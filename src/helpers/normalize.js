import dayjs from 'dayjs';
import { load } from 'cheerio';

// Approximate static exchange rates to USD (Base: USD)
// In a real production app, fetch these dynamically.
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
 * @param {number} amount - The amount in original currency.
 * @param {string} currency - The currency code (e.g., 'EUR').
 * @returns {number|null} - The estimated amount in USD, or null if invalid.
 */
export function normalizeCurrencyToUsd(amount, currency) {
    if (!amount || isNaN(amount)) return null;
    if (!currency) return amount; // Assume USD if missing? Or return raw. Let's return raw if unknown.

    const code = currency.toUpperCase().trim();
    const rate = EXCHANGE_RATES[code];

    if (rate) {
        return Math.round(amount * rate);
    }
    
    // If currency not found, return null or original? 
    // Spec says "approximate is acceptable". 
    // If we can't convert, we can't filter by budget reliably.
    return null; 
}

/**
 * Strips HTML tags from a string.
 * @param {string} html - The HTML string.
 * @returns {string} - Plain text.
 */
export function stripHtml(html) {
    if (!html) return '';
    const $ = load(html);
    return $.text().trim().replace(/\s+/g, ' ');
}

/**
 * Formats a date string to ISO 8601.
 * @param {string|Date} date - The date to format.
 * @returns {string|null} - ISO string or null.
 */
export function formatDate(date) {
    if (!date) return null;
    const d = dayjs(date);
    return d.isValid() ? d.toISOString() : null;
}

/**
 * Calculates days remaining until deadline.
 * @param {string} deadlineIso - ISO formatted deadline.
 * @returns {number|null} - Days remaining (can be negative if expired).
 */
export function getDaysRemaining(deadlineIso) {
    if (!deadlineIso) return null;
    const now = dayjs();
    const end = dayjs(deadlineIso);
    return end.diff(now, 'day');
}