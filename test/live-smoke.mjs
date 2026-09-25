// Live smoke test against the REAL DeepSeek endpoint.
//
// Safety: the Telegram API is redirected to a local stub (TELEGRAM_API_BASE),
// so no message can reach a real person. Only the model call is real. This
// proves the generation, tool-calling, formatting and chunking path works
// against the live API rather than only against a stub.
//
//   node test/live-smoke.mjs
//
// Requires DEEPSEEK_API_KEY in .env. Never needs a real bot token.

import http from "node:http";
import path from "node:path";
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import dotenv from "dotenv";

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), "..");
dotenv.config({ path: path.join(ROOT, ".env") });

if (!process.env.DEEPSEEK_API_KEY) {
  console.error("DEEPSEEK_API_KEY is not set in .env");
  process.exit(1);
}

const TEST_DB =
  process.env.BOB_TEST_DATABASE_URL ??
  "postgresql://postgres:postgres@127.0.0.1:5432/bobdb_test";
const BOT_USERNAME = process.env.BOB_USERNAME ?? "bob_friendly_ai_bot";
const SECRET = "live-smoke-secret";
const PORT = 4900 + Math.floor(Math.random() * 400);

const PROMPT =
  process.argv[2] ??
  "Give me a 3-column markdown table comparing Lisbon, Porto and Seville: " +
    "best month to visit, rough nightly hotel price, one thing not to miss. " +
    "Keep it to a couple of sentences plus the table.";

const sent = [];

const tgStub = http.createServer((req, res) => {
  let body = "";
  req.on("data", (c) => (body += c));
  req.on("end", () => {
    if (!req.url.startsWith("/bot")) {
      res.writeHead(404);
      return res.end();
    }
    const params = Object.fromEntries(new URLSearchParams(body));
    // sendChatAction ("typing") carries no text; only real sends are of
    // interest, and counting them as messages makes the smoke test lie.
    if (params.text !== undefined) sent.push(params);
    res.writeHead(200, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ ok: true, result: { message_id: sent.length } }));
  });
});

await new Promise((r) => tgStub.listen(0, "127.0.0.1", r));
const tgPort = tgStub.address().port;

const server = spawn(process.execPath, ["server.js"], {
  cwd: ROOT,
  env: {
    ...process.env,
    PORT: String(PORT),
    DATABASE_URL: TEST_DB,
    TELEGRAM_BOT_TOKEN: "000000:live-smoke",
    TELEGRAM_API_BASE: `http://127.0.0.1:${tgPort}`,
    WEBHOOK_SECRET: SECRET,
    BOB_USERNAME: BOT_USERNAME,
    HUMANIZE: "true",
  },
  stdio: ["ignore", "pipe", "pipe"],
});

let out = "";
server.stdout.on("data", (d) => {
  out += d;
  process.stdout.write(`[server] ${d}`);
});
server.stderr.on("data", (d) => process.stderr.write(`[server!] ${d}`));

const wait = (ms) => new Promise((r) => setTimeout(r, ms));
const get = (p) =>
  new Promise((resolve) => {
    http
      .get({ host: "127.0.0.1", port: PORT, path: p }, (res) => {
        res.resume();
        res.on("end", () => resolve(res.statusCode));
      })
      .on("error", () => resolve(0));
  });

let up = false;
for (let i = 0; i < 60 && !up; i++) {
  await wait(500);
  up = (await get("/health")) === 200;
}
if (!up) {
  console.error("server did not start");
  server.kill();
  tgStub.close();
  process.exit(1);
}

// Default to a fresh chat id per run: a chat that has already introduced
// itself will not re-introduce, so reusing one silently skips the disclosure
// check and the smoke test passes while testing nothing.
const chatId = Number(process.env.SMOKE_CHAT_ID ?? 5150);
const userId = Number(process.env.SMOKE_USER_ID ?? 6001);
const res = await fetch(`http://127.0.0.1:${PORT}/telegram-webhook`, {
  method: "POST",
  headers: {
    "Content-Type": "application/json",
    "X-Telegram-Bot-Api-Secret-Token": SECRET,
  },
  body: JSON.stringify({
    update_id: Date.now(),
    message: {
      message_id: 1,
      chat: { id: chatId, type: "private" },
      from: { id: userId, first_name: "LiveTester" },
      text: `@${BOT_USERNAME} ${PROMPT}`,
    },
  }),
});
console.log(`\nwebhook status: ${res.status}\n`);

const deadline = Date.now() + 90000;
while (Date.now() < deadline && sent.length === 0) await wait(500);

console.log("=".repeat(70));
if (sent.length === 0) {
  console.log("NO MESSAGE PRODUCED. Server log:");
  console.log(out.slice(-3000));
} else {
  for (const [i, m] of sent.entries()) {
    const tag = m.chat_id == null ? "" : ` -> chat ${m.chat_id}`;
    console.log(`--- message ${i + 1}${tag} (${(m.text ?? "").length} chars) ---`);
    console.log(m.text);
  }
  const last = sent[sent.length - 1].text ?? "";
  console.log("=".repeat(70));
  console.log("checks:");
  console.log("  total chars sent     :", sent.reduce((n, m) => n + (m.text ?? "").length, 0));
  console.log("  all under 4096       :", sent.every((m) => (m.text ?? "").length <= 4096));
  console.log("  parse_mode html      :", sent.every((m) => m.parse_mode === "HTML"));
  console.log("  discloses AI         :", /AI|bot|assistant/i.test(last));
  console.log("  table rendered (<pre>):", last.includes("<pre>"));
  console.log("  no raw '**' left     :", !/\*\*[^*]+\*\*/.test(last));
  console.log("  no raw '|' in table  :", !/<pre>[\s\S]*\|[\s\S]*<\/pre>/.test(last));
}
console.log("=".repeat(70));
console.log("token usage lines:");
for (const line of out.split("\n").filter((l) => l.includes("tokens:"))) {
  console.log("  " + line.trim());
}

server.kill();
tgStub.close();
process.exit(0);
