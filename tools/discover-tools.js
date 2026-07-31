/**
 * STEP 1 — RUN THIS BEFORE ANYTHING ELSE.
 *
 * This is a throwaway Actor whose only job is to connect to an MCP connector
 * and print the real tool names the upstream server exposes.
 *
 * Why this exists: the Actor input schema has to declare tool-name patterns
 * (e.g. "query_*", "create_*"). If those patterns don't match the server's
 * actual tool names, the connector picker in Apify Console shows ZERO eligible
 * connectors and the failure looks like a permissions bug. Guessing is the
 * single biggest time sink in this build.
 *
 * HOW TO RUN IT:
 *   1. Deploy this folder's parent as an Actor (see SETUP.md step 5).
 *   2. Temporarily set "start": "node tools/discover-tools.js" in package.json.
 *   3. Run it in Console with any Notion connector selected.
 *   4. Copy the printed tool names into INPUT_SCHEMA.json.
 *   5. Set "start" back to "node main.js".
 *
 * Keep the output. It goes in the article verbatim.
 */

import { Actor, log } from 'apify';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';

await Actor.init();

try {
    const input = (await Actor.getInput()) || {};

    // Accept a connector from any of the field names this repo uses,
    // so you can run discovery without editing the input schema.
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
            'APIFY_MCP_PROXY_URL is not set. This env var only exists on Apify-hosted runs, ' +
                'not on local `apify run`. Deploy first, then run in Console.',
        );
    }

    const transport = new StreamableHTTPClientTransport(
        new URL(`${proxyUrl}/${connectorId}`),
        {
            requestInit: {
                headers: { Authorization: `Bearer ${token}` },
            },
        },
    );

    const client = new Client({ name: 'tender-monitor-discovery', version: '1.0.0' });
    await client.connect(transport);
    log.info('Connected to MCP proxy.');

    const { tools } = await client.listTools();

    log.info('');
    log.info(`=== ${tools.length} TOOLS VISIBLE THROUGH THIS CONNECTOR ===`);
    log.info('');

    for (const t of tools) {
        // MCP tool annotations. These drive the readOnly / destructive /
        // idempotent / openWorld hints in the input schema. If a server does not
        // annotate a tool, MCP spec defaults apply:
        //   readOnly    -> false
        //   destructive -> true
        //   idempotent  -> false
        //   openWorld   -> true
        // Those defaults are why an over-strict hint silently excludes tools.
        const a = t.annotations || {};
        log.info(`TOOL: ${t.name}`);
        log.info(`  title       : ${a.title ?? '(none)'}`);
        log.info(`  readOnly    : ${a.readOnlyHint ?? '(unannotated -> false)'}`);
        log.info(`  destructive : ${a.destructiveHint ?? '(unannotated -> true)'}`);
        log.info(`  idempotent  : ${a.idempotentHint ?? '(unannotated -> false)'}`);
        log.info(`  openWorld   : ${a.openWorldHint ?? '(unannotated -> true)'}`);
        log.info(`  description : ${(t.description || '').slice(0, 160)}`);
        log.info(`  inputSchema : ${JSON.stringify(t.inputSchema)}`);
        log.info('');
    }

    log.info('=== COPY-PASTE SUMMARY (tool names only) ===');
    log.info(JSON.stringify(tools.map((t) => t.name), null, 2));

    // Also persist to the key-value store so you can download it as a file.
    await Actor.setValue('DISCOVERED_TOOLS', tools);
    log.info('Full tool list saved to key-value store under DISCOVERED_TOOLS.');

    await client.close();
} catch (err) {
    log.error(`Discovery failed: ${err.message}`);
    log.error(err.stack);
} finally {
    await Actor.exit();
}
