import assert from "node:assert/strict";
import { test } from "node:test";

import { fetchBinary, isPrivateAddress, isPublicHttpUrl, probeUrl } from "../src/http.js";
import { collectNotification } from "../src/vacancy/collect.js";

// Security review finding: links found on third-party pages must not reach this PC or the
// local network, and unconfirmed links must not be probed.

test("private, loopback, link-local and special addresses are recognised", () => {
    for (const ip of ["127.0.0.1", "10.1.2.3", "172.16.0.1", "172.31.255.255", "192.168.1.1", "169.254.169.254", "100.64.0.1", "0.0.0.0",
        "::1", "fc00::1", "fd12::1", "fe80::1", "::ffff:127.0.0.1", "::ffff:192.168.0.10"]) {
        assert.equal(isPrivateAddress(ip), true, ip);
    }
    for (const ip of ["8.8.8.8", "164.100.1.1", "172.32.0.1", "2606:4700::1111"]) assert.equal(isPrivateAddress(ip), false, ip);
});

test("only public http(s) URLs on default ports with a DNS name are allowed", () => {
    assert.equal(isPublicHttpUrl("https://upsc.gov.in/apply"), true);
    for (const url of ["http://127.0.0.1/", "http://[::1]/", "http://169.254.169.254/latest/", "http://localhost:3000/", "http://router.local/",
        "https://example.gov.in:8443/", "file:///C:/Windows/win.ini", "https://user@example.gov.in/", "http://10.0.0.5/admin", "http://intranet/"]) {
        assert.equal(isPublicHttpUrl(url), false, url);
    }
});

test("probeUrl and fetchBinary refuse local targets without making a request", async () => {
    let calls = 0;
    const get = async () => { calls++; return { status: 200, data: { destroy() {} } }; };
    await assert.rejects(probeUrl("http://127.0.0.1:8080/", { get }), /Blocked/);
    await assert.rejects(probeUrl("http://169.254.169.254/latest/meta-data/", { get }), /Blocked/);
    await assert.rejects(fetchBinary("http://localhost/secret.pdf", { get }), /Blocked/);
    assert.equal(calls, 0);
});

test("probeUrl passes the public-only agents and redirect guard to every request", async () => {
    let options;
    const get = async (url, o) => { options = o; return { status: 200, data: { destroy() {} } }; };
    assert.equal(await probeUrl("https://upsc.gov.in/", { get }), 200);
    assert.ok(options.httpsAgent && options.httpAgent, "agents with a public-only DNS lookup");
    assert.throws(() => options.beforeRedirect({ protocol: "http:", hostname: "127.0.0.1", path: "/" }), /Blocked redirect/);
    assert.doesNotThrow(() => options.beforeRedirect({ protocol: "https:", hostname: "rrbapply.gov.in", path: "/" }));
});

test("the detailed format never probes an unconfirmed apply link", async () => {
    const html = `<html><body><table>
        <tr><td>Name Of Post :</td><td>Some Post 2026</td></tr>
        <tr><td>Apply Online</td><td><a href="https://apply.unknown-board.example/">Click Here</a></td></tr>
        <tr><td>Official Website</td><td><a href="https://board.example.gov.in/">Site</a></td></tr>
    </table></body></html>`;
    const probed = [];
    const { model } = await collectNotification({ url: "https://www.sarkariresult.com/x/" }, "latestJob", {
        fetchPage: async () => html,
        fetchBinary: async () => { throw new Error("no pdf"); },
        probe: async url => { probed.push(url); return 200; },
        log: { info() {}, warn() {}, error() {} },
    });
    assert.equal(model.apply.trust, "unconfirmed");
    assert.deepEqual(probed, []);
    assert.equal(model.apply.status, undefined, "no HTTP status recorded for unconfirmed links");
});

// --- Security review round 2 -------------------------------------------------------------

test("IPv6: every IPv4-mapped / compatible / NAT64 / 6to4 / Teredo form is blocked", () => {
    for (const ip of [
        "::ffff:7f00:1", "0:0:0:0:0:ffff:127.0.0.1", "::ffff:0a00:0001", "::127.0.0.1", "::7f00:1",
        "64:ff9b::7f00:1", "64:ff9b::808:808", "2002:7f00:1::", "2002:c0a8:101::1",
        "2001:0:4136:e378:8000:63bf:3fff:fdd2", "2001:db8::1", "fe80::1%eth0", "::", "ff02::1", "fd00::1",
    ]) {
        assert.equal(isPrivateAddress(ip), true, ip);
    }
    for (const ip of ["2606:4700::1111", "2404:6800:4009:80b::200e", "2a00:1450:4001:81a::200e"]) assert.equal(isPrivateAddress(ip), false, ip);
});

test("trailing-dot hosts are not treated as public URLs", () => {
    assert.equal(isPublicHttpUrl("http://localhost./"), false);
    assert.equal(isPublicHttpUrl("https://upsc.gov.in./"), false);
});
