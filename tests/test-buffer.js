const H = require("./harness.js");
const { runAllocation, classifyBufferSpending, bufferAllocationStale, captureBufferAllocation, round2 } = H;

let pass = 0, fail = 0;
function check(name, got, want, tol = 0.005) {
  const ok = typeof want === "number" ? Math.abs(got - want) < tol : got === want;
  if (ok) { pass++; console.log(`  PASS  ${name}`); }
  else { fail++; console.log(`  FAIL  ${name}: got ${JSON.stringify(got)}, want ${JSON.stringify(want)}`); }
}

const START = "2026-09-01";
const END = "2026-09-15";
const CATS = [
  { name: "Restaurants", is_transfer: false },
  { name: "Groceries", is_transfer: false },
  { name: "Entertainment", is_transfer: false },
  { name: "Gas", is_transfer: false, is_variable_necessity: true, variable_min_amount: 20 },
  { name: "Credit Card Payment", is_transfer: true },
  { name: "Savings", is_transfer: true },
  { name: "Paycheck", is_transfer: false }
];

let idc = 0;
const tx = (date, amount, category, merchant = "MERCHANT") => ({
  id: `tx_${++idc}`, date, amount, merchant_raw: merchant, resolved_category: category
});

// The spec's worked examples carry $350 of committed obligations. Modelled as
// an unpaid fixed expense so it flows through the real committed path.
const COMMITTED_350 = [{ id: "f_committed", name: "Rent half", amount: 350, due_day_of_month: 10 }];

function alloc(over) {
  return runAllocation(Object.assign({
    cashOnHand: 1700, todayStr: START, nextPaydayStr: END, currentDateStr: "2026-09-08",
    fixedExpenses: COMMITTED_350, installmentDebts: [], revolvingDebts: [], upcomingSubs: [],
    earmarked: 0, savingsMode: false, goals: [], paychecksFor: {},
    transactions: [], categoryMeta: CATS, bufferMode: "manual", manualBuffer: 350,
    bufferAllocation: { amount: 350, mode: "manual", manualBuffer: 350, capturedFor: START }
  }, over));
}

console.log("\nExample A — ordinary buffer spending");
{
  const before = alloc({});
  check("A: buffer remaining starts at allocation", before.bufferRemaining, 350);
  check("A: availableForDebt before", before.availableForDebt, 1000);  // 1700-350-350

  const after = alloc({ cashOnHand: 1660, transactions: [tx("2026-09-05", -40, "Restaurants")] });
  check("A: cash fell to 1660", after.cashOnHand, 1660);
  check("A: buffer spent", after.bufferSpent, 40);
  check("A: buffer remaining", after.bufferRemaining, 310);
  check("A: availableForDebt UNCHANGED", after.availableForDebt, 1000);
  check("A: no overrun", after.bufferOverrun, 0);
}

console.log("\nExample B — subscription already billed");
{
  // Committed carries the $20 sub before it bills; once billed it drops out of
  // upcomingSubs, so the test mirrors that by removing it.
  const SUB_RULES = [{ merchant_pattern: "NETFLIX", display_name: "Netflix", category: "Subscription" }];
  const before = alloc({ upcomingSubs: [{ key: "Netflix", amount: 20, dueDate: "2026-09-10" }] });
  check("B: committed includes sub", before.committed, 350 + 20);
  check("B: availableForDebt before", before.availableForDebt, 1700 - 370 - 350);

  const after = alloc({
    cashOnHand: 1680, upcomingSubs: [],
    transactions: [tx("2026-09-10", -20, "Subscription", "NETFLIX.COM")],
    subscriptionKeys: ["Netflix"], rules: SUB_RULES
  });
  check("B: buffer NOT consumed", after.bufferSpent, 0);
  check("B: buffer remaining unchanged", after.bufferRemaining, 350);
  check("B: availableForDebt UNCHANGED", after.availableForDebt, 1700 - 370 - 350);
}

console.log("\nExample C — projected variable necessity");
{
  const after = alloc({ cashOnHand: 1648, transactions: [tx("2026-09-06", -52, "Gas", "SHELL")] });
  check("C: gas does not consume buffer", after.bufferSpent, 0);
  check("C: buffer remaining", after.bufferRemaining, 350);
}

console.log("\nExample D — partial use, sweep candidate");
{
  const after = alloc({
    cashOnHand: 1473,
    transactions: [tx("2026-09-03", -127, "Restaurants"), tx("2026-09-07", -100, "Groceries")]
  });
  check("D: buffer spent", after.bufferSpent, 227);
  check("D: sweep candidate", after.bufferRemaining, 123);
}

console.log("\nExample E — overrun");
{
  const after = alloc({ cashOnHand: 1280, transactions: [tx("2026-09-04", -420, "Restaurants")] });
  check("E: remaining floors at 0", after.bufferRemaining, 0);
  check("E: overrun", after.bufferOverrun, 70);
  check("E: effectiveBuffer is 0 not negative", after.effectiveBuffer, 0);
  // 1280 - 0 committed - 0 buffer = 1280; baseline was 1000 + 350 unspent = 1350.
  // Overrun of 70 is exactly the shortfall vs spending the full allowance.
  check("E: overrun reduces available by exactly 70", after.availableForDebt, 1000 - 70);
}

console.log("\nExample F — transaction removed");
{
  const withTx = alloc({ cashOnHand: 1600, transactions: [tx("2026-09-04", -100, "Restaurants")] });
  check("F: remaining with tx", withTx.bufferRemaining, 250);
  const without = alloc({ cashOnHand: 1700, transactions: [] });
  check("F: remaining after delete", without.bufferRemaining, 350);
}

console.log("\nExclusions");
{
  const debtTx = tx("2026-09-05", -62.5, "Shopping", "AFFIRM");
  const r = alloc({
    cashOnHand: 1637.5, transactions: [debtTx],
    installmentDebts: [{ id: "d1", installment_amount: 62.5, next_due_date: "2026-09-20",
      balance_anchor: { amount: 250 }, applied_payments: [{ tx_id: debtTx.id, amount: 62.5, date: "2026-09-05" }] }]
  });
  check("debt payment does not consume buffer", r.bufferSpent, 0);

  const saveTx = tx("2026-09-06", -200, "Savings");
  const r2 = alloc({
    cashOnHand: 1500, transactions: [saveTx],
    goals: [{ id: "g1", name: "Move fund", target_amount: 3000, saved_amount: 200,
      contributions: [{ id: "c1", amount: 200, date: "2026-09-06", linked_tx_id: saveTx.id }] }]
  });
  check("savings transfer does not consume buffer", r2.bufferSpent, 0);

  const r3 = alloc({ cashOnHand: 800, transactions: [tx("2026-09-02", -900, "Credit Card Payment")] });
  check("transfer category does not consume buffer", r3.bufferSpent, 0);

  const rentTx = tx("2026-09-02", -700, "Housing", "LANDLORD");
  const r4 = alloc({
    cashOnHand: 1000, transactions: [rentTx],
    fixedExpenses: [{ id: "f1", name: "Rent", amount: 700, due_day_of_month: 2, last_paid_date: "2026-09-02",
      linked_payments: [{ tx_id: rentTx.id, amount: 700, date: "2026-09-02", paid_for: "2026-09-02" }] }]
  });
  check("LINKED fixed expense does not consume buffer", r4.bufferSpent, 0);
}

console.log("\nScope and boundaries");
{
  const r = alloc({ transactions: [tx("2026-08-28", -200, "Restaurants")] });
  check("prior-period tx excluded", r.bufferSpent, 0);
  const r2 = alloc({ transactions: [tx(START, -30, "Restaurants")] });
  check("period-start tx included", r2.bufferSpent, 30);
  const r3 = alloc({ transactions: [tx(END, -30, "Restaurants")] });
  check("next-payday tx excluded", r3.bufferSpent, 0);
  const r4 = alloc({ transactions: [Object.assign(tx("2026-09-05", -30, "Restaurants"), { date: "" })] });
  check("dateless tx excluded", r4.bufferSpent, 0);
}

console.log("\nRefunds and income");
{
  const r = alloc({
    transactions: [tx("2026-09-03", -109, "Restaurants"), tx("2026-09-06", 40, "Restaurants")]
  });
  check("refund credits back", r.bufferSpent, 69);

  const r2 = alloc({
    transactions: [tx("2026-09-03", -109, "Restaurants"), tx("2026-09-01", 1400, "Paycheck")]
  });
  check("paycheck income is NOT a refund", r2.bufferSpent, 109);

  const r3 = alloc({
    transactions: [tx("2026-09-03", -50, "Restaurants"), tx("2026-09-06", 300, "Restaurants")]
  });
  check("oversized refund cannot go negative", r3.bufferSpent, 0);

  const r4 = alloc({
    transactions: [tx("2026-09-03", -50, "Restaurants"), tx("2026-09-06", 300, "Groceries")]
  });
  check("refund does not cross categories", r4.bufferSpent, 50);
}

console.log("\nDuplicate / pending handling");
{
  const t1 = tx("2026-09-03", -50, "Restaurants");
  const dup = Object.assign({}, t1, { id: "tx_dup" });
  const r = alloc({ transactions: [t1, dup] });
  check("two distinct records both count (import dedupes upstream)", r.bufferSpent, 100);
  const r2 = alloc({ transactions: [t1] });
  check("pending->settled keeps one id, counted once", r2.bufferSpent, 50);
}

console.log("\nSnapshot stability");
{
  const snap = { amount: 350, mode: "manual", manualBuffer: 350, capturedFor: START };
  check("stable snapshot is not stale", bufferAllocationStale(snap, "manual", 350, START), false);
  check("mode switch makes it stale", bufferAllocationStale(snap, "auto", 350, START), true);
  check("manual edit makes it stale", bufferAllocationStale(snap, "manual", 400, START), true);
  check("new period makes it stale", bufferAllocationStale(snap, "manual", 350, "2026-09-15"), true);
  check("missing snapshot is stale", bufferAllocationStale(null, "manual", 350, START), true);

  // Auto mode: the live recalculation drifts as the month's spend grows, but the
  // snapshot must not follow it.
  const TARGETED = CATS.map((c) =>
    c.name === "Restaurants" ? Object.assign({}, c, { monthly_target: 100 }) : c
  );
  const txs = [tx("2026-09-03", -109, "Restaurants"), tx("2026-09-07", -80, "Groceries")];
  const a1 = captureBufferAllocation({ transactions: [], categoryMeta: TARGETED, periodStartStr: START, nextPaydayStr: END, bufferMode: "auto" });
  const a2 = captureBufferAllocation({ transactions: txs, categoryMeta: TARGETED, periodStartStr: START, nextPaydayStr: END, bufferMode: "auto" });
  check("auto allocation genuinely drifts with data (so it must be persisted)", a1.amount !== a2.amount, true);

  const held = alloc({ bufferMode: "auto", bufferAllocation: a1, transactions: txs, cashOnHand: 1511 });
  check("snapshot wins over live recalculation", held.allocatedBuffer, a1.amount);
  check("spend measured against the snapshot", held.bufferSpent, 189);
}

console.log("\nAuto mode end-to-end");
{
  const txs = [tx("2026-09-03", -60, "Restaurants")];
  const a = captureBufferAllocation({ transactions: txs, categoryMeta: CATS, periodStartStr: START, nextPaydayStr: END, bufferMode: "auto" });
  const r = alloc({ bufferMode: "auto", manualBuffer: 0, bufferAllocation: a, transactions: txs, cashOnHand: 1640 });
  check("auto: allocation from snapshot", r.allocatedBuffer, a.amount);
  check("auto: spend tracked", r.bufferSpent, 60);
  check("auto: remaining = allocated - spent", r.bufferRemaining, round2(Math.max(0, a.amount - 60)));
}

console.log("\nNo-snapshot fallback (pre-feature period)");
{
  const r = alloc({ bufferAllocation: null, bufferMode: "manual", manualBuffer: 350 });
  check("falls back to the live manual figure", r.allocatedBuffer, 350);
}


console.log("\nIssue 1 — uncategorized spending consumes the buffer");
{
  const r = alloc({ cashOnHand: 1660, transactions: [tx("2026-09-05", -40, "Uncategorized", "NEW BISTRO")] });
  check("uncategorized outflow spends the buffer", r.bufferSpent, 40);
  check("uncategorized: remaining drops", r.bufferRemaining, 310);
  check("uncategorized: savings capacity unchanged", r.availableForDebt, 1000);

  const r2 = alloc({ cashOnHand: 1660, transactions: [Object.assign(tx("2026-09-05", -40, null, "NEW BISTRO"), { resolved_category: undefined })] });
  check("missing category also spends the buffer", r2.bufferSpent, 40);

  // The analytics definition must be left alone — it gates the Smart Buffer
  // sizing and the Insights trend, neither of which should change. The funding
  // question now lives in the ownership index and is covered in its own suite.
  check("isDiscretionaryCategory still excludes Uncategorized", H.isDiscretionaryCategory("Uncategorized", CATS), false);
}

console.log("\nIssue 2 — no loose amount matching for fixed expenses");
{
  // The exact bug: insurance marked paid, its real transaction absent, and a
  // restaurant purchase of the same amount standing in for it.
  const dinner = tx("2026-09-06", -50, "Restaurants", "SOME BISTRO");
  const r = alloc({
    cashOnHand: 1650, transactions: [dinner],
    fixedExpenses: COMMITTED_350.concat([
      { id: "f_ins", name: "Car Insurance", amount: 50, due_day_of_month: 3, last_paid_date: "2026-09-03" }
    ])
  });
  check("unlinked fixed expense cannot shield a same-priced purchase", r.bufferSpent, 50);

  // And the link really does exclude the right one.
  const insTx = tx("2026-09-03", -50, "Car Insurance", "PROG UNIVERSAL");
  const r2 = alloc({
    cashOnHand: 1600, transactions: [dinner, insTx],
    fixedExpenses: COMMITTED_350.concat([
      { id: "f_ins", name: "Car Insurance", amount: 50, due_day_of_month: 3, last_paid_date: "2026-09-03",
        linked_payments: [{ tx_id: insTx.id, amount: 50, date: "2026-09-03", paid_for: "2026-09-03" }] }
    ])
  });
  check("linked insurance excluded, dinner still counted", r2.bufferSpent, 50);

  // Candidates must never include a transaction another bucket already owns.
  const claimedTx = tx("2026-09-03", -50, "Uncategorized", "AFFIRM");
  const cands = H.fixedExpenseCandidates(
    { id: "f_ins", name: "Car Insurance", amount: 50 },
    [dinner, insTx, claimedTx],
    [{ id: "f_other", linked_payments: [{ tx_id: insTx.id }] }],
    [], [{ applied_payments: [{ tx_id: claimedTx.id }] }], [],
    "2026-09-03"
  );
  check("candidates exclude already-claimed transactions", cands.map((c) => c.id).join(","), dinner.id);

  // recordFixedPayment is idempotent on transaction id.
  const e = { id: "f_x", name: "X", amount: 50, linked_payments: [] };
  H.recordFixedPayment(e, "2026-09-03", insTx);
  H.recordFixedPayment(e, "2026-09-03", insTx);
  check("recordFixedPayment cannot double-link", e.linked_payments.length, 1);
  H.clearFixedPayment(e, "2026-09-03");
  check("clearFixedPayment drops that cycle", e.linked_payments.length, 0);
}

console.log("\nIssue 4 — sweep routes through recommendSavings");
{
  const goals = [
    { id: "g_move", name: "Moving fund", target_amount: 3000, saved_amount: 2950, target_date: "2026-11-26" },
    { id: "g_car",  name: "Car repairs", target_amount: 800,  saved_amount: 0 }
  ];
  // $123 sweep: the moving goal can only take $50 before it hits its target.
  const plan = H.recommendSavings(goals, 123, { g_move: 1 }, "2026-09-15", "2026-11-26");
  const move = plan.breakdown.find((b) => b.id === "g_move");
  check("priority goal capped at its remaining target", move ? move.amount : 0, 50);
  check("overflow reaches the second goal", plan.total, 123);
  check("nothing exceeds the swept amount", plan.total <= 123, true);

  const full = H.recommendSavings(
    [{ id: "g1", name: "Done", target_amount: 100, saved_amount: 100 }], 123, {}, "2026-09-15", null
  );
  check("fully funded goals take nothing", full.total, 0);

  const capped = H.recommendSavings(goals, 5000, { g_move: 1 }, "2026-09-15", "2026-11-26");
  check("total cannot exceed all goals' remaining need", capped.total, 50 + 800);
}


console.log("\nIssue 1 — positive Uncategorized is not a refund");
{
  // Debits still count (the previous round's fix must survive).
  const spend = alloc({ cashOnHand: 1600, transactions: [tx("2026-09-03", -100, "Uncategorized", "NEW BISTRO")] });
  check("uncategorized debit still consumes buffer", spend.bufferSpent, 100);

  const r = alloc({
    transactions: [
      tx("2026-09-03", -100, "Uncategorized", "NEW BISTRO"),
      tx("2026-09-06", 60, "Uncategorized", "VENMO FROM SAM")
    ]
  });
  check("uncategorized credit does NOT offset spending", r.bufferSpent, 100);

  const r2 = alloc({
    transactions: [
      tx("2026-09-03", -100, "Uncategorized", "NEW BISTRO"),
      tx("2026-09-04", 1748.95, "Uncategorized", "ACME FOODS DIR DEP")
    ]
  });
  check("unlabeled payroll credit cannot wipe the allowance", r2.bufferSpent, 100);

  // A labeled refund must still work — the guard is about the unknown case only.
  const r3 = alloc({
    transactions: [tx("2026-09-03", -100, "Restaurants"), tx("2026-09-06", 60, "Restaurants")]
  });
  check("labeled refund still credits back", r3.bufferSpent, 40);
}

console.log("\nIssue 2 — month-end due dates and local parsing");
{
  check("clamp: 31st in September -> 30", H.dueDayInMonth(31, 2026, 8), 30);
  check("clamp: 31st in February -> 28", H.dueDayInMonth(31, 2026, 1), 28);
  check("clamp: 29th in leap February -> 29", H.dueDayInMonth(29, 2028, 1), 29);
  check("clamp: 15th is never clamped", H.dueDayInMonth(15, 2026, 1), 15);

  check("31st resolves in a 30-day month", H.getDueDateInRange(31, "2026-09-20", "2026-10-04"), "2026-09-30");
  check("31st resolves in a 31-day month", H.getDueDateInRange(31, "2026-08-20", "2026-09-04"), "2026-08-31");
  check("30th resolves in February", H.getDueDateInRange(30, "2026-02-20", "2026-03-06"), "2026-02-28");
  check("nextDueDateOnOrAfter clamps too", H.nextDueDateOnOrAfter(31, "2026-09-15"), "2026-09-30");
  check("nextDueDateOnOrAfter exact month", H.nextDueDateOnOrAfter(31, "2026-08-15"), "2026-08-31");

  // The UTC-parse bug: these must be the literal days, not one day earlier.
  check("local parse: due on the 1st is the 1st", H.getDueDateInRange(1, "2026-09-01", "2026-09-15"), "2026-09-01");
  check("local parse: due on the 15th is the 15th", H.getDueDateInRange(15, "2026-09-01", "2026-09-16"), "2026-09-15");
  check("local parse: nextDueDateOnOrAfter on the 1st", H.nextDueDateOnOrAfter(1, "2026-09-01"), "2026-09-01");

  // And the obligation must actually reach the budget.
  const r = alloc({
    fixedExpenses: [{ id: "f_31", name: "Loan payment", amount: 120, due_day_of_month: 31 }],
    todayStr: "2026-09-01", nextPaydayStr: "2026-10-01", currentDateStr: "2026-09-20"
  });
  // The end-of-window drop: a bill due on the last day of the period.
  check("bill due on the period's last day is found", H.getDueDateInRange(14, "2026-09-01", "2026-09-15"), "2026-09-14");
  check("bill due on the last day, real schedule", H.getDueDateInRange(28, "2026-09-15", "2026-09-29"), "2026-09-28");
  const lastDay = alloc({
    fixedExpenses: [{ id: "f_last", name: "Phone bill", amount: 85, due_day_of_month: 14 }],
    todayStr: "2026-09-01", nextPaydayStr: "2026-09-15", currentDateStr: "2026-09-08"
  });
  check("last-day bill reaches committed", lastDay.committed, 85);

  check("a 31st bill is committed in September", r.committed, 120);
  check("a 31st bill appears in periodFixed", r.periodFixed.length, 1);
}

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
