import React from "react";
import { createRoot } from "react-dom/client";
import App from "./app/App.tsx";
import "./styles/index.css";

function mount() {
  const el = document.getElementById("root");
  if (!el) {
    document.body.innerHTML = '<div id="root" style="min-height:100vh;background:#000;color:#0f0;padding:1rem;font-family:monospace;">Root element not found.</div>';
    return;
  }
  const root = createRoot(el);
  root.render(<App />);
}

if (document.readyState === "loading") {
  document.addEventListener("DOMContentLoaded", mount);
} else {
  mount();
}