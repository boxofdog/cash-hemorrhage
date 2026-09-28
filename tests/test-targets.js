// 1.20.0 — Budget target rows on the Insights tab: name and Tune over spend vs
// target; what the target asks; the bar; trend vs last month and room left.
global.document = { body: { classList: { contains: () => false } } };
const H = require("./harness.js");
const { el, allText } = H;

let pass = 0, fail = 0;
function check(name, got, want) {
  const ok = JSON.stringify(got) === JSON.stringify(want);
  if (ok) { pass++; console.log(`  PASS  ${name}`); }
  else { fail++; console.log(`  FAIL  ${name}: got ${JSON.stringify(got)}, want ${JSON.stringify(want)}`); }
}
const find = (n, pred, out = []) => { if (pred(n)) out.push(n); (n.children || []).forEach((c) => find(c, pred, out)); return out; };
const byCls = (n, cls) => find(n, (x) => x.classes && x.classes.has(cls));
const text = (n) => allText(n).replace(/\s+/g, " ").trim();
const has = (n, cls) => n.classes.has(cls);

const tx = (date, amount, cat) => ({ id: `${date}-${cat}-${amount}`, date, amount, resolved_category: cat, merchant_raw: cat });

async function render(month, txs, cats) {
  const v = Object.create(H.BudgetDashboardView.prototype);
  Object.assign(v, { app: {}, plugin: { settings: {} }, sectionOpen: {}, scrollMemory: {}, insightsMonth: month });
  v.render = () => {};
  const root = el("div");
  await v.renderInsights(root, { allTx: txs, categoryMetaList: cats, rules: [], ownership: null });
  return byCls(root, "budget-target-row");
}

(async () => {
console.log("\n1. The four lines");
{
  const txs = [
    tx("2026-08-05", -153.13, "Eating Out"), // August: 153.13
    tx("2026-09-03", -207.79, "Eating Out"), // September: 207.79 vs target 145.47
    tx("2026-08-10", -327.81, "Snacks"),
    tx("2026-09-10", -42.22, "Snacks"),      // target 120 → 77.78 left... see below
    tx("2026-09-12", -30, "Hobbies")         // no August spend at all
  ];
  const cats = [
    { name: "Eating Out", monthly_target: 145.47 },
    { name: "Snacks", monthly_target: 120 },
    { name: "Hobbies", monthly_target: 50 }
  ];
  const rows = await render("2026-09", txs, cats);
  const [eating, hobbies, snacks] = rows;
  check("one row per target, alphabetical", rows.map((r) => text(r).split(" ")[0]), ["Eating", "Hobbies", "Snacks"]);

  const top = byCls(eating, "budget-goal-top")[0];
  check("top line: name and Tune, then spend / target", [text(byCls(top, "budget-goal-name")[0]), text(byCls(top, "budget-target-amount")[0])], ["Eating Out Tune", "$207.79 / $145.47"]);
  check("over target: the figure is in the error color", has(byCls(top, "budget-target-amount")[0], "budget-target-over"), true);
  check("subtitle: the cut the target asks for, against last month by name", text(byCls(eating, "budget-target-aim")[0]), "Goal: 5% reduction vs August");
  check("the old badge is gone", byCls(eating, "budget-aim").length, 0);
  check("the bar spills past the line when over", [byCls(eating, "budget-progress-track").length, byCls(eating, "budget-progress-spill").length], [1, 1]);
  const status = byCls(eating, "budget-target-status")[0];
  check("bottom: the change from last month as a tag, and how far over", status.children.map(text), ["+$54.66 vs August", "+$62.32 over budget (143%)"]);
  check("more than last month reads as bad, over budget in the error color",
    [has(status.children[0], "budget-target-up"), has(status.children[1], "budget-target-over")], [true, true]);

  const sStatus = byCls(snacks, "budget-target-status")[0];
  check("less than last month, under budget", sStatus.children.map(text), ["-$285.59 vs August", "$77.78 left (35%)"]);
  check("less reads as good; room left stays quiet", [has(sStatus.children[0], "budget-target-down"), has(sStatus.children[1], "budget-target-over")], [true, false]);
  check("a target far below last month", text(byCls(snacks, "budget-target-aim")[0]), "Goal: 63% reduction vs August");
  check("under target: not in the error color", has(byCls(snacks, "budget-target-amount")[0], "budget-target-over"), false);

  check("no last month: the target as a figure", text(byCls(hobbies, "budget-target-aim")[0]), "Target: $50.00/mo");
  const hStatus = byCls(hobbies, "budget-target-status")[0];
  check("…and no trend tag, but room left still there", hStatus.children.map(text), ["", "$20.00 left (60%)"]);
}

console.log("\n2. Edges");
{
  const cats = [{ name: "Eating Out", monthly_target: 200 }];
  let [row] = await render("2026-09", [tx("2026-08-05", -150, "Eating Out"), tx("2026-09-03", -150, "Eating Out")], cats);
  check("a target above last month isn't a 'reduction'", text(byCls(row, "budget-target-aim")[0]), "Target: $200.00/mo");
  check("same spend as last month", text(byCls(row, "budget-target-status")[0].children[0]), "same as August");
  [row] = await render("2027-01", [tx("2026-12-05", -300, "Eating Out"), tx("2027-01-03", -100, "Eating Out")], cats);
  check("January compares with December of the year before, by year", [text(byCls(row, "budget-target-aim")[0]), text(byCls(row, "budget-target-status")[0].children[0])],
    ["Goal: 33% reduction vs December 2026", "-$200.00 vs December 2026"]);
  [row] = await render("2026-09", [tx("2026-08-05", -200, "Eating Out"), tx("2026-09-03", -200, "Eating Out")], cats);
  check("exactly at target: nothing left, not over", [text(byCls(row, "budget-target-status")[0].children[1]), has(byCls(row, "budget-target-amount")[0], "budget-target-over")], ["$0.00 left (100%)", false]);
  check("targetMonthName", [H.targetMonthName("2026-08", "2026-09"), H.targetMonthName("2025-12", "2026-01"), H.targetMonthName(null, "2026-01")], ["August", "December 2025", ""]);
}

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
})().catch((e) => { console.error(e); process.exit(1); });
