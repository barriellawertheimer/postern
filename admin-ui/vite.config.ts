import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";

// SPA bundle for /admin/. Output goes to admin-ui/dist; the root build
// pipeline copies it to dist/admin-ui where Fastify serves it from.
export default defineConfig({
  base: "/admin/",
  plugins: [react()],
  build: {
    outDir: "dist",
    emptyOutDir: true,
    sourcemap: true,
  },
  server: {
    port: 5173,
    strictPort: true,
    // Dev: forward /admin/api to the Fastify backend on :8787 so the cookie
    // (Path=/admin) flows correctly without needing a separate origin.
    proxy: {
      "/admin/api": {
        target: "http://127.0.0.1:8787",
        changeOrigin: false,
      },
    },
  },
});
