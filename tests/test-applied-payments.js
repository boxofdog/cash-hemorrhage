// Applied payments, where you can see and change them: each debt's list under
// its row, with a way to correct a payment, move it to another debt of the same
// kind, or take it back; the Overview naming the payments it counted; and two
// debts that share an id being told apart.
global.document = { body: { classList: { contains: () => false } } };
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
const tx = (id, date, amount, merchant, extra = {}) => Object.assign({ id, date, amount, merchant_raw: merchant, account_id: "chk", resolved_category: "BNPL" }, extra);

// Two plans from one lender: one monthly on the 4th, one on the 6th.
const bigPlan = () => ({ id: "k1", provider: "Klarna", installment_amount: 49.48, frequency: "monthly", next_due_date: "2026-12-04", remaining_installments: 9, balance_anchor: { amount: 445.32, date: "2026-10-01" }, applied_payments: [] });
const smallPlan = () => ({ id: "k2", provider: "Klarna - Gadget", installment_amount: 23.24, frequency: "monthly", next_due_date: "2026-12-06", remaining_installments: 13, balance_anchor: { amount: 302.12, date: "2026-11-01" }, applied_payments: [] });
const card = () => ({ id: "c1", account_id: "Card", apr: 25, min_payment_due: 40, due_date: "2026-12-10", balance_anchor: { amount: 500, date: "2026-11-01" }, applied_payments: [] });
const card2 = () => ({ id: "c2", account_id: "Card Two", apr: 20, min_payment_due: 25, due_date: "2026-12-12", balance_anchor: { amount: 300, date: "2026-11-01" }, applied_payments: [] });
const loan = () => ({ id: "l1", kind: "loan", loan_type: "car", provider: "Auto", apr: 7, installment_amount: 400, frequency: "monthly", first_payment_date: "2026-11-15", next_due_date: "2026-12-15", loan_date: "2026-10-15", payment_category: "Car Loan", balance_anchor: { amount: 20000, date: "2026-10-15" }, applied_payments: [] });

(async () => {
// ===========================================================================
console.log("\n1. The same kind of debt");
{
  check("a plan and a plan; a card and a card; a loan and a loan", [H.sameDebtKind(bigPlan(), smallPlan()), H.sameDebtKind(card(), card2()), H.sameDebtKind(loan(), Object.assign(loan(), { id: "l2" }))], [true, true, true]);
  check("but not across kinds", [H.sameDebtKind(bigPlan(), card()), H.sameDebtKind(bigPlan(), loan()), H.sameDebtKind(card(), loan()), H.sameDebtKind(null, card())], [false, false, false, false]);
}

// ===========================================================================
console.log("\n2. Moving a payment");
{
  // The $23.24 prepayment for the small plan went on the big one.
  const from = bigPlan();
  from.applied_payments = [{ tx_id: "old", amount: 49.48, date: "2026-10-04" }, { tx_id: "p1", amount: 23.24, date: "2026-11-24", applied_on: "2026-11-25" }];
  const to = smallPlan();
  const balanceBefore = H.debtBalance(to);
  const r = H.moveAppliedPayment(from, 1, to, "bnpl");
  check("it comes off the first and goes on the second, still linked to its transaction", [r.ok, from.applied_payments.map((p) => p.tx_id), to.applied_payments.map((p) => [p.tx_id, p.amount, p.date])], [true, ["old"], [["p1", 23.24, "2026-11-24"]]]);
  check("a payment from after the balance was typed comes off it", [balanceBefore, H.debtBalance(to)], [302.12, r2(302.12 - 23.24)]);
  check("it covers the installment it was for, so the date moves on a month", [r.advanced, to.next_due_date, to.remaining_installments], ["2027-01-06", "2027-01-06", 12]);
  check("and the first debt's balance goes back up", H.debtBalance(from), r2(445.32 - 49.48));

  const early = smallPlan();
  early.applied_payments = [];
  const p2 = bigPlan();
  p2.applied_payments = [{ tx_id: "p2", amount: 23.24, date: "2026-10-20" }];
  const r2m = H.moveAppliedPayment(p2, 0, early, "bnpl");
  check("a payment from before the other's balance was typed counts for its installment but not the balance", [r2m.ok, H.debtBalance(early), early.next_due_date], [true, 302.12, "2026-12-06"]);

  // A payment that moved a due date puts it back when it leaves.
  const rolled = smallPlan();
  H.applyPickedPayments(rolled, [{ id: "p3", amount: -23.24, date: "2026-11-24" }], {}, "bnpl");
  check("applying it rolled the date", rolled.next_due_date, "2027-01-06");
  const home = smallPlan();
  H.moveAppliedPayment(rolled, 0, home, "bnpl");
  check("moving it away puts the first one's date and count back", [rolled.next_due_date, rolled.remaining_installments, rolled.applied_payments.length], ["2026-12-06", 13, 0]);
  check("and the second moves on instead", [home.next_due_date, home.remaining_installments], ["2027-01-06", 12]);

  const ex = loan();
  ex.applied_payments = [{ tx_id: "x1", amount: 100, date: "2026-11-20", extra: true }];
  const other = Object.assign(loan(), { id: "l2" });
  const lr = H.moveAppliedPayment(ex, 0, other, "loan");
  check("an extra-toward-principal flag goes along", [lr.ok, other.applied_payments[0].extra, ex.applied_payments.length], [true, true, 0]);

  const typed = bigPlan();
  typed.applied_payments = [{ amount: 7, date: "2026-11-02" }];
  const dest = smallPlan();
  check("a typed-in payment (no transaction) moves too", [H.moveAppliedPayment(typed, 0, dest, "bnpl").ok, dest.applied_payments.map((p) => [p.amount, p.date])], [true, [[7, "2026-11-02"]]]);

  const dup = bigPlan();
  dup.applied_payments = [{ tx_id: "same", amount: 23.24, date: "2026-11-24" }];
  const has = smallPlan();
  has.applied_payments = [{ tx_id: "same", amount: 23.24, date: "2026-11-24" }];
  const d = H.moveAppliedPayment(dup, 0, has, "bnpl");
  check("a payment the other debt already has isn't added twice, and isn't taken off either", [d.ok, d.why, dup.applied_payments.length, has.applied_payments.length], [false, "already", 1, 1]);
  const a = bigPlan();
  a.applied_payments = [{ tx_id: "q", amount: 5, date: "2026-11-02" }];
  const c = card();
  check("a plan's payment can't go to a card or a loan", [H.moveAppliedPayment(a, 0, c, "bnpl").why, H.moveAppliedPayment(a, 0, loan(), "bnpl").why, a.applied_payments.length], ["kind", "kind", 1]);
  check("nor to itself, nor one that isn't there", [H.moveAppliedPayment(a, 0, a, "bnpl").why, H.moveAppliedPayment(a, 4, smallPlan(), "bnpl").why, H.moveAppliedPayment(a, 0, null, "bnpl").why], ["same", "missing", "same"]);

  // The transaction now belongs to the second debt.
  const rows = [tx("p1", "2026-11-24", -23.24, "KLARNA PAYMENT")];
  const ownerOf = (plans) => H.completeOwnership({ installmentDebts: plans, revolvingDebts: [], fixedExpenses: [], goals: [], categoryMeta: [], rules: [] }).settlementOf(rows[0]);
  const f2 = bigPlan(); f2.applied_payments = [{ tx_id: "p1", amount: 23.24, date: "2026-11-24" }];
  const t2 = smallPlan();
  check("before the move it counts toward the first", ownerOf([f2, t2]).label, "Klarna");
  H.moveAppliedPayment(f2, 0, t2, "bnpl");
  check("after it counts toward the second", ownerOf([f2, t2]).label, "Klarna - Gadget");
}

// ===========================================================================
console.log("\n3. Correcting a payment");
{
  const plan = smallPlan();
  plan.applied_payments = [{ tx_id: "e1", amount: 10, date: "2026-11-24" }];
  const r = H.editAppliedPayment(plan, 0, { amount: "12.5", date: "2026-11-25" }, "bnpl");
  check("the amount and date change, the transaction stays linked", [r.ok, plan.applied_payments[0]], [true, { tx_id: "e1", amount: 12.5, date: "2026-11-25" }]);
  check("a payment that doesn't cover the installment leaves the date", [r.advanced, plan.next_due_date], [null, "2026-12-06"]);
  const up = H.editAppliedPayment(plan, 0, { amount: 23.24 }, "bnpl");
  check("one raised to cover it moves the date on, and remembers it did", [up.advanced, plan.next_due_date, plan.applied_payments[0].rolled], ["2027-01-06", "2027-01-06", { from: "2026-12-06", to: "2027-01-06", remaining: 13 }]);
  check("a negative amount is read as its size", [H.editAppliedPayment(plan, 0, { amount: -30 }, "bnpl").ok, plan.applied_payments[0].amount], [true, 30]);
  const before = clone(plan);
  check("a zero or junk amount, a bad date, a missing payment: refused, nothing changed", [H.editAppliedPayment(plan, 0, { amount: 0 }, "bnpl").why, H.editAppliedPayment(plan, 0, { amount: "abc" }, "bnpl").why, H.editAppliedPayment(plan, 0, { date: "11/24" }, "bnpl").why, H.editAppliedPayment(plan, 3, { amount: 5 }, "bnpl").why, plan], ["amount", "amount", "date", "missing", before]);
  check("with only a date, the amount stays", [H.editAppliedPayment(plan, 0, { date: "2026-11-20" }, "bnpl").ok, plan.applied_payments[0].amount], [true, 30]);

  const l = loan();
  l.applied_payments = [{ tx_id: "x", amount: 400, date: "2026-11-14" }];
  const lr = H.editAppliedPayment(l, 0, { amount: 400, extra: true }, "loan");
  check("on a loan, the extra-toward-principal flag can be set and cleared", [lr.ok, l.applied_payments[0].extra, H.editAppliedPayment(l, 0, { extra: false }, "loan").ok, "extra" in l.applied_payments[0]], [true, true, true, false]);
  const nonLoan = smallPlan();
  nonLoan.applied_payments = [{ tx_id: "y", amount: 5, date: "2026-11-02" }];
  H.editAppliedPayment(nonLoan, 0, { extra: true }, "bnpl");
  check("a plan has no such flag", "extra" in nonLoan.applied_payments[0], false);
}

// ===========================================================================
console.log("\n4. What Due this pay period counts");
{
  // The prepayment sits on the wrong plan. Overview: the first plan looks
  // partly paid, with the payment named. After the move it doesn't.
  const wrong = bigPlan();
  wrong.applied_payments = [{ tx_id: "p1", amount: 23.24, date: "2026-11-24" }];
  const right = smallPlan();
  const run = (plans) => H.runAllocation({ cashOnHand: 2000, todayStr: "2026-11-27", nextPaydayStr: "2026-12-05", fixedExpenses: [], installmentDebts: plans, revolvingDebts: [], transactions: [], categoryMeta: [] });
  const v = Object.create(H.BudgetDashboardView.prototype);
  Object.assign(v, { app: {}, sectionOpen: {}, scrollMemory: {}, plugin: { settings: {} } });
  const drawn = (r) => { const g = el("div"); v.renderObligationsCard(g, r, { rules: [] }); return byCls(g, "budget-fixed-row"); };

  const r1 = run([wrong, right]);
  check("only the plan due in the period is there, with what it counted", r1.dueInstallments.map((d) => [d.provider, d._paidThisPeriod, d._remaining, d._payments]), [["Klarna", 23.24, 26.24, [{ date: "2026-11-24", amount: 23.24 }]]]);
  const row = drawn(r1)[0];
  check("the row says what was counted, so a wrong one is easy to spot", [text(row).startsWith(`Klarna — $23.24 paid ${H.formatShortDate("2026-11-24")} · $23.24`), !!byCls(row, "budget-buffer-sub")[0]], [true, true]);

  H.moveAppliedPayment(wrong, 0, right, "bnpl");
  const r2x = run([wrong, right]);
  check("moved to the other plan, the first is owed in full again", r2x.dueInstallments.map((d) => [d.provider, d._paidThisPeriod, d._remaining, d._payments]), [["Klarna", 0, 49.48, []]]);
  check("and the row has nothing to say about payments", [text(drawn(r2x)[0]).includes("·"), byCls(drawn(r2x)[0], "budget-buffer-sub").length], [false, 0]);
  check("the reserve goes up by the payment that wasn't theirs", [r1.requiredMinimums, r2x.requiredMinimums], [26.24, 49.48]);

  const settled = bigPlan();
  settled.applied_payments = [{ tx_id: "s", amount: 49.48, date: "2026-11-05" }];
  const srow = drawn(run([settled]))[0];
  check("a plan that's paid shows its payment too", [text(srow).startsWith("Klarna — paid"), text(srow).includes(`${H.formatShortDate("2026-11-05")} · $49.48`)], [true, true]);
  const two = bigPlan();
  two.applied_payments = [{ amount: 10, date: "2026-11-05" }, { amount: 5, date: "2026-11-20" }];
  check("several are listed", text(drawn(run([two]))[0]).includes(`${H.formatShortDate("2026-11-05")} · $10.00, ${H.formatShortDate("2026-11-20")} · $5.00`), true);
  const edge = bigPlan();
  edge.applied_payments = [{ tx_id: "e", amount: 49.48, date: "2026-11-04" }, { tx_id: "o", amount: 23.24, date: "2026-10-20" }, { tx_id: "z", amount: 0, date: "2026-11-10" }, { tx_id: "in", amount: 5, date: "2026-11-24" }];
  const er = run([edge]);
  check("a payment on the cycle's first day was for the last one, and older ones aren't counted; a zero payment isn't named", [er.dueInstallments[0]._paidThisPeriod, er.dueInstallments[0]._payments.map((p) => p.amount), text(drawn(er)[0]).includes("$0.00")], [5, [0, 5], false]);
  check("only the ones in the cycle are named", text(drawn(er)[0]).includes(`${H.formatShortDate("2026-11-24")} · $5.00`) && !text(drawn(er)[0]).includes("$49.48 ") && !text(drawn(er)[0]).includes("$23.24"), true);
  const untouched = drawn(run([bigPlan()]))[0];
  check("an unpaid one is as it was", text(untouched).startsWith("Klarna minimum"), true);
}

// ===========================================================================
console.log("\n5. Changing them, through the plugin");
{
  const files = () => ({
    [F.installmentDebts]: [Object.assign(bigPlan(), { applied_payments: [{ tx_id: "p1", amount: 23.24, date: "2026-11-24" }, { tx_id: "p0", amount: 49.48, date: "2026-10-04" }] }), smallPlan(), loan()],
    [F.revolvingDebts]: [card(), card2()],
    [F.transactions]: []
  });
  const mk = (f) => {
    const store = {};
    Object.entries(f).forEach(([k, v]) => (store[k] = JSON.stringify(v)));
    const written = [];
    const app = { vault: { adapter: { exists: async (p) => p in store, read: async (p) => store[p], write: async (p, d) => { store[p] = d; written.push(p); }, mkdir: async () => {} } } };
    const plugin = Object.create(H.__PluginClass.prototype);
    const calls = [];
    Object.assign(plugin, { app, settings: {}, snapshotDebt: async () => calls.push("snapshot"), refreshAfterDataChange: async () => calls.push("refresh") });
    return { plugin, calls, get: (x) => JSON.parse(store[x]), written };
  };
  let { plugin, calls, get, written } = mk(files());
  global.__notices = [];
  let r = await plugin.movePayment("k1", "bnpl", 0, "k2");
  const plans = get(F.installmentDebts);
  check("Move to: it's on the other plan and off the first, in the saved file", [r.ok, plans[0].applied_payments.map((p) => p.tx_id), plans[1].applied_payments.map((p) => p.tx_id)], [true, ["p0"], ["p1"]]);
  check("it says so, with the new due date, and refreshes", [global.__notices.pop(), calls], ["Moved $23.24 to Klarna - Gadget. Next due 2027-01-06.", ["snapshot", "refresh"]]);
  check("the cards' file isn't touched, and the loan is as it was", [get(F.revolvingDebts).length, plans[2].applied_payments], [2, []]);

  ({ plugin, calls, get, written } = mk(files()));
  global.__notices = [];
  r = await plugin.movePayment("k1", "bnpl", 0, "c1");
  check("to a card: refused and told so, nothing written, nothing refreshed", [r.why, global.__notices.pop(), get(F.installmentDebts)[0].applied_payments.length, calls], ["missing", undefined, 2, []]);
  r = await plugin.movePayment("k1", "bnpl", 0, "l1");
  check("to a loan: refused with a reason", [r.why, global.__notices.pop(), calls], ["kind", "A payment can only move to a debt of the same kind.", []]);
  r = await plugin.movePayment("k1", "bnpl", 7, "k2");
  check("a payment that isn't there changes nothing", [r.ok, calls], [false, []]);
  await plugin.editPayment("k1", "bnpl", 0, { amount: 0 });
  await plugin.unapplyPayment("k1", "bnpl", 9);
  check("none of the refused ones wrote a file", written, []);
  const f = files();
  f[F.installmentDebts][1].applied_payments = [{ tx_id: "p1", amount: 23.24, date: "2026-11-24" }];
  ({ plugin, calls, get, written } = mk(f));
  global.__notices = [];
  await plugin.movePayment("k1", "bnpl", 0, "k2");
  check("one the other already has: said so, nothing changed", [global.__notices.pop(), get(F.installmentDebts)[0].applied_payments.length, get(F.installmentDebts)[1].applied_payments.length], ["Klarna - Gadget already has that payment.", 2, 1]);

  ({ plugin, calls, get, written } = mk(files()));
  global.__notices = [];
  r = await plugin.unapplyPayment("k1", "bnpl", 1);
  check("Unapply takes that payment off", [r.ok, get(F.installmentDebts)[0].applied_payments.map((p) => p.tx_id), global.__notices.pop(), calls], [true, ["p1"], "Took the $49.48 payment off.", ["snapshot", "refresh"]]);
  check("unapplying one that isn't there does nothing", [(await plugin.unapplyPayment("nope", "bnpl", 0)).ok, (await plugin.unapplyPayment("k1", "bnpl", 9)).ok], [false, false]);

  global.__notices = [];
  r = await plugin.editPayment("k1", "bnpl", 0, { amount: 30, date: "2026-11-25" });
  check("Edit: the payment changes in the file", [r.ok, get(F.installmentDebts)[0].applied_payments[0].amount, get(F.installmentDebts)[0].applied_payments[0].date, global.__notices.pop()], [true, 30, "2026-11-25", "Payment updated."]);
  r = await plugin.editPayment("k1", "bnpl", 0, { amount: 0 });
  check("a bad edit is refused and the file keeps what it had", [r.ok, get(F.installmentDebts)[0].applied_payments[0].amount], [false, 30]);
  ({ plugin, calls, get, written } = mk(files()));
  await plugin.editPayment("k1", "bnpl", 1, { amount: 50 });
  check("an edit goes to the payment you pick, not the first", get(F.installmentDebts)[0].applied_payments.map((p) => p.amount), [23.24, 50]);

  const cf = files();
  cf[F.revolvingDebts][0].applied_payments = [{ tx_id: "cp", amount: 40, date: "2026-11-20" }];
  ({ plugin, calls, get, written } = mk(cf));
  r = await plugin.movePayment("c1", "cc", 0, "c2");
  check("a card's payment moves to the other card, in the cards' file", [r.ok, get(F.revolvingDebts).map((d) => d.applied_payments.map((p) => p.tx_id)), get(F.installmentDebts)[0].applied_payments.length], [true, [[], ["cp"]], 2]);
}

// ===========================================================================
console.log("\n6. The list under a debt");
{
  const store = { [F.closedLoans]: "[]", [F.debtHistory]: "[]" };
  const plugCalls = [];
  const v = Object.create(H.BudgetDashboardView.prototype);
  let renders = 0;
  Object.assign(v, {
    app: { vault: { adapter: { exists: async (p) => p in store, read: async (p) => store[p], write: async (p, d) => { store[p] = d; } } } },
    sectionOpen: {}, scrollMemory: {}, lastResult: null,
    plugin: {
      promptLoan() {}, promptCloseLoan() {}, promptEditBNPL() {}, snapshotDebt: async () => {}, refreshAfterDataChange: async () => {},
      unapplyPayment: (...a) => plugCalls.push(["unapply", ...a]), movePayment: (...a) => plugCalls.push(["move", ...a]), editPayment: (...a) => plugCalls.push(["edit", ...a])
    }
  });
  v.render = () => { renders++; };
  const big = Object.assign(bigPlan(), { applied_payments: [{ tx_id: "p0", amount: 49.48, date: "2026-10-04" }, { tx_id: "p1", amount: 23.24, date: "2026-11-24" }, { tx_id: "gone", amount: 5, date: "2026-11-02", extra: true }, { amount: 7, date: "2026-11-03" }] });
  const small = smallPlan();
  const rows = [tx("p0", "2026-10-04", -49.48, "KLARNA PAYMENT"), tx("p1", "2026-11-24", -23.24, "KLARNA*GADGET")];
  const draw = async (debts, extra = {}) => {
    global.__menus = [];
    const root = el("div");
    const revolving = debts.filter((d) => !d.provider);
    const installment = debts.filter((d) => d.provider);
    await v.renderDebts(root, Object.assign({ allTx: rows, revolvingDebts: revolving, installmentDebts: installment, allDebts: debts, categoryMetaList: [], accounts: [], ownership: null, rules: [] }, extra));
    return root;
  };

  let root = await draw([big, small]);
  const toggle = byCls(root, "budget-debt-applied-toggle")[0];
  check("a row with payments has a quiet link saying how many", [byCls(root, "budget-debt-applied-toggle").length, toggle._text, toggle.attrs["aria-expanded"]], [1, "4 payments applied", "false"]);
  check("the count isn't repeated in the meta line", text(byCls(root, "budget-debt-row")[0]).split("payments applied").length - 1, 1);
  check("a row with none has no link", byCls(byCls(root, "budget-debt-row")[1], "budget-debt-applied-toggle").length, 0);
  check("closed, there's no list", byCls(root, "budget-debt-applied-list").length, 0);
  toggle.onclick();
  check("tapping it opens it and redraws", [v.sectionOpen["applied-k1"], renders], [true, 1]);

  root = await draw([big, small]);
  byCls(root, "budget-debt-applied-toggle")[0].onclick();
  check("tapping it again closes it", v.sectionOpen["applied-k1"], false);
  v.sectionOpen["applied-k1"] = true;
  root = await draw([big, small]);
  const open = byCls(root, "budget-debt-applied-list")[0];
  const lines = byCls(open, "budget-applied-row");
  check("open: newest first, naming each, marking what's extra", lines.map((l) => text(l).replace(/ Edit.*$/, "")), [
    `${H.displayMerchant("KLARNA*GADGET", [])} ${H.formatShortDate("2026-11-24")} $23.24`,
    `Typed in ${H.formatShortDate("2026-11-03")} $7.00`,
    `(transaction deleted) ${H.formatShortDate("2026-11-02")} extra toward principal $5.00`,
    `${H.displayMerchant("KLARNA PAYMENT", [])} ${H.formatShortDate("2026-10-04")} $49.48`
  ]);
  check("each has Edit, Move to…, Unapply", lines.map((l) => buttons(l).map((b) => b._text)), lines.map(() => ["Edit", "Move to…", "Unapply"]));
  check("the list is under the row, which also still has its Apply payment and Edit", [byCls(byCls(root, "budget-debt-row")[0], "budget-debt-applied-list").length, !!button(byCls(root, "budget-debt-row")[0], "Edit")], [1, true]);
  check("the other plan's row has no list", byCls(byCls(root, "budget-debt-row")[1], "budget-debt-applied-list").length, 0);

  // The lines are newest-first; the buttons act on the payment's own place in the debt.
  const lineFor = (what) => lines.find((l) => text(l).includes(what));
  button(lineFor("Typed in"), "Unapply").onclick();
  button(lineFor("$23.24"), "Unapply").onclick();
  check("Unapply goes to the right payment (by its place in the debt, not the list)", plugCalls.splice(0), [["unapply", "k1", "bnpl", 3], ["unapply", "k1", "bnpl", 1]]);
  button(lineFor("$23.24"), "Move to…").onclick();
  const menu = global.__menus[0];
  check("Move to… lists only the other plans, by name", menu.items.map((i) => i.title), ["Klarna - Gadget"]);
  menu.items[0].cb();
  check("and choosing one moves that payment there", plugCalls.splice(0), [["move", "k1", "bnpl", 1, "k2"]]);
  let opened = null;
  const realOpen = H.EditAppliedPaymentModal.prototype.open;
  H.EditAppliedPaymentModal.prototype.open = function () { opened = this; };
  button(lineFor("$23.24"), "Edit").onclick();
  check("Edit opens its dialog on that payment", [opened.entry.tx_id, opened.isLoanDebt], ["p1", false]);
  opened.onSubmit({ amount: 30, date: "2026-11-25" });
  check("and saving it goes to the plugin, by the payment's place in the debt", plugCalls.splice(0), [["edit", "k1", "bnpl", 1, { amount: 30, date: "2026-11-25" }]]);
  H.EditAppliedPaymentModal.prototype.open = realOpen;

  const lone = Object.assign(bigPlan(), { applied_payments: [{ tx_id: "p1", amount: 23.24, date: "2026-11-24" }] });
  v.sectionOpen = { "applied-k1": true };
  root = await draw([lone, card(), loan()]);
  check("a plan beside a card and a loan: Edit and Unapply only", buttons(byCls(root, "budget-applied-row")[0]).map((b) => b._text), ["Edit", "Unapply"]);
  const cardWith = Object.assign(card(), { applied_payments: [{ tx_id: "cp", amount: 40, date: "2026-11-20" }] });
  v.sectionOpen = { "applied-c1": true };
  root = await draw([cardWith, card2(), bigPlan()]);
  global.__menus = [];
  button(byCls(root, "budget-applied-row")[0], "Move to…").onclick();
  check("a card's payment can go to the other card, not to a plan", global.__menus[0].items.map((i) => i.title), ["Card Two"]);

  // The Edit menu's entry opens the list.
  v.sectionOpen = {};
  root = await draw([Object.assign(bigPlan(), { applied_payments: [{ tx_id: "p1", amount: 23.24, date: "2026-11-24" }] })]);
  button(root, "Edit").onclick();
  const entry = global.__menus[0].items.find((i) => i.title === "Applied payments…");
  const before = renders;
  entry.cb();
  check("Applied payments… in the Edit menu opens the list", [v.sectionOpen["applied-k1"], renders - before], [true, 1]);

  // A loan has one too, with its own flag.
  v.sectionOpen = { "applied-l1": true };
  root = await draw([Object.assign(loan(), { applied_payments: [{ tx_id: "x", amount: 400, date: "2026-11-14", extra: true }] })]);
  check("a loan's payments are listed, and its extra ones marked", [byCls(root, "budget-applied-row").length, text(byCls(root, "budget-applied-row")[0]).includes("extra toward principal")], [1, true]);
}

// ===========================================================================
console.log("\n7. The edit dialog");
{
  const submitted = [];
  const mk = (entry, isLoanDebt = false) => {
    SettingStub.buttons = []; SettingStub.texts = []; SettingStub.toggles = [];
    const m = new H.EditAppliedPaymentModal({}, entry, isLoanDebt, (c) => submitted.push(c));
    m.close = () => {};
    m.onOpen();
    return m;
  };
  const type = (t, v) => { t.inputEl.value = v; t.inputEl.dispatchEvent({ type: "input" }); };
  const save = () => SettingStub.buttons.find((b) => b.label === "Save").cb();
  let m = mk({ tx_id: "p", amount: 23.24, date: "2026-11-24" });
  check("it opens on what's there", [SettingStub.texts[0].inputEl.value, SettingStub.texts[1].inputEl.value, text(m.contentEl).includes("Edit payment")], ["23.24", "2026-11-24", true]);
  check("a plan's has no extra toggle", SettingStub.toggles.length, 0);
  save();
  check("saved as it was, nothing changes", submitted.pop(), { amount: 23.24, date: "2026-11-24" });
  type(SettingStub.texts[0], "30"); type(SettingStub.texts[1], "2026-11-25"); save();
  check("typed over, it's what's sent", submitted.pop(), { amount: 30, date: "2026-11-25" });
  global.__notices = [];
  type(SettingStub.texts[0], "0"); save();
  check("an amount of 0 is refused", [global.__notices.pop(), submitted.length], ["Amount must be above 0.", 0]);
  type(SettingStub.texts[0], "12"); type(SettingStub.texts[1], ""); save();
  check("so is no date", [global.__notices.pop(), submitted.length], ["Enter a date.", 0]);
  m = mk({ amount: 400, date: "2026-11-14", extra: true }, true);
  check("a loan's has the extra toggle, on when the payment was extra", SettingStub.toggles.length, 1);
  save();
  check("and sends it", submitted.pop(), { amount: 400, date: "2026-11-14", extra: true });
  SettingStub.toggles[0].flip(false); save();
  check("turned off, it's sent off", submitted.pop().extra, false);
}

// ===========================================================================
console.log("\n8. Two debts with one id");
{
  const run = async (items) => {
    const store = { [F.installmentDebts]: JSON.stringify(items) };
    let writes = 0;
    const app = { vault: { adapter: { exists: async (p) => p in store, read: async (p) => store[p], write: async (p, d) => { writes++; store[p] = d; } } } };
    await H.ensureIds(app, F.installmentDebts, "bnpl");
    return { writes, saved: JSON.parse(store[F.installmentDebts]) };
  };
  const a = Object.assign(bigPlan(), { id: "same" });
  const b = Object.assign(smallPlan(), { id: "same" });
  const r = await run([a, b, Object.assign(smallPlan(), { id: "other" })]);
  check("the first keeps the id, the copy gets its own; a different one is left alone", [r.saved[0].id, r.saved[1].id !== "same" && r.saved[1].id.startsWith("bnpl-"), r.saved[2].id], ["same", true, "other"]);
  check("each is found by its own key now", [H.debtKey(r.saved[0]) !== H.debtKey(r.saved[1]), r.saved[1].provider], [true, "Klarna - Gadget"]);
  const clean = await run([bigPlan(), smallPlan()]);
  check("nothing to repair: nothing written", clean.writes, 0);
  const missing = await run([Object.assign(bigPlan(), { id: undefined }), smallPlan()]);
  check("a missing id is still filled", [missing.saved[0].id.startsWith("bnpl-"), missing.writes], [true, 1]);
}

// ===========================================================================
console.log("\n9. Found by an audit: corrections and months with a 31st");
{
  const plan50 = () => ({ id: "p", provider: "Plan", installment_amount: 50, frequency: "monthly", next_due_date: "2026-12-06", remaining_installments: 10, balance_anchor: { amount: 500, date: "2026-11-01" }, applied_payments: [] });
  const apply = (rec, amount, date, tx = "t") => H.applyPickedPayments(rec, [{ id: tx, amount: -amount, date }], {}, "bnpl");

  // A payment that posts after the due date, then corrected by a day or just saved.
  const late = plan50();
  apply(late, 50, "2026-12-08");
  check("a payment posted two days late covers it: due moves on, count down", [late.next_due_date, late.remaining_installments, late.applied_payments[0].rolled], ["2027-01-06", 9, { from: "2026-12-06", to: "2027-01-06", remaining: 10 }]);
  const e1 = H.editAppliedPayment(late, 0, { date: "2026-12-09" }, "bnpl");
  check("changing its date by a day doesn't move the plan on a second month", [e1.advanced, late.next_due_date, late.remaining_installments], ["2027-01-06", "2027-01-06", 9]);
  H.editAppliedPayment(late, 0, { amount: 50, date: "2026-12-09" }, "bnpl");
  check("nor does saving it as it is, however often", [late.next_due_date, late.remaining_installments], ["2027-01-06", 9]);
  const u = H.undoAppliedPayment(late, 0, "bnpl");
  check("and taking it back after that puts the plan where it was", [u.restoredDue, late.next_due_date, late.remaining_installments], ["2026-12-06", "2026-12-06", 10]);

  const big = Object.assign(plan50(), { next_due_date: "2026-12-01" });
  apply(big, 100, "2026-12-03");
  H.editAppliedPayment(big, 0, {}, "bnpl");
  check("a payment bigger than the installment: saved unchanged, still one month on", [big.next_due_date, big.remaining_installments], ["2027-01-01", 9]);

  const card = { id: "c", account_id: "Card", min_payment_due: 40, due_date: "2026-12-10", balance_anchor: { amount: 500, date: "2026-11-01" }, applied_payments: [] };
  H.applyPickedPayments(card, [{ id: "ct", amount: -40, date: "2026-12-12" }], {}, "cc");
  H.editAppliedPayment(card, 0, { date: "2026-12-13" }, "cc");
  check("a card is the same", card.due_date, "2027-01-10");

  // Corrected down, or to a date outside the cycle: the due date goes back.
  const down = plan50();
  apply(down, 50, "2026-12-01");
  check("a $50 payment moves it on", down.next_due_date, "2027-01-06");
  const r = H.editAppliedPayment(down, 0, { amount: 20 }, "bnpl");
  check("corrected to $20 it no longer covers it, so the plan is back on its date", [r.advanced, down.next_due_date, down.remaining_installments, "rolled" in down.applied_payments[0]], [null, "2026-12-06", 10, false]);
  const run = (rec) => H.runAllocation({ cashOnHand: 2000, todayStr: "2026-12-01", nextPaydayStr: "2026-12-15", fixedExpenses: [], installmentDebts: [rec], revolvingDebts: [], transactions: [], categoryMeta: [] });
  check("so $30 is still reserved for it that period", [run(down).requiredMinimums, run(down).dueInstallments[0]._paidThisPeriod], [30, 20]);
  const away = plan50();
  apply(away, 50, "2026-12-01");
  H.editAppliedPayment(away, 0, { date: "2026-10-15" }, "bnpl");
  check("corrected to a date outside its cycle, the same", [away.next_due_date, run(away).requiredMinimums], ["2026-12-06", 50]);
  const up = plan50();
  apply(up, 20, "2026-12-01");
  check("a partial payment doesn't move it", up.next_due_date, "2026-12-06");
  const ru = H.editAppliedPayment(up, 0, { amount: 50 }, "bnpl");
  check("corrected up to the installment, it moves it, and remembers the count", [ru.advanced, up.applied_payments[0].rolled], ["2027-01-06", { from: "2026-12-06", to: "2027-01-06", remaining: 10 }]);
  H.undoAppliedPayment(up, 0, "bnpl");
  check("so taking that back restores both", [up.next_due_date, up.remaining_installments], ["2026-12-06", 10]);

  // A date you changed yourself since is left alone.
  const mine = plan50();
  apply(mine, 50, "2026-12-08");
  mine.next_due_date = "2026-12-20";
  const rm = H.editAppliedPayment(mine, 0, { amount: 60 }, "bnpl");
  check("an edit after you set the date yourself doesn't move it again, though the payment is in that cycle", [rm.advanced, mine.next_due_date, !!mine.applied_payments[0].rolled, mine.applied_payments[0].amount], [null, "2026-12-20", true, 60]);

  // Moving keeps the day an undated payment was applied.
  const lo = (id) => Object.assign(loan(), { id });
  const a = lo("la");
  a.applied_payments = [{ amount: 400, applied_on: "2026-11-14" }];
  const b = lo("lb");
  H.moveAppliedPayment(a, 0, b, "loan");
  check("an undated loan payment keeps its applied-on day when moved", b.applied_payments[0].applied_on, "2026-11-14");

  // Due on the 29th to the 31st.
  const eom = Object.assign(plan50(), { next_due_date: "2027-03-31", balance_anchor: { amount: 500, date: "2027-02-01" } });
  const adv = apply(eom, 50, "2027-03-02");
  check("due on the 31st: a payment on the 2nd is in its cycle, which began the last day of February", [adv, eom.next_due_date], ["2027-04-30", "2027-04-30"]);
  const eom2 = Object.assign(plan50(), { next_due_date: "2027-03-31", balance_anchor: { amount: 500, date: "2027-02-01" }, applied_payments: [{ tx_id: "x", amount: 50, date: "2027-03-02" }] });
  const rr = H.runAllocation({ cashOnHand: 2000, todayStr: "2027-03-20", nextPaydayStr: "2027-04-03", fixedExpenses: [], installmentDebts: [eom2], revolvingDebts: [], transactions: [], categoryMeta: [] });
  check("and the Overview agrees it's paid", [rr.dueInstallments[0]._paidThisPeriod, rr.requiredMinimums], [50, 0]);
  const feb = Object.assign(plan50(), { next_due_date: "2027-03-30", balance_anchor: { amount: 500, date: "2027-02-01" }, applied_payments: [{ tx_id: "x", amount: 50, date: "2027-02-28" }] });
  const rf = H.runAllocation({ cashOnHand: 2000, todayStr: "2027-03-20", nextPaydayStr: "2027-04-03", fixedExpenses: [], installmentDebts: [feb], revolvingDebts: [], transactions: [], categoryMeta: [] });
  check("due the 30th: Feb 28 is as far back as the cycle goes, so it isn't in it", rf.dueInstallments[0]._paidThisPeriod, 0);
}

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
})().catch((e) => { console.error(e); process.exit(1); });

function r2(n) { return Math.round(n * 100) / 100; }
