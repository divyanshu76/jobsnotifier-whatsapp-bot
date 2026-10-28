import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { test } from "node:test";
import cron from "node-cron";
import { DisconnectReason } from "@whiskeysockets/baileys";

import { EXIT, HOURLY_SCHEDULE, isValidGroupId, loadConfig, maskGroupId } from "../src/config.js";
import { fetchHtml, isRetryable } from "../src/http.js";
import { acquireLock } from "../src/lock.js";
import { createLogger, rotateIfNeeded } from "../src/logger.js";
import { closeDecision } from "../src/whatsapp/client.js";
import { decideRestart } from "../scripts/supervisor.js";
import { tempDir } from "./helpers.js";

// --- HTTP retries -----------------------------------------------------------

const httpError = status => Object.assign(new Error(`HTTP ${status}`), { response: { status } });
const networkError = () => Object.assign(new Error("ECONNRESET"), { code: "ECONNRESET" });

test("fetchHtml retries transient failures and then succeeds", async () => {
    let calls = 0;
    const waits = [];
    const html = await fetchHtml("https://x", {
        get: async (_, opts) => {
            assert.equal(opts.timeout, 30_000);
            calls++;
            if (calls === 1) throw networkError();
            if (calls === 2) throw httpError(503);
            return { data: "<html>ok</html>" };
        },
        wait: async ms => waits.push(ms),
    });
    assert.equal(html, "<html>ok</html>");
    assert.equal(calls, 3);
    assert.deepEqual(waits, [2000, 4000]);
});

test("fetchHtml gives up after a bounded number of retries", async () => {
    let calls = 0;
    await assert.rejects(
        fetchHtml("https://x", { retries: 3, get: async () => { calls++; throw networkError(); }, wait: async () => {} }),
        /GET https:\/\/x failed: ECONNRESET/,
    );
    assert.equal(calls, 4);
});

test("fetchHtml does not retry a 404", async () => {
    let calls = 0;
    await assert.rejects(
        fetchHtml("https://x", { get: async () => { calls++; throw httpError(404); }, wait: async () => {} }),
        /HTTP 404/,
    );
    assert.equal(calls, 1);
});

test("isRetryable classifies errors", () => {
    assert.equal(isRetryable(networkError()), true);
    assert.equal(isRetryable(httpError(429)), true);
    assert.equal(isRetryable(httpError(500)), true);
    assert.equal(isRetryable(httpError(403)), false);
});

// --- Scheduler --------------------------------------------------------------

test("schedule is every 30 minutes (minute 0 and 30) in local time", () => {
    assert.equal(HOURLY_SCHEDULE, "*/30 * * * *");
    assert.equal(cron.validate(HOURLY_SCHEDULE), true);

    const task = cron.createTask(HOURLY_SCHEDULE, () => {}, { noOverlap: true });
    const runs = task.getNextRuns(5);
    task.destroy();

    assert.equal(runs.length, 5);
    for (const date of runs) {
        assert.ok([0, 30].includes(date.getMinutes()), `minute ${date.getMinutes()}`);
        assert.equal(date.getSeconds(), 0);
    }
    for (let i = 1; i < runs.length; i++) assert.equal(runs[i] - runs[i - 1], 30 * 60_000);
    assert.ok(runs[0] - Date.now() <= 30 * 60_000);
});

// --- WhatsApp reconnect policy ---------------------------------------------

test("logged-out / forbidden sessions stop instead of reconnecting", () => {
    assert.equal(closeDecision(DisconnectReason.loggedOut, 0).action, "auth-required");
    assert.equal(closeDecision(DisconnectReason.forbidden, 0).action, "auth-required");
    assert.equal(closeDecision(DisconnectReason.connectionReplaced, 0).action, "replaced");
});

test("transient disconnects reconnect with capped exponential backoff", () => {
    assert.deepEqual(closeDecision(DisconnectReason.restartRequired, 3), { action: "reconnect", delayMs: 0 });
    assert.equal(closeDecision(DisconnectReason.connectionLost, 0).delayMs, 5_000);
    assert.equal(closeDecision(DisconnectReason.connectionLost, 2).delayMs, 20_000);
    assert.equal(closeDecision(undefined, 20).delayMs, 5 * 60_000);
});

// --- Supervisor restart policy ---------------------------------------------

test("supervisor does not restart on exits a restart cannot fix", () => {
    for (const code of [EXIT.OK, EXIT.CONFIG, EXIT.LOCKED, EXIT.AUTH_REQUIRED, EXIT.SESSION_REPLACED]) {
        assert.equal(decideRestart(code, []).restart, false, `code ${code}`);
    }
});

test("supervisor restarts crashes with backoff and gives up after 10 per hour", () => {
    const now = Date.now();
    assert.deepEqual(decideRestart(1, [], now), { restart: true, delayMs: 10_000 });
    assert.equal(decideRestart(1, [now - 1000, now - 2000], now).delayMs, 40_000);
    assert.equal(decideRestart(1, Array(9).fill(now - 1000), now).delayMs, 10 * 60_000);
    assert.equal(decideRestart(1, Array(10).fill(now - 1000), now).restart, false);
    assert.equal(decideRestart(1, Array(10).fill(now - 2 * 60 * 60_000), now).restart, true, "old crashes are forgotten");
});

// --- Single-instance lock ---------------------------------------------------

test("lock allows only one live owner and takes over stale locks", async () => {
    const file = path.join(tempDir(), "bot.lock");
    const release = acquireLock(file);
    assert.ok(release);
    assert.equal(acquireLock(file), null, "second acquire fails while the first holds it");
    release();
    assert.equal(fs.existsSync(file), false);

    // A lock left by a process that has exited is reclaimed.
    const child = spawn(process.execPath, ["-e", ""]);
    await new Promise(r => child.on("exit", r));
    fs.writeFileSync(file, String(child.pid));
    const again = acquireLock(file);
    assert.ok(again);
    again();
});

// --- Config & logging -------------------------------------------------------

test("group id validation and masking", () => {
    assert.equal(isValidGroupId("120363012345678901@g.us"), true);
    assert.equal(isValidGroupId("919876543210-1600000000@g.us"), true);
    assert.equal(isValidGroupId("919876543210@s.whatsapp.net"), false);
    assert.equal(isValidGroupId(""), false);
    assert.equal(maskGroupId("120363012345678901@g.us"), "1203…901@g.us");
});

test("config defaults match the original scraper limits and project-relative folders", () => {
    const config = loadConfig({});
    assert.deepEqual(config.limits, { admitCard: 3, result: 3, admission: 3, latestJob: 2 });
    assert.equal(config.dryRun, false);
    assert.equal(path.basename(config.authDir), "auth");
    assert.ok(path.isAbsolute(config.authDir));
    assert.equal(loadConfig({ DRY_RUN: "true" }).dryRun, true);
});

test("log files rotate by size and keep a bounded number of files", () => {
    const dir = tempDir();
    const file = path.join(dir, "bot.log");
    const log = createLogger({ file, maxBytes: 200, keep: 2, toConsole: false });
    for (let i = 0; i < 50; i++) log.info(`line ${i} ${"x".repeat(20)}`);
    const files = fs.readdirSync(dir).sort();
    assert.deepEqual(files, ["bot.log", "bot.log.1", "bot.log.2"]);
    for (const f of files) assert.ok(fs.statSync(path.join(dir, f)).size < 260);
    rotateIfNeeded(path.join(dir, "missing.log"), 1, 1); // no throw
});
