import { datesInText, isoDate, normalizeDigits } from "./dates.js";
import { hostOf, isNotOfficial } from "./links.js";

const MAX_PDF_PAGES = 20;

// Text layer of a PDF (empty string for scanned/image-only PDFs).
export async function pdfText(buffer, { maxPages = MAX_PDF_PAGES } = {}) {
    const { getDocument } = await import("pdfjs-dist/legacy/build/pdf.mjs");
    const task = getDocument({
        data: new Uint8Array(buffer),
        isEvalSupported: false,
        useSystemFonts: false,
        verbosity: 0,
    });
    try {
        const doc = await task.promise;
        let text = "";
        for (let p = 1; p <= Math.min(doc.numPages, maxPages); p++) {
            const content = await (await doc.getPage(p)).getTextContent();
            text += content.items.map(i => i.str).join(" ") + "\n";
        }
        return { text, pages: doc.numPages };
    } finally {
        await task.destroy();
    }
}

// A PDF counts as readable when it has a real text layer, not just a title.
export const hasUsableText = text => normalizeDigits(text).replace(/\s/g, "").length >= 500;

const compact = s => normalizeDigits(s).toLowerCase().replace(/[\s.]/g, "");

const containsNumber = (text, n) => {
    const plain = String(n);
    const withCommas = Number(n).toLocaleString("en-IN");
    const re = new RegExp(`(^|[^\\d])(${plain}|${withCommas.replace(/,/g, ",")})(?![\\d])`);
    return re.test(normalizeDigits(text));
};

// Cross-checks facts taken from the post against the notification's text layer.
// Each result is true (found), false (not found) or absent (nothing to check).
// "Found" means the exact value appears in the notification text; it does not prove the
// value belongs to the same field, so callers present it as "found in the notification".
export function crossCheck(facts, text) {
    const dates = datesInText(text);
    const result = {};

    for (const [field, date] of Object.entries(facts.dates || {})) {
        if (date) result[field] = dates.has(isoDate(date));
    }
    if (facts.totalPosts >= 10) result.totalPosts = containsNumber(text, facts.totalPosts);
    if (facts.advertisementNo) result.advertisementNo = compact(text).includes(compact(facts.advertisementNo));
    if (facts.ageReferenceDate) result.ageReferenceDate = dates.has(isoDate(facts.ageReferenceDate));

    const fees = (facts.feeAmounts || []).filter(n => n >= 10);
    if (fees.length) result.fees = fees.every(n => containsNumber(text, n));

    return result;
}

const MAX_CACHED_TEXT = 400_000;

// Downloads the notification PDF and extracts its text. Never throws: failures are
// reported in the result. The text is kept so the comparison can be redone whenever the
// post's details change (e.g. an extended last date) without downloading the PDF again.
export async function fetchNotification(url, { fetchBinary, log }) {
    const source = {
        url,
        host: hostOf(url),
        official: url ? !isNotOfficial(url) : false,
        fetchedAt: new Date().toISOString(),
    };
    if (!url) return { ...source, status: "missing" };
    if (!/\.pdf(\?|#|$)/i.test(url)) return { ...source, status: "not-pdf" };

    try {
        const { text, pages } = await pdfText(await fetchBinary(url));
        if (!hasUsableText(text)) return { ...source, pages, status: "scanned" };
        return { ...source, pages, status: "readable", text: text.slice(0, MAX_CACHED_TEXT) };
    } catch (err) {
        const tls = tlsProblem(err);
        log?.warn(`Notification download/read failed for ${url}: ${tls ?? err.message}`);
        return { ...source, status: "unreachable", reason: tls ? "tls" : "error", error: err.message.slice(0, 200) };
    }
}

// Compares the current facts with a fetched notification. Returns the record without its text.
export function checkNotification(record, facts) {
    const { text, ...rest } = record;
    if (record.status !== "readable") return rest;
    return { ...rest, status: "checked", checkedAt: new Date().toISOString(), matches: crossCheck(facts, text) };
}

// Outdated TLS or an incomplete certificate chain on the remote site. Node's TLS checks are
// never relaxed to get past these; the check is reported as not possible instead.
export function tlsProblem(err) {
    const msg = `${err?.code ?? ""} ${err?.message ?? ""}`;
    if (/legacy renegotiation|EPROTO|unsupported protocol|SSL routines/i.test(msg)) return "site uses outdated TLS";
    if (/UNABLE_TO_VERIFY_LEAF_SIGNATURE|unable to verify the first certificate|CERT_|self.signed/i.test(msg)) return "site's certificate chain could not be verified";
    return null;
}

// Checks that an application link opens (HTTP status below 400 after redirects).
export async function probeLink(url, { probe, log }) {
    const checkedAt = new Date().toISOString();
    try {
        const status = await probe(url);
        return { reachable: status < 400, status, checkedAt };
    } catch (err) {
        // Some government sites only support outdated TLS renegotiation. TLS security is not
        // lowered to check them; the link is reported as "not checked" instead.
        const reason = tlsProblem(err);
        log?.warn(`Link check failed for ${url}: ${reason ?? err.message}`);
        return { reachable: null, reason: reason ? "tls" : "unreachable", error: err.message.slice(0, 200), checkedAt };
    }
}
