// Screenshot of Enter Paycheck with its recent-deposits picker, rendered from
// the plugin's own PaycheckModal source in Obsidian's setting DOM.
const P = require("../../tests/paths.js");
const fs = require("fs");
const path = require("path");
const H = require(P.TESTS + "/harness.js");
const OUT = P.OUT + "/shots-deposits";
fs.mkdirSync(OUT, { recursive: true });
const css = fs.readFileSync(P.STYLES, "utf8");
const PREVIEW = fs.readFileSync(P.PREVIEWS + "/preview.js", "utf8");
const THEME = PREVIEW.slice(PREVIEW.indexOf("const THEME = `") + 15, PREVIEW.indexOf("`;\n\nfunction makeView"));
const SYNC = fs.readFileSync(P.PREVIEWS + "/preview-sync.js", "utf8");
const grab = (name) => { const a = SYNC.indexOf(`const ${name} = \``) + name.length + 10; return SYNC.slice(a, SYNC.indexOf("`;", a)); };
const OBSIDIAN_CSS = grab("OBSIDIAN_CSS");
const OBSIDIAN_JS = grab("OBSIDIAN_JS").replace('if (o.text) d.textContent = o.text;', 'if (o.text) d.textContent = o.text; if (o.type) d.type = o.type;').replace("addToggle(cb) {", `addExtraButton(cb) {
    const b = this.controlEl.createEl("button"); b.className = "clickable-icon"; b.textContent = "↺";
    const c = { setIcon() { return c; }, setTooltip(t) { b.title = t; return c; }, onClick(f) { b.onclick = f; return c; } };
    cb(c); return this;
  }
  addToggle(cb) {`);
const fns = ["bindMoneyInput", "parseMoneyInput", "formatMoneyInput", "fieldNote", "fieldNoteHost", "bindDateInput", "normalizeDate",
  "isISODateString", "toLocalISO", "requireMoney", "validateNextPayday", "todayLocal", "addDays", "daysBetween"].map((n) => H[n] ? H[n].toString() : `/* ${n} missing */`).join("\n");
const MODAL = H.PaycheckModal.toString();
const T = H.todayLocal();
const D = (n) => H.addDays(T, n);
const deposits = [
  { id: "a", date: D(0), merchant_raw: "ACME FOODS INC PAYROLL PPD ID 1234567890 DIRECT DEPOSIT", amount: 1748.95, resolved_category: "Uncategorized" },
  { id: "b", date: D(-1), merchant_raw: "ZELLE FROM MOM", amount: 40, resolved_category: "Uncategorized" },
  { id: "c", date: D(-2), merchant_raw: "AMAZON.COM REFUND", amount: 23.4, resolved_category: "Uncategorized", pending: true }
];
const body = (pick) => `<div class="modal" id="modal"></div>
<script>${OBSIDIAN_JS}
${fns}
function displayMerchant(raw) { return raw; }
function guessMerchantKey(raw) { return raw; }
${MODAL}
const m = new PaycheckModal({}, () => {}, { recentDeposits: ${JSON.stringify(deposits)}, rules: [],
  detectedPaycheck: { amount: 1702.1, date: "${D(-14)}", merchant_raw: "ACME FOODS INC PAYROLL" },
  checkingBalance: 912.33, scheduledNextPayday: "${D(14)}", scheduleLabel: "every 2 weeks" });
m.onOpen();
${pick != null ? `const r = document.querySelectorAll(".budget-deposit-row input")[${pick}]; r.checked = true; r.onchange();` : ""}
</script>`;

(async () => {
  const { chromium } = require("playwright");
  const browser = await chromium.launch();
  for (const [name, width, scheme, pick] of [["none-dark", 1000, "dark", null], ["picked-dark", 1000, "dark", 0], ["picked-light", 1000, "light", 0], ["picked-mobile", 400, "dark", 0]]) {
    const page = await browser.newPage({ viewport: { width, height: 900 }, deviceScaleFactor: 2 });
    const errors = [];
    page.on("pageerror", (e) => errors.push(e.message));
    await page.setContent(`<!doctype html><html><head><meta charset="utf-8"><style>${THEME}\n${css}\n${OBSIDIAN_CSS}</style></head><body class="theme-${scheme}">${body(pick)}</body></html>`);
    await page.waitForTimeout(200);
    const file = path.join(OUT, `paycheck-${name}.png`);
    await page.screenshot({ path: file, fullPage: true });
    const m = await page.evaluate(() => {
      const rows = [...document.querySelectorAll(".budget-deposit-row")].map((r) => {
        const rr = r.getBoundingClientRect();
        const amt = r.querySelector(".budget-amount");
        const a = amt ? amt.getBoundingClientRect() : null;
        return { h: Math.round(rr.height), amountInside: a ? a.right <= rr.right + 0.5 && a.left >= rr.left : null };
      });
      return { rows, overflow: document.documentElement.scrollWidth > window.innerWidth,
        amount: document.querySelector(".budget-money-input").value };
    });
    console.log(path.basename(file), errors.length ? "ERRORS " + JSON.stringify(errors) : "", JSON.stringify(m));
    await page.close();
  }
  await browser.close();
})();
