import { findSection, isBoilerplate, splitLabel } from "./article.js";
import { parseIndianDate, startOfDay } from "./dates.js";

// Structured notification built only from what the post states, plus the results of the
// link and notification checks. Missing values stay null; the formatter decides how to say so.

const DATE_FIELDS = [
    // Order matters: the fee rule must run before the generic "last date" rule.
    ["feeLastDate", /fee|payment/i],
    ["correction", /correction|edit/i],
    ["start", /(application|apply|registration|online).*(begin|start|open)|^start/i],
    ["lastDate", /last date|closing date|end date/i],
    ["notification", /notification|short notice|advertisement|advt/i],
    ["admitCard", /admit card|call letter/i],
    ["exam", /exam(ination)? date|cbt|written test|test date|exam\b/i],
    ["answerKey", /answer key/i],
    ["result", /result|merit/i],
];

// One date line: the text as published and the parsed date (null for "As per Schedule" etc.).
const dateEntry = (label, text) => ({ label, text, date: parseIndianDate(text) });

export function classifyDates(items) {
    const dates = { others: [] };
    for (const line of items) {
        const [label, value] = splitLabel(line);
        if (!label || !value) continue;
        const field = DATE_FIELDS.find(([, re]) => re.test(label))?.[0];
        if (field && !dates[field]) dates[field] = dateEntry(label, value);
        else dates.others.push(dateEntry(label, value));
    }
    return dates;
}

export function applicationStatus(dates, today = new Date()) {
    const day = startOfDay(today);
    if (dates.start?.date && day < dates.start.date) return "upcoming";
    if (dates.lastDate?.date) return day > dates.lastDate.date ? "closed" : "open";
    return "unknown";
}

// "General / OBC / EWS : 800/- for Male" -> { label: "General / OBC / EWS", value: "₹800/- for Male", amount: 800 }
export function parseFees(section) {
    if (!section) return null;
    const items = [];
    const notes = [];
    for (const line of section.items) {
        const [label, value] = splitLabel(line);
        if (label && value && /\d/.test(value) && label.length < 60) {
            const amount = Number(value.match(/(\d[\d,]*)/)?.[1].replace(/,/g, ""));
            items.push({ label, value: /^\d/.test(value) ? `₹${value}` : value, amount });
        } else if (!isBoilerplate(line)) {
            notes.push(line);
        }
    }
    return { tentative: /tentative/i.test(section.heading), items, notes };
}

export function parseAge(section) {
    if (!section) return null;
    const ref = section.heading.match(/as on\s*:?\s*([0-9]{1,2}[/.-][0-9]{1,2}[/.-][0-9]{4}|\d{1,2}\s+[A-Za-z]+\s+\d{4})/i)?.[1] ?? null;
    const age = { referenceText: ref, referenceDate: parseIndianDate(ref), min: null, max: null, relaxation: [], other: [] };
    for (const line of section.items) {
        const [label, value] = splitLabel(line);
        if (/minimum/i.test(label || "")) age.min = value;
        else if (/maximum/i.test(label || "")) age.max = value;
        else if (/relax/i.test(line)) age.relaxation.push(line);
        else if (!isBoilerplate(line)) age.other.push(line);
    }
    return age;
}

const findTable = (article, re) => article.tables.find(t => t.headers.some(h => re.test(h))) || null;
const columnIndex = (table, re) => table.headers.findIndex(h => re.test(h));

// Post-wise rows: name, count, eligibility lines, pay (only when the table has those columns).
export function parsePosts(article) {
    const table = findTable(article, /eligib|qualification/i) || findTable(article, /^Total Post/i);
    if (!table) return [];
    const nameCol = 0;
    const totalCol = columnIndex(table, /total|no\.? of post|vacanc/i);
    const eligCol = columnIndex(table, /eligib|qualification/i);
    const payCol = columnIndex(table, /pay|salary|level/i);

    return table.rows.map(cells => {
        const elig = eligCol >= 0 ? (cells[eligCol].items.length ? cells[eligCol].items : [cells[eligCol].text]) : [];
        return {
            name: cells[nameCol].text,
            total: totalCol >= 0 ? cells[totalCol].text : null,
            eligibility: elig.map(s => s.trim()).filter(s => !isBoilerplate(s)),
            pay: payCol >= 0 ? cells[payCol].text || null : null,
        };
    }).filter(p => p.name);
}

// Height / chest / weight / race lines are physical standards, not qualifications.
export const isPhysicalStandard = line => /^(height|chest|weight|running|race|run\b|eye ?sight|vision|physical (standard|efficiency))/i.test(line);

// Posts with identical requirements are shown together.
export function groupEligibility(posts) {
    const groups = new Map();
    for (const post of posts) {
        if (!post.eligibility.length) continue;
        const key = post.eligibility.join("\n");
        if (!groups.has(key)) {
            groups.set(key, {
                posts: [],
                lines: post.eligibility.filter(l => !isPhysicalStandard(l)),
                physical: post.eligibility.filter(isPhysicalStandard),
            });
        }
        groups.get(key).posts.push(post.name);
    }
    return [...groups.values()];
}

// Category-wise table (UR / EWS / OBC / SC / ST ...), as published.
export function parseCategoryTable(article) {
    const table = article.tables.find(t => t.headers.filter(h => /^(UR|GEN|General|EWS|OBC|SC|ST|PwBD|PH)$/i.test(h)).length >= 2);
    return table ? { headers: table.headers, rows: table.rows.map(r => r.map(c => c.text)) } : null;
}

// State/zone-wise counts double as the posting location.
export function parseLocations(article) {
    const table = article.tables.find(t => /^(State Name|Zone|State|Region)/i.test(t.headers[0]));
    return table ? table.rows.map(r => ({ name: r[0].text, count: r[1]?.text ?? null })).filter(r => r.name) : null;
}

const listSection = (article, re) => {
    const s = findSection(article, re);
    const lines = s?.items.filter(l => !isBoilerplate(l)) ?? [];
    return lines.length ? lines : null;
};

// Explicit employment wording in the title only (never guessed).
const employmentType = title =>
    /apprentice/i.test(title) ? "Apprenticeship"
        : /contract/i.test(title) ? "Contractual"
        : /guest/i.test(title) ? "Guest / Temporary"
        : null;

const TYPES = { latestJob: "job", admitCard: "admitCard", result: "result", admission: "admission" };

export function buildVacancy(article, { taskName, sourceUrl, links, linkCheck, notificationCheck, today = new Date() }) {
    const dates = classifyDates(findSection(article, /important dates/i)?.items ?? []);
    const posts = parsePosts(article);
    const status = applicationStatus(dates, today);
    const activates = links.primary?.activatesOn && parseIndianDate(links.primary.activatesOn);

    return {
        type: TYPES[taskName] ?? "job",
        title: article.title,
        organization: article.organization,
        advertisementNo: article.advertisementNo,
        totalPosts: article.totalPosts,
        employmentType: article.title ? employmentType(article.title) : null,
        posts,
        categoryVacancies: parseCategoryTable(article),
        locations: parseLocations(article),
        dates,
        status: status === "open" && activates && startOfDay(today) < activates ? "upcoming" : status,
        fees: parseFees(findSection(article, /application fee|exam fee/i)),
        age: parseAge(findSection(article, /age limit/i)),
        eligibility: groupEligibility(posts),
        selection: listSection(article, /selection|mode of selection/i),
        salary: listSection(article, /pay scale|salary|pay level|emolument/i),
        documents: listSection(article, /documents? required|required documents/i),
        otr: article.mentionsOtr,
        apply: links.primary ? {
            url: links.primary.href,
            trust: links.primary.trust,
            homepage: isHomepage(links.primary.href),
            activatesOn: links.primary.activatesOn,
            ...linkCheck,
        } : null,
        notification: notificationCheck ?? null,
        sources: {
            article: sourceUrl,
            officialWebsite: links.officialWebsite,
            notification: links.notification,
            apply: links.primary?.href ?? null,
            checkedAt: new Date().toISOString(),
        },
    };
}

const isHomepage = url => {
    try {
        const { pathname, search } = new URL(url);
        return (pathname === "/" || pathname === "") && !search;
    } catch {
        return false;
    }
};

// Values to look for in the notification text.
export function factsForCrossCheck(model) {
    const dates = {};
    for (const [field, entry] of Object.entries(model.dates)) {
        if (field !== "others" && entry?.date) dates[field] = entry.date;
    }
    return {
        dates,
        totalPosts: model.totalPosts,
        advertisementNo: model.advertisementNo,
        ageReferenceDate: model.age?.referenceDate ?? null,
        feeAmounts: model.fees?.items.map(f => f.amount).filter(Number.isFinite) ?? [],
    };
}
