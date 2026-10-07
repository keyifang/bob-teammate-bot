// Vercel serverless entry point.
//
// This does NOT reimplement the webhook. It imports the same express app the
// long-lived server uses, so there is one webhook implementation and the two
// targets cannot drift. A fork would be the classic serverless mistake: two
// code paths, one of them under-tested.
//
// The differences from Render are environmental, not behavioural:
//
//   - invocations share no memory, so dedupe, per-chat serialization and relay
//     cancellation live in Postgres (processed_updates, chat_locks) rather than
//     in module-level Maps;
//   - the schema is bootstrapped on a cold start, and ensureSchema is
//     idempotent, so a warm instance re-running it is safe;
//   - a background task cannot outlive the response, so nothing correctness-
//     bearing may be fire-and-forget here.

import { app, ensureSchemaReady } from "../server.js";

export default async function handler(req, res) {
  // Bootstrap before the first request is served, so a cold start cannot race
  // the tables it needs.
  try {
    await ensureSchemaReady();
  } catch (err) {
    console.error("Schema bootstrap failed:", err.message);
    res.statusCode = 500;
    return res.end("schema bootstrap failed");
  }

  // Express handles routing, body parsing and the 403 on a bad secret. The
  // request is passed through untouched.
  return app(req, res);
}
