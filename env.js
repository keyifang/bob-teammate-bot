// Loads .env. MUST be imported before any module that reads process.env in its
// module body.
//
// ES module imports are evaluated depth-first, before the importing module's
// own body runs. Calling dotenv.config() from server.js therefore happens too
// late for a module like db.js that reads DATABASE_URL while being loaded:
// the pool would be built from ambient PG* variables instead of .env, and the
// app would fail at boot with a SASL password error even though .env is
// correct. Importing this module first fixes the ordering.
import dotenv from "dotenv";

dotenv.config();
