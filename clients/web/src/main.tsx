import React from "react";
import ReactDOM from "react-dom/client";
import App from "./App";
import { JamGuestEntry } from "./JamGuestEntry";
import "./index.css";

// No router in this app (tabs are plain state in App.tsx) — a jam invite
// link is the one URL this app needs to handle, so it gets one manual check
// here instead of pulling in a routing dependency for it.
const jamMatch = location.pathname.match(/^\/jam\/([A-Za-z0-9]+)/);

ReactDOM.createRoot(document.getElementById("root")!).render(
  <React.StrictMode>{jamMatch ? <JamGuestEntry code={jamMatch[1]} /> : <App />}</React.StrictMode>,
);

// Required (on some browsers) for the "Install app" prompt — see public/sw.js.
if ("serviceWorker" in navigator) {
  window.addEventListener("load", () => {
    navigator.serviceWorker.register("/sw.js").catch(() => {});
  });
}
