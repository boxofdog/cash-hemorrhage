// Sinking funds: a bill set aside a little each paycheck.
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

// Rent: $1,500, due the 1st. Paid every other week; paydays Oct 2, Oct 16, Oct 30, Nov 13.
const BIWEEKLY = { cadence: "biweekly", anchor_date: "2026-10-02" };
const rent = (extra = {}) => Object.assign({ id: "sink1", kind: "sinking", name: "Rent", target_amount: 1500, due_day_of_month: 1, paid_through: "2026-10-01", saved_amount: 0, contributions: [], linked_payments: [] }, extra);
const at = (fund, day, schedule = BIWEEKLY, periodDays = 14) => H.sinkingHold(fund, { schedule, todayStr: day, periodDays });

(async () => {
console.log("\n1. Due dates");
{
  check("the next one after a date", [H.sinkingDueAfter(1, "2026-10-01"), H.sinkingDueAfter(1, "2026-10-02"), H.sinkingDueAfter(15, "2026-10-14"), H.sinkingDueAfter(15, "2026-10-15")], ["2026-11-01", "2026-11-01", "2026-10-15", "2026-11-15"]);
  check("the last one before a date", [H.sinkingDueBefore(1, "2026-11-01"), H.sinkingDueBefore(1, "2026-11-02"), H.sinkingDueBefore(15, "2026-10-15")], ["2026-10-01", "2026-11-01", "2026-09-15"]);
  check("across the new year", [H.sinkingDueAfter(1, "2026-12-15"), H.sinkingDueBefore(1, "2027-01-01")], ["2027-01-01", "2026-12-01"]);
  check("the 31st is a short month's last day", [H.sinkingDueAfter(31, "2026-01-31"), H.sinkingDueAfter(31, "2026-02-28"), H.sinkingDueAfter(31, "2028-01-31"), H.sinkingDueAfter(31, "2026-04-30")], ["2026-02-28", "2026-03-31", "2028-02-29", "2026-05-31"]);
  check("and looking back", [H.sinkingDueBefore(31, "2026-03-31"), H.sinkingDueBefore(30, "2026-03-30")], ["2026-02-28", "2026-02-28"]);
}

console.log("\n2. What a paycheck carries");
{
  const r = at(rent(), "2026-10-02");
  check("three paychecks before the 1st: $500 each", [r.total, r.perCheck, r.due, r.prevDue], [3, 500, "2026-11-01", "2026-10-01"]);
  check("first check: a third is held", [r.received, r.target, r.hold], [1, 500, 500]);
  check("second check: two thirds, the running total", [at(rent(), "2026-10-16").received, at(rent(), "2026-10-16").hold], [2, 1000]);
  check("third: all of it", [at(rent(), "2026-10-30").hold, at(rent(), "2026-10-31").hold], [1500, 1500]);
  check("between checks it doesn't change", at(rent(), "2026-10-09").hold, 500);
  check("before this cycle's first paycheck, nothing yet", at(rent(), "2026-10-01").hold, 0);
  check("on the due date, all of it, and unpaid it stays that way", [at(rent(), "2026-11-01").hold, at(rent(), "2026-11-05").hold, at(rent(), "2026-11-05").overdue], [1500, 1500, true]);
  check("not overdue before the day", at(rent(), "2026-10-30").overdue, false);

  const twice = { cadence: "semimonthly", anchor_date: "2026-10-10", days: [10, 25] };
  const t = at(rent(), "2026-10-10", twice);
  check("two paychecks (10th and 25th): $750 each", [t.total, t.perCheck, t.hold, at(rent(), "2026-10-25", twice).hold], [2, 750, 750, 1500]);
  const onPrev = at(rent(), "2026-10-01", { cadence: "biweekly", anchor_date: "2026-10-01" });
  check("a paycheck on the previous due date funds this cycle", [onPrev.total, onPrev.received, onPrev.hold], [3, 1, 500]);
  const onDue = at(rent(), "2026-10-20", { cadence: "biweekly", anchor_date: "2026-11-01" });
  check("one on the due date itself comes too late for it", [onDue.total, onDue.perCheck], [2, 750]);
  check("weekly: more, smaller", [at(rent(), "2026-10-02", { cadence: "weekly", anchor_date: "2026-10-02" }).total, at(rent(), "2026-10-02", { cadence: "weekly", anchor_date: "2026-10-02" }).perCheck], [5, 300]);
  const longPeriod = at(rent(), "2026-10-16", null, 60);
  check("a pay period longer than the window still holds the whole bill once", [longPeriod.total, longPeriod.hold], [1, 1500]);
  const noSchedule = at(rent(), "2026-10-16", null, 14);
  check("without a pay schedule it goes by the pay period's length", [noSchedule.total, noSchedule.received, noSchedule.hold], [2, 2, 1500]);

  const lateInWindow = at(rent(), "2026-10-30", null, 14);
  check("going by the pay period, it never holds more than the bill before the day", [lateInWindow.received, lateInWindow.hold, lateInWindow.overdue], [2, 1500, false]);
  const unknown = at(rent(), "2026-10-16", { cadence: "every-full-moon", anchor_date: "2026-10-02" }, 14);
  check("a pay schedule it can't read is as good as none", [unknown.total, unknown.received, unknown.hold], [noSchedule.total, noSchedule.received, noSchedule.hold]);

  check("money in the savings account counts as set aside, so less is held here", [at(rent({ saved_amount: 500 }), "2026-10-16").hold, at(rent({ saved_amount: 500 }), "2026-10-16").saved], [500, 500]);
  check("enough in savings: nothing held", at(rent({ saved_amount: 1000 }), "2026-10-16").hold, 0);
  check("more than the bill isn't more than the bill", [at(rent({ saved_amount: 9000 }), "2026-10-30").saved, at(rent({ saved_amount: 9000 }), "2026-10-30").hold], [1500, 0]);
  check("a negative balance is nothing", at(rent({ saved_amount: -200 }), "2026-10-16").hold, 1000);
  check("set aside counts whichever is more, the plan or the savings", [H.sinkingSetAside(at(rent(), "2026-10-16")), H.sinkingSetAside(at(rent({ saved_amount: 1200 }), "2026-10-16"))], [1000, 1200]);
  const prog = H.sinkingProgress(at(rent(), "2026-10-16"));
  check("the goal row's bar", [prog.saved, prog.target, prog.remaining, Math.round(prog.pct)], [1000, 1500, 500, 67]);

  const paid = at(rent({ paid_through: "2026-11-01" }), "2026-11-13");
  check("once a due date is paid, the next one starts", [paid.due, paid.prevDue, paid.total, paid.received, paid.hold], ["2026-12-01", "2026-11-01", 2, 1, 750]);
  check("a new fund starts on the next due date after today", at(rent({ paid_through: undefined }), "2026-10-20").due, "2026-11-01");
  check("a fund with no amount or day can't be planned", [at(rent({ target_amount: 0 }), "2026-10-02"), at(rent({ due_day_of_month: 0 }), "2026-10-02"), at(rent({ due_day_of_month: 40 }), "2026-10-02")], [null, null, null]);

  const rows = H.sinkingHolds([rent(), rent({ id: "s2", name: "Insurance", target_amount: 600, due_day_of_month: 15, paid_through: "2026-09-15" }), { id: "g1", name: "Trip" }], { schedule: BIWEEKLY, todayStr: "2026-10-16", periodDays: 14 });
  check("every fund's standing, and what they hold together", [rows.rows.map((x) => x.name), rows.total], [["Rent", "Insurance"], 1000 + at(rent({ id: "s2", target_amount: 600, due_day_of_month: 15, paid_through: "2026-09-15" }), "2026-10-16").hold]);
}

console.log("\n3. Paying it, and taking that back");
{
  const f = rent();
  H.recordSinkingPayment(f, "2026-11-01", { id: "tx1", date: "2026-11-01", amount: -1500, resolved_category: "Rent" });
  check("the payment is linked and the fund moves on", [f.paid_through, f.linked_payments, f.payment_category], ["2026-11-01", [{ tx_id: "tx1", amount: 1500, date: "2026-11-01", paid_for: "2026-11-01" }], "Rent"]);
  check("its next due date is the month after", at(f, "2026-11-13").due, "2026-12-01");
  H.recordSinkingPayment(f, "2026-12-01", null);
  check("paid with no transaction picked", [f.paid_through, f.linked_payments[1].tx_id], ["2026-12-01", null]);
  const gone = H.undoSinkingPayment(f);
  check("undo takes back the latest and reopens that due date", [gone.paid_for, f.paid_through, f.linked_payments.length], ["2026-12-01", "2026-11-01", 1]);
  H.undoSinkingPayment(f);
  check("and the one before", [f.paid_through, f.linked_payments.length], ["2026-10-01", 0]);
  check("nothing left to take back", H.undoSinkingPayment(f), null);
  const learned = rent({ payment_category: "Housing" });
  H.recordSinkingPayment(learned, "2026-11-01", { id: "t", amount: -1, date: "2026-11-01", resolved_category: "Rent" });
  check("it keeps the category it already had", learned.payment_category, "Housing");
}

console.log("\n4. What it holds back");
{
  const base = { cashOnHand: 3000, todayStr: "2026-10-02", nextPaydayStr: "2026-10-16", fixedExpenses: [], installmentDebts: [], revolvingDebts: [], bufferMode: "manual", manualBuffer: 300, currentDateStr: "2026-10-02" };
  const none = H.runAllocation(base);
  const one = H.runAllocation(Object.assign({}, base, { goals: [rent()], sinkingRows: [at(rent(), "2026-10-02")] }));
  check("it's committed, and comes off what's free", [one.sinkingHeld, one.committed - none.committed, one.sinkingRows.length], [500, 500, 1]);
  check("so there is less to put toward debt or savings", [none.availableForDebt - one.availableForDebt, one.sinkingRows[0].name], [500, "Rent"]);
  const later = H.runAllocation(Object.assign({}, base, { todayStr: "2026-10-16", nextPaydayStr: "2026-10-30", goals: [rent()], sinkingRows: [at(rent(), "2026-10-16")] }));
  check("the second check: the running total, not just its share", later.sinkingHeld, 1000);
  const mid = H.runAllocation(Object.assign({}, base, { goals: [rent({ saved_amount: 500 })], sinkingRows: [at(rent({ saved_amount: 500 }), "2026-10-02")] }));
  check("a transfer already in savings isn't held back again", mid.sinkingHeld, 0);

  // The bill it takes over is held back by the fund, not also due in full.
  const bill = { id: "bill1", name: "Rent", amount: 1500, due_day_of_month: 1 };
  const dueNow = { todayStr: "2026-10-30", nextPaydayStr: "2026-11-13", currentDateStr: "2026-10-30", fixedExpenses: [bill] };
  const both = H.runAllocation(Object.assign({}, base, dueNow, { goals: [rent({ replaces_bill_id: "bill1" })], sinkingRows: [at(rent(), "2026-10-30")] }));
  check("a bill a fund has taken over isn't due as well", [both.periodFixed.length, both.periodFixedTotal, both.sinkingHeld], [0, 0, 1500]);
  const separate = H.runAllocation(Object.assign({}, base, dueNow, { goals: [rent()], sinkingRows: [at(rent(), "2026-10-30")] }));
  check("one it hasn't taken over still is", [separate.periodFixed.length, separate.periodFixedTotal], [1, 1500]);
  const stale = H.runAllocation(Object.assign({}, base, dueNow, { goals: [rent({ replaces_bill_id: "gone" })], sinkingRows: [] }));
  check("a fund pointing at a bill that's gone changes nothing", stale.periodFixed.length, 1);
  check("a fund isn't a goal: it's left out of the savings recommendations and goal list", [H.regularGoals([rent(), { id: "g", name: "Trip" }]).map((g) => g.id), H.sinkingFunds([rent(), { id: "g" }]).map((g) => g.id)], [["g"], ["sink1"]]);
  check("its logged contributions aren't also held back as earmarked", H.earmarkedSavings([rent({ contributions: [{ id: "c", amount: 300 }] }), { id: "g", contributions: [{ id: "c2", amount: 40 }] }]), 40);
}

console.log("\n5. A payment is a bill paid");
{
  const idx = H.buildOwnershipIndex({ goals: [rent({ linked_payments: [{ tx_id: "pay1", amount: 1500, paid_for: "2026-11-01" }], payment_category: "Housing" })] });
  check("the linked payment settles the fund as a bill", [idx.classOf({ id: "pay1", amount: -1500, resolved_category: "Rent" }), idx.settlementOf({ id: "pay1", amount: -1500 }).label], ["fixed_expense", "Rent"]);
  check("charges in its category read as that bill", [idx.classOf({ id: "x", amount: -1500, resolved_category: "Housing" }), idx.classOf({ id: "y", amount: -5, resolved_category: "Rent" })], ["fixed_expense", "fixed_expense"]);
  check("a category a bill uses is scheduled", [idx.isScheduledCategory("Rent"), idx.isScheduledCategory("Housing"), idx.isScheduledCategory("Gas")], [true, true, false]);
}

console.log("\n6. Transfers into its savings account");
{
  const fund = rent({ account_id: "sav", track_from: "2026-10-01" });
  const trip = { id: "g1", name: "Trip", target_amount: 1000, saved_amount: 0, account_id: "sav", track_from: "2026-10-01", contributions: [] };
  const tx = (id, amount, date) => ({ id, date, amount, merchant_raw: "Transfer", account_id: "sav", resolved_category: "Transfer" });
  check("a fund follows an account like a goal does", [H.accountGoals([fund, trip]).map((g) => g.id), H.assignableGoals([fund, trip, { id: "cap", kind: "capped" }]).map((g) => g.id)], [["sink1", "g1"], ["sink1", "g1"]]);
  const alone = H.goalTransferQueue([tx("t1", 500, "2026-10-02")], [fund]);
  check("the only thing on the account: the transfer goes to it on its own", [alone.auto.map((a) => a.goalId), alone.ask.length], [["sink1"], 0]);
  const shared = H.goalTransferQueue([tx("t1", 500, "2026-10-02")], [fund, trip]);
  check("sharing the account with a goal: you're asked which", [shared.auto.length, shared.ask[0].goalIds], [0, ["sink1", "g1"]]);

  const goals = [clone(fund)];
  const r = H.assignGoalTransfer(goals, tx("t1", 500, "2026-10-02"), "sink1");
  check("assigned, it's money in the fund's savings", [!!r, goals[0].saved_amount], [true, 500]);
  check("so the hold is that much less", at(goals[0], "2026-10-02").hold, 0);
  check("and a withdrawal takes it back off", (() => {
    H.assignGoalTransfer(goals, tx("t2", -500, "2026-10-20"), "sink1");
    return goals[0].saved_amount;
  })(), 0);
  const choices = H.goalAccountChoices([{ id: "sav", type: "savings", institution: "Savings" }, { id: "chk", type: "checking" }], [fund, trip], null);
  check("it can follow the savings account the goals use", choices.map((c) => [c.id, c.others]), [["sav", ["Rent", "Trip"]]]);
  const cappedAccount = H.goalAccountChoices([{ id: "oops", type: "savings" }], [{ id: "cap", kind: "capped", account_id: "oops" }], null);
  check("but not an account a capped fund owns", cappedAccount, []);
}

console.log("\n7. On screen");
{
  const row = at(rent(), "2026-10-16");
  const calls = [];
  const v = Object.create(H.BudgetDashboardView.prototype);
  Object.assign(v, { app: {}, sectionOpen: {}, scrollMemory: {}, plugin: { markSinkingPaid: (id) => calls.push(["paid", id]), promptSinkingFund: (g) => calls.push(["edit", g && g.id]), confirmDeleteSinkingFund: (g) => calls.push(["delete", g.id]), undoSinkingPaid: (id) => calls.push(["undo", id]), settings: { paySchedule: BIWEEKLY } } });
  const grid = el("div");
  v.renderObligationsCard(grid, { periodFixed: [], periodFixedPaid: [], dueInstallments: [], dueRevolvingMins: [], earmarked: 0, minimumsPaid: 0, sinkingRows: [row] }, { rules: [] });
  const li = byCls(grid, "budget-fixed-row")[0];
  check("Due this pay period: the fund, what it's set aside of, and the check", [text(li).startsWith("Rent $500.00 a check \u00b7 due"), text(li).includes("$1000.00"), !!button(li, "Paid")], [true, true, true]);
  check("the held amount is what's shown as the figure", text(byCls(li, "budget-amount")[0]), "$1000.00");
  button(li, "Paid").onclick();
  check("Paid opens it for that fund", calls.pop(), ["paid", "sink1"]);
  const withSavings = el("div");
  v.renderObligationsCard(withSavings, { periodFixed: [], periodFixedPaid: [], dueInstallments: [], dueRevolvingMins: [], earmarked: 0, minimumsPaid: 0, sinkingRows: [at(rent({ saved_amount: 400 }), "2026-10-16")] }, { rules: [] });
  check("what's in savings is said too", text(withSavings).includes("$400.00 in savings"), true);
  const overdue = el("div");
  v.renderObligationsCard(overdue, { periodFixed: [], periodFixedPaid: [], dueInstallments: [], dueRevolvingMins: [], earmarked: 0, minimumsPaid: 0, sinkingRows: [at(rent(), "2026-11-05")] }, { rules: [] });
  check("an overdue one says so", text(overdue).includes("was due Nov 1"), true);
  const noneYet = el("div");
  v.renderObligationsCard(noneYet, { periodFixed: [], periodFixedPaid: [], dueInstallments: [], dueRevolvingMins: [], earmarked: 0, minimumsPaid: 0 }, { rules: [] });
  check("a saved period from before has none, and nothing breaks", byCls(noneYet, "budget-fixed-row").length, 0);

  // The goals card
  const goalsCard = el("div");
  const f = rent({ account_id: "sav", linked_payments: [{ tx_id: "p", paid_for: "2026-10-01" }] });
  const saved = [{ id: "g1", name: "Trip", target_amount: 1000, saved_amount: 100, contributions: [] }, f];
  v.renderGoalsCard(goalsCard, { allTx: [], rules: [], savingsGoals: saved, accounts: [{ id: "sav", type: "savings", institution: "Savings" }], ownership: null });
  const rows = byCls(goalsCard, "budget-goal-row");
  check("the Savings goals card lists it after the goals", rows.map((r) => text(byCls(r, "budget-goal-name")[0])), ["Trip", "Rent"]);
  const fundRow = rows[1];
  check("with Paid, Undo, Edit and Delete, and no Pin or Add Funds", buttons(fundRow).map((b) => b._text).filter((t) => ["Paid", "Undo last paid", "Edit", "Delete", "Pin to dashboard", "Add Funds"].includes(t)), ["Paid", "Undo last paid", "Edit", "Delete"]);
  check("the goal beside it still has its own", buttons(rows[0]).map((b) => b._text).includes("Add Funds"), true);
  check("it says what a check carries, when it's due and what it follows", text(byCls(fundRow, "budget-goal-meta")[0]).includes("a check") && /due [A-Z][a-z]{2} \d+/.test(text(fundRow)) && text(fundRow).includes("follows Savings"), true);
  button(fundRow, "Edit").onclick();
  button(fundRow, "Delete").onclick();
  button(fundRow, "Undo last paid").onclick();
  button(fundRow, "Paid").onclick();
  check("each goes to the fund's own flow", calls.splice(0), [["edit", "sink1"], ["delete", "sink1"], ["undo", "sink1"], ["paid", "sink1"]]);
  check("the card has a button for a new one", !!button(goalsCard, "New sinking fund"), true);
  const inboxCard = el("div");
  const sharedSavings = { id: "sav", type: "savings", institution: "Savings" };
  v.renderGoalTransferInbox(inboxCard, [{ tx: { id: "in1", date: "2026-10-20", amount: 500, merchant_raw: "TRANSFER FROM CHECKING", account_id: "sav" }, goalIds: ["sink1", "g1"], suggested: [] }], { rules: [], savingsGoals: [Object.assign(clone(saved[1]), { account_id: "sav" }), Object.assign(clone(saved[0]), { account_id: "sav" })], accounts: [sharedSavings] });
  check("a transfer into an account the fund shares can be answered with the fund", byCls(inboxCard, "budget-goal-inbox-btns").map((b) => buttons(b).map((x) => x._text)), [["Rent", "Trip", "Not for a goal"]]);
  const onlyFund = el("div");
  v.renderGoalsCard(onlyFund, { allTx: [], rules: [], savingsGoals: [rent()], accounts: [], ownership: null });
  check("a card with only a fund isn't 'no goals yet'", [text(onlyFund).includes("No goals yet"), byCls(onlyFund, "budget-goal-row").length], [false, 1]);
}

console.log("\n8. The dialog");
{
  const submitted = [];
  const mk = (existing = null, opts = {}) => {
    SettingStub.buttons = []; SettingStub.texts = []; SettingStub.dropdowns = [];
    const m = new H.SinkingFundModal({}, (d) => submitted.push(d), existing, opts);
    m.close = () => {};
    m.onOpen();
    return m;
  };
  const fill = (vals) => {
    const [name, amount, day] = SettingStub.texts;
    name.inputEl.value = vals.name; name.inputEl.dispatchEvent({ type: "input" });
    amount.inputEl.value = vals.amount; amount.inputEl.dispatchEvent({ type: "input" });
    day.inputEl.value = vals.day; day.inputEl.dispatchEvent({ type: "input" });
  };
  const save = () => SettingStub.buttons.find((b) => b.label === "Create" || b.label === "Save changes").cb();
  global.__notices = [];
  mk();
  fill({ name: "Rent", amount: "1,500", day: "1" });
  save();
  check("a name, an amount and a day make one", submitted.pop(), { name: "Rent", target_amount: 1500, due_day_of_month: 1, account_id: null, track_from: null, replaces_bill_id: null });
  mk(); fill({ name: "", amount: "1500", day: "1" }); save();
  check("no name", global.__notices.pop(), "Give it a name.");
  mk(); fill({ name: "Rent", amount: "0", day: "1" }); save();
  check("no amount", global.__notices.pop(), "Amount due must be above 0.");
  mk(); fill({ name: "Rent", amount: "1500", day: "0" }); save();
  check("a day that isn't one", global.__notices.pop(), "Due day: a number from 1 to 31.");
  mk(); fill({ name: "Rent", amount: "1500", day: "32" }); save();
  check("or past 31", global.__notices.pop(), "Due day: a number from 1 to 31.");
  mk(); fill({ name: "Rent", amount: "1500", day: "1.5" }); save();
  check("or a fraction", global.__notices.pop(), "Due day: a number from 1 to 31.");
  check("nothing was saved by those", submitted.length, 0);

  mk(null, { prefill: { id: "bill1", name: "Rent", amount: 1500, due_day_of_month: 1 }, bills: [{ id: "bill1", name: "Rent", amount: 1500 }] });
  check("started from a bill: filled in, and it takes that bill over", [SettingStub.texts.map((t) => t.inputEl.value), SettingStub.dropdowns[0].value], [["Rent", "1500", "1"], "bill1"]);
  save();
  check("so it's saved with that bill", [submitted.pop().replaces_bill_id], ["bill1"]);

  mk(null, { accountChoices: [{ id: "sav", label: "Savings", others: ["Trip"] }] });
  fill({ name: "Rent", amount: "1500", day: "1" });
  SettingStub.dropdowns[0].choose("sav");
  save();
  const withAccount = submitted.pop();
  check("with an account, it counts transfers from today, and says it shares the account", [withAccount.account_id, withAccount.track_from, SettingStub.dropdowns[0].options.map((o) => o.label).pop()], ["sav", H.todayLocal(), "Savings (also Trip)"]);
  mk(rent({ account_id: "sav", track_from: "2026-09-01" }), { accountChoices: [{ id: "sav", label: "Savings", others: [] }] });
  save();
  check("editing keeps where it counts from", [submitted.pop().track_from], ["2026-09-01"]);
  check("and the dialog says edit", text(mk(rent()).contentEl).startsWith("Edit sinking fund: Rent"), true);
}

console.log("\n9. Saving, paying, deleting");
{
  const mkPlugin = (files) => {
    const store = {};
    Object.entries(files).forEach(([k, v]) => (store[k] = JSON.stringify(v)));
    const app = { vault: { adapter: { exists: async (p) => p in store, read: async (p) => store[p], write: async (p, d) => { store[p] = d; } } } };
    const plugin = Object.create(H.__PluginClass.prototype);
    Object.assign(plugin, { app, settings: { paySchedule: BIWEEKLY }, refreshAfterDataChange: async () => {}, assignGoalTransfersNow: async () => 0 });
    return { plugin, store, get: (f) => JSON.parse(store[f]) };
  };
  const files = () => ({
    [F.savingsGoals]: [], [F.accounts]: [{ id: "sav", type: "savings", institution: "Savings" }, { id: "chk", type: "checking" }],
    [F.fixedExpenses]: [{ id: "bill1", name: "Rent", amount: 1500, due_day_of_month: 1 }, { id: "bill2", name: "Gym", amount: 20, interval_days: 30, next_due_date: "2026-11-01" }],
    [F.transactions]: [], [F.rules]: [], [F.categories]: [], [F.revolvingDebts]: [], [F.installmentDebts]: [], [F.subscriptionReviews]: []
  });
  let opened = null;
  const origOpen = H.SinkingFundModal.prototype.open;
  H.SinkingFundModal.prototype.open = function () { opened = this; };

  let { plugin, get } = mkPlugin(files());
  await plugin.promptSinkingFund(null, { id: "bill1", name: "Rent", amount: 1500, due_day_of_month: 1 });
  check("the dialog offers monthly bills only, and the savings account", [opened.bills.map((b) => b.id), opened.accountChoices.map((c) => c.id)], [["bill1"], ["sav"]]);
  await opened.onSubmit({ name: "Rent", target_amount: 1500, due_day_of_month: 1, account_id: "sav", track_from: "2026-10-01", replaces_bill_id: "bill1" });
  const made = get(F.savingsGoals)[0];
  check("a new fund is a sinking goal that starts on the next due date", [made.kind, made.id.startsWith("sink-"), made.contributions, made.saved_amount, made.linked_payments, made.account_id, made.replaces_bill_id, made.paid_through <= H.todayLocal() && made.paid_through > H.addDays(H.todayLocal(), -32)], ["sinking", true, [], 0, [], "sav", "bill1", true]);
  await plugin.promptSinkingFund(made);
  check("a bill another fund has taken over isn't offered again", opened.bills.map((b) => b.id).includes("bill1"), true);
  await plugin.promptSinkingFund(null);
  check("…to a second fund", opened.bills.map((b) => b.id), []);
  await plugin.promptSinkingFund(made);
  await opened.onSubmit({ name: "Rent!", target_amount: 1600, due_day_of_month: 3, account_id: null, track_from: null, replaces_bill_id: null });
  const edited = get(F.savingsGoals)[0];
  check("editing changes the plan and keeps its history; clearing the account clears the rest", [edited.name, edited.target_amount, edited.due_day_of_month, edited.id === made.id, edited.paid_through === made.paid_through, "account_id" in edited, "track_from" in edited, "replaces_bill_id" in edited], ["Rent!", 1600, 3, true, true, false, false, false]);
  H.SinkingFundModal.prototype.open = origOpen;

  // Paying it.
  const sav = rent({ account_id: "sav", track_from: "2026-10-01" });
  ({ plugin, get } = mkPlugin(Object.assign(files(), { [F.savingsGoals]: [sav], [F.transactions]: [
    { id: "pay", date: "2026-11-01", amount: -1500, merchant_raw: "LANDLORD", account_id: "chk", resolved_category: "Rent" },
    { id: "wd", date: "2026-11-01", amount: -1500, merchant_raw: "TO CHECKING", account_id: "sav", resolved_category: "Transfer" }
  ] })));
  let paidModal = null;
  const origPaid = H.MarkPaidModal.prototype.open;
  H.MarkPaidModal.prototype.open = function () { paidModal = this; };
  await plugin.markSinkingPaid("sink1");
  check("Paid opens on the due date it's building toward, as the fund", [paidModal.defaultDate, paidModal.expense.name, paidModal.expense.amount], [H.sinkingHold(sav, { schedule: BIWEEKLY, todayStr: H.todayLocal() }).due, "Rent", 1500]);
  global.__notices = [];
  await paidModal.onSubmit("2026-11-01", { id: "pay", date: "2026-11-01", amount: -1500, resolved_category: "Rent", account_id: "chk" });
  let f = get(F.savingsGoals)[0];
  check("it's linked, and the fund moves on", [f.paid_through, f.linked_payments.map((p) => p.tx_id), f.saved_amount, global.__notices.pop().startsWith("Rent paid. Next due 2026-12-01")], ["2026-11-01", ["pay"], 0, true]);
  check("a payment from checking doesn't touch what savings holds", f.contributions, []);

  ({ plugin, get } = mkPlugin(Object.assign(files(), { [F.savingsGoals]: [Object.assign(clone(sav), { saved_amount: 1500, contributions: [{ id: "c1", amount: 1500, date: "2026-10-20", linked_tx_id: "dep", source: "account" }] })], [F.transactions]: [
    { id: "dep", date: "2026-10-20", amount: 1500, account_id: "sav", resolved_category: "Transfer" },
    { id: "wd", date: "2026-11-01", amount: -1500, merchant_raw: "RENT FROM SAVINGS", account_id: "sav", resolved_category: "Rent", goal_review: true }
  ] })));
  await plugin.markSinkingPaid("sink1");
  await paidModal.onSubmit("2026-11-01", { id: "wd", date: "2026-11-01", amount: -1500, resolved_category: "Rent", account_id: "sav" });
  f = get(F.savingsGoals)[0];
  check("paid out of the savings account, it also comes off what's saved there", [f.saved_amount, f.contributions.map((c) => [c.amount, c.linked_tx_id])], [0, [[1500, "dep"], [-1500, "wd"]]]);
  check("and it isn't asked about again", [get(F.transactions).find((t) => t.id === "wd").goal_review, H.goalTransferQueue(get(F.transactions), get(F.savingsGoals)).ask.length], [undefined, 0]);
  check("it keeps its own category, not Transfer", get(F.transactions).find((t) => t.id === "wd").resolved_category, "Rent");

  await plugin.markSinkingPaid("nope");
  H.MarkPaidModal.prototype.open = origPaid;

  // Undo.
  global.__notices = [];
  await plugin.undoSinkingPaid("sink1");
  check("Undo reopens the due date", [get(F.savingsGoals)[0].paid_through, get(F.savingsGoals)[0].linked_payments.length, global.__notices.pop()], ["2026-10-01", 0, "Took back the Rent payment."]);
  await plugin.undoSinkingPaid("sink1");

  // Delete.
  const confirms = [];
  const origConfirm = H.ConfirmModal.prototype.open;
  H.ConfirmModal.prototype.open = function () { confirms.push(this.opts); };
  ({ plugin, get } = mkPlugin(Object.assign(files(), { [F.savingsGoals]: [rent({ replaces_bill_id: "bill1", linked_payments: [{ tx_id: "p", paid_for: "2026-10-01" }] }), { id: "g1", name: "Trip", target_amount: 100, contributions: [] }] })));
  plugin.releaseGoalTransfers = async () => 0;
  plugin.confirmDeleteSinkingFund(get(F.savingsGoals)[0]);
  check("it asks first, and says what changes", [confirms[0].title, confirms[0].body.filter(Boolean)], ["Delete “Rent”?", ["It stops holding money back for this. Nothing moves.", "The bill it took over goes back to being due in full.", "1 payment you linked will count as spending again."]]);
  check("nothing's gone until you say", get(F.savingsGoals).length, 2);
  await confirms[0].onConfirm();
  check("then only that fund is", get(F.savingsGoals).map((g) => g.id), ["g1"]);

  // Its transfers aren't then asked about as if they belonged to nothing.
  ({ plugin, get } = mkPlugin(Object.assign(files(), {
    [F.savingsGoals]: [rent({ account_id: "sav", saved_amount: 500, contributions: [{ id: "c1", amount: 500, date: "2026-10-20", linked_tx_id: "dep", source: "account" }] })],
    [F.transactions]: [{ id: "dep", date: "2026-10-20", amount: 500, account_id: "sav", resolved_category: "Transfer" }, { id: "other", date: "2026-10-21", amount: 40, account_id: "sav", resolved_category: "Transfer" }]
  })));
  confirms.length = 0;
  plugin.confirmDeleteSinkingFund(get(F.savingsGoals)[0]);
  await confirms[0].onConfirm();
  check("deleting a fund marks the transfers it had as not for any goal, and only those", [get(F.savingsGoals).length, get(F.transactions).map((t) => [t.id, t.goal_skip === true])], [0, [["dep", true], ["other", false]]]);
  H.ConfirmModal.prototype.open = origConfirm;
}

console.log("\n10. Settings");
{
  const goalsSaved = [rent({ account_id: "sav", replaces_bill_id: "bill1" }), { id: "g1", name: "Trip", target_amount: 100, contributions: [] }];
  const store = { [F.savingsGoals]: JSON.stringify(goalsSaved), [F.accounts]: JSON.stringify([{ id: "sav", type: "savings", institution: "Savings" }]), [F.fixedExpenses]: JSON.stringify([{ id: "bill1", name: "Rent", amount: 1500, due_day_of_month: 1 }, { id: "bill3", name: "Phone", amount: 40, due_day_of_month: 9 }, { id: "bill2", name: "Gym", amount: 20, interval_days: 30, next_due_date: "2026-11-01" }]), [F.categories]: "[]" };
  const app = { vault: { adapter: { exists: async (p) => p in store, read: async (p) => store[p], write: async (p, d) => { store[p] = d; } } } };
  const calls = [];
  const tab = Object.create(H.BudgetSettingTab.prototype);
  tab.app = app;
  tab.plugin = { settings: {}, promptSinkingFund: (g, bill) => calls.push(["fund", g && g.id, bill && bill.id]), confirmDeleteSinkingFund: (g) => calls.push(["delete", g.id]) };
  tab.display = () => {};
  tab.section = (c) => c;
  tab.countLabel = () => "";
  SettingStub.buttons = [];
  const root = el("div");
  await tab.renderGoalSettings(root);
  check("Settings lists the fund with its plan and account", text(byCls(root, "budget-cat-row")[0]).startsWith("Rent sinking fund $1500.00 · monthly on day 1 · follows Savings"), true);
  check("with Edit and Delete", buttons(byCls(root, "budget-cat-row")[0]).map((b) => b._text), ["Edit", "Delete"]);
  check("and a button for a new one", SettingStub.buttons.map((b) => b.label), ["New goal", "New capped fund", "New sinking fund"]);
  buttons(byCls(root, "budget-cat-row")[0])[0].onclick();
  buttons(byCls(root, "budget-cat-row")[0])[1].onclick();
  check("which go to the fund's own flow", calls.splice(0), [["fund", "sink1", null], ["delete", "sink1"]]);

  const bills = el("div");
  await tab.renderFixedExpenseSettings(bills);
  const brs = byCls(bills, "budget-cat-row");
  const rowOf = (name) => brs.find((r) => text(r).startsWith(name));
  check("a bill a fund has taken over says so and isn't offered", [text(rowOf("Rent")).includes("set aside"), !!button(rowOf("Rent"), "Set aside")], [true, false]);
  check("a monthly bill can be set aside", [!!button(rowOf("Phone"), "Set aside"), text(rowOf("Phone")).includes("set aside")], [true, false]);
  check("a rolling one can't", !!button(rowOf("Gym"), "Set aside"), false);
  button(rowOf("Phone"), "Set aside").onclick();
  check("it starts a fund from that bill", calls.pop(), ["fund", null, "bill3"]);
}

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
})().catch((e) => { console.error(e); process.exit(1); });
