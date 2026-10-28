import { displayDate } from "./dates.js";
import { TRUST_LABEL, hostOf } from "./links.js";

// WhatsApp formatting: *bold*, plain line breaks, URLs on their own line so they stay clickable.

export const RULE = "━━━━━━━━━━━━━━━━━━";
export const UNVERIFIED = "Could not verify — check official notification";
// WhatsApp accepts much longer texts, but beyond ~4,000 characters a message becomes hard to
// read and is collapsed behind "Read more"; longer notifications are split into parts.
export const MAX_PART_CHARS = 4000;

const tick = (matches, field) => (matches?.[field] ? " ✔" : "");

// Published text for a date; adds a hint for non-dates such as "As per Schedule".
function dateText(entry, matches, field) {
    if (!entry) return null;
    if (entry.date) {
        // Keep remarks such as "(Date Extended)" that follow the date.
        const remark = entry.text
            .replace(/^\s*(\d{1,2}\s*[/.-]\s*\d{1,2}\s*[/.-]\s*\d{2,4}|\d{1,2}(st|nd|rd|th)?\s+[A-Za-z]+,?\s+\d{4}|[A-Za-z]+\s+\d{1,2},?\s+\d{4})/, "")
            .replace(/[()]/g, "")
            .trim();
        return `${displayDate(entry.date)}${remark ? ` (${remark})` : ""}${tick(matches, field)}`;
    }
    return `${entry.text} (tentative / not yet announced)`;
}

const bullet = lines => lines.map(l => `• ${l}`).join("\n");

const STATUS_LINE = {
    open: "🟢 Applications are OPEN",
    upcoming: "🟡 Applications have NOT opened yet",
    closed: "🔴 Applications are CLOSED (last date has passed)",
    unknown: "⚪ Application status could not be determined",
};

function yearOf(model) {
    return model.title?.match(/\b(20\d\d)\b/)?.[1] ?? "";
}

function postNames(model) {
    const names = [...new Set(model.posts.map(p => p.name))];
    if (names.length && names.length <= 4) return names.join(", ");
    if (names.length) return `${names.length} posts (see vacancy details)`;
    return model.title ?? UNVERIFIED;
}

function vacancySection(model) {
    const lines = [];
    const counted = model.posts.filter(p => p.total);
    // Counts such as "Soon" or "—" mean the number is not published yet.
    const count = total => (/\d/.test(total) ? total : `count not yet published${total ? ` (“${total}”)` : ""}`);
    if (counted.length > 1 || (counted.length === 1 && model.posts.length > 1)) {
        lines.push(...counted.map(p => `• ${p.name}: ${count(p.total)}`));
    }
    if (model.categoryVacancies) {
        const { headers, rows } = model.categoryVacancies;
        lines.push("", "*Category-wise:*");
        for (const row of rows) {
            lines.push(`• ${row[0]}: ${headers.slice(1).map((h, i) => `${h} ${row[i + 1]}`).join(" | ")}`);
        }
    }
    return lines.length ? `👥 *VACANCY DETAILS*\n${lines.join("\n").trim()}` : null;
}

function locationText(model) {
    if (!model.locations?.length) return UNVERIFIED;
    const count = c => (c ? c.replace(/\s*posts?$/i, "") : "");
    const list = model.locations.map(l => `${l.name}${count(l.count) ? ` ${count(l.count)}` : ""}`).join(", ");
    return model.locations.length <= 6 ? list : `${model.locations.length} states/zones — ${list}`;
}

function datesSection(model, { withApplication = true } = {}) {
    const m = model.notification?.matches;
    const d = model.dates;
    const rows = [
        ["🔔 Notification Date", dateText(d.notification, m, "notification")],
        withApplication && ["🟢 Application Start", dateText(d.start, m, "start") ?? (model.status === "upcoming" ? "Upcoming" : null)],
        withApplication && ["🔴 Last Date to Apply", dateText(d.lastDate, m, "lastDate")],
        withApplication && ["💳 Fee Payment Last Date", dateText(d.feeLastDate, m, "feeLastDate")],
        withApplication && ["✏️ Correction Window", dateText(d.correction, m, "correction")],
        ["📝 Exam Date", dateText(d.exam, m, "exam") ?? "To be announced"],
        ["🎫 Admit Card", dateText(d.admitCard, m, "admitCard") ?? "To be announced"],
        ["🔑 Answer Key", dateText(d.answerKey, m, "answerKey")],
        ["🏆 Result", dateText(d.result, m, "result")],
    ].filter(r => r && r[1]);
    for (const other of d.others) rows.push([`📌 ${other.label}`, dateText(other, null)]);
    if (!rows.length) return `📅 *IMPORTANT DATES*\n${UNVERIFIED}`;
    return `📅 *IMPORTANT DATES*\n${rows.map(([k, v]) => `${k}: ${v}`).join("\n")}`;
}

function eligibilitySection(model) {
    const groups = model.eligibility.filter(g => g.lines.length);
    if (!groups.length) return `🎓 *EDUCATIONAL QUALIFICATION*\n${UNVERIFIED}`;
    const single = groups.length === 1;
    const blocks = groups.map(g => (single ? bullet(g.lines) : `*${g.posts.join(", ")}:*\n${bullet(g.lines)}`));
    return `🎓 *EDUCATIONAL QUALIFICATION*\n${blocks.join("\n\n")}`;
}

function physicalSection(model) {
    const groups = model.eligibility.filter(g => g.physical?.length);
    if (!groups.length) return null;
    // Identical standards for every post are listed once.
    const same = groups.every(g => g.physical.join("\n") === groups[0].physical.join("\n"));
    const blocks = same
        ? [bullet(groups[0].physical)]
        : groups.map(g => `*${g.posts.join(", ")}:*\n${bullet(g.physical)}`);
    return `🏃 *PHYSICAL STANDARDS*\n${blocks.join("\n\n")}`;
}

function ageSection(model) {
    const a = model.age;
    if (!a) return `🎂 *AGE LIMIT*\n${UNVERIFIED}`;
    const m = model.notification?.matches;
    const lines = [
        `• Minimum Age: ${a.min ?? UNVERIFIED}`,
        `• Maximum Age: ${a.max ?? UNVERIFIED}`,
        `• Age Calculation Date: ${a.referenceDate ? displayDate(a.referenceDate) + tick(m, "ageReferenceDate") : a.referenceText ?? UNVERIFIED}`,
        ...a.other.map(l => `• ${l}`),
    ];
    const relax = a.relaxation.length
        ? bullet(a.relaxation)
        : `• ${UNVERIFIED}`;
    const generic = a.relaxation.every(l => /as per/i.test(l) && !/SC|ST|OBC|EWS|PwBD|PH|years/i.test(l.replace(/as per.*$/i, "")));
    return `🎂 *AGE LIMIT*\n${lines.join("\n")}\n\n📌 *AGE RELAXATION*\n${relax}${generic ? `\n• Category-wise relaxation (SC/ST/OBC/EWS/PwBD): ${UNVERIFIED}` : ""}`;
}

function feesSection(model) {
    const f = model.fees;
    if (!f || !f.items.length) return `💰 *APPLICATION FEES*\n${UNVERIFIED}`;
    const lines = f.items.map(i => `• ${i.label}: ${i.value}`);
    if (f.notes.length) lines.push(...f.notes.map(n => `• ${n}`));
    const verified = model.notification?.matches?.fees ? " ✔" : "";
    return `💰 *APPLICATION FEES*${f.tentative ? " (tentative)" : ""}${verified}\n${lines.join("\n")}`;
}

function salarySection(model) {
    const perPost = model.posts.filter(p => p.pay);
    if (perPost.length) return `💵 *SALARY / PAY SCALE*\n${perPost.map(p => `• ${p.name}: ${p.pay}`).join("\n")}`;
    if (model.salary) return `💵 *SALARY / PAY SCALE*\n${bullet(model.salary)}`;
    return `💵 *SALARY / PAY SCALE*\n${UNVERIFIED}`;
}

// Restates only facts shown above; adds no new conditions.
function summarySection(model) {
    const groups = model.eligibility.filter(g => g.lines.length);
    if (!groups.length && !/\d/.test(`${model.age?.min ?? ""}${model.age?.max ?? ""}`)) return null;
    const parts = [];
    if (groups.length === 1) parts.push(`Candidates with: ${groups[0].lines.map(l => l.replace(/[.;,\s]+$/, "")).join("; ")}`);
    else if (groups.length > 1) parts.push("Candidates who hold the post-wise qualification listed above");
    else parts.push("Candidates");
    // Only numeric ages are summarised ("NA" or "Not specified" are left out, not guessed).
    const hasNumber = v => /\d/.test(v ?? "");
    const asOn = model.age?.referenceDate ? ` as on ${displayDate(model.age.referenceDate)}` : "";
    if (hasNumber(model.age?.min) && hasNumber(model.age?.max)) {
        parts.push(`aged ${model.age.min.replace(/\s*years?/i, "")}–${model.age.max}${asOn} (before relaxation)`);
    } else if (hasNumber(model.age?.max)) {
        parts.push(`aged up to ${model.age.max}${asOn} (before relaxation)`);
    } else if (hasNumber(model.age?.min)) {
        parts.push(`aged at least ${model.age.min}${asOn}`);
    }
    const physical = model.eligibility.some(g => g.physical?.length) ? " Physical standards also apply." : "";
    return `📋 *ELIGIBILITY SUMMARY*\n${parts.join(", ")}.${physical} Final eligibility is decided by the official notification.`;
}

function howToApply(model) {
    const steps = [];
    if (model.status === "upcoming") steps.push(`Wait until the application window opens${model.dates.start?.date ? ` on ${displayDate(model.dates.start.date)}` : ""}.`);
    steps.push("Read the official notification completely.");
    steps.push(model.otr ? "Complete One Time Registration (OTR) on the official portal, then log in." : "Open the official application form and register / log in.");
    steps.push("Fill in your details carefully.");
    steps.push("Upload your photograph, signature and documents as instructed.");
    if (model.fees?.items.some(f => f.amount > 0)) steps.push("Pay the applicable fee before the fee deadline.");
    steps.push("Submit the form and save / print the confirmation.");
    return `📝 *HOW TO APPLY*\n${steps.map((s, i) => `${i + 1}. ${s}`).join("\n")}`;
}

// Fields each template displays; verification notes only mention these.
const SHOWN = {
    job: null, // everything
    admission: ["start", "lastDate", "feeLastDate", "correction", "notification", "exam", "admitCard", "answerKey", "result", "advertisementNo", "ageReferenceDate", "fees"],
    admitCard: ["notification", "exam", "admitCard", "answerKey", "result", "advertisementNo"],
    result: ["notification", "exam", "admitCard", "answerKey", "result", "advertisementNo"],
};

function verificationNotes(model) {
    const notes = [];
    const n = model.notification;
    const where = n?.official ? `official notification PDF (${n.host})` : `copy of the notification PDF (${n?.host ?? "unknown host"})`;
    const audience = model.type === "job" || model.type === "admission" ? "before applying" : "on the official website";
    if (n?.status === "checked") {
        const shown = SHOWN[model.type];
        const matches = Object.fromEntries(Object.entries(n.matches).filter(([k]) => !shown || shown.includes(k)));
        const found = Object.entries(matches).filter(([, v]) => v).map(([k]) => FIELD_NAMES[k] ?? k);
        const missing = Object.entries(matches).filter(([, v]) => !v).map(([k]) => FIELD_NAMES[k] ?? k);
        if (applicationDatesConflict(matches)) {
            notes.push(`⚠️ CONFLICT: the application dates shown here were NOT found in the ${where}. The notice may be older or revised (re-opened / extended). Check the latest notice on the official website before applying.`);
        }
        if (found.length) notes.push(`✔ marks values found in the ${where}: ${found.join(", ")}.`);
        if (missing.length) notes.push(`Not found in the notification text: ${missing.join(", ")} — check the official notification.`);
    } else if (n?.status === "scanned") {
        notes.push(`The notification PDF (${n.host}) is a scanned image, so details could not be cross-checked automatically.`);
    } else if (n?.status === "unreachable") {
        notes.push(n.reason === "tls"
            ? `The notification PDF (${n.host}) could not be opened automatically (the site's security setup is not supported), so details were not cross-checked.`
            : `The notification PDF (${n.host}) could not be downloaded, so details were not cross-checked.`);
    } else {
        notes.push("No notification PDF was available to cross-check these details.");
    }
    notes.push(`Details are compiled from a recruitment news page; confirm everything in the official notification ${audience}.`);
    return notes;
}

// None of the checked application dates (start / last date / fee date) appear in the notice.
export function applicationDatesConflict(matches = {}) {
    const checked = ["start", "lastDate", "feeLastDate"].filter(f => f in matches);
    return checked.length > 0 && checked.every(f => !matches[f]);
}

const FIELD_NAMES = {
    start: "application start", lastDate: "last date", feeLastDate: "fee last date", correction: "correction date",
    notification: "notification date", exam: "exam date", admitCard: "admit card date", answerKey: "answer key date", result: "result date",
    totalPosts: "total vacancies", advertisementNo: "advertisement no.", ageReferenceDate: "age reference date", fees: "fee amounts",
};

function linkBlock(model, heading) {
    const a = model.apply;
    if (!a) return `${heading}\nOfficial link not available — check the official notification / website before applying.`;
    const notes = [];
    if (a.activatesOn && model.status === "upcoming") notes.push(`⏳ Link becomes active ${a.activatesOn === "soon" ? "soon" : `on ${a.activatesOn}`}.`);
    if (a.homepage) notes.push("ℹ️ This is the official portal's home page; open the recruitment section there.");
    if (a.trust === "unconfirmed") notes.push(`⚠️ ${hostOf(a.url)}: ${TRUST_LABEL.unconfirmed}. Verify before entering any details.`);
    if (a.reachable === false) notes.push(`⚠️ The link returned HTTP ${a.status} when checked.`);
    if (a.reachable === null) {
        notes.push(a.reason === "tls"
            ? "ℹ️ Automatic link check not possible (the site's security setup is not supported by the checker)."
            : "⚠️ The link could not be reached when checked (the site may be slow or down).");
    }
    return `${heading}\n${a.url}${notes.length ? `\n${notes.join("\n")}` : ""}`;
}

function header(model, icon, label) {
    const lines = [
        `🏢 *Organization:* ${model.organization ?? UNVERIFIED}`,
        `${icon} *${label}:* ${model.type === "job" ? postNames(model) : model.title ?? UNVERIFIED}`,
        `🔢 *Advertisement No.:* ${model.advertisementNo ? model.advertisementNo + tick(model.notification?.matches, "advertisementNo") : UNVERIFIED}`,
    ];
    return lines;
}

export function formatVacancy(model) {
    const m = model.notification?.matches;
    const top = [
        ...header(model, "💼", "Post Name"),
        `📍 *Job Location:* ${locationText(model)}`,
        `👥 *Total Vacancies:* ${model.totalPosts ? model.totalPosts + tick(m, "totalPosts") : UNVERIFIED}`,
        model.employmentType && `🧾 *Employment Type:* ${model.employmentType}`,
        `📌 *Status:* ${STATUS_LINE[model.status]}`,
    ].filter(Boolean);

    const sections = [
        `📢 *NEW GOVERNMENT VACANCY ${yearOf(model)}*`.replace(/ \*$/, "*"),
        RULE,
        top.join("\n"),
        RULE,
        datesSection(model),
        RULE,
        vacancySection(model),
        eligibilitySection(model),
        physicalSection(model),
        ageSection(model),
        feesSection(model),
        `🏆 *SELECTION PROCESS*\n${model.selection ? bullet(model.selection) : UNVERIFIED}`,
        salarySection(model),
        summarySection(model),
        `📄 *DOCUMENTS REQUIRED*\n${model.documents ? bullet(model.documents) : UNVERIFIED}`,
        howToApply(model),
        RULE,
        `🚨 *IMPORTANT NOTE*\n${bullet([STATUS_LINE[model.status], ...verificationNotes(model)])}`,
        RULE,
        linkBlock(model, "🚀 *APPLY NOW*"),
    ];
    return sections.filter(Boolean).join("\n\n").replace(new RegExp(`\\n\\n${RULE}\\n\\n`, "g"), `\n${RULE}\n`);
}

// Admit cards, results and admissions get their own templates (never labelled as vacancies).
const UPDATE_TEMPLATES = {
    admitCard: { title: "🎫 *ADMIT CARD RELEASED*", icon: "📝", label: "Exam", link: "📥 *DOWNLOAD ADMIT CARD*" },
    result: { title: "🏆 *RESULT DECLARED*", icon: "📝", label: "Exam", link: "📥 *CHECK RESULT*" },
    admission: { title: "🎓 *ADMISSION / ONLINE FORM*", icon: "📚", label: "Course / Exam", link: "🚀 *APPLY NOW*" },
};

export function formatUpdate(model) {
    const t = UPDATE_TEMPLATES[model.type];
    const isAdmission = model.type === "admission";
    const sections = [
        t.title,
        RULE,
        [...header(model, t.icon, t.label), isAdmission && `📌 *Status:* ${STATUS_LINE[model.status]}`].filter(Boolean).join("\n"),
        RULE,
        datesSection(model, { withApplication: isAdmission }),
        isAdmission && feesSection(model),
        isAdmission && model.age && ageSection(model),
        isAdmission && model.eligibility.length && eligibilitySection(model),
        RULE,
        `🚨 *IMPORTANT NOTE*\n${bullet(verificationNotes(model))}`,
        RULE,
        linkBlock(model, t.link),
    ];
    return sections.filter(Boolean).join("\n\n").replace(new RegExp(`\\n\\n${RULE}\\n\\n`, "g"), `\n${RULE}\n`);
}

export const formatNotification = model => (model.type === "job" ? formatVacancy(model) : formatUpdate(model));

// Splits a long message into labelled parts at section boundaries (never inside a line,
// so URLs stay intact). The last section (the link) always ends up in the last part.
export function splitMessage(text, { max = MAX_PART_CHARS, label = "" } = {}) {
    if (text.length <= max) return [text];

    const blocks = text.split(/\n(?=━)|\n\n/);
    const reserve = 60 + label.length;
    const parts = [];
    let current = "";
    const push = () => {
        if (current.trim()) parts.push(current.trim());
        current = "";
    };

    for (const block of blocks) {
        const pieces = block.length > max - reserve ? block.split("\n") : [block];
        for (const piece of pieces) {
            const sep = current ? (piece.startsWith("━") || pieces.length > 1 ? "\n" : "\n\n") : "";
            if ((current + sep + piece).length > max - reserve) push();
            current += (current ? sep : "") + piece;
        }
    }
    push();

    // A divider at the edge of a part is redundant next to the part header/footer.
    const trimRules = p => p.replace(new RegExp(`^(${RULE}\\n)+`), "").replace(new RegExp(`(\\n${RULE})+$`), "");
    const short = label.length > 60 ? `${label.slice(0, 57)}…` : label;
    return parts.map(trimRules).map((p, i) => (i === 0
        ? `${p}\n\n_(Part 1/${parts.length})_`
        : `📢 *${short}* — Part ${i + 1}/${parts.length}\n${RULE}\n${p}`));
}
