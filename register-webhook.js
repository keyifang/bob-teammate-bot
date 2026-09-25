import "./env.js";

const { TELEGRAM_BOT_TOKEN, WEBHOOK_URL, WEBHOOK_SECRET } = process.env;

if (!TELEGRAM_BOT_TOKEN || !WEBHOOK_URL || !WEBHOOK_SECRET) {
  console.error(
    "TELEGRAM_BOT_TOKEN, WEBHOOK_URL and WEBHOOK_SECRET must all be set in .env"
  );
  process.exit(1);
}
if (!WEBHOOK_URL.startsWith("https://")) {
  console.error("WEBHOOK_URL must be https:// - Telegram refuses plain http.");
  process.exit(1);
}
if (WEBHOOK_SECRET.length < 16) {
  console.error("WEBHOOK_SECRET must be at least 16 characters.");
  process.exit(1);
}

// A secret of this length is indistinguishable from the placeholder, and
// registering with it would lock every update out until someone notices.
if (/^(pick_a_random|your_|change_?me|placeholder)/i.test(WEBHOOK_SECRET)) {
  console.error("WEBHOOK_SECRET still looks like a placeholder; refusing to register.");
  process.exit(1);
}

const res = await fetch(
  `https://api.telegram.org/bot${TELEGRAM_BOT_TOKEN}/setWebhook`,
  {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      url: WEBHOOK_URL,
      secret_token: WEBHOOK_SECRET,
      allowed_updates: ["message"],
    }),
  }
);

const body = await res.json();
console.log(JSON.stringify(body, null, 2));

if (!body.ok) {
  console.error(`setWebhook failed: ${body.description ?? res.status}`);
  process.exit(1);
}

const info = await fetch(
  `https://api.telegram.org/bot${TELEGRAM_BOT_TOKEN}/getWebhookInfo`
).then((r) => r.json());
console.log(JSON.stringify(info.result ?? info, null, 2));

// A webhook that is registered but failing looks identical to a healthy one
// until you read last_error_message, so surface it here.
if (info.result?.last_error_message) {
  console.error(`Telegram reports a webhook error: ${info.result.last_error_message}`);
  process.exit(1);
}
