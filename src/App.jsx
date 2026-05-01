import { Suspense, lazy } from "react";
import { BrowserRouter, Navigate, Route, Routes } from "react-router-dom";

const FangornWebsite = lazy(() => import("./components/FangornWebsite.jsx"));
const TilthApp = lazy(() => import("./tilth/TilthApp.jsx"));

function RouteFallback({ label = "Loading…" }) {
  return <div style={{ padding: 24 }}>{label}</div>;
}

function MarketingRoute() {
  return (
    <Suspense fallback={<RouteFallback />}>
      <FangornWebsite />
    </Suspense>
  );
}

function TilthRoute() {
  return (
    <Suspense fallback={<RouteFallback label="Loading Tilth…" />}>
      <TilthApp />
    </Suspense>
  );
}

export default function App() {
  return (
    <BrowserRouter>
      <Routes>
        <Route path="/" element={<MarketingRoute />} />
        <Route path="/tilth" element={<TilthRoute />} />
        <Route path="/tilth/:section" element={<TilthRoute />} />
        <Route path="/tilth/:section/*" element={<TilthRoute />} />
        <Route path="*" element={<Navigate to="/" replace />} />
      </Routes>
    </BrowserRouter>
  );
}

