// Preview or send ONE notification (detailed format) for a single post.
//
//   npm run send-one -- <post url> [--type latestJob|admitCard|result|admission]
//       preview only: prints the message parts, the delivery record and a content fingerprint
//   npm run send-one -- <post url> --send --expect <fingerprint> [--resend]
//       sends exactly the previewed content (refuses if it changed), records it as sent.
//       --resend is required when the item is already recorded as sent.
//       The hourly bot must be stopped first (it holds the WhatsApp connection).
import crypto from "node:crypto";
import path from "node:path";

import { EXIT, MESSAGE_FORMATS, isValidGroupId, loadConfig } from "../src/config.js";
import { collectFromSource, fetchSourcePage } from "../src/source/index.js";
import { NotSentError } from "../src/errors.js";
import { fetchBinary, fetchHtml, probeUrl } from "../src/http.js";
import { acquireLock } from "../src/lock.js";
import { createLogger } from "../src/logger.js";
import { itemKey } from "../src/runner.js";
import { openStore } from "../src/store.js";
import { collectNotification } from "../src/vacancy/collect.js";
import { createWhatsAppClient } from "../src/whatsapp/client.js";

const argv = process.argv.slice(2);
const option = name => {
    const i = argv.indexOf(name);
    return i >= 0 ? argv[i + 1] : undefined;
};
const url = argv.find(a => /^https?:\/\//.test(a));
const taskName = option("--type") ?? "latestJob";
const send = argv.includes("--send");
const resend = argv.includes("--resend");
const expected = option("--expect");

if (!url || !["latestJob", "admitCard", "result", "admission"].includes(taskName)) {
    console.error("Usage: npm run send-one -- <post url> [--type latestJob|admitCard|result|admission] [--send --expect <fingerprint> [--resend]]");
    process.exit(EXIT.CONFIG);
}

const config = loadConfig();
const log = createLogger({ file: path.join(config.logDir, "bot.log"), toConsole: send });
const fingerprint = parts => crypto.createHash("sha256").update(parts.join("\n\u0000\n")).digest("hex").slice(0, 12);

let release = () => {};
if (send) {
    release = acquireLock(path.join(config.dataDir, "bot.lock"));
    if (!release) {
        console.error("The hourly bot is running and holds the WhatsApp connection. Stop it first: scripts\\stop-bot.ps1");
        process.exit(EXIT.LOCKED);
    }
}
const store = openStore(path.join(config.dataDir, "jobs.db"));
const key = itemKey(taskName, url);

let code = EXIT.OK;
try {
    const quiet = { info() {}, warn: m => log.warn(m), error: m => log.error(m) };
    const formatArg = argv.find(a => a.startsWith("--format="))?.split("=")[1];
    const format = MESSAGE_FORMATS.includes(formatArg) ? formatArg : config.messageFormat;
    const { model, parts } = format === "compact"
        ? await collectFromSource({ url }, taskName, { fetchPage: u => fetchSourcePage(u), cache: store })
        : await collectNotification({ url }, taskName, {
            fetchPage: u => fetchHtml(u), fetchBinary, probe: u => probeUrl(u), cache: store, log: quiet,
        });
    const record = store.get(key);
    const print = parts.length > 1 ? `${parts.length} parts` : "1 message";

    if (!send) {
        parts.forEach((p, i) => console.log(`\n--- message ${i + 1}/${parts.length} (${p.length} chars) ---\n${p}`));
        console.log(`\nKey: ${key}`);
        console.log(`Delivery record: ${record ? `${record.status} (updated ${record.updated_at} UTC)` : "none"}`);
        console.log(`Status: ${model.status} | apply link: ${model.apply?.trust ?? "none"}, reachable ${model.apply?.reachable} | notification: ${model.notification?.status}`);
        console.log(`Would send: ${print}`);
        console.log(`Fingerprint: ${fingerprint(parts)}`);
        console.log("Preview only - nothing was sent.");
    } else {
        if (!isValidGroupId(config.wpGroup)) throw new Error("WP_GROUP is missing or invalid in .env");
        if (expected !== fingerprint(parts)) {
            throw new Error(`Content changed since the approved preview (fingerprint ${fingerprint(parts)}, expected ${expected}). Nothing sent; preview again.`);
        }
        const alreadySent = record?.status === "sent";
        if (alreadySent && !resend) throw new Error(`${key} is already recorded as sent. Add --resend to send it again deliberately.`);
        if (["sending", "uncertain"].includes(record?.status)) throw new Error(`${key} has status "${record.status}"; not sending.`);
        if (!alreadySent && !store.beginBulkSend(key, { category: taskName, title: model.title, url })) {
            throw new Error(`Could not claim ${key} for sending.`);
        }

        const client = createWhatsAppClient({ authDir: config.authDir, allowQr: false, log });
        let sentParts = 0;
        let attempted = false;
        try {
            await client.start();
            const group = await client.getGroup(config.wpGroup);
            log.info(`Sending ${print} for ${key} to "${group.subject}"`);
            for (const part of parts) {
                if (sentParts > 0) await new Promise(r => setTimeout(r, Math.max(config.sendDelayMs, 3000)));
                attempted = true;
                await client.sendText(config.wpGroup, part);
                sentParts++;
                log.info(`Part ${sentParts}/${parts.length} accepted by WhatsApp (${part.length} chars)`);
            }
            if (alreadySent) store.markResent(key);
            else store.markSent(key);
            log.info(`Delivered ${print}; ${key} recorded as sent.`);
        } catch (err) {
            code = 1;
            if (alreadySent) {
                log.error(`Resend stopped after ${sentParts}/${parts.length} parts: ${err.message} (record stays "sent").`);
            } else if (sentParts === 0 && (!attempted || err instanceof NotSentError)) {
                // Nothing reached WhatsApp (connection/group check failed, or not connected): retryable.
                store.markFailed(key, err.message);
                log.error(`Not sent: ${err.message}`);
            } else {
                store.markUncertain(key, `${sentParts}/${parts.length} parts sent: ${err.message}`);
                log.error(`Delivery uncertain after ${sentParts}/${parts.length} parts: ${err.message}`);
            }
        } finally {
            client.stop();
        }
    }
} catch (err) {
    console.error(err.message);
    code = 1;
} finally {
    store.close();
    release();
    setTimeout(() => process.exit(code), 1500);
}
