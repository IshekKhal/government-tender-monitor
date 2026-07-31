import { gotScraping } from 'got-scraping';
import dayjs from 'dayjs';
import { Actor, log } from 'apify';
import { fixMojibake } from '../helpers/cleaners.js';

/** Key-value store keys allow only [a-zA-Z0-9!\-_.'()] — normalise query labels. */
function slug(s) {
    return String(s).replace(/[^a-zA-Z0-9]+/g, '_').slice(0, 60);
}

const API_URL = 'https://api.sam.gov/opportunities/v2/search';

/**
 * SAM.gov official API.
 *
 * v1 fetched the most recent N notices and filtered them locally. That was the
 * bug behind "400 fetched, 0 matched": the feed is dominated by ship repair,
 * facilities work, and hardware, so a consultancy's keywords never appear in an
 * arbitrary slice of the newest notices.
 *
 * v2 pushes the capability profile into the query. SAM.gov's search API supports
 * `title` (keyword in title) and `ncode` (NAICS), so each profile signal becomes
 * its own server-side query and the results are merged and deduplicated.
 *
 * This is the difference between "the connector decides what we discard" and
 * "the connector decides what we fetch".
 *
 * @param {number} maxResultsPerSource
 * @param {string} apiKey
 * @param {Object} profile - { keywords: string[], codes: string[] }
 */
export async function fetchTenders(
    maxResultsPerSource = 200,
    apiKey,
    profile = {},
    { maxRequests = 4, cacheHours = 6 } = {},
) {
    if (!apiKey) return [];

    const { keywords = [], codes = [], weights = {} } = profile;

    const now = dayjs();
    const postedTo = now.format('MM/DD/YYYY');
    const postedFrom = now.subtract(90, 'day').format('MM/DD/YYYY');

    // NAICS codes are 6-digit US codes. CPV codes are 8-digit European ones and
    // mean nothing to SAM.gov, so filter them out rather than sending garbage.
    const naicsCodes = codes.filter((c) => /^\d{6}$/.test(String(c).trim()));

    /** @type {Array<{label: string, params: Object}>} */
    const queries = [];

    // ORDER MATTERS — this is a request budget, not a query list.
    //
    // SAM.gov gives non-federal API keys 10 requests PER DAY. One query per
    // profile signal burns the entire daily allowance in two runs, which is
    // exactly what happened on 2026-07-31: three runs at five queries each,
    // throttled on the eleventh request.
    //
    // Observed yield from a real profile:
    //   naics=541512            -> 40 results
    //   title~"cyber security"  ->  2 results
    //   title~"devops"          ->  1 result
    //   title~"cloud migration" ->  0 results
    //   title~"kubernetes"      ->  0 results
    //
    // Classification codes return an order of magnitude more per request, so
    // they go first. Keywords follow, heaviest first, and get cut when the
    // budget runs out.
    for (const code of naicsCodes) {
        queries.push({ label: `naics=${code}`, params: { ncode: code } });
    }

    const rankedKeywords = [...keywords].sort(
        (a, b) => (weights[b] ?? 1) - (weights[a] ?? 1),
    );
    for (const kw of rankedKeywords) {
        queries.push({ label: `title~"${kw}"`, params: { title: kw } });
    }

    // No profile signals -> behave like v1 and return the recent feed. Keeps the
    // Actor usable for someone who hasn't filled in their profile yet.
    if (queries.length === 0) {
        log.warning('SAM.gov: no keywords or NAICS codes in profile — falling back to recent feed.');
        queries.push({ label: 'recent (unfiltered)', params: {} });
    }

    const budgeted = queries.slice(0, maxRequests);
    if (queries.length > budgeted.length) {
        log.warning(
            `SAM.gov: ${queries.length} profile signals but a budget of ${maxRequests} ` +
                `request(s)/run (free keys allow 10/day). Dropping: ` +
                `${queries.slice(maxRequests).map((q) => q.label).join(', ')}`,
        );
    }

    log.info(`SAM.gov: running ${budgeted.length} profile-driven quer(ies)...`);

    const byId = new Map();
    const perQueryLimit = Math.max(20, Math.ceil(maxResultsPerSource / budgeted.length));

    for (const q of budgeted) {
        if (byId.size >= maxResultsPerSource) break;

        try {
            // Cache lookup before spending a request.
            //
            // With a 10/day ceiling, a debugging session is the thing most
            // likely to exhaust the quota — and the tender feed barely moves
            // hour to hour, so re-fetching it is pure waste. Cached responses
            // make iteration free and leave the allowance for real runs.
            const cacheKey = `SAM_${slug(q.label)}_${postedFrom.replace(/\//g, '')}`;
            const cached = await Actor.getValue(cacheKey);
            const ageHours = cached ? (Date.now() - cached.ts) / 3_600_000 : Infinity;

            let items;
            if (cached && ageHours < cacheHours) {
                items = cached.items;
                log.info(
                    `SAM.gov [${q.label}] served from cache ` +
                        `(${ageHours.toFixed(1)}h old, 0 requests spent)`,
                );
            } else {
                const res = await gotScraping({
                    url: API_URL,
                    searchParams: {
                        limit: Math.min(perQueryLimit, 1000),
                        offset: 0,
                        api_key: apiKey,
                        postedFrom,
                        postedTo,
                        ...q.params,
                    },
                    responseType: 'json',
                    timeout: { request: 30000 },
                    throwHttpErrors: false,
                });

                if (res.statusCode === 429) {
                    const next = res.body?.nextAccessTime || 'the next daily reset';
                    log.warning(
                        `SAM.gov [${q.label}] quota exhausted — free keys allow 10 requests/day. ` +
                            `Access returns at ${next}. Serving whatever is cached and continuing.`,
                    );
                    // Stale cache beats nothing at all.
                    if (cached) {
                        items = cached.items;
                        log.info(`  using stale cache (${ageHours.toFixed(1)}h old)`);
                    } else {
                        continue;
                    }
                } else if (res.statusCode !== 200) {
                    log.warning(
                        `SAM.gov [${q.label}] HTTP ${res.statusCode}: ` +
                            `${JSON.stringify(res.body).slice(0, 200)}`,
                    );
                    continue;
                } else {
                    items = res.body?.opportunitiesData || [];
                    await Actor.setValue(cacheKey, { ts: Date.now(), items });
                }
            }

            let added = 0;

            for (const item of items) {
                if (byId.size >= maxResultsPerSource) break;
                if (!item.noticeId || byId.has(item.noticeId)) continue;
                byId.set(item.noticeId, mapNotice(item, q.label));
                added += 1;
            }

            log.info(
                `SAM.gov [${q.label}] -> ${items.length} returned, ${added} new ` +
                    `(running total ${byId.size})`,
            );
        } catch (err) {
            log.warning(`SAM.gov [${q.label}] failed: ${err.message}`);
        }
    }

    const tenders = [...byId.values()];
    log.info(`SAM.gov (Official): Total collected ${tenders.length}`);
    return tenders;
}

function mapNotice(item, matchedVia) {
    // Repair encoding at the point of ingestion, not on the way out. Fixing it
    // only at dataset-write time meant every log line, every score reason and
    // every dry-run preview still showed "â€“", which reads as our bug.
    // The v2 response puts naicsCode, classificationCode, award, pointOfContact
    // and placeOfPerformance at the TOP LEVEL of each opportunity — not under a
    // `data` object, despite what the docs table's "data.award.amount" style
    // naming suggests. Reading item.data.naicsCode silently yields undefined for
    // every record, which is why NAICS matching never fired and every contact
    // field came back empty. Prefer top level, fall back to data.* just in case.
    const pick2 = (a, b) => (a !== undefined && a !== null ? a : b);

    const title = fixMojibake(item.title || '');
    const description = fixMojibake(item.description || '');
    const agency = fixMojibake(item.fullParentPathName || item.organizationName || 'USA Government');
    const postedDateISO = item.postedDate ? dayjs(item.postedDate).toISOString() : null;
    const deadlineISO = item.responseDeadLine ? dayjs(item.responseDeadLine).toISOString() : null;

    const award = pick2(item.award, item.data?.award) || {};
    const awardAmountUSD = award.amount ? parseFloat(award.amount) : null;

    const link =
        item.uiLink ||
        (item.links && item.links.length > 0
            ? item.links[0].href
            : `https://sam.gov/opp/${item.noticeId}/view`);

    const poc = (pick2(item.pointOfContact, item.data?.pointOfContact) || [])[0] || {};
    const place = pick2(item.placeOfPerformance, item.data?.placeOfPerformance) || {};

    const rawNaics = pick2(item.naicsCode, item.data?.naicsCode);
    const naicsCode = rawNaics ? String(rawNaics) : '';
    const classificationCode = pick2(item.classificationCode, item.data?.classificationCode) || '';
    const setAside =
        pick2(item.typeOfSetAsideDescription, item.data?.typeOfSetAsideDescription) ||
        item.setAside ||
        null;

    // SAM.gov nests the buyer as Department -> Agency -> Office in a single
    // slash-delimited path. Splitting it is what makes past-performance matching
    // work against any level of the hierarchy, not just the full string.
    const pathParts = (item.fullParentPathName || '').split('.').filter(Boolean);

    return {
        rawSourceId: item.noticeId,
        title,
        description,

        buyer: agency,
        buyerDepartment: pathParts[0] || null,
        buyerAgency: pathParts[1] || null,
        buyerOffice: pathParts[2] || null,
        buyerContactName: poc.fullName || '',
        buyerContactEmail: poc.email || '',
        buyerContactPhone: poc.phone || '',
        // place.city / place.state / place.country are objects with .name/.code,
        // not strings. Interpolating them directly produced "[object Object]".
        buyerAddress: place.city
            ? [place.city?.name, place.state?.code || place.state?.name, place.country?.code]
                  .filter(Boolean)
                  .join(', ')
            : '',

        country: 'USA',
        region: place.state?.code || place.state?.name || '',
        postcode: place.zip || '',
        placeOfPerformance: place.state?.name || place.state?.code || null,

        noticeType: item.type || '',
        status: item.active ? 'Active' : 'Archived',
        procurementMethod: item.solicitationNumber || '',
        category: item.type,
        cpvCode: null,
        naicsCode,
        classificationCode,

        currency: 'USD',
        valueLow: null,
        valueHigh: awardAmountUSD,
        awardValue: awardAmountUSD,
        awardDate: award.date || null,
        supplierAwarded: award.awardee?.name || '',
        supplierUei: award.awardee?.ueiSAM || null,
        budgetOriginal: awardAmountUSD,
        budgetUsd: awardAmountUSD,

        startDate: null,
        endDate: null,
        contractDuration: null,
        deadline: deadlineISO,
        publishedDate: postedDateISO,

        documents: item.links || [],
        documentUrls: (item.links || []).map((l) => l.href),

        isSMEEligible: setAside ? setAside.toLowerCase().includes('small business') : null,
        setAside,
        sourceName: 'SAM.gov',
        sourceUrl: link,
        sourceRecordUrl: link,

        // Which profile signal pulled this record in. Useful in the dataset and
        // it makes the "profile-driven" claim auditable rather than asserted.
        matchedVia,

        keywordsMatched: [],
        confidenceScore: 0,
    };
}
