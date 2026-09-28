// 1.21.0 — the Portfolio chart's hover readout, and the Insights trend chart's
// sandwich drilldown: the pure parts, in Node. test-charts-browser.js drives
// the pointer, keyboard and animation in a real browser.
const P = require("./paths.js");
global.document = { body: { classList: { contains: () => false } }, importNode: (n) => n };
global.DOMParser = class { parseFromString(str) { return { getElementsByTagName: () => [], documentElement: { outerHTML: str, children: [], text: "" } }; } };
const H = require("./harness.js");
const OLD = require("./harness-for.js")(P.BASELINES + "/main.v121-before.js");
const { el, allText } = H;

let pass = 0, fail = 0;
function check(name, got, want) {
  const ok = JSON.stringify(got) === JSON.stringify(want);
  if (ok) { pass++; console.log(`  PASS  ${name}`); }
  else { fail++; console.log(`  FAIL  ${name}: got ${JSON.stringify(got)}, want ${JSON.stringify(want)}`); }
}
const find = (n, pred, out = []) => { if (pred(n)) out.push(n); (n.children || []).forEach((c) => find(c, pred, out)); return out; };
const byCls = (n, cls) => find(n, (x) => x.classes && x.classes.has(cls));
const attrs = (svg, cls) => [...svg.matchAll(new RegExp(`<[a-z]+ class="${cls}[^"]*"[^>]*>`, "g"))].map((m) => {
  const o = {};
  for (const a of m[0].matchAll(/([a-z-]+)="([^"]*)"/g)) o[a[1]] = a[2];
  return o;
});

(async () => {
// ===========================================================================
console.log("\n1. The debt chart is drawn exactly as before");
{
  const hist = [{ date: "2026-06-01", total_debt: 9000 }, { date: "2026-07-15", total_debt: 8200.5 }, { date: "2026-09-01", total_debt: 7000 }];
  check("history only", H.buildDebtChart(hist, null), OLD.buildDebtChart(hist, null));
  check("with a projection", H.buildDebtChart(hist, { zeroDate: "2027-12-01", perDay: 5 }), OLD.buildDebtChart(hist, { zeroDate: "2027-12-01", perDay: 5 }));
  check("one point", H.buildDebtChart(hist.slice(0, 1), null), OLD.buildDebtChart(hist.slice(0, 1), null));
}

// ===========================================================================
console.log("\n2. The portfolio chart has the debt chart's hover layers");
{
  const svg = H.buildPortfolioChart([{ month: "2026-03", value: 52700 }, { month: "2026-06", value: 119876.67 }, { month: "2026-09", value: 123876.67 }]);
  check("crosshair group, guide, ring and hit area", ["budget-chart-focus", "budget-chart-guide", "budget-chart-ring", "budget-chart-hit"].map((c) => attrs(svg, c).length), [1, 1, 1, 1]);
  const pts = attrs(svg, "budget-chart-pt");
  check("a point per month, at the month's end", pts.map((p) => p["data-date"]), ["2026-03-31", "2026-06-30", "2026-09-30"]);
  check("each carries its value", pts.map((p) => p["data-value"]), ["52700.00", "119876.67", "123876.67"]);
  check("and what the readout calls it", pts.map((p) => p["data-label"]), ["End of March 2026", "End of June 2026", "End of September 2026"]);
  check("its own class, keeping the debt chart's for the shared styles", /class="budget-debt-chart budget-pf-chart"/.test(svg), true);
  check("named for what it is, not debt", /aria-label="Combined investment value, March 2026 to September 2026: \$52700\.00 to \$123876\.67\. Use the arrow keys to read each point\."/.test(svg), true);
  check("the axis reads months", [/>Mar 2026</.test(svg), />Sep 2026</.test(svg), />03-31</.test(svg)], [true, true, false]);
  check("focusable, for the arrow keys", /tabindex="0"/.test(svg), true);
  check("nothing to draw", H.buildPortfolioChart([]), null);
  check("labels are escaped", H.escapeAttr(`a"<b>&`), "a&quot;&lt;b&gt;&amp;");
}

{
  // The Portfolio tab itself: the new chart, in the wrapper the readout needs.
  const acct = (o) => H.normalizePortfolioAccounts([o])[0];
  const store = {};
  const files = {
    [H.FILES.portfolioAccounts]: [acct({ id: "a", provider: "Fidelity", type: "401k", label: "401k" })],
    [H.FILES.portfolioSnapshots]: [
      { account_id: "a", statement_start: "2026-06-01", statement_end: "2026-06-30", ending_value: 100 },
      { account_id: "a", statement_start: "2026-07-01", statement_end: "2026-07-31", ending_value: 120 }
    ]
  };
  Object.entries(files).forEach(([k, v]) => (store[k] = JSON.stringify(v)));
  const app = { vault: { adapter: { exists: async (p) => p in store, read: async (p) => store[p], write: async (p, d) => (store[p] = d), mkdir: async () => {}, list: async () => ({ files: [], folders: [] }) } } };
  const plugin = Object.create(H.__PluginClass.prototype);
  Object.assign(plugin, { app, refreshDashboard() {} });
  const v = Object.create(H.BudgetDashboardView.prototype);
  Object.assign(v, { app, plugin, sectionOpen: {}, scrollMemory: {} });
  const root = el("div");
  await v.renderPortfolio(root);
  const wrap = find(root, (n) => n.classes && n.classes.has("budget-chart-wrap"))[0];
  check("the Portfolio tab draws the new chart", /class="budget-debt-chart budget-pf-chart"/.test(((wrap.children || [])[0] || {}).outerHTML || ""), true);
  check("in the wrapper that positions the readout", wrap.classes.has("budget-debt-chart-wrap"), true);
}

// ===========================================================================
console.log("\n3. The trend chart: each month grouped, bars where they were");
{
  const series = [
    { key: "2026-04", label: "04/26", total: 812.4 }, { key: "2026-05", label: "05/26", total: 1204.9 },
    { key: "2026-06", label: "06/26", total: 640 }, { key: "2026-07", label: "07/26", total: 990.12 }
  ];
  const svg = H.buildTrendChart(series, "2026-05");
  const bars = attrs(svg, "budget-trend-bar");
  const oldBars = attrs(OLD.buildTrendChart(series, "2026-05"), "budget-trend-bar");
  const geo = (b) => [b["data-month"], b.x, b.y, b.width, b.height, b.fill];
  check("bars have the same months, places, sizes and colours as before", bars.map(geo), oldBars.map(geo));
  check("each month is a group holding its bar, figure and label", [...svg.matchAll(/<g class="budget-trend-month" data-month="([^"]+)">/g)].map((m) => m[1]), series.map((s) => s.key));
  check("bars can be reached by keyboard", bars.every((b) => b.tabindex === "0" && b.role === "button"), true);
  check("an empty stage for the sandwich, drawn last", /<g class="budget-trend-stage"><\/g><\/svg>$/.test(svg), true);
  check("gridlines grouped, to fade together", attrs(svg, "budget-trend-grid").length, 1);
}

// ===========================================================================
console.log("\n4. The sandwich's layout: a tall pillar, callouts to its right");
{
  const rows = [
    ["Eating Out", 420.1], ["Groceries", 300], ["Subscriptions", 120.55], ["Clothes/Luxuries", 88], ["Snacks", 40],
    ["Entertainment", 22], ["Hobbies", 9.5], ["Games", 4]
  ].map(([name, amount], i) => ({ name, amount, color: `c${i}` }));
  const total = rows.reduce((s, r) => s + r.amount, 0);
  rows.forEach((r) => (r.pct = (r.amount / total) * 100));
  const L = H.trendSandwichLayout(rows);
  const S = H.TREND_SANDWICH;
  const plotH = H.TREND_H - S.top - S.bottomPad;
  check("the pillar sits at the left, the plot's full height", L.bar, { x: S.left, y: S.top, w: S.barW, h: plotH });
  check("the chart keeps its height when the callouts fit", L.height, H.TREND_H);
  check("a slice per category, biggest at the top", L.slices.map((s) => s.name), rows.map((r) => r.name));
  check("stacked top to bottom with no gaps, filling the pillar", [
    Math.abs(L.slices[0].y - S.top) < 1e-9,
    L.slices.every((s, i) => i === 0 || Math.abs(s.y - (L.slices[i - 1].y + L.slices[i - 1].h)) < 1e-9),
    Math.abs(L.slices.at(-1).y + L.slices.at(-1).h - (S.top + plotH)) < 1e-6
  ], [true, true, true]);
  check("each as tall as its share", L.slices.every((s, i) => Math.abs(s.h - (rows[i].amount / total) * plotH) < 1e-6), true);
  check("each as wide as the pillar", L.slices.every((s) => s.x === S.left && s.w === S.barW), true);
  check("every category gets a callout", L.labels.map((l) => l.name), rows.map((r) => r.name));
  check("callouts read name, then amount and share", [L.labels[0].name, L.labels[0].figure], ["Eating Out", "$420.10 · 42%"]);
  check("eight rows fit at full row height", [L.rowH, L.height], [S.rowH, H.TREND_H]);
  const ten = H.trendSandwichLayout(Array.from({ length: 10 }, (_, i) => ({ name: `C${i}`, amount: 20 - i })));
  check("ten tighten a little rather than grow the chart", [ten.rowH, ten.height], [plotH / 10, H.TREND_H]);
  check("they keep a row apart", L.labels.every((l, i) => i === 0 || l.mid - L.labels[i - 1].mid >= L.rowH - 1e-9), true);
  check("they stay inside the plot", L.labels.every((l) => l.mid - L.rowH / 2 >= S.top - 1e-9 && l.mid + L.rowH / 2 <= S.top + plotH + 1e-9), true);
  const few = H.trendSandwichLayout(rows.slice(0, 4));
  check("with room to spare, a slice's callout sits level with it", few.labels.map((l, i) => Math.abs(l.mid - few.slices[i].cy) < 1e-9 || i > 1), [true, true, true, true]);
  check("the callouts start to the right of the pillar", L.labels.every((l) => l.nameX > S.left + S.barW), true);
  const leaders = L.labels.map((l) => l.leader);
  check("each leader runs from its slice, at the pillar's edge, to its callout", leaders.every((ld, i) =>
    ld[0][0] === S.left + S.barW && Math.abs(ld[0][1] - L.slices[i].cy) < 1e-9 && ld.at(-1)[1] === L.labels[i].mid && ld.at(-1)[0] < L.labels[i].nameX), true);
  check("no two leaders cross (both ends keep the same order)", L.labels.every((l, i) => i === 0 || (L.slices[i].cy > L.slices[i - 1].cy && l.mid > L.labels[i - 1].mid)), true);
  const longest = Math.max(...rows.map((r) => r.name.length));
  check("amounts line up in one column, just past the longest name", [new Set(L.labels.map((l) => l.figureX)).size, L.labels[0].figureX > L.labels[0].nameX + longest * S.nameCharW], [1, true]);
  check("…never pushed off the chart", L.labels[0].figureX <= S.right - 120, true);
  check("the amounts' column sits just past the longest name", L.labels[0].figureX, L.labels[0].nameX + 8 + longest * S.nameCharW + 24);

  // More categories than rows fit: the chart grows taller, and each keeps its callout.
  const many = Array.from({ length: 18 }, (_, i) => ({ name: `Category ${i}`, amount: 40 - i, color: "x" }));
  const M = H.trendSandwichLayout(many);
  check("eighteen categories: the chart grows to fit a (tightest) row each", [M.rowH, M.height], [S.minRowH, S.top + 18 * S.minRowH + S.bottomPad]);
  check("…the pillar grows with it", M.bar.h, 18 * S.minRowH);
  check("…and every one keeps its callout, a row apart", [M.labels.length, M.labels.every((l, i) => i === 0 || l.mid - M.labels[i - 1].mid >= M.rowH - 1e-9)], [18, true]);
  check("nothing spent: no slices, no callouts, normal height", [H.trendSandwichLayout([]).slices, H.trendSandwichLayout([]).labels, H.trendSandwichLayout([]).height], [[], [], H.TREND_H]);
  check("zero and refund rows are left out", H.trendSandwichLayout([{ name: "A", amount: 10 }, { name: "B", amount: 0 }, { name: "C", amount: -5 }]).slices.map((s) => s.name), ["A"]);
  check("rows are ordered biggest first whatever order they came in", H.trendSandwichLayout([{ name: "S", amount: 1 }, { name: "B", amount: 9 }]).slices.map((s) => s.name), ["B", "S"]);
  check("one category fills the pillar", H.trendSandwichLayout([{ name: "A", amount: 10, pct: 100 }]).slices[0].h, plotH);
}

// ===========================================================================
console.log("\n5. Insights: the list below the chart only where there's no room");
async function insights({ mobile, month }) {
  global.document.body.classList.contains = (c) => mobile && c === "is-mobile";
  const tx = (date, amount, cat) => ({ id: `${date}${cat}${amount}`, date, amount, resolved_category: cat, merchant_raw: cat });
  const allTx = [tx("2026-07-03", -120, "Eating Out"), tx("2026-08-03", -150, "Eating Out"), tx("2026-08-09", -40, "Snacks"), tx("2026-09-02", -90, "Eating Out")];
  const v = Object.create(H.BudgetDashboardView.prototype);
  Object.assign(v, { app: {}, plugin: { settings: {} }, sectionOpen: {}, scrollMemory: {}, insightsMonth: "2026-09", trendMonth: month });
  v.render = () => {};
  const root = el("div");
  await v.renderInsights(root, { allTx, categoryMetaList: [], rules: [], ownership: null });
  global.document.body.classList.contains = () => false;
  return root;
}
{
  let root = await insights({ mobile: false, month: "2026-08" });
  check("desktop, a month open: no list below the chart (it opens inside it)", byCls(root, "budget-trend-panel").length, 0);
  root = await insights({ mobile: true, month: "2026-08" });
  check("phone, a month open: the list, as before", byCls(root, "budget-trend-panel").length, 1);
  check("…listing that month's categories", /August 2026 \$190\.00 discretionary .*Eating Out.*Snacks/.test(allText(byCls(root, "budget-trend-panel")[0]).replace(/\s+/g, " ")), true);
  root = await insights({ mobile: true, month: null });
  check("phone, nothing open: no list", byCls(root, "budget-trend-panel").length, 0);
}

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
})().catch((e) => { console.error(e); process.exit(1); });
