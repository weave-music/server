import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";

export default defineConfig({
  plugins: [react()],
  server: {
    host: true,
    // Vite's DNS-rebinding protection blocks any Host header not in this
    // list — needed once this dev server is reachable via the Cloudflare
    // tunnel under music-dev.rileyboughner.dev, not just localhost/LAN IP.
    allowedHosts: ["music-dev.rileyboughner.dev"],
    proxy: {
      // ws: true so the /api/playback/ws WebSocket upgrade gets proxied too
      // — the plain string form only forwards regular HTTP requests.
      "/api": { target: "http://weave-server:4533", ws: true },
      "/rest": "http://weave-server:4533",
    },
  },
});
