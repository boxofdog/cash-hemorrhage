// Runs every tests/test-*.js (or the ones named) and totals them.
//
//   node tests/run-tests.js              all of them
//   node tests/run-tests.js loans label  just test-loans.js and test-label-modal.js
//
// Each test file prints PASS/FAIL lines and ends with "N passed, M failed".
// Browser checks (Playwright + Chromium) run when a browser can be launched;
// otherwise they're skipped and the summary says so.
const { spawn } = require("child_process");
const fs = require("fs");
const path = require("path");
const os = require("os");

const DIR = __dirname;
const BROWSER_ONLY = new Set(["test-charts-browser.js"]);

async function browserWorks() {
  try {
    const { chromium } = require("playwright");
    const b = await Promise.race([chromium.launch(), new Promise((_, no) => setTimeout(() => no(new Error("timeout")), 20000))]);
    await b.close();
    return true;
  } catch (e) {
    return false;
  }
}

function run(file, env) {
  return new Promise((resolve) => {
    const started = Date.now();
    const child = spawn(process.execPath, [path.join(DIR, file)], { cwd: DIR, env });
    let out = "";
    child.stdout.on("data", (d) => (out += d));
    child.stderr.on("data", (d) => (out += d));
    const timer = setTimeout(() => child.kill("SIGKILL"), 5 * 60 * 1000);
    child.on("close", (code) => {
      clearTimeout(timer);
      // The last summary line (a test may log after it).
      const all = [...out.matchAll(/^(\d+) passed, (\d+) failed\s*$/gm)];
      const m = all.length ? all[all.length - 1] : null;
      resolve({ file, code, out, passed: m ? +m[1] : 0, failed: m ? +m[2] : 0, summary: !!m, ms: Date.now() - started });
    });
  });
}

(async () => {
  const want = process.argv.slice(2);
  let files = fs.readdirSync(DIR).filter((f) => /^test-.*\.js$/.test(f)).sort();
  if (want.length) files = files.filter((f) => want.some((w) => f === w || f.includes(w)));
  if (!files.length) {
    console.log("No test files match.");
    process.exit(1);
  }
  const hasBrowser = !process.env.BT_NO_BROWSER && (await browserWorks());
  const env = Object.assign({}, process.env, hasBrowser ? {} : { BT_NO_BROWSER: "1" });
  const skipped = hasBrowser ? [] : files.filter((f) => BROWSER_ONLY.has(f));
  files = files.filter((f) => !skipped.includes(f));

  const results = [];
  const queue = files.slice();
  const workers = Math.max(1, Math.min(4, os.cpus().length));
  await Promise.all(Array.from({ length: workers }, async () => {
    while (queue.length) {
      const r = await run(queue.shift(), env);
      results.push(r);
      const ok = r.code === 0 && r.summary && r.failed === 0;
      console.log(`${ok ? "ok  " : "FAIL"}  ${r.file.padEnd(28)} ${r.summary ? `${r.passed} passed, ${r.failed} failed` : "crashed"}  (${(r.ms / 1000).toFixed(1)}s)`);
    }
  }));

  const bad = results.filter((r) => !(r.code === 0 && r.summary && r.failed === 0));
  bad.forEach((r) => {
    console.log(`\n==== ${r.file} ====`);
    const lines = r.out.split("\n");
    const fails = lines.filter((l) => /^\s+FAIL\s/.test(l));
    console.log((fails.length ? fails : lines.slice(-25)).join("\n"));
  });
  const passed = results.reduce((s, r) => s + r.passed, 0);
  const failed = results.reduce((s, r) => s + r.failed, 0);
  console.log(`\n${passed} passed, ${failed} failed across ${results.length} files` +
    (bad.length ? ` — ${bad.length} file(s) failing` : "") +
    (hasBrowser ? "" : ` — no browser here, so browser checks were skipped${skipped.length ? ` (and ${skipped.join(", ")})` : ""}`));
  process.exit(bad.length ? 1 : 0);
})();
