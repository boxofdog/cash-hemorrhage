// Renders the dashboard through the DOM shim, serializes it to real HTML with
// the plugin's stylesheet and Obsidian's theme variables, and screenshots it.
// Looking at the thing is the only way to judge whether it looks right.
const P = require("../../tests/paths.js");
global.document = { body: { classList: { contains: () => false } } };
global.requestAnimationFrame = (fn) => setTimeout(fn, 0);
const fs = require("fs");
const path = require("path");

const PLUGIN = P.ROOT;
const OUT = process.argv[2] || P.OUT + "/shots-fund";
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


const T = H.todayLocal();
const SAV = { id: "Personal Savings", type: "savings", institution: "Cal Coast — Personal Savings", current_balance: 640.12, simplefin_id: "ACT-sav", balance_as_of: T };
const CHK = { id: "Main Checking", type: "checking", institution: "Credit Union", current_balance: 900, simplefin_id: "ACT-chk" };
const fund = (placement) => ({ id: "fund-1", kind: "capped", name: "Oopsie Fund", target_amount: 1000, account_id: "Personal Savings", placement });
const ASK = { id: "fund-1", target: "Oopsie Fund", amount: 107.96, reason: "64% full, so it takes 36% of what's left — eases off near its $1000.00 cap", fund: true };

function makeView(result, savingsMode) {
  const v = Object.create(HF.BudgetDashboardView.prototype);
  Object.assign(v, {
    sectionOpen: {}, scrollMemory: {}, activeTab: "overview",
    pieRange: "all", expandedSpendCategory: null, expandedIncomeCategory: null,
    activePieTab: "spending", app: {}, lastResult: result,
    plugin: {
      settings: { savingsMode, bufferMode: "auto", manualBuffer: 350 },
      expiredPeriod: null, lastResult: null,
      promptEnterPaycheck() {}, promptQuickBalance() {}, hasSimpleFINConnection() { return true; }, syncing: false,
      promptImportCSV() {}, promptMarkFixedPaid() {}, openSettings() {},
      recalculate: async () => {}, refreshAfterDataChange: async () => {},
      fixedPaymentCandidates: async () => [], pendingSweep: async () => null, openSweepModal: async () => {}
    }
  });
  return v;
}
function openAll(n) { if (n.tag === "details") n.open = false; (n.children || []).forEach(openAll); }

async function renderFull(placement, { dragging = false, savingsMode = false } = {}) {
  // A period with a surplus, so the fund has something to ask for.
  const result = Object.assign({}, RESULT, {
    savingsMode, deficit: false, obligationShortfall: 0, availableForDebt: 300,
    savingsBreakdown: [ASK], recommendedSavings: 107.96, freeCash: 0,
    payoffBreakdown: savingsMode ? [] : [{ target: "Capital One Card", amount: 192.04, reason: "highest APR (29.99%)" }],
    recommendedExtraPayoff: savingsMode ? 0 : 192.04
  });
  const ctx = JSON.parse(JSON.stringify(CTX));
  ctx.accounts = [CHK, SAV].concat(ctx.accounts);
  ctx.savingsGoals = ctx.savingsGoals.concat([fund(placement)]);
  ctx.ownership = CTX.ownership;
  const v = makeView(result, savingsMode);
  v.contentEl = el("div");
  v.loadRenderContext = async () => ctx;
  await v.renderView();
  await new Promise((r) => setTimeout(r, 40));
  if (dragging) {
    const find = (n, p, o = []) => { if (p(n)) o.push(n); (n.children || []).forEach((c) => find(c, p, o)); return o; };
    const grip = find(v.contentEl, (n) => n.classes && n.classes.has("budget-fund-grip"))[0];
    grip.dispatchEvent({ type: "dragstart", dataTransfer: { setData() {}, setDragImage() {} } });
    const hero = find(v.contentEl, (n) => n.classes && n.classes.has("budget-fund-drop-hero"))[0];
    hero.dispatchEvent({ type: "dragover", dataTransfer: {}, preventDefault() {} });
  }
  return html(v.contentEl);
}

(async () => {
  const css = fs.readFileSync(PLUGIN + "/styles.css", "utf8");
  const shots = [];
  for (const p of ["hero", "cards", "goals"]) shots.push({ name: `fund-${p}`, body: await renderFull(p) });
  shots.push({ name: "fund-dragging", body: await renderFull("cards", { dragging: true }) });
  shots.push({ name: "fund-savings-focus", body: await renderFull("goals", { savingsMode: true }) });

  // The modal, rendered in the browser against Obsidian's real setting DOM
  // (borrowed from preview-sync.js), running the plugin's own class source.
  const syncSrc = fs.readFileSync(P.PREVIEWS + "/preview-sync.js", "utf8");
  const OBS_CSS = /const OBSIDIAN_CSS = `([\s\S]*?)`;/.exec(syncSrc)[1];
  const OBS_JS = /const OBSIDIAN_JS = `([\s\S]*?)`;/.exec(syncSrc)[1];
  const fns = ["formatMoneyInput", "parseMoneyInput", "bindMoneyInput", "fieldNote", "fieldNoteHost", "requireMoney", "round2", "fundPlacement"]
    .map((n) => H[n].toString()).join("\n");
  const modalBody = `<div class="modal" id="modal"></div><script>${OBS_JS}
${fns}
const FUND_PLACEMENTS = ${JSON.stringify(H.FUND_PLACEMENTS)};
const FUND_PLACEMENT_LABELS = ${JSON.stringify(H.FUND_PLACEMENT_LABELS)};
${H.CappedFundModal.toString()}
const m = new CappedFundModal({}, { choices: [
  { value: "local:Personal Savings", label: "Cal Coast — Personal Savings · $640.12" },
  { value: "sf:ACT-hol", label: "Cal Coast — Holiday Club · $55.00 — adds it to your accounts" }
], connected: true }, () => {});
m.onOpen();
document.querySelector("select").value = "local:Personal Savings";
document.querySelectorAll("input")[1].value = "1,000.00";
</script>`;
  shots.push({ name: "fund-modal", body: modalBody, width: 640, extraCss: OBS_CSS });

  const { chromium } = require("playwright");
  const browser = await chromium.launch();
  const shoot = async (s, scheme, width, file, mobile = false) => {
    const page = await browser.newPage({ viewport: { width, height: 900 }, deviceScaleFactor: 2 });
    const errors = [];
    page.on("pageerror", (e) => errors.push(e.message));
    await page.setContent(`<!doctype html><html><head><meta charset="utf-8"><style>${THEME}\n${css}\n${s.extraCss || ""}</style></head>` +
      `<body class="theme-${scheme}${mobile ? " is-mobile" : ""}">${s.body}</body></html>`);
    await page.waitForTimeout(120);
    await page.screenshot({ path: path.join(OUT, file), fullPage: true });
    const overflow = await page.evaluate(() => document.documentElement.scrollWidth > window.innerWidth);
    console.log("wrote", file, errors.length ? `ERRORS ${JSON.stringify(errors)}` : "", overflow ? "OVERFLOW" : "");
    await page.close();
  };
  for (const s of shots) {
    for (const scheme of ["light", "dark"]) await shoot(s, scheme, s.width || 1180, `${s.name}-${scheme}.png`);
  }
  // Element shots for the summary: each placement in its surroundings.
  for (const [name, sel] of [["fund-hero", ".budget-hero"], ["fund-cards", ".budget-fund-card"], ["fund-goals", ".budget-goals-card"]]) {
    const page = await browser.newPage({ viewport: { width: 1100, height: 900 }, deviceScaleFactor: 2 });
    await page.setContent(`<!doctype html><html><head><meta charset="utf-8"><style>${THEME}\n${css}</style></head><body class="theme-light">${shots.find((x) => x.name === name).body}</body></html>`);
    await page.waitForTimeout(120);
    await page.locator(sel).first().screenshot({ path: path.join(OUT, `el-${name}.png`) });
    await page.close();
  }

  // Rendered again as the phone sees it: no grip, no drop targets.
  global.document.body.classList.contains = (c) => c === "is-mobile";
  for (const p of ["hero", "cards", "goals"]) await shoot({ body: await renderFull(p) }, "dark", 400, `fund-${p}-mobile.png`, true);
  global.document.body.classList.contains = () => false;
  await shoot(shots.find((s) => s.name === "fund-modal"), "dark", 400, "fund-modal-mobile.png", true);
  await browser.close();
})();
