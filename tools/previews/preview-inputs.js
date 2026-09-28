// Screenshots of the 1.14.0 field and chart changes, rendered with Obsidian's
// real setting-item structure and the plugin's own functions (their source,
// injected verbatim) — not the test shim, whose DOM isn't Obsidian's.
const P = require("../../tests/paths.js");
const fs = require("fs");
const path = require("path");
const H = require(P.TESTS + "/harness.js");
const OUT = P.OUT + "/shots-inputs";
fs.mkdirSync(OUT, { recursive: true });

const css = fs.readFileSync(P.STYLES, "utf8");
const PREVIEW = fs.readFileSync(P.PREVIEWS + "/preview.js", "utf8");
const THEME = PREVIEW.slice(PREVIEW.indexOf("const THEME = `") + 15, PREVIEW.indexOf("`;\n\nfunction makeView"));

// Enough of Obsidian's own stylesheet for a setting row and its inputs.
const OBSIDIAN_CSS = `
.theme-light { --background-modifier-form-field: #ffffff; --interactive-accent: #7b6cd9; }
.theme-dark { --background-modifier-form-field: #2a2a2a; --interactive-accent: #8a7cf0; }
.modal { width: 520px; max-width: calc(100vw - 32px); box-sizing: border-box; margin: 0 auto 28px;
  padding: 20px 24px; border-radius: 12px; background: var(--background-primary);
  border: 1px solid var(--background-modifier-border); box-shadow: 0 10px 40px rgba(0,0,0,.25); }
.modal h2 { margin: 0 0 12px; font-size: 1.25em; }
.setting-item { display: flex; align-items: center; gap: 16px; padding: 12px 0; border-top: 1px solid var(--background-modifier-border); }
.setting-item-info { flex: 1 1 auto; min-width: 0; }
.setting-item-name { font-size: 15px; color: var(--text-normal); }
.setting-item-description { font-size: 13px; color: var(--text-muted); padding-top: 3px; line-height: 1.35; }
.setting-item-control { flex: 0 0 auto; display: flex; gap: 8px; align-items: center; }
input[type=text], input[type=date], input[type=month] { font: inherit; font-size: 14px; height: 32px; padding: 0 10px;
  width: 190px; box-sizing: border-box; border-radius: 6px; color: var(--text-normal);
  background: var(--background-modifier-form-field); border: 1px solid var(--background-modifier-border); }
input:focus { outline: none; border-color: var(--interactive-accent); }
.raw { font-family: var(--font-monospace); font-size: 12px; color: var(--text-muted); margin: 0 0 8px; }
@media (max-width: 520px) { .setting-item { flex-wrap: wrap; } .setting-item-control { width: 100%; } input[type=text], input[type=date] { width: 100%; } }
`;

const fns = ["bindMoneyInput", "parseMoneyInput", "formatMoneyInput", "fieldNote", "fieldNoteHost", "bindDateInput",
  "normalizeDate", "isISODateString", "toLocalISO", "patternReach", "describePatternReach", "bindPatternReach",
  "enableChartHover", "nearestIndexByX", "formatChartMoney", "formatChartDate"].map((n) => H[n].toString()).join("\n");

const OBSIDIAN_JS = `
HTMLElement.prototype.setAttr = function (k, v) { this.setAttribute(k, v); };
HTMLElement.prototype.addClass = function (c) { this.classList.add(c); };
HTMLElement.prototype.toggleClass = function (c, on) { this.classList.toggle(c, !!on); };
HTMLElement.prototype.setText = function (t) { this.textContent = t; };
HTMLElement.prototype.createDiv = function (o = {}) { const d = document.createElement("div"); if (o.cls) d.className = o.cls; if (o.text) d.textContent = o.text; this.appendChild(d); return d; };
// Obsidian's Setting: name and description on the left, the control on the right.
function setting(parent, name, desc) {
  const item = parent.createDiv({ cls: "setting-item" });
  const info = item.createDiv({ cls: "setting-item-info" });
  info.createDiv({ cls: "setting-item-name", text: name });
  const descEl = info.createDiv({ cls: "setting-item-description" });
  if (desc) descEl.textContent = desc;
  const control = item.createDiv({ cls: "setting-item-control" });
  const input = document.createElement("input");
  input.type = "text";
  control.appendChild(input);
  const text = { inputEl: input, setValue(v) { input.value = v == null ? "" : v; return this; }, onChange(cb) { input.addEventListener("input", () => cb(input.value)); return this; } };
  return { setting: { descEl, settingEl: item }, text, input };
}`;

const history = [
  { date: "2026-05-15", total_debt: 5820.4 }, { date: "2026-06-01", total_debt: 5512.18 },
  { date: "2026-06-15", total_debt: 5390.02 }, { date: "2026-07-01", total_debt: 5100.25 },
  { date: "2026-07-15", total_debt: 4966.9 }, { date: "2026-08-01", total_debt: 4821.5 },
  { date: "2026-08-15", total_debt: 4560.33 }, { date: "2026-09-01", total_debt: 4213.07 }
];
const chart = H.buildDebtChart(history, { zeroDate: "2027-07-10", perDay: 14.2 });

const txs = [
  { merchant_raw: "RIGOBERTOS TACO SHOP 44" }, { merchant_raw: "RIGOBERTOS TACO SHOP 45" },
  { merchant_raw: "TACO BELL 9" }, { merchant_raw: "TACO BELL 12" }, { merchant_raw: "TACOS EL GORDO" }
];
const rules = [{ merchant_pattern: "TACO BELL", home_label: "Eating Out", display_name: "Taco Bell" }];

const body = `
<div class="modal"><h2>Categorize transaction</h2>
  <p class="raw">RIGOBERTOS TACO SHOP 44</p><div id="label"></div></div>
<div class="modal"><h2>Enter Paycheck</h2><div id="paycheck"></div></div>
<div class="modal" style="padding-bottom:12px"><h2>Total debt progress</h2>
  <div id="wrap" class="budget-chart-wrap budget-debt-chart-wrap">${chart}</div></div>
<script>${OBSIDIAN_JS}\n${fns}
  const TXS = ${JSON.stringify(txs)}, RULES = ${JSON.stringify(rules)};
  // Pattern field, partway through being widened.
  const p = setting(document.getElementById("label"), "Pattern to match",
    "Future transactions containing this text will auto-categorize. Shorten it so it'll actually match next time.");
  const reach = bindPatternReach(p.setting, { transactions: TXS, rules: RULES, sample: "RIGOBERTOS TACO SHOP 44" });
  p.text.setValue("TACO").onChange((v) => reach(v));
  reach("TACO");
  const nick = setting(document.getElementById("label"), "Display nickname (optional)", "A clean name shown everywhere in the UI.");

  // Paycheck: one field mid-typo, one tidied, the payday a picker.
  const a = setting(document.getElementById("paycheck"), "Paycheck amount");
  bindMoneyInput(a.text, a.setting);
  a.input.value = "1,1OO.00"; a.input.dispatchEvent(new Event("input"));
  const c = setting(document.getElementById("paycheck"), "Current checking balance", "Your actual balance right now, whatever the account says today.");
  bindMoneyInput(c.text, c.setting, { allowNegative: true });
  c.input.value = "1234.5"; c.input.dispatchEvent(new Event("input")); c.input.dispatchEvent(new Event("blur"));
  const d = setting(document.getElementById("paycheck"), "Next expected payday", "Filled in from your pay schedule (biweekly). Only change this for an off-cycle check.");
  bindDateInput(d.text, "2026-10-06");

  window.hover = enableChartHover(document.getElementById("wrap"));
</script>`;

(async () => {
  const { chromium } = require("playwright");
  const browser = await chromium.launch();
  for (const [scheme, width, tag, pick] of [["dark", 700, "wide", 5], ["light", 700, "wide", 5], ["dark", 400, "mobile", 8]]) {
    const page = await browser.newPage({ viewport: { width, height: 1300 }, deviceScaleFactor: 2 });
    await page.setContent(`<!doctype html><html><head><meta charset="utf-8"><style>${THEME}\n${css}\n${OBSIDIAN_CSS}</style></head>` +
      `<body class="theme-${scheme}">${body}</body></html>`);
    await page.evaluate((i) => window.hover.show(i), pick);
    await page.waitForTimeout(120);
    const file = path.join(OUT, `inputs-${tag}-${scheme}.png`);
    await page.screenshot({ path: file, fullPage: true });
    const m = await page.evaluate(() => {
      const tip = document.querySelector(".budget-chart-tip").getBoundingClientRect();
      const wrap = document.getElementById("wrap").getBoundingClientRect();
      const overflow = document.documentElement.scrollWidth > window.innerWidth;
      const notes = [...document.querySelectorAll(".budget-field-note")].map((n) => n.textContent);
      return { tipInside: tip.left >= wrap.left - 0.5 && tip.right <= wrap.right + 0.5, overflow, notes };
    });
    console.log(file.split("/").pop(), JSON.stringify(m));
    await page.close();
  }
  await browser.close();
})();
