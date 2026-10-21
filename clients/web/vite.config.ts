import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";

export default defineConfig({
  plugins: [react()],
  server: {
    host: true,
    proxy: {
      "/api": "http://weave-server:4533",
      "/rest": "http://weave-server:4533",
    },
  },
});
