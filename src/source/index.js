import { formatCompact } from "./compact.js";
import { HOME_SECTIONS, buildSourceModel, parseHomeSection, parseSourceArticle } from "./parse.js";
import { SOURCE_HOME, SourceBlockedError, toSourceUrl } from "./site.js";

export { SOURCE_HOME, SOURCE_HOST, fetchSourcePage, isSourceUrl, toSourceUrl } from "./site.js";

const HOUR = 60 * 60_000;

// Builds the compact notification for one post. `fetchPage` must be the strict source
// fetcher; the URL is checked here as well, so nothing else is ever requested.
// No external links are fetched or probed: they are only displayed.
export async function collectFromSource(item, taskName, { fetchPage, cache, today = new Date() }) {
    const url = toSourceUrl(item.url);
    if (!url) throw new SourceBlockedError(`Blocked: ${item.url} is not on the permitted source website`);

    const key = `source-article:${url}`;
    let article = cache?.cacheGet(key, 3 * HOUR);
    if (article === undefined) {
        article = parseSourceArticle(await fetchPage(url));
        cache?.cacheSet(key, article);
    }
    if (!article.title && !article.heading) throw new Error(`no post details found on ${url}`);

    const model = buildSourceModel(article, { taskName, sourceUrl: url, today });
    return { model, parts: formatCompact(model, today) };
}

// Task definitions for the hourly check (same names, limits and dedup keys as before).
export function createSourceTasks(limits, sources) {
    return Object.entries(HOME_SECTIONS).map(([name, heading]) => ({
        name,
        list: html => parseHomeSection(html, heading, limits[name]),
        buildMessage: async item => (await collectFromSource(item, name, sources)).parts,
    }));
}

export const SOURCE_HOMEPAGE = SOURCE_HOME;
