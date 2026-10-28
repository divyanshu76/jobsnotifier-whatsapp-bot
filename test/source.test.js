import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { test } from "node:test";

import { loadConfig } from "../src/config.js";
import { NOT_ON_SOURCE, formatCompact, warningsFor } from "../src/source/compact.js";
import { SOURCE_HOME, collectFromSource, createSourceTasks } from "../src/source/index.js";
import { buildSourceModel, parseHomeSection, parseSourceArticle } from "../src/source/parse.js";
import { SourceBlockedError, fetchSourcePage, toSourceUrl } from "../src/source/site.js";
import { silentLogger } from "../src/logger.js";
import { itemKey, runCycle } from "../src/runner.js";
import { openStore } from "../src/store.js";
import { mockSender, tempDir } from "./helpers.js";

const home = fs.readFileSync(new URL("./fixtures/cm-home.html", import.meta.url), "utf8");
const articleHtml = fs.readFileSync(new URL("./fixtures/cm-article.html", import.meta.url), "utf8");
const TODAY = new Date(2026, 9, 26);
const LIMITS = { admitCard: 3, result: 3, admission: 3, latestJob: 2 };
const ARTICLE_URL = "https://sarkariresult.com.cm/example-assistant-2026/";

const model = (overrides = {}) => buildSourceModel(parseSourceArticle(articleHtml), { taskName: "latestJob", sourceUrl: ARTICLE_URL, today: TODAY, ...overrides });
const urlsIn = text => text.match(/https?:\/\/\S+/g) ?? [];

// --- Hostname rules -----------------------------------------------------------------

test("only the exact host sarkariresult.com.cm is accepted (http upgraded to https)", () => {
    assert.equal(toSourceUrl("https://sarkariresult.com.cm/x/"), "https://sarkariresult.com.cm/x/");
    assert.equal(toSourceUrl("http://sarkariresult.com.cm/x/#top"), "https://sarkariresult.com.cm/x/");
    assert.equal(toSourceUrl("/relative-post/"), "https://sarkariresult.com.cm/relative-post/");
    assert.equal(toSourceUrl("https://SarkariResult.com.cm/x/"), "https://sarkariresult.com.cm/x/");
});

test("look-alike, deceptive and other hosts are rejected", () => {
    for (const url of [
        "https://www.sarkariresult.com/2026/x/",
        "https://sarkariresult.com/x/",
        "https://www.sarkariresult.com.cm/x/",
        "https://sarkariresult.com.cm./x/",
        "https://sarkariresult.com.cm.evil.example/x/",
        "https://evil-sarkariresult.com.cm/x/",
        "https://sarkariresuIt.com.cm/x/",
        "https://xn--sarkariresult-9ib.com.cm/x/",
        "https://sarkariresult.com.cm@evil.example/x/",
        "https://user:pass@sarkariresult.com.cm/x/",
        "https://sarkariresult.com.cm:8443/x/",
        "ftp://sarkariresult.com.cm/x/",
        "javascript:alert(1)",
        "https://www.freejobalert.com/x/",
        "not a url",
    ]) {
        assert.equal(toSourceUrl(url, "https://example.invalid/"), null, url);
    }
});

// --- Strict fetcher ---------------------------------------------------------------------

const response = (status, data = "", location) => ({ status, data, headers: location ? { location } : {} });

test("the fetcher never requests a URL outside the permitted host", async () => {
    let calls = 0;
    const get = async () => { calls++; return response(200, "ok"); };
    await assert.rejects(fetchSourcePage("https://www.sarkariresult.com/", { get }), SourceBlockedError);
    await assert.rejects(fetchSourcePage("https://www.freejobalert.com/", { get }), SourceBlockedError);
    assert.equal(calls, 0);
});

test("redirects are followed only while they stay on the permitted host", async () => {
    const seen = [];
    const get = async (url, options) => {
        seen.push(url);
        assert.equal(options.maxRedirects, 0, "automatic redirects are disabled");
        if (url.endsWith("/old/")) return response(301, "", "http://sarkariresult.com.cm/new/");
        return response(200, "<html>new</html>");
    };
    assert.equal(await fetchSourcePage("https://sarkariresult.com.cm/old/", { get }), "<html>new</html>");
    assert.deepEqual(seen, ["https://sarkariresult.com.cm/old/", "https://sarkariresult.com.cm/new/"]);
});

test("a redirect to an external or deceptive domain is refused and not followed", async () => {
    for (const target of ["https://www.freejobalert.com/job/", "https://sarkariresult.com.cm.evil.example/", "//evil.example/x"]) {
        const seen = [];
        const get = async url => { seen.push(url); return response(302, "", target); };
        await assert.rejects(fetchSourcePage("https://sarkariresult.com.cm/x/", { get, wait: async () => {} }), SourceBlockedError, target);
        assert.equal(seen.length, 1, `${target} must not be requested`);
    }
});

test("network failures are retried a bounded number of times, with no fallback site", async () => {
    const seen = [];
    const get = async url => { seen.push(url); throw Object.assign(new Error("ECONNRESET"), { code: "ECONNRESET" }); };
    await assert.rejects(fetchSourcePage("https://sarkariresult.com.cm/", { get, retries: 2, wait: async () => {} }), /ECONNRESET/);
    assert.equal(seen.length, 3);
    assert.ok(seen.every(u => u === "https://sarkariresult.com.cm/"));
});

// --- Parsing --------------------------------------------------------------------------

test("homepage blocks keep only links on the permitted host", () => {
    assert.deepEqual(parseHomeSection(home, "Latest Jobs", 5).map(i => i.url), [
        "https://sarkariresult.com.cm/example-assistant-2026/",
        "https://sarkariresult.com.cm/example-clerk-2026/",
    ]);
    assert.deepEqual(parseHomeSection(home, "Admit Cards", 5).map(i => i.url), ["https://sarkariresult.com.cm/example-admit-card-2026/"]);
    assert.equal(parseHomeSection(home, "Latest Jobs", 1).length, 1, "limit applies");
});

test("article fields come from the page; filler, FAQ and related posts are ignored", () => {
    const m = model();
    assert.equal(m.title, "Example Assistant Online Form 2026 (120 Posts)");
    assert.equal(m.titleStatus, "Start");
    assert.equal(m.organization, "Example Public Service Commission (EPSC)");
    assert.equal(m.totalPosts, 120);
    assert.deepEqual(m.categoryVacancies, [
        { category: "General", count: "51" }, { category: "EWS", count: "12" }, { category: "OBC", count: "31" },
        { category: "SC", count: "24" }, { category: "ST", count: "02" },
    ]);
    assert.deepEqual(m.dates.start.date, new Date(2026, 9, 20));
    assert.deepEqual(m.dates.lastDate.date, new Date(2026, 10, 19));
    assert.equal(m.dates.exam.text, "Notify Later");
    assert.equal(m.status, "open");
    assert.deepEqual(m.qualification, { lines: ["Bachelor Degree in Commerce.", "Bachelor Degree in Any Stream."], postWise: true }, "deduplicated, no filler; page says eligibility is post-wise");
    assert.deepEqual(m.age.limits, ["Minimum Age : 21 Years", "Maximum Age : 40 Years"]);
    assert.deepEqual(m.age.referenceDate, new Date(2026, 6, 1));
    assert.deepEqual(m.fees.items.map(f => [f.label, f.value]), [["General / OBC / EWS", "₹500/-"], ["SC / ST", "₹250/-"]]);
    assert.deepEqual(m.fees.notes, ["Fee Refund : SC / ST : Rs. 200/- will be refunded after the exam."]);
    assert.deepEqual(m.selection, ["Written Exam", "Interview", "Document Verification"]);
    assert.equal(m.salary, null);
    assert.equal(JSON.stringify(m).includes("99 years"), false, "FAQ text is not used");
});

test("links: the external apply URL is kept as a reference; social and source links are not", () => {
    const m = model();
    assert.equal(m.links.primary, "https://epsc.example.gov.in/apply");
    assert.equal(m.links.notification, "https://epsc.example.gov.in/notice.pdf");
    assert.equal(m.links.officialWebsite, "https://epsc.example.gov.in/");
    assert.equal(m.sources.article, ARTICLE_URL, "article URL kept internally");
});

test("a page with only a social link or a source-site link has no application link", () => {
    const html = articleHtml.replace("https://epsc.example.gov.in/apply", "https://t.me/somechannel");
    assert.equal(buildSourceModel(parseSourceArticle(html), { taskName: "latestJob", sourceUrl: ARTICLE_URL }).links.primary, null);
    const html2 = articleHtml.replace("https://epsc.example.gov.in/apply", "https://sarkariresult.com.cm/apply/");
    assert.equal(buildSourceModel(parseSourceArticle(html2), { taskName: "latestJob", sourceUrl: ARTICLE_URL }).links.primary, null);
});

// --- Compact message ----------------------------------------------------------------

test("compact vacancy message: required fields, apply link last, nothing else linked", () => {
    const [text] = formatCompact(model(), TODAY);
    assert.match(text, /^📢 \*Example Assistant Online Form 2026 \(120 Posts\)\*\n🏢 Example Public Service Commission \(EPSC\)/);
    assert.match(text, /👥 \*Total Vacancies:\* 120\n• General 51 \| EWS 12 \| OBC 31 \| SC 24 \| ST 02/);
    assert.match(text, /📌 \*Status:\* 🟢 Applications open/);
    assert.match(text, /• Start: 20\/10\/2026\n• Last Date: 19\/11\/2026\n• Fee Last Date: 21\/11\/2026\n• Exam: Notify Later/);
    assert.match(text, /🎂 \*Age Limit\* \(as on 01\/07\/2026\)\n• Minimum Age: 21 Years\n• Maximum Age: 40 Years\n• Relaxation: EPSC provides/);
    assert.match(text, /🏆 \*Selection:\* Written Exam → Interview → Document Verification/);
    assert.ok(!/Salary/.test(text), "salary omitted when not provided");
    assert.deepEqual(urlsIn(text), ["https://epsc.example.gov.in/apply"], "only the application URL appears");
    assert.ok(text.endsWith("🚀 *APPLY NOW*\nhttps://epsc.example.gov.in/apply"));
    assert.ok(!/how to fill|click here link|found in the|cross-checked|recruitment news page|✔/i.test(text), "no generic instructions or verification reports");
});

test("missing fields are reported, never invented", () => {
    const bare = parseSourceArticle("<html><body><main class='site-main'><h2>Bare Post 2026</h2></main></body></html>");
    const m = buildSourceModel(bare, { taskName: "latestJob", sourceUrl: "https://sarkariresult.com.cm/bare/", today: TODAY });
    const [text] = formatCompact(m, TODAY);
    assert.match(text, new RegExp(`Total Vacancies:\\* ${NOT_ON_SOURCE}`));
    assert.match(text, new RegExp(`Qualification:\\* ${NOT_ON_SOURCE}`));
    assert.match(text, new RegExp(`Age Limit:\\* ${NOT_ON_SOURCE}`));
    assert.match(text, new RegExp(`Application Fee:\\* ${NOT_ON_SOURCE}`));
    assert.match(text, /⚠️ not given on the source website: last date, qualification, fees, age limit, application link/);
    assert.match(text, /🚀 \*APPLY NOW\*\nApplication link not given on the source website/);
    assert.deepEqual(urlsIn(text), []);
    assert.equal(m.organization, null);
});

test("contradictory dates get a short warning", () => {
    const m = model();
    m.dates.lastDate = { label: "Last", text: "01/10/2026", date: new Date(2026, 9, 1) };
    m.titleStatus = "Last Date Today";
    const w = warningsFor(m, TODAY);
    assert.ok(w.includes("last date is before the start date"));
    assert.ok(w.some(x => /title says "Last Date Today" but the last date is 01\/10\/2026/.test(x)));
});

test("admit cards, results, answer keys and admissions use separate templates", () => {
    const admit = buildSourceModel(parseSourceArticle(articleHtml), { taskName: "admitCard", sourceUrl: ARTICLE_URL, today: TODAY });
    const [a] = formatCompact(admit, TODAY);
    assert.match(a, /^🎫 /);
    assert.match(a, /📥 \*DOWNLOAD ADMIT CARD\*\nDownload link not given on the source website\./);
    assert.ok(!/Vacanc/.test(a));

    const keyHtml = articleHtml.replace("Example Assistant Online Form 2026 (120 Posts) – Start", "Example Board Answer Key 2026 – Out");
    const [k] = formatCompact(buildSourceModel(parseSourceArticle(keyHtml), { taskName: "result", sourceUrl: ARTICLE_URL, today: TODAY }), TODAY);
    assert.match(k, /^🔑 \*Example Board Answer Key 2026\*/);
    assert.match(k, /📥 \*CHECK ANSWER KEY\*/);

    const [adm] = formatCompact(buildSourceModel(parseSourceArticle(articleHtml), { taskName: "admission", sourceUrl: ARTICLE_URL, today: TODAY }), TODAY);
    assert.match(adm, /^🎓 /);
    assert.match(adm, /🚀 \*APPLY NOW\*\nhttps:\/\/epsc\.example\.gov\.in\/apply$/);
});

// --- Collection and hourly cycle --------------------------------------------------

test("collectFromSource only ever requests the permitted host; external links are never fetched", async () => {
    const requested = [];
    const fetchPage = async url => { requested.push(url); return articleHtml; };
    const { parts } = await collectFromSource({ url: "http://sarkariresult.com.cm/example-assistant-2026/" }, "latestJob", { fetchPage, today: TODAY });
    assert.deepEqual(requested, [ARTICLE_URL]);
    assert.match(parts[0], /https:\/\/epsc\.example\.gov\.in\/apply/);

    await assert.rejects(collectFromSource({ url: "https://www.sarkariresult.com/2026/x/" }, "latestJob", { fetchPage }), SourceBlockedError);
    assert.equal(requested.length, 1, "blocked URL was not requested");
});

test("hourly cycle in compact mode: source host only, dedup intact, no fallback when the site is down", async () => {
    const store = openStore(path.join(tempDir(), "jobs.db"));
    const requested = [];
    const fetchPage = async url => {
        requested.push(url);
        return url === SOURCE_HOME ? home : articleHtml;
    };
    const tasks = createSourceTasks(LIMITS, { fetchPage, cache: store });
    const run = (sender, extra = {}) => runCycle({ tasks, fetchPage, store, sender, log: silentLogger, sendDelayMs: 0, wait: async () => {}, homepageUrl: SOURCE_HOME, ...extra });

    const sender = mockSender();
    const first = await run(sender);
    assert.equal(first.sent, 5);
    assert.ok(requested.every(u => new URL(u).hostname === "sarkariresult.com.cm"), requested.join("\n"));
    assert.equal(store.get(itemKey("latestJob", "https://sarkariresult.com.cm/example-assistant-2026/")).status, "sent");

    const second = await run(sender);
    assert.equal(second.sent, 0);
    assert.equal(second.alreadyHandled, 5);

    const down = async url => { requested.push(url); throw new Error("site down"); };
    const before = requested.length;
    await assert.rejects(run(mockSender(), { fetchPage: down }), /site down/);
    assert.deepEqual(requested.slice(before), [SOURCE_HOME], "no other site is tried");
    store.close();
});

test("MESSAGE_FORMAT: compact (default) and detailed; anything else falls back to compact", () => {
    assert.equal(loadConfig({ MESSAGE_FORMAT: "compact" }).messageFormat, "compact");
    assert.equal(loadConfig({ MESSAGE_FORMAT: "detailed" }).messageFormat, "detailed");
    assert.equal(loadConfig({}).messageFormat, "compact");
    assert.equal(loadConfig({ MESSAGE_FORMAT: "classic" }).messageFormat, "compact");
});

test("7 new notifications -> 7 separate send operations, one notification each, no combining", async () => {
    const store = openStore(path.join(tempDir(), "jobs.db"));
    const posts = {
        admitCard: ["a1", "a2"], latestJob: ["j1", "j2"], result: ["r1", "r2"], admission: ["m1"],
    };
    const heading = { admitCard: "Admit Cards", latestJob: "Latest Jobs", result: "Results", admission: "Admission" };
    const homeHtml = `<main>${Object.entries(posts).map(([type, slugs]) => `
        <div><p class="gb-headline">${heading[type]}</p><ul class="wp-block-latest-posts">
        ${slugs.map(s => `<li><a href="https://sarkariresult.com.cm/post-${s}/">Post ${s}</a></li>`).join("")}</ul></div>`).join("")}</main>`;
    // Each article has its own title and its own application link.
    const fetchPage = async url => {
        if (url === SOURCE_HOME) return homeHtml;
        const slug = url.match(/post-(\w+)/)[1];
        const linkLabel = slug.startsWith("a") ? "Download Admit Card" : slug.startsWith("r") ? "Check Result" : "Apply Online";
        return articleHtml
            .replace("Example Assistant Online Form 2026 (120 Posts) – Start", `Notification ${slug.toUpperCase()} 2026`)
            .replace("<h5>Apply Online</h5>", `<h5>${linkLabel}</h5>`)
            .replaceAll("https://epsc.example.gov.in/apply", `https://board-${slug}.example.gov.in/apply`);
    };
    const tasks = createSourceTasks(LIMITS, { fetchPage, cache: store });
    const sender = mockSender();
    const summary = await runCycle({ tasks, fetchPage, store, sender, log: silentLogger, sendDelayMs: 0, wait: async () => {}, homepageUrl: SOURCE_HOME });

    assert.equal(summary.new, 7);
    assert.equal(summary.sent, 7);
    assert.equal(sender.sent.length, 7, "exactly 7 send operations");
    const slugs = Object.values(posts).flat();
    sender.sent.forEach(message => {
        const titles = slugs.filter(s => message.includes(`Notification ${s.toUpperCase()} 2026`));
        assert.equal(titles.length, 1, `one notification per message:\n${message}`);
        const urls = message.match(/https?:\/\/\S+/g) ?? [];
        assert.deepEqual(urls, [`https://board-${titles[0]}.example.gov.in/apply`], "its own link only, at the end");
        assert.ok(message.trimEnd().endsWith(urls[0]));
        assert.ok(message.length < 4000, "no split needed");
    });
    assert.deepEqual(new Set(sender.sent).size, 7, "no duplicate messages");
    for (const s of slugs) assert.ok(store.isHandled(`${Object.keys(posts).find(t => posts[t].includes(s))}:https://sarkariresult.com.cm/post-${s}/`));
    store.close();
});

test("a single over-long notification is split into parts of that notification only", async () => {
    const store = openStore(path.join(tempDir(), "jobs.db"));
    // Fee exemption notes are shown in full (qualification is condensed), so they make the message long.
    const longFees = Array.from({ length: 10 }, (_, i) => `<li>Fee Exemption rule ${i}: ${"candidates of this category are exempted from paying the fee subject to documents ".repeat(5)}</li>`).join("");
    const longArticle = articleHtml.replace("<li>For SC / ST :₹ 250/-</li>", `<li>For SC / ST :₹ 250/-</li>${longFees}`);
    const homeHtml = `<main><div><p class="gb-headline">Latest Jobs</p><ul class="wp-block-latest-posts">
        <li><a href="https://sarkariresult.com.cm/long/">Long</a></li><li><a href="https://sarkariresult.com.cm/short/">Short</a></li></ul></div></main>`;
    const fetchPage = async url => (url === SOURCE_HOME ? homeHtml : url.includes("long") ? longArticle : articleHtml);
    const sender = mockSender();
    await runCycle({ tasks: createSourceTasks(LIMITS, { fetchPage, cache: store }), fetchPage, store, sender, log: silentLogger, sendDelayMs: 0, wait: async () => {}, homepageUrl: SOURCE_HOME });

    const parts = sender.sent.filter(m => /Part \d\/\d/.test(m));
    assert.ok(parts.length >= 2, "the long notification was split");
    assert.equal(sender.sent.length, parts.length + 1, "the short one is a single, separate message");
    assert.ok(parts.every(p => p.length <= 4000));
    assert.equal(sender.sent.filter(m => m.includes("🚀 *APPLY NOW*")).length, 2, "one Apply Now per notification");
    store.close();
});

test("site status suffixes are removed from titles (kept separately)", () => {
    for (const [raw, status] of [["X Online Form 2026 – Date Extend", "Date Extend"], ["Y Result 2026 – Out", "Out"], ["Z Form 2026 - Last Date Extended", "Last Date Extended"]]) {
        const a = parseSourceArticle(`<main class="site-main"><h2>${raw}</h2></main>`);
        assert.equal(a.displayTitle, raw.replace(/\s+[–-]\s+.*$/, ""));
        assert.equal(a.titleStatus, status);
    }
});
