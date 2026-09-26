import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), "..");

// A reasoning model intermittently emits its scratchpad into `content` instead
// of `reasoning`. Observed live: Bob posted the model's internal monologue -
// an audit of its own style rules, the system prompt, and a message it had been
// asked to rewrite - straight into a group chat, across 3 chunked messages.
// That is a privacy leak and a display defect, so the detector below is pinned
// to the exact text that leaked.

// Loads the real functions out of server.js rather than re-implementing them,
// so the test cannot pass while the shipped logic is broken.
async function loadDetector() {
  const src = await readFile(path.join(ROOT, "server.js"), "utf8");
  const start = src.indexOf("const REASONING_LEAK_RE");
  const end = src.indexOf("function contentOf");
  assert.ok(start > 0 && end > start, "detector not found in server.js");
  return new Function(`${src.slice(start, end)}; return looksLikeReasoningLeak;`)();
}

const LEAKED_TEXT = `- Is 1-3 sentences (usually 1-2)
- No preamble, no greetings
- No restating what was asked
- Has opinions/suggest/push back/ask follow-up? That might not fit preserving meaning exactly. The original is just a question.`;

test("the detector is present and is actually used", async () => {
  const src = await readFile(path.join(ROOT, "server.js"), "utf8");
  assert.match(src, /looksLikeReasoningLeak/);
  // Used in two places: to strip a leak at the transport boundary, and to
  // reject one that still slips through to contentOf.
  assert.ok(
    (src.match(/looksLikeReasoningLeak\(/g) ?? []).length >= 3,
    "the detector must be called by the scrubber and by contentOf"
  );
});

test("negative control: the real leaked text must be detected", async () => {
  const detect = await loadDetector();
  assert.equal(
    detect(LEAKED_TEXT),
    true,
    "if this returns false the guard is inert and the leak reaches users again"
  );
});

test("a scratchpad with no bullets is still caught", async () => {
  const detect = await loadDetector();
  const narrated = `Let me just rewrite the input text into a casual group chat message.
Step 1: remove the prefix.
Step 2: keep the meaning.
Step 3: output only the rewrite.`;
  assert.equal(detect(narrated), true);
});

test("a genuine short reply is not flagged", async () => {
  const detect = await loadDetector();
  for (const text of [
    "hey ky, bob here, ai teammate. what up?",
    "im good, all running smooth. whats u workin on?",
    "malacca is a solid pick - 1h from singapore, great food",
  ]) {
    assert.equal(detect(text), false, `false positive on: ${text}`);
  }
});

test("a genuine bullet list is not flagged", async () => {
  // The dangerous failure mode of this guard is rejecting a real answer, so the
  // common reply shapes must survive it.
  const detect = await loadDetector();
  for (const text of [
    "- book flights\n- check visa requirements\n- tell maya the dates",
    "here are the steps:\n- open the app\n- tap settings\n- scroll down",
    "1. fly on the 3rd\n2. hotel near the centre\n3. leave a day for the museum",
  ]) {
    assert.equal(detect(text), false, `false positive on: ${text.replace(/\n/g, " / ")}`);
  }
});

test("a longer real answer is not flagged", async () => {
  const detect = await loadDetector();
  const text =
    "ok so i think we should go with postgres. better tooling, and the relational " +
    "model fits what we're building. mongo would be quicker to prototype but we'd " +
    "hit schema pain later. which one were we leaning toward?";
  assert.equal(detect(text), false);
});

test("the scrubber moves a leak out of content before anything is sent", async () => {
  const src = await readFile(path.join(ROOT, "server.js"), "utf8");
  // The defence in depth: even before contentOf can reject it, the transport
  // layer relocates the scratchpad so no caller can send it.
  assert.match(src, /message\.content = null/);
  assert.match(src, /message\.reasoning = /);
  assert.match(src, /moved to reasoning|moving it to reasoning/);
});

// A free reasoning model can also degenerate into repetition. Observed live:
// "The networkellsellsellsellsells this the rigor withellsells deep al of the
// user's request: ..." would have been posted verbatim into a group chat.
async function loadDegenerate() {
  const src = await readFile(path.join(ROOT, "server.js"), "utf8");
  const start = src.indexOf("function looksDegenerate");
  const end = src.indexOf("function contentOf");
  assert.ok(start > 0 && end > start, "degeneracy check not found in server.js");
  return new Function(`${src.slice(start, end)}; return looksDegenerate;`)();
}

test("negative control: observed degenerate output must be rejected", async () => {
  const isDegenerate = await loadDegenerate();
  assert.equal(
    isDegenerate(
      "The networkellsellsellsellsells this the rigor withellsells deep al of the user's request: Recent messages: LiveTester"
    ),
    true
  );
});

test("a repeated word is degenerate", async () => {
  const isDegenerate = await loadDegenerate();
  assert.equal(isDegenerate("aaa aaa aaa aaa aaa aaa aaa aaa aaa aaa aaa aaa aaa"), true);
});

test("a real reply is not degenerate", async () => {
  const isDegenerate = await loadDegenerate();
  for (const text of [
    "hey ky, bob here, ai teammate. what up?",
    "malacca is a solid pick - 1h from singapore, great food and cheap hotels too",
    "ok so i think we should go with postgres. better tooling, and the relational model fits what we are building. which one were we leaning toward?",
    "hey, yep - the switch 2 launched in june 2025 with a bigger screen and faster cpu. main complaints so far are battery life and the game library. want details?",
  ]) {
    assert.equal(isDegenerate(text), false, `false positive on: ${text}`);
  }
});

test("a reply that repeats a word a few times is still fine", async () => {
  // Repetition is normal in speech; only saturation is a defect.
  const isDegenerate = await loadDegenerate();
  assert.equal(
    isDegenerate("yeah yeah, that works for me. we can do it that way and it will be fine with the team"),
    false
  );
});

test("the final tool hop forces an answer instead of allowing an endless chain", async () => {
  const src = await readFile(path.join(ROOT, "server.js"), "utf8");
  // Without this, a model that keeps requesting tools returns null content and
  // the user sees nothing.
  assert.match(src, /tool_choice: isFinalHop \? "none" : "auto"/);
  assert.match(src, /isFinalHop = hops \+ 1 >= 3/);
});
