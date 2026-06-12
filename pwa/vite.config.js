import path from "path";

import { defineConfig } from "vite";
import { VitePWA } from "vite-plugin-pwa";

export default defineConfig({
  // Stamp every build into the service worker so its bytes change on each
  // deploy. The browser then detects the update, installs the fresh worker
  // (which re-boots with the latest app.wasm) and claims the tab.
  define: {
    __SW_BUILD__: JSON.stringify(String(Date.now())),
  },
  server: {
    // Two paths reach the host Rails: the service worker fetches the
    // authorized shape config during boot, and writes (the worker passes
    // every non-GET through to the network: the host is the write
    // authority). Reads are served from the in-VM Rails.
    proxy: {
      "/client_scopes": "http://localhost:3000",
      "/cells": "http://localhost:3000",
    },
  },
  optimizeDeps: {
    // PGlite carries its own wasm assets; Vite pre-bundling breaks them.
    exclude: ["@electric-sql/pglite", "@electric-sql/pglite-sync"],
  },
  build: {
    rollupOptions: {
      input: {
        main: path.resolve(__dirname, "index.html"),
        boot: path.resolve(__dirname, "boot.html"),
      },
    },
  },
  plugins: [
    VitePWA({
      srcDir: ".",
      filename: "rails.sw.js",
      strategies: "injectManifest",
      injectRegister: false,
      manifest: false,
      injectManifest: {
        injectionPoint: null,
      },
      devOptions: {
        enabled: true,
      },
    }),
  ],
});
