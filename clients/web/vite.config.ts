import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";

// Production is served by nginx from a static build (see
// docker/Dockerfile.web), not by Vite at all — this host/proxy config is
// only for local dev (`npm run dev`) and ad-hoc `npm run preview` checks,
// which is why `preview` still gets the same setup as `server` below.
const hostConfig = {
  host: true,
  // Vite's DNS-rebinding protection blocks any Host header not in this
  // list — needed once this is reachable via the Cloudflare tunnel under
  // weave.rileyboughner.dev, not just localhost/LAN IP.
  allowedHosts: ["weave.rileyboughner.dev"],
  proxy: {
    // ws: true so the /api/playback/ws and /api/jam/:id/ws WebSocket
    // upgrades get proxied too — the plain string form only forwards
    // regular HTTP requests.
    "/api": { target: "http://weave-server:4533", ws: true },
    "/rest": "http://weave-server:4533",
  },
};

export default defineConfig({
  plugins: [react()],
  server: hostConfig,
  // vite preview defaults to port 4173; pin it to 5173 to match the
  // container's existing port mapping instead of changing that everywhere.
  preview: { ...hostConfig, port: 5173 },
});
