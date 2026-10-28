import { parseArticle } from "./article.js";
import { formatNotification, splitMessage } from "./format.js";
import { pickLinks } from "./links.js";
import { buildVacancy, factsForCrossCheck } from "./model.js";
import { checkNotification, fetchNotification, probeLink } from "./verify.js";

const HOUR = 60 * 60_000;
// Post pages change (corrigenda, extended dates), so they are re-read after a few hours;
// the text of a notification PDF at a given URL does not change, so it is kept for a week.
export const CACHE_TTL = { article: 3 * HOUR, link: 6 * HOUR, notification: 7 * 24 * HOUR };

const LINK_KIND = { latestJob: "apply", admission: "apply", admitCard: "admitCard", result: "result" };

async function cached(cache, key, ttl, load) {
    const hit = cache?.cacheGet(key, ttl);
    if (hit !== undefined) return hit;
    const value = await load();
    cache?.cacheSet(key, value);
    return value;
}

// Fetches a post, verifies its links/notification and returns the structured model and the
// WhatsApp message parts. Throws only if the post page itself cannot be fetched or parsed,
// so the caller can retry on the next run; a failing PDF or link only lowers verification.
export async function collectNotification(item, taskName, { fetchPage, fetchBinary, probe, cache, log, today = new Date() }) {
    const article = await cached(cache, `article:${item.url}`, CACHE_TTL.article, async () => parseArticle(await fetchPage(item.url)));
    if (!article.title) throw new Error(`no post details found on ${item.url}`);

    const links = pickLinks(article.links, LINK_KIND[taskName] ?? "apply");
    // Only links classified as official / government / known exam portal are probed; an
    // unconfirmed link is shown with a warning but never requested.
    const linkCheck = links.primary && links.primary.trust !== "unconfirmed"
        ? await cached(cache, `link:${links.primary.href}`, CACHE_TTL.link, () => probeLink(links.primary.href, { probe, log }))
        : null;

    const base = { taskName, sourceUrl: item.url, links, linkCheck, today };
    const notification = links.notification
        ? await cached(cache, `notification:${links.notification}`, CACHE_TTL.notification,
            () => fetchNotification(links.notification, { fetchBinary, log }))
        : { url: null, status: "missing" };

    const notificationCheck = checkNotification(notification, factsForCrossCheck(buildVacancy(article, base)));
    const model = buildVacancy(article, { ...base, notificationCheck });
    const parts = splitMessage(formatNotification(model), { label: article.title });
    return { model, parts };
}
