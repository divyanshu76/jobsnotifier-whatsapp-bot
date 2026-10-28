// Read-only health check of the local setup. Never prints secrets. Usage: npm run check
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";

import { ROOT_DIR, isValidGroupId, loadConfig, maskGroupId } from "../src/config.js";
import { lockOwner } from "../src/lock.js";

const config = loadConfig();
let problems = 0;
const ok = msg => console.log(`  OK    ${msg}`);
const warn = msg => console.log(`  WARN  ${msg}`);
const bad = msg => { problems++; console.log(`  FAIL  ${msg}`); };

console.log("JobsNotifier setup check\n");

const [major, minor] = process.versions.node.split(".").map(Number);
(major > 22 || (major === 22 && minor >= 13)) ? ok(`Node.js ${process.version}`) : bad(`Node.js ${process.version} is too old (need >= 22.13 for node:sqlite)`);

for (const dep of ["@whiskeysockets/baileys", "axios", "cheerio", "dotenv", "node-cron", "pino", "qrcode-terminal"]) {
    try {
        await import(dep);
        ok(`dependency ${dep}`);
    } catch (err) {
        bad(`dependency ${dep} cannot be loaded (${err.code || err.message}); run npm ci`);
    }
}

fs.existsSync(path.join(ROOT_DIR, ".env")) ? ok(".env exists") : bad(".env missing: Copy-Item .env.example .env");
isValidGroupId(config.wpGroup) ? ok(`WP_GROUP looks valid (${maskGroupId(config.wpGroup)})`) : bad("WP_GROUP missing or not a group ID (…@g.us); run npm run groups");
config.dryRun ? warn("DRY_RUN=true: the hourly bot will NOT send messages") : ok("DRY_RUN is off");

const credsFile = path.join(config.authDir, "creds.json");
let linked = false;
try {
    linked = Boolean(JSON.parse(fs.readFileSync(credsFile, "utf8")).me?.id);
} catch {
    // no session yet
}
linked ? ok(`WhatsApp session present in ${path.relative(ROOT_DIR, config.authDir)}`) : warn("WhatsApp not linked yet: run npm run login");

try {
    const ignored = execFileSync("git", ["check-ignore", ".env", "auth/creds.json", "data/jobs.db", "logs/bot.log"], { cwd: ROOT_DIR, encoding: "utf8" })
        .trim().split(/\r?\n/);
    ignored.length === 4 ? ok("git ignores .env, auth/, data/, logs/") : bad(`git does not ignore all secret paths (ignored: ${ignored.join(", ")})`);
} catch {
    bad("git does not ignore all of .env, auth/, data/, logs/ (or git is unavailable)");
}

const owner = lockOwner(path.join(config.dataDir, "bot.lock"));
owner ? ok(`bot is running (pid ${owner})`) : warn("bot is not running");

// --online: connect with the saved session and read the target group's details (sends nothing).
if (process.argv.includes("--online")) {
    if (owner) {
        warn("skipping online check: the bot is running and holds the WhatsApp connection");
    } else if (!linked || !isValidGroupId(config.wpGroup)) {
        bad("online check needs a linked session and a valid WP_GROUP");
    } else {
        const { createWhatsAppClient } = await import("../src/whatsapp/client.js");
        const quiet = { info() {}, warn() {}, error() {} };
        const client = createWhatsAppClient({ authDir: config.authDir, allowQr: false, log: quiet });
        try {
            await client.start();
            ok("WhatsApp connected with the saved session");
            const group = await client.getGroup(config.wpGroup);
            ok(`target group reachable: "${group.subject}" (${group.size} members)`);
        } catch (err) {
            bad(`online check failed: ${err.message}`);
        } finally {
            client.stop();
        }
    }
}

console.log(problems ? `\n${problems} problem(s) found.` : "\nAll required checks passed.");
process.exitCode = problems ? 1 : 0;
setTimeout(() => process.exit(), 1500).unref();
