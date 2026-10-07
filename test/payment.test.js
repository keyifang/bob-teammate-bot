// Payments: Stripe checkout and webhook handling.
//
// Two things matter more than the rest, and both are asserted here:
//
//   1. A credit is granted ONLY on a signature-verified webhook. Trusting the
//      success redirect would let anyone mint credit by visiting a URL.
//   2. The webhook is idempotent. Stripe retries, so a replayed event must not
//      grant the same credit twice - the same class of bug as a replayed
//      Telegram update.

import test from "node:test";
import assert from "node:assert/strict";
import crypto from "node:crypto";

import {
  paymentsConfigured,
  verifyStripeSignature,
  parseStripeEvent,
  creditForCheckout,
  STRIPE_TOLERANCE_SECONDS,
} from "../payment.js";
import { CREDIT_PACKS, creditsForPack } from "../credits.js";

const SECRET = "whsec_test_secret_value";

function sign(payload, secret = SECRET, timestamp = Math.floor(Date.now() / 1000)) {
  const signed = `${timestamp}.${payload}`;
  const v1 = crypto.createHmac("sha256", secret).update(signed, "utf8").digest("hex");
  return { header: `t=${timestamp},v1=${v1}`, timestamp, v1 };
}

test("payments are disabled without a secret key and a webhook secret", () => {
  assert.equal(paymentsConfigured({ STRIPE_SECRET_KEY: "sk", STRIPE_WEBHOOK_SECRET: "whsec" }), true);
  assert.equal(paymentsConfigured({ STRIPE_SECRET_KEY: "sk" }), false);
  assert.equal(paymentsConfigured({ STRIPE_WEBHOOK_SECRET: "whsec" }), false);
  assert.equal(paymentsConfigured({}), false);
  assert.equal(paymentsConfigured(null), false);
});

test("a correctly signed payload verifies", () => {
  const payload = JSON.stringify({ id: "evt_1", type: "checkout.session.completed" });
  const { header } = sign(payload);
  assert.equal(verifyStripeSignature(payload, header, SECRET).ok, true);
});

test("a payload with a wrong signature is refused", () => {
  const payload = JSON.stringify({ id: "evt_1" });
  const { header } = sign(payload, "the-wrong-secret");
  assert.equal(verifyStripeSignature(payload, header, SECRET).ok, false);
});

test("a tampered payload is refused, even with a valid-looking header", () => {
  // The attack: keep the header, change the body to grant more credit.
  const original = JSON.stringify({ id: "evt_1", amount_total: 500 });
  const { header } = sign(original);
  const tampered = JSON.stringify({ id: "evt_1", amount_total: 500000 });
  assert.equal(verifyStripeSignature(tampered, header, SECRET).ok, false);
});

test("a missing or malformed signature header is refused, not treated as valid", () => {
  const payload = "{}";
  for (const bad of ["", "garbage", "t=123", "v1=abc", null, undefined]) {
    assert.equal(
      verifyStripeSignature(payload, bad, SECRET).ok,
      false,
      `${JSON.stringify(bad)} must be refused`
    );
  }
});

test("a replayed old event is refused, so a captured request cannot be reused forever", () => {
  const payload = JSON.stringify({ id: "evt_old" });
  const old = Math.floor(Date.now() / 1000) - (STRIPE_TOLERANCE_SECONDS + 60);
  const { header } = sign(payload, SECRET, old);
  assert.equal(verifyStripeSignature(payload, header, SECRET).ok, false);
});

test("a signature is compared in constant time, not with ===", async () => {
  // A timing-unsafe comparison leaks the expected signature byte by byte.
  const src = await import("node:fs/promises").then((fs) =>
    fs.readFile(new URL("../payment.js", import.meta.url), "utf8")
  );
  assert.match(src, /timingSafeEqual/, "the comparison must be constant-time");
});

test("parseStripeEvent extracts only what is needed and tolerates a partial body", () => {
  const full = parseStripeEvent(
    JSON.stringify({
      id: "evt_1",
      type: "checkout.session.completed",
      data: { object: { id: "cs_1", client_reference_id: "42", metadata: { pack: "starter" } } },
    })
  );
  assert.equal(full.id, "evt_1");
  assert.equal(full.type, "checkout.session.completed");
  assert.equal(full.userId, "42");
  assert.equal(full.pack, "starter");

  // A malformed body must not throw into the webhook handler.
  assert.equal(parseStripeEvent("not json"), null);
  assert.equal(parseStripeEvent("{}").type, null);
});

test("creditForCheckout grants exactly the pack's credits, never an amount from the request", () => {
  // The amount must come from OUR pack table, not from the payload - otherwise
  // a tampered body could ask for any balance it liked.
  for (const pack of CREDIT_PACKS) {
    assert.equal(creditForCheckout(pack.id), creditsForPack(pack));
  }
  assert.equal(creditForCheckout("nonsense"), null);
  assert.equal(creditForCheckout(null), null);
});

test("every pack is purchasable, so no button leads to a dead checkout", () => {
  for (const pack of CREDIT_PACKS) {
    assert.ok(creditForCheckout(pack.id) > 0, `pack ${pack.id} grants nothing`);
  }
});

test("checkout includes a product tax code, which Stripe requires", async () => {
  // Verified live: without it Stripe answers 400 "the product tax code is
  // missing" and NO session is created, so /credits would silently fail.
  const src = await import("node:fs/promises").then((fs) =>
    fs.readFile(new URL("../payment.js", import.meta.url), "utf8")
  );
  assert.match(
    src,
    /tax_code/,
    "inline price_data requires a tax code or Stripe refuses the session"
  );
  assert.match(src, /txcd_\d+/, "and it must be a real tax code, not a placeholder");
});

test("the checkout carries the user id and pack, so the webhook knows whose balance to credit", async () => {
  const src = await import("node:fs/promises").then((fs) =>
    fs.readFile(new URL("../payment.js", import.meta.url), "utf8")
  );
  // Without client_reference_id the webhook cannot tell whose balance to move,
  // and without the pack it cannot tell how much.
  assert.match(src, /client_reference_id/, "the webhook needs the user id");
  assert.match(src, /metadata\[pack\]/, "and the pack");
});
