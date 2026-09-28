// Loads any copy of main.js through the same stubs the main harness uses — the
// current file, or a frozen older one in baselines/ for a differential test.
module.exports = function (mainPath) {
  const fs = require("fs");
  const Module = require("module");
  const path = require("path");
  const base = fs.readFileSync(path.join(__dirname, "harness.js"), "utf8");
  const patched = base
    .split("process.env.BT_HARNESS_MAIN || P.MAIN")
    .join(JSON.stringify(path.resolve(mainPath)))
    .replace(/"BudgetSettingTab"/, '"BudgetSettingTab", "BudgetDashboardView"');
  const m = new Module("harness-" + mainPath, null);
  m.filename = path.join(__dirname, "harness-dyn.js");
  m.paths = Module._nodeModulePaths(__dirname);
  m._compile(patched, m.filename);
  return m.exports;
};
