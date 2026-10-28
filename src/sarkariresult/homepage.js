import * as cheerio from "cheerio";

export const SITE_HOME = "https://www.sarkariresult.com/";
export const SECTIONS = ["admitCard", "latestJob", "result", "admission"];

// On the homepage every block is a grid column: a heading (`p.gb-headline`) whose link
// text names the block, followed by a `ul.sarkari-quick-list` of posts.
const HEADINGS = {
    admitCard: /^admit\s*cards?$/i,
    latestJob: /^latest\s*jobs?$/i,
    result: /^results?$/i,
    admission: /^admissions?$/i,
};

const HEADING_SELECTOR = ".gb-headline, h1, h2, h3, h4, h5, h6";
const LIST_SELECTOR = "ul.sarkari-quick-list";

const clean = text => (text ?? "").replace(/\s+/g, " ").trim();

function absoluteUrl(href) {
    const value = (href ?? "").trim();
    if (!value || value.startsWith("#")) return null;
    try {
        const url = new URL(value, SITE_HOME);
        return url.protocol === "http:" || url.protocol === "https:" ? url.href : null;
    } catch {
        return null;
    }
}

function headingSection($, el) {
    const label = clean($(el).text());
    return Object.keys(HEADINGS).find(section => HEADINGS[section].test(label)) ?? null;
}

export function parseHomepageSection(html, section, limit) {
    if (!SECTIONS.includes(section)) throw new Error(`Unknown homepage section: ${section}`);
    const max = Number.isFinite(limit) ? Math.max(0, Math.floor(limit)) : Infinity;
    if (max === 0) return [];

    const $ = cheerio.load(html ?? "");
    // Walk headings and lists in document order; a list belongs to the heading just before it.
    let current = null;
    let list = null;
    $(`${HEADING_SELECTOR}, ${LIST_SELECTOR}`).each((_, el) => {
        if ($(el).is(LIST_SELECTOR)) {
            if (current === section) {
                list = el;
                return false;
            }
            current = null;
        } else {
            current = headingSection($, el);
        }
    });
    if (!list) return [];

    const entries = [];
    const seen = new Set();
    $(list).children("li").each((_, li) => {
        const link = $(li).find("a[href]").first();
        const url = absoluteUrl(link.attr("href"));
        const title = clean(link.text());
        if (!url || !title || seen.has(url)) return;
        seen.add(url);
        entries.push({ title, url });
        if (entries.length >= max) return false;
    });
    return entries;
}
