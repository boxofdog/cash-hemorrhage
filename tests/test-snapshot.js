// 1.23.0 — Export Snapshot: every figure checked against an independent sum,
// the Markdown and CSV shapes, and the button's clipboard/file behaviour.
global.document = { body: { classList: { contains: () => false } } };
const H = require("./harness.js");

let pass = 0, fail = 0;
function check(name, got, want) {
  const ok = JSON.stringify(got) === JSON.stringify(want);
  if (ok) { pass++; console.log(`  PASS  ${name}`); }
  else { fail++; console.log(`  FAIL  ${name}: got ${JSON.stringify(got)}, want ${JSON.stringify(want)}`); }
}
const r2 = (n) => Math.round(n * 100) / 100;
const T = "2026-09-23";
const D = (n) => H.addDays(T, n);

// ---------------------------------------------------------------------------
const accounts = [
  { id: "Main Checking", type: "checking", institution: "Credit Union", current_balance: 1250.4, balance_as_of: T },
  { id: "Personal Savings", type: "savings", institution: "Cal Coast — Personal Savings", current_balance: 640.12, balance_as_of: D(-1) },
  { id: "Old Savings", type: "savings", current_balance: null },
  { id: "Capital One Card", type: "credit_card", current_balance: 590.46, credit_limit: 901 },
  { id: "Store Card", type: "credit_card", current_balance: 20 }
];
const goals = [
  { id: "g1", name: "Moving fund", target_amount: 3000, saved_amount: 250, target_date: "2026-11-26" },
  { id: "fund-1", kind: "capped", name: "Oopsie Fund", target_amount: 1000, account_id: "Personal Savings" }
];
// A card whose balance has moved since it was anchored: $500 + $120 − $50.
const card = { id: "cc1", account_id: "Capital One Card", apr: 29.99, min_payment_due: 40, due_date: D(2), payment_category: "Credit Card Payment", balance_anchor: { amount: 500, date: D(-20) }, applied_payments: [] };
const paidCard = { id: "cc2", account_id: "Store Card", apr: 25, min_payment_due: 25, balance_anchor: { amount: 0, date: D(-20) }, applied_payments: [] };
const plans = [
  { id: "p1", provider: "Klarna", installment_amount: 49.48, frequency: "monthly", balance_anchor: { amount: 544.28, date: D(-14) }, applied_payments: [{ amount: 23.24 }] },
  { id: "p2", provider: "ZIP - Switch 2", installment_amount: 67.5, frequency: "biweekly", balance_anchor: { amount: 405.01, date: D(-10) }, applied_payments: [] },
  { id: "p3", provider: "Affirm - Toy", installment_amount: 24.37, frequency: "biweekly", balance_anchor: { amount: 48.74, date: D(-40) }, applied_payments: [{ amount: 48.74 }] }
];
const bills = [
  { id: "f1", name: "Rent", amount: 1450, due_day_of_month: 1 },
  { id: "f2", name: "Phone Co", amount: 33.81, interval_days: 28, next_due_date: D(10) },
  { id: "f3", name: "Netflix", amount: 15.49, due_day_of_month: 12, payment_category: "Subscription" }
];
const tx = (id, date, amount, merchant, cat, account = "Main Checking") => ({ id, date, amount, merchant_raw: merchant, resolved_category: cat, account_id: account });
const transactions = [
  tx("c1", D(-5), -120, "AMAZON", "Shopping", "Capital One Card"),
  tx("c2", D(-3), 50, "PAYMENT THANK YOU", "Credit Card Payment", "Capital One Card"),
  // Subscriptions: Spotify monthly (kept), Hulu monthly (flagged to cancel),
  // Netflix monthly (also a bill: counted there).
  ...[-75, -45, -15].map((n, i) => tx(`s${i}`, D(n), -11.99, "SPOTIFY USA", "Subscription")),
  ...[-76, -46, -16].map((n, i) => tx(`h${i}`, D(n), -17.99, "HULU", "Subscription")),
  ...[-70, -40, -10].map((n, i) => tx(`n${i}`, D(n), -15.49, "NETFLIX.COM", "Subscription")),
  // Gas every ~5 days; one older than 90 days that mustn't count.
  tx("gold", D(-120), -60, "SHELL", "Gas"),
  ...[-40, -35, -30, -25, -20, -15, -10, -5].map((n, i) => tx(`g${i}`, D(n), -50, "SHELL", "Gas")),
  // Pet food: two purchases, both on one day.
  tx("pf1", D(-20), -80, "CHEWY", "Pet Bills"),
  tx("pf2", D(-20), -96.1, "CHEWY", "Pet Bills"),
  // A paycheck deposit older than the entered one.
  tx("pay0", D(-22), 1590, "ACME PAYROLL", "Paycheck"),
  tx("pay1", D(-8), 1612.4, "ACME PAYROLL", "Paycheck")
];
const categoryMeta = [
  { name: "Gas", is_variable_necessity: true },
  { name: "Pet Bills", is_variable_necessity: true },
  { name: "Subscription" },
  { name: "Credit Card Payment", is_transfer: true }
];
const reviews = [{ merchant_key: "HULU", status: "cancel" }];
const portfolioAccounts = [
  { id: "a", provider: "Fidelity", type: "401k", label: "Fidelity 401(k)" },
  { id: "b", provider: "Vanguard", type: "roth_ira", label: "Roth" }
];
const portfolioSnapshots = [
  { account_id: "a", statement_start: "2026-07-01", statement_end: "2026-07-31", ending_value: 55000 },
  { account_id: "a", statement_start: "2026-08-01", statement_end: "2026-08-31", ending_value: 56200 },
  { account_id: "gone", statement_end: "2026-08-31", ending_value: 99999 }
];
const DATA = { accounts, goals, revolvingDebts: [card, paidCard], installmentDebts: plans, fixedExpenses: bills, transactions, reviews, rules: [], categoryMeta, paycheckHistory: [{ date: D(-8), amount: 1600 }, { date: D(-22), amount: 1580 }], portfolioAccounts, portfolioSnapshots };
const build = (over = {}, settings = { paySchedule: { cadence: "biweekly", anchor_date: D(-8) } }) => H.buildFinancialSnapshot(Object.assign({}, DATA, over), { todayStr: T, settings });

(async () => {
// ===========================================================================
console.log("\n1. Cash, credit, savings");
{
  const s = build();
  check("every non-card account, a capped fund's marked", s.cash.map((c) => [c.name, c.balance, c.fund]), [["Credit Union", 1250.4, null], ["Cal Coast — Personal Savings", 640.12, "Oopsie Fund"], ["Old Savings", null, null]]);
  check("cash total leaves out an account with no balance", s.cashTotal, r2(1250.4 + 640.12));
  check("credit available is limit less the card's live debt balance", s.credit.map((c) => [c.name, c.balance, c.available]), [["Capital One Card", 570, 331], ["Store Card", 0, null]]);
  check("a card with no limit isn't counted as available credit", s.creditAvailable, 331);
  const untracked = H.buildFinancialSnapshot({ accounts }, { todayStr: T });
  check("a card not on the Debts tab: the account's balance", untracked.credit.map((c) => [c.balance, c.available]), [[590.46, 310.54], [20, null]]);
  check("goals at saved and target", s.savings, [{ name: "Moving fund", saved: 250, target: 3000, remaining: 2750, targetDate: "2026-11-26" }]);
  check("a capped fund at its account's balance", s.funds, [{ name: "Oopsie Fund", balance: 640.12, cap: 1000, account: "Cal Coast — Personal Savings" }]);
}

// ===========================================================================
console.log("\n2. Debts");
{
  const s = build();
  check("a card at its live balance (anchor + charges − payments since)", s.cards[0].balance, r2(500 + 120 - 50));
  check("…the same figure the Debts tab uses", s.cards[0].balance, H.debtBalance(card, transactions));
  check("a paid-off card costs nothing a month", [s.cards[1].balance, s.cards[1].minimum], [0, 0]);
  check("plans at their balance", s.plans.map((p) => p.balance), [r2(544.28 - 23.24), 405.01, 0]);
  check("…and what each costs a month, by frequency", s.plans.map((p) => p.monthly), [49.48, r2(67.5 * 2.166), 0]);
  check("installments left", s.plans.map((p) => p.remaining), [H.remainingInstallments(plans[0]), 7, 0]);
  check("total debt", s.debtTotal, r2(570 + 521.04 + 405.01));
  check("monthly debt cost: card minimums plus plan payments", s.debtMonthly, r2(40 + 49.48 + 67.5 * 2.166));
}

// ===========================================================================
console.log("\n3. Bills, subscriptions, necessities");
{
  const s = build();
  check("a monthly bill is its amount; one every 28 days is scaled to a month", s.bills.map((b) => [b.name, b.monthly]), [["Rent", 1450], ["Phone Co", r2(33.81 * (30.44 / 28))], ["Netflix", 15.49]]);
  check("bills total", s.billsMonthly, r2(1450 + r2(33.81 * 30.44 / 28) + 15.49));
  const audit = H.buildSubscriptionAudit(transactions, reviews, [], undefined, { accounts, todayStr: T });
  check("a subscription flagged to cancel isn't counted", s.subscriptions.some((x) => /HULU/.test(x.name)), false);
  check("nor one that's also a bill (it's counted there)", s.subscriptions.some((x) => /NETFLIX/i.test(x.name)), false);
  check("the rest at the audit's own monthly estimate", s.subscriptions.map((x) => [x.name, x.monthly]), audit.filter((a) => /SPOTIFY/.test(a.key)).map((a) => [a.key, a.monthlyEstimate]));
  const gas = s.necessities.find((n) => n.name === "Gas");
  check("gas: the last 90 days' spending as a monthly rate", [gas.spent90, gas.monthly], [400, r2(400 / 90 * 30.44)]);
  check("…with its typical purchase and spacing for reference", [gas.typical, gas.everyDays], [50, 5]);
  const pet = s.necessities.find((n) => n.name === "Pet Bills");
  check("pet food bought twice on one day: its spending counts, no made-up rhythm", [pet.typical, pet.everyDays, pet.monthly], [null, null, r2(176.1 / 90 * 30.44)]);
  check("necessities total", s.necessitiesMonthly, r2(r2(400 / 90 * 30.44) + r2(176.1 / 90 * 30.44)));
}

// ===========================================================================
console.log("\n4. The dashboard's necessity projection no longer invents a daily purchase");
{
  const ctx = H.calculateVariableNecessities(transactions, categoryMeta, T, D(14));
  const pet = ctx.detail.find((d) => d.category === "Pet Bills");
  check("two purchases on the same day: not enough history, nothing held back", [pet.sufficientHistory, pet.reserveAmount, pet.projectedCount], [false, 0, 0]);
  const gas = ctx.detail.find((d) => d.category === "Gas");
  check("a real rhythm still projects", [gas.medianGap, gas.projectedCount > 0], [5, true]);
  const twoDays = [tx("x1", D(-9), -80, "CHEWY", "Pet Bills"), tx("x2", D(-2), -80, "CHEWY", "Pet Bills")];
  const ok = H.calculateVariableNecessities(twoDays, categoryMeta, T, D(14)).detail.find((d) => d.category === "Pet Bills");
  check("purchases on two different days do", [ok.sufficientHistory !== false, ok.medianGap], [true, 7]);
}

// ===========================================================================
console.log("\n5. Investments and income");
{
  const s = build();
  check("each account at its latest statement; one without is listed, uncounted", s.investments.map((i) => [i.name, i.value, i.asOf]), [["Fidelity 401(k)", 56200, "2026-08-31"], ["Roth", null, null]]);
  check("a deleted account's statements aren't counted", s.investedTotal, 56200);
  check("the latest paycheck: entered beats an older deposit", s.income.paycheck, { amount: 1600, date: D(-8), source: "entered" });
  const s2 = build({ paycheckHistory: [{ date: D(-30), amount: 1500 }] });
  check("a newer deposit filed as Paycheck beats an older entry", s2.income.paycheck, { amount: 1612.4, date: D(-8), source: "deposit" });
  const per = (cadence) => build({}, { paySchedule: { cadence, anchor_date: D(-8) } }).income.monthly;
  check("monthly income by cadence: weekly ×4.33, biweekly ×2.166, twice a month ×2, monthly ×1", [per("weekly"), per("biweekly"), per("semimonthly"), per("monthly")], [r2(1600 * 4.33), r2(1600 * 2.166), 3200, 1600]);
  const outflow = r2(s.debtMonthly + s.billsMonthly + s.subscriptionsMonthly + s.necessitiesMonthly);
  check("outgoings: debt minimums + bills + subscriptions + necessities", s.income.outflow, outflow);
  check("surplus: income less outgoings", s.income.surplus, r2(r2(1600 * 2.166) - outflow));
  const none = build({ paycheckHistory: [], transactions: transactions.filter((t) => t.resolved_category !== "Paycheck") }, {});
  check("no paycheck and no schedule: no income or surplus, not zero", [none.income.paycheck, none.income.monthly, none.income.surplus], [null, null, null]);
  const detected = build({}, {});
  check("no saved schedule: detected from paycheck deposits", [detected.income.cadence, detected.income.cadenceInferred], ["biweekly", true]);
}

// ===========================================================================
console.log("\n6. Markdown");
{
  const md = H.snapshotMarkdown(build()); if (process.env.SHOWMD) console.log(md);
  check("titled with the date", md.split("\n")[0], "# Financial snapshot — Sep 23, 2026");
  check("sections in order", [...md.matchAll(/^## (.+)$/gm)].map((m) => m[1]), ["At a glance", "Income & cash flow", "Cash", "Credit", "Savings", "Debts", "Recurring bills", "Subscriptions", "Projected necessities", "Investments"]);
  check("money with thousands separators and cents", /\| Rent \| \$1,450\.00 \| monthly, day 1 \| \$1,450\.00 \|/.test(md), true);
  check("every table has a header rule, amounts right-aligned", /\| Debt \| Balance \| Terms \| Monthly \|\n\| --- \| ---: \| ---: \| ---: \|/.test(md), true);
  check("totals in bold", /\| \*\*Total\*\* \| \*\*\$1,496\.05\*\* \|  \| \*\*\$235\.68\/mo\*\* \|/.test(md), true);
  check("paid-off debts aren't listed", /Affirm - Toy|Store Card \| \$0/.test(md.split("## Debts")[1].split("##")[0]), false);
  check("outgoings shown as deductions", /\| Debt minimums \| -\$235\.68 \|/.test(md), true);
  check("a negative surplus reads as a deficit", H.snapshotMoney(-5191.74), "-$5,191.74");
  check("a | in a name can't break the table", H.snapshotTable(["Name", "Amount"], [["A | B", "$1.00"]]).split("\n")[2], "| A \\| B | $1.00 |");
  const bare = H.snapshotMarkdown(H.buildFinancialSnapshot({}, { todayStr: T }));
  check("an empty vault: no crash, empty sections say so", [/_No debts tracked\._/.test(bare), /_No active subscriptions\._/.test(bare), /## Investments/.test(bare)], [true, true, false]);
}

// ===========================================================================
console.log("\n7. CSV");
{
  const csv = H.snapshotCSV(build()); if (process.env.SHOWCSV) console.log(csv);
  const blocks = csv.replace(/\r\n$/, "").split("\r\n\r\n").map((b) => b.split("\r\n"));
  const find = (bi, name) => blocks[bi].find((l) => l.startsWith(name + ","));
  check("stacked blocks, each with its own header", blocks.map((b) => b[0]), [
    "Metric,Amount",
    "Account,Type,Balance,Target Goal,Target Date",
    "Lender,Balance,Credit Limit,Available Credit,APR (%),Monthly Min,Remaining Months",
    "Item,Category,Monthly Cost,Billing Cadence",
    "Account,Kind,Value,Statement Date"
  ]);
  check("CRLF throughout, one blank row between blocks", [/[^\r]\n/.test(csv), (csv.match(/\r\n\r\n/g) || []).length], [false, 4]);
  check("every row as wide as its header", blocks.every((b) => b.every((l) => l.replace(/"[^"]*"/g, "x").split(",").length === b[0].split(",").length)), true);
  check("summary: income, outgoings, surplus, totals", blocks[0].slice(1).map((l) => l.split(",")[0]), ["Latest paycheck", "Paychecks per month", "Estimated monthly income", "Debt minimums (monthly)", "Recurring bills (monthly)", "Subscriptions (monthly)", "Projected necessities (monthly)", "Total monthly outgoings", "Net surplus / deficit (monthly)", "Total cash", "Credit available", "Total debt", "Invested"]);
  check("outgoings are positive and add up to the total", (() => {
    const v = (m) => Number(find(0, m).split(",")[1]);
    return [v("Debt minimums (monthly)") > 0, Math.abs(v("Debt minimums (monthly)") + v("Recurring bills (monthly)") + v("Subscriptions (monthly)") + v("Projected necessities (monthly)") - v("Total monthly outgoings")) < 0.011,
      Math.abs(v("Estimated monthly income") - v("Total monthly outgoings") - v("Net surplus / deficit (monthly)")) < 0.011];
  })(), [true, true, true]);
  check("no $ or % anywhere: bare numbers", /\$|\d%/.test(csv), false);
  check("a goal: bare target and ISO date", find(1, "Moving fund"), "Moving fund,Savings goal,250.00,3000.00,2026-11-26");
  check("a capped fund's cap on the account that holds it", find(1, "Cal Coast — Personal Savings (Oopsie Fund)"), "Cal Coast — Personal Savings (Oopsie Fund),Savings,640.12,1000.00,");
  check("an unknown balance is an empty cell", find(1, "Old Savings"), "Old Savings,Savings,,,");
  check("a card: limit, what's left, APR, minimum", find(2, "Capital One Card"), "Capital One Card,570.00,901.00,331.00,29.99,40.00,");
  check("a monthly plan: payments left as months", find(2, "Klarna"), "Klarna,521.04,,,,49.48,11");
  check("a biweekly plan: its monthly cost, and months to run", find(2, "ZIP - Switch 2"), "ZIP - Switch 2,405.01,,,,146.20,3.2");
  check("paid-off debts and limitless zero cards left out", blocks[2].some((l) => /Kendama|Store Card/.test(l)), false);
  check("row reconciles: limit − balance = available", (() => { const c = find(2, "Capital One Card").split(","); return Math.abs(c[2] - c[1] - c[3]) < 0.001; })(), true);
  check("bills, subscriptions and necessities, tagged", blocks[3].slice(1).map((l) => l.split(",")[1]), ["Bill", "Bill", "Bill", "Subscription", "Necessity", "Necessity"]);
  check("a bill's cadence stays one unquoted cell", find(3, "Rent"), "Rent,Bill,1450.00,Monthly (day 1)");
  check("a necessity without a rhythm", find(3, "Pet Bills").split(",")[3], "Irregular");
  check("the block sums to the non-debt outgoings", (() => { const s = build(); return Math.abs(blocks[3].slice(1).reduce((t, l) => t + Number(l.split(",")[2]), 0) - (s.billsMonthly + s.subscriptionsMonthly + s.necessitiesMonthly)) < 0.02; })(), true);
  check("a negative surplus is a bare negative number", /^Net surplus \/ deficit \(monthly\),-\d+\.\d\d$/m.test(H.snapshotCSV(build({ paycheckHistory: [{ date: D(-8), amount: 100 }] })).replace(/\r/g, "")), true);
  check("quotes are doubled", H.snapshotCSV(H.buildFinancialSnapshot({ fixedExpenses: [{ name: 'The "Big" Bill', amount: 5, due_day_of_month: 1 }] }, { todayStr: T })).includes('"The ""Big"" Bill"'), true);
  const empty = H.snapshotCSV(H.buildFinancialSnapshot({}, { todayStr: T }));
  check("no data: the four blocks, headers only, empty cells for unknowns", [empty.split("\r\n\r\n").length, /Estimated monthly income,\r\n/.test(empty)], [4, true]);
}

// ===========================================================================
console.log("\n8. The button: clipboard and files");
{
  const store = {};
  Object.entries({
    [H.FILES.accounts]: accounts, [H.FILES.savingsGoals]: goals, [H.FILES.revolvingDebts]: [card], [H.FILES.installmentDebts]: plans,
    [H.FILES.fixedExpenses]: bills, [H.FILES.transactions]: transactions, [H.FILES.categories]: categoryMeta, [H.FILES.subscriptionReviews]: reviews,
    [H.FILES.paycheckHistory]: DATA.paycheckHistory, [H.FILES.portfolioAccounts]: portfolioAccounts, [H.FILES.portfolioSnapshots]: portfolioSnapshots
  }).forEach(([k, v]) => (store[k] = JSON.stringify(v)));
  const dirs = new Set();
  let failWrite = false;
  const app = { vault: { adapter: {
    exists: async (p) => p in store || dirs.has(p),
    read: async (p) => store[p],
    write: async (p, d) => { if (failWrite) throw new Error("read-only"); store[p] = d; },
    mkdir: async (p) => dirs.add(p)
  } } };
  const plugin = Object.create(H.__PluginClass.prototype);
  Object.assign(plugin, { app, settings: { paySchedule: { cadence: "biweekly", anchor_date: D(-8) } } });
  let clip = null;
  const savedNav = globalThis.navigator;
  const setNav = (v) => Object.defineProperty(globalThis, "navigator", { value: v, configurable: true, writable: true });
  setNav({ clipboard: { writeText: async (t) => { clip = t; } } });
  global.__notices = [];
  const out = await plugin.exportSnapshot();
  const base = `Budget/exports/Snapshot - ${H.todayLocal()}`;
  check("the Markdown goes to the clipboard", clip === out.markdown && clip.startsWith("# Financial snapshot"), true);
  check("…and is saved, with a CSV copy, in Budget/exports", [store[`${base}.md`] === out.markdown, store[`${base}.csv`] === out.csv, dirs.has("Budget/exports")], [true, true, true]);
  check("it says so", global.__notices.pop(), `Financial snapshot copied to clipboard! Saved to ${base}.md and .csv.`);
  setNav({ clipboard: { writeText: async () => { throw new Error("denied"); } } });
  await plugin.exportSnapshot();
  check("no clipboard: points to the saved file instead", global.__notices.pop(), `Couldn't reach the clipboard — the snapshot is saved to ${base}.md (and .csv).`);
  setNav({ clipboard: { writeText: async (t) => { clip = t; } } });
  failWrite = true;
  clip = null;
  const r = await plugin.exportSnapshot();
  check("files can't be written: still copied", [!!clip, r.saved, global.__notices.pop()], [true, false, "Financial snapshot copied to clipboard!"]);
  setNav(savedNav);
}

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
})().catch((e) => { console.error(e); process.exit(1); });
