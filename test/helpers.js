import fs from "node:fs";
import os from "node:os";
import path from "node:path";

export function tempDir() {
    return fs.mkdtempSync(path.join(os.tmpdir(), "jobsnotifier-test-"));
}

// Minimal one-page PDF with a real text layer (one line of text per input line).
export function makePdf(text) {
    const esc = s => s.replace(/[()\\]/g, "\\$&");
    const content = `BT /F1 9 Tf 30 810 Td 11 TL ${text.split("\n").map(l => `(${esc(l)}) Tj T*`).join(" ")} ET`;
    const objects = [
        "<< /Type /Catalog /Pages 2 0 R >>",
        "<< /Type /Pages /Kids [3 0 R] /Count 1 >>",
        "<< /Type /Page /Parent 2 0 R /MediaBox [0 0 595 842] /Resources << /Font << /F1 5 0 R >> >> /Contents 4 0 R >>",
        `<< /Length ${Buffer.byteLength(content, "latin1")} >>\nstream\n${content}\nendstream`,
        "<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>",
    ];
    let pdf = "%PDF-1.4\n";
    const offsets = objects.map((obj, i) => {
        const offset = Buffer.byteLength(pdf, "latin1");
        pdf += `${i + 1} 0 obj\n${obj}\nendobj\n`;
        return offset;
    });
    const xref = Buffer.byteLength(pdf, "latin1");
    pdf += `xref\n0 ${objects.length + 1}\n0000000000 65535 f \n${offsets.map(o => `${String(o).padStart(10, "0")} 00000 n \n`).join("")}`;
    pdf += `trailer\n<< /Size ${objects.length + 1} /Root 1 0 R >>\nstartxref\n${xref}\n%%EOF`;
    return Buffer.from(pdf, "latin1");
}

// Mock WhatsApp sender. `behaviour` is called for each send and may throw.
export function mockSender({ ready = true, behaviour = () => {} } = {}) {
    const sent = [];
    let calls = 0;
    return {
        sent,
        ready,
        isReady() { return this.ready; },
        async waitUntilReady() { return this.ready; },
        async send(text) {
            await behaviour(text, calls++);
            sent.push(text);
        },
    };
}
