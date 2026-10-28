import { displayDate, startOfDay } from "../vacancy/dates.js";
import { splitMessage } from "../vacancy/format.js";
import { LINK_NOTE } from "./linkpolicy.js";

// Compact WhatsApp templates. Everything shown comes from sarkariresult.com.cm; required
// fields that the site does not publish say so, optional ones are left out.

export const NOT_ON_SOURCE = "Not specified on the source website";

const STATUS = {
    open: "🟢 Applications open",
    upcoming: "🟡 Applications not open yet",
    closed: "🔴 Applications closed",
    unknown: "⚪ Status not specified on the source website",
};

const dateValue = entry => {
    if (!entry) return null;
    return entry.date ? displayDate(entry.date) : entry.text;
};

const bullets = lines => lines.map(l => `• ${l}`).join("\n");

// Short warnings for incomplete or contradictory details on the source page.
export function warningsFor(model, today = new Date()) {
    const w = [];
    const d = model.dates;
    const day = startOfDay(today);

    if (d.start?.date && d.lastDate?.date && d.lastDate.date < d.start.date) w.push("last date is before the start date");
    if (d.feeLastDate?.date && d.start?.date && d.feeLastDate.date < d.start.date) w.push("fee last date is before the start date");
    if (/last date today/i.test(model.titleStatus ?? "") && d.lastDate?.date && d.lastDate.date.getTime() !== day.getTime()) {
        w.push(`title says "Last Date Today" but the last date is ${displayDate(d.lastDate.date)}`);
    }

    const missing = [];
    if (model.type === "job" || model.type === "admission") {
        if (!d.lastDate) missing.push("last date");
        if (!model.qualification) missing.push("qualification");
        if (!model.fees?.items.length) missing.push("fees");
        if (model.type === "job" && !model.age) missing.push("age limit");
    }
    // A link that was found but withheld by the link policy is explained in the link block.
    if (!model.links.primary && !model.links.found) missing.push(model.type === "admitCard" ? "download link" : model.type === "result" ? "result / answer key link" : "application link");
    if (missing.length) w.push(`not given on the source website: ${missing.join(", ")}`);
    return w;
}

function datesBlock(model, rows) {
    const lines = rows.map(([label, key]) => [label, dateValue(model.dates[key])]).filter(([, v]) => v);
    return lines.length ? `📅 *Dates*\n${lines.map(([l, v]) => `• ${l}: ${v}`).join("\n")}` : `📅 *Dates:* ${NOT_ON_SOURCE}`;
}

function ageBlock(model) {
    const a = model.age;
    if (!a) return `🎂 *Age Limit:* ${NOT_ON_SOURCE}`;
    const head = `🎂 *Age Limit*${a.referenceDate ? ` (as on ${displayDate(a.referenceDate)})` : a.referenceText ? ` (as on ${a.referenceText})` : ""}`;
    const tidy = l => l.replace(/\s*:\s*/, ": ");
    return `${head}\n${bullets([...a.limits.map(tidy), ...a.relaxation.map(r => `Relaxation: ${r.replace(/^age relaxation\s*:?\s*/i, "")}`)])}`;
}

function feesBlock(model) {
    const f = model.fees;
    if (!f?.items.length) return `💰 *Application Fee:* ${NOT_ON_SOURCE}`;
    return `💰 *Application Fee*\n${bullets([...f.items.map(i => `${i.label}: ${i.value}`), ...f.notes])}`;
}

// --- Qualification -----------------------------------------------------------------------
// Short lists are shown as published. Long or post-wise lists are condensed: alternatives
// joined by "OR" become one "Any one of" bullet, long lines are shortened at a word boundary
// (marked "…"), and the message says when something is not shown. Wording is never changed
// and no condition is presented as the complete requirement when it is not.

export const POST_WISE_NOTE = "📌 See notification for post-wise eligibility";
const MAX_QUAL_BULLETS = 4;
const MAX_QUAL_CHARS = 520;
const MAX_LINE = 140;

const shorten = (s, n = MAX_LINE) => {
    if (s.length <= n) return s;
    const cut = s.slice(0, n);
    return `${cut.slice(0, Math.max(cut.lastIndexOf(" "), n - 20)).replace(/[\s,;/(–-]+$/, "")}…`;
};

// Lines ending in "OR" (and lines that are themselves lists of "… OR …") are alternatives.
export function qualificationGroups(lines) {
    const groups = [];
    let alts = null;
    for (const raw of lines) {
        const endsWithOr = /\s+OR\.?$/i.test(raw);
        const text = raw.replace(/\s+OR\.?$/i, "").trim();
        const inner = text.split(/\s+OR\s+/i);
        if (alts) {
            alts.push(...inner);
            if (!endsWithOr) { groups.push({ alts }); alts = null; }
        } else if (endsWithOr) {
            alts = [...inner];
        } else {
            groups.push(inner.length > 2 ? { alts: inner } : { line: text });
        }
    }
    if (alts) groups.push({ alts });
    return groups;
}

function renderGroup(group) {
    if (group.line) return { text: shorten(group.line), cut: group.line.length > MAX_LINE };
    const n = group.alts.length;
    const full = `Any one of: ${group.alts.join(" / ")}`;
    if (full.length <= 220) return { text: full, cut: false };
    return { text: `Any one of ${n} options, e.g. ${shorten(group.alts[0], 110)}`, cut: true };
}

export function summarizeQualification(q) {
    const rendered = qualificationGroups(q.lines).map(renderGroup);
    const shown = [];
    let chars = 0;
    for (const r of rendered) {
        if (shown.length >= MAX_QUAL_BULLETS || chars + r.text.length > MAX_QUAL_CHARS) break;
        shown.push(r);
        chars += r.text.length;
    }
    const hidden = rendered.length - shown.length;
    const condensed = hidden > 0 || shown.some(r => r.cut);
    const lines = shown.map(r => r.text);
    if (q.postWise || condensed) {
        lines.push(`${POST_WISE_NOTE}${hidden > 0 ? ` (${hidden} more condition${hidden > 1 ? "s" : ""} not shown)` : ""}`);
    }
    return lines;
}

function qualificationBlock(model) {
    const q = model.qualification;
    if (!q) return `🎓 *Qualification:* ${NOT_ON_SOURCE}`;
    const lines = summarizeQualification(q);
    return `🎓 *Qualification*\n${lines.map(l => (l.startsWith("📌") ? l : `• ${l}`)).join("\n")}`;
}

// --- Links -------------------------------------------------------------------------------
function linkBlock(model, heading, unavailable) {
    const { primary, policy } = model.links;
    if (!primary) {
        if (policy && !policy.show) return `${heading}\nLink not shown: ${policy.reason}. Use the organisation's official website instead.`;
        return `${heading}\n${unavailable}`;
    }
    const note = LINK_NOTE[policy?.level];
    return `${heading}\n${primary}${note ? `\n${note}` : ""}`;
}

function warningLine(model, today) {
    const w = warningsFor(model, today);
    return w.length ? `⚠️ ${w.join("; ")}. Check the official notification.` : null;
}

function statusText(model, today) {
    const last = model.dates.lastDate?.date;
    if (model.status === "open" && last && last.getTime() === startOfDay(today).getTime()) return `${STATUS.open} — last date today`;
    return STATUS[model.status];
}

export function formatCompactVacancy(model, today = new Date()) {
    const total = model.totalPosts ? model.totalPosts.toLocaleString("en-IN") : NOT_ON_SOURCE;
    const categories = model.categoryVacancies?.length
        ? `\n• ${model.categoryVacancies.map(c => `${c.category} ${c.count}`).join(" | ")}`
        : "";
    const parts = [
        [`📢 *${model.title}*`, model.organization && `🏢 ${model.organization}`].filter(Boolean).join("\n"),
        `👥 *Total Vacancies:* ${total}${categories}\n📌 *Status:* ${statusText(model, today)}`,
        datesBlock(model, [["Start", "start"], ["Last Date", "lastDate"], ["Fee Last Date", "feeLastDate"], ["Exam", "exam"]]),
        qualificationBlock(model),
        ageBlock(model),
        feesBlock(model),
        model.selection && `🏆 *Selection:* ${model.selection.join(" → ")}`,
        model.salary && `💵 *Salary:* ${model.salary.join("; ")}`,
        warningLine(model, today),
        linkBlock(model, "🚀 *APPLY NOW*", "Application link not given on the source website — check the official notification."),
    ];
    return parts.filter(Boolean).join("\n\n");
}

const UPDATE = {
    admitCard: { icon: "🎫", rows: [["Exam", "exam"], ["Admit Card", "admitCard"]], link: "📥 *DOWNLOAD ADMIT CARD*", none: "Download link not given on the source website." },
    result: { icon: "🏆", rows: [["Exam", "exam"], ["Answer Key", "answerKey"], ["Result", "result"]], link: "📥 *CHECK RESULT*", none: "Result link not given on the source website." },
};

export function formatCompactUpdate(model, today = new Date()) {
    if (model.type === "admission") {
        const parts = [
            [`🎓 *${model.title}*`, model.organization && `🏢 ${model.organization}`].filter(Boolean).join("\n"),
            `📌 *Status:* ${statusText(model, today)}`,
            datesBlock(model, [["Start", "start"], ["Last Date", "lastDate"], ["Exam", "exam"]]),
            model.qualification && qualificationBlock(model),
            model.age && ageBlock(model),
            feesBlock(model),
            warningLine(model, today),
            linkBlock(model, "🚀 *APPLY NOW*", "Application link not given on the source website — check the official notification."),
        ];
        return parts.filter(Boolean).join("\n\n");
    }
    // Answer keys are listed in the site's "Results" block; label them as what they are.
    const answerKey = model.type === "result" && /answer key/i.test(model.title ?? "") && !/\bresult\b/i.test(model.title ?? "");
    const t = answerKey
        ? { ...UPDATE.result, icon: "🔑", link: "📥 *CHECK ANSWER KEY*", none: "Answer key link not given on the source website." }
        : UPDATE[model.type];
    const parts = [
        [`${t.icon} *${model.title}*`, model.organization && `🏢 ${model.organization}`].filter(Boolean).join("\n"),
        datesBlock(model, t.rows),
        warningLine(model, today),
        linkBlock(model, t.link, t.none),
    ];
    return parts.filter(Boolean).join("\n\n");
}

export function formatCompact(model, today = new Date()) {
    const text = model.type === "job" ? formatCompactVacancy(model, today) : formatCompactUpdate(model, today);
    return splitMessage(text, { label: model.title ?? "" });
}
