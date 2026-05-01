import { Component, useCallback, useEffect, useState } from "react";
import { Link, useLocation, useNavigate, useParams } from "react-router-dom";
import treeLogo from "../../Fangorn Assets/Grey logo tree only.png";
import { supabase, supabaseConfigured } from "../lib/supabaseClient";
import { fetchTilthApi, getTilthApiBase } from "../lib/tilthApi.js";
import { AppShell } from "./ui/AppShell.jsx";
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
import { hydrateFarmStore } from "./state/localStore.js";
import { getAuthRedirect } from "../lib/authRedirect.js";
import { FieldsSetup } from "./FieldsSetup.jsx";
import { GlobalAssistant } from "./ui/GlobalAssistant.jsx";
import { FieldMode } from "./ui/FieldMode.jsx";
import { FieldsWorkspace } from "./workspace/FieldsWorkspace.jsx";
import { RecordsWorkspace } from "./workspace/RecordsWorkspace.jsx";
import { SubmissionsWorkspace } from "./workspace/SubmissionsWorkspace.jsx";
import { YieldWorkspace } from "./workspace/YieldWorkspace.jsx";
import { RotationWorkspace } from "./workspace/RotationWorkspace.jsx";
import { ObservationsWorkspace } from "./workspace/ObservationsWorkspace.jsx";
import { RemoteSensingWorkspace } from "./workspace/RemoteSensingWorkspace.jsx";
import { SoilWorkspace } from "./workspace/SoilWorkspace.jsx";
import { WeatherWorkspace } from "./workspace/WeatherWorkspace.jsx";
import { InsightsWorkspace } from "./workspace/InsightsWorkspace.jsx";
import { CompareView } from "./workspace/CompareView.jsx";
import { ReportsWorkspace } from "./workspace/ReportsWorkspace.jsx";
import { ComplianceWorkspace } from "./workspace/ComplianceWorkspace.jsx";
import { CostsWorkspace } from "./workspace/CostsWorkspace.jsx";
import { TeamWorkspace } from "./workspace/TeamWorkspace.jsx";
import { LivestockWorkspace } from "./workspace/LivestockWorkspace.jsx";
import { CalendarWorkspace } from "./workspace/CalendarWorkspace.jsx";
import { InventoryWorkspace } from "./workspace/InventoryWorkspace.jsx";
import { FinanceWorkspace } from "./workspace/FinanceWorkspace.jsx";
import { DocumentsWorkspace } from "./workspace/DocumentsWorkspace.jsx";
import { ContactsWorkspace } from "./workspace/ContactsWorkspace.jsx";
import { MarketWorkspace } from "./workspace/MarketWorkspace.jsx";
import { AuditWorkspace } from "./workspace/AuditWorkspace.jsx";

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
        setUser((prev) => (prev?.id === data?.user?.id ? prev : data?.user || null));
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
      setUser((prev) => (prev?.id === session?.user?.id ? prev : session?.user || null));
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
        overflowX: "hidden",
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
            minWidth: 0,
          }}
          className="tilth-loggedout-header"
        >
          <div className="tilth-loggedout-brand" style={{ display: "flex", alignItems: "center", gap: 12, minWidth: 0 }}>
            <img src={treeLogo} alt="Fangorn" style={{ height: 34, width: "auto" }} />
            <div style={{ minWidth: 0 }}>
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
              <div className="tilth-loggedout-title" style={{ fontFamily: fonts.serif, fontSize: 20, color: brand.forest }}>
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
      <style>{`
        @media (max-width: 520px) {
          .tilth-loggedout-header { padding: 12px 16px !important; gap: 10px !important; }
          .tilth-loggedout-brand { gap: 9px !important; }
          .tilth-loggedout-brand img { height: 30px !important; }
          .tilth-loggedout-title { font-size: 17px !important; line-height: 1.1 !important; }
        }
      `}</style>
    </div>
  );
}

function LoggedOut({ onGoogle, onEmail }) {
  return (
    <LoggedOutShell>
      <div style={{ maxWidth: 1100, margin: "0 auto", padding: "64px 20px 80px", width: "100%", boxSizing: "border-box" }}>
        <div
          style={{
            display: "grid",
            gridTemplateColumns: "repeat(auto-fit, minmax(min(100%, 360px), 1fr))",
            gap: 24,
            alignItems: "start",
          }}
          className="tilth-loggedout-grid"
        >
          <Card tone="section" padding={28} elevated>
            <Kicker style={{ marginBottom: 12 }}>Beta access</Kicker>
            <Headline size="xl" style={{ marginBottom: 14 }}>
              Keep the day-to-day farm work in one calm place.
            </Headline>
            <Body style={{ marginBottom: 22, maxWidth: 640 }}>
              Map fields, plan jobs, keep spray and stock records, store documents, check
              weather, and prepare reports from the same farm workspace.
            </Body>
            <div style={{ display: "flex", flexWrap: "wrap", gap: 12 }}>
              <Button variant="primary" size="lg" onClick={onGoogle}>
                Continue with Google
              </Button>
              <Button variant="secondary" size="lg" onClick={onEmail}>
                Request access
              </Button>
            </div>
          </Card>

          <Card padding={22}>
            <Kicker style={{ marginBottom: 12 }}>What Tilth helps with</Kicker>
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
                ["Fields", "Keep boundaries, cropping, notes, and history together."],
                ["Jobs and records", "Plan work, log sprays and inputs, and keep audit evidence tidy."],
                ["Documents", "Store invoices, certificates, maps, soil tests, and reports."],
                ["Decisions", "Use weather, field observations, yield, and market notes in one place."],
                ["Reports", "Prepare farm summaries when you need to share or review progress."],
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
          @media (max-width: 520px) {
            .tilth-loggedout-grid { gap: 14px !important; }
            .tilth-loggedout-grid h1 { font-size: clamp(38px, 14vw, 56px) !important; line-height: 1.05 !important; }
            .tilth-loggedout-grid button { width: 100%; justify-content: center; }
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
    return "This part of Tilth did not load cleanly. Refresh the page and try again.";
  }
  if (/failed to fetch|networkerror|load failed/i.test(raw || "")) {
    return "Tilth could not reach the service it needs. Check your connection and try again.";
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

function normalizeSection(section) {
  return SECTION_IDS.includes(section) ? section : "home";
}

async function loadAccessibleFarm(userId) {
  let clientError = null;
  const { data: owned, error: ownedError } = await supabase
    .from("farms")
    .select("*")
    .eq("owner_user_id", userId)
    .order("created_at", { ascending: true })
    .limit(1);
  if (owned?.[0]) return owned[0];
  if (ownedError) clientError = ownedError;

  const { data: memberships, error: memberError } = await supabase
    .from("farm_members")
    .select("role, farms(*)")
    .eq("user_id", userId)
    .order("created_at", { ascending: true })
    .limit(1);
  if (memberships?.[0]?.farms) return memberships[0].farms;
  if (memberError) clientError = clientError || memberError;

  const apiBase = getTilthApiBase();
  if (!apiBase) {
    if (clientError) throw new Error(clientError.message);
    return null;
  }
  const { data: sessionData } = await supabase.auth.getSession();
  const token = sessionData?.session?.access_token;
  if (!token) {
    if (clientError) throw new Error(clientError.message);
    return null;
  }
  const response = await fetch(`${apiBase}/api/farms/current`, {
    headers: { Authorization: `Bearer ${token}` },
  });
  if (!response.ok) {
    if (clientError) throw new Error(clientError.message);
    throw new Error("Could not confirm your farm access.");
  }
  const payload = await response.json().catch(() => ({}));
  return payload?.farm || null;
}

async function getAuthHeaders() {
  const { data: sessionData } = await supabase.auth.getSession();
  const token = sessionData?.session?.access_token;
  return token ? { Authorization: `Bearer ${token}` } : {};
}

async function loadFarmFields(farmId) {
  const headers = await getAuthHeaders();
  if (headers.Authorization) {
    const response = await fetchTilthApi(`/api/farms/${encodeURIComponent(farmId)}/fields`, {
      headers,
    });
    if (response.ok) {
      const payload = await response.json().catch(() => ({}));
      return payload?.fields || [];
    }
  }

  const { data, error: fe } = await supabase
    .from("tilth_fields")
    .select("*")
    .eq("farm_id", farmId)
    .order("created_at", { ascending: true });
  if (fe) throw new Error(fe.message);
  return data || [];
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

  const refreshFields = useCallback(async () => {
    if (!supabase || !farm?.id) return;
    try {
      setFields(await loadFarmFields(farm.id));
    } catch (err) {
      reportGlobalError(err, "Could not refresh fields.");
    }
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

  const resumeFieldMapping = () => {
    if (farm?.id) {
      try {
        sessionStorage.removeItem(`tilth_skip_field_mapping_${farm.id}`);
      } catch {
        /* private mode */
      }
    }
    setFieldsOnboardingSkipped(false);
    setFieldsOnboardingDone(false);
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
        const data = await loadAccessibleFarm(user.id);
        if (cancelled) return;
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
        const data = await loadFarmFields(farm.id);
        if (cancelled) return;
        setFields(data);
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
            Tilth is not ready to sign farmers in on this environment yet. Please contact
            Fangorn if you need access.
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
    if (error) {
      return (
        <LoggedOutShell>
          <LoadingPanel>
            <div style={{ display: "grid", gap: 12, maxWidth: 640 }}>
              <div>{error}</div>
              <Button variant="secondary" size="sm" onClick={() => window.location.reload()}>
                Retry
              </Button>
            </div>
          </LoadingPanel>
        </LoggedOutShell>
      );
    }
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

  if (fieldsLoading && !fields.length) {
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
    return (
      <FieldMode
        farm={farm}
        fields={fields}
        user={user}
        onExit={() => setFieldMode(false)}
        onNavigate={(s) => { setFieldMode(false); selectSection(s); }}
      />
    );
  }

  let view;
  switch (activeSection) {
    case "fields": {
      view = <FieldsWorkspace farm={farm} fields={fields} onFieldsUpdated={refreshFields} />;
      break;
    }
    case "records": {
      view = <RecordsWorkspace farm={farm} fields={fields} onNavigate={selectSection} />;
      break;
    }
    case "submissions": {
      view = <SubmissionsWorkspace farm={farm} fields={fields} />;
      break;
    }
    case "yield": {
      view = <YieldWorkspace farm={farm} fields={fields} />;
      break;
    }
    case "rotation": {
      view = <RotationWorkspace farm={farm} fields={fields} />;
      break;
    }
    case "observations": {
      view = <ObservationsWorkspace farm={farm} fields={fields} />;
      break;
    }
    case "sensing": {
      view = <RemoteSensingWorkspace farm={farm} fields={fields} />;
      break;
    }
    case "soil": {
      view = <SoilWorkspace farm={farm} fields={fields} />;
      break;
    }
    case "weather": {
      view = <WeatherWorkspace farm={farm} fields={fields} />;
      break;
    }
    case "insights": {
      view = (
        <InsightsWorkspace
          farm={farm}
          fields={fields}
          onNavigate={selectSection}
        />
      );
      break;
    }
    case "compare": {
      view = <CompareView fields={fields} farmId={farm?.id} />;
      break;
    }
    case "reports": {
      view = <ReportsWorkspace farm={farm} fields={fields} />;
      break;
    }
    case "compliance": {
      view = <ComplianceWorkspace farm={farm} fields={fields} />;
      break;
    }
    case "costs": {
      view = <CostsWorkspace farm={farm} fields={fields} />;
      break;
    }
    case "team": {
      view = <TeamWorkspace farm={farm} user={user} />;
      break;
    }
    case "livestock": {
      view = <LivestockWorkspace farm={farm} fields={fields} />;
      break;
    }
    case "calendar": {
      view = <CalendarWorkspace farm={farm} fields={fields} />;
      break;
    }
    case "inventory": {
      view = <InventoryWorkspace farm={farm} fields={fields} />;
      break;
    }
    case "finance": {
      view = <FinanceWorkspace farm={farm} fields={fields} />;
      break;
    }
    case "documents": {
      view = <DocumentsWorkspace farm={farm} fields={fields} />;
      break;
    }
    case "contacts": {
      view = <ContactsWorkspace farm={farm} fields={fields} />;
      break;
    }
    case "market": {
      view = <MarketWorkspace farm={farm} fields={fields} />;
      break;
    }
    case "audit": {
      view = <AuditWorkspace farm={farm} fields={fields} />;
      break;
    }
    case "home":
    default:
      view = (
        <WorkspaceHome
          farm={farm}
          fields={fields}
          onNavigate={selectSection}
          onMapFields={fields.length > 0 ? () => selectSection("fields") : resumeFieldMapping}
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
