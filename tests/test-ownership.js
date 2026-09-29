// The ten acceptance cases from the reconciliation spec, plus the precedence
// rules the resolver promises.
const H = require("./harness.js");
const { buildOwnershipIndex, runAllocation, calculateVariableNecessities, round2,
        buildPeriodObligations, findUnreconciledObligations, summarizeOwnership } = H;

let pass = 0, fail = 0;
function check(name, got, want, tol = 0.005) {
  const ok = typeof want === "number" ? Math.abs(got - want) < tol : got === want;
  if (ok) { pass++; console.log(`  PASS  ${name}`); }
  else { fail++; console.log(`  FAIL  ${name}: got ${JSON.stringify(got)}, want ${JSON.stringify(want)}`); }
}

const START = "2026-09-15", END = "2026-09-29";
const CATS = [
  { name: "Eating Out", is_transfer: false },
  { name: "BNPL", is_transfer: false },
  { name: "Phone Bill", is_transfer: false },
  { name: "Subscription", is_transfer: false },
  { name: "Gas", is_transfer: false, is_variable_necessity: true, variable_min_amount: 20 },
  { name: "Savings", is_transfer: true },
  { name: "Credit Card Payment", is_transfer: true },
  { name: "Paycheck", is_transfer: false }
];
let n = 0;
const tx = (date, amount, category, merchant = "M") =>
  ({ id: `t${++n}`, date, amount, resolved_category: category, merchant_raw: merchant, account_id: "Main Checking" });

const zip = (applied = []) => ({
  provider: "ZIP - Switch 2", installment_amount: 67.50, next_due_date: "2026-09-22", frequency: "monthly",
  payment_category: "BNPL",  // set for every plan at creation, as in the real data
  balance_anchor: { amount: 135, date: "2026-09-01" }, applied_payments: applied
});
const phone = (over = {}) => Object.assign({
  id: "f_phone", name: "Phone bill", amount: 33.81, due_day_of_month: 20, linked_payments: []
}, over);

const alloc = (over) => runAllocation(Object.assign({
  cashOnHand: 1000, todayStr: START, nextPaydayStr: END, currentDateStr: "2026-09-20",
  fixedExpenses: [], installmentDebts: [], revolvingDebts: [], upcomingSubs: [], earmarked: 0,
  savingsMode: false, goals: [], paychecksFor: {}, transactions: [], categoryMeta: CATS,
  bufferMode: "manual", manualBuffer: 350,
  bufferAllocation: { amount: 350, mode: "manual", manualBuffer: 350, capturedFor: START },
  subscriptionKeys: [], rules: []
}, over));

const idx = (over = {}) => buildOwnershipIndex(Object.assign({
  fixedExpenses: [], installmentDebts: [], revolvingDebts: [], goals: [],
  categoryMeta: CATS, subscriptionKeys: [], rules: []
}, over));

console.log("\nPrecedence — explicit links outrank inference");
{
  // Same transaction, categorized as a variable necessity, but explicitly
  // applied to a debt. Debt must win.
  const t = tx("2026-09-18", -67.50, "Gas", "ZIP");
  const i = idx({ installmentDebts: [zip([{ tx_id: t.id, amount: 67.50, date: "2026-09-18" }])] });
  check("explicit debt beats necessity category", i.typeOf(t), "debt");
  check("and is marked explicit", i.ownerOf(t).explicit, true);

  const t2 = tx("2026-09-18", -33.81, "Eating Out", "CARRIER");
  const i2 = idx({ fixedExpenses: [phone({ linked_payments: [{ tx_id: t2.id, amount: 33.81, paid_for: "2026-09-20" }] })] });
  check("explicit fixed expense beats a discretionary category", i2.typeOf(t2), "fixed_expense");

  const t3 = tx("2026-09-18", -200, "Eating Out", "TRANSFER");
  const i3 = idx({ goals: [{ id: "g1", name: "Move", contributions: [{ id: "c", amount: 200, linked_tx_id: t3.id }] }] });
  check("explicit savings link beats category", i3.typeOf(t3), "savings");

  // Debt outranks fixed expense when a transaction is (wrongly) linked to both.
  const t4 = tx("2026-09-18", -50, "Eating Out");
  const i4 = idx({
    installmentDebts: [zip([{ tx_id: t4.id, amount: 50 }])],
    fixedExpenses: [phone({ linked_payments: [{ tx_id: t4.id, amount: 50, paid_for: "2026-09-20" }] })]
  });
  check("double-linked resolves deterministically to debt", i4.typeOf(t4), "debt");
}

console.log("\nPrecedence — inference order");
{
  const sub = tx("2026-09-18", -15.99, "Subscription", "NETFLIX.COM");
  const i = idx({ subscriptionKeys: ["Netflix"], rules: [{ merchant_pattern: "NETFLIX", display_name: "Netflix" }] });
  check("kept subscription claims its charge", i.typeOf(sub), "subscription");
  check("marked inferred, not explicit", i.ownerOf(sub).explicit, false);

  check("transfer category", idx().typeOf(tx("2026-09-18", -900, "Credit Card Payment")), "transfer");
  check("variable necessity category", idx().typeOf(tx("2026-09-18", -52, "Gas")), "variable_necessity");
  check("legacy name heuristic still recognises rent", idx().typeOf(tx("2026-09-18", -700, "Rent")), "fixed_expense");
  check("discretionary fallback", idx().typeOf(tx("2026-09-18", -40, "Eating Out")), "discretionary");
  check("Uncategorized falls to discretionary", idx().typeOf(tx("2026-09-18", -40, "Uncategorized")), "discretionary");
  check("money in is income", idx().typeOf(tx("2026-09-18", 1748.95, "Paycheck")), "income");
}

console.log("\n1. BNPL due, unpaid");
{
  const r = alloc({ installmentDebts: [zip()] });
  check("appears as a pay-period obligation", r.periodObligations.filter((o) => o.source === "debt").length, 1);
  check("reserved in committed", r.committed, 67.50);
  check("reduces savings capacity", round2(r.availableForDebt), round2(1000 - 67.50 - 350));
  check("does not consume allowance", r.bufferSpent, 0);
  const vn = calculateVariableNecessities([], CATS, "2026-09-20", END, idx({ installmentDebts: [zip()] }));
  check("not projected as a variable necessity", vn.totalReserve, 0);
}

console.log("\n2. BNPL payment posts and is applied");
{
  const t = tx("2026-09-18", -67.50, "BNPL", "ZIP");
  const r = alloc({
    cashOnHand: 1000 - 67.50, transactions: [t],
    installmentDebts: [zip([{ tx_id: t.id, amount: 67.50, date: "2026-09-18" }])]
  });
  check("obligation is satisfied", r.committed, 0);
  check("allowance untouched", r.bufferSpent, 0);
  check("allowance remains full", r.bufferRemaining, 350);
  check("no duplicate reserve", round2(r.availableForDebt), round2(1000 - 67.50 - 350));
  check("owned by debt in the summary", r.ownershipSummary.byType.find((b) => b.type === "debt").amount, 67.50);
}

console.log("\n3. Fixed phone bill");
{
  const unpaid = alloc({ fixedExpenses: [phone()] });
  check("due before payday, reserved", unpaid.committed, 33.81);

  const t = tx("2026-09-19", -33.81, "Phone Bill", "CARRIER");
  const paid = alloc({
    cashOnHand: 1000 - 33.81, transactions: [t],
    fixedExpenses: [phone({ last_paid_date: "2026-09-20", linked_payments: [{ tx_id: t.id, amount: 33.81, date: "2026-09-19", paid_for: "2026-09-20" }] })]
  });
  check("once linked the reserve disappears", paid.committed, 0);
  check("and it does not consume allowance", paid.bufferSpent, 0);
}

console.log("\n4. Kept subscription");
{
  const RULES = [{ merchant_pattern: "NETFLIX", display_name: "Netflix" }];
  const before = alloc({ upcomingSubs: [{ key: "Netflix", amount: 15.99, dueDate: "2026-09-20" }] });
  check("upcoming renewal is an obligation", before.periodObligations.filter((o) => o.source === "subscription").length, 1);
  check("reserved", before.committed, 15.99);

  const t = tx("2026-09-20", -15.99, "Subscription", "NETFLIX.COM");
  const after = alloc({
    cashOnHand: 1000 - 15.99, transactions: [t], upcomingSubs: [],
    subscriptionKeys: ["Netflix"], rules: RULES
  });
  check("renewal satisfied once it posts", after.committed, 0);
  check("does not also consume allowance", after.bufferSpent, 0);
}

console.log("\n5. Gas — a genuine variable necessity");
{
  const hist = [
    tx("2026-07-20", -50, "Gas"), tx("2026-08-03", -52, "Gas"),
    tx("2026-08-17", -51, "Gas"), tx("2026-08-31", -53, "Gas"), tx("2026-09-14", -52, "Gas")
  ];
  const r = alloc({ transactions: hist, currentDateStr: "2026-09-20" });
  check("projected from cadence", r.variableNecessitiesTotal > 0, true);

  const posted = tx("2026-09-18", -52, "Gas");
  const r2 = alloc({ transactions: hist.concat([posted]), currentDateStr: "2026-09-20" });
  check("does not consume allowance when it posts", r2.bufferSpent, 0);
  check("owned by the necessity bucket", r2.ownershipSummary.byType.find((b) => b.type === "variable_necessity").amount > 0, true);
  check("projection re-estimates from the new history", r2.variableNecessitiesTotal !== r.variableNecessitiesTotal, true);
}

console.log("\n6. Eating Out consumes the allowance");
{
  const r = alloc({ cashOnHand: 960, transactions: [tx("2026-09-18", -40, "Eating Out")] });
  check("consumes allowance", r.bufferSpent, 40);
  check("remaining drops", r.bufferRemaining, 310);
}

console.log("\n7. Uncategorized, then identified");
{
  const t = tx("2026-09-18", -40, "Uncategorized", "NEW BISTRO");
  const before = alloc({ cashOnHand: 960, transactions: [t] });
  check("unknown outflow consumes allowance by default", before.bufferSpent, 40);

  // Later linked to a debt: ownership must change with no migration.
  const after = alloc({
    cashOnHand: 960, transactions: [t],
    installmentDebts: [zip([{ tx_id: t.id, amount: 40, date: "2026-09-18" }])]
  });
  check("linking changes the derived answer", after.bufferSpent, 0);

  // Or simply recategorized.
  const recat = Object.assign({}, t, { resolved_category: "Gas" });
  check("recategorizing changes it too", alloc({ cashOnHand: 960, transactions: [recat] }).bufferSpent, 0);
}

console.log("\n8. Accidental overlap — BNPL also marked a variable necessity");
{
  const OVERLAP = CATS.map((c) => (c.name === "BNPL" ? Object.assign({}, c, { is_variable_necessity: true, variable_min_amount: 10 }) : c));
  const hist = [
    tx("2026-07-20", -67.5, "BNPL"), tx("2026-08-03", -67.5, "BNPL"),
    tx("2026-08-17", -67.5, "BNPL"), tx("2026-08-31", -67.5, "BNPL")
  ];
  const i = idx({ installmentDebts: [zip()], categoryMeta: OVERLAP });
  const vn = calculateVariableNecessities(hist, OVERLAP, "2026-09-20", END, i);
  check("debt ownership wins — no duplicate projection", vn.totalReserve, 0);
  check("and it says why", vn.skipped.includes("BNPL"), true);

  // Without the resolver the old code would have projected it.
  const unguarded = calculateVariableNecessities(hist, OVERLAP, "2026-09-20", END, null);
  check("(the projection it prevents was real)", unguarded.totalReserve > 0, true);
}

console.log("\n9. UI duplication allowed, financial duplication not");
{
  const t = tx("2026-09-18", -67.50, "BNPL", "ZIP");
  const r = alloc({
    cashOnHand: 1000 - 67.50, transactions: [t],
    installmentDebts: [zip([{ tx_id: t.id, amount: 67.50, date: "2026-09-18" }])]
  });
  check("visible as an obligation row", r.periodObligations.some((o) => o.source === "debt"), true);
  check("that row reads settled", r.periodObligations.find((o) => o.source === "debt").settled, true);
  const counted = r.ownershipSummary.byType.reduce((s, b) => s + b.amount, 0);
  check("counted exactly once across all buckets", counted, 67.50);
}

console.log("\n10. Reconciliation — every outflow has one owner");
{
  const txs = [
    tx("2026-09-16", -40, "Eating Out"),
    tx("2026-09-17", -52, "Gas"),
    tx("2026-09-18", -900, "Credit Card Payment"),
    tx("2026-09-19", -15.99, "Subscription", "NETFLIX.COM")
  ];
  const r = alloc({
    cashOnHand: 100, transactions: txs,
    subscriptionKeys: ["Netflix"], rules: [{ merchant_pattern: "NETFLIX", display_name: "Netflix" }]
  });
  const total = r.ownershipSummary.byType.reduce((s, b) => s + b.amount, 0);
  check("every outgoing dollar is attributed", total, round2(40 + 52 + 900 + 15.99));
  check("transaction count matches", r.ownershipSummary.count, 4);
  const types = r.ownershipSummary.byType.map((b) => b.type).sort();
  check("four distinct buckets (a card payment shows apart)", types.join(","), "card_payment,discretionary,subscription,variable_necessity");
}

console.log("\nClass and settlement are independent facts");
{
  const t = tx("2026-09-18", -67.50, "BNPL", "ZIP");
  const i = idx({ installmentDebts: [zip()] });
  check("unlinked BNPL is still DEBT class", i.classOf(t), "debt");
  check("but settles nothing yet", i.settlementOf(t), null);
  check("and is not marked explicit", i.ownerOf(t).explicit, false);
  check("class came from the debt's own payment_category", i.ownerOf(t).basis, "category a tracked debt takes payments in");

  const linkedTx = tx("2026-09-18", -67.50, "BNPL", "ZIP");
  const i2 = idx({ installmentDebts: [zip([{ tx_id: linkedTx.id, amount: 67.50 }])] });
  check("linking adds settlement without changing class", i2.classOf(linkedTx), "debt");
  check("and names the instance", i2.settlementOf(linkedTx).label, "ZIP - Switch 2");

  // A fixed expense with no category field still confers class via its name.
  const ph = tx("2026-09-19", -33.81, "Phone Bill", "CARRIER");
  const i3 = idx({ fixedExpenses: [phone()] });
  check("unlinked phone bill is FIXED_EXPENSE class", i3.classOf(ph), "fixed_expense");
  check("via the expense name matching the category", i3.ownerOf(ph).basis, "category matches a tracked fixed expense");
  check("settling nothing yet", i3.settlementOf(ph), null);
}

console.log("\nThe allowance uses class, the reserve uses settlement");
{
  const t = tx("2026-09-18", -67.50, "BNPL", "ZIP");
  const r = alloc({ cashOnHand: 1000 - 67.50, transactions: [t], installmentDebts: [zip()] });
  check("unlinked debt payment does NOT consume allowance", r.bufferSpent, 0);
  check("allowance stays whole", r.bufferRemaining, 350);
  check("obligation still reserved, because nothing settled it", r.committed, 67.50);
  check("but the overlap is flagged", r.unreconciled.pairs.length, 1);
  check("naming the obligation", r.unreconciled.pairs[0].obligation.label, "ZIP - Switch 2");
  check("and the candidate", r.unreconciled.pairs[0].candidate.id, t.id);
  check("with the amount at risk", r.unreconciled.total, 67.50);
  check("candidate carries its class", r.unreconciled.pairs[0].candidate.class, "debt");

  // Once linked, the flag clears and so does the double count.
  const fixed = alloc({
    cashOnHand: 1000 - 67.50, transactions: [t],
    installmentDebts: [zip([{ tx_id: t.id, amount: 67.50, date: "2026-09-18" }])]
  });
  check("linking clears the flag", fixed.unreconciled.pairs.length, 0);
  // One error remains while unlinked, not two: the reserve is held because the
  // app genuinely does not know the obligation was settled. It errs toward
  // thinking you still owe money, never toward letting you spend it twice.
  check("linking releases exactly one reserve", round2(fixed.availableForDebt - r.availableForDebt), 67.50);
  check("and the allowance was never involved", r.bufferSpent, fixed.bufferSpent);

  // Class-scoped pairing: a dinner is discretionary money and can never be
  // offered as the settlement for a debt obligation, however the amounts line up.
  const dinner = tx("2026-09-18", -67.50, "Eating Out", "SOME BISTRO");
  const coincidence = alloc({ cashOnHand: 900, transactions: [dinner], installmentDebts: [zip()] });
  check("a same-priced dinner still consumes allowance", coincidence.bufferSpent, 67.50);
  check("and is never offered as a debt settlement", coincidence.unreconciled.pairs.length, 0);
  check("the obligation stays reserved", coincidence.committed, 67.50);
}

console.log("\nDouble-reserve under overrun (the case that actually costs money)");
{
  const t = tx("2026-09-18", -67.50, "BNPL", "ZIP");
  const blown = [tx("2026-09-16", -400, "Eating Out")];
  const un = alloc({ cashOnHand: 532.50, transactions: [t].concat(blown), installmentDebts: [zip()] });
  const li = alloc({
    cashOnHand: 532.50, transactions: [t].concat(blown),
    installmentDebts: [zip([{ tx_id: t.id, amount: 67.50, date: "2026-09-18" }])]
  });
  // The allowance no longer absorbs it either way, so the only remaining gap is
  // the unreleased reserve — one error, not two.
  check("allowance is untouched whether linked or not", un.bufferSpent, li.bufferSpent);
  check("the only gap left is the unreleased reserve", round2(li.availableForDebt - un.availableForDebt), 67.50);
  check("and that is exactly what the flag warns about", un.unreconciled.total, 67.50);
}

console.log("\nObligation umbrella does not duplicate records");
{
  const r = alloc({
    fixedExpenses: [phone()], installmentDebts: [zip()],
    upcomingSubs: [{ key: "Netflix", amount: 15.99, dueDate: "2026-09-20" }]
  });
  const sources = r.periodObligations.map((o) => o.source).sort();
  check("one row per obligation, three sources", sources.join(","), "debt,fixed_expense,subscription");
  const sum = round2(r.periodObligations.reduce((s, o) => s + o.remaining, 0));
  check("their remaining sums to committed", sum, r.committed);
}

console.log("\nA category can declare its own class (the only record a bill exists)");
{
  // The real gap: a phone bill with NO fixed expense, NO debt, NO subscription.
  // Nothing in the app knows it is a bill, so it reads as ordinary spending.
  const ph = tx("2026-09-19", -33.81, "Phone Bill", "CARRIER");
  check("with no record anywhere it is discretionary", idx().classOf(ph), "discretionary");
  check("and it consumes the allowance", alloc({ cashOnHand: 966, transactions: [ph] }).bufferSpent, 33.81);

  const DECLARED = CATS.map((c) =>
    c.name === "Phone Bill" ? Object.assign({}, c, { exclude_from_discretionary: true }) : c
  );
  check("declaring it makes it fixed-expense class", idx({ categoryMeta: DECLARED }).classOf(ph), "fixed_expense");
  check("stating why", idx({ categoryMeta: DECLARED }).ownerOf(ph).basis, "category marked as a scheduled bill");
  check("and it stops consuming the allowance",
    alloc({ cashOnHand: 966, transactions: [ph], categoryMeta: DECLARED }).bufferSpent, 0);
  check("with no obligation invented for it",
    alloc({ cashOnHand: 966, transactions: [ph], categoryMeta: DECLARED }).committed, 0);

  // A declared category must not outrank a real tracked record.
  const DECL_GAS = CATS.map((c) =>
    c.name === "Gas" ? Object.assign({}, c, { exclude_from_discretionary: true }) : c
  );
  check("an explicit necessity flag still wins over the declaration",
    idx({ categoryMeta: DECL_GAS }).classOf(tx("2026-09-19", -52, "Gas")), "variable_necessity");
}

console.log("\nLegacy debts without payment_category");
{
  const legacy = Object.assign({}, zip());
  delete legacy.payment_category;
  const t = tx("2026-09-18", -67.50, "BNPL", "KLARNA");
  check("a plan missing the field confers no class on its own", idx({ installmentDebts: [legacy] }).classOf(t), "discretionary");
  // One plan that DOES carry it is enough to class the whole category, which is
  // why the backfill matters for a ledger where only some plans have it.
  check("but one plan that has it covers the category",
    idx({ installmentDebts: [legacy, zip()] }).classOf(t), "debt");
}

console.log("\nA fixed expense declares where its charges land");
{
  // The real shape: the bill is called "Phone Co", the charges are categorized
  // "Phone Bill". No name match exists between them.
  const gfi = { id: "f_phone", name: "Phone Co", amount: 33.81, due_day_of_month: 4, linked_payments: [] };
  const t = tx("2026-09-19", -33.81, "Phone Bill", "PHONE CO");

  check("name fallback cannot bridge different names", idx({ fixedExpenses: [gfi] }).classOf(t), "discretionary");

  const declared = Object.assign({}, gfi, { payment_category: "Phone Bill" });
  check("declaring the category bridges it", idx({ fixedExpenses: [declared] }).classOf(t), "fixed_expense");
  check("stating why", idx({ fixedExpenses: [declared] }).ownerOf(t).basis, "category matches a tracked fixed expense");
  check("and it leaves the allowance",
    alloc({ cashOnHand: 966, transactions: [t], fixedExpenses: [declared] }).bufferSpent, 0);

  // The name fallback must still work for expenses that predate the field.
  const legacy = { id: "f_ph", name: "Phone Bill", amount: 33.81, due_day_of_month: 4, linked_payments: [] };
  check("legacy name match still honoured", idx({ fixedExpenses: [legacy] }).classOf(t), "fixed_expense");

  // Declared wins over a colliding name.
  const both = Object.assign({}, legacy, { name: "Phone Bill", payment_category: "Utilities" });
  const u = tx("2026-09-19", -33.81, "Utilities", "ANY");
  check("declared category also classes its own transactions", idx({ fixedExpenses: [both] }).classOf(u), "fixed_expense");
}

console.log("\nLinking a payment teaches the expense its category");
{
  const gfi = { id: "f_phone", name: "Phone Co", amount: 33.81, due_day_of_month: 4, linked_payments: [] };
  const t = tx("2026-09-04", -33.81, "Phone Bill", "PHONE CO");
  check("starts with no category", gfi.payment_category, undefined);

  H.recordFixedPayment(gfi, "2026-09-04", t);
  check("learned from the linked transaction", gfi.payment_category, "Phone Bill");
  check("and the link was recorded", gfi.linked_payments.length, 1);

  // From then on, an UNLINKED future charge is classed automatically.
  const next = tx("2026-10-04", -33.81, "Phone Bill", "PHONE CO");
  check("next month's charge needs no link", idx({ fixedExpenses: [gfi] }).classOf(next), "fixed_expense");
  check("though it still settles nothing", idx({ fixedExpenses: [gfi] }).settlementOf(next), null);

  // It must not learn from an unlabelled transaction.
  const blank = { id: "f_b", name: "Blank", amount: 10, due_day_of_month: 4, linked_payments: [] };
  H.recordFixedPayment(blank, "2026-09-04", tx("2026-09-04", -10, "Uncategorized", "X"));
  check("does not learn Uncategorized", blank.payment_category, undefined);

  // And it must not overwrite a deliberate choice.
  const set = { id: "f_s", name: "Set", amount: 10, due_day_of_month: 4, payment_category: "Utilities", linked_payments: [] };
  H.recordFixedPayment(set, "2026-09-04", tx("2026-09-04", -10, "Phone Bill", "X"));
  check("does not overwrite an existing category", set.payment_category, "Utilities");
}

console.log("\nMoney went: transfers and card payments");
{
  const txs = [
    tx("2026-09-16", -40, "Eating Out"),
    tx("2026-09-17", -900, "Credit Card Payment"),
    tx("2026-09-18", -250, "Savings")   // a move to your own savings account
  ];
  const r = alloc({ cashOnHand: 100, transactions: txs });
  const types = r.ownershipSummary.byType.map((b) => b.type).sort();
  check("a card payment shows as its own line", types.includes("card_payment"), true);
  check("an account-to-account transfer is not listed", types.includes("transfer"), false);
  check("the card payment counts in the total", r.ownershipSummary.total, 940);
  check("and in the count; the transfer is in neither", r.ownershipSummary.count, 2);
  check("the card payment line holds only the payment", r.ownershipSummary.byType.find((b) => b.type === "card_payment").amount, 900);

  const own = idx();
  const bare = summarizeOwnership(txs, START, END, own);
  check("without card categories (old callers) transfers are simply left out", bare.byType.map((b) => b.type).sort().join(","), "discretionary");

  const custom = [tx("2026-09-17", -120, "Visa Payment")];
  const meta = CATS.concat([{ name: "Visa Payment", is_transfer: true }]);
  const own2 = idx({ categoryMeta: meta });
  const withCard = summarizeOwnership(custom, START, END, own2, new Set(["Visa Payment"]));
  check("a card's own payment category counts as a card payment", withCard.byType.map((b) => b.type).join(","), "card_payment");
  // A move into a savings goal is the same money in another place, so it is
  // left out too; the goal link that classes it stays for everything else.
  const sv = tx("2026-09-18", -400, "Savings");
  const goalIdx = idx({ goals: [{ id: "g1", name: "Trip", contributions: [{ id: "c1", amount: 400, linked_tx_id: sv.id }] }] });
  check("the move is owned by savings for the allowance", goalIdx.ownerOf(sv).class, "savings");
  const withGoal = summarizeOwnership([sv, tx("2026-09-16", -40, "Eating Out")], START, END, goalIdx);
  check("but it is not listed, and not in the total or count", [withGoal.byType.map((b) => b.type).join(","), withGoal.total, withGoal.count].join("|"), "discretionary|40|1");

  check("the allowance is untouched by the display change",
    alloc({ cashOnHand: 100, transactions: txs }).ownershipSummary.total,
    alloc({ cashOnHand: 100, transactions: txs.slice(0, 2) }).ownershipSummary.total);
}

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
