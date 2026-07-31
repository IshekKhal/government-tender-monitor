import dayjs from 'dayjs';
import { log } from 'apify';

/**
 * v1 scoring, kept verbatim for comparison.
 *
 * This function is no longer the main scorer. It stays here because the whole
 * point of v2 is that the same contract scores differently once the Actor has
 * read the user's capability profile — and you cannot demonstrate that without
 * running both scorers over identical input.
 *
 * Every output record carries `confidenceScoreV1` alongside the new score.
 */
export function calculateConfidenceV1(tender, keywords) {
    let score = 50;
    const matches = new Set();

    const textToCheck = [
        tender.title,
        tender.description,
        tender.buyer,
        tender.naicsCode,
        tender.cpvCode,
        tender.classificationCode,
    ]
        .filter(Boolean)
        .join(' ')
        .toLowerCase();

    let keywordPoints = 0;
    const safeKeywords = Array.isArray(keywords) ? keywords : [];

    for (const kw of safeKeywords) {
        const lowerKw = kw.toLowerCase();
        if ((tender.title || '').toLowerCase().includes(lowerKw)) {
            matches.add(kw);
            keywordPoints += 15;
        } else if (textToCheck.includes(lowerKw)) {
            matches.add(kw);
            keywordPoints += 5;
        }
    }
    score += Math.min(40, keywordPoints);

    if ((tender.budgetUsd && tender.budgetUsd > 0) || (tender.awardValue && tender.awardValue > 0)) {
        score += 10;
    }

    if (tender.buyerContactEmail || (tender.documentUrls && tender.documentUrls.length > 0)) {
        score += 10;
    }

    if (tender.publishedDate) {
        const daysAgo = dayjs().diff(dayjs(tender.publishedDate), 'day');
        if (daysAgo <= 1) score += 10;
        else if (daysAgo <= 7) score += 5;
        else if (daysAgo <= 30) score += 2;
    }

    return { score: Math.min(100, score), matches: Array.from(matches) };
}

/**
 * v2 scoring — personalised against the capability profile read from Notion.
 *
 * The structural change from v1: v1 could only ask "does this contract match the
 * words you typed into the input form?" v2 can ask "does this match the work you
 * are actually qualified for, and have you won with this buyer before?"
 *
 * That second question is only answerable because the connector fired before the
 * scrape and read the user's own records.
 *
 * Weighting (max 115, capped at 100 — nothing realistically scores every band):
 *   base                      40
 *   weighted keyword match  +  0..25
 *   classification code     +  0..15   <- profile-driven
 *   past-performance buyer  +  0..15   <- profile-driven
 *   budget present          +  0..5
 *   contact/docs present    +  0..5
 *   recency                 +  0..10
 *
 * @param {Object} tender
 * @param {Object} profile - from readCapabilityProfile()
 * @returns {{score:number, matches:string[], reason:string, breakdown:Object}}
 */
export function calculateConfidence(tender, profile = {}) {
    const { keywords = [], codes = [], wonAgencies = [], weights = {} } = profile;

    const breakdown = {
        base: 40,
        keywords: 0,
        classification: 0,
        pastPerformance: 0,
        budget: 0,
        completeness: 0,
        recency: 0,
    };
    const matches = new Set();
    const reasons = [];

    const title = (tender.title || '').toLowerCase();
    const haystack = [
        tender.title,
        tender.description,
        tender.buyer,
        tender.naicsCode,
        tender.cpvCode,
        tender.classificationCode,
    ]
        .filter(Boolean)
        .join(' ')
        .toLowerCase();

    /* 1. Weighted keyword match (max +25) ---------------------------------- */
    // v1 gave every keyword equal weight. v2 reads a Weight column from the
    // profile, so "cyber security" can outrank "consulting" for a firm whose
    // actual business is security.
    let kwPoints = 0;
    for (const kw of keywords) {
        const w = weights[kw] ?? 1;
        if (title.includes(kw)) {
            matches.add(kw);
            kwPoints += 9 * w;
        } else if (haystack.includes(kw)) {
            matches.add(kw);
            kwPoints += 3 * w;
        }
    }
    breakdown.keywords = Math.min(25, Math.round(kwPoints));
    if (breakdown.keywords > 0) {
        reasons.push(`keywords ${[...matches].join(', ')} (+${breakdown.keywords})`);
    }

    /* 2. Classification code match (max +15) ------------------------------- */
    // A NAICS or CPV match is a far stronger qualification signal than a word in
    // a description, because the buyer assigned that code deliberately.
    const tenderCodes = [tender.naicsCode, tender.cpvCode, tender.classificationCode]
        .filter(Boolean)
        .map((c) => String(c).toLowerCase());

    const codeHits = codes.filter((c) =>
        tenderCodes.some((tc) => tc.startsWith(String(c).toLowerCase())),
    );
    if (codeHits.length > 0) {
        // Circular-signal guard.
        //
        // If a record was FETCHED by a code query (matchedVia = "naics=541512"),
        // then of course it carries that code — every result of that query does.
        // Awarding +15 for it gives every record in the batch the same points and
        // destroys the ranking: the first run produced twelve contracts all
        // scoring exactly 70, including "Raised Floor Tiles".
        //
        // A signal you searched on cannot also be evidence. Only score a code
        // match that the query did not guarantee.
        const fetchedByThisCode = codeHits.some((c) =>
            String(tender.matchedVia || '').includes(String(c)),
        );

        if (!fetchedByThisCode) {
            breakdown.classification = 15;
            for (const c of codeHits) matches.add(c);
            reasons.push(`classification code ${codeHits.join(', ')} (+15)`);
        } else {
            reasons.push(`code ${codeHits.join(', ')} matched but was the search term (+0)`);
        }
    }

    /* 3. Past-performance bonus (max +15) ---------------------------------- */
    // The signal v1 structurally could not see. If the team has won with this
    // department, agency, or office before, the contract is materially easier to
    // win and belongs at the top of the list.
    const buyerFields = [
        tender.buyer,
        tender.buyerDepartment,
        tender.buyerAgency,
        tender.buyerOffice,
    ]
        .filter(Boolean)
        .map((b) => String(b).toLowerCase());

    const agencyHit = wonAgencies.find((a) => buyerFields.some((b) => b.includes(a)));
    if (agencyHit) {
        breakdown.pastPerformance = 15;
        reasons.push(`previously won with "${agencyHit}" (+15)`);
    }

    /* 4-6. Structural signals ---------------------------------------------- */
    if ((tender.budgetUsd && tender.budgetUsd > 0) || (tender.awardValue && tender.awardValue > 0)) {
        breakdown.budget = 5;
        reasons.push('budget published (+5)');
    }

    if (tender.buyerContactEmail || (tender.documentUrls && tender.documentUrls.length > 0)) {
        breakdown.completeness = 5;
        reasons.push('contact or documents available (+5)');
    }

    if (tender.publishedDate) {
        const daysAgo = dayjs().diff(dayjs(tender.publishedDate), 'day');
        if (daysAgo <= 1) breakdown.recency = 10;
        else if (daysAgo <= 7) breakdown.recency = 5;
        else if (daysAgo <= 30) breakdown.recency = 2;
        if (breakdown.recency) reasons.push(`published ${daysAgo}d ago (+${breakdown.recency})`);
    }

    const raw = Object.values(breakdown).reduce((a, b) => a + b, 0);

    return {
        score: Math.min(100, raw),
        matches: [...matches].filter(Boolean),
        reason: `base 40; ${reasons.join('; ') || 'no additional signals'}`,
        breakdown,
    };
}

/**
 * Filters and scores tenders against the capability profile.
 *
 * @param {Object[]} tenders
 * @param {Object} criteria - input fields plus `profile` read from Notion
 */
export function processTenders(tenders, criteria) {
    const {
        excludeKeywords = [],
        countries = [],
        minimumBudget = 0,
        deadlineWithinDays,
        includeExpired = false,
        includeNoDeadline = true,
        profile = { keywords: [], codes: [], wonAgencies: [], excludeBuyers: [], weights: {} },
    } = criteria;

    const {
        keywords = [],
        codes = [],
        wonAgencies = [],
        excludeBuyers = [],
        excludeTerms = [],
    } = profile;

    // Exclusions can come from two places: the Notion profile (preferred — it
    // lives with everything else that describes what this team wants) and the
    // legacy input field. Merge both so neither is silently ignored.
    const allExcludeTerms = [
        ...excludeTerms,
        ...excludeKeywords.map((k) => String(k).toLowerCase()),
    ];

    if (allExcludeTerms.length > 0) {
        // Logged loudly because an exclude list is invisible in its effect —
        // it only ever removes things, and a term entered by mistake looks
        // exactly like "the search found nothing".
        log.info(`Exclusion terms active: [${allExcludeTerms.join(', ')}]`);
    }

    log.info(`Processing ${tenders.length} raw tenders against the capability profile...`);

    // Drop-reason funnel. "0 passed filtering" out of 400 is useless on its own —
    // it could be the keywords, the deadline window, the country list, or a
    // parsing failure upstream. Counting each gate turns a mystery into a number.
    const dropped = {
        noKeywordMatch: 0,
        excludedKeyword: 0,
        excludedBuyer: 0,
        countryMismatch: 0,
        belowBudget: 0,
        deadlinePassed: 0,
        deadlineTooFar: 0,
        noDeadlineField: 0,
    };

    const results = [];

    for (const tender of tenders) {
        const text = [
            tender.title,
            tender.description,
            tender.buyer,
            tender.naicsCode,
            tender.cpvCode,
            tender.classificationCode,
        ]
            .filter(Boolean)
            .join(' ')
            .toLowerCase();

        // Relevance gate. v1 only checked keywords, which was wrong once the
        // profile also carries codes and past-win agencies: a contract pulled in
        // by a NAICS query, or one from an agency you've already won with, would
        // be discarded for not containing a keyword string. Any profile signal
        // now qualifies a record.
        const codeMatch =
            codes.length > 0 &&
            [tender.naicsCode, tender.cpvCode, tender.classificationCode]
                .filter(Boolean)
                .some((tc) => codes.some((c) => String(tc).toLowerCase().startsWith(String(c).toLowerCase())));

        const agencyMatch =
            wonAgencies.length > 0 &&
            [tender.buyer, tender.buyerDepartment, tender.buyerAgency, tender.buyerOffice]
                .filter(Boolean)
                .some((b) => wonAgencies.some((a) => String(b).toLowerCase().includes(a)));

        // Multi-word keywords are matched word-by-word rather than as an exact
        // substring. "cloud migration" should match "Migration to Cloud
        // Infrastructure"; requiring the literal phrase means it doesn't.
        const keywordMatch =
            keywords.length > 0 &&
            keywords.some((k) => {
                if (text.includes(k)) return true;
                const words = k.split(/\s+/).filter((w) => w.length > 2);
                return words.length > 1 && words.every((w) => text.includes(w));
            });

        const hasProfile = keywords.length > 0 || codes.length > 0 || wonAgencies.length > 0;
        const kwMatch = hasProfile ? keywordMatch || codeMatch || agencyMatch : true;

        const exMatch =
            allExcludeTerms.length > 0 ? allExcludeTerms.some((k) => text.includes(k)) : false;

        if (!kwMatch) {
            dropped.noKeywordMatch += 1;
            continue;
        }
        if (exMatch) {
            dropped.excludedKeyword += 1;
            continue;
        }

        // Excluded buyers come from the profile, not the input form. Teams have
        // agencies they will not bid on — bad payment history, conflict of
        // interest, a prior dispute. That belongs in their records, not retyped
        // into a form on every run.
        if (excludeBuyers.length > 0) {
            const buyerText = [
                tender.buyer,
                tender.buyerDepartment,
                tender.buyerAgency,
                tender.buyerOffice,
            ]
                .filter(Boolean)
                .join(' ')
                .toLowerCase();
            if (excludeBuyers.some((b) => buyerText.includes(b))) {
                dropped.excludedBuyer += 1;
                continue;
            }
        }

        if (countries.length > 0) {
            const normalizedCountry = tender.country ? tender.country.toUpperCase() : '';
            const match = countries.some(
                (c) =>
                    normalizedCountry === c.toUpperCase() ||
                    normalizedCountry.includes(c.toUpperCase()),
            );
            if (!match) {
                dropped.countryMismatch += 1;
                continue;
            }
        }

        // Kept from v1: contracts store their value in different fields depending
        // on notice type, so checking only one drops real opportunities.
        if (minimumBudget > 0) {
            const value = tender.awardValue || tender.budgetUsd || tender.valueHigh || 0;
            if (value < minimumBudget) {
                dropped.belowBudget += 1;
                continue;
            }
        }

        if (tender.deadline) {
            const now = dayjs();
            const deadline = dayjs(tender.deadline);
            if (!includeExpired && deadline.isBefore(now)) {
                dropped.deadlinePassed += 1;
                continue;
            }
            if (deadlineWithinDays && deadline.diff(now, 'day') > deadlineWithinDays) {
                dropped.deadlineTooFar += 1;
                continue;
            }
        } else if (deadlineWithinDays && !includeNoDeadline) {
            // Notices with no published deadline. v1 dropped these whenever a
            // deadline window was set, which cost 10 of 45 records in one run.
            //
            // That's the wrong default for this data: RFIs and Sources Sought
            // notices routinely have no response date, and they are the earliest
            // and most valuable signal a BD team can get — you hear about the
            // requirement before the solicitation exists. Keeping them is now the
            // default and it's an input toggle rather than a hardcoded rule.
            dropped.noDeadlineField += 1;
            continue;
        }

        const v2 = calculateConfidence(tender, profile);
        const v1 = calculateConfidenceV1(tender, keywords);

        // Isolating the profile's contribution.
        //
        // Comparing v2 against v1 directly is confounded: v2 rebalanced the base
        // from 50 to 40 and the completeness bonus from 10 to 5. On the Veterans
        // Affairs contracts that produced a perfect accidental cancellation —
        // +15 past-performance minus 10 base minus 5 completeness = 0 delta — so
        // "promotedByProfile" read 0 while the bonus was demonstrably firing.
        //
        // The honest counterfactual holds the weights fixed and removes only the
        // signals that require reading the user's records: past-performance and
        // classification codes. Everything else is identical.
        const profileContribution = v2.breakdown.pastPerformance + v2.breakdown.classification;
        const scoreWithoutProfile = v2.score - profileContribution;

        results.push({
            ...tender,
            confidenceScore: v2.score,
            confidenceScoreV1: v1.score,
            confidenceScoreWithoutProfile: scoreWithoutProfile,
            // The number the article is built on: points this contract earned
            // solely because the connector read the user's Notion records first.
            profileContribution,
            scoreDelta: v2.score - v1.score,
            scoreReason: v2.reason,
            scoreBreakdown: v2.breakdown,
            keywordsMatched: v2.matches,
        });
    }

    const totalDropped = Object.values(dropped).reduce((a, b) => a + b, 0);
    log.info(
        `Filter funnel — ${tenders.length} in, ${results.length} out, ${totalDropped} dropped:`,
    );
    for (const [reason, count] of Object.entries(dropped)) {
        if (count > 0) log.info(`    ${reason}: ${count}`);
    }

    // If nothing survived, show what the data actually looked like. Guessing at a
    // zero-result run from the outside is how you lose an afternoon.
    if (results.length === 0 && tenders.length > 0) {
        log.warning('Nothing passed the filters. Sample of what was fetched:');
        for (const t of tenders.slice(0, 3)) {
            log.warning(
                `  title="${(t.title || '').slice(0, 70)}" | country=${t.country || 'none'} ` +
                    `| deadline=${t.deadline || 'none'} | naics=${t.naicsCode || '-'} ` +
                    `| cpv=${t.cpvCode || '-'}`,
            );
        }
        log.warning(`  Profile keywords being matched against: [${keywords.join(', ')}]`);
    }

    return results
        .sort((a, b) => b.confidenceScore - a.confidenceScore)
        .map((t) => ({
            rawSourceId: t.rawSourceId ?? '',
            title: t.title ?? '',
            description: t.description ?? '',

            buyer: t.buyer ?? '',
            buyerContactName: t.buyerContactName ?? '',
            buyerContactEmail: t.buyerContactEmail ?? '',
            buyerContactPhone: t.buyerContactPhone ?? '',
            buyerDepartment: t.buyerDepartment ?? null,
            buyerAgency: t.buyerAgency ?? null,
            buyerOffice: t.buyerOffice ?? null,
            buyerAddress: t.buyerAddress ?? '',

            country: t.country ?? '',
            region: t.region ?? '',
            postcode: t.postcode ?? '',
            placeOfPerformance: t.placeOfPerformance ?? null,

            noticeType: t.noticeType ?? '',
            status: t.status ?? '',
            cpvCode: t.cpvCode ?? null,
            naicsCode: t.naicsCode ?? null,
            classificationCode: t.classificationCode ?? null,
            setAside: t.setAside ?? null,
            isSMEEligible: t.isSMEEligible ?? null,

            budgetOriginal: t.budgetOriginal ?? null,
            budgetUsd: t.budgetUsd ?? null,
            valueLow: t.valueLow ?? null,
            valueHigh: t.valueHigh ?? null,
            awardValue: t.awardValue ?? null,
            currency: t.currency ?? '',

            documents: t.documents ?? [],
            documentUrls: t.documentUrls ?? [],
            sourceRecordUrl: t.sourceRecordUrl ?? '',

            deadline: t.deadline ?? null,
            publishedDate: t.publishedDate ?? null,
            contractStartDate: t.startDate ?? t.contractStartDate ?? null,
            contractEndDate: t.endDate ?? t.contractEndDate ?? null,
            awardDate: t.awardDate ?? null,

            supplierName: t.supplierName ?? t.supplierAwarded ?? null,
            supplierUei: t.supplierUei ?? null,

            // v2 scoring surface
            confidenceScore: t.confidenceScore ?? 0,
            confidenceScoreV1: t.confidenceScoreV1 ?? 0,
            confidenceScoreWithoutProfile: t.confidenceScoreWithoutProfile ?? 0,
            profileContribution: t.profileContribution ?? 0,
            scoreDelta: t.scoreDelta ?? 0,
            scoreReason: t.scoreReason ?? '',
            scoreBreakdown: t.scoreBreakdown ?? null,
            keywordsMatched: t.keywordsMatched ?? [],

            // Populated by main.js after the write-back phase
            writtenToPipeline: false,
            skippedAsDuplicate: false,
        }));
}
