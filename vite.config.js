import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { defineConfig } from "vite";

const root = fileURLToPath(new URL(".", import.meta.url));

export default defineConfig({
  build: {
    rollupOptions: {
      input: {
        main: resolve(root, "index.html"),
        gmpeTest: resolve(root, "gmpe-test.html"),
      },
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
