import * as cheerio from "cheerio";

import { parseIndianDate } from "../vacancy/dates.js";
import { isNotOfficial, normalizeLink } from "../vacancy/links.js";
import { linkPolicy } from "./linkpolicy.js";
import { applicationStatus, classifyDates } from "../vacancy/model.js";
import { SOURCE_HOST, toSourceUrl } from "./site.js";

// Parsers for sarkariresult.com.cm. Only text published on that site is used; nothing is
// fetched from or inferred about other websites.

const clean = s => (s || "").replace(/ /g, " ").replace(/\s+/g, " ").trim();
const norm = s => clean(s).toLowerCase().replace(/[.;,\s]+$/, "");

// Homepage block headings, per notification type.
export const HOME_SECTIONS = {
    admitCard: "Admit Cards",
    latestJob: "Latest Jobs",
    result: "Results",
    admission: "Admission",
};

// Newest entries of a homepage block. Links that leave the permitted host are dropped.
export function parseHomeSection(html, heading, limit) {
    const $ = cheerio.load(html);
    const items = [];
    $("p.gb-headline, h2.gb-headline, h3.gb-headline").each((i, el) => {
        if (clean($(el).text()).toLowerCase() !== heading.toLowerCase()) return;
        $(el).parent().find("ul.wp-block-latest-posts li a").each((j, a) => {
            if (items.length >= limit) return false;
            const url = toSourceUrl($(a).attr("href"));
            if (url) items.push({ title: clean($(a).text()), url });
        });
        return false;
    });
    return items;
}

// Text the site repeats on every post; it carries no recruitment information.
const FILLER = [
    /read (the )?(official )?notification/i,
    /form more details/i,
    /for post wise eligibility/i,
    /^you may also check/i,
    /sarkari ?result/i,
    /candidates are advised to confirm/i,
    /^more details/i,
    // The site's standard "how to apply" sentences.
    /^interested candidates who wish to apply/i,
    /^use the click here link/i,
    /^alternatively, visit the official website/i,
    /^make sure to complete the application/i,
    /^note\s*[–-]\s*छात्रो/i,
];
const isFiller = line => !line || FILLER.some(re => re.test(line));

// Headings that start a new section (also when written as a single-cell table row).
const SECTION_RE = /important dates|fee|age limit|total post|vacanc|eligib|qualification|selection|salary|pay scale|pay level|stipend|how to (fill|apply)|important link|useful link/i;
const STOP_RE = /important question|latest posts|related posts|frequently asked/i;

// Status words the site appends to titles ("… – Start", "… – Last Date Today").
const TITLE_STATUS = /\s+[–-]\s+(start(ed)?|soon|last date (today|extend(ed)?)|date extend(ed)?|out|released|declared|today|re-?open(ed)?)$/i;

export function parseSourceArticle(html) {
    const $ = cheerio.load(html);
    $("style, script, noscript, iframe").remove();
    const root = $("main.site-main").first().length ? $("main.site-main").first() : $("body");

    const rawTitle = clean(root.find("h2").first().text()) || clean($("h1").first().text()) || null;
    const postDateText = root.find("p").map((i, p) => clean($(p).text())).get().find(t => /^Post Date\s*:/i.test(t));
    const intro = root.find("p").map((i, p) => clean($(p).text())).get()
        .find(t => t.length > 60 && !/^Post Date/i.test(t) && !/sarkari ?result/i.test(t)) ?? null;

    const sections = [];
    const links = [];
    let current = { heading: "", lists: [], rows: [] };
    sections.push(current);
    let stopped = false;
    const start = heading => {
        current = { heading, lists: [], rows: [] };
        sections.push(current);
    };

    root.find("h2, h3, h4, h5, h6, tr, ul").each((i, el) => {
        if (stopped) return false;
        const node = $(el);
        const tag = el.tagName;

        if (/^h[2-6]$/.test(tag)) {
            if (node.closest("tr").children("td, th").length >= 2) return; // label inside a link row
            const text = clean(node.text());
            if (STOP_RE.test(text)) { stopped = true; return false; }
            start(text);
            return;
        }

        if (tag === "tr") {
            const cells = node.children("td, th");
            const texts = cells.map((j, c) => clean($(c).text())).get();
            if (cells.length === 1) {
                // Heading text of the row, without any list inside the same cell.
                const cell = $(cells[0]).clone();
                cell.find("ul, ol").remove();
                const label = clean(cell.text());
                if (STOP_RE.test(label)) { stopped = true; return false; }
                if (label && SECTION_RE.test(label)) start(label);
                return; // other single-cell rows (e.g. a post name label) do not start a section
            }
            const anchors = $(cells[1]).find("a[href]");
            if (cells.length === 2 && anchors.length && texts[0].length <= 90) {
                anchors.each((j, a) => {
                    // Only the normalised URL is kept, so the checked link and the displayed link are identical.
                    const href = normalizeLink($(a).attr("href"));
                    if (href) links.push({ label: texts[0], text: clean($(a).text()), href });
                });
                return;
            }
            if (texts.some(t => /eligibility criteria|qualification/i.test(t))) start(texts.join(" | "));
            current.rows.push(texts);
            return;
        }

        // ul: only top-level lists; nested lists are part of their parent item's text.
        if (node.parents("ul").length) return;
        if (node.closest("tr").find("a[href]").length && node.closest("tr").children("td").length === 2) return;
        const items = node.children("li").map((j, li) => clean($(li).text())).get().filter(Boolean);
        if (items.length) current.lists.push(items);
    });

    return {
        title: rawTitle,
        displayTitle: rawTitle ? rawTitle.replace(TITLE_STATUS, "") : null,
        titleStatus: rawTitle?.match(TITLE_STATUS)?.[1] ?? null,
        heading: clean($("h1").first().text()) || null,
        postDate: postDateText ? clean(postDateText.replace(/^Post Date\s*:/i, "")) : null,
        intro,
        sections,
        links,
    };
}

const linesOf = section => section.lists.flat();
const sectionsMatching = (article, re) => article.sections.filter(s => re.test(s.heading));

// "Uttar Pradesh Public Service Commission (UPPSC), has released ..." -> the organisation.
export function organizationFrom(intro) {
    const m = intro?.match(/^(.{4,140}?)\s*,?\s+(?:has|have)\s+(?:released|issued|announced|invited|published|declared|uploaded|started|notified)\b/i);
    return m ? clean(m[1].replace(/,$/, "")) : null;
}

// "(33,320 Posts)" in the title, a single "No. Of Posts" row, or "for 501 vacancies" in the intro.
export function totalPostsFrom(article) {
    const fromTitle = article.title?.match(/\((\d[\d,]*)\s*Posts?\)/i);
    if (fromTitle) return { value: Number(fromTitle[1].replace(/,/g, "")), from: "title" };

    for (const s of sectionsMatching(article, /total post|vacanc/i)) {
        const header = s.rows.findIndex(r => r.some(c => /no\.? of posts?|total posts?/i.test(c)));
        const data = header >= 0 ? s.rows.slice(header + 1).filter(r => /\d/.test(r.at(-1))) : [];
        if (data.length === 1) return { value: Number(data[0].at(-1).match(/(\d[\d,]*)/)[1].replace(/,/g, "")), from: "table" };
    }
    const fromIntro = article.intro?.match(/\bfor\s+(\d[\d,]*)\s+(?:vacanc\w*|posts?)/i);
    return fromIntro ? { value: Number(fromIntro[1].replace(/,/g, "")), from: "intro" } : null;
}

const CATEGORY = /^(general|gen|ur|ews|obc|bc|ebc|sc|st|pwbd|ph|female)$/i;

// Header row of categories followed by a row of the same number of counts.
export function categoryVacancies(article) {
    for (const s of article.sections) {
        for (let i = 0; i < s.rows.length - 1; i++) {
            const cats = s.rows[i].filter(c => CATEGORY.test(c));
            const counts = s.rows[i + 1].filter(c => /^\d[\d,]*$/.test(c));
            if (cats.length >= 2 && counts.length === cats.length) return cats.map((c, j) => ({ category: c, count: counts[j] }));
        }
    }
    return null;
}

export function feesFrom(article) {
    const items = [];
    const notes = [];
    for (const s of sectionsMatching(article, /fee/i)) {
        for (const line of linesOf(s)) {
            if (/^(minimum|maximum) age/i.test(line) || /age relaxation/i.test(line)) continue;
            if (/refund|exempt/i.test(line)) {
                notes.push(line);
                continue;
            }
            const m = line.match(/^(?:for\s+)?(.{2,70}?)\s*:\s*(?:₹|rs\.?|inr)?\s*(\d[\d,]*)\s*\/?-?\s*(.*)$/i);
            if (m && !/payment mode/i.test(m[1])) {
                items.push({ label: clean(m[1]), value: `₹${m[2]}/-${m[3] && !/^\/-?$/.test(m[3]) ? ` ${clean(m[3])}` : ""}`.trim(), amount: Number(m[2].replace(/,/g, "")) });
            } else if (/no fee/i.test(line)) {
                notes.push(line);
            }
        }
    }
    return items.length || notes.length ? { items, notes } : null;
}

export function ageFrom(article) {
    const ageLines = article.sections.flatMap(s => s.lists.flat()).filter(l => /^(minimum|maximum) age\s*:/i.test(l) || /age relaxation|relaxation in age|provides age relaxation/i.test(l));
    if (!ageLines.length) return null;
    const heading = article.sections.find(s => /age limit/i.test(s.heading))?.heading ?? "";
    const ref = heading.match(/as on\s*:?\s*(.+)$/i)?.[1]?.trim() ?? null;
    return {
        limits: [...new Set(ageLines.filter(l => /^(minimum|maximum) age/i.test(l)))],
        relaxation: ageLines.filter(l => /relaxation/i.test(l)),
        referenceText: ref,
        referenceDate: parseIndianDate(ref),
    };
}

// Deduplicated qualification lines, plus whether the page says (or shows) that eligibility
// differs from post to post.
export function qualificationFrom(article) {
    const seen = new Set();
    const lines = [];
    let postWise = false;
    let postLists = 0;
    for (const s of sectionsMatching(article, /eligib|qualification/i)) {
        postLists += s.lists.length;
        for (const line of linesOf(s)) {
            if (/post ?-?wise/i.test(line)) postWise = true;
            if (isFiller(line) || seen.has(norm(line))) continue;
            seen.add(norm(line));
            lines.push(line.replace(/\s+OR$/i, " OR"));
        }
    }
    if (!lines.length) return null;
    return { lines, postWise: postWise || postLists > 1 };
}

const listSection = (article, re) => {
    const lines = sectionsMatching(article, re).flatMap(linesOf).filter(l => !isFiller(l)).map(l => l.replace(/[.\s–-]+$/, ""));
    return lines.length ? [...new Set(lines)] : null;
};

// Link rows -> application / download / notification / official-website URLs (as references).
const LINK_LABELS = {
    apply: /^apply online|^online apply|^registration|^apply link|^apply now/i,
    admitCard: /admit card|call letter|exam city/i,
    result: /result|answer key|score ?card|merit list|marks/i,
};

export function linksFrom(article, kind) {
    // Social / messenger / video / aggregator links are never used as application links.
    const external = l => isExternalUrl(l.href) && !isNotOfficial(l.href) && !/sarkari ?result|channel|whatsapp|telegram|youtube/i.test(l.label);
    const pick = re => article.links.find(l => re.test(l.label) && external(l))?.href ?? null;
    const officialWebsite = pick(/official website/i);
    const candidate = pick(LINK_LABELS[kind]);
    const policy = candidate ? linkPolicy(candidate, officialWebsite) : null;
    return {
        // Shown in the message only when the link policy allows it.
        primary: policy?.show ? candidate : null,
        policy,
        found: candidate,
        notification: pick(/official notification|download notification|notification/i),
        officialWebsite,
    };
}

// A syntactically valid http(s) URL on another host (never the source site itself).
export function isExternalUrl(url) {
    try {
        const u = new URL(url);
        return ["http:", "https:"].includes(u.protocol) && !!u.hostname && u.hostname.toLowerCase() !== SOURCE_HOST
            && !u.username && !u.password;
    } catch {
        return false;
    }
}

const TYPES = { latestJob: "job", admitCard: "admitCard", result: "result", admission: "admission" };
const LINK_KIND = { latestJob: "apply", admission: "apply", admitCard: "admitCard", result: "result" };

export function buildSourceModel(article, { taskName, sourceUrl, today = new Date() }) {
    const dateLines = sectionsMatching(article, /important dates/i).flatMap(linesOf);
    const dates = classifyDates(dateLines);
    const total = totalPostsFrom(article);
    return {
        type: TYPES[taskName] ?? "job",
        title: article.displayTitle ?? article.heading,
        titleStatus: article.titleStatus,
        organization: organizationFrom(article.intro),
        totalPosts: total?.value ?? null,
        categoryVacancies: categoryVacancies(article),
        dates,
        status: applicationStatus(dates, today),
        qualification: qualificationFrom(article),
        age: ageFrom(article),
        fees: feesFrom(article),
        selection: listSection(article, /selection/i),
        salary: listSection(article, /salary|pay scale|pay level|stipend/i),
        links: linksFrom(article, LINK_KIND[taskName] ?? "apply"),
        // Kept for records/debugging; never shown in the message.
        sources: { article: sourceUrl, checkedAt: new Date().toISOString() },
    };
}
