/**
 * Tilth API client.
 *
 * In Vite dev, always use the "/tilth-api" proxy (same-origin, no CORS).
 * The proxy is configured in vite.config.js and forwards to localhost:3847.
 * In production, use VITE_TILTH_API_URL or fall back to the local API.
 */

function getEnv() {
  return typeof import.meta !== "undefined" && import.meta.env ? import.meta.env : {};
}

export function getTilthApiBase() {
  const env = getEnv();
  const configured = env.VITE_TILTH_API_URL
    ? String(env.VITE_TILTH_API_URL).trim().replace(/\/$/, "")
    : "";

  const loc = typeof window !== "undefined" ? window.location : null;
  const host = loc?.hostname || "";
  const isLocal =
    host === "localhost" ||
    host === "127.0.0.1" ||
    host === "::1" ||
    /^10\./.test(host) ||
    /^192\.168\./.test(host) ||
    /^172\.(1[6-9]|2\d|3[0-1])\./.test(host);

  // In Vite dev mode, use the same-origin proxy — avoids CORS entirely.
  if (env.DEV) return configured || "/tilth-api";

  // Local production previews do not run Vite's dev proxy, so a relative
  // "/tilth-api" would hit the static app and return 404. Talk directly to
  // the local Tilth API instead.
  if (isLocal && (!configured || configured === "/tilth-api")) {
    return `http://${host === "::1" ? "localhost" : host}:3847`;
  }

  if (configured) return configured;

  return isLocal ? `http://${host === "::1" ? "localhost" : host}:3847` : "";
}

export function tilthApiConfigured() {
  return Boolean(getTilthApiBase());
}

export async function fetchTilthApi(path, options = {}) {
  const endpoint = path.startsWith("/") ? path : `/${path}`;
  const base = getTilthApiBase();
  if (!base) throw new Error("Tilth service is not available right now.");
  const url = `${base}${endpoint}`;
  const maxAttempts = 3;
  let lastError = null;
  for (let attempt = 0; attempt < maxAttempts; attempt++) {
    try {
      return await fetch(url, options);
    } catch (err) {
      lastError = err;
      if (attempt < maxAttempts - 1) {
        await new Promise((r) => setTimeout(r, 1000 * (attempt + 1)));
      }
    }
  }
  throw new Error(tilthApiFetchErrorMessage(lastError));
}

export function tilthApiFetchErrorMessage(err) {
  const raw = err?.message || String(err || "");
  if (/failed to fetch|networkerror|load failed/i.test(raw)) {
    return "Tilth could not reach the service it needs. Check your connection and try again.";
  }
  return raw || "Tilth request failed.";
}
