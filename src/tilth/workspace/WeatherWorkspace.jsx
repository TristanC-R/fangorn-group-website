import { useMemo } from "react";
import { brand, fonts, radius } from "../ui/theme.js";
import {
  Body,
  Card,
  Kicker,
  Pill,
  SectionHeader,
  Stat,
  WorkspaceFrame,
  EmptyState,
} from "../ui/primitives.jsx";
import { ringCentroid } from "../geoPointInPolygon.js";
import {
  useWeatherForecast,
  computeSprayWindow,
  SPRAY_WINDOW_LIMITS,
  computeGDD,
  computeFieldWorkOutlook,
  frostRiskHours,
  WEATHER_CODES,
} from "../../lib/weather.js";

function DayCard({ day }) {
  if (!day) return null;
  const wmo = WEATHER_CODES?.[day.weatherCode] || day.weather || { description: "—", icon: "?" };
  return (
    <Card padding={12} style={{ textAlign: "center", minWidth: 0 }}>
      <div style={{ fontSize: 28, lineHeight: 1 }}>{wmo.icon}</div>
      <div style={{ fontFamily: fonts.mono, fontSize: 10, color: brand.muted, marginTop: 4 }}>
        {day.date ? new Date(day.date).toLocaleDateString("en-GB", { weekday: "short", day: "numeric", month: "short" }) : "—"}
      </div>
      <div style={{ fontFamily: fonts.sans, fontSize: 13, fontWeight: 600, color: brand.forest, marginTop: 2 }}>
        {day.tempMax != null ? `${Math.round(day.tempMax)}°` : "—"} / {day.tempMin != null ? `${Math.round(day.tempMin)}°` : "—"}
      </div>
      <div style={{ fontFamily: fonts.mono, fontSize: 10, color: brand.info, marginTop: 2 }}>
        {day.precipSum != null ? `${day.precipSum.toFixed(1)} mm` : "—"}
      </div>
      <div style={{ fontFamily: fonts.mono, fontSize: 9, color: brand.muted, marginTop: 2 }}>
        wind {day.windMax != null ? `${Math.round(day.windMax)} km/h` : "—"}
      </div>
    </Card>
  );
}

export function WeatherWorkspace({ farm, fields }) {
  const center = useMemo(() => {
    for (const f of fields || []) {
      if (f.boundary?.length >= 3) return ringCentroid(f.boundary);
    }
    if (farm?.postcode) return null;
    return null;
  }, [fields, farm]);

  const { forecast, loading, error } = useWeatherForecast(center?.lat, center?.lng);

  const sprayWindows = useMemo(() => {
    if (!forecast?.hourly) return [];
    try { return computeSprayWindow(forecast.hourly); } catch { return []; }
  }, [forecast]);

  const gdd = useMemo(() => {
    if (!forecast?.hourly) return null;
    try { return computeGDD(forecast.hourly, 0); } catch { return null; }
  }, [forecast]);

  const frosts = useMemo(() => {
    if (!forecast?.hourly) return [];
    try { return frostRiskHours(forecast.hourly); } catch { return []; }
  }, [forecast]);

  const fieldWork = useMemo(() => {
    if (!forecast?.daily) return [];
    try { return computeFieldWorkOutlook(forecast.daily); } catch { return []; }
  }, [forecast]);

  if (!center) {
    return (
      <WorkspaceFrame
        header={<SectionHeader kicker="Forecast" title="Weather" description="Map at least one field to enable weather forecasting." />}
      >
        <EmptyState title="No location" message="Add field boundaries so we can look up your local forecast." />
      </WorkspaceFrame>
    );
  }

  return (
    <WorkspaceFrame
      header={
        <SectionHeader
          kicker="Forecast"
          title="Weather"
          description={`7-day forecast for ${center.lat.toFixed(3)}°N, ${center.lng.toFixed(3)}°W via Open-Meteo`}
        />
      }
    >
      <div className="tilth-scroll" style={{ flex: "1 1 auto", minHeight: 0, overflowY: "auto", padding: "0 4px 4px" }}>
        {loading ? (
          <Body size="sm" style={{ padding: 20 }}>Loading forecast…</Body>
        ) : error ? (
          <Body size="sm" style={{ padding: 20, color: brand.danger }}>{String(error)}</Body>
        ) : (
          <>
            {/* 7-day strip */}
            <div style={{ display: "grid", gridTemplateColumns: "repeat(7, 1fr)", gap: 8, marginBottom: 16 }}>
              {(forecast?.daily || []).map((d, i) => <DayCard key={i} day={d} />)}
            </div>

            <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr 1fr", gap: 12, marginBottom: 16 }}>
              <Stat kicker="Spray windows" value={sprayWindows.length} sub={sprayWindows.length > 0 ? "available" : "none found"} tone={sprayWindows.length > 0 ? "ok" : "warn"} />
              <Stat kicker="GDD (base 0°C)" value={gdd != null ? Math.round(gdd) : "—"} sub="7-day accumulation" />
              <Stat kicker="Frost risk" value={frosts.length} sub={frosts.length > 0 ? "hours below 0°C" : "No frost risk"} tone={frosts.length > 0 ? "danger" : "ok"} />
            </div>

            <Card padding={14} style={{ marginBottom: 12 }}>
              <Kicker style={{ marginBottom: 8 }}>Field-work outlook</Kicker>
              <div style={{ display: "grid", gap: 6 }}>
                {fieldWork.map((day) => (
                  <div key={day.date} style={{ display: "grid", gridTemplateColumns: "120px 1fr auto", gap: 8, alignItems: "center", padding: "7px 10px", border: `1px solid ${brand.border}`, borderRadius: radius.base, background: brand.bgSection }}>
                    <span style={{ fontFamily: fonts.mono, fontSize: 10, color: brand.muted }}>
                      {new Date(day.date).toLocaleDateString("en-GB", { weekday: "short", day: "numeric", month: "short" })}
                    </span>
                    <span style={{ fontFamily: fonts.sans, fontSize: 12, color: brand.forest, fontWeight: 600 }}>{day.summary}</span>
                    <Pill tone={day.rating === "good" ? "ok" : day.rating === "caution" ? "warn" : "danger"} style={{ fontSize: 9 }}>
                      {day.reasons.length ? day.reasons.join(", ") : "clear"}
                    </Pill>
                  </div>
                ))}
              </div>
            </Card>

            {/* Spray windows */}
            <Card padding={14} style={{ marginBottom: 12 }}>
              <div style={{ display: "flex", alignItems: "baseline", justifyContent: "space-between", gap: 8, flexWrap: "wrap", marginBottom: 8 }}>
                <Kicker>Spray windows</Kicker>
                <Body size="sm" style={{ color: brand.muted }}>
                  Wind {SPRAY_WINDOW_LIMITS.minWindKmh}-{SPRAY_WINDOW_LIMITS.maxWindKmh} km/h · temp {SPRAY_WINDOW_LIMITS.minTempC}-{SPRAY_WINDOW_LIMITS.maxTempC}°C · no rain ±{SPRAY_WINDOW_LIMITS.rainBufferHours}h
                </Body>
              </div>
              {sprayWindows.length > 0 ? (
                <div style={{ display: "grid", gap: 6 }}>
                  {sprayWindows.slice(0, 8).map((w, i) => {
                    const start = new Date(w.start);
                    const end = new Date(w.end);
                    const hours = Math.round((end - start) / 3_600_000);
                    return (
                      <div key={i} style={{ display: "flex", alignItems: "center", justifyContent: "space-between", padding: "6px 10px", borderRadius: radius.base, border: `1px solid ${brand.border}`, background: brand.bgSection }}>
                        <div>
                          <span style={{ fontFamily: fonts.sans, fontSize: 12, fontWeight: 600, color: brand.forest }}>
                            {start.toLocaleDateString("en-GB", { weekday: "short", day: "numeric", month: "short" })}
                          </span>
                          <span style={{ fontFamily: fonts.mono, fontSize: 10, color: brand.muted, marginLeft: 6 }}>
                            {start.toLocaleTimeString("en-GB", { hour: "2-digit", minute: "2-digit" })} – {end.toLocaleTimeString("en-GB", { hour: "2-digit", minute: "2-digit" })}
                          </span>
                        </div>
                        <div style={{ display: "flex", gap: 4, alignItems: "center", flexWrap: "wrap", justifyContent: "flex-end" }}>
                          <Pill tone="neutral" style={{ fontSize: 9, textTransform: "none" }}>
                            wind {Math.round(w.conditions.windRange[0])}-{Math.round(w.conditions.windRange[1])} km/h
                          </Pill>
                          <Pill tone="neutral" style={{ fontSize: 9, textTransform: "none" }}>
                            temp {Math.round(w.conditions.tempRange[0])}-{Math.round(w.conditions.tempRange[1])}°C
                          </Pill>
                          <Pill tone="ok" style={{ fontSize: 9, textTransform: "none" }}>{hours}h window</Pill>
                        </div>
                      </div>
                    );
                  })}
                </div>
              ) : (
                <Body size="sm" style={{ color: brand.muted }}>No suitable spray windows in the next 7 days. Minimum/maximum wind, rain buffer, or temperature constraints not met.</Body>
              )}
            </Card>

            {/* Frost alerts */}
            {frosts.length > 0 && (
              <Card padding={14}>
                <Kicker style={{ marginBottom: 8 }}>Frost risk hours</Kicker>
                <div style={{ display: "flex", flexWrap: "wrap", gap: 4 }}>
                  {frosts.slice(0, 20).map((f, i) => (
                    <Pill key={i} tone="danger" style={{ fontSize: 9, textTransform: "none" }}>
                      {new Date(f.datetime).toLocaleString("en-GB", { weekday: "short", hour: "2-digit", minute: "2-digit" })} · {f.temp.toFixed(1)}°C
                    </Pill>
                  ))}
                </div>
              </Card>
            )}
          </>
        )}
      </div>
    </WorkspaceFrame>
  );
}
