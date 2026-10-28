import axios from "axios";

// The ONLY website vacancies may be discovered on or read from in the compact format.
// Matching is exact: "www.sarkariresult.com.cm", "sarkariresult.com.cm.example.org",
// "sarkariresult.com" and look-alikes are all rejected.
export const SOURCE_HOST = "sarkariresult.com.cm";
export const SOURCE_ORIGIN = `https://${SOURCE_HOST}`;
export const SOURCE_HOME = `${SOURCE_ORIGIN}/`;

export class SourceBlockedError extends Error {
    name = "SourceBlockedError";
}

// Returns the canonical https URL when `url` is on the permitted host, otherwise null.
// http:// links (used inside the site) are upgraded to https. Credentials and explicit
// ports are rejected so "https://sarkariresult.com.cm@evil.example/" cannot slip through.
export function toSourceUrl(url, base = SOURCE_HOME) {
    let parsed;
    try {
        parsed = new URL(url, base);
    } catch {
        return null;
    }
    if (!["https:", "http:"].includes(parsed.protocol)) return null;
    if (parsed.username || parsed.password || parsed.port) return null;
    if (parsed.hostname.toLowerCase() !== SOURCE_HOST) return null;
    parsed.protocol = "https:";
    parsed.hash = "";
    return parsed.href;
}

export const isSourceUrl = url => toSourceUrl(url) !== null;

const sleep = ms => new Promise(r => setTimeout(r, ms));
const MAX_HOPS = 5;

// GET a page from the permitted host only. Redirects are followed manually, one hop at a
// time, and only while they stay on the permitted host; a redirect anywhere else is refused.
// Bounded retries with backoff for network errors, 429 and 5xx.
export async function fetchSourcePage(url, {
    get = axios.get,
    retries = 3,
    timeoutMs = 30_000,
    baseDelayMs = 2_000,
    wait = sleep,
} = {}) {
    const start = toSourceUrl(url);
    if (!start) throw new SourceBlockedError(`Blocked: ${url} is not on ${SOURCE_HOST}`);

    let lastError;
    for (let attempt = 0; attempt <= retries; attempt++) {
        try {
            return await fetchFollowingSameHost(start, get, timeoutMs);
        } catch (err) {
            if (err instanceof SourceBlockedError) throw err;
            lastError = err;
            const status = err.response?.status;
            const retryable = status === undefined || status === 429 || status >= 500;
            if (attempt === retries || !retryable) break;
            await wait(baseDelayMs * 2 ** attempt);
        }
    }
    const status = lastError?.response?.status;
    throw new Error(`GET ${start} failed${status ? ` (HTTP ${status})` : ""}: ${lastError?.message}`);
}

async function fetchFollowingSameHost(start, get, timeoutMs) {
    let current = start;
    for (let hop = 0; hop <= MAX_HOPS; hop++) {
        const response = await get(current, {
            timeout: timeoutMs,
            maxRedirects: 0,
            maxContentLength: 10 * 1024 * 1024,
            responseType: "text",
            validateStatus: s => s >= 200 && s < 400,
        });
        if (response.status < 300) return response.data;

        const location = response.headers?.location;
        const next = location ? toSourceUrl(location, current) : null;
        if (!next) throw new SourceBlockedError(`Blocked redirect from ${current} to ${location ?? "(no location)"}`);
        current = next;
    }
    throw new SourceBlockedError(`Too many redirects starting at ${start}`);
}
