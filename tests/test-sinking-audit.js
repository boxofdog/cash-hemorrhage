// Sinking funds, the cases a review found: a fund that stops following its
// account, a withdrawal bigger than what was saved, taking back a payment dated
// off its due date, a renamed category, two rows becoming one, and a payment
// made straight out of the account the fund follows.
global.document = { body: { classList: { contains: () => false } } };
const H = require("./harness.js");
const { SettingStub } = H;

let pass = 0, fail = 0;
function check(name, got, want) {
  const ok = JSON.stringify(got) === JSON.stringify(want);
  if (ok) { pass++; console.log(`  PASS  ${name}`); }
  else { fail++; console.log(`  FAIL  ${name}: got ${JSON.stringify(got)}, want ${JSON.stringify(want)}`); }
}
const clone = (x) => JSON.parse(JSON.stringify(x));
const F = H.FILES;
const BIWEEKLY = { cadence: "biweekly", anchor_date: "2026-10-02" };
const rent = (extra = {}) => Object.assign({ id: "sink1", kind: "sinking", name: "Rent", target_amount: 1500, due_day_of_month: 1, paid_through: "2026-10-01", saved_amount: 0, contributions: [], linked_payments: [] }, extra);
const at = (fund, day) => H.sinkingHold(fund, { schedule: BIWEEKLY, todayStr: day, periodDays: 14 });
const savedFund = () => rent({ account_id: "sav", track_from: "2026-09-01", saved_amount: 1500, contributions: [{ id: "c1", amount: 1500, date: "2026-10-20", linked_tx_id: "dep", source: "account" }] });

function mk(files) {
  const store = {};
  Object.entries(files).forEach(([k, v]) => (store[k] = JSON.stringify(v)));
  const app = { vault: { adapter: { exists: async (p) => p in store, read: async (p) => store[p], write: async (p, d) => { store[p] = d; }, mkdir: async () => {} } } };
  const plugin = Object.create(H.__PluginClass.prototype);
  Object.assign(plugin, { app, settings: { paySchedule: BIWEEKLY }, refreshAfterDataChange: async () => {}, assignGoalTransfersNow: async () => 0 });
  return { plugin, app, store, get: (f) => JSON.parse(store[f]) };
}

(async () => {
// ===========================================================================
console.log("\n1. A fund that stops following its account");
{
  check("saved money with no account followed isn't there: the whole hold, not none", [at(rent({ saved_amount: 1500 }), "2026-10-30").saved, at(rent({ saved_amount: 1500 }), "2026-10-30").hold], [0, 1500]);
  check("followed, it's counted", [at(savedFund(), "2026-10-30").saved, at(savedFund(), "2026-10-30").hold], [1500, 0]);

  const files = () => ({
    [F.savingsGoals]: [savedFund()],
    [F.accounts]: [{ id: "sav", type: "savings", institution: "Savings" }, { id: "sav2", type: "savings", institution: "Other" }],
    [F.transactions]: [{ id: "dep", date: "2026-10-20", amount: 1500, account_id: "sav", resolved_category: "Transfer", merchant_raw: "FROM CHECKING" }],
    [F.fixedExpenses]: [], [F.rules]: [], [F.categories]: []
  });
  let opened = null;
  const orig = H.SinkingFundModal.prototype.open;
  H.SinkingFundModal.prototype.open = function () { opened = this; };
  const edit = async (change) => {
    const t = mk(files());
    await t.plugin.promptSinkingFund(t.get(F.savingsGoals)[0]);
    await opened.onSubmit(Object.assign({ name: "Rent", target_amount: 1500, due_day_of_month: 1, account_id: "sav", track_from: "2026-09-01", replaces_bill_id: null }, change));
    return { goal: t.get(F.savingsGoals)[0], tx: t.get(F.transactions)[0] };
  };
  let r = await edit({ account_id: null, track_from: null });
  check("clearing the account lets go of what it held: nothing saved, its transfers asked about again", [r.goal.saved_amount, r.goal.contributions, "account_id" in r.goal, r.tx.goal_review], [0, [], false, true]);
  check("so the hold is the whole bill when it's due", at(r.goal, "2026-10-30").hold, 1500);
  r = await edit({ account_id: "sav2", track_from: "2026-11-01" });
  check("pointing it at another account does too, and starts from today there", [r.goal.account_id, r.goal.saved_amount, r.goal.contributions, r.goal.track_from], ["sav2", 0, [], "2026-11-01"]);
  r = await edit({ name: "Rent!", target_amount: 1600 });
  check("changing only its name or amount keeps what the account held", [r.goal.name, r.goal.saved_amount, r.goal.contributions.length, r.tx.goal_review], ["Rent!", 1500, 1, undefined]);
  H.SinkingFundModal.prototype.open = orig;
}

// ===========================================================================
console.log("\n2. Taking more out than was saved");
{
  const goals = [rent({ account_id: "sav", saved_amount: 1000 })];
  H.assignGoalTransfer(goals, { id: "wd", date: "2026-11-01", amount: -1500 }, "sink1");
  check("it stops at nothing, with the withdrawal still on record", [goals[0].saved_amount, goals[0].contributions.map((c) => c.amount)], [0, [-1500]]);
  H.assignGoalTransfer(goals, { id: "dep2", date: "2026-11-05", amount: 500 }, "sink1");
  check("so the next deposit counts in full", goals[0].saved_amount, 500);
  const trip = [{ id: "g1", name: "Trip", target_amount: 100, saved_amount: 10, account_id: "sav", contributions: [] }];
  H.assignGoalTransfer(trip, { id: "wd2", date: "2026-11-01", amount: -30 }, "g1");
  check("an ordinary goal is as it was", trip[0].saved_amount, -20);
}

// ===========================================================================
console.log("\n3. Taking a payment back");
{
  const f = rent();
  H.recordSinkingPayment(f, "2026-11-03", { id: "p", date: "2026-11-03", amount: -1500 });
  check("paid for a date that isn't a due date: it moves on from there", [f.paid_through, at(f, "2026-11-10").due], ["2026-11-03", "2026-12-01"]);
  H.undoSinkingPayment(f);
  check("taking it back puts it where it was, not a due date earlier than that", [f.paid_through, at(f, "2026-10-10").due], ["2026-10-01", "2026-11-01"]);
  const two = rent();
  H.recordSinkingPayment(two, "2026-11-01", null);
  H.recordSinkingPayment(two, "2026-12-01", null);
  H.undoSinkingPayment(two);
  check("with two, the last one comes off and it goes back to the first's", [two.paid_through, two.linked_payments.length], ["2026-11-01", 1]);
  const old = rent({ paid_through: "2026-11-01", linked_payments: [{ tx_id: "p", amount: 1500, date: "2026-11-01", paid_for: "2026-11-01" }] });
  H.undoSinkingPayment(old);
  check("a payment saved before this worked out from its due date", old.paid_through, "2026-10-01");
}

// ===========================================================================
console.log("\n4. A renamed or deleted category");
{
  const store = {
    [F.fixedExpenses]: JSON.stringify([{ id: "b", name: "Rent bill", amount: 1500, due_day_of_month: 1, payment_category: "Housing" }]),
    [F.savingsGoals]: JSON.stringify([rent({ payment_category: "Housing" }), { id: "g", name: "Trip", target_amount: 5, contributions: [] }, rent({ id: "sink2", name: "Gas", payment_category: "Utilities" })]),
    [F.installmentDebts]: "[]", [F.revolvingDebts]: "[]", [F.rules]: "[]", [F.transactions]: "[]", [F.categories]: "[]"
  };
  const app = { vault: { adapter: { exists: async (p) => p in store, read: async (p) => store[p], write: async (p, d) => { store[p] = d; } } } };
  const n = await H.repointPaymentCategories(app, "Housing", "Shelter");
  const goals = () => JSON.parse(store[F.savingsGoals]);
  check("the fund follows the rename, as the bill does; other funds and goals don't", [n, goals()[0].payment_category, JSON.parse(store[F.fixedExpenses])[0].payment_category, goals()[2].payment_category, "payment_category" in goals()[1]], [2, "Shelter", "Shelter", "Utilities", false]);
  await H.repointPaymentCategories(app, "Shelter", null);
  check("deleting the category lets go of it", goals()[0].payment_category, null);

  // The delete dialog says what it's about to disconnect, funds included.
  const dstore = {
    [F.fixedExpenses]: JSON.stringify([{ id: "b", name: "Rent bill", amount: 1500, due_day_of_month: 1, payment_category: "Housing" }]),
    [F.savingsGoals]: JSON.stringify([rent({ payment_category: "Housing" }), rent({ id: "sink2", name: "Gas", payment_category: "Utilities" })]),
    [F.installmentDebts]: "[]", [F.revolvingDebts]: "[]", [F.rules]: "[]", [F.categories]: "[]",
    [F.transactions]: JSON.stringify([{ id: "t", date: "2026-10-01", amount: -5, merchant_raw: "X", resolved_category: "Housing", account_id: "chk" }])
  };
  const dapp = { vault: { adapter: { exists: async (p) => p in dstore, read: async (p) => dstore[p], write: async (p, d) => { dstore[p] = d; } } } };
  const tab = Object.create(H.BudgetSettingTab.prototype);
  Object.assign(tab, { app: dapp, plugin: { settings: {} }, display: () => {}, section: (c) => c, countLabel: () => "" });
  const find = (n, pred, out = []) => { if (pred(n)) out.push(n); (n.children || []).forEach((c) => find(c, pred, out)); return out; };
  const root = H.el("div");
  await tab.renderCategorySettings(root);
  let shown = null;
  const realOpen = H.DeleteCategoryModal.prototype.open;
  H.DeleteCategoryModal.prototype.open = function () { shown = this; };
  find(root, (x) => x.tag === "button" && x._text === "Delete")[0].onclick();
  H.DeleteCategoryModal.prototype.open = realOpen;
  check("deleting Housing names the bill and the fund that follow it, not the one that doesn't", shown.dependents, ["Rent bill", "Rent"]);
}

// ===========================================================================
console.log("\n5. Two rows that become one");
{
  const fund = rent({ linked_payments: [{ tx_id: "hold1", amount: 1500, date: "2026-11-01", paid_for: "2026-11-01" }] });
  const hold = { id: "hold1", date: null, pending: true, amount: -1500, merchant_raw: "POS HOLD LANDLORD PROPERTIES", account_id: "chk", resolved_category: "Rent" };
  const posted = { id: "post1", date: "2026-11-02", amount: -1500, merchant_raw: "LANDLORD PROPERTIES", account_id: "chk", resolved_category: "Rent" };
  const r = H.mergeSettledHolds([hold, posted], { goals: [fund] });
  check("a pending hold the fund was paid with is merged into its posted row, and the fund's link goes along", [r.merged, r.relink], [1, [{ from: "hold1", to: "post1", date: "2026-11-02" }]]);
  const clashing = H.mergeSettledHolds([hold, posted], { goals: [fund], fixedExpenses: [{ id: "b", name: "Other", linked_payments: [{ tx_id: "post1" }] }] });
  check("with another bill claiming the posted row, it's left for you", [clashing.merged, clashing.skipped.length], [0, 1]);
  const goals = [clone(fund)];
  const moved = H.applyTransactionRelinks(goals, r.relink, "linked_payments");
  check("the fund's payment is repointed at the surviving row", [moved.moved, goals[0].linked_payments[0].tx_id], [1, "post1"]);
  check("a goal with no payments isn't touched", H.applyTransactionRelinks([{ id: "g", contributions: [] }], r.relink, "linked_payments").moved, 0);

  const store = {
    [F.transactions]: JSON.stringify([hold, posted]), [F.savingsGoals]: JSON.stringify([fund]),
    [F.installmentDebts]: "[]", [F.revolvingDebts]: "[]", [F.fixedExpenses]: "[]"
  };
  const app = { vault: { adapter: { exists: async (p) => p in store, read: async (p) => store[p], write: async (p, d) => { store[p] = d; } } } };
  const rep = await H.repairSettledHolds(app);
  check("repairing the vault does it end to end", [rep.merged, rep.relinked, JSON.parse(store[F.savingsGoals])[0].linked_payments[0].tx_id, JSON.parse(store[F.transactions]).map((t) => t.id)], [1, 1, "post1", ["post1"]]);
  const own = H.completeOwnership({ goals: JSON.parse(store[F.savingsGoals]), categoryMeta: [] }).settlementOf(posted);
  check("so the posted rent row still counts as the fund's bill, not spending", [own && own.type, own && own.label], ["fixed_expense", "Rent"]);

  check("deleting a transaction the fund was paid with is warned about, as a bill", H.transactionLinks("pay1", { goals: [rent({ linked_payments: [{ tx_id: "pay1" }] })] }), [{ kind: "bill", name: "Rent" }]);
  check("a goal's contribution still says goal", H.transactionLinks("c", { goals: [{ id: "g", name: "Trip", contributions: [{ linked_tx_id: "c" }] }] }), [{ kind: "goal", name: "Trip" }]);

  // A typed-in row merged into the bank's.
  const manual = { id: "man1", date: "2026-11-01", amount: -1500, merchant_raw: "rent", account_id: "chk", manual: true, resolved_category: "Rent" };
  const bank = { id: "bank1", date: "2026-11-01", amount: -1500, merchant_raw: "LANDLORD", account_id: "chk", resolved_category: "Rent" };
  const t = mk({ [F.transactions]: [manual, bank], [F.savingsGoals]: [rent({ linked_payments: [{ tx_id: "man1", paid_for: "2026-11-01" }] })], [F.installmentDebts]: [], [F.revolvingDebts]: [], [F.fixedExpenses]: [] });
  check("merging a typed row into the bank's takes the fund's payment to the bank's row", [await t.plugin.mergeManualDuplicate("man1", "bank1"), t.get(F.savingsGoals)[0].linked_payments[0].tx_id, t.get(F.transactions).map((x) => x.id)], [true, "bank1", ["bank1"]]);
}

// ===========================================================================
console.log("\n6. Paid out of the account it follows");
{
  const files = (extra = {}) => Object.assign({
    [F.savingsGoals]: [savedFund()],
    [F.accounts]: [{ id: "sav", type: "savings", institution: "Savings" }, { id: "chk", type: "checking" }],
    [F.transactions]: [
      { id: "dep", date: "2026-10-20", amount: 1500, account_id: "sav", resolved_category: "Transfer", merchant_raw: "FROM CHECKING" },
      { id: "wd", date: "2026-11-01", amount: -1500, account_id: "sav", resolved_category: "Transfer", merchant_raw: "TO LANDLORD" },
      { id: "far", date: "2026-09-01", amount: -300, account_id: "sav", resolved_category: "Transfer", merchant_raw: "OLD" },
      { id: "plain", date: "2026-11-01", amount: -1500, account_id: "chk", resolved_category: "Uncategorized", merchant_raw: "LANDLORD" }
    ],
    [F.categories]: [{ name: "Transfer", is_transfer: true }], [F.fixedExpenses]: [], [F.rules]: [], [F.installmentDebts]: [], [F.revolvingDebts]: []
  }, extra);
  // The withdrawal is already filed against the fund, as money out of it.
  const base = files();
  base[F.savingsGoals][0].contributions.push({ id: "c2", amount: -1500, date: "2026-11-01", linked_tx_id: "wd", source: "account" });
  base[F.savingsGoals][0].contributions.push({ id: "c3", amount: -300, date: "2026-09-01", linked_tx_id: "far", source: "account" });
  base[F.savingsGoals][0].saved_amount = -300;
  let { plugin, get } = mk(base);
  const expense = { id: "sink1", name: "Rent", amount: 1500, fundId: "sink1" };
  const ids = async (e) => (await plugin.fixedPaymentCandidates(e, "2026-11-01")).map((t) => t.id);
  check("the withdrawal is offered as the payment, with the ordinary candidates after it", await ids(expense), ["wd", "plain"]);
  check("not for a bill, which has no fund", await ids({ id: "bill", name: "Rent", amount: 1500 }), ["plain"]);
  check("and not one that's outside the dates around the due date", (await ids(expense)).includes("far"), false);

  const f = clone(base[F.savingsGoals][0]);
  f.linked_payments = [{ tx_id: "wd", amount: 1500, paid_for: "2026-10-01" }];
  ({ plugin } = mk(Object.assign({}, base, { [F.savingsGoals]: [f, ...base[F.savingsGoals].slice(1)] })));
  check("one already used for a payment isn't offered again", (await plugin.fixedPaymentCandidates(expense, "2026-11-01")).map((t) => t.id), ["plain"]);

  // Paying it: linked to the fund, not filed as the fund's category.
  ({ plugin, get } = mk(base));
  let modal = null;
  const realOpen = H.MarkPaidModal.prototype.open;
  H.MarkPaidModal.prototype.open = function () { modal = this; };
  await plugin.markSinkingPaid("sink1");
  check("Paid hands the fund's id on, so the list knows", modal.expense.fundId, "sink1");
  await modal.onSubmit("2026-11-01", base[F.transactions][1]);
  const after = get(F.savingsGoals)[0];
  check("it's linked to the fund; it isn't asked about as a transfer again; Transfer isn't what the bill is called", [after.linked_payments.map((p) => p.tx_id), "payment_category" in after, after.paid_through], [["wd"], false, "2026-11-01"]);
  check("it wasn't taken off what's saved a second time", after.contributions.filter((c) => c.linked_tx_id === "wd").length, 1);

  ({ plugin, get } = mk(files()));
  await plugin.markSinkingPaid("sink1");
  await modal.onSubmit("2026-11-01", { id: "plain", date: "2026-11-01", amount: -1500, account_id: "chk", resolved_category: "Rent" });
  check("a payment categorised as itself still teaches the fund its category", get(F.savingsGoals)[0].payment_category, "Rent");
  H.MarkPaidModal.prototype.open = realOpen;
}

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
})().catch((e) => { console.error(e); process.exit(1); });
