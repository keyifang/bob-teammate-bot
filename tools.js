// Model-callable tools: owl_research and web_fetch.
//
// web_fetch is reachable by anyone who can talk to the bot, so every URL is
// treated as hostile: scheme is pinned to http(s), the host is resolved and
// checked against private/loopback/link-local ranges (including cloud metadata
// at 169.254.169.254), redirects are followed manually with the same check on
// every hop, and the body is capped.

import dns from "node:dns/promises";
import net from "node:net";

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
      name: "web_fetch",
      description:
        "Fetch and read the text content of one specific URL someone shared or referenced.",
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

export async function executeTool(name, args = {}) {
  if (name === "owl_research") return await runOwlResearch(args.query);
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

