import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";

export default defineConfig({
  plugins: [react()],
  server: {
    host: true,
    proxy: {
      // ws: true so the /api/playback/ws WebSocket upgrade gets proxied too
      // — the plain string form only forwards regular HTTP requests.
      "/api": { target: "http://weave-server:4533", ws: true },
      "/rest": "http://weave-server:4533",
    },
  },
});
