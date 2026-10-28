// List the WhatsApp groups of the linked account, to find the ID for WP_GROUP.
//
//   npm run groups
//
// Read-only: sends nothing. The bot must be stopped first (it holds the WhatsApp connection).
import path from "node:path";

import { EXIT, loadConfig } from "../src/config.js";
import { AuthRequiredError } from "../src/errors.js";
import { acquireLock } from "../src/lock.js";
import { createWhatsAppClient } from "../src/whatsapp/client.js";

const config = loadConfig();
const release = acquireLock(path.join(config.dataDir, "bot.lock"));
if (!release) {
    console.error("The bot is running and holds the WhatsApp connection. Stop it first, then run this again.");
    process.exit(EXIT.LOCKED);
}

const quiet = { info() {}, warn() {}, error: message => console.error(message) };
const client = createWhatsAppClient({ authDir: config.authDir, allowQr: false, log: quiet });

let code = EXIT.OK;
try {
    console.log("Connecting to WhatsApp...");
    await client.start();
    const groups = await client.listGroups();

    if (groups.length === 0) {
        console.log("\nThis account is not a member of any group.");
    } else {
        const width = String(groups.length).length;
        console.log("");
        groups.forEach((group, i) => {
            console.log(`${String(i + 1).padStart(width)}. ${group.subject || "(no name)"}`);
            console.log(`${" ".repeat(width + 2)}ID:      ${group.id}`);
            console.log(`${" ".repeat(width + 2)}Members: ${group.size}`);
        });
        console.log(`\n${groups.length} group${groups.length === 1 ? "" : "s"} found.`);
        console.log("Copy the ID of the target group into .env as WP_GROUP=<id>");
    }
} catch (err) {
    console.error(err.message);
    code = err instanceof AuthRequiredError ? EXIT.AUTH_REQUIRED : 1;
} finally {
    client.stop();
    release();
}
process.exit(code);
