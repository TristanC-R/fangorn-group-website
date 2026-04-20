import { useEffect, useState } from "react";

const SECTIONS = ["home", "services", "projects", "team", "contact"];

const NoiseOverlay = () => (
  <svg
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
      background: "rgba(27,58,45,0.04)",
      animation: `fadeInLine 2s ${delay}s ease forwards`,
      opacity: 0,
    }}
  />
);

export default function FangornWebsite() {
  const [activeSection, setActiveSection] = useState("home");
  const [scrollY, setScrollY] = useState(0);
  const [hoveredService, setHoveredService] = useState(null);

  useEffect(() => {
    const handleScroll = () => setScrollY(window.scrollY);
    window.addEventListener("scroll", handleScroll, { passive: true });
    return () => window.removeEventListener("scroll", handleScroll);
  }, []);

  const services = [
    {
      id: "remote-sensing",
      title: "Remote Sensing & Surveying",
      icon: "◎",
      desc: "UAV LiDAR, hyperspectral, and optical surveys. High-resolution orthomosaics, 3D point clouds, and digital surface models for any terrain.",
      tags: ["LiDAR", "Hyperspectral", "Photogrammetry", "DSM/DTM"],
    },
    {
      id: "ai-agents",
      title: "Custom AI Agents",
      icon: "⬡",
      desc: "Purpose-built autonomous agents for business workflows — from account reconciliation and web scraping to research automation and data extraction.",
      tags: ["LLM Agents", "Automation", "RAG Systems", "Data Pipelines"],
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
      id: "outsourcing",
      title: "Data Operations",
      icon: "⟐",
      desc: "A dedicated 10-person data analyst team delivering GIS processing, data labelling, quality assurance, digitisation, and business research at scale.",
      tags: ["GIS Processing", "QA", "Digitisation", "Business Research"],
    },
  ];

  const projects = [
    {
      title: "Gower Cemetery Mapping",
      client: "Gower Consultants",
      category: "Remote Sensing",
      description:
        "Ongoing high-resolution LiDAR and optical surveying of cemetery sites. Automated headstone measurement, movement monitoring, tree carbon assessment, and OCR-based transcription of historical records into structured databases.",
      color: "#2D5A3F",
    },
    {
      title: "Crop Canopy Cover Research",
      client: "Weetabix",
      category: "Agricultural Analytics",
      description:
        "Funded research programme using UAV-mounted sensors to quantify crop canopy cover, monitor growth stages, and provide precision agriculture insights for large-scale cereal production.",
      color: "#8A7B5B",
    },
    {
      title: "Sinkhole Detection & Quantification",
      client: "Confidential",
      category: "Geospatial Analytics",
      description:
        "LiDAR-based detection and volumetric quantification of sinkholes across large survey areas. Change detection analysis and risk assessment for geotechnical planning.",
      color: "#3A6A6A",
    },
    {
      title: "Cefetra Trading Platform",
      client: "Cefetra",
      category: "Software Development",
      description:
        "Full-stack commodity trading platform managing grain trading workflows, client relationships, operational data integration, and real-time reporting dashboards.",
      color: "#5A4A6A",
    },
    {
      title: "Account Reconciliation Agent",
      client: "Confidential",
      category: "AI Agents",
      description:
        "Autonomous AI agent for financial account reconciliation — matching transactions, flagging discrepancies, and generating exception reports with minimal human oversight.",
      color: "#6A4A5A",
    },
    {
      title: "Business Research & Web Scraping",
      client: "Various",
      category: "Data Operations",
      description:
        "Automated web scraping pipelines and structured business intelligence research, delivering clean datasets for market analysis, competitor tracking, and lead generation.",
      color: "#4A6A5A",
    },
  ];

  return (
    <div
      style={{
        fontFamily: "'Instrument Serif', Georgia, serif",
        background: "#FFFFFF",
        color: "#4A5A50",
        minHeight: "100vh",
        position: "relative",
      }}
    >
      <NoiseOverlay />
      <style>{`
        @import url('https://fonts.googleapis.com/css2?family=Instrument+Serif:ital@0;1&family=DM+Sans:ital,wght@0,300;0,400;0,500;0,600;1,300;1,400&family=JetBrains+Mono:wght@300;400&display=swap');

        * { margin: 0; padding: 0; box-sizing: border-box; }

        @keyframes fadeInLine { from { opacity: 0; } to { opacity: 1; } }
        @keyframes fadeUp { from { opacity: 0; transform: translateY(40px); } to { opacity: 1; transform: translateY(0); } }
        @keyframes fadeIn { from { opacity: 0; } to { opacity: 1; } }
        @keyframes pulse { 0%, 100% { opacity: 0.3; } 50% { opacity: 1; } }
        @keyframes marquee { from { transform: translateX(0); } to { transform: translateX(-50%); } }

        ::selection { background: #D4E8D4; color: #1B3A2D; }

        .nav-link {
          font-family: 'DM Sans', sans-serif;
          font-size: 13px;
          font-weight: 400;
          letter-spacing: 0.12em;
          text-transform: uppercase;
          color: #7A8A80;
          text-decoration: none;
          padding: 8px 0;
          position: relative;
          transition: color 0.3s;
          cursor: pointer;
        }
        .nav-link:hover, .nav-link.active { color: #1B3A2D; }
        .nav-link::after {
          content: '';
          position: absolute;
          bottom: 0; left: 0;
          width: 0; height: 1px;
          background: #1B3A2D;
          transition: width 0.3s;
        }
        .nav-link:hover::after, .nav-link.active::after { width: 100%; }

        .service-card {
          padding: 36px;
          border: 1px solid #E4EBE4;
          border-radius: 2px;
          background: #FFFFFF;
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
          background: linear-gradient(90deg, transparent, #2D5A3F, transparent);
          transform: scaleX(0);
          transition: transform 0.4s;
        }
        .service-card:hover {
          border-color: #C4D4C4;
          background: #F7F9F5;
          transform: translateY(-4px);
          box-shadow: 0 12px 40px rgba(27,58,45,0.06);
        }
        .service-card:hover::before { transform: scaleX(1); }

        .project-card {
          padding: 40px;
          border: 1px solid #E4EBE4;
          background: #FFFFFF;
          border-radius: 2px;
          transition: all 0.4s;
          cursor: pointer;
        }
        .project-card:hover {
          border-color: #C4D4C4;
          transform: translateY(-2px);
          box-shadow: 0 8px 30px rgba(27,58,45,0.05);
        }

        .tag {
          font-family: 'JetBrains Mono', monospace;
          font-size: 10px;
          letter-spacing: 0.06em;
          padding: 4px 10px;
          border: 1px solid #D4DDD4;
          border-radius: 1px;
          color: #7A8A80;
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
          border: 1px solid #2D5A3F;
          color: #1B3A2D;
          cursor: pointer;
          transition: all 0.3s;
          text-decoration: none;
          display: inline-block;
        }
        .cta-btn:hover {
          background: #2D5A3F;
          color: #FFFFFF;
        }
        .cta-btn.filled {
          background: #1B3A2D;
          border-color: #1B3A2D;
          color: #FFFFFF;
        }
        .cta-btn.filled:hover {
          background: #2D5A3F;
          border-color: #2D5A3F;
        }

        .marquee-track {
          display: flex;
          animation: marquee 30s linear infinite;
          width: max-content;
        }

        @media (max-width: 768px) {
          .service-grid { grid-template-columns: 1fr !important; }
          .project-grid { grid-template-columns: 1fr !important; }
          .hero-title { font-size: 42px !important; line-height: 1.1 !important; }
          .hero-sub { font-size: 16px !important; }
          .section-padding { padding: 60px 20px !important; }
          .stat-grid { grid-template-columns: 1fr 1fr !important; }
          .two-col { grid-template-columns: 1fr !important; gap: 40px !important; }
          .nav-links { display: none !important; }
        }
      `}</style>

      <nav
        style={{
          position: "fixed",
          top: 0,
          left: 0,
          right: 0,
          zIndex: 1000,
          padding: "20px 48px",
          display: "flex",
          justifyContent: "space-between",
          alignItems: "center",
          background: scrollY > 60 ? "rgba(255,255,255,0.92)" : "transparent",
          backdropFilter: scrollY > 60 ? "blur(20px)" : "none",
          borderBottom: scrollY > 60 ? "1px solid #E4EBE4" : "none",
          transition: "all 0.4s",
        }}
      >
        <div style={{ display: "flex", alignItems: "center", gap: 12 }}>
          <span
            style={{
              fontFamily: "'Instrument Serif', serif",
              fontSize: 26,
              color: "#1B3A2D",
              letterSpacing: "-0.02em",
            }}
          >
            Fangorn
          </span>
          <span
            style={{
              fontFamily: "'JetBrains Mono', monospace",
              fontSize: 9,
              color: "#2D5A3F",
              letterSpacing: "0.15em",
              textTransform: "uppercase",
              marginTop: 6,
            }}
          >
            Group
          </span>
        </div>
        <div
          className="nav-links"
          style={{ display: "flex", gap: 32, alignItems: "center" }}
        >
          {SECTIONS.map((s) => (
            <a
              key={s}
              className={`nav-link ${activeSection === s ? "active" : ""}`}
              onClick={() => {
                setActiveSection(s);
                document.getElementById(s)?.scrollIntoView({ behavior: "smooth" });
              }}
            >
              {s}
            </a>
          ))}
        </div>
      </nav>

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
          background: "#F7F9F5",
        }}
      >
        <GridLine horizontal position="20%" delay={0.2} />
        <GridLine horizontal position="50%" delay={0.5} />
        <GridLine horizontal position="80%" delay={0.8} />
        <GridLine position="15%" delay={0.3} />
        <GridLine position="45%" delay={0.6} />
        <GridLine position="75%" delay={0.9} />

        <div style={{ maxWidth: 1100, position: "relative", zIndex: 1 }}>
          <div
            style={{
              fontFamily: "'JetBrains Mono', monospace",
              fontSize: 11,
              color: "#2D5A3F",
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
              color: "#1B3A2D",
              letterSpacing: "-0.03em",
              marginBottom: 32,
              animation: "fadeUp 1s 0.4s ease forwards",
              opacity: 0,
            }}
          >
            We turn complex data
            <br />
            <span style={{ fontStyle: "italic", color: "#2D5A3F" }}>
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
              color: "#5A6A60",
              maxWidth: 620,
              marginBottom: 48,
              animation: "fadeUp 1s 0.6s ease forwards",
              opacity: 0,
            }}
          >
            Remote sensing, machine learning, custom AI agents, and a dedicated
            data team — delivering geospatial analytics, software platforms, and
            applied research for organisations that need answers from their
            data.
          </p>

          <div
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
            <a
              className="cta-btn"
              onClick={() =>
                document
                  .getElementById("contact")
                  ?.scrollIntoView({ behavior: "smooth" })
              }
            >
              Start a Conversation
            </a>
          </div>
        </div>

        <div
          style={{
            position: "absolute",
            bottom: 48,
            right: 48,
            fontFamily: "'JetBrains Mono', monospace",
            fontSize: 11,
            color: "rgba(27,58,45,0.15)",
            textAlign: "right",
            lineHeight: 2,
            animation: "fadeIn 2s 1.2s ease forwards",
            opacity: 0,
          }}
        >
          51.5074° N
          <br />
          0.1278° W
          <br />
          <span
            style={{
              animation: "pulse 3s infinite",
              display: "inline-block",
              color: "#2D5A3F",
            }}
          >
            ●
          </span>{" "}
          OPERATIONAL
        </div>
      </section>

      <div
        style={{
          borderTop: "1px solid #E4EBE4",
          borderBottom: "1px solid #E4EBE4",
          padding: "14px 0",
          overflow: "hidden",
          background: "#FFFFFF",
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
                "UAV Surveys",
                "Satellite Analysis",
                "AI Agents",
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
                    color: "#2D5A3F",
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
        style={{ padding: "120px 48px", background: "#FFFFFF" }}
      >
        <div style={{ maxWidth: 1200, margin: "0 auto" }}>
          <div style={{ marginBottom: 80 }}>
            <span
              style={{
                fontFamily: "'JetBrains Mono', monospace",
                fontSize: 11,
                color: "#2D5A3F",
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
                color: "#1B3A2D",
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
                color: "#5A6A60",
                maxWidth: 560,
                marginTop: 16,
                lineHeight: 1.7,
              }}
            >
              From drone surveys to AI agents, we deliver end-to-end data
              solutions. Every project is backed by domain expertise and a
              dedicated analyst team.
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
                    color: "#2D5A3F",
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
                    color: "#1B3A2D",
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
                    color: "#5A6A60",
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
          borderTop: "1px solid #E4EBE4",
          borderBottom: "1px solid #E4EBE4",
          padding: "48px",
          background: "#F7F9F5",
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
                  color: "#1B3A2D",
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
                  color: "#2D5A3F",
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
                  color: "#7A8A80",
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
        style={{ padding: "120px 48px", background: "#FFFFFF" }}
      >
        <div style={{ maxWidth: 1200, margin: "0 auto" }}>
          <div style={{ marginBottom: 80 }}>
            <span
              style={{
                fontFamily: "'JetBrains Mono', monospace",
                fontSize: 11,
                color: "#2D5A3F",
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
                color: "#1B3A2D",
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
                color: "#5A6A60",
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
                      color: "#7A8A80",
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
                    color: "#1B3A2D",
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
                    color: "#5A6A60",
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
        id="team"
        className="section-padding"
        style={{
          padding: "120px 48px",
          borderTop: "1px solid #E4EBE4",
          background: "#F7F9F5",
        }}
      >
        <div style={{ maxWidth: 1200, margin: "0 auto" }}>
          <div style={{ marginBottom: 60 }}>
            <span
              style={{
                fontFamily: "'JetBrains Mono', monospace",
                fontSize: 11,
                color: "#2D5A3F",
                letterSpacing: "0.2em",
                textTransform: "uppercase",
              }}
            >
              03 — The Team
            </span>
            <h2
              style={{
                fontFamily: "'Instrument Serif', serif",
                fontSize: 52,
                fontWeight: 400,
                color: "#1B3A2D",
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
                  color: "#4A5A50",
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
                  color: "#4A5A50",
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
                  color: "#4A5A50",
                  lineHeight: 1.8,
                }}
              >
                Our technical stack spans Python, TensorFlow, Neo4j, PostGIS, QGIS,
                and a range of UAV sensor platforms. We pair deep domain expertise
                with production engineering to build systems that work in the real
                world.
              </p>
            </div>

            <div
              style={{
                padding: 40,
                border: "1px solid #E4EBE4",
                background: "#FFFFFF",
              }}
            >
              <div
                style={{
                  fontFamily: "'JetBrains Mono', monospace",
                  fontSize: 10,
                  color: "#2D5A3F",
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
                  color: "#1B3A2D",
                  marginBottom: 6,
                }}
              >
                Tristan Campbell-Reynolds
              </div>
              <div
                style={{
                  fontFamily: "'DM Sans', sans-serif",
                  fontSize: 13,
                  color: "#5A6A60",
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
                      color: "#5A6A60",
                      paddingLeft: 16,
                      borderLeft: "2px solid #E8F0E4",
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
                  borderTop: "1px solid #E4EBE4",
                }}
              >
                <div
                  style={{
                    fontFamily: "'JetBrains Mono', monospace",
                    fontSize: 10,
                    color: "#2D5A3F",
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
                    color: "#1B3A2D",
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
                    color: "#5A6A60",
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
          borderTop: "1px solid #E4EBE4",
          background: "#FFFFFF",
        }}
      >
        <div style={{ maxWidth: 1200, margin: "0 auto" }}>
          <div
            className="two-col"
            style={{
              display: "grid",
              gridTemplateColumns: "1fr 1fr",
              gap: 80,
              alignItems: "center",
            }}
          >
            <div>
              <span
                style={{
                  fontFamily: "'JetBrains Mono', monospace",
                  fontSize: 11,
                  color: "#2D5A3F",
                  letterSpacing: "0.2em",
                  textTransform: "uppercase",
                }}
              >
                04 — Get in Touch
              </span>
              <h2
                style={{
                  fontFamily: "'Instrument Serif', serif",
                  fontSize: 52,
                  fontWeight: 400,
                  color: "#1B3A2D",
                  letterSpacing: "-0.02em",
                  marginTop: 16,
                  lineHeight: 1.1,
                  marginBottom: 24,
                }}
              >
                Let's talk about
                <br />
                <span style={{ fontStyle: "italic", color: "#2D5A3F" }}>
                  your data.
                </span>
              </h2>
              <p
                style={{
                  fontFamily: "'DM Sans', sans-serif",
                  fontSize: 16,
                  fontWeight: 300,
                  color: "#5A6A60",
                  lineHeight: 1.7,
                  marginBottom: 40,
                }}
              >
                Whether you need a drone survey, a custom AI agent, satellite
                analysis, or a dedicated data team — we'd like to hear from you.
              </p>
              <a className="cta-btn filled" href="mailto:tristan@fangorn.earth">
                tristan@fangorn.earth
              </a>
            </div>

            <div
              style={{
                padding: 48,
                border: "1px solid #E4EBE4",
                background: "#F7F9F5",
              }}
            >
              {[
                {
                  label: "Remote Sensing",
                  detail: "UAV LiDAR, hyperspectral, optical, satellite",
                },
                {
                  label: "AI & Automation",
                  detail: "Custom agents, RAG systems, data pipelines",
                },
                { label: "Software", detail: "Platforms, dashboards, knowledge graphs" },
                { label: "Data Operations", detail: "GIS processing, research, QA at scale" },
                { label: "Applied Research", detail: "Agriculture, carbon, environmental" },
              ].map((item, i) => (
                <div
                  key={item.label}
                  style={{
                    padding: "18px 0",
                    borderBottom: i < 4 ? "1px solid #E4EBE4" : "none",
                    display: "flex",
                    justifyContent: "space-between",
                    alignItems: "center",
                  }}
                >
                  <span
                    style={{
                      fontFamily: "'DM Sans', sans-serif",
                      fontSize: 14,
                      fontWeight: 500,
                      color: "#1B3A2D",
                    }}
                  >
                    {item.label}
                  </span>
                  <span
                    style={{
                      fontFamily: "'JetBrains Mono', monospace",
                      fontSize: 11,
                      color: "#2D5A3F",
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

      <footer
        style={{
          padding: "40px 48px",
          background: "#1B3A2D",
          display: "flex",
          justifyContent: "space-between",
          alignItems: "center",
        }}
      >
        <span
          style={{
            fontFamily: "'JetBrains Mono', monospace",
            fontSize: 11,
            color: "rgba(255,255,255,0.5)",
          }}
        >
          © 2026 Fangorn Group Limited
        </span>
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

