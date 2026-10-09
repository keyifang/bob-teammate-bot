// Model-callable tools: owl_research and web_fetch.
//
// web_fetch is reachable by anyone who can talk to the bot, so every URL is
// treated as hostile: scheme is pinned to http(s), the host is resolved and
// checked against private/loopback/link-local ranges (including cloud metadata
// at 169.254.169.254), redirects are followed manually with the same check on
// every hop, and the body is capped.

import dns from "node:dns/promises";
import net from "node:net";
import { fileURLToPath } from "node:url";

// Only tools that can actually run are advertised. Offering a tool that is
// unconfigured is worse than not offering it: the model calls it, gets a
// refusal back, and then needs another full model pass to recover - a wasted
// round trip, and on a slow model a visibly long pause.
export const TOOL_SCHEMAS = [
  ...(process.env.OWL_API_URL
    ? [
        {
          type: "function",
          function: {
            name: "owl_research",
            description:
              "Research current or recent information beyond your training data - news, prices, specs, anything that may have changed. Use this whenever the answer depends on up-to-date facts.",
            parameters: {
              type: "object",
              properties: {
                query: { type: "string", description: "The research question" },
              },
              required: ["query"],
            },
          },
        },
      ]
    : []),
  {
    type: "function",
    function: {
      name: "weather",
      description:
        "Get CURRENT conditions for a city: weather (temperature, feels-like, humidity, wind) and AIR QUALITY (AQI, PM2.5, PM10, ozone). Use this for any weather, air quality, pollution, haze, smog or AQI question. It is fast, reliable and needs no key, so prefer it over searching and fetching those sites - most news, weather and air-quality sites block automated requests and will fail.",
      parameters: {
        type: "object",
        properties: {
          location: {
            type: "string",
            description: "City name, optionally with a country code, e.g. 'Melbourne' or 'Melbourne, Australia'",
          },
          air_quality: {
            type: "boolean",
            description:
              "Set true when the question is about air quality, pollution, haze, smog, AQI or pollutants. Omit it for weather.",
          },
        },
        required: ["location"],
      },
    },
  },
  {
    type: "function",
    function: {
      name: "web_search",
      description:
        "Search the web and get titles, URLs and snippets. Use this for anything time-sensitive or that may have changed - current prices, recent releases, today's news, scores, who won. Use it before answering from memory when the facts could be out of date.",
      parameters: {
        type: "object",
        properties: {
          query: { type: "string", description: "The search query" },
          max_results: {
            type: "integer",
            description: "How many results to return (1-8, default 5)",
          },
        },
        required: ["query"],
      },
    },
  },
  {
    type: "function",
    function: {
      name: "web_fetch",
      description:
        "Fetch and read the full text of one specific URL. Use this when someone shares a link, or to read past the snippet a web_search returned.",
      parameters: {
        type: "object",
        properties: {
          url: { type: "string", description: "The exact URL to fetch" },
        },
        required: ["url"],
      },
    },
  },
];

const MAX_BODY_BYTES = 500_000;
const MAX_TEXT_CHARS = 8000;
const MAX_REDIRECTS = 5;

function ipv4ToInt(ip) {
  const parts = ip.split(".").map(Number);
  if (parts.length !== 4 || parts.some((n) => !Number.isInteger(n) || n < 0 || n > 255)) {
    return null;
  }
  return ((parts[0] << 24) | (parts[1] << 16) | (parts[2] << 8) | parts[3]) >>> 0;
}

function inCidr(ipInt, base, bits) {
  const baseInt = ipv4ToInt(base);
  if (ipInt === null || baseInt === null) return false;
  const mask = bits === 0 ? 0 : (0xffffffff << (32 - bits)) >>> 0;
  return (ipInt & mask) === (baseInt & mask);
}

function isBlockedIpv4(ip) {
  const n = ipv4ToInt(ip);
  if (n === null) return true;
  return (
    inCidr(n, "0.0.0.0", 8) ||
    inCidr(n, "10.0.0.0", 8) ||
    inCidr(n, "100.64.0.0", 10) ||
    inCidr(n, "127.0.0.0", 8) ||
    inCidr(n, "169.254.0.0", 16) ||
    inCidr(n, "172.16.0.0", 12) ||
    inCidr(n, "192.0.0.0", 24) ||
    inCidr(n, "192.0.2.0", 24) ||
    inCidr(n, "192.168.0.0", 16) ||
    inCidr(n, "198.18.0.0", 15) ||
    inCidr(n, "198.51.100.0", 24) ||
    inCidr(n, "203.0.113.0", 24) ||
    inCidr(n, "224.0.0.0", 4) ||
    inCidr(n, "240.0.0.0", 4)
  );
}

function isBlockedIpv6(rawAddress) {
  const addr = rawAddress.split("%")[0].toLowerCase();
  if (addr === "::" || addr === "::1") return true;
  if (addr.startsWith("fe80")) return true; // link-local
  if (/^f[cd]/.test(addr)) return true; // unique local fc00::/7
  if (addr.startsWith("ff")) return true; // multicast
  const mapped = addr.match(/^::ffff:(\d{1,3}\.\d{1,3}\.\d{1,3}\.\d{1,3})$/);
  if (mapped) return isBlockedIpv4(mapped[1]);
  // ::ffff:7f00:1 form
  const hexMapped = addr.match(/^::ffff:([0-9a-f]{1,4}):([0-9a-f]{1,4})$/);
  if (hexMapped) {
    const hi = parseInt(hexMapped[1], 16);
    const lo = parseInt(hexMapped[2], 16);
    return isBlockedIpv4(`${hi >> 8}.${hi & 255}.${lo >> 8}.${lo & 255}`);
  }
  // 6to4 (2002::/16) and Teredo (2001:0000::/32) can tunnel to private v4.
  if (addr.startsWith("2002:")) return true;
  if (addr.startsWith("2001:0:")) return true;
  return false;
}

function isBlockedAddress(address) {
  const version = net.isIP(address);
  if (version === 4) return isBlockedIpv4(address);
  if (version === 6) return isBlockedIpv6(address);
  return true;
}

/**
 * Validates a URL and every address its host resolves to.
 * Returns { ok: true, url } or { ok: false, reason }.
 */
export async function assertUrlSafe(rawUrl) {
  let u;
  try {
    u = new URL(String(rawUrl));
  } catch {
    return { ok: false, reason: "not a valid absolute URL" };
  }

  if (u.protocol !== "http:" && u.protocol !== "https:") {
    return { ok: false, reason: `scheme ${u.protocol} is not allowed` };
  }

  if (u.username || u.password) {
    return { ok: false, reason: "URLs with embedded credentials are not allowed" };
  }

  // Node normalises decimal/hex/octal IPv4 and bracketed IPv6 already, but
  // strip the IPv6 brackets Node keeps and reject a trailing-dot FQDN form.
  let hostname = u.hostname.toLowerCase();
  if (hostname.startsWith("[") && hostname.endsWith("]")) {
    hostname = hostname.slice(1, -1);
  }
  if (!hostname) return { ok: false, reason: "missing host" };
  if (hostname.endsWith(".")) hostname = hostname.slice(0, -1);

  if (hostname === "localhost" || hostname.endsWith(".localhost")) {
    return { ok: false, reason: "loopback host is not allowed" };
  }

  const literalVersion = net.isIP(hostname);
  if (literalVersion) {
    if (isBlockedAddress(hostname)) {
      return { ok: false, reason: "address is in a blocked private range" };
    }
    return { ok: true, url: u };
  }

  let records;
  try {
    records = await dns.lookup(hostname, { all: true });
  } catch {
    return { ok: false, reason: "host did not resolve" };
  }
  if (!records.length) return { ok: false, reason: "host did not resolve" };

  for (const record of records) {
    if (isBlockedAddress(record.address)) {
      return { ok: false, reason: "host resolves to a blocked private address" };
    }
  }

  return { ok: true, url: u };
}

async function readCapped(res) {
  const declared = Number(res.headers.get("content-length") ?? 0);
  if (declared && declared > MAX_BODY_BYTES) {
    return `That page is too large to read (${declared} bytes).`;
  }
  if (!res.body) return "";

  const reader = res.body.getReader();
  const chunks = [];
  let total = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    total += value.length;
    if (total > MAX_BODY_BYTES) {
      chunks.push(value.subarray(0, Math.max(0, value.length - (total - MAX_BODY_BYTES))));
      await reader.cancel().catch(() => {});
      break;
    }
    chunks.push(value);
  }
  return Buffer.concat(chunks.map((c) => Buffer.from(c))).toString("utf8");
}

function htmlToText(html) {
  return html
    .replace(/<script[\s\S]*?<\/script>/gi, "")
    .replace(/<style[\s\S]*?<\/style>/gi, "")
    .replace(/<[^>]+>/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

export async function runOwlResearch(query) {
  const url = process.env.OWL_API_URL;
  if (!url) return "owl_research is not configured on this deployment.";

  const res = await fetch(url, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${process.env.OWL_API_KEY ?? ""}`,
    },
    body: JSON.stringify({ query }),
    signal: AbortSignal.timeout(25000),
  });
  if (!res.ok) throw new Error(`OWL error: ${res.status}`);
  const data = await res.json();
  // Adjust this to match OWL's actual response shape
  return data.result ?? data.answer ?? JSON.stringify(data);
}

// Open-Meteo WMO weather codes, so the model gets "Partly cloudy" rather
// than "code 2". Without this the model either guesses or repeats a number.
const WMO = {
  0: "Clear sky",
  1: "Mainly clear",
  2: "Partly cloudy",
  3: "Overcast",
  45: "Fog",
  48: "Freezing fog",
  51: "Light drizzle",
  53: "Drizzle",
  55: "Heavy drizzle",
  61: "Light rain",
  63: "Rain",
  65: "Heavy rain",
  71: "Light snow",
  73: "Snow",
  75: "Heavy snow",
  80: "Rain showers",
  81: "Rain showers",
  82: "Violent rain showers",
  85: "Snow showers",
  95: "Thunderstorm",
  96: "Thunderstorm with hail",
  99: "Thunderstorm with heavy hail",
};

/**
 * Current air quality for a city, via Open-Meteo.
 *
 * Added for the same reason as the weather path. Search for air quality returns
 * aqicn / aqitrends / iqair, and those intermittently answer 404 or 429 to a
 * datacenter IP - observed live as a web_fetch 404, after which the model had
 * no data and told the user "the search provider is unavailable". Open-Meteo
 * answers in under a second for every city tried.
 *
 * EU AQI bands, so the model gets "Moderate" rather than a bare number.
 */
const AQI_BANDS = [
  [20, "Good"],
  [40, "Fair"],
  [60, "Moderate"],
  [80, "Poor"],
  [100, "Very poor"],
  [Infinity, "Extremely poor"],
];

function aqiBand(value) {
  const v = Number(value);
  if (!Number.isFinite(v)) return "unknown";
  for (const [limit, label] of AQI_BANDS) {
    if (v <= limit) return label;
  }
  return "Extremely poor";
}

async function runAirQuality(hit) {
  const res = await fetch(
    `https://air-quality-api.open-meteo.com/v1/air-quality` +
      `?latitude=${hit.latitude}&longitude=${hit.longitude}` +
      `&current=pm10,pm2_5,ozone,nitrogen_dioxide,sulphur_dioxide,carbon_monoxide&timezone=auto`,
    { signal: AbortSignal.timeout(12000) }
  );
  if (!res.ok) return `Air quality lookup failed (${res.status}).`;
  const c = (await res.json())?.current;
  if (!c) return "No current air-quality data returned.";

  // Open-Meteo's european_aqi field is the band-ready number; fall back to a
  // EU-style estimate when it is absent so the model still gets a figure.
  const estimate = Number.isFinite(c.european_aqi)
    ? c.european_aqi
    : Math.round((2 * (c.pm2_5 ?? 0) + (c.pm10 ?? 0)) / 3);

  const place = [hit.name, hit.admin1, hit.country_code].filter(Boolean).join(", ");
  const parts = [
    `Air quality for ${place}: EU AQI ${Math.round(estimate)} (${aqiBand(estimate)}).`,
    `PM2.5 ${c.pm2_5 ?? "?"} ug/m3, PM10 ${c.pm10 ?? "?"} ug/m3, ozone ${c.ozone ?? "?"} ug/m3.`,
  ];
  if (Number.isFinite(c.nitrogen_dioxide)) parts.push(`Nitrogen dioxide ${c.nitrogen_dioxide} ug/m3.`);
  return parts.join(" ");
}

/**
 * Current weather for a city, via Open-Meteo.
 *
 * Added because the search path cannot answer a weather question from this
 * host: the sites search returns (AccuWeather, EaseWeather) both answer 403 to
 * datacenter IPs, and no User-Agent changes that. Observed live as Bob
 * answering a Melbourne weather question with Wikipedia links, because it
 * searched, failed to fetch, and wandered.
 *
 * Chosen over wttr.in as the primary because it is a documented API rather
 * than a scraping-friendly front end, and it needs no key.
 */
export async function runWeather(location, { airQuality = false } = {}) {
  const place = String(location ?? "").trim();
  if (!place) return "No location was given.";

  const geoRes = await fetch(
    `https://geocoding-api.open-meteo.com/v1/search?name=${encodeURIComponent(place)}&count=1`,
    { signal: AbortSignal.timeout(12000) }
  );
  if (!geoRes.ok) return `Could not look up "${place}" (geocoding returned ${geoRes.status}).`;
  const geo = await geoRes.json();
  const hit = geo?.results?.[0];
  if (!hit) return `Could not find a place called "${place}". Try adding a country, e.g. "Melbourne, Australia".`;

  const wxRes = await fetch(
    `https://api.open-meteo.com/v1/forecast` +
      `?latitude=${hit.latitude}&longitude=${hit.longitude}` +
      `&current=temperature_2m,apparent_temperature,relative_humidity_2m,precipitation,weather_code,wind_speed_10m` +
      `&timezone=auto&forecast_days=1`,
    { signal: AbortSignal.timeout(12000) }
  );
  if (!wxRes.ok) return `Weather lookup failed for ${place} (${wxRes.status}).`;
  const wx = await wxRes.json();
  const c = wx?.current;
  if (!c) return `No current conditions returned for ${place}.`;

  if (airQuality) return runAirQuality(hit);

  const desc = WMO[c.weather_code] ?? `Conditions code ${c.weather_code}`;
  const place_ = [hit.name, hit.admin1, hit.country_code].filter(Boolean).join(", ");
  return [
    `Current weather for ${place_}: ${c.temperature_2m}°C (feels like ${c.apparent_temperature}°C), ${desc}.`,
    `Humidity ${c.relative_humidity_2m}%, wind ${c.wind_speed_10m} km/h` +
      (c.precipitation ? `, precipitation ${c.precipitation} mm` : ", no precipitation") + ".",
  ].join(" ");
}

export async function runWebFetch(rawUrl) {
  let current = rawUrl;

  for (let hop = 0; hop <= MAX_REDIRECTS; hop++) {
    const safe = await assertUrlSafe(current);
    if (!safe.ok) {
      return `That URL cannot be fetched (${safe.reason}).`;
    }

    const res = await fetch(safe.url, {
      redirect: "manual",
      signal: AbortSignal.timeout(15000),
      headers: {
        "User-Agent": "Mozilla/5.0 (BobBot/1.0)",
        Accept: "text/html,text/plain;q=0.9,*/*;q=0.1",
      },
    });

    if (res.status >= 300 && res.status < 400) {
      const location = res.headers.get("location");
      if (!location) throw new Error(`Fetch failed: ${res.status} with no Location`);
      await res.body?.cancel().catch(() => {});
      current = new URL(location, safe.url).toString();
      continue;
    }

    if (!res.ok) throw new Error(`Fetch failed: ${res.status}`);

    const contentType = res.headers.get("content-type") ?? "";
    if (!contentType.includes("text/html") && !contentType.includes("text/plain")) {
      await res.body?.cancel().catch(() => {});
      return `URL returned non-text content (${contentType}); cannot read it.`;
    }

    const body = await readCapped(res);
    if (typeof body !== "string") return body;

    const text = contentType.includes("text/plain")
      ? body.replace(/\s+/g, " ").trim()
      : htmlToText(body);

    return text.slice(0, MAX_TEXT_CHARS);
  }

  return "That URL redirected too many times.";
}

// Two backends, tried in order.
//
// 1. search.py -> the `ddgs` library, which is a real DuckDuckGo client rather
//    than a scraper. This is what the owl-basic-research skill uses. It is not
//    challenged the way the scraped endpoint is: verified returning results
//    from an IP where html.duckduckgo.com was serving 202 challenge pages.
// 2. The scraped html/lite endpoints, as a fallback when Python or `ddgs` is
//    unavailable - notably in the Docker image, which ships no Python.
//
// Both report a block honestly instead of returning an empty result set.
const SEARCH_PYTHON = process.env.SEARCH_PYTHON_BIN ?? "python";
// fileURLToPath, not URL.pathname: on Windows the pathname keeps percent
// escapes, so a project path containing spaces becomes "My%20Vibe%20..." and
// Python cannot open it.
const SEARCH_SCRIPT = fileURLToPath(new URL("./search.py", import.meta.url));
const SEARCH_PY_TIMEOUT_MS = Number(process.env.SEARCH_PY_TIMEOUT_MS ?? 45000);

async function searchViaPython(query, maxResults) {
  const { execFile } = await import("node:child_process");
  return await new Promise((resolve) => {
    const child = execFile(
      SEARCH_PYTHON,
      [SEARCH_SCRIPT],
      { timeout: SEARCH_PY_TIMEOUT_MS, maxBuffer: 4 * 1024 * 1024 },
      (err, stdout) => {
        if (err && !stdout) {
          resolve({ ok: false, error: err.message });
          return;
        }
        // The sentinel line survives stray progress output on stdout.
        const line = String(stdout)
          .split("\n")
          .reverse()
          .find((l) => l.includes(SEARCH_SENTINEL));
        if (!line) {
          resolve({ ok: false, error: "no result payload from search helper" });
          return;
        }
        try {
          resolve(JSON.parse(line.slice(line.indexOf(SEARCH_SENTINEL) + SEARCH_SENTINEL.length)));
        } catch (parseErr) {
          resolve({ ok: false, error: `unreadable helper output: ${parseErr.message}` });
        }
      }
    );
    child.stdin?.end(JSON.stringify({ query, maxResults }));
  });
}

const SEARCH_SENTINEL = "@@OWL_SEARCH_JSON@@";

// DuckDuckGo rate-limits by IP and answers a blocked request with 200/202 and
// a challenge page rather than an error status. It also runs several endpoints
// with separate limits, so a block is retried against the next one after a
// short backoff instead of surfacing as "no results found" - which would read
// as a real answer rather than a failure.
const SEARCH_ENDPOINTS = [
  (q) => `https://html.duckduckgo.com/html/?q=${q}`,
  (q) => `https://lite.duckduckgo.com/lite/?q=${q}`,
];
const SEARCH_BROWSER_HEADERS = {
  // A scripted-looking client gets the challenge page; POST is refused outright
  // (202 with zero results), so search must be a GET.
  "User-Agent":
    "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 " +
    "(KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36",
  "Accept-Language": "en-US,en;q=0.9",
};
const SEARCH_RETRY_DELAY_MS = Number(process.env.SEARCH_RETRY_DELAY_MS ?? 1500);

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// A blocked response is not an error - it parses to zero results. Detecting it
// explicitly is the difference between "the provider blocked us" and "there is
// genuinely nothing on the web for this", which are very different answers.
function isBlockedPage(status, html) {
  if (status === 202) return true;
  if (/<title>\s*Captcha/i.test(html)) return true;
  if (/anomaly\.duckduckgo|challenge\.duckduckgo|unusual traffic/i.test(html)) return true;
  return false;
}

function parseSearchHtml(html, maxResults) {
  const results = [];
  const seen = new Set();
  const linkRe =
    /<a[^>]*class="result__a"[^>]*href="([^"]+)"[^>]*>([\s\S]*?)<\/a>/g;
  // lite.duckduckgo.com uses a table with result-link rather than the html
  // endpoint's result__a markup.
  const liteLinkRe =
    /<a[^>]*class="result-link"[^>]*href="([^"]+)"[^>]*>([\s\S]*?)<\/a>/g;
  const snippetRe =
    /<a[^>]*class="result__snippet"[^>]*>([\s\S]*?)<\/a>/g;
  const snippets = [...html.matchAll(snippetRe)].map((m) =>
    decodeEntities(m[1].replace(/<[^>]+>/g, " ")).replace(/\s+/g, " ").trim()
  );

  for (const re of [linkRe, liteLinkRe]) {
    for (const m of html.matchAll(re)) {
      const href = m[1];
      const title = decodeEntities(m[2].replace(/<[^>]+>/g, " "))
        .replace(/\s+/g, " ")
        .trim();
      // Outbound links are wrapped as /l/?uddg=<encoded target>.
      const target = href.match(/uddg=([^&]+)/)?.[1];
      const resolved = target ? decodeURIComponent(target) : href;
      if (!/^https?:\/\//i.test(resolved) || seen.has(resolved)) continue;
      seen.add(resolved);
      results.push({
        title,
        url: resolved,
        snippet: snippets[results.length] ?? "",
      });
      if (results.length >= maxResults) return results;
    }
  }
  return results;
}

function formatResults(results) {
  return results
    .map((r, i) => `${i + 1}. ${r.title}\n   ${r.url}\n   ${r.snippet ?? ""}`.trimEnd())
    .join("\n\n");
}

export async function runDdgSearch(query, maxResults = 5) {
  const text = String(query ?? "").trim();
  if (!text) return "web_search needs a search query.";

  const limit = Math.min(Math.max(Number(maxResults) || 5, 1), 8);
  const encoded = encodeURIComponent(text);

  // Backend 1: the ddgs library via search.py. Preferred because it is not
  // challenged. A miss here falls through to the scraped endpoints rather than
  // ending the search. Disabled in the test suite, where the tests stub fetch
  // and a live subprocess would bypass the stub entirely.
  const pythonEnabled = process.env.SEARCH_DISABLE_PYTHON !== "1";
  const viaPython = pythonEnabled
    ? await searchViaPython(text, limit)
    : { ok: false, error: "disabled" };
  if (viaPython.ok && Array.isArray(viaPython.results) && viaPython.results.length) {
    return formatResults(viaPython.results.slice(0, limit));
  }
  if (!viaPython.ok) {
    console.error(`web_search: helper backend unavailable, falling back: ${viaPython.error}`);
  } else {
    console.error("web_search: helper returned no results, trying the scraped endpoints");
  }

  for (let attempt = 0; attempt < SEARCH_ENDPOINTS.length; attempt++) {
    const url = SEARCH_ENDPOINTS[attempt](encoded);
    let html;
    let status;
    try {
      const res = await fetch(url, {
        headers: SEARCH_BROWSER_HEADERS,
        signal: AbortSignal.timeout(20000),
      });
      status = res.status;
      html = await res.text();
    } catch (err) {
      // Never propagate: a throwing tool aborts the whole reply and the user
      // gets the fallback message instead of an answer. Internals (hostnames,
      // error codes) stay in the log, not in the model's context.
      if (attempt < SEARCH_ENDPOINTS.length - 1) {
        console.error(
          `web_search: ${new URL(url).hostname} unreachable, trying the next endpoint: ${err.message}`
        );
        await sleep(SEARCH_RETRY_DELAY_MS);
        continue;
      }
      console.error(`web_search: all endpoints failed: ${err.message}`);
      return "The search provider is unavailable right now. Try again shortly - this is temporary.";
    }

    if (isBlockedPage(status, html)) {
      if (attempt < SEARCH_ENDPOINTS.length - 1) {
        console.error(
          `web_search: ${new URL(url).hostname} returned a challenge page, retrying via the next endpoint`
        );
        await sleep(SEARCH_RETRY_DELAY_MS);
        continue;
      }
      return "The search provider is rate-limiting requests right now. Try again shortly - this is temporary.";
    }

    if (!status || status >= 400) {
      if (attempt < SEARCH_ENDPOINTS.length - 1) {
        await sleep(SEARCH_RETRY_DELAY_MS);
        continue;
      }
      if (attempt < SEARCH_ENDPOINTS.length - 1) {
        await sleep(SEARCH_RETRY_DELAY_MS);
        continue;
      }
      // Never throw: a throwing tool aborts the whole reply and the user gets
      // the fallback message instead of an answer. A failed search degrades to
      // a sentence the model can relay.
      return "The search provider is unavailable right now. Try again shortly - this is temporary.";
    }

    const results = parseSearchHtml(html, limit);
    if (results.length) {
      return results
        .map((r, i) => `${i + 1}. ${r.title}\n   ${r.url}\n   ${r.snippet}`.trimEnd())
        .join("\n\n");
    }

    // A 200 that parsed to nothing may still be a soft block rather than an
    // empty result set, so fall through to the next endpoint before concluding
    // there is nothing to find.
    if (attempt < SEARCH_ENDPOINTS.length - 1) {
      await sleep(SEARCH_RETRY_DELAY_MS);
      continue;
    }
    return `No results for "${text}".`;
  }

  return "The search provider is rate-limiting requests right now. Try again shortly - this is temporary.";
}
// HTML entities in real result titles are effectively unbounded. Rather than
// enumerate names - and silently leave "&uuml;" in text handed to the model -
// numeric references are decoded directly and named ones are resolved through
// the Latin-1 range, which covers the accented letters that actually appear in
// titles far more often than anything outside it.
const NAMED_ENTITIES = {
  quot: String.fromCharCode(34),
  apos: String.fromCharCode(39),
  ndash: "-",
  mdash: "-",
  hellip: "...",
  lsquo: String.fromCharCode(39),
  rsquo: String.fromCharCode(39),
  ldquo: String.fromCharCode(34),
  rdquo: String.fromCharCode(34),
  middot: "-",
  laquo: "<<",
  raquo: ">>",
  bull: "-",
  deg: " deg ",
  eacute: "e",
  egrave: "e",
  agrave: "a",
  aacute: "a",
  acirc: "a",
  ecirc: "e",
  icirc: "i",
  ocirc: "o",
  ucirc: "u",
  uuml: "u",
  ouml: "o",
  auml: "a",
  ccedil: "c",
  ntilde: "n",
  szlig: "ss",
  eth: "d",
  thorn: "th",
};

function decodeEntities(s) {
  return String(s).replace(
    /&(?:#(\d+)|#[xX]([0-9a-fA-F]+)|([a-zA-Z][a-zA-Z0-9]*));/g,
    (whole, dec, hex, name) => {
      if (dec !== undefined) return String.fromCodePoint(Number(dec));
      if (hex !== undefined) return String.fromCodePoint(parseInt(hex, 16));
      const key = name.toLowerCase();
      if (key === "amp") return "&";
      if (key === "lt") return "<";
      if (key === "gt") return ">";
      if (key === "nbsp") return " ";
      return key in NAMED_ENTITIES ? NAMED_ENTITIES[key] : whole;
    }
  );
}

export async function executeTool(name, args = {}) {
  if (name === "owl_research") return await runOwlResearch(args.query);
  if (name === "weather") {
    return await runWeather(args.location, { airQuality: Boolean(args.air_quality) });
  }
  if (name === "web_search") return await runDdgSearch(args.query, args.max_results);
  if (name === "web_fetch") return await runWebFetch(args.url);
  throw new Error(`Unknown tool: ${name}`);
}

// Tool overuse raises latency and cost, so every call is counted (FR-13). The
// running rate is what tells you whether the persona wording needs tightening.
const toolCallCounts = new Map();

export function noteToolCall(name) {
  const next = (toolCallCounts.get(name) ?? 0) + 1;
  toolCallCounts.set(name, next);
  return next;
}

export function getToolCallStats() {
  const total = [...toolCallCounts.values()].reduce((a, b) => a + b, 0);
  return { counts: Object.fromEntries(toolCallCounts), total };
}

