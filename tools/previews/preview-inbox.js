// The Transactions tab in its three states — notification closed, open, and
// cleared — rendered from the real 438-transaction fixture.
const P = require("../../tests/paths.js");
global.document = { body: { classList: { contains: () => false } } };
global.requestAnimationFrame = (fn) => setTimeout(fn, 0);
const fs = require("fs");
const path = require("path");
const H = require(P.TESTS + "/harness.js");
const HF = require(P.TESTS + "/harness-for.js")(P.MAIN);
const OUT = P.OUT + "/shots-inbox";
fs.mkdirSync(OUT, { recursive: true });

const css = fs.readFileSync(P.STYLES, "utf8");
const PREVIEW = fs.readFileSync(P.PREVIEWS + "/preview.js", "utf8");
const THEME = PREVIEW.slice(PREVIEW.indexOf("const THEME = `") + 15, PREVIEW.indexOf("`;\n\nfunction makeView"));
const VOID = new Set(["input", "br", "hr", "img"]);
const esc = (s) => String(s).replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
const html = (n) => {
  const cls = [...(n.classes || [])].join(" ");
  const attrs = Object.entries(n.attrs || {}).map(([k, v]) => ` ${k}="${esc(v)}"`).join("");
  const open = `<${n.tag}${cls ? ` class="${esc(cls)}"` : ""}${attrs}${n.tag === "details" && n.open ? " open" : ""}>`;
  if (VOID.has(n.tag)) return open;
  return open + esc(n._text || "") + (n.children || []).map(html).join("") + `</${n.tag}>`;
};

const CTX = JSON.parse(fs.readFileSync(P.FIXTURES + "/fixture-ctx.json", "utf8"));

async function render(allTx, withTabs = true) {
  const v = Object.create(HF.BudgetDashboardView.prototype);
  Object.assign(v, { sectionOpen: {}, scrollMemory: {}, activeTab: "transactions", app: {}, plugin: { settings: {} } });
  v.collapsible = function (parent, id, title, meta) {
    const d = parent.createEl("details", { cls: "budget-collapsible" });
    d.open = true;
    const s = d.createEl("summary", { cls: "budget-collapsible-summary" });
    s.createSpan({ text: title, cls: "budget-collapsible-title" });
    s.createSpan({ text: meta, cls: "budget-collapsible-sub" });
    return d.createDiv({ cls: "budget-collapsible-body" });
  };
  const root = H.el("div");
  await v.renderTransactions(root, { allTx, rules: CTX.rules || [], existingLabels: [] });
  // The real tab strip above it, for context on where the badge sits.
  const tabs = withTabs
    ? `<div class="budget-tabs">${["Overview", "Debts", "Transactions", "Subscriptions", "Insights", "Portfolio"]
        .map((t) => `<button class="budget-tab${t === "Transactions" ? " budget-tab-active" : ""}">${t}</button>`).join("")}</div>`
    : "";
  return tabs + `<div id="host" class="budget-tab-body">${html(root)}</div>`;
}

(async () => {
  const withQueue = await render(CTX.allTx);
  const cleared = await render(CTX.allTx.map((t) => (t.resolved_category === "Uncategorized" ? Object.assign({}, t, { resolved_category: "Eating Out" }) : t)));
  const script = `<script>
    HTMLElement.prototype.setAttr = function (k, v) { this.setAttribute(k, v); };
    HTMLElement.prototype.toggleClass = function (c, on) { this.classList.toggle(c, !!on); };
    HTMLElement.prototype.setText = function (t) { this.textContent = t; };
    ${H.bindInboxToggle.toString()}
    const inbox = document.querySelector(".budget-inbox");
    if (inbox) bindInboxToggle({ inbox, badge: inbox.querySelector(".budget-inbox-badge"), action: inbox.querySelector(".budget-inbox-action") }, { open: false });
  </script>`;

  const { chromium } = require("playwright");
  const browser = await chromium.launch();
  const shots = [];
  for (const [scheme, width, tag] of [["dark", 1000, "wide"], ["light", 1000, "wide"], ["dark", 400, "phone"]]) {
    for (const [state, body] of [["closed", withQueue], ["open", withQueue], ["cleared", cleared]]) {
      const page = await browser.newPage({ viewport: { width, height: 1100 }, deviceScaleFactor: 2 });
      await page.setContent(`<!doctype html><html><head><meta charset="utf-8"><style>${THEME}\n${css}</style></head>` +
        `<body class="theme-${scheme}"><div class="budget-dashboard">${body}</div>${script}</body></html>`);
      await page.waitForTimeout(450);
      if (state === "open") {
        await page.click(".budget-inbox-badge");
        await page.waitForTimeout(500);
      }
      const file = path.join(OUT, `${tag}-${scheme}-${state}.png`);
      await page.screenshot({ path: file, clip: { x: 0, y: 0, width, height: Math.min(tag === "phone" ? 900 : 760, 1100) } });
      shots.push(file.split("/").pop());
      await page.close();
    }
  }
  await browser.close();
  console.log(shots.join("\n"));
})();
