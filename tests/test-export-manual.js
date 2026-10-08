// The Export dialog and its notes, and adding a transaction or a balance by hand.
const H = require("./harness.js");
const { el, allText, SettingStub } = H;

let pass = 0, fail = 0;
function check(name, got, want) {
  const ok = JSON.stringify(got) === JSON.stringify(want);
  if (ok) { pass++; console.log(`  PASS  ${name}`); }
  else { fail++; console.log(`  FAIL  ${name}: got ${JSON.stringify(got)}, want ${JSON.stringify(want)}`); }
}
const F = H.FILES;
const T = H.todayLocal();

const data = {
  accounts: [{ id: "chk", institution: "Cal Coast Checking", type: "checking", current_balance: 1200 }],
  goals: [], revolvingDebts: [],
  installmentDebts: [{ id: "b1", payment_category: "BNPL", provider: "Affirm - Headphones", installment_amount: 32.5, frequency: "monthly", remaining_installments: 5, next_due_date: H.addDays(T, 5), balance_anchor: { amount: 162.5, date: T }, applied_payments: [] }],
  fixedExpenses: [{ id: "f1", name: "Fiber Net", amount: 60, due_day_of_month: 12 }],
  transactions: [
    { id: "t1", date: "2026-09-01", merchant_raw: "PAYROLL", amount: 2000, account_id: "chk", resolved_category: "Paycheck" },
    { id: "t2", date: "2026-09-03", merchant_raw: "SHELL", amount: -40, account_id: "chk", resolved_category: "Gas" },
    { id: "t3", date: "2026-09-04", merchant_raw: "SAVINGS XFER", amount: -100, account_id: "chk", resolved_category: "Transfer" }
  ],
  reviews: [], rules: [],
  categoryMeta: [{ name: "Transfer", is_transfer: true }],
  paycheckHistory: [{ date: "2026-09-01", amount: 2000 }],
  portfolioAccounts: [{ id: "hsa", label: "HSA", type: "hsa", provider: "Fidelity" }],
  portfolioSnapshots: [{ account_id: "hsa", statement_start: "2026-09-01", statement_end: "2026-09-30", beginning_value: 1000, contributions: 100, ending_value: 1150 }]
};
const paths = (kind) => H.buildDataNotes(kind, data, { todayStr: "2026-10-08" }).map((f) => f.path);
const body = (kind, i = 0) => H.buildDataNotes(kind, data, { todayStr: "2026-10-08" })[i].content;

console.log("\n1. Notes for one kind of data");
check("the kinds on offer", H.EXPORT_KINDS.map((k) => k.label), ["Transactions", "Spending by month", "Debts", "Income", "Cash and credit", "Savings goals", "Bills and subscriptions", "Portfolio"]);
check("debts: one note, no repeated heading, a table of the plan", [paths("debts"), /^# Debts\n\n\| Debt/m.test(body("debts")), body("debts").includes("Affirm")], [["Debts.md"], true, true]);
check("every note says it's a copy", H.EXPORT_KINDS.every((k) => H.buildDataNotes(k.key, data, { todayStr: "2026-10-08" }).every((f) => f.content.includes("Changes here are overwritten"))), true);
check("income: the paycheck and the history", [body("income").includes("Latest paycheck"), body("income").includes("Paychecks you entered"), body("income").includes("| 2026-09-01 | $2,000.00 |")], [true, true, true]);
check("portfolio: latest value and the statement history", [body("portfolio").includes("HSA"), body("portfolio").includes("| HSA | 2026-09-30 | $1,000.00 | $100.00 | $1,150.00 |")], [true, true]);
check("spending: by month, transfers left out and said so", [body("spending").includes("## September 2026"), body("spending").includes("| Gas | $40.00 | 100% |"), body("spending").includes("not counted above: $100.00")], [true, true, true]);
check("bills and subscriptions: the bill is there", body("bills").includes("Fiber Net"), true);
check("cash and credit: the account is there", body("accounts").includes("Cal Coast Checking"), true);
check("transactions: the monthly notes under Transactions/", paths("transactions"), ["Transactions/Transactions 2026-09.md", "Transactions/Transactions.md"]);
check("a full export has them all", H.buildFullExportNotes(data, { todayStr: "2026-10-08" }).map((f) => f.path).sort(), [
  "Bills and subscriptions.md", "Cash and credit.md", "Debts.md", "Income.md", "Portfolio.md", "Savings goals.md", "Spending by month.md",
  "Transactions/Transactions 2026-09.md", "Transactions/Transactions.md"]);
check("the snapshot is unchanged when nothing is filtered", H.snapshotMarkdown(H.buildFinancialSnapshot(data, { todayStr: "2026-10-08" })).startsWith("# Financial snapshot"), true);

console.log("\n2. The dialog");
{
  const calls = [];
  SettingStub.buttons = []; SettingStub.dropdowns = [];
  const m = new H.ExportModal({}, { snapshot: () => calls.push("snapshot"), full: () => calls.push("full"), kind: (k) => calls.push(k) });
  let closed = 0; m.close = () => closed++;
  m.onOpen();
  check("three choices", SettingStub.buttons.map((b) => b.label), ["Export", "Export", "Export"]);
  SettingStub.buttons[0].cb(); SettingStub.buttons[1].cb();
  SettingStub.dropdowns[0].choose("debts"); SettingStub.buttons[2].cb();
  check("each does its thing and closes", [calls, closed], [["snapshot", "full", "debts"], 3]);
  check("the dropdown lists every kind", SettingStub.dropdowns[0].options.map((o) => o.value), H.EXPORT_KINDS.map((k) => k.key));
}

console.log("\n3. The export commands");
(async () => {
  const store = {};
  Object.entries({ [F.accounts]: data.accounts, [F.savingsGoals]: [], [F.revolvingDebts]: [], [F.installmentDebts]: data.installmentDebts, [F.fixedExpenses]: data.fixedExpenses,
    [F.transactions]: data.transactions, [F.subscriptionReviews]: [], [F.rules]: [], [F.categories]: data.categoryMeta, [F.paycheckHistory]: data.paycheckHistory,
    [F.portfolioAccounts]: data.portfolioAccounts, [F.portfolioSnapshots]: data.portfolioSnapshots }).forEach(([k, v]) => (store[k] = JSON.stringify(v)));
  const dirs = new Set(), writes = {};
  const app = { vault: { adapter: { exists: async (p) => p in store || dirs.has(p), read: async (p) => store[p], mkdir: async (p) => dirs.add(p), write: async (p, d) => { writes[p] = d; } } } };
  const plugin = Object.create(H.__PluginClass.prototype);
  plugin.app = app; plugin.settings = {};
  global.__notices = [];
  await plugin.exportKind("debts");
  check("one kind saves one note", Object.keys(writes), ["Budget/exports/Debts.md"]);
  check("and says so", global.__notices.pop(), "Exported debts to Budget/exports.");
  Object.keys(writes).forEach((k) => delete writes[k]);
  await plugin.exportEverything();
  const names = Object.keys(writes).map((p) => p.replace("Budget/exports/", ""));
  check("a full export saves the snapshot (note and CSV) and every kind", [names.some((n) => /^Snapshot - .*\.md$/.test(n)), names.some((n) => /^Snapshot - .*\.csv$/.test(n)), names.includes("Debts.md"), names.includes("Transactions/Transactions.md")], [true, true, true, true]);
  check("the full export's notice", global.__notices.pop(), "Full export saved to Budget/exports.");
  check("the data files are untouched", store[F.transactions], JSON.stringify(data.transactions));

  console.log("\n4. Adding a transaction by hand");
  const rules = [{ merchant_pattern: "SHELL", home_label: "Gas" }];
  const ok = (over) => H.buildManualTransaction(Object.assign({ date: "2026-10-02", merchant: "Shell Oil", amount: "40.25", direction: "out", account_id: "chk", category: "" }, over), rules);
  const r1 = ok({});
  check("money out is negative; the rules categorise it", [r1.ok, r1.tx.amount, r1.tx.resolved_category, r1.tx.override_label, r1.tx.account_id, r1.tx.date], [true, -40.25, "Gas", null, "chk", "2026-10-02"]);
  check("it's marked as typed in, and has an id", [r1.tx.manual, typeof r1.tx.id], [true, "string"]);
  const r2 = ok({ direction: "in", merchant: "Birthday cash", category: "Misc Income" });
  check("money in is positive; a category you pick wins", [r2.tx.amount, r2.tx.resolved_category, r2.tx.override_label], [40.25, "Misc Income", "Misc Income"]);
  check("a typed $ and commas are fine", ok({ amount: "$1,234.50" }).tx.amount, -1234.5);
  check("no date", ok({ date: "" }).error, "Enter a date.");
  check("no description", ok({ merchant: "  " }).error, "Enter what it was for.");
  check("no amount", ok({ amount: "" }).error, "Enter an amount above zero.");
  check("zero", ok({ amount: "0" }).error, "Enter an amount above zero.");
  check("nonsense", ok({ amount: "abc" }).ok, false);
  check("no account", ok({ account_id: "" }).error, "Choose an account.");

  console.log("\n5. Saving it");
  store[F.rules] = JSON.stringify(rules);
  const written = [];
  const origWrite = app.vault.adapter.write;
  app.vault.adapter.write = async (p, d) => { store[p] = d; written.push(p); };
  plugin.refreshAfterDataChange = async () => written.push("refreshed");
  const origModal = H.ManualTransactionModal.prototype.open;
  let captured = null;
  H.ManualTransactionModal.prototype.open = function () { captured = this; };
  await plugin.promptAddTransaction();
  H.ManualTransactionModal.prototype.open = origModal;
  check("the form gets the accounts and the categories in use", [captured.accounts.map((a) => a.id), captured.categories.includes("Gas")], [["chk"], true]);
  await captured.onSubmit(r1.tx);
  const saved = JSON.parse(store[F.transactions]);
  check("it's added to the rest, nothing else changed", [saved.length, saved[saved.length - 1].merchant_raw, saved.slice(0, 3).map((t) => t.id)], [4, "Shell Oil", ["t1", "t2", "t3"]]);
  check("and the dashboard refreshes", written.includes("refreshed"), true);
  store[F.accounts] = "[]";
  global.__notices = [];
  await plugin.promptAddTransaction();
  check("no accounts: it says so", global.__notices.pop(), "Add an account first.");

  console.log("\n6. A balance by hand");
  const b = (over) => H.buildManualBalance(Object.assign({ account_id: "hsa", date: "2026-10-07", value: "1,200.50" }, over));
  const b1 = b({});
  check("one day, an ending value, marked as typed in", [b1.ok, b1.snapshot.statement_start, b1.snapshot.statement_end, b1.snapshot.ending_value, b1.snapshot.manual], [true, "2026-10-07", "2026-10-07", 1200.5, true]);
  check("no value", b({ value: "" }).error, "Enter what it's worth.");
  check("no date", b({ date: "" }).ok, false);
  check("no account", b({ account_id: "" }).ok, false);
  store[F.portfolioSnapshots] = JSON.stringify(data.portfolioSnapshots);
  global.__notices = [];
  let cap2 = null;
  const origBal = H.ManualBalanceModal.prototype.open;
  H.ManualBalanceModal.prototype.open = function () { cap2 = this; };
  plugin.loadPortfolioAccounts = async () => [{ id: "hsa", label: "HSA" }];
  plugin.refreshDashboard = () => written.push("redrawn");
  await plugin.promptAddInvestmentBalance();
  await cap2.onSubmit(b1.snapshot);
  H.ManualBalanceModal.prototype.open = origBal;
  const snaps = JSON.parse(store[F.portfolioSnapshots]);
  check("a new balance is added in date order", [snaps.map((s) => s.statement_end), global.__notices.pop()], [["2026-09-30", "2026-10-07"], "Balance saved."]);
  plugin.loadPortfolioAccounts = async () => [];
  await plugin.promptAddInvestmentBalance();
  check("no investment accounts: it says so", global.__notices.pop(), "Add an investment account first.");

  console.log(`\n${pass} passed, ${fail} failed`);
  process.exit(fail ? 1 : 0);
})().catch((e) => { console.error(e); process.exit(1); });
