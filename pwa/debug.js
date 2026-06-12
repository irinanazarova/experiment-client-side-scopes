// Boot diagnostics: the service worker swallows boot failures (a rejected
// install just leaves the worker stuck "installing"), so this page runs the
// identical stack inline and prints every step, Ruby's stdout/stderr, and the
// failure backtrace if boot dies.
import {
  initRailsVM,
  registerPGliteWasmInterface,
} from "./vendor/wasmify-rails/index.js";
import { setupPGliteDatabase } from "./database.js";

const el = document.getElementById("log");
const log = (m) => {
  el.textContent += m + "\n";
};
const progress = { updateStep: log, notify: log };

const REQUEST = String.raw`
  request = Rack::MockRequest.env_for("http://localhost:5173/sheets/1/aggregates")
  status, headers, body_iter = Rails.application.call(request)
  body = +""
  body_iter.each { |part| body << part }
  "#{status} #{body}"
`;

try {
  log("• PGlite + Electric sync…");
  const db = await setupPGliteDatabase(progress);
  registerPGliteWasmInterface(self, db);
  log("• Booting Rails VM (debug mode)…");
  const t0 = performance.now();
  const vm = await initRailsVM("/app.wasm", {
    database: { adapter: "pglite" },
    async: true,
    debug: true,
    env: ["PATH=/usr/local/bin:/usr/bin:/bin", "HOME=/rails"],
    progressCallback: log,
    outputCallback: log,
  });
  log(`✓ Rails initialized in ${((performance.now() - t0) / 1000).toFixed(1)}s`);

  log("• GET /sheets/1/aggregates through Rack…");
  const res = await vm.evalAsync(REQUEST);
  log("✓ Response: " + res.toString());
  document.title = "diagnostics: done";
} catch (e) {
  log("✗ BOOT FAILED: " + e.message);
  if (e.stack) log(e.stack);
  document.title = "diagnostics: failed";
}
