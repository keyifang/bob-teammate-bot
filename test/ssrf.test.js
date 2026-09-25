import test from "node:test";
import assert from "node:assert/strict";

import { assertUrlSafe, TOOL_SCHEMAS, executeTool } from "../tools.js";

// A negative control for every allowed case: if assertUrlSafe() ever returns
// { ok: true } for these, the tool is an open proxy into the host network and
// the "public URL is allowed" tests below mean nothing.

const BLOCKED = [
  ["http://127.0.0.1/", "loopback literal"],
  ["http://127.0.0.1:8080/admin", "loopback with port"],
  ["http://localhost/", "localhost name"],
  ["http://localhost./", "localhost with trailing dot"],
  ["http://[::1]/", "ipv6 loopback"],
  ["http://0.0.0.0/", "unspecified address"],
  ["http://10.0.0.5/", "private 10/8"],
  ["http://172.16.4.4/", "private 172.16/12"],
  ["http://192.168.1.1/", "private 192.168/16"],
  ["http://169.254.169.254/latest/meta-data/", "cloud metadata"],
  ["http://2130706433/", "decimal-encoded loopback"],
  ["http://0x7f000001/", "hex-encoded loopback"],
  ["http://[::ffff:127.0.0.1]/", "ipv4-mapped ipv6 loopback"],
  ["http://100.64.0.1/", "carrier-grade NAT"],
  ["file:///etc/passwd", "file scheme"],
  ["gopher://127.0.0.1/", "gopher scheme"],
  ["ftp://example.com/", "ftp scheme"],
  ["http://user:pass@example.com/", "embedded credentials"],
  ["not a url at all", "unparseable"],
  ["http://127.0.0.1.nip.io/", "hostname that resolves to loopback"],
];

for (const [url, why] of BLOCKED) {
  test(`assertUrlSafe rejects ${why}: ${url}`, async () => {
    const result = await assertUrlSafe(url);
    assert.equal(result.ok, false, `expected ${url} to be rejected`);
    assert.ok(result.reason, "a reason must be given");
  });
}

test("assertUrlSafe accepts an ordinary public https URL", async () => {
  const result = await assertUrlSafe("https://example.com/page");
  assert.equal(result.ok, true, result.reason ?? "");
});

test("assertUrlSafe accepts a public URL with a port", async () => {
  const result = await assertUrlSafe("https://example.com:8443/x");
  assert.equal(result.ok, true, result.reason ?? "");
});

test("a local name that does not resolve is rejected, not attempted", async () => {
  const result = await assertUrlSafe("http://bobbot.invalid/");
  assert.equal(result.ok, false);
});

test("executeTool rejects an unknown tool name", async () => {
  await assert.rejects(() => executeTool("rm_rf", {}), /Unknown tool/);
});

test("owl_research is not mislabeled as an open fetch", () => {
  assert.equal(TOOL_SCHEMAS.length, 2);
  const names = TOOL_SCHEMAS.map((t) => t.function.name).sort();
  assert.deepEqual(names, ["owl_research", "web_fetch"]);
});
