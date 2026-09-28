// One finder behind three flows. The bug this closes: each call site built its
// own idea of "already claimed", so a transaction linked to a fixed expense
// could still be offered as a debt payment and claimed twice.
const H = require("./harness.js");
const { findCandidateTransactions, candidatePayments, fixedExpenseCandidates,
        contributionCandidates, buildOwnershipIndex } = H;

let pass = 0, fail = 0;
function check(name, got, want) {
  const ok = got === want;
  if (ok) { pass++; console.log(`  PASS  ${name}`); }
  else { fail++; console.log(`  FAIL  ${name}: got ${JSON.stringify(got)}, want ${JSON.stringify(want)}`); }
}

let n = 0;
const tx = (date, amount, category = "Uncategorized", merchant = "M") =>
  ({ id: `t${++n}`, date, amount, resolved_category: category, merchant_raw: merchant });

const zip = (applied = []) => ({
  id: "d_zip", provider: "ZIP", installment_amount: 67.5, next_due_date: "2026-09-22",
  payment_category: "BNPL", balance_anchor: { amount: 135, date: "2026-09-01" },
  applied_payments: applied
});

console.log("\nCross-domain exclusion (the inconsistency that is now gone)");
{
  const phoneTx = tx("2026-09-04", -33.81, "BNPL", "PHONE CO");
  const free = tx("2026-09-05", -67.5, "BNPL", "ZIP");
  const expense = {
    id: "f_phone", name: "Phone Co", amount: 33.81, due_day_of_month: 4,
    linked_payments: [{ tx_id: phoneTx.id, amount: 33.81, paid_for: "2026-09-04" }]
  };
  const cands = candidatePayments(
    zip(), [phoneTx, free], [zip()], [{ name: "BNPL", is_transfer: false }],
    buildOwnershipIndex({ fixedExpenses: [expense], installmentDebts: [zip()] })
  );
  check("a fixed-expense-linked payment is not offered as a debt payment",
    cands.some((c) => c.id === phoneTx.id), false);
  check("an unclaimed one still is", cands.some((c) => c.id === free.id), true);

  const savedTx = tx("2026-09-06", -200, "BNPL", "TRANSFER");
  const goals = [{ id: "g1", name: "Move", contributions: [{ id: "c", amount: 200, linked_tx_id: savedTx.id }] }];
  const c2 = candidatePayments(
    zip(), [savedTx, free], [zip()], [{ name: "BNPL", is_transfer: false }],
    buildOwnershipIndex({ goals, installmentDebts: [zip()] })
  );
  check("a savings-linked transfer is not offered as a debt payment",
    c2.some((c) => c.id === savedTx.id), false);
}

console.log("\nEach wrapper keeps its own semantics");
{
  const near = tx("2026-09-04", -33.81, "Phone Bill");
  const far = tx("2026-08-01", -33.81, "Phone Bill");
  const wrong = tx("2026-09-05", -500, "Phone Bill");
  const got = fixedExpenseCandidates(
    { id: "f", name: "Phone Co", amount: 33.81 },
    [far, wrong, near], [], [], [], [], "2026-09-04"
  );
  check("fixed expense ranks the exact amount nearest the due date first", got[0].id, near.id);
  check("and drops anything outside the +/-12 day window", got.some((t) => t.id === far.id), false);

  const c = contributionCandidates({ id: "c1", amount: 200, date: "2026-09-06" },
    [tx("2026-09-05", -200, "Savings"), tx("2026-09-05", -199, "Savings")], []);
  check("contributions require an exact amount", c.length, 1);

  const debtCands = candidatePayments(zip(),
    [tx("2026-09-05", -67.5, "Uncategorized"), tx("2026-09-05", -67.5, "BNPL")],
    [zip()], [{ name: "BNPL", is_transfer: false }]);
  check("debt ranks known categories before unlabelled guesses",
    debtCands[0].resolved_category, "BNPL");
}

console.log("\nGates that must survive");
{
  const applied = tx("2026-09-05", -67.5, "BNPL");
  applied.debt_payment_review_status = "already_applied";
  const excluded = tx("2026-09-06", -67.5, "BNPL");
  excluded.excluded_from_debt_payments = true;
  const ok = tx("2026-09-07", -67.5, "BNPL");
  const got = candidatePayments(zip(), [applied, excluded, ok], [zip()], [{ name: "BNPL", is_transfer: false }]);
  check("'already applied' stays hidden", got.some((t) => t.id === applied.id), false);
  check("'not a payment' stays hidden", got.some((t) => t.id === excluded.id), false);
  check("a clean one is offered", got.some((t) => t.id === ok.id), true);

  const preAnchor = tx("2026-08-01", -67.5, "BNPL");
  const postAnchor = tx("2026-09-05", -67.5, "BNPL");
  const g2 = candidatePayments(zip(), [preAnchor, postAnchor], [zip()], [{ name: "BNPL", is_transfer: false }]);
  check("anything before the balance anchor is excluded", g2.some((t) => t.id === preAnchor.id), false);

  const wrongCat = tx("2026-09-05", -67.5, "Eating Out");
  const g3 = candidatePayments(zip(), [wrongCat], [zip()], [{ name: "BNPL", is_transfer: false }]);
  check("categories outside the debt's allowlist are excluded", g3.length, 0);
}

console.log("\nThe core, directly");
{
  const a = tx("2026-09-05", -50);
  const b = tx("2026-09-06", 50);       // inflow
  const c = tx("2026-09-07", -50);
  const got = findCandidateTransactions({ transactions: [a, b, c], excludeIds: [c.id] });
  check("inflows are never candidates", got.some((t) => t.id === b.id), false);
  check("explicit exclusions are honoured", got.some((t) => t.id === c.id), false);
  check("the rest survive", got.length, 1);

  const many = Array.from({ length: 60 }, (_, i) => tx(`2026-09-${String((i % 28) + 1).padStart(2, "0")}`, -10));
  check("limit is applied", findCandidateTransactions({ transactions: many, limit: 40 }).length, 40);
  check("no limit means no cap", findCandidateTransactions({ transactions: many }).length, 60);
}


console.log("\nCross-class contamination");
{
  const CATS = [
    { name: "BNPL", is_transfer: false },
    { name: "Phone Bill", is_transfer: false },
    { name: "Gas", is_transfer: false, is_variable_necessity: true },
    { name: "Subscription", is_transfer: false },
    { name: "Savings", is_transfer: true },
    { name: "Eating Out", is_transfer: false }
  ];
  const plan = { id: "d1", provider: "ZIP", installment_amount: 67.5, payment_category: "BNPL",
                 next_due_date: "2026-09-22", balance_anchor: { amount: 135, date: "2026-09-01" }, applied_payments: [] };
  const bill = { id: "f1", name: "Phone Co", amount: 67.5, due_day_of_month: 20,
                 payment_category: "Phone Bill", linked_payments: [] };
  const RULES = [{ merchant_pattern: "NETFLIX", display_name: "Netflix" }];

  const mk = (id, cat, merch) => ({ id, date: "2026-09-19", amount: -67.5, resolved_category: cat, merchant_raw: merch });
  const debtTx = mk("c_debt", "BNPL", "ZIP");
  const billTx = mk("c_bill", "Phone Bill", "PHONE CO");
  const gasTx = mk("c_gas", "Gas", "SHELL");
  const subTx = mk("c_sub", "Subscription", "NETFLIX");
  const xferTx = mk("c_xfer", "Savings", "TO SHARE");
  const freeTx = mk("c_free", "Eating Out", "BISTRO");
  const all = [debtTx, billTx, gasTx, subTx, xferTx, freeTx];

  const own = buildOwnershipIndex({
    installmentDebts: [plan], fixedExpenses: [bill], categoryMeta: CATS,
    subscriptionKeys: ["Netflix"], rules: RULES
  });

  const feIds = fixedExpenseCandidates(bill, all, [bill], [], [plan], [], "2026-09-20", own).map((t) => t.id);
  check("bill list excludes a debt payment", feIds.includes(debtTx.id), false);
  check("bill list excludes a fuel purchase", feIds.includes(gasTx.id), false);
  check("bill list excludes a subscription charge", feIds.includes(subTx.id), false);
  check("bill list keeps its OWN class", feIds.includes(billTx.id), true);
  check("bill list keeps unclassified spending", feIds.includes(freeTx.id), true);

  const ccIds = contributionCandidates({ id: "c", amount: 67.5, date: "2026-09-19" }, all, [], own).map((t) => t.id);
  check("savings list excludes a debt payment", ccIds.includes(debtTx.id), false);
  check("savings list excludes a bill payment", ccIds.includes(billTx.id), false);
  check("savings list excludes a fuel purchase", ccIds.includes(gasTx.id), false);
  check("savings list keeps a transfer", ccIds.includes(xferTx.id), true);

  const dpIds = candidatePayments(plan, all, [plan], CATS, own).map((t) => t.id);
  check("debt list excludes a bill payment", dpIds.includes(billTx.id), false);
  check("debt list excludes a fuel purchase", dpIds.includes(gasTx.id), false);
  check("debt list excludes a subscription charge", dpIds.includes(subTx.id), false);
  check("debt list keeps its OWN class", dpIds.includes(debtTx.id), true);
  check("debt list keeps a transfer (card payments are transfers)", dpIds.includes(xferTx.id), true);
}

console.log("\nThe empty state can explain itself");
{
  const CATS = [{ name: "Gas", is_transfer: false, is_variable_necessity: true }];
  const bill = { id: "f1", name: "Water", amount: 40, due_day_of_month: 20, linked_payments: [] };
  const own = buildOwnershipIndex({ fixedExpenses: [bill], categoryMeta: CATS });
  const gasOnly = [{ id: "g", date: "2026-09-19", amount: -40, resolved_category: "Gas", merchant_raw: "SHELL" }];
  const got = fixedExpenseCandidates(bill, gasOnly, [bill], [], [], [], "2026-09-20", own);
  check("nothing offered", got.length, 0);
  check("but it knows why", got.accountedElsewhere, 1);

  const none = fixedExpenseCandidates(bill, [], [bill], [], [], [], "2026-09-20", own);
  check("a genuinely empty range reports zero excluded", none.accountedElsewhere, 0);
}

console.log("\nScheduled-category check is narrower than the payment allowlist");
{
  const CATS = [{ name: "Gas", is_transfer: false, is_variable_necessity: true }, { name: "Savings", is_transfer: true }];
  const plan = { id: "d1", provider: "ZIP", payment_category: "BNPL", installment_amount: 10 };
  const bill = { id: "f1", name: "Phone Co", payment_category: "Phone Bill", amount: 10 };
  const own = buildOwnershipIndex({ installmentDebts: [plan], fixedExpenses: [bill], categoryMeta: CATS });
  check("a debt's declared category is scheduled", own.isScheduledCategory("BNPL"), true);
  check("a bill's declared category is scheduled", own.isScheduledCategory("Phone Bill"), true);
  check("a bill's own name still counts", own.isScheduledCategory("Phone Co"), true);
  check("matching ignores case and spacing", own.isScheduledCategory("phone co"), true);
  check("Uncategorized is NOT scheduled", own.isScheduledCategory("Uncategorized"), false);
  check("an unrelated transfer category is NOT scheduled", own.isScheduledCategory("Savings"), false);
  check("ordinary spending is NOT scheduled", own.isScheduledCategory("Gas"), false);
}

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
