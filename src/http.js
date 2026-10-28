import axios from "axios";
import dns from "node:dns";
import http from "node:http";
import https from "node:https";
import net from "node:net";

// --- Requests to links found on pages (notification PDFs, application links) -------------
// These URLs come from third-party pages, so they must not be able to reach this PC or the
// local network: only http(s) on default ports, no IP literals or local names, and every
// DNS answer (also for redirect hops, which reuse these agents) must be a public address.

const PRIVATE_V4 = [
    ["0.0.0.0", 8], ["10.0.0.0", 8], ["100.64.0.0", 10], ["127.0.0.0", 8], ["169.254.0.0", 16],
    ["172.16.0.0", 12], ["192.0.0.0", 24], ["192.168.0.0", 16], ["198.18.0.0", 15], ["224.0.0.0", 4], ["240.0.0.0", 4],
];
const v4ToInt = ip => ip.split(".").reduce((n, o) => (n << 8) + Number(o), 0) >>> 0;

// "2001:db8::1", "::ffff:127.0.0.1", "64:ff9b::7f00:1" -> eight 16-bit groups.
export function expandIPv6(address) {
    let a = address.toLowerCase().replace(/^\[|\]$/g, "").replace(/%.*$/, "");
    const dotted = a.match(/(\d+\.\d+\.\d+\.\d+)$/);
    if (dotted) {
        const n = v4ToInt(dotted[1]);
        a = a.slice(0, -dotted[1].length) + `${(n >>> 16).toString(16)}:${(n & 0xffff).toString(16)}`;
    }
    const [head, tail] = a.split("::");
    const h = head ? head.split(":") : [];
    const t = tail !== undefined && tail ? tail.split(":") : [];
    const groups = tail === undefined ? h : [...h, ...Array(8 - h.length - t.length).fill("0"), ...t];
    return groups.map(g => Number.parseInt(g || "0", 16));
}

export function isPrivateAddress(address) {
    if (net.isIPv4(address)) {
        const n = v4ToInt(address);
        return PRIVATE_V4.some(([base, bits]) => (n >>> (32 - bits)) === (v4ToInt(base) >>> (32 - bits)));
    }
    if (net.isIPv6(address)) {
        const g = expandIPv6(address);
        if (g.length !== 8 || g.some(x => !Number.isInteger(x))) return true;
        // Only global unicast (2000::/3) is public. This rejects ::, ::1, IPv4-mapped/compatible
        // addresses in any notation, NAT64 (64:ff9b::/96), unique-local, link-local and multicast.
        if ((g[0] & 0xe000) !== 0x2000) return true;
        // Transition / documentation ranges inside 2000::/3 can tunnel to private IPv4 targets.
        if (g[0] === 0x2002) return true;                     // 6to4 2002::/16
        if (g[0] === 0x2001 && g[1] === 0x0000) return true;  // Teredo 2001::/32
        if (g[0] === 0x2001 && g[1] === 0x0db8) return true;  // documentation 2001:db8::/32
        return false;
    }
    return true;
}

// Rejects anything but a public http(s) URL on the default port with a DNS host name.
export function isPublicHttpUrl(url) {
    let u;
    try {
        u = new URL(url);
    } catch {
        return false;
    }
    if (!["http:", "https:"].includes(u.protocol) || u.port || u.username || u.password) return false;
    const host = u.hostname.replace(/^\[|\]$/g, "");
    if (host.endsWith(".")) return false; // "localhost." would slip past the name checks below
    if (net.isIP(host)) return false;
    return host.includes(".") && !/(^|\.)(localhost|local|internal|lan|home|corp)$/i.test(host);
}

function publicLookup(hostname, options, callback) {
    dns.lookup(hostname, { ...options, all: true }, (err, addresses) => {
        if (err) return callback(err);
        const list = Array.isArray(addresses) ? addresses : [{ address: addresses, family: options.family }];
        const blocked = list.find(a => isPrivateAddress(a.address));
        if (blocked) return callback(new Error(`Blocked: ${hostname} resolves to a non-public address`));
        if (options.all) return callback(null, list);
        return callback(null, list[0].address, list[0].family);
    });
}

const publicAgents = {
    httpAgent: new http.Agent({ lookup: publicLookup }),
    httpsAgent: new https.Agent({ lookup: publicLookup }),
};

const guardRedirect = options => {
    const target = `${options.protocol}//${options.hostname}${options.port ? `:${options.port}` : ""}${options.path ?? ""}`;
    if (!isPublicHttpUrl(target)) throw new Error(`Blocked redirect to ${options.hostname}`);
};

export const externalRequestOptions = { ...publicAgents, beforeRedirect: guardRedirect };

const sleep = ms => new Promise(r => setTimeout(r, ms));

// Network errors, timeouts, 429 and 5xx are worth retrying; other 4xx are not.
export function isRetryable(err) {
    const status = err?.response?.status;
    if (status === undefined) return true;
    return status === 429 || status >= 500;
}

// GET a page with a timeout and a bounded number of retries (exponential backoff).
export async function fetchHtml(url, {
    retries = 3,
    timeoutMs = 30_000,
    baseDelayMs = 2_000,
    get = axios.get,
    wait = sleep,
    responseType = "text",
    maxBytes = 10 * 1024 * 1024,
    requestOptions = {},
} = {}) {
    let lastError;
    for (let attempt = 0; attempt <= retries; attempt++) {
        try {
            const { data } = await get(url, {
                timeout: timeoutMs,
                maxContentLength: maxBytes,
                responseType,
                ...requestOptions,
            });
            return data;
        } catch (err) {
            lastError = err;
            if (attempt === retries || !isRetryable(err)) break;
            await wait(baseDelayMs * 2 ** attempt);
        }
    }
    const status = lastError?.response?.status;
    throw new Error(`GET ${url} failed${status ? ` (HTTP ${status})` : ""}: ${lastError?.message}`);
}

// Notification PDFs: binary, larger limit, fewer retries (official sites are often slow).
// Public addresses only (see above).
export const fetchBinary = (url, options = {}) => {
    if (!isPublicHttpUrl(url)) return Promise.reject(new Error(`Blocked: ${url} is not a public http(s) URL`));
    return fetchHtml(url, {
        retries: 1, timeoutMs: 60_000, responseType: "arraybuffer", maxBytes: 40 * 1024 * 1024,
        requestOptions: externalRequestOptions, ...options,
    });
};

// HTTP status of a link after redirects (any status is returned, network errors throw).
// The body is not downloaded. Public addresses only (see above).
export async function probeUrl(url, { get = axios.get, timeoutMs = 20_000 } = {}) {
    if (!isPublicHttpUrl(url)) throw new Error(`Blocked: ${url} is not a public http(s) URL`);
    const response = await get(url, {
        timeout: timeoutMs,
        maxRedirects: 5,
        responseType: "stream",
        validateStatus: () => true,
        ...externalRequestOptions,
    });
    response.data?.destroy?.();
    return response.status;
}
