import { useMemo } from "react";
import { brand, fonts, radius } from "../ui/theme.js";
import {
  Body,
  Button,
  Card,
  Kicker,
  Pill,
  Row,
  SectionHeader,
  Stat,
  WorkspaceFrame,
} from "../ui/primitives.jsx";
import { ringAreaSqDeg } from "../geoPointInPolygon.js";
import {
  scoreTone,
  useFarmHealth,
} from "../../lib/cropHealth.js";
import { tilthStore, useLocalValue } from "../state/localStore.js";
import {
  CROP_CATALOGUE,
  daysSincePlanting,
  expectedStage,
} from "../../lib/cropPhenology.js";

function approxHectares(ring) {
  if (!Array.isArray(ring) || ring.length < 3) return 0;
  const sqDeg = Math.abs(ringAreaSqDeg(ring));
  const midLat = ring.reduce((a, p) => a + p.lat, 0) / ring.length;
  return Math.max(0, (sqDeg * 111_132 * 111_320 * Math.cos((midLat * Math.PI) / 180)) / 10_000);
}

function fmtHa(ha) {
  if (!Number.isFinite(ha) || ha <= 0) return "—";
  return ha < 10 ? `${ha.toFixed(2)} ha` : `${ha.toFixed(1)} ha`;
}

function fmtRelative(ts) {
  if (!ts) return null;
  const days = Math.round((Date.now() - ts) / 86_400_000);
  if (days <= 0) return "today";
  if (days === 1) return "yesterday";
  if (days < 7) return `${days}d ago`;
  if (days < 56) return `${Math.round(days / 7)}w ago`;
  return `${Math.round(days / 30)}mo ago`;
}

const DAY_MS = 86_400_000;

function isNvzApproaching(landUse, now) {
  const d = new Date(now);
  const year = d.getFullYear();
  const startMonth = landUse === "grass" ? 9 : 9;
  const startDay = landUse === "grass" ? 15 : 1;
  const closeDate = new Date(year, startMonth, startDay);
  if (closeDate < d) return null;
  const daysUntil = Math.round((closeDate - d) / DAY_MS);
  if (daysUntil <= 14 && daysUntil > 0) return daysUntil;
  return null;
}

export function WorkspaceHome({ farm, fields, onNavigate, onMapFields }) {
  const farmId = farm?.id || null;
  const totalHa = useMemo(
    () => (fields || []).reduce((acc, f) => acc + approxHectares(f.boundary || []), 0),
    [fields],
  );
  const hasFields = (fields?.length || 0) > 0;

  const plantingsMap = useMemo(() => tilthStore.loadPlantings(farmId), [farmId]);
  const { health, status: healthStatus } = useFarmHealth(fields, plantingsMap);

  const records = useMemo(() => tilthStore.loadRecords(farmId), [farmId]);
  const attrs = useMemo(() => tilthStore.loadFieldAttrs(farmId), [farmId]);

  const [farmLivestock] = useLocalValue("livestock", farmId, []);
  const [farmLivestockMeds] = useLocalValue("livestock_medicines", farmId, []);
  const [farmTasks] = useLocalValue("tasks", farmId, []);
  const [farmInventory] = useLocalValue("inventory", farmId, []);
  const [farmFinances] = useLocalValue("finances", farmId, []);

  const now = Date.now();
  const fieldsById = useMemo(() => new Map((fields || []).map((f) => [f.id, f])), [fields]);

  // Health roll-up
  const attention = useMemo(() => {
    let critical = 0, warn = 0, healthy = 0, mostRecent = 0;
    const flagged = [];
    const signalCounts = { moisture: 0, chlorophyll: 0, canopy: 0, disturbance: 0 };
    for (const [fieldId, rec] of health) {
      if (!rec) continue;
      const tone = scoreTone(rec.score);
      if (tone === "danger") critical += 1;
      else if (tone === "warn") warn += 1;
      else if (tone === "ok") healthy += 1;
      const t = rec.latest?.scene_datetime ? new Date(rec.latest.scene_datetime).getTime() : 0;
      if (Number.isFinite(t) && t > mostRecent) mostRecent = t;
      if (tone === "danger" || tone === "warn") {
        flagged.push({ fieldId, name: fieldsById.get(fieldId)?.name || "Unnamed", rec });
      }
      if (rec.flags?.includes("water_stress") || rec.flags?.includes("moisture_decline") || rec.flags?.includes("surface_wetness")) signalCounts.moisture += 1;
      if (rec.flags?.includes("chlorophyll_stress")) signalCounts.chlorophyll += 1;
      if (rec.flags?.includes("thin_canopy") || rec.flags?.includes("dense_canopy_decline")) signalCounts.canopy += 1;
      if (rec.flags?.includes("disturbance_or_exposed_soil")) signalCounts.disturbance += 1;
    }
    flagged.sort((a, b) => (a.rec?.score ?? 99) - (b.rec?.score ?? 99));
    return { critical, warn, healthy, total: health.size, mostRecent, flagged, signalCounts };
  }, [health, fieldsById]);

  // Upcoming crop events (stage transitions, harvest, N timing)
  const cropEvents = useMemo(() => {
    const events = [];
    for (const f of fields || []) {
      const planting = plantingsMap[f.id]?.[0];
      if (!planting?.crop || !planting?.plantingDate) continue;
      const crop = CROP_CATALOGUE[planting.crop];
      if (!crop) continue;
      const dsp = daysSincePlanting(planting.plantingDate, now);
      if (dsp == null) continue;
      const stg = expectedStage(planting.crop, dsp);
      if (!stg) continue;

      // Harvest approaching
      const lastStage = crop.stages[crop.stages.length - 1];
      const daysToHarvest = lastStage.dayRange[0] - dsp;
      if (daysToHarvest > 0 && daysToHarvest <= 28) {
        events.push({ type: "harvest", priority: daysToHarvest <= 14 ? "high" : "medium", field: f.name, crop: planting.crop, days: daysToHarvest, detail: `${planting.crop} harvest in ~${daysToHarvest} days` });
      }

      // Stage transition imminent
      const nextIdx = stg.stageIndex + 1;
      if (nextIdx < crop.stages.length) {
        const daysToNext = crop.stages[nextIdx].dayRange[0] - dsp;
        if (daysToNext > 0 && daysToNext <= 14) {
          events.push({ type: "stage", priority: "info", field: f.name, crop: planting.crop, days: daysToNext, detail: `${planting.crop} entering ${crop.stages[nextIdx].name} in ~${daysToNext} days` });
        }
      }

      // Behind schedule
      if (stg.isLate) {
        events.push({ type: "late", priority: "high", field: f.name, crop: planting.crop, days: 0, detail: `${planting.crop} is behind schedule at ${stg.stageName}` });
      }
    }
    events.sort((a, b) => {
      const p = { high: 0, medium: 1, info: 2 };
      return (p[a.priority] ?? 9) - (p[b.priority] ?? 9) || a.days - b.days;
    });
    return events;
  }, [fields, plantingsMap, now]);

  // PHI countdowns
  const phiAlerts = useMemo(() => {
    const alerts = [];
    const PRODUCT_PHI = { "proline-275": 35, "revystar-xpro": 35, "ascra-xpro": 35, "aviator-xpro": 35, "elatus-era": 35, "adexar": 35, "decis-forte": 30, "hallmark-zeon": 28, "biscaya": 14, "roundup-flex": 7 };
    for (const r of records) {
      const phi = PRODUCT_PHI[r.productId];
      if (!phi || !r.date) continue;
      const appDate = new Date(r.date).getTime();
      const clearDate = appDate + phi * DAY_MS;
      const daysLeft = Math.ceil((clearDate - now) / DAY_MS);
      if (daysLeft > 0 && daysLeft <= 5) {
        const fieldName = fieldsById.get(r.fieldId)?.name || "Unknown";
        alerts.push({ field: fieldName, product: r.productId, daysLeft, detail: `PHI expires in ${daysLeft} day${daysLeft === 1 ? "" : "s"}` });
      }
    }
    return alerts;
  }, [records, fieldsById, now]);

  // NVZ warnings
  const nvzWarnings = useMemo(() => {
    const warns = [];
    for (const f of fields || []) {
      const landUse = attrs[f.id]?.landUse;
      if (!landUse) continue;
      const daysUntil = isNvzApproaching(landUse, now);
      if (daysUntil != null) {
        warns.push({ field: f.name, days: daysUntil, detail: `NVZ closed period starts in ${daysUntil} days` });
      }
    }
    return warns;
  }, [fields, attrs, now]);

  // Records stats
  const recordStats = useMemo(() => {
    const weekAgo = now - 7 * DAY_MS;
    const thisWeek = records.filter((r) => r.date && new Date(r.date).getTime() >= weekAgo);
    return { total: records.length, thisWeek: thisWeek.length };
  }, [records, now]);

  // Planting coverage
  const plantingStats = useMemo(() => {
    let planted = 0;
    const crops = new Map();
    for (const f of fields || []) {
      const p = plantingsMap[f.id]?.[0];
      if (p?.crop) {
        planted += 1;
        crops.set(p.crop, (crops.get(p.crop) || 0) + 1);
      }
    }
    return { planted, total: fields?.length || 0, crops: [...crops.entries()].sort((a, b) => b[1] - a[1]) };
  }, [fields, plantingsMap]);

  const allTasks = useMemo(() => {
    const tasks = [];
    for (const item of attention.flagged.slice(0, 5)) {
      tasks.push({ priority: scoreTone(item.rec.score) === "danger" ? "critical" : "high", icon: "!", title: item.name, detail: item.rec.summary, action: "insights", category: "health" });
    }
    for (const e of cropEvents.slice(0, 5)) {
      tasks.push({ priority: e.priority, icon: e.type === "harvest" ? "H" : e.type === "late" ? "!" : "→", title: e.field, detail: e.detail, action: "fields", category: "crop" });
    }
    for (const a of phiAlerts) {
      tasks.push({ priority: "high", icon: "P", title: a.field, detail: `${a.product}: ${a.detail}`, action: "records", category: "compliance" });
    }
    for (const w of nvzWarnings) {
      tasks.push({ priority: "medium", icon: "N", title: w.field, detail: w.detail, action: "records", category: "compliance" });
    }

    const todayStr = new Date(now).toISOString().slice(0, 10);
    const weekFromNow = new Date(now + 7 * DAY_MS).toISOString().slice(0, 10);
    for (const t of (farmTasks || []).filter((t) => t.status === "pending" || t.status === "in_progress")) {
      if (t.due_date && t.due_date <= todayStr) {
        tasks.push({ priority: t.priority === "urgent" ? "critical" : "high", icon: "T", title: t.title, detail: `Due ${t.due_date}${t.category !== "general" ? ` · ${t.category}` : ""}`, action: "calendar", category: "task" });
      } else if (t.due_date && t.due_date <= weekFromNow) {
        tasks.push({ priority: "medium", icon: "T", title: t.title, detail: `Due ${t.due_date}`, action: "calendar", category: "task" });
      }
    }

    for (const item of (farmInventory || [])) {
      if (item.expiry_date) {
        const daysToExpiry = Math.ceil((new Date(item.expiry_date).getTime() - now) / DAY_MS);
        if (daysToExpiry <= 0) {
          tasks.push({ priority: "high", icon: "X", title: item.product_name, detail: `Expired ${Math.abs(daysToExpiry)} days ago`, action: "inventory", category: "inventory" });
        } else if (daysToExpiry <= 30) {
          tasks.push({ priority: "medium", icon: "X", title: item.product_name, detail: `Expires in ${daysToExpiry} days`, action: "inventory", category: "inventory" });
        }
      }
    }

    for (const med of (farmLivestockMeds || [])) {
      if (med.withdrawal_meat_days && med.treatment_date) {
        const clearDate = new Date(med.treatment_date).getTime() + med.withdrawal_meat_days * DAY_MS;
        const daysLeft = Math.ceil((clearDate - now) / DAY_MS);
        if (daysLeft > 0 && daysLeft <= 7) {
          tasks.push({ priority: "high", icon: "W", title: med.product_name, detail: `Meat withdrawal: ${daysLeft}d left · ${med.animal_tag || "batch"}`, action: "livestock", category: "livestock" });
        }
      }
    }

    const order = { critical: 0, high: 1, medium: 2, info: 3 };
    tasks.sort((a, b) => (order[a.priority] ?? 9) - (order[b.priority] ?? 9));
    return tasks;
  }, [attention.flagged, cropEvents, phiAlerts, nvzWarnings, farmTasks, farmInventory, farmLivestockMeds, now]);

  const recentlyLabel = fmtRelative(attention.mostRecent);

  const addrLines = [
    farm?.address_line1,
    farm?.address_line2,
    [farm?.city, farm?.region].filter(Boolean).join(", "),
    [farm?.postcode, farm?.country].filter(Boolean).join(" "),
  ].filter((x) => x && String(x).trim());

  return (
    <WorkspaceFrame
      header={
        <SectionHeader
          kicker="Today"
          title={`Good ${new Date().getHours() < 12 ? "morning" : new Date().getHours() < 17 ? "afternoon" : "evening"}`}
          description={hasFields
            ? `${fields.length} fields · ${fmtHa(totalHa)} · ${plantingStats.planted} planted · ${recordStats.total} records logged`
            : "Start by mapping field boundaries — they unlock satellite analysis, crop tracking, and reports."}
          actions={
            <>
              <Button variant="secondary" size="sm" onClick={() => onNavigate("records")}>
                Log application
              </Button>
              <Button variant="primary" size="sm" onClick={() => hasFields ? onNavigate("fields") : onMapFields()}>
                {hasFields ? "Open map" : "Map first field"}
              </Button>
            </>
          }
        />
      }
    >
      <div
        className="tilth-scroll"
        style={{ flex: "1 1 auto", minHeight: 0, overflowY: "auto", overflowX: "hidden", paddingRight: 4, paddingBottom: 4 }}
      >
        {!hasFields ? (
          <Card
            padding={18}
            tone="section"
            style={{
              marginBottom: 14,
              borderColor: brand.moss,
              display: "grid",
              gridTemplateColumns: "minmax(0, 1fr) auto",
              gap: 14,
              alignItems: "center",
            }}
            className="tilth-mobile-card tilth-mobile-stack"
          >
            <div>
              <Kicker style={{ marginBottom: 8 }}>First setup</Kicker>
              <div style={{ fontFamily: fonts.serif, fontSize: 22, color: brand.forest, marginBottom: 6 }}>
                Map a field when you are ready
              </div>
              <Body size="sm" style={{ maxWidth: 680 }}>
                Weather, records, crop health, reports, and field notes all work better once Tilth
                knows your field boundaries. You can come back to this step at any time.
              </Body>
            </div>
            <Button variant="primary" size="sm" onClick={onMapFields}>
              Resume field mapping
            </Button>
          </Card>
        ) : null}

        {/* Stats strip */}
        <div className="tilth-home-stats" style={{ display: "grid", gridTemplateColumns: "repeat(12, minmax(0, 1fr))", gap: 10, marginBottom: 14 }}>
          <div style={{ gridColumn: "span 2", minWidth: 0 }}>
            <Stat kicker="Fields" value={fields?.length || 0} sub={fmtHa(totalHa)} tone="forest" />
          </div>
          <div style={{ gridColumn: "span 2", minWidth: 0 }}>
            <Stat kicker="Planted" value={`${plantingStats.planted}/${plantingStats.total}`} sub={plantingStats.crops[0]?.[0] || "—"} />
          </div>
          <div style={{ gridColumn: "span 2", minWidth: 0 }}>
            <Stat
              kicker="Critical"
              value={healthStatus === "loading" && !attention.total ? "—" : String(attention.critical)}
              sub={attention.critical > 0 ? "Need action" : "None"}
            />
          </div>
          <div style={{ gridColumn: "span 2", minWidth: 0 }}>
            <Stat kicker="Watch" value={healthStatus === "loading" && !attention.total ? "—" : String(attention.warn)} sub={attention.warn > 0 ? "Worth a look" : "None"} />
          </div>
          <div style={{ gridColumn: "span 2", minWidth: 0 }}>
            <Stat kicker="Healthy" value={healthStatus === "loading" && !attention.total ? "—" : String(attention.healthy)} sub={`of ${attention.total}`} />
          </div>
          <div style={{ gridColumn: "span 2", minWidth: 0 }}>
            <Stat kicker="Last scene" value={recentlyLabel || "—"} sub="Satellite" />
          </div>
        </div>

        {attention.total > 0 ? (
          <Card padding={10} tone="section" style={{ marginBottom: 14 }}>
            <div style={{ display: "flex", flexWrap: "wrap", gap: 6, alignItems: "center" }}>
              <Kicker style={{ marginRight: 4 }}>Spectral signals</Kicker>
              <Pill tone={attention.signalCounts.moisture ? "warn" : "neutral"}>Moisture {attention.signalCounts.moisture}</Pill>
              <Pill tone={attention.signalCounts.chlorophyll ? "warn" : "neutral"}>Chlorophyll/N {attention.signalCounts.chlorophyll}</Pill>
              <Pill tone={attention.signalCounts.canopy ? "warn" : "neutral"}>Canopy {attention.signalCounts.canopy}</Pill>
              <Pill tone={attention.signalCounts.disturbance ? "warn" : "neutral"}>NBR context {attention.signalCounts.disturbance}</Pill>
            </div>
          </Card>
        ) : null}

        {/* Main grid */}
        <div className="tilth-home-grid" style={{ display: "grid", gridTemplateColumns: "minmax(0, 1.6fr) minmax(0, 1fr)", gap: 14, alignItems: "start" }}>
          {/* Left — Action list */}
          <div style={{ display: "grid", gap: 12 }}>
            {/* Today's tasks */}
            <Card padding={16} tone="section">
              <div style={{ display: "flex", alignItems: "baseline", justifyContent: "space-between", gap: 8, marginBottom: 10 }}>
                <Kicker>Action list</Kicker>
                <span style={{ fontFamily: fonts.mono, fontSize: 9, color: brand.muted, letterSpacing: "0.12em", textTransform: "uppercase" }}>
                  {allTasks.length} item{allTasks.length === 1 ? "" : "s"}
                </span>
              </div>
              {allTasks.length > 0 ? (
                <div style={{ display: "grid", gap: 4 }}>
                  {allTasks.slice(0, 10).map((task, i) => (
                    <TaskRow key={i} task={task} onNavigate={onNavigate} />
                  ))}
                </div>
              ) : healthStatus === "loading" ? (
                <Body size="sm" style={{ color: brand.muted }}>Loading satellite data and checking crop calendars…</Body>
              ) : hasFields ? (
                <div style={{ padding: "12px 0", textAlign: "center" }}>
                  <div style={{ fontFamily: fonts.serif, fontSize: 18, color: brand.forest, marginBottom: 4 }}>All clear</div>
                  <Body size="sm" style={{ color: brand.muted }}>No urgent actions right now. Keep an eye on the crop calendar below.</Body>
                </div>
              ) : (
                <div style={{ padding: "12px 0", textAlign: "center" }}>
                  <div style={{ fontFamily: fonts.serif, fontSize: 18, color: brand.forest, marginBottom: 4 }}>No farm actions yet</div>
                  <Body size="sm" style={{ color: brand.muted, marginBottom: 10 }}>
                    Add your first field or calendar job to start building the daily action list.
                  </Body>
                  <Button variant="secondary" size="sm" onClick={onMapFields}>Map first field</Button>
                </div>
              )}
            </Card>

            {/* Crop calendar */}
            {plantingStats.planted > 0 && (
              <Card padding={16}>
                <div style={{ display: "flex", alignItems: "baseline", justifyContent: "space-between", gap: 8, marginBottom: 10 }}>
                  <Kicker>Crop calendar</Kicker>
                  <button type="button" onClick={() => onNavigate("fields")} style={{ background: "transparent", border: "none", padding: 0, cursor: "pointer", fontFamily: fonts.mono, fontSize: 10, letterSpacing: "0.14em", textTransform: "uppercase", color: brand.forest }}>
                    View fields →
                  </button>
                </div>
                <div style={{ display: "grid", gap: 4 }}>
                  {(fields || []).map((f) => {
                    const p = plantingsMap[f.id]?.[0];
                    if (!p?.crop) return null;
                    const dsp = daysSincePlanting(p.plantingDate, now);
                    const stg = expectedStage(p.crop, dsp);
                    if (!stg) return null;
                    const crop = CROP_CATALOGUE[p.crop];
                    return (
                      <div key={f.id} style={{ display: "grid", gridTemplateColumns: "140px 1fr auto", gap: 8, alignItems: "center", padding: "6px 8px", borderRadius: radius.base, border: `1px solid ${brand.border}`, background: brand.white }}>
                        <div style={{ overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap", fontFamily: fonts.sans, fontSize: 12, fontWeight: 600, color: brand.forest }}>{f.name}</div>
                        <div style={{ display: "flex", alignItems: "center", gap: 6 }}>
                          <span style={{ fontFamily: fonts.sans, fontSize: 11, color: brand.bodySoft }}>{p.crop}</span>
                          <span style={{ fontFamily: fonts.mono, fontSize: 9, color: brand.muted }}>{stg.stageName}</span>
                          <div style={{ flex: 1, display: "flex", gap: 1, height: 4, borderRadius: 2, overflow: "hidden" }}>
                            {crop?.stages.map((_, si) => (
                              <div key={si} style={{ flex: 1, borderRadius: 1, background: si < stg.stageIndex ? brand.forest : si === stg.stageIndex ? brand.moss : brand.border }} />
                            ))}
                          </div>
                        </div>
                        <span style={{ fontFamily: fonts.mono, fontSize: 9, color: brand.muted }}>{dsp}d</span>
                      </div>
                    );
                  }).filter(Boolean)}
                </div>
              </Card>
            )}
          </div>

          {/* Right column */}
          <div style={{ display: "grid", gap: 12, minWidth: 0 }}>
            {/* Quick links */}
            <Card padding={14}>
              <Kicker style={{ marginBottom: 8 }}>Quick actions</Kicker>
              <div style={{ display: "grid", gap: 4 }}>
                {[
                  !hasFields ? { id: "fields", label: "Map first field", sub: "Start setup" } : null,
                  { id: "records", label: "Log application", sub: "Record a spray or fertiliser" },
                  { id: "calendar", label: "Today's jobs", sub: "Plan your day" },
                  { id: "inventory", label: "Store", sub: "Chemical & seed stock" },
                  { id: "observations", label: "Add observation", sub: "Field note or photo" },
                  { id: "documents", label: "Find paperwork", sub: "Certificates & receipts" },
                  { id: "contacts", label: "Contacts", sub: "Suppliers and advisers" },
                ].filter(Boolean).map((item) => (
                  <Row
                    key={item.id}
                    onClick={() => (item.id === "fields" && !hasFields ? onMapFields() : onNavigate(item.id))}
                    style={{ padding: "7px 8px" }}
                  >
                    <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", gap: 8 }}>
                      <span style={{ fontWeight: 600, color: brand.forest, fontSize: 12 }}>{item.label}</span>
                      <span style={{ fontFamily: fonts.mono, fontSize: 9, color: brand.muted, letterSpacing: "0.06em" }}>{item.sub}</span>
                    </div>
                  </Row>
                ))}
              </div>
            </Card>

            {/* Farm info */}
            <Card padding={14}>
              <Kicker style={{ marginBottom: 6 }}>Farm</Kicker>
              <div style={{ fontFamily: fonts.serif, fontSize: 18, color: brand.forest, marginBottom: 4 }}>{farm?.name || "Unnamed"}</div>
              {addrLines.length ? (
                <pre style={{ margin: 0, fontFamily: fonts.mono, fontSize: 10, color: brand.muted, lineHeight: 1.5, whiteSpace: "pre-wrap" }}>{addrLines.join("\n")}</pre>
              ) : null}
            </Card>

            {/* Crop mix summary */}
            {plantingStats.crops.length > 0 && (
              <Card padding={14}>
                <Kicker style={{ marginBottom: 8 }}>Crop mix</Kicker>
                <div style={{ display: "grid", gap: 4 }}>
                  {plantingStats.crops.map(([crop, count]) => (
                    <div key={crop} style={{ display: "flex", alignItems: "center", justifyContent: "space-between", gap: 8, padding: "4px 6px", borderRadius: radius.base, background: brand.bgSection }}>
                      <span style={{ fontFamily: fonts.sans, fontSize: 11.5, color: brand.forest, fontWeight: 500 }}>{crop}</span>
                      <span style={{ fontFamily: fonts.mono, fontSize: 10, color: brand.muted }}>{count} field{count > 1 ? "s" : ""}</span>
                    </div>
                  ))}
                </div>
              </Card>
            )}

            {/* Records summary */}
            <Card padding={14}>
              <Kicker style={{ marginBottom: 8 }}>Records</Kicker>
              <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 6 }}>
                <MiniStat label="Total" value={recordStats.total} />
                <MiniStat label="This week" value={recordStats.thisWeek} />
              </div>
            </Card>

            {/* Livestock summary */}
            {farmLivestock.length > 0 && (
              <Card padding={14} onClick={() => onNavigate("livestock")} interactive>
                <Kicker style={{ marginBottom: 8 }}>Livestock</Kicker>
                <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 6 }}>
                  <MiniStat label="Active" value={farmLivestock.filter((a) => a.status === "active").length} />
                  <MiniStat label="Total" value={farmLivestock.length} />
                </div>
              </Card>
            )}

            {/* Tasks summary */}
            {farmTasks.length > 0 && (
              <Card padding={14} onClick={() => onNavigate("calendar")} interactive>
                <Kicker style={{ marginBottom: 8 }}>Tasks</Kicker>
                <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 6 }}>
                  <MiniStat label="Pending" value={farmTasks.filter((t) => t.status === "pending" || t.status === "in_progress").length} />
                  <MiniStat label="Done" value={farmTasks.filter((t) => t.status === "done").length} />
                </div>
              </Card>
            )}

            {/* Inventory summary */}
            {farmInventory.length > 0 && (() => {
              const expiredCount = farmInventory.filter((i) => i.expiry_date && new Date(i.expiry_date).getTime() < now).length;
              return (
                <Card padding={14} onClick={() => onNavigate("inventory")} interactive>
                  <Kicker style={{ marginBottom: 8 }}>Store</Kicker>
                  <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 6 }}>
                    <MiniStat label="Products" value={farmInventory.length} />
                    <MiniStat label="Expired" value={expiredCount} />
                  </div>
                </Card>
              );
            })()}

            {/* Finance summary */}
            {farmFinances.length > 0 && (() => {
              const yearStart = new Date(new Date().getFullYear(), 0, 1).toISOString().slice(0, 10);
              const thisYear = farmFinances.filter((f) => f.txn_date >= yearStart);
              const income = thisYear.filter((f) => f.txn_type === "income").reduce((s, f) => s + (Number(f.amount) || 0), 0);
              const expense = thisYear.filter((f) => f.txn_type === "expense").reduce((s, f) => s + (Number(f.amount) || 0), 0);
              return (
                <Card padding={14} onClick={() => onNavigate("finance")} interactive>
                  <Kicker style={{ marginBottom: 8 }}>Finance (YTD)</Kicker>
                  <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 6 }}>
                    <MiniStat label="Income" value={`£${Math.round(income).toLocaleString()}`} />
                    <MiniStat label="Expenses" value={`£${Math.round(expense).toLocaleString()}`} />
                  </div>
                </Card>
              );
            })()}
          </div>
        </div>
      </div>

      <style>{`
        @media (max-width: 1180px) {
          .tilth-home-stats > div { grid-column: span 4 !important; }
          .tilth-home-grid { grid-template-columns: 1fr !important; }
        }
        @media (max-width: 640px) {
          .tilth-home-stats > div { grid-column: span 6 !important; }
        }
      `}</style>
    </WorkspaceFrame>
  );
}

function TaskRow({ task, onNavigate }) {
  const priorityStyles = {
    critical: { bg: brand.dangerSoft, border: brand.danger, dot: brand.danger },
    high: { bg: brand.warnSoft, border: brand.warn, dot: brand.warn },
    medium: { bg: brand.bgSection, border: brand.border, dot: brand.muted },
    info: { bg: brand.bgSection, border: brand.border, dot: brand.moss },
  };
  const s = priorityStyles[task.priority] || priorityStyles.medium;

  return (
    <button
      type="button"
      onClick={() => onNavigate(task.action)}
      style={{
        display: "grid",
        gridTemplateColumns: "auto 1fr auto",
        alignItems: "center",
        gap: 10,
        padding: "8px 10px",
        border: `1px solid ${s.border}`,
        background: s.bg,
        borderRadius: radius.base,
        cursor: "pointer",
        textAlign: "left",
        fontFamily: fonts.sans,
        width: "100%",
      }}
    >
      <span style={{ width: 8, height: 8, borderRadius: 999, background: s.dot, flexShrink: 0 }} />
      <div style={{ minWidth: 0 }}>
        <div style={{ display: "flex", alignItems: "baseline", gap: 6, marginBottom: 2 }}>
          <span style={{ fontWeight: 600, fontSize: 12, color: brand.forest, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>{task.title}</span>
          <Pill tone="neutral" style={{ fontSize: 8, textTransform: "none", letterSpacing: "0.06em" }}>{task.category}</Pill>
        </div>
        <div style={{ fontSize: 11, color: brand.bodySoft, lineHeight: 1.35, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>{task.detail}</div>
      </div>
      <span style={{ fontFamily: fonts.mono, fontSize: 9, color: brand.muted, letterSpacing: "0.1em" }}>→</span>
    </button>
  );
}

function MiniStat({ label, value }) {
  return (
    <div style={{ border: `1px solid ${brand.border}`, background: brand.bgSection, borderRadius: radius.base, padding: "6px 8px" }}>
      <div style={{ fontFamily: fonts.mono, fontSize: 9, letterSpacing: "0.14em", textTransform: "uppercase", color: brand.muted, marginBottom: 2 }}>{label}</div>
      <div style={{ fontFamily: fonts.sans, fontSize: 13, fontWeight: 600, color: brand.forest }}>{value}</div>
    </div>
  );
}
