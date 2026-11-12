// A debt set up after you'd already made a payment: the payment can still be
// applied, so the installment reads as paid, and the balance isn't reduced twice.
const H = require("./harness.js");
const { el, allText, SettingStub } = H;

let pass = 0, fail = 0;
function check(name, got, want) {
  const ok = JSON.stringify(got) === JSON.stringify(want);
  if (ok) { pass++; console.log(`  PASS  ${name}`); }
  else { fail++; console.log(`  FAIL  ${name}: got ${JSON.stringify(got)}, want ${JSON.stringify(want)}`); }
}
const find = (n, pred, out = []) => { if (pred(n)) out.push(n); (n.children || []).forEach((c) => find(c, pred, out)); return out; };
const byCls = (n, c) => find(n, (x) => x.classes && x.classes.has(c));
const buttons = (n) => find(n, (x) => x.tag === "button");
const button = (n, label) => buttons(n).find((b) => b._text === label);
const text = (n) => allText(n).replace(/\s+/g, " ").trim();
const clone = (x) => JSON.parse(JSON.stringify(x));
const T = "2026-11-12";
const D = (n) => H.addDays(T, n);

(async () => {
console.log("\n1. A plan set up after paying");
{
  // Typed in today: $120 left, $30 a payment, the next one due in 3 days. The
  // payment that came out 5 days ago is already in that $120.
  const plan = { id: "b1", provider: "Rivermark - Subaru", installment_amount: 30, frequency: "monthly", next_due_date: D(3), remaining_installments: 4, balance_anchor: { amount: 120, date: T }, applied_payments: [] };
  const rec = clone(plan);
  const advanced = H.applyPickedPayments(rec, [{ id: "t1", amount: -30, date: D(-5) }], {}, "bnpl");
  check("applying it covers the installment", [!!advanced, rec.next_due_date === advanced], [true, true]);
  check("without taking the balance down a second time", H.debtBalance(rec), 120);
  check("a payment on the day the balance was typed does come off", (() => {
    const r2 = clone(plan);
    H.applyPickedPayments(r2, [{ id: "t2", amount: -30, date: T }], {}, "bnpl");
    return H.debtBalance(r2);
  })(), 90);
  check("and one after it", (() => {
    const r3 = clone(plan);
    H.applyPickedPayments(r3, [{ id: "t3", amount: -30, date: D(1) }], {}, "bnpl");
    return H.debtBalance(r3);
  })(), 90);
  check("an undated payment (a bank hold) counts as before", (() => {
    const r4 = clone(plan);
    r4.applied_payments = [{ tx_id: "h", amount: 30 }];
    return H.debtBalance(r4);
  })(), 90);
  const u = H.undoAppliedPayment(rec, 0, "bnpl");
  check("undoing it puts the due date back and leaves the balance alone", [u.ok, rec.next_due_date, H.debtBalance(rec)], [true, D(3), 120]);
}

console.log("\n2. A loan set up after paying");
{
  const loan = { id: "loan1", kind: "loan", loan_type: "car", provider: "Rivermark - Subaru", apr: 6.9, installment_amount: 248.43, frequency: "monthly", next_due_date: "2026-11-15", loan_date: "2026-06-01", payment_category: "Car Loan", balance_anchor: { amount: 9000, date: T }, applied_payments: [] };
  const due = (l) => H.loanPeriodDues(l, "2026-11-12", "2026-11-26", T);
  check("before anything's applied it asks for the installment", due(loan).map((r) => [r.due, r.remaining, r.settled]), [["2026-11-15", 248.43, false]]);
  const paid = clone(loan);
  H.applyPickedPayments(paid, [{ id: "t1", amount: -248.43, date: "2026-11-05" }], {}, "loan");
  check("applied, it's paid", due(paid).map((r) => [r.due, r.remaining, r.settled]).slice(0, 1), [["2026-11-15", 0, true]]);
  check("and the balance is the one you typed", H.loanState(paid, T).balance, 9000);
}

console.log("\n3. The search finds it");
{
  SettingStub.buttons = [];
  const plan = { id: "b1", provider: "Rivermark - Subaru", installment_amount: 30, frequency: "monthly", next_due_date: D(3), balance_anchor: { amount: 120, date: T }, applied_payments: [] };
  const ledger = [
    { id: "p", date: D(-5), amount: -30, merchant_raw: "RIVERMARK CU LOAN PMT", account_id: "chk", resolved_category: "Car Loan" },
    { id: "z", date: D(-40), amount: -8, merchant_raw: "COFFEE", account_id: "chk", resolved_category: "Eating Out" }
  ];
  let submitted = null;
  const m = new H.ApplyPaymentModal({}, plan, [], (picked) => (submitted = picked), [], [], null, ledger, null);
  m.close = () => {};
  m.onOpen();
  const finder = byCls(m.contentEl, "budget-apply-find")[0];
  check("with nothing suggested the search is open, already listing", [finder.open, byCls(finder, "budget-apply-row").length], [true, 2]);
  const row = byCls(finder, "budget-apply-row")[0];
  check("a payment from before the balance was typed is offered, and says why it won't change it", [text(row).includes("RIVERMARK CU LOAN PMT"), text(row).includes("already in the balance")], [true, true]);
  check("the note says what applying it does", text(finder).includes("it counts toward the installment, not the balance"), true);
  button(row, "Add").onclick();
  check("adding it shows what the balance will be: unchanged", text(m.contentEl).includes("new balance $120.00"), true);
  SettingStub.buttons.find((b) => b.label === "Apply selected").cb();
  check("and it's handed over", submitted.map((t) => t.id), ["p"]);
  // A suggestion exists: the search stays folded away.
  const m2 = new H.ApplyPaymentModal({}, plan, [ledger[0]], () => {}, [], [], null, ledger, null);
  m2.close = () => {};
  m2.onOpen();
  check("with a suggestion, it's folded", byCls(m2.contentEl, "budget-apply-find")[0].open, false);
}

console.log("\n4. Apply from the Overview row");
{
  const calls = [];
  const v = Object.create(H.BudgetDashboardView.prototype);
  Object.assign(v, { app: {}, sectionOpen: {}, scrollMemory: {}, plugin: { openApplyPaymentForKey: (k) => calls.push(k) } });
  const unpaid = { id: "loan1", provider: "Rivermark - Subaru Impreza", _due: 248.43, _paidThisPeriod: 0, _remaining: 248.43, _settled: false };
  const done = { id: "b2", provider: "Klarna", _due: 24, _paidThisPeriod: 24, _remaining: 0, _settled: true };
  const grid = el("div");
  v.renderObligationsCard(grid, { periodFixed: [], periodFixedPaid: [], dueInstallments: [unpaid, done], dueRevolvingMins: [], earmarked: 0, minimumsPaid: 24 }, { rules: [] });
  const rows = byCls(grid, "budget-fixed-row");
  check("an unpaid minimum has Apply; a paid one doesn't", rows.map((r) => !!button(r, "Apply")), [true, false]);
  button(rows[0], "Apply").onclick();
  check("it opens Apply payment on that debt", calls, ["loan1"]);
  check("the row still reads as before", text(rows[0]), "Rivermark - Subaru Impreza minimum $248.43 Apply");
}

console.log("\n5. Opening it from a key");
{
  const store = {
    "Budget/data/revolving_debts.json": "[]",
    "Budget/data/installment_debts.json": JSON.stringify([{ id: "b1", provider: "Affirm" }, { id: "loan1", provider: "Rivermark", kind: "loan" }])
  };
  const app = { vault: { adapter: { exists: async (p) => p in store, read: async (p) => store[p] } } };
  const plugin = Object.create(H.__PluginClass.prototype);
  plugin.app = app;
  const opened = [];
  plugin.openApplyPaymentFor = async (d, tx) => opened.push([d.id, tx]);
  await plugin.openApplyPaymentForKey("loan1");
  await plugin.openApplyPaymentForKey("nope");
  check("it finds the debt by its key, fresh from the files", opened, [["loan1", null]]);
}

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
})().catch((e) => { console.error(e); process.exit(1); });
