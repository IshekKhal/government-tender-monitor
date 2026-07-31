/**
 * Repairs mojibake — UTF-8 bytes that were decoded as Windows-1252 upstream.
 *
 * SAM.gov returns titles like "Patient Advocate Tracking System â€“ Replacement".
 * That "â€“" is a UTF-8 en-dash (bytes E2 80 93) rendered one byte at a time
 * through cp1252. Left alone it goes straight into Notion and looks like a bug
 * in this Actor rather than in the upstream feed.
 *
 * The obvious fix — `Buffer.from(s, 'latin1').toString('utf8')` — does not work.
 * Latin-1 covers 0x00-0xFF, but cp1252 puts printable characters in 0x80-0x9F
 * where Latin-1 has control codes. '€' is U+20AC, far outside the byte range, so
 * the round-trip silently drops exactly the characters that need repairing.
 * Hence the explicit table below.
 */

// The 27 code points where Windows-1252 differs from Latin-1, mapped to bytes.
const CP1252_TO_BYTE = new Map([
    ['€', 0x80], ['‚', 0x82], ['ƒ', 0x83], ['„', 0x84],
    ['…', 0x85], ['†', 0x86], ['‡', 0x87], ['ˆ', 0x88],
    ['‰', 0x89], ['Š', 0x8a], ['‹', 0x8b], ['Œ', 0x8c],
    ['Ž', 0x8e], ['‘', 0x91], ['’', 0x92], ['“', 0x93],
    ['”', 0x94], ['•', 0x95], ['–', 0x96], ['—', 0x97],
    ['˜', 0x98], ['™', 0x99], ['š', 0x9a], ['›', 0x9b],
    ['œ', 0x9c], ['ž', 0x9e], ['Ÿ', 0x9f],
]);

// Signature of the damage: Â, Ã or â immediately followed by another
// high character. Clean text never matches this.
const MOJIBAKE_SIGNATURE = /[ÂÃâ][-ÿ -⃿Œ-ƒ™]/;

export function fixMojibake(s) {
    if (typeof s !== 'string' || !MOJIBAKE_SIGNATURE.test(s)) return s;

    const bytes = [];
    for (const ch of s) {
        const cp = ch.codePointAt(0);
        if (cp <= 0xff) {
            bytes.push(cp);
        } else if (CP1252_TO_BYTE.has(ch)) {
            bytes.push(CP1252_TO_BYTE.get(ch));
        } else {
            // A character outside cp1252 means this isn't simple mojibake.
            // Returning the original is the safe outcome.
            return s;
        }
    }

    const repaired = Buffer.from(bytes).toString('utf8');
    return repaired.includes('�') ? s : repaired;
}

export function cleanRecord(record) {
    const cleaned = {};
    // Iterate over keys in the order they are defined in the record
    Object.keys(record).forEach((key) => {
        const value = record[key];
        if (
            value === null ||
            value === undefined ||
            value === '' ||
            (Array.isArray(value) && value.length === 0)
        ) {
            // Skip
            return;
        }
        cleaned[key] = typeof value === 'string' ? fixMojibake(value) : value;
    });
    return cleaned;
}
