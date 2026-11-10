// Deleting and undoing: transactions, applied debt payments, saved balances,
// closed loans, monthly targets and the pay schedule. Plus finding any
// transaction to apply to a debt.
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
const F = H.FILES;
const T = H.todayLocal();
const D = (n) => H.addDays(T, n);
const tx = (id, date, amount, merchant, extra = {}) => Object.assign({ id, date, amount, merchant_raw: merchant, account_id: "chk", resolved_category: "Shopping" }, extra);

// Opens of ConfirmModal are captured so a test can press its button.
const confirms = [];
H.ConfirmModal.prototype.open = function () { confirms.push(this.opts); };
const lastConfirm = () => confirms[confirms.length - 1];

function makePlugin(files) {
  const store = {};
  Object.entries(files).forEach(([k, v]) => (store[k] = JSON.stringify(v)));
  const app = { vault: { adapter: { exists: async (p) => p in store, read: async (p) => store[p], write: async (p, d) => { store[p] = d; }, mkdir: async () => {} } } };
  const plugin = Object.create(H.__PluginClass.prototype);
  plugin.app = app;
  plugin.settings = {};
  plugin.refreshAfterDataChange = async () => {};
  plugin.refreshDashboard = () => {};
  plugin.snapshotDebt = async () => {};
  return { plugin, store, get: (f) => JSON.parse(store[f]) };
}

(async () => {
console.log("\n1. Transactions: what keeps a deleted row from coming back");
{
  const bank = tx("b1", "2026-10-03", -40.25, "SHELL OIL 123", { simplefin_id: "S1", simplefin_account: "A" });
  const csv = tx("c1", "2026-10-03", -40.25, "SHELL OIL 123");
  check("a synced row is known by its id and by what it says", H.transactionDeleteKeys(bank), ["sf:A::S1", "tx:2026-10-03|SHELL OIL 123|-40.25|chk"]);
  check("a CSV row by what it says", H.transactionDeleteKeys(csv), ["tx:2026-10-03|SHELL OIL 123|-40.25|chk"]);
  const deleted = [{ keys: H.transactionDeleteKeys(bank) }];
  check("a sync that brings the same id back is skipped", H.withoutDeletedTransactions([tx("n1", "2026-10-04", -9, "X", { simplefin_id: "S1", simplefin_account: "A" }), tx("n2", "2026-10-04", -9, "Y", { simplefin_id: "S2", simplefin_account: "A" })], deleted), { kept: [tx("n2", "2026-10-04", -9, "Y", { simplefin_id: "S2", simplefin_account: "A" })], dropped: 1 });
  check("so is a CSV that says the same thing", H.withoutDeletedTransactions([csv], deleted).dropped, 1);
  check("a different amount, date or account is a different transaction", [
    tx("z1", "2026-10-03", -40.26, "SHELL OIL 123"), tx("z2", "2026-10-04", -40.25, "SHELL OIL 123"), tx("z3", "2026-10-03", -40.25, "SHELL OIL 123", { account_id: "sav" })
  ].map((t) => H.withoutDeletedTransactions([t], deleted).dropped), [0, 0, 0]);
  check("nothing deleted: nothing changes", H.withoutDeletedTransactions([csv], []), { kept: [csv], dropped: 0 });
}

console.log("\n2. Transactions: what counts them, and taking one out");
{
  const stores = {
    installmentDebts: [{ id: "d1", provider: "Affirm", applied_payments: [{ tx_id: "t1" }] }],
    revolvingDebts: [{ id: "c1", account_id: "Card", applied_payments: [{ tx_id: "t2" }] }],
    fixedExpenses: [{ id: "f1", name: "Fiber Net", linked_payments: [{ tx_id: "t3" }] }],
    goals: [{ id: "g1", name: "Trip", contributions: [{ linked_tx_id: "t4" }] }]
  };
  check("a debt, a card, a bill and a goal each count", ["t1", "t2", "t3", "t4", "t5"].map((id) => H.transactionLinks(id, stores).map((l) => `${l.kind}:${l.name}`)), [["debt:Affirm"], ["debt:Card"], ["bill:Fiber Net"], ["goal:Trip"], []]);
  const ledger = [tx("m1", "2026-10-02", -5, "A", { transfer_pair: "m2" }), tx("m2", "2026-10-02", 5, "B", { transfer_pair: "m1", account_id: "sav" }), tx("m3", "2026-10-02", -1, "C")];
  const r = H.ledgerWithout(ledger, "m1");
  check("the row goes and its transfer partner is let go", [r.ok, r.transactions.map((t) => t.id), r.transactions[0].transfer_pair, r.removed.id], [true, ["m2", "m3"], undefined, "m1"]);
  check("the original is untouched", [ledger.length, ledger[1].transfer_pair], [3, "m1"]);
  check("a row that isn't there", H.ledgerWithout(ledger, "nope").ok, false);
}

console.log("\n3. Transactions: deleting through the plugin");
{
  const data = {
    [F.transactions]: [tx("m1", "2026-10-02", -40.25, "Shell", { manual: true }), tx("b1", "2026-10-03", -40.25, "SHELL OIL 123", { simplefin_id: "S1", simplefin_account: "A" }), tx("p1", "2026-10-03", -30, "AFFIRM")],
    [F.installmentDebts]: [{ id: "d1", provider: "Affirm", applied_payments: [{ tx_id: "p1", amount: 30 }] }],
    [F.revolvingDebts]: [], [F.fixedExpenses]: [], [F.savingsGoals]: [], [F.deletedTransactions]: []
  };
  const { plugin, get } = makePlugin(data);
  const manual = await plugin.deleteTransaction("m1");
  check("a typed-in row is deleted, and not remembered (nothing imports it)", [manual.ok, get(F.transactions).map((t) => t.id), get(F.deletedTransactions)], [true, ["b1", "p1"], []]);
  const bank = await plugin.deleteTransaction("b1");
  check("a bank row is deleted and remembered so it stays gone", [bank.ok, get(F.transactions).map((t) => t.id), get(F.deletedTransactions).map((d) => d.keys)], [true, ["p1"], [["sf:A::S1", "tx:2026-10-03|SHELL OIL 123|-40.25|chk"]]]);
  const blocked = await plugin.deleteTransaction("p1");
  check("one a debt counts is refused, and nothing changes", [blocked.ok, blocked.reason, get(F.transactions).map((t) => t.id)], [false, "Counted toward Affirm. Undo that first.", ["p1"]]);
  check("one that isn't there", (await plugin.deleteTransaction("zzz")).ok, false);

  // The confirm dialog, from the Change window.
  global.__notices = [];
  confirms.length = 0;
  await plugin.confirmDeleteTransaction(data[F.transactions][2]);
  check("asking about a counted transaction says so instead of asking", [confirms.length, global.__notices.pop()], [0, "Counted toward Affirm. Undo that first."]);
  data[F.transactions].push(tx("x1", "2026-10-05", -12, "COFFEE"));
  const { plugin: p2, get: get2 } = makePlugin(Object.assign({}, data, { [F.transactions]: [tx("x1", "2026-10-05", -12, "COFFEE")], [F.installmentDebts]: [] }));
  await p2.confirmDeleteTransaction(tx("x1", "2026-10-05", -12, "COFFEE"));
  check("it asks first, and says what imports will do", [confirms.length, lastConfirm().title, lastConfirm().body[1]], [1, "Delete this transaction?", "A later import or sync will skip it."]);
  check("nothing is deleted until you confirm", get2(F.transactions).length, 1);
  await lastConfirm().onConfirm();
  check("then it's gone", [get2(F.transactions).length, global.__notices.pop()], [0, "Transaction deleted."]);
  await p2.confirmDeleteTransaction(tx("m9", "2026-10-05", -3, "Typed", { manual: true }));
  check("a typed-in row's dialog says so", lastConfirm().body[1], "You added it by hand.");

  const src = require("fs").readFileSync(H.MAIN_PATH || require("./paths.js").MAIN, "utf8");
  check("a sync and a CSV import both skip what you deleted", (src.match(/withoutDeletedTransactions\(/g) || []).length >= 3, true);
}

console.log("\n4. The Change window offers Delete");
{
  const mk = (ctx) => {
    const m = new H.LabelModal({}, "SHELL", -40, ["Gas"], () => {}, null, ctx);
    m.close = () => {};
    m.onOpen();
    return m;
  };
  let asked = 0;
  const withDelete = mk({ onDelete: () => asked++ });
  const del = button(withDelete.contentEl, "Delete this transaction…");
  check("a quiet link at the bottom", !!del, true);
  del.onclick();
  check("it asks the caller", asked, 1);
  check("not offered where it can't be done", !!button(mk({}).contentEl, "Delete this transaction…"), false);
}

console.log("\n5. Taking a payment back off a debt");
{
  // A plan: applying rolled the due date and count forward; undoing puts them back.
  const plan = { id: "b1", provider: "Affirm", installment_amount: 30, frequency: "monthly", next_due_date: D(5), remaining_installments: 4, balance_anchor: { amount: 120, date: D(-40) }, applied_payments: [] };
  const rec = clone(plan);
  const advanced = H.applyPickedPayments(rec, [{ id: "t1", amount: -30, date: D(0) }], {}, "bnpl");
  check("applying covers the installment and rolls it on", [!!advanced, rec.remaining_installments, rec.next_due_date === advanced], [true, 3, true]);
  check("and remembers how it moved", rec.applied_payments[0].rolled, { from: D(5), to: advanced, remaining: 4 });
  const u = H.undoAppliedPayment(rec, 0, "bnpl");
  check("undoing restores the date and the count", [u.ok, rec.applied_payments.length, rec.next_due_date, rec.remaining_installments, u.restoredDue], [true, 0, D(5), 4, D(5)]);
  check("and the balance is what it was", H.debtBalance(rec), 120);

  // A payment that didn't cover it moved nothing, so there's nothing to put back.
  const part = clone(plan);
  H.applyPickedPayments(part, [{ id: "t1", amount: -10, date: D(0) }], {}, "bnpl");
  check("a part payment records no move", part.applied_payments[0].rolled, undefined);
  H.undoAppliedPayment(part, 0, "bnpl");
  check("undoing it leaves the date alone", [part.next_due_date, part.remaining_installments], [D(5), 4]);

  // One applied before this existed has no record; the date stays where it is.
  const old = clone(plan);
  old.applied_payments = [{ tx_id: "t1", amount: 30, date: D(0) }];
  old.next_due_date = H.addDays(D(5), 30);
  const ou = H.undoAppliedPayment(old, 0, "bnpl");
  check("an older payment is taken off; its due date isn't guessed at", [ou.ok, old.applied_payments.length, old.next_due_date, ou.restoredDue], [true, 0, H.addDays(D(5), 30), null]);
  check("a date you've since changed isn't overwritten", (() => {
    const r2 = clone(plan);
    H.applyPickedPayments(r2, [{ id: "t1", amount: -30, date: D(0) }], {}, "bnpl");
    r2.next_due_date = "2030-01-01";
    H.undoAppliedPayment(r2, 0, "bnpl");
    return r2.next_due_date;
  })(), "2030-01-01");

  // A card.
  const card = { account_id: "Card", due_date: D(5), min_payment_due: 35, balance_anchor: { amount: 500, date: D(-40) }, applied_payments: [] };
  const cr = clone(card);
  const cAdv = H.applyPickedPayments(cr, [{ id: "t9", amount: -35, date: D(0) }], {}, "cc");
  check("a card's minimum covered moves its due date", [!!cAdv, cr.due_date === cAdv], [true, true]);
  H.undoAppliedPayment(cr, 0, "cc");
  check("undoing it puts the due date back", [cr.due_date, cr.applied_payments.length], [D(5), 0]);

  // A loan works its due date out from its payments.
  const loan = { id: "loan-car", kind: "loan", loan_type: "car", provider: "Auto", apr: 7.49, installment_amount: 432.13, frequency: "monthly", next_due_date: "2026-11-09", loan_date: "2026-09-28", payment_category: "Car Loan", balance_anchor: { amount: 25000, date: "2026-09-28" }, applied_payments: [] };
  const lr = clone(loan);
  const lAdv = H.applyPickedPayments(lr, [{ id: "t5", amount: -432.13, date: "2026-11-09" }], {}, "loan");
  check("a loan's payment moves it on", [!!lAdv, lr.next_due_date !== "2026-11-09"], [true, true]);
  const lu = H.undoAppliedPayment(lr, 0, "loan");
  check("undoing it works the due date out again", [lr.next_due_date, lu.restoredDue], ["2026-11-09", "2026-11-09"]);
  check("an index that isn't there", H.undoAppliedPayment(clone(loan), 3, "loan").ok, false);
  const extra = clone(loan);
  H.applyPickedPayments(extra, [{ id: "t6", amount: -100, date: "2026-10-01" }], { extra: true }, "loan");
  check("an extra-toward-principal flag stays on the entry, and undoing it takes the whole entry", [extra.applied_payments[0].extra, H.undoAppliedPayment(extra, 0, "loan").ok, extra.applied_payments.length], [true, true, 0]);
}

console.log("\n6. The Applied payments window");
{
  const debt = { id: "b1", provider: "Affirm", installment_amount: 30, applied_payments: [{ tx_id: "t1", amount: 30, date: "2026-10-01" }, { tx_id: "gone", amount: 12.5, date: "2026-10-05", extra: true }, { amount: 7, date: "2026-10-03" }] };
  const m = new H.AppliedPaymentsModal({}, debt, [tx("t1", "2026-10-01", -30, "AFFIRM PAYMENT")], [], async (i) => { debt.applied_payments = debt.applied_payments.filter((_, k) => k !== i); return debt; });
  m.onOpen();
  const rows = byCls(m.contentEl, "budget-apply-row");
  check("newest first, with what each was", rows.map((r) => text(r).replace(/ Undo$/, "")), [
    "(transaction deleted) 2026-10-05 extra toward principal $12.50", "Typed in 2026-10-03 $7.00", "AFFIRM 2026-10-01 $30.00"]);
  await button(rows[0], "Undo").onclick();
  check("Undo takes one off and redraws", [debt.applied_payments.length, byCls(m.contentEl, "budget-apply-row").length], [2, 2]);
  const shown = byCls(m.contentEl, "budget-apply-row").map((r) => text(r));
  check("and it was the right one", shown.some((s) => s.includes("12.50")), false);
  debt.applied_payments = [];
  const none = new H.AppliedPaymentsModal({}, debt, [], [], async () => null);
  none.onOpen();
  check("nothing applied says so", text(none.contentEl).includes("Nothing applied."), true);
}

console.log("\n7. The Debts menu");
{
  const store = { [F.closedLoans]: "[]", [F.debtHistory]: "[]" };
  const v = Object.create(H.BudgetDashboardView.prototype);
  const calls = [];
  Object.assign(v, {
    app: { vault: { adapter: { exists: async (p) => p in store, read: async (p) => store[p], write: async (p, d) => { store[p] = d; } } } },
    sectionOpen: {}, scrollMemory: {}, lastResult: null,
    plugin: { promptLoan() {}, promptCloseLoan() {}, promptEditBNPL() {}, confirmDeleteLoan: (l) => calls.push(["delete loan", l.id]), snapshotDebt: async () => {}, refreshAfterDataChange: async () => {} }
  });
  const menuFor = async (debt) => {
    global.__menus = [];
    const root = el("div");
    await v.renderDebts(root, { allTx: [], revolvingDebts: [], installmentDebts: [debt], allDebts: [debt], categoryMetaList: [], accounts: [], ownership: null, rules: [] });
    button(root, "Edit").onclick();
    return global.__menus[0];
  };
  const plan = { id: "b1", provider: "Affirm", installment_amount: 30, frequency: "monthly", next_due_date: D(5), remaining_installments: 4, balance_anchor: { amount: 120, date: D(-40) }, applied_payments: [] };
  check("a plan with nothing applied: no Applied payments entry", (await menuFor(plan)).items.map((i) => i.title), ["Edit plan", "Set balance", "Delete…"]);
  const paid = Object.assign(clone(plan), { applied_payments: [{ tx_id: "t1", amount: 30, date: D(-1) }] });
  check("once something's applied, it's there", (await menuFor(paid)).items.map((i) => i.title), ["Edit plan", "Set balance", "Applied payments…", "Delete…"]);
  const loan = { id: "loan-car", kind: "loan", loan_type: "car", provider: "Auto", apr: 7.49, installment_amount: 432.13, frequency: "monthly", next_due_date: D(20), loan_date: D(-10), payment_category: "Car Loan", balance_anchor: { amount: 25000, date: D(-10) }, applied_payments: [{ tx_id: "t1", amount: 400, date: D(-2) }] };
  const lm = await menuFor(loan);
  check("a loan's menu has all of it", lm.items.map((i) => i.title), ["Edit loan", "Applied payments…", "Close loan…", "Delete…"]);
  lm.items[3].cb();
  check("and Delete goes to the loan's delete", calls, [["delete loan", "loan-car"]]);
}

console.log("\n8. Closed loans");
{
  const rec = { id: "old", provider: "Old Civic loan", closed: { reason: "sold", date: "2026-06-01" } };
  const { plugin, get } = makePlugin({ [F.closedLoans]: [rec, { id: "keep", provider: "Other", closed: {} }] });
  confirms.length = 0;
  plugin.confirmDeleteClosedLoan(rec);
  check("it asks first", [confirms.length, lastConfirm().title], [1, "Delete “Old Civic loan”?"]);
  check("and nothing's gone yet", get(F.closedLoans).length, 2);
  await lastConfirm().onConfirm();
  check("then only that record is", get(F.closedLoans).map((r) => r.id), ["keep"]);
}

console.log("\n9. Saved balances and statements");
{
  const snaps = [{ account_id: "hsa", statement_end: "2026-09-30", ending_value: 1000 }, { account_id: "hsa", statement_end: "2026-10-07", ending_value: 1200, manual: true }, { account_id: "401k", statement_end: "2026-09-30", ending_value: 5000 }];
  const r = H.removePortfolioSnapshot(snaps, "hsa", "2026-10-07");
  check("one account's one date goes", [r.removed, r.snapshots.map((s) => `${s.account_id}:${s.statement_end}`)], [1, ["hsa:2026-09-30", "401k:2026-09-30"]]);
  check("the same date on another account stays", H.removePortfolioSnapshot(snaps, "hsa", "2026-09-30").snapshots.some((s) => s.account_id === "401k"), true);
  check("a date that isn't there changes nothing", H.removePortfolioSnapshot(snaps, "hsa", "2020-01-01").removed, 0);
  const { plugin, get } = makePlugin({ [F.portfolioSnapshots]: snaps });
  confirms.length = 0;
  plugin.confirmRemoveSavedBalance({ id: "hsa", label: "HSA" }, snaps[1]);
  check("it asks first, naming it", [lastConfirm().title, lastConfirm().body[0]], ["Remove this balance?", "HSA · 2026-10-07 · $1200.00"]);
  await lastConfirm().onConfirm();
  check("then it's removed", get(F.portfolioSnapshots).length, 2);

  // On the Portfolio tab, per account.
  const v = Object.create(H.BudgetDashboardView.prototype);
  const asked = [];
  Object.assign(v, {
    app: { vault: { adapter: { exists: async () => true, read: async (p) => JSON.stringify(snaps), write: async () => {} } } },
    sectionOpen: {}, scrollMemory: {},
    plugin: { loadPortfolioAccounts: async () => [{ id: "hsa", label: "HSA", type: "hsa", provider: "Fidelity" }], confirmRemoveSavedBalance: (a, s) => asked.push([a.id, s.statement_end]) }
  });
  const root = el("div");
  await v.renderPortfolio(root);
  const rows = find(root, (x) => x.tag === "button" && x._text === "Remove");
  check("each saved balance has a Remove, newest first", rows.length, 2);
  rows[0].onclick();
  check("which asks about that one", asked, [["hsa", "2026-10-07"]]);
  check("the list says which one was typed in", text(root).includes("2026-10-07 · typed in"), true);
}

console.log("\n10. Monthly targets");
{
  let removed = 0, saved = 0;
  const mk = (current, baseline) => {
    const m = new H.TargetTunerModal({}, "Dining", baseline, "2026-09", current, () => saved++, () => removed++);
    m.close = () => {};
    m.onOpen();
    return m;
  };
  const withTarget = mk(150, 200);
  const rm = button(withTarget.contentEl, "Remove this target");
  check("a category with a target can lose it", !!rm, true);
  rm.onclick();
  check("which calls the remover, not the saver", [removed, saved], [1, 0]);
  check("no target: nothing to remove", !!button(mk(0, 200).contentEl, "Remove this target"), false);
  check("with no baseline to cut from, it's still there", !!button(mk(150, 0).contentEl, "Remove this target"), true);
  const noRemover = new H.TargetTunerModal({}, "Dining", 200, "2026-09", 150, () => {});
  noRemover.close = () => {};
  noRemover.onOpen();
  check("and only when the caller can remove it", !!button(noRemover.contentEl, "Remove this target"), false);
  const t = makePlugin({ [F.categories]: [{ name: "Dining", monthly_target: 150, is_transfer: false }, { name: "Gas" }] });
  await H.setCategoryTarget(t.plugin.app, "Dining", 0);
  check("setting it to nothing removes just the target", t.get(F.categories), [{ name: "Dining", is_transfer: false }, { name: "Gas" }]);
}

console.log("\n11. The pay schedule");
{
  const written = [];
  const app = { vault: { adapter: { exists: async () => false, read: async () => "{}", write: async (p, d) => written.push(d) } } };
  const run = async (paySchedule) => {
    SettingStub.texts = []; SettingStub.dropdowns = []; SettingStub.buttons = [];
    const tab = Object.create(H.BudgetSettingTab.prototype);
    tab.app = app;
    tab.plugin = { settings: { paySchedule }, refreshDashboard() {} };
    tab.display = () => {};
    await tab.renderPayScheduleSettings(el("div"));
    return tab;
  };
  let tab = await run({ cadence: "semimonthly", anchor_date: "2026-10-01", days: [10, 25] });
  const clear = SettingStub.buttons.find((b) => b.label === "Clear");
  check("a saved schedule has a Clear, even twice a month", !!clear, true);
  global.__notices = [];
  await clear.cb();
  check("it clears it and says so", [tab.plugin.settings.paySchedule, global.__notices.pop()], [null, "Pay schedule cleared."]);
  tab = await run(null);
  check("nothing saved: nothing to clear", SettingStub.buttons.some((b) => b.label === "Clear"), false);
}

console.log("\n12. Finding any transaction to apply to a debt");
{
  const ledger = [
    tx("a", D(-2), -40, "SHELL OIL 123", { resolved_category: "Gas" }),
    tx("b", D(-4), -75.5, "ACME ELECTRIC", { resolved_category: "Utilities" }),
    tx("c", D(-9), -20, "AFFIRM INC", { resolved_category: "Shopping" }),
    tx("d", D(-3), 500, "PAYROLL", { resolved_category: "Paycheck" }),
    tx("e", D(-60), -33, "OLD THING"),
    tx("f", D(-1), -12, "COFFEE", { transfer_pair: "g" }), tx("g", D(-1), 12, "COFFEE IN", { transfer_pair: "f", account_id: "sav" })
  ];
  const ids = (o) => H.searchDebits(ledger, o).map((t) => t.id);
  check("every outgoing transaction, newest first, whatever its category", ids({}), ["a", "b", "c", "e"].sort((x, y) => (ledger.find((t) => t.id === y).date < ledger.find((t) => t.id === x).date ? -1 : 1)));
  check("money in, and a confirmed transfer, aren't offered", ids({}).some((i) => ["d", "f", "g"].includes(i)), false);
  check("matching the merchant", ids({ query: "affirm" }), ["c"]);
  check("or the category", ids({ query: "utilit" }), ["b"]);
  check("or the amount, typed any way", [ids({ query: "75.50" }), ids({ query: "$75.5" }), ids({ query: "40" })], [["b"], ["b"], ["a"]]);
  check("not before the balance was set", ids({ notBefore: D(-10) }).includes("e"), false);
  check("not ones already applied here", ids({ excludeIds: new Set(["a"]) }).includes("a"), false);
  check("a limit", ids({ limit: 2 }).length, 2);

  // In the Apply payment window.
  SettingStub.buttons = [];
  const plan = { id: "b1", provider: "Affirm", installment_amount: 30, frequency: "monthly", next_due_date: D(5), remaining_installments: 4, balance_anchor: { amount: 120, date: D(-30) }, applied_payments: [{ tx_id: "applied", amount: 5 }] };
  const ownership = { settlementOf: (t) => (t.id === "b" ? { label: "Electric bill" } : null) };
  let submitted = null;
  const m = new H.ApplyPaymentModal({}, plan, [], (picked, opts) => (submitted = picked), [], [], null, ledger.concat(tx("applied", D(-5), -5, "ALREADY")), ownership);
  m.close = () => {};
  m.onOpen();
  const finder = byCls(m.contentEl, "budget-apply-find")[0];
  check("with nothing suggested, there's still a search", [!!finder, text(m.contentEl).includes("No unapplied payments found")], [true, true]);
  const box = byCls(finder, "budget-apply-search")[0];
  box.value = "";
  box.dispatchEvent({ type: "input" });
  const rows = byCls(finder, "budget-apply-row");
  check("it lists what isn't there yet, without what's already applied here or before the balance", rows.map((r) => text(r).split(" ")[0]), ["SHELL", "ACME", "AFFIRM"]);
  check("one that counts toward something else says so and can't be added", [text(rows[1]).includes("counts toward Electric bill"), !!button(rows[1], "Add")], [true, false]);
  box.value = "affirm";
  box.dispatchEvent({ type: "input" });
  button(byCls(finder, "budget-apply-row")[0], "Add").onclick();
  const listed = byCls(m.contentEl, "budget-apply-list")[0];
  const added = byCls(listed, "budget-apply-row");
  check("adding one puts it in the list, ticked", [added.length, find(added[0], (x) => x.tag === "checkbox")[0].checked, text(m.contentEl).includes("Applying $20.00")], [1, true, true]);
  check("and it's no longer offered by the search", byCls(finder, "budget-apply-row").length, 0);
  SettingStub.buttons.find((b) => b.label === "Apply selected").cb();
  check("Apply selected hands it over like any other", submitted.map((t) => t.id), ["c"]);
}

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
})().catch((e) => { console.error(e); process.exit(1); });
