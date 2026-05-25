import { defineConfig } from "vite";

export default defineConfig({
  build: {
    rollupOptions: {
      output: {
        manualChunks: {
          'maplibre-gl': ["maplibre-gl"]
        },
      },
    },
  },
});
