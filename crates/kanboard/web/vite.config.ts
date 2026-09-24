import { defineConfig } from "vite";
import solid from "vite-plugin-solid";

// The bundle is embedded in the Rust binary (rust-embed) and served from `/`,
// so asset URLs must be relative to the app root and hashed for caching.
export default defineConfig({
  plugins: [solid()],
  base: "/",
  build: {
    outDir: "dist",
    emptyOutDir: true,
    target: "es2022",
    assetsDir: "assets",
    sourcemap: false,
  },
  server: { port: 5173 },
});
