// Renders the subscriptions tab with one row in every phase-out state and
// screenshots it. Reading the CSS tells you nothing about whether a fourth
// button fits on the row or whether the accent edge reads as noise.
const P = require("../../tests/paths.js");
global.document = { body: { classList: { contains: () => false } } };
global.requestAnimationFrame = (fn) => setTimeout(fn, 0);
const fs = require("fs");
const path = require("path");

const PLUGIN = P.ROOT;
const OUT = process.argv[2] || P.OUT + "/shots-subs";
fs.mkdirSync(OUT, { recursive: true });

const H = require(P.TESTS + "/harness.js");
const HF = require(P.TESTS + "/harness-for.js")(PLUGIN + "/main.js");
const { el } = H;

// Single-source the theme block from preview.js rather than keeping a second
// copy that can drift.
const PREVIEW = fs.readFileSync(P.PREVIEWS + "/preview.js", "utf8");
const THEME = PREVIEW.slice(PREVIEW.indexOf("const THEME = `") + 15, PREVIEW.indexOf("`;\n\nfunction makeView"));

const VOID = new Set(["input", "br", "hr", "img"]);
const esc = (s) => String(s).replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
const CAMEL = (k) => k.replace(/[A-Z]/g, (m) => "-" + m.toLowerCase());
function html(n) {
  const cls = [...(n.classes || [])].join(" ");
  const style = Object.entries(n.style || {}).filter(([, v]) => v !== "" && v != null)
    .map(([k, v]) => `${CAMEL(k)}:${v}`).join(";");
  const attrs = Object.entries(n.attrs || {}).filter(([k]) => k !== "style")
    .map(([k, v]) => ` ${k}="${esc(v)}"`).join("");
  const open = `<${n.tag}${cls ? ` class="${esc(cls)}"` : ""}${style ? ` style="${esc(style)}"` : ""}${attrs}` +
    (n.tag === "details" && n.open ? " open" : "") + ">";
  if (VOID.has(n.tag)) return open;
  return open + esc(n._text || "") + (n.children || []).map(html).join("") + `</${n.tag}>`;
}

const TODAY = "2026-09-22";
const keyFor = (m) => H.subscriptionGroupKey(m, []);
let seq = 0;
const tx = (date, merchant, amount, acct = "chase", cat = "Subscription") => ({
  id: `tx-${++seq}`, date, merchant_raw: merchant, amount, account_id: acct, resolved_category: cat
});

// One row in each state the tab can show.
const TXS = [
  // confirmable — monthly, silent since June, card current
  tx("2026-04-14", "NETFLIX.COM", -15.49), tx("2026-05-14", "NETFLIX.COM", -15.49), tx("2026-06-14", "NETFLIX.COM", -15.49),
  // flagged, but the card it bills on is months behind
  tx("2026-05-03", "SPOTIFY USA", -11.99, "amex"), tx("2026-06-03", "SPOTIFY USA", -11.99, "amex"),
  // flagged, next charge simply isn't due yet
  tx("2026-08-20", "HULU 877-8244858", -17.99), tx("2026-09-20", "HULU 877-8244858", -17.99),
  // kept — nothing about phase-out should appear on it
  tx("2026-08-08", "DISNEY PLUS", -13.99), tx("2026-09-08", "DISNEY PLUS", -13.99),
  // flagged, one charge only, cadence is a guess
  tx("2026-01-10", "OBSCURE SAAS LLC", -99.0),
  // confirmed gone — should not render as a row at all
  tx("2026-02-11", "AUDIBLE*4H8D2", -14.95), tx("2026-03-11", "AUDIBLE*4H8D2", -14.95),
  // confirmed gone, then charged again
  tx("2026-03-19", "PARAMOUNT+", -12.99), tx("2026-04-19", "PARAMOUNT+", -12.99), tx("2026-09-19", "PARAMOUNT+", -12.99)
];
const REVIEWS = [
  { merchant_key: keyFor("NETFLIX.COM"), status: "cancel", cadence_override: null },
  { merchant_key: keyFor("SPOTIFY USA"), status: "cancel", cadence_override: null },
  { merchant_key: keyFor("HULU 877-8244858"), status: "cancel", cadence_override: null },
  { merchant_key: keyFor("DISNEY PLUS"), status: "keep", cadence_override: null },
  { merchant_key: keyFor("OBSCURE SAAS LLC"), status: "cancel", cadence_override: null },
  { merchant_key: keyFor("AUDIBLE*4H8D2"), status: "cancel", faded_out_at: "2026-05-01", faded_out_after: "2026-03-11" },
  { merchant_key: keyFor("PARAMOUNT+"), status: "cancel", faded_out_at: "2026-06-01", faded_out_after: "2026-04-19" }
];
const ACCOUNTS = [
  { id: "chase", institution: "Chase Freedom", last_imported_through: "2026-09-21" },
  { id: "amex", institution: "Amex Blue", last_imported_through: "2026-07-02" }
];

const REVIEWS_PATH = "Budget/data/subscription_reviews.json";

(async () => {
  const css = fs.readFileSync(PLUGIN + "/styles.css", "utf8");

  const v = Object.create(HF.BudgetDashboardView.prototype);
  Object.assign(v, {
    sectionOpen: {}, scrollMemory: {}, activeTab: "subscriptions",
    app: { vault: { adapter: {
      exists: async (p) => p === REVIEWS_PATH,
      read: async () => JSON.stringify(REVIEWS),
      write: async () => {}, mkdir: async () => {}, list: async () => ({ files: [], folders: [] })
    } } },
    collapsible(parent, id, title, meta) {
      const d = parent.createEl("details", { cls: "budget-collapsible" });
      d.open = true;
      const s = d.createEl("summary", { cls: "budget-collapsible-head" });
      s.createSpan({ text: title });
      s.createSpan({ text: meta, cls: "budget-muted" });
      return d.createDiv({ cls: "budget-collapsible-body" });
    },
    render() {},
    plugin: { settings: {}, refreshAfterDataChange: async () => {} }
  });

  // todayLocal() drives "is the expected charge in the past", so the fixture
  // dates have to be read against a fixed today rather than the real one.
  const root = el("div");
  root.classes.add("budget-dashboard");
  const realNow = Date.now;
  Date.now = () => new Date(`${TODAY}T12:00:00`).getTime();
  await v.renderSubscriptions(root, { allTx: TXS, rules: [], accounts: ACCOUNTS });
  Date.now = realNow;
  await new Promise((r) => setTimeout(r, 40));

  const body = html(root);
  const { chromium } = require("playwright");
  const browser = await chromium.launch();
  for (const [scheme, width, tag] of [["light", 1180, "wide"], ["dark", 1180, "wide"], ["dark", 400, "mobile"]]) {
    const page = await browser.newPage({ viewport: { width, height: 1000 }, deviceScaleFactor: 2 });
    await page.setContent(
      `<!doctype html><html><head><meta charset="utf-8"><style>${THEME}\n${css}</style></head>` +
        `<body class="theme-${scheme}">${body}</body></html>`
    );
    await page.waitForTimeout(150);
    const file = path.join(OUT, `subs-${tag}-${scheme}.png`);
    await page.screenshot({ path: file, fullPage: true });
    console.log("wrote", file);

    // Measure rather than eyeball: nothing may overflow the card horizontally.
    const metrics = await page.evaluate(() => {
      const out = { overflow: [], amountX: [], border: null, tap: [] };
      document.querySelectorAll(".budget-sub-row, .budget-sub-btn-col, .budget-sub-text-col").forEach((n) => {
        if (n.scrollWidth > n.clientWidth + 1) out.overflow.push([n.className, n.scrollWidth, n.clientWidth]);
      });
      document.querySelectorAll(".budget-sub-row").forEach((r) => {
        const a = r.querySelector(".budget-sub-amt-col");
        const nm = r.querySelector(".budget-sub-name span");
        if (a) out.amountX.push([(nm ? nm.textContent : "?").slice(0, 14), Math.round(a.getBoundingClientRect().right)]);
      });
      const c = document.querySelector(".budget-sub-confirmable");
      if (c) out.border = getComputedStyle(c).borderLeftWidth + " " + getComputedStyle(c).borderLeftColor;
      // The CTA must render at the same size as its siblings in the row.
      const cta = document.querySelector(".budget-sub-cta");
      const peer = document.querySelector(".budget-sub-btn-col .budget-btn");
      out.ctaSize = cta && peer
        ? [getComputedStyle(cta).fontSize, getComputedStyle(peer).fontSize,
           Math.round(cta.getBoundingClientRect().height), Math.round(peer.getBoundingClientRect().height)]
        : null;
      // And the row must not have grown a line the others do not have.
      const heights = [...document.querySelectorAll(".budget-sub-row")]
        .map((r) => [((r.querySelector(".budget-sub-name span") || {}).textContent || "?").slice(0, 12),
                     Math.round(r.getBoundingClientRect().height)]);
      out.rowHeights = heights;
      return out;
    });
    console.log("   overflow:", metrics.overflow.length ? JSON.stringify(metrics.overflow) : "none");
    console.log("   amount right edges:", JSON.stringify(metrics.amountX));
    console.log("   confirmable border:", metrics.border);
    console.log("   cta vs peer [font,font,h,h]:", JSON.stringify(metrics.ctaSize));
    console.log("   row heights:", JSON.stringify(metrics.rowHeights));
    await page.close();
  }
  await browser.close();
})();
