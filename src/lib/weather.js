/**
 * Weather integration for Tilth — powered by Open-Meteo (free, no API key).
 *
 * Provides:
 *   - 7-day hourly + daily forecast with normalised shapes
 *   - Historical daily rainfall via the archive API
 *   - Spray-window detection (wind / rain / temp constraints)
 *   - Growing Degree Day accumulation
 *   - Frost-risk hour extraction
 *   - A React hook with LRU localStorage caching (3-hour TTL)
 *
 * All pure functions except `useWeatherForecast` which is the only
 * stateful piece.
 */

import { useState, useEffect, useRef, useCallback } from "react";

// ---------------------------------------------------------------------------
// WMO weather-code lookup
// ---------------------------------------------------------------------------

/** @type {Record<number, { description: string, icon: string }>} */
export const WEATHER_CODES = {
  0:  { description: "Clear sky",              icon: "☀️" },
  1:  { description: "Mainly clear",           icon: "🌤️" },
  2:  { description: "Partly cloudy",          icon: "⛅" },
  3:  { description: "Overcast",               icon: "☁️" },
  45: { description: "Fog",                    icon: "🌫️" },
  48: { description: "Depositing rime fog",    icon: "🌫️" },
  51: { description: "Light drizzle",          icon: "🌦️" },
  53: { description: "Moderate drizzle",       icon: "🌦️" },
  55: { description: "Dense drizzle",          icon: "🌧️" },
  56: { description: "Light freezing drizzle", icon: "🌧️" },
  57: { description: "Dense freezing drizzle", icon: "🌧️" },
  61: { description: "Slight rain",            icon: "🌧️" },
  63: { description: "Moderate rain",          icon: "🌧️" },
  65: { description: "Heavy rain",             icon: "🌧️" },
  66: { description: "Light freezing rain",    icon: "🌧️" },
  67: { description: "Heavy freezing rain",    icon: "🌧️" },
  71: { description: "Slight snowfall",        icon: "🌨️" },
  73: { description: "Moderate snowfall",      icon: "🌨️" },
  75: { description: "Heavy snowfall",         icon: "❄️" },
  77: { description: "Snow grains",            icon: "❄️" },
  80: { description: "Slight rain showers",    icon: "🌦️" },
  81: { description: "Moderate rain showers",  icon: "🌧️" },
  82: { description: "Violent rain showers",   icon: "🌧️" },
  85: { description: "Slight snow showers",    icon: "🌨️" },
  86: { description: "Heavy snow showers",     icon: "❄️" },
  95: { description: "Thunderstorm",           icon: "⛈️" },
  96: { description: "Thunderstorm with slight hail", icon: "⛈️" },
  99: { description: "Thunderstorm with heavy hail",  icon: "⛈️" },
};

// ---------------------------------------------------------------------------
// Internal helpers
// ---------------------------------------------------------------------------

const FORECAST_URL = "https://api.open-meteo.com/v1/forecast";
const ARCHIVE_URL  = "https://archive-api.open-meteo.com/v1/archive";
const FETCH_TIMEOUT_MS = 30_000;
const CACHE_TTL_MS     = 3 * 60 * 60 * 1000; // 3 hours
const CACHE_PREFIX     = "tilth:weather";
const MAX_CACHE_ENTRIES = 20;

export const SPRAY_WINDOW_LIMITS = {
  minWindKmh: 2,
  maxWindKmh: 12,
  minTempC: 5,
  maxTempC: 25,
  rainBufferHours: 6,
};

/**
 * Round a coordinate to 2 decimals for cache-key stability.
 * @param {number} n
 * @returns {string}
 */
function roundCoord(n) {
  return Number(n).toFixed(2);
}

/**
 * Build a cache key for a lat/lng pair.
 */
function cacheKey(lat, lng) {
  return `${CACHE_PREFIX}:${roundCoord(lat)},${roundCoord(lng)}`;
}

/**
 * Fetch with a 30-second timeout via AbortController.
 * @param {string} url
 * @param {AbortSignal} [externalSignal]
 * @returns {Promise<any>}
 */
async function fetchJSON(url, externalSignal) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), FETCH_TIMEOUT_MS);

  const onExternalAbort = () => controller.abort();
  if (externalSignal) externalSignal.addEventListener("abort", onExternalAbort);

  try {
    const res = await fetch(url, { signal: controller.signal });
    if (!res.ok) throw new Error(`Open-Meteo ${res.status}: ${res.statusText}`);
    return await res.json();
  } finally {
    clearTimeout(timer);
    if (externalSignal) externalSignal.removeEventListener("abort", onExternalAbort);
  }
}

// ---------------------------------------------------------------------------
// LRU localStorage cache
// ---------------------------------------------------------------------------

/**
 * Read the cache index (ordered list of keys, newest-first).
 * @returns {string[]}
 */
function readCacheIndex() {
  try {
    const raw = localStorage.getItem(`${CACHE_PREFIX}:_index`);
    return raw ? JSON.parse(raw) : [];
  } catch {
    return [];
  }
}

function writeCacheIndex(keys) {
  try {
    localStorage.setItem(`${CACHE_PREFIX}:_index`, JSON.stringify(keys));
  } catch { /* quota — silently ignore */ }
}

/**
 * Get a cached forecast, or null if expired / missing.
 * @param {string} key
 */
function cacheGet(key) {
  try {
    const raw = localStorage.getItem(key);
    if (!raw) return null;
    const entry = JSON.parse(raw);
    if (Date.now() - entry.ts > CACHE_TTL_MS) {
      localStorage.removeItem(key);
      return null;
    }
    return entry.data;
  } catch {
    return null;
  }
}

/**
 * Write a forecast to the LRU cache, evicting the oldest entry when the
 * cache exceeds MAX_CACHE_ENTRIES.
 * @param {string} key
 * @param {any} data
 */
function cacheSet(key, data) {
  const entry = { ts: Date.now(), data };
  try {
    localStorage.setItem(key, JSON.stringify(entry));
  } catch { /* quota */ }

  let index = readCacheIndex().filter((k) => k !== key);
  index.unshift(key);
  while (index.length > MAX_CACHE_ENTRIES) {
    const evict = index.pop();
    try { localStorage.removeItem(evict); } catch { /* noop */ }
  }
  writeCacheIndex(index);
}

// ---------------------------------------------------------------------------
// Fetch helpers
// ---------------------------------------------------------------------------

/**
 * Parse the raw Open-Meteo forecast response into a normalised shape.
 * @param {object} raw
 * @returns {{ daily: object[], hourly: object[], current: object | null }}
 */
function parseForecastResponse(raw) {
  const hourly = [];
  const hLen = raw.hourly?.time?.length ?? 0;
  for (let i = 0; i < hLen; i++) {
    hourly.push({
      datetime:    raw.hourly.time[i],
      temperature: raw.hourly.temperature_2m?.[i]    ?? null,
      precipitation: raw.hourly.precipitation?.[i]    ?? null,
      windSpeed:   raw.hourly.windspeed_10m?.[i]      ?? null,
      humidity:    raw.hourly.relative_humidity_2m?.[i] ?? null,
      weatherCode: raw.hourly.weathercode?.[i]        ?? null,
      weather:     WEATHER_CODES[raw.hourly.weathercode?.[i]] ?? null,
    });
  }

  const daily = [];
  const dLen = raw.daily?.time?.length ?? 0;
  for (let i = 0; i < dLen; i++) {
    daily.push({
      date:        raw.daily.time[i],
      tempMax:     raw.daily.temperature_2m_max?.[i]  ?? null,
      tempMin:     raw.daily.temperature_2m_min?.[i]  ?? null,
      precipSum:   raw.daily.precipitation_sum?.[i]   ?? null,
      windMax:     raw.daily.windspeed_10m_max?.[i]   ?? null,
      sunrise:     raw.daily.sunrise?.[i]             ?? null,
      sunset:      raw.daily.sunset?.[i]              ?? null,
      weatherCode: raw.daily.weathercode?.[i]         ?? null,
      weather:     WEATHER_CODES[raw.daily.weathercode?.[i]] ?? null,
    });
  }

  const now = new Date();
  const nowIso = now.toISOString().slice(0, 13); // "YYYY-MM-DDTHH"
  const currentIdx = hourly.findIndex(
    (h) => h.datetime && h.datetime.startsWith(nowIso)
  );
  const current = currentIdx >= 0 ? hourly[currentIdx] : (hourly[0] ?? null);

  return { daily, hourly, current };
}

// ---------------------------------------------------------------------------
// Public API — pure fetchers
// ---------------------------------------------------------------------------

/**
 * Fetch a 7-day hourly + daily forecast from Open-Meteo.
 *
 * @param {number} lat  — latitude
 * @param {number} lng  — longitude
 * @param {{ signal?: AbortSignal }} [opts]
 * @returns {Promise<{ daily: object[], hourly: object[], current: object | null }>}
 */
export async function fetchForecast(lat, lng, opts = {}) {
  if (!Number.isFinite(lat) || !Number.isFinite(lng)) {
    throw new Error("fetchForecast: lat/lng must be finite numbers");
  }

  const params = new URLSearchParams({
    latitude:      roundCoord(lat),
    longitude:     roundCoord(lng),
    hourly:        "temperature_2m,precipitation,windspeed_10m,relative_humidity_2m,weathercode",
    daily:         "temperature_2m_max,temperature_2m_min,precipitation_sum,windspeed_10m_max,sunrise,sunset,weathercode",
    timezone:      "auto",
    forecast_days: "7",
  });

  const raw = await fetchJSON(`${FORECAST_URL}?${params}`, opts.signal);
  return parseForecastResponse(raw);
}

/**
 * Fetch historical daily rainfall from the Open-Meteo archive API.
 *
 * @param {number} lat
 * @param {number} lng
 * @param {string} startDate — ISO date string (YYYY-MM-DD)
 * @param {string} endDate   — ISO date string (YYYY-MM-DD)
 * @param {{ signal?: AbortSignal }} [opts]
 * @returns {Promise<{ days: Array<{ date: string, precip_mm: number }> }>}
 */
export async function fetchHistoricalRainfall(lat, lng, startDate, endDate, opts = {}) {
  if (!Number.isFinite(lat) || !Number.isFinite(lng)) {
    throw new Error("fetchHistoricalRainfall: lat/lng must be finite numbers");
  }
  if (!startDate || !endDate) {
    throw new Error("fetchHistoricalRainfall: startDate and endDate are required");
  }

  const params = new URLSearchParams({
    latitude:       roundCoord(lat),
    longitude:      roundCoord(lng),
    daily:          "precipitation_sum",
    timezone:       "auto",
    start_date:     startDate,
    end_date:       endDate,
  });

  const raw = await fetchJSON(`${ARCHIVE_URL}?${params}`, opts.signal);

  const days = [];
  const len = raw.daily?.time?.length ?? 0;
  for (let i = 0; i < len; i++) {
    days.push({
      date:      raw.daily.time[i],
      precip_mm: raw.daily.precipitation_sum?.[i] ?? 0,
    });
  }

  return { days };
}

// ---------------------------------------------------------------------------
// Public API — pure analytics
// ---------------------------------------------------------------------------

/**
 * Find spray-safe windows from hourly forecast data.
 *
 * Constraints per hour:
 *   - Wind between 2 and 12 km/h
 *   - No precipitation in the preceding 6 h and following 6 h
 *   - Temperature between 5 and 25 °C
 *
 * Adjacent qualifying hours are merged into contiguous windows.
 *
 * @param {object[]} hourly — array from `fetchForecast().hourly`
 * @returns {Array<{ start: string, end: string, conditions: object }>}
 */
export function computeSprayWindow(hourly) {
  if (!Array.isArray(hourly) || !hourly.length) return [];

  const len = hourly.length;
  const qualifying = new Array(len).fill(false);

  for (let i = 0; i < len; i++) {
    const h = hourly[i];
    if (
      !Number.isFinite(h.windSpeed) ||
      !Number.isFinite(h.temperature) ||
      h.windSpeed < SPRAY_WINDOW_LIMITS.minWindKmh ||
      h.windSpeed >= SPRAY_WINDOW_LIMITS.maxWindKmh ||
      h.temperature <= SPRAY_WINDOW_LIMITS.minTempC ||
      h.temperature > SPRAY_WINDOW_LIMITS.maxTempC
    ) continue;

    let rainNearby = false;
    for (let j = Math.max(0, i - SPRAY_WINDOW_LIMITS.rainBufferHours); j <= Math.min(len - 1, i + SPRAY_WINDOW_LIMITS.rainBufferHours); j++) {
      const p = hourly[j].precipitation;
      if (Number.isFinite(p) && p > 0) {
        rainNearby = true;
        break;
      }
    }
    if (!rainNearby) qualifying[i] = true;
  }

  const windows = [];
  let windowStart = null;
  let minWind = Infinity;
  let maxWind = -Infinity;
  let minTemp = Infinity;
  let maxTemp = -Infinity;
  let minHumidity = Infinity;
  let maxHumidity = -Infinity;

  for (let i = 0; i <= len; i++) {
    if (i < len && qualifying[i]) {
      if (windowStart === null) {
        windowStart = i;
        minWind = Infinity; maxWind = -Infinity;
        minTemp = Infinity; maxTemp = -Infinity;
        minHumidity = Infinity; maxHumidity = -Infinity;
      }
      const h = hourly[i];
      if (Number.isFinite(h.windSpeed)) {
        minWind = Math.min(minWind, h.windSpeed);
        maxWind = Math.max(maxWind, h.windSpeed);
      }
      if (Number.isFinite(h.temperature)) {
        minTemp = Math.min(minTemp, h.temperature);
        maxTemp = Math.max(maxTemp, h.temperature);
      }
      if (Number.isFinite(h.humidity)) {
        minHumidity = Math.min(minHumidity, h.humidity);
        maxHumidity = Math.max(maxHumidity, h.humidity);
      }
    } else if (windowStart !== null) {
      windows.push({
        start: hourly[windowStart].datetime,
        end:   hourly[i - 1].datetime,
        conditions: {
          windRange:     [minWind, maxWind],
          tempRange:     [minTemp, maxTemp],
          humidityRange: [
            Number.isFinite(minHumidity) ? minHumidity : null,
            Number.isFinite(maxHumidity) ? maxHumidity : null,
          ],
          hours: i - windowStart,
          limits: SPRAY_WINDOW_LIMITS,
        },
      });
      windowStart = null;
    }
  }

  return windows;
}

/**
 * Calculate cumulative Growing Degree Days from hourly temperature data.
 *
 * GDD = Σ max(0, T_hour − baseTemp) / 24
 *
 * @param {object[]} hourly — array from `fetchForecast().hourly`
 * @param {number} [baseTemp=0] — base temperature in °C
 * @returns {number} cumulative GDD
 */
export function computeGDD(hourly, baseTemp = 0) {
  if (!Array.isArray(hourly) || !hourly.length) return 0;

  let sum = 0;
  for (const h of hourly) {
    if (Number.isFinite(h.temperature)) {
      sum += Math.max(0, h.temperature - baseTemp);
    }
  }
  return Math.round((sum / 24) * 100) / 100;
}

/**
 * Find hours where temperature drops below 0 °C.
 *
 * @param {object[]} hourly — array from `fetchForecast().hourly`
 * @returns {Array<{ datetime: string, temp: number }>}
 */
export function frostRiskHours(hourly) {
  if (!Array.isArray(hourly)) return [];

  const results = [];
  for (const h of hourly) {
    if (Number.isFinite(h.temperature) && h.temperature < 0) {
      results.push({ datetime: h.datetime, temp: h.temperature });
    }
  }
  return results;
}

export function computeFieldWorkOutlook(daily) {
  if (!Array.isArray(daily)) return [];
  return daily.map((day) => {
    const rain = Number(day.precipSum) || 0;
    const wind = Number(day.windMax) || 0;
    const tempMax = Number(day.tempMax);
    const tempMin = Number(day.tempMin);
    let score = 3;
    const reasons = [];
    if (rain >= 8) {
      score -= 2;
      reasons.push("wet");
    } else if (rain >= 2) {
      score -= 1;
      reasons.push("showery");
    }
    if (wind >= 35) {
      score -= 2;
      reasons.push("windy");
    } else if (wind >= 22) {
      score -= 1;
      reasons.push("breezy");
    }
    if (Number.isFinite(tempMin) && tempMin <= 0) {
      score -= 1;
      reasons.push("frost");
    }
    if (Number.isFinite(tempMax) && tempMax < 5) {
      score -= 1;
      reasons.push("cold");
    }
    const rating = score >= 3 ? "good" : score >= 1 ? "caution" : "poor";
    return {
      date: day.date,
      rating,
      reasons,
      summary: rating === "good" ? "Good field-work day" : rating === "caution" ? "Check conditions" : "Avoid non-urgent work",
    };
  });
}

// ---------------------------------------------------------------------------
// React hook — the only stateful piece
// ---------------------------------------------------------------------------

/**
 * Fetch the 7-day forecast on mount, caching in localStorage for 3 hours.
 * Coordinates are rounded to 2 d.p. for cache-key stability.
 *
 * @param {number|null} lat
 * @param {number|null} lng
 * @returns {{ forecast: object|null, loading: boolean, error: Error|null }}
 */
export function useWeatherForecast(lat, lng) {
  const [forecast, setForecast] = useState(null);
  const [loading, setLoading]   = useState(false);
  const [error, setError]       = useState(null);
  const abortRef = useRef(null);

  const load = useCallback(async () => {
    if (!Number.isFinite(lat) || !Number.isFinite(lng)) return;

    const key = cacheKey(lat, lng);
    const cached = cacheGet(key);
    if (cached) {
      setForecast(cached);
      setLoading(false);
      setError(null);
      return;
    }

    abortRef.current?.abort();
    const controller = new AbortController();
    abortRef.current = controller;

    setLoading(true);
    setError(null);
    try {
      const data = await fetchForecast(lat, lng, { signal: controller.signal });
      if (!controller.signal.aborted) {
        cacheSet(key, data);
        setForecast(data);
      }
    } catch (err) {
      if (!controller.signal.aborted) {
        setError(err);
      }
    } finally {
      if (!controller.signal.aborted) {
        setLoading(false);
      }
    }
  }, [lat, lng]);

  useEffect(() => {
    load();
    return () => { abortRef.current?.abort(); };
  }, [load]);

  return { forecast, loading, error };
}
