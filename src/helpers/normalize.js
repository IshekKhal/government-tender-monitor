// Approximate static exchange rates to USD.
//
// Deliberate v1 tradeoff: good enough to filter by budget without adding a
// runtime dependency on a currency API. Not good enough for financial analysis,
// and the README says so.
const EXCHANGE_RATES = {
    USD: 1,
    EUR: 1.09,
    GBP: 1.27,
    CAD: 0.74,
    AUD: 0.67,
    INR: 0.012,
};

/**
 * Normalizes a currency amount to USD.
 *
 * Returns null rather than the original amount when the currency is unknown.
 * A number in an unknown currency compared against a USD threshold is worse
 * than no number at all, because it silently passes or fails the filter.
 *
 * @param {number} amount - The amount in the original currency.
 * @param {string} currency - The currency code, for example 'EUR'.
 * @returns {number|null} - Estimated USD amount, or null if not convertible.
 */
export function normalizeCurrencyToUsd(amount, currency) {
    if (!amount || Number.isNaN(Number(amount))) return null;
    if (!currency) return amount;

    const rate = EXCHANGE_RATES[currency.toUpperCase().trim()];
    return rate ? Math.round(amount * rate) : null;
}
