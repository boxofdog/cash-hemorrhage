// The export tells the truth about itself: a plan can't cost more than what's
// left of it, income is a few paychecks and not one, each paycheck is listed
// once, a subscription that looks off says so, partial months are labelled,
// transfers are kept apart from income and spending, and the top of the
// snapshot lists what makes the figures less certain.
global.document = { body: { classList: { contains: () => false } } };
const H = require("./harness.js");

let pass = 0, fail = 0;
function check(name, got, want) {
  const ok = JSON.stringify(got) === JSON.stringify(want);
  if (ok) { pass++; console.log(`  PASS  ${name}`); }
  else { fail++; console.log(`  FAIL  ${name}: got ${JSON.stringify(got)}, want ${JSON.stringify(want)}`); }
}
const r2 = (n) => Math.round(n * 100) / 100;
const F = H.FILES;
const T = "2026-11-23";
const D = (n) => H.addDays(T, n);
const BIWEEKLY = { paySchedule: { cadence: "biweekly", anchor_date: "2026-11-06" } };
const tx = (id, date, amount, merchant, cat, account = "chk", extra = {}) => Object.assign({ id, date, amount, merchant_raw: merchant, resolved_category: cat, account_id: account }, extra);
const snap = (data, settings = BIWEEKLY, todayStr = T) => H.buildFinancialSnapshot(data, { todayStr, settings });

(async () => {
// ===========================================================================
console.log("\n1. A plan can't cost more than what's left of it");
{
  const last = { id: "z", provider: "Zip plan", installment_amount: 130, frequency: "biweekly", balance_anchor: { amount: 130, date: D(-10) }, applied_payments: [] };
  const more = { id: "k", provider: "Other plan", installment_amount: 130, frequency: "biweekly", balance_anchor: { amount: 650, date: D(-10) }, applied_payments: [] };
  const s = snap({ installmentDebts: [last, more] });
  check("one payment left: that payment, not a month of them", [s.plans[0].monthly, s.plans[0].capped, s.plans[0].remaining], [130, true, 1]);
  check("five left: a month of them, 26/12 payments", [s.plans[1].monthly, s.plans[1].capped, s.plans[1].remaining], [r2(130 * 26 / 12), false, 5]);
  check("debt minimums use the capped figure", s.debtMonthly, r2(130 + r2(130 * 26 / 12)));
  const md = H.snapshotMarkdown(s);
  check("the table says '1 payment left' and that it's all that's left", [md.includes("$130.00 biweekly, 1 payment left"), md.includes("$130.00/mo (all that's left)"), md.includes("5 payments left")], [true, true, true]);
  const two = snap({ installmentDebts: [{ id: "t", provider: "Two left", installment_amount: 130, frequency: "biweekly", balance_anchor: { amount: 260, date: D(-10) }, applied_payments: [] }] });
  check("two biweekly payments left cost $260, under the $281.67 a month", two.plans[0].monthly, 260);
  const monthly = snap({ installmentDebts: [{ id: "m", provider: "Last month", installment_amount: 50, frequency: "monthly", balance_anchor: { amount: 30, date: D(-10) }, applied_payments: [] }] });
  check("a final payment smaller than the installment costs what's owed", [monthly.plans[0].monthly, monthly.plans[0].capped], [30, true]);
  const paid = snap({ installmentDebts: [{ id: "p", provider: "Done", installment_amount: 50, frequency: "monthly", balance_anchor: { amount: 0, date: D(-10) }, applied_payments: [] }] });
  check("paid off: nothing, not capped", [paid.plans[0].monthly, paid.plans[0].capped], [0, false]);
}

// ===========================================================================
console.log("\n2. Each paycheck once");
{
  const entered = [
    { date: "2026-09-08", amount: 1500 }, { date: "2026-09-08", amount: 1500 }, { date: "2026-09-08", amount: 1500 },
    { date: "2026-10-27", amount: 1600 }
  ];
  const deposits = [
    tx("d1", "2026-10-28", 1598.5, "PAYROLL", "Paycheck"),
    tx("d2", "2026-11-09", 1700, "PAYROLL", "Paycheck"),
    tx("d3", "2026-11-12", 75, "REFUND", "Shopping"),
    tx("d4", "2026-11-13", -40, "PAYROLL FEE", "Paycheck")
  ];
  const { rows, duplicates } = H.mergedPaychecks(entered, deposits);
  check("repeated entries for a day count once; a deposit you didn't enter is listed; newest first", rows.map((r) => [r.date, r.amount, r.source]), [["2026-11-09", 1700, "deposit"], ["2026-10-27", 1600, "both"], ["2026-09-08", 1500, "entered"]]);
  check("an entry and the deposit a day later are one paycheck, with the deposit's amount kept", [rows[1].deposit, rows[1].depositDate], [1598.5, "2026-10-28"]);
  check("it says how many repeats there were", duplicates, 2);
  check("other deposits and negative amounts aren't paychecks", rows.length, 3);
  const edge = H.mergedPaychecks([{ date: "2026-10-27", amount: 1600 }], [tx("e", "2026-10-30", 1600, "P", "Paycheck"), tx("f", "2026-10-31", 1600, "P", "Paycheck")]);
  check("a deposit 4 days from the only entry is another paycheck", H.mergedPaychecks([{ date: "2026-10-27", amount: 1600 }], [tx("g", "2026-10-31", 1600, "P", "Paycheck")]).rows.map((r) => [r.date, r.source]), [["2026-10-31", "deposit"], ["2026-10-27", "entered"]]);
  check("3 days apart is the same paycheck; the next one out isn't", edge.rows.map((r) => [r.date, r.source]), [["2026-10-31", "deposit"], ["2026-10-27", "both"]]);
  const near = H.mergedPaychecks([{ date: "2026-10-27", amount: 1600 }, { date: "2026-10-29", amount: 1600 }], [tx("n", "2026-10-29", 1600, "P", "Paycheck")]);
  check("one deposit matches one entry, the nearer", near.rows.map((r) => [r.date, r.source]), [["2026-10-29", "both"], ["2026-10-27", "entered"]]);
  check("junk entries are ignored", H.mergedPaychecks([null, { date: "nope", amount: 5 }, { date: "2026-10-01", amount: 0 }, { date: "2026-10-01", amount: -5 }], []).rows, []);

  // Entering the period's paycheck again replaces it.
  const history = [{ date: "2026-11-06", amount: 1400 }, { date: "2026-11-06", amount: 1450 }, { date: "2026-10-23", amount: 1500 }];
  const after = H.recordPaycheckEntry(history, { date: "2026-11-06", amount: 1475 });
  check("the same period's line is replaced, other periods kept", after.map((p) => [p.date, p.amount]), [["2026-10-23", 1500], ["2026-11-06", 1475]]);
  check("a new period is added", H.recordPaycheckEntry(after, { date: "2026-11-20", amount: 1480 }).length, 3);
  check("and the old list isn't changed", history.length, 3);

  // Through Enter Paycheck.
  const store = { [F.transactions]: "[]", [F.accounts]: JSON.stringify([{ id: "chk", type: "checking", institution: "Bank", current_balance: 900 }]), [F.rules]: "[]" };
  const app = { vault: { adapter: { exists: async (p) => p in store, read: async (p) => store[p], write: async (p, d) => { store[p] = d; }, mkdir: async () => {} } } };
  const plugin = Object.create(H.__PluginClass.prototype);
  Object.assign(plugin, { app, settings: BIWEEKLY, activateView: async () => {}, recalculate: async () => null, offerBufferSweep: async () => {} });
  let modal = null;
  const orig = H.PaycheckModal.prototype.open;
  H.PaycheckModal.prototype.open = function () { modal = this; };
  await plugin.promptEnterPaycheck();
  await modal.onSubmit({ paycheckAmount: 1500, checkingBalance: 900, alreadyDeposited: true, nextPaydayStr: D(14) });
  await modal.onSubmit({ paycheckAmount: 1500, checkingBalance: 900, alreadyDeposited: true, nextPaydayStr: D(14) });
  await modal.onSubmit({ paycheckAmount: 1525, checkingBalance: 900, alreadyDeposited: true, nextPaydayStr: D(14) });
  H.PaycheckModal.prototype.open = orig;
  const saved = JSON.parse(store[F.paycheckHistory]);
  check("entering the same period's paycheck three times leaves one line, the last", saved.map((p) => p.amount), [1525]);
}

// ===========================================================================
console.log("\n3. Income is a few paychecks");
{
  const amounts = [1900, 1200, 1300, 1400, 1500, 1600, 1700];
  const history = amounts.map((a, i) => ({ date: H.addDays("2026-08-07", i * 14), amount: a }));
  const s = snap({ paycheckHistory: history });
  check("the last six, their average and range", s.income.average, { count: 6, amount: 1450, low: 1200, high: 1700 });
  check("the latest is still the latest", s.income.paycheck, { amount: 1700, date: "2026-10-30", source: "entered" });
  check("monthly income: the average × 26/12", s.income.monthly, r2(1450 * 26 / 12));
  const one = snap({ paycheckHistory: [{ date: "2026-11-06", amount: 1800 }] });
  check("with one paycheck there's no average and it's that one", [one.income.average, one.income.monthly], [null, r2(1800 * 26 / 12)]);
  const md = H.snapshotMarkdown(s);
  check("the table shows the average and range", md.includes("| Average of the last 6 paychecks | $1,450.00 ($1,200.00 to $1,700.00) |"), true);
  const csv = H.snapshotCSV(s);
  check("the CSV has the average as a bare number", /^Average recent paycheck,1450\.00$/m.test(csv.replace(/\r/g, "")), true);
  const both = snap({ paycheckHistory: [{ date: "2026-11-06", amount: 1600 }], transactions: [tx("a", "2026-11-07", 1590, "P", "Paycheck"), tx("b", "2026-10-23", 1500, "P", "Paycheck")] });
  check("an entry and its deposit count once; a deposit you didn't enter counts", [both.income.average.count, both.income.average.amount], [2, 1550]);

  // Months with an extra paycheck, against an independent count.
  const brute = (cadence, anchor) => {
    const step = cadence === "weekly" ? 7 : 14;
    const counts = {};
    for (let d = anchor; d <= "2027-11-30"; d = H.addDays(d, step)) counts[d.slice(0, 7)] = (counts[d.slice(0, 7)] || 0) + 1;
    return Object.entries(counts).filter(([k, n]) => k >= "2026-11" && k <= "2027-10" && n > (cadence === "weekly" ? 4 : 2)).map(([k]) => k).sort();
  };
  check("every other week: the months with three", H.extraPaycheckMonths({ cadence: "biweekly", anchor_date: "2026-11-06" }, T), brute("biweekly", "2026-11-06"));
  check("…which are two in the year", brute("biweekly", "2026-11-06").length, 2);
  check("weekly: the months with five", H.extraPaycheckMonths({ cadence: "weekly", anchor_date: "2026-11-06" }, T), brute("weekly", "2026-11-06"));
  check("twice a month and monthly never have one", [H.extraPaycheckMonths({ cadence: "semimonthly", anchor_date: "2026-11-10", days: [10, 25] }, T), H.extraPaycheckMonths({ cadence: "monthly", anchor_date: "2026-11-10" }, T), H.extraPaycheckMonths(null, T)], [[], [], []]);
  check("the snapshot lists them", H.snapshotMarkdown(snap({ paycheckHistory: history })).includes("| Months with an extra paycheck | January 2027, July 2027 |"), true);
  check("the current month counts while it's still going", H.extraPaycheckMonths({ cadence: "biweekly", anchor_date: "2026-11-06" }, "2026-01-02").includes("2026-01"), true);
}

// ===========================================================================
console.log("\n4. A subscription that looks off says so");
{
  const monthly = (id, merchant, amount, n = 3) => Array.from({ length: n }, (_, i) => tx(`${id}${i}`, D(-30 * (n - i) + 10), -amount, merchant, "Subscription"));
  const transactions = [
    ...monthly("a", "STEADY TV", 10),
    ...monthly("b", "VOUCHERED APP", 12),
    tx("bc", D(-5), 12, "VOUCHERED APP CREDIT", "Refund"),
    ...monthly("c", "REFUNDED EARLY", 8),
    tx("cc", D(-80), 8, "REFUNDED EARLY CREDIT", "Refund"),
    tx("o", D(-9), -15, "ONE TIME THING", "Subscription"),
    ...[[-70, 10], [-40, 10], [-10, 12]].map(([n, a], i) => tx(`h${i}`, D(n), -a, "PRICE HIKE PLUS", "Subscription")),
    ...[[-45, 5], [-15, 20]].map(([n, a], i) => tx(`w${i}`, D(n), -a, "TWO CHARGES CO", "Subscription")),
    ...[[-120, 5], [-95, 20], [-60, 8], [-33, 12]].map(([n, a], i) => tx(`t${i}`, D(n), -a, "TOP UP TOOL", "Subscription"))
  ];
  const s = snap({ transactions });
  const by = Object.fromEntries(s.subscriptions.map((x) => [x.name, x]));
  const names = Object.keys(by);
  const find = (w) => by[names.find((n) => n.toUpperCase().includes(w))];
  check("a steady subscription has nothing to say", find("STEADY").flags, []);
  check("a credit after the last charge: flagged, with its date", find("VOUCHERED").flags, [{ kind: "credit", date: D(-5) }]);
  check("a credit from before the last charge isn't", find("REFUNDED").flags, []);
  check("a small price change isn't 'varying'", find("PRICE HIKE").flags, []);
  check("two charges are too few to call it varying", find("TWO CHARGES").flags, []);
  check("a single charge is a guess at monthly", find("ONE TIME").flags, [{ kind: "one charge" }]);
  check("charges that range widely: flagged with the range", find("TOP UP").flags.filter((f) => f.kind === "varies"), [{ kind: "varies", low: 5, high: 20 }]);
  const audit = H.buildSubscriptionAudit(transactions, [], [], undefined, { accounts: [], todayStr: T });
  check("the total is what the screen's audit says: nothing is taken out", s.subscriptionsMonthly, r2(audit.reduce((t, a) => t + a.monthlyEstimate, 0)));
  check("the flagged ones' share is told separately", s.subscriptionsFlaggedMonthly, r2(s.subscriptions.filter((x) => x.flags.length).reduce((t, x) => t + x.monthly, 0)));
  const md = H.snapshotMarkdown(s);
  check("Markdown adds a Note column when there's something to say", [md.includes("| Service | Cadence | Last charge | Monthly | Note |"), /credit .+, may be cancelled/.test(md), md.includes("amounts vary $5.00 to $20.00"), md.includes("one charge, counted monthly")], [true, true, true, true]);
  check("and what the notes come to", md.includes(`_Rows with a note come to ${H.snapshotMoney(s.subscriptionsFlaggedMonthly)} a month of the total._`), true);
  const csv = H.snapshotCSV(s);
  check("the CSV carries them in plain words, with no $", [/Subscription,[^\r\n]*credit \d{4}-\d\d-\d\d/.test(csv), /amounts vary 5\.00 to 20\.00/.test(csv), /\$/.test(csv)], [true, true, false]);
  const clean = H.snapshotMarkdown(snap({ transactions: monthly("a", "STEADY TV", 10) }));
  check("nothing to say: no Note column and no line about it", [clean.includes("| Note |"), clean.includes("Rows with a note")], [false, false]);
}

// ===========================================================================
console.log("\n5. Partial months");
{
  const rows = [tx("m1", "2026-05-18", -10, "A", "Gas"), tx("m2", "2026-08-10", -10, "A", "Gas"), tx("m3", "2026-10-28", -10, "A", "Gas"), tx("m4", "2026-11-22", -10, "A", "Gas")];
  const cov = H.ledgerCoverage(rows, T);
  check("the first month starts when the data does", H.monthCoverage("2026-05", cov), { from: "2026-05-18", to: "2026-05-31", days: 14, of: 31, startsLate: true, endsEarly: false });
  check("this month goes as far as the last row", H.monthCoverage("2026-11", cov), { from: "2026-11-01", to: "2026-11-22", days: 22, of: 30, startsLate: false, endsEarly: true });
  check("a month in between is whole", H.monthCoverage("2026-08", cov), null);
  check("a past month whose last row is early is still whole", H.monthCoverage("2026-10", cov), null);
  check("the month the data starts in, when it starts on the 1st, is whole", H.monthCoverage("2026-08", H.ledgerCoverage([tx("x", "2026-08-01", -1, "A", "Gas"), tx("y", "2026-09-30", -1, "A", "Gas")], "2026-12-01")), null);
  check("this month with no row yet today goes through today", H.monthCoverage("2026-11", { first: "2026-05-18", last: "2026-10-28", todayStr: T }).to, T);
  check("on the last day of the month it's whole", H.monthCoverage("2026-11", H.ledgerCoverage(rows, "2026-11-30")), null);
  const both = H.monthCoverage("2026-05", H.ledgerCoverage([tx("x", "2026-05-18", -1, "A", "Gas"), tx("y", "2026-05-22", -1, "A", "Gas")], "2026-05-23"));
  check("data that starts and stops inside one month: the range", [both.days, H.monthCoverageNote(both)], [5, `${H.formatShortDate("2026-05-18")} to ${H.formatShortDate("2026-05-22")}, 5 of 31 days`]);
  check("the words", [H.monthCoverageNote(H.monthCoverage("2026-05", cov)), H.monthCoverageNote(H.monthCoverage("2026-11", cov)), H.monthCoverageNote(null)], [`data starts ${H.formatShortDate("2026-05-18")}, 14 of 31 days`, `through ${H.formatShortDate("2026-11-22")}, 22 of 30 days`, ""]);
  check("no data: nothing", H.monthCoverage("2026-05", H.ledgerCoverage([], T)), null);

  const notes = H.buildTransactionNotes(rows, [], { todayStr: T });
  const by = Object.fromEntries(notes.map((f) => [f.name, f.content]));
  check("a partial month's note says what it covers, in its properties and under the title", [by["Transactions 2026-11"].includes("covers: 2026-11-01 to 2026-11-22"), by["Transactions 2026-11"].includes(`Partial month: through ${H.formatShortDate("2026-11-22")}, 22 of 30 days`), by["Transactions 2026-05"].includes("covers: 2026-05-18 to 2026-05-31")], [true, true, true]);
  check("a whole month's doesn't", [by["Transactions 2026-08"].includes("covers:"), by["Transactions 2026-08"].includes("Partial month")], [false, false]);

  const spending = H.buildDataNotes("spending", { transactions: rows, categoryMeta: [] }, { todayStr: T })[0].content;
  check("Spending by month marks them the same way", [spending.includes(`_Partial month: through ${H.formatShortDate("2026-11-22")}, 22 of 30 days._`), spending.includes("_Partial month: data starts"), (spending.match(/Partial month/g) || []).length], [true, true, 2]);
}

// ===========================================================================
console.log("\n6. In and out, without transfers");
{
  const meta = [{ name: "Credit Card Payment", is_transfer: true }];
  const rows = [
    tx("p", "2026-10-02", 2000, "PAYROLL", "Paycheck"),
    tx("g", "2026-10-03", -40, "GROCERY", "Groceries"),
    tx("cp", "2026-10-04", -150, "CARD PAYMENT", "Credit Card Payment"),
    tx("o", "2026-10-05", -300, "TO SAVINGS", "Moved", "chk", { transfer_pair: "i" }),
    tx("i", "2026-10-05", 300, "FROM CHECKING", "Moved", "sav", { transfer_pair: "o" }),
    tx("s", "2026-10-06", -25, "ONE SIDED", "Moved", "chk", { transfer_single: true })
  ];
  const note = H.buildTransactionNotes(rows, [], { categoryMeta: meta, todayStr: "2026-12-01" }).find((f) => f.name === "Transactions 2026-10").content;
  const props = note.split("---")[1].trim().split("\n");
  check("all money in and out, as before", props.slice(2, 4), ["money_in: 2300.00", "money_out: 515.00"]);
  check("and without card payments and transfers: only the paycheck and the groceries", props.slice(4, 6), ["income_excluding_transfers: 2000.00", "spending_excluding_transfers: 40.00"]);
  check("the summary says both", note.includes("Without transfers: in $2,000.00 · out $40.00"), true);
  const line = (m) => note.split("\n").find((l) => l.includes(m));
  check("a transfer's row says so in its category", [line("CARD PAYMENT").includes("Credit Card Payment (transfer)"), line("TO SAVINGS").includes("Moved (transfer)"), line("FROM CHECKING").includes("Moved (transfer)"), line("ONE SIDED").includes("Moved (transfer)"), /GROCERY \| Groceries \|/.test(line("GROCERY")), /PAYROLL \| Paycheck \|/.test(line("PAYROLL"))], [true, true, true, true, true, true]);
  const plain = H.buildTransactionNotes([tx("a", "2026-10-02", 5, "X", "Gas")], []).find((f) => f.name === "Transactions 2026-10").content;
  check("with no transfers the two sets are equal", plain.includes("money_in: 5.00") && plain.includes("income_excluding_transfers: 5.00"), true);

  // The same test the Transactions list's 'Hide transfers' uses.
  const isTransfer = H.transferTester(rows, meta);
  const shown = H.transactionListView(rows, { mode: "all", days: 36500, hideTransfers: true, categoryMeta: meta, todayStr: "2026-12-01" }).rows.map((t) => t.id).sort();
  check("it agrees with what Hide transfers leaves on the screen", rows.filter((t) => !isTransfer(t)).map((t) => t.id).sort(), shown);
}

// ===========================================================================
console.log("\n7. As-of dates, labels and what's not tracked");
{
  const accounts = [
    { id: "a", type: "checking", institution: "Fresh", current_balance: 100, balance_as_of: D(-1) },
    { id: "b", type: "savings", institution: "Old", current_balance: 50, balance_as_of: D(-12) },
    { id: "c", type: "savings", institution: "Nothing", current_balance: null, balance_as_of: D(-90) },
    { id: "d", type: "savings", institution: "Undated", current_balance: 5 }
  ];
  const portfolioAccounts = [{ id: "p1", provider: "Fidelity", type: "401k", label: "Retirement" }, { id: "p2", provider: "Vanguard", type: "roth_ira", label: "Roth" }];
  const portfolioSnapshots = [{ account_id: "p1", statement_end: "2026-10-31", ending_value: 5000 }, { account_id: "p2", statement_end: "2026-09-30", ending_value: 2000, contributions: 100, beginning_value: 1800 }];
  const data = { accounts, portfolioAccounts, portfolioSnapshots };
  const s = snap(data);
  check("cash is as of the oldest balance it adds up, ignoring accounts with no balance or no date", s.cashAsOf, D(-12));
  check("invested is as of the oldest statement", s.investedAsOf, "2026-09-30");
  const md = H.snapshotMarkdown(s);
  check("At a glance has an As of column on those two rows", [md.includes("|  | Amount | As of |"), md.includes(`| Cash on hand | $155.00 | ${H.formatChartDate(D(-12))} |`), md.includes("| Invested (latest statements) | $7,000.00 | Sep 30, 2026 |")], [true, true, true]);
  check("a figure that mixes dates has no single date", md.includes("| Total debt | $0.00 |  |"), true);
  check("the labels say what the surplus is before", [md.includes("| Committed monthly outgoings |"), md.includes("**Surplus before everyday spending**"), /Net surplus|Estimated monthly outgoings/.test(md), md.includes("Groceries, eating out, shopping")], [true, true, false, true]);
  const notes = H.buildDataNotes("portfolio", data, { todayStr: T })[0].content;
  check("portfolio: contributions are 'not tracked' when a statement has none, the figure when it does", [/Retirement \| 2026-10-31 \| — \| not tracked \|/.test(notes), /Roth \| 2026-09-30 \| \$1,800\.00 \| \$100\.00 \|/.test(notes)], [true, true]);
}

// ===========================================================================
console.log("\n8. Data health");
{
  const clean = snap({ accounts: [{ id: "a", type: "checking", institution: "Bank", current_balance: 100, balance_as_of: T }], transactions: [tx("x", "2026-11-01", -5, "A", "Gas"), tx("y", "2026-11-30", -5, "A", "Gas")] }, BIWEEKLY, "2026-11-30");
  check("nothing to report: no list, no heading", [clean.health, H.snapshotMarkdown(clean).includes("Data health")], [[], false]);

  const accounts = [
    { id: "a", type: "checking", institution: "Fresh", current_balance: 100, balance_as_of: D(-1) },
    { id: "b", type: "savings", institution: "Stale", current_balance: 50, balance_as_of: D(-12) },
    { id: "c", type: "savings", institution: "Week", current_balance: 50, balance_as_of: D(-7) },
    { id: "card", type: "credit_card", institution: "Maxed", current_balance: 1200, credit_limit: 1000 },
    { id: "card2", type: "credit_card", institution: "Fine", current_balance: 100, credit_limit: 1000 },
    { id: "card3", type: "credit_card", institution: "Exactly", current_balance: 1000, credit_limit: 1000 }
  ];
  const transactions = [
    tx("2", D(-3), -5, "A", "Gas"),
    tx("u1", D(-5), -9, "MYSTERY", "Uncategorized"), tx("u2", D(-6), -9, "MYSTERY", null), tx("u3", D(-200), -9, "OLD MYSTERY", "Uncategorized"), tx("u4", D(-4), -9, "LABELLED", "Uncategorized", "chk", { override_label: "Gas" })
  ];
  const s = snap({ accounts, transactions, paycheckHistory: [{ date: "2026-11-06", amount: 1500 }, { date: "2026-11-06", amount: 1500 }], reviews: [] });
  const h = s.health.join("\n");
  const first = D(-200);
  check("partial months, first and current", h.includes(`Partial months: May 2026: data starts ${H.formatShortDate(first)}, ${31 - Number(first.slice(8)) + 1} of 31 days; November 2026: through ${H.formatShortDate(D(-3))}, ${Number(D(-3).slice(8))} of 30 days.`), true);
  check("a balance over a week old; one exactly a week isn't", h.includes(`Balances over a week old: Stale (${H.formatShortDate(D(-12))}).`), true);
  check("a card over its limit, not one under or at it", h.includes("Over the credit limit: Maxed."), true);
  check("the repeat paycheck entry", h.includes("1 paycheck entry repeated a day already entered, counted once."), true);
  check("uncategorized in the last 90 days: not older, not ones you labelled", h.includes("2 transactions in the last 90 days are uncategorized."), true);
  const md = H.snapshotMarkdown(s);
  check("they're a list at the top, before At a glance", md.indexOf("## Data health") < md.indexOf("## At a glance") && md.indexOf("## Data health") > 0, true);
  check("one-kind exports don't carry it", H.snapshotMarkdown(s, { only: ["debts"] }).includes("Data health"), false);
  const withSub = snap({ transactions: [tx("o", D(-9), -15, "ONE TIME THING", "Subscription")] });
  check("a subscription with a note is counted", withSub.health.includes("1 subscription with a note: see Subscriptions."), true);
  check("the CSV is unchanged by any of it: still numbers only", /Data health/.test(H.snapshotCSV(s)), false);
}

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
})().catch((e) => { console.error(e); process.exit(1); });
