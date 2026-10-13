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
    // Dev only: the Colony server handles /api; in production it serves this app itself.
    proxy: { "/api": { target: `http://127.0.0.1:${serverPort}`, changeOrigin: true } },
    fs: { allow: [path.resolve(import.meta.dirname, "..")], deny: [".env", ".env.*", "*.{crt,pem}", "**/.git/**", "**/*.local", "**/data/**"] },
  },
});
