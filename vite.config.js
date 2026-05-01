import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";

export default defineConfig({
  plugins: [react()],
  build: {
    // Tilth workspaces are intentionally loaded with the app shell for reliable
    // navigation. Three.js remains isolated so map rendering code is still
    // separated from the application bundle.
    chunkSizeWarningLimit: 800,
    rollupOptions: {
      output: {
        manualChunks(id) {
          if (id.includes("node_modules/three")) return "map-vendor-three";
          return undefined;
        },
      },
    },
  },
  server: {
    port: 5173,
    strictPort: true,
    host: true,
    watch: {
      ignored: [
        "**/node_modules/**",
        "**/dist/**",
        "**/tilth-api/document-worker/.venv/**",
        "**/tilth-api/document-worker/__pycache__/**",
      ],
    },
    proxy: {
      "/tilth-api": {
        target: "http://127.0.0.1:3847",
        changeOrigin: true,
        rewrite: (path) => path.replace(/^\/tilth-api/, ""),
      },
    },
  },
});

