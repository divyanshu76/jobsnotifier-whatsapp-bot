import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import fs from "node:fs";
import path from "node:path";
import { test } from "node:test";

import { AuthRequiredError, NotSentError, SessionReplacedError, UncertainSendError } from "../src/errors.js";
import { closeDecision, createWhatsAppClient, hasLinkedSession } from "../src/whatsapp/client.js";
import { tempDir } from "./helpers.js";

const flush = () => new Promise(resolve => setImmediate(resolve));

async function until(check, rounds = 5000) {
    for (let i = 0; i < rounds && !check(); i++) await flush();
    assert.ok(check(), "condition not reached");
}

function linkedDir() {
    const dir = tempDir();
    fs.writeFileSync(path.join(dir, "creds.json"), JSON.stringify({ me: { id: "910000000000:1@s.whatsapp.net" } }));
    return dir;
}

function fakeSocket(behaviour) {
    const ev = new EventEmitter();
    return {
        ev,
        ended: 0,
        calls: [],
        emit(name, data) { ev.emit(name, data); },
        open() { ev.emit("connection.update", { connection: "open" }); },
        close(statusCode) {
            ev.emit("connection.update", { connection: "close", lastDisconnect: { error: { output: { statusCode } } } });
        },
        async sendMessage(jid, content) {
            this.calls.push({ jid, content });
            return behaviour?.sendMessage ? behaviour.sendMessage(jid, content) : { key: { id: "x" } };
        },
        async groupMetadata(jid) { return behaviour.groupMetadata(jid); },
        async groupFetchAllParticipating() { return behaviour.groupFetchAllParticipating(); },
        end() { this.ended++; },
    };
}

function harness({ allowQr = false, linked = true, onFatal, behaviour } = {}) {
    const authDir = linked ? linkedDir() : tempDir();
    const sockets = [];
    const configs = [];
    const qrs = [];
    const logs = { info: [], warn: [], error: [] };
    const saves = { count: 0 };
    const client = createWhatsAppClient({
        authDir,
        allowQr,
        onFatal,
        log: { info: m => logs.info.push(m), warn: m => logs.warn.push(m), error: m => logs.error.push(m) },
        deps: {
            makeSocket(config) {
                configs.push(config);
                const s = fakeSocket(behaviour);
                sockets.push(s);
                return s;
            },
            loadAuthState: async () => ({ state: { creds: {}, keys: {} }, saveCreds: async () => { saves.count++; } }),
            fetchVersion: async () => [2, 3000, 1],
            printQr: qr => qrs.push(qr),
        },
    });
    return { client, authDir, sockets, configs, qrs, logs, saves };
}

async function connected(options) {
    const h = harness(options);
    const started = h.client.start();
    await until(() => h.sockets.length === 1);
    h.sockets[0].open();
    await started;
    return h;
}

test("closeDecision follows the status code table", () => {
    for (const code of [401, 403, 411]) assert.deepEqual(closeDecision(code, 0), { action: "auth-required" });
    assert.deepEqual(closeDecision(440, 3), { action: "replaced" });
    assert.deepEqual(closeDecision(515, 4), { action: "reconnect", delayMs: 0 });
    assert.deepEqual(closeDecision(undefined, 0), { action: "reconnect", delayMs: 5000 });
    assert.deepEqual(closeDecision(428, 1), { action: "reconnect", delayMs: 10000 });
    assert.deepEqual(closeDecision(500, 3), { action: "reconnect", delayMs: 40000 });
    assert.deepEqual(closeDecision(408, 6), { action: "reconnect", delayMs: 300000 });
    assert.deepEqual(closeDecision(408, 20), { action: "reconnect", delayMs: 300000 });
});

test("hasLinkedSession detects a linked account without touching files", async () => {
    const dir = linkedDir();
    const before = fs.readFileSync(path.join(dir, "creds.json"), "utf8");
    assert.equal(await hasLinkedSession(dir), true);
    assert.equal(fs.readFileSync(path.join(dir, "creds.json"), "utf8"), before);

    const empty = tempDir();
    assert.equal(await hasLinkedSession(empty), false);
    assert.deepEqual(fs.readdirSync(empty), []);
    assert.equal(await hasLinkedSession(path.join(empty, "missing")), false);
    assert.equal(fs.existsSync(path.join(empty, "missing")), false);

    fs.writeFileSync(path.join(empty, "creds.json"), "{not json");
    assert.equal(await hasLinkedSession(empty), false);
    fs.writeFileSync(path.join(empty, "creds.json"), JSON.stringify({ me: { id: "" } }));
    assert.equal(await hasLinkedSession(empty), false);
    fs.writeFileSync(path.join(empty, "creds.json"), JSON.stringify({ noiseKey: {} }));
    assert.equal(await hasLinkedSession(empty), false);
});

test("start() without a session and without QR permission rejects and creates no socket", async () => {
    const h = harness({ linked: false });
    await assert.rejects(h.client.start(), err => err instanceof AuthRequiredError && /npm run login/.test(err.message));
    assert.equal(h.sockets.length, 0);
    assert.deepEqual(fs.readdirSync(h.authDir), []);
});

test("start() resolves when the connection opens and passes the expected socket config", async () => {
    const h = await connected();
    assert.equal(h.client.isReady(), true);
    assert.equal(h.logs.info.filter(m => /connected/i.test(m)).length, 1);
    const config = h.configs[0];
    assert.deepEqual(config.version, [2, 3000, 1]);
    assert.equal(config.printQRInTerminal, false);
    assert.equal(config.markOnlineOnConnect, false);
    assert.equal(config.syncFullHistory, false);
    assert.ok(config.auth && config.logger);
    await assert.rejects(h.client.start(), /already started/);
    h.client.stop();
});

test("a QR code without permission is an AuthRequiredError", async () => {
    const h = harness();
    const started = h.client.start();
    await until(() => h.sockets.length === 1);
    h.sockets[0].emit("connection.update", { qr: "QR-DATA" });
    await assert.rejects(started, AuthRequiredError);
    assert.deepEqual(h.qrs, []);
    assert.equal(h.client.isReady(), false);
    assert.equal(h.sockets[0].ended, 1);
});

test("a QR code with permission is printed with one instruction", async () => {
    const h = harness({ allowQr: true, linked: false });
    const started = h.client.start();
    await until(() => h.sockets.length === 1);
    h.sockets[0].emit("connection.update", { qr: "QR-1" });
    h.sockets[0].emit("connection.update", { qr: "QR-2" });
    await until(() => h.qrs.length === 2);
    assert.deepEqual(h.qrs, ["QR-1", "QR-2"]);
    assert.equal(h.logs.info.filter(m => /Linked devices/.test(m)).length, 1);
    h.sockets[0].open();
    await started;
    h.client.stop();
});

test("515 reconnects immediately", async t => {
    t.mock.timers.enable({ apis: ["setTimeout"] });
    const h = harness({ allowQr: true, linked: false });
    const started = h.client.start();
    await until(() => h.sockets.length === 1);
    h.sockets[0].close(515);
    t.mock.timers.tick(0);
    await until(() => h.sockets.length === 2);
    h.sockets[1].open();
    await started;
    assert.equal(h.client.isReady(), true);
    h.client.stop();
});

test("other close codes back off exponentially and the attempt counter resets after open", async t => {
    t.mock.timers.enable({ apis: ["setTimeout"] });
    const h = await connected();

    h.sockets[0].close(500);
    assert.equal(h.client.isReady(), false);
    assert.match(h.logs.warn.at(-1), /500.*5 s/);
    t.mock.timers.tick(4999);
    await flush();
    assert.equal(h.sockets.length, 1);
    t.mock.timers.tick(1);
    await until(() => h.sockets.length === 2);

    h.sockets[1].close(undefined);
    assert.match(h.logs.warn.at(-1), /10 s/);
    t.mock.timers.tick(10000);
    await until(() => h.sockets.length === 3);

    h.sockets[2].open();
    assert.equal(h.client.isReady(), true);
    assert.equal(h.logs.info.filter(m => /connected/i.test(m)).length, 2);

    h.sockets[2].close(428);
    assert.match(h.logs.warn.at(-1), /5 s/);
    t.mock.timers.tick(5000);
    await until(() => h.sockets.length === 4);
    h.client.stop();
});

test("440 before the first open rejects start() with SessionReplacedError", async t => {
    t.mock.timers.enable({ apis: ["setTimeout"] });
    const h = harness();
    const started = h.client.start();
    await until(() => h.sockets.length === 1);
    h.sockets[0].close(440);
    await assert.rejects(started, SessionReplacedError);
    t.mock.timers.tick(600000);
    await flush();
    assert.equal(h.sockets.length, 1);
});

test("401 after the first open calls onFatal and does not reconnect", async t => {
    t.mock.timers.enable({ apis: ["setTimeout"] });
    const fatal = [];
    const h = await connected({ onFatal: err => fatal.push(err) });
    h.sockets[0].close(401);
    assert.equal(fatal.length, 1);
    assert.ok(fatal[0] instanceof AuthRequiredError);
    assert.match(fatal[0].message, /npm run login/);
    assert.equal(h.client.isReady(), false);
    t.mock.timers.tick(600000);
    await flush();
    assert.equal(h.sockets.length, 1);
    assert.ok(fs.existsSync(path.join(h.authDir, "creds.json")));
});

test("events from a replaced socket are ignored", async t => {
    t.mock.timers.enable({ apis: ["setTimeout"] });
    const fatal = [];
    const h = await connected({ onFatal: err => fatal.push(err) });
    h.sockets[0].close(500);
    t.mock.timers.tick(5000);
    await until(() => h.sockets.length === 2);

    h.sockets[0].open();
    assert.equal(h.client.isReady(), false);
    h.sockets[0].close(401);
    h.sockets[0].emit("creds.update", {});
    await flush();
    assert.equal(fatal.length, 0);
    assert.equal(h.saves.count, 0);

    h.sockets[1].open();
    assert.equal(h.client.isReady(), true);
    h.client.stop();
});

test("stop() cancels a pending reconnect and is safe to repeat", async t => {
    t.mock.timers.enable({ apis: ["setTimeout"] });
    const h = await connected();
    h.sockets[0].close(500);
    h.client.stop();
    h.client.stop();
    t.mock.timers.tick(600000);
    await flush();
    assert.equal(h.sockets.length, 1);
    assert.equal(h.client.isReady(), false);
});

test("stop() ends the current socket", async () => {
    const h = await connected();
    h.client.stop();
    assert.equal(h.sockets[0].ended, 1);
    assert.equal(h.client.isReady(), false);
    assert.equal(await h.client.waitUntilReady(10), false);
});

test("waitUntilReady resolves on open or after the timeout", async () => {
    const h = harness();
    const started = h.client.start();
    assert.equal(await h.client.waitUntilReady(5), false);
    await until(() => h.sockets.length === 1);
    const waiting = h.client.waitUntilReady(5000);
    h.sockets[0].open();
    assert.equal(await waiting, true);
    await started;
    assert.equal(await h.client.waitUntilReady(0), true);
    h.client.stop();
});

test("sendText when not connected throws NotSentError and calls nothing", async t => {
    t.mock.timers.enable({ apis: ["setTimeout"] });
    const h = await connected();
    h.sockets[0].close(500);
    await assert.rejects(h.client.sendText("1@g.us", "hi"), NotSentError);
    assert.equal(h.sockets[0].calls.length, 0);
    h.client.stop();

    const fresh = harness();
    await assert.rejects(fresh.client.sendText("1@g.us", "hi"), NotSentError);
});

test("sendText calls sendMessage exactly once", async () => {
    const h = await connected();
    await h.client.sendText("120363000000000000@g.us", "hello");
    await h.client.sendText("120363000000000000@g.us", "again");
    assert.deepEqual(h.sockets[0].calls, [
        { jid: "120363000000000000@g.us", content: { text: "hello" } },
        { jid: "120363000000000000@g.us", content: { text: "again" } },
    ]);
    h.client.stop();
});

test("sendMessage failure becomes UncertainSendError without a retry", async () => {
    const h = await connected({ behaviour: { sendMessage: async () => { throw new Error("socket hang up"); } } });
    await assert.rejects(
        h.client.sendText("1@g.us", "hi"),
        err => err instanceof UncertainSendError && /socket hang up/.test(err.message),
    );
    assert.equal(h.sockets[0].calls.length, 1);
    h.client.stop();
});

test("no result within the timeout becomes UncertainSendError", async () => {
    const h = await connected({ behaviour: { sendMessage: () => new Promise(() => {}) } });
    await assert.rejects(h.client.sendText("1@g.us", "hi", { timeoutMs: 20 }), UncertainSendError);
    assert.equal(h.sockets[0].calls.length, 1);
    h.client.stop();
});

test("getGroup and listGroups map and sort group metadata", async () => {
    const groups = {
        "2@g.us": { id: "2@g.us", subject: "Zeta Alerts", participants: [{}, {}, {}] },
        "1@g.us": { id: "1@g.us", subject: "alpha jobs", participants: [{}] },
        "3@g.us": { id: "3@g.us", subject: "Beta Updates", participants: [] },
    };
    const h = await connected({
        behaviour: {
            groupMetadata: async jid => groups[jid],
            groupFetchAllParticipating: async () => groups,
        },
    });
    assert.deepEqual(await h.client.getGroup("2@g.us"), { id: "2@g.us", subject: "Zeta Alerts", size: 3 });
    assert.deepEqual(await h.client.listGroups(), [
        { id: "1@g.us", subject: "alpha jobs", size: 1 },
        { id: "3@g.us", subject: "Beta Updates", size: 0 },
        { id: "2@g.us", subject: "Zeta Alerts", size: 3 },
    ]);
    h.client.stop();
});

test("creds.update saves the credentials", async () => {
    const h = await connected();
    h.sockets[0].emit("creds.update", {});
    h.sockets[0].emit("creds.update", {});
    await until(() => h.saves.count === 2);
    h.client.stop();
});
