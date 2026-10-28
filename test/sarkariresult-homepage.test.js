import assert from "node:assert/strict";
import fs from "node:fs";
import { test } from "node:test";

import { SECTIONS, SITE_HOME, parseHomepageSection } from "../src/sarkariresult/homepage.js";

const html = fs.readFileSync(new URL("./fixtures/sr-homepage.html", import.meta.url), "utf8");

test("exports the site home and section names", () => {
    assert.equal(SITE_HOME, "https://www.sarkariresult.com/");
    assert.deepEqual(SECTIONS, ["admitCard", "latestJob", "result", "admission"]);
});

test("latest jobs: entries in page order, limited, relative links resolved", () => {
    assert.deepEqual(parseHomepageSection(html, "latestJob", 3), [
        { title: "Example Department Clerk Online Form 2099 | Last Date : 01/01/2100", url: "https://www.sarkariresult.com/2099/job-one/" },
        { title: "Sample Office Assistant Online Form 2099", url: "https://www.sarkariresult.com/2099/job-two/" },
        { title: "Demo Board Teacher Online Form 2099", url: "https://www.sarkariresult.com/2099/job-three/" },
    ]);
    assert.equal(parseHomepageSection(html, "latestJob", 100).length, 4);
    assert.equal(parseHomepageSection(html, "latestJob", 1).length, 1);
});

test("result: whitespace collapsed, root-relative and external links kept", () => {
    assert.deepEqual(parseHomepageSection(html, "result", 10), [
        { title: "Example Board Result 2099 | Updated", url: "https://www.sarkariresult.com/2099/result-first/" },
        { title: "Sample Commission Result 2099", url: "https://www.sarkariresult.com/2099/result-second/" },
        { title: "Demo Agency Final Result", url: "https://doc.example.org/result-third.pdf" },
    ]);
});

test("admit card: duplicates and entries without a usable link are skipped", () => {
    const entries = parseHomepageSection(html, "admitCard", 10);
    assert.deepEqual(entries.map(e => e.url), [
        "https://www.sarkariresult.com/2099/admit-one/",
        "https://www.sarkariresult.com/2099/admit-two/",
        "https://www.sarkariresult.com/2099/admit-three/",
    ]);
    assert.equal(entries[0].title, "Alpha Exam Admit Card 2099");
    // the limit counts usable entries, not raw list items
    assert.deepEqual(parseHomepageSection(html, "admitCard", 3).map(e => e.url), entries.map(e => e.url));
});

test("admission: picks its own block, not neighbouring answer key / syllabus lists", () => {
    assert.deepEqual(parseHomepageSection(html, "admission", 5), [
        { title: "Example University Admission Online Form 2099", url: "https://www.sarkariresult.com/2099/admission-one/" },
        { title: "Sample Institute Entrance Online Form 2099", url: "http://www.sarkariresult.com/2099/admission-two/" },
    ]);
});

test("limit 0 returns an empty list", () => {
    for (const section of SECTIONS) assert.deepEqual(parseHomepageSection(html, section, 0), []);
});

test("unknown section throws", () => {
    assert.throws(() => parseHomepageSection(html, "answerKey", 3), Error);
    assert.throws(() => parseHomepageSection(html, "", 3), Error);
});

test("page without the section returns an empty list", () => {
    const page = `<html><body>
        <p class="gb-headline"><a href="/answerkey/">Answer Key</a></p>
        <ul class="sarkari-quick-list"><li><a href="/x/">Some Answer Key</a></li></ul>
        <h2>Result</h2><p>No list follows this heading.</p>
    </body></html>`;
    for (const section of SECTIONS) assert.deepEqual(parseHomepageSection(page, section, 5), []);
    assert.deepEqual(parseHomepageSection("", "result", 5), []);
});
