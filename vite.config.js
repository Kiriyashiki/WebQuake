import { defineConfig } from "vite";

export default defineConfig({
  build: {
    rollupOptions: {
      output: {
        manualChunks(id) {
          if (id.includes("maplibre-gl")) {
            return "maplibre-gl";
          }
        },
      },
    },
  },
});
