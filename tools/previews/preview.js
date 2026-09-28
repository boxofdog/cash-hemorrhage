// Renders the dashboard through the DOM shim, serializes it to real HTML with
// the plugin's stylesheet and Obsidian's theme variables, and screenshots it.
// Looking at the thing is the only way to judge whether it looks right.
const P = require("../../tests/paths.js");
global.document = { body: { classList: { contains: () => false } } };
global.requestAnimationFrame = (fn) => setTimeout(fn, 0);
const fs = require("fs");
const path = require("path");

const PLUGIN = P.ROOT;
const OUT = process.argv[2] || P.OUT + "/shots";
fs.mkdirSync(OUT, { recursive: true });

const H = require(P.TESTS + "/harness.js");
const HF = require(P.TESTS + "/harness-for.js")(PLUGIN + "/main.js");
const { el } = H;

const RESULT = JSON.parse(fs.readFileSync(P.FIXTURES + "/fixture-result.json", "utf8"));
const CTX = JSON.parse(fs.readFileSync(P.FIXTURES + "/fixture-ctx.json", "utf8"));
CTX.ownership = H.completeOwnership({
  fixedExpenses: [], installmentDebts: CTX.installmentDebts, revolvingDebts: CTX.revolvingDebts,
  goals: CTX.savingsGoals, categoryMeta: CTX.categoryMetaList, rules: CTX.rules
});

const VOID = new Set(["input", "br", "hr", "img"]);
const esc = (s) => String(s).replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
const CAMEL = (k) => k.replace(/[A-Z]/g, (m) => "-" + m.toLowerCase());

function html(n) {
  const cls = [...(n.classes || [])].join(" ");
  const style = Object.entries(n.style || {})
    .filter(([, v]) => v !== "" && v != null)
    .map(([k, v]) => `${CAMEL(k)}:${v}`)
    .join(";");
  const attrs = Object.entries(n.attrs || {})
    .filter(([k]) => k !== "style")
    .map(([k, v]) => ` ${k}="${esc(v)}"`)
    .join("");
  const open =
    `<${n.tag}${cls ? ` class="${esc(cls)}"` : ""}${style ? ` style="${esc(style)}"` : ""}${attrs}` +
    (n.tag === "details" && n.open ? " open" : "") +
    ">";
  if (VOID.has(n.tag)) return open;
  const inner = n.innerHTML != null ? n.innerHTML : "";
  const body = esc(n._text || "") + inner + (n.children || []).map(html).join("");
  return open + body + `</${n.tag}>`;
}

// Obsidian's theme variables, both schemes, so the plugin renders the way it
// does in the app rather than as unstyled boxes.
const THEME = `
:root, .theme-light {
  --background-primary: #ffffff;
  --background-primary-alt: #f5f6f8;
  --background-secondary: #f2f3f5;
  --background-modifier-border: #dcddde;
  --background-modifier-hover: rgba(0,0,0,0.05);
  --background-modifier-error: #e5534b;
  --text-normal: #1f2430;
  --text-muted: #6b7280;
  --text-faint: #9aa0aa;
  --text-accent: #7b6cd9;
  --text-error: #c0392b;
  --text-success: #2f9e44;
  --text-warning: #c47f16;
  --radius-s: 6px; --radius-m: 10px;
  --font-ui-medium: 15px;
  --font-monospace: ui-monospace, SFMono-Regular, Menlo, monospace;
  /* Obsidian's own default accent palette, light scheme. */
  --color-red: #e93147; --color-orange: #ec7500; --color-yellow: #e0ac00;
  --color-green: #08b94e; --color-cyan: #00bfbc; --color-blue: #086ddd;
  --color-purple: #7852ee; --color-pink: #d53984;
}
.theme-dark {
  --background-primary: #1e1e1e;
  --background-primary-alt: #262626;
  --background-secondary: #262626;
  --background-modifier-border: #3b3b3b;
  --background-modifier-hover: rgba(255,255,255,0.075);
  --background-modifier-error: #b34a44;
  --text-normal: #dcddde;
  --text-muted: #9a9b9e;
  --text-faint: #6c6e72;
  --text-accent: #a99bf5;
  --text-error: #ff6b6b;
  --text-success: #4ac26b;
  --text-warning: #e0a83a;
  /* Obsidian brightens these in dark mode; using its real values is the whole
     point of the change, so the preview has to use them too. */
  --color-red: #fb464c; --color-orange: #e9973f; --color-yellow: #e0de71;
  --color-green: #44cf6e; --color-cyan: #53dfdd; --color-blue: #027aff;
  --color-purple: #a882ff; --color-pink: #fa99cd;
}
body {
  margin: 0; padding: 24px;
  background: var(--background-primary);
  color: var(--text-normal);
  font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif;
  font-size: 15px; line-height: 1.5;
}
h2,h3,h4,h5 { color: var(--text-normal); }
button { font-family: inherit; font-size: inherit; cursor: pointer; }
select { font-family: inherit; }
ul { padding-left: 0; }
.mod-cta { background: var(--text-accent); color: #fff; border-color: var(--text-accent); }
`;

function makeView(state = {}) {
  const v = Object.create(HF.BudgetDashboardView.prototype);
  Object.assign(
    v,
    {
      sectionOpen: {}, scrollMemory: {}, activeTab: "overview",
      pieRange: "all", expandedSpendCategory: null, expandedIncomeCategory: null,
      activePieTab: "spending", app: {}, lastResult: RESULT,
      plugin: {
        settings: { savingsMode: true, bufferMode: "auto", manualBuffer: 350 },
        expiredPeriod: null, lastResult: null,
        promptEnterPaycheck() {}, promptQuickBalance() {}, hasSimpleFINConnection() { return false; }, syncing: false,
        recalculate: async () => {}, refreshAfterDataChange: async () => {},
        fixedPaymentCandidates: async () => [], pendingSweep: async () => null, openSweepModal: async () => {}
      }
    },
    state
  );
  return v;
}

// Open every collapsible so nothing hides from the screenshot.
function openAll(n) {
  if (n.tag === "details") n.open = true;
  (n.children || []).forEach(openAll);
}

(async () => {
  const css = fs.readFileSync(PLUGIN + "/styles.css", "utf8");
  const shots = [];

  // A result where part of the allowance has been spent, so Spendable carries
  // its "of $X allowance" subtitle — the case the figures row has to stay
  // aligned through.
  const SPENT = Object.assign({}, RESULT, {
    bufferSpent: 128.4, allocatedBuffer: 350, bufferRemaining: 221.6
  });
  // The strategy switch lives in the action bar now, which only renderView
  // builds — rendering renderOverview alone would miss the thing under review.
  const fullView = async (state) => {
    const v = makeView(state);
    v.contentEl = el("div");
    v.loadRenderContext = async () => CTX;
    await v.renderView();
    await new Promise((r) => setTimeout(r, 40));
    openAll(v.contentEl);
    return html(v.contentEl);
  };
  shots.push({ name: "full-savings", body: await fullView({}) });
  shots.push({
    name: "full-debt",
    body: await fullView({
      lastResult: Object.assign({}, RESULT, { savingsMode: false }),
      plugin: Object.assign({}, makeView().plugin, {
        settings: { savingsMode: false, bufferMode: "auto", manualBuffer: 350 }
      })
    })
  });

  for (const variant of [
    { name: "overview", state: {}, open: true },
    { name: "debt-mode", state: {
        lastResult: Object.assign({}, RESULT, { savingsMode: false,
          payoffBreakdown: [{ target: "Capital One Card", amount: 85, reason: "highest APR first" }] }),
        plugin: Object.assign({}, makeView().plugin, { settings: { savingsMode: false, bufferMode: "auto", manualBuffer: 350 } })
      }, open: true },
    { name: "hero-subtitle", state: { lastResult: SPENT }, open: true },
    { name: "overview-income", state: { activePieTab: "income", expandedIncomeCategory: "Paycheck" }, open: true }
  ]) {
    const v = makeView(variant.state);
    const root = el("div");
    await v.renderOverview(root, CTX);
    await new Promise((r) => setTimeout(r, 40));
    if (variant.open) openAll(root);
    root.classes.add("budget-dashboard");
    shots.push({ name: variant.name, body: html(root) });
  }

  // The action bar and tabs live in renderView, not renderOverview, so seeing
  // the header at all means rendering the whole view. loadRenderContext is
  // stubbed because it reads the vault; everything else runs for real.
  for (const [name, savingsMode] of [["full-savings", true], ["full-debt", false]]) {
    const v = makeView({ plugin: null });
    v.plugin = Object.assign({}, makeView().plugin, {
      settings: { savingsMode, bufferMode: "auto", manualBuffer: 350 },
      promptImportCSV() {}, promptMarkFixedPaid() {}, openSettings() {}
    });
    if (!savingsMode) v.lastResult = Object.assign({}, RESULT, { savingsMode: false,
      payoffBreakdown: [{ target: "Capital One Card", amount: 85, reason: "highest APR first" }] });
    v.contentEl = el("div");
    v.loadRenderContext = async () => CTX;
    await v.renderView();
    await new Promise((r) => setTimeout(r, 40));
    openAll(v.contentEl);
    shots.push({ name, body: html(v.contentEl) });
  }

  const { chromium } = require("playwright");
  const browser = await chromium.launch();
  for (const scheme of ["light", "dark"]) {
    for (const s of shots) {
      const page = await browser.newPage({ viewport: { width: 1180, height: 1200 }, deviceScaleFactor: 2 });
      await page.setContent(
        `<!doctype html><html><head><meta charset="utf-8"><style>${THEME}\n${css}</style></head>` +
          `<body class="theme-${scheme}">${s.body}</body></html>`
      );
      await page.waitForTimeout(150);
      const file = path.join(OUT, `${s.name}-${scheme}.png`);
      await page.screenshot({ path: file, fullPage: true });
      console.log("wrote", file);
      await page.close();
    }
  }
  // One narrow shot to check the mobile story.
  const page = await browser.newPage({ viewport: { width: 400, height: 1400 }, deviceScaleFactor: 2 });
  const mobileBody = (shots.find((s) => s.name === "full-savings") || shots[0]).body;
  await page.setContent(
    `<!doctype html><html><head><meta charset="utf-8"><style>${THEME}\n${css}</style></head>` +
      `<body class="theme-dark">${mobileBody}</body></html>`
  );
  await page.waitForTimeout(150);
  await page.screenshot({ path: path.join(OUT, "overview-mobile.png"), fullPage: true });
  console.log("wrote", path.join(OUT, "overview-mobile.png"));
  await browser.close();
})();
