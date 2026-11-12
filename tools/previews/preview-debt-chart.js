// The debt chart with a big new debt on the end of a small history: scaled to the
// long side, the new debt's point on the top edge. Screenshots to the folder
// given (default .preview/). Set PW_EXECUTABLE if Playwright's own Chromium isn't
// the one installed.
const fs = require("fs");
const path = require("path");
const P = require("../../tests/paths.js");
global.document = { body: { classList: { contains: () => false } } };
const H = require(P.TESTS + "/harness.js");

const OUT = process.argv[2] || path.join(P.ROOT, ".preview");
fs.mkdirSync(OUT, { recursive: true });

const T = H.todayLocal();
const hist = [];
let v = 3049;
for (let i = 0; i < 34; i++) {
  v += [-40, -25, 10, -60, 5, -30, 20, -15][i % 8];
  hist.push({ date: H.addDays(T, -66 + i * 2), total_debt: Math.round(v * 100) / 100 });
}
hist.push({ date: T, total_debt: 16055.42 });

const css = fs.readFileSync(path.join(P.ROOT, "styles.css"), "utf8");
const THEME = `.theme-dark{--background-primary:#1e1e1e;--background-secondary:#262626;--background-modifier-border:#3a3a3a;--text-normal:#dadada;--text-muted:#a0a0a0;--text-faint:#6a6a6a;--text-accent:#a78bfa;--interactive-accent:#7b6cd9;--radius-s:6px;--font-ui-medium:15px}
body{margin:0;background:var(--background-primary);color:var(--text-normal);font-family:system-ui,sans-serif}
.card{margin:12px;padding:14px;background:var(--background-secondary);border:1px solid var(--background-modifier-border);border-radius:10px}
.card h4{margin:0 0 6px}`;

(async () => {
  const { chromium } = require("playwright");
  const browser = await chromium.launch(process.env.PW_EXECUTABLE ? { executablePath: process.env.PW_EXECUTABLE } : {});
  const shots = [
    ["before", H.buildDebtChart(hist, null, { zoom: false }), "Total debt progress, whole scale"],
    ["after", H.buildDebtChart(hist, null, { zoom: true }), "Total debt progress, scaled to the long side"]
  ];
  for (const [name, svg, title] of shots) {
    const page = await browser.newPage({ viewport: { width: 390, height: 360 }, deviceScaleFactor: 3 });
    await page.setContent(`<!doctype html><html><head><meta charset="utf-8"><style>${THEME}\n${css}</style></head><body class="theme-dark"><div class="card"><h4>${title}</h4><div class="budget-chart-wrap budget-debt-chart-wrap">${svg}</div></div></body></html>`);
    await page.screenshot({ path: path.join(OUT, `debt-chart-${name}.png`) });
    console.log("wrote", `debt-chart-${name}.png`);
    await page.close();
  }
  await browser.close();
})();
