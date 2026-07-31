/**
 * Thin wrapper around the official MCP TypeScript SDK for talking to the
 * Apify MCP Proxy.
 *
 * Key facts (from docs.apify.com/platform/integrations/mcp-connectors/use-in-actors):
 *   - Every run gets APIFY_MCP_PROXY_URL and APIFY_TOKEN as env vars.
 *   - You connect to `${APIFY_MCP_PROXY_URL}/<connectorId>`.
 *   - You authenticate with the run's own APIFY_TOKEN as a bearer credential.
 *   - The Actor NEVER sees the user's Notion/Slack/GitHub credential. The proxy
 *     injects it server-side before forwarding upstream.
 *   - No Apify-specific MCP SDK exists or is needed. This is the standard client.
 *   - The proxy session dies when the run ends, so all connector work must happen
 *     before Actor.exit().
 */

import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import { log } from 'apify';

/**
 * Opens an MCP session to one connector through the Apify proxy.
 *
 * @param {string} connectorId - Connector ID from the Actor input.
 * @param {string} label - Human-readable name, used only for logging.
 * @returns {Promise<{client: Client, tools: Array}>}
 */
export async function connectToConnector(connectorId, label = 'connector') {
    const proxyUrl = process.env.APIFY_MCP_PROXY_URL;
    const token = process.env.APIFY_TOKEN;

    if (!proxyUrl) {
        throw new Error(
            'APIFY_MCP_PROXY_URL is missing. MCP connectors only work on Apify-hosted ' +
                'runs — this variable is not injected during a local `apify run`.',
        );
    }
    if (!connectorId) {
        throw new Error(`No connector ID supplied for "${label}".`);
    }

    const transport = new StreamableHTTPClientTransport(
        new URL(`${proxyUrl}/${connectorId}`),
        {
            requestInit: {
                headers: { Authorization: `Bearer ${token}` },
            },
        },
    );

    const client = new Client({ name: 'tender-monitor', version: '2.0.0' });
    await client.connect(transport);

    // The proxy filters tools/list down to what this Actor declared in its input
    // schema. So this list is the *effective* permission set, not everything
    // Notion can do. Logging it makes permission problems debuggable instead of
    // mysterious.
    const { tools } = await client.listTools();
    log.info(
        `[${label}] connected. ${tools.length} tool(s) permitted: ${tools
            .map((t) => t.name)
            .join(', ')}`,
    );

    return { client, tools };
}

/**
 * Finds the first available tool whose name matches one of the candidate
 * patterns, in priority order.
 *
 * This exists because MCP servers do not agree on tool naming, and Notion has
 * renamed its tools before. Hardcoding a tool name is how this Actor breaks
 * silently three months from now. Resolve at runtime, fail loudly.
 *
 * @param {Array} tools - Result of client.listTools().
 * @param {string[]} patterns - Glob-ish patterns, '*' matches any characters.
 * @param {string} purpose - Description used in the error message.
 * @returns {string} The resolved tool name.
 */
export function resolveTool(tools, patterns, purpose) {
    const names = tools.map((t) => t.name);

    for (const pattern of patterns) {
        const rx = new RegExp(
            `^${pattern.split('*').map(escapeRegex).join('.*')}$`,
            'i',
        );
        const hit = names.find((n) => rx.test(n));
        if (hit) {
            log.debug(`Resolved ${purpose} -> "${hit}" (matched pattern "${pattern}")`);
            return hit;
        }
    }

    throw new Error(
        `Could not resolve a tool for "${purpose}".\n` +
            `  Tried patterns : ${patterns.join(', ')}\n` +
            `  Tools available: ${names.join(', ') || '(none)'}\n` +
            `If the tool list is empty, the connector matched an mcpServers rule that ` +
            `does not permit these tools — check INPUT_SCHEMA.json. If the list is ` +
            `non-empty but nothing matched, the upstream server renamed its tools: ` +
            `re-run tools/discover-tools.js and update the patterns.`,
    );
}

function escapeRegex(s) {
    return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/**
 * Calls a tool and returns its parsed payload.
 *
 * MCP responses come back as a content array. Servers vary in whether they
 * populate `structuredContent` or stuff JSON into a text block, so handle both.
 *
 * @param {Client} client
 * @param {string} name - Tool name.
 * @param {object} args - Tool arguments.
 * @returns {Promise<any>}
 */
export async function callTool(client, name, args) {
    const res = await client.callTool({ name, arguments: args });

    if (res.isError) {
        const detail = (res.content || [])
            .map((c) => c.text ?? JSON.stringify(c))
            .join(' ');
        throw new Error(`Tool "${name}" returned an error: ${detail}`);
    }

    if (res.structuredContent) return res.structuredContent;

    const textBlock = (res.content || []).find((c) => c.type === 'text');
    if (!textBlock) return res.content;

    try {
        return JSON.parse(textBlock.text);
    } catch {
        return textBlock.text;
    }
}

/**
 * Closes a set of clients without letting one failure mask the others.
 */
export async function closeAll(clients) {
    await Promise.allSettled(
        clients.filter(Boolean).map(async (c) => {
            try {
                await c.close();
            } catch (err) {
                log.warning(`Failed to close an MCP client cleanly: ${err.message}`);
            }
        }),
    );
}
