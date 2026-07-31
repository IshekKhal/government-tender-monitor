import { log } from 'apify';
import { gotScraping } from 'got-scraping';

export async function fetchTenders(limit = 200) {
    log.info('SAM.gov: best-effort mode');

    const url = 'https://sam.gov/api/prod/opportunities/v2/search';

    try {
        const res = await gotScraping({
            url,
            searchParams: {
                limit: Math.min(limit, 100),
                sort: 'modifiedDate,desc',
                postedFrom: '2024-01-01',
                active: 'true'
            },
            headers: {
                accept: 'application/json'
            },
            timeout: { request: 30000 },
            throwHttpErrors: false // Handle 500s manually
        }).json();

        // Check for error fields often returned by SAM
        if (!res || res.errorCode || res.errorMessage) {
            log.warning(`SAM.gov API Error: ${res.errorMessage || res.errorCode || 'Unknown error'}`);
            return [];
        }

        if (!res.opportunitiesData) {
            log.warning('SAM.gov: Unexpected response format (missing opportunitiesData).');
            return [];
        }

        const tenders = res.opportunitiesData.map(o => ({
            rawSourceId: o.noticeId,
            title: o.title || '',
            description: o.description || '',
            buyer: o.organizationName || '',
            country: 'USA',
            currency: 'USD',
            budgetOriginal: null, // SAM opportunities API often omits award amount in search list
            budgetUsd: null,
            deadline: o.responseDate || null,
            publishedDate: o.postedDate || null,
            sourceName: 'SAM.gov',
            sourceUrl: `https://sam.gov/opp/${o.noticeId}/view`,
            cpvCode: null,
            category: o.type || 'Contract Opportunity'
        }));

        log.info(`SAM.gov parsed ${tenders.length} tenders.`);
        return tenders;

    } catch (err) {
        // Catch network errors, parser errors, etc.
        log.warning(`SAM.gov unavailable: ${err.message}`);
        return [];
    }
}