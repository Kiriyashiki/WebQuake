import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { readFileSync, readdirSync, rmSync } from "node:fs";
import { defineConfig } from "vite";

const root = fileURLToPath(new URL(".", import.meta.url));
const distDir = resolve(root, "dist");
const packageJson = JSON.parse(readFileSync(resolve(root, "package.json"), "utf8"));

/**
 * Exclude content not reachable in the desktop version.
 */
function removeAboutPageAssets() {
  rmSync(resolve(distDir, "about.html"), { force: true });
  rmSync(resolve(distDir, "gmpe-test.html"), { force: true });
  rmSync(resolve(distDir, "demo"), { recursive: true, force: true });

  const assetsDir = resolve(distDir, "assets");
  try {
    for (const file of readdirSync(assetsDir)) {
      if (file.startsWith("about-")) {
        rmSync(resolve(assetsDir, file), { force: true });
      }
    }
  } catch {
    // The assets directory may not exist if nothing was emitted.
  }
}

export default defineConfig(({ mode }) => {
  const isDesktopBuild = mode === "desktop";

  const input = {
    main: resolve(root, "index.html")
  };

  if (!isDesktopBuild) {
    input.about = resolve(root, "about.html");
    input.gmpeTest = resolve(root, "gmpe-test.html");
  }

  return {
    define: {
      __APP_VERSION__: JSON.stringify(packageJson.version),
    },
    plugins: isDesktopBuild
      ? [
          {
            name: "exclude-pages-from-desktop-build",
            apply: "build",
            closeBundle() {
              removeAboutPageAssets();
            },
          },
        ]
      : [],
    build: {
      rollupOptions: {
        input,
        output: {
          manualChunks(id) {
            if (id.includes("maplibre-gl")) {
              return "maplibre-gl";
            }
          },
        },
      },
    },
  };
});
