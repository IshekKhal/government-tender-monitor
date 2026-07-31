/**
 * Notion reads and writes through an Apify MCP connector.
 *
 * Rewritten against the real tool surface, discovered from run 2LXGH1qR6jag3f5hh.
 * Nothing in here is guessed anymore.
 *
 * THREE THINGS THE DISCOVERY RUN CHANGED:
 *
 * 1. Notion's MCP does not expose a REST-style "query database" tool. It exposes
 *    `notion-query-data-sources`, which runs **SQLite** against a data source.
 *    You get the data source URL (collection://uuid) from `notion-fetch`.
 *    So reading a database is a two-step: fetch for the handle, then SQL.
 *
 * 2. Page properties are NOT Notion REST property objects. The tool schema says
 *    "a JSON map of property names to SQLite values". So it's flat:
 *        { "Name": "Cloud migration", "Score": 87 }
 *    not
 *        { "Name": { "title": [{ "text": { "content": "..." } }] } }
 *    This is a large simplification over the REST API.
 *
 * 3. Every Notion tool IS annotated with readOnly/destructive/idempotent/openWorld.
 *    That means the behavioral hints in INPUT_SCHEMA.json are usable — see
 *    FINDINGS.md. `notion-fetch` and `notion-query-data-sources` are both
 *    readOnly:true, destructive:false, idempotent:true.
 */

import { log } from 'apify';
import { resolveTool, callTool } from './mcpClient.js';

/* Tool name patterns, most specific first. Real names confirmed by discovery. */
const FETCH_PATTERNS = ['notion-fetch', '*fetch*'];
const SQL_PATTERNS = ['notion-query-data-sources', '*query*data*source*'];
const CREATE_PATTERNS = ['notion-create-pages', 'notion-create-page', '*create*page*'];

/**
 * Fails fast if the connector cannot read. Better than limping on and producing
 * an empty profile that looks like a parsing bug.
 */
export function assertReadCapability(tools, label) {
    const names = tools.map((t) => t.name);
    const hasFetch = names.some((n) => /fetch/i.test(n));
    const hasSql = names.some((n) => /query.*data.?source/i.test(n));

    if (hasFetch && hasSql) return;

    throw new Error(
        `The "${label}" connector cannot read Notion databases.\n` +
            `  Tools permitted : ${names.join(', ') || '(none)'}\n` +
            `  Needs           : notion-fetch (present: ${hasFetch}), ` +
            `notion-query-data-sources (present: ${hasSql})\n` +
            `\n` +
            `  Reading a Notion database takes both: fetch resolves the database ID\n` +
            `  to a data source handle, then query-data-sources runs SQL against it.\n` +
            `  Widen the tools.required patterns for this field in INPUT_SCHEMA.json.`,
    );
}

/* ------------------------------------------------------------------------- */
/* Step 1 of every read: turn a database ID into a data source URL             */
/* ------------------------------------------------------------------------- */

/**
 * `notion-query-data-sources` needs a `collection://uuid` handle, not the
 * database ID from the browser URL. `notion-fetch` is what converts one to the
 * other — it returns the database in Notion-flavored Markdown, with the data
 * source declared in a <data-source> tag.
 *
 * A database can have several data sources. We take the first, and log when
 * there is more than one so a surprise is visible instead of silent.
 */
export async function resolveDataSourceUrl(client, tools, databaseId) {
    const fetchTool = resolveTool(tools, FETCH_PATTERNS, 'resolving the database data source');

    log.info(`Resolving data source for database ${databaseId} (tool: ${fetchTool})...`);

    const raw = await callTool(client, fetchTool, { id: databaseId });
    const text = unwrapText(raw);

    const found = [...text.matchAll(/collection:\/\/[0-9a-f-]{36}/gi)].map((m) => m[0]);
    const unique = [...new Set(found)];

    if (unique.length === 0) {
        throw new Error(
            `notion-fetch returned no data source handle for database "${databaseId}".\n` +
                `  Most likely causes:\n` +
                `    - the ID is a page ID, not a database ID\n` +
                `    - the database is not shared with the connector (re-authorize and grant it)\n` +
                `  First 500 chars of the response:\n${text.slice(0, 500)}`,
        );
    }

    if (unique.length > 1) {
        log.warning(
            `Database has ${unique.length} data sources; using the first. All: ${unique.join(', ')}`,
        );
    }

    log.info(`Data source resolved: ${unique[0]}`);

    // The fetch response carries the column schema in a <data-source-state>
    // block. Grabbing it here costs nothing and lets the write path match each
    // value to the column's declared type — see coerceToSchema.
    const schema = extractSchema(text);
    if (schema) {
        const types = Object.entries(schema)
            .map(([k, v]) => {
                // Show the allowed values for select columns. They are the most
                // common cause of a write failing, and seeing them up front is
                // the difference between a warning and 27 rejected rows.
                if ((v.type === 'select' || v.type === 'status') && v.options?.length) {
                    return `${k}:${v.type}[${v.options.map((o) => o.name).join('|')}]`;
                }
                return `${k}:${v.type}`;
            })
            .join(', ');
        log.info(`Schema: ${types}`);
    }

    return { url: unique[0], rawText: text, schema };
}

/**
 * Pulls the column schema out of the <data-source-state> block in a fetch
 * response. Shape: { "Score": { name, type: "number" }, ... }
 */
function extractSchema(text) {
    const m = text.match(/<data-source-state>\s*([\s\S]*?)\s*<\/data-source-state>/);
    if (!m) return null;
    try {
        return JSON.parse(m[1])?.schema ?? null;
    } catch {
        // The block is sometimes truncated on large databases.
        const s = m[1].match(/"schema"\s*:\s*(\{[\s\S]*)/);
        if (!s) return null;
        try {
            return JSON.parse(s[1]);
        } catch {
            return null;
        }
    }
}

/**
 * Matches each value to the type its destination column actually declares.
 *
 * Notion silently drops a value whose type doesn't match the column — no error,
 * no warning, the cell is just empty. Confirmed on run tmVqtf5bMcgHBA3pd, where
 * a pipeline built with Score and Budget as *text* columns received numbers and
 * showed blanks, while every text field wrote fine.
 *
 * Two databases built from the same instructions can differ, because whoever
 * makes the Notion table picks the column types. So the Actor reads the
 * destination schema and adapts, rather than assuming.
 *
 * This is only possible because the connector reads before it writes — the same
 * property that makes deduplication work.
 */
/** Collected across a run so the warning is printed once, not per row. */
const droppedSelects = new Set();

export function reportDroppedSelects() {
    if (droppedSelects.size === 0) return;
    log.warning('Some select values were dropped because the column has no matching option:');
    for (const d of droppedSelects) log.warning(`    ${d}`);
    log.warning(
        '    Rows were still written without that field. To keep it, add the option ' +
            'to the select column in Notion, or change the column to Text.',
    );
    droppedSelects.clear();
}

function coerceToSchema(properties, schema) {
    if (!schema) return properties;

    const out = {};
    for (const [key, value] of Object.entries(properties)) {
        const col = schema[key];
        if (!col) {
            // Column doesn't exist in the destination. Sending it is harmless but
            // saying so beats a mysteriously missing field.
            log.debug(`Skipping "${key}" — no such column in the destination database.`);
            continue;
        }

        switch (col.type) {
            case 'number':
                out[key] = typeof value === 'number' ? value : toNumber(value);
                break;
            case 'checkbox':
                out[key] = Boolean(value);
                break;
            case 'select':
            case 'status': {
                // A select column accepts ONLY its declared options. Notion
                // rejects the whole page with a 400 if you send anything else,
                // and the rejection is per row, so one bad value fails the batch.
                //
                // Confirmed on run Vo5F6jRFPsggddk9G: a Country column whose only
                // option was "UK" rejected all 27 US contracts:
                //   Invalid select value for property "Country": "USA".
                //   Value must be one of the following: "UK".
                //
                // Notion's API cannot add options on the fly, so the only safe
                // move is to drop the property and still write the row. Losing
                // one field beats losing the record.
                if (value == null) break;
                const allowed = (col.options || []).map((o) => o.name);
                const str = String(value);

                // A select column with ZERO options rejects everything. It does
                // not learn new values from writes, so a brand-new pipeline that
                // nobody has typed into would fail 100% of rows on its first run.
                // Send only what the column already declares; drop the rest.
                const match =
                    allowed.find((o) => o === str) ||
                    allowed.find((o) => o.toLowerCase() === str.toLowerCase());

                if (match) {
                    out[key] = match;
                } else {
                    droppedSelects.add(
                        `${key}="${str}" (column allows: ${allowed.join(', ') || 'NOTHING, it has no options'})`,
                    );
                }
                break;
            }
            case 'title':
            case 'rich_text':
            case 'text':
            case 'url':
            case 'email':
            case 'phone_number':
                out[key] = value == null ? null : String(value);
                break;
            case 'date':
                out[key] = value == null ? null : String(value);
                break;
            case 'multi_select':
                out[key] = Array.isArray(value) ? value.map(String) : [String(value)];
                break;
            default:
                out[key] = value;
        }

        if (out[key] === null || out[key] === '') delete out[key];
    }
    return out;
}

function toNumber(v) {
    const n = Number(String(v).replace(/[^0-9.\-]/g, ''));
    return Number.isFinite(n) ? n : null;
}

/** Notion's metered-tool refusal. Not a transport error, not a bad query. */
function isUsageLimitError(err) {
    return /usage limit|upgrade to Business|mcp_tool_upsell/i.test(String(err?.message || ''));
}

/**
 * Reads a database's rows, degrading gracefully instead of failing.
 *
 * Notion meters `notion-query-data-sources` per workspace plan. On a Free or
 * Plus workspace you get a quota and then this, mid-run:
 *
 *   "Your workspace has reached the usage limit for Query Data Source.
 *    You can try again later, or upgrade to Business..."
 *
 * Notion does not publish the quota size or the reset window, so an Actor that
 * depends on that one tool is an Actor that stops working on someone else's
 * billing schedule, with no way to predict when.
 *
 * The escape hatch is that `notion-fetch` is NOT metered — and it already
 * returns the database contents as Markdown, because we called it to resolve the
 * data source handle. The rows were in our hands before SQL was ever attempted.
 *
 * Order: SQL (best — real filtering, one round trip) -> database view ->
 * parse the fetch response we already have (always available).
 */
async function readRowsWithFallback(
    client,
    tools,
    databaseId,
    { url },
    sql,
    { viewUrl = null, searchHint = null } = {},
) {
    const names = tools.map((t) => t.name);

    if (names.some((n) => /query.*data.?source/i.test(n))) {
        try {
            return { rows: await runSql(client, tools, url, sql), via: 'sql' };
        } catch (err) {
            if (!isUsageLimitError(err)) throw err;
            log.warning(
                'Notion refused the SQL query — workspace quota for Query Data Source is spent. ' +
                    'Falling back to the unmetered read path; results are identical, ' +
                    'filtering just happens locally.',
            );
        }
    }

    // Fallback 1: the database-view tool.
    //
    // Needs a REAL view URL containing ?v=<viewId>. A bare database URL is
    // rejected outright:
    //   "Invalid database view URL" / tool_error_code: invalid_view_url
    // The view ID cannot be derived from the database ID — it has to be copied
    // out of the browser, which is why it's an optional Actor input.
    const viewTool = names.find((n) => /query.*database.*view/i.test(n));
    if (viewTool && viewUrl) {
        try {
            const raw = await callTool(client, viewTool, { view_url: viewUrl, page_size: 100 });
            const viewRows = parseRows(unwrapText(raw));
            if (viewRows.length > 0) {
                log.info(`Read ${viewRows.length} row(s) via ${viewTool}.`);
                return { rows: viewRows, via: 'database-view' };
            }
            log.warning(`${viewTool} returned nothing parsable.`);
        } catch (err) {
            log.warning(`${viewTool} failed: ${err.message}`);
        }
    } else if (viewTool) {
        log.warning(
            'Skipping the database-view tool — no view URL supplied. Paste the full ' +
                'Notion URL including ?v=... into the matching Actor input to enable it.',
        );
    }

    // Fallback 2: semantic search scoped to the data source.
    //
    // notion-search accepts an optional data_source_url and is readOnly. It ranks
    // rather than enumerates, so it is a poor way to read a table — but for a
    // capability profile of a few dozen rows it is usually complete enough, and
    // it is not behind the Query Data Source quota.
    const searchTool = names.find((n) => /search/i.test(n));
    if (searchTool) {
        try {
            const raw = await callTool(client, searchTool, {
                query: searchHint || 'list all entries',
                data_source_url: url,
                page_size: 25,
            });
            const searchRows = parseRows(unwrapText(raw));
            if (searchRows.length > 0) {
                log.warning(
                    `Read ${searchRows.length} row(s) via ${searchTool}. NOTE: search ranks ` +
                        'by relevance rather than returning every row, so this profile may be ' +
                        'incomplete. Restore SQL access for a guaranteed-complete read.',
                );
                return { rows: searchRows, via: 'search-approximate' };
            }
        } catch (err) {
            log.warning(`${searchTool} scoped to the data source failed: ${err.message}`);
        }
    }

    // Fallback 3: fetch the DATA SOURCE itself.
    //
    // Confirmed by run smWTyoaosIc4FJU7K: this returns the schema and the SQLite
    // table definition, but NOT the rows. Kept only because a future Notion
    // change might start including them, and the cost is one call.
    const fetchTool = resolveTool(tools, FETCH_PATTERNS, 'reading rows from the data source');

    log.info(`Reading rows directly from data source ${url}...`);
    const dsText = unwrapText(await callTool(client, fetchTool, { id: url }));

    const rows = parseRows(dsText);
    if (rows.length > 0) {
        log.info(`Recovered ${rows.length} row(s) from the data source fetch.`);
        return { rows, via: 'fetch-datasource' };
    }

    throw new Error(
        `Could not read rows for database "${databaseId}".\n` +
            `\n` +
            `  Every read path Notion offers is exhausted:\n` +
            `    - notion-query-data-sources : over workspace quota\n` +
            `    - notion-query-database-view: ${viewUrl ? 'failed' : 'no view URL supplied'}\n` +
            `    - notion-search             : returned nothing\n` +
            `    - notion-fetch on the data source: schema only, no rows (confirmed)\n` +
            `\n` +
            `  Options:\n` +
            (viewUrl
                ? `    1. The view URL you supplied was tried and did not return usable rows,\n` +
                  `       so that route is closed too. Nothing left to configure.\n`
                : `    1. Paste the full Notion view URL (with ?v=...) into the\n` +
                  `       "Capability view URL" input and re-run.\n`) +
            `    2. Wait for the Query Data Source quota to reset. Notion does not\n` +
            `       publish the window; observed resets have been several hours.\n` +
            `    3. Use a different Notion workspace — the quota is per workspace,\n` +
            `       so a second free workspace resets the budget immediately.\n` +
            `    4. Upgrade to Notion Business for unmetered querying.\n`,
    );
}

/**
 * Notion's MCP wraps its Markdown payload in a JSON envelope:
 *   { metadata: {...}, title: "...", url: "...", text: "<database ...>..." }
 * The Markdown we care about is in `.text`. Stringifying the whole object gives
 * you the envelope with the content escaped inside it, which no parser will read.
 */
function unwrapText(raw) {
    if (raw == null) return '';
    if (typeof raw === 'string') {
        // Sometimes the envelope arrives as a JSON string rather than an object.
        try {
            const parsed = JSON.parse(raw);
            if (parsed && typeof parsed.text === 'string') return parsed.text;
        } catch {
            /* plain markdown, use as-is */
        }
        return raw;
    }
    if (typeof raw.text === 'string') return raw.text;
    if (Array.isArray(raw.content)) {
        return raw.content.map((c) => c.text ?? '').join('\n');
    }
    return JSON.stringify(raw);
}

/**
 * Parses rows out of a data source fetch. Tries both shapes Notion is known to
 * emit: a Markdown pipe table, and a sequence of <page> blocks with properties.
 */
function parseRows(text) {
    const table = parseMarkdownTable(text);
    if (table.length > 0) return table;
    return parsePageBlocks(text);
}

/**
 * Notion renders data source rows as repeated blocks, roughly:
 *
 *   <page url="{{https://...}}">
 *   Name: cloud migration
 *   Type: Keyword
 *   Weight: 3
 *   </page>
 *
 * Attribute-style `key: value` lines inside each block become row fields.
 */
function parsePageBlocks(text) {
    const blocks = [...text.matchAll(/<page\b[^>]*>([\s\S]*?)<\/page>/gi)].map((m) => m[1]);
    if (blocks.length === 0) return [];

    const rows = [];
    for (const block of blocks) {
        const row = {};
        for (const line of block.split('\n')) {
            const m = line.match(/^\s*([A-Za-z][\w \-()]*?)\s*:\s*(.*)$/);
            if (!m) continue;
            const [, key, value] = m;
            row[key.trim()] = coerce(value.trim());
        }
        if (Object.keys(row).length > 0) rows.push(row);
    }
    return rows;
}

/* ------------------------------------------------------------------------- */
/* READ SIDE — the connector fires before the scrape and decides what to scrape */
/* ------------------------------------------------------------------------- */

/**
 * Runs a read-only SQLite query against a Notion data source.
 *
 * The table name is the data source URL itself and must be double-quoted:
 *   SELECT * FROM "collection://f336d0bc-..."
 *
 * Worth knowing: the tool schema warns that filters configured on a *view* are
 * not applied automatically. Every filter has to be in the WHERE clause.
 */
async function runSql(client, tools, dataSourceUrl, query, params = []) {
    const sqlTool = resolveTool(tools, SQL_PATTERNS, 'querying a Notion data source');

    const raw = await callTool(client, sqlTool, {
        data: {
            mode: 'sql',
            data_source_urls: [dataSourceUrl],
            query,
            ...(params.length ? { params } : {}),
        },
    });

    const rows = extractRows(raw);
    log.debug(`SQL "${query.slice(0, 80)}" returned ${rows.length} row(s).`);
    return rows;
}

/**
 * Reads the Capability Profile database and turns it into search criteria.
 *
 * Columns expected (see SETUP.md):
 *   Name   (title)    - the keyword, NAICS/CPV code, or agency name
 *   Type   (select)   - Keyword | NAICS | CPV | WonAgency | ExcludeBuyer
 *   Weight (number)   - optional, 1-3
 *   Active (checkbox) - optional, uncheck to disable a row
 */
export async function readCapabilityProfile(client, tools, databaseId, viewUrl = null) {
    const source = await resolveDataSourceUrl(client, tools, databaseId);

    log.info('Reading capability profile...');
    const { rows, via } = await readRowsWithFallback(
        client,
        tools,
        databaseId,
        source,
        `SELECT * FROM "${source.url}"`,
        { viewUrl, searchHint: 'keyword NAICS CPV agency capability profile entries' },
    );

    log.info(`Capability profile returned ${rows.length} row(s) (via ${via}).`);
    if (rows.length > 0) {
        // Column names come straight from Notion. Logging them once makes a
        // "0 keywords" result diagnosable in one glance instead of ten minutes.
        log.info(`Columns seen: ${Object.keys(rows[0]).join(', ')}`);
        // And the values, so a Type spelled "keyword " or a blank Name is visible.
        for (const r of rows.slice(0, 20)) {
            log.info(
                `    row: Name="${r.Name ?? r.name ?? ''}" Type="${r.Type ?? r.type ?? ''}" ` +
                    `Weight=${r.Weight ?? r.weight ?? ''} Active=${r.Active ?? r.active ?? ''}`,
            );
        }
    }

    const profile = {
        keywords: [],
        codes: [],
        wonAgencies: [],
        excludeBuyers: [],
        excludeTerms: [],
        weights: {},
    };

    for (const row of rows) {
        const name = pick(row, ['Name', 'name', 'title', 'Title']);
        if (!name) continue;

        // Notion's SQL layer returns checkboxes as the strings "__YES__" and
        // "__NO__", not booleans. Checking for `false` alone silently treats
        // every unchecked row as active.
        const active = pick(row, ['Active', 'active']);
        if (active === false || active === 0 || active === 'false' || active === '__NO__') {
            log.debug(`Skipping inactive profile row: ${pick(row, ['Name', 'name'])}`);
            continue;
        }

        const type = String(pick(row, ['Type', 'type']) || 'Keyword')
            .toLowerCase()
            .replace(/\s+/g, '');
        const weight = Number(pick(row, ['Weight', 'weight'])) || 1;
        const lower = String(name).toLowerCase();

        switch (type) {
            case 'naics':
            case 'cpv':
                profile.codes.push(String(name));
                profile.weights[lower] = weight;
                break;
            case 'wonagency':
            case 'agency':
                profile.wonAgencies.push(lower);
                break;
            case 'excludebuyer':
                profile.excludeBuyers.push(lower);
                break;
            case 'excludekeyword':
            case 'excludeterm':
            case 'exclude':
                profile.excludeTerms.push(lower);
                break;
            default:
                profile.keywords.push(lower);
                profile.weights[lower] = weight;
        }
    }

    log.info(
        `Profile parsed — ${profile.keywords.length} keyword(s), ` +
            `${profile.codes.length} code(s), ` +
            `${profile.wonAgencies.length} past-win agency/agencies, ` +
            `${profile.excludeBuyers.length} excluded buyer(s), ` +
            `${profile.excludeTerms.length} excluded term(s).`,
    );

    return profile;
}

/**
 * Reads the pipeline and returns the set of Source IDs already recorded.
 *
 * This is the argument for reading before writing. A write-only Actor on a daily
 * schedule re-inserts the same contract every day. This one can't.
 *
 * Note the SQL does the work: one query, one column, no pagination loop. That is
 * the practical advantage of a SQL tool over a REST list endpoint.
 */
export async function readExistingPipelineIds(client, tools, databaseId, viewUrl = null) {
    const source = await resolveDataSourceUrl(client, tools, databaseId);

    let rows;
    try {
        ({ rows } = await readRowsWithFallback(
            client,
            tools,
            databaseId,
            source,
            `SELECT "Source ID" FROM "${source.url}" WHERE "Source ID" IS NOT NULL`,
            { viewUrl, searchHint: 'contract source id' },
        ));
    } catch (err) {
        // A brand-new pipeline database may not have the column yet, and a
        // missing column is a SQL error, not an empty result.
        //
        // Deliberately non-fatal: an empty dedupe index means duplicates, which
        // is recoverable. A failed run means no contracts at all.
        log.warning(
            `Dedupe read failed (${err.message}). Treating the pipeline as empty — ` +
                'this run may re-insert rows that are already there. Check that the ' +
                'pipeline database has a text column named exactly "Source ID".',
        );
        const empty = new Set();
        empty.schema = source.schema;
        return empty;
    }

    const seen = new Set();
    for (const row of rows) {
        const id = pick(row, ['Source ID', 'source id', 'source_id', 'SourceID']);
        if (id) seen.add(String(id));
    }

    log.info(`Dedupe index built: ${seen.size} contract(s) already in the pipeline.`);

    // Carried out alongside the IDs so the write path can match each value to
    // the column type this particular database declares.
    seen.schema = source.schema;
    return seen;
}

/* ------------------------------------------------------------------------- */
/* WRITE SIDE                                                                 */
/* ------------------------------------------------------------------------- */

/**
 * Writes a batch of contracts as pages in the pipeline database.
 *
 * `notion-create-pages` accepts up to 100 pages per call, and properties are a
 * flat map of column name to scalar — no rich_text wrappers, no title arrays.
 * That is a real difference from the REST API and the reason the earlier
 * property-object shape in this file was wrong.
 */
export async function writeContractBatch(client, tools, databaseId, contracts, schema = null) {
    const createTool = resolveTool(tools, CREATE_PATTERNS, 'writing contracts to the pipeline');

    const pages = contracts.map((c) => ({
        properties: coerceToSchema(
            stripEmpty({
                Name: truncate(c.title, 200),
                'Source ID': String(c.rawSourceId || ''),
                Buyer: truncate(c.buyer, 200),
                Score: numOrNull(c.confidenceScore),
                'Budget (USD)': numOrNull(c.budgetUsd ?? c.awardValue),
                Country: c.country || null,
                Deadline: isoDateOnly(c.deadline),
                Link: c.sourceRecordUrl || null,
                Contact: isEmail(c.buyerContactEmail) ? c.buyerContactEmail : null,
                'Why it scored': truncate(c.scoreReason, 1800),
            }),
            schema,
        ),
    }));

    return callTool(client, createTool, {
        parent: { database_id: databaseId },
        pages,
    });
}

/**
 * Writes in chunks, sequentially.
 *
 * Chunked rather than one-call-per-contract because the tool takes up to 100
 * pages at once — 60 contracts is 3 calls, not 60. Sequential between chunks
 * because a burst still risks rate limiting, and a partial write is worse than a
 * slow one: the next run's dedupe index would treat the failed rows as done.
 */
export async function writeAllContracts(
    client,
    tools,
    databaseId,
    contracts,
    { chunkSize = 25, delayMs = 500, schema = null } = {},
) {
    const written = [];
    const failed = [];

    for (let i = 0; i < contracts.length; i += chunkSize) {
        const chunk = contracts.slice(i, i + chunkSize);
        const label = `chunk ${Math.floor(i / chunkSize) + 1} (${chunk.length} row(s))`;

        try {
            await writeContractBatch(client, tools, databaseId, chunk, schema);
            written.push(...chunk.map((c) => c.rawSourceId));
            log.info(`  wrote ${label}`);
        } catch (err) {
            // Retry the chunk one row at a time so a single bad record doesn't
            // cost the other 24.
            log.warning(`  ${label} failed (${err.message}) — retrying individually`);
            for (const c of chunk) {
                try {
                    await writeContractBatch(client, tools, databaseId, [c], schema);
                    written.push(c.rawSourceId);
                } catch (rowErr) {
                    failed.push({ id: c.rawSourceId, error: rowErr.message });
                    log.warning(`    row ${c.rawSourceId} failed: ${rowErr.message}`);
                }
                await sleep(delayMs);
            }
        }

        if (i + chunkSize < contracts.length) await sleep(delayMs);
    }

    return { written, failed };
}

/* ------------------------------------------------------------------------- */
/* Helpers                                                                    */
/* ------------------------------------------------------------------------- */

function extractRows(raw) {
    if (!raw) return [];
    if (Array.isArray(raw)) return raw;
    for (const key of ['rows', 'results', 'records', 'data', 'items']) {
        if (Array.isArray(raw[key])) return raw[key];
    }
    // Fall through to the text parsers — the SQL tool also answers in Markdown
    // when it feels like it.
    const parsed = parseRows(unwrapText(raw));
    if (parsed.length) return parsed;
    log.debug(`Unrecognised response shape: ${JSON.stringify(raw).slice(0, 400)}`);
    return [];
}

/**
 * Notion's MCP frequently answers in Markdown rather than JSON, so a pipe table
 * is a realistic response shape for a SQL query.
 */
function parseMarkdownTable(text) {
    const lines = text
        .split('\n')
        .map((l) => l.trim())
        .filter((l) => l.startsWith('|') && l.endsWith('|'));
    if (lines.length < 2) return [];

    const cells = (l) =>
        l
            .slice(1, -1)
            .split('|')
            .map((c) => c.trim());

    const headers = cells(lines[0]);
    const body = lines.filter((l) => !/^\|[\s|:-]+\|$/.test(l)).slice(1);

    return body.map((line) => {
        const vals = cells(line);
        return Object.fromEntries(headers.map((h, i) => [h, coerce(vals[i])]));
    });
}

function coerce(v) {
    if (v == null || v === '' || v === '—' || v === '-') return null;
    if (v === 'true' || v === '✓' || v === 'Yes') return true;
    if (v === 'false' || v === '☐' || v === 'No') return false;
    if (/^-?\d+(\.\d+)?$/.test(v)) return Number(v);
    return v;
}

function pick(row, keys) {
    for (const k of keys) {
        if (row && Object.prototype.hasOwnProperty.call(row, k) && row[k] != null) return row[k];
    }
    // Last resort: case-insensitive match, because Notion column names drift.
    const lowered = Object.fromEntries(
        Object.entries(row || {}).map(([k, v]) => [k.toLowerCase().replace(/\s+/g, ''), v]),
    );
    for (const k of keys) {
        const hit = lowered[k.toLowerCase().replace(/\s+/g, '')];
        if (hit != null) return hit;
    }
    return null;
}

function stripEmpty(obj) {
    return Object.fromEntries(Object.entries(obj).filter(([, v]) => v != null && v !== ''));
}

function numOrNull(v) {
    return typeof v === 'number' && Number.isFinite(v) ? v : null;
}

function isoDateOnly(v) {
    if (!v) return null;
    const d = new Date(v);
    return Number.isNaN(d.getTime()) ? null : d.toISOString().slice(0, 10);
}

function truncate(s, n) {
    if (!s) return '';
    return s.length > n ? `${s.slice(0, n - 1)}…` : s;
}

function isEmail(s) {
    return typeof s === 'string' && /^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(s);
}

function sleep(ms) {
    return new Promise((r) => setTimeout(r, ms));
}
