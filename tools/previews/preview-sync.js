// Screenshots of the 1.16.0 SimpleFIN surfaces: the Sync button in its three
// states, Settings → Bank sync (both states), and the account link dropdown.
// The action bar comes from the real renderView through the shim; the settings
// and modal render the plugin's own method source in a page that builds
// Obsidian's real setting-item DOM.
const P = require("../../tests/paths.js");
global.document = { body: { classList: { contains: () => false } } };
global.requestAnimationFrame = (fn) => setTimeout(fn, 0);
const fs = require("fs");
const path = require("path");
const PLUGIN = P.ROOT;
const OUT = P.OUT + "/shots-sync";
fs.mkdirSync(OUT, { recursive: true });

const H = require(P.TESTS + "/harness.js");
const HF = require(P.TESTS + "/harness-for.js")(PLUGIN + "/main.js");
const { el } = H;
const css = fs.readFileSync(PLUGIN + "/styles.css", "utf8");
const PREVIEW = fs.readFileSync(P.PREVIEWS + "/preview.js", "utf8");
const THEME = PREVIEW.slice(PREVIEW.indexOf("const THEME = `") + 15, PREVIEW.indexOf("`;\n\nfunction makeView"));
const htmlSrc = PREVIEW.slice(PREVIEW.indexOf("const VOID"), PREVIEW.indexOf("// Obsidian's theme variables"));
eval(htmlSrc.replace("function html(", "global.html = function html(").replace(/const (VOID|esc|CAMEL) =/g, "global.$1 ="));

const RESULT = JSON.parse(fs.readFileSync(P.FIXTURES + "/fixture-result.json", "utf8"));
const CTX = JSON.parse(fs.readFileSync(P.FIXTURES + "/fixture-ctx.json", "utf8"));
CTX.ownership = H.completeOwnership({ fixedExpenses: [], installmentDebts: CTX.installmentDebts, revolvingDebts: CTX.revolvingDebts, goals: CTX.savingsGoals, categoryMeta: CTX.categoryMetaList, rules: CTX.rules });

async function actionBar(connected, syncing) {
  const v = Object.create(HF.BudgetDashboardView.prototype);
  Object.assign(v, {
    sectionOpen: {}, scrollMemory: {}, activeTab: "overview", pieRange: "all", expandedSpendCategory: null, expandedIncomeCategory: null,
    activePieTab: "spending", app: {}, lastResult: RESULT, contentEl: el("div"),
    plugin: {
      settings: { savingsMode: false, bufferMode: "auto", manualBuffer: 350 }, expiredPeriod: null, lastResult: null, syncing,
      hasSimpleFINConnection: () => connected, promptEnterPaycheck() {}, promptQuickBalance() {}, promptImportCSV() {}, promptMarkFixedPaid() {}, openSettings() {},
      recalculate: async () => {}, refreshAfterDataChange: async () => {}, fixedPaymentCandidates: async () => [], pendingSweep: async () => null, openSweepModal: async () => {}
    }
  });
  v.loadRenderContext = async () => CTX;
  await v.renderView();
  await new Promise((r) => setTimeout(r, 40));
  const find = (n) => (n.classes && n.classes.has("budget-action-bar") ? n : (n.children || []).map(find).find(Boolean));
  return global.html(find(v.contentEl));
}

// Enough of Obsidian's stylesheet for settings and modals.
const OBSIDIAN_CSS = `
.theme-light { --background-modifier-form-field: #ffffff; --interactive-accent: #7b6cd9; --interactive-accent-rgb: 123,108,217; --text-on-accent: #fff; --background-modifier-error: #e93147; }
.theme-dark { --background-modifier-form-field: #2a2a2a; --interactive-accent: #8a7cf0; --interactive-accent-rgb: 138,124,240; --text-on-accent: #fff; --background-modifier-error: #e93147; }
body { margin: 0; padding: 20px; font-family: -apple-system, "Segoe UI", sans-serif; font-size: 15px; background: var(--background-primary); color: var(--text-normal); }
.label { font: 12px ui-monospace, monospace; color: var(--text-muted); margin: 18px 0 6px; }
.budget-action-bar { margin: 0; }
.pane { max-width: 760px; padding: 4px 28px 16px; border-radius: 10px; background: var(--background-primary); border: 1px solid var(--background-modifier-border); margin-bottom: 22px; }
.modal { width: 560px; max-width: calc(100vw - 32px); box-sizing: border-box; padding: 20px 24px; border-radius: 12px; background: var(--background-primary);
  border: 1px solid var(--background-modifier-border); box-shadow: 0 10px 40px rgba(0,0,0,.25); }
.modal h2 { margin: 0 0 8px; font-size: 1.25em; }
.setting-item { display: flex; align-items: center; gap: 16px; padding: 12px 0; border-top: 1px solid var(--background-modifier-border); }
.setting-item-info { flex: 1 1 auto; min-width: 0; }
.setting-item-name { font-size: 15px; color: var(--text-normal); }
.setting-item-description { font-size: 13px; color: var(--text-muted); padding-top: 3px; line-height: 1.4; }
.setting-item-control { flex: 0 0 auto; display: flex; gap: 8px; align-items: center; flex-wrap: wrap; justify-content: flex-end; }
input[type=text], input[type=password], select { font: inherit; font-size: 14px; height: 32px; padding: 0 10px; box-sizing: border-box; border-radius: 6px;
  color: var(--text-normal); background: var(--background-modifier-form-field); border: 1px solid var(--background-modifier-border); max-width: 100%; }
input[type=text] { width: 190px; }
select { max-width: 280px; }
button { font: inherit; font-size: 14px; min-height: 32px; padding: 0 14px; border-radius: 6px; cursor: pointer; color: var(--text-normal);
  background: var(--background-secondary); border: 1px solid var(--background-modifier-border); }
button.mod-cta { background: var(--interactive-accent); color: var(--text-on-accent); border-color: var(--interactive-accent); }
button.mod-warning { background: var(--background-modifier-error); color: #fff; border-color: transparent; }
h3 { margin: 18px 0 4px; }
@media (max-width: 520px) { .setting-item { flex-wrap: wrap; } .setting-item-control { width: 100%; justify-content: flex-start; } input[type=password], .budget-sync-token { width: 100%; flex: 1 1 auto; } }
`;

const OBSIDIAN_JS = `
const P = HTMLElement.prototype;
P.setAttr = function (k, v) { this.setAttribute(k, v); };
P.addClass = function (c) { this.classList.add(c); };
P.toggleClass = function (c, on) { this.classList.toggle(c, !!on); };
P.setText = function (t) { this.textContent = t; };
P.empty = function () { this.innerHTML = ""; };
P.createEl = function (tag, o = {}) { const d = document.createElement(tag); if (o.cls) d.className = o.cls; if (o.text) d.textContent = o.text; if (o.attr) Object.entries(o.attr).forEach(([k, v]) => d.setAttribute(k, v)); this.appendChild(d); return d; };
P.createDiv = function (o = {}) { return this.createEl("div", o); };
P.createSpan = function (o = {}) { return this.createEl("span", o); };
window.__notices = [];
class Notice { constructor(m) { __notices.push(m); } }
class Setting {
  constructor(parent) {
    this.settingEl = parent.createDiv({ cls: "setting-item" });
    const info = this.settingEl.createDiv({ cls: "setting-item-info" });
    this.nameEl = info.createDiv({ cls: "setting-item-name" });
    this.descEl = info.createDiv({ cls: "setting-item-description" });
    this.controlEl = this.settingEl.createDiv({ cls: "setting-item-control" });
  }
  setName(t) { this.nameEl.textContent = t; return this; }
  setDesc(t) { this.descEl.textContent = t; return this; }
  addText(cb) {
    const inputEl = this.controlEl.createEl("input"); inputEl.type = "text";
    const c = { inputEl, setPlaceholder(p) { inputEl.placeholder = p; return c; }, setValue(v) { inputEl.value = v == null ? "" : v; return c; },
      getValue() { return inputEl.value; }, onChange(f) { inputEl.addEventListener("input", () => f(inputEl.value)); return c; } };
    cb(c); return this;
  }
  addButton(cb) {
    const b = this.controlEl.createEl("button");
    const c = { buttonEl: b, setButtonText(t) { b.textContent = t; return c; }, setCta() { b.classList.add("mod-cta"); return c; },
      setWarning() { b.classList.add("mod-warning"); return c; }, setDisabled(d) { b.disabled = d; return c; }, onClick(f) { b.onclick = f; return c; } };
    cb(c); return this;
  }
  addDropdown(cb) {
    const s = this.controlEl.createEl("select");
    const c = { selectEl: s, addOption(v, l) { const o = document.createElement("option"); o.value = v; o.textContent = l; s.appendChild(o); return c; },
      setValue(v) { s.value = v; return c; }, onChange(f) { s.onchange = () => f(s.value); return c; } };
    cb(c); return this;
  }
  addToggle(cb) {
    const t = this.controlEl.createDiv({ cls: "checkbox-container" });
    const c = { setValue(v) { t.classList.toggle("is-enabled", !!v); return c; }, onChange() { return c; } };
    cb(c); return this;
  }
}
class Modal { constructor(app) { this.app = app; this.contentEl = document.getElementById("modal"); } close() {} }
`;

// The plugin's own code, verbatim.
const fnNames = ["simplefinAccountLabel", "formatMoneyInput", "parseMoneyInput", "formatChartDate", "toLocalISO", "redactSimpleFIN",
  "bindMoneyInput", "fieldNote", "fieldNoteHost", "requireMoney"];
const FNS = fnNames.map((n) => H[n].toString()).join("\n") + "\n" + H.SimpleFINError.toString() + "\n";
const RENDER_SETTINGS = HF.BudgetSettingTab.prototype.renderBankSyncSettings.toString();
const ADD_ACCOUNT = H.AddAccountModal.toString();

const KNOWN = [
  { id: "ACT-chk", name: "Checking", org: "Credit Union", balance: 1234.56 },
  { id: "ACT-card", name: "Freedom Unlimited", org: "Chase", balance: -590.46 },
  { id: "ACT-sav", name: "Share Savings", org: "Credit Union", balance: 5000 },
  { id: "ACT-amex", name: "Blue Cash Everyday", org: "American Express", balance: -212.08 }
];

function settingsPage(connected, focus) {
  const lastSync = new Date(); lastSync.setHours(8, 42, 0, 0);
  const data = {
    "Budget/data/simplefin_accounts.json": { accounts: KNOWN, last_sync: { at: lastSync.toISOString(), added: 4 } },
    "Budget/data/accounts.json": [
      { id: "checking", institution: "Credit Union", simplefin_id: "ACT-chk" },
      { id: "chase", institution: "Chase", simplefin_id: "ACT-card" },
      { id: "savings", institution: "Credit Union Savings" }
    ]
  };
  return `<div class="pane" id="pane"></div>
<script>${OBSIDIAN_JS}
${FNS}
const FILES = { simplefinAccounts: "Budget/data/simplefin_accounts.json", accounts: "Budget/data/accounts.json" };
const DATA = ${JSON.stringify(data)};
async function readJSON(app, p, fb) { return p in DATA ? JSON.parse(JSON.stringify(DATA[p])) : fb; }
class ConfirmModal { open() {} }
const tab = {
  app: {}, display() {},
  plugin: { settingsFocus: ${focus ? '"simplefin"' : "null"}, hasSimpleFINConnection: () => ${connected}, connectSimpleFIN: async () => ({ accounts: [] }) },
  ${RENDER_SETTINGS}
};
tab.renderBankSyncSettings(document.getElementById("pane")).then(() => { window.done = true; });
</script>`;
}

function modalPage() {
  const existing = { id: "savings", type: "savings", institution: "Credit Union Savings", current_balance: 200, csv_source: "mainbank" };
  return `<div class="modal" id="modal"></div>
<script>${OBSIDIAN_JS}
${FNS}
${ADD_ACCOUNT}
const m = new AddAccountModal({}, () => {}, ${JSON.stringify(existing)}, { simplefinAccounts: ${JSON.stringify(KNOWN)}, linkedBy: { "ACT-chk": "Credit Union", "ACT-card": "Chase" } });
m.onOpen();
window.done = true;
</script>`;
}

(async () => {
  const bars = [
    ["not set up", await actionBar(false, false)],
    ["connected", await actionBar(true, false)],
    ["syncing", await actionBar(true, true)]
  ];
  const barBody = bars.map(([label, h]) => `<div class="label">${label}</div>${h}`).join("");

  const { chromium } = require("playwright");
  const browser = await chromium.launch();
  const shoot = async (name, body, { width = 900, scheme = "dark", wait = 250, measure = null } = {}) => {
    const page = await browser.newPage({ viewport: { width, height: 900 }, deviceScaleFactor: 2 });
    const errors = [];
    page.on("pageerror", (e) => errors.push(e.message));
    await page.setContent(`<!doctype html><html><head><meta charset="utf-8"><style>${THEME}\n${css}\n${OBSIDIAN_CSS}</style></head>` +
      `<body class="theme-${scheme}">${body}</body></html>`);
    await page.waitForTimeout(wait);
    const file = path.join(OUT, `${name}-${scheme}.png`);
    await page.screenshot({ path: file, fullPage: true });
    const m = measure ? await page.evaluate(measure) : null;
    console.log(path.basename(file), errors.length ? `ERRORS ${JSON.stringify(errors)}` : "", m ? JSON.stringify(m) : "");
    await page.close();
  };

  const barMeasure = () => [...document.querySelectorAll(".budget-sync-btn")].map((b) => {
    const s = getComputedStyle(b);
    const r = b.getBoundingClientRect();
    const label = b.querySelector(".budget-sync-label");
    const lr = label.getBoundingClientRect();
    return { text: label.textContent, w: Math.round(r.width), h: Math.round(r.height), labelCentred: Math.abs((lr.left + lr.width / 2) - (r.left + r.width / 2)) < 1, opacity: s.opacity, color: s.color };
  });
  const overflow = () => ({ overflow: document.documentElement.scrollWidth > window.innerWidth });

  for (const scheme of ["dark", "light"]) {
    await shoot("bar", barBody, { width: 1100, scheme, measure: barMeasure });
    await shoot("settings-off-focus", settingsPage(false, true), { scheme, wait: 900 });
    await shoot("settings-on", settingsPage(true, false), { scheme });
    await shoot("link-modal", modalPage(), { width: 640, scheme });
  }
  await shoot("bar-mobile", barBody, { width: 400, measure: overflow });
  await shoot("settings-off-mobile", settingsPage(false, false), { width: 400, measure: overflow });
  await shoot("settings-on-mobile", settingsPage(true, false), { width: 400, measure: overflow });
  await shoot("link-modal-mobile", modalPage(), { width: 400, measure: overflow });
  await browser.close();
})();
