import net from "node:net";

import { classifyLink, hostOf, isGovernmentHost, normalizeLink } from "../vacancy/links.js";

// What the compact messages may say about a link taken from the source page. Links are
// never opened; the decision is based on the URL alone, and "official" is never claimed.
//
//   government  - government / academic domain (gov.in, nic.in, ac.in, ...): shown
//   exam-portal - recognised exam-conduct portal (TCS iON, IBPS, NTA): shown
//   listed-site - not a government domain, but the same site as the organisation website
//                 listed on the source page: shown with a note
//   unverified  - unfamiliar domain: shown, clearly labelled as unverified
//   unsafe      - cannot be safely identified: NOT shown

const SHORTENERS = ["bit.ly", "tinyurl.com", "goo.gl", "t.co", "cutt.ly", "rb.gy", "is.gd", "ow.ly",
    "shorturl.at", "tiny.cc", "buff.ly", "rebrand.ly", "shorte.st", "s.id", "v.gd"];
const RISKY_FILE = /\.(exe|apk|msi|bat|cmd|scr|zip|rar|7z|js|vbs|ps1|jar)$/i;

const unsafe = reason => ({ show: false, level: "unsafe", reason });

export function linkPolicy(url, listedWebsite) {
    // Every check below runs on the same canonical URL that the message would display.
    const canonical = normalizeLink(url);
    if (canonical === null) {
        let parsed = null;
        try {
            parsed = new URL(String(url).trim());
        } catch {
            return unsafe("it is not a valid web address");
        }
        return unsafe(parsed.hostname.endsWith(".") ? "it uses an unusual domain format" : "it contains hidden or invalid characters");
    }
    if (canonical !== url) return unsafe("it is not in canonical form");
    const u = new URL(canonical);
    if (!["http:", "https:"].includes(u.protocol)) return unsafe("it is not a web link");
    if (u.username || u.password) return unsafe("it contains login details");
    if (u.port && !["80", "443"].includes(u.port)) return unsafe("it uses a non-standard port");

    const host = u.hostname.toLowerCase().replace(/^\[|\]$/g, "");
    if (net.isIP(host)) return unsafe("it uses a raw IP address");
    if (host.split(".").some(label => label.startsWith("xn--"))) return unsafe("it uses a look-alike (internationalised) domain");
    if (SHORTENERS.some(d => host === d || host.endsWith(`.${d}`))) return unsafe("it is a shortened link");
    if (RISKY_FILE.test(u.pathname)) return unsafe("it downloads a program or archive");

    const trust = classifyLink(url, listedWebsite);
    if (!trust) return unsafe("it is a social-media or aggregator link");
    if (isGovernmentHost(hostOf(url))) return { show: true, level: "government" };
    if (trust === "exam-portal") return { show: true, level: "exam-portal" };
    if (trust === "official-site") return { show: true, level: "listed-site" };
    return { show: true, level: "unverified" };
}

export const LINK_NOTE = {
    "listed-site": "ℹ️ Not a government domain; same site as the organisation website listed on the source page.",
    unverified: "⚠️ Unverified link: not a government domain and not the organisation website listed on the source page. Check it before entering any details.",
};
