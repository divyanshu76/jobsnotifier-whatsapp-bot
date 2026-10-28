import path from "node:path";
import { fileURLToPath } from "node:url";
import dotenv from "dotenv";

// Resolve everything relative to the project folder, not the current directory,
// so Task Scheduler and manual runs use the same auth/data/log folders.
export const ROOT_DIR = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

dotenv.config({ path: path.join(ROOT_DIR, ".env"), quiet: true });

// Every 30 minutes (minute 0 and 30 of every hour), in the local timezone.
export const HOURLY_SCHEDULE = "*/30 * * * *";

// Exit codes the supervisor treats as "do not restart".
export const EXIT = {
    OK: 0,
    CONFIG: 64,
    LOCKED: 75,
    AUTH_REQUIRED: 78,
    SESSION_REPLACED: 79,
};

const bool = (value, fallback) =>
    value === undefined || value === "" ? fallback : /^(1|true|yes|on)$/i.test(value.trim());

const int = (value, fallback) => {
    const n = Number.parseInt(value, 10);
    return Number.isFinite(n) && n >= 0 ? n : fallback;
};

const dir = (value, fallback) => path.resolve(ROOT_DIR, value || fallback);

export const MESSAGE_FORMATS = ["compact", "detailed"];
export const parseFormat = value => {
    const v = (value || "").trim().toLowerCase();
    return MESSAGE_FORMATS.includes(v) ? v : "compact";
};

export function loadConfig(env = process.env) {
    return {
        wpGroup: (env.WP_GROUP || "").trim(),
        dryRun: bool(env.DRY_RUN, false),
        runOnStart: bool(env.RUN_ON_START, false),
        authDir: dir(env.AUTH_DIR, "auth"),
        dataDir: dir(env.DATA_DIR, "data"),
        logDir: dir(env.LOG_DIR, "logs"),
        // How many of the newest entries per section to look at each run (3 / 3 / 3 / 2).
        limits: {
            admitCard: int(env.LIMIT_ADMIT_CARD, 3),
            result: int(env.LIMIT_RESULT, 3),
            admission: int(env.LIMIT_ADMISSION, 3),
            latestJob: int(env.LIMIT_LATEST_JOB, 2),
        },
        sendDelayMs: int(env.SEND_DELAY_MS, 3000),
        // "compact"  = compact notifications; sarkariresult.com.cm is the ONLY source (default)
        // "detailed" = full structured notifications (www.sarkariresult.com)
        messageFormat: parseFormat(env.MESSAGE_FORMAT),
    };
}

// WhatsApp group JIDs look like 120363012345678901@g.us (or the older
// 919876543210-1600000000@g.us form).
export function isValidGroupId(id) {
    return /^\d+(-\d+)?@g\.us$/.test(id || "");
}

export function maskGroupId(id) {
    if (!id) return "(unset)";
    const [local, domain] = id.split("@");
    return `${local.slice(0, 4)}…${local.slice(-3)}@${domain ?? ""}`;
}
