// Renders the dashboard through the DOM shim, serializes it to real HTML with
// the plugin's stylesheet and Obsidian's theme variables, and screenshots it.
// Looking at the thing is the only way to judge whether it looks right.
const P = require("../../tests/paths.js");
global.document = { body: { classList: { contains: () => false } } };
global.requestAnimationFrame = (fn) => setTimeout(fn, 0);
const fs = require("fs");
const path = require("path");

const PLUGIN = P.ROOT;
const OUT = process.argv[2] || P.OUT + "/shots-v1251";
fs.mkdirSync(OUT, { recursive: true });

const H = require(P.TESTS + "/harness.js");
const HF = require(P.TESTS + "/harness-for.js")(PLUGIN + "/main.js");
const { el } = H;

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






const DATA = {
  "Budget/data/categories.json": [
    { name: "Eating Out", is_transfer: false },
    { name: "Gas", is_transfer: false, is_variable_necessity: true, variable_min_amount: 20 },
    { name: "Phone Bill", is_transfer: false, exclude_from_discretionary: true },
    { name: "Credit Card Payment", is_transfer: true },
    { name: "Oil change", is_transfer: false, is_necessary_expense: true }
  ],
  "Budget/data/category_rules.json": [{ merchant_pattern: "SHELL", home_label: "Gas" }],
  "Budget/data/transactions.json": [], "Budget/data/fixed_expenses.json": [], "Budget/data/installment_debts.json": [], "Budget/data/revolving_debts.json": []
};
(async () => {
  const css = fs.readFileSync(PLUGIN + "/styles.css", "utf8");
  const tab = Object.create(HF.BudgetSettingTab.prototype);
  tab.app = { vault: { adapter: { exists: async (p) => p in DATA, read: async (p) => JSON.stringify(DATA[p] ?? []), write: async () => {} } } };
  tab.plugin = { app: tab.app, settings: {}, refreshDashboard() {} };
  tab._openSections = { categories: true };
  tab.display = async () => {};
  const root = el("div");
  await tab.renderCategorySettings(root);
  const body = html(root);
  const { chromium } = require("playwright");
  const browser = await chromium.launch();
  for (const [width, mobile] of [[900, false], [390, true]]) {
    const page = await browser.newPage({ viewport: { width, height: 500 }, deviceScaleFactor: 2 });
    await page.setContent(`<!doctype html><html><head><meta charset="utf-8"><style>${THEME}\n${css}</style></head><body class="theme-dark${mobile ? " is-mobile" : ""}"><div class="budget-dashboard">${body}</div></body></html>`);
    const file = `categories-${mobile ? "mobile" : "desktop"}.png`;
    await page.screenshot({ path: path.join(OUT, file), fullPage: true });
    console.log("wrote", file, (await page.evaluate(() => document.documentElement.scrollWidth > window.innerWidth)) ? "OVERFLOW" : "");
    await page.close();
  }
  await browser.close();
})();
