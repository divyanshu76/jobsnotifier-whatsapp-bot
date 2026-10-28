import * as cheerio from "cheerio";

import { normalizeLink } from "./links.js";

// Parses a sarkariresult.com post (job, admit card, result or admission) into raw, labelled
// pieces. Nothing is inferred here: every value is text that appears on the page.
// The page is one large table; sections are <h2>/<h3> headings followed by a <ul> in a cell,
// data tables start with a header row ("Post Name | Total Post | ..."), and the
// "Important Links" rows have exactly two cells: a label and a link.

const clean = s => (s || "").replace(/ /g, " ").replace(/\s+/g, " ").trim();

// Boilerplate the site repeats everywhere; it carries no recruitment information.
const BOILERPLATE = [
    /read the (full )?notification/i,
    /sarkari ?result/i,
    /^click here$/i,
    /^more (eligibility )?details?\.?$/i,
];
export const isBoilerplate = line => !line || BOILERPLATE.some(re => re.test(line));

// "Label : value" -> [label, value]; lines without ":" -> [null, line].
export function splitLabel(line) {
    const i = line.indexOf(":");
    if (i < 0) return [null, clean(line)];
    return [clean(line.slice(0, i)), clean(line.slice(i + 1))];
}

export function parseArticle(html) {
    const $ = cheerio.load(html);
    const text = el => clean($(el).text());

    // Two-cell "Label : | value" rows near the top of the post.
    const rowValue = re => {
        let value = null;
        $("tr").each((i, tr) => {
            const cells = $(tr).children("td");
            if (cells.length === 2 && re.test(text(cells[0]))) {
                value = text(cells[1]);
                return false;
            }
        });
        return value;
    };

    const title = rowValue(/^Name Of Post/i) || clean($("h1").first().text()) || null;
    const postDate = rowValue(/^Post Date/i);
    const shortInfo = rowValue(/^Short Information/i);

    // Heading block above the dates: organisation, recruitment name, "... Advt No ... : Short Details".
    const headingRow = $("h2, h3").filter((i, el) => /Short Details/i.test(text(el))).first().closest("tr");
    const headings = headingRow.find("h2, h3").map((i, el) => text(el)).get()
        .filter(h => !/sarkari ?result/i.test(h));
    const organization = headings[0] && !/Short Details/i.test(headings[0]) ? headings[0] : null;

    // Sections: a heading followed by a list in the same cell.
    const sections = [];
    $("td").each((i, td) => {
        const heading = $(td).children("h2, h3, h4").first();
        const list = $(td).children("ul, ol").first();
        if (!heading.length || !list.length) return;
        sections.push({
            heading: text(heading),
            items: list.children("li").map((j, li) => text(li)).get().filter(Boolean),
        });
    });
    // Data tables: a header row of short cells followed by rows with the same number of cells.
    const tables = [];
    let current = null;
    $("tr").each((i, tr) => {
        const cells = $(tr).children("td, th");
        const values = cells.map((j, c) => text(c)).get();
        const looksLikeHeader = cells.length >= 2 && /^(Post Name|State Name|Name of Post|Category|Trade Name|Zone|Department)/i.test(values[0])
            && values.every(v => v.length < 80);

        if (looksLikeHeader) {
            current = { headers: values, rows: [] };
            tables.push(current);
            return;
        }
        if (current && cells.length === current.headers.length) {
            current.rows.push(cells.map((j, c) => ({
                text: text(c),
                items: $(c).find("li").map((k, li) => text(li)).get().filter(Boolean),
            })).get());
            return;
        }
        current = null;
    });

    // "Important Links": label cell + a cell with one or more links.
    const links = [];
    $("tr").each((i, tr) => {
        const cells = $(tr).children("td");
        if (cells.length !== 2) return;
        const label = text(cells[0]);
        if (!label || label.length > 80) return;
        $(cells[1]).find("a[href]").each((j, a) => {
            // Only the normalised URL is kept, so the checked link and the displayed link are identical.
            const href = normalizeLink($(a).attr("href"));
            if (href) links.push({ label, text: text(a), href });
        });
    });

    const pageText = clean($("body").text());

    return {
        title,
        postDate,
        shortInfo,
        organization,
        headings,
        sections,
        tables,
        links,
        totalPosts: matchTotal(sections, headings, $),
        advertisementNo: matchAdvertisementNo([title, ...headings, shortInfo].filter(Boolean).join(" | ")),
        mentionsOtr: /one time registration|\bOTR\b/i.test(pageText),
    };
}

// First section whose heading matches (the result is plain data, so it can be cached as JSON).
export const findSection = (article, re) => article.sections.find(s => re.test(s.heading)) || null;

function matchTotal(sections, headings, $) {
    const candidates = [...headings, ...sections.map(s => s.heading), ...$("h2, h3").map((i, el) => clean($(el).text())).get()];
    for (const h of candidates) {
        const m = h.match(/Vacancy Details\s*Total\s*:?\s*([\d,]+)\s*Posts?/i);
        if (m) return Number(m[1].replace(/,/g, ""));
    }
    return null;
}

// "Advt. No. 23-Exam/2026", "Advertisement No : 05/2026", "CEN 01/2026", "Advt No 03/2026".
export function matchAdvertisementNo(text) {
    const m = text.match(/\b(?:Advt|Advertisement)\.?\s*No\.?\s*[:.-]?\s*([A-Z0-9][A-Z0-9/.\-]*\d)/i)
        || text.match(/\b(CEN\s*(?:No\.?\s*)?\d{1,3}\/\d{4})\b/i);
    return m ? clean(m[1]) : null;
}
