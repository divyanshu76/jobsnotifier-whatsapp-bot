import assert from "node:assert/strict";
import fs from "node:fs";
import { test } from "node:test";

import { POST_WISE_NOTE, formatCompact, qualificationGroups, summarizeQualification } from "../src/source/compact.js";
import { LINK_NOTE, linkPolicy } from "../src/source/linkpolicy.js";
import { buildSourceModel, parseSourceArticle } from "../src/source/parse.js";

const articleHtml = fs.readFileSync(new URL("./fixtures/cm-article.html", import.meta.url), "utf8");
const TODAY = new Date(2026, 9, 26);
const URL_ = "https://sarkariresult.com.cm/example-assistant-2026/";

// --- Qualification summary ---------------------------------------------------------------

const BPSC_LIKE = [
    "Bachelor Degree with 50% Marks and B.Ed Degree OR",
    "Bachelor Degree in Any Stream with Diploma in Elementary Education OR",
    "10+2 Inter with 50% Marks with 2 Year Diploma in Elementary Education OR",
    "Master Degree with 55% Marks and B.Ed – Med 3 Year Degree",
    "CTET Paper I OR BTET Paper I Exam Qualified.",
    "Graduate with 2 Year D.El.Ed OR Graduate with 50% Marks with B.Ed OR Graduate with 45% Marks and B.Ed (NCTE Norms) OR Post Graduate with 55% Marks and 3 Year B.Ed – M.Ed Course.",
    "STET Paper I Exam Passed",
    "STET Paper II Exam Passed",
    "Post Graduate in Related Subject with Minimum 50% Marks and B.Ed Degree",
];

test("short qualification lists are shown exactly as published", () => {
    const lines = ["10+2 Intermediate Exam From Any Recognized Board in India.", "Computer Typing English 30 WPM OR Hindi 25 WPM"];
    assert.deepEqual(summarizeQualification({ lines, postWise: false }), lines);
});

test("'OR' alternatives become one 'Any one of' bullet, never a single mandatory line", () => {
    const groups = qualificationGroups(BPSC_LIKE.slice(0, 4));
    assert.deepEqual(groups, [{ alts: [
        "Bachelor Degree with 50% Marks and B.Ed Degree",
        "Bachelor Degree in Any Stream with Diploma in Elementary Education",
        "10+2 Inter with 50% Marks with 2 Year Diploma in Elementary Education",
        "Master Degree with 55% Marks and B.Ed – Med 3 Year Degree",
    ] }]);
    const [first] = summarizeQualification({ lines: BPSC_LIKE.slice(0, 4), postWise: false });
    assert.match(first, /^Any one of 4 options, e\.g\. Bachelor Degree with 50% Marks and B\.Ed Degree$/);
});

test("long post-wise lists are condensed and say what is not shown", () => {
    const out = summarizeQualification({ lines: BPSC_LIKE, postWise: true });
    assert.ok(out.length <= 5, "at most 4 bullets + the note");
    assert.ok(out.join("\n").length < 700);
    const note = out.at(-1);
    assert.ok(note.startsWith(POST_WISE_NOTE));
    assert.match(note, /\(\d+ more conditions? not shown\)$/);
    for (const line of out.slice(0, -1)) assert.ok(line.length <= 260, line);
});

test("post-wise pages always point to the notification, even when everything fits", () => {
    const out = summarizeQualification({ lines: ["Bachelor Degree in Commerce."], postWise: true });
    assert.deepEqual(out, ["Bachelor Degree in Commerce.", POST_WISE_NOTE]);
});

test("shortened lines end with an ellipsis and keep the original wording", () => {
    const long = `Bachelor Degree in Engineering in Civil, Mechanical or Electrical branch from a recognised university with at least 60% marks and two years of field experience in large projects`;
    const [line, note] = summarizeQualification({ lines: [long], postWise: false });
    assert.ok(line.endsWith("…"));
    assert.ok(long.startsWith(line.slice(0, -1)));
    assert.equal(note, POST_WISE_NOTE, "a shortened requirement always points to the notification");
});

// --- Link policy -----------------------------------------------------------------------

test("government domains and known exam portals are shown without a warning", () => {
    assert.deepEqual(linkPolicy("https://ssc.gov.in/login", "https://ssc.gov.in/"), { show: true, level: "government" });
    assert.deepEqual(linkPolicy("https://uppsc.up.nic.in/x", null), { show: true, level: "government" });
    assert.deepEqual(linkPolicy("https://rrb.digialm.com/EForms/x", "https://indianrailways.gov.in/"), { show: true, level: "exam-portal" });
    assert.deepEqual(linkPolicy("https://ibpsreg.ibps.in/bob/", "https://www.bankofbaroda.in/"), { show: true, level: "exam-portal" });
});

test("a non-government site is only 'listed-site' when it matches the source page's organisation website", () => {
    assert.deepEqual(linkPolicy("https://cotcorp.org.in/result", "https://cotcorp.org.in/"), { show: true, level: "listed-site" });
    assert.deepEqual(linkPolicy("https://www.hgupexam2025.com/login.aspx", "https://uppbpb.gov.in/"), { show: true, level: "unverified" });
    assert.deepEqual(linkPolicy("https://apply.upessc.org/", "https://upessc.up.gov.in/"), { show: true, level: "unverified" });
});

test("links that cannot be safely identified are withheld", () => {
    for (const [url, reason] of [
        ["https://bit.ly/abc", /shortened/],
        ["http://103.20.10.5/result", /raw IP/],
        ["https://xn--80ak6aa92e.com/x", /look-alike/],
        ["https://user:pw@ssc.gov.in/", /login details/],
        ["https://ssc.gov.in:8443/x", /non-standard port/],
        ["https://exam-results.example.com/app.apk", /program or archive/],
        ["https://t.me/channel", /social-media or aggregator/],
        ["ftp://ssc.gov.in/x", /not a web link/],
        ["not a url", /not a valid/],
    ]) {
        const p = linkPolicy(url, null);
        assert.equal(p.show, false, url);
        assert.match(p.reason, reason, url);
    }
});

// --- Link policy in the result / admit-card messages -----------------------------------

const withResultLink = (href, website = "https://epsc.example.gov.in/") => articleHtml
    .replace("Example Assistant Online Form 2026 (120 Posts) – Start", "Example Board Result 2026")
    .replace("<h5>Apply Online</h5>", "<h5>Check Result</h5>")
    .replace("https://epsc.example.gov.in/apply", href)
    .replace(`<a href="https://epsc.example.gov.in/">`, `<a href="${website}">`);

const messageFor = (html, taskName) =>
    formatCompact(buildSourceModel(parseSourceArticle(html), { taskName, sourceUrl: URL_, today: TODAY }), TODAY)[0];

test("result on a government domain: link shown, no label, never called official", () => {
    const text = messageFor(withResultLink("https://results.epsc.example.gov.in/r"), "result");
    assert.match(text, /📥 \*CHECK RESULT\*\nhttps:\/\/results\.epsc\.example\.gov\.in\/r$/);
    assert.ok(!/official link|verified/i.test(text));
});

test("result on an unfamiliar domain: link shown and clearly labelled unverified", () => {
    const text = messageFor(withResultLink("https://www.hgupexam2025.com/login.aspx"), "result");
    assert.ok(text.endsWith(`https://www.hgupexam2025.com/login.aspx\n${LINK_NOTE.unverified}`));
});

test("admit card on a shortener: link withheld with the reason", () => {
    const html = withResultLink("https://bit.ly/admit123").replace("<h5>Check Result</h5>", "<h5>Download Admit Card</h5>");
    const text = messageFor(html, "admitCard");
    assert.match(text, /📥 \*DOWNLOAD ADMIT CARD\*\nLink not shown: it is a shortened link\. Use the organisation's official website instead\.$/);
    assert.ok(!text.includes("bit.ly"));
});

test("non-government site that matches the listed organisation website gets an informational note", () => {
    const text = messageFor(withResultLink("https://exam.cotcorp.org.in/result", "https://cotcorp.org.in/"), "result");
    assert.ok(text.endsWith(`https://exam.cotcorp.org.in/result\n${LINK_NOTE["listed-site"]}`));
});

// --- Security review round 2 -------------------------------------------------------------

test("trailing-dot hosts cannot bypass the shortener / IP / government checks", () => {
    for (const url of ["https://bit.ly./abc", "https://tinyurl.com./x", "https://ssc.gov.in./login", "https://hgupexam2025.com./x"]) {
        const p = linkPolicy(url, null);
        assert.equal(p.show, false, url);
        assert.match(p.reason, /unusual domain format/, url);
    }
});

test("links with hidden characters are withheld; only canonical URLs are accepted", () => {
    for (const url of ["https://ssc.gov.in/\n✅ Official link", "https://ssc.gov.in/\tx", "https://ssc.gov.in/a b", "https://ssc.gov.in/\u202Etxt.exe"]) {
        const p = linkPolicy(url, null);
        assert.equal(p.show, false, JSON.stringify(url));
        assert.match(p.reason, /hidden or invalid characters/);
    }
    assert.equal(linkPolicy("https://SSC.gov.in/login", null).reason, "it is not in canonical form");
});

test("an injected line break in a page link cannot add text to the message", () => {
    const html = articleHtml.replace(
        `<a href="https://epsc.example.gov.in/apply">`,
        `<a href="https://epsc.example.gov.in/apply\n\n✅ OFFICIAL &amp; VERIFIED LINK\n">`,
    );
    const text = messageFor(html, "latestJob");
    assert.ok(!/OFFICIAL & VERIFIED/.test(text), "injected text never appears");
    assert.match(text, /🚀 \*APPLY NOW\*\nApplication link not given on the source website/);
});

test("displayed links are the normalised URL, identical to what the policy checked", () => {
    const html = articleHtml.replace(`<a href="https://epsc.example.gov.in/apply">`, `<a href="  HTTPS://EPSC.Example.GOV.in/apply  ">`);
    const text = messageFor(html, "latestJob");
    assert.ok(text.endsWith("🚀 *APPLY NOW*\nhttps://epsc.example.gov.in/apply"));
});
