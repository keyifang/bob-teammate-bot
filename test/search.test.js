import test from "node:test";
import assert from "node:assert/strict";

import { readFile } from "node:fs/promises";
import { TOOL_SCHEMAS, runDdgSearch, executeTool } from "../tools.js";

const source = () => readFile(new URL("../tools.js", import.meta.url), "utf8");

// web_search is how Bob reaches beyond his training data without any API key
// or headless browser. The parser is the risky part: DDG's markup is not a
// contract, so the failure modes below are the ones that must not produce
// confident, wrong output.

test("web_search is advertised with a query parameter", () => {
  const names = TOOL_SCHEMAS.map((t) => t.function.name);
  assert.ok(names.includes("web_search"), "web_search must be advertised");
  assert.ok(names.includes("web_fetch"));

  const spec = TOOL_SCHEMAS.find((t) => t.function.name === "web_search");
  assert.ok(
    spec.function.description.toLowerCase().includes("search the web"),
    "the description must tell the model when to use it"
  );
  assert.deepEqual(spec.function.parameters.required, ["query"]);
  assert.ok(
    spec.function.parameters.properties.query.type === "string",
    "query must be typed so the model does not send a number"
  );
});

test("the tool description tells the model to search for time-sensitive facts", () => {
  const spec = TOOL_SCHEMAS.find((t) => t.function.name === "web_search");
  const d = spec.function.description.toLowerCase();
  assert.ok(d.includes("current") || d.includes("time-sensitive"));
  assert.ok(
    d.includes("out of date") || d.includes("changed"),
    "the model must be nudged toward searching rather than recalling"
  );
});

test("executeTool dispatches web_search", async () => {
  // Reaches the network; only the shape of the failure matters here, since the
  // live behaviour is covered by the smoke test.
  const out = await executeTool("web_search", { query: "" });
  assert.match(out, /needs a search query/i, `unexpected: ${out}`);
});

test("executeTool still rejects an unknown tool", async () => {
  await assert.rejects(() => executeTool("definitely_not_a_tool", {}), /Unknown tool/);
});

test("an empty query is refused without a network call", async () => {
  assert.match(await runDdgSearch(""), /needs a search query/i);
  assert.match(await runDdgSearch("   "), /needs a search query/i);
  assert.match(await runDdgSearch(null), /needs a search query/i);
});

test("a live search returns real titles, urls and snippets", async (t) => {
  // The network test is the only way to prove the endpoint still works and the
  // markup still matches; skipped only if offline.
  let results;
  try {
    results = await runDdgSearch("tokyo population", 3);
  } catch (err) {
    t.skip(`network unavailable: ${err.message}`);
    return;
  }
  if (/rate-limiting|rate limit/i.test(results)) {
    t.skip("DDG is rate limiting this client");
    return;
  }
  assert.ok(!/No results/i.test(results), `expected results, got: ${results}`);

  const first = results.split("\n\n")[0];
  assert.match(first, /^1\./, `results must be numbered: ${first}`);
  assert.ok(
    /https?:\/\//.test(first),
    `results must carry a resolvable URL, not a DDG redirect: ${first}`
  );
  // The /l/?uddg= wrapper must be unwrapped, or the model gets unusable links.
  assert.ok(
    !/uddg=/.test(results),
    `redirect wrapper leaked into the output: ${results.slice(0, 200)}`
  );
  assert.ok(results.length > 50, `results look empty: ${results}`);
});

test("a live search respects max_results", async (t) => {
  let results;
  try {
    results = await runDdgSearch("javascript promises", 2);
  } catch (err) {
    t.skip(`network unavailable: ${err.message}`);
    return;
  }
  if (/rate-limiting|rate limit|No results/i.test(results)) {
    t.skip("DDG is rate limiting this client");
    return;
  }
  const numbered = results.match(/^\d+\./gm) ?? [];
  assert.ok(
    numbered.length <= 2,
    `asked for 2, got ${numbered.length}: ${results.slice(0, 200)}`
  );
});

test("html entities in titles and snippets are decoded", async () => {
  // Behavioural, not a source grep: the earlier version asserted that specific
  // .replace() lines existed, which passed while the decoder was incomplete.
  // Real titles carry named and numeric entities, including accented letters.
  const html = `<div class="result results_links">
    <a class="result__a" href="//duckduckgo.com/l/?uddg=https%3A%2F%2Fex.com%2Fa&amp;rut=1">Tokyo &ndash; demographics &quot;2024&quot; &hellip; caf&eacute; Z&uuml;rich</a>
    <a class="result__snippet" href="#">Caf&eacute;s in Ma&ccedil;on, na&iuml;ve &amp; more</a>
    <a class="result__a" href="https://ex.org/b">A &amp; B &lt;tag&gt;</a>
    <a class="result__snippet" href="#">Second &#8212; end.</a>
  </div>`;
  const original = globalThis.fetch;
  globalThis.fetch = async () => ({ ok: true, status: 200, text: async () => html });
  try {
    const out = await runDdgSearch("tokyo", 5);
    assert.ok(!/&(ndash|quot|hellip|eacute|uuml|amp|lt|gt|ccedil);/.test(out), `entities left: ${out}`);
    assert.ok(!/&#\d+;/.test(out), `numeric entity left: ${out}`);
    assert.ok(out.includes("Tokyo - demographics"), out);
    assert.ok(out.includes("cafe") && out.includes("Zurich"), `accents not folded: ${out}`);
    assert.ok(out.includes("A & B <tag>"), `ampersand/brackets wrong: ${out}`);
    assert.ok(out.includes("—"), `em dash entity not decoded: ${out}`);
  } finally {
    globalThis.fetch = original;
  }
});

test("an unrecognised entity is left intact rather than mangled", async () => {
  const html = `<div class="result results_links">
    <a class="result__a" href="https://ex.org/a">Title &notarealentity; here</a>
    <a class="result__snippet" href="#">S</a>
  </div>`;
  const original = globalThis.fetch;
  globalThis.fetch = async () => ({ ok: true, status: 200, text: async () => html });
  try {
    const out = await runDdgSearch("x", 5);
    // Dropping an unknown entity silently loses text; keeping it is safe.
    assert.ok(out.includes("&notarealentity;"), out);
  } finally {
    globalThis.fetch = original;
  }
});

test("a blocked response is retried on another endpoint, not reported as empty", async () => {
  // The live behaviour that matters: a 202 challenge page must NOT be reported
  // as "no results", because that reads as a real answer.
  const seen = [];
  const original = globalThis.fetch;
  globalThis.fetch = async (url) => {
    seen.push(String(url));
    // First endpoint blocked, second serves a real result.
    if (seen.length === 1) {
      return { ok: false, status: 202, text: async () => "<title>Captcha</title>" };
    }
    return {
      ok: true,
      status: 200,
      text: async () => `<div class="result results_links">
        <a class="result__a" href="https://ex.org/a">Recovered result</a>
        <a class="result__snippet" href="#">snippet</a>
      </div>`,
    };
  };
  try {
    const out = await runDdgSearch("tokyo", 5);
    assert.equal(seen.length, 2, `expected a retry, saw ${seen.length} request(s)`);
    assert.ok(/duckduckgo|mojeek/.test(seen[1]), "retry must use a different endpoint");
    assert.ok(out.includes("Recovered result"), `retry did not recover: ${out}`);
  } finally {
    globalThis.fetch = original;
  }
});

test("when every endpoint is blocked the failure is stated, not hidden", async () => {
  const original = globalThis.fetch;
  globalThis.fetch = async () => ({ ok: false, status: 202, text: async () => "<title>Captcha</title>" });
  try {
    const out = await runDdgSearch("tokyo", 5);
    assert.match(out, /rate-limiting/i, `must admit the block, got: ${out}`);
    assert.ok(!/No results/i.test(out), "a block must not be reported as an empty result set");
  } finally {
    globalThis.fetch = original;
  }
});

test("search stops at max_results", async () => {
  const rows = Array.from({ length: 12 }, (_, i) => {
    const n = i + 1;
    return `<a class="result__a" href="https://ex.org/${n}">Result ${n}</a>
            <a class="result__snippet" href="#">Snippet ${n}</a>`;
  }).join("\n");
  const html = `<div class="result results_links">${rows}</div>`;
  const original = globalThis.fetch;
  globalThis.fetch = async () => ({ ok: true, status: 200, text: async () => html });
  try {
    const out = await runDdgSearch("x", 3);
    assert.equal((out.match(/^\d+\./gm) ?? []).length, 3, out);
    assert.ok(!out.includes("Result 4"), out);
  } finally {
    globalThis.fetch = original;
  }
});

test("duplicate URLs are collapsed", async () => {
  const html = `<div class="result results_links">
    <a class="result__a" href="https://ex.org/same">One</a>
    <a class="result__snippet" href="#">a</a>
    <a class="result__a" href="https://ex.org/same">One again</a>
    <a class="result__snippet" href="#">b</a>
  </div>`;
  const original = globalThis.fetch;
  globalThis.fetch = async () => ({ ok: true, status: 200, text: async () => html });
  try {
    const out = await runDdgSearch("x", 5);
    assert.equal((out.match(/^\d+\./gm) ?? []).length, 1, out);
  } finally {
    globalThis.fetch = original;
  }
});

test("a bot-detection interstitial is reported, not parsed as results", async () => {
  const src = await source();
  // A 200 that is really a challenge page would otherwise parse to zero results
  // and be reported as "no results found", which reads as a real answer.
  assert.match(src, /anomaly|challenge\.duckduckgo|captcha/);
  assert.match(src, /rate-limiting/);
});

test("search uses GET with a browser User-Agent, since DDG refuses POST", async () => {
  // Behavioural: DDG answers POST with 202 and zero results, and serves a
  // challenge page to clients that do not look like a browser. Asserted by
  // inspecting the request the tool actually makes.
  const seen = [];
  const original = globalThis.fetch;
  globalThis.fetch = async (url, init) => {
    seen.push({ url: String(url), init });
    return {
      ok: true,
      status: 200,
      text: async () => `<div class="result results_links">
        <a class="result__a" href="https://ex.org/a">R</a>
        <a class="result__snippet" href="#">s</a>
      </div>`,
    };
  };
  try {
    await runDdgSearch("tokyo", 5);
    assert.ok(seen.length >= 1);
    const first = seen[0];
    assert.ok(
      !first.init?.method || first.init.method === "GET",
      `search must be a GET, got ${first.init?.method}`
    );
    const ua = first.init?.headers?.["User-Agent"] ?? "";
    assert.ok(/Mozilla/i.test(ua), `a browser User-Agent is required, got: ${ua}`);
    assert.ok(/q=/.test(first.url), `query must be in the URL: ${first.url}`);
    assert.match(first.url, /^https:\/\//, "search must use https");
  } finally {
    globalThis.fetch = original;
  }
});

test("a failing search never throws - it must degrade, not abort the reply", async () => {
  // A throwing tool propagates out of the tool loop, so the user gets the
  // fallback message instead of an answer. A rate-limited or broken provider
  // must cost a sentence the model can relay, nothing more.
  const original = globalThis.fetch;
  globalThis.fetch = async () => {
    throw new Error("ECONNRESET");
  };
  try {
    const out = await runDdgSearch("tokyo", 5);
    assert.equal(typeof out, "string", "must return a string, never throw");
    assert.ok(out.length > 0);
  } finally {
    globalThis.fetch = original;
  }
});

test("an HTTP error from the provider is reported, not thrown", async () => {
  const original = globalThis.fetch;
  globalThis.fetch = async () => ({ ok: false, status: 503, text: async () => "" });
  try {
    const out = await runDdgSearch("tokyo", 5);
    assert.equal(typeof out, "string");
    assert.ok(!/Search failed/.test(out), `must not leak a raw error to the model: ${out}`);
  } finally {
    globalThis.fetch = original;
  }
});

test("search never exposes an internal hostname or stack to the model", async () => {
  const original = globalThis.fetch;
  globalThis.fetch = async () => {
    throw new Error("connect ECONNREFUSED 10.0.0.5:443");
  };
  try {
    const out = await runDdgSearch("tokyo", 5);
    assert.ok(!/ECONNREFUSED|10\.0\.0\.5/.test(out), `internals leaked: ${out}`);
  } finally {
    globalThis.fetch = original;
  }
});
