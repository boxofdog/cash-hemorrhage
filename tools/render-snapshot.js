// Renders the Overview against the DOM shim and prints a stable text snapshot,
// so a pure-structure refactor can be proved to change nothing.
// Pin "today" so the snapshot doesn't change with the calendar: the Overview
// and Settings text includes days-to-payday and the next paydays.
const __RealDate = Date;
const __FIXED_NOW = new __RealDate("2026-09-29T12:00:00").getTime();
global.Date = class extends __RealDate {
  constructor(...a) { if (a.length === 0) super(__FIXED_NOW); else super(...a); }
  static now() { return __FIXED_NOW; }
};
const P = require("../tests/paths.js");
const path = process.argv[2] || P.MAIN;
process.env.BUDGET_MAIN = path;
const H = require(P.TESTS + "/harness-for.js")(path);
const { el, BudgetDashboardView } = H;

function dump(node, depth = 0, out = []) {
  const cls = [...(node.classes || [])].sort().join(".");
  const text = (node._text || "").replace(/\s+/g, " ").trim();
  out.push(`${"  ".repeat(depth)}<${node.tag}${cls ? " ." + cls : ""}>${text ? " " + text : ""}`);
  (node.children || []).forEach((c) => dump(c, depth + 1, out));
  return out;
}

(async () => {
  const view = Object.create(BudgetDashboardView.prototype);
  view.sectionOpen = {};
  view.scrollMemory = {};
  view.activeTab = "overview";
  view.app = {};
  view.plugin = {
    settings: { savingsMode: false, bufferMode: "manual", manualBuffer: 350 },
    expiredPeriod: null,
    lastResult: null,
    promptEnterPaycheck() {},
    promptQuickBalance() {}, hasSimpleFINConnection() { return false; }, syncing: false,
    recalculate: async () => {},
    refreshAfterDataChange: async () => {},
    fixedPaymentCandidates: async () => [],
    pendingSweep: async () => null,
    openSweepModal: async () => {}
  };

  view.lastResult = JSON.parse(require("fs").readFileSync(P.FIXTURES + "/fixture-result.json", "utf8"));
  const ctx = JSON.parse(require("fs").readFileSync(P.FIXTURES + "/fixture-ctx.json", "utf8"));

  const container = el("div");
  await view.renderOverview(container, ctx);
  await new Promise((r) => setTimeout(r, 30));  // let the pendingSweep promise settle
  console.log(dump(container).join("\n"));
})();
