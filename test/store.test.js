import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { test } from "node:test";

import { SCHEMA_VERSION, backupDatabase, openStore } from "../src/store.js";
import { tempDir } from "./helpers.js";

const item = { category: "admitCard", title: "T", url: "https://u" };

test("a sent item stays handled after reopening the database (restart)", () => {
    const file = path.join(tempDir(), "jobs.db");
    let store = openStore(file);
    assert.equal(store.isHandled("k"), false);
    assert.equal(store.beginSend("k", item), true);
    store.markSent("k");
    store.close();

    store = openStore(file);
    assert.equal(store.isHandled("k"), true);
    assert.equal(store.get("k").status, "sent");
    assert.equal(store.beginSend("k", item), false, "cannot claim an already-sent item");
    store.close();
});

test("an item is only marked sent after markSent", () => {
    const store = openStore(path.join(tempDir(), "jobs.db"));
    store.beginSend("k", item);
    assert.equal(store.get("k").status, "sending");
    store.close();
});

test("failed items can be retried; uncertain items cannot", () => {
    const store = openStore(path.join(tempDir(), "jobs.db"));
    store.beginSend("a", item);
    store.markFailed("a", "offline");
    assert.equal(store.isHandled("a"), false);
    assert.equal(store.beginSend("a", item), true);
    assert.equal(store.get("a").attempts, 2);

    store.beginSend("b", item);
    store.markUncertain("b", "timeout");
    assert.equal(store.isHandled("b"), true);
    assert.equal(store.beginSend("b", item), false);
    store.close();
});

test("an interrupted send becomes uncertain on the next start", () => {
    const file = path.join(tempDir(), "jobs.db");
    let store = openStore(file);
    store.beginSend("k", item);
    store.close(); // simulated crash while "sending"

    store = openStore(file);
    assert.equal(store.recoverInterrupted(), 1);
    assert.equal(store.get("k").status, "uncertain");
    assert.equal(store.isHandled("k"), true);
    store.close();
});

test("requeueUncertain makes an uncertain item sendable again", () => {
    const store = openStore(path.join(tempDir(), "jobs.db"));
    store.beginSend("k", item);
    store.markUncertain("k", "timeout");
    assert.equal(store.requeueUncertain("k"), 1);
    assert.equal(store.isHandled("k"), false);
    store.close();
});

test("skipped and seeded items are handled and never overwrite existing rows", () => {
    const store = openStore(path.join(tempDir(), "jobs.db"));
    store.markSeeded("s", item);
    store.markSkipped("x", item);
    assert.equal(store.isHandled("s"), true);
    assert.equal(store.isHandled("x"), true);

    store.beginSend("sent", item);
    store.markSent("sent");
    store.markSeeded("sent", item);
    assert.equal(store.get("sent").status, "sent");
    store.close();
});

test("a database from a newer version is refused, not modified", () => {
    const file = path.join(tempDir(), "jobs.db");
    const db = new DatabaseSync(file);
    db.exec(`PRAGMA user_version = ${SCHEMA_VERSION + 1}`);
    db.close();
    assert.throws(() => openStore(file), /newer than this code/);
});

test("backupDatabase writes a readable copy", () => {
    const dir = tempDir();
    const file = path.join(dir, "jobs.db");
    const store = openStore(file);
    store.markSeeded("k", item);
    store.close();

    const db = new DatabaseSync(file);
    const backup = backupDatabase(db, file, 1);
    db.close();
    assert.ok(fs.existsSync(backup));
    const copy = new DatabaseSync(backup);
    assert.equal(copy.prepare("SELECT COUNT(*) AS n FROM deliveries").get().n, 1);
    copy.close();
});
