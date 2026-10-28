import fs from "node:fs";
import path from "node:path";

const MB = 1024 * 1024;

// Local-time timestamp, e.g. "2026-10-26 14:00:00".
export const timestamp = (date = new Date()) => date.toLocaleString("sv-SE");

// Size-based rotation: bot.log -> bot.log.1 -> ... -> bot.log.<keep>.
export function rotateIfNeeded(file, maxBytes, keep) {
    let size = 0;
    try {
        size = fs.statSync(file).size;
    } catch {
        return;
    }
    if (size < maxBytes) return;

    fs.rmSync(`${file}.${keep}`, { force: true });
    for (let i = keep - 1; i >= 1; i--) {
        if (fs.existsSync(`${file}.${i}`)) fs.renameSync(`${file}.${i}`, `${file}.${i + 1}`);
    }
    fs.renameSync(file, `${file}.1`);
}

export function createLogger({ file, maxBytes = 5 * MB, keep = 5, toConsole = true } = {}) {
    if (file) fs.mkdirSync(path.dirname(file), { recursive: true });

    const write = (level, args) => {
        const text = args
            .map(a => (a instanceof Error ? a.stack || a.message : typeof a === "string" ? a : JSON.stringify(a)))
            .join(" ");
        const line = `${timestamp()} [${level}] ${text}`;

        if (toConsole) (level === "ERROR" ? console.error : console.log)(line);
        if (!file) return;
        try {
            rotateIfNeeded(file, maxBytes, keep);
            fs.appendFileSync(file, line + "\n");
        } catch (err) {
            if (toConsole) console.error(`Could not write log file: ${err.message}`);
        }
    };

    return {
        info: (...a) => write("INFO", a),
        warn: (...a) => write("WARN", a),
        error: (...a) => write("ERROR", a),
    };
}

// Logger that discards everything (used by tests).
export const silentLogger = { info() {}, warn() {}, error() {} };
