// The debt chart by kind of debt, and a big step no longer squashing the rest.
const H = require("./harness.js");
const { el, allText } = H;

let pass = 0, fail = 0;
function check(name, got, want) {
  const ok = JSON.stringify(got) === JSON.stringify(want);
  if (ok) { pass++; console.log(`  PASS  ${name}`); }
  else { fail++; console.log(`  FAIL  ${name}: got ${JSON.stringify(got)}, want ${JSON.stringify(want)}`); }
}
const find = (n, pred, out = []) => { if (pred(n)) out.push(n); (n.children || []).forEach((c) => find(c, pred, out)); return out; };
const byCls = (n, c) => find(n, (x) => x.classes && x.classes.has(c));
const text = (n) => allText(n).replace(/\s+/g, " ").trim();
const F = H.FILES;
const T = H.todayLocal();
const D = (n) => H.addDays(T, n);

const card = { id: "c1", account_id: "Card", balance_anchor: { amount: 1000, date: D(-30) }, applied_payments: [], min_payment_due: 35, due_date: D(8) };
const plan = { id: "b1", provider: "Affirm", installment_amount: 30, frequency: "monthly", next_due_date: D(5), balance_anchor: { amount: 200, date: D(-30) }, applied_payments: [] };
const loan = { id: "l1", kind: "loan", loan_type: "car", provider: "Auto", apr: 0, installment_amount: 300, frequency: "monthly", next_due_date: D(10), loan_date: D(-60), balance_anchor: { amount: 13000, date: D(-1) }, applied_payments: [] };

(async () => {
console.log("\n1. Saving the balance by kind");
{
  const t = H.debtBalancesByType([card], [plan, loan]);
  check("cards, plans and loans each add up on their own", t, { card: 1000, plan: 200, loan: 13000 });
  check("none of a kind is zero", H.debtBalancesByType([], [plan]), { card: 0, plan: 200, loan: 0 });
  check("they add up to the total", [t.card + t.plan + t.loan, H.totalDebt([card], [plan, loan])], [14200, 14200]);

  const store = { [F.debtHistory]: "[]" };
  const app = { vault: { adapter: { exists: async (p) => p in store, read: async (p) => store[p], write: async (p, d) => { store[p] = d; } } } };
  await H.logDebtSnapshot(app, [card], [plan, loan]);
  const saved = JSON.parse(store[F.debtHistory]);
  check("a new point carries the total and the kinds", [saved.length, saved[0].total_debt, saved[0].types], [1, 14200, { card: 1000, plan: 200, loan: 13000 }]);
  let writes = 0;
  const countingApp = { vault: { adapter: Object.assign({}, app.vault.adapter, { write: async (p, d) => { writes++; store[p] = d; } }) } };
  await H.logDebtSnapshot(countingApp, [card], [plan, loan]);
  check("saving again with nothing changed writes nothing", writes, 0);
  store[F.debtHistory] = JSON.stringify([{ date: T, total_debt: 14200 }]);
  await H.logDebtSnapshot(countingApp, [card], [plan, loan]);
  check("a point from before the kinds were kept gets them, same total", [writes, JSON.parse(store[F.debtHistory])[0].types], [1, { card: 1000, plan: 200, loan: 13000 }]);
  const paid = Object.assign({}, plan, { balance_anchor: { amount: 150, date: D(-30) } });
  await H.logDebtSnapshot(countingApp, [card], [paid, loan]);
  const after = JSON.parse(store[F.debtHistory]);
  check("a change updates today's point, not a new one", [after.length, after[0].total_debt, after[0].types.plan], [1, 14150, 150]);
}

console.log("\n2. Which points a kind has");
{
  const hist = [{ date: "2026-09-01", total_debt: 3000 }, { date: "2026-10-01", total_debt: 2800 }, { date: "2026-11-12", total_debt: 16000, types: { card: 1500, plan: 1500, loan: 13000 } }];
  check("all: every point's total", H.debtChartSeries(hist, "all").map((p) => p.total_debt), [3000, 2800, 16000]);
  check("no kind given is all", H.debtChartSeries(hist).length, 3);
  check("a kind: only the points that recorded it, at its own balance", H.debtChartSeries(hist, "loan"), [{ date: "2026-11-12", total_debt: 13000 }]);
  check("another kind", H.debtChartSeries(hist, "card").map((p) => p.total_debt), [1500]);
  check("a kind nothing recorded", H.debtChartSeries([hist[0]], "card"), []);
  check("a zero balance is a point, not a gap", H.debtChartSeries([{ date: "2026-11-12", total_debt: 5, types: { card: 0, plan: 5, loan: 0 } }], "card"), [{ date: "2026-11-12", total_debt: 0 }]);
}

console.log("\n3. Spotting a big step");
{
  const old = [3049, 3048, 2900, 2700, 2650, 2600, 2610, 2590, 2580, 2570];
  check("one new debt on the end of a long history", H.detectLevelShift(old.concat([16055])), { index: 10, coreBefore: true });
  check("a debt added early, a long history after it", H.detectLevelShift([3000, 16000, 15900, 15800, 15700, 15650, 15600]), { index: 1, coreBefore: false });
  check("a tie goes to the later side", H.detectLevelShift([3000, 3010, 16000, 16010]), { index: 2, coreBefore: false });
  check("steady paydown isn't a step", H.detectLevelShift([3000, 2900, 2800, 2700, 2600, 2500]), null);
  check("a step no bigger than the wobble around it isn't either", H.detectLevelShift([3000, 2000, 3000, 2000, 3000]), null);
  check("two points can't be told", H.detectLevelShift([3000, 16000]), null);
  check("none", H.detectLevelShift([]), null);
  check("a drop works the same way", H.detectLevelShift([16000, 15900, 15800, 15850, 15700, 3000]), { index: 5, coreBefore: true });
}

console.log("\n4. The chart");
{
  const hist = [];
  for (let i = 0; i < 12; i++) hist.push({ date: D(-60 + i * 4), total_debt: 3000 - i * 40 });
  hist.push({ date: D(0), total_debt: 16055.42 });
  const ticks = (svg) => [...svg.matchAll(/text-anchor="end" font-size="10"[^>]*>\$([\d,]+)</g)].map((x) => Number(x[1].replace(/,/g, "")));
  const pts = (svg) => [...svg.matchAll(/class="(budget-chart-pt[^"]*)" cx="([\d.]+)" cy="([\d.]+)"/g)].map((x) => ({ cls: x[1], cy: Number(x[3]) }));

  const zoomed = H.buildDebtChart(hist, null, { zoom: true });
  const t = ticks(zoomed);
  check("scaled to the long side: the top of the axis is near the old totals, not $16k", t.every((v) => v < 4000), true);
  const p = pts(zoomed);
  check("the new debt's point is on the top edge, hollow", [p[p.length - 1].cls.includes("budget-chart-pt-off"), p[p.length - 1].cy < 25, p.slice(0, -1).some((x) => x.cls.includes("-off"))], [true, true, false]);
  check("the earlier points use the height of the chart", Math.max(...p.slice(0, -1).map((x) => x.cy)) - Math.min(...p.slice(0, -1).map((x) => x.cy)) > 80, true);
  const offDot = zoomed.match(/<circle class="budget-chart-pt budget-chart-pt-off"[^>]*>/)[0];
  check("the off-scale point is hollow", offDot.includes('fill="var(--background-primary)"') && offDot.includes("stroke="), true);
  check("its real figure is on the point for the hover, and written near it", [zoomed.includes('data-value="16055.42"'), zoomed.includes("↑ $16,055")], [true, true]);
  const flat = H.buildDebtChart(hist, null);
  check("not zoomed: nothing is cut off", [flat.includes("budget-chart-pt-off"), flat.includes("budget-chart-off")], [false, false]);
  check("with a payoff line: not zoomed, nothing cut off", H.buildDebtChart(hist, { zeroDate: D(900), perDay: 20 }, { zoom: true }).includes("budget-chart-pt-off"), false);
  const smooth = [3000, 2900, 2800, 2700].map((v, i) => ({ date: D(-30 + i * 10), total_debt: v }));
  check("a steady line is unchanged", H.buildDebtChart(smooth, null, { zoom: true }).includes("budget-chart-pt-off"), false);

  // The new debt came first, then a long history after it: the early points go off the bottom.
  const flipped = [{ date: D(-70), total_debt: 3000 }].concat(Array.from({ length: 9 }, (_, i) => ({ date: D(-60 + i * 6), total_debt: 16000 - i * 30 })));
  const fz = H.buildDebtChart(flipped, null, { zoom: true });
  check("scaled to the long side after it, the one before sits on the bottom edge", [fz.includes("↓ $3,000"), pts(fz)[0].cls.includes("-off"), ticks(fz).every((v) => v > 15000)], [true, true, true]);
  check("fewer than three points: as before", H.buildDebtChart(hist.slice(0, 2), null, { zoom: true }).includes("-off"), false);
}

console.log("\n5. The screen");
{
  const mk = async ({ history, debts, state = {}, projected = false }) => {
    const store = { [F.debtHistory]: JSON.stringify(history), [F.closedLoans]: "[]" };
    const calls = [];
    const v = Object.create(H.BudgetDashboardView.prototype);
    Object.assign(v, {
      app: { vault: { adapter: { exists: async (p) => p in store, read: async (p) => store[p], write: async (p, d) => { store[p] = d; } } } },
      sectionOpen: {}, scrollMemory: {},
      lastResult: projected ? { recommendedExtraPayoff: 100, requiredMinimums: 100, todayStr: T, nextPaydayStr: D(14) } : null,
      plugin: { confirmRemoveDebtPoint() {}, snapshotDebt: async () => {}, refreshAfterDataChange: async () => {} }
    }, state);
    v.render = () => calls.push("render");
    const root = el("div");
    const rev = debts.filter((d) => d.account_id);
    const inst = debts.filter((d) => !d.account_id);
    await v.renderDebts(root, { allTx: [], revolvingDebts: rev, installmentDebts: inst, allDebts: debts, categoryMetaList: [], accounts: [], ownership: null, rules: [] });
    const card = byCls(root, "budget-progress-card")[0];
    return { v, calls, card };
  };
  const hist = [
    { date: D(-40), total_debt: 3000 }, { date: D(-20), total_debt: 2900 },
    { date: D(-3), total_debt: 15000, types: { card: 1000, plan: 1000, loan: 13000 } },
    { date: D(0), total_debt: 14800, types: { card: 900, plan: 900, loan: 13000 } }
  ];
  let r = await mk({ history: hist, debts: [card, plan, loan] });
  const segs = (c) => byCls(c, "budget-segment").map(text);
  check("with cards, plans and a loan: a switch for each, and All is on", [segs(r.card), byCls(r.card, "budget-segment-on").map(text)], [["All debts", "Cards", "BNPL", "Loans"], ["All debts"]]);
  const h4 = (c) => text(find(c, (x) => x.tag === "h4")[0]);
  check("it's still titled the total", h4(r.card), "Total debt progress");
  r = await mk({ history: hist, debts: [card] });
  check("one kind of debt: no switch", segs(r.card), []);
  r = await mk({ history: hist, debts: [plan, loan] });
  check("only the kinds you have", segs(r.card).filter((s) => ["Cards", "BNPL", "Loans"].includes(s)), ["BNPL", "Loans"]);
  r = await mk({ history: hist, debts: [card, plan, loan], projected: true });
  check("all, with a payoff date: Progress and Payoff are there too", segs(r.card), ["All debts", "Cards", "BNPL", "Loans", "Progress", "Payoff"]);
  byCls(r.card, "budget-segment").find((b) => text(b) === "Loans").onclick();
  check("choosing a kind remembers it and redraws", [r.v.debtChartType, r.calls.pop()], ["loan", "render"]);

  r = await mk({ history: hist, debts: [card, plan, loan], state: { debtChartType: "loan" }, projected: true });
  check("a kind: titled for it, no Progress/Payoff, no payoff sentence", [h4(r.card), segs(r.card), text(r.card).includes("debt-free around")], ["Loans progress", ["All debts", "Cards", "BNPL", "Loans"], false]);
  check("a kind says its figures are kept from when they were first recorded", text(r.card).includes("No change since") && text(r.card).includes("Kept by kind from then."), true);
  r = await mk({ history: hist, debts: [card, plan, loan], state: { debtChartType: "card" } });
  check("a kind with several points: how it's moved, and from when", text(r.card).includes("Down $100.00 since") && text(r.card).includes("from $1000.00 to $900.00") && text(r.card).includes("Kept by kind from then."), true);
  r = await mk({ history: hist.slice(0, 3), debts: [card, plan, loan], state: { debtChartType: "loan" } });
  check("a kind with one point", text(r.card).includes("Only one data point so far"), true);
  r = await mk({ history: hist.slice(0, 2), debts: [card, plan, loan], state: { debtChartType: "loan" } });
  check("a kind nothing's been saved for", text(r.card).includes("Nothing saved for this yet"), true);
  r = await mk({ history: hist, debts: [card], state: { debtChartType: "loan" } });
  check("a kind you no longer have falls back to the total", h4(r.card), "Total debt progress");
  r = await mk({ history: hist, debts: [card, plan], state: { debtChartType: "loan" } });
  check("even when you still have two other kinds", [h4(r.card), byCls(r.card, "budget-segment-on").map(text)], ["Total debt progress", ["All debts"]]);
  r = await mk({ history: hist, debts: [card, plan, loan], state: { debtChartType: "all" } });
  check("the saved points list is the true totals either way", byCls(r.card, "budget-fixed-name").map(text).length, 4);
}

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
})().catch((e) => { console.error(e); process.exit(1); });
