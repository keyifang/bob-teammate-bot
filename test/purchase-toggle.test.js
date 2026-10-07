// Purchase kill-switch.
//
// Purchases can be disabled WITHOUT removing the integration, so a deployment
// can be switched to free testing and back with one environment variable and no
// code change or redeploy of the payment path.
//
// The important property is that "disabled" is REFUSED, not silently ignored:
// a user tapping a pack button must be told why, exactly as they are when
// payments are unconfigured. A button that appears to work and charges nobody
// is worse than one that explains itself.

import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), "..");

async function serverSource() {
  return (await readFile(path.join(ROOT, "server.js"), "utf8")).replace(/\r\n/g, "\n");
}

test("purchases can be disabled by an environment variable", async () => {
  const src = await serverSource();
  assert.match(
    src,
    /purchasesEnabled/,
    "there must be a switch, so testing mode is one env var rather than a code change"
  );
});

test("the switch defaults to ON, so forgetting it never silently disables payments", async () => {
  const { purchasesEnabled } = await import("../payment.js");
  assert.equal(
    purchasesEnabled({}),
    true,
    "an unset variable must leave purchasing enabled - the safe default is the real behaviour"
  );
  assert.equal(purchasesEnabled({ CREDIT_PURCHASES_ENABLED: "false" }), false);
  assert.equal(purchasesEnabled({ CREDIT_PURCHASES_ENABLED: "FALSE" }), false);
  assert.equal(purchasesEnabled({ CREDIT_PURCHASES_ENABLED: "0" }), false);
  assert.equal(purchasesEnabled({ CREDIT_PURCHASES_ENABLED: "no" }), false);
});

test("nonsense values leave purchasing enabled rather than guessing", async () => {
  // Guessing at an unrecognised value could disable payments in production by
  // accident. Anything not explicitly false stays on.
  const { purchasesEnabled } = await import("../payment.js");
  // Whitespace is trimmed first, so "off " still disables - a stray space
  // should not defeat the switch. These are values that mean nothing and must
  // therefore NOT disable it.
  for (const v of ["", "maybe", "2", "null", "nope"]) {
    assert.equal(
      purchasesEnabled({ CREDIT_PURCHASES_ENABLED: v }),
      true,
      `${JSON.stringify(v)} must not disable purchases`
    );
  }
});

test("a disabled purchase explains itself instead of failing silently", async () => {
  const src = await serverSource();
  const start = src.indexOf('cb.action === "buy"');
  const body = src.slice(start, src.indexOf("\n  }", start));
  assert.match(
    body,
    /!purchasesEnabled\(\)/,
    "the buy handler must check the switch"
  );
  // The refusal must be shown to the user, not swallowed.
  assert.match(
    body,
    /not (?:taking|enabled)|paused|turned off/i,
    "the user must be told why nothing happened"
  );
});

test("the webhook refuses to grant credit while purchasing is disabled", async () => {
  // The switch has to cover the WEBHOOK, not just the button. Otherwise a
  // checkout started before the switch was flipped would still grant credit.
  const src = await serverSource();
  const start = src.indexOf('app.post("/stripe-webhook"');
  const body = src.slice(start, src.indexOf("\n});", start));
  assert.match(
    body,
    /purchasesEnabled\(\)/,
    "the webhook must also honour the switch, or in-flight checkouts still credit"
  );
});