// Every path the tests and tools use, relative to the repo root. Set BT_MAIN to
// point the harness at a different main.js (a branch copy, a baseline).
const path = require("path");
const ROOT = path.resolve(__dirname, "..");
module.exports = {
  ROOT,
  MAIN: process.env.BT_MAIN ? path.resolve(process.env.BT_MAIN) : path.join(ROOT, "main.js"),
  STYLES: path.join(ROOT, "styles.css"),
  TESTS: __dirname,
  FIXTURES: path.join(__dirname, "fixtures"),
  BASELINES: path.join(__dirname, "baselines"),
  TOOLS: path.join(ROOT, "tools"),
  PREVIEWS: path.join(ROOT, "tools", "previews"),
  // Screenshots and other throwaway output. Git-ignored.
  OUT: path.join(ROOT, ".preview"),
  // Set by run-tests.js when there's no Playwright/Chromium to drive.
  noBrowser: () => !!process.env.BT_NO_BROWSER
};
