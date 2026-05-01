/**
 * Synchronous .env loader, run as a side effect on import.
 *
 * Must be imported BEFORE any other module that reads `process.env` at
 * top-level (e.g. supabaseAdmin.mjs, extract/index.mjs). ES modules hoist
 * imports to the top of the file in the order they appear, so this file
 * being the first import in server.mjs guarantees `process.env` is fully
 * populated before any consumer evaluates its constants.
 *
 * Format: KEY=value per line, comments allowed with `#`. Values may be
 * single- or double-quoted. Existing process.env values win — useful for
 * deployment overrides where the OS env is the source of truth.
 */

import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(__dirname, "..");

function loadEnvFile(envFile) {
  if (!fs.existsSync(envFile)) return;
  const text = fs.readFileSync(envFile, "utf8");
  for (const line of text.split(/\n/)) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith("#")) continue;
    const eq = trimmed.indexOf("=");
    if (eq <= 0) continue;
    const key = trimmed.slice(0, eq).trim();
    let val = trimmed.slice(eq + 1).trim();
    if (
      (val.startsWith('"') && val.endsWith('"')) ||
      (val.startsWith("'") && val.endsWith("'"))
    ) {
      val = val.slice(1, -1);
    }
    if (key && process.env[key] === undefined) process.env[key] = val;
  }
}

for (const envFile of [
  path.join(__dirname, ".env"),
  path.join(repoRoot, ".env"),
  path.join(__dirname, "document-worker", ".env"),
]) {
  loadEnvFile(envFile);
}
