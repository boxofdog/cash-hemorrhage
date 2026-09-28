// 1.21.0 — the Portfolio chart's hover readout and the trend chart's sandwich,
// driven in a real browser: pointer, clicks, keys, the animation's end states,
// and the rendered label boxes (which the layout only estimates).
const P = require("./paths.js");
global.document = { body: { classList: { contains: () => false } } };
const fs = require("fs");
const path = require("path");
const H = require(P.TESTS + "/harness.js");
const OUT = P.OUT + "/shots-v121";
fs.mkdirSync(OUT, { recursive: true });

let pass = 0, fail = 0;
function check(name, got, want) {
  const ok = JSON.stringify(got) === JSON.stringify(want);
  if (ok) { pass++; console.log(`  PASS  ${name}`); }
  else { fail++; console.log(`  FAIL  ${name}: got ${JSON.stringify(got)}, want ${JSON.stringify(want)}`); }
}

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

const FNS = ["buildDebtChart", "buildPortfolioChart", "enableChartHover", "formatChartMoney", "formatChartDate", "nearestIndexByX",
  "formatMoneyInput", "escapeAttr", "monthLabel", "toLocalISO", "setSvgContent", "buildTrendChart", "trendSandwichLayout", "enableTrendSandwich"]
  .map((n) => H[n].toString()).join("\n");
const CONSTS = `const TREND_W = ${H.TREND_W}; const TREND_H = ${H.TREND_H}; const TREND_PAD = ${JSON.stringify(H.TREND_PAD)}; const TREND_SANDWICH = ${JSON.stringify(H.TREND_SANDWICH)};`;
const CSS = fs.readFileSync(P.STYLES, "utf8");

const SERIES = [
  { key: "2026-04", label: "04/26", total: 812.4 }, { key: "2026-05", label: "05/26", total: 1204.9 },
  { key: "2026-06", label: "06/26", total: 640 }, { key: "2026-07", label: "07/26", total: 990.12 },
  { key: "2026-08", label: "08/26", total: 1103.37 }, { key: "2026-09", label: "09/26", total: 0 }
];
const COLORS = H.PIE_COLORS;
const ROWS = {
  "2026-05": [["Eating Out", 402.2], ["Groceries", 288.1], ["Subscriptions", 160.55], ["Clothes/Luxuries", 120], ["Snacks", 88.4],
    ["Entertainment", 70.25], ["Hobbies", 40], ["Games", 21.4], ["Books", 14]],
  "2026-04": [["Eating Out", 812.4]]
};

function page(body, scheme) {
  return `<!doctype html><html><head><meta charset="utf-8"><style>${THEME}\n${CSS}\n.card{max-width:900px}</style></head>` +
    `<body class="theme-${scheme}"><div class="budget-card card">${body}</div><script>${FNS}\n${CONSTS}\n` +
    `window.SERIES = ${JSON.stringify(SERIES)}; window.ROWS = ${JSON.stringify(ROWS)}; window.COLORS = ${JSON.stringify(COLORS)};</script></body></html>`;
}

(async () => {
  const { chromium } = require("playwright");
  const browser = await chromium.launch();

  // =========================================================================
  console.log("\n1. Portfolio chart: hover, touch and keys");
  {
    const p = await browser.newPage({ viewport: { width: 960, height: 600 }, deviceScaleFactor: 2 });
    const errors = [];
    p.on("pageerror", (e) => errors.push(e.message));
    await p.setContent(page(`<div class="budget-chart-wrap budget-debt-chart-wrap" id="pf"></div><div class="budget-chart-wrap budget-debt-chart-wrap" id="debt"></div>`, "light"));
    await p.evaluate(() => {
      const pf = document.getElementById("pf");
      setSvgContent(pf, buildPortfolioChart([{ month: "2026-03", value: 52700 }, { month: "2026-04", value: 53400 }, { month: "2026-05", value: 54100 }, { month: "2026-06", value: 119876.67 }, { month: "2026-07", value: 120500 }, { month: "2026-08", value: 123876.67 }]));
      window.pfHover = enableChartHover(pf);
      const d = document.getElementById("debt");
      setSvgContent(d, buildDebtChart([{ date: "2026-06-01", total_debt: 9000 }, { date: "2026-09-01", total_debt: 7000 }], null));
      enableChartHover(d);
    });
    check("hover wiring attached", await p.evaluate(() => !!window.pfHover && window.pfHover.points.length), 6);
    const pt = await p.evaluate(() => { const r = document.querySelectorAll("#pf .budget-chart-pt")[3].getBoundingClientRect(); return { x: r.x + r.width / 2, y: r.y + r.height / 2 }; });
    await p.mouse.move(pt.x + 4, pt.y + 30);
    const tip = () => p.evaluate(() => { const t = document.querySelector("#pf .budget-chart-tip"); return t.hidden ? null : [t.querySelector(".budget-chart-tip-value").textContent, t.querySelector(".budget-chart-tip-date").textContent]; });
    check("hovering near June snaps to it and reads it out", await tip(), ["$119,876.67", "End of June 2026"]);
    check("the crosshair shows", await p.evaluate(() => document.querySelector("#pf .budget-chart-focus").getAttribute("visibility")), "visible");
    await p.screenshot({ path: path.join(OUT, "pf-hover.png"), clip: await p.evaluate(() => { const r = document.getElementById("pf").getBoundingClientRect(); return { x: r.x - 10, y: r.y - 10, width: r.width + 20, height: r.height + 20 }; }) });
    await p.mouse.move(5, 5);
    check("leaving hides it", await tip(), null);
    await p.focus("#pf svg");
    check("focus shows the latest month", await tip(), ["$123,876.67", "End of August 2026"]);
    await p.keyboard.press("ArrowLeft");
    check("← steps back a month", await tip(), ["$120,500.00", "End of July 2026"]);
    await p.keyboard.press("Home");
    check("Home jumps to the first", await tip(), ["$52,700.00", "End of March 2026"]);
    await p.keyboard.press("Escape");
    check("Escape clears", await tip(), null);
    const dpt = await p.evaluate(() => { const r = document.querySelectorAll("#debt .budget-chart-pt")[1].getBoundingClientRect(); return { x: r.x + r.width / 2, y: r.y + r.height / 2 }; });
    await p.mouse.move(dpt.x, dpt.y);
    check("the debt chart still reads a date", await p.evaluate(() => document.querySelector("#debt .budget-chart-tip-date").textContent), "Sep 1, 2026");
    check("no page errors", errors, []);
    await p.close();
  }

  // =========================================================================
  console.log("\n2. The sandwich: open, read, close");
  const setup = async (scheme = "light", opts = "{}", rowsFor = null) => {
    const p = await browser.newPage({ viewport: { width: 960, height: 700 }, deviceScaleFactor: 2 });
    p.errors = [];
    p.on("pageerror", (e) => p.errors.push(e.message));
    await p.setContent(page(`<h4>Discretionary spend by month</h4><div class="budget-chart-wrap budget-trend-wrap" id="trend"></div>`, scheme));
    await p.evaluate(([o, extra]) => {
      if (extra) Object.assign(ROWS, extra);
      const wrap = document.getElementById("trend");
      setSvgContent(wrap, buildTrendChart(SERIES, null));
      window.log = [];
      window.narrowNow = false;
      const breakdown = (key) => {
        const rows = (ROWS[key] || []).map(([name, amount], i) => ({ name, amount, color: COLORS[i % COLORS.length] }));
        const total = rows.reduce((s, r) => s + r.amount, 0);
        rows.forEach((r) => (r.pct = (r.amount / total) * 100));
        return { rows, total, title: monthLabel(key) };
      };
      window.sw = enableTrendSandwich(wrap, Object.assign({
        breakdown,
        onToggle: (k) => window.log.push(["toggle", k]),
        narrow: () => window.narrowNow,
        onNarrow: (k) => window.log.push(["narrow", k])
      }, o));
    }, [JSON.parse(opts), rowsFor]);
    return p;
  };
  const settle = (p) => p.waitForFunction(() => !window.sw.busy, null, { timeout: 5000 });
  const barAt = (p, key) => p.evaluate((k) => { const r = document.querySelector(`.budget-trend-bar[data-month="${k}"]`).getBoundingClientRect(); return { x: r.x + r.width / 2, y: r.y + r.height / 2 }; }, key);
  const bar = (p, key) => p.evaluate((k) => { const b = document.querySelector(`.budget-trend-bar[data-month="${k}"]`); return ["x", "y", "width", "height"].map((a) => Math.round(Number(b.getAttribute(a)) * 10) / 10); }, key);
  const viewH = (p) => p.evaluate(() => Number(document.querySelector("svg.budget-trend-chart").getAttribute("viewBox").split(" ")[3]));
  {
    const p = await setup();
    const orig = await bar(p, "2026-05");
    const at = await barAt(p, "2026-05");
    await p.mouse.click(at.x, at.y);
    await p.waitForTimeout(170);
    await p.screenshot({ path: path.join(OUT, "sandwich-mid-1.png") });
    await p.waitForTimeout(330);
    await p.screenshot({ path: path.join(OUT, "sandwich-mid-2.png") });
    await settle(p);
    await p.screenshot({ path: path.join(OUT, "sandwich-open-light.png") });
    check("open, and remembered", [await p.evaluate(() => window.sw.openKey), await p.evaluate(() => window.log)], ["2026-05", [["toggle", "2026-05"]]]);
    check("the bar has slid to the left and stands the plot's full height", await bar(p, "2026-05"), [14, 14, 120, 158]);
    check("the chart keeps its height", await viewH(p), 200);
    const faded = await p.evaluate(() => [...document.querySelectorAll(".budget-trend-month:not(.is-open)")].map((g) => getComputedStyle(g).opacity));
    check("the other months have faded out", [...new Set(faded)], ["0"]);
    check("so has the grid", await p.evaluate(() => getComputedStyle(document.querySelector(".budget-trend-grid")).opacity), "0");
    const slices = await p.evaluate(() => [...document.querySelectorAll(".budget-trend-slice")].map((s) => [s.getAttribute("data-category"), Number(s.getAttribute("y"))]));
    check("a slice per category, stacked top to bottom, biggest first", [slices.map((s) => s[0]), slices.every((s, i) => i === 0 || s[1] > slices[i - 1][1])], [ROWS["2026-05"].map((r) => r[0]), true]);
    check("a callout per category", await p.evaluate(() => [...document.querySelectorAll(".budget-trend-slice-name")].map((t) => t.textContent)), ROWS["2026-05"].map((r) => r[0]));
    check("each reads its amount and share", await p.evaluate(() => document.querySelectorAll(".budget-trend-slice-figure")[0].textContent), "$402.20 · 33%");
    check("the heading says what it is and how to close it", await p.evaluate(() => document.querySelector(".budget-trend-heading").textContent), "May 2026 · $1204.90 discretionary · click to close");
    // What the browser actually drew: callouts to the right of the pillar, in
    // order, not overlapping, inside the chart.
    const boxes = await p.evaluate(() => {
      const names = [...document.querySelectorAll(".budget-trend-slice-name")];
      const figs = [...document.querySelectorAll(".budget-trend-slice-figure")];
      return names.map((n, i) => {
        const a = n.getBBox(), b = figs[i].getBBox();
        return { name: n.textContent, x0: a.x, x1: b.x + b.width, y0: Math.min(a.y, b.y), y1: Math.max(a.y + a.height, b.y + b.height), nameEnd: a.x + a.width, figStart: b.x };
      });
    });
    const clash = [];
    boxes.forEach((a, i) => boxes.slice(i + 1).forEach((b) => { if (a.y0 < b.y1 - 0.5 && a.y1 > b.y0 + 0.5) clash.push([a.name, b.name]); }));
    check("no two callouts overlap", clash, []);
    check("every callout right of the pillar and inside the chart", boxes.every((b) => b.x0 > 134 && b.x1 <= 640 && b.y0 >= 0 && b.y1 <= 200), true);
    check("no name runs into its amount", boxes.every((b) => b.nameEnd + 6 < b.figStart), true);
    const leaders = await p.evaluate(() => [...document.querySelectorAll(".budget-trend-tick")].map((l) => l.getAttribute("points").split(" ").map((pt) => pt.split(",").map(Number))));
    check("each leader starts at the pillar's right edge and runs right", leaders.every((pts) => pts[0][0] === 134 && pts.at(-1)[0] > pts[0][0]), true);
    // Pointing at a thin slice's callout lights the slice, and dims the rest.
    const row = await p.evaluate(() => { const r = document.querySelectorAll(".budget-trend-label-hit")[7].getBoundingClientRect(); return { x: r.x + 60, y: r.y + r.height / 2 }; });
    await p.mouse.move(row.x, row.y);
    await p.waitForTimeout(180);
    check("pointing at a callout lights its layer, and dims the others", await p.evaluate(() => [...document.querySelectorAll(".budget-trend-layer")].map((l) => [l.classList.contains("is-hot"), getComputedStyle(l).opacity]).filter((x, i) => i === 7 || i === 0)), [[false, "0.45"], [true, "1"]]);
    const top = await p.evaluate(() => { const r = document.querySelectorAll(".budget-trend-slice")[0].getBoundingClientRect(); return { x: r.x + r.width / 2, y: r.y + r.height / 2 }; });
    await p.mouse.move(top.x, top.y);
    await p.waitForTimeout(180);
    check("pointing at a slice does the same", await p.evaluate(() => [...document.querySelectorAll(".budget-trend-layer")].map((l) => l.classList.contains("is-hot"))), [true, false, false, false, false, false, false, false, false]);
    await p.screenshot({ path: path.join(OUT, "sandwich-hover.png") });
    check("its figures are in its tooltip", await p.evaluate(() => document.querySelectorAll(".budget-trend-slice")[6].querySelector("title").textContent), "Hobbies: $40.00 (3%)");
    // A faded month can't be clicked through.
    const hidden = await barAt(p, "2026-07");
    await p.mouse.click(hidden.x, hidden.y);
    await p.waitForTimeout(100);
    check("clicking where a faded month was doesn't open it", await p.evaluate(() => window.sw.openKey), "2026-05");
    // Clicking the sandwich closes it.
    await p.mouse.click(top.x, top.y);
    await p.waitForTimeout(260);
    await p.screenshot({ path: path.join(OUT, "sandwich-closing.png") });
    await settle(p);
    check("clicking the sandwich closes it", [await p.evaluate(() => window.sw.openKey), (await p.evaluate(() => window.log)).at(-1)], [null, ["toggle", null]]);
    check("the bar is back in its slot, its own size", await bar(p, "2026-05"), orig);
    check("the other months are back", [...new Set(await p.evaluate(() => [...document.querySelectorAll(".budget-trend-month")].map((g) => getComputedStyle(g).opacity)))], ["1"]);
    check("the stage is empty again", await p.evaluate(() => document.querySelector(".budget-trend-stage").childNodes.length), 0);
    check("no page errors", p.errors, []);
    await p.close();
  }

  // =========================================================================
  console.log("\n3. Many categories, keyboard, double clicks, narrow screens, reduced motion");
  {
    const eighteen = Array.from({ length: 18 }, (_, i) => [`Category ${i + 1}`, Math.round((300 / (i + 1) + 4) * 100) / 100]);
    let p = await setup("light", "{}", { "2026-06": eighteen });
    const b6 = await barAt(p, "2026-06");
    await p.mouse.click(b6.x, b6.y);
    await settle(p);
    const tall = await viewH(p);
    check("eighteen categories: the chart grows to give each a row", tall, 14 + 18 * H.TREND_SANDWICH.minRowH + 28);
    check("…every one labelled", await p.evaluate(() => document.querySelectorAll(".budget-trend-slice-name").length), 18);
    const boxes = await p.evaluate(() => [...document.querySelectorAll(".budget-trend-slice-name")].map((n) => { const a = n.getBBox(); return [a.y, a.y + a.height]; }));
    check("…none overlapping", boxes.every((b, i) => i === 0 || b[0] >= boxes[i - 1][1] - 0.5), true);
    await p.screenshot({ path: path.join(OUT, "sandwich-18.png") });
    const s0 = await p.evaluate(() => { const r = document.querySelector(".budget-trend-slice").getBoundingClientRect(); return { x: r.x + r.width / 2, y: r.y + r.height / 2 }; });
    await p.mouse.click(s0.x, s0.y);
    await settle(p);
    check("…and back to its own height when closed", await viewH(p), 200);
    await p.close();

    p = await setup();
    await p.focus('.budget-trend-bar[data-month="2026-05"]');
    await p.keyboard.press("Enter");
    await settle(p);
    await p.waitForTimeout(30);
    check("Enter opens it and moves focus into it", [await p.evaluate(() => window.sw.openKey), await p.evaluate(() => document.activeElement.getAttribute("class"))], ["2026-05", "budget-trend-sandwich"]);
    check("which says what's in it", /^May 2026 · \$1204\.90 discretionary\. Eating Out \$402\.20, Groceries/.test(await p.evaluate(() => document.activeElement.getAttribute("aria-label"))), true);
    check("the bar says it's expanded", await p.evaluate(() => document.querySelector('.budget-trend-bar[data-month="2026-05"]').getAttribute("aria-expanded")), "true");
    await p.keyboard.press("Escape");
    await settle(p);
    await p.waitForTimeout(30);
    check("Escape closes it and puts focus back on the bar", [await p.evaluate(() => window.sw.openKey), await p.evaluate(() => document.activeElement.getAttribute("data-month"))], [null, "2026-05"]);

    const at = await barAt(p, "2026-04");
    await p.mouse.click(at.x, at.y);
    await p.waitForTimeout(60);
    await p.mouse.click(at.x, at.y);
    await settle(p);
    check("a second click mid-animation doesn't flip it back", await p.evaluate(() => window.sw.openKey), "2026-04");
    check("one category fills the pillar", await p.evaluate(() => [...document.querySelectorAll(".budget-trend-slice")].map((s) => Math.round(Number(s.getAttribute("height"))))), [158]);
    await p.evaluate(() => window.sw.close({ instant: true }));
    await p.close();

    p = await setup();
    await p.evaluate(() => (window.narrowNow = true));
    const b = await barAt(p, "2026-05");
    await p.mouse.click(b.x, b.y);
    await p.waitForTimeout(100);
    check("on a narrow screen it hands over to the list instead", [await p.evaluate(() => window.sw.openKey), await p.evaluate(() => window.log)], [null, [["narrow", "2026-05"]]]);
    await p.close();

    p = await setup("light", '{"reducedMotion": true}');
    const b2 = await barAt(p, "2026-05");
    await p.mouse.click(b2.x, b2.y);
    await p.waitForTimeout(20);
    check("reduced motion: open at once", [await p.evaluate(() => window.sw.busy), await p.evaluate(() => window.sw.openKey)], [false, "2026-05"]);
    await p.close();

    p = await setup();
    await p.evaluate(() => window.sw.open("2026-05", { instant: true }));
    check("re-rendered with a month open: shown open, no animation", [await p.evaluate(() => window.sw.busy), await bar(p, "2026-05")], [false, [14, 14, 120, 158]]);
    await p.close();

    p = await setup();
    const short = await bar(p, "2026-06");
    await p.evaluate(() => window.sw.open("2026-06", { instant: true }));
    check("a short month's bar stretches to the plot's full height too", [short[3] < 100, await bar(p, "2026-06")], [true, [14, 14, 120, 158]]);
    check("another month can't be opened over it", [await p.evaluate(() => window.sw.open("2026-05", { instant: true })), await p.evaluate(() => window.sw.openKey)], [false, "2026-06"]);
    await p.evaluate(() => window.sw.close({ instant: true }));
    check("closed, it's its own height again", await bar(p, "2026-06"), short);
    await p.close();

    p = await setup("dark");
    await p.evaluate(() => window.sw.open("2026-09", { instant: true }));
    check("a month with nothing spent: a plain pillar, and it says so", [await p.evaluate(() => document.querySelectorAll(".budget-trend-slice").length), await p.evaluate(() => document.querySelector(".budget-trend-heading").textContent)], [0, "September 2026: no discretionary spending · click to close"]);
    await p.evaluate(() => window.sw.close({ instant: true }));
    await p.evaluate(() => window.sw.open("2026-05", { instant: true }));
    await p.screenshot({ path: path.join(OUT, "sandwich-open-dark.png") });
    check("no page errors", p.errors, []);
    await p.close();
  }

  // =========================================================================
  console.log("\n4. 1.22.0: palette, silhouette, gaps, one motion, light type");
  {
    const PAL = H.PIE_COLORS;
    let p = await browser.newPage({ viewport: { width: 600, height: 300 } });
    await p.setContent(`<div id="t"></div>`);
    // Measured by the browser: each colour against the dark card.
    const ratios = await p.evaluate((pal) => {
      const lum = (hex) => { const c = [1, 3, 5].map((i) => parseInt(hex.slice(i, i + 2), 16) / 255).map((v) => (v <= 0.03928 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4)); return 0.2126 * c[0] + 0.7152 * c[1] + 0.0722 * c[2]; };
      const bg = lum("#262626");
      return pal.map((h) => (lum(h) + 0.05) / (bg + 0.05));
    }, PAL);
    check("eighteen colours, led by the UI's lavender and cyan", [PAL.length, PAL[0], PAL[1]], [18, "#A28AF6", "#4ECCCC"]);
    check("every one clears 3:1 against the dark card", ratios.every((r) => r >= 3), true);
    await p.close();

    p = await setup("dark");
    const short = await bar(p, "2026-06");
    const b = await barAt(p, "2026-06");
    await p.mouse.click(b.x, b.y);
    await p.waitForTimeout(210);
    const mid = await bar(p, "2026-06");
    check("an older month's grey bar takes the accent as it opens", await p.evaluate(() => document.querySelector('.budget-trend-bar[data-month="2026-06"]').getAttribute("fill")), "var(--text-accent, #7b6cd9)");
    check("one motion: mid-way it's both moving left and stretching up", [mid[0] < short[0] && mid[0] > 14, mid[3] > short[3] && mid[3] < 158, mid[1] < short[1] && mid[1] > 14], [true, true, true]);
    await p.screenshot({ path: path.join(OUT, "stretch-mid.png") });
    await settle(p);
    const clip = await p.evaluate(() => {
      const g = document.querySelector(".budget-trend-slices");
      const id = (g.getAttribute("clip-path").match(/url\(#([^)]+)\)/) || [])[1];
      const r = document.getElementById(id).querySelector("rect");
      return { inStage: !!document.querySelector(".budget-trend-stage").contains(r), rect: ["x", "y", "width", "height", "rx"].map((a) => Number(r.getAttribute(a))), slices: g.querySelectorAll(".budget-trend-slice").length };
    });
    check("the slices are clipped to the expanded bar's rounded silhouette", clip, { inStage: true, rect: [14, 14, 120, 158, 6], slices: 0 });
    check("the bar's own corners end the same", await p.evaluate(() => Number(document.querySelector('.budget-trend-bar[data-month="2026-06"]').getAttribute("rx"))), 6);
    await p.evaluate(() => window.sw.close({ instant: true }));
    check("…and gives it back when closed", await p.evaluate(() => document.querySelector('.budget-trend-bar[data-month="2026-06"]').getAttribute("fill")), "var(--background-modifier-border)");
    await p.evaluate(() => window.sw.open("2026-05", { instant: true }));
    const cut = await p.evaluate(() => [...document.querySelectorAll(".budget-trend-slices .budget-trend-slice")].map((r) => [Number(r.getAttribute("y")), Number(r.getAttribute("height"))]));
    check("a slice per category inside the clip", cut.length, 9);
    check("a 1px cut between every pair of layers", cut.slice(1).every((c, i) => Math.abs(c[0] - (cut[i][0] + cut[i][1]) - 1) < 0.02), true);
    check("the last runs to the bottom of the pillar", Math.round((cut.at(-1)[0] + cut.at(-1)[1]) * 100) / 100, 172);
    const ids = await p.evaluate(() => {
      const w2 = document.createElement("div");
      w2.className = "budget-chart-wrap budget-trend-wrap";
      document.querySelector(".card").appendChild(w2);
      setSvgContent(w2, buildTrendChart(SERIES, null));
      const s2 = enableTrendSandwich(w2, { breakdown: () => ({ rows: [{ name: "A", amount: 1, pct: 100, color: "#7B6CD9" }], total: 1, title: "x" }) });
      return s2.open("2026-05", { instant: true }).then(() => [...document.querySelectorAll("clipPath")].map((c) => c.id));
    });
    check("each chart's clip has its own id", new Set(ids).size, ids.length);
    const type = await p.evaluate(() => {
      const n = document.querySelector(".budget-trend-slice-name"), f = document.querySelector(".budget-trend-slice-figure");
      const cs = (e) => getComputedStyle(e);
      return [cs(n).fontWeight, cs(n).fontSize, cs(f).fontWeight, cs(f).fontSize];
    });
    check("names and figures in regular weight, small (9.5 and 9 chart units)", type, ["400", "9.5px", "400", "9px"]);
    const s3 = await p.evaluate(() => { const r = document.querySelectorAll(".budget-trend-slices .budget-trend-slice")[2].getBoundingClientRect(); return { x: r.x + r.width / 2, y: r.y + r.height / 2 }; });
    await p.mouse.move(s3.x, s3.y);
    await p.waitForTimeout(150);
    check("pointing at a slice lights it and its callout, and dims the rest", await p.evaluate(() => [
      document.querySelectorAll(".budget-trend-slices .budget-trend-slice")[2].classList.contains("is-hot"),
      document.querySelectorAll(".budget-trend-layer")[2].classList.contains("is-hot"),
      getComputedStyle(document.querySelectorAll(".budget-trend-slices .budget-trend-slice")[0]).opacity,
      getComputedStyle(document.querySelectorAll(".budget-trend-layer")[0]).opacity
    ]), [true, true, "0.45", "0.45"]);
    await p.mouse.move(5, 5);
    await p.waitForTimeout(100);
    await p.screenshot({ path: path.join(OUT, "polished-dark.png") });
    check("no page errors", p.errors, []);
    await p.close();
    p = await setup("light");
    await p.evaluate(() => window.sw.open("2026-05", { instant: true }));
    await p.screenshot({ path: path.join(OUT, "polished-light.png") });
    await p.close();
  }

  await browser.close();
  console.log(`\n${pass} passed, ${fail} failed`);
  process.exit(fail ? 1 : 0);
})().catch((e) => { console.error(e); process.exit(1); });
