import { defineConfig } from "vite";
import { resolve } from "node:path";

const API_PORT = Number(process.env.TTY_API_PORT ?? 3001);
const CLIENT_PORT = Number(process.env.TTY_CLIENT_PORT ?? 5173);

export default defineConfig({
  root: resolve(import.meta.dirname, "src"),
  publicDir: resolve(import.meta.dirname, "assets"),
  server: {
    port: CLIENT_PORT,
    strictPort: true,
    proxy: {
      "/world": `http://localhost:${API_PORT}`,
      "/health": `http://localhost:${API_PORT}`,
      "/procs": `http://localhost:${API_PORT}`,
    },
  },
  resolve: {
    alias: {
      "@shared": resolve(import.meta.dirname, "shared"),
    },
  },
  build: {
    outDir: resolve(import.meta.dirname, "dist"),
    emptyOutDir: true,
    target: "es2022",
  },
});
