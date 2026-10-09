// Protocol markup must never reach a chat.
//
// OBSERVED (live, 2026-10-08): asked a question Bob answered "search is hitting
// a limit", the user pushed back, and Bob replied with this, verbatim, in a
// Telegram group:
//
//     <tool_call>
//     <function=web_fetch>
//     <parameter=url>
//     https://www.checkpointsg.com/haze
//     </parameter>
//     </function>
//     </tool_call>
//
// The model meant to call the tool and the provider rendered the call as TEXT.
// The existing detector only knew two shapes - prose reasoning, and a bulleted
// self-audit - so this third shape passed straight through.
//
// This is deliberately written against the CLASS, not this one string: models
// emit tool calls as text in many dialects, and a fix that only matches the
// observed example fails on the next provider that spells it differently.

import test from "node:test";
import assert from "node:assert/strict";

// Built from char codes: an escaped newline written literally gets mangled by
// whatever writes this file, and a broken loader would silently pass nothing.
const LF = String.fromCharCode(10);
const CRLF = new RegExp(String.fromCharCode(13, 10), "g");
const CLOSE = LF + "}" + LF;
const NL = LF;

// Extracts the detector from server.js the same way the retry suite does, so the
// test runs the REAL function rather than a copy that can drift.
async function detector() {
  const { readFile } = await import("node:fs/promises");
  const path = await import("node:path");
  const { fileURLToPath } = await import("node:url");
  const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), "..");

  const src = (await readFile(path.join(ROOT, "server.js"), "utf8")).replace(/\r\n/g, "\n");
  // Start above the constants the detector closes over (ZWSP, ZWNP, the
  // regexes), not at REASONING_LEAK_RE - or the extracted function throws
  // ReferenceError instead of testing anything.
  const start = src.indexOf("const ZWSP =");
  const end = src.indexOf("\n}\n", src.indexOf("function looksLikeReasoningLeak"));
  const body = src.slice(start, end + 2);
  return new Function(`${body}; return looksLikeReasoningLeak;`)();
}


// Loads parseTextToolCall from server.js, so the test runs the shipped parser.
async function parser() {
  const { readFile } = await import("node:fs/promises");
  const path = await import("node:path");
  const { fileURLToPath } = await import("node:url");
  const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), "..");
  const raw = await readFile(path.join(ROOT, "server.js"), "utf8");
  const src = raw.replace(CRLF, LF);
  const start = src.indexOf("const ZWSP =");
  const end = src.indexOf(CLOSE, src.indexOf("function parseTextToolCall")) + CLOSE.length;
  // new Function cannot parse "export", so the keyword is stripped from the
  // slice. It is removed, not renamed - the function body is unchanged.
  const body = src.slice(start, end).replace(/^export\s+/m, "");
  return new Function(body + "; return parseTextToolCall;")();
}

test("the exact text that leaked into the chat is rejected", async () => {
  const leak = await detector();
  const observed = [
    "<tool_call>",
    "<function=web_fetch>",
    "<parameter=url>",
    "https://www.checkpointsg.com/haze",
    "</parameter>",
    "</function>",
    "</tool_call>",
  ].join("\n");
  assert.equal(leak(observed), true, "the observed leak must be caught");
});

test("tool-call markup is caught in the dialects models actually emit", async () => {
  const leak = await detector();
  const dialects = [
    // Zero-width space variants - the observed one.
    "<tool_call>\n<function=web_fetch>\n<parameter=url>\nhttps://x.test\n</parameter>\n</function>\n</tool_call>",
    // Plain ASCII.
    "<tool_call>\n<function=get_weather>\n<parameter=city>\nParis\n</parameter>\n</function>\n</tool_call>",
    // Self-closing / attribute style, e.g. Hermes and Llama dialects.
    "<tool_call>\n{\"name\": \"web_search\", \"arguments\": {\"query\": \"psi singapore\"}}\n</tool_call>",
    "<tool_call>{\"name\":\"web_fetch\",\"arguments\":{\"url\":\"https://x.test\"}}</tool_call>",
    // Markdown-fenced.
    "```tool_call\nweb_fetch(url='https://x.test')\n```",
    // Bare XML-ish, no wrapper.
    "<function=web_search><parameter=query>news</parameter></function>",
    // Brace-delimited, as some providers render.
    "{tool_call: {name: web_fetch, arguments: {url: https://x.test}}}",
    // Streamed newline variants.
    "<tool_call>\n<function=web_fetch>\n<parameter=url>\nhttps://x.test\n</parameter>\n</function>\n</tool_call>",
  ];
  for (const d of dialects) {
    assert.equal(leak(d), true, `must catch: ${d.slice(0, 60).replace(/\n/g, "\\n")}`);
  }
});

test("a legitimate answer that merely MENTIONS a tool is not rejected", async () => {
  const leak = await detector();
  // Over-rejection is its own failure: Bob would refuse to answer a fair
  // question, and the user would never learn why.
  const legitimate = [
    "You can use the tool call feature for that - try asking me to search.",
    "I looked it up with web_fetch and NEA reports PSI 42.",
    "Run the function call in your terminal to test it directly.",
    "Here's how the tool works:\n- it takes a query\n- it returns results",
  ];
  for (const l of legitimate) {
    assert.equal(leak(l), false, `must NOT reject: ${l.slice(0, 50)}`);
  }
});

test("a bare <parameter> tag is rejected on purpose, and the cost is stated", async () => {
  const leak = await detector();
  // This is a deliberate trade-off, documented rather than hidden. A lone
  // <parameter> IS ambiguous: it could be an HTML lesson, or a tool call that
  // lost its wrapper to truncation. We reject it because a stray <parameter=
  // block in a chat reads far more like a broken tool call than like prose, and
  // the failure being prevented is the user seeing protocol markup.
  //
  // The cost: a reply that legitimately discusses an XML <parameter> tag is
  // discarded and retried once. That is strictly better than the alternative,
  // which is the user being shown protocol markup they cannot use.
  assert.equal(leak("The <parameter> tag in HTML means something else."), true);
  // An ordinary numbered list must NOT trip it, or the retry never helps.
  assert.equal(leak("Here is how it works:\n1. First\n2. Second\n3. Third"), false);
});

test("an ordinary answer about search is not rejected", async () => {
  const leak = await detector();
  assert.equal(leak("I can't look that up right now - try the NEA website."), false);
  assert.equal(
    leak("Search is rate limited at the moment. The current PSI reading is on nea.gov.sg."),
    false
  );
});

test("the detector still rejects the two shapes it already caught", async () => {
  const leak = await detector();
  // Prose reasoning.
  assert.equal(
    leak("Okay, let me think about this.\n1. The user asked a question\n2. I should search"),
    true
  );
  // Bulleted self-audit.
  assert.equal(
    leak("- no preamble\n- keep it short\n- output only the message"),
    true
  );
});

test("the detector is not fooled by empty or trivial input", async () => {
  const leak = await detector();
  for (const t of ["", "   ", "ok", "hello", "1. one\n2. two\n3. three"]) {
    assert.equal(typeof leak(t), "boolean", `must not throw on ${JSON.stringify(t)}`);
  }
});

test("a very long protocol dump is still caught", async () => {
  const leak = await detector();
  const long = "<tool_call>\n" + "x".repeat(20000) + "\n</tool_call>";
  assert.equal(leak(long), true, "length must not defeat the check");
});

// A tool call written as text is EXECUTED, not discarded.
//
// The incident had two halves. First the model refused to search; that was
// fixed by telling it a failed tool means try another. Then, with the fallback
// data already in hand, it emitted this as its final content - and the leak
// detector correctly rejected it, leaving the user with "hit an error" while
// throwing away the answer it had already fetched.
test("a tool call written as text is parsed into a call, not discarded", async () => {
  const parse = await parser();
  // The exact text observed live, built from char codes so the zero-width
  // space cannot be mangled or hidden.
  const observed = [
    "<​tool_call>",
    "<function=web_search>",
    "<parameter=max_results>5</parameter>",
    "<parameter=query>NEA Singapore PSI current 2025</parameter>",
    "</function>",
    "</​tool_call>",
  ].join(NL);
  const call = parse(observed);
  assert.ok(call, "the markup must be recognised as a call the model meant to make");
  assert.equal(call.name, "web_search");
  assert.equal(call.args.query, "NEA Singapore PSI current 2025");
  // Numbers are coerced: the model means the number 5, not the string "5".
  assert.strictEqual(call.args.max_results, 5);
});

test("the JSON form of a text tool call is parsed too", async () => {
  const parse = await parser();
  const call = parse(
    '{"name":"web_fetch","arguments":{"url":"https://www.checkpointsg.com/haze"}}'
  );
  assert.equal(call.name, "web_fetch");
  assert.equal(call.args.url, "https://www.checkpointsg.com/haze");
});

test("text that is not a tool call parses to null, so the reply path is untouched", async () => {
  const parse = await parser();
  for (const t of [
    "Lisbon is the capital of Portugal.",
    "I looked it up with web_fetch and NEA reports PSI 42.",
    "",
    null,
    undefined,
    42,
  ]) {
    assert.equal(parse(t), null, `must not parse: ${JSON.stringify(t)}`);
  }
});

test("a parsed call names a tool that actually exists", async () => {
  // Parsing an unknown tool and executing it would only be a new error path.
  const parse = await parser();
  const call = parse(
    ["<​tool_call>",
     "<function=totally_made_up>",
     "<parameter=x>1</parameter>",
     "</function>",
     "</​tool_call>"].join(NL)
  );
  assert.ok(call, "it is still parsed");
  const { TOOL_SCHEMAS } = await import("../tools.js");
  const names = TOOL_SCHEMAS.map((s) => s.function.name);
  assert.ok(
    !names.includes(call.name),
    "a hallucinated tool is not one we offer, so executing it needs the normal guard"
  );
});

// A FLAT JSON call, preceded by prose.
//
// OBSERVED live (2026-10-08): asked for Melbourne weather, the model replied
// "I'll check the current weather in Melbourne for you." followed by a bare
//     {"tool": "web_search", "query": "Melbourne weather today"}
// The earlier parser only understood {"name":..., "arguments":{...}}, so this
// was treated as prose and the user got a refusal instead of an answer.
test("a flat JSON tool call, even after preamble, is parsed", async () => {
  const parse = await parser();
  const call = parse(
    "I'll check the current weather in Melbourne for you." + NL +
    '{"tool": "web_search", "query": "Melbourne weather today"}'
  );
  assert.ok(call, "this shape must be recognised as the call the model meant to make");
  assert.equal(call.name, "web_search");
  assert.equal(call.args.query, "Melbourne weather today");
});

test("a flat JSON call with a numeric argument coerces the number", async () => {
  const parse = await parser();
  const call = parse('{"tool":"web_fetch","url":"https://x.test","max_results":5}');
  assert.equal(call.name, "web_fetch");
  assert.equal(call.args.url, "https://x.test");
  assert.strictEqual(call.args.max_results, 5);
});

test("the nested JSON form still parses after adding the flat one", async () => {
  const parse = await parser();
  const call = parse('{"name":"web_search","arguments":{"query":"psi"}}');
  assert.equal(call.name, "web_search");
  assert.equal(call.args.query, "psi");
});
