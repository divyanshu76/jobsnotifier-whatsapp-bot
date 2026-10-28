import fs from "node:fs";
import path from "node:path";
import cron from "node-cron";

import { EXIT, HOURLY_SCHEDULE, MESSAGE_FORMATS, isValidGroupId, loadConfig, maskGroupId } from "./src/config.js";
import { SOURCE_HOME, createSourceTasks, fetchSourcePage } from "./src/source/index.js";
import { AuthRequiredError, SessionReplacedError } from "./src/errors.js";
import { fetchBinary, fetchHtml, probeUrl } from "./src/http.js";
import { acquireLock, lockOwner } from "./src/lock.js";
import { createLogger, timestamp } from "./src/logger.js";
import { createGuardedRun, runCycle } from "./src/runner.js";
import { SITE_HOME } from "./src/sarkariresult/homepage.js";
import { openStore } from "./src/store.js";
import { createDetailedTasks } from "./src/vacancy/tasks.js";
import { createWhatsAppClient, hasLinkedSession } from "./src/whatsapp/client.js";

// Usage:
//   node index.js              hourly bot (sends to WP_GROUP)
//   node index.js --once       one live check now, then exit
//   node index.js --dry-run    one check, print messages, send nothing, record nothing
//   node index.js --seed       record what is on the site now as "already seen", send nothing
//   node index.js --login      link WhatsApp (shows QR code if needed), then exit
//   node index.js --test-message  send ONE test line to WP_GROUP (job database untouched), then exit

const args = new Set(process.argv.slice(2));
const config = loadConfig();
const mode = args.has("--login") ? "login"
    : args.has("--test-message") ? "test-message"
    : args.has("--seed") ? "seed"
    : args.has("--dry-run") || config.dryRun ? "dry-run"
    : "live";
const once = args.has("--once") || mode !== "live";
// --format=compact|detailed overrides MESSAGE_FORMAT from .env (default: compact).
const formatArg = process.argv.find(a => a.startsWith("--format="))?.split("=")[1];
const messageFormat = MESSAGE_FORMATS.includes(formatArg) ? formatArg : config.messageFormat;

const log = createLogger({ file: path.join(config.logDir, "bot.log") });
const lockFile = path.join(config.dataDir, "bot.lock");

let store = null;
let releaseLock = () => {};
let stopWhatsApp = () => {};
let scheduledTask = null;
let shuttingDown = false;

async function shutdown(code, reason) {
    if (shuttingDown) return;
    shuttingDown = true;
    if (reason) log.info(`Shutting down: ${reason}`);
    try { await scheduledTask?.stop(); } catch { /* ignore */ }
    stopWhatsApp();
    try { store?.close(); } catch { /* ignore */ }
    releaseLock();
    process.exitCode = code;
    // Give the log and Baileys a moment to flush credential writes.
    setTimeout(() => process.exit(code), 1500).unref();
}

process.on("SIGINT", () => shutdown(EXIT.OK, "Ctrl+C"));
process.on("SIGTERM", () => shutdown(EXIT.OK, "SIGTERM"));
process.on("unhandledRejection", err => log.error("Unhandled promise rejection:", err));
process.on("uncaughtException", err => {
    log.error("Uncaught exception:", err);
    shutdown(1);
});

// When started by scripts/supervisor.js (IPC channel), stop cleanly on request and
// exit if the supervisor goes away (e.g. the scheduled task was ended).
const supervised = typeof process.send === "function";
if (supervised) {
    process.on("message", msg => msg === "shutdown" && shutdown(EXIT.OK, "stop requested by supervisor"));
    process.on("disconnect", () => shutdown(EXIT.OK, "supervisor exited"));
}

async function main() {
    log.info(`JobsNotifier starting (mode: ${mode}${once ? ", once" : ", hourly"}, messages: ${messageFormat}, pid ${process.pid})`);

    if (mode !== "dry-run") {
        const release = acquireLock(lockFile);
        if (!release) {
            log.error(`Another JobsNotifier process (pid ${lockOwner(lockFile)}) is already running. Stop it first.`);
            process.exit(EXIT.LOCKED);
        }
        releaseLock = release;
        process.on("exit", release);

        // scripts\stop-bot.ps1 asks for a clean stop by creating this file (Windows has no SIGTERM).
        const stopFile = path.join(config.dataDir, "stop.request");
        fs.rmSync(stopFile, { force: true });
        setInterval(() => {
            if (!fs.existsSync(stopFile)) return;
            fs.rmSync(stopFile, { force: true });
            shutdown(EXIT.OK, "stop requested (stop-bot.ps1)");
        }, 2000).unref();
    }

    if ((mode === "live" || mode === "test-message") && !isValidGroupId(config.wpGroup)) {
        log.error("WP_GROUP is missing or invalid in .env (expected something like 1203630...@g.us). Run `npm run groups` to find it.");
        return shutdown(EXIT.CONFIG);
    }

    store = openStore(path.join(config.dataDir, "jobs.db"));
    if (mode !== "dry-run") {
        const recovered = store.recoverInterrupted();
        if (recovered) log.warn(`${recovered} message(s) were interrupted mid-send last time; marked "uncertain" (not resent). See \`npm run db -- uncertain\`.`);
    }

    // compact: sarkariresult.com.cm is the only website requested (strict fetcher, no PDFs,
    // no link probing). detailed: www.sarkariresult.com posts with notification cross-checks.
    const compact = messageFormat === "compact";
    const fetchPage = compact ? url => fetchSourcePage(url) : url => fetchHtml(url);
    const homepageUrl = compact ? SOURCE_HOME : SITE_HOME;
    const tasks = compact
        ? createSourceTasks(config.limits, { fetchPage, cache: store })
        : createDetailedTasks(config.limits, { fetchPage, fetchBinary, probe: url => probeUrl(url), cache: store, log });
    store.cachePrune(14 * 24 * 60 * 60_000);

    if (mode === "dry-run" || mode === "seed") {
        const summary = await createGuardedRun(
            () => runCycle({ tasks, fetchPage, store, sender: null, log, mode, homepageUrl }),
            log,
        )(mode);
        return shutdown(summary ? EXIT.OK : 1);
    }

    // login / live: connect to WhatsApp.
    const interactive = Boolean(process.stdout.isTTY) && !supervised;
    const allowQr = interactive || mode === "login";
    if (!allowQr && !(await hasLinkedSession(config.authDir))) {
        throw new AuthRequiredError("WhatsApp is not linked yet. Run `npm run login` in a terminal and scan the QR code.");
    }

    const onFatal = err => {
        log.error(err.message);
        shutdown(err instanceof SessionReplacedError ? EXIT.SESSION_REPLACED : EXIT.AUTH_REQUIRED);
    };

    const client = createWhatsAppClient({ authDir: config.authDir, allowQr, log, onFatal });
    stopWhatsApp = () => client.stop();
    const connected = client.start();

    if (mode === "login") {
        const timeout = new Promise((_, reject) => setTimeout(() => reject(new Error("Timed out after 5 minutes waiting for the QR scan.")), 5 * 60_000).unref());
        await Promise.race([connected, timeout]);
        log.info(`WhatsApp linked. Session saved in ${config.authDir}`);
        if (isValidGroupId(config.wpGroup)) await checkGroup(client);
        else log.warn("WP_GROUP is not set yet. Run `npm run groups` to list your groups.");
        return shutdown(EXIT.OK, "login complete");
    }

    if (mode === "test-message") {
        await connected;
        const group = await checkGroup(client);
        await client.sendText(config.wpGroup, `✅ JobsNotifier test message (${timestamp()}). Job alerts will appear in this group.`);
        log.info(`Test message sent to "${group.subject}".`);
        return shutdown(EXIT.OK, "test message sent");
    }

    connected
        .then(() => checkGroup(client).catch(err => {
            log.error(`Cannot access WP_GROUP ${maskGroupId(config.wpGroup)}: ${err.message}. Check the ID with \`npm run groups\`.`);
            shutdown(EXIT.CONFIG);
        }))
        .catch(onFatal);

    const sender = {
        isReady: () => client.isReady(),
        waitUntilReady: timeoutMs => client.waitUntilReady(timeoutMs),
        send: text => client.sendText(config.wpGroup, text),
    };
    const run = createGuardedRun(
        () => runCycle({ tasks, fetchPage, store, sender, log, mode: "live", sendDelayMs: config.sendDelayMs, homepageUrl }),
        log,
    );

    if (once) {
        const summary = await run("manual");
        return shutdown(summary ? EXIT.OK : 1, "single run complete");
    }

    scheduledTask = cron.schedule(HOURLY_SCHEDULE, () => run("scheduled"), { name: "hourly-check", noOverlap: true });
    log.info(`Scheduler active ("${HOURLY_SCHEDULE}", local time). Next check: ${timestamp(scheduledTask.getNextRun())}`);

    if (config.runOnStart) run("startup");
}

async function checkGroup(client, attempts = 3) {
    for (let i = 1; ; i++) {
        try {
            const group = await client.getGroup(config.wpGroup);
            log.info(`Target group: "${group.subject}" (${group.size} members)`);
            return group;
        } catch (err) {
            if (i >= attempts) throw err;
            await new Promise(r => setTimeout(r, 10_000));
        }
    }
}

main().catch(err => {
    log.error(err instanceof AuthRequiredError ? err.message : err);
    shutdown(err instanceof AuthRequiredError ? EXIT.AUTH_REQUIRED : 1);
});
