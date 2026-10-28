// Date handling for Indian recruitment notices.

const MONTHS = ["january", "february", "march", "april", "may", "june", "july",
    "august", "september", "october", "november", "december"];

const monthIndex = name => {
    const n = name.toLowerCase();
    return MONTHS.findIndex(m => m === n || (n.length >= 3 && m.startsWith(n)));
};

const valid = (y, m, d) => {
    const date = new Date(y, m, d);
    return date.getFullYear() === y && date.getMonth() === m && date.getDate() === d ? date : null;
};

const fullYear = y => (y < 100 ? 2000 + y : y);

// "26/11/2026", "06.11.2026", "30/09/2026 (Date Extended)", "15 June 2026", "June 15, 2026"
// -> Date (local midnight) when the text STARTS with a date; otherwise null.
export function parseIndianDate(text) {
    if (!text) return null;
    const t = normalizeDigits(String(text)).trim();

    const dmy = t.match(/^(\d{1,2})\s*[/.-]\s*(\d{1,2})\s*[/.-]\s*(\d{2}|\d{4})\b/);
    if (dmy) return valid(fullYear(+dmy[3]), +dmy[2] - 1, +dmy[1]);

    const dMonY = t.match(/^(\d{1,2})\s*(?:st|nd|rd|th)?\s+([A-Za-z]+)\.?,?\s+(\d{4})\b/);
    if (dMonY && monthIndex(dMonY[2]) >= 0) return valid(+dMonY[3], monthIndex(dMonY[2]), +dMonY[1]);

    const monDY = t.match(/^([A-Za-z]+)\.?\s+(\d{1,2})\s*(?:st|nd|rd|th)?,?\s+(\d{4})\b/);
    if (monDY && monthIndex(monDY[1]) >= 0) return valid(+monDY[3], monthIndex(monDY[1]), +monDY[2]);

    return null;
}

// Every date that appears anywhere in a block of text, as "YYYY-MM-DD" strings.
export function datesInText(text) {
    const t = normalizeDigits(text);
    const found = new Set();
    const add = date => date && found.add(isoDate(date));

    for (const m of t.matchAll(/\b(\d{1,2})\s*[/.-]\s*(\d{1,2})\s*[/.-]\s*(\d{4}|\d{2})\b/g)) {
        add(valid(fullYear(+m[3]), +m[2] - 1, +m[1]));
    }
    // "21 October 2026", "21st Oct. 2026", "21 st October, 2026" (PDF text often splits the suffix)
    for (const m of t.matchAll(/\b(\d{1,2})\s*(?:st|nd|rd|th)?\s+([A-Za-z]{3,9})\.?,?\s+(\d{4})\b/g)) {
        if (monthIndex(m[2]) >= 0) add(valid(+m[3], monthIndex(m[2]), +m[1]));
    }
    for (const m of t.matchAll(/\b([A-Za-z]{3,9})\.?\s+(\d{1,2})\s*(?:st|nd|rd|th)?,?\s+(\d{4})\b/g)) {
        if (monthIndex(m[1]) >= 0) add(valid(+m[3], monthIndex(m[1]), +m[2]));
    }
    return found;
}

export const isoDate = date =>
    `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, "0")}-${String(date.getDate()).padStart(2, "0")}`;

export const displayDate = date =>
    `${String(date.getDate()).padStart(2, "0")}/${String(date.getMonth() + 1).padStart(2, "0")}/${date.getFullYear()}`;

export const startOfDay = (date = new Date()) => new Date(date.getFullYear(), date.getMonth(), date.getDate());

// Devanagari digits (used in many Hindi notices) -> ASCII.
export function normalizeDigits(text) {
    return text.replace(/[०-९]/g, d => String(d.charCodeAt(0) - 0x0966));
}
