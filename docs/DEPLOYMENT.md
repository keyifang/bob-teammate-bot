# Deployment

Three targets, in the order they are worth using: **Render** (the default, and
the only one with no limitations), **Supabase** (the database for both), and
**Vercel** (usable, with real limitations stated below rather than glossed).

Every target runs the same `server.js`. The Vercel entry point
(`api/webhook.js`) imports the same express app rather than reimplementing the
webhook, so there is one implementation and the targets cannot drift.

---

## 1. Supabase (the database)

Use the **pooled** connection string, not the direct one.

| | Direct | Pooled |
|---|---|---|
| Host | `db.<ref>.supabase.co` | `aws-0-<region>.pooler.supabase.com` |
| Port | 5432 | 5432 (session) / 6543 (transaction) |
| Use for | migrations from one machine | an app with many short-lived clients |

Two consequences the code already accounts for:

- **The pooler runs in transaction mode**, which rejects a multi-statement query
  string. `ensureSchema()` therefore issues **one statement per call** - see
  `db.js` and the `ensureSchema issues one statement per query` test.
- **The pooler multiplexes many clients over few server connections**, so the
  app's pool is capped at 5 (`PGPOOL_MAX`). A default-size pool exhausts
  connections and presents as a random "too many clients" failure.

Paste the pooled URL as `DATABASE_URL`. Nothing else changes: the schema is
applied on first boot, and `ensureSchema` is idempotent, so a restart is safe.

```bash
# Verify the connection before deploying, rather than discovering it at boot.
DATABASE_URL='postgresql://postgres.<ref>:<pw>@aws-0-<region>.pooler.supabase.com:5432/postgres' \
  node -e "import('./db.js').then(async db => { await db.ensureSchema(); console.log('schema ok'); await db.closePool(); })"
```

---

## 2. Render (the default target)

`render.yaml` and `Dockerfile` deploy Bob as a Docker web service.

1. Push the repo to GitHub.
2. Render → **New → Blueprint** → point it at the repo.
3. Render prompts for each secret (`sync: false`, so nothing sensitive is in
   the repo):

| Variable | Where it comes from |
|---|---|
| `TELEGRAM_BOT_TOKEN` | BotFather |
| `MODEL_API_KEY` | OpenRouter |
| `DATABASE_URL` | the Supabase pooled URL above |
| `WEBHOOK_SECRET` | any random string, 16+ characters |
| `OWL_API_URL`, `OWL_API_KEY` | optional; unset disables `owl_research` |

`WEBHOOK_URL` is deliberately **not** in `render.yaml`: it only exists once
Render has assigned a hostname. Add it, then register:

```bash
WEBHOOK_URL='https://<your-service>.onrender.com/telegram-webhook' npm run register
```

`register-webhook.js` calls `setWebhook`, then `getWebhookInfo`, and **fails
non-zero** if Telegram reports `last_error_message` - a webhook that registers
but silently fails is otherwise indistinguishable from a healthy one.

**Why Render is the default:** it is a long-lived process, so background
summarisation, the relay turn registry and the per-chat queue all work exactly
as they do locally. Nothing in this document's Vercel caveats applies.

---

## 3. Vercel (with real limitations)

`vercel.json` and `api/webhook.js` deploy the same app as a serverless
function.

```bash
vercel --prod
```

Set the same environment variables, then register the webhook against the
Vercel hostname.

### What is different, and why

Serverless invocations **share no memory**. Any state in a module-level `Map`
is lost between requests, and a background task cannot outlive the response.
Bob's correctness-critical state therefore lives in Postgres, which is what
makes this target viable at all:

| Concern | In-process (Render) | Postgres (both) |
|---|---|---|
| Duplicate webhook delivery | `Set` of update ids | `processed_updates`, PK-arbitrated |
| One job per chat | promise queue | `chat_locks`, an expiring lease |
| Relay cancellation | token registry | in-memory token, safe because the turn is short-lived |

### The limitations, stated plainly

1. **The per-chat queue is weaker.** On Render, `chatQueues` serializes
   requests within one process. On Vercel, two concurrent invocations can both
   pass the lease check if they arrive in the same instant - the lease bounds
   the window, it does not close it. Two rapid messages are *usually* handled
   in order, not *always*.
2. **A relay turn can be cut off.** `maxDuration` is 300s (the Hobby maximum).
   A relay turn on a slow free model can approach that. The turn posts each
   bot's reply as it arrives, so a truncation loses the tail, not the whole
   turn - but it is a real difference.
3. **Background summarisation is best-effort.** On Render it runs after the
   response with the process still alive. On Vercel it may be killed when the
   function returns. Memory still consolidates, just later, on a subsequent
   invocation.
4. **Cold starts.** The schema bootstrap runs on a cold start. It is idempotent
   and cheap, but the first request after an idle period is slower.

If any of these matter for a paying user, deploy to Render. Vercel is the
right choice for a low-traffic deployment or a free tier, not for the
guarantees.

### Cost note

Vercel's Hobby plan is free but capped at 300s per invocation. Fluid compute
bills active CPU time, so a turn that spends most of its time waiting on a slow
free model is cheaper than the wall-clock suggests.

---

## Verifying a deployment

```bash
curl -sS https://<host>/health                 # -> ok
curl -sS "https://api.telegram.org/bot<token>/getWebhookInfo"
```

`getWebhookInfo` must show your URL and an **empty** `last_error_message`. A
non-empty one means Telegram is trying and failing, which is the state that
looks healthy from the app's side.

---

## Environment variables

See `.env.example`. Missing required variables abort the process at boot with a
named error rather than starting half-configured. `WEBHOOK_URL` is not required
at boot, because it is only known after the platform assigns a hostname.

`.env` is read by `env.js`, which `server.js` imports **before** anything that
reads `process.env` while being loaded. ES module imports are evaluated before
the importing module's own body, so calling `dotenv.config()` inline would run
too late. `db.js` also builds its pool lazily, so the ordering cannot be broken
by accident.

---

## Project files (optional, Cloudflare R2)

Small coding projects need object storage, not the database. Cloudflare R2 is
the recommendation: 10 GB free and **zero egress fees**, which matters because
a user downloads their own project back.

| Variable | Purpose |
|---|---|
| `R2_ACCOUNT_ID` | account id |
| `R2_ACCESS_KEY_ID` / `R2_SECRET_ACCESS_KEY` | S3-compatible credentials |
| `R2_BUCKET` | bucket name |

Unset means the feature is disabled, which is the default. It is deliberately
not required: a deployment without it works, minus project file storage.
