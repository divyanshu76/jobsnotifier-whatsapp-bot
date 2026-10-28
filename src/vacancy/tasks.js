import { SECTIONS, parseHomepageSection } from "../sarkariresult/homepage.js";
import { collectNotification } from "./collect.js";

// Tasks for the "detailed" format: new posts in the www.sarkariresult.com homepage sections,
// one detailed notification each. `sources` = { fetchPage, fetchBinary, probe, cache, log }.
export function createDetailedTasks(limits, sources) {
    return SECTIONS.map(name => ({
        name,
        list: html => parseHomepageSection(html, name, limits[name]),
        buildMessage: async item => (await collectNotification(item, name, sources)).parts,
    }));
}
