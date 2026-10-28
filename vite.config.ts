import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";

const HOST = process.env.PREVIEW_HOST || "localhost";

export default defineConfig({
  root: "web",
  plugins: [react()],
  server: {
    host: "0.0.0.0",
    port: Number(process.env.WEB_PORT || 5173),
    strictPort: false,
    allowedHosts: [HOST, ".style.dev", ".local"],
    proxy: {
      "/api": {
        target: `http://127.0.0.1:${process.env.API_PORT || 8788}`,
        changeOrigin: true,
        ws: true,
      },
    },
  },
  build: {
    outDir: "../dist/web",
    emptyOutDir: true,
  },
});
