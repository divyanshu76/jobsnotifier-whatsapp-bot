// Keeps the bot running: starts index.js, restarts it after a crash with backoff,
// and stops for good on exits that a restart cannot fix (logged out, already running,
// bad configuration). This is what the Windows scheduled task runs.
import { spawn } from "node:child_process";
import path from "node:path";
import { pathToFileURL } from "node:url";

import { EXIT, ROOT_DIR, loadConfig } from "../src/config.js";
import { isProcessAlive } from "../src/lock.js";
import { createLogger } from "../src/logger.js";

const STOP_CODES = new Map([
    [EXIT.OK, "exited normally"],
    [EXIT.CONFIG, "configuration problem (see bot.log)"],
    [EXIT.LOCKED, "another instance is already running"],
    [EXIT.AUTH_REQUIRED, "WhatsApp needs to be linked again: run `npm run login`"],
    [EXIT.SESSION_REPLACED, "WhatsApp session was opened elsewhere"],
]);

const CRASH_WINDOW_MS = 60 * 60_000;
const MAX_CRASHES_PER_WINDOW = 10;

// Decide what to do after the bot exits. crashTimes: previous crash timestamps (ms).
export function decideRestart(code, crashTimes, now = Date.now()) {
    if (STOP_CODES.has(code)) return { restart: false, reason: STOP_CODES.get(code) };

    const recent = crashTimes.filter(t => now - t < CRASH_WINDOW_MS);
    if (recent.length >= MAX_CRASHES_PER_WINDOW) {
        return { restart: false, reason: `crashed ${recent.length} times in the last hour; giving up` };
    }
    return { restart: true, delayMs: Math.min(10_000 * 2 ** recent.length, 10 * 60_000) };
}

function main() {
    const config = loadConfig();
    const log = createLogger({ file: path.join(config.logDir, "supervisor.log"), toConsole: Boolean(process.stdout.isTTY) });
    const crashTimes = [];
    let child = null;
    let stopping = false;

    const start = () => {
        child = spawn(process.execPath, ["--disable-warning=ExperimentalWarning", path.join(ROOT_DIR, "index.js")], {
            cwd: ROOT_DIR,
            stdio: process.stdout.isTTY ? ["ignore", "inherit", "inherit", "ipc"] : ["ignore", "ignore", "pipe", "ipc"],
            windowsHide: true,
        });
        log.info(`Started bot (pid ${child.pid})`);
        child.stderr?.on("data", chunk => log.error(`bot stderr: ${chunk.toString().trim()}`));

        child.on("exit", (code, signal) => {
            child = null;
            if (stopping) return;
            const exitCode = code ?? 1;
            const decision = decideRestart(exitCode, crashTimes);
            log.info(`Bot exited (code ${code}${signal ? `, signal ${signal}` : ""})`);
            if (!decision.restart) {
                log.info(`Not restarting: ${decision.reason}`);
                process.exit(0);
            }
            crashTimes.push(Date.now());
            log.warn(`Restarting in ${decision.delayMs / 1000}s`);
            setTimeout(start, decision.delayMs);
        });
    };

    const stop = reason => {
        if (stopping) return;
        stopping = true;
        log.info(`Supervisor stopping: ${reason}`);
        if (!child) process.exit(0);
        child.send?.("shutdown");
        const force = setTimeout(() => child?.kill(), 10_000);
        child.once("exit", () => {
            clearTimeout(force);
            process.exit(0);
        });
    };

    process.on("SIGINT", () => stop("Ctrl+C"));
    process.on("SIGTERM", () => stop("SIGTERM"));

    // If whatever launched us (the scheduled task's PowerShell host) is killed, stop too.
    const parent = process.ppid;
    setInterval(() => {
        if (!isProcessAlive(parent)) stop("launcher exited");
    }, 10_000).unref();

    log.info(`Supervisor started (pid ${process.pid}, node ${process.version})`);
    start();
}

if (import.meta.url === pathToFileURL(process.argv[1]).href) main();
