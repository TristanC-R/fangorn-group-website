import { BrowserRouter, Navigate, Route, Routes } from "react-router-dom";
import FangornWebsite from "./components/FangornWebsite.jsx";
import TilthApp from "./tilth/TilthApp.jsx";

export default function App() {
  return (
    <BrowserRouter>
      <Routes>
        <Route path="/" element={<FangornWebsite />} />
        <Route path="/tilth" element={<TilthApp />} />
        <Route path="/tilth/:section" element={<TilthApp />} />
        <Route path="/tilth/:section/*" element={<TilthApp />} />
        <Route path="*" element={<Navigate to="/" replace />} />
      </Routes>
    </BrowserRouter>
  );
}

