// The label window in a real DOM: Obsidian's Modal and Setting stood in for,
// the plugin's own LabelModal and helpers pulled from its source.
const P = require("../../tests/paths.js");
const fs = require("fs");
const path = require("path");
const SRC = fs.readFileSync(P.MAIN, "utf8");
const CSS = fs.readFileSync(P.STYLES, "utf8");
const OUT = P.OUT + "/shots-v1261";
fs.mkdirSync(OUT, { recursive: true });
function grab(name) {
  const re = new RegExp(`^(?:async )?function ${name}\\b|^class ${name}\\b|^(?:const|let) ${name}\\b`, "m");
  const m = re.exec(SRC);
  if (!m) throw new Error("missing " + name);
  if (/^(const|let)/.test(m[0])) { const end = SRC.indexOf(";\n", m.index); return SRC.slice(m.index, end + 2); }
  let i = m.index;
  if (/function/.test(m[0])) {
    // Past the parameter list, which may itself contain braces.
    i = SRC.indexOf("(", m.index);
    let pd = 0;
    for (; i < SRC.length; i++) { if (SRC[i] === "(") pd++; else if (SRC[i] === ")") { pd--; if (pd === 0) break; } }
  }
  i = SRC.indexOf("{", i);
  let depth = 0;
  for (; i < SRC.length; i++) { if (SRC[i] === "{") depth++; else if (SRC[i] === "}") { depth--; if (depth === 0) break; } }
  return SRC.slice(m.index, i + 1);
}
const names = ["COMMON_CITIES", "US_STATES", "stripTrailingCityState", "guessMerchantKey", "sortCategoriesByUse", "bindPatternReach", "patternReach", "describePatternReach", "fieldNote", "fieldNoteHost", "ruleIndexOf", "LabelModal"];
let lib = names.map(grab).join("\n\n");
const THEME = `
body.theme-dark { --background-primary:#1e1e1e; --background-secondary:#262626; --background-modifier-border:#3b3b3b; --text-normal:#dcddde; --text-muted:#9a9b9e; --text-faint:#6c6e72; --text-accent:#a99bf5; --text-error:#ff6b6b; --text-success:#4ac26b; --interactive-accent:#7b6cd9; --color-red:#fb464c; --color-green:#44cf6e; --color-red-rgb: 251,70,76; }
body { margin:0; background:#111; color:var(--text-normal); font-family:-apple-system,"Segoe UI",Roboto,sans-serif; font-size:15px; display:flex; justify-content:center; padding:24px; }
.modal { background:var(--background-primary); border:1px solid var(--background-modifier-border); border-radius:12px; padding:20px 24px; width:100%; max-width:520px; box-sizing:border-box; }
h2 { font-size:22px; }
.setting-item { display:flex; align-items:center; gap:16px; padding:10px 0; border-top:1px solid var(--background-modifier-border); }
.setting-item-info { flex:1 1 auto; min-width:0; }
.setting-item-name { font-size:15px; }
.setting-item-description { font-size:13px; color:var(--text-muted); padding-top:3px; }
.setting-item-control { flex:0 0 auto; display:flex; gap:8px; }
input, select { background:#2a2a2a; color:var(--text-normal); border:1px solid #444; border-radius:6px; padding:5px 8px; font:inherit; font-size:14px; }
button { background:#333; color:var(--text-normal); border:none; border-radius:6px; padding:6px 14px; font:inherit; font-size:14px; }
button.mod-cta { background:var(--interactive-accent); color:#fff; }
.budget-positive { color:var(--color-green); } .budget-negative { color:var(--color-red); } .budget-muted { color:var(--text-muted); }
@media (max-width:520px) { .setting-item { flex-wrap:wrap; } .setting-item-control { width:100%; } .setting-item-control > * { flex:1; } }
`;
const shim = `
const P = HTMLElement.prototype;
P.createDiv = function (o = {}) { return this.createEl("div", o); };
P.createSpan = function (o = {}) { return this.createEl("span", o); };
P.createEl = function (t, o = {}) { const e = document.createElement(t); if (o.cls) e.className = o.cls; if (o.text) e.textContent = o.text; if (o.attr) Object.entries(o.attr).forEach(([k, v]) => e.setAttribute(k, v)); this.appendChild(e); return e; };
P.setAttr = function (k, v) { this.setAttribute(k, v); }; P.addClass = function (c) { this.classList.add(c); };
P.toggleClass = function (c, on) { this.classList.toggle(c, !!on); }; P.setText = function (t) { this.textContent = t; }; P.empty = function () { this.innerHTML = ""; };
class Modal { constructor() { this.contentEl = document.querySelector(".modal"); } close() {} open() { this.onOpen(); } }
class Notice { constructor() {} }
let categoryUsageOrder = [];
class Setting {
  constructor(parent) { this.settingEl = parent.createDiv({ cls: "setting-item" }); this.info = this.settingEl.createDiv({ cls: "setting-item-info" }); this.nameEl = this.info.createDiv({ cls: "setting-item-name" }); this.descEl = this.info.createDiv({ cls: "setting-item-description" }); this.controlEl = this.settingEl.createDiv({ cls: "setting-item-control" }); }
  setName(n) { this.nameEl.textContent = n; return this; } setDesc(d) { this.descEl.textContent = d; return this; }
  addText(fn) { const i = this.controlEl.createEl("input"); i.type = "text"; const t = { inputEl: i, setValue(v) { i.value = v ?? ""; return t; }, setPlaceholder(p) { i.placeholder = p; return t; }, onChange(cb) { i.addEventListener("input", () => cb(i.value)); return t; } }; fn(t); return this; }
  addDropdown(fn) { const s = this.controlEl.createEl("select"); const d = { addOption(v, l) { const o = document.createElement("option"); o.value = v; o.textContent = l; s.appendChild(o); return d; }, setValue(v) { s.value = v; return d; }, onChange(cb) { s.addEventListener("change", () => cb(s.value)); return d; } }; fn(d); return this; }
  addButton(fn) { const b = this.controlEl.createEl("button"); const x = { setButtonText(t) { b.textContent = t; return x; }, setCta() { b.classList.add("mod-cta"); return x; }, onClick(cb) { b.onclick = cb; return x; } }; fn(x); return this; }
}
`;
(async () => {
  const { chromium } = require("playwright");
  const browser = await chromium.launch();
  const txs = [
    "Recurring Withdrawal Debit Card GOOGLE *G1SK002M 855-836-3987 CA Date 09/23/26 031652 5816 Card 20 #0000",
    "Recurring Withdrawal Debit Card GOOGLE *Relay for r", "Recurring Withdrawal Debit Card GOOGLE *Bumble Dati"
  ].map((m) => ({ merchant_raw: m }));
  const rules = [{ merchant_pattern: "Relay for r", home_label: "Subscription", display_name: "Relay for Reddit" }, { merchant_pattern: "Recurring Withdrawal Debit Card GOOGLE", home_label: "Subscription", display_name: "Relay for Reddit" }];
  for (const [name, width, open] of [["closed", 560, false], ["open", 560, true], ["mobile", 390, false]]) {
    const page = await browser.newPage({ viewport: { width, height: 700 }, deviceScaleFactor: 2 });
    const errors = [];
    page.on("pageerror", (e) => errors.push(e.message));
    await page.setContent(`<!doctype html><html><head><meta charset="utf-8"><style>${THEME}\n${CSS}</style></head><body class="theme-dark"><div class="modal"></div></body></html>`);
    await page.addScriptTag({ content: shim + "\n" + lib + `
      const TX = ${JSON.stringify(txs)}; const RULES = ${JSON.stringify(rules)};
      new LabelModal({}, TX[0].merchant_raw, -1.99, ["Subscription", "Eating Out", "Groceries", "Gas", "Entertainment"], () => {}, RULES[1], { transactions: TX, rules: RULES, onTransfer: () => {} }).open();
      ${open ? 'document.querySelector("details").open = true;' : ""}` });
    await page.waitForTimeout(200);
    const file = `label-${name}.png`;
    await page.screenshot({ path: path.join(OUT, file), fullPage: true });
    console.log("wrote", file, errors.length ? "ERRORS " + JSON.stringify(errors) : "", (await page.evaluate(() => document.documentElement.scrollWidth > window.innerWidth)) ? "OVERFLOW" : "");
    await page.close();
  }
  await browser.close();
})();
