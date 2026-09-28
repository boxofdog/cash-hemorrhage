// Renders the dashboard through the DOM shim, serializes it to real HTML with
// the plugin's stylesheet and Obsidian's theme variables, and screenshots it.
// Looking at the thing is the only way to judge whether it looks right.
const P = require("../../tests/paths.js");
global.document = { body: { classList: { contains: () => false } } };
global.requestAnimationFrame = (fn) => setTimeout(fn, 0);
const fs = require("fs");
const path = require("path");

const PLUGIN = P.ROOT;
const OUT = process.argv[2] || P.OUT + "/shots-v120";
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



const tx = (date, amount, cat) => ({ id: `${date}-${cat}-${amount}`, date, amount, resolved_category: cat, merchant_raw: cat });
const TXS = [
  tx("2026-08-05", -153.13, "Eating Out"), tx("2026-09-03", -207.79, "Eating Out"),
  tx("2026-08-10", -327.81, "Snacks"), tx("2026-09-10", -42.22, "Snacks"),
  tx("2026-09-12", -30, "Hobbies"), tx("2026-08-12", -120, "Clothes/Luxuries"), tx("2026-09-14", -60.5, "Clothes/Luxuries")
];
const CATS = [
  { name: "Eating Out", monthly_target: 145.47 }, { name: "Snacks", monthly_target: 120 },
  { name: "Hobbies", monthly_target: 50 }, { name: "Clothes/Luxuries", monthly_target: 100 }
];
async function renderIns() {
  const v = Object.create(HF.BudgetDashboardView.prototype);
  Object.assign(v, { app: {}, plugin: { settings: {} }, sectionOpen: {}, scrollMemory: {}, insightsMonth: "2026-09" });
  v.render = () => {};
  const root = el("div");
  await v.renderInsights(root, { allTx: TXS, categoryMetaList: CATS, rules: [], ownership: null });
  // Only the targets card.
  return html(root.children[0]);
}
(async () => {
  const css = fs.readFileSync(PLUGIN + "/styles.css", "utf8");
  const { chromium } = require("playwright");
  const browser = await chromium.launch();
  const body = await renderIns();
  for (const [scheme, width, mobile] of [["light", 900, false], ["dark", 900, false], ["dark", 380, true]]) {
    const page = await browser.newPage({ viewport: { width, height: 700 }, deviceScaleFactor: 2 });
    const errors = [];
    page.on("pageerror", (e) => errors.push(e.message));
    await page.setContent(`<!doctype html><html><head><meta charset="utf-8"><style>${THEME}\n${css}</style></head><body class="theme-${scheme}${mobile ? " is-mobile" : ""}">${body}</body></html>`);
    await page.waitForTimeout(120);
    const file = `targets-${scheme}${mobile ? "-mobile" : ""}.png`;
    await page.screenshot({ path: path.join(OUT, file), fullPage: true });
    const overflow = await page.evaluate(() => document.documentElement.scrollWidth > window.innerWidth);
    console.log("wrote", file, errors.length ? `ERRORS ${JSON.stringify(errors)}` : "", overflow ? "OVERFLOW" : "");
    await page.close();
  }
  await browser.close();
})();
