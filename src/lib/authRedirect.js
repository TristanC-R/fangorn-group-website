export function getAuthRedirect(path = "") {
  const currentOrigin = window.location.origin;
  const configured = import.meta.env.VITE_SUPABASE_REDIRECT_TO?.trim();
  const suffix = path.startsWith("/") ? path : `/${path}`;

  if (!configured) return `${currentOrigin}${suffix}`;

  try {
    const configuredUrl = new URL(configured);
    const currentUrl = new URL(currentOrigin);
    const currentHost = window.location.hostname;
    const configuredHost = configuredUrl.hostname;
    const currentIsLocalhost = currentHost === "localhost" || currentHost === "127.0.0.1" || currentHost === "::1";
    const configuredIsLocalhost = configuredHost === "localhost" || configuredHost === "127.0.0.1" || configuredHost === "::1";

    if (import.meta.env.DEV && configuredUrl.host !== currentUrl.host) {
      return `${currentOrigin}${suffix}`;
    }

    if (configuredIsLocalhost && !currentIsLocalhost) {
      return `${currentOrigin}${suffix}`;
    }

    configuredUrl.pathname = suffix || configuredUrl.pathname;
    configuredUrl.search = "";
    configuredUrl.hash = "";
    return configuredUrl.toString();
  } catch {
    return `${currentOrigin}${suffix}`;
  }
}
