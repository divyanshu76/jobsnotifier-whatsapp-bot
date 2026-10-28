// Inspect the delivery database.
//   npm run db                          counts per status + 20 most recent rows
//   npm run db -- uncertain             items whose delivery could not be confirmed
//   npm run db -- failed                items that will be retried next run
//   npm run db -- requeue <key>|--all   allow uncertain item(s) to be sent again
//                                       (only after checking the group: they may already be there)
import path from "node:path";

import { loadConfig } from "../src/config.js";
import { openStore } from "../src/store.js";

const config = loadConfig();
const store = openStore(path.join(config.dataDir, "jobs.db"));
const [command, arg] = process.argv.slice(2);

const show = rows => {
    if (!rows.length) return console.log("(none)");
    // SQLite stores UTC; show local time.
    const local = utc => new Date(`${utc.replace(" ", "T")}Z`).toLocaleString("sv-SE");
    for (const r of rows) console.log(`${local(r.updated_at)}  ${r.status.padEnd(9)}  ${r.key}${r.last_error ? `  [${r.last_error}]` : ""}`);
};

switch (command) {
    case undefined:
        console.log("Counts:", store.counts());
        show(store.listRecent(20));
        break;
    case "uncertain":
    case "failed":
    case "sent":
    case "skipped":
    case "seeded":
        show(store.listByStatus(command));
        break;
    case "requeue":
        if (!arg) {
            console.error("Usage: npm run db -- requeue <key> | --all");
            process.exitCode = 1;
        } else {
            console.log(`Requeued ${store.requeueUncertain(arg === "--all" ? null : arg)} item(s).`);
        }
        break;
    default:
        console.error(`Unknown command "${command}".`);
        process.exitCode = 1;
}

store.close();
