import { log } from 'apify';
import { gotScraping } from 'got-scraping';
import { normalizeCurrencyToUsd } from '../helpers/normalize.js';
import { fixMojibake } from '../helpers/cleaners.js';

const BASE_URL = 'https://www.contractsfinder.service.gov.uk/Published/Notices/OCDS/Search';

/**
 * UK Contracts Finder, OCDS endpoint.
 *
 * Same change as the SAM.gov source: the capability profile now drives the
 * query instead of only filtering the results. Contracts Finder's OCDS search
 * supports `keyword` and `cpvCodes`, so each profile signal becomes a separate
 * server-side query and the results are merged and deduplicated.
 *
 * @param {number} limit
 * @param {Object} profile - { keywords: string[], codes: string[] }
 */
export async function fetchTenders(limit = 200, profile = {}) {
    const { keywords = [], codes = [] } = profile;
    const cpvCodes = codes.filter((c) => /^\d{8}$/.test(String(c).trim()));

    // IMPORTANT ASYMMETRY, and worth writing about:
    //
    // SAM.gov's search API accepts `title` and `ncode`, so the capability profile
    // can be pushed down into the query. Contracts Finder's OCDS endpoint accepts
    // ONLY publishedFrom, publishedTo, stages, limit and cursor — no keyword, no
    // CPV filter. (Its POST /Searches/Search endpoint does support keywords, but
    // returns a different, non-OCDS shape.)
    //
    // An earlier version of this file passed `keyword=` and `cpvCodes=` here. The
    // API ignored them silently and returned the same recent feed for every
    // query. The tell was that five different keywords each returned exactly the
    // page cap — including "kubernetes", which has no live UK tenders.
    //
    // Unknown parameters being ignored rather than rejected is the failure mode
    // to design around: it looks like it works.
    //
    // So the UK path does the opposite of the US path — pull a deliberately wide
    // pool server-side, then filter locally against the profile. Same outcome,
    // different division of labour, because the APIs are not equally capable.
    log.info(
        'UK Contracts: OCDS endpoint has no server-side keyword/CPV filter — ' +
            'fetching a wide pool and filtering locally against the profile.',
    );

    const publishedTo = new Date().toISOString();
    // Look back far enough that a niche profile still has something to match.
    const publishedFrom = new Date(Date.now() - 90 * 864e5).toISOString();

    // Overfetch: the local filter will discard most of it, so the pool has to be
    // much larger than the target. Capped to stay well inside the rate limit —
    // Contracts Finder returns 403 and demands a 5-minute cooldown if pushed.
    const poolTarget = Math.min(Math.max(limit * 5, 500), 2000);

    const byId = new Map();
    let nextUrl =
        `${BASE_URL}?limit=100` +
        `&publishedFrom=${encodeURIComponent(publishedFrom)}` +
        `&publishedTo=${encodeURIComponent(publishedTo)}` +
        `&stages=tender`;
    let pages = 0;

    while (byId.size < poolTarget && pages < 25) {
        try {
            const res = await gotScraping({
                url: nextUrl,
                responseType: 'json',
                timeout: { request: 30000 },
            }).json();

            if (!res || (!res.records && !res.releases)) {
                log.warning('UK Contracts: unexpected response structure.');
                break;
            }

            const items = res.records || res.releases || [];
            if (items.length === 0) break;

            for (const r of items) {
                if (!r.id || byId.has(r.id)) continue;
                byId.set(r.id, mapRecord(r, 'uk-pool'));
            }

            pages += 1;

            if (res.links?.next) {
                nextUrl = res.links.next;
            } else {
                break;
            }
        } catch (err) {
            const msg = String(err.message || '');
            if (msg.includes('403')) {
                log.warning(
                    'UK Contracts: hit the rate limit (403). Contracts Finder requires a ' +
                        `5-minute cooldown. Continuing with the ${byId.size} record(s) collected.`,
                );
            } else {
                log.warning(`UK Contracts failed on page ${pages + 1}: ${err.message}`);
            }
            break;
        }
    }

    const pool = [...byId.values()];
    log.info(`UK Contracts: pool of ${pool.length} record(s) over ${pages} page(s).`);

    // Local relevance pass. Tag each survivor with what matched it, so the
    // dataset shows why a UK record is present just as it does for a US one.
    const hasProfile = keywords.length > 0 || cpvCodes.length > 0;
    if (!hasProfile) {
        log.warning('UK Contracts: empty profile — returning the pool unfiltered.');
        return pool.slice(0, limit);
    }

    const matched = [];
    for (const t of pool) {
        if (matched.length >= limit) break;

        const text = [t.title, t.description, t.buyer, t.cpvCode, t.classificationCode]
            .filter(Boolean)
            .join(' ')
            .toLowerCase();

        const kwHit = keywords.find((k) => {
            if (text.includes(k)) return true;
            const words = k.split(/\s+/).filter((w) => w.length > 2);
            return words.length > 1 && words.every((w) => text.includes(w));
        });

        const cpvHit = cpvCodes.find((c) =>
            [t.cpvCode, t.classificationCode]
                .filter(Boolean)
                .some((tc) => String(tc).startsWith(String(c).slice(0, 4))),
        );

        if (kwHit || cpvHit) {
            t.matchedVia = kwHit ? `keyword~"${kwHit}"` : `cpv=${cpvHit}`;
            matched.push(t);
        }
    }

    log.info(
        `UK Contracts: ${matched.length} of ${pool.length} matched the profile locally.`,
    );
    return matched;
}

function mapRecord(r, matchedVia) {
    const t = r.tender ?? {};
    const currency = t.value?.currency ?? 'GBP';
    const budgetOriginal = t.value?.amount ?? null;

    const buyer = r.buyer || {};
    const contact = t.contactPoint || r.contactPoint || {};

    const items = t.items || [];
    const classification = items[0]?.classification || {};

    const awards = r.awards || [];
    const firstAward = awards[0] || {};
    const status = t.status || 'active';
    const isAwarded = status.toLowerCase().includes('award') || awards.length > 0;

    const addressParts = [
        buyer.address?.streetAddress,
        buyer.address?.locality,
        buyer.address?.region,
        buyer.address?.postalCode,
        buyer.address?.countryName,
    ]
        .filter(Boolean)
        .join(', ');

    return {
        rawSourceId: r.id ?? '',
        title: fixMojibake(t.title || r.title || ''),
        description: fixMojibake(t.description || r.description || ''),
        noticeType: r.tag ? r.tag.join(', ') : isAwarded ? 'contract' : 'opportunity',
        status,

        buyer: buyer.name || '',
        buyerDepartment: buyer.name || null,
        buyerAgency: null,
        buyerOffice: null,
        buyerContactName: contact.name || '',
        buyerContactEmail: contact.email || '',
        buyerContactPhone: contact.telephone || '',
        buyerAddress: addressParts,

        country: 'UK',
        region: buyer.address?.region || '',
        postcode: buyer.address?.postalCode || '',
        placeOfPerformance: buyer.address?.region || null,

        cpvCode: classification.id || null,
        naicsCode: null,
        classificationCode: classification.id || null,
        setAside: null,
        isSMEEligible: t.suitability?.sme ?? null,

        currency,
        valueLow: t.minValue?.amount ?? null,
        valueHigh: t.value?.amount ?? null,
        awardValue: firstAward.value?.amount ?? null,
        budgetOriginal,
        budgetUsd: normalizeCurrencyToUsd(budgetOriginal, currency),

        publishedDate: r.date ?? null,
        deadline: t.tenderPeriod?.endDate ?? null,
        contractStartDate: t.contractPeriod?.startDate ?? null,
        contractEndDate: t.contractPeriod?.endDate ?? null,
        awardDate: firstAward.date ?? null,

        supplierName: firstAward.suppliers?.[0]?.name ?? '',
        supplierUei: null,

        documentUrls: (t.documents || []).map((d) => d.url).filter(Boolean),

        sourceName: 'Contracts Finder UK',
        sourceRecordUrl: `https://www.contractsfinder.service.gov.uk/Notice/${r.id}`,

        matchedVia,

        keywordsMatched: [],
        confidenceScore: 0,
    };
}
