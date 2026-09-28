// Regression tests for the reported failure: a "Payments to match" window where
// pressing Match did nothing, on payments that had already been applied.
//
// Three independent faults produced it, and each gets its own section here.
const P = require("./paths.js");
const H = require("./harness.js");

let pass = 0, fail = 0;
function check(name, got, want) {
  const ok = JSON.stringify(got) === JSON.stringify(want);
  if (ok) { pass++; console.log(`  PASS  ${name}`); }
  else { fail++; console.log(`  FAIL  ${name}: got ${JSON.stringify(got)}, want ${JSON.stringify(want)}`); }
}

const CATS = [
  { name: "BNPL", is_transfer: false, is_variable_necessity: false },
  { name: "Gas", is_transfer: false, is_variable_necessity: true },
  { name: "Pet Bills", is_transfer: false, is_variable_necessity: true },
  { name: "Savings", is_transfer: true, is_variable_necessity: false },
  { name: "Phone Bill", is_transfer: false, is_variable_necessity: false },
  { name: "Eating Out", is_transfer: false, is_variable_necessity: false }
];
const ZIP = {
  id: "d_zip", provider: "ZIP - Switch 2", installment_amount: 67.5, payment_category: "BNPL",
  next_due_date: "2026-09-22", frequency: "biweekly",
  balance_anchor: { amount: 540, date: "2026-09-09" }, applied_payments: []
};
const PHONE = { id: "f_phone", name: "Phone Bill", amount: 33.81, due_day_of_month: 15, linked_payments: [] };

function classify(transactions, { debts = [ZIP], fixed = [PHONE] } = {}) {
  const ownership = H.buildOwnershipIndex({
    fixedExpenses: fixed, installmentDebts: debts, revolvingDebts: [],
    goals: [], categoryMeta: CATS
  });
  return H.classifyBufferSpending({
    transactions, periodStartStr: "2026-09-12", nextPaydayStr: "2026-09-26",
    categoryMeta: CATS, fixedExpenses: fixed, installmentDebts: debts,
    revolvingDebts: [], goals: [], ownership
  });
}

// ---------------------------------------------------------------------------
console.log("\nFault 1: rows offered for matching that have nothing to match");
{
  // Every one of these is reserved money the allowance must exclude. Only some
  // of them name an obligation a user could point at.
  const txs = [
    { id: "t_gas",  date: "2026-09-18", amount: -20,    resolved_category: "Gas",       merchant_raw: "SHELL" },
    { id: "t_pet",  date: "2026-09-15", amount: -40.99, resolved_category: "Pet Bills", merchant_raw: "PETCO" },
    { id: "t_xfer", date: "2026-09-15", amount: -1054.77, resolved_category: "Savings", merchant_raw: "To Savings 00" },
    { id: "t_bnpl", date: "2026-09-15", amount: -67.5,  resolved_category: "BNPL",      merchant_raw: "ZIP* BEST BUY" },
    { id: "t_fi",   date: "2026-09-15", amount: -33.81, resolved_category: "Phone Bill", merchant_raw: "GOOGLE *FI" },
    { id: "t_food", date: "2026-09-16", amount: -18,    resolved_category: "Eating Out", merchant_raw: "TACO" }
  ];
  const r = classify(txs);

  check("gas is still reserved, not spending", r.settled.variable_necessity, 60.99);
  check("the transfer is still reserved", r.settled.transfer, 1054.77);
  check("only ordinary spending draws the allowance", r.spent, 18);

  const ids = r.unsettled.map((u) => u.id).sort();
  check("only the debt and the bill are offered", ids, ["t_bnpl", "t_fi"]);
  check("a variable necessity is never offered", r.unsettled.some((u) => u.class === "variable_necessity"), false);
  check("a transfer is never offered", r.unsettled.some((u) => u.class === "transfer"), false);
}

// ---------------------------------------------------------------------------
console.log("\nFault 2: prompting when nothing is being held back");
{
  const unsettled = [
    { id: "t_bnpl", date: "2026-09-15", amount: 67.5, class: "debt", category: "BNPL", merchant_raw: "ZIP" },
    { id: "t_fi", date: "2026-09-15", amount: 33.81, class: "fixed_expense", category: "Phone Bill", merchant_raw: "GOOGLE *FI" }
  ];

  // Nothing open: matching would release nothing, so there is nothing to ask.
  const none = H.findUnreconciledObligations({
    periodObligations: [
      { source: "debt", ref: "d_zip", label: "ZIP", remaining: 0, settled: true },
      { source: "fixed_expense", ref: "f_phone", label: "Phone Bill", remaining: 0, settled: true }
    ],
    unsettled
  });
  check("nothing open means nothing to match", none.needsMatching.length, 0);
  check("and no suggestions either", none.pairs.length, 0);

  // Only the bill is still open.
  const some = H.findUnreconciledObligations({
    periodObligations: [
      { source: "debt", ref: "d_zip", label: "ZIP", remaining: 0, settled: true },
      { source: "fixed_expense", ref: "f_phone", label: "Phone Bill", remaining: 33.81, settled: false }
    ],
    unsettled
  });
  check("only the kind still reserved is offered", some.needsMatching.map((u) => u.id), ["t_fi"]);
  check("the settled debt's payment is left alone", some.needsMatching.some((u) => u.class === "debt"), false);
  check("an exact match still becomes a suggestion", some.pairs.length, 1);
  check("pointing at the right obligation", some.pairs[0].obligation.ref, "f_phone");
  check("open amounts are reported per kind", some.openByClass, { fixed_expense: 33.81 });
}

// ---------------------------------------------------------------------------
console.log("\nFault 3: a hold and its settled charge stored as two transactions");
{
  const hold = { id: "t_hold", date: "", amount: -67.49, account_id: "Credit Union", merchant_raw: "POS Hold, ZIP* BEST BUY", resolved_category: "BNPL" };
  const posted = { id: "t_posted", date: "2026-09-08", amount: -67.49, account_id: "Credit Union", merchant_raw: "Withdrawal Debit Card ZIP* BEST BUY 183-37823729 NY Date 09/08/26", resolved_category: "BNPL" };
  const debts = [Object.assign({}, ZIP, { applied_payments: [{ tx_id: "t_hold", amount: 67.49, date: "" }] })];

  const r = H.mergeSettledHolds([hold, posted], { installmentDebts: debts });
  check("the pair collapses to one row", r.transactions.length, 1);
  check("and it is the settled one", r.transactions[0].id, "t_posted");
  check("the link is scheduled to move, with the settled date", r.relink, [{ from: "t_hold", to: "t_posted", date: "2026-09-08" }]);

  const moved = H.applyTransactionRelinks(debts, r.relink, "applied_payments");
  check("one link moved", moved.moved, 1);
  check("onto the surviving transaction", debts[0].applied_payments[0].tx_id, "t_posted");
  check("taking its date, so it isn't 'today' forever", debts[0].applied_payments[0].date, "2026-09-08");

  // The whole point: the settled charge is no longer an orphan.
  const own = H.buildOwnershipIndex({ installmentDebts: debts, revolvingDebts: [], categoryMeta: CATS });
  check("so it now settles its obligation", !!own.settlementOf(r.transactions[0]), true);
}

console.log("\n  a hold with no settled twin is left alone");
{
  const hold = { id: "t_hold", date: "", amount: -23.24, account_id: "Credit Union", merchant_raw: "KLARNA - PURCHASE" };
  const other = { id: "t_x", date: "2026-09-08", amount: -99, account_id: "Credit Union", merchant_raw: "SOMETHING ELSE" };
  const r = H.mergeSettledHolds([hold, other], {});
  check("nothing merged", r.merged, 0);
  check("both rows survive", r.transactions.length, 2);
}

console.log("\n  two possible twins are never guessed between");
{
  const hold = { id: "t_hold", date: "", amount: -24.37, account_id: "Credit Union", merchant_raw: "POS Hold, SP+AFF * YOYOEXP" };
  const a = { id: "t_a", date: "2026-09-11", amount: -24.37, account_id: "Credit Union", merchant_raw: "Withdrawal Debit Card SP+AFF * YOYOEXPERT 855" };
  const b = { id: "t_b", date: "2026-09-25", amount: -24.37, account_id: "Credit Union", merchant_raw: "Withdrawal Debit Card SP+AFF * YOYOEXPERT 855" };
  const debts = [Object.assign({}, ZIP, { applied_payments: [{ tx_id: "t_hold", amount: 24.37 }] })];
  const r = H.mergeSettledHolds([hold, a, b], { installmentDebts: debts });
  check("nothing merged", r.merged, 0);
  check("all three rows survive", r.transactions.length, 3);
  check("and it says why", r.skipped.length, 1);
}

console.log("\n  a different account is never merged across");
{
  const hold = { id: "t_hold", date: "", amount: -50, account_id: "Credit Union", merchant_raw: "POS Hold, TARGET STORE" };
  const other = { id: "t_o", date: "2026-09-11", amount: -50, account_id: "Capital One", merchant_raw: "TARGET STORE 1234" };
  check("left alone", H.mergeSettledHolds([hold, other], {}).merged, 0);
}

console.log("\n  a conflicting pair of links is reported, not resolved");
{
  const hold = { id: "t_hold", date: "", amount: -67.5, account_id: "Credit Union", merchant_raw: "POS Hold, ZIP* BEST BUY" };
  const posted = { id: "t_posted", date: "2026-09-15", amount: -67.5, account_id: "Credit Union", merchant_raw: "ZIP* BEST BUY 183" };
  const debts = [
    Object.assign({}, ZIP, { id: "d_a", applied_payments: [{ tx_id: "t_hold", amount: 67.5 }] }),
    Object.assign({}, ZIP, { id: "d_b", applied_payments: [{ tx_id: "t_posted", amount: 67.5 }] })
  ];
  const r = H.mergeSettledHolds([hold, posted], { installmentDebts: debts });
  check("nothing merged", r.merged, 0);
  check("and it says why", r.skipped.length, 1);
}

// ---------------------------------------------------------------------------
console.log("\nOne transaction can only pay an obligation once");
{
  // Applying the hold and then the posted charge to the same plan recorded the
  // installment as paid twice, which rolled its due date forward a cycle early.
  const debt = Object.assign({}, ZIP, {
    applied_payments: [
      { tx_id: "t_posted", amount: 24.37, date: "2026-09-11" },
      { tx_id: "t_hold", amount: 24.37, date: "" }
    ]
  });
  const r = H.applyTransactionRelinks([debt], [{ from: "t_hold", to: "t_posted" }], "applied_payments");
  check("the duplicate is dropped", debt.applied_payments.length, 1);
  check("counted separately from the move", r, { moved: 1, deduped: 1 });
  check("and the dated entry is the one kept", debt.applied_payments[0].date, "2026-09-11");
}

console.log("\n  a pre-existing duplicate is cleaned with no merge at all");
{
  const debt = Object.assign({}, ZIP, {
    applied_payments: [
      { tx_id: "t_a", amount: 67.5, date: "2026-09-15" },
      { tx_id: "t_a", amount: 67.5, date: "2026-09-15" }
    ]
  });
  const r = H.applyTransactionRelinks([debt], [], "applied_payments");
  check("collapsed", debt.applied_payments.length, 1);
  check("reported as a dedupe", r.deduped, 1);
}

console.log("\n  two genuinely different payments are both kept");
{
  const debt = Object.assign({}, ZIP, {
    applied_payments: [
      { tx_id: "t_a", amount: 67.49, date: "2026-09-08" },
      { tx_id: "t_b", amount: 67.5, date: "2026-09-15" }
    ]
  });
  H.applyTransactionRelinks([debt], [], "applied_payments");
  check("both survive", debt.applied_payments.length, 2);
}

console.log("\n  savings contributions use their own key");
{
  const goal = { id: "g1", name: "Dog food", contributions: [
    { linked_tx_id: "t_x", amount: 50 }, { linked_tx_id: "t_x", amount: 50 }
  ] };
  const r = H.applyTransactionRelinks([goal], [], "contributions");
  check("deduped by linked_tx_id", goal.contributions.length, 1);
  check("and reported", r.deduped, 1);
}

// ---------------------------------------------------------------------------
console.log("\nImport: an undated hold can finally settle");
{
  const existing = [
    { id: "t_hold", date: "", amount: -67.49, account_id: "Credit Union", merchant_raw: "POS Hold, ZIP* BEST BUY", resolved_category: "BNPL", override_label: "BNPL" }
  ];
  const incoming = [
    { id: "t_new", date: "2026-09-08", amount: -67.49, account_id: "Credit Union", merchant_raw: "Withdrawal Debit Card ZIP* BEST BUY 183-37823729 NY", resolved_category: null, override_label: null }
  ];
  const r = H.reconcileImport(existing, incoming);
  check("no second row is created", r.merged.length, 1);
  check("it is counted as an update", r.updated, 1);
  check("nothing was added", r.added, 0);
  check("the surviving row keeps the stored id", r.merged[0].id, "t_hold");
  check("and gains the posting date", r.merged[0].date, "2026-09-08");
  check("the user's override is preserved", r.merged[0].override_label, "BNPL");
  check("and it is no longer a hold", r.merged[0].pending, undefined);
}

console.log("\n  an unrelated charge of the same amount still imports");
{
  const existing = [
    { id: "t_hold", date: "", amount: -20, account_id: "Credit Union", merchant_raw: "POS Hold, SHELL OIL" }
  ];
  const incoming = [
    { id: "t_new", date: "2026-09-18", amount: -20, account_id: "Credit Union", merchant_raw: "Withdrawal Debit Card CHIPOTLE 4820" }
  ];
  const r = H.reconcileImport(existing, incoming);
  check("it is added, not swallowed", r.added, 1);
  check("both rows exist", r.merged.length, 2);
  check("and the hold is untouched", r.merged[0].date, "");
}

console.log("\n  a short merchant core will not over-match");
{
  const existing = [{ id: "t_hold", date: "", amount: -9.99, account_id: "Credit Union", merchant_raw: "POS Hold, SQ *" }];
  const incoming = [{ id: "t_new", date: "2026-09-18", amount: -9.99, account_id: "Credit Union", merchant_raw: "SQ *SOME COFFEE BAR" }];
  const r = H.reconcileImport(existing, incoming);
  check("added as its own row", r.added, 1);
}

console.log("\n  a dated pending row still reconciles the way it always did");
{
  const existing = [
    { id: "t_p", date: "2026-09-18", amount: -30, account_id: "Credit Union", merchant_raw: "COSTCO GAS", pending: true }
  ];
  const incoming = [
    { id: "t_new", date: "2026-09-19", amount: -30, account_id: "Credit Union", merchant_raw: "COSTCO GAS #123" }
  ];
  const r = H.reconcileImport(existing, incoming);
  check("settled in place", r.updated, 1);
  check("with one row", r.merged.length, 1);
}

console.log("\n  a hold five days out is not treated as the same charge");
{
  const existing = [
    { id: "t_p", date: "2026-09-12", amount: -30, account_id: "Credit Union", merchant_raw: "COSTCO GAS", pending: true }
  ];
  const incoming = [
    { id: "t_new", date: "2026-09-19", amount: -30, account_id: "Credit Union", merchant_raw: "COSTCO GAS" }
  ];
  const r = H.reconcileImport(existing, incoming);
  check("added separately", r.added, 1);
}

// ---------------------------------------------------------------------------
console.log("\nThe whole path, on the reported data");
{
  // Exactly the eight outflows from the screenshot, with the BNPL charges
  // already applied against the holds they arrived as.
  const holds = [
    { id: "h_zip", date: "", amount: -67.5, account_id: "Credit Union", merchant_raw: "POS Hold, ZIP* BEST BUY", resolved_category: "BNPL" }
  ];
  const posted = [
    { id: "t_zip", date: "2026-09-15", amount: -67.5, account_id: "Credit Union", merchant_raw: "Withdrawal Debit Card ZIP* BEST BUY 183-37823729", resolved_category: "BNPL" },
    { id: "t_pet", date: "2026-09-15", amount: -40.99, account_id: "Credit Union", merchant_raw: "PETCO 1224", resolved_category: "Pet Bills" },
    { id: "t_fi",  date: "2026-09-15", amount: -33.81, account_id: "Credit Union", merchant_raw: "GOOGLE *FI", resolved_category: "Phone Bill" },
    { id: "t_gas", date: "2026-09-18", amount: -20, account_id: "Credit Union", merchant_raw: "SHELL SERVICE STATI", resolved_category: "Gas" },
    { id: "t_gas2", date: "2026-09-20", amount: -45, account_id: "Credit Union", merchant_raw: "82ND MINI MART", resolved_category: "Gas" }
  ];
  const debts = [Object.assign({}, ZIP, { applied_payments: [{ tx_id: "h_zip", amount: 67.5, date: "" }] })];

  const before = classify(holds.concat(posted), { debts });
  check("five rows no longer reach the list", before.unsettled.length, 2);

  const rep = H.mergeSettledHolds(holds.concat(posted), { installmentDebts: debts, fixedExpenses: [PHONE] });
  H.applyTransactionRelinks(debts, rep.relink, "applied_payments");
  check("the hold merged into the posted charge", rep.merged, 1);

  const after = classify(rep.transactions, { debts });
  check("and the already-applied payment drops off", after.unsettled.map((u) => u.id), ["t_fi"]);

  const un = H.findUnreconciledObligations({
    periodObligations: H.buildPeriodObligations({
      periodFixed: [PHONE], dueInstallments: [], todayStr: "2026-09-21", nextPaydayStr: "2026-09-26"
    }),
    unsettled: after.unsettled
  });
  check("one genuine task is left", un.needsMatching.length, 1);
  check("and it has a suggestion attached", un.pairs.length, 1);
  check("naming the bill it probably paid", un.pairs[0].obligation.label, "Phone Bill");
}

// ---------------------------------------------------------------------------
console.log("\nThe review bar follows the gated list, not the raw one");
{
  const View = require("./harness-for.js")(P.MAIN).BudgetDashboardView;
  const { el, allText } = H;
  const view = Object.create(View.prototype);
  view.app = {};
  view.plugin = { settings: {}, expiredPeriod: null, pendingSweep: async () => null, openSweepModal: async () => {} };

  const render = (unreconciled, bufferSpending) => {
    const c = el("div");
    view.renderAlerts(c, { unreconciled, bufferSpending, periodObligations: [], bufferOverrun: 0, allocatedBuffer: 300 }, { rules: [] });
    return allText(c);
  };

  // A row the user cannot act on must not put a bar on screen, even though the
  // engine still knows the transaction is unsettled.
  const quiet = render(
    { pairs: [], needsMatching: [] },
    { unsettled: [{ id: "t_x", class: "transfer", amount: 1054.77, date: "2026-09-15", category: "Savings", merchant_raw: "To Savings 00" }] }
  );
  check("no bar when nothing is actionable", quiet.includes("needs matching") || quiet.includes("need matching"), false);

  const loud = render(
    { pairs: [], needsMatching: [{ id: "t_fi", class: "fixed_expense", amount: 33.81, date: "2026-09-15", category: "Phone Bill", merchant_raw: "GOOGLE *FI" }] },
    { unsettled: [] }
  );
  check("a bar when there is real work", loud.includes("1 payment still needs matching"), true);
  check("and it stays plain-language", /ownership|resolver|settlement|unsettled|class/i.test(loud), false);
}

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
