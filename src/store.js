import fs from "node:fs";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";

// Delivery record for every listing the bot has handled.
//
//   sending   - send in progress (if the process dies here it becomes "uncertain")
//   sent      - WhatsApp accepted the message
//   failed    - definitely NOT sent (e.g. WhatsApp was offline); retried next run
//   uncertain - send started but its outcome is unknown; never retried automatically
//   skipped   - nothing worth sending (e.g. job page had no details)
//   seeded    - marked as already-seen by `npm run seed`, never sent
//
// Only "failed" (or a missing row) is eligible for sending.
export const SCHEMA_VERSION = 2;

const MIGRATIONS = {
    1: `
        CREATE TABLE deliveries (
            key        TEXT PRIMARY KEY,
            category   TEXT NOT NULL,
            title      TEXT,
            url        TEXT,
            status     TEXT NOT NULL,
            attempts   INTEGER NOT NULL DEFAULT 0,
            last_error TEXT,
            created_at TEXT NOT NULL DEFAULT (datetime('now')),
            updated_at TEXT NOT NULL DEFAULT (datetime('now'))
        );
        CREATE INDEX deliveries_status ON deliveries(status);
    `,
    // Cache of fetched/verified sources (post pages, notification checks, link checks).
    2: `
        CREATE TABLE source_cache (
            key        TEXT PRIMARY KEY,
            payload    TEXT NOT NULL,
            fetched_at INTEGER NOT NULL
        );
    `,
};

export function openStore(file) {
    fs.mkdirSync(path.dirname(file), { recursive: true });
    const existed = fs.existsSync(file);
    const db = new DatabaseSync(file);
    db.exec("PRAGMA journal_mode = WAL; PRAGMA busy_timeout = 5000;");

    migrate(db, file, existed);

    const q = {
        get: db.prepare("SELECT * FROM deliveries WHERE key = ?"),
        begin: db.prepare(`
            INSERT INTO deliveries (key, category, title, url, status, attempts)
            VALUES (?, ?, ?, ?, 'sending', 1)
            ON CONFLICT(key) DO UPDATE SET
                status = 'sending', attempts = attempts + 1, updated_at = datetime('now')
            WHERE deliveries.status = 'failed'
        `),
        beginBulk: db.prepare(`
            INSERT INTO deliveries (key, category, title, url, status, attempts)
            VALUES (?, ?, ?, ?, 'sending', 1)
            ON CONFLICT(key) DO UPDATE SET
                status = 'sending', attempts = attempts + 1, updated_at = datetime('now')
            WHERE deliveries.status IN ('failed', 'seeded')
        `),
        setStatus: db.prepare(`
            UPDATE deliveries SET status = ?, last_error = ?, updated_at = datetime('now')
            WHERE key = ? AND status = 'sending'
        `),
        insertFinal: db.prepare(`
            INSERT INTO deliveries (key, category, title, url, status)
            VALUES (?, ?, ?, ?, ?)
            ON CONFLICT(key) DO NOTHING
        `),
        recover: db.prepare(`
            UPDATE deliveries SET status = 'uncertain',
                last_error = 'process stopped while sending', updated_at = datetime('now')
            WHERE status = 'sending'
        `),
        byStatus: db.prepare("SELECT * FROM deliveries WHERE status = ? ORDER BY updated_at DESC"),
        recent: db.prepare("SELECT * FROM deliveries ORDER BY updated_at DESC LIMIT ?"),
        counts: db.prepare("SELECT status, COUNT(*) AS n FROM deliveries GROUP BY status"),
        resent: db.prepare(`
            UPDATE deliveries SET attempts = attempts + 1, last_error = 'manual resend', updated_at = datetime('now')
            WHERE key = ? AND status = 'sent'
        `),
        cacheGet: db.prepare("SELECT payload, fetched_at FROM source_cache WHERE key = ?"),
        cacheSet: db.prepare(`
            INSERT INTO source_cache (key, payload, fetched_at) VALUES (?, ?, ?)
            ON CONFLICT(key) DO UPDATE SET payload = excluded.payload, fetched_at = excluded.fetched_at
        `),
        cachePrune: db.prepare("DELETE FROM source_cache WHERE fetched_at < ?"),
        requeue: db.prepare(`
            UPDATE deliveries SET status = 'failed', updated_at = datetime('now')
            WHERE status = 'uncertain' AND (? IS NULL OR key = ?)
        `),
    };

    return {
        get: key => q.get.get(key),

        // True when the item must not be sent (already sent, in progress, unknown, skipped, seeded).
        isHandled(key) {
            const row = q.get.get(key);
            return Boolean(row) && row.status !== "failed";
        },

        // Atomically claim the item for sending. Returns false if it is already handled.
        beginSend(key, { category, title, url }) {
            return q.begin.run(key, category, title ?? null, url ?? null).changes === 1;
        },

        // Like beginSend, but also claims "seeded" items (used by the one-time bulk send,
        // which deliberately includes items that were seeded without being sent).
        beginBulkSend(key, { category, title, url }) {
            return q.beginBulk.run(key, category, title ?? null, url ?? null).changes === 1;
        },

        // True when the item is already delivered or its delivery is in doubt.
        isDeliveredOrInDoubt(key) {
            const row = q.get.get(key);
            return Boolean(row) && ["sent", "sending", "uncertain"].includes(row.status);
        },

        markSent: key => q.setStatus.run("sent", null, key),
        // A deliberate manual resend of an item that is already "sent" (status unchanged).
        markResent: key => q.resent.run(key),
        markFailed: (key, error) => q.setStatus.run("failed", String(error ?? ""), key),
        markUncertain: (key, error) => q.setStatus.run("uncertain", String(error ?? ""), key),

        markSkipped: (key, item) => q.insertFinal.run(key, item.category, item.title ?? null, item.url ?? null, "skipped"),
        markSeeded: (key, item) => q.insertFinal.run(key, item.category, item.title ?? null, item.url ?? null, "seeded"),

        // Call once at startup: anything left in "sending" was interrupted mid-send.
        recoverInterrupted: () => Number(q.recover.run().changes),

        listByStatus: status => q.byStatus.all(status),
        listRecent: (limit = 20) => q.recent.all(limit),
        counts: () => Object.fromEntries(q.counts.all().map(r => [r.status, r.n])),

        // Manual escape hatch after checking the group: allow an "uncertain" item to be sent again.
        requeueUncertain: (key = null) => Number(q.requeue.run(key, key).changes),

        // JSON cache entry, or undefined when missing or older than maxAgeMs.
        cacheGet(key, maxAgeMs, now = Date.now()) {
            const row = q.cacheGet.get(key);
            if (!row || now - row.fetched_at > maxAgeMs) return undefined;
            return JSON.parse(row.payload);
        },
        cacheSet: (key, value, now = Date.now()) => q.cacheSet.run(key, JSON.stringify(value), now),
        cachePrune: (olderThanMs, now = Date.now()) => Number(q.cachePrune.run(now - olderThanMs).changes),

        close: () => db.close(),
    };
}

function migrate(db, file, existed) {
    const current = db.prepare("PRAGMA user_version").get().user_version;

    if (current > SCHEMA_VERSION) {
        throw new Error(`Database ${file} has schema v${current}, newer than this code (v${SCHEMA_VERSION}).`);
    }
    if (current === SCHEMA_VERSION) return;

    // Back up an existing database before changing its schema.
    if (existed && current > 0) backupDatabase(db, file, current);

    for (let v = current + 1; v <= SCHEMA_VERSION; v++) {
        db.exec("BEGIN");
        try {
            db.exec(MIGRATIONS[v]);
            db.exec(`PRAGMA user_version = ${v}`);
            db.exec("COMMIT");
        } catch (err) {
            db.exec("ROLLBACK");
            throw err;
        }
    }
}

export function backupDatabase(db, file, version) {
    const stamp = new Date().toISOString().replace(/[:.]/g, "-");
    const target = `${file}.v${version}.${stamp}.bak`;
    db.exec(`VACUUM INTO '${target.replace(/'/g, "''")}'`);
    return target;
}
