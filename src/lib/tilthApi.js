/** Base URL for the Tilth Node proxy (no trailing slash). Empty = call OSM services from the browser. */
export function getTilthApiBase() {
  const env =
    typeof import.meta !== "undefined" && import.meta.env ? import.meta.env : {};
  const loc = typeof window !== "undefined" ? window.location : null;
  const host = loc?.hostname || "";
  const isLocalBrowser =
    host === "localhost" ||
    host === "127.0.0.1" ||
    host === "::1" ||
    /^10\./.test(host) ||
    /^192\.168\./.test(host) ||
    /^172\.(1[6-9]|2\d|3[0-1])\./.test(host);
  const configured = env.VITE_TILTH_API_URL
    ? String(env.VITE_TILTH_API_URL).trim()
    : "";
  if (configured) {
    try {
      const apiUrl = new URL(configured);
      const configuredLocalhost = apiUrl.hostname === "localhost" || apiUrl.hostname === "127.0.0.1";
      const pageOnLanHost = isLocalBrowser && host && host !== "localhost" && host !== "127.0.0.1" && host !== "::1";
      if (configuredLocalhost && pageOnLanHost) {
        apiUrl.hostname = host;
        return apiUrl.toString().replace(/\/$/, "");
      }
    } catch {
      /* Fall through to the configured string. */
    }
    return configured.replace(/\/$/, "");
  }

  const raw = isLocalBrowser
    ? `http://${host === "::1" ? "localhost" : host}:3847`
    : env.DEV
      ? "http://localhost:3847"
      : "";
  return raw.replace(/\/$/, "");
}

export function tilthApiConfigured() {
  return Boolean(getTilthApiBase());
}
