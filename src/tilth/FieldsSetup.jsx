import { useCallback, useEffect, useRef, useState } from "react";
import { FieldMapThree2D } from "./FieldMapThree2D";
import { getTilthApiBase, tilthApiConfigured } from "../lib/tilthApi.js";
import { fetchOsmFieldAtPoint } from "./osmFieldAtPoint.js";
import { supabase } from "../lib/supabaseClient";
import { triggerNdviRefresh } from "../lib/tilthSentinel.js";
import { triggerSarRefresh } from "../lib/tilthSar.js";
import { autoFillFieldSoil } from "../lib/soilAutoFill.js";

const brand = {
  muted: "#839788",
  forest: "#104E3F",
  moss: "#649A5C",
  bodySoft: "#54695F",
  bgSection: "#EFF4F0",
  border: "#D5E5D7",
  white: "#FFFFFF",
};

function FieldLabel({ children, htmlFor }) {
  return (
    <label
      htmlFor={htmlFor}
      style={{
        display: "block",
        fontFamily: "'DM Sans', system-ui, sans-serif",
        fontSize: 11,
        fontWeight: 600,
        letterSpacing: "0.12em",
        textTransform: "uppercase",
        color: brand.muted,
        marginBottom: 8,
      }}
    >
      {children}
    </label>
  );
}

/** Nominatim accepts `email=` when the client cannot send a proper User-Agent (browser fetch). */
function nominatimContactEmail() {
  const fromEnv =
    typeof import.meta.env.VITE_NOMINATIM_CONTACT_EMAIL === "string"
      ? import.meta.env.VITE_NOMINATIM_CONTACT_EMAIL.trim()
      : "";
  return fromEnv;
}

function looksLikeUkPostcode(s) {
  const t = String(s || "")
    .trim()
    .toUpperCase()
    .replace(/\s+/g, "");
  if (t.length < 5 || t.length > 8) return false;
  return /^[A-Z]{1,2}\d/.test(t) && /\d[A-Z]{2}$/.test(t);
}

/** ISO 3166-1 alpha-2 for Nominatim `countrycodes` (comma-separated allowed; we use one). */
function inferCountryCodes(farm) {
  const c = (farm.country || "").toLowerCase();
  if (
    /\b(united kingdom|great britain|england|scotland|wales|northern ireland)\b/.test(c) ||
    /(^|\s)uk(\s|$)/.test(c) ||
    /\bgb\b/.test(c)
  ) {
    return "gb";
  }
  if (/\b(republic of ireland|ireland)\b/.test(c) && !/northern ireland/.test(c)) return "ie";
  if (farm.postcode?.trim() && looksLikeUkPostcode(farm.postcode)) return "gb";
  return null;
}

function nominatimDelay(ms) {
  return new Promise((r) => {
    window.setTimeout(r, ms);
  });
}

function pickBestNominatimHit(data) {
  if (!Array.isArray(data) || data.length === 0) return null;
  const scored = [...data].sort(
    (a, b) => (parseFloat(b.importance) || 0) - (parseFloat(a.importance) || 0)
  );
  return scored[0];
}

const WGS84_R = 6378137;
const TWO_PI_R = 2 * Math.PI * WGS84_R;
/** Must match `FieldMapThree2D`: halfH = (2πR/2^z) * 0.55, view height in mercator Y = 2*halfH. */
const ORTHO_HALF_H_FRAC = 0.55;

function lonLatToMercMeters(lon, lat) {
  const λ = (lon * Math.PI) / 180;
  const φ = (lat * Math.PI) / 180;
  const x = WGS84_R * λ;
  const y = WGS84_R * Math.log(Math.tan(Math.PI / 4 + φ / 2));
  return { x, y };
}

/**
 * Largest integer zoom in [minZ, maxZ] so the Three ortho view still contains the bbox (Web Mercator), with padding.
 */
function zoomToFitMercatorSize(mercW, mercH, aspectWidthOverHeight, pad, minZ, maxZ) {
  const aspect = Math.max(0.75, Math.min(3, aspectWidthOverHeight));
  const w = Math.max(1, mercW) * pad;
  const h = Math.max(1, mercH) * pad;
  let bestZ = minZ;
  for (let z = maxZ; z >= minZ; z -= 1) {
    const span = TWO_PI_R / 2 ** z;
    const visH = span * 2 * ORTHO_HALF_H_FRAC;
    const visW = visH * aspect;
    if (visH >= h && visW >= w) {
      bestZ = z;
      break;
    }
  }
  return bestZ;
}

/** Centre + zoom from a Nominatim hit so the whole `boundingbox` fits (e.g. postcode sector). */
function viewFromNominatimHit(hit) {
  let lat = parseFloat(hit.lat);
  let lng = parseFloat(hit.lon);
  if (!Number.isFinite(lat) || !Number.isFinite(lng)) return null;

  const bb = hit.boundingbox;
  if (!Array.isArray(bb) || bb.length < 4) {
    return { lat, lng, zoom: 17 };
  }
  const south = Number(bb[0]);
  const north = Number(bb[1]);
  const west = Number(bb[2]);
  const east = Number(bb[3]);
  if (![south, north, west, east].every(Number.isFinite) || north <= south || east <= west) {
    return { lat, lng, zoom: 17 };
  }

  lat = (south + north) / 2;
  lng = (west + east) / 2;

  const corners = [
    lonLatToMercMeters(west, south),
    lonLatToMercMeters(east, south),
    lonLatToMercMeters(west, north),
    lonLatToMercMeters(east, north),
  ];
  let minx = Infinity;
  let maxx = -Infinity;
  let miny = Infinity;
  let maxy = -Infinity;
  for (const c of corners) {
    minx = Math.min(minx, c.x);
    maxx = Math.max(maxx, c.x);
    miny = Math.min(miny, c.y);
    maxy = Math.max(maxy, c.y);
  }
  const mercW = maxx - minx;
  const mercH = maxy - miny;

  const viewportAspect =
    typeof window !== "undefined"
      ? window.innerWidth / Math.max(window.innerHeight, 1)
      : 1.65;
  const aspect = Math.max(0.85, Math.min(2.8, viewportAspect * 0.66));
  const zoom = zoomToFitMercatorSize(mercW, mercH, aspect, 1.14, 2, 19);
  return { lat, lng, zoom };
}

function closeRingLatLng(ring) {
  if (!ring?.length) return ring;
  const first = ring[0];
  const last = ring[ring.length - 1];
  if (first.lat === last.lat && first.lng === last.lng) return ring;
  return [...ring, { lat: first.lat, lng: first.lng }];
}

/**
 * Step 2 onboarding: Three.js orthographic map + OSM tiles; draw field polygons as WGS84 lat/lng.
 */
export function FieldsSetup({ farm, fields, onFieldsUpdated, onSkip, onDone }) {
  /** null = geocoding in progress; set before map mounts so the viewer opens on the farm. */
  const [mapView, setMapView] = useState(null);
  const [mapMode, setMapMode] = useState("pan");
  const [geocodeNote, setGeocodeNote] = useState(null);
  const [outlineBusy, setOutlineBusy] = useState(false);
  const findFieldAbortRef = useRef(null);
  const [lastFoundOutline, setLastFoundOutline] = useState(null);
  const [draftRing, setDraftRing] = useState([]);
  const [fieldName, setFieldName] = useState("");
  const [formError, setFormError] = useState(null);
  const [saving, setSaving] = useState(false);

  useEffect(() => {
    if (!farm?.id) return undefined;
    let cancelled = false;
    setMapView(null);

    const freeText = [
      farm.address_line1,
      farm.address_line2,
      farm.city,
      farm.region,
      farm.postcode,
      farm.country,
    ]
      .filter(Boolean)
      .join(", ");

    const NOMINATIM_GAP_MS = 1100;
    const email = nominatimContactEmail();

    const fetchJson = async (url) => {
      const ac = new AbortController();
      const timer = window.setTimeout(() => ac.abort(), 15000);
      try {
        const res = await fetch(url, {
          headers: { Accept: "application/json" },
          signal: ac.signal,
        });
        if (!res.ok) throw new Error(String(res.status));
        return await res.json();
      } finally {
        window.clearTimeout(timer);
      }
    };

    function nominatimUrl(params) {
      const p = new URLSearchParams({ format: "json", addressdetails: "0" });
      const api = getTilthApiBase();
      if (!api && email) p.set("email", email);
      for (const [k, v] of Object.entries(params)) {
        if (v != null && String(v).trim() !== "") p.set(k, String(v).trim());
      }
      return api
        ? `${api}/api/nominatim/search?${p.toString()}`
        : `https://nominatim.openstreetmap.org/search?${p.toString()}`;
    }

    (async () => {
      if (!freeText.trim()) {
        if (!cancelled) {
          setMapView({ lat: 54, lng: -2, zoom: 6, isFallback: true });
          setGeocodeNote("No address on file — pan the map to your farm.");
        }
        return;
      }
      if (!cancelled) setGeocodeNote("Locating farm address…");

      const applyHit = (hit) => {
        if (!hit) return false;
        const v = viewFromNominatimHit(hit);
        if (!v) return false;
        if (!cancelled) {
          setMapView({ lat: v.lat, lng: v.lng, zoom: v.zoom, isFallback: false });
          setGeocodeNote(null);
        }
        return true;
      };

      const street = [farm.address_line1, farm.address_line2].filter(Boolean).join(", ");
      const city = farm.city?.trim() || "";
      const region = farm.region?.trim() || "";
      const postcode = farm.postcode?.trim() || "";
      const countryRaw = farm.country?.trim() || "";
      const countryCodes = inferCountryCodes(farm);
      const country =
        countryRaw || (countryCodes === "gb" ? "United Kingdom" : "");

      const attempts = [];

      if (postcode && country) {
        attempts.push(() => nominatimUrl({ limit: "1", postalcode: postcode, country }));
      }
      if (street && postcode && country) {
        const p = { limit: "1", street, postalcode: postcode, country };
        if (city) p.city = city;
        attempts.push(() => nominatimUrl(p));
      }
      if (street && postcode && country && region && countryCodes === "gb") {
        attempts.push(() =>
          nominatimUrl({
            limit: "1",
            street,
            postalcode: postcode,
            country,
            county: region,
            ...(city ? { city } : {}),
          })
        );
      }
      if (street && country) {
        const p = { limit: "1", street, country };
        if (city) p.city = city;
        if (postcode) p.postalcode = postcode;
        if (region) p.state = region;
        attempts.push(() => nominatimUrl(p));
      }
      if (freeText.trim()) {
        const p = { limit: "5", q: freeText };
        if (countryCodes) p.countrycodes = countryCodes;
        attempts.push(() => nominatimUrl(p));
      }
      if (farm.address_line1?.trim() && postcode) {
        const q = `${farm.address_line1.trim()}, ${postcode}`;
        const p = { limit: "5", q };
        if (countryCodes) p.countrycodes = countryCodes;
        attempts.push(() => nominatimUrl(p));
      }
      if (postcode && countryCodes === "gb") {
        attempts.push(() =>
          nominatimUrl({ limit: "5", q: `${postcode}, United Kingdom`, countrycodes: "gb" })
        );
      }

      const seen = new Set();
      let callIdx = 0;

      try {
        for (const makeUrl of attempts) {
          if (cancelled) return;
          const url = makeUrl();
          if (seen.has(url)) continue;
          seen.add(url);
          if (callIdx++ > 0) await nominatimDelay(NOMINATIM_GAP_MS);
          if (cancelled) return;

          const data = await fetchJson(url);
          const hit = pickBestNominatimHit(Array.isArray(data) ? data : []);
          if (applyHit(hit)) return;
        }

        if (!cancelled) {
          setMapView({ lat: 54, lng: -2, zoom: 6, isFallback: true });
          setGeocodeNote(
            tilthApiConfigured()
              ? "Address not found — pan and zoom to your farm on the map."
              : email
                ? "Address not found — pan and zoom to your farm on the map."
                : "Address not found — pan and zoom to your farm on the map."
          );
        }
      } catch {
        if (!cancelled) {
          setMapView({ lat: 54, lng: -2, zoom: 6, isFallback: true });
          setGeocodeNote("Could not reach geocoder — pan the map to your farm.");
        }
      }
    })();

    return () => {
      cancelled = true;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps -- re-run geocode when address fields change; `farm` ref alone is unstable
  }, [
    farm?.id,
    farm?.address_line1,
    farm?.address_line2,
    farm?.city,
    farm?.region,
    farm?.postcode,
    farm?.country,
  ]);

  const handleFindFieldClick = useCallback(async (lat, lng) => {
    findFieldAbortRef.current?.abort();
    const ac = new AbortController();
    findFieldAbortRef.current = ac;
    setFormError(null);
    setOutlineBusy(true);
    try {
      const outline = await fetchOsmFieldAtPoint(lat, lng, { signal: ac.signal });
      if (ac.signal.aborted) return;
      if (!outline) {
        setLastFoundOutline(null);
        setFormError(
          "We could not find a saved boundary at that point. Try another spot, zoom in, or draw the field by hand."
        );
        return;
      }
      setLastFoundOutline(outline);
      setDraftRing(outline.ring.map((p) => ({ lat: p.lat, lng: p.lng })));
      setFieldName((prev) => {
        const existing = String(prev || "").trim();
        if (existing) return prev;
        const tags = outline.tags && typeof outline.tags === "object" ? outline.tags : {};
        const nameVariants = [
          tags.name,
          tags.official_name,
          tags.short_name,
          tags.loc_name,
          tags["name:en"],
          tags["name:ga"],
          tags["name:cy"],
        ]
          .map((v) => String(v || "").trim())
          .filter(Boolean);

        // Any name:* tag (OSM sometimes only has a localized variant).
        if (nameVariants.length === 0) {
          for (const [k, v] of Object.entries(tags)) {
            if (!k.startsWith("name:")) continue;
            const t = String(v || "").trim();
            if (t) {
              nameVariants.push(t);
              break;
            }
          }
        }

        const refVariants = [
          tags.ref,
          tags.local_ref,
          tags["ref:GB:field"],
          tags["ref:field"],
          tags["field_ref"],
        ]
          .map((v) => String(v || "").trim())
          .filter(Boolean);

        const label = String(outline.label || "").trim();
        const labelLooksGeneric =
          !label ||
          label === "Land outline" ||
          label.toLowerCase() === "farmland" ||
          label.toLowerCase() === "meadow" ||
          label.toLowerCase() === "orchard" ||
          label.toLowerCase() === "farmyard" ||
          label.toLowerCase() === "vineyard";

        const suggested =
          nameVariants[0] ||
          refVariants[0] ||
          (labelLooksGeneric ? "" : label) ||
          "";
        return suggested || prev;
      });
    } catch (e) {
      if (e?.name === "AbortError" || ac.signal.aborted) return;
      if (e?.status === 429) {
        setFormError(
          "The boundary lookup is busy. Wait a few seconds, then click again or draw the field by hand."
        );
      } else {
        setFormError("We could not look up that boundary. Try again or draw the field by hand.");
      }
    } finally {
      if (findFieldAbortRef.current === ac) {
        findFieldAbortRef.current = null;
        setOutlineBusy(false);
      }
    }
  }, []);

  const clearDraft = () => {
    setDraftRing([]);
    setFormError(null);
  };

  const saveField = async () => {
    setFormError(null);
    const name = fieldName.trim();
    if (!name) {
      setFormError("Field name is required.");
      return;
    }
    if (draftRing.length < 3) {
      setFormError(
        "Find an existing boundary or click around the field to draw one before saving."
      );
      return;
    }
    const ring = closeRingLatLng(draftRing);
    if (!supabase) return;
    setSaving(true);
    try {
      const { data, error } = await supabase
        .from("tilth_fields")
        .insert({
          farm_id: farm.id,
          name,
          boundary: ring.map(({ lat, lng }) => ({ lat, lng })),
        })
        .select("id")
        .single();
      if (error) throw new Error(error.message);
      setFieldName("");
      clearDraft();
      // Auto-kick both Sentinel-2 NDVI and Sentinel-1 SAR ingests as
      // soon as the field is saved. Fire-and-forget — the Tilth API
      // queues the work and the Satellite / Radar workspaces surface
      // results via Realtime when the user navigates there. Failures
      // are logged but never block the save. The server-side periodic
      // sweep will catch up later if either fails to kick off.
      if (data?.id) {
        triggerNdviRefresh(data.id).catch(() => {});
        triggerSarRefresh(data.id).catch(() => {});
        autoFillFieldSoil(farm.id, data.id, ring).catch(() => {});
      }
      await onFieldsUpdated?.();
    } catch (e) {
      setFormError(e?.message || "Could not save field.");
    } finally {
      setSaving(false);
    }
  };

  return (
    <div style={{ maxWidth: 1200, margin: "0 auto", padding: "36px 20px 80px" }}>
      <div
        style={{
          border: `1px solid ${brand.border}`,
          background: brand.bgSection,
          borderRadius: 2,
          padding: "clamp(22px, 4vw, 34px)",
          boxShadow: "0 18px 70px rgba(16,78,63,0.08)",
        }}
      >
        <div
          style={{
            fontFamily: "'JetBrains Mono', ui-monospace, monospace",
            fontSize: 11,
            letterSpacing: "0.18em",
            textTransform: "uppercase",
            color: brand.moss,
            marginBottom: 10,
          }}
        >
          Step 2 — Your fields
        </div>
        <h1
          style={{
            fontFamily: "'Instrument Serif', Georgia, serif",
            fontSize: "clamp(28px, 4.5vw, 40px)",
            fontWeight: 400,
            color: brand.forest,
            letterSpacing: "-0.02em",
            lineHeight: 1.1,
            marginBottom: 10,
          }}
        >
          Map your fields
        </h1>
        <p
          style={{
            fontFamily: "'DM Sans', system-ui, sans-serif",
            fontSize: 15,
            fontWeight: 300,
            color: brand.bodySoft,
            lineHeight: 1.65,
            marginBottom: 18,
            maxWidth: 820,
          }}
        >
          Start by finding your farm on the map. If a boundary is already available,
          click inside the field to use it. If not, choose <strong>Draw boundary</strong> and click
          around the field corners. Add a name, save, then repeat for the fields you want in Tilth.
        </p>

        <div
          style={{
            display: "grid",
            gridTemplateColumns: "minmax(0, 1fr) minmax(280px, 320px)",
            gap: 18,
            alignItems: "start",
          }}
          className="tilth-fields-layout"
        >
          <div>
            <div
              style={{
                display: "flex",
                flexWrap: "wrap",
                gap: 8,
                marginBottom: 10,
                alignItems: "center",
              }}
            >
              {[
                ["pan", "Pan map"],
                ["find", "Use saved boundary"],
                ["draw", "Draw boundary"],
              ].map(([id, label]) => (
                <button
                  key={id}
                  type="button"
                  onClick={() => setMapMode(id)}
                  style={{
                    fontFamily: "'DM Sans', system-ui, sans-serif",
                    fontSize: 11,
                    letterSpacing: "0.1em",
                    textTransform: "uppercase",
                    padding: "10px 14px",
                    borderRadius: 2,
                    border: `1px solid ${mapMode === id ? brand.forest : brand.border}`,
                    background: mapMode === id ? brand.forest : brand.white,
                    color: mapMode === id ? brand.white : brand.forest,
                    cursor: "pointer",
                  }}
                >
                  {label}
                </button>
              ))}
              <button
                type="button"
                onClick={clearDraft}
                style={{
                  fontFamily: "'DM Sans', system-ui, sans-serif",
                  fontSize: 11,
                  letterSpacing: "0.1em",
                  textTransform: "uppercase",
                  padding: "10px 14px",
                  borderRadius: 2,
                  border: `1px solid ${brand.border}`,
                  background: brand.white,
                  color: brand.muted,
                  cursor: "pointer",
                }}
              >
                Clear draft
              </button>
            </div>

            {mapView ? (
              <FieldMapThree2D
                key={`${mapView.lat.toFixed(6)}-${mapView.lng.toFixed(6)}-${mapView.zoom}`}
                center={[mapView.lat, mapView.lng]}
                zoom={mapView.zoom}
                savedFields={fields || []}
                draftRing={draftRing}
                mapMode={mapMode}
                onAddVertex={(lat, lng) => {
                  setDraftRing((r) => [...r, { lat, lng }]);
                  setFormError(null);
                }}
                onFindFieldClick={handleFindFieldClick}
              />
            ) : (
              <div
                style={{
                  width: "100%",
                  minHeight: 420,
                  height: "min(62vh, 640px)",
                  borderRadius: 2,
                  border: `1px solid ${brand.border}`,
                  background: brand.bgSection,
                  display: "flex",
                  alignItems: "center",
                  justifyContent: "center",
                  fontFamily: "'DM Sans', system-ui, sans-serif",
                  fontSize: 15,
                  color: brand.muted,
                }}
              >
                Locating your farm on the map…
              </div>
            )}

            <div
              style={{
                marginTop: 10,
                fontFamily: "'JetBrains Mono', ui-monospace, monospace",
                fontSize: 10,
                color: brand.muted,
                lineHeight: 1.55,
              }}
            >
              {geocodeNote ? `${geocodeNote} ` : ""}
              Drag to move the map · Scroll to zoom · Use saved boundary or draw your own ·
              Boundary points: <strong>{draftRing.length}</strong>
              {outlineBusy ? " · Looking for a boundary…" : ""}
              {fields?.length ? (
                <>
                  {" "}
                  · Saved fields: <strong>{fields.length}</strong>
                </>
              ) : null}
            </div>
          </div>

          <div
            style={{
              border: `1px solid ${brand.border}`,
              borderRadius: 2,
              background: brand.white,
              padding: 16,
            }}
          >
            {lastFoundOutline ? (
              <div style={{ marginBottom: 14 }}>
                <FieldLabel>Selected boundary</FieldLabel>
                <details
                  style={{
                    border: `1px solid ${brand.border}`,
                    borderRadius: 2,
                    background: brand.bgSection,
                    padding: 10,
                  }}
                >
                  <summary
                    style={{
                      cursor: "pointer",
                      fontFamily: "'DM Sans', system-ui, sans-serif",
                      fontSize: 13,
                      color: brand.forest,
                      fontWeight: 600,
                    }}
                  >
                    Boundary found. Open technical details.
                  </summary>
                  <div
                    style={{
                      fontFamily: "'JetBrains Mono', ui-monospace, monospace",
                      fontSize: 11,
                      color: brand.bodySoft,
                      lineHeight: 1.5,
                      marginBottom: 8,
                      whiteSpace: "pre-wrap",
                      wordBreak: "break-word",
                    }}
                  >
                    <strong style={{ color: brand.forest }}>id</strong>: {String(lastFoundOutline.id || "")}
                    {"\n"}
                    <strong style={{ color: brand.forest }}>label</strong>:{" "}
                    {String(lastFoundOutline.label || "")}
                    {"\n"}
                    <strong style={{ color: brand.forest }}>type</strong>:{" "}
                    {String(lastFoundOutline.element?.type || "")}
                  </div>

                  <div
                    style={{
                      fontFamily: "'JetBrains Mono', ui-monospace, monospace",
                      fontSize: 11,
                      color: brand.bodySoft,
                      lineHeight: 1.5,
                      whiteSpace: "pre-wrap",
                      wordBreak: "break-word",
                      maxHeight: 220,
                      overflowY: "auto",
                      paddingTop: 8,
                      borderTop: `1px solid ${brand.border}`,
                    }}
                  >
                    {JSON.stringify(lastFoundOutline.element || lastFoundOutline.tags || {}, null, 2)}
                  </div>
                </details>
              </div>
            ) : null}

            <div
              style={{
                marginBottom: 14,
                padding: "10px 12px",
                borderRadius: 2,
                background: brand.bgSection,
                border: `1px solid ${brand.border}`,
                fontFamily: "'DM Sans', system-ui, sans-serif",
                fontSize: 12,
                color: brand.bodySoft,
                lineHeight: 1.5,
              }}
            >
              <strong style={{ color: brand.forest }}>Use a saved boundary</strong>
              {!mapView ? " — waiting for map." : null}
              {mapView && outlineBusy ? " — looking for a boundary at your click…" : null}
              {mapView && !outlineBusy ? (
                <>
                  {" "}
                  — choose <strong>Use saved boundary</strong>, then click inside a field. If nothing
                  appears, use <strong>Draw boundary</strong>.
                </>
              ) : null}
            </div>

            <div style={{ marginBottom: 14 }}>
              <FieldLabel htmlFor="field-name">Field name</FieldLabel>
              <input
                id="field-name"
                value={fieldName}
                onChange={(e) => setFieldName(e.target.value)}
                style={{
                  width: "100%",
                  boxSizing: "border-box",
                  fontFamily: "'DM Sans', system-ui, sans-serif",
                  fontSize: 15,
                  padding: "12px 12px",
                  border: `1px solid ${brand.border}`,
                  borderRadius: 2,
                }}
                placeholder="e.g. North paddock"
              />
            </div>

            <div
              style={{
                fontFamily: "'DM Sans', system-ui, sans-serif",
                fontSize: 13,
                color: brand.bodySoft,
                marginBottom: 12,
                lineHeight: 1.5,
              }}
            >
              The <strong>orange</strong> line is your draft boundary. A saved boundary can fill it
              for you; drawing lets you place the corners yourself.
            </div>

            {formError && (
              <p
                role="alert"
                style={{
                  color: "#a33",
                  fontSize: 14,
                  marginBottom: 12,
                  lineHeight: 1.45,
                }}
              >
                {formError}
              </p>
            )}

            <button
              type="button"
              onClick={saveField}
              disabled={saving}
              style={{
                width: "100%",
                fontFamily: "'DM Sans', system-ui, sans-serif",
                fontSize: 12,
                letterSpacing: "0.12em",
                textTransform: "uppercase",
                padding: "14px 16px",
                borderRadius: 2,
                border: `1px solid ${brand.forest}`,
                background: brand.forest,
                color: brand.white,
                cursor: saving ? "wait" : "pointer",
                marginBottom: 10,
              }}
            >
              {saving ? "Saving…" : "Save field"}
            </button>

            {Array.isArray(fields) && fields.length > 0 ? (
              <button
                type="button"
                onClick={onDone}
                style={{
                  width: "100%",
                  fontFamily: "'DM Sans', system-ui, sans-serif",
                  fontSize: 12,
                  letterSpacing: "0.08em",
                  textTransform: "uppercase",
                  padding: "12px 14px",
                  borderRadius: 2,
                  border: `1px solid ${brand.border}`,
                  background: brand.white,
                  color: brand.forest,
                  cursor: "pointer",
                  marginBottom: 10,
                }}
              >
                Done adding fields
              </button>
            ) : null}

            <button
              type="button"
              onClick={onSkip}
              style={{
                width: "100%",
                fontFamily: "'DM Sans', system-ui, sans-serif",
                fontSize: 12,
                letterSpacing: "0.08em",
                textTransform: "uppercase",
                padding: "12px 14px",
                borderRadius: 2,
                border: `1px solid ${brand.border}`,
                background: brand.white,
                color: brand.muted,
                cursor: "pointer",
              }}
            >
              Skip for now
            </button>
          </div>
        </div>
      </div>
      <style>{`
        @media (max-width: 900px) {
          .tilth-fields-layout { grid-template-columns: 1fr !important; }
        }
      `}</style>
    </div>
  );
}
