import { Component, useCallback, useEffect, useState } from "react";
import { Link, useLocation, useNavigate, useParams } from "react-router-dom";
import treeLogo from "../../Fangorn Assets/Grey logo tree only.png";
import { supabase, supabaseConfigured } from "../lib/supabaseClient";
import { FieldsSetup } from "./FieldsSetup";
import { AppShell } from "./ui/AppShell.jsx";
import { GlobalAssistant } from "./ui/GlobalAssistant.jsx";
import { brand, fonts, inputStyle, SECTION_IDS } from "./ui/theme.js";
import {
  Body,
  Button,
  Card,
  FieldLabel,
  Headline,
  Kicker,
} from "./ui/primitives.jsx";
import { WorkspaceHome } from "./workspace/WorkspaceHome.jsx";
import { FieldsWorkspace } from "./workspace/FieldsWorkspace.jsx";
import { RecordsWorkspace } from "./workspace/RecordsWorkspace.jsx";
import { SubmissionsWorkspace } from "./workspace/SubmissionsWorkspace.jsx";
import { YieldWorkspace } from "./workspace/YieldWorkspace.jsx";
import { RemoteSensingWorkspace } from "./workspace/RemoteSensingWorkspace.jsx";
import { SoilWorkspace } from "./workspace/SoilWorkspace.jsx";
import { InsightsWorkspace } from "./workspace/InsightsWorkspace.jsx";
import { ReportsWorkspace } from "./workspace/ReportsWorkspace.jsx";
import { hydrateFarmStore } from "./state/localStore.js";
import { getAuthRedirect } from "../lib/authRedirect.js";

function useSupabaseUser() {
  const [user, setUser] = useState(null);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    if (!supabase) {
      setLoading(false);
      return;
    }
    let done = false;
    const watchdog = window.setTimeout(() => {
      if (done) return;
      done = true;
      setLoading(false);
    }, 8000);

    (async () => {
      try {
        const { data } = await supabase.auth.getUser();
        setUser(data?.user || null);
      } catch {
        setUser(null);
      } finally {
        if (!done) {
          done = true;
          window.clearTimeout(watchdog);
          setLoading(false);
        }
      }
    })();
    const { data: sub } = supabase.auth.onAuthStateChange((_event, session) => {
      setUser(session?.user || null);
      if (!done) {
        done = true;
        window.clearTimeout(watchdog);
        setLoading(false);
      }
    });
    return () => {
      done = true;
      window.clearTimeout(watchdog);
      sub.subscription.unsubscribe();
    };
  }, []);

  return { user, loading };
}

function LoggedOutShell({ children }) {
  return (
    <div
      style={{
        minHeight: "100vh",
        background: brand.white,
        color: brand.body,
        display: "flex",
        flexDirection: "column",
      }}
    >
      <style>{`
        @import url('https://fonts.googleapis.com/css2?family=Instrument+Serif:ital@0;1&family=DM+Sans:ital,wght@0,300;0,400;0,500;0,600;1,300;1,400&family=JetBrains+Mono:wght@300;400&display=swap');
      `}</style>
      <header
        style={{
          position: "sticky",
          top: 0,
          zIndex: 10,
          background: "rgba(255,255,255,0.94)",
          backdropFilter: "blur(20px)",
          borderBottom: `1px solid ${brand.border}`,
        }}
      >
        <div
          style={{
            maxWidth: 1200,
            margin: "0 auto",
            padding: "14px 20px",
            display: "flex",
            alignItems: "center",
            justifyContent: "space-between",
            gap: 16,
          }}
        >
          <div style={{ display: "flex", alignItems: "center", gap: 12 }}>
            <img src={treeLogo} alt="Fangorn" style={{ height: 34, width: "auto" }} />
            <div>
              <div
                style={{
                  fontFamily: fonts.mono,
                  fontSize: 11,
                  letterSpacing: "0.18em",
                  textTransform: "uppercase",
                  color: brand.muted,
                }}
              >
                Tilth · Beta
              </div>
              <div style={{ fontFamily: fonts.serif, fontSize: 20, color: brand.forest }}>
                Farm management platform
              </div>
            </div>
          </div>
          <Link
            to="/"
            style={{
              fontFamily: fonts.sans,
              fontSize: 11,
              letterSpacing: "0.12em",
              textTransform: "uppercase",
              color: brand.muted,
              textDecoration: "none",
              padding: "9px 12px",
              borderRadius: 2,
              border: `1px solid ${brand.border}`,
              background: brand.white,
            }}
          >
            Back to Fangorn
          </Link>
        </div>
      </header>
      <div style={{ flex: 1 }}>{children}</div>
    </div>
  );
}

function LoggedOut({ onGoogle, onEmail }) {
  return (
    <LoggedOutShell>
      <div style={{ maxWidth: 1100, margin: "0 auto", padding: "64px 20px 80px" }}>
        <div
          style={{
            display: "grid",
            gridTemplateColumns: "minmax(0, 1.15fr) minmax(0, 0.85fr)",
            gap: 24,
            alignItems: "start",
          }}
          className="tilth-loggedout-grid"
        >
          <Card tone="section" padding={28} elevated>
            <Kicker style={{ marginBottom: 12 }}>Beta access</Kicker>
            <Headline size="xl" style={{ marginBottom: 14 }}>
              Tilth helps you plan, track, and optimise your farm.
            </Headline>
            <Body style={{ marginBottom: 22, maxWidth: 640 }}>
              Sign in to access the workspace — field boundaries, input and spray records,
              RPA/DEFRA submission readiness, yield maps, satellite time-series and LiDAR
              derivatives, all tied to the same field registry.
            </Body>
            <div style={{ display: "flex", flexWrap: "wrap", gap: 12 }}>
              <Button variant="primary" size="lg" onClick={onGoogle}>
                Continue with Google
              </Button>
              <Button variant="secondary" size="lg" onClick={onEmail}>
                Sign in with email
              </Button>
            </div>
          </Card>

          <Card padding={22}>
            <Kicker style={{ marginBottom: 12 }}>POC feature stack</Kicker>
            <ul
              style={{
                listStyle: "none",
                padding: 0,
                margin: 0,
                display: "grid",
                gap: 10,
                fontFamily: fonts.sans,
                fontSize: 14,
                color: brand.bodySoft,
                lineHeight: 1.55,
              }}
            >
              {[
                ["Layer 1", "Boundaries + interactive map + registry + history"],
                ["Layer 2", "Input / spray records with NMax & UKFS validation"],
                ["Layer 3", "RPA / DEFRA submission mapping and exports"],
                ["Layer 4", "Yield maps — clean, visualise, compare years"],
                ["Analytical", "Sentinel-2 NDVI, EA LiDAR, cross-field analytics, PDF reports"],
              ].map(([t, d]) => (
                <li
                  key={t}
                  style={{
                    padding: 12,
                    borderRadius: 2,
                    border: `1px solid ${brand.border}`,
                    background: brand.bgSection,
                  }}
                >
                  <div style={{ fontWeight: 600, color: brand.forest, fontSize: 13 }}>{t}</div>
                  <div>{d}</div>
                </li>
              ))}
            </ul>
          </Card>
        </div>

        <style>{`
          @media (max-width: 900px) {
            .tilth-loggedout-grid { grid-template-columns: 1fr !important; }
          }
        `}</style>
      </div>
    </LoggedOutShell>
  );
}

function FarmSetup({ userId, onCreated, error, setError }) {
  const [saving, setSaving] = useState(false);
  const [name, setName] = useState("");
  const [line1, setLine1] = useState("");
  const [line2, setLine2] = useState("");
  const [city, setCity] = useState("");
  const [region, setRegion] = useState("");
  const [postcode, setPostcode] = useState("");
  const [country, setCountry] = useState("");

  const save = async () => {
    setError(null);
    if (!supabase) return;
    const n = name.trim();
    const a1 = line1.trim();
    if (!n || !a1) {
      setError("Farm name and address line 1 are required.");
      return;
    }
    setSaving(true);
    try {
      const { data, error: e } = await supabase
        .from("farms")
        .insert({
          owner_user_id: userId,
          name: n,
          address_line1: a1,
          address_line2: line2.trim() || null,
          city: city.trim() || null,
          region: region.trim() || null,
          postcode: postcode.trim() || null,
          country: country.trim() || null,
        })
        .select("*")
        .single();
      if (e) throw new Error(e.message);
      onCreated(data);
    } catch (err) {
      setError(err?.message || "Could not save your farm.");
    } finally {
      setSaving(false);
    }
  };

  return (
    <div style={{ maxWidth: 900, margin: "0 auto", padding: "36px 20px 80px" }}>
      <Card tone="section" padding="clamp(22px, 4vw, 34px)" elevated>
        <Kicker style={{ marginBottom: 10 }}>Step 1 — Your farm</Kicker>
        <Headline style={{ marginBottom: 10 }}>Tell us about your farm</Headline>
        <Body style={{ marginBottom: 22 }}>
          This is the first setup step for Tilth. You can update details later as we add more farm
          management features.
        </Body>

        <div style={{ marginBottom: 14 }}>
          <FieldLabel htmlFor="farm-name">Farm name</FieldLabel>
          <input
            id="farm-name"
            value={name}
            onChange={(e) => setName(e.target.value)}
            style={inputStyle}
            autoComplete="organization"
            required
          />
        </div>

        <div style={{ marginBottom: 14 }}>
          <FieldLabel htmlFor="farm-a1">Address line 1</FieldLabel>
          <input
            id="farm-a1"
            value={line1}
            onChange={(e) => setLine1(e.target.value)}
            style={inputStyle}
            autoComplete="address-line1"
            required
          />
        </div>

        <div style={{ marginBottom: 14 }}>
          <FieldLabel htmlFor="farm-a2">Address line 2 (optional)</FieldLabel>
          <input
            id="farm-a2"
            value={line2}
            onChange={(e) => setLine2(e.target.value)}
            style={inputStyle}
            autoComplete="address-line2"
          />
        </div>

        <div
          className="tilth-two-col"
          style={{
            display: "grid",
            gridTemplateColumns: "minmax(0, 1fr) minmax(0, 1fr)",
            gap: 12,
            marginBottom: 14,
          }}
        >
          <div>
            <FieldLabel htmlFor="farm-city">City / town</FieldLabel>
            <input
              id="farm-city"
              value={city}
              onChange={(e) => setCity(e.target.value)}
              style={inputStyle}
              autoComplete="address-level2"
            />
          </div>
          <div>
            <FieldLabel htmlFor="farm-region">Region / state</FieldLabel>
            <input
              id="farm-region"
              value={region}
              onChange={(e) => setRegion(e.target.value)}
              style={inputStyle}
              autoComplete="address-level1"
            />
          </div>
        </div>

        <div
          className="tilth-two-col"
          style={{
            display: "grid",
            gridTemplateColumns: "minmax(0, 1fr) minmax(0, 1fr)",
            gap: 12,
            marginBottom: 14,
          }}
        >
          <div>
            <FieldLabel htmlFor="farm-post">Postcode</FieldLabel>
            <input
              id="farm-post"
              value={postcode}
              onChange={(e) => setPostcode(e.target.value)}
              style={inputStyle}
              autoComplete="postal-code"
            />
          </div>
          <div>
            <FieldLabel htmlFor="farm-country">Country</FieldLabel>
            <input
              id="farm-country"
              value={country}
              onChange={(e) => setCountry(e.target.value)}
              style={inputStyle}
              autoComplete="country-name"
            />
          </div>
        </div>

        {error && (
          <p
            role="alert"
            style={{
              fontFamily: fonts.sans,
              fontSize: 14,
              color: brand.danger,
              marginBottom: 14,
              lineHeight: 1.5,
            }}
          >
            {error}
          </p>
        )}

        <Button variant="primary" size="lg" onClick={save} disabled={saving}>
          {saving ? "Saving…" : "Save and continue"}
        </Button>
      </Card>

      <style>{`
        @media (max-width: 720px) {
          .tilth-two-col { grid-template-columns: 1fr !important; }
        }
      `}</style>
    </div>
  );
}

function LoadingPanel({ children }) {
  return (
    <div style={{ maxWidth: 1200, margin: "0 auto", padding: "70px 24px" }}>
      <Kicker style={{ marginBottom: 10 }}>Tilth</Kicker>
      <div
        style={{
          fontFamily: fonts.sans,
          fontSize: 14,
          color: brand.bodySoft,
        }}
      >
        {children || "Loading…"}
      </div>
    </div>
  );
}

function friendlyErrorMessage(err, fallback = "Something went wrong.") {
  const raw = typeof err === "string" ? err : err?.message;
  if (isDynamicImportFetchError(err)) {
    return "The browser could not load this workspace bundle from Vite. Refresh the page or retry the workspace.";
  }
  if (/failed to fetch|networkerror|load failed/i.test(raw || "")) {
    return "A network request failed. Check the Tilth API/Supabase connection, then retry.";
  }
  return raw || fallback;
}

function isDynamicImportFetchError(err) {
  return /failed to fetch dynamically imported module|importing a module script failed|error loading dynamically imported module/i
    .test(err?.message || "");
}

class WorkspaceErrorBoundary extends Component {
  constructor(props) {
    super(props);
    this.state = { error: null };
  }

  static getDerivedStateFromError(error) {
    return { error };
  }

  componentDidUpdate(prevProps) {
    if (prevProps.resetKey !== this.props.resetKey && this.state.error) {
      this.setState({ error: null });
    }
  }

  render() {
    if (!this.state.error) return this.props.children;
    return (
      <LoadingPanel>
        <div style={{ display: "grid", gap: 12, maxWidth: 640 }}>
          <div>{friendlyErrorMessage(this.state.error, "This workspace could not render.")}</div>
          <Button variant="secondary" size="sm" onClick={() => this.setState({ error: null })}>
            Retry workspace
          </Button>
        </div>
      </LoadingPanel>
    );
  }
}

const retryableImport = (staticLoader, path, version) => {
  if (!version || !import.meta.env.DEV) return staticLoader();
  return import(/* @vite-ignore */ `${path}?tilth_retry=${version}`);
};

const lazyWorkspaceLoaders = {
  rotation: (version) => retryableImport(() => import("./workspace/RotationWorkspace.jsx"), "./workspace/RotationWorkspace.jsx", version),
  compare: (version) => retryableImport(() => import("./workspace/CompareView.jsx"), "./workspace/CompareView.jsx", version),
  observations: (version) => retryableImport(() => import("./workspace/ObservationsWorkspace.jsx"), "./workspace/ObservationsWorkspace.jsx", version),
  weather: (version) => retryableImport(() => import("./workspace/WeatherWorkspace.jsx"), "./workspace/WeatherWorkspace.jsx", version),
  compliance: (version) => retryableImport(() => import("./workspace/ComplianceWorkspace.jsx"), "./workspace/ComplianceWorkspace.jsx", version),
  costs: (version) => retryableImport(() => import("./workspace/CostsWorkspace.jsx"), "./workspace/CostsWorkspace.jsx", version),
  team: (version) => retryableImport(() => import("./workspace/TeamWorkspace.jsx"), "./workspace/TeamWorkspace.jsx", version),
  fieldMode: (version) => retryableImport(() => import("./ui/FieldMode.jsx"), "./ui/FieldMode.jsx", version),
  livestock: (version) => retryableImport(() => import("./workspace/LivestockWorkspace.jsx"), "./workspace/LivestockWorkspace.jsx", version),
  calendar: (version) => retryableImport(() => import("./workspace/CalendarWorkspace.jsx"), "./workspace/CalendarWorkspace.jsx", version),
  inventory: (version) => retryableImport(() => import("./workspace/InventoryWorkspace.jsx"), "./workspace/InventoryWorkspace.jsx", version),
  finance: (version) => retryableImport(() => import("./workspace/FinanceWorkspace.jsx"), "./workspace/FinanceWorkspace.jsx", version),
  documents: (version) => retryableImport(() => import("./workspace/DocumentsWorkspace.jsx"), "./workspace/DocumentsWorkspace.jsx", version),
  contacts: (version) => retryableImport(() => import("./workspace/ContactsWorkspace.jsx"), "./workspace/ContactsWorkspace.jsx", version),
  market: (version) => retryableImport(() => import("./workspace/MarketWorkspace.jsx"), "./workspace/MarketWorkspace.jsx", version),
  audit: (version) => retryableImport(() => import("./workspace/AuditWorkspace.jsx"), "./workspace/AuditWorkspace.jsx", version),
};

const lazyWorkspaceLabels = {
  rotation: "Rotation planner",
  compare: "Comparison view",
  observations: "Observations",
  weather: "Weather",
  compliance: "Compliance",
  costs: "Cost analysis",
  team: "Team",
  fieldMode: "Field mode",
  livestock: "Livestock",
  calendar: "Calendar",
  inventory: "Inventory",
  finance: "Finance",
  documents: "Documents",
  contacts: "Contacts",
  market: "Market",
  audit: "Audit prep",
};

function normalizeSection(section) {
  return SECTION_IDS.includes(section) ? section : "home";
}

export default function TilthApp() {
  const { section } = useParams();
  const location = useLocation();
  const navigate = useNavigate();
  const { user, loading } = useSupabaseUser();
  const [error, setError] = useState(null);
  const [farmLoading, setFarmLoading] = useState(false);
  const [farm, setFarm] = useState(null);
  const [farmFormError, setFarmFormError] = useState(null);
  const [fields, setFields] = useState([]);
  const [fieldsLoading, setFieldsLoading] = useState(false);
  const [fieldsOnboardingSkipped, setFieldsOnboardingSkipped] = useState(false);
  const [fieldsOnboardingDone, setFieldsOnboardingDone] = useState(false);
  const [activeSection, setActiveSection] = useState(() => normalizeSection(section));
  const [fieldMode, setFieldMode] = useState(false);

  const reportGlobalError = useCallback((err, fallback) => {
    setError(friendlyErrorMessage(err, fallback));
  }, []);

  const selectSection = useCallback((nextSection, options = {}) => {
    const normalized = normalizeSection(nextSection);
    setActiveSection(normalized);
    const nextPath = normalized === "home" ? "/tilth" : `/tilth/${normalized}`;
    if (location.pathname !== nextPath) {
      navigate(`${nextPath}${location.search}`, {
        replace: options.replace ?? false,
      });
    }
  }, [location.pathname, location.search, navigate]);

  useEffect(() => {
    const params = new URLSearchParams(window.location.search);
    if (!params.has("calendar")) return;
    params.delete("calendar");
    params.delete("message");
    const next = `${window.location.pathname}${params.toString() ? `?${params.toString()}` : ""}${window.location.hash}`;
    window.history.replaceState({}, "", next);
  }, []);

  useEffect(() => {
    const normalized = normalizeSection(section);
    if (section && normalized !== section) {
      selectSection("home", { replace: true });
      return;
    }
    setActiveSection(normalized);
  }, [section, selectSection]);

  useEffect(() => {
    setError(null);
  }, [activeSection]);

  // Lazy-loaded workspaces — loaded only when the user navigates to them
  const [lazyModules, setLazyModules] = useState({});
  const [lazyErrors, setLazyErrors] = useState({});
  const [lazyLoading, setLazyLoading] = useState({});
  const [lazyVersions, setLazyVersions] = useState({});
  const loadModule = useCallback((key, options = {}) => {
    const loader = lazyWorkspaceLoaders[key];
    if (
      !loader ||
      (!options.force && lazyModules[key]) ||
      lazyLoading[key]
    ) return;

    const version = options.force ? Date.now() : lazyVersions[key] || 0;

    setLazyLoading((currentLoading) => ({ ...currentLoading, [key]: true }));
    setLazyErrors((currentErrors) => ({ ...currentErrors, [key]: null }));
    loader(version)
      .then((module) => {
        setLazyModules((currentModules) => ({ ...currentModules, [key]: module }));
        setLazyErrors((currentErrors) => ({ ...currentErrors, [key]: null }));
      })
      .catch((err) => {
        console.error(`Failed to load Tilth workspace "${key}"`, err);
        if (import.meta.env.DEV && isDynamicImportFetchError(err) && !options.force) {
          const retryVersion = Date.now();
          window.setTimeout(() => {
            setLazyVersions((currentVersions) => ({ ...currentVersions, [key]: retryVersion }));
            loader(retryVersion)
              .then((module) => {
                setLazyModules((currentModules) => ({ ...currentModules, [key]: module }));
                setLazyErrors((currentErrors) => ({ ...currentErrors, [key]: null }));
              })
              .catch((retryErr) => {
                console.error(`Retry failed for Tilth workspace "${key}"`, retryErr);
                setLazyErrors((currentErrors) => ({
                  ...currentErrors,
                  [key]: friendlyErrorMessage(retryErr, "Could not load this workspace."),
                }));
              })
              .finally(() => {
                setLazyLoading((currentLoading) => ({ ...currentLoading, [key]: false }));
              });
          }, 350);
          return;
        }
        setLazyErrors((currentErrors) => ({
          ...currentErrors,
          [key]: friendlyErrorMessage(err, "Could not load this workspace."),
        }));
      })
      .finally(() => {
        setLazyLoading((currentLoading) => ({ ...currentLoading, [key]: false }));
      });
  }, [lazyLoading, lazyModules, lazyVersions]);

  const retryModule = useCallback((key) => {
    const version = Date.now();
    setLazyVersions((currentVersions) => ({ ...currentVersions, [key]: version }));
    setLazyErrors((currentErrors) => ({ ...currentErrors, [key]: null }));
    loadModule(key, { force: true });
  }, [loadModule]);

  useEffect(() => {
    if (lazyWorkspaceLoaders[activeSection] && !lazyErrors[activeSection]) loadModule(activeSection);
  }, [activeSection, lazyErrors, loadModule]);

  useEffect(() => {
    if (fieldMode) loadModule("fieldMode");
  }, [fieldMode, loadModule]);

  const renderLazyWorkspace = (key, exportName, fallbackText, render) => {
    const Component = lazyModules[key]?.[exportName];
    if (Component) return render(Component);
    if (lazyErrors[key]) {
      const label = lazyWorkspaceLabels[key] || fallbackText.replace(/\u2026$/, "");
      return (
        <LoadingPanel>
          <div style={{ display: "grid", gap: 12, maxWidth: 640 }}>
            <div>
              Could not load {label}: {lazyErrors[key]}
            </div>
            <Button variant="secondary" size="sm" onClick={() => retryModule(key)}>
              Retry {label}
            </Button>
          </div>
        </LoadingPanel>
      );
    }
    return <LoadingPanel>{lazyLoading[key] ? fallbackText : `${fallbackText.replace(/\u2026$/, "")}…`}</LoadingPanel>;
  };

  const refreshFields = useCallback(async () => {
    if (!supabase || !farm?.id) return;
    const { data, error: fe } = await supabase
      .from("tilth_fields")
      .select("*")
      .eq("farm_id", farm.id)
      .order("created_at", { ascending: true });
    if (fe) reportGlobalError(fe, "Could not refresh fields.");
    else setFields(data || []);
  }, [farm?.id, reportGlobalError]);

  const skipFieldMapping = () => {
    if (farm?.id) {
      try {
        sessionStorage.setItem(`tilth_skip_field_mapping_${farm.id}`, "1");
      } catch {
        /* private mode */
      }
    }
    setFieldsOnboardingSkipped(true);
    setFieldsOnboardingDone(true);
  };

  const doneFieldMapping = () => {
    setFieldsOnboardingDone(true);
  };

  const onGoogle = async () => {
    setError(null);
    setFarmFormError(null);
    if (!supabase) return;
    const { error: e } = await supabase.auth.signInWithOAuth({
      provider: "google",
      options: { redirectTo: getAuthRedirect("/tilth") },
    });
    if (e) reportGlobalError(e, "Could not start Google sign-in.");
  };

  const onEmail = async () => {
    window.location.href = "/#contact";
  };

  const onSignOut = async () => {
    setError(null);
    setFarmFormError(null);
    if (!supabase) return;
    const { error: e } = await supabase.auth.signOut();
    if (e) reportGlobalError(e, "Could not sign out.");
  };

  useEffect(() => {
    if (!supabase || !user) {
      setFarm(null);
      return;
    }
    let cancelled = false;
    (async () => {
      try {
        setFarmLoading(true);
        setError(null);
        setFarmFormError(null);
        const { data, error: e } = await supabase
          .from("farms")
          .select("*")
          .eq("owner_user_id", user.id)
          .order("created_at", { ascending: true })
          .limit(1)
          .maybeSingle();
        if (cancelled) return;
        if (e) throw new Error(e.message);
        setFarm(data || null);
      } catch (err) {
        if (!cancelled) reportGlobalError(err, "Could not load farm.");
      } finally {
        if (!cancelled) setFarmLoading(false);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [reportGlobalError, user]);

  useEffect(() => {
    if (!farm?.id) {
      setFieldsOnboardingSkipped(false);
      setFieldsOnboardingDone(false);
      return;
    }
    hydrateFarmStore(farm.id).catch(() => {});
    try {
      setFieldsOnboardingSkipped(!!sessionStorage.getItem(`tilth_skip_field_mapping_${farm.id}`));
    } catch {
      setFieldsOnboardingSkipped(false);
    }
    setFieldsOnboardingDone(false);
  }, [farm?.id]);

  useEffect(() => {
    if (!supabase || !farm?.id) {
      setFields([]);
      return undefined;
    }
    let cancelled = false;
    (async () => {
      try {
        setFieldsLoading(true);
        const { data, error: fe } = await supabase
          .from("tilth_fields")
          .select("*")
          .eq("farm_id", farm.id)
          .order("created_at", { ascending: true });
        if (cancelled) return;
        if (fe) throw new Error(fe.message);
        setFields(data || []);
      } catch (err) {
        if (!cancelled) reportGlobalError(err, "Could not load fields.");
      } finally {
        if (!cancelled) setFieldsLoading(false);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [farm?.id, reportGlobalError]);

  if (!supabaseConfigured) {
    return (
      <LoggedOutShell>
        <div style={{ maxWidth: 900, margin: "0 auto", padding: "70px 20px" }}>
          <Headline style={{ marginBottom: 12 }}>Tilth</Headline>
          <Body>
            Supabase isn’t configured yet. Set <code>VITE_SUPABASE_URL</code> and{" "}
            <code>VITE_SUPABASE_ANON_KEY</code>.
          </Body>
        </div>
      </LoggedOutShell>
    );
  }

  if (loading) {
    return (
      <LoggedOutShell>
        <LoadingPanel>Loading…</LoadingPanel>
      </LoggedOutShell>
    );
  }

  if (!user) {
    return <LoggedOut onGoogle={onGoogle} onEmail={onEmail} />;
  }

  if (farmLoading) {
    return (
      <LoggedOutShell>
        <LoadingPanel>Loading your farm…</LoadingPanel>
      </LoggedOutShell>
    );
  }

  if (!farm) {
    return (
      <LoggedOutShell>
        <FarmSetup
          userId={user.id}
          onCreated={(row) => setFarm(row)}
          error={farmFormError}
          setError={setFarmFormError}
        />
      </LoggedOutShell>
    );
  }

  if (fieldsLoading) {
    return (
      <LoggedOutShell>
        <LoadingPanel>Loading fields…</LoadingPanel>
      </LoggedOutShell>
    );
  }

  const needsFieldsOnboarding =
    !fieldsOnboardingSkipped && !fieldsOnboardingDone && fields.length === 0;

  if (needsFieldsOnboarding) {
    return (
      <LoggedOutShell>
        <FieldsSetup
          farm={farm}
          fields={fields}
          onFieldsUpdated={refreshFields}
          onSkip={skipFieldMapping}
          onDone={doneFieldMapping}
        />
      </LoggedOutShell>
    );
  }

  if (fieldMode) {
    const FM = lazyModules.fieldMode?.FieldMode;
    if (FM) {
      return (
        <FM
          farm={farm}
          fields={fields}
          user={user}
          onExit={() => setFieldMode(false)}
          onNavigate={(s) => { setFieldMode(false); selectSection(s); }}
        />
      );
    }
  }

  let view;
  switch (activeSection) {
    case "fields":
      view = <FieldsWorkspace farm={farm} fields={fields} onFieldsUpdated={refreshFields} />;
      break;
    case "records":
      view = <RecordsWorkspace farm={farm} fields={fields} />;
      break;
    case "submissions":
      view = <SubmissionsWorkspace farm={farm} fields={fields} />;
      break;
    case "yield":
      view = <YieldWorkspace farm={farm} fields={fields} />;
      break;
    case "rotation": {
      view = renderLazyWorkspace("rotation", "RotationWorkspace", "Loading rotation planner…", (R) => (
        <R farm={farm} fields={fields} />
      ));
      break;
    }
    case "observations": {
      view = renderLazyWorkspace("observations", "ObservationsWorkspace", "Loading observations…", (O) => (
        <O farm={farm} fields={fields} />
      ));
      break;
    }
    case "sensing":
      view = <RemoteSensingWorkspace farm={farm} fields={fields} />;
      break;
    case "soil":
      view = <SoilWorkspace farm={farm} fields={fields} />;
      break;
    case "weather": {
      view = renderLazyWorkspace("weather", "WeatherWorkspace", "Loading weather…", (W) => (
        <W farm={farm} fields={fields} />
      ));
      break;
    }
    case "insights":
      view = (
        <InsightsWorkspace
          farm={farm}
          fields={fields}
          onNavigate={selectSection}
        />
      );
      break;
    case "compare": {
      view = renderLazyWorkspace("compare", "CompareView", "Loading comparison view…", (C) => (
        <C fields={fields} farmId={farm?.id} />
      ));
      break;
    }
    case "reports":
      view = <ReportsWorkspace farm={farm} fields={fields} />;
      break;
    case "compliance": {
      view = renderLazyWorkspace("compliance", "ComplianceWorkspace", "Loading compliance…", (CP) => (
        <CP farm={farm} fields={fields} />
      ));
      break;
    }
    case "costs": {
      view = renderLazyWorkspace("costs", "CostsWorkspace", "Loading cost analysis…", (CO) => (
        <CO farm={farm} fields={fields} />
      ));
      break;
    }
    case "team": {
      view = renderLazyWorkspace("team", "TeamWorkspace", "Loading team…", (T) => (
        <T farm={farm} user={user} />
      ));
      break;
    }
    case "livestock": {
      view = renderLazyWorkspace("livestock", "LivestockWorkspace", "Loading livestock…", (LS) => (
        <LS farm={farm} fields={fields} />
      ));
      break;
    }
    case "calendar": {
      view = renderLazyWorkspace("calendar", "CalendarWorkspace", "Loading calendar…", (CL) => (
        <CL farm={farm} fields={fields} />
      ));
      break;
    }
    case "inventory": {
      view = renderLazyWorkspace("inventory", "InventoryWorkspace", "Loading inventory…", (IV) => (
        <IV farm={farm} fields={fields} />
      ));
      break;
    }
    case "finance": {
      view = renderLazyWorkspace("finance", "FinanceWorkspace", "Loading finance…", (FN) => (
        <FN farm={farm} fields={fields} />
      ));
      break;
    }
    case "documents": {
      view = renderLazyWorkspace("documents", "DocumentsWorkspace", "Loading documents…", (DC) => (
        <DC farm={farm} fields={fields} />
      ));
      break;
    }
    case "contacts": {
      view = renderLazyWorkspace("contacts", "ContactsWorkspace", "Loading contacts…", (CT) => (
        <CT farm={farm} fields={fields} />
      ));
      break;
    }
    case "market": {
      view = renderLazyWorkspace("market", "MarketWorkspace", "Loading market…", (MK) => (
        <MK farm={farm} fields={fields} />
      ));
      break;
    }
    case "audit": {
      view = renderLazyWorkspace("audit", "AuditWorkspace", "Loading audit prep…", (AU) => (
        <AU farm={farm} fields={fields} />
      ));
      break;
    }
    case "home":
    default:
      view = (
        <WorkspaceHome
          farm={farm}
          fields={fields}
          onNavigate={selectSection}
          onMapFields={() => selectSection("fields")}
        />
      );
      break;
  }

  return (
    <AppShell
      user={user}
      farm={farm}
      activeSection={activeSection}
      onSelectSection={selectSection}
      onSignOut={onSignOut}
      statusBadge={`${fields.length} field${fields.length === 1 ? "" : "s"}`}
      onFieldMode={fields.length > 0 ? () => setFieldMode(true) : undefined}
    >
      <WorkspaceErrorBoundary resetKey={activeSection}>
        {view}
      </WorkspaceErrorBoundary>
      <GlobalAssistant farm={farm} />
      {error ? (
        <div style={{ maxWidth: 1200, margin: "0 auto", padding: "0 24px 24px" }}>
          <Card
            padding={14}
            tone="section"
            style={{
              borderColor: brand.warn,
              color: brand.body,
              display: "flex",
              alignItems: "center",
              justifyContent: "space-between",
              gap: 12,
            }}
          >
            <span>{error}</span>
            <Button variant="ghost" size="sm" onClick={() => setError(null)}>
              Dismiss
            </Button>
          </Card>
        </div>
      ) : null}
    </AppShell>
  );
}
