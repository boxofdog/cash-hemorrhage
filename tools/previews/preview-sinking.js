// Sinking funds on screen: the Overview's "Due this pay period" row and the
// Savings goals card (through the DOM shim, serialized with the plugin's
// stylesheet), and the fund dialog in a real DOM with the whole of main.js
// loaded against a small Obsidian stand-in. Dark theme, desktop and phone.
const P = require("../../tests/paths.js");
global.document = { body: { classList: { contains: () => false } } };
global.requestAnimationFrame = (fn) => setTimeout(fn, 0);
const fs = require("fs");
const path = require("path");
const PLUGIN = P.ROOT;
const SRC = fs.readFileSync(PLUGIN + "/main.js", "utf8");
const CSS = fs.readFileSync(PLUGIN + "/styles.css", "utf8");
const OUT = process.argv[2] || P.OUT + "/shots-sinking";
fs.mkdirSync(OUT, { recursive: true });
const H = require(P.TESTS + "/harness.js");
const { el } = H;

const VOID = new Set(["input", "br", "hr", "img"]);
const esc = (s) => String(s).replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
const CAMEL = (k) => k.replace(/[A-Z]/g, (m) => "-" + m.toLowerCase());
function html(n) {
  const cls = [...(n.classes || [])].join(" ");
  const style = Object.entries(n.style || {}).filter(([, v]) => v !== "" && v != null).map(([k, v]) => `${CAMEL(k)}:${v}`).join(";");
  const attrs = Object.entries(n.attrs || {}).filter(([k]) => k !== "style").map(([k, v]) => ` ${k}="${esc(v)}"`).join("");
  const open = `<${n.tag}${cls ? ` class="${esc(cls)}"` : ""}${style ? ` style="${esc(style)}"` : ""}${attrs}` + (n.tag === "details" && n.open ? " open" : "") + ">";
  if (VOID.has(n.tag)) return open;
  return open + esc(n._text || "") + (n.innerHTML != null ? n.innerHTML : "") + (n.children || []).map(html).join("") + `</${n.tag}>`;
}

const THEME = `
.theme-dark {
  --background-primary: #1e1e1e; --background-primary-alt: #262626; --background-secondary: #262626;
  --background-modifier-border: #3b3b3b; --background-modifier-hover: rgba(255,255,255,0.075); --background-modifier-error: #b34a44;
  --text-normal: #dcddde; --text-muted: #9a9b9e; --text-faint: #6c6e72; --text-accent: #a99bf5; --text-error: #ff6b6b; --text-success: #4ac26b; --text-warning: #e0a83a;
  --interactive-accent: #7b6cd9; --radius-s: 6px; --radius-m: 10px; --font-ui-medium: 15px; --font-ui-small: 13px; --font-ui-smaller: 12px;
  --font-monospace: ui-monospace, SFMono-Regular, Menlo, monospace;
  --color-red: #fb464c; --color-orange: #e9973f; --color-yellow: #e0de71; --color-green: #44cf6e; --color-cyan: #53dfdd; --color-blue: #027aff; --color-purple: #a882ff; --color-pink: #fa99cd;
}
body { margin: 0; padding: 24px; background: var(--background-primary); color: var(--text-normal); font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif; font-size: 15px; line-height: 1.5; }
button { font-family: inherit; font-size: 14px; cursor: pointer; background: #333; color: var(--text-normal); border: none; border-radius: 6px; padding: 6px 14px; }
.mod-cta { background: var(--interactive-accent); color: #fff; }
.modal { background: var(--background-primary); border: 1px solid var(--background-modifier-border); border-radius: 12px; padding: 20px 24px; max-width: 560px; margin: 0 auto; box-sizing: border-box; }
.modal h2 { font-size: 22px; margin-top: 0; }
.setting-item { display: flex; align-items: center; gap: 16px; padding: 10px 0; border-top: 1px solid var(--background-modifier-border); }
.setting-item-info { flex: 1 1 auto; min-width: 0; }
.setting-item-description { font-size: 13px; color: var(--text-muted); padding-top: 3px; }
.setting-item-control { flex: 0 0 auto; display: flex; gap: 8px; align-items: center; }
input[type=text], select { background: #2a2a2a; color: var(--text-normal); border: 1px solid #444; border-radius: 6px; padding: 5px 8px; font: inherit; font-size: 14px; }
.checkbox-container { width: 38px; height: 20px; border-radius: 10px; background: #444; position: relative; }
.checkbox-container.is-enabled { background: var(--interactive-accent); }
.checkbox-container::after { content: ""; position: absolute; top: 2px; left: 2px; width: 16px; height: 16px; border-radius: 50%; background: #fff; }
.checkbox-container.is-enabled::after { left: 20px; }
.is-mobile .setting-item { flex-wrap: wrap; } .is-mobile .setting-item-control { width: 100%; } .is-mobile .setting-item-control > * { flex: 1; }
`;

// Enough of Obsidian for the dialogs, on real elements.
const SHIM = `
const P = HTMLElement.prototype;
P.createDiv = function (o = {}) { return this.createEl("div", o); };
P.createSpan = function (o = {}) { return this.createEl("span", o); };
P.createEl = function (t, o = {}, cb) { const e = document.createElement(t); if (typeof o === "string") o = { cls: o }; if (o.cls) e.className = Array.isArray(o.cls) ? o.cls.join(" ") : o.cls; if (o.text != null) e.textContent = o.text; if (o.type) e.type = o.type; if (o.value != null) e.value = o.value; if (o.placeholder) e.placeholder = o.placeholder; if (o.href) e.href = o.href; if (o.title) e.title = o.title; if (o.attr) Object.entries(o.attr).forEach(([k, v]) => e.setAttribute(k, v)); this.appendChild(e); if (cb) cb(e); return e; };
P.setAttr = function (k, v) { this.setAttribute(k, v); }; P.addClass = function (...c) { this.classList.add(...c); }; P.removeClass = function (...c) { this.classList.remove(...c); };
P.toggleClass = function (c, on) { this.classList.toggle(c, !!on); }; P.hasClass = function (c) { return this.classList.contains(c); };
P.setText = function (t) { this.textContent = t; }; P.empty = function () { this.innerHTML = ""; };
P.hide = function () { this.style.display = "none"; }; P.show = function () { this.style.display = ""; }; P.toggle = function (on) { this.style.display = on ? "" : "none"; };
class Modal { constructor(app) { this.app = app; this.contentEl = document.querySelector(".modal"); this.modalEl = this.contentEl; } close() {} open() { this.onOpen(); } }
class Notice { constructor(m) { window.__notices = (window.__notices || []).concat([m]); } }
class Setting {
  constructor(parent) { this.settingEl = parent.createDiv({ cls: "setting-item" }); this.infoEl = this.settingEl.createDiv({ cls: "setting-item-info" }); this.nameEl = this.infoEl.createDiv({ cls: "setting-item-name" }); this.descEl = this.infoEl.createDiv({ cls: "setting-item-description" }); this.controlEl = this.settingEl.createDiv({ cls: "setting-item-control" }); }
  setName(n) { this.nameEl.textContent = n; return this; } setDesc(d) { this.descEl.textContent = d; return this; } setHeading() { this.settingEl.classList.add("setting-item-heading"); return this; } setClass(c) { this.settingEl.classList.add(c); return this; }
  addText(fn) { const i = this.controlEl.createEl("input"); i.type = "text"; const t = { inputEl: i, getValue: () => i.value, setValue(v) { i.value = v ?? ""; return t; }, setPlaceholder(p) { i.placeholder = p; return t; }, setDisabled(d) { i.disabled = d; return t; }, onChange(cb) { i.addEventListener("input", () => cb(i.value)); return t; } }; fn(t); return this; }
  addTextArea(fn) { return this.addText(fn); }
  addDropdown(fn) { const s = this.controlEl.createEl("select"); const d = { selectEl: s, addOption(v, l) { const o = document.createElement("option"); o.value = v; o.textContent = l; s.appendChild(o); return d; }, addOptions(m) { Object.entries(m).forEach(([v, l]) => d.addOption(v, l)); return d; }, getValue: () => s.value, setValue(v) { s.value = v; return d; }, setDisabled(x) { s.disabled = x; return d; }, onChange(cb) { s.addEventListener("change", () => cb(s.value)); return d; } }; fn(d); return this; }
  addToggle(fn) { const c = this.controlEl.createDiv({ cls: "checkbox-container" }); let val = false; let h = null; const t = { toggleEl: c, getValue: () => val, setValue(v) { val = !!v; c.classList.toggle("is-enabled", val); return t; }, onChange(cb) { h = cb; return t; } }; c.onclick = () => { t.setValue(!val); if (h) h(val); }; fn(t); return this; }
  addButton(fn) { const b = this.controlEl.createEl("button"); const x = { buttonEl: b, setButtonText(t) { b.textContent = t; return x; }, setCta() { b.classList.add("mod-cta"); return x; }, setWarning() { b.classList.add("mod-warning"); return x; }, setTooltip() { return x; }, setIcon() { return x; }, setDisabled(d) { b.disabled = d; return x; }, onClick(cb) { b.onclick = cb; return x; } }; fn(x); return this; }
  addExtraButton(fn) { return this.addButton(fn); }
}
const obsidian = { Modal, Notice, Setting, Plugin: class {}, ItemView: class {}, PluginSettingTab: class {}, FuzzySuggestModal: class {}, SuggestModal: class {}, Menu: class {}, TFile: class {}, TFolder: class {}, MarkdownRenderer: {}, Platform: {}, requestUrl: async () => ({}), setIcon() {}, debounce: (f) => f, normalizePath: (p) => p, moment: null };
`;

const T = H.todayLocal();
const D = (n) => H.addDays(T, n);
// Paid every other week, the last one 5 days ago. Rent is due the 1st, car insurance the 15th.
const SCHEDULE = { cadence: "biweekly", anchor_date: D(-5) };
const rentDay = Number(H.sinkingDueAfter(1, T).slice(8, 10));
const RENT = { id: "sink-rent", kind: "sinking", name: "Rent", target_amount: 1500, due_day_of_month: 1, account_id: "Savings", track_from: D(-40), replaces_bill_id: "bill-rent", saved_amount: 0, contributions: [], linked_payments: [{ tx_id: "p1", amount: 1500, date: D(-12), paid_for: H.sinkingDueBefore(1, T) }], paid_through: H.sinkingDueBefore(1, T) };
const CARINS = { id: "sink-ins", kind: "sinking", name: "Car insurance", target_amount: 640, due_day_of_month: 15, saved_amount: 160, account_id: "Savings", track_from: D(-40), contributions: [{ id: "c1", amount: 160, date: D(-3), linked_tx_id: "t1", source: "account" }], linked_payments: [] };
const TRIP = { id: "g1", name: "Trip", target_amount: 1200, saved_amount: 300, target_date: D(120), contributions: [] };
const ACCOUNTS = [{ id: "Checking", type: "checking", institution: "Credit Union" }, { id: "Savings", type: "savings", institution: "Credit Union — Savings" }];
const goals = [TRIP, RENT, CARINS];
const sinkRows = H.sinkingHolds(goals, { schedule: SCHEDULE, todayStr: T, periodDays: 14 }).rows;

function overview() {
  const v = Object.create(H.BudgetDashboardView.prototype);
  Object.assign(v, { app: {}, sectionOpen: {}, scrollMemory: {}, plugin: { settings: { paySchedule: SCHEDULE } } });
  const root = el("div");
  v.renderObligationsCard(root, {
    periodFixed: [{ name: "Internet", amount: 65 }, { name: "Phone", amount: 48.5 }], periodFixedPaid: [], dueInstallments: [], dueRevolvingMins: [], earmarked: 0, minimumsPaid: 0,
    sinkingRows: sinkRows, todayStr: T, nextPaydayStr: D(9)
  }, { rules: [] });
  return html(root);
}
function goalsCard() {
  const v = Object.create(H.BudgetDashboardView.prototype);
  Object.assign(v, { app: {}, sectionOpen: {}, scrollMemory: {}, lastResult: null, plugin: { settings: { paySchedule: SCHEDULE } } });
  const root = el("div");
  v.renderGoalsCard(root, { allTx: [], rules: [], accounts: ACCOUNTS, savingsGoals: goals, categoryMetaList: [], ownership: null });
  return html(root);
}

(async () => {
  const { chromium } = require("playwright");
  const browser = await chromium.launch(process.env.PW_EXECUTABLE ? { executablePath: process.env.PW_EXECUTABLE } : {});
  const shots = [];
  for (const [name, body] of [["overview", overview()], ["goals", goalsCard()]]) {
    for (const [width, mobile] of [[820, false], [390, true]]) {
      const page = await browser.newPage({ viewport: { width, height: 700 }, deviceScaleFactor: 2 });
      await page.setContent(`<!doctype html><html><head><meta charset="utf-8"><style>${THEME}\n${CSS}</style></head><body class="theme-dark${mobile ? " is-mobile" : ""}">${body}</body></html>`);
      await page.waitForTimeout(300);
      const file = `sinking-${name}${mobile ? "-mobile" : ""}.png`;
      await page.screenshot({ path: path.join(OUT, file), fullPage: true });
      shots.push([file, await page.evaluate(() => document.documentElement.scrollWidth > window.innerWidth)]);
      await page.close();
    }
  }

  const choices = JSON.stringify([{ id: "Savings", label: "Credit Union — Savings", others: ["Trip"] }]);
  const bills = JSON.stringify([{ id: "bill-rent", name: "Rent", amount: 1500 }, { id: "bill-ins", name: "Car insurance", amount: 640 }]);
  const dialogs = [
    ["new", `new SinkingFundModal({}, () => {}, null, { accountChoices: ${choices}, bills: ${bills} }).open();`],
    ["from-bill", `new SinkingFundModal({}, () => {}, null, { accountChoices: ${choices}, bills: ${bills}, prefill: { id: "bill-rent", name: "Rent", amount: 1500, due_day_of_month: 1 } }).open();`]
  ];
  for (const [name, script] of dialogs) for (const [width, mobile] of [[620, false], [390, true]]) {
    const page = await browser.newPage({ viewport: { width, height: 800 }, deviceScaleFactor: 2 });
    const errors = [];
    page.on("pageerror", (e) => errors.push(e.message));
    await page.setContent(`<!doctype html><html><head><meta charset="utf-8"><style>${THEME}\n${CSS}</style></head><body class="theme-dark${mobile ? " is-mobile" : ""}"><div class="modal"></div></body></html>`);
    await page.addScriptTag({ content: SHIM + `\n(function (require, module, exports) {\n${SRC}\n;window.__run = () => { ${script} };\n})((n) => obsidian, { exports: {} }, {});\ntry { window.__run(); } catch (e) { document.body.insertAdjacentText("beforeend", "ERROR " + e.stack); }` });
    await page.waitForTimeout(300);
    const file = `sinking-dialog-${name}${mobile ? "-mobile" : ""}.png`;
    await page.screenshot({ path: path.join(OUT, file), fullPage: true });
    shots.push([file, await page.evaluate(() => document.documentElement.scrollWidth > window.innerWidth), errors.concat(await page.evaluate(() => (document.body.textContent.match(/ERROR [^\n]*/) || [""])[0])).filter(Boolean)]);
    await page.close();
  }
  await browser.close();
  shots.forEach(([f, over, errs]) => console.log("wrote", f, over ? "OVERFLOW" : "", errs && errs.length ? JSON.stringify(errs) : ""));
})();
