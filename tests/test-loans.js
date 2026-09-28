// 1.27.0 — Loans: car, mortgage, student, personal. Interest-bearing balances
// with a fixed monthly payment, a first payment that can be weeks away, an
// optional SimpleFIN link for the lender's balance, and a way to close one.
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
const byCls = (n, cls) => find(n, (x) => x.classes && x.classes.has(cls));
const text = (n) => allText(n).replace(/\s+/g, " ").trim();
const buttonsIn = (n) => find(n, (x) => x.tag === "button");
const button = (n, label) => buttonsIn(n).find((b) => b._text === label);
const clone = (x) => JSON.parse(JSON.stringify(x));
const F = H.FILES;
const T = H.todayLocal();
const D = (n) => H.addDays(T, n);
const r2 = (n) => Math.round(n * 100) / 100;

// $25,000 at 7.49% for 72 months, funded Sep 28, first payment Nov 9.
const CAR = () => ({
  id: "loan-car", kind: "loan", loan_type: "car", provider: "Credit union auto loan", apr: 7.49, installment_amount: 432.13, frequency: "monthly",
  next_due_date: "2026-11-09", loan_date: "2026-09-28", payment_category: "Car Loan",
  balance_anchor: { amount: 25000, date: "2026-09-28", at: "2026-09-28T17:00:00.000Z", source: "manual" }, applied_payments: []
});

(async () => {
// ===========================================================================
console.log("\n1. Interest and the balance");
{
  check("daily interest counts the days", H.loanInterest(25000, 7.49, "daily", "2026-09-28", "2026-11-09"), r2(25000 * 0.0749 * 42 / 365));
  check("a mortgage's is a month's, however long", [H.loanInterest(300000, 6.5, "monthly", "2026-10-01", "2026-11-01"), H.loanInterest(300000, 6.5, "monthly", "2026-10-01", "2026-12-15")], [1625, 1625]);
  check("none at 0%, or on nothing", [H.loanInterest(1000, 0, "daily", "2026-01-01", "2026-02-01"), H.loanInterest(0, 7, "daily", "2026-01-01", "2026-02-01")], [0, 0]);
  check("months keep the day they started on", [H.addLoanMonths("2026-01-31", 1), H.addLoanMonths("2026-02-28", 1, 31), H.addLoanMonths("2026-11-09", 3), H.addLoanMonths("2026-03-15", -1)], ["2026-02-28", "2026-03-31", "2027-02-09", "2026-02-15"]);

  const car = CAR();
  check("before any payment: what was financed", H.loanState(car, "2026-10-15").balance, 25000);
  car.applied_payments = [{ tx_id: "p1", amount: 432.13, date: "2026-11-09" }];
  const st = H.loanState(car, "2026-11-10");
  const firstInterest = r2(25000 * 0.0749 * 42 / 365);
  check("the first payment covers 42 days of interest, the rest is principal", [st.interestPaid, st.principalPaid, st.balance], [firstInterest, r2(432.13 - firstInterest), r2(25000 - (432.13 - firstInterest))]);
  check("…and it's what debtBalance says", H.debtBalance(car), st.balance);
  car.applied_payments.push({ tx_id: "p2", amount: 432.13, date: "2026-12-09" });
  const second = r2(st.balance * 0.0749 * 30 / 365);
  check("the next one, 30 days of interest on what's left", H.loanState(car, "2026-12-10").interestPaid, r2(firstInterest + second));

  const synced = Object.assign(CAR(), { balance_anchor: { amount: 24600, date: "2026-12-01", source: "simplefin" }, applied_payments: [{ amount: 432.13, date: "2026-11-09" }] });
  check("a payment on or before the anchor is already in it", H.loanState(synced, "2026-12-02").balance, 24600);
  const small = Object.assign(CAR(), { applied_payments: [{ amount: 50, date: "2026-11-09" }] });
  check("a payment that doesn't cover the interest leaves the balance", H.loanState(small, "2026-11-10").balance, 25000);
  const undated = Object.assign(CAR(), { applied_payments: [{ amount: 432.13 }] });
  check("an undated payment (a pending hold) counts as today's", H.loanState(undated, "2026-11-09").balance, st.balance);

  const mort = { kind: "loan", loan_type: "mortgage", apr: 6, installment_amount: 2400, escrow: 400, first_payment_date: "2026-11-01", next_due_date: "2026-11-01", balance_anchor: { amount: 300000, date: "2026-10-01" }, applied_payments: [{ amount: 2400, date: "2026-11-01" }] };
  check("escrow comes off first and never touches the balance", H.loanState(mort, "2026-11-02").balance, r2(300000 - (2000 - 1500)));
  check("mortgages don't take spare cash unless told to", [H.loanTakesExtra(mort), H.loanTakesExtra(CAR()), H.loanTakesExtra(Object.assign(clone(mort), { extra_payments: true }))], [false, true, true]);
  check("an unknown type is a personal loan", [H.loanType({ loan_type: "boat" }), H.loanMethod({ loan_type: "boat" })], ["personal", "daily"]);
}

// ===========================================================================
console.log("\n2. Payoff");
{
  const p = H.loanPayoff(CAR(), { todayStr: "2026-09-28" });
  check("72 months of payments, plus a small last one for the long first month", [p.payments, p.payoffDate, p.never], [73, "2032-11-09", false]);
  check("interest still to come, in the right ballpark", p.interest > 5900 && p.interest < 6400, true);
  const faster = H.loanExtraSavings(CAR(), 50, "2026-09-28");
  check("$50 more a month: sooner, and less interest", [faster.months > 0, faster.interest > 0, faster.payoffDate < p.payoffDate], [true, true, true]);
  check("a payment that can't cover the interest never pays it off", H.loanPayoff(Object.assign(CAR(), { installment_amount: 100 }), { todayStr: "2026-09-28" }).never, true);
  check("…and has no count of payments left", H.remainingInstallments(Object.assign(CAR(), { installment_amount: 100 })), Infinity);
  const done = Object.assign(CAR(), { balance_anchor: { amount: 0, date: "2026-09-28" } });
  check("nothing owed: done", [H.loanPayoff(done).done, H.remainingInstallments(done)], [true, 0]);
  check("remaining payments come from the schedule, not balance ÷ payment", H.remainingInstallments(CAR()) > Math.ceil(25000 / 432.13), true);
  const zero = Object.assign(CAR(), { apr: 0, installment_amount: 500 });
  check("at 0% it's just balance ÷ payment", H.loanPayoff(zero, { todayStr: "2026-09-28" }).payments, 50);
  check("equity: worth less owed", [H.loanEquity(Object.assign(CAR(), { estimated_value: 27000 }), "2026-10-01"), H.loanEquity(Object.assign(CAR(), { estimated_value: 22000 }), "2026-10-01"), H.loanEquity(CAR())], [2000, -3000, null]);
}

// ===========================================================================
console.log("\n3. In the pay period");
{
  const card = { account_id: "Capital One Card", apr: 29.99, balance_anchor: { amount: 1000, date: D(-30) }, applied_payments: [], min_payment_due: 40, due_date: D(40) };
  const base = { cashOnHand: 3000, todayStr: D(-3), nextPaydayStr: D(11), fixedExpenses: [], revolvingDebts: [card], bufferMode: "manual", manualBuffer: 300, currentDateStr: T };
  const loan = (o = {}) => Object.assign(CAR(), { next_due_date: D(42), loan_date: T, balance_anchor: { amount: 25000, date: T } }, o);

  let r = H.runAllocation(Object.assign({}, base, { installmentDebts: [loan()] }));
  check("first payment 42 days out: nothing set aside yet", r.periodObligations.filter((o) => o.label === "Credit union auto loan").length, 0);
  r = H.runAllocation(Object.assign({}, base, { installmentDebts: [loan({ next_due_date: D(5) })] }));
  const ob = r.periodObligations.find((o) => o.label === "Credit union auto loan");
  check("in the period it falls in: the whole payment", [ob.amount, ob.remaining], [432.13, 432.13]);
  r = H.runAllocation(Object.assign({}, base, { installmentDebts: [loan({ next_due_date: D(5), applied_payments: [{ amount: 432.13, date: D(-1) }] })] }));
  check("paid: settled", r.periodObligations.find((o) => o.label === "Credit union auto loan").settled, true);

  r = H.runAllocation(Object.assign({}, base, { cashOnHand: 5000, installmentDebts: [loan()] }));
  check("spare cash: the 29.99% card first, then the 7.49% loan", r.payoffBreakdown.map((p) => [p.target, p.reason]), [["Capital One Card", "highest APR (29.99%)"], ["Credit union auto loan", "highest APR (7.49%)"]]);
  check("…never as a '0% installment payoff'", r.payoffBreakdown.some((p) => /0% installment/.test(p.reason)), false);
  r = H.runAllocation(Object.assign({}, base, { cashOnHand: 5000, installmentDebts: [loan({ extra_payments: false })] }));
  check("a loan told not to take extra doesn't", r.payoffBreakdown.map((p) => p.target), ["Capital One Card"]);
  r = H.runAllocation(Object.assign({}, base, { cashOnHand: 5000, installmentDebts: [loan({ loan_type: "mortgage" })] }));
  check("nor a mortgage, by default", r.payoffBreakdown.map((p) => p.target), ["Capital One Card"]);
  r = H.runAllocation(Object.assign({}, base, { cashOnHand: 5000, installmentDebts: [loan({ apr: 0 })] }));
  check("nor a 0% loan: nothing to gain", r.payoffBreakdown.map((p) => p.target), ["Capital One Card"]);
  const bnpl = { provider: "Affirm", installment_amount: 50, next_due_date: D(20), balance_anchor: { amount: 300, date: D(-10) }, applied_payments: [] };
  r = H.runAllocation(Object.assign({}, base, { cashOnHand: 50000, installmentDebts: [loan(), bnpl] }));
  check("plans still get theirs, after", r.payoffBreakdown.map((p) => p.target), ["Capital One Card", "Credit union auto loan", "Affirm"]);
  check("total debt counts the loan's balance", H.totalDebt([card], [loan()], []), r2(1000 + 25000));

  // Apply Payment's list: this billing cycle, not just since the anchor.
  const synced = loan({ next_due_date: D(20), loan_date: D(-400), balance_anchor: { amount: 24800, date: D(-1), source: "simplefin" } });
  check("matching reaches back over the cycle", H.loanMatchFrom(synced), H.addDays(H.addLoanMonths(D(20), -1), -5));
  check("never before the loan existed", H.loanMatchFrom(loan({ next_due_date: D(20) })), T);
  const txs = [
    { id: "pay", date: D(-3), amount: -432.13, merchant_raw: "Credit Union LOAN PMT", resolved_category: "Car Loan", account_id: "chk" },
    { id: "old", date: D(-60), amount: -432.13, merchant_raw: "Credit Union LOAN PMT", resolved_category: "Car Loan", account_id: "chk" }
  ];
  const offered = H.candidatePayments(synced, txs, [synced], [{ name: "Car Loan" }]).map((t) => t.id);
  check("a payment just before the lender's balance date is still offered", offered, ["pay"]);
  const adv = Object.assign(loan({ next_due_date: "2026-11-09" }), { applied_payments: [{ amount: 432.13, date: "2026-11-08" }] });
  check("paying it rolls the date a month", [H.advanceDueDateIfCovered(adv, "loan"), adv.next_due_date], ["2026-12-09", "2026-12-09"]);
}

// ===========================================================================
console.log("\n4. SimpleFIN");
{
  const byId = new Map([["ACT-loan", { id: "ACT-loan", balance: -24650.12, balanceDate: "2026-10-01", balanceAt: "2026-10-01T16:00:00.000Z" }]]);
  const linked = Object.assign(CAR(), { simplefin_id: "ACT-loan" });
  let u = H.simplefinLoanUpdates([linked], byId, "2026-10-02T00:00:00.000Z");
  check("the lender's balance, its size, dated by the lender", u.updates.map((x) => [x.id, x.amount, x.date, x.at]), [["loan-car", 24650.12, "2026-10-01", "2026-10-01T16:00:00.000Z"]]);
  const typed = Object.assign(clone(linked), { balance_anchor: { amount: 24500, date: "2026-10-01", at: "2026-10-01T20:00:00.000Z", source: "manual" } });
  u = H.simplefinLoanUpdates([typed], byId, "2026-10-02T00:00:00.000Z");
  check("a balance typed after the lender's figure is kept", [u.updates.length, u.kept.length], [0, 1]);
  u = H.simplefinLoanUpdates([Object.assign(clone(linked), { simplefin_id: "gone" })], byId);
  check("a linked account SimpleFIN didn't send is reported", u.missing.length, 1);
  check("unlinked loans and plans are left alone", H.simplefinLoanUpdates([CAR(), { provider: "Affirm", simplefin_id: "ACT-loan" }], byId).updates.length, 0);

  // End to end: a sync with only the loan linked.
  const store = {};
  const put = (p, v) => (store[p] = JSON.stringify(v));
  put(F.accounts, []);
  put(F.installmentDebts, [linked]);
  put(F.transactions, []);
  const app = { vault: { adapter: { exists: async (p) => p in store, read: async (p) => store[p], write: async (p, d) => { store[p] = d; }, mkdir: async () => {} } } };
  const plugin = Object.assign(Object.create(H.__PluginClass.prototype), { app, manifest: { id: "budget-tracker" }, settings: {}, syncing: false, openSettings() {}, async refreshAfterDataChange() {}, refreshAllDashboards() {} });
  const secrets = {};
  app.secretStorage = { getSecret: (id) => secrets[id] ?? null, setSecret: (id, v) => { secrets[id] = v; } };
  plugin.setSimpleFINAccess("https://demo:s3cr3t@bridge.example/simplefin");
  const json = { accounts: [
    { id: "ACT-loan", name: "Auto Loan", conn_id: "C1", currency: "USD", balance: "-24650.12", "balance-date": Math.floor(Date.now() / 1000) - 3600, transactions: [{ id: "i1", posted: Math.floor(Date.now() / 1000) - 3600, amount: "-150.00", description: "INTEREST" }] }
  ], connections: [{ conn_id: "C1", name: "Credit Union" }] };
  global.__requestUrl = async () => ({ status: 200, json, text: JSON.stringify(json) });
  global.__notices = [];
  await plugin.syncSimpleFIN();
  const after = JSON.parse(store[F.installmentDebts])[0];
  check("a sync with just a loan linked takes its balance", [after.balance_anchor.amount, after.balance_anchor.source], [24650.12, "simplefin"]);
  check("…doesn't import the loan account's rows (payments are seen from checking)", JSON.parse(store[F.transactions]).length, 0);
  check("…counts it, and doesn't call the account unlinked", global.__notices.pop(), "Synced — nothing new · 1 balance updated.");
  check("…and logs the debt total", F.debtHistory in store, true);
}

// ===========================================================================
console.log("\n5. Adding, editing, closing");
{
  const store = {};
  const put = (p, v) => (store[p] = JSON.stringify(v));
  const get = (p) => (p in store ? JSON.parse(store[p]) : undefined);
  put(F.installmentDebts, []);
  put(F.transactions, [
    { id: "sale", date: D(-1), amount: 3500, merchant_raw: "DEPOSIT CARMAX", resolved_category: "Uncategorized", account_id: "chk" },
    { id: "short", date: D(-1), amount: -1200, merchant_raw: "Credit Union LOAN PAYOFF", resolved_category: "Uncategorized", account_id: "chk" }
  ]);
  put(F.categories, []);
  put(F.simplefinAccounts, { accounts: [{ id: "ACT-loan", name: "Auto Loan", org: "Credit Union", balance: -24650.12 }, { id: "ACT-chk", name: "Checking", org: "Credit Union", balance: 500 }] });
  put(F.accounts, [{ id: "chk", type: "checking", simplefin_id: "ACT-chk" }]);
  const app = { vault: { adapter: { exists: async (p) => p in store, read: async (p) => store[p], write: async (p, d) => { store[p] = d; }, mkdir: async () => {} } } };
  const plugin = Object.assign(Object.create(H.__PluginClass.prototype), { app, settings: {}, async refreshAfterDataChange() {}, async snapshotDebt() {} });

  check("SimpleFIN choices: accounts not already used", (await plugin.loanSimplefinChoices()).map((c) => c.id), ["ACT-loan"]);
  const data = { loan_type: "car", name: "Credit union auto loan", balance: 25000, balanceChanged: true, asOf: T, apr: 7.49, payment: 432.13, escrow: 0, due: D(42), category: "Car Loan", value: 27000, simplefin_id: null, extra: null };
  const saved = await plugin.saveLoan(null, data);
  check("added as a loan among the plans", [saved.kind, saved.provider, saved.frequency, saved.next_due_date, saved.loan_date, saved.payment_category], ["loan", "Credit union auto loan", "monthly", D(42), T, "Car Loan"]);
  check("its balance anchored, typed", [saved.balance_anchor.amount, saved.balance_anchor.date, saved.balance_anchor.source], [25000, T, "manual"]);
  check("no escrow on a car loan; what it's worth kept", ["escrow" in saved, saved.estimated_value], [false, 27000]);

  const list = get(F.installmentDebts);
  list[0].applied_payments = [{ tx_id: "p1", amount: 432.13, date: D(42) }];
  put(F.installmentDebts, list);
  const edited = await plugin.saveLoan(list[0], Object.assign({}, data, { apr: 6.99, balance: 24783.34, asOf: D(60), balanceChanged: false, simplefin_id: "ACT-loan", escrow: 150 }));
  check("an edit that leaves the balance keeps its anchor and payments", [edited.apr, edited.balance_anchor.amount, edited.balance_anchor.date, edited.applied_payments.length, edited.simplefin_id], [6.99, 25000, T, 1, "ACT-loan"]);
  check("escrow is only kept on a mortgage", "escrow" in edited, false);
  const fixed = await plugin.saveLoan(edited, Object.assign({}, data, { balance: 24000, balanceChanged: true, asOf: D(50), simplefin_id: "ACT-loan" }));
  check("changing the balance re-anchors it — and still keeps the payments", [fixed.balance_anchor.amount, fixed.balance_anchor.date, fixed.applied_payments.length], [24000, D(50), 1]);
  check("its own SimpleFIN account stays on its list", (await plugin.loanSimplefinChoices(fixed)).map((c) => c.id), ["ACT-loan"]);
  check("…and off another loan's", (await plugin.loanSimplefinChoices(null)).length, 0);

  const rec = await plugin.closeLoan(fixed, { reason: "sold", date: T, price: 18000, payoff: 14200, fees: 300, result: 3500, txId: "sale" });
  check("closing moves it to the closed list, with how it ended", [get(F.installmentDebts).length, get(F.closedLoans).length, rec.closed.reason, rec.closed.result], [0, 1, "sold", 3500]);
  const sale = get(F.transactions).find((t) => t.id === "sale");
  check("the sale money is filed as an Asset Sale — not income", [sale.resolved_category, get(F.categories).find((c) => c.name === "Asset Sale").is_transfer], ["Asset Sale", true]);
  check("the summary", H.closedLoanSummary(rec), `Sold ${H.formatChartDate(T)} for $18000.00 · paid off $14200.00 · $300.00 in costs · $3500.00 to you`);
  const back = await plugin.reopenLoan(rec.id);
  check("reopened: back as it was", [get(F.installmentDebts).length, get(F.closedLoans).length, "closed" in back, back.applied_payments.length], [1, 0, false, 1]);
  const under = await plugin.closeLoan(back, { reason: "sold", date: T, price: 13000, payoff: 14200, fees: 0, result: -1200, txId: "short" });
  check("a shortfall you covered is a payment on the loan", get(F.transactions).find((t) => t.id === "short").resolved_category, "Car Loan");
  check("…and says so", H.closedLoanSummary(under).endsWith("you covered $1200.00"), true);
  check("traded in, refinanced, paid off", [
    H.closedLoanSummary({ closed: { reason: "traded", date: T, price: 16000, payoff: 14200, result: 1800 } }).endsWith("$1800.00 toward the next one"),
    H.closedLoanSummary({ closed: { reason: "traded", date: T, price: 12000, payoff: 14200, result: -2200 } }).endsWith("$2200.00 rolled into the next loan"),
    H.closedLoanSummary({ closed: { reason: "refinanced", date: T, payoff: 14200 } }),
    H.closedLoanSummary({ closed: { reason: "paid", date: T } })
  ], [true, true, `Refinanced ${H.formatChartDate(T)} · paid off $14200.00`, `Paid off ${H.formatChartDate(T)}`]);
}

// ===========================================================================
console.log("\n6. The dialogs");
{
  const open = (m) => {
    SettingStub.texts = []; SettingStub.buttons = []; SettingStub.dropdowns = [];
    m.onOpen();
    const fields = {}; SettingStub.texts.forEach((t) => { if (t.settingName && !fields[t.settingName]) fields[t.settingName] = t; });
    const lists = {}; SettingStub.dropdowns.forEach((d) => { if (d.settingName) lists[d.settingName] = d; });
    return { el: m.contentEl, fields, lists, buttons: SettingStub.buttons.slice() };
  };
  const type = (t, v) => { t.inputEl.value = v; t.inputEl.dispatchEvent({ type: "input" }); };
  let got = null;
  let m = open(new H.LoanModal({}, { sfChoices: [{ id: "ACT-loan", label: "Credit Union — Auto Loan · $24,650.12" }] }, (d) => (got = d)));
  check("a new loan asks when the first payment is", Object.keys(m.fields).includes("First payment"), true);
  check("escrow only for a mortgage", m.fields["Escrow in that payment"].setting.settingEl.classes.has("budget-hidden"), true);
  m.lists.Type.choose("mortgage");
  check("…shown when it is, with its category", [m.fields["Escrow in that payment"].setting.settingEl.classes.has("budget-hidden"), m.fields["Payment category"].inputEl.value], [false, "Mortgage"]);
  m.lists.Type.choose("car");
  type(m.fields.Name, "Credit union auto loan");
  type(m.fields.Balance, "25000");
  type(m.fields["APR (%)"], "7.49");
  type(m.fields["Monthly payment"], "432.13");
  type(m.fields["First payment"], D(42));
  m.lists["Balance from SimpleFIN"].choose("ACT-loan");
  m.buttons.find((b) => b.label === "Add loan").cb();
  check("what it hands back", [got.loan_type, got.name, got.balance, got.apr, got.payment, got.due, got.category, got.simplefin_id, got.asOf], ["car", "Credit union auto loan", 25000, 7.49, 432.13, D(42), "Car Loan", "ACT-loan", T]);
  got = null;
  global.__notices = [];
  m = open(new H.LoanModal({}, {}, (d) => (got = d)));
  m.lists.Type.choose("mortgage");
  type(m.fields.Name, "Home"); type(m.fields.Balance, "300000"); type(m.fields["Monthly payment"], "400"); type(m.fields["Escrow in that payment"], "400"); type(m.fields["First payment"], D(10));
  m.buttons.find((b) => b.label === "Add loan").cb();
  check("escrow can't be the whole payment", [got, global.__notices.pop()], [null, "Escrow has to be less than the whole payment."]);
  const started = Object.assign(CAR(), { applied_payments: [{ amount: 432.13, date: "2026-11-09" }], next_due_date: "2026-12-09" });
  m = open(new H.LoanModal({}, { existing: started }, () => {}));
  check("once it's started, it's the next payment", [Object.keys(m.fields).includes("Next payment"), Object.keys(m.fields).includes("First payment")], [true, false]);
  check("with the balance as it stands", m.fields.Balance.inputEl.value, String(H.loanState(started).balance));

  got = null;
  const close = new H.CloseLoanModal({}, Object.assign(CAR(), { balance_anchor: { amount: 14200, date: T } }), {
    candidates: (sign, amount) => [{ id: "sale", date: T, amount: 3500 * sign, merchant_raw: "DEPOSIT CARMAX" }]
  }, (i) => (got = i));
  m = open(close);
  check("payoff starts at the balance", m.fields["Payoff amount"].inputEl.value, "14200");
  type(m.fields["Sold for"], "18000");
  type(m.fields["Selling costs (optional)"], "300");
  check("the result as you type", text(byCls(m.el, "budget-loan-result")[0]), "$3500.00 to you.");
  const radios = find(m.el, (x) => x.tag === "input" && x.attrs && x.attrs.type === "radio");
  check("and the deposit it was, to pick", [radios.length, text(byCls(m.el, "budget-loan-pick")[0]).includes("DEPOSIT CARMAX")], [2, true]);
  radios[1].onchange();
  button(m.el, "Close loan").onclick();
  check("closing hands back the sale", got, { reason: "sold", date: T, price: 18000, payoff: 14200, fees: 300, result: 3500, txId: "sale" });
}

// ===========================================================================
console.log("\n7. The Debts tab");
{
  const store = {};
  store[F.closedLoans] = JSON.stringify([Object.assign(CAR(), { id: "old", provider: "Old Civic loan", closed: { reason: "sold", date: "2026-06-01", price: 9000, payoff: 7000, fees: 0, result: 2000 } })]);
  store[F.debtHistory] = "[]";
  const calls = [];
  const v = Object.create(H.BudgetDashboardView.prototype);
  Object.assign(v, {
    app: { vault: { adapter: { exists: async (p) => p in store, read: async (p) => store[p] } } },
    sectionOpen: { "closed-loans": true }, scrollMemory: {}, lastResult: null,
    plugin: { promptLoan: (l) => calls.push(["loan", l && l.id]), promptCloseLoan: (l) => calls.push(["close", l.id]), reopenLoan: async (id) => (calls.push(["reopen", id]), null), async snapshotDebt() {}, async refreshAfterDataChange() {} }
  });
  const loan = Object.assign(CAR(), { next_due_date: D(42), loan_date: T, balance_anchor: { amount: 25000, date: T, source: "manual" }, estimated_value: 27000 });
  const root = el("div");
  await v.renderDebts(root, { allTx: [], revolvingDebts: [], installmentDebts: [loan], allDebts: [loan], categoryMetaList: [], accounts: [], ownership: null, rules: [] });
  const row = byCls(root, "budget-debt-row")[0];
  check("its type and when it starts", byCls(row, "budget-badge").map(text), ["car loan", `starts ${H.formatChartDate(D(42))}`]);
  const meta = byCls(row, "budget-debt-meta").map(text);
  check("rate and payment; the badge has the date", meta[0], `7.49% APR · $432.13/mo`);
  check("payments left, when it's paid off, interest to go", /^\d+ payments left · paid off \w{3} \d{4} · \$[\d.]+ interest to go$/.test(meta[1]), true);
  check("what $50 more would do", /^\$50 more a month: paid off \d+ months sooner, \$[\d.]+ less interest$/.test(meta[2]), true);
  check("equity", meta[3], "Worth ~$27000.00 · $2000.00 equity");
  check("where the balance comes from", meta[4], `Balance as entered ${H.formatChartDate(T)}`);
  check("its amount", text(byCls(row, "budget-amount")[0]), "$25000.00");
  check("Apply Payment, Edit, Close — no Delete or Set Balance", buttonsIn(byCls(row, "budget-debt-btn-col")[0]).map((b) => b._text), ["Apply Payment", "Edit", "Close"]);
  button(row, "Edit").onclick();
  button(row, "Close").onclick();
  button(root, "Add loan").onclick();
  check("which open the loan dialogs", calls, [["loan", "loan-car"], ["close", "loan-car"], ["loan", undefined]]);
  const closedRow = byCls(root, "budget-loan-closed")[0];
  check("closed loans, with how they ended", text(closedRow), `Old Civic loan Sold ${H.formatChartDate("2026-06-01")} for $9000.00 · paid off $7000.00 · $2000.00 to you Reopen`);
  await button(closedRow, "Reopen").onclick();
  check("and a way back", calls.pop(), ["reopen", "old"]);

  const paying = Object.assign(clone(loan), { first_payment_date: D(-50), next_due_date: D(-20), loan_date: D(-60), balance_anchor: { amount: 25000, date: D(-60), source: "manual" }, applied_payments: [{ amount: 432.13, date: D(-50) }] });
  const root3 = el("div");
  await v.renderDebts(root3, { allTx: [], revolvingDebts: [], installmentDebts: [paying], allDebts: [paying], categoryMetaList: [], accounts: [], ownership: null, rules: [] });
  const meta3 = byCls(root3, "budget-debt-meta").map(text);
  check("a due date passed without a payment applied says so", meta3[0], `7.49% APR · $432.13/mo · ${H.formatChartDate(H.addLoanMonths(D(-50), 1))} payment not applied`);
  check("…and the balance counts the payments since it was entered", text(byCls(root3, "budget-debt-seam")[0]), `Balance worked out from $25000.00 on ${H.formatChartDate(D(-60))}, less 1 payment since`);
  const sf = Object.assign(clone(loan), { balance_anchor: { amount: 24650.12, date: T, source: "simplefin" }, simplefin_id: "ACT-loan" });
  const root2 = el("div");
  await v.renderDebts(root2, { allTx: [], revolvingDebts: [], installmentDebts: [sf], allDebts: [sf], categoryMetaList: [], accounts: [], ownership: null, rules: [] });
  check("a synced balance says so", byCls(root2, "budget-debt-seam").map(text), [`Balance from SimpleFIN · ${H.formatChartDate(T)}`]);
}

// ===========================================================================
console.log("\n8. The snapshot");
{
  const s = H.buildFinancialSnapshot({ installmentDebts: [Object.assign(CAR(), { loan_date: T, next_due_date: D(42), balance_anchor: { amount: 25000, date: T } })] }, { todayStr: T });
  const plan = s.plans[0];
  check("a loan's rate, payment and payments left", [plan.apr, plan.installment, plan.monthly, plan.remaining > 70], [7.49, 432.13, 432.13, true]);
  check("…in the Markdown", H.snapshotMarkdown(s).includes(`| Credit union auto loan | $25,000.00 | 7.49% APR, $432.13 monthly, ${plan.remaining} left | $432.13/mo |`), true);
  check("…and the CSV's APR column", H.snapshotCSV(s).split("\r\n").find((l) => l.startsWith("Credit union auto loan,")), `Credit union auto loan,25000.00,,,7.49,432.13,${plan.remaining}`);
  const never = H.buildFinancialSnapshot({ installmentDebts: [Object.assign(CAR(), { installment_amount: 100, balance_anchor: { amount: 25000, date: T } })] }, { todayStr: T });
  check("one that never pays off says so, not Infinity", [never.plans[0].remaining, H.snapshotMarkdown(never).includes("never paid off at this payment")], [null, true]);
}

// ===========================================================================
console.log("\n9. What the audit found");
{
  const MORT = (o = {}) => Object.assign({
    id: "loan-home", kind: "loan", loan_type: "mortgage", provider: "Home", apr: 6, installment_amount: 2400, escrow: 400, frequency: "monthly",
    next_due_date: "2026-11-01", loan_date: "2026-10-01", payment_category: "Mortgage",
    balance_anchor: { amount: 300000, date: "2026-10-01", source: "manual" }, applied_payments: []
  }, o);
  const car = (o = {}) => Object.assign(CAR(), o);
  const alloc = (debts, from, to, extra = {}) => H.runAllocation(Object.assign({ cashOnHand: 3000, todayStr: from, nextPaydayStr: to, currentDateStr: from,
    fixedExpenses: [], revolvingDebts: [], installmentDebts: debts, bufferMode: "manual", manualBuffer: 0 }, extra));
  const loanOb = (r) => r.periodObligations.find((o) => o.source === "debt");

  // Mortgage interest is per due date, not per payment.
  check("mortgage: $1000 more mid-month, marked extra, is all principal", H.loanState(MORT({ applied_payments: [{ amount: 2400, date: "2026-11-01" }, { amount: 1000, date: "2026-11-15", extra: true }] }), "2026-11-20").balance, 298500);
  const ahead = MORT({ applied_payments: [{ amount: 2400, date: "2026-11-01" }, { amount: 1000, date: "2026-11-15" }] });
  check("…left unmarked, it's part of December's payment, made early",
    [H.loanState(ahead, "2026-11-20").balance, H.loanSchedule(ahead, { todayStr: "2026-11-20" }).installments[1]], [299500, { due: "2026-12-01", covered: 1000, remaining: 1400 }]);
  check("mortgage: the payment in two halves is the payment", H.loanState(MORT({ applied_payments: [{ amount: 1200, date: "2026-11-01" }, { amount: 1200, date: "2026-11-15" }] }), "2026-11-20").balance, 299500);
  const skipped = H.loanState(MORT({ applied_payments: [{ amount: 2400, date: "2026-11-01" }, { amount: 2400, date: "2027-01-01" }] }), "2027-01-02");
  check("mortgage: a skipped month's interest and escrow are still owed", [skipped.balance, skipped.interestPaid], [299500, 3100]);

  // Daily interest isn't forgiven by a short payment.
  const split = H.loanState(car({ applied_payments: [{ amount: 100, date: "2026-11-09" }, { amount: 332.13, date: "2026-11-10" }] }), "2026-11-11");
  const single = H.loanState(car({ applied_payments: [{ amount: 432.13, date: "2026-11-10" }] }), "2026-11-11");
  check("car: split across two days is the same as paid once", split.balance, single.balance);
  check("car: interest a short payment didn't cover is carried, not dropped",
    H.loanState(car({ applied_payments: [{ amount: 50, date: "2026-11-09" }, { amount: 432.13, date: "2026-12-09" }] }), "2026-12-10").balance,
    H.loanState(car({ applied_payments: [{ amount: 482.13, date: "2026-12-09" }] }), "2026-12-10").balance);

  // Interest runs from the last payment, not from the balance's date.
  const synced = car({ balance_anchor: { amount: 24800, date: "2026-11-08", source: "simplefin" }, applied_payments: [{ amount: 432.13, date: "2026-10-09" }, { amount: 432.13, date: "2026-11-09" }] });
  check("after a sync, the next payment still pays interest since the last one", H.loanState(synced, "2026-11-10").interestPaid, H.loanInterest(24800, 7.49, "daily", "2026-10-09", "2026-11-09"));
  const typo = car({ loan_date: "2026-09-01", next_due_date: "2026-10-15", balance_anchor: { amount: 24000, date: "2026-09-20", source: "manual" }, applied_payments: [{ amount: 432.13, date: "2026-10-15" }] });
  check("a corrected balance before the first payment: interest from the funding date", H.loanState(typo, "2026-10-16").interestPaid, H.loanInterest(24000, 7.49, "daily", "2026-09-01", "2026-10-15"));

  // Extra toward principal doesn't pay next month.
  const ex = car({ applied_payments: [{ tx_id: "reg", amount: 432.13, date: "2026-11-08" }] });
  check("the regular payment rolls the date", H.advanceDueDateIfCovered(ex, "loan"), "2026-12-09");
  ex.applied_payments.push({ tx_id: "x", amount: 1000, date: "2026-11-20", extra: true });
  check("an extra payment doesn't", [H.advanceDueDateIfCovered(ex, "loan"), ex.next_due_date], [null, "2026-12-09"]);
  check("…so December is still set aside", [loanOb(alloc([ex], "2026-12-01", "2026-12-15")).remaining, alloc([ex], "2026-12-01", "2026-12-15").requiredMinimums], [432.13, 432.13]);
  check("…and the balance still falls by all of it", H.loanState(ex, "2026-11-21").balance, r2(H.loanState(car({ applied_payments: [{ amount: 432.13, date: "2026-11-08" }] }), "2026-11-20").balance - 1000));
  const unflagged = car({ applied_payments: [{ amount: 432.13, date: "2026-11-08" }, { amount: 1000, date: "2026-11-20" }] });
  check("left unflagged, it's paying ahead", loanOb(alloc([unflagged], "2026-12-01", "2026-12-15")).settled, true);
  const paidNov = car({ applied_payments: [{ amount: 432.13, date: "2026-11-08" }] });
  check("extra is suggested once the month is paid; not for a payment's worth, or the first",
    [H.loanExtraSuggested(paidNov, [{ amount: -1000, date: "2026-11-20" }], "2026-11-21"), H.loanExtraSuggested(paidNov, [{ amount: -432.13, date: "2026-12-05" }], "2026-12-05"), H.loanExtraSuggested(car(), [{ amount: -1000, date: "2026-10-20" }], "2026-10-21"), H.loanExtraSuggested({ provider: "Affirm" }, [{ amount: -1000 }])],
    [true, false, false, false]);

  // Late, early, overdue.
  const late = car({ applied_payments: [{ amount: 432.13, date: "2026-11-12" }] });
  check("paid 3 days late: the next month is still due", [H.advanceDueDateIfCovered(late, "loan"), loanOb(alloc([late], "2026-12-01", "2026-12-15")).remaining], ["2026-12-09", 432.13]);
  const early = car({ applied_payments: [{ amount: 432.13, date: "2026-10-06" }] });
  check("the first payment made early, weeks before it's due, counts", [H.advanceDueDateIfCovered(early, "loan"), loanOb(alloc([early], "2026-11-01", "2026-11-15")).settled], ["2026-12-09", true]);
  const never = car();
  check("a missed payment stays set aside — once, not forever",
    [["2026-11-01", "2026-11-15"], ["2026-11-15", "2026-12-01"], ["2026-12-01", "2026-12-15"], ["2027-01-01", "2027-01-15"]].map(([a, b]) => alloc([never], a, b).requiredMinimums),
    [432.13, 432.13, 864.26, 864.26]);
  check("a month-end due date keeps its day", (() => {
    const l = car({ next_due_date: "2027-01-31", loan_date: "2026-12-20", balance_anchor: { amount: 25000, date: "2026-12-20" } });
    return ["2027-01-30", "2027-02-27", "2027-03-27"].map((d) => { l.applied_payments.push({ amount: 432.13, date: d }); return H.advanceDueDateIfCovered(l, "loan"); });
  })(), ["2027-02-28", "2027-03-31", "2027-04-30"]);
  check("…and a payment 29 days early for the 31st counts", H.advanceDueDateIfCovered(car({ next_due_date: "2027-03-31", loan_date: "2026-12-20", applied_payments: [{ amount: 432.13, date: "2027-03-02" }] }), "loan"), "2027-04-30");

  // The last payment, and after.
  const last = car({ next_due_date: D(5), loan_date: D(-2000), balance_anchor: { amount: 300, date: D(-25) } });
  const lr = alloc([last], D(-3), D(11), { cashOnHand: 5000, currentDateStr: T });
  check("the last payment: what's left, not a whole installment, and no extra on top", [lr.requiredMinimums < 432.13, lr.requiredMinimums > 300, lr.payoffBreakdown.length], [true, true, 0]);
  const paidOff = alloc([car({ next_due_date: D(5), balance_anchor: { amount: 0, date: D(-25) } })], D(-3), D(11));
  check("paid off, not yet closed: nothing set aside, and no $0 row", [paidOff.requiredMinimums, paidOff.periodObligations.filter((o) => o.source === "debt").length], [0, 0]);

  // Dates on applied payments.
  const dated = H.loanState(car({ applied_payments: [{ amount: 432.13, applied_on: "2026-11-10" }] }), "2027-03-01").balance;
  check("an applied payment without a bank date uses the day it was applied — not 'today' forever", dated, H.loanState(car({ applied_payments: [{ amount: 432.13, date: "2026-11-10" }] }), "2026-11-11").balance);
  check("…and a lender balance read after that day already has it in it",
    H.loanState(car({ balance_anchor: { amount: 24788.47, date: "2026-12-01", source: "simplefin" }, applied_payments: [{ amount: 432.13, applied_on: "2026-11-10" }] }), "2026-12-02").balance, 24788.47);
  const recs = [{ applied_payments: [{ tx_id: "hold", amount: 432.13 }] }];
  H.applyTransactionRelinks(recs, [{ from: "hold", to: "post", date: "2026-11-10" }], "applied_payments");
  check("a hold that posts gives its payment the posted date", recs[0].applied_payments, [{ tx_id: "post", amount: 432.13, date: "2026-11-10" }]);

  // SimpleFIN refusals.
  const sf = new Map([["1", { id: "1", balance: -33000, currency: "CAD", balanceDate: "2026-10-01" }]]);
  let u = H.simplefinLoanUpdates([car({ simplefin_id: "1" })], sf);
  check("a balance in another currency isn't taken", [u.updates.length, u.refused.length, /CAD/.test(u.refused[0].why)], [0, 1, true]);
  u = H.simplefinLoanUpdates([car({ simplefin_id: "1" })], new Map([["1", { id: "1", balance: -24650, balanceDate: "2026-10-01" }]]), undefined, { ambiguous: ["1"] });
  check("nor one whose id two connections share", [u.updates.length, u.refused.length], [0, 1]);
}

// ===========================================================================
console.log("\n10. The audit, in the dialogs and files");
{
  const open = (m) => {
    SettingStub.texts = []; SettingStub.buttons = []; SettingStub.dropdowns = []; SettingStub.toggles = [];
    m.onOpen();
    const fields = {}; SettingStub.texts.forEach((t) => { if (t.settingName && !fields[t.settingName]) fields[t.settingName] = t; });
    return { el: m.contentEl, fields, buttons: SettingStub.buttons.slice(), toggles: SettingStub.toggles.slice() };
  };
  const type = (t, v) => { t.inputEl.value = v; t.inputEl.dispatchEvent({ type: "input" }); };

  // Tabbing through Balance tidies it to "24,788.47" — that isn't a change.
  let got = null;
  const linked = Object.assign(CAR(), { simplefin_id: "ACT-loan", next_due_date: D(10), loan_date: D(-60), balance_anchor: { amount: 24788.47, date: D(-2), source: "simplefin" } });
  let m = open(new H.LoanModal({}, { existing: linked, sfChoices: [] }, (d) => (got = d)));
  m.fields.Balance.inputEl.dispatchEvent({ type: "blur" });
  type(m.fields["APR (%)"], "6.99");
  m.buttons.find((b) => b.label === "Save").cb();
  check("editing the rate doesn't re-anchor the balance", [m.fields.Balance.inputEl.value, got.balanceChanged, got.apr], ["24,788.47", false, 6.99]);

  // A pick that's no longer on screen isn't submitted.
  got = null;
  const txs = { "1": [{ id: "dep", date: T, amount: 3800, merchant_raw: "DEPOSIT CARMAX" }], "-1": [{ id: "pmt", date: T, amount: -1200, merchant_raw: "Credit Union LOAN PAYOFF" }] };
  m = open(new H.CloseLoanModal({}, Object.assign(CAR(), { balance_anchor: { amount: 14200, date: T } }), { candidates: (sign) => txs[String(sign)] }, (i) => (got = i)));
  type(m.fields["Sold for"], "18000");
  find(m.el, (x) => x.tag === "input" && x.attrs && x.attrs.type === "radio")[1].onchange();
  type(m.fields["Sold for"], "13000");
  const radios = find(m.el, (x) => x.tag === "input" && x.attrs && x.attrs.type === "radio");
  button(m.el, "Close loan").onclick();
  check("changing the price to a shortfall drops the deposit that was picked", [radios.map((r) => !!r.checked), got.txId, got.result], [[true, false], null, -1200]);

  // Apply Payment: the extra-principal switch, suggested and then yours.
  const store = {};
  const put = (p, v) => (store[p] = JSON.stringify(v));
  const get = (p) => JSON.parse(store[p]);
  const loan = Object.assign(CAR(), { first_payment_date: "2026-11-09", next_due_date: "2026-12-09", applied_payments: [{ tx_id: "nov", amount: 432.13, date: "2026-11-08", applied_on: "2026-11-08" }] });
  put(F.installmentDebts, [loan]);
  put(F.revolvingDebts, []); put(F.fixedExpenses, []); put(F.savingsGoals, []); put(F.rules, []); put(F.categories, [{ name: "Car Loan" }]);
  put(F.transactions, [
    { id: "nov", date: "2026-11-08", amount: -432.13, merchant_raw: "Credit Union LOAN PMT", resolved_category: "Car Loan", account_id: "chk" },
    { id: "big", date: "2026-11-20", amount: -1000, merchant_raw: "Credit Union LOAN PMT", resolved_category: "Car Loan", account_id: "chk" }
  ]);
  const app = { vault: { adapter: { exists: async (p) => p in store, read: async (p) => store[p], write: async (p, d) => { store[p] = d; }, mkdir: async () => {} } } };
  const plugin = Object.assign(Object.create(H.__PluginClass.prototype), { app, settings: {}, async refreshAfterDataChange() {}, async snapshotDebt() {} });
  SettingStub.texts = []; SettingStub.buttons = []; SettingStub.dropdowns = []; SettingStub.toggles = [];
  const realOpen = H.ApplyPaymentModal.prototype.open;
  let modal = null;
  H.ApplyPaymentModal.prototype.open = function () { modal = this; return realOpen.call(this); };
  await plugin.openApplyPaymentFor(loan);
  H.ApplyPaymentModal.prototype.open = realOpen;
  const toggle = SettingStub.toggles.find((t) => t.settingName === "Extra toward principal");
  check("a loan's Apply Payment has the switch, off to start", [!!toggle, toggle.value], [true, false]);
  const box = find(modal.contentEl, (x) => x.tag === "checkbox")[0];
  box.checked = true; box.onchange();
  check("$1000 after this month's payment: suggested as extra", toggle.value, true);
  global.__notices = [];
  await SettingStub.buttons.find((b) => b.label === "Apply selected").cb();
  await new Promise((r) => setTimeout(r, 0));
  const saved = get(F.installmentDebts)[0];
  const entry = saved.applied_payments.find((p) => p.tx_id === "big");
  check("saved with its bank date, the day it was applied, and as extra", [entry.date, entry.applied_on, entry.extra], ["2026-11-20", T, true]);
  check("…and December is still due", [saved.next_due_date, global.__notices.pop()], ["2026-12-09", "Applied $1000.00 to Credit union auto loan."]);

  put(F.installmentDebts, [loan]);
  SettingStub.toggles = []; SettingStub.buttons = [];
  H.ApplyPaymentModal.prototype.open = function () { modal = this; return realOpen.call(this); };
  await plugin.openApplyPaymentFor(loan);
  H.ApplyPaymentModal.prototype.open = realOpen;
  const t2 = SettingStub.toggles.find((t) => t.settingName === "Extra toward principal");
  const b2 = find(modal.contentEl, (x) => x.tag === "checkbox")[0];
  b2.checked = true; b2.onchange();
  t2.flip(false);
  await SettingStub.buttons.find((b) => b.label === "Apply selected").cb();
  await new Promise((r) => setTimeout(r, 0));
  check("switched off: it pays the months ahead, December and January", ["extra" in get(F.installmentDebts)[0].applied_payments.find((p) => p.tx_id === "big"), get(F.installmentDebts)[0].next_due_date], [false, "2027-02-09"]);

  // Closing keeps this period's payments a bill, not spending.
  const s2 = {};
  s2[F.installmentDebts] = JSON.stringify([Object.assign(CAR(), { payment_category: "Car Payment", next_due_date: D(-2), loan_date: D(-200), balance_anchor: { amount: 14200, date: D(-40) }, applied_payments: [{ tx_id: "inst", amount: 432.13, date: D(-2) }] })]);
  s2[F.transactions] = JSON.stringify([
    { id: "inst", date: D(-2), amount: -432.13, merchant_raw: "Credit Union LOAN PMT", resolved_category: "Car Payment", account_id: "chk" },
    { id: "short", date: D(-1), amount: -1200, merchant_raw: "Credit Union PAYOFF", resolved_category: "Uncategorized", account_id: "chk" }
  ]);
  s2[F.categories] = "[]";
  const app2 = { vault: { adapter: { exists: async (p) => p in s2, read: async (p) => s2[p], write: async (p, d) => { s2[p] = d; }, mkdir: async () => {} } } };
  const p2 = Object.assign(Object.create(H.__PluginClass.prototype), { app: app2, settings: {}, async refreshAfterDataChange() {}, async snapshotDebt() {} });
  await p2.closeLoan(JSON.parse(s2[F.installmentDebts])[0], { reason: "sold", date: T, price: 13000, payoff: 14200, fees: 0, result: -1200, txId: "short" });
  const r = H.runAllocation({ cashOnHand: 5000, todayStr: D(-5), nextPaydayStr: D(9), currentDateStr: T, fixedExpenses: [], revolvingDebts: [], installmentDebts: [],
    transactions: JSON.parse(s2[F.transactions]), categoryMeta: JSON.parse(s2[F.categories]), bufferMode: "manual", manualBuffer: 800 });
  check("closed: its payments and the shortfall aren't spending", [r.bufferSpent, JSON.parse(s2[F.categories]).find((c) => c.name === "Car Payment").exclude_from_discretionary], [0, true]);

  // Reopening puts the money back where it was.
  const s3 = {};
  s3[F.installmentDebts] = JSON.stringify([CAR()]);
  s3[F.transactions] = JSON.stringify([{ id: "dep", date: T, amount: 3500, merchant_raw: "DEPOSIT CARMAX 123", resolved_category: "Deposits", account_id: "chk" }]);
  s3[F.categories] = "[]";
  s3[F.rules] = JSON.stringify([{ merchant_pattern: "DEPOSIT CARMAX", home_label: "Deposits" }]);
  const app3 = { vault: { adapter: { exists: async (p) => p in s3, read: async (p) => s3[p], write: async (p, d) => { s3[p] = d; }, mkdir: async () => {} } } };
  const p3 = Object.assign(Object.create(H.__PluginClass.prototype), { app: app3, settings: {} });
  const rec = await p3.closeLoan(CAR(), { reason: "sold", date: T, price: 18000, payoff: 14200, fees: 300, result: 3500, txId: "dep" });
  check("closed: the deposit is an Asset Sale", JSON.parse(s3[F.transactions])[0].resolved_category, "Asset Sale");
  await p3.reopenLoan(rec.id);
  const dep = JSON.parse(s3[F.transactions])[0];
  check("reopened: back to what its rule says, nothing left behind", [dep.resolved_category, "override_label" in dep, "transfer_prev_label" in dep], ["Deposits", false, false]);

  // A loan whose category was deleted gets its type's back, not "BNPL".
  const s4 = {};
  s4[F.revolvingDebts] = "[]";
  s4[F.installmentDebts] = JSON.stringify([Object.assign(CAR(), { payment_category: null }), Object.assign(CAR(), { id: "m", loan_type: "mortgage", payment_category: null }), { provider: "Affirm", installment_amount: 50, balance_anchor: { amount: 200, date: T } }]);
  await H.ensureDebtAnchors({ vault: { adapter: { exists: async (p) => p in s4, read: async (p) => s4[p], write: async (p, d) => { s4[p] = d; }, mkdir: async () => {} } } });
  check("on load: a loan's type's category, a plan's BNPL", JSON.parse(s4[F.installmentDebts]).map((d) => d.payment_category), ["Car Loan", "Mortgage", "BNPL"]);
}

// ===========================================================================
console.log("\n11. The second audit");
{
  const MORT = (o = {}) => Object.assign({
    id: "loan-home", kind: "loan", loan_type: "mortgage", provider: "Home", apr: 6, installment_amount: 2400, escrow: 400, frequency: "monthly",
    first_payment_date: "2026-11-01", next_due_date: "2026-11-01", loan_date: "2026-10-01", payment_category: "Mortgage",
    balance_anchor: { amount: 300000, date: "2026-10-01", source: "manual" }, applied_payments: []
  }, o);
  const car = (o = {}) => Object.assign(CAR(), { first_payment_date: "2026-11-09" }, o);
  const alloc = (debts, from, to) => H.runAllocation({ cashOnHand: 3000, todayStr: from, nextPaydayStr: to, currentDateStr: from,
    fixedExpenses: [], revolvingDebts: [], installmentDebts: debts, bufferMode: "manual", manualBuffer: 0 });

  // A mortgage paid a few days early still pays that month's interest.
  const early = MORT({ applied_payments: [{ amount: 2400, date: "2026-10-28" }, { amount: 2400, date: "2026-11-28" }] });
  const onTime = MORT({ applied_payments: [{ amount: 2400, date: "2026-11-01" }, { amount: 2400, date: "2026-12-01" }] });
  check("mortgage: autopay 3 days early lands where paying on the day does", [H.loanState(MORT({ applied_payments: early.applied_payments.slice(0, 1) }), "2026-10-29").balance, H.loanState(early, "2026-12-02").balance], [299500, H.loanState(onTime, "2026-12-02").balance]);
  check("…and so does the payoff", H.loanPayoff(early, { todayStr: "2026-12-02" }), H.loanPayoff(onTime, { todayStr: "2026-12-02" }));
  const synced = MORT({ balance_anchor: { amount: 299500, date: "2026-10-30", source: "simplefin" }, applied_payments: [{ amount: 2400, date: "2026-10-28" }, { amount: 2400, date: "2026-11-28" }] });
  check("…a lender balance read between the early payment and its due date: no month charged twice", H.loanState(synced, "2026-12-02").balance, H.loanState(onTime, "2026-12-02").balance);

  // A payment 21 days early, last month paid: it's next month's.
  const d21 = car({ first_payment_date: "2026-10-09", next_due_date: "2026-11-09", loan_date: "2026-09-10", balance_anchor: { amount: 25000, date: "2026-09-10" },
    applied_payments: [{ amount: 432.13, date: "2026-10-09" }, { amount: 432.13, date: "2026-10-19" }] });
  check("a payment's worth, a day before the window: it pays the next month, as the switch suggested",
    [H.loanExtraSuggested(Object.assign({}, d21, { applied_payments: d21.applied_payments.slice(0, 1) }), [{ amount: -432.13, date: "2026-10-19" }], "2026-10-25"), H.loanSchedule(d21, { todayStr: "2026-10-25" }).nextDue, alloc([d21], "2026-11-01", "2026-11-15").requiredMinimums],
    [false, "2026-12-09", 0]);
  const five = car({ applied_payments: [{ amount: 432.13 * 5, date: "2026-11-09" }] });
  check("unmarked, a big payment pays the months ahead", H.loanSchedule(five, { todayStr: "2026-11-10" }).nextDue, "2027-04-09");

  // A mortgage payment split in two, the second half in next month's window.
  const split = MORT({ applied_payments: [{ amount: 1200, date: "2026-11-01" }, { amount: 1200, date: "2026-11-14" }] });
  const sp = H.loanSchedule(split, { todayStr: "2026-11-20" });
  check("the second half finishes November, not starts December", [sp.installments[0].remaining, sp.nextDue, H.loanState(split, "2026-11-20").balance], [0, "2026-12-01", 299500]);

  // An extra payment then a lender balance: interest still runs from the last regular payment.
  const reanchored = car({ next_due_date: "2026-12-09", balance_anchor: { amount: 23789.23, date: "2026-11-26", source: "simplefin" },
    applied_payments: [{ amount: 432.13, date: "2026-11-09" }, { amount: 1000, date: "2026-11-25", extra: true }, { amount: 432.13, date: "2026-12-09" }] });
  check("after an extra payment and a sync, interest runs from the last regular payment", [H.loanAccrualStart(reanchored, "2026-11-26"), H.loanState(reanchored, "2026-12-10").interestPaid], ["2026-11-09", H.loanInterest(23789.23, 7.49, "daily", "2026-11-09", "2026-12-09")]);

  // Part-paid: the payoff counts only what's left of that month.
  const part = car({ applied_payments: [{ amount: 200, date: "2026-11-05" }] });
  const asked = H.loanPeriodDues(part, "2026-11-01", "2026-11-15", "2026-11-06")[0].remaining;
  const before = H.loanPayoff(part, { todayStr: "2026-11-06" });
  const paid = car({ applied_payments: [{ amount: 200, date: "2026-11-05" }, { amount: asked, date: "2026-11-09" }] });
  const after = H.loanPayoff(paid, { todayStr: "2026-11-10" });
  check("part-paid: the payoff asks for the rest, and paying it takes one payment off the count", [asked, after.payments, after.payoffDate], [232.13, before.payments - 1, before.payoffDate]);

  // Moving a started loan's due date.
  const store = {};
  const app = { vault: { adapter: { exists: async (p) => p in store, read: async (p) => store[p], write: async (p, d) => { store[p] = d; }, mkdir: async () => {} } } };
  const plugin = Object.assign(Object.create(H.__PluginClass.prototype), { app, settings: {} });
  const started = car({ first_payment_date: "2026-10-09", next_due_date: "2026-12-09", loan_date: "2026-09-10", balance_anchor: { amount: 25000, date: "2026-09-10", source: "manual" },
    applied_payments: [{ amount: 432.13, date: "2026-10-09" }, { amount: 432.13, date: "2026-11-09" }] });
  store[F.installmentDebts] = JSON.stringify([started]);
  const edit = { loan_type: "car", name: started.provider, balance: 0, balanceChanged: false, asOf: T, apr: 7.49, payment: 432.13, escrow: 0, due: "2026-12-15", category: "Car Loan", value: null, simplefin_id: null, extra: null };
  const moved = await plugin.saveLoan(started, edit);
  check("moved from the 9th to the 15th: December's is due on the 15th, unpaid", [H.loanSchedule(moved, { todayStr: "2026-11-20" }).nextDue, alloc([moved], "2026-12-10", "2026-12-24").requiredMinimums], ["2026-12-15", 432.13]);
  check("…and the months already paid keep their interest", H.loanState(moved, "2026-11-20").balance, H.loanState(started, "2026-11-20").balance);
  check("…the old dates kept for that", moved.due_history, [{ first: "2026-10-09", until: "2026-12-09" }]);
  const m = MORT({ next_due_date: "2027-01-01", applied_payments: [{ amount: 2400, date: "2026-11-01" }, { amount: 2400, date: "2026-12-01" }] });
  store[F.installmentDebts] = JSON.stringify([m]);
  const mm = await plugin.saveLoan(m, { loan_type: "mortgage", name: "Home", balance: 0, balanceChanged: false, asOf: T, apr: 6, payment: 2400, escrow: 400, due: "2027-01-05", category: "Mortgage", value: null, simplefin_id: null, extra: null });
  check("a mortgage's balance doesn't move when its due date does", [H.loanState(mm, "2026-12-10").balance, H.loanState(mm, "2026-12-10").interestPaid], [H.loanState(m, "2026-12-10").balance, H.loanState(m, "2026-12-10").interestPaid]);
  mm.applied_payments.push({ amount: 2400, date: "2027-01-05" });
  check("…and the next payment pays one month's interest, not two or none", r2(H.loanState(mm, "2027-01-06").interestPaid - H.loanState(m, "2026-12-10").interestPaid), r2(H.loanState(m, "2026-12-10").balance * 0.06 / 12));
  const fresh = await plugin.saveLoan(null, Object.assign({}, edit, { balance: 25000, balanceChanged: true, due: D(42) }));
  const refreshed = await plugin.saveLoan(fresh, Object.assign({}, edit, { balance: 25000, due: D(45) }));
  check("before the first payment, moving it just moves it", [refreshed.first_payment_date, "due_history" in refreshed, "coverage_from" in refreshed], [D(45), false, false]);

  check("a date that isn't one is ignored, not turned into NaN", [H.loanSchedule(car({ first_payment_date: "2026-11", next_due_date: "2026-11" })).installments.length, H.loanDueDatesBetween(car({ first_payment_date: "2026-11", next_due_date: "2026-11" }), "2026-01-01", "2027-01-01")], [0, []]);
}

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
})().catch((e) => { console.error(e); process.exit(1); });
