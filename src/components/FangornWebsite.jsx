import {
  useCallback,
  useEffect,
  useLayoutEffect,
  useRef,
  useState,
} from "react";
import fullLogo from "../../Fangorn Assets/Full Logo - Transparent 1000 dpi.png";
import treeLogo from "../../Fangorn Assets/Grey logo tree only.png";
import partnerTreeStockMark from "../../Fangorn Assets/Partners/TreestockLogo.png";
import partnerWolven from "../../Fangorn Assets/Partners/Wolven Industries.png";
import { supabase, supabaseConfigured } from "../lib/supabaseClient";
import { getAuthRedirect } from "../lib/authRedirect.js";

const PARTNERS = [
  {
    kicker: "Tree intelligence",
    url: "https://www.treestock.com/",
    label: "TreeStock",
    blurb:
      "TreeStock focuses on high-precision tree and forest intelligence at scale: they scan, model, and quantify tree properties to deliver accurate, repeatable datasets, with per-tree identity and change tracking over time. Their tools are built to cut time to insight, whether you use the web product or connect into existing workflows.",
    logo: partnerTreeStockMark,
    layout: "lockup",
    lockupName: "TreeStock",
  },
  {
    kicker: "Software development",
    url: "https://www.wolvenindustries.co.uk/",
    label: "Wolven Industries",
    blurb:
      "Wolven Industries is a software engineering consultancy with a simple promise: bespoke software, built to last. They work alongside organisations to design and deliver robust, scalable systems that address real business problems, integrate where you need them, and hold up to long-term use through careful engineering and close collaboration.",
    logo: partnerWolven,
    layout: "image",
    /** Same green as hero headline — `brand.forest` */
    tint: "forest",
    imgClass: "partner-logo-img--wordmark",
  },
];

const SECTIONS = [
  "home",
  "services",
  "projects",
  "partners",
  "team",
  "contact",
];

// Tilth (beta) – update to your real URL anytime
const TILTH_URL = "/tilth";

/** GIX Option 1 (Coolors) + derived neutrals */
const brand = {
  sage: "#C3D3C4",
  muted: "#839788",
  forest: "#104E3F",
  moss: "#649A5C",
  orange: "#EC9A29",
  mossDark: "#4A8443",
  body: "#3A4F47",
  bodySoft: "#54695F",
  bgSection: "#EFF4F0",
  border: "#D5E5D7",
  borderSoft: "#DCE9DE",
  tagBorder: "#CADBD0",
  white: "#FFFFFF",
};

const MAX_CONTACT_FILE_BYTES = 10 * 1024 * 1024;
const MAX_CONTACT_FILES = 8;
const DEFAULT_ACCEPT =
  "image/*,.pdf,.zip,.txt,.csv,.tsv,.json,.geojson,.gpkg,.kml,.kmz,.gml,application/xml,text/xml";

const NoiseOverlay = () => (
  <svg
    className="site-noise-overlay"
    style={{
      position: "fixed",
      top: 0,
      left: 0,
      width: "100%",
      height: "100%",
      pointerEvents: "none",
      zIndex: 9999,
      opacity: 0.018,
    }}
  >
    <filter id="noise">
      <feTurbulence
        type="fractalNoise"
        baseFrequency="0.85"
        numOctaves="4"
        stitchTiles="stitch"
      />
    </filter>
    <rect width="100%" height="100%" filter="url(#noise)" />
  </svg>
);

const GridLine = ({ delay, horizontal, position }) => (
  <div
    style={{
      position: "absolute",
      [horizontal ? "top" : "left"]: position,
      [horizontal ? "left" : "top"]: 0,
      [horizontal ? "width" : "height"]: "100%",
      [horizontal ? "height" : "width"]: "1px",
      background: "rgba(16,78,63,0.06)",
      animation: `fadeInLine 2s ${delay}s ease forwards`,
      opacity: 0,
    }}
  />
);

export default function FangornWebsite() {
  const [activeSection, setActiveSection] = useState("home");
  const [scrollY, setScrollY] = useState(0);
  const [hoveredService, setHoveredService] = useState(null);
  const [isMobileNav, setIsMobileNav] = useState(false);
  const [mobileMenuOpen, setMobileMenuOpen] = useState(false);
  const [navBarHeight, setNavBarHeight] = useState(80);
  const navRef = useRef(null);

  const [authDialogOpen, setAuthDialogOpen] = useState(false);
  const [contactFormOpen, setContactFormOpen] = useState(false);
  const [contactName, setContactName] = useState("");
  const [contactEmail, setContactEmail] = useState("");
  const [contactCompany, setContactCompany] = useState("");
  const [contactPhone, setContactPhone] = useState("");
  const [contactMessage, setContactMessage] = useState("");
  const [projectFiles, setProjectFiles] = useState([]);
  const [contactError, setContactError] = useState(null);
  const [contactSuccess, setContactSuccess] = useState(false);
  const [contactSubmitting, setContactSubmitting] = useState(false);
  const fileInputRef = useRef(null);
  const gotchaRef = useRef(null);
  const lastOverlayFocusRef = useRef(null);
  const [authUser, setAuthUser] = useState(null);
  const [authMode, setAuthMode] = useState("google"); // google | email-signin | email-signup
  const [authEmail, setAuthEmail] = useState("");
  const [authPassword, setAuthPassword] = useState("");
  const [authPassword2, setAuthPassword2] = useState("");
  const [profileOpen, setProfileOpen] = useState(false);
  const [profileLoading, setProfileLoading] = useState(false);
  const [myEnquiries, setMyEnquiries] = useState([]);
  const [selectedEnquiryId, setSelectedEnquiryId] = useState(null);
  const supabaseRedirectTo = getAuthRedirect("/");

  useEffect(() => {
    if (!supabase) return;
    supabase.auth.getUser().then(({ data }) => setAuthUser(data?.user || null));
    const { data: sub } = supabase.auth.onAuthStateChange((_event, session) => {
      setAuthUser(session?.user || null);
    });
    return () => sub.subscription.unsubscribe();
  }, []);

  const signInWithGoogle = async () => {
    setContactError(null);
    if (!supabase) {
      setContactError(
        "Sign-in is not available in this environment yet. Please contact Fangorn for access."
      );
      return;
    }
    const { error } = await supabase.auth.signInWithOAuth({
      provider: "google",
      options: {
        redirectTo: supabaseRedirectTo,
      },
    });
    if (error) setContactError(error.message);
  };

  const signOut = async () => {
    setContactError(null);
    if (!supabase) return;
    const { error } = await supabase.auth.signOut();
    if (error) setContactError(error.message);
  };

  const signInWithEmail = async () => {
    setContactError(null);
    if (!supabase) {
      setContactError(
        "Sign-in is not available in this environment yet. Please contact Fangorn for access."
      );
      return;
    }
    const email = authEmail.trim();
    if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) {
      setContactError("Please enter a valid email address.");
      return;
    }
    if (!authPassword) {
      setContactError("Please enter your password.");
      return;
    }
    const { error } = await supabase.auth.signInWithPassword({
      email,
      password: authPassword,
    });
    if (error) setContactError(error.message);
  };

  const signUpWithEmail = async () => {
    setContactError(null);
    if (!supabase) {
      setContactError(
        "Account creation is not available in this environment yet. Please contact Fangorn for access."
      );
      return;
    }
    const email = authEmail.trim();
    if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) {
      setContactError("Please enter a valid email address.");
      return;
    }
    if (!authPassword || authPassword.length < 8) {
      setContactError("Password must be at least 8 characters.");
      return;
    }
    if (authPassword !== authPassword2) {
      setContactError("Passwords do not match.");
      return;
    }
    const { error } = await supabase.auth.signUp({
      email,
      password: authPassword,
      options: { emailRedirectTo: supabaseRedirectTo },
    });
    if (error) {
      setContactError(error.message);
      return;
    }
    setContactError(
      "Account created. If email confirmation is enabled, check your inbox to confirm your address, then sign in."
    );
    setAuthMode("email-signin");
    setAuthPassword("");
    setAuthPassword2("");
  };

  const goToSection = (s) => {
    setActiveSection(s);
    setMobileMenuOpen(false);
    document.getElementById(s)?.scrollIntoView({ behavior: "smooth" });
  };

  const rememberOverlayTrigger = useCallback(() => {
    lastOverlayFocusRef.current = document.activeElement;
  }, []);

  const restoreOverlayFocus = useCallback(() => {
    window.setTimeout(() => lastOverlayFocusRef.current?.focus?.({ preventScroll: true }), 0);
  }, []);

  const resetContactForm = useCallback(() => {
    setContactName("");
    setContactEmail("");
    setContactCompany("");
    setContactPhone("");
    setContactMessage("");
    setProjectFiles([]);
    setContactError(null);
    setContactSuccess(false);
    if (fileInputRef.current) fileInputRef.current.value = "";
    if (gotchaRef.current) gotchaRef.current.value = "";
    setAuthMode("google");
    setAuthEmail("");
    setAuthPassword("");
    setAuthPassword2("");
  }, []);

  const closeContactForm = useCallback(() => {
    setContactFormOpen(false);
    resetContactForm();
    restoreOverlayFocus();
  }, [resetContactForm, restoreOverlayFocus]);

  const resetAuthForm = useCallback(() => {
    setContactError(null);
    setAuthMode("google");
    setAuthEmail("");
    setAuthPassword("");
    setAuthPassword2("");
  }, []);

  const closeAuthDialog = useCallback(() => {
    setAuthDialogOpen(false);
    resetAuthForm();
    restoreOverlayFocus();
  }, [resetAuthForm, restoreOverlayFocus]);

  const openAuthDialog = useCallback(() => {
    rememberOverlayTrigger();
    setMobileMenuOpen(false);
    setAuthDialogOpen(true);
  }, [rememberOverlayTrigger]);

  const openProfile = useCallback(() => {
    rememberOverlayTrigger();
    setMobileMenuOpen(false);
    setProfileOpen(true);
  }, [rememberOverlayTrigger]);

  const closeProfile = useCallback(() => {
    setProfileOpen(false);
    setSelectedEnquiryId(null);
    restoreOverlayFocus();
  }, [restoreOverlayFocus]);

  const openContactForm = useCallback(() => {
    rememberOverlayTrigger();
    setMobileMenuOpen(false);
    setContactFormOpen(true);
  }, [rememberOverlayTrigger]);

  const removeProjectFile = (index) => {
    setProjectFiles((prev) => prev.filter((_, j) => j !== index));
  };

  const onProjectFilesChange = (e) => {
    setContactError(null);
    const input = e.target;
    if (!input.files?.length) return;
    const incoming = Array.from(input.files);
    const combined = [...projectFiles, ...incoming];
    if (combined.length > MAX_CONTACT_FILES) {
      setContactError(
        `You can add up to ${MAX_CONTACT_FILES} files at once. Remove one or add fewer files.`
      );
      input.value = "";
      return;
    }
    const over = combined.find((f) => f.size > MAX_CONTACT_FILE_BYTES);
    if (over) {
      setContactError(
        `Each file must be under ${MAX_CONTACT_FILE_BYTES / 1024 / 1024} MB (${over.name} is too large).`
      );
      input.value = "";
      return;
    }
    setProjectFiles(combined);
    input.value = "";
  };

  const handleContactSubmit = async (e) => {
    e.preventDefault();
    setContactError(null);
    if (gotchaRef.current?.value) return;
    const name = contactName.trim();
    const email = contactEmail.trim();
    const message = contactMessage.trim();
    if (!name || !email || !message) {
      setContactError("Please add your name, email, and a project message.");
      return;
    }
    if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) {
      setContactError("Please enter a valid email address.");
      return;
    }
    try {
      if (!supabase) {
        throw new Error(
          "The enquiry form is not available in this environment yet. Please contact Fangorn directly."
        );
      }
      setContactSubmitting(true);

      // Generate the id client-side so anon users don't need SELECT/RETURNING.
      // (RLS intentionally blocks reading enquiries; returning rows would fail.)
      const enquiryId = crypto.randomUUID();
      const { error: enquiryErr } = await supabase.from("enquiries").insert({
        id: enquiryId,
        user_id: authUser?.id || null,
        name,
        email,
        company: contactCompany.trim() || null,
        phone: contactPhone.trim() || null,
        message,
      });

      if (enquiryErr) throw new Error(enquiryErr.message);
      const bucket = "enquiry-uploads";

      for (const f of projectFiles) {
        const safeName = f.name.replace(/[^\w.\- ]+/g, "_");
        const objectPath = `enquiries/${enquiryId}/${crypto.randomUUID()}-${safeName}`;

        const { error: upErr } = await supabase.storage
          .from(bucket)
          .upload(objectPath, f, {
            contentType: f.type || "application/octet-stream",
            upsert: false,
          });
        if (upErr) throw new Error(upErr.message);

        const { error: refErr } = await supabase.from("enquiry_files").insert({
          enquiry_id: enquiryId,
          bucket,
          path: objectPath,
          filename: f.name,
          content_type: f.type || null,
          size_bytes: f.size || null,
        });
        if (refErr) throw new Error(refErr.message);
      }

      setContactSuccess(true);
    } catch (err) {
      setContactError(
        err?.message || "Could not send your message. Please try again later."
      );
    } finally {
      setContactSubmitting(false);
    }
  };

  useLayoutEffect(() => {
    const el = navRef.current;
    if (!el) return;
    const set = () => setNavBarHeight(el.offsetHeight);
    set();
    const ro = new ResizeObserver(set);
    ro.observe(el);
    return () => ro.disconnect();
  }, []);

  useEffect(() => {
    const handleScroll = () => setScrollY(window.scrollY);
    window.addEventListener("scroll", handleScroll, { passive: true });
    return () => window.removeEventListener("scroll", handleScroll);
  }, []);

  useEffect(() => {
    const mq = window.matchMedia("(max-width: 768px)");
    const apply = () => setIsMobileNav(mq.matches);
    apply();
    mq.addEventListener("change", apply);
    return () => mq.removeEventListener("change", apply);
  }, []);

  useEffect(() => {
    if (!isMobileNav) {
      setMobileMenuOpen(false);
    }
  }, [isMobileNav]);

  useEffect(() => {
    if (!profileOpen) return;
    if (!supabase || !authUser) return;
    let cancelled = false;
    (async () => {
      try {
        setProfileLoading(true);
        setContactError(null);
        const { data, error } = await supabase
          .from("enquiries")
          .select(
            "id,created_at,status,name,email,company,phone,message,enquiry_files(id,filename,bucket,path,content_type,size_bytes,created_at),enquiry_responses(id,message,created_at,author_user_id)"
          )
          .eq("user_id", authUser.id)
          .order("created_at", { ascending: false });
        if (cancelled) return;
        if (error) throw new Error(error.message);
        setMyEnquiries(data || []);
        setSelectedEnquiryId((prev) => prev || (data?.[0]?.id ?? null));
      } catch (e) {
        if (!cancelled) setContactError(e?.message || "Could not load profile.");
      } finally {
        if (!cancelled) setProfileLoading(false);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [profileOpen, authUser]);

  useEffect(() => {
    const lock =
      (isMobileNav && mobileMenuOpen) ||
      contactFormOpen ||
      authDialogOpen ||
      profileOpen;
    const prevBody = document.body.style.overflow;
    const prevHtml = document.documentElement.style.overflow;
    document.body.style.overflow = lock ? "hidden" : prevBody;
    document.documentElement.style.overflow = lock ? "hidden" : prevHtml;
    return () => {
      document.body.style.overflow = prevBody;
      document.documentElement.style.overflow = prevHtml;
    };
  }, [isMobileNav, mobileMenuOpen, contactFormOpen, authDialogOpen, profileOpen]);

  useEffect(() => {
    if (!mobileMenuOpen && !contactFormOpen && !authDialogOpen && !profileOpen)
      return;
    const onKey = (e) => {
      if (e.key !== "Escape") return;
      if (contactFormOpen) {
        if (contactSubmitting) return;
        e.preventDefault();
        closeContactForm();
        return;
      }
      if (authDialogOpen) {
        e.preventDefault();
        closeAuthDialog();
        return;
      }
      if (profileOpen) {
        e.preventDefault();
        closeProfile();
        return;
      }
      if (mobileMenuOpen) setMobileMenuOpen(false);
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [
    mobileMenuOpen,
    contactFormOpen,
    authDialogOpen,
    profileOpen,
    contactSubmitting,
    closeContactForm,
    closeAuthDialog,
    closeProfile,
  ]);

  const navLogoSrc = isMobileNav || scrollY > 72 ? treeLogo : fullLogo;
  const navLogoHeight = isMobileNav ? 34 : scrollY > 72 ? 38 : 46;
  const navLogoMaxWidth = isMobileNav ? 44 : scrollY > 72 ? 52 : 280;

  const services = [
    {
      id: "outsourcing",
      title: "Data Operations",
      icon: "⟐",
      desc: "A dedicated 10-person data analyst team delivering GIS processing, data labelling, quality assurance, digitisation, and business research at scale.",
      tags: ["GIS Processing", "QA", "Digitisation", "Business Research"],
    },
    {
      id: "ai-agents",
      title: "AI-Powered Systems",
      icon: "⬡",
      desc: "Intelligent, purpose-built systems for business workflows — from account reconciliation and web scraping to research automation and data extraction.",
      tags: ["Automation", "Intelligent Workflows", "RAG Systems", "Data Pipelines"],
    },
    {
      id: "geospatial",
      title: "Geospatial Analytics",
      icon: "◈",
      desc: "Satellite imagery analysis, sinkhole detection, terrain modelling, and environmental monitoring at any scale — from individual trees to entire regions.",
      tags: [
        "Satellite Analysis",
        "GIS",
        "Terrain Modelling",
        "Change Detection",
      ],
    },
    {
      id: "data-platforms",
      title: "Data Platforms & Software",
      icon: "⬢",
      desc: "End-to-end platform development — trading systems, knowledge graphs, data dashboards, and bespoke software for complex operational workflows.",
      tags: ["Full-Stack", "Knowledge Graphs", "Trading Platforms", "Dashboards"],
    },
    {
      id: "research",
      title: "Applied Research",
      icon: "◉",
      desc: "Agricultural analytics, biomass estimation, carbon accounting, and environmental impact assessment backed by peer-reviewed methods and machine learning.",
      tags: ["ML/AI", "Carbon", "Agriculture", "Environmental"],
    },
    {
      id: "remote-sensing",
      title: "Remote Sensing & Surveying",
      icon: "◎",
      desc: "LiDAR, hyperspectral, and optical surveys — with aerial or field data capture brought in from trusted partners when your project needs it. High-resolution orthomosaics, 3D point clouds, and digital surface models for any terrain.",
      tags: ["LiDAR", "Hyperspectral", "Photogrammetry", "DSM/DTM"],
    },
  ];

  const projects = [
    {
      title: "Gower Cemetery Mapping",
      client: "Gower Consultants",
      category: "Remote Sensing",
      description:
        "Ongoing high-resolution LiDAR and optical surveying of cemetery sites. Automated headstone measurement, movement monitoring, tree carbon assessment, and OCR-based transcription of historical records into structured databases.",
      color: brand.moss,
    },
    {
      title: "Crop Canopy Cover Research",
      client: "Weetabix",
      category: "Agricultural Analytics",
      description:
        "Funded research programme using airborne and field sensor data to quantify crop canopy cover, monitor growth stages, and provide precision agriculture insights for large-scale cereal production.",
      color: brand.orange,
    },
    {
      title: "Sinkhole Detection & Quantification",
      client: "Confidential",
      category: "Geospatial Analytics",
      description:
        "LiDAR-based detection and volumetric quantification of sinkholes across large survey areas. Change detection analysis and risk assessment for geotechnical planning.",
      color: brand.forest,
    },
    {
      title: "Evaluating Agricultural Yield Reductions",
      client: "Scottish Power",
      category: "Agricultural Analytics",
      description:
        "Consultancy report assessing drivers of agricultural yield reduction — bringing together crop and operational data to evaluate impacts, support decision-making, and document findings for stakeholders (final revision, October 2024).",
      color: brand.muted,
    },
    {
      title: "Account Reconciliation Agent",
      client: "Confidential",
      category: "AI Systems",
      description:
        "Autonomous AI agent for financial account reconciliation — matching transactions, flagging discrepancies, and generating exception reports with minimal human oversight.",
      color: brand.mossDark,
    },
    {
      title: "Business Research & Web Scraping",
      client: "Various",
      category: "Data Operations",
      description:
        "Automated web scraping pipelines and structured business intelligence research, delivering clean datasets for market analysis, competitor tracking, and lead generation.",
      color: "#4A7A6A",
    },
  ];

  return (
    <div
      style={{
        fontFamily: "'Instrument Serif', Georgia, serif",
        background: brand.white,
        color: brand.body,
        minHeight: "100vh",
        position: "relative",
      }}
    >
      <NoiseOverlay />
      <style>{`
        @import url('https://fonts.googleapis.com/css2?family=Instrument+Serif:ital@0;1&family=DM+Sans:ital,wght@0,300;0,400;0,500;0,600;1,300;1,400&family=JetBrains+Mono:wght@300;400&family=Montserrat:wght@600;700&display=swap');

        * { margin: 0; padding: 0; box-sizing: border-box; }
        html, body { overflow-x: hidden; }

        @keyframes fadeInLine { from { opacity: 0; } to { opacity: 1; } }
        @keyframes fadeUp { from { opacity: 0; transform: translateY(40px); } to { opacity: 1; transform: translateY(0); } }
        @keyframes fadeIn { from { opacity: 0; } to { opacity: 1; } }
        @keyframes pulse { 0%, 100% { opacity: 0.3; } 50% { opacity: 1; } }
        @keyframes marquee { from { transform: translateX(0); } to { transform: translateX(-50%); } }

        ::selection { background: ${brand.sage}; color: ${brand.forest}; }

        .nav-link {
          font-family: 'DM Sans', sans-serif;
          font-size: 13px;
          font-weight: 400;
          letter-spacing: 0.12em;
          text-transform: uppercase;
          color: ${brand.muted};
          text-decoration: none;
          padding: 8px 0;
          position: relative;
          transition: color 0.3s;
          cursor: pointer;
        }
        .nav-link:hover, .nav-link.active { color: ${brand.forest}; }
        .nav-link::after {
          content: '';
          position: absolute;
          bottom: 0; left: 0;
          width: 0; height: 1px;
          background: ${brand.forest};
          transition: width 0.3s;
        }
        .nav-link:hover::after, .nav-link.active::after { width: 100%; }

        .nav-tilth {
          font-family: 'DM Sans', sans-serif;
          font-size: 12px;
          font-weight: 600;
          letter-spacing: 0.12em;
          text-transform: uppercase;
          color: ${brand.forest};
          text-decoration: none;
          padding: 10px 14px;
          border: 1px solid ${brand.border};
          border-radius: 2px;
          background: rgba(255,255,255,0.7);
          transition: border-color 0.25s, box-shadow 0.25s, background 0.25s;
          white-space: nowrap;
        }
        .nav-tilth:hover,
        .nav-tilth:focus-visible {
          border-color: ${brand.sage};
          box-shadow: 0 0 0 1px ${brand.sage};
          outline: none;
          background: ${brand.bgSection};
        }

        .nav-menu-toggle {
          display: flex;
          align-items: center;
          justify-content: center;
          min-width: 44px;
          min-height: 44px;
          margin: 0 0 0 4px;
          padding: 0;
          border: none;
          background: transparent;
          color: ${brand.forest};
          cursor: pointer;
          border-radius: 2px;
        }
        .nav-menu-toggle:focus-visible {
          outline: 2px solid ${brand.moss};
          outline-offset: 2px;
        }
        .nav-auth {
          display: inline-flex;
          align-items: center;
          gap: 10px;
          padding: 8px 10px;
          border: 1px solid ${brand.border};
          background: rgba(255,255,255,0.75);
          backdrop-filter: blur(10px);
          border-radius: 2px;
        }
        .nav-auth-label {
          font-family: 'JetBrains Mono', monospace;
          font-size: 11px;
          color: ${brand.muted};
          max-width: 220px;
          overflow: hidden;
          text-overflow: ellipsis;
          white-space: nowrap;
        }
        .nav-auth-btn {
          font-family: 'DM Sans', sans-serif;
          font-size: 12px;
          font-weight: 500;
          letter-spacing: 0.08em;
          text-transform: uppercase;
          color: ${brand.forest};
          border: none;
          background: none;
          cursor: pointer;
          padding: 6px 8px;
        }
        .nav-auth-btn:focus-visible {
          outline: 2px solid ${brand.moss};
          outline-offset: 2px;
          border-radius: 2px;
        }
        .mobile-nav-item {
          font-family: 'DM Sans', sans-serif;
          font-size: 15px;
          font-weight: 500;
          letter-spacing: 0.14em;
          text-transform: uppercase;
          color: ${brand.muted};
          background: none;
          border: none;
          width: 100%;
          text-align: left;
          padding: 18px 4px 18px 0;
          border-bottom: 1px solid ${brand.border};
          cursor: pointer;
          min-height: 48px;
          display: flex;
          align-items: center;
        }
        .mobile-nav-item.active {
          color: ${brand.forest};
        }
        .mobile-nav-item:focus-visible {
          color: ${brand.forest};
          outline: 2px solid ${brand.moss};
          outline-offset: 2px;
        }

        button.cta-btn {
          font: inherit;
        }
        .contact-form-label {
          display: block;
          font-family: 'DM Sans', sans-serif;
          font-size: 11px;
          font-weight: 600;
          letter-spacing: 0.12em;
          text-transform: uppercase;
          color: ${brand.muted};
          margin-bottom: 8px;
        }
        .contact-form-input,
        .contact-form-textarea {
          width: 100%;
          font-family: 'DM Sans', sans-serif;
          font-size: 15px;
          font-weight: 400;
          color: ${brand.body};
          padding: 12px 14px;
          border: 1px solid ${brand.border};
          border-radius: 2px;
          background: ${brand.white};
          box-sizing: border-box;
        }
        .contact-form-input:focus,
        .contact-form-textarea:focus {
          outline: none;
          border-color: ${brand.moss};
          box-shadow: 0 0 0 1px ${brand.sage};
        }
        .contact-form-textarea {
          min-height: 120px;
          resize: vertical;
          line-height: 1.55;
        }
        .contact-form-hint {
          font-family: 'DM Sans', sans-serif;
          font-size: 12px;
          font-weight: 300;
          color: ${brand.muted};
          margin-top: 6px;
          line-height: 1.45;
        }

        .service-card {
          padding: 36px;
          border: 1px solid ${brand.border};
          border-radius: 2px;
          background: ${brand.white};
          transition: all 0.4s cubic-bezier(0.23,1,0.32,1);
          cursor: default;
          position: relative;
          overflow: hidden;
        }
        .service-card::before {
          content: '';
          position: absolute;
          top: 0; left: 0;
          width: 100%; height: 2px;
          background: linear-gradient(90deg, transparent, ${brand.moss}, transparent);
          transform: scaleX(0);
          transition: transform 0.4s;
        }
        .service-card:hover {
          border-color: ${brand.sage};
          background: ${brand.bgSection};
          transform: translateY(-4px);
          box-shadow: 0 12px 40px rgba(16,78,63,0.08);
        }
        .service-card:hover::before { transform: scaleX(1); }
        .project-card {
          padding: 40px;
          border: 1px solid ${brand.border};
          background: ${brand.white};
          border-radius: 2px;
          transition: all 0.4s;
          cursor: pointer;
        }
        .project-card:hover {
          border-color: ${brand.sage};
          transform: translateY(-2px);
          box-shadow: 0 8px 30px rgba(16,78,63,0.06);
        }

        .tag {
          font-family: 'JetBrains Mono', monospace;
          font-size: 10px;
          letter-spacing: 0.06em;
          padding: 4px 10px;
          border: 1px solid ${brand.tagBorder};
          border-radius: 1px;
          color: ${brand.muted};
          display: inline-block;
        }

        .cta-btn {
          font-family: 'DM Sans', sans-serif;
          font-size: 14px;
          font-weight: 500;
          letter-spacing: 0.08em;
          text-transform: uppercase;
          padding: 16px 40px;
          background: transparent;
          border: 1px solid ${brand.moss};
          color: ${brand.forest};
          cursor: pointer;
          transition: all 0.3s;
          text-decoration: none;
          display: inline-block;
        }
        .cta-btn:hover {
          background: ${brand.moss};
          color: ${brand.white};
        }
        .cta-btn.filled {
          background: ${brand.forest};
          border-color: ${brand.forest};
          color: ${brand.white};
        }
        .cta-btn.filled:hover {
          background: ${brand.mossDark};
          border-color: ${brand.mossDark};
        }
        .hero-tilth-card {
          display: inline-grid;
          grid-template-columns: auto minmax(0, 1fr) auto;
          gap: 16px;
          align-items: center;
          position: absolute;
          top: 0;
          right: 0;
          padding: 16px 18px;
          width: 410px;
          max-width: calc(100vw - 96px);
          border: 1px solid ${brand.border};
          border-left: 3px solid ${brand.moss};
          border-radius: 2px;
          background: rgba(255,255,255,0.72);
          color: inherit;
          text-decoration: none;
          backdrop-filter: blur(10px);
          animation: fadeUp 1s 0.95s ease forwards;
          opacity: 0;
          transition: border-color 0.25s, box-shadow 0.25s, transform 0.25s, background 0.25s;
        }
        @media (max-width: 1100px) {
          .hero-tilth-card {
            position: static;
            margin-top: 24px;
            width: auto;
            max-width: 720px;
          }
        }
        .hero-tilth-card:hover,
        .hero-tilth-card:focus-visible {
          border-color: ${brand.sage};
          background: rgba(255,255,255,0.92);
          box-shadow: 0 12px 36px rgba(16,78,63,0.08);
          transform: translateY(-2px);
          outline: none;
        }
        .hero-tilth-badge {
          font-family: 'JetBrains Mono', monospace;
          font-size: 10px;
          letter-spacing: 0.12em;
          text-transform: uppercase;
          color: ${brand.moss};
          border: 1px solid ${brand.tagBorder};
          padding: 6px 9px;
          background: ${brand.white};
          white-space: nowrap;
        }
        .hero-tilth-title {
          display: block;
          font-family: 'DM Sans', sans-serif;
          font-size: 14px;
          font-weight: 600;
          color: ${brand.forest};
          margin-bottom: 3px;
        }
        .hero-tilth-copy {
          display: block;
          font-family: 'DM Sans', sans-serif;
          font-size: 13px;
          font-weight: 300;
          line-height: 1.45;
          color: ${brand.bodySoft};
        }
        .hero-tilth-arrow {
          font-family: 'JetBrains Mono', monospace;
          font-size: 18px;
          color: ${brand.forest};
          transition: transform 0.2s;
        }
        .hero-tilth-card:hover .hero-tilth-arrow,
        .hero-tilth-card:focus-visible .hero-tilth-arrow {
          transform: translateX(3px);
        }

        .marquee-track {
          display: flex;
          animation: marquee 30s linear infinite;
          width: max-content;
        }

        .nav-brand img { display: block; }

        .contact-expertise-card {
          min-width: 0;
        }
        .contact-expertise-row {
          display: grid;
          grid-template-columns: minmax(0, 1fr) minmax(0, 1.35fr);
          column-gap: 20px;
          row-gap: 6px;
          align-items: start;
        }
        .contact-expertise-label {
          line-height: 1.35;
        }
        .contact-expertise-detail {
          min-width: 0;
          text-align: right;
          line-height: 1.5;
          overflow-wrap: anywhere;
        }
        @media (max-width: 900px) {
          .contact-expertise-row {
            grid-template-columns: 1fr;
            row-gap: 4px;
          }
          .contact-expertise-detail { text-align: left; }
        }

        .partner-grid {
          display: grid;
          grid-template-columns: minmax(0, 1fr) minmax(0, 1fr);
          gap: 20px;
          align-items: stretch;
        }
        .partner-tile {
          display: flex;
          flex-direction: column;
          height: 100%;
          border: 1px solid ${brand.border};
          border-radius: 2px;
          background: ${brand.white};
          padding: 20px;
          min-width: 0;
          gap: 12px;
        }
        .partner-kicker {
          font-family: 'DM Sans', sans-serif;
          font-size: 10px;
          font-weight: 600;
          letter-spacing: 0.18em;
          text-transform: uppercase;
          color: ${brand.moss};
          margin: 0;
          line-height: 1.4;
          flex-shrink: 0;
        }
        /* Grow to align logo rows, but do NOT shrink below text (min-h:0 caused overlap) */
        .partner-blurb-wrap {
          flex: 1 1 auto;
          display: flex;
          flex-direction: column;
          justify-content: flex-start;
          min-width: 0;
        }
        .partner-logo-well {
          background: ${brand.bgSection};
          border: 1px solid ${brand.border};
          border-radius: 2px;
          height: 140px;
          min-height: 140px;
          flex-shrink: 0;
          display: flex;
          align-items: center;
          justify-content: center;
          padding: 16px 14px;
          box-sizing: border-box;
        }
        .partner-logo-well > img {
          max-width: 100%;
          width: auto;
          height: auto;
          object-fit: contain;
          display: block;
        }
        .partner-lockup {
          display: flex;
          flex-direction: row;
          align-items: center;
          justify-content: center;
          gap: 8px;
          flex-wrap: wrap;
          max-width: 100%;
        }
        /* Nudge toward brand.forest; contrast+slight dim pulls green closer to lockup text without greying the tree */
        .partner-lockup-icon {
          flex-shrink: 0;
          height: 56px;
          width: auto;
          max-width: 76px;
          object-fit: contain;
          display: block;
          filter: hue-rotate(30deg) saturate(1.1) contrast(1.14) brightness(0.93);
        }
        .partner-lockup-name {
          font-family: 'Montserrat', 'DM Sans', system-ui, sans-serif;
          font-size: clamp(1.3rem, 2.75vw, 1.65rem);
          font-weight: 700;
          color: ${brand.forest};
          letter-spacing: -0.04em;
          line-height: 1.05;
        }
        .partner-logo-img--wordmark {
          max-height: 84px;
          max-width: 100%;
          width: auto;
        }
        .partner-wordmark-tint {
          display: block;
          width: 100%;
          height: 84px;
          max-width: 100%;
          max-height: 84px;
          box-sizing: border-box;
          -webkit-mask-size: contain;
          mask-size: contain;
          -webkit-mask-repeat: no-repeat;
          mask-repeat: no-repeat;
          -webkit-mask-position: center;
          mask-position: center;
        }
        @media (min-width: 500px) {
          .partner-logo-img--wordmark {
            max-height: 96px;
          }
          .partner-wordmark-tint {
            height: 96px;
            max-height: 96px;
          }
        }
        @media (min-width: 900px) {
          .partner-logo-img--wordmark {
            max-height: 102px;
          }
          .partner-wordmark-tint {
            height: 102px;
            max-height: 102px;
          }
        }
        .partner-blurb {
          font-family: 'DM Sans', sans-serif;
          font-size: 14px;
          font-weight: 300;
          color: ${brand.body};
          line-height: 1.65;
          margin: 0;
          overflow-wrap: break-word;
        }
        a.partner-logo-well {
          text-decoration: none;
          color: inherit;
          transition: border-color 0.25s, box-shadow 0.25s;
        }
        a.partner-logo-well:hover,
        a.partner-logo-well:focus-visible {
          border-color: ${brand.sage};
          box-shadow: 0 0 0 1px ${brand.sage};
          outline: none;
        }
        a.partner-website {
          display: inline-flex;
          align-items: center;
          gap: 6px;
          margin-top: 0;
          flex-shrink: 0;
          align-self: flex-start;
          font-family: 'JetBrains Mono', monospace;
          font-size: 11px;
          font-weight: 400;
          letter-spacing: 0.06em;
          color: ${brand.forest};
          text-decoration: none;
          width: fit-content;
          max-width: 100%;
        }
        a.partner-website::after {
          content: '↗';
          font-size: 10px;
          opacity: 0.75;
        }
        a.partner-website:hover,
        a.partner-website:focus-visible {
          color: ${brand.moss};
          text-decoration: underline;
          text-underline-offset: 3px;
          outline: none;
        }

        @media (max-width: 768px) {
          .site-noise-overlay { display: none; }
          .nav-brand {
            flex: 0 0 auto !important;
            max-width: 44px !important;
            overflow: hidden !important;
          }
          .nav-brand img {
            width: 34px !important;
            height: 34px !important;
            max-width: 34px !important;
            object-fit: contain !important;
          }
          .partner-grid { grid-template-columns: 1fr; }
          .service-grid { grid-template-columns: 1fr !important; }
          .project-grid { grid-template-columns: 1fr !important; }
          .home-copy { width: 100%; }
          .hero-kicker {
            font-size: 10px !important;
            letter-spacing: 0.15em !important;
            line-height: 1.55 !important;
            margin-bottom: 20px !important;
          }
          .hero-title { font-size: clamp(44px, 16vw, 64px) !important; line-height: 1.05 !important; }
          .hero-sub { font-size: 16px !important; max-width: 100% !important; margin-bottom: 32px !important; }
          .hero-actions { flex-direction: column; width: 100%; gap: 12px !important; }
          .hero-tilth-card { grid-template-columns: 1fr; width: 100%; max-width: 100%; }
          .hero-tilth-arrow { display: none; }
          .hero-coordinate-lockup { display: none !important; }
          .section-padding { padding: 88px 20px 56px !important; }
          #home.section-padding {
            min-height: auto !important;
            justify-content: flex-start !important;
            padding-top: max(112px, calc(92px + env(safe-area-inset-top, 0px))) !important;
          }
          .section-padding h2 { font-size: clamp(34px, 11vw, 46px) !important; }
          .service-card,
          .project-card,
          .contact-expertise-card { padding: 24px !important; }
          .partner-tile { padding: 18px; }
          .partner-logo-well { height: 112px; min-height: 112px; }
          .stat-grid { grid-template-columns: 1fr 1fr !important; }
          .two-col { grid-template-columns: 1fr !important; gap: 40px !important; }
          .nav-links { display: none !important; }
          .cta-btn { width: 100%; text-align: center; padding: 14px 18px; }
        }

        @media (max-width: 460px) {
          .hero-title { font-size: clamp(40px, 15vw, 58px) !important; }
          .hero-sub { line-height: 1.55 !important; }
          .stat-grid { grid-template-columns: 1fr !important; }
        }
      `}</style>

      <nav
        ref={navRef}
        style={{
          position: "fixed",
          top: 0,
          left: 0,
          right: 0,
          zIndex: 1003,
          padding: isMobileNav
            ? "max(12px, env(safe-area-inset-top, 0px)) 16px 12px 16px"
            : "20px 48px",
          display: "flex",
          justifyContent: "space-between",
          alignItems: "center",
          background: isMobileNav
            ? "rgba(255,255,255,0.97)"
            : scrollY > 60
              ? "rgba(255,255,255,0.92)"
              : "transparent",
          backdropFilter: isMobileNav || scrollY > 60 ? "blur(20px)" : "none",
          borderBottom: isMobileNav || scrollY > 60 ? `1px solid ${brand.border}` : "none",
          transition: "all 0.4s",
        }}
      >
        <button
          type="button"
          className="nav-brand"
          onClick={() => {
            setActiveSection("home");
            document.getElementById("home")?.scrollIntoView({ behavior: "smooth" });
          }}
          style={{
            background: "none",
            border: "none",
            cursor: "pointer",
            padding: 0,
            margin: 0,
            display: "flex",
            alignItems: "center",
          }}
          aria-label="Fangorn Group home"
        >
          <img
            src={navLogoSrc}
            alt="Fangorn Group"
            style={{
              height: navLogoHeight,
              width: "auto",
              maxWidth: navLogoMaxWidth,
              objectFit: "contain",
              transition: "height 0.35s ease, max-width 0.35s ease",
            }}
          />
        </button>
        <div
          className="nav-links"
          style={{ display: "flex", gap: 32, alignItems: "center" }}
        >
          {SECTIONS.map((s) => (
            <a
              key={s}
              href={`#${s}`}
              className={`nav-link ${activeSection === s ? "active" : ""}`}
              onClick={(e) => {
                e.preventDefault();
                goToSection(s);
              }}
            >
              {s}
            </a>
          ))}
          <a
            className="nav-tilth"
            href={TILTH_URL}
            target="_blank"
            rel="noreferrer"
            aria-label="Open Tilth (beta farm management platform)"
            title="Tilth — beta farm management platform"
          >
            Tilth <span style={{ opacity: 0.65 }}>(beta)</span>
          </a>
        </div>
        {!isMobileNav && (
          <div className="nav-auth">
            {authUser ? (
              <>
                <button
                  type="button"
                  className="nav-auth-btn"
                  onClick={openProfile}
                  aria-label="Open profile"
                  style={{
                    padding: 0,
                    textTransform: "none",
                    letterSpacing: "normal",
                    fontFamily: "'JetBrains Mono', monospace",
                    fontSize: 11,
                    color: brand.muted,
                  }}
                >
                  Signed in{authUser.email ? `: ${authUser.email}` : ""}
                </button>
                <button
                  type="button"
                  className="nav-auth-btn"
                  onClick={signOut}
                  aria-label="Sign out"
                >
                  Sign out
                </button>
              </>
            ) : (
              <button
                type="button"
                className="nav-auth-btn"
                onClick={openAuthDialog}
                aria-label="Sign in"
              >
                Sign in
              </button>
            )}
          </div>
        )}
        {isMobileNav && (
          <button
            type="button"
            className="nav-menu-toggle"
            onClick={() => setMobileMenuOpen((o) => !o)}
            aria-expanded={mobileMenuOpen}
            aria-controls="mobile-nav-panel"
            aria-label={mobileMenuOpen ? "Close menu" : "Open site menu"}
          >
            {mobileMenuOpen ? (
              <svg
                width="22"
                height="22"
                viewBox="0 0 24 24"
                fill="none"
                stroke="currentColor"
                strokeWidth="2"
                strokeLinecap="round"
                aria-hidden
              >
                <path d="M6 6l12 12M18 6L6 18" />
              </svg>
            ) : (
              <svg
                width="24"
                height="24"
                viewBox="0 0 24 24"
                fill="none"
                stroke="currentColor"
                strokeWidth="2"
                strokeLinecap="round"
                aria-hidden
              >
                <path d="M4 6h16M4 12h16M4 18h16" />
              </svg>
            )}
          </button>
        )}
      </nav>
      {isMobileNav && mobileMenuOpen && (
        <div
          id="mobile-nav-panel"
          role="dialog"
          aria-modal="true"
          aria-label="Page sections"
          className="mobile-nav-panel"
          style={{
            position: "fixed",
            top: navBarHeight,
            left: 0,
            right: 0,
            bottom: 0,
            zIndex: 1001,
            background: brand.white,
            borderTop: `1px solid ${brand.borderSoft}`,
            padding: "0 20px 24px",
            paddingBottom: "max(32px, env(safe-area-inset-bottom, 0px))",
            overflowY: "auto",
            boxShadow: "0 12px 40px rgba(16,78,63,0.12)",
            WebkitOverflowScrolling: "touch",
          }}
        >
          <div style={{ padding: "14px 0 6px", borderBottom: `1px solid ${brand.border}` }}>
            <a
              className="nav-tilth"
              href={TILTH_URL}
              target="_blank"
              rel="noreferrer"
              style={{ display: "inline-block" }}
            >
              Tilth <span style={{ opacity: 0.65 }}>(beta)</span>
            </a>
          </div>
          {authUser ? (
            <div
              style={{
                padding: "14px 0 6px",
                borderBottom: `1px solid ${brand.border}`,
                marginBottom: 6,
              }}
            >
              <button
                type="button"
                onClick={() => {
                  setMobileMenuOpen(false);
                  openProfile();
                }}
                style={{
                  fontFamily: "'JetBrains Mono', monospace",
                  fontSize: 11,
                  color: brand.muted,
                  marginBottom: 10,
                  overflow: "hidden",
                  textOverflow: "ellipsis",
                  whiteSpace: "nowrap",
                  width: "100%",
                  textAlign: "left",
                  background: "none",
                  border: "none",
                  padding: 0,
                  cursor: "pointer",
                }}
                title={authUser.email || ""}
              >
                Signed in{authUser.email ? `: ${authUser.email}` : ""} (Profile)
              </button>
              <button
                type="button"
                className="cta-btn"
                onClick={() => {
                  setMobileMenuOpen(false);
                  signOut();
                }}
                style={{ padding: "12px 18px" }}
              >
                Sign out
              </button>
            </div>
          ) : (
            <div
              style={{
                padding: "14px 0 6px",
                borderBottom: `1px solid ${brand.border}`,
                marginBottom: 6,
              }}
            >
              <button
                type="button"
                className="cta-btn"
                onClick={() => {
                  setMobileMenuOpen(false);
                  openAuthDialog();
                }}
                style={{ padding: "12px 18px" }}
              >
                Sign in
              </button>
            </div>
          )}
          {SECTIONS.map((s, i) => (
            <button
              key={s}
              type="button"
              className={`mobile-nav-item ${activeSection === s ? "active" : ""}`}
              autoFocus={i === 0}
              onClick={() => goToSection(s)}
            >
              {s}
            </button>
          ))}
        </div>
      )}

      <section
        id="home"
        className="section-padding"
        style={{
          minHeight: "100vh",
          display: "flex",
          flexDirection: "column",
          justifyContent: "center",
          padding: "140px 48px 80px",
          position: "relative",
          background: brand.bgSection,
        }}
      >
        <GridLine horizontal position="20%" delay={0.2} />
        <GridLine horizontal position="50%" delay={0.5} />
        <GridLine horizontal position="80%" delay={0.8} />
        <GridLine position="15%" delay={0.3} />
        <GridLine position="45%" delay={0.6} />
        <GridLine position="75%" delay={0.9} />

        <div className="home-copy" style={{ maxWidth: 1100, position: "relative", zIndex: 1 }}>
          <div
            className="hero-kicker"
            style={{
              fontFamily: "'JetBrains Mono', monospace",
              fontSize: 11,
              color: brand.moss,
              letterSpacing: "0.2em",
              textTransform: "uppercase",
              marginBottom: 32,
              animation: "fadeUp 1s 0.2s ease forwards",
              opacity: 0,
            }}
          >
            Geospatial Intelligence · AI Systems · Data Operations
          </div>

          <h1
            className="hero-title"
            style={{
              fontFamily: "'Instrument Serif', serif",
              fontSize: 82,
              fontWeight: 400,
              lineHeight: 1.05,
              color: brand.forest,
              letterSpacing: "-0.03em",
              marginBottom: 32,
              animation: "fadeUp 1s 0.4s ease forwards",
              opacity: 0,
            }}
          >
            We turn complex data
            <br />
            <span style={{ fontStyle: "italic", color: brand.orange }}>
              into clear decisions.
            </span>
          </h1>

          <p
            className="hero-sub"
            style={{
              fontFamily: "'DM Sans', sans-serif",
              fontSize: 19,
              fontWeight: 300,
              lineHeight: 1.7,
              color: brand.bodySoft,
              maxWidth: 620,
              marginBottom: 48,
              animation: "fadeUp 1s 0.6s ease forwards",
              opacity: 0,
            }}
          >
            Remote sensing, machine learning, AI-powered systems, and a dedicated
            data team — delivering geospatial analytics, software platforms, and
            applied research for organisations that need answers from their
            data.
          </p>

          <div
            className="hero-actions"
            style={{
              display: "flex",
              gap: 16,
              flexWrap: "wrap",
              animation: "fadeUp 1s 0.8s ease forwards",
              opacity: 0,
            }}
          >
            <a
              className="cta-btn filled"
              onClick={() =>
                document
                  .getElementById("services")
                  ?.scrollIntoView({ behavior: "smooth" })
              }
            >
              Explore Services
            </a>
            <button
              type="button"
              className="cta-btn"
              onClick={openContactForm}
            >
              Start a Conversation
            </button>
          </div>

          <a
            className="hero-tilth-card"
            href={TILTH_URL}
            target="_blank"
            rel="noreferrer"
            aria-label="Open Tilth Beta, Fangorn's farm management platform"
          >
            <span className="hero-tilth-badge">Tilth Beta</span>
            <span>
              <span className="hero-tilth-title">Farm management, built from Fangorn's geospatial and data work.</span>
              <span className="hero-tilth-copy">
                A practical workspace for fields, records, compliance, weather, markets, tasks, and farm reporting.
              </span>
            </span>
            <span className="hero-tilth-arrow" aria-hidden="true">→</span>
          </a>
        </div>

        <div
          className="hero-coordinate-lockup"
          style={{
            position: "absolute",
            bottom: 48,
            right: 48,
            fontFamily: "'JetBrains Mono', monospace",
            fontSize: 11,
            color: "rgba(16,78,63,0.14)",
            textAlign: "right",
            lineHeight: 2,
            animation: "fadeIn 2s 1.2s ease forwards",
            opacity: 0,
            display: isMobileNav ? "none" : "flex",
            flexDirection: "column",
            alignItems: "flex-end",
            gap: 12,
          }}
        >
          <img
            src={treeLogo}
            alt="Fangorn mark"
            width={56}
            height={56}
            style={{
              width: 56,
              height: "auto",
              maxHeight: 64,
              objectFit: "contain",
              opacity: 0.55,
            }}
          />
          51.5074° N
          <br />
          0.1278° W
          <br />
          <span
            style={{
              animation: "pulse 3s infinite",
              display: "inline-block",
              color: brand.orange,
            }}
          >
            ●
          </span>{" "}
          OPERATIONAL
        </div>
      </section>

      <div
        style={{
          borderTop: `1px solid ${brand.border}`,
          borderBottom: `1px solid ${brand.border}`,
          padding: "14px 0",
          overflow: "hidden",
          background: brand.white,
        }}
      >
        <div className="marquee-track">
          {[...Array(2)].map((_, i) => (
            <div key={i} style={{ display: "flex", gap: 48, paddingRight: 48 }}>
              {[
                "LiDAR",
                "Hyperspectral",
                "Machine Learning",
                "Knowledge Graphs",
                "Survey & Mapping",
                "Satellite Analysis",
                "AI Systems",
                "Carbon Accounting",
                "Point Clouds",
                "Trading Systems",
                "GIS Processing",
                "OCR Pipelines",
                "Biomass Estimation",
                "Data Platforms",
                "Web Scraping",
                "Reconciliation",
              ].map((t) => (
                <span
                  key={`${i}-${t}`}
                  style={{
                    fontFamily: "'JetBrains Mono', monospace",
                    fontSize: 11,
                    color: brand.moss,
                    letterSpacing: "0.1em",
                    textTransform: "uppercase",
                    whiteSpace: "nowrap",
                    opacity: 0.45,
                  }}
                >
                  {t}
                </span>
              ))}
            </div>
          ))}
        </div>
      </div>

      <section
        id="services"
        className="section-padding"
        style={{ padding: "120px 48px", background: brand.white }}
      >
        <div style={{ maxWidth: 1200, margin: "0 auto" }}>
          <div style={{ marginBottom: 80 }}>
            <span
              style={{
                fontFamily: "'JetBrains Mono', monospace",
                fontSize: 11,
                color: brand.moss,
                letterSpacing: "0.2em",
                textTransform: "uppercase",
              }}
            >
              01 — What We Do
            </span>
            <h2
              style={{
                fontFamily: "'Instrument Serif', serif",
                fontSize: 52,
                fontWeight: 400,
                color: brand.forest,
                letterSpacing: "-0.02em",
                marginTop: 16,
                lineHeight: 1.1,
              }}
            >
              Services
            </h2>
            <p
              style={{
                fontFamily: "'DM Sans', sans-serif",
                fontSize: 16,
                fontWeight: 300,
                color: brand.bodySoft,
                maxWidth: 560,
                marginTop: 16,
                lineHeight: 1.7,
              }}
            >
              From geospatial intelligence to AI-powered systems, we deliver
              end-to-end data solutions. Every project is backed by domain
              expertise and a dedicated analyst team.
            </p>
          </div>

          <div
            className="service-grid"
            style={{
              display: "grid",
              gridTemplateColumns: "repeat(3, 1fr)",
              gap: 20,
            }}
          >
            {services.map((s) => (
              <div
                key={s.id}
                className="service-card"
                onMouseEnter={() => setHoveredService(s.id)}
                onMouseLeave={() => setHoveredService(null)}
              >
                <div
                  style={{
                    fontFamily: "'Instrument Serif', serif",
                    fontSize: 32,
                    color: brand.moss,
                    marginBottom: 20,
                    transition: "transform 0.4s",
                    transform:
                      hoveredService === s.id ? "scale(1.2)" : "scale(1)",
                  }}
                >
                  {s.icon}
                </div>
                <h3
                  style={{
                    fontFamily: "'DM Sans', sans-serif",
                    fontSize: 17,
                    fontWeight: 500,
                    color: brand.forest,
                    marginBottom: 12,
                    letterSpacing: "0.01em",
                  }}
                >
                  {s.title}
                </h3>
                <p
                  style={{
                    fontFamily: "'DM Sans', sans-serif",
                    fontSize: 14,
                    fontWeight: 300,
                    color: brand.bodySoft,
                    lineHeight: 1.7,
                    marginBottom: 20,
                  }}
                >
                  {s.desc}
                </p>
                <div style={{ display: "flex", flexWrap: "wrap", gap: 6 }}>
                  {s.tags.map((t) => (
                    <span key={t} className="tag">
                      {t}
                    </span>
                  ))}
                </div>
              </div>
            ))}
          </div>
        </div>
      </section>

      <div
        style={{
          borderTop: `1px solid ${brand.border}`,
          borderBottom: `1px solid ${brand.border}`,
          padding: "48px",
          background: brand.bgSection,
        }}
      >
        <div
          className="stat-grid"
          style={{
            maxWidth: 1200,
            margin: "0 auto",
            display: "grid",
            gridTemplateColumns: "repeat(4, 1fr)",
            gap: 32,
          }}
        >
          {[
            { value: "10+", label: "Data Analysts", sub: "Distributed team" },
            { value: "PhD", label: "Research-Led", sub: "Geoinformatics" },
            { value: "3", label: "Core Platforms", sub: "In production" },
            { value: "UK/ZW", label: "Operations", sub: "Two continents" },
          ].map((stat) => (
            <div key={stat.label} style={{ textAlign: "center" }}>
              <div
                style={{
                  fontFamily: "'Instrument Serif', serif",
                  fontSize: 42,
                  color: brand.forest,
                  letterSpacing: "-0.02em",
                }}
              >
                {stat.value}
              </div>
              <div
                style={{
                  fontFamily: "'DM Sans', sans-serif",
                  fontSize: 13,
                  fontWeight: 500,
                  color: brand.moss,
                  textTransform: "uppercase",
                  letterSpacing: "0.1em",
                  marginTop: 4,
                }}
              >
                {stat.label}
              </div>
              <div
                style={{
                  fontFamily: "'JetBrains Mono', monospace",
                  fontSize: 10,
                  color: brand.muted,
                  marginTop: 4,
                }}
              >
                {stat.sub}
              </div>
            </div>
          ))}
        </div>
      </div>

      <section
        id="projects"
        className="section-padding"
        style={{ padding: "120px 48px", background: brand.white }}
      >
        <div style={{ maxWidth: 1200, margin: "0 auto" }}>
          <div style={{ marginBottom: 80 }}>
            <span
              style={{
                fontFamily: "'JetBrains Mono', monospace",
                fontSize: 11,
                color: brand.moss,
                letterSpacing: "0.2em",
                textTransform: "uppercase",
              }}
            >
              02 — Selected Work
            </span>
            <h2
              style={{
                fontFamily: "'Instrument Serif', serif",
                fontSize: 52,
                fontWeight: 400,
                color: brand.forest,
                letterSpacing: "-0.02em",
                marginTop: 16,
                lineHeight: 1.1,
              }}
            >
              Projects
            </h2>
            <p
              style={{
                fontFamily: "'DM Sans', sans-serif",
                fontSize: 16,
                fontWeight: 300,
                color: brand.bodySoft,
                maxWidth: 560,
                marginTop: 16,
                lineHeight: 1.7,
              }}
            >
              A cross-section of recent and ongoing work across our practice
              areas.
            </p>
          </div>

          <div
            className="project-grid"
            style={{
              display: "grid",
              gridTemplateColumns: "repeat(2, 1fr)",
              gap: 20,
            }}
          >
            {projects.map((p) => (
              <div key={p.title} className="project-card">
                <div
                  style={{
                    display: "flex",
                    justifyContent: "space-between",
                    alignItems: "center",
                    marginBottom: 20,
                  }}
                >
                  <span
                    className="tag"
                    style={{ borderColor: p.color, color: p.color }}
                  >
                    {p.category}
                  </span>
                  <span
                    style={{
                      fontFamily: "'JetBrains Mono', monospace",
                      fontSize: 10,
                      color: brand.muted,
                    }}
                  >
                    {p.client}
                  </span>
                </div>
                <h3
                  style={{
                    fontFamily: "'Instrument Serif', serif",
                    fontSize: 24,
                    fontWeight: 400,
                    color: brand.forest,
                    marginBottom: 14,
                    letterSpacing: "-0.01em",
                  }}
                >
                  {p.title}
                </h3>
                <p
                  style={{
                    fontFamily: "'DM Sans', sans-serif",
                    fontSize: 14,
                    fontWeight: 300,
                    color: brand.bodySoft,
                    lineHeight: 1.7,
                  }}
                >
                  {p.description}
                </p>
              </div>
            ))}
          </div>
        </div>
      </section>

      <section
        id="partners"
        className="section-padding"
        style={{
          padding: "120px 48px",
          borderTop: `1px solid ${brand.border}`,
          background: brand.white,
        }}
      >
        <div style={{ maxWidth: 1200, margin: "0 auto" }}>
          <div style={{ marginBottom: 48 }}>
            <span
              style={{
                fontFamily: "'JetBrains Mono', monospace",
                fontSize: 11,
                color: brand.moss,
                letterSpacing: "0.2em",
                textTransform: "uppercase",
              }}
            >
              03 — Partners
            </span>
            <h2
              style={{
                fontFamily: "'Instrument Serif', serif",
                fontSize: 52,
                fontWeight: 400,
                color: brand.forest,
                letterSpacing: "-0.02em",
                marginTop: 16,
                lineHeight: 1.1,
              }}
            >
              Organisations we work with
            </h2>
            <p
              style={{
                fontFamily: "'DM Sans', sans-serif",
                fontSize: 16,
                fontWeight: 300,
                color: brand.bodySoft,
                lineHeight: 1.7,
                marginTop: 16,
                maxWidth: 560,
              }}
            >
              We collaborate with partners for tree and forest intelligence and for
              software design and build. Read more on their own sites, linked
              below.
            </p>
          </div>
          <div className="partner-grid">
            {PARTNERS.map((p) => (
              <div className="partner-tile" key={p.label}>
                <div className="partner-kicker">{p.kicker}</div>
                <div className="partner-blurb-wrap">
                  <p className="partner-blurb">{p.blurb}</p>
                </div>
                <a
                  className="partner-logo-well"
                  href={p.url}
                  target="_blank"
                  rel="noopener noreferrer"
                  aria-label={`${p.label} — visit website (opens in a new tab)`}
                >
                  {p.layout === "lockup" ? (
                    <span className="partner-lockup">
                      <img
                        className="partner-lockup-icon"
                        src={p.logo}
                        alt=""
                        loading="lazy"
                        decoding="async"
                      />
                      <span className="partner-lockup-name">{p.lockupName}</span>
                    </span>
                  ) : p.tint && brand[p.tint] ? (
                    <div
                      className="partner-logo-img--wordmark partner-wordmark-tint"
                      style={{
                        backgroundColor: brand[p.tint],
                        WebkitMaskImage: `url(${p.logo})`,
                        maskImage: `url(${p.logo})`,
                      }}
                      role="img"
                      aria-label={`${p.label} logo`}
                    />
                  ) : (
                    <img
                      className={p.imgClass}
                      src={p.logo}
                      alt={`${p.label} logo`}
                      loading="lazy"
                    />
                  )}
                </a>
                <a
                  className="partner-website"
                  href={p.url}
                  target="_blank"
                  rel="noopener noreferrer"
                >
                  {p.url.replace(/^https?:\/\/(www\.)?/i, "").replace(/\/$/, "")}
                </a>
              </div>
            ))}
          </div>
        </div>
      </section>

      <section
        id="team"
        className="section-padding"
        style={{
          padding: "120px 48px",
          borderTop: `1px solid ${brand.border}`,
          background: brand.bgSection,
        }}
      >
        <div style={{ maxWidth: 1200, margin: "0 auto" }}>
          <div style={{ marginBottom: 60 }}>
            <span
              style={{
                fontFamily: "'JetBrains Mono', monospace",
                fontSize: 11,
                color: brand.moss,
                letterSpacing: "0.2em",
                textTransform: "uppercase",
              }}
            >
              04 — The Team
            </span>
            <h2
              style={{
                fontFamily: "'Instrument Serif', serif",
                fontSize: 52,
                fontWeight: 400,
                color: brand.forest,
                letterSpacing: "-0.02em",
                marginTop: 16,
                lineHeight: 1.1,
              }}
            >
              Built to deliver.
            </h2>
          </div>

          <div
            className="two-col"
            style={{
              display: "grid",
              gridTemplateColumns: "1fr 1fr",
              gap: 60,
              alignItems: "start",
            }}
          >
            <div>
              <p
                style={{
                  fontFamily: "'DM Sans', sans-serif",
                  fontSize: 16,
                  fontWeight: 300,
                  color: brand.body,
                  lineHeight: 1.8,
                  marginBottom: 24,
                }}
              >
                Fangorn is led by Tristan Campbell-Reynolds — a geoinformatics
                researcher, remote sensing specialist, and technical founder with
                a background in engineering geology and a PhD focus on
                above-ground biomass estimation.
              </p>
              <p
                style={{
                  fontFamily: "'DM Sans', sans-serif",
                  fontSize: 16,
                  fontWeight: 300,
                  color: brand.body,
                  lineHeight: 1.8,
                  marginBottom: 24,
                }}
              >
                The team includes 10 data analysts based in Zimbabwe, specialising
                in GIS processing, data labelling, quality assurance, digitisation,
                and business research. This distributed model means we can deliver
                at scale without inflated overheads.
              </p>
              <p
                style={{
                  fontFamily: "'DM Sans', sans-serif",
                  fontSize: 16,
                  fontWeight: 300,
                  color: brand.body,
                  lineHeight: 1.8,
                }}
              >
                Our technical stack spans Python, TensorFlow, Neo4j, PostGIS, QGIS,
                and a wide range of geospatial, imagery, and ML tooling — including
                arrangements for specialist aerial or survey data capture when a
                project requires it. We pair deep domain expertise with production
                engineering to build systems that work in the real world.
              </p>
            </div>

            <div
              style={{
                padding: 40,
                border: `1px solid ${brand.border}`,
                background: brand.white,
              }}
            >
              <div
                style={{
                  fontFamily: "'JetBrains Mono', monospace",
                  fontSize: 10,
                  color: brand.moss,
                  letterSpacing: "0.15em",
                  textTransform: "uppercase",
                  marginBottom: 24,
                }}
              >
                Leadership
              </div>
              <div
                style={{
                  fontFamily: "'Instrument Serif', serif",
                  fontSize: 22,
                  color: brand.forest,
                  marginBottom: 6,
                }}
              >
                Tristan Campbell-Reynolds
              </div>
              <div
                style={{
                  fontFamily: "'DM Sans', sans-serif",
                  fontSize: 13,
                  color: brand.bodySoft,
                  marginBottom: 24,
                }}
              >
                CEO / CTO — Fangorn Group Limited
              </div>
              <div style={{ display: "flex", flexDirection: "column", gap: 10 }}>
                {[
                  "MSc Engineering Geology — University of Portsmouth",
                  "PhD Researcher — Geoinformatics (Active)",
                  "CTO — TreeStock (Forest Analytics Platform)",
                  "Academic Mentor — MSc Supervision",
                ].map((item) => (
                  <div
                    key={item}
                    style={{
                      fontFamily: "'DM Sans', sans-serif",
                      fontSize: 13,
                      fontWeight: 300,
                      color: brand.bodySoft,
                      paddingLeft: 16,
                      borderLeft: `2px solid ${brand.borderSoft}`,
                    }}
                  >
                    {item}
                  </div>
                ))}
              </div>

              <div
                style={{
                  marginTop: 32,
                  paddingTop: 24,
                  borderTop: `1px solid ${brand.border}`,
                }}
              >
                <div
                  style={{
                    fontFamily: "'JetBrains Mono', monospace",
                    fontSize: 10,
                    color: brand.moss,
                    letterSpacing: "0.15em",
                    textTransform: "uppercase",
                    marginBottom: 16,
                  }}
                >
                  Operations — Harare, Zimbabwe
                </div>
                <div
                  style={{
                    fontFamily: "'Instrument Serif', serif",
                    fontSize: 18,
                    color: brand.forest,
                    marginBottom: 6,
                  }}
                >
                  10 Data Analysts
                </div>
                <div
                  style={{
                    fontFamily: "'DM Sans', sans-serif",
                    fontSize: 13,
                    fontWeight: 300,
                    color: brand.bodySoft,
                    lineHeight: 1.7,
                  }}
                >
                  GIS processing, data labelling, digitisation, quality assurance,
                  business research, and web data extraction.
                </div>
              </div>
            </div>
          </div>
        </div>
      </section>

      <section
        id="contact"
        className="section-padding"
        style={{
          padding: "120px 48px",
          borderTop: `1px solid ${brand.border}`,
          background: brand.white,
        }}
      >
        <div style={{ maxWidth: 1200, margin: "0 auto" }}>
          <div
            className="two-col"
            style={{
              display: "grid",
              gridTemplateColumns: "minmax(0, 1fr) minmax(0, 1fr)",
              gap: 80,
              alignItems: "center",
            }}
          >
            <div style={{ minWidth: 0 }}>
              <span
                style={{
                  fontFamily: "'JetBrains Mono', monospace",
                  fontSize: 11,
                  color: brand.moss,
                  letterSpacing: "0.2em",
                  textTransform: "uppercase",
                }}
              >
                05 — Get in Touch
              </span>
              <h2
                style={{
                  fontFamily: "'Instrument Serif', serif",
                  fontSize: 52,
                  fontWeight: 400,
                  color: brand.forest,
                  letterSpacing: "-0.02em",
                  marginTop: 16,
                  lineHeight: 1.1,
                  marginBottom: 24,
                }}
              >
                Let's talk about
                <br />
                <span style={{ fontStyle: "italic", color: brand.orange }}>
                  your data.
                </span>
              </h2>
              <p
                style={{
                  fontFamily: "'DM Sans', sans-serif",
                  fontSize: 16,
                  fontWeight: 300,
                  color: brand.bodySoft,
                  lineHeight: 1.7,
                  marginBottom: 40,
                }}
              >
                Whether you need geospatial analysis, an AI-powered system,
                satellite or survey data, or a dedicated data team — we'd like
                to hear from you.
              </p>
              <button
                type="button"
                className="cta-btn filled"
                onClick={openContactForm}
              >
                Start a conversation
              </button>
            </div>

            <div
              className="contact-expertise-card"
              style={{
                padding: 48,
                border: `1px solid ${brand.border}`,
                background: brand.bgSection,
                minWidth: 0,
              }}
            >
              {[
                {
                  label: "Remote Sensing",
                  detail: "LiDAR, hyperspectral, optical, satellite",
                },
                {
                  label: "AI & Automation",
                  detail: "Intelligent systems, RAG, data pipelines",
                },
                { label: "Software", detail: "Platforms, dashboards, knowledge graphs" },
                { label: "Data Operations", detail: "GIS processing, research, QA at scale" },
                { label: "Applied Research", detail: "Agriculture, carbon, environmental" },
              ].map((item, i) => (
                <div
                  key={item.label}
                  className="contact-expertise-row"
                  style={{
                    padding: "16px 0",
                    borderBottom: i < 4 ? `1px solid ${brand.border}` : "none",
                  }}
                >
                  <span
                    className="contact-expertise-label"
                    style={{
                      fontFamily: "'DM Sans', sans-serif",
                      fontSize: 14,
                      fontWeight: 500,
                      color: brand.forest,
                    }}
                  >
                    {item.label}
                  </span>
                  <span
                    className="contact-expertise-detail"
                    style={{
                      fontFamily: "'JetBrains Mono', monospace",
                      fontSize: 11,
                      color: brand.moss,
                    }}
                  >
                    {item.detail}
                  </span>
                </div>
              ))}
            </div>
          </div>
        </div>
      </section>

      {contactFormOpen && (
        <div
          role="presentation"
          style={{
            position: "fixed",
            inset: 0,
            zIndex: 2500,
            display: "flex",
            alignItems: "center",
            justifyContent: "center",
            padding:
              "max(20px, env(safe-area-inset-top)) 20px max(20px, env(safe-area-inset-bottom)) 20px",
            background: "rgba(16, 78, 63, 0.45)",
            backdropFilter: "blur(6px)",
          }}
          onClick={() => {
            if (!contactSubmitting) closeContactForm();
          }}
        >
          <div
            role="dialog"
            aria-modal="true"
            aria-labelledby="contact-form-title"
            onClick={(ev) => ev.stopPropagation()}
            style={{
              width: "100%",
              maxWidth: 520,
              maxHeight: "min(92vh, 880px)",
              overflow: "auto",
              background: brand.white,
              border: `1px solid ${brand.border}`,
              borderRadius: 2,
              boxShadow: "0 24px 80px rgba(0,0,0,0.18)",
              padding: "clamp(24px, 5vw, 36px)",
              WebkitOverflowScrolling: "touch",
            }}
          >
            {contactSuccess ? (
              <div>
                <h2
                  id="contact-form-title"
                  style={{
                    fontFamily: "'Instrument Serif', serif",
                    fontSize: 32,
                    fontWeight: 400,
                    color: brand.forest,
                    lineHeight: 1.15,
                    marginBottom: 16,
                  }}
                >
                  Thank you
                </h2>
                <p
                  style={{
                    fontFamily: "'DM Sans', sans-serif",
                    fontSize: 16,
                    fontWeight: 300,
                    color: brand.bodySoft,
                    lineHeight: 1.65,
                    marginBottom: 28,
                  }}
                >
                  Your message and any files have been sent. We&apos;ll review
                  your project and get back to you by email.
                </p>
                <button
                  type="button"
                  className="cta-btn filled"
                  onClick={closeContactForm}
                >
                  Close
                </button>
              </div>
            ) : (
              <form
                onSubmit={handleContactSubmit}
                className="contact-form"
                style={{ position: "relative" }}
              >
                <h2
                  id="contact-form-title"
                  style={{
                    fontFamily: "'Instrument Serif', serif",
                    fontSize: "clamp(26px, 5vw, 32px)",
                    fontWeight: 400,
                    color: brand.forest,
                    lineHeight: 1.15,
                    marginBottom: 8,
                  }}
                >
                  Start a conversation
                </h2>
                <p
                  style={{
                    fontFamily: "'DM Sans', sans-serif",
                    fontSize: 14,
                    fontWeight: 300,
                    color: brand.muted,
                    lineHeight: 1.55,
                    marginBottom: 28,
                  }}
                >
                  Tell us about your project and attach any reference images or
                  data that help describe what you need.
                </p>
                <input
                  ref={gotchaRef}
                  type="text"
                  tabIndex={-1}
                  autoComplete="off"
                  style={{
                    position: "absolute",
                    left: -9999,
                    width: 1,
                    height: 1,
                    margin: 0,
                    border: 0,
                    padding: 0,
                    opacity: 0,
                  }}
                  aria-hidden="true"
                />

                <div style={{ marginBottom: 18 }}>
                  <label className="contact-form-label" htmlFor="contact-name">
                    Name
                  </label>
                  <input
                    id="contact-name"
                    className="contact-form-input"
                    name="name"
                    type="text"
                    autoComplete="name"
                    value={contactName}
                    onChange={(e) => setContactName(e.target.value)}
                    disabled={contactSubmitting}
                    required
                  />
                </div>
                <div style={{ marginBottom: 18 }}>
                  <label className="contact-form-label" htmlFor="contact-email">
                    Email
                  </label>
                  <input
                    id="contact-email"
                    className="contact-form-input"
                    name="email"
                    type="email"
                    autoComplete="email"
                    value={contactEmail}
                    onChange={(e) => setContactEmail(e.target.value)}
                    disabled={contactSubmitting}
                    required
                  />
                </div>
                <div style={{ marginBottom: 18 }}>
                  <label
                    className="contact-form-label"
                    htmlFor="contact-company"
                  >
                    Organisation (optional)
                  </label>
                  <input
                    id="contact-company"
                    className="contact-form-input"
                    name="company"
                    type="text"
                    autoComplete="organization"
                    value={contactCompany}
                    onChange={(e) => setContactCompany(e.target.value)}
                    disabled={contactSubmitting}
                  />
                </div>
                <div style={{ marginBottom: 18 }}>
                  <label className="contact-form-label" htmlFor="contact-phone">
                    Phone (optional)
                  </label>
                  <input
                    id="contact-phone"
                    className="contact-form-input"
                    name="phone"
                    type="tel"
                    autoComplete="tel"
                    value={contactPhone}
                    onChange={(e) => setContactPhone(e.target.value)}
                    disabled={contactSubmitting}
                  />
                </div>
                <div style={{ marginBottom: 18 }}>
                  <label
                    className="contact-form-label"
                    htmlFor="contact-message"
                  >
                    Project message
                  </label>
                  <textarea
                    id="contact-message"
                    className="contact-form-textarea"
                    name="message"
                    value={contactMessage}
                    onChange={(e) => setContactMessage(e.target.value)}
                    disabled={contactSubmitting}
                    required
                    placeholder="What are you trying to solve, scope, timeline…"
                  />
                </div>

                <div style={{ marginBottom: 20 }}>
                  <label className="contact-form-label" htmlFor="contact-files">
                    Reference files (optional)
                  </label>
                  <input
                    id="contact-files"
                    ref={fileInputRef}
                    type="file"
                    className="contact-form-input"
                    accept={DEFAULT_ACCEPT}
                    multiple
                    disabled={contactSubmitting}
                    onChange={onProjectFilesChange}
                    style={{ padding: 10, cursor: "pointer" }}
                  />
                  <p className="contact-form-hint">
                    Images, PDFs, CSVs, GeoJSON, zips, or other data — up to{" "}
                    {MAX_CONTACT_FILES} files, {MAX_CONTACT_FILE_BYTES / 1024 / 1024}{" "}
                    MB each. You can add more in another message if needed.
                  </p>
                </div>

                {projectFiles.length > 0 && (
                  <ul
                    style={{
                      listStyle: "none",
                      margin: "0 0 20px 0",
                      padding: 0,
                      display: "flex",
                      flexDirection: "column",
                      gap: 8,
                    }}
                  >
                    {projectFiles.map((f, i) => (
                      <li
                        key={`${f.name}-${i}`}
                        style={{
                          display: "flex",
                          alignItems: "center",
                          justifyContent: "space-between",
                          gap: 12,
                          fontFamily: "'JetBrains Mono', monospace",
                          fontSize: 11,
                          color: brand.body,
                          minWidth: 0,
                        }}
                      >
                        <span style={{ overflow: "hidden", textOverflow: "ellipsis" }}>
                          {f.name} (
                          {f.size >= 1024 * 1024
                            ? `${(f.size / (1024 * 1024)).toFixed(1)} MB`
                            : `${Math.max(1, Math.round(f.size / 1024))} KB`}
                          )
                        </span>
                        <button
                          type="button"
                          disabled={contactSubmitting}
                          onClick={() => removeProjectFile(i)}
                          style={{
                            flexShrink: 0,
                            fontFamily: "'DM Sans', sans-serif",
                            fontSize: 12,
                            color: brand.forest,
                            background: "none",
                            border: "none",
                            textDecoration: "underline",
                            textUnderlineOffset: 3,
                            cursor: "pointer",
                            padding: 4,
                          }}
                        >
                          Remove
                        </button>
                      </li>
                    ))}
                  </ul>
                )}

                <p
                  className="contact-form-hint"
                  style={{ marginBottom: 16, display: "block" }}
                >
                  We won&apos;t show your address on the site. Submissions are
                  delivered securely to our team.
                </p>
                <div
                  style={{
                    border: `1px solid ${brand.border}`,
                    background: brand.bgSection,
                    padding: 14,
                    borderRadius: 2,
                    marginBottom: 16,
                  }}
                >
                  <div
                    style={{
                      fontFamily: "'JetBrains Mono', monospace",
                      fontSize: 10,
                      color: brand.muted,
                      letterSpacing: "0.12em",
                      textTransform: "uppercase",
                      marginBottom: 8,
                    }}
                  >
                    Account (optional)
                  </div>
                  {authUser ? (
                    <div
                      style={{
                        display: "flex",
                        flexWrap: "wrap",
                        alignItems: "center",
                        justifyContent: "space-between",
                        gap: 10,
                      }}
                    >
                      <div
                        style={{
                          fontFamily: "'DM Sans', sans-serif",
                          fontSize: 13,
                          color: brand.bodySoft,
                        }}
                      >
                        Signed in as{" "}
                        <span style={{ color: brand.forest }}>
                          {authUser.email || "Google user"}
                        </span>
                      </div>
                      <button
                        type="button"
                        className="cta-btn"
                        disabled={contactSubmitting}
                        onClick={signOut}
                        style={{ padding: "12px 18px" }}
                      >
                        Sign out
                      </button>
                    </div>
                  ) : (
                    <div style={{ display: "flex", flexDirection: "column", gap: 10 }}>
                      <button
                        type="button"
                        className="cta-btn"
                        disabled={contactSubmitting}
                        onClick={() => {
                          setAuthMode("google");
                          signInWithGoogle();
                        }}
                        style={{ padding: "12px 18px" }}
                      >
                        Continue with Google
                      </button>
                      <button
                        type="button"
                        className="cta-btn"
                        disabled={contactSubmitting}
                        onClick={() => setAuthMode("email-signin")}
                        style={{ padding: "12px 18px" }}
                      >
                        Use email instead
                      </button>

                      {(authMode === "email-signin" ||
                        authMode === "email-signup") && (
                        <div
                          style={{
                            marginTop: 4,
                            paddingTop: 12,
                            borderTop: `1px solid ${brand.border}`,
                            display: "flex",
                            flexDirection: "column",
                            gap: 10,
                          }}
                        >
                          <div style={{ display: "grid", gap: 10 }}>
                            <div>
                              <label
                                className="contact-form-label"
                                htmlFor="auth-email"
                              >
                                Account email
                              </label>
                              <input
                                id="auth-email"
                                className="contact-form-input"
                                type="email"
                                autoComplete="email"
                                value={authEmail}
                                onChange={(e) => setAuthEmail(e.target.value)}
                                disabled={contactSubmitting}
                              />
                            </div>
                            <div>
                              <label
                                className="contact-form-label"
                                htmlFor="auth-password"
                              >
                                Password
                              </label>
                              <input
                                id="auth-password"
                                className="contact-form-input"
                                type="password"
                                autoComplete={
                                  authMode === "email-signup"
                                    ? "new-password"
                                    : "current-password"
                                }
                                value={authPassword}
                                onChange={(e) => setAuthPassword(e.target.value)}
                                disabled={contactSubmitting}
                              />
                            </div>
                            {authMode === "email-signup" && (
                              <div>
                                <label
                                  className="contact-form-label"
                                  htmlFor="auth-password2"
                                >
                                  Confirm password
                                </label>
                                <input
                                  id="auth-password2"
                                  className="contact-form-input"
                                  type="password"
                                  autoComplete="new-password"
                                  value={authPassword2}
                                  onChange={(e) => setAuthPassword2(e.target.value)}
                                  disabled={contactSubmitting}
                                />
                              </div>
                            )}
                          </div>

                          <div style={{ display: "flex", flexWrap: "wrap", gap: 10 }}>
                            {authMode === "email-signin" ? (
                              <>
                                <button
                                  type="button"
                                  className="cta-btn filled"
                                  disabled={contactSubmitting}
                                  onClick={signInWithEmail}
                                  style={{ padding: "12px 18px" }}
                                >
                                  Sign in
                                </button>
                                <button
                                  type="button"
                                  className="cta-btn"
                                  disabled={contactSubmitting}
                                  onClick={() => setAuthMode("email-signup")}
                                  style={{ padding: "12px 18px" }}
                                >
                                  Create account
                                </button>
                              </>
                            ) : (
                              <>
                                <button
                                  type="button"
                                  className="cta-btn filled"
                                  disabled={contactSubmitting}
                                  onClick={signUpWithEmail}
                                  style={{ padding: "12px 18px" }}
                                >
                                  Create account
                                </button>
                                <button
                                  type="button"
                                  className="cta-btn"
                                  disabled={contactSubmitting}
                                  onClick={() => setAuthMode("email-signin")}
                                  style={{ padding: "12px 18px" }}
                                >
                                  Back to sign in
                                </button>
                              </>
                            )}
                          </div>
                        </div>
                      )}
                    </div>
                  )}
                  {!supabaseConfigured && (
                    <p
                      className="contact-form-hint"
                      style={{ marginTop: 10, marginBottom: 0 }}
                    >
                      Sign-in and saved enquiries are not available in this environment yet.
                      Please contact Fangorn directly if you need access.
                    </p>
                  )}
                </div>
                {contactError && (
                  <p
                    role="alert"
                    style={{
                      fontFamily: "'DM Sans', sans-serif",
                      fontSize: 14,
                      color: "#a33",
                      marginBottom: 16,
                      lineHeight: 1.5,
                    }}
                  >
                    {contactError}
                  </p>
                )}

                <div
                  style={{
                    display: "flex",
                    flexWrap: "wrap",
                    gap: 12,
                    marginTop: 8,
                  }}
                >
                  <button
                    type="submit"
                    className="cta-btn filled"
                    disabled={contactSubmitting}
                  >
                    {contactSubmitting ? "Sending…" : "Send message"}
                  </button>
                  <button
                    type="button"
                    className="cta-btn"
                    disabled={contactSubmitting}
                    onClick={closeContactForm}
                  >
                    Cancel
                  </button>
                </div>
              </form>
            )}
          </div>
        </div>
      )}

      {authDialogOpen && (
        <div
          role="presentation"
          style={{
            position: "fixed",
            inset: 0,
            zIndex: 2600,
            display: "flex",
            alignItems: "center",
            justifyContent: "center",
            padding:
              "max(20px, env(safe-area-inset-top)) 20px max(20px, env(safe-area-inset-bottom)) 20px",
            background: "rgba(16, 78, 63, 0.45)",
            backdropFilter: "blur(6px)",
          }}
          onClick={closeAuthDialog}
        >
          <div
            role="dialog"
            aria-modal="true"
            aria-labelledby="auth-dialog-title"
            onClick={(ev) => ev.stopPropagation()}
            style={{
              width: "100%",
              maxWidth: 520,
              maxHeight: "min(92vh, 760px)",
              overflow: "auto",
              background: brand.white,
              border: `1px solid ${brand.border}`,
              borderRadius: 2,
              boxShadow: "0 24px 80px rgba(0,0,0,0.18)",
              padding: "clamp(24px, 5vw, 36px)",
              WebkitOverflowScrolling: "touch",
            }}
          >
            <h2
              id="auth-dialog-title"
              style={{
                fontFamily: "'Instrument Serif', serif",
                fontSize: "clamp(26px, 5vw, 32px)",
                fontWeight: 400,
                color: brand.forest,
                lineHeight: 1.15,
                marginBottom: 8,
              }}
            >
              Sign in
            </h2>
            <p
              style={{
                fontFamily: "'DM Sans', sans-serif",
                fontSize: 14,
                fontWeight: 300,
                color: brand.muted,
                lineHeight: 1.55,
                marginBottom: 22,
              }}
            >
              Sign in to link enquiries to your account. You can also submit an
              enquiry without signing in.
            </p>

            <div style={{ display: "grid", gap: 14 }}>
              <button
                type="button"
                className="cta-btn filled"
                onClick={() => {
                  setAuthMode("google");
                  signInWithGoogle();
                }}
                style={{ width: "100%", textAlign: "center" }}
              >
                Continue with Google
              </button>

              <div
                style={{
                  display: "flex",
                  alignItems: "center",
                  gap: 12,
                  color: brand.borderSoft,
                }}
                aria-hidden="true"
              >
                <div style={{ height: 1, background: brand.borderSoft, flex: 1 }} />
                <span
                  style={{
                    fontFamily: "'JetBrains Mono', monospace",
                    fontSize: 10,
                    letterSpacing: "0.18em",
                    textTransform: "uppercase",
                    color: brand.muted,
                  }}
                >
                  or
                </span>
                <div style={{ height: 1, background: brand.borderSoft, flex: 1 }} />
              </div>

              <div
                style={{
                  display: "inline-flex",
                  gap: 8,
                  padding: 4,
                  border: `1px solid ${brand.border}`,
                  background: brand.bgSection,
                  borderRadius: 2,
                  width: "fit-content",
                }}
              >
                <button
                  type="button"
                  className="cta-btn"
                  onClick={() => setAuthMode("email-signin")}
                  style={{
                    padding: "12px 16px",
                    background:
                      authMode === "email-signin" ? brand.white : "transparent",
                    borderColor:
                      authMode === "email-signin" ? brand.border : "transparent",
                    boxShadow:
                      authMode === "email-signin"
                        ? "0 1px 0 rgba(16,78,63,0.06)"
                        : "none",
                  }}
                >
                  Email sign in
                </button>
                <button
                  type="button"
                  className="cta-btn"
                  onClick={() => setAuthMode("email-signup")}
                  style={{
                    padding: "12px 16px",
                    background:
                      authMode === "email-signup" ? brand.white : "transparent",
                    borderColor:
                      authMode === "email-signup" ? brand.border : "transparent",
                    boxShadow:
                      authMode === "email-signup"
                        ? "0 1px 0 rgba(16,78,63,0.06)"
                        : "none",
                  }}
                >
                  Create account
                </button>
              </div>

              {(authMode === "email-signin" || authMode === "email-signup") && (
                <div style={{ display: "grid", gap: 12, marginTop: 6 }}>
                  <div>
                    <label className="contact-form-label" htmlFor="auth2-email">
                      Email
                    </label>
                    <input
                      id="auth2-email"
                      className="contact-form-input"
                      type="email"
                      autoComplete="email"
                      value={authEmail}
                      onChange={(e) => setAuthEmail(e.target.value)}
                    />
                  </div>
                  <div>
                    <label
                      className="contact-form-label"
                      htmlFor="auth2-password"
                    >
                      Password
                    </label>
                    <input
                      id="auth2-password"
                      className="contact-form-input"
                      type="password"
                      autoComplete={
                        authMode === "email-signup"
                          ? "new-password"
                          : "current-password"
                      }
                      value={authPassword}
                      onChange={(e) => setAuthPassword(e.target.value)}
                    />
                  </div>
                  {authMode === "email-signup" && (
                    <div>
                      <label
                        className="contact-form-label"
                        htmlFor="auth2-password2"
                      >
                        Confirm password
                      </label>
                      <input
                        id="auth2-password2"
                        className="contact-form-input"
                        type="password"
                        autoComplete="new-password"
                        value={authPassword2}
                        onChange={(e) => setAuthPassword2(e.target.value)}
                      />
                    </div>
                  )}

                  <div style={{ display: "flex", gap: 12, flexWrap: "wrap" }}>
                    {authMode === "email-signin" ? (
                      <button
                        type="button"
                        className="cta-btn filled"
                        onClick={signInWithEmail}
                        style={{ padding: "14px 22px" }}
                      >
                        Sign in
                      </button>
                    ) : (
                      <button
                        type="button"
                        className="cta-btn filled"
                        onClick={signUpWithEmail}
                        style={{ padding: "14px 22px" }}
                      >
                        Create account
                      </button>
                    )}
                    <button
                      type="button"
                      className="cta-btn"
                      onClick={closeAuthDialog}
                      style={{ padding: "14px 22px" }}
                    >
                      Close
                    </button>
                  </div>
                </div>
              )}

              <button
                type="button"
                onClick={() => {
                  closeAuthDialog();
                  openContactForm();
                }}
                style={{
                  marginTop: 4,
                  background: "none",
                  border: "none",
                  padding: 0,
                  cursor: "pointer",
                  fontFamily: "'JetBrains Mono', monospace",
                  fontSize: 11,
                  letterSpacing: "0.12em",
                  textTransform: "uppercase",
                  color: brand.forest,
                  textDecoration: "underline",
                  textUnderlineOffset: 4,
                  width: "fit-content",
                }}
              >
                Start an enquiry instead
              </button>
            </div>

            {contactError && (
              <p
                role="alert"
                style={{
                  fontFamily: "'DM Sans', sans-serif",
                  fontSize: 14,
                  color: "#a33",
                  marginTop: 16,
                  lineHeight: 1.5,
                }}
              >
                {contactError}
              </p>
            )}
          </div>
        </div>
      )}

      {profileOpen && (
        <div
          role="presentation"
          style={{
            position: "fixed",
            inset: 0,
            zIndex: 2700,
            display: "flex",
            alignItems: "center",
            justifyContent: "center",
            padding:
              "max(20px, env(safe-area-inset-top)) 20px max(20px, env(safe-area-inset-bottom)) 20px",
            background: "rgba(16, 78, 63, 0.45)",
            backdropFilter: "blur(6px)",
          }}
          onClick={closeProfile}
        >
          <div
            role="dialog"
            aria-modal="true"
            aria-label="Your profile"
            onClick={(ev) => ev.stopPropagation()}
            style={{
              width: "100%",
              maxWidth: 980,
              maxHeight: "min(92vh, 860px)",
              overflow: "auto",
              background: brand.white,
              border: `1px solid ${brand.border}`,
              borderRadius: 2,
              boxShadow: "0 24px 80px rgba(0,0,0,0.18)",
              padding: "clamp(20px, 4vw, 32px)",
              WebkitOverflowScrolling: "touch",
            }}
          >
            <div
              style={{
                display: "flex",
                alignItems: "flex-start",
                justifyContent: "space-between",
                gap: 16,
                marginBottom: 18,
              }}
            >
              <div style={{ minWidth: 0 }}>
                <div
                  style={{
                    fontFamily: "'JetBrains Mono', monospace",
                    fontSize: 11,
                    color: brand.muted,
                    letterSpacing: "0.18em",
                    textTransform: "uppercase",
                    marginBottom: 10,
                  }}
                >
                  Account
                </div>
                <h2
                  style={{
                    fontFamily: "'Instrument Serif', serif",
                    fontSize: "clamp(26px, 4vw, 34px)",
                    fontWeight: 400,
                    color: brand.forest,
                    lineHeight: 1.1,
                    marginBottom: 8,
                  }}
                >
                  Your profile
                </h2>
                <div
                  style={{
                    fontFamily: "'DM Sans', sans-serif",
                    fontSize: 14,
                    fontWeight: 300,
                    color: brand.bodySoft,
                    lineHeight: 1.6,
                    overflow: "hidden",
                    textOverflow: "ellipsis",
                  }}
                >
                  {authUser?.email || "Signed in"}
                </div>
              </div>
              <div style={{ display: "flex", gap: 10, flexWrap: "wrap" }}>
                <button
                  type="button"
                  className="cta-btn"
                  onClick={signOut}
                  style={{ padding: "14px 22px" }}
                >
                  Sign out
                </button>
                <button
                  type="button"
                  className="cta-btn filled"
                  onClick={closeProfile}
                  style={{ padding: "14px 22px" }}
                >
                  Close
                </button>
              </div>
            </div>

            <div
              style={{
                display: "grid",
                gridTemplateColumns: "minmax(0, 0.9fr) minmax(0, 1.1fr)",
                gap: 18,
              }}
            >
              <div
                style={{
                  border: `1px solid ${brand.border}`,
                  background: brand.bgSection,
                  padding: 16,
                  borderRadius: 2,
                  minWidth: 0,
                }}
              >
                <div
                  style={{
                    fontFamily: "'JetBrains Mono', monospace",
                    fontSize: 10,
                    color: brand.muted,
                    letterSpacing: "0.18em",
                    textTransform: "uppercase",
                    marginBottom: 12,
                  }}
                >
                  Your enquiries
                </div>

                {profileLoading ? (
                  <div
                    style={{
                      fontFamily: "'DM Sans', sans-serif",
                      fontSize: 14,
                      color: brand.muted,
                    }}
                  >
                    Loading…
                  </div>
                ) : myEnquiries.length === 0 ? (
                  <div
                    style={{
                      fontFamily: "'DM Sans', sans-serif",
                      fontSize: 14,
                      fontWeight: 300,
                      color: brand.bodySoft,
                      lineHeight: 1.6,
                    }}
                  >
                    No enquiries yet. Submit one from “Start a conversation”.
                  </div>
                ) : (
                  <div style={{ display: "grid", gap: 10 }}>
                    {myEnquiries.map((e) => {
                      const active = e.id === selectedEnquiryId;
                      return (
                        <button
                          key={e.id}
                          type="button"
                          onClick={() => setSelectedEnquiryId(e.id)}
                          style={{
                            textAlign: "left",
                            padding: "12px 12px",
                            borderRadius: 2,
                            border: `1px solid ${
                              active ? brand.sage : brand.border
                            }`,
                            background: active ? brand.white : "rgba(255,255,255,0.6)",
                            cursor: "pointer",
                          }}
                        >
                          <div
                            style={{
                              display: "flex",
                              justifyContent: "space-between",
                              gap: 12,
                              alignItems: "baseline",
                            }}
                          >
                            <div
                              style={{
                                fontFamily: "'DM Sans', sans-serif",
                                fontSize: 14,
                                fontWeight: 500,
                                color: brand.forest,
                                overflow: "hidden",
                                textOverflow: "ellipsis",
                                whiteSpace: "nowrap",
                              }}
                              title={e.message}
                            >
                              {e.message?.slice(0, 42) || "Enquiry"}
                              {e.message && e.message.length > 42 ? "…" : ""}
                            </div>
                            <div
                              style={{
                                fontFamily: "'JetBrains Mono', monospace",
                                fontSize: 10,
                                color: brand.muted,
                                letterSpacing: "0.12em",
                                textTransform: "uppercase",
                                flexShrink: 0,
                              }}
                            >
                              {e.status || "new"}
                            </div>
                          </div>
                          <div
                            style={{
                              fontFamily: "'JetBrains Mono', monospace",
                              fontSize: 10,
                              color: brand.muted,
                              marginTop: 6,
                            }}
                          >
                            {new Date(e.created_at).toLocaleString()}
                          </div>
                        </button>
                      );
                    })}
                  </div>
                )}
              </div>

              <div
                style={{
                  border: `1px solid ${brand.border}`,
                  background: brand.white,
                  padding: 16,
                  borderRadius: 2,
                  minWidth: 0,
                }}
              >
                {(() => {
                  const e = myEnquiries.find((x) => x.id === selectedEnquiryId);
                  if (!e) {
                    return (
                      <div
                        style={{
                          fontFamily: "'DM Sans', sans-serif",
                          fontSize: 14,
                          color: brand.muted,
                        }}
                      >
                        Select an enquiry to view details.
                      </div>
                    );
                  }
                  const files = e.enquiry_files || [];
                  const responses = (e.enquiry_responses || []).slice().sort((a, b) => {
                    return new Date(a.created_at) - new Date(b.created_at);
                  });
                  return (
                    <div style={{ display: "grid", gap: 16 }}>
                      <div>
                        <div
                          style={{
                            fontFamily: "'JetBrains Mono', monospace",
                            fontSize: 10,
                            color: brand.muted,
                            letterSpacing: "0.18em",
                            textTransform: "uppercase",
                            marginBottom: 8,
                          }}
                        >
                          Enquiry details
                        </div>
                        <div
                          style={{
                            fontFamily: "'DM Sans', sans-serif",
                            fontSize: 14,
                            fontWeight: 300,
                            color: brand.bodySoft,
                            lineHeight: 1.65,
                            whiteSpace: "pre-wrap",
                          }}
                        >
                          {e.message}
                        </div>
                      </div>

                      <div
                        style={{
                          borderTop: `1px solid ${brand.borderSoft}`,
                          paddingTop: 14,
                        }}
                      >
                        <div
                          style={{
                            fontFamily: "'JetBrains Mono', monospace",
                            fontSize: 10,
                            color: brand.muted,
                            letterSpacing: "0.18em",
                            textTransform: "uppercase",
                            marginBottom: 10,
                          }}
                        >
                          Attachments
                        </div>
                        {files.length === 0 ? (
                          <div
                            style={{
                              fontFamily: "'DM Sans', sans-serif",
                              fontSize: 14,
                              fontWeight: 300,
                              color: brand.muted,
                            }}
                          >
                            None
                          </div>
                        ) : (
                          <ul style={{ listStyle: "none", padding: 0, margin: 0, display: "grid", gap: 8 }}>
                            {files.map((f) => (
                              <li
                                key={f.id}
                                style={{
                                  display: "flex",
                                  alignItems: "center",
                                  justifyContent: "space-between",
                                  gap: 12,
                                  minWidth: 0,
                                }}
                              >
                                <span
                                  style={{
                                    fontFamily: "'JetBrains Mono', monospace",
                                    fontSize: 11,
                                    color: brand.body,
                                    overflow: "hidden",
                                    textOverflow: "ellipsis",
                                    whiteSpace: "nowrap",
                                  }}
                                  title={f.filename}
                                >
                                  {f.filename}
                                </span>
                                <button
                                  type="button"
                                  onClick={async () => {
                                    if (!supabase) return;
                                    const { data } = await supabase.storage
                                      .from(f.bucket)
                                      .createSignedUrl(f.path, 60);
                                    if (data?.signedUrl) window.open(data.signedUrl, "_blank");
                                  }}
                                  style={{
                                    flexShrink: 0,
                                    fontFamily: "'DM Sans', sans-serif",
                                    fontSize: 12,
                                    color: brand.forest,
                                    background: "none",
                                    border: "none",
                                    textDecoration: "underline",
                                    textUnderlineOffset: 3,
                                    cursor: "pointer",
                                    padding: 4,
                                  }}
                                >
                                  Download
                                </button>
                              </li>
                            ))}
                          </ul>
                        )}
                      </div>

                      <div
                        style={{
                          borderTop: `1px solid ${brand.borderSoft}`,
                          paddingTop: 14,
                        }}
                      >
                        <div
                          style={{
                            fontFamily: "'JetBrains Mono', monospace",
                            fontSize: 10,
                            color: brand.muted,
                            letterSpacing: "0.18em",
                            textTransform: "uppercase",
                            marginBottom: 10,
                          }}
                        >
                          Responses
                        </div>
                        {responses.length === 0 ? (
                          <div
                            style={{
                              fontFamily: "'DM Sans', sans-serif",
                              fontSize: 14,
                              fontWeight: 300,
                              color: brand.muted,
                            }}
                          >
                            No response yet. We’ll email you when we reply.
                          </div>
                        ) : (
                          <div style={{ display: "grid", gap: 12 }}>
                            {responses.map((r) => (
                              <div
                                key={r.id}
                                style={{
                                  border: `1px solid ${brand.border}`,
                                  background: brand.bgSection,
                                  padding: 14,
                                  borderRadius: 2,
                                }}
                              >
                                <div
                                  style={{
                                    fontFamily: "'JetBrains Mono', monospace",
                                    fontSize: 10,
                                    color: brand.muted,
                                    marginBottom: 8,
                                  }}
                                >
                                  {new Date(r.created_at).toLocaleString()}
                                </div>
                                <div
                                  style={{
                                    fontFamily: "'DM Sans', sans-serif",
                                    fontSize: 14,
                                    fontWeight: 300,
                                    color: brand.bodySoft,
                                    lineHeight: 1.65,
                                    whiteSpace: "pre-wrap",
                                  }}
                                >
                                  {r.message}
                                </div>
                              </div>
                            ))}
                          </div>
                        )}
                      </div>
                    </div>
                  );
                })()}
              </div>
            </div>
          </div>
        </div>
      )}

      <footer
        style={{
          padding: "40px 48px",
          background: brand.forest,
          display: "flex",
          justifyContent: "space-between",
          alignItems: "center",
          flexWrap: "wrap",
          gap: 24,
        }}
      >
        <div style={{ display: "flex", alignItems: "center", gap: 20 }}>
          <img
            src={fullLogo}
            alt="Fangorn Group"
            style={{
              height: 32,
              width: "auto",
              maxWidth: 200,
              objectFit: "contain",
              filter: "brightness(0) invert(1)",
              opacity: 0.92,
            }}
          />
          <span
            style={{
              fontFamily: "'JetBrains Mono', monospace",
              fontSize: 11,
              color: "rgba(255,255,255,0.55)",
            }}
          >
            © 2026 Fangorn Group Limited
          </span>
        </div>
        <span
          style={{
            fontFamily: "'JetBrains Mono', monospace",
            fontSize: 11,
            color: "rgba(255,255,255,0.5)",
          }}
        >
          United Kingdom · Zimbabwe
        </span>
      </footer>
    </div>
  );
}

