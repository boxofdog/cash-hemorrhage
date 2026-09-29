// Renders the dashboard through the DOM shim, serializes it to real HTML with
// the plugin's stylesheet and Obsidian's theme variables, and screenshots it.
// Looking at the thing is the only way to judge whether it looks right.
const P = require("../../tests/paths.js");
global.document = { body: { classList: { contains: () => false } } };
global.requestAnimationFrame = (fn) => setTimeout(fn, 0);
const fs = require("fs");
const path = require("path");

const PLUGIN = P.ROOT;
const OUT = process.argv[2] || P.OUT + "/showcase";
fs.mkdirSync(OUT, { recursive: true });

const H = require(P.TESTS + "/harness.js");
const HF = require(P.TESTS + "/harness-for.js")(PLUGIN + "/main.js");
const { el } = H;

const VOID = new Set(["input", "br", "hr", "img"]);
const esc = (s) => String(s).replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
const CAMEL = (k) => k.replace(/[A-Z]/g, (m) => "-" + m.toLowerCase());

function html(n) {
  if (n && n.outerHTML && !n.tag) return n.outerHTML;
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






// ---------------------------------------------------------------------------
// A made-up household, so the screenshots show real computed numbers without
// anyone's real data. Dates are relative to today, so they never go stale.
// ---------------------------------------------------------------------------
const F = H.FILES;
const T = H.todayLocal();
const D = (n) => H.addDays(T, n);
let seed = 7;
const rnd = () => { seed = (seed * 16807) % 2147483647; return seed / 2147483647; };
const pick = (a) => a[Math.floor(rnd() * a.length)];
const money = (lo, hi) => Math.round((lo + rnd() * (hi - lo)) * 100) / 100;
let n = 0;
const tx = (date, amount, merchant, category, account = "Main Checking") =>
  ({ id: `tx-demo-${++n}`, date, amount, merchant_raw: merchant, account_id: account, resolved_category: category, override_label: null });

const txs = [];
for (const d of [-6, -20, -34, -48, -62, -76]) txs.push(tx(D(d), 1850, "ACME PAYROLL DIRECT DEP", "Paycheck"));
for (let d = -84; d <= 0; d++) {
  const dow = new Date(D(d) + "T12:00:00").getDay();
  if ([2, 5].includes(dow) && rnd() < 0.85) txs.push(tx(D(d), -money(28, 70), pick(["Orchard Grocery", "Riverside Market", "Fresh Basket"]), "Groceries"));
  if (rnd() < 0.24) txs.push(tx(D(d), -money(8, 24), pick(["Maple Street Cafe", "Lucky Noodle House", "Harbor Pizza", "Blue Heron Grill", "Willow Coffee"]), "Eating Out"));
  if (dow === 0 && rnd() < 0.85) txs.push(tx(D(d), -money(31, 52), "Summit Fuel", "Gas"));
  if (rnd() < 0.07) txs.push(tx(D(d), -money(12, 60), pick(["Northside Pet Supply", "Red Barn Feed"]), "Pet Bills"));
  if (rnd() < 0.04) txs.push(tx(D(d), -money(14, 42), pick(["Juniper Books", "Fern Hollow Gifts", "Pixel Arcade"]), "Entertainment"));
  if (rnd() < 0.03) txs.push(tx(D(d), -money(25, 90), pick(["Granite Auto Parts", "Clover Thrift"]), "Shopping"));
}
// Monthly things, landing this period and in each earlier month.
for (const m of [0, 1, 2]) {
  const off = m * -30;
  txs.push(tx(D(-3 + off), -15.99, "STREAMLY", "Subscription"));
  txs.push(tx(D(-10 + off), -10.99, "TUNEBOX", "Subscription"));
  txs.push(tx(D(-15 + off), -2.99, "CLOUDBOX STORAGE", "Subscription"));
  txs.push(tx(D(-22 + off), -25, "CEDAR FITNESS", "Subscription"));
  txs.push(tx(D(-4 + off), -34, "PHONE CO", "Phone Bill"));
  txs.push(tx(D(-1 + off), -60, "FIBER NET", "Internet"));
  txs.push(tx(D(-12 + off), -118, "EXAMPLE INSURANCE", "Car Insurance"));
  txs.push(tx(D(-18 + off), -312, "AUTO LOAN PAYMENT", "Car Loan"));
  txs.push(tx(D(-9 + off), -250, "ONLINE PMT CARD", "Credit Card Payment"));
  txs.push(tx(D(-9 + off), 250, "PAYMENT THANK YOU", "Credit Card Payment", "Everyday Card"));
  txs.push(tx(D(-2 + off), -32.5, "AFFIRM HEADPHONES", "BNPL"));
}
for (const d of [-6, -20, -34, -48]) txs.push(tx(D(d), -150, "To Savings 00", "Savings"));
const card = (date, amount, merchant, category) => tx(date, amount, merchant, category, "Everyday Card");
const cardBuys = [["Orchard Grocery", "Groceries"], ["Harbor Pizza", "Eating Out"], ["Pixel Arcade", "Entertainment"], ["Summit Fuel", "Gas"]];
for (let d = -40; d <= 0; d += 4) if (rnd() < 0.6) { const [m, c] = pick(cardBuys); txs.push(card(D(d), -money(12, 46), m, c)); }
txs.sort((a, b) => (a.date < b.date ? 1 : -1));

const rules = [
  ["ORCHARD GROCERY|RIVERSIDE MARKET|FRESH BASKET", "Groceries"], ["MAPLE STREET|LUCKY NOODLE|HARBOR PIZZA|BLUE HERON|WILLOW COFFEE", "Eating Out"],
  ["SUMMIT FUEL", "Gas"], ["NORTHSIDE PET|RED BARN", "Pet Bills"], ["JUNIPER|FERN HOLLOW|PIXEL ARCADE", "Entertainment"],
  ["GRANITE AUTO|CLOVER THRIFT", "Shopping"], ["STREAMLY|TUNEBOX|CLOUDBOX|CEDAR FITNESS", "Subscription"], ["PHONE CO", "Phone Bill"],
  ["FIBER NET", "Internet"], ["EXAMPLE INSURANCE", "Car Insurance"], ["ACME PAYROLL", "Paycheck"]
].flatMap(([pat, label]) => pat.split("|").map((p) => ({ merchant_pattern: p, home_label: label, display_name: p.split(" ").map((w) => w[0] + w.slice(1).toLowerCase()).join(" ") })));

const cats = [
  ["Groceries", { monthly_target: 520 }], ["Eating Out", { monthly_target: 180 }], ["Gas", { is_variable_necessity: true, variable_min_amount: 20 }],
  ["Phone Bill", { exclude_from_discretionary: true }], ["Internet", { exclude_from_discretionary: true }], ["Car Insurance", {}], ["Car Loan", {}],
  ["Subscription", {}], ["Shopping", { monthly_target: 120 }], ["Entertainment", { monthly_target: 80 }], ["Pet Bills", {}], ["BNPL", {}],
  ["Credit Card Payment", { is_transfer: true }], ["Savings", { is_transfer: true }], ["Paycheck", {}], ["Refund", {}]
].map(([name, o]) => Object.assign({ name, is_transfer: false }, o));

const dom = (off) => Number(D(off).slice(8));
const find = (cat, from, to) => txs.find((t) => t.resolved_category === cat && t.date >= D(from) && t.date <= D(to));
const link = (t) => ({ tx_id: t.id, amount: Math.abs(t.amount), date: t.date, paid_for: t.date });
const DATA = {
  [F.accounts]: [
    { id: "Main Checking", type: "checking", institution: "Harbor Credit Union", current_balance: 2184.4, balance_as_of: T },
    { id: "Rainy Day Savings", type: "savings", institution: "Harbor Credit Union", current_balance: 640, balance_as_of: T },
    { id: "Everyday Card", type: "credit_card", institution: "Everyday Bank", current_balance: 1412.3, credit_limit: 3500, balance_as_of: T }
  ],
  [F.transactions]: txs,
  [F.rules]: rules,
  [F.categories]: cats,
  [F.fixedExpenses]: [
    { id: "f1", name: "Phone Co", amount: 34, due_day_of_month: dom(-4), payment_category: "Phone Bill", linked_payments: [link(find("Phone Bill", -6, 0))] },
    { id: "f2", name: "Fiber Net", amount: 60, due_day_of_month: dom(-1), payment_category: "Internet", linked_payments: [link(find("Internet", -6, 0))] },
    { id: "f3", name: "Car insurance", amount: 118, due_day_of_month: dom(6), payment_category: "Car Insurance", linked_payments: [] },
    { id: "f4", name: "Storage unit", amount: 45, due_day_of_month: dom(4), payment_category: "Storage", linked_payments: [] }
  ],
  [F.revolvingDebts]: [{ id: "cc1", account_id: "Everyday Card", payment_category: "Credit Card Payment", apr: 24.99, min_payment_due: 35, due_date: D(9), balance_anchor: { amount: 1412.3, date: T }, applied_payments: [] }],
  [F.installmentDebts]: [
    { id: "b1", payment_category: "BNPL", provider: "Affirm - Headphones", installment_amount: 32.5, frequency: "monthly", remaining_installments: 5, next_due_date: D(26), balance_anchor: { amount: 162.5, date: D(-9) }, applied_payments: [{ tx_id: find("BNPL", -6, 0).id, amount: 32.5, date: find("BNPL", -6, 0).date }] },
    { id: "b2", payment_category: "BNPL", provider: "Klarna - Sneakers", installment_amount: 24, frequency: "biweekly", remaining_installments: 3, next_due_date: D(3), balance_anchor: { amount: 72, date: T }, applied_payments: [] },
    { id: "loan1", kind: "loan", loan_type: "car", provider: "Auto loan", apr: 6.9, installment_amount: 312, frequency: "monthly", next_due_date: D(12), loan_date: D(-400), payment_category: "Car Loan", estimated_value: 9400, balance_anchor: { amount: 6800, date: D(-30), at: new Date().toISOString(), source: "manual" }, applied_payments: [{ tx_id: find("Car Loan", -20, -10).id, amount: 312, date: find("Car Loan", -20, -10).date }] }
  ],
  [F.savingsGoals]: [
    { id: "fund-1", kind: "capped", name: "Oopsie Fund", target_amount: 1000, account_id: "Rainy Day Savings", placement: "hero" },
    { id: "g1", name: "Trip to Lisbon", target_amount: 2400, saved_amount: 900, target_date: D(120), contributions: [{ id: "c1", amount: 900, date: D(-30), linked_tx_id: null }] },
    { id: "g2", name: "New laptop", target_amount: 1400, saved_amount: 350, contributions: [{ id: "c2", amount: 350, date: D(-30), linked_tx_id: null }] }
  ],
  [F.subscriptionReviews]: [],
  [F.debtHistory]: Array.from({ length: 13 }, (_, i) => ({ date: D(-84 + i * 7), total_debt: Math.round((9650 - i * 105 + (i % 3) * 30) * 100) / 100 })),
  [F.categoryOrder]: [], [F.paycheckHistory]: [], [F.bufferSweeps]: [], [F.portfolioAccounts]: [], [F.portfolioSnapshots]: [], [F.closedLoans]: [], [F.simplefinAccounts]: []
};

function makeApp() {
  const store = {};
  Object.entries(DATA).forEach(([k, v]) => (store[k] = JSON.stringify(v)));
  return { _store: store, vault: { adapter: { exists: async (p) => p in store, read: async (p) => store[p], write: async (p, d) => { store[p] = d; }, mkdir: async () => {}, list: async () => ({ files: [], folders: [] }) }, getFiles: () => [] },
    workspace: { getLeavesOfType: () => [] } };
}

async function build(savingsMode) {
  const app = makeApp();
  const plugin = Object.create(HF.__PluginClass.prototype);
  Object.assign(plugin, {
    app, manifest: { id: "budget-tracker" }, syncing: false, refreshDashboard() {}, expiredPeriod: null, pendingSweepClosing: null,
    settings: { bufferMode: "auto", manualBuffer: 350, savingsMode, savingsDeadline: savingsMode ? D(120) : null, paySchedule: { cadence: "biweekly", anchor_date: D(-6) } },
    lastPaycheckInputs: { paycheckAmount: 1850, checkingBalance: 2184.4, alreadyDeposited: true, nextPaydayStr: D(8), periodStartStr: D(-6), todayStr: D(-6), checkingAccountId: "Main Checking", checkingBalanceAt: new Date().toISOString(), checkingBalanceSource: "simplefin" },
    promptEnterPaycheck() {}, promptQuickBalance() {}, promptImportCSV() {}, promptMarkFixedPaid() {}, openSettings() {}, hasSimpleFINConnection() { return true; },
    pendingSweep: async () => null, openSweepModal: async () => {}, refreshAfterDataChange: async () => {}, fixedPaymentCandidates: async () => []
  });
  await plugin.recalculate();
  return plugin;
}

const openAll = (x) => { if (x.tag === "details") x.open = true; (x.children || []).forEach(openAll); };

async function renderTab(plugin, tab, opts = {}) {
  const v = Object.create(HF.BudgetDashboardView.prototype);
  Object.assign(v, { app: plugin.app, plugin, activeTab: tab, sectionOpen: opts.sectionOpen || {}, scrollMemory: {}, lastResult: plugin.lastResult,
    pieRange: null, expandedSpendCategory: null, expandedIncomeCategory: null, activePieTab: "spending" }, opts.state || {});
  v.contentEl = el("div");
  await v.renderView();
  await new Promise((r) => setTimeout(r, 60));
  if (opts.open) openAll(v.contentEl);
  return html(v.contentEl);
}

(async () => {
  const css = fs.readFileSync(PLUGIN + "/styles.css", "utf8");
  const debt = await build(false);
  const savings = await build(true);
  const r = debt.lastResult;
  console.log("spendable", r.bufferRemaining, "flex", r.totalFlexibility, "committed", r.committed, "freeCash", r.freeCash);

  const views = {
    overview: await renderTab(debt, "overview", { sectionOpen: { "ownership-breakdown": true } }),
    insights: await renderTab(debt, "insights", { open: true }),
    debts: await renderTab(debt, "debts", { open: true }),
    insights: await renderTab(debt, "insights", { open: true }),
    transactions: await renderTab(debt, "transactions", { open: true }),
    subscriptions: await renderTab(debt, "subscriptions", { open: true })
  };

  const { chromium } = require("playwright");
  const browser = await chromium.launch();
  const page0 = async (w, h, mobile, body, scale) => {
    const page = await browser.newPage({ viewport: { width: w, height: h }, deviceScaleFactor: scale });
    await page.setContent(`<!doctype html><html><head><meta charset="utf-8"><style>${THEME}\n${css}</style></head><body class="theme-dark${mobile ? " is-mobile" : ""}">${body}</body></html>`);
    await page.waitForTimeout(250);
    return page;
  };
  // A "shot" is a view, plus which part of the page to frame: from the top of
  // the element matching `from` (or the page top), for `h` CSS pixels.
  const shots = [
    { name: "1-overview", view: "overview", from: [null, ".budget-hero"], off: [0, -80], h: { d: 900, m: 844 } },
    { name: "2-plan", view: "overview", from: [".budget-card", ".budget-card"], off: [-14, -14], h: { d: 900, m: 844 } },
    { name: "3-debts", view: "debts", from: [".budget-tabs", ".budget-tabs"], off: [-12, -12], h: { d: 1000, m: 844 } },
    { name: "4-insights", view: "insights", from: [".budget-tabs", ".budget-tabs"], off: [-12, -12], h: { d: 1000, m: 844 } },
    { name: "5-spending", view: "overview", from: [".budget-pie-card", ".budget-pie-card"], off: [-14, -14], h: { d: 900, m: 844 } },
    { name: "extra-transactions", view: "transactions", from: [".budget-tabs", ".budget-tabs"], off: [-12, -12], h: { d: 1000, m: 844 } }
  ];
  for (const s of shots) {
    for (const [kind, w, mobile, scale, i] of [["desktop", 1200, false, 2, 0], ["mobile", 390, true, 3, 1]]) {
      const page = await page0(w, 900, mobile, views[s.view], scale);
      let y = 0;
      if (s.from[i]) y = await page.evaluate(([sel, off]) => { const e = document.querySelector(sel); return e ? Math.max(0, e.getBoundingClientRect().top + window.scrollY + off) : 0; }, [s.from[i], s.off[i]]);
      const total = await page.evaluate(() => document.documentElement.scrollHeight);
      const h = Math.min(s.h[kind === "desktop" ? "d" : "m"], total - y);
      const file = path.join(OUT, `${s.name}-${kind}.png`);
      await page.screenshot({ path: file, fullPage: true, clip: { x: 0, y, width: w, height: h } });
      console.log("wrote", path.basename(file), `y=${Math.round(y)} h=${Math.round(h)} of ${total}`, (await page.evaluate(() => document.documentElement.scrollWidth > window.innerWidth)) ? "OVERFLOW" : "");
      await page.close();
    }
  }
  await browser.close();
})().catch((e) => { console.error(e); process.exit(1); });
