// Shows the detailed WhatsApp message for one or more posts. Sends nothing, records nothing.
//   npm run preview -- <post url> [<post url> ...] [--type latestJob|admitCard|result|admission] [--json]
import { MESSAGE_FORMATS, loadConfig } from "../src/config.js";
import { fetchBinary, fetchHtml, probeUrl } from "../src/http.js";
import { collectFromSource, fetchSourcePage } from "../src/source/index.js";
import { collectNotification } from "../src/vacancy/collect.js";

const argv = process.argv.slice(2);
const typeIndex = argv.indexOf("--type");
const taskName = typeIndex >= 0 ? argv[typeIndex + 1] : "latestJob";
const json = argv.includes("--json");
const urls = argv.filter((a, i) => /^https?:\/\//.test(a) && (typeIndex < 0 || i !== typeIndex + 1));

if (!urls.length) {
    console.error("Usage: npm run preview -- <post url> [--type latestJob|admitCard|result|admission] [--json]");
    process.exit(64);
}

const log = { info() {}, warn: m => console.error(`warn: ${m}`), error: m => console.error(`error: ${m}`) };
const formatArg = argv.find(a => a.startsWith("--format="))?.split("=")[1];
const format = MESSAGE_FORMATS.includes(formatArg) ? formatArg : loadConfig().messageFormat;
const sources = { fetchPage: url => fetchHtml(url), fetchBinary, probe: url => probeUrl(url), cache: null, log };
// compact: only sarkariresult.com.cm is requested (strict fetcher); nothing else is fetched.
const collect = format === "compact"
    ? item => collectFromSource(item, taskName, { fetchPage: url => fetchSourcePage(url), cache: null })
    : item => collectNotification(item, taskName, sources);

let failed = 0;
for (const url of urls) {
    try {
        const { model, parts } = await collect({ url });
        if (json) {
            console.log(JSON.stringify(model, null, 2));
            continue;
        }
        console.log(`\n================ ${url} (${format})`);
        if (format === "compact") console.log(`status: ${model.status} | apply link (not fetched): ${model.links.primary ?? "none"} | source article: ${model.sources.article}`);
        else console.log(`status: ${model.status} | apply: ${model.apply?.trust ?? "none"} (reachable: ${model.apply?.reachable}) | notification: ${model.notification?.status}${model.notification?.matches ? ` ${JSON.stringify(model.notification.matches)}` : ""}`);
        parts.forEach((p, i) => console.log(`\n--- message ${i + 1}/${parts.length} (${p.length} chars) ---\n${p}`));
    } catch (err) {
        failed++;
        console.error(`\n${url}: FAILED - ${err.message}`);
    }
}
process.exitCode = failed ? 1 : 0;
