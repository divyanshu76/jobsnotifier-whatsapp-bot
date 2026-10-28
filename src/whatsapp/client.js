import fs from "node:fs/promises";
import path from "node:path";
import pino from "pino";

import { AuthRequiredError, NotSentError, SessionReplacedError, UncertainSendError } from "../errors.js";

const BASE_DELAY_MS = 5000;
const MAX_DELAY_MS = 300000;
const VERSION_TIMEOUT_MS = 10000;
const SILENT = { info() {}, warn() {}, error() {} };

// What to do after the connection closed. `attempt` = reconnects since the last successful open.
export function closeDecision(statusCode, attempt) {
    if ([401, 403, 411].includes(statusCode)) return { action: "auth-required" };
    if (statusCode === 440) return { action: "replaced" };
    if (statusCode === 515) return { action: "reconnect", delayMs: 0 };
    const n = Number.isInteger(attempt) && attempt > 0 ? attempt : 0;
    return { action: "reconnect", delayMs: Math.min(BASE_DELAY_MS * 2 ** n, MAX_DELAY_MS) };
}

// Read-only check of a Baileys multi-file auth folder.
export async function hasLinkedSession(authDir) {
    try {
        const creds = JSON.parse(await fs.readFile(path.join(authDir, "creds.json"), "utf8"));
        const id = creds?.me?.id;
        return typeof id === "string" && id.trim() !== "";
    } catch {
        return false;
    }
}

function defaultDeps(log) {
    const baileys = () => import("@whiskeysockets/baileys");
    return {
        async loadAuthState(authDir) {
            const { useMultiFileAuthState } = await baileys();
            return useMultiFileAuthState(authDir);
        },
        async fetchVersion() {
            let timer;
            try {
                const { fetchLatestBaileysVersion } = await baileys();
                const timeout = new Promise((_, reject) => {
                    timer = setTimeout(() => reject(new Error("timed out after 10 s")), VERSION_TIMEOUT_MS);
                    timer.unref?.();
                });
                const result = await Promise.race([fetchLatestBaileysVersion(), timeout]);
                // The library reports failures in the result instead of throwing.
                if (result?.error || !Array.isArray(result?.version)) throw result?.error ?? new Error("no version returned");
                return result.version;
            } catch (err) {
                log.warn(`Could not fetch the current WhatsApp Web version (${err?.message ?? err}); using the library default.`);
                return undefined;
            } finally {
                clearTimeout(timer);
            }
        },
        async makeSocket(config) {
            const { default: makeWASocket } = await baileys();
            return makeWASocket(config);
        },
        async printQr(qr) {
            const { default: qrcode } = await import("qrcode-terminal");
            qrcode.generate(qr, { small: true });
        },
    };
}

const toGroup = (meta, fallbackId) => ({
    id: meta?.id ?? fallbackId,
    subject: meta?.subject ?? "",
    size: Array.isArray(meta?.participants) ? meta.participants.length : 0,
});

export function createWhatsAppClient({ authDir, allowQr = false, log = SILENT, onFatal, deps = {} } = {}) {
    if (typeof authDir !== "string" || authDir === "") throw new TypeError("authDir is required");
    const d = { ...defaultDeps(log), ...deps };

    let started = false;
    let stopped = false;
    let everOpened = false;
    let connected = false;
    let socket = null;
    let attempt = 0;
    let reconnectTimer = null;
    let qrHintShown = false;
    let auth = null;
    let version;
    let logger = null;
    let pendingStart = null;
    const readyWaiters = new Set();

    const settleWaiters = value => {
        for (const resolve of readyWaiters) resolve(value);
        readyWaiters.clear();
    };

    function shutdown(reason) {
        stopped = true;
        connected = false;
        clearTimeout(reconnectTimer);
        reconnectTimer = null;
        const old = socket;
        socket = null;
        if (old) {
            try {
                old.end(reason);
            } catch {
                // already closed
            }
        }
        settleWaiters(false);
    }

    function fail(error) {
        shutdown(error);
        if (pendingStart) {
            pendingStart.reject(error);
            pendingStart = null;
        } else if (onFatal) {
            onFatal(error);
        } else {
            log.error(error.message);
        }
    }

    async function connect() {
        reconnectTimer = null;
        if (stopped) return;
        let sock;
        try {
            sock = await d.makeSocket({
                auth: auth.state,
                ...(version ? { version } : {}),
                logger,
                printQRInTerminal: false,
                markOnlineOnConnect: false,
                syncFullHistory: false,
            });
        } catch (err) {
            fail(err);
            return;
        }
        if (stopped) {
            try {
                sock.end(undefined);
            } catch {
                // ignore
            }
            return;
        }
        socket = sock;
        sock.ev.on("creds.update", () => {
            if (sock !== socket) return;
            Promise.resolve()
                .then(() => auth.saveCreds())
                .catch(err => log.warn(`Could not save WhatsApp credentials: ${err?.message ?? err}`));
        });
        sock.ev.on("connection.update", update => {
            if (sock !== socket || stopped) return;
            onConnectionUpdate(update ?? {});
        });
    }

    function onConnectionUpdate({ connection, lastDisconnect, qr }) {
        if (qr) {
            if (!allowQr) {
                fail(new AuthRequiredError("WhatsApp asked for a new QR code: this device is not linked. Run `npm run login` to link it."));
                return;
            }
            if (!qrHintShown) {
                qrHintShown = true;
                log.info("Scan the QR code with your phone: WhatsApp → Linked devices → Link a device.");
            }
            Promise.resolve()
                .then(() => d.printQr(qr))
                .catch(err => log.warn(`Could not print the QR code: ${err?.message ?? err}`));
        }

        if (connection === "open") {
            connected = true;
            attempt = 0;
            log.info("WhatsApp connected.");
            settleWaiters(true);
            if (!everOpened) {
                everOpened = true;
                pendingStart?.resolve();
                pendingStart = null;
            }
        } else if (connection === "close") {
            connected = false;
            const code = lastDisconnect?.error?.output?.statusCode;
            const decision = closeDecision(code, attempt);
            if (decision.action === "auth-required") {
                fail(new AuthRequiredError(
                    `WhatsApp login is no longer valid (code ${code}). The auth folder was kept: move it aside and link again with \`npm run login\`.`,
                ));
            } else if (decision.action === "replaced") {
                fail(new SessionReplacedError(
                    "Another WhatsApp client is using this session (code 440). Make sure only one copy of the bot runs.",
                ));
            } else {
                attempt++;
                socket = null;
                log.warn(`WhatsApp connection closed (code ${code ?? "unknown"}); reconnecting in ${decision.delayMs / 1000} s.`);
                reconnectTimer = setTimeout(connect, decision.delayMs);
            }
        }
    }

    function requireSocket() {
        if (!connected || !socket) throw new NotSentError("WhatsApp is not connected.");
        return socket;
    }

    return {
        async start() {
            if (started) throw new Error("WhatsApp client was already started.");
            started = true;
            if (!allowQr && !(await hasLinkedSession(authDir))) {
                stopped = true;
                throw new AuthRequiredError("No linked WhatsApp session found. Run `npm run login` to link this device first.");
            }
            auth = await d.loadAuthState(authDir);
            version = await d.fetchVersion();
            logger = pino({ level: process.env.WA_LOG_LEVEL || "silent" });
            if (stopped) throw new Error("WhatsApp client was stopped.");
            const opened = new Promise((resolve, reject) => {
                pendingStart = { resolve, reject };
            });
            connect();
            return opened;
        },

        isReady() {
            return connected;
        },

        waitUntilReady(timeoutMs) {
            if (connected) return Promise.resolve(true);
            if (stopped) return Promise.resolve(false);
            return new Promise(resolve => {
                const done = value => {
                    clearTimeout(timer);
                    readyWaiters.delete(done);
                    resolve(value);
                };
                const timer = setTimeout(() => done(false), timeoutMs);
                readyWaiters.add(done);
            });
        },

        async sendText(jid, text, { timeoutMs = 60000 } = {}) {
            if (!connected || !socket) throw new NotSentError("WhatsApp is not connected; the message was not sent.");
            const sock = socket;
            let timer;
            const timeout = new Promise((_, reject) => {
                timer = setTimeout(
                    () => reject(new UncertainSendError(`WhatsApp did not confirm the message within ${timeoutMs} ms.`)),
                    timeoutMs,
                );
            });
            // Exactly one attempt: a retry could post the message twice.
            const attemptSend = Promise.resolve().then(() => sock.sendMessage(jid, { text }));
            try {
                await Promise.race([attemptSend, timeout]);
            } catch (err) {
                if (err instanceof UncertainSendError) throw err;
                throw new UncertainSendError(err?.message ?? String(err), { cause: err });
            } finally {
                clearTimeout(timer);
                attemptSend.catch(() => {});
            }
        },

        async getGroup(jid) {
            const meta = await requireSocket().groupMetadata(jid);
            return toGroup(meta, jid);
        },

        async listGroups() {
            const all = await requireSocket().groupFetchAllParticipating();
            return Object.entries(all ?? {})
                .map(([id, meta]) => toGroup(meta, id))
                .sort((a, b) => a.subject.localeCompare(b.subject));
        },

        stop() {
            shutdown(undefined);
            if (pendingStart) {
                pendingStart.reject(new Error("WhatsApp client was stopped."));
                pendingStart = null;
            }
        },
    };
}
