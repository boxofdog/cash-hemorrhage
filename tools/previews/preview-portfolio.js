// Renders the dashboard through the DOM shim, serializes it to real HTML with
// the plugin's stylesheet and Obsidian's theme variables, and screenshots it.
// Looking at the thing is the only way to judge whether it looks right.
const P = require("../../tests/paths.js");
global.document = { body: { classList: { contains: () => false } } };
global.requestAnimationFrame = (fn) => setTimeout(fn, 0);
const fs = require("fs");
const path = require("path");

const PLUGIN = P.ROOT;
const OUT = process.argv[2] || P.OUT + "/shots-pf";
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
const FX = require(P.FIXTURES + "/fixtures-portfolio.js");
const acct = (o) => H.normalizePortfolioAccounts([o])[0];
const monthsAgoEnd = (n) => { const [y, m] = T.split("-").map(Number); return H.toLocalISO(new Date(y, m - n, 0)); };
const startOf = (d) => d.slice(0, 8) + "01";

const ACCOUNTS = [
  acct({ id: "fidelity_401k", provider: "Fidelity", type: "401k", label: "Fidelity 401(k)" }),
  acct({ id: "fidelity_hsa", provider: "Fidelity", type: "hsa", label: "Fidelity HSA" }),
  acct({ id: "e", provider: "Empower", type: "401k", label: "Old job 401(k)", cadence: "quarterly", account_hint: "4321" }),
  acct({ id: "v", provider: "Vanguard", type: "roth_ira", label: "Vanguard Roth IRA", cadence: "quarterly" })
];
const SNAPS = [];
for (let i = 6; i >= 1; i--) {
  const end = monthsAgoEnd(i);
  SNAPS.push({ account_id: "fidelity_401k", statement_start: startOf(end), statement_end: end, beginning_value: 52000 + (6 - i) * 700, ending_value: 52700 + (6 - i) * 700, contributions: 1560, change_in_market_value: 640 - i * 30, vested_value: 51000 + (6 - i) * 650, personal_rate_of_return: 1.2 + i / 10, allocation: { stocks_pct: 90, bonds_pct: 8, short_term_other_pct: 2 }, holdings: [{ name: "FID FREEDOM 2055 K6", market_value: 52700 + (6 - i) * 700 }] });
  if (i >= 2) SNAPS.push({ account_id: "fidelity_hsa", statement_start: startOf(end), statement_end: end, beginning_value: 700 + (6 - i) * 50, ending_value: 750 + (6 - i) * 50, change_from_last_period: 50, change_in_investment_value: 8.2 });
}
SNAPS.push({ account_id: "e", statement_start: "2026-04-01", statement_end: "2026-06-30", beginning_value: 61020.44, ending_value: 66726.67, contributions: 3600, fees: 12.5, change_in_market_value: 2118.73, vested_value: 64100, personal_rate_of_return: 3.42 });

function makeApp(files) {
  const store = {};
  Object.entries(files).forEach(([k, v]) => (store[k] = JSON.stringify(v)));
  return { vault: { adapter: { exists: async (p) => p in store, read: async (p) => store[p], write: async (p, d) => { store[p] = d; }, mkdir: async () => {}, list: async () => ({ files: [], folders: [] }) } } };
}
async function renderTab(accounts, snaps) {
  const app = makeApp({ [H.FILES.portfolioAccounts]: accounts, [H.FILES.portfolioSnapshots]: snaps });
  const plugin = Object.create(HF.__PluginClass.prototype);
  Object.assign(plugin, { app, refreshDashboard() {}, promptPortfolioImport() {}, promptPortfolioAccount() {} });
  const v = Object.create(HF.BudgetDashboardView.prototype);
  Object.assign(v, { app, plugin, sectionOpen: {}, scrollMemory: {} });
  const root = el("div");
  root.addClass("budget-view");
  await v.renderPortfolio(root);
  return html(root);
}

(async () => {
  const css = fs.readFileSync(PLUGIN + "/styles.css", "utf8");
  const shots = [];
  shots.push({ name: "pf-tab", body: await renderTab(ACCOUNTS, SNAPS) });
  shots.push({ name: "pf-empty", body: await renderTab([], []) });

  const syncSrc = fs.readFileSync(P.PREVIEWS + "/preview-sync.js", "utf8");
  const OBS_CSS = /const OBSIDIAN_CSS = `([\s\S]*?)`;/.exec(syncSrc)[1];
  const OBS_JS = /const OBSIDIAN_JS = `([\s\S]*?)`;/.exec(syncSrc)[1];
  const fns = ["formatMoneyInput", "parseMoneyInput", "bindMoneyInput", "fieldNote", "fieldNoteHost", "requireMoney", "round2",
    "bindDateInput", "normalizeDate", "isISODateString", "previousMonthKey", "todayLocal", "toLocalISO", "pfSameProvider", "pfCadence", "pfDefaultLabel"]
    .map((n) => H[n].toString()).join("\n");
  const consts = `const PF_FIELDS = ${JSON.stringify(H.PF_FIELDS)};
const PF_OUTFLOWS = new Set(${JSON.stringify([...H.PF_OUTFLOWS])});
const PF_PROVIDERS = ${JSON.stringify(H.PF_PROVIDERS)};
const PF_TYPES = ${JSON.stringify(H.PF_TYPES)};
const PF_CADENCES = ${JSON.stringify(H.PF_CADENCES)};`;
  const parsed = H.parsePortfolioStatement(FX.schwabOne, "2026-08", { accounts: ACCOUNTS, snapshots: [] });
  const review = `<div class="modal budget-portfolio-modal" id="modal"></div><script>${OBS_JS}
${fns}
${consts}
${H.PortfolioImportModal.toString()}
const m = new PortfolioImportModal({}, {}, null);
m.modalEl = document.getElementById("modal");
m.onOpen();
const ta = document.querySelector("textarea");
ta.value = ${JSON.stringify(FX.schwabOne)};
m.showReview(ta, ${JSON.stringify(parsed)}, ${JSON.stringify(ACCOUNTS)}, "5678");
document.querySelector(".budget-pf-more").open = true;
</script>`;
  shots.push({ name: "pf-review", body: review, width: 760, extraCss: OBS_CSS });
  const acctModal = `<div class="modal" id="modal"></div><script>${OBS_JS}
${fns}
${consts}
${H.PortfolioAccountModal.toString()}
const m = new PortfolioAccountModal({}, { prefill: ${JSON.stringify(Object.assign({}, parsed.suggested, { account_hint: "5678" }))} }, () => {});
m.onOpen();
</script>`;
  shots.push({ name: "pf-account", body: acctModal, width: 640, extraCss: OBS_CSS });

  const { chromium } = require("playwright");
  const browser = await chromium.launch();
  const shoot = async (s, scheme, width, file, mobile = false) => {
    const page = await browser.newPage({ viewport: { width, height: 900 }, deviceScaleFactor: 2 });
    const errors = [];
    page.on("pageerror", (e) => errors.push(e.message));
    await page.setContent(`<!doctype html><html><head><meta charset="utf-8"><style>${THEME}\n${css}\n${s.extraCss || ""}\n.budget-hidden{display:none!important}</style></head>` +
      `<body class="theme-${scheme}${mobile ? " is-mobile" : ""}">${s.body}</body></html>`);
    await page.waitForTimeout(150);
    await page.screenshot({ path: path.join(OUT, file), fullPage: true });
    const overflow = await page.evaluate(() => document.documentElement.scrollWidth > window.innerWidth);
    console.log("wrote", file, errors.length ? `ERRORS ${JSON.stringify(errors)}` : "", overflow ? "OVERFLOW" : "");
    await page.close();
  };
  for (const s of shots) for (const scheme of ["light", "dark"]) await shoot(s, scheme, s.width || 1180, `${s.name}-${scheme}.png`);
  global.document.body.classList.contains = (c) => c === "is-mobile";
  await shoot({ body: await renderTab(ACCOUNTS, SNAPS) }, "dark", 400, "pf-tab-mobile.png", true);
  global.document.body.classList.contains = () => false;
  await shoot(shots.find((s) => s.name === "pf-review"), "dark", 400, "pf-review-mobile.png", true);
  await browser.close();
})();
