import fs from "node:fs";
import path from "node:path";

export function isProcessAlive(pid) {
    if (!Number.isInteger(pid) || pid <= 0) return false;
    try {
        process.kill(pid, 0);
        return true;
    } catch (err) {
        return err.code === "EPERM";
    }
}

// Single-instance lock: a file holding the owner's PID. A lock left behind by a
// crashed process (PID no longer running) is taken over.
// Returns a release function, or null if another live process holds the lock.
export function acquireLock(file, pid = process.pid) {
    fs.mkdirSync(path.dirname(file), { recursive: true });

    for (let attempt = 0; attempt < 2; attempt++) {
        try {
            fs.writeFileSync(file, String(pid), { flag: "wx" });
            let released = false;
            return () => {
                if (released) return;
                released = true;
                try {
                    if (fs.readFileSync(file, "utf8").trim() === String(pid)) fs.rmSync(file);
                } catch {
                    // already gone
                }
            };
        } catch (err) {
            if (err.code !== "EEXIST") throw err;
            const owner = Number.parseInt(fs.readFileSync(file, "utf8"), 10);
            if (isProcessAlive(owner)) return null;
            fs.rmSync(file, { force: true });
        }
    }
    return null;
}

export function lockOwner(file) {
    try {
        const pid = Number.parseInt(fs.readFileSync(file, "utf8"), 10);
        return isProcessAlive(pid) ? pid : null;
    } catch {
        return null;
    }
}
