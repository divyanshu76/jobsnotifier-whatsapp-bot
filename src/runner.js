import { NotSentError } from "./errors.js";

const sleep = ms => new Promise(r => setTimeout(r, ms));

// Items are identified by section + link, so the same post appearing again on the
// homepage (or after a restart) is not sent twice.
export const itemKey = (taskName, url) => `${taskName}:${url}`;

// One check of all sections.
//
// mode: "live"   - send new items and record them
//       "dry-run"- print what would be sent; no WhatsApp, no database writes
//       "seed"   - record current items as already seen, without sending
export async function runCycle({
    tasks,
    fetchPage,
    store,
    sender,
    log,
    mode = "live",
    sendDelayMs = 3000,
    readyTimeoutMs = 120_000,
    wait = sleep,
    homepageUrl,
}) {
    if (!homepageUrl) throw new Error("runCycle: homepageUrl is required");
    const summary = { new: 0, sent: 0, alreadyHandled: 0, skipped: 0, failed: 0, uncertain: 0, seeded: 0, errors: 0 };
    let sentSomething = false;
    let whatsappDown = false;

    const homepage = await fetchPage(homepageUrl);

    for (const task of tasks) {
        let items;
        try {
            items = task.list(homepage);
            log.info(`[${task.name}] found ${items.length} item(s) on the homepage`);
            if (items.length === 0) log.warn(`[${task.name}] no items parsed - the site layout may have changed`);
        } catch (err) {
            summary.errors++;
            log.error(`[${task.name}] parsing failed:`, err);
            continue;
        }

        for (const item of items) {
            const key = itemKey(task.name, item.url);
            const record = { category: task.name, title: item.title, url: item.url };

            if (store.isHandled(key)) {
                summary.alreadyHandled++;
                continue;
            }
            summary.new++;

            if (mode === "seed") {
                store.markSeeded(key, record);
                summary.seeded++;
                log.info(`[${task.name}] seeded (will not be sent): ${item.title || item.url}`);
                continue;
            }

            let message;
            try {
                message = await task.buildMessage(item, fetchPage);
            } catch (err) {
                // Leave unrecorded so the next run tries again.
                summary.errors++;
                log.error(`[${task.name}] could not build message for ${item.url}: ${err.message}`);
                continue;
            }

            // A message is one string or, when split, an array of parts sent in order.
            const parts = (Array.isArray(message) ? message : [message]).filter(Boolean);

            if (!parts.length) {
                summary.skipped++;
                if (mode !== "dry-run") store.markSkipped(key, record);
                log.warn(`[${task.name}] nothing to send for ${item.url} (skipped)`);
                continue;
            }

            if (mode === "dry-run") {
                parts.forEach((part, i) =>
                    log.info(`[${task.name}] DRY RUN - would send${parts.length > 1 ? ` (message ${i + 1}/${parts.length}, ${part.length} chars)` : ""}:\n${part}\n`));
                continue;
            }

            if (whatsappDown) {
                summary.failed++;
                continue;
            }

            if (!sender.isReady()) {
                log.warn(`WhatsApp not connected; waiting up to ${Math.round(readyTimeoutMs / 1000)}s...`);
                if (!(await sender.waitUntilReady(readyTimeoutMs))) {
                    whatsappDown = true;
                    summary.failed++;
                    log.error("WhatsApp is still not connected; remaining items will be retried next hour.");
                    continue;
                }
            }

            if (sentSomething) await wait(sendDelayMs);

            if (!store.beginSend(key, record)) {
                summary.alreadyHandled++;
                continue;
            }

            let partsSent = 0;
            try {
                for (const part of parts) {
                    if (partsSent > 0) await wait(sendDelayMs);
                    await sender.send(part);
                    partsSent++;
                }
                store.markSent(key);
                summary.sent++;
                sentSomething = true;
                log.info(`[${task.name}] sent${parts.length > 1 ? ` (${parts.length} parts)` : ""}: ${item.title || item.url}`);
            } catch (err) {
                if (partsSent > 0) {
                    // Some parts reached the group; resending would duplicate them.
                    store.markUncertain(key, `${partsSent}/${parts.length} parts sent: ${err.message}`);
                    summary.uncertain++;
                    sentSomething = true;
                    log.error(`[${task.name}] only ${partsSent}/${parts.length} parts sent; marked UNCERTAIN: ${err.message}`);
                } else if (err instanceof NotSentError) {
                    store.markFailed(key, err.message);
                    summary.failed++;
                    log.error(`[${task.name}] not sent (will retry next run): ${err.message}`);
                } else {
                    // The message may or may not have reached WhatsApp. Never resend automatically.
                    store.markUncertain(key, err.message);
                    summary.uncertain++;
                    log.error(`[${task.name}] delivery UNCERTAIN, will not resend automatically: ${err.message}`);
                }
            }
        }
    }

    return summary;
}

// Wraps a cycle so that two runs never overlap, and logs start/finish/duration.
export function createGuardedRun(runOnce, log) {
    let running = false;

    return async function guardedRun(reason = "scheduled") {
        if (running) {
            log.warn(`Skipping ${reason} run: the previous run is still in progress.`);
            return null;
        }
        running = true;
        const started = Date.now();
        log.info(`Run started (${reason})`);
        try {
            const summary = await runOnce();
            log.info(`Run finished in ${((Date.now() - started) / 1000).toFixed(1)}s: ${JSON.stringify(summary)}`);
            return summary;
        } catch (err) {
            log.error(`Run failed after ${((Date.now() - started) / 1000).toFixed(1)}s:`, err.message);
            return null;
        } finally {
            running = false;
        }
    };
}
