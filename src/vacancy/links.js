// Classifies links found on a post. The goal is to show only a direct, official application
// (or download) link and never an aggregator page.

// Sites that are never an official application link.
const NOT_OFFICIAL = [
    "sarkariresult.com", "sarkariresults.org.in", "sarkariresultportal.com", "sarkariresult.app",
    "youtube.com", "youtu.be", "t.me", "telegram.me", "whatsapp.com", "play.google.com",
    "itunes.apple.com", "apps.apple.com", "facebook.com", "instagram.com", "twitter.com", "x.com",
];

// Government / academic top-level suffixes in India.
const GOVERNMENT_SUFFIXES = ["gov.in", "nic.in", "ac.in", "edu.in", "res.in", "mil.in", "gov"];

// Exam-conduct portals used by many official recruiters (TCS iON, IBPS, NTA ...).
const KNOWN_PORTALS = ["digialm.com", "ibps.in", "nta.ac.in", "nta.nic.in", "onlineapplicationform.org"];

// Two-part public suffixes, so that "upsc.gov.in" -> registrable "upsc.gov.in", not "gov.in".
const TWO_PART = ["gov.in", "nic.in", "co.in", "org.in", "ac.in", "edu.in", "res.in", "net.in", "mil.in", "ind.in"];

// Hosts ending in "." ("bit.ly.") are equivalent in DNS but would slip past suffix checks,
// so they are treated as unidentifiable everywhere.
export const hostOf = url => {
    try {
        const host = new URL(url).hostname.toLowerCase();
        return host.endsWith(".") ? null : host.replace(/^www\./, "");
    } catch {
        return null;
    }
};

// Whitespace, control and bidirectional-text characters. The URL parser silently drops some of
// them, so a link containing them could be checked as one thing and displayed as another.
const UNSAFE_LINK_CHARS = /[\s\u0000-\u001f\u007f\u200b-\u200f\u202a-\u202e\u2066-\u2069\ufeff]/;

// Canonical URL for a link taken from a third-party page (this exact string is what may be
// checked and displayed), or null when it cannot be used safely.
export function normalizeLink(href) {
    if (typeof href !== "string") return null;
    const trimmed = href.trim();
    if (!trimmed || UNSAFE_LINK_CHARS.test(trimmed)) return null;
    let u;
    try {
        u = new URL(trimmed);
    } catch {
        return null;
    }
    if (u.hostname.endsWith(".")) return null;
    return u.href;
}

const endsWithDomain = (host, domain) => host === domain || host.endsWith(`.${domain}`);

export function registrableDomain(host) {
    const parts = host.split(".");
    const lastTwo = parts.slice(-2).join(".");
    return TWO_PART.includes(lastTwo) ? parts.slice(-3).join(".") : lastTwo;
}

// Same organisation site: identical hosts, one a subdomain of the other, or (outside the
// shared gov.in/nic.in spaces) the same registrable domain.
export function sameSite(a, b) {
    if (!a || !b) return false;
    if (endsWithDomain(a, b) || endsWithDomain(b, a)) return true;
    const shared = ["gov.in", "nic.in"].some(s => endsWithDomain(a, s) || endsWithDomain(b, s));
    return !shared && registrableDomain(a) === registrableDomain(b);
}

export const isNotOfficial = url => {
    const host = hostOf(url);
    return !host || NOT_OFFICIAL.some(d => endsWithDomain(host, d));
};

export const isHttpUrl = url => /^https?:\/\//i.test(url || "");

// Hosts under suffixes reserved for Indian government / academic bodies.
export const isGovernmentHost = host => !!host && GOVERNMENT_SUFFIXES.some(s => endsWithDomain(host, s));

// trust: "official-site" | "government-domain" | "exam-portal" | "unconfirmed"
export function classifyLink(url, officialWebsite) {
    const host = hostOf(url);
    if (!isHttpUrl(url) || !host || isNotOfficial(url)) return null;
    if (officialWebsite && sameSite(host, hostOf(officialWebsite))) return "official-site";
    if (GOVERNMENT_SUFFIXES.some(s => endsWithDomain(host, s))) return "government-domain";
    if (KNOWN_PORTALS.some(d => endsWithDomain(host, d))) return "exam-portal";
    return "unconfirmed";
}

export const TRUST_LABEL = {
    "official-site": "same website as the organisation's official site",
    "government-domain": "government domain",
    "exam-portal": "recognised exam portal",
    "unconfirmed": "domain not confirmed as official",
};

// Picks the link for the "Apply now" / "Download" button out of the post's link rows.
//   kind: "apply" | "admitCard" | "result"
const LABELS = {
    apply: /^(Apply Online|Online Apply|Registration|Apply Now|Online Form|Apply\b)/i,
    admitCard: /(Download )?Admit Card|Exam City|Call Letter/i,
    result: /(Download|Check) Result|^Result\b|Merit List|Score ?Card|Marks/i,
};

export function pickLinks(links, kind) {
    const officialWebsite = links.find(l => /^Official Website/i.test(l.label) && isHttpUrl(l.href) && !isNotOfficial(l.href))?.href ?? null;
    const notification = links.find(l => /Notification|Notice|Advertisement|Advt/i.test(l.label) && isHttpUrl(l.href))?.href ?? null;

    const candidates = links
        .filter(l => LABELS[kind].test(l.label))
        .map(l => ({ ...l, trust: classifyLink(l.href, officialWebsite), activatesOn: activationText(l) }))
        .filter(l => l.trust);

    const order = ["official-site", "government-domain", "exam-portal", "unconfirmed"];
    candidates.sort((a, b) => order.indexOf(a.trust) - order.indexOf(b.trust));

    return { officialWebsite, notification, primary: candidates[0] ?? null };
}

// "Link will be Activate on 26/10/2026", "Available Soon", "Start 01/11/2026"
function activationText(link) {
    const t = `${link.text} ${link.label}`;
    const m = t.match(/(?:Activate|Active|Available|Start|Open)\w*\s*(?:on|from)?\s*:?\s*(\d{1,2}\/\d{1,2}\/\d{4})/i);
    if (m) return m[1];
    return /available soon|coming soon|link soon/i.test(t) ? "soon" : null;
}
