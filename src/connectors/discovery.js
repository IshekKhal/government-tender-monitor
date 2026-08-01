/**
 * Connector tool discovery.
 *
 * Prints every tool the connector exposes through the Apify proxy, with its
 * annotations and full input schema.
 *
 * WHY THIS EXISTS. The Actor's input schema has to declare tool-name patterns.
 * If those patterns match nothing, the connector picker in Console shows zero
 * options and the failure looks like a permissions problem. Guessing tool names
 * cost this Actor a full day. Run discovery once against a new MCP server before
 * writing any schema.
 *
 * HOW TO RUN IT. Set the "Run mode" input to `discover`. That field is hidden in
 * the form by default, so set it through the JSON input tab or the API. It used
 * to require editing package.json and pushing a second build, which was a bad
 * design borrowed from nowhere and replaced with this.
 */

import { Actor, log } from 'apify';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';

export async function runDiscovery(input) {
    const connectorId =
        input.capabilityConnector || input.pipelineConnector || input.connectorId;

    if (!connectorId) {
        throw new Error(
            'No connector selected. Pick one in the input form before running discovery.',
        );
    }

    const proxyUrl = process.env.APIFY_MCP_PROXY_URL;
    const token = process.env.APIFY_TOKEN;

    log.info('--- MCP CONNECTOR DISCOVERY ---');
    log.info(`Proxy base URL : ${proxyUrl}`);
    log.info(`Connector ID   : ${connectorId}`);

    if (!proxyUrl) {
        throw new Error(
            'APIFY_MCP_PROXY_URL is not set. It is only injected on Apify-hosted runs, ' +
                'never on a local `apify run`. Deploy first, then run in Console.',
        );
    }

    const transport = new StreamableHTTPClientTransport(new URL(`${proxyUrl}/${connectorId}`), {
        requestInit: { headers: { Authorization: `Bearer ${token}` } },
    });

    const client = new Client({ name: 'tender-monitor-discovery', version: '2.0.0' });
    await client.connect(transport);
    log.info('Connected to MCP proxy.');

    const { tools } = await client.listTools();

    log.info('');
    log.info(`=== ${tools.length} TOOLS VISIBLE THROUGH THIS CONNECTOR ===`);
    log.info('');

    for (const t of tools) {
        // MCP spec defaults for an unannotated tool:
        //   readOnly false, destructive true, idempotent false, openWorld true
        // Those defaults are why an over-strict behavioural hint in the input
        // schema silently excludes tools and leaves you with an empty picker.
        const a = t.annotations || {};
        log.info(`TOOL: ${t.name}`);
        log.info(`  readOnly    : ${a.readOnlyHint ?? '(unannotated, treated as false)'}`);
        log.info(`  destructive : ${a.destructiveHint ?? '(unannotated, treated as true)'}`);
        log.info(`  idempotent  : ${a.idempotentHint ?? '(unannotated, treated as false)'}`);
        log.info(`  openWorld   : ${a.openWorldHint ?? '(unannotated, treated as true)'}`);
        log.info(`  description : ${(t.description || '').slice(0, 160)}`);
        log.info(`  inputSchema : ${JSON.stringify(t.inputSchema)}`);
        log.info('');
    }

    log.info('=== TOOL NAMES ONLY ===');
    log.info(JSON.stringify(tools.map((t) => t.name), null, 2));

    await Actor.setValue('DISCOVERED_TOOLS', tools);
    log.info('Full tool list saved to the key-value store under DISCOVERED_TOOLS.');

    await client.close();
}
