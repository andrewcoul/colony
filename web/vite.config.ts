import path from "node:path";
import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import tailwindcss from "@tailwindcss/vite";

const serverPort = Number(process.env.COLONY_PORT ?? 8787);

export default defineConfig({
  plugins: [react(), tailwindcss()],
  resolve: {
    alias: { "@shared": path.resolve(import.meta.dirname, "../server/src/shared") },
  },
  server: {
    port: Number(process.env.COLONY_WEB_PORT ?? 5180),
    strictPort: true,
    // Lets `tailscale serve` point at the dev server too (https://<machine>.<tailnet>.ts.net).
    allowedHosts: [".ts.net"],
    // Dev only: the Colony server handles /api; in production it serves this app itself.
    // ws: the Screen tab streams the desktop over a WebSocket under /api.
    proxy: { "/api": { target: `http://127.0.0.1:${serverPort}`, changeOrigin: true, ws: true } },
    fs: { allow: [path.resolve(import.meta.dirname, "..")], deny: [".env", ".env.*", "*.{crt,pem}", "**/.git/**", "**/*.local", "**/data/**"] },
  },
});
