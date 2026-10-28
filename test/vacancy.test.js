import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { test } from "node:test";

import { parseArticle } from "../src/vacancy/article.js";
import { collectNotification } from "../src/vacancy/collect.js";
import { datesInText, parseIndianDate } from "../src/vacancy/dates.js";
import { MAX_PART_CHARS, UNVERIFIED, applicationDatesConflict, formatNotification, splitMessage } from "../src/vacancy/format.js";
import { classifyLink, pickLinks, sameSite } from "../src/vacancy/links.js";
import { applicationStatus, buildVacancy, classifyDates, factsForCrossCheck, parseFees } from "../src/vacancy/model.js";
import { crossCheck, fetchNotification, checkNotification, pdfText, probeLink, tlsProblem } from "../src/vacancy/verify.js";
import { openStore } from "../src/store.js";
import { makePdf, tempDir } from "./helpers.js";

const jobHtml = fs.readFileSync(new URL("./fixtures/article-job.html", import.meta.url), "utf8");
const admitHtml = fs.readFileSync(new URL("./fixtures/article-admitcard.html", import.meta.url), "utf8");
const TODAY = new Date(2026, 9, 26);
const silent = { info() {}, warn() {}, error() {} };

const NOTICE_TEXT = [
    "EXAMPLE PUBLIC SERVICE COMMISSION Advertisement No. 07/2026",
    "Recruitment of Assistant - 120 posts",
    "Opening date of online application: 20.10.2026",
    "Closing date of online application: 19 th November, 2026",
    "Last date for fee payment: 21/11/2026",
    "Age as on 01-07-2026: minimum 21 and maximum 40 years",
    "Fee: General/OBC/EWS Rs. 500, SC/ST Rs. 250",
    ...Array.from({ length: 12 }, (_, i) => `General instruction ${i + 1}: candidates must read all conditions carefully before applying.`),
].join("\n");

function model({ article = parseArticle(jobHtml), taskName = "latestJob", linkCheck = { reachable: true, status: 200 }, notificationCheck, today = TODAY } = {}) {
    const kind = taskName === "admitCard" ? "admitCard" : "apply";
    return buildVacancy(article, { taskName, sourceUrl: "https://www.sarkariresult.com/x/", links: pickLinks(article.links, kind), linkCheck, notificationCheck, today });
}

// --- Dates ------------------------------------------------------------------

test("parseIndianDate handles the formats used on posts and in notices", () => {
    assert.deepEqual(parseIndianDate("26/11/2026"), new Date(2026, 10, 26));
    assert.deepEqual(parseIndianDate("06.11.2026"), new Date(2026, 10, 6));
    assert.deepEqual(parseIndianDate("30/09/2026 (Date Extended)"), new Date(2026, 8, 30));
    assert.deepEqual(parseIndianDate("21 st October, 2026"), new Date(2026, 9, 21));
    assert.deepEqual(parseIndianDate("November 5, 2026"), new Date(2026, 10, 5));
    assert.deepEqual(parseIndianDate("२६/११/२०२६"), new Date(2026, 10, 26), "Devanagari digits");
    assert.equal(parseIndianDate("As per Schedule"), null);
    assert.equal(parseIndianDate("31/02/2026"), null, "impossible dates are rejected");
});

test("datesInText finds every date format in a notice", () => {
    const found = datesInText(NOTICE_TEXT);
    for (const iso of ["2026-10-20", "2026-11-19", "2026-11-21", "2026-07-01"]) assert.ok(found.has(iso), iso);
});

// --- Article parsing ---------------------------------------------------------

test("parseArticle extracts the structured parts of a job post", () => {
    const a = parseArticle(jobHtml);
    assert.equal(a.title, "Example Public Service Commission EPSC Assistant Recruitment 2026 Apply Online for 120 Post");
    assert.equal(a.organization, "Example Public Service Commission (EPSC)");
    assert.equal(a.advertisementNo, "07/2026");
    assert.equal(a.totalPosts, 120);
    assert.equal(a.mentionsOtr, true);
    assert.deepEqual(a.sections.map(s => s.heading.slice(0, 20)), ["Important Dates", "Application Fee (Ten", "EPSC Assistant 2026 ", "Sarkari Result® : Ho"]);
    assert.equal(a.tables.length, 2);
});

test("dates are classified, tentative values kept as text, nothing invented", () => {
    const d = classifyDates(parseArticle(jobHtml).sections[0].items);
    assert.deepEqual(d.start.date, new Date(2026, 9, 20));
    assert.deepEqual(d.lastDate.date, new Date(2026, 10, 19));
    assert.deepEqual(d.feeLastDate.date, new Date(2026, 10, 21));
    assert.deepEqual(d.correction.date, new Date(2026, 10, 25));
    assert.equal(d.exam.date, null);
    assert.equal(d.exam.text, "As per Schedule");
    assert.equal(d.admitCard.text, "Before Exam");
    assert.deepEqual(d.others.map(o => o.label), ["Exam City Available"]);
    assert.equal(d.notification, undefined);
});

test("application status: upcoming, open, closed, unknown", () => {
    const d = classifyDates(parseArticle(jobHtml).sections[0].items);
    assert.equal(applicationStatus(d, new Date(2026, 9, 19)), "upcoming");
    assert.equal(applicationStatus(d, new Date(2026, 9, 20)), "open");
    assert.equal(applicationStatus(d, new Date(2026, 10, 19, 22)), "open", "last day is still open");
    assert.equal(applicationStatus(d, new Date(2026, 10, 20)), "closed");
    assert.equal(applicationStatus({}, TODAY), "unknown");
});

test("fees keep the published categories; no category is assumed equal to another", () => {
    const fees = parseFees(parseArticle(jobHtml).sections[1]);
    assert.equal(fees.tentative, true);
    assert.deepEqual(fees.items, [
        { label: "General / OBC / EWS", value: "₹500/-", amount: 500 },
        { label: "SC / ST", value: "₹250/-", amount: 250 },
        { label: "All Category Female", value: "₹0/-", amount: 0 },
    ]);
    assert.deepEqual(fees.notes, ["Pay the Exam Fee Through Debit Card, Credit Card, Net Banking Mode Only."]);
});

test("the model: age, posts, category table, eligibility without boilerplate, physical standards", () => {
    const m = model();
    assert.equal(m.type, "job");
    assert.equal(m.status, "open");
    assert.deepEqual(m.age.referenceDate, new Date(2026, 6, 1));
    assert.equal(m.age.min, "21 Years");
    assert.equal(m.age.max, "40 Years");
    assert.deepEqual(m.posts.map(p => [p.name, p.total]), [["Assistant (Accounts)", "70"], ["Assistant (Field)", "50"]]);
    assert.deepEqual(m.categoryVacancies.headers, ["Post Name", "UR", "EWS", "OBC", "SC", "ST", "Total"]);
    assert.deepEqual(m.eligibility, [
        { posts: ["Assistant (Accounts)"], lines: ["Bachelor Degree in Commerce B.Com."], physical: [] },
        { posts: ["Assistant (Field)"], lines: ["Bachelor Degree in Any Stream."], physical: ["Height Male : 165 CMS"] },
    ]);
    assert.equal(m.selection, null);
    assert.equal(m.salary, null);
    assert.equal(m.documents, null);
    assert.equal(m.locations, null);
});

test("missing sections stay null instead of being filled in", () => {
    const bare = parseArticle("<html><body><table><tr><td>Name Of Post :</td><td>Some Post 2026</td></tr></table></body></html>");
    const m = model({ article: bare });
    assert.equal(m.title, "Some Post 2026");
    assert.equal(m.organization, null);
    assert.equal(m.totalPosts, null);
    assert.equal(m.fees, null);
    assert.equal(m.age, null);
    assert.equal(m.apply, null);
    assert.equal(m.status, "unknown");
});

// --- Links -------------------------------------------------------------------

test("official link classification", () => {
    const official = "https://epsc.example.gov.in/";
    assert.equal(classifyLink("https://epsc.example.gov.in/recruitment/apply", official), "official-site");
    assert.equal(classifyLink("https://other.up.nic.in/form", official), "government-domain");
    assert.equal(classifyLink("https://cdn3.digialm.com/EForms/x", official), "exam-portal");
    assert.equal(classifyLink("https://apply.example-board.org/", official), "unconfirmed");
    assert.equal(classifyLink("https://www.sarkariresult.com/2026/x/", official), null);
    assert.equal(classifyLink("https://doc.sarkariresults.org.in/x.pdf", official), null);
    assert.equal(classifyLink("https://youtu.be/x", official), null);
    assert.equal(classifyLink("javascript:void(0)", official), null);
    assert.equal(sameSite("uppsc.up.nic.in", "upsssc.up.nic.in"), false, "different offices under nic.in are different sites");
    assert.equal(sameSite("careers.bhel.in", "bhel.in"), true);
});

test("pickLinks selects the official apply link and ignores aggregator/social links", () => {
    const links = pickLinks(parseArticle(jobHtml).links, "apply");
    assert.equal(links.primary.href, "https://epsc.example.gov.in/recruitment/apply");
    assert.equal(links.primary.trust, "official-site");
    assert.equal(links.officialWebsite, "https://epsc.example.gov.in/");
    assert.equal(links.notification, "https://epsc.example.gov.in/docs/advt-07-2026.pdf");
});

test("an apply row pointing only to an aggregator yields no apply link", () => {
    const links = pickLinks([{ label: "Apply Online", text: "Click Here", href: "https://www.sarkariresult.com/apply/" }], "apply");
    assert.equal(links.primary, null);
});

test("'Link will be Activate on' marks a not-yet-open application", () => {
    const links = pickLinks([{ label: "Apply Online", text: "Link will be Activate on 30/10/2026", href: "https://x.gov.in/" }], "apply");
    assert.equal(links.primary.activatesOn, "30/10/2026");
    const article = parseArticle(jobHtml);
    const m = buildVacancy(article, { taskName: "latestJob", sourceUrl: "s", links, linkCheck: null, today: TODAY });
    assert.equal(m.status, "upcoming");
});

// --- Verification --------------------------------------------------------------

test("crossCheck reports which facts appear in the notice text", () => {
    const facts = factsForCrossCheck(model());
    const result = crossCheck(facts, NOTICE_TEXT);
    assert.deepEqual(result, {
        start: true, lastDate: true, feeLastDate: true, correction: false,
        totalPosts: true, advertisementNo: true, ageReferenceDate: true, fees: true,
    });
    assert.deepEqual(crossCheck({ ...facts, totalPosts: 999 }, NOTICE_TEXT).totalPosts, false);
});

test("pdfText reads a real PDF text layer; scanned PDFs are recognised", async () => {
    const { text, pages } = await pdfText(makePdf(NOTICE_TEXT));
    assert.equal(pages, 1);
    assert.match(text, /Closing date of online application/);

    const record = await fetchNotification("https://epsc.example.gov.in/a.pdf", { fetchBinary: async () => makePdf("Title only"), log: silent });
    assert.equal(record.status, "scanned");
});

test("notification fetch failures and non-PDF links are reported, never thrown", async () => {
    const down = await fetchNotification("https://x.gov.in/a.pdf", { fetchBinary: async () => { throw new Error("timeout"); }, log: silent });
    assert.equal(down.status, "unreachable");
    assert.equal((await fetchNotification("https://x.gov.in/notice.html", { fetchBinary: async () => null, log: silent })).status, "not-pdf");
    assert.equal((await fetchNotification(null, { fetchBinary: async () => null, log: silent })).status, "missing");
});

test("checkNotification compares current facts and drops the cached text", async () => {
    const record = await fetchNotification("https://epsc.example.gov.in/a.pdf", { fetchBinary: async () => makePdf(NOTICE_TEXT), log: silent });
    assert.equal(record.status, "readable");
    const checked = checkNotification(record, factsForCrossCheck(model()));
    assert.equal(checked.status, "checked");
    assert.equal(checked.official, true);
    assert.equal("text" in checked, false);
    assert.equal(checked.matches.lastDate, true);
});

test("link probing: reachable, HTTP error, network error, outdated TLS", async () => {
    assert.deepEqual((await probeLink("u", { probe: async () => 200 })).reachable, true);
    const notFound = await probeLink("u", { probe: async () => 404 });
    assert.equal(notFound.reachable, false);
    assert.equal(notFound.status, 404);
    const down = await probeLink("u", { probe: async () => { throw new Error("ETIMEDOUT"); }, log: silent });
    assert.equal(down.reachable, null);
    assert.equal(down.reason, "unreachable");
    const tls = await probeLink("u", { probe: async () => { throw new Error("write EPROTO ... unsafe legacy renegotiation disabled"); }, log: silent });
    assert.equal(tls.reason, "tls");
    assert.equal(tlsProblem({ message: "unable to verify the first certificate" }), "site's certificate chain could not be verified");
});

// --- Formatting -------------------------------------------------------------

const urlsIn = text => text.match(/https?:\/\/\S+/g) ?? [];

test("vacancy message: all sections, official link only, at the end", () => {
    const text = formatNotification(model());
    for (const heading of ["NEW GOVERNMENT VACANCY 2026", "IMPORTANT DATES", "VACANCY DETAILS", "EDUCATIONAL QUALIFICATION",
        "PHYSICAL STANDARDS", "AGE LIMIT", "AGE RELAXATION", "APPLICATION FEES", "SELECTION PROCESS", "SALARY / PAY SCALE",
        "ELIGIBILITY SUMMARY", "DOCUMENTS REQUIRED", "HOW TO APPLY", "IMPORTANT NOTE", "APPLY NOW"]) {
        assert.ok(text.includes(`*${heading}*`), heading);
    }
    assert.deepEqual(urlsIn(text), ["https://epsc.example.gov.in/recruitment/apply"], "the only URL is the official apply link");
    assert.ok(text.trimEnd().endsWith("https://epsc.example.gov.in/recruitment/apply"));
    assert.match(text, /🏢 \*Organization:\* Example Public Service Commission \(EPSC\)/);
    assert.match(text, /🔢 \*Advertisement No\.:\* 07\/2026\n/);
    assert.match(text, /🔴 Last Date to Apply: 19\/11\/2026\n/);
    assert.match(text, /📝 Exam Date: As per Schedule \(tentative \/ not yet announced\)/);
    assert.match(text, /• Assistant \(Accounts\): UR 30 \| EWS 07 \| OBC 18 \| SC 14 \| ST 01 \| Total 70/);
    assert.match(text, /\*APPLICATION FEES\* \(tentative\)/);
    assert.match(text, /Complete One Time Registration \(OTR\)/);
    assert.ok(!/Read the Notification|SarkariResult|sarkariresult/i.test(text.replace("compiled from a recruitment news page", "")), "no boilerplate or aggregator text");
});

test("missing fields say 'Could not verify' instead of inventing values", () => {
    const text = formatNotification(model());
    assert.match(text, new RegExp(`🏆 \\*SELECTION PROCESS\\*\\n${UNVERIFIED}`));
    assert.match(text, new RegExp(`💵 \\*SALARY / PAY SCALE\\*\\n${UNVERIFIED}`));
    assert.match(text, new RegExp(`📍 \\*Job Location:\\* ${UNVERIFIED}`));
    assert.match(text, /Category-wise relaxation \(SC\/ST\/OBC\/EWS\/PwBD\): Could not verify/);
    assert.ok(!/5 years|3 years|10 years/i.test(text), "no standard relaxation rules assumed");
});

test("✔ marks only appear for values found in the notification", () => {
    const plain = formatNotification(model());
    assert.ok(!plain.includes("✔"));
    const checked = formatNotification(model({
        notificationCheck: { status: "checked", official: true, host: "epsc.example.gov.in", matches: { lastDate: true, start: false, totalPosts: true } },
    }));
    assert.match(checked, /🔴 Last Date to Apply: 19\/11\/2026 ✔/);
    assert.match(checked, /🟢 Application Start: 20\/10\/2026\n/);
    assert.match(checked, /👥 \*Total Vacancies:\* 120 ✔/);
    assert.match(checked, /found in the official notification PDF \(epsc\.example\.gov\.in\): last date, total vacancies/);
});

test("conflicting dates are flagged", () => {
    assert.equal(applicationDatesConflict({ start: false, lastDate: false, fees: true }), true);
    assert.equal(applicationDatesConflict({ start: true, lastDate: false }), false);
    const text = formatNotification(model({
        notificationCheck: { status: "checked", official: false, host: "copy.example.org", matches: { start: false, lastDate: false } },
    }));
    assert.match(text, /⚠️ CONFLICT: the application dates shown here were NOT found in the copy of the notification PDF/);
});

test("closed and upcoming applications are labelled; links are annotated", () => {
    const closed = formatNotification(model({ today: new Date(2026, 11, 1) }));
    assert.match(closed, /Applications are CLOSED/);
    const upcoming = formatNotification(model({ today: new Date(2026, 9, 1) }));
    assert.match(upcoming, /Applications have NOT opened yet/);
    assert.match(upcoming, /1\. Wait until the application window opens on 20\/10\/2026/);
    const broken = formatNotification(model({ linkCheck: { reachable: false, status: 404 } }));
    assert.match(broken, /⚠️ The link returned HTTP 404/);
});

test("no verified apply link -> clearly marked unavailable, no URL", () => {
    const article = parseArticle(jobHtml);
    article.links = article.links.filter(l => l.label !== "Apply Online");
    const text = formatNotification(model({ article }));
    assert.match(text, /🚀 \*APPLY NOW\*\nOfficial link not available — check the official notification \/ website before applying\./);
    assert.deepEqual(urlsIn(text), []);
});

test("admit cards use their own template and are not called vacancies", () => {
    const m = model({ article: parseArticle(admitHtml), taskName: "admitCard" });
    const text = formatNotification(m);
    assert.match(text, /^🎫 \*ADMIT CARD RELEASED\*/);
    assert.ok(!/VACANCY/.test(text));
    assert.match(text, /📝 Exam Date: 05\/11\/2026/);
    assert.match(text, /📥 \*DOWNLOAD ADMIT CARD\*\nhttps:\/\/eprb\.example\.nic\.in\/admitcard$/);
    assert.ok(!/Last Date to Apply/.test(text), "application dates are not shown for admit cards");
});

test("results and admissions have their own headings", () => {
    const article = parseArticle(admitHtml);
    assert.match(formatNotification(model({ article, taskName: "result" })), /^🏆 \*RESULT DECLARED\*/);
    assert.match(formatNotification(model({ article: parseArticle(jobHtml), taskName: "admission" })), /^🎓 \*ADMISSION \/ ONLINE FORM\*/);
});

test("splitMessage keeps short messages whole", () => {
    assert.deepEqual(splitMessage("short", { label: "x" }), ["short"]);
});

test("long messages are split into labelled parts; URL intact in the last part", () => {
    const m = model();
    m.eligibility = Array.from({ length: 40 }, (_, i) => ({ posts: [`Post ${i}`], lines: ["Bachelor Degree in a relevant subject with two years of experience in the field. ".repeat(2).trim()], physical: [] }));
    const text = formatNotification(m);
    assert.ok(text.length > MAX_PART_CHARS);

    const parts = splitMessage(text, { label: m.title });
    assert.ok(parts.length >= 2);
    for (const part of parts) assert.ok(part.length <= MAX_PART_CHARS, `part length ${part.length}`);
    assert.match(parts[0], /\(Part 1\/\d\)_$/);
    parts.slice(1).forEach((p, i) => assert.match(p, new RegExp(`— Part ${i + 2}/${parts.length}\\n`)));
    const last = parts.at(-1);
    assert.match(last, /🚀 \*APPLY NOW\*\nhttps:\/\/epsc\.example\.gov\.in\/recruitment\/apply/);
    assert.deepEqual(parts.flatMap(urlsIn), ["https://epsc.example.gov.in/recruitment/apply"], "the URL appears once and unbroken");
    // Nothing lost: every eligibility line is in some part.
    for (let i = 0; i < 40; i++) assert.ok(parts.some(p => p.includes(`*Post ${i}:*`)), `Post ${i}`);
});

// --- Collection with mocked network + cache -------------------------------------

function sources(overrides = {}) {
    const calls = { page: 0, pdf: 0, probe: 0 };
    return {
        calls,
        fetchPage: async () => { calls.page++; return jobHtml; },
        fetchBinary: async () => { calls.pdf++; return makePdf(NOTICE_TEXT); },
        probe: async () => { calls.probe++; return 200; },
        log: silent,
        today: TODAY,
        ...overrides,
    };
}

test("collectNotification builds a verified message from mocked sources", async () => {
    const s = sources();
    const { model: m, parts } = await collectNotification({ url: "https://www.sarkariresult.com/x/" }, "latestJob", s);
    assert.equal(m.notification.status, "checked");
    assert.equal(m.notification.matches.lastDate, true);
    assert.equal(m.apply.reachable, true);
    assert.equal(parts.length, 1);
    assert.match(parts[0], /🔴 Last Date to Apply: 19\/11\/2026 ✔/);
    assert.match(parts[0], /found in the official notification PDF \(epsc\.example\.gov\.in\)/);
    assert.equal(m.sources.notification, "https://epsc.example.gov.in/docs/advt-07-2026.pdf");
    assert.equal(m.sources.apply, "https://epsc.example.gov.in/recruitment/apply");
    assert.ok(m.sources.checkedAt);
});

test("cache avoids refetching the post, PDF and link", async () => {
    const store = openStore(path.join(tempDir(), "jobs.db"));
    const s = sources({ cache: store });
    await collectNotification({ url: "https://www.sarkariresult.com/x/" }, "latestJob", s);
    await collectNotification({ url: "https://www.sarkariresult.com/x/" }, "latestJob", s);
    assert.deepEqual(s.calls, { page: 1, pdf: 1, probe: 1 });
    assert.equal(store.cacheGet("article:https://www.sarkariresult.com/x/", 1000, Date.now() + 2000), undefined, "expired entries are ignored");
    store.close();
});

test("failing PDF and link checks lower verification but do not fail the message", async () => {
    const s = sources({
        fetchBinary: async () => { throw new Error("ECONNRESET"); },
        probe: async () => { throw new Error("ETIMEDOUT"); },
    });
    const { model: m, parts } = await collectNotification({ url: "u" }, "latestJob", s);
    assert.equal(m.notification.status, "unreachable");
    assert.equal(m.apply.reachable, null);
    assert.match(parts[0], /could not be downloaded, so details were not cross-checked/);
    assert.match(parts[0], /could not be reached when checked/);
});

test("a post page that cannot be fetched throws (so the hourly check retries it later)", async () => {
    await assert.rejects(collectNotification({ url: "u" }, "latestJob", sources({ fetchPage: async () => { throw new Error("HTTP 503"); } })), /503/);
    await assert.rejects(collectNotification({ url: "u" }, "latestJob", sources({ fetchPage: async () => "<html></html>" })), /no post details/);
});

test("answer key dates are not mistaken for result dates", () => {
    const d = classifyDates(["CBT Exam Date : 21/09/2026", "Answer key Available : 25/09/2026", "Result Available : 24/10/2026", "Skill Test Date : 01/11/2026"]);
    assert.deepEqual(d.answerKey.date, new Date(2026, 8, 25));
    assert.deepEqual(d.result.date, new Date(2026, 9, 24));
    assert.deepEqual(d.exam.date, new Date(2026, 8, 21));
    assert.deepEqual(d.others.map(o => o.label), ["Skill Test Date"]);
});

test("result/admit card notes only mention fields the message shows", () => {
    const m = model({
        article: parseArticle(admitHtml), taskName: "result",
        notificationCheck: { status: "checked", official: true, host: "eprb.example.nic.in", matches: { start: true, lastDate: false, exam: true } },
    });
    const text = formatNotification(m);
    assert.match(text, /found in the official notification PDF \(eprb\.example\.nic\.in\): exam date\./);
    assert.ok(!/application start|last date|CONFLICT/.test(text));
    assert.match(text, /confirm everything in the official notification on the official website\./);
});

test("post counts that are not numbers are shown as not yet published", () => {
    const m = model();
    m.posts = [{ name: "Post A", total: "Soon", eligibility: [], pay: null }, { name: "Post B", total: "12", eligibility: [], pay: null }];
    const text = formatNotification(m);
    assert.match(text, /• Post A: count not yet published \(“Soon”\)/);
    assert.match(text, /• Post B: 12\n/);
});

test("non-numeric ages (e.g. 'NA') are not put into the eligibility summary", () => {
    const m = model();
    m.age = { ...m.age, min: "NA", max: "27 Years" };
    const text = formatNotification(m);
    assert.match(text, /• Minimum Age: NA\n/, "published value shown as is");
    assert.match(text, /aged up to 27 Years as on 01\/07\/2026 \(before relaxation\)/);
    assert.ok(!/NA–/.test(text));
});
