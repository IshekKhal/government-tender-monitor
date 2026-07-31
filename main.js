/**
 * Government Contract Monitor v2 — Notion-driven.
 *
 * v1 shape:  input form -> scrape -> score -> dataset. Done.
 * v2 shape:  Notion -> scrape -> score -> dedupe -> Notion.
 *
 * The connector fires FIRST. The user's own records decide what gets scraped
 * and how it is scored, and the same records tell the Actor what it has already
 * reported so a scheduled run stops re-inserting the same contract every day.
 *
 * Run phases:
 *   0. Connect to both connectors through the Apify MCP proxy
 *   1. READ  — capability profile from Notion  (keywords, codes, past wins, exclusions)
 *   2. READ  — existing pipeline rows          (dedupe index)
 *   3. SCRAPE — SAM.gov + UK Contracts Finder  (unchanged from v1)
 *   4. SCORE  — personalised against the profile, with v1 score kept for comparison
 *   5. FILTER — drop anything already in the pipeline
 *   6. WRITE  — new qualifying contracts back into Notion
 */

import { Actor, log } from 'apify';
import { gotScraping } from 'got-scraping';

import { cleanRecord } from './src/helpers/cleaners.js';
import { processTenders } from './src/helpers/filters.js';
import * as samOfficial from './src/sources/us_sam_official.js';
import * as ukSource from './src/sources/uk_contracts.js';

import { connectToConnector, closeAll } from './src/connectors/mcpClient.js';
import {
    assertReadCapability,
    readCapabilityProfile,
    readExistingPipelineIds,
    reportDroppedSelects,
    writeAllContracts,
} from './src/connectors/notion.js';

const SOURCES = {
    SAM_OFFICIAL: { module: samOfficial, countries: ['USA', 'US', 'UNITED STATES'] },
    UK: { module: ukSource, countries: ['UK', 'UNITED KINGDOM', 'GB'] },
};

const EU_COUNTRIES = ['EU', 'GERMANY', 'FRANCE', 'SPAIN', 'ITALY'];

await Actor.init();

let capabilityClient = null;
let pipelineClient = null;

try {
    const input = (await Actor.getInput()) || {};
    const {
        capabilityConnector,
        pipelineConnector,
        capabilityDatabaseId,
        pipelineDatabaseId,
        minimumScore = 65,
        dryRun = true,
        maxWritesPerRun = 50,
        countries = [],
        maxResultsPerSource = 200,
        notifyWebhook = null,
        samApiKey = null,
    } = input;

    if (!capabilityConnector || !pipelineConnector) {
        throw new Error(
            'Both Notion connectors are required. Select them in the input form. ' +
                'If the picker shows no options, your connector does not satisfy the ' +
                'mcpServers rules in INPUT_SCHEMA.json — run tools/discover-tools.js.',
        );
    }
    if (!capabilityDatabaseId || !pipelineDatabaseId) {
        throw new Error('Both Notion database IDs are required. See README for where to find them.');
    }

    /* ---------------------------------------------------------------------- */
    /* PHASE 0 — open the connector sessions                                   */
    /* ---------------------------------------------------------------------- */
    log.info('=== PHASE 0: connecting to MCP connectors ===');

    const cap = await connectToConnector(capabilityConnector, 'capability (read)');
    capabilityClient = cap.client;

    const pipe = await connectToConnector(pipelineConnector, 'pipeline (read+write)');
    pipelineClient = pipe.client;

    // Worth logging explicitly: these two lists differ, and the difference is
    // enforced by the Apify proxy from the input schema, not by this code.
    log.info(
        `Permission split — capability connector sees ${cap.tools.length} tool(s), ` +
            `pipeline connector sees ${pipe.tools.length} tool(s).`,
    );

    // Preflight. Fail here with instructions rather than 40 seconds into a scrape
    // that was never going to produce anything.
    assertReadCapability(cap.tools, 'capability (read)');
    assertReadCapability(pipe.tools, 'pipeline (read+write)');

    /* ---------------------------------------------------------------------- */
    /* PHASE 1 — READ the capability profile                                   */
    /* ---------------------------------------------------------------------- */
    log.info('=== PHASE 1: reading capability profile from Notion ===');

    const profile = await readCapabilityProfile(
        capabilityClient,
        cap.tools,
        capabilityDatabaseId,
        input.capabilityViewUrl || null,
    );

    if (profile.keywords.length === 0 && profile.codes.length === 0) {
        log.warning(
            'Capability profile produced no keywords or codes. The Actor will match ' +
                'every tender, which is almost certainly not what you want. Check that ' +
                'the database has rows and that the Type column values are spelled as ' +
                'documented in the README.',
        );
    }

    /* ---------------------------------------------------------------------- */
    /* PHASE 2 — READ the existing pipeline (dedupe index)                     */
    /* ---------------------------------------------------------------------- */
    log.info('=== PHASE 2: building dedupe index from existing pipeline ===');

    const alreadyReported = await readExistingPipelineIds(
        pipelineClient,
        pipe.tools,
        pipelineDatabaseId,
        input.pipelineViewUrl || null,
    );

    /* ---------------------------------------------------------------------- */
    /* PHASE 3 — SCRAPE (unchanged from v1)                                    */
    /* ---------------------------------------------------------------------- */
    log.info('=== PHASE 3: fetching from government sources ===');

    const selectedSources = [];
    const countrySet = new Set(countries.map((c) => c.toUpperCase()));
    const getAll = countrySet.size === 0;
    const resolvedSamApiKey = samApiKey || process.env.SAM_API_KEY || null;

    if ([...countrySet].some((c) => EU_COUNTRIES.includes(c))) {
        log.warning('EU sources are unavailable — currently only USA + UK are supported.');
    }

    if (getAll || [...countrySet].some((c) => SOURCES.SAM_OFFICIAL.countries.includes(c))) {
        if (resolvedSamApiKey) {
            log.info('Using official SAM.gov source (API key provided).');
            selectedSources.push({
                name: 'SAM.gov (Official)',
                // The profile is passed into the fetcher, not just the filter.
                // This is the difference between the connector deciding what we
                // discard and the connector deciding what we fetch.
                runner: (limit) =>
                    SOURCES.SAM_OFFICIAL.module.fetchTenders(limit, resolvedSamApiKey, profile, {
                        maxRequests: input.samMaxRequestsPerRun ?? 4,
                        cacheHours: input.samCacheHours ?? 6,
                    }),
            });
        } else {
            log.warning('SAM.gov API key not provided — skipping U.S. federal tenders.');
        }
    }

    if (getAll || [...countrySet].some((c) => SOURCES.UK.countries.includes(c))) {
        selectedSources.push({
            name: 'UK Contracts',
            runner: (limit) => SOURCES.UK.module.fetchTenders(limit, profile),
        });
    }

    if (selectedSources.length === 0) {
        throw new Error('No sources matched the country filter, or required API keys are missing.');
    }

    const resultsArrays = await Promise.all(
        selectedSources.map(async (source) => {
            try {
                log.info(`Launching ${source.name}...`);
                const tenders = await source.runner(maxResultsPerSource);
                log.info(`${source.name} finished — ${tenders.length} raw results.`);
                return tenders;
            } catch (err) {
                log.error(`${source.name} failed: ${err.message}`);
                return [];
            }
        }),
    );

    const allTenders = resultsArrays.flat();
    log.info(`Total raw tenders fetched: ${allTenders.length}`);

    /* ---------------------------------------------------------------------- */
    /* PHASE 4 — SCORE against the profile                                     */
    /* ---------------------------------------------------------------------- */
    log.info('=== PHASE 4: scoring against the capability profile ===');

    const processed = processTenders(allTenders, { ...input, profile });
    log.info(`${processed.length} tender(s) passed filtering.`);

    // The number the article is built on: how many contracts changed rank because
    // the Actor read the user's own records first.
    const moved = processed.filter((t) => t.scoreDelta !== 0);
    const promoted = processed.filter((t) => t.profileContribution > 0);
    const pastWinHits = processed.filter((t) => (t.scoreBreakdown?.pastPerformance ?? 0) > 0);

    log.info(
        `Scoring — ${moved.length} contract(s) scored differently than the v1 formula.`,
    );
    log.info(
        `Profile contribution — ${promoted.length} contract(s) earned points that ` +
            `exist only because the connector read your Notion records first ` +
            `(${pastWinHits.length} from past-win agencies).`,
    );

    // Ranking impact is the claim that matters: not "the score changed" but
    // "the order changed". A contract can gain points and still rank the same.
    const rankWith = [...processed]
        .sort((a, b) => b.confidenceScore - a.confidenceScore)
        .map((t) => t.rawSourceId);
    const rankWithout = [...processed]
        .sort((a, b) => b.confidenceScoreWithoutProfile - a.confidenceScoreWithoutProfile)
        .map((t) => t.rawSourceId);
    const rankChanged = rankWith.filter((id, i) => id !== rankWithout[i]).length;

    log.info(`Ranking — ${rankChanged} of ${processed.length} position(s) changed.`);

    // Show the largest single beneficiary. This is the before/after example the
    // article needs, picked by the data rather than by hand.
    const best = [...processed].sort((a, b) => b.profileContribution - a.profileContribution)[0];
    if (best && best.profileContribution > 0) {
        log.info(
            `Biggest profile effect: "${(best.title || '').slice(0, 70)}" ` +
                `${best.confidenceScoreWithoutProfile} -> ${best.confidenceScore} ` +
                `(+${best.profileContribution}) — ${best.scoreReason}`,
        );
    }

    /* ---------------------------------------------------------------------- */
    /* PHASE 5 — dedupe against what is already in the pipeline                */
    /* ---------------------------------------------------------------------- */
    log.info('=== PHASE 5: deduplicating against existing pipeline ===');

    const duplicates = [];
    const candidates = [];

    // Within-run dedupe, on top of the cross-run dedupe against Notion.
    //
    // SAM.gov reissues the same opportunity under new notice IDs when it's
    // amended or reposted, so an ID-only check let "DE01--ECO Enterprise Service
    // Desk (ESD) Tier One Support" through twice in one batch. Matching on
    // normalised title + buyer catches those.
    const seenThisRun = new Set();
    const fingerprint = (t) =>
        `${(t.title || '').toLowerCase().replace(/\s+/g, ' ').trim()}::${(t.buyer || '')
            .toLowerCase()
            .trim()}`;

    // Two distinct kinds of duplicate, counted separately because they prove
    // different things. Cross-run duplicates are the ones only a connector that
    // READS can catch. Within-run duplicates are SAM.gov reissuing the same
    // opportunity under a new notice ID inside a single batch.
    let crossRunDupes = 0;
    let withinRunDupes = 0;

    for (const t of processed) {
        if (alreadyReported.has(String(t.rawSourceId))) {
            t.skippedAsDuplicate = true;
            duplicates.push(t);
            crossRunDupes += 1;
            continue;
        }

        const fp = fingerprint(t);
        if (seenThisRun.has(fp)) {
            t.skippedAsDuplicate = true;
            duplicates.push(t);
            withinRunDupes += 1;
            continue;
        }
        seenThisRun.add(fp);

        if (t.confidenceScore >= minimumScore) {
            candidates.push(t);
        }
    }

    log.info(
        `${crossRunDupes} already in your pipeline from a previous run, ` +
            `${withinRunDupes} repeated within this batch, ` +
            `${candidates.length} new at or above score ${minimumScore}.`,
    );

    // The claim the article rests on, stated only when it is actually true.
    if (crossRunDupes > 0) {
        log.info(
            `Cross-run deduplication saved ${crossRunDupes} redundant row(s). ` +
                'A write-only Actor would have re-inserted every one of them, ' +
                'and again tomorrow, and again the day after.',
        );
    }
    if (withinRunDupes > 0) {
        log.info(
            `Within-run deduplication saved ${withinRunDupes} row(s) where the source ` +
                'reissued the same opportunity under a new notice ID.',
        );
    }

    const toWrite = candidates.slice(0, maxWritesPerRun);
    if (candidates.length > toWrite.length) {
        log.warning(
            `Capping write-back at ${maxWritesPerRun} row(s); ` +
                `${candidates.length - toWrite.length} will be picked up on the next run.`,
        );
    }

    /* ---------------------------------------------------------------------- */
    /* PHASE 6 — WRITE back                                                    */
    /* ---------------------------------------------------------------------- */
    let writeResult = { written: [], failed: [] };

    if (dryRun) {
        log.info('=== PHASE 6: DRY RUN — nothing will be written to Notion ===');
        for (const t of toWrite) {
            log.info(`  WOULD WRITE  [${t.confidenceScore}]  ${t.title}`);
            log.info(`               ${t.scoreReason}`);
        }
        log.info(`Dry run complete. ${toWrite.length} row(s) would have been created.`);
    } else {
        log.info(`=== PHASE 6: writing ${toWrite.length} contract(s) to Notion ===`);
        writeResult = await writeAllContracts(
            pipelineClient,
            pipe.tools,
            pipelineDatabaseId,
            toWrite,
            { chunkSize: 25, delayMs: 500, schema: alreadyReported.schema },
        );

        const writtenSet = new Set(writeResult.written.map(String));
        for (const t of toWrite) {
            t.writtenToPipeline = writtenSet.has(String(t.rawSourceId));
        }

        reportDroppedSelects();

        log.info(
            `Write-back complete: ${writeResult.written.length} succeeded, ` +
                `${writeResult.failed.length} failed.`,
        );
        for (const f of writeResult.failed) {
            log.warning(`  failed ${f.id}: ${f.error}`);
        }
    }

    /* ---------------------------------------------------------------------- */
    /* Output                                                                  */
    /* ---------------------------------------------------------------------- */
    await Actor.pushData(processed.map((r) => cleanRecord(r)));

    const summary = {
        runFinishedAt: new Date().toISOString(),
        dryRun,
        profile: {
            keywords: profile.keywords.length,
            codes: profile.codes.length,
            wonAgencies: profile.wonAgencies.length,
            excludeBuyers: profile.excludeBuyers.length,
        },
        rawFetched: allTenders.length,
        passedFilters: processed.length,
        scoredDifferentlyThanV1: moved.length,
        promotedByProfile: promoted.length,
        promotedByPastWins: pastWinHits.length,
        rankingPositionsChanged: rankChanged,
        biggestProfileGain: best?.profileContribution ?? 0,
        duplicatesSuppressed: duplicates.length,
        crossRunDuplicates: crossRunDupes,
        withinRunDuplicates: withinRunDupes,
        newAboveThreshold: candidates.length,
        written: writeResult.written.length,
        writeFailures: writeResult.failed.length,
    };

    await Actor.setValue('RUN_SUMMARY', summary);
    log.info(`Run summary: ${JSON.stringify(summary, null, 2)}`);

    if (notifyWebhook) {
        try {
            await gotScraping.post(notifyWebhook, {
                json: { ...summary, top_matches: processed.slice(0, 5) },
            });
            log.info('Webhook notification sent.');
        } catch (err) {
            log.error(`Failed to send webhook: ${err.message}`);
        }
    }

    log.info('Actor finished successfully.');
} catch (error) {
    log.error(`Actor failed: ${error.message}`);
    log.error(error.stack);
    throw error;
} finally {
    // The proxy session expires the moment the run ends, so close cleanly before
    // exiting rather than relying on teardown.
    await closeAll([capabilityClient, pipelineClient]);
    await Actor.exit();
}
