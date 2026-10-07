// Telegram command and inline-keyboard layer.
//
// Two constraints shape this, and both are asserted here:
//
//   - callback_data is capped at 64 bytes by Telegram. A raw OpenRouter model id
//     is up to 39 characters, so `m:m:openrouter:nvidia/nemotron-3-ultra-550b-a55b:free`
//     is 53 and one longer id would silently break the button. The callback
//     carries an INDEX into the registry instead, which is validated on the way
//     back so a tampered callback cannot select an unregistered model.
//
//   - the flow keeps no server-side state. On serverless an invocation shares
//     no memory with the last one, so the callback must carry everything needed
//     to act on it.

import test from "node:test";
import assert from "node:assert/strict";

import {
  TELEGRAM_CALLBACK_LIMIT,
  parseCommand,
  buildProviderKeyboard,
  buildModelKeyboard,
  buildCreditKeyboard,
  buildFormatKeyboard,
  parseCallback,
  describeModelChoice,
} from "../commands.js";
import { listProviders } from "../providers.js";
import { CREDIT_PACKS } from "../credits.js";

test("parseCommand recognises a command with and without a bot suffix", () => {
  assert.deepEqual(parseCommand("/bot_model"), { command: "bot_model", args: "" });
  assert.deepEqual(parseCommand("/bot_model@bob_friendly_ai_bot"), {
    command: "bot_model",
    args: "",
  });
  assert.deepEqual(parseCommand("/export csv"), { command: "export", args: "csv" });
  assert.deepEqual(parseCommand("  /credits  "), { command: "credits", args: "" });
});

test("parseCommand returns null for ordinary text, so it is never mistaken for a command", () => {
  // Ordinary text, an empty string, a double slash, and a URL. These are the
  // shapes that must never become a command.
  //
  // "/not a command/" is deliberately NOT here: it parses as the command "not"
  // with the argument "a command/", which is exactly what Telegram itself does
  // with it. Asserting otherwise would mean diverging from the client, and an
  // unrecognised command is handled safely downstream.
  for (const t of ["hello", "@bob hi", "", "//x", "http://x/y", "/", " / "]) {
    assert.equal(parseCommand(t), null, `${JSON.stringify(t)} must not parse as a command`);
  }
});

test("a command name must end at a boundary, so a slash cannot extend it", () => {
  // The project commands carry paths in their arguments, so a slash AFTER the
  // name is legitimate - and one inside the name is not.
  assert.equal(parseCommand("/save_project app src/index.js::code").command, "save_project");
  assert.equal(parseCommand("/export csv").args, "csv");
  assert.equal(parseCommand("/bot_model@bob_friendly_ai_bot").command, "bot_model");
  assert.equal(parseCommand("/a/b"), null, "a slash inside the name is not a command");
});

test("the provider keyboard offers every registered provider", () => {
  const kb = buildProviderKeyboard();
  const flat = kb.inline_keyboard.flat();
  assert.equal(flat.length, listProviders().length);
  for (const p of listProviders()) {
    assert.ok(
      flat.some((b) => b.text.includes(p.label)),
      `provider ${p.id} is missing from the keyboard`
    );
  }
});

test("every callback_data is within Telegram's 64-byte limit", () => {
  const all = [
    ...buildProviderKeyboard().inline_keyboard.flat(),
    ...buildCreditKeyboard().inline_keyboard.flat(),
    ...buildFormatKeyboard().inline_keyboard.flat(),
    ...listProviders().flatMap((p) => buildModelKeyboard(p.id).inline_keyboard.flat()),
  ];
  assert.ok(all.length > 0);
  for (const b of all) {
    const bytes = Buffer.byteLength(b.callback_data, "utf8");
    assert.ok(
      bytes <= TELEGRAM_CALLBACK_LIMIT,
      `callback "${b.callback_data}" is ${bytes} bytes, over the ${TELEGRAM_CALLBACK_LIMIT} limit`
    );
  }
});

test("the model keyboard offers exactly that provider's models", () => {
  for (const p of listProviders()) {
    const kb = buildModelKeyboard(p.id);
    const flat = kb.inline_keyboard.flat();
    assert.equal(flat.length, p.models.length, `${p.id} keyboard size`);
    for (const m of p.models) {
      assert.ok(
        flat.some((b) => b.text.includes(m.label)),
        `${p.id}/${m.id} missing from its keyboard`
      );
    }
  }
});

test("the model keyboard refuses an unknown provider rather than producing an empty keyboard", () => {
  assert.equal(buildModelKeyboard("ghost"), null);
});

test("a provider callback round-trips to the provider", () => {
  const kb = buildProviderKeyboard();
  for (const b of kb.inline_keyboard.flat()) {
    const parsed = parseCallback(b.callback_data);
    assert.equal(parsed.action, "provider");
    assert.ok(listProviders().some((p) => p.id === parsed.provider));
  }
});

test("a model callback round-trips to the exact model, by index", () => {
  for (const p of listProviders()) {
    const flat = buildModelKeyboard(p.id).inline_keyboard.flat();
    for (const [i, b] of flat.entries()) {
      const parsed = parseCallback(b.callback_data);
      assert.equal(parsed.action, "model");
      assert.equal(parsed.provider, p.id);
      assert.equal(parsed.model, p.models[i].id, "the index must resolve to the same model");
    }
  }
});

test("a tampered model index resolves to null rather than an arbitrary model", () => {
  // A crafted callback must not select something outside the registry.
  assert.equal(parseCallback("m:m:openrouter:999").model, null);
  assert.equal(parseCallback("m:m:openrouter:-1").model, null);
  assert.equal(parseCallback("m:m:openrouter:abc").model, null);
  assert.equal(parseCallback("m:m:ghost:0").model, null);
});

test("a malformed or foreign callback is ignored, never acted on", () => {
  for (const bad of ["", "garbage", "m", "m:", "m:m", "x:y:z", null, undefined, "m:m:openrouter"]) {
    const parsed = parseCallback(bad);
    assert.equal(parsed.action, null, `${JSON.stringify(bad)} must not produce an action`);
  }
});

test("the credit keyboard offers every pack, with its price and bonus", () => {
  const kb = buildCreditKeyboard();
  const flat = kb.inline_keyboard.flat();
  assert.equal(flat.length, CREDIT_PACKS.length);
  for (const pack of CREDIT_PACKS) {
    const btn = flat.find((b) => b.callback_data === `c:${pack.id}`);
    assert.ok(btn, `pack ${pack.id} missing`);
    assert.ok(btn.text.includes(pack.label));
  }
});

test("a credit callback resolves to a real pack, and a tampered one to null", () => {
  assert.equal(parseCallback("c:starter").pack, "starter");
  assert.equal(parseCallback("c:nonsense").pack, null);
});

test("the format keyboard offers every export format", () => {
  const kb = buildFormatKeyboard();
  const flat = kb.inline_keyboard.flat();
  for (const id of ["pdf", "html", "markdown", "text", "csv"]) {
    assert.ok(
      flat.some((b) => b.callback_data === `e:${id}`),
      `format ${id} missing from the keyboard`
    );
  }
});

test("a format callback resolves to a registered format, and a tampered one to null", () => {
  assert.equal(parseCallback("e:pdf").format, "pdf");
  assert.equal(parseCallback("e:exe").format, null);
});

test("describeModelChoice says whether a key is still needed", () => {
  const free = describeModelChoice("openrouter", "nvidia/nemotron-3-ultra-550b-a55b:free");
  assert.match(free, /Nemotron/i);
  // A free model needs no key, which is the whole point of the free tier.
  assert.equal(free.includes("key"), false);

  const paid = describeModelChoice("openrouter", "z-ai/glm-5.3-flash");
  assert.match(paid, /GLM/i);
});

test("describeModelChoice is null-safe for an unknown pair", () => {
  assert.equal(describeModelChoice("ghost", "x"), null);
  assert.equal(describeModelChoice("openrouter", "ghost"), null);
});

test("keyboard rows stay narrow enough to render on a phone", () => {
  for (const kb of [
    buildProviderKeyboard(),
    buildCreditKeyboard(),
    buildFormatKeyboard(),
    ...listProviders().map((p) => buildModelKeyboard(p.id)),
  ]) {
    for (const row of kb.inline_keyboard) {
      assert.ok(row.length <= 2, `a row of ${row.length} buttons is too wide for a phone`);
    }
  }
});
