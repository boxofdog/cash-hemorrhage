// Capped funds (1.18.0): a savings goal whose balance is a linked account's,
// with a ceiling it stops asking for surplus at.
const P = require("./paths.js");
global.document = { body: { classList: { contains: () => false } } };
const fs = require("fs");
const H = require("./harness.js");
const { el, allText, SettingStub } = H;

let pass = 0, fail = 0;
function check(name, got, want) {
  const ok = JSON.stringify(got) === JSON.stringify(want);
  if (ok) { pass++; console.log(`  PASS  ${name}`); }
  else { fail++; console.log(`  FAIL  ${name}: got ${JSON.stringify(got)}, want ${JSON.stringify(want)}`); }
}
const tick = (ms = 5) => new Promise((r) => setTimeout(r, ms));
const T = H.todayLocal();
const D = (n) => H.addDays(T, n);
const F = H.FILES;
const find = (n, pred, out = []) => { if (pred(n)) out.push(n); (n.children || []).forEach((c) => find(c, pred, out)); return out; };
const byCls = (n, cls) => find(n, (x) => x.classes && x.classes.has(cls));
const text = (n) => allText(n).replace(/\s+/g, " ").trim();
const buttonsIn = (n) => find(n, (x) => x.tag === "button");
const button = (n, label) => buttonsIn(n).find((b) => b._text === label);

// ---------------------------------------------------------------------------
const SAV = { id: "Personal Savings", type: "savings", institution: "Cal Coast — Personal Savings", current_balance: 640.12, simplefin_id: "ACT-sav", balance_as_of: T };
const CHK = { id: "Main Checking", type: "checking", institution: "Credit Union", current_balance: 900, simplefin_id: "ACT-chk" };
const CARD = { id: "Capital One Card", type: "credit_card", current_balance: 300, credit_limit: 901 };
const ACCOUNTS = [CHK, SAV, CARD];
const fund = (o = {}) => Object.assign({ id: "fund-1", kind: "capped", name: "Oopsie Fund", target_amount: 1000, account_id: "Personal Savings", placement: "cards" }, o);
const acct = (bal, o = {}) => [Object.assign({}, SAV, { current_balance: bal }, o)];

function makeApp(files = {}) {
  const store = {};
  Object.entries(files).forEach(([k, v]) => (store[k] = JSON.stringify(v)));
  const secrets = {};
  return {
    _store: store,
    vault: {
      adapter: {
        exists: async (p) => p in store,
        read: async (p) => store[p],
        write: async (p, d) => { store[p] = d; },
        mkdir: async () => {},
        list: async () => ({ files: [], folders: [] })
      },
      getFiles: () => [],
      read: async () => ""
    },
    secretStorage: { getSecret: (id) => secrets[id] ?? null, setSecret: (id, v) => { secrets[id] = v; } },
    loadLocalStorage: () => null,
    saveLocalStorage: () => {}
  };
}
const readFile = (app, p) => (p in app._store ? JSON.parse(app._store[p]) : undefined);
function makePlugin(app) {
  const p = Object.create(H.__PluginClass.prototype);
  Object.assign(p, {
    app, manifest: { id: "budget-tracker" }, settings: {}, syncing: false,
    lastPaycheckInputs: { checkingBalance: 900, alreadyDeposited: true },
    _refreshes: 0, _afterChange: 0, _opened: [],
    refreshDashboard() { this._refreshes++; },
    async refreshAfterDataChange() { this._afterChange++; },
    openSettings(o) { this._opened.push(o || {}); }
  });
  return p;
}

(async () => {
// ===========================================================================
console.log("\n1. What a capped fund is");
{
  check("kind capped", H.isCappedFund(fund()), true);
  check("an ordinary goal isn't", H.isCappedFund({ id: "g", name: "Moving", target_amount: 3000 }), false);
  check("null-safe", H.isCappedFund(null), false);
  const goals = [{ id: "g1", name: "Moving" }, fund(), null];
  check("regularGoals drops funds and holes", H.regularGoals(goals).map((g) => g.id), ["g1"]);
  check("cappedFunds keeps only funds", H.cappedFunds(goals).map((g) => g.id), ["fund-1"]);
  check("placement defaults to a card", H.fundPlacement(fund({ placement: undefined })), "cards");
  check("an unknown placement is a card", H.fundPlacement(fund({ placement: "sidebar" })), "cards");
  check("hero is kept", H.fundPlacement(fund({ placement: "hero" })), "hero");
  check("a pinned fund never takes the pinned slot", H.findPriorityGoal([fund({ pinned: true })]), null);
  check("an ordinary pinned goal still does", H.findPriorityGoal([fund({ pinned: true }), { id: "g", pinned: true }]).id, "g");
}

// ===========================================================================
console.log("\n2. Its balance is the account's");
{
  let p = H.fundProgress(fund(), ACCOUNTS);
  check("saved is the live balance", [p.saved, p.target, p.remaining], [640.12, 1000, 359.88]);
  check("percent full", Math.round(p.pct * 100) / 100, 64.01);
  check("known, with its account and date", [p.known, p.account.id, p.asOf], [true, "Personal Savings", T]);
  check("goalProgress hands funds to fundProgress", H.goalProgress(fund(), ACCOUNTS).saved, 640.12);
  check("and ignores accounts for an ordinary goal",
    H.goalProgress({ target_amount: 100, saved_amount: 40 }, ACCOUNTS), { saved: 40, target: 100, remaining: 60, pct: 40, complete: false });

  p = H.fundProgress(fund(), acct(1250));
  check("over the cap: complete, full bar, overage", [p.complete, p.pct, p.remaining, p.over], [true, 100, 0, 250]);
  p = H.fundProgress(fund(), acct(1000));
  check("exactly at the cap is complete", [p.complete, p.remaining, p.over], [true, 0, 0]);
  p = H.fundProgress(fund(), acct(-20));
  check("overdrawn counts as empty, not less", [p.saved, p.pct, p.remaining, p.complete], [-20, 0, 1000, false]);

  p = H.fundProgress(fund(), []);
  check("account gone: unknown, and asks for nothing", [p.known, p.account, p.remaining, p.pct, p.complete], [false, null, 0, 0, false]);
  p = H.fundProgress(fund(), acct(null));
  check("no balance yet: unknown, and asks for nothing", [p.known, p.remaining], [false, 0]);
  p = H.fundProgress(fund(), acct(""));
  check("a blank balance is no balance", p.known, false);
  p = H.fundProgress(fund({ target_amount: "abc" }), ACCOUNTS);
  check("a broken ceiling reads as zero", [p.target, p.pct, p.complete], [0, 0, false]);
}

// ===========================================================================
console.log("\n3. Its share of a surplus eases off near the ceiling");
{
  const share = (bal, surplus) => H.fundShare(fund(), surplus, acct(bal)).amount;
  check("empty: the whole surplus", share(0, 300), 300);
  check("half full: half of it", share(500, 300), 150);
  check("90% full: a tenth", share(900, 300), 30);
  check("64% full: 36%", share(640, 300), 108);
  check("a big surplus still fills it", share(900, 5000), 100);
  check("never more than the room left", share(0, 5000), 1000);
  check("a share under $1 isn't suggested", share(995, 100), 0);
  check("but $1 is", share(990, 100), 1);
  check("full: nothing", share(1000, 300), 0);
  check("over: nothing", share(1300, 300), 0);
  check("no surplus: nothing", share(0, 0), 0);
  check("negative surplus: nothing", share(0, -50), 0);
  check("unknown balance: nothing, not the whole ceiling", H.fundShare(fund(), 300, []).amount, 0);
  check("zero ceiling: nothing", H.fundShare(fund({ target_amount: 0 }), 300, acct(0)).amount, 0);

  const why = (bal, surplus) => H.fundReason(H.fundShare(fund(), surplus, acct(bal)));
  check("reason when it fills", why(900, 5000), "tops it up to its $1000.00 cap");
  check("reason when empty", why(0, 300), "empty, so it takes all of what's left toward its $1000.00 cap");
  check("reason in between", why(640, 300), "64% full, so it takes 36% of what's left — eases off near its $1000.00 cap");
  check("never '100% full, takes 0%'", why(996, 500), "99% full, so it takes 1% of what's left — eases off near its $1000.00 cap");
}

// ===========================================================================
console.log("\n4. Splitting a surplus across funds");
{
  const accounts = [
    Object.assign({}, SAV, { id: "a", current_balance: 800 }),
    Object.assign({}, SAV, { id: "b", current_balance: 100 }),
    Object.assign({}, SAV, { id: "c", current_balance: 1000 })
  ];
  const goals = [
    fund({ id: "fa", name: "A", account_id: "a" }),
    fund({ id: "fb", name: "B", account_id: "b" }),
    fund({ id: "fc", name: "Full", account_id: "c" }),
    fund({ id: "fx", name: "Lost", account_id: "gone" }),
    { id: "g", name: "Moving", target_amount: 3000, saved_amount: 0 }
  ];
  const r = H.allocateToFunds(goals, 400, accounts);
  check("emptiest first, full and unknown skipped, goals ignored", r.breakdown.map((b) => b.id), ["fb", "fa"]);
  // B: 10% full -> 90% of 400 = 360. A: 20% of the 40 left = 8.
  check("each takes its share of what the one before left", r.breakdown.map((b) => b.amount), [360, 8]);
  check("total", r.total, 368);
  check("entries are marked as funds", r.breakdown.every((b) => b.fund === true), true);
  check("nothing to split", [H.allocateToFunds(goals, 0, accounts).breakdown, H.allocateToFunds(goals, 0, accounts).total], [[], 0]);
  check("no funds", H.allocateToFunds([goals[4]], 500, accounts), { breakdown: [], total: 0, periods: {} });
}

// ===========================================================================
console.log("\n5. Savings Focus (1.20.0 ladder): dated paces, then the fund, then top-ups, then undated");
{
  const dated = { id: "g1", name: "Moving fund", target_amount: 3000, saved_amount: 2800, target_date: D(60) };
  let r = H.recommendSavings([dated, fund()], 500, { g1: 4 }, T, null, ACCOUNTS);
  // Pace $50 (200 over 4 checks); the fund takes 36% of the $450 left; the
  // goal is then topped up with the other $150 it needs.
  check("the goal's pace, then the fund's share, then the goal topped up", r.breakdown.map((b) => [b.id, b.amount]), [["g1", 200], ["fund-1", 161.95]]);
  check("the fund gets 36% of what the pace left", r.breakdown[1].reason.startsWith("64% full"), true);
  check("the goal's reason says it was topped up", /on pace for .*then topped up/.test(r.breakdown[0].reason), true);
  check("total counts both", r.total, 361.95);

  r = H.recommendSavings([{ id: "g2", name: "Car", target_amount: 5000, saved_amount: 0 }, fund()], 500, {}, T, null, ACCOUNTS);
  check("an undated goal comes after the fund", r.breakdown.map((b) => [b.id, b.amount]), [["fund-1", 179.94], ["g2", 320.06]]);

  r = H.recommendSavings([fund()], 300, {}, T, null, ACCOUNTS);
  check("with no goals the fund draws on all of it", r.breakdown.map((b) => [b.id, b.amount]), [["fund-1", 107.96]]);

  // Before, a fund had no saved_amount, so it would have read as an undated
  // goal $1000 short and taken the whole surplus in tier 3.
  r = H.recommendSavings([fund()], 5000, {}, T, null, ACCOUNTS);
  check("never treated as an undated goal", r.breakdown.map((b) => b.amount), [359.88]);
  check("the global deadline doesn't make it dated", H.recommendSavings([fund()], 300, { "fund-1": 2 }, T, D(30), ACCOUNTS).breakdown[0].amount, 107.96);
  check("without accounts it asks for nothing", H.recommendSavings([fund()], 300, {}, T, null).breakdown, []);
  check("no surplus, no fund", H.recommendSavings([fund()], 0, {}, T, null, ACCOUNTS).total, 0);
}

// ===========================================================================
console.log("\n6. The allocator, both strategies");
{
  const base = {
    cashOnHand: 2000, todayStr: D(-3), nextPaydayStr: D(11), fixedExpenses: [], installmentDebts: [],
    revolvingDebts: [{ account_id: "Capital One Card", apr: 29.99, balance_anchor: { amount: 5000, date: D(-30) }, applied_payments: [], min_payment_due: 40, due_date: D(40) }],
    bufferMode: "manual", manualBuffer: 300, currentDateStr: T
  };
  const cliff = { provider: "Affirm", installment_amount: 50, next_due_date: D(40), balance_anchor: { amount: 400, date: D(-10) }, applied_payments: [],
    deferred_interest_risk: { applies: true, payoff_deadline: D(90), retroactive_apr: 30, original_principal: 400 } };

  const debt = H.runAllocation(Object.assign({}, base, { goals: [fund()], accounts: ACCOUNTS }));
  const avail = debt.availableForDebt;
  check("available surplus", avail, 1700);
  const want = Math.round(Math.min(359.88, 1700 * 0.35988) * 100) / 100;
  check("Debt Reduction: the fund takes its weighted share", debt.savingsBreakdown.map((b) => [b.id, b.amount]), [["fund-1", want]]);
  check("and the card gets the rest", debt.payoffBreakdown.map((p) => p.amount), [Math.round((1700 - want) * 100) / 100]);
  check("recommendedSavings is the fund's share", debt.recommendedSavings, want);
  check("free cash still reconciles",
    Math.round((debt.cashOnHand - debt.committed - debt.recommendedExtraPayoff - debt.recommendedSavings - debt.effectiveBuffer) * 100) / 100,
    Math.round(debt.freeCash * 100) / 100);

  const lean = H.runAllocation(Object.assign({}, base, { cashOnHand: 600, goals: [fund()], accounts: ACCOUNTS }));
  check("a smaller surplus: the fund's weighted share, the card the rest",
    [lean.availableForDebt, lean.savingsBreakdown[0].amount, lean.payoffBreakdown[0].amount], [300, 107.96, 192.04]);
  check("the fund's reason explains the taper", lean.savingsBreakdown[0].reason, "64% full, so it takes 36% of what's left — eases off near its $1000.00 cap");

  const withCliff = H.runAllocation(Object.assign({}, base, { installmentDebts: [cliff], goals: [fund()], accounts: ACCOUNTS }));
  check("a deferred-interest cliff is paid before the fund", withCliff.payoffBreakdown[0].target, "Affirm");
  check("the fund takes its share of what the cliff left", withCliff.savingsBreakdown[0].amount,
    Math.round(Math.min(359.88, (withCliff.availableForDebt - 400) * 0.35988) * 100) / 100);

  const full = H.runAllocation(Object.assign({}, base, { goals: [fund()], accounts: acct(1000) }));
  check("a full fund leaves Debt Reduction exactly as it was", [full.savingsBreakdown, full.recommendedSavings, full.payoffBreakdown[0].amount], [[], 0, 1700]);

  const sav = H.runAllocation(Object.assign({}, base, { savingsMode: true, goals: [fund()], accounts: ACCOUNTS }));
  check("Savings Focus: no payoff, the fund in savings", [sav.payoffBreakdown.length, sav.savingsBreakdown[0].id], [0, "fund-1"]);
  check("and the fund's share counts against free cash", Math.round(sav.freeCash * 100) / 100, Math.round((1700 - sav.recommendedSavings) * 100) / 100);

  // Without a fund, nothing about the allocation may change. Checked against
  // the release before this one, not against expectations written today.
  const old = require("./harness-for.js")(P.BASELINES + "/main.fund-before.js");
  const goals = [{ id: "g1", name: "Moving fund", target_amount: 3000, saved_amount: 250, target_date: D(60), contributions: [] }];
  for (const [label, extra] of [["Debt Reduction", {}], ["Savings Focus", { savingsMode: true }], ["with a cliff", { installmentDebts: [cliff] }]]) {
    const args = Object.assign({}, base, { goals, paychecksFor: { g1: 4 } }, extra);
    const strip = (r) => JSON.parse(JSON.stringify(r));
    const now = strip(H.runAllocation(Object.assign({ accounts: ACCOUNTS }, args)));
    check(`no fund, ${label}: the only new field is an empty fundPeriods`, now.fundPeriods, {});
    delete now.fundPeriods;
    check(`no fund, ${label}: otherwise identical to 1.17.0`, now, strip(old.runAllocation(args)));
  }
}

// ===========================================================================
console.log("\n7. Pairing transfers with the fund's account");
{
  const cats = [{ name: "Savings", is_transfer: true }, { name: "Groceries", is_transfer: false }, { name: "Credit Card Payment", is_transfer: true }, { name: "Chase Payment", is_transfer: true }];
  const t = (o) => Object.assign({ resolved_category: "Uncategorized", override_label: null }, o);
  const out = (list, goals = [fund()], c = cats, opts = {}) => H.pairFundTransfers(list, goals, c, Object.assign({ accounts: ACCOUNTS }, opts));
  const X = "To Savings 00";

  let txs = [
    t({ id: "c1", date: D(-2), amount: -200, account_id: "Main Checking", merchant_raw: X }),
    t({ id: "s1", date: D(-2), amount: 200, account_id: "Personal Savings", merchant_raw: "From Share 10" })
  ];
  let pairs = out(txs);
  check("an uncategorised pair that reads like a transfer is found", pairs.map((p) => [p.fundIndex, p.otherIndex, p.category, p.labelOther]), [[1, 0, "Savings", true]]);
  H.applyFundTransferPairs(txs, pairs);
  check("both halves filed as Savings", txs.map((x) => [x.override_label, x.resolved_category]), [["Savings", "Savings"], ["Savings", "Savings"]]);
  check("and pointed at each other", [txs[0].transfer_pair, txs[1].transfer_pair], ["s1", "c1"]);
  check("a second pass finds nothing more", out(txs), []);

  // The user's real shape: the checking half is already filed by hand.
  txs = [
    t({ id: "c1", date: D(-8), amount: -1054.77, account_id: "Main Checking", merchant_raw: X, override_label: "Savings", resolved_category: "Savings" }),
    t({ id: "s1", date: D(-8), amount: 1054.77, account_id: "Personal Savings", merchant_raw: "Deposit" })
  ];
  pairs = out(txs);
  check("a half already filed as a transfer lends its category", pairs.map((p) => [p.category, p.labelOther]), [["Savings", false]]);
  H.applyFundTransferPairs(txs, pairs);
  check("and is left as it was", [txs[0].override_label, txs[0].resolved_category, txs[0].transfer_pair], ["Savings", "Savings", "s1"]);
  check("filed as a transfer needs no telling description",
    out([t({ id: "c", date: T, amount: -40, account_id: "Main Checking", merchant_raw: "ACH 99812", resolved_category: "Savings" }), t({ id: "s", date: T, amount: 40, account_id: "Personal Savings" })]).length, 1);

  check("money out of the fund pairs the same way",
    out([t({ id: "s", date: D(-1), amount: -300, account_id: "Personal Savings" }), t({ id: "c", date: D(0), amount: 300, account_id: "Main Checking", merchant_raw: "Transfer from Savings 00" })]).length, 1);

  // Audit case A: payday, a $200 card payment and a $200 move to savings.
  txs = [
    t({ id: "cc-pay", date: T, amount: -200, account_id: "Main Checking", merchant_raw: "CAPITAL ONE ONLINE PMT", resolved_category: "Credit Card Payment" }),
    t({ id: "cc-in", date: T, amount: 200, account_id: "Capital One Card", merchant_raw: "PAYMENT THANK YOU", resolved_category: "Credit Card Payment" }),
    t({ id: "xfer", date: T, amount: -200, account_id: "Main Checking", merchant_raw: X }),
    t({ id: "fund-in", date: T, amount: 200, account_id: "Personal Savings", merchant_raw: "Deposit" })
  ];
  check("a same-sized card payment isn't taken for the transfer", out(txs).map((p) => txs[p.otherIndex].id), ["xfer"]);
  // Audit case A2: a withdrawal the same day as a card payment.
  txs = [
    t({ id: "cc-in", date: T, amount: 300, account_id: "Capital One Card", merchant_raw: "PAYMENT THANK YOU", resolved_category: "Credit Card Payment" }),
    t({ id: "wd-in", date: T, amount: 300, account_id: "Main Checking", merchant_raw: "Transfer from Savings 00" }),
    t({ id: "wd-out", date: T, amount: -300, account_id: "Personal Savings", merchant_raw: "Withdrawal" })
  ];
  check("nor a card's payment-received row", out(txs).map((p) => txs[p.otherIndex].id), ["wd-in"]);
  check("a card row never pairs, even uncategorised and telling",
    out([t({ id: "k", date: T, amount: 300, account_id: "Capital One Card", merchant_raw: "TRANSFER" }), t({ id: "s", date: T, amount: -300, account_id: "Personal Savings" })]), []);
  check("a debt's own payment category is out too",
    out([t({ id: "k", date: T, amount: -75, account_id: "Main Checking", resolved_category: "Chase Payment" }), t({ id: "s", date: T, amount: 75, account_id: "Personal Savings" })], [fund()], cats, { debtCategories: ["Chase Payment"] }), []);
  // Audit case B: a split direct deposit and an ATM withdrawal.
  check("an ATM withdrawal isn't a transfer to savings",
    out([t({ id: "atm", date: D(-2), amount: -100, account_id: "Main Checking", merchant_raw: "ATM WITHDRAWAL 7-ELEVEN" }), t({ id: "pay", date: D(0), amount: 100, account_id: "Personal Savings", merchant_raw: "ACME FOODS PAYROLL" })]), []);
  // Audit case D: a Zelle payment beside the real transfer.
  txs = [
    t({ id: "zelle", date: T, amount: -50, account_id: "Main Checking", merchant_raw: "ZELLE TRANSFER TO SAM" }),
    t({ id: "real", date: T, amount: -50, account_id: "Main Checking", merchant_raw: "ONLINE TRANSFER TO SAV" }),
    t({ id: "s", date: T, amount: 50, account_id: "Personal Savings", merchant_raw: "TRANSFER FROM CHK" })
  ];
  check("a Zelle payment that says 'transfer' isn't one", out(txs).map((p) => txs[p.otherIndex].id), ["real"]);
  check("nor is it taken when it's the only candidate", out([txs[0], txs[2]]), []);
  check("the fund side's own description doesn't vouch for the other half",
    out([t({ id: "c", date: T, amount: -50, account_id: "Main Checking", merchant_raw: "CAFE" }), t({ id: "s", date: T, amount: 50, account_id: "Personal Savings", merchant_raw: "TRANSFER FROM CHK" })]), []);
  check("'Save Mart' doesn't read as savings",
    out([t({ id: "c", date: T, amount: -50, account_id: "Main Checking", merchant_raw: "SAVE MART 612" }), t({ id: "s", date: T, amount: 50, account_id: "Personal Savings" })]), []);

  const fundLeg = t({ id: "s", date: D(-2), amount: 50, account_id: "Personal Savings" });
  check("a grocery run isn't a transfer", out([t({ id: "g", date: D(-2), amount: -50, account_id: "Main Checking", merchant_raw: X, resolved_category: "Groceries" }), fundLeg]), []);
  check("a fund-side row labelled by hand is left alone",
    out([t({ id: "c", date: D(-2), amount: -50, account_id: "Main Checking", merchant_raw: X }), t({ id: "s", date: D(-2), amount: 50, account_id: "Personal Savings", override_label: "Uncategorized" })]), []);
  check("so is one a rule filed",
    out([t({ id: "c", date: D(-2), amount: -50, account_id: "Main Checking", merchant_raw: X }), t({ id: "s", date: D(-2), amount: 50, account_id: "Personal Savings", resolved_category: "Interest" })]), []);
  check("same sign isn't a transfer", out([t({ id: "c", date: D(-2), amount: 50, account_id: "Main Checking", merchant_raw: X }), fundLeg]), []);
  check("a cent apart isn't the same amount", out([t({ id: "c", date: D(-2), amount: -50.01, account_id: "Main Checking", merchant_raw: X }), fundLeg]), []);
  check("three days apart pairs", out([t({ id: "c", date: D(-5), amount: -50, account_id: "Main Checking", merchant_raw: X }), fundLeg]).length, 1);
  check("four days apart doesn't", out([t({ id: "c", date: D(-6), amount: -50, account_id: "Main Checking", merchant_raw: X }), fundLeg]), []);
  check("two rows in the fund's own account never pair",
    out([t({ id: "a", date: T, amount: -50, account_id: "Personal Savings", merchant_raw: X }), t({ id: "b", date: T, amount: 50, account_id: "Personal Savings" })]), []);
  check("rows without an id are skipped",
    out([t({ date: T, amount: -50, account_id: "Main Checking", merchant_raw: X }), t({ id: "s", date: T, amount: 50, account_id: "Personal Savings" })]), []);
  check("rows without a date are skipped",
    out([t({ id: "c", amount: -50, account_id: "Main Checking", merchant_raw: X }), t({ id: "s", date: T, amount: 50, account_id: "Personal Savings" })]), []);

  txs = [
    t({ id: "s1", date: D(-1), amount: 50, account_id: "Personal Savings" }),
    t({ id: "s2", date: D(-1), amount: 50, account_id: "Personal Savings" }),
    t({ id: "c1", date: D(-1), amount: -50, account_id: "Main Checking", merchant_raw: X })
  ];
  check("one half pairs once", out(txs).length, 1);
  txs = [
    t({ id: "far", date: D(-3), amount: -50, account_id: "Main Checking", merchant_raw: X }),
    t({ id: "near", date: D(0), amount: -50, account_id: "Main Checking", merchant_raw: X }),
    t({ id: "s", date: D(0), amount: 50, account_id: "Personal Savings" })
  ];
  check("nearest date wins", txs[out(txs)[0].otherIndex].id, "near");
  txs = [
    t({ id: "loose", date: D(-1), amount: -50, account_id: "Main Checking", merchant_raw: X }),
    t({ id: "filed", date: D(1), amount: -50, account_id: "Main Checking", resolved_category: "Savings" }),
    t({ id: "s", date: D(0), amount: 50, account_id: "Personal Savings" })
  ];
  check("on a tie, the half already filed as a transfer wins", txs[out(txs)[0].otherIndex].id, "filed");

  txs = [
    t({ id: "c-old", date: D(-1), amount: -50, account_id: "Main Checking", resolved_category: "Savings", transfer_pair: "s-old" }),
    t({ id: "s-old", date: D(-1), amount: 50, account_id: "Personal Savings", resolved_category: "Savings", override_label: "Savings", transfer_pair: "c-old" }),
    t({ id: "s-new", date: D(0), amount: 50, account_id: "Personal Savings" })
  ];
  check("a half paired on an earlier pass isn't reused", out(txs), []);
  txs[1] = t({ id: "s-other", date: D(-9), amount: 7, account_id: "Main Checking" });
  check("but one whose partner is gone is free again", out(txs).map((p) => txs[p.otherIndex].id), ["c-old"]);

  const two = [fund(), fund({ id: "fund-2", name: "Car cushion", account_id: "Car Savings" })];
  txs = [t({ id: "a", date: T, amount: -80, account_id: "Personal Savings", merchant_raw: "Transfer to Savings 02" }), t({ id: "b", date: T, amount: 80, account_id: "Car Savings", merchant_raw: "Transfer from Savings 01" })];
  check("between two funds' accounts, one pair", out(txs, two).length, 1);

  check("no funds, no pairs", out([t({ id: "c", date: T, amount: -5, account_id: "Main Checking", merchant_raw: X }), t({ id: "s", date: T, amount: 5, account_id: "Personal Savings" })], [{ id: "g" }]), []);
  check("a fund without an account pairs nothing", out([t({ id: "s", date: T, amount: 5, account_id: "Personal Savings" })], [fund({ account_id: null })]), []);

  check("with no Savings category, Savings is created as a transfer", H.fundTransferCategory([]), { name: "Savings", create: true });
  check("an existing transfer Savings is used as is", H.fundTransferCategory(cats), { name: "Savings", create: false });
  check("a Savings that counts as spending isn't flipped", H.fundTransferCategory([{ name: "Savings", is_transfer: false }]), { name: "Savings Transfer", create: true });
  check("nor is a Savings Transfer that does", H.fundTransferCategory([{ name: "Savings", is_transfer: false }, { name: "Savings Transfer", is_transfer: false }]), { name: "Savings Transfer 2", create: true });
  check("and the fallback is used for new pairs",
    H.pairFundTransfers([t({ id: "c", date: T, amount: -5, account_id: "Main Checking", merchant_raw: X }), t({ id: "s", date: T, amount: 5, account_id: "Personal Savings" })], [fund()], [{ name: "Savings", is_transfer: false }])[0].category,
    "Savings Transfer");
}

// ===========================================================================
console.log("\n8. Pairing inside the plugin");
{
  const files = () => ({
    [F.savingsGoals]: [fund()],
    [F.accounts]: ACCOUNTS,
    [F.categories]: [{ name: "Groceries", is_transfer: false }],
    [F.transactions]: [
      { id: "c1", date: D(-2), amount: -200, account_id: "Main Checking", merchant_raw: "To Savings 00", resolved_category: "Uncategorized" },
      { id: "s1", date: D(-2), amount: 200, account_id: "Personal Savings", merchant_raw: "From Share 10", resolved_category: "Uncategorized" }
    ]
  });
  let app = makeApp(files());
  let plugin = makePlugin(app);
  const ledger = readFile(app, F.transactions);
  const n = await plugin.pairFundTransfersIn(ledger);
  check("pairs the ledger it is handed", [n, ledger[0].override_label, ledger[1].override_label], [1, "Savings", "Savings"]);
  check("and doesn't write it itself", readFile(app, F.transactions)[0].override_label, undefined);
  check("the category is created as a transfer first", readFile(app, F.categories).find((c) => c.name === "Savings"), { name: "Savings", is_transfer: true });

  app = makeApp(files());
  plugin = makePlugin(app);
  check("relabelFundTransfers writes the whole ledger", [await plugin.relabelFundTransfers(), readFile(app, F.transactions)[1].resolved_category], [1, "Savings"]);

  const noFund = files();
  noFund[F.savingsGoals] = [{ id: "g", name: "Moving" }];
  app = makeApp(noFund);
  plugin = makePlugin(app);
  check("no fund: nothing touched, no category made", [await plugin.relabelFundTransfers(), readFile(app, F.categories).length], [0, 1]);
}

// ===========================================================================
console.log("\n9. A sync files the fund's transfers");
{
  const ACCESS = "https://demo:s3cr3t@beta-bridge.simplefin.org/simplefin";
  const at = (d, h = 12) => Math.floor(new Date(`${d}T${String(h).padStart(2, "0")}:00:00`).getTime() / 1000);
  const app = makeApp({
    [F.accounts]: [
      Object.assign({}, CHK, { last_imported_through: D(-3) }),
      Object.assign({}, SAV, { last_imported_through: D(-3), current_balance: 440.12, balance_as_of: D(-5) })
    ],
    [F.savingsGoals]: [fund()],
    [F.categories]: [{ name: "Savings", is_transfer: true }],
    [F.transactions]: [],
    [F.rules]: []
  });
  app.secretStorage.setSecret(H.SIMPLEFIN_SECRET_ID, ACCESS);
  const plugin = makePlugin(app);
  global.__notices = [];
  global.__requestUrl = async () => ({
    status: 200,
    json: {
      errlist: [],
      connections: [{ conn_id: "C1", name: "Cal Coast" }],
      accounts: [
        { id: "ACT-chk", name: "Checking", conn_id: "C1", currency: "USD", balance: "700", "balance-date": at(T, 9),
          transactions: [{ id: "x1", posted: at(D(-1)), amount: "-200.00", description: "To Savings 00" },
                         { id: "x2", posted: at(D(-1)), amount: "-12.00", description: "CAFE" }] },
        { id: "ACT-sav", name: "Personal Savings", conn_id: "C1", currency: "USD", balance: "640.12", "balance-date": at(D(-1), 23),
          transactions: [{ id: "y1", posted: at(D(-1)), amount: "200.00", description: "From Share 10" },
                         { id: "y2", posted: at(D(-1)), amount: "0.42", description: "DIVIDEND" }] }
      ]
    }
  });
  const res = await plugin.syncSimpleFIN();
  const after = readFile(app, F.transactions);
  const by = Object.fromEntries(after.map((t) => [t.simplefin_id, t]));
  check("sync ran", res && res.added, 4);
  check("both halves of the transfer are Savings", [by.x1.resolved_category, by.y1.resolved_category], ["Savings", "Savings"]);
  check("the cafe and the dividend are left for the rules", [by.x2.resolved_category, by.y2.resolved_category], ["Uncategorized", "Uncategorized"]);
  check("the notice stays short: filing transfers is housekeeping", [global.__notices[0].startsWith("Synced 4 new transactions"), /Filed/.test(global.__notices[0])], [true, false]);
  const acc = readFile(app, F.accounts);
  check("the fund's balance is the account's, with its date", [acc[1].current_balance, acc[1].balance_as_of], [640.12, D(-1)]);
  check("checking's date is its own", acc[0].balance_as_of, T);
}

// ===========================================================================
console.log("\n10. A CSV import files them too");
{
  const app = makeApp({
    [F.accounts]: [{ id: "Main Checking", type: "checking", current_balance: 700, csv_source: "mainbank" }, SAV],
    [F.savingsGoals]: [fund()],
    [F.categories]: [],
    [F.transactions]: [{ id: "s1", date: D(-2), amount: 150, account_id: "Personal Savings", merchant_raw: "From Share 10", resolved_category: "Uncategorized", simplefin_id: "y9", simplefin_account: "ACT-sav" }],
    [F.rules]: []
  });
  const mdy = (d) => `${d.slice(5, 7)}/${d.slice(8)}/${d.slice(0, 4)}`;
  app.vault.getFiles = () => [{ path: `${H.IMPORT_DIR}/export.csv`, extension: "csv" }];
  app.vault.read = async () => `Date,Description,Amount\n${mdy(D(-2))},To Savings 00,-150.00\n${mdy(D(-1))},CAFE,-9.00`;
  app.vault.getAbstractFileByPath = () => ({});
  app.fileManager = { trashFile: async () => {} };
  const plugin = makePlugin(app);
  let result = null;
  H.ImportResultModal.prototype.open = function () { result = this.summary; };
  H.ImportSourceModal.prototype.open = function () { return this.onChoose(this.files[0]); };
  H.AccountPickerModal.prototype.open = function () { return this.onChoose(this.accounts[0]); };
  await plugin.promptImportCSV();
  await tick(20);
  const after = readFile(app, F.transactions);
  const xfer = after.find((t) => t.merchant_raw === "To Savings 00");
  check("the imported half is filed", xfer && xfer.resolved_category, "Savings");
  check("and so is the synced half", after.find((t) => t.id === "s1").resolved_category, "Savings");
  check("Savings now exists as a transfer", readFile(app, F.categories), [{ name: "Savings", is_transfer: true }]);
  check("the import says so", result.notes.some((n) => /1 transfer with a capped fund's account was filed as a transfer/.test(n)), true);
  check("still a clean import", result.status, "success");
}

// ===========================================================================
console.log("\n11. Choosing the account");
{
  const cache = { accounts: [
    { id: "ACT-chk", name: "Checking", org: "Cal Coast", currency: "USD", balance: 900 },
    { id: "ACT-sav", name: "Personal Savings", org: "Cal Coast", currency: "USD", balance: 640.12 },
    { id: "ACT-hol", name: "Holiday Club", org: "Cal Coast", currency: "USD", balance: 55, balance_date: D(-1) },
    { id: "ACT-eur", name: "Euro Account", org: "Wise", currency: "EUR", balance: 10 },
    { id: "ACT-amex", name: "Blue Cash", org: "American Express", currency: "USD", balance: -212.08 }
  ] };
  const files = (extra = []) => ({
    [F.accounts]: [CHK, Object.assign({}, CARD, { simplefin_id: "ACT-card" }), SAV].concat(extra),
    [F.savingsGoals]: [fund({ id: "other", name: "Car cushion" })],
    [F.simplefinAccounts]: cache
  });
  let app = makeApp(files());
  let plugin = makePlugin(app);
  plugin.hasSimpleFINConnection = () => true;
  let { choices, connected, unlinkedLocal } = await plugin.fundAccountChoices();
  check("connected", connected, true);
  check("synced savings, plus SimpleFIN accounts not added yet", choices.map((c) => c.value), ["local:Personal Savings", "sf:ACT-hol"]);
  check("checking, cards, non-dollar and below-zero feeds are left out", choices.some((c) => /Credit Union|Capital|eur|amex/.test(c.value)), false);
  check("an account another fund follows says so", [choices[0].takenBy, /used by Car cushion/.test(choices[0].label)], ["Car cushion", true]);
  check("a new SimpleFIN account says choosing it adds it", choices[1].label, "Cal Coast — Holiday Club · $55.00 — adds it to your accounts");
  check("nothing waiting to be linked", unlinkedLocal, []);

  // A savings account kept by CSV and not linked may be one of those feeds.
  app = makeApp(files([{ id: "Old Savings", type: "savings", institution: "Cal Coast Savings", current_balance: 20 }]));
  plugin = makePlugin(app);
  plugin.hasSimpleFINConnection = () => true;
  ({ choices, unlinkedLocal } = await plugin.fundAccountChoices());
  check("with an unlinked savings account here, SimpleFIN accounts aren't offered to add", choices.map((c) => c.value), ["local:Personal Savings"]);
  check("and it's named so the modal can say why", unlinkedLocal, ["Cal Coast Savings"]);

  plugin.hasSimpleFINConnection = () => false;
  ({ choices, unlinkedLocal } = await plugin.fundAccountChoices());
  check("without a connection only accounts already here", [choices.map((c) => c.value), unlinkedLocal], [["local:Personal Savings"], []]);

  ({ choices } = await plugin.fundAccountChoices(fund({ id: "other", account_id: "Old Savings" })));
  check("editing: its own account stays, even one that doesn't sync", choices.map((c) => [c.value, c.takenBy]), [["local:Personal Savings", null], ["local:Old Savings", null]]);
  check("labelled as such", /doesn't sync/.test(choices[1].label), true);
  ({ choices } = await plugin.fundAccountChoices(fund({ id: "other", account_id: "Deleted" })));
  check("editing a fund whose account is gone shows that", [choices[0].value, choices[0].missing], ["local:Deleted", true]);
}

// ===========================================================================
console.log("\n12. Saving, moving, deleting");
{
  const baseFiles = () => ({
    [F.accounts]: [CHK, SAV],
    [F.savingsGoals]: [{ id: "g1", name: "Moving", target_amount: 3000 }],
    [F.categories]: [{ name: "Savings", is_transfer: true }],
    [F.transactions]: [
      { id: "c1", date: D(-2), amount: -75, account_id: "Main Checking", resolved_category: "Savings", override_label: "Savings" },
      { id: "s1", date: D(-2), amount: 75, account_id: "Personal Savings", resolved_category: "Uncategorized" }
    ]
  });
  let app = makeApp(baseFiles());
  let plugin = makePlugin(app);
  global.__notices = [];
  const made = await plugin.saveCappedFund(null, { name: "Oopsie Fund", target_amount: 1000, choice: "local:Personal Savings", placement: "hero" });
  const goals = readFile(app, F.savingsGoals);
  check("created beside the goals", goals.map((g) => g.id), ["g1", made.id]);
  check("as a capped fund with no ledger of its own",
    [made.kind, made.name, made.target_amount, made.account_id, made.placement, "saved_amount" in made, "contributions" in made],
    ["capped", "Oopsie Fund", 1000, "Personal Savings", "hero", false, false]);
  check("transfers already imported are filed at once", readFile(app, F.transactions)[1].resolved_category, "Savings");
  check("and the notice says what happened",
    global.__notices[0], "Created Oopsie Fund, following Cal Coast — Personal Savings. 1 transfer with it was filed as a transfer.");
  check("the Overview recalculates", plugin._afterChange, 1);

  global.__notices = [];
  check("a second fund on the same account is refused",
    await plugin.saveCappedFund(null, { name: "Other", target_amount: 50, choice: "local:Personal Savings", placement: "cards" }), null);
  check("with a reason", global.__notices[0], "Oopsie Fund already follows that account. One account can back one fund.");
  check("nothing saved", readFile(app, F.savingsGoals).length, 2);

  const edited = await plugin.saveCappedFund(made, { name: "Bullshit Balance", target_amount: 1500, choice: "local:Personal Savings", placement: "goals" });
  const g2 = readFile(app, F.savingsGoals);
  check("editing keeps the id and changes the fields", [g2.length, g2[1].id, g2[1].name, g2[1].target_amount, g2[1].placement], [2, made.id, "Bullshit Balance", 1500, "goals"]);
  check("its own account isn't a clash", edited && edited.id, made.id);

  global.__notices = [];
  check("an unknown placement falls back to a card",
    (await plugin.saveCappedFund(g2[1], { name: "B", target_amount: 10, choice: "local:Personal Savings", placement: "nowhere" })).placement, "cards");
  check("no account chosen is refused", await plugin.saveCappedFund(null, { name: "X", target_amount: 1, choice: "" }), null);

  // Choosing a SimpleFIN account that isn't here yet.
  app = makeApp(Object.assign(baseFiles(), { [F.accounts]: [CHK, { id: "Personal Savings", type: "savings", current_balance: 5 }] }));
  plugin = makePlugin(app);
  const sfChoice = { value: "sf:ACT-sav", simplefin: { id: "ACT-sav", name: "Personal Savings", org: "Cal Coast", currency: "USD", balance: 640.12, balance_date: D(-1) } };
  global.__notices = [];
  const viaSf = await plugin.saveCappedFund(null, { name: "Oopsie Fund", target_amount: 1000, choice: "sf:ACT-sav", placement: "cards" }, [sfChoice]);
  const accs = readFile(app, F.accounts);
  const addedAcct = accs.find((a) => a.simplefin_id === "ACT-sav");
  check("the account is added, with a name that doesn't clash", addedAcct && addedAcct.id, "Personal Savings 2");
  check("as synced savings with its last reported balance",
    [addedAcct.type, addedAcct.institution, addedAcct.current_balance, addedAcct.balance_as_of, addedAcct.last_imported_through],
    ["savings", "Cal Coast — Personal Savings", 640.12, D(-1), null]);
  check("and the fund follows it", viaSf.account_id, "Personal Savings 2");
  check("the notice says it was added", /added to your accounts; its transactions come in with the next sync/.test(global.__notices[0]), true);

  // Linked meanwhile, somewhere else.
  app = makeApp(Object.assign(baseFiles(), { [F.accounts]: [CHK, SAV] }));
  plugin = makePlugin(app);
  const reuse = await plugin.saveCappedFund(null, { name: "O", target_amount: 1, choice: "sf:ACT-sav", placement: "cards" }, [sfChoice]);
  check("an account already linked to that feed is used, not added twice", [reuse.account_id, readFile(app, F.accounts).length], ["Personal Savings", 2]);

  app = makeApp(baseFiles());
  plugin = makePlugin(app);
  global.__notices = [];
  check("a SimpleFIN account no longer reported is refused", await plugin.saveCappedFund(null, { name: "O", target_amount: 1, choice: "sf:ACT-gone" }, []), null);
  check("and nothing is added", readFile(app, F.accounts).length, 2);

  // Moving.
  app = makeApp({ [F.savingsGoals]: [{ id: "g1", name: "Moving" }, fund()] });
  plugin = makePlugin(app);
  global.__notices = [];
  check("move to the hero", await plugin.moveCappedFund("fund-1", "hero"), true);
  check("stored", readFile(app, F.savingsGoals)[1].placement, "hero");
  check("said", global.__notices[0], "Oopsie Fund moved to the hero.");
  check("repainted, not recalculated", [plugin._refreshes, plugin._afterChange], [1, 0]);
  check("moving to where it already is does nothing", await plugin.moveCappedFund("fund-1", "hero"), false);
  check("nor to somewhere that doesn't exist", await plugin.moveCappedFund("fund-1", "footer"), false);
  check("nor an ordinary goal", await plugin.moveCappedFund("g1", "cards"), false);
  check("the goal got no placement", "placement" in readFile(app, F.savingsGoals)[0], false);

  await plugin.deleteCappedFund(fund());
  check("delete removes only the fund", readFile(app, F.savingsGoals).map((g) => g.id), ["g1"]);
}

// ===========================================================================
console.log("\n13. Balances carry their date");
{
  const app = makeApp({ [F.accounts]: [CHK, SAV, CARD] });
  const plugin = makePlugin(app);
  await plugin.applyBalancePatch({ "Main Checking": 1, "Personal Savings": 2 }, { asOf: { "Personal Savings": D(-2) } });
  let a = readFile(app, F.accounts);
  check("from the per-account map, today when the map has none", [a[0].balance_as_of, a[1].balance_as_of], [T, D(-2)]);
  check("an account not in the patch keeps what it had", a[2].balance_as_of, undefined);
  await plugin.applyBalancePatch({ "Personal Savings": 3 }, { asOf: D(-4) });
  check("from a single date", readFile(app, F.accounts)[1].balance_as_of, D(-4));
  await plugin.applyBalancePatch({ "Personal Savings": 4 });
  check("typed by hand: today", readFile(app, F.accounts)[1].balance_as_of, T);
}

// ===========================================================================
console.log("\n14. Other goal machinery leaves funds out");
{
  const app = makeApp({
    [F.savingsGoals]: [fund(), { id: "g1", name: "Moving", target_amount: 3000, target_date: D(60) }],
    [F.transactions]: []
  });
  const plugin = makePlugin(app);
  plugin.settings = { savingsDeadline: D(30), paySchedule: { cadence: "biweekly", anchor_date: D(-3) } };
  const map = await plugin.goalPaychecksMap(readFile(app, F.savingsGoals), T, []);
  check("no paycheck pacing for a fund, even under a global deadline", Object.keys(map), ["g1"]);

  let offered = null;
  const origOpen = H.BufferSweepModal.prototype.open;
  H.BufferSweepModal.prototype.open = function () { offered = this.plan(500); };
  plugin.upsertSweepRecord = async () => {};
  await plugin.openSweepModal({ periodStart: D(-14), periodEnd: T, remaining: 500, allocated: 600, spent: 100 });
  H.BufferSweepModal.prototype.open = origOpen;
  check("an unspent-allowance sweep only offers goals", offered.breakdown.map((b) => b.id), ["g1"]);
  check("earmarks ignore funds", H.earmarkedSavings([fund()]), 0);
}

// ===========================================================================
console.log("\n15. The modal");
{
  const open = (opts) => {
    SettingStub.texts = []; SettingStub.buttons = []; SettingStub.dropdowns = [];
    let submitted = null;
    const m = new H.CappedFundModal({}, opts, (d) => { submitted = d; });
    let closed = false;
    m.close = () => { closed = true; };
    m.open();
    const field = (n) => SettingStub.texts.find((t) => t.settingName === n);
    const dd = (n) => SettingStub.dropdowns.find((d) => d.settingName === n);
    return { m, field, dd, buttons: SettingStub.buttons.slice(), got: () => submitted, closed: () => closed };
  };
  const type = (t, v) => { t.inputEl.value = v; t.inputEl.dispatchEvent({ type: "input" }); };
  const press = (b, label) => b.find((x) => x.label === label).cb();
  const choices = [
    { value: "local:Personal Savings", label: "Cal Coast — Personal Savings · $640.12" },
    { value: "local:Taken", label: "Taken (used by Car cushion)", takenBy: "Car cushion" },
    { value: "local:Gone", label: "Gone (no longer in your accounts)", missing: true }
  ];

  let s = open({ choices, connected: true });
  check("a new fund is named for you", s.field("Name").inputEl.value, "Oopsie Fund");
  check("and shown as a card", s.dd("Show it").value, "cards");
  check("the account list starts unchosen", [s.dd("Account").value, s.dd("Account").options.map((o) => o.value)],
    ["", ["", "local:Personal Savings", "local:Taken", "local:Gone"]]);
  check("placements offered", s.dd("Show it").options.map((o) => o.label), ["In the hero", "As a card", "In Savings goals"]);

  global.__notices = [];
  type(s.field("Ceiling"), "1,000");
  press(s.buttons, "Create fund");
  check("no account: refused", [s.got(), global.__notices.pop()], [null, "Choose the account this fund follows."]);
  s.dd("Account").choose("local:Taken");
  press(s.buttons, "Create fund");
  check("an account in use: refused", global.__notices.pop(), "Car cushion already follows that account. One account can back one fund.");
  s.dd("Account").choose("local:Gone");
  press(s.buttons, "Create fund");
  check("an account that's gone: refused", global.__notices.pop(), "That account is gone. Choose another one.");
  s.dd("Account").choose("local:Personal Savings");
  type(s.field("Ceiling"), "0");
  press(s.buttons, "Create fund");
  check("a $0 ceiling: refused", global.__notices.pop(), "The ceiling has to be more than $0.");
  type(s.field("Name"), "   ");
  type(s.field("Ceiling"), "1,000");
  press(s.buttons, "Create fund");
  check("a blank name: refused", global.__notices.pop(), "Give the fund a name.");
  type(s.field("Name"), " Bullshit Balance ");
  s.dd("Show it").choose("hero");
  press(s.buttons, "Create fund");
  check("submits what was entered, tidied",
    s.got(), { name: "Bullshit Balance", target_amount: 1000, choice: "local:Personal Savings", placement: "hero" });
  check("and closes", s.closed(), true);

  s = open({ existing: fund({ placement: "goals", target_amount: 750 }), choices, connected: true });
  check("editing starts from the fund", [s.field("Name").inputEl.value, s.field("Ceiling").inputEl.value, s.dd("Account").value, s.dd("Show it").value],
    ["Oopsie Fund", "750", "local:Personal Savings", "goals"]);
  check("with its own title and button", s.buttons.map((b) => b.label), ["Save changes"]);

  let sent = 0;
  s = open({ choices: [], connected: false, openBankSync: () => sent++ });
  check("nothing to choose and no connection: says to connect", /connect SimpleFIN first/.test(text(s.m.contentEl)), true);
  press(s.buttons, "Set up bank sync");
  check("and the button goes there", [s.closed(), sent], [true, 1]);
  s = open({ choices: [], connected: true });
  check("connected but nothing reported: says to sync", /Sync once, then try again/.test(text(s.m.contentEl)), true);
  check("no bank-sync button then", s.buttons.map((b) => b.label), ["Create fund"]);
}

// ===========================================================================
console.log("\n16. On the Overview");
const RESULT = JSON.parse(fs.readFileSync(P.FIXTURES + "/fixture-result.json", "utf8"));
const CTX0 = JSON.parse(fs.readFileSync(P.FIXTURES + "/fixture-ctx.json", "utf8"));
function makeView(plugin = {}) {
  const v = Object.create(H.BudgetDashboardView.prototype);
  const calls = [];
  Object.assign(v, {
    sectionOpen: {}, scrollMemory: {}, activeTab: "overview", app: {}, pieRange: "all",
    activePieTab: "spending", expandedSpendCategory: null, expandedIncomeCategory: null,
    lastResult: null,
    plugin: Object.assign({
      settings: { savingsMode: false, bufferMode: "manual", manualBuffer: 350 },
      expiredPeriod: null, lastResult: null, syncing: false,
      promptEnterPaycheck() {}, promptQuickBalance() {}, hasSimpleFINConnection() { return false; },
      recalculate: async () => {}, refreshAfterDataChange: async () => {},
      fixedPaymentCandidates: async () => [], pendingSweep: async () => null, openSweepModal: async () => {},
      moveCappedFund: async (id, p) => calls.push(["move", id, p]),
      promptCappedFund: (f) => calls.push(["edit", f ? f.id : null]),
      deleteCappedFund: async (f) => calls.push(["delete", f.id])
    }, plugin)
  });
  v.render = () => calls.push(["render"]);
  return { v, calls };
}
async function overview({ placement = "cards", balance = 640.12, asOf = T, breakdown = null, savingsMode = false, extraGoals = null, accounts = null, funds = null, avail = null } = {}) {
  const ctx = JSON.parse(JSON.stringify(CTX0));
  ctx.accounts = accounts || [CHK, Object.assign({}, SAV, { current_balance: balance, balance_as_of: asOf })];
  ctx.savingsGoals = (extraGoals || ctx.savingsGoals).concat(funds || [fund({ placement })]);
  const r = Object.assign({}, RESULT, { savingsMode });
  if (avail != null) r.availableForDebt = avail;
  r.savingsBreakdown = breakdown || [];
  r.recommendedSavings = Math.round(r.savingsBreakdown.reduce((s, b) => s + b.amount, 0) * 100) / 100;
  const { v, calls } = makeView();
  v.lastResult = r;
  const root = el("div");
  await v.renderOverview(root, ctx);
  await tick(20);
  return { v, calls, root, ctx };
}
{
  const ask = [{ id: "fund-1", target: "Oopsie Fund", amount: 54.5, reason: "64% full, so it takes 36% of what's left — eases off near its $1000.00 cap", fund: true }];
  let { root, v, calls } = await overview({ placement: "cards", breakdown: ask });
  const grid = byCls(root, "budget-grid")[0];
  const cards = grid.children.map((c) => [...c.classes].includes("budget-fund-card") ? "fund" : [...c.classes].includes("budget-fund-drop") ? "slot" : [...c.classes].includes("budget-card-wide") ? "recs" : "card");
  check("as a card: between the cards and the recommendations", cards, ["card", "card", "fund", "slot", "recs"]);
  const card = byCls(root, "budget-fund-card")[0];
  check("its figure", text(byCls(card, "budget-fund-figure")[0]), "$640.12 of $1000.00 cap");
  check("its bar", byCls(card, "budget-fund-fill")[0].style.width, "64.0%");
  check("where it stands and where from", text(byCls(card, "budget-fund-meta")[0]), "$359.88 below the cap · Cal Coast — Personal Savings · as of " + H.formatChartDate(T).replace(`, ${T.slice(0, 4)}`, ""));
  check("what to do this period, and why", text(byCls(card, "budget-fund-ask-row")[0]), "Move $54.50 in this period — 64% full, so it takes 36% of what's left — eases off near its $1000.00 cap");
  check("Move, Edit, Delete — no Add Funds, no pin", buttonsIn(card).map((b) => b._text), ["Move", "Edit", "Delete"]);
  check("the bar says what it measures", [byCls(card, "budget-fund-track")[0].attrs.role, byCls(card, "budget-fund-track")[0].attrs["aria-valuenow"]], ["progressbar", "640.12"]);
  check("not in the hero", byCls(byCls(root, "budget-hero")[0], "budget-fund-hero").length, 0);
  check("and the figures row keeps its normal size", byCls(root, "budget-hero-figures-tall").length, 0);
  check("not in the goals list", byCls(byCls(root, "budget-goals-card")[0], "budget-fund-row").length, 0);
  check("the hero's basis names it", /− \$54\.50 to Oopsie Fund/.test(text(byCls(root, "budget-hero-basis")[0])), true);
  check("and doesn't call it goals", /to goals/.test(text(byCls(root, "budget-hero-basis")[0])), false);
  const recs = byCls(root, "budget-card-wide").find((c) => byCls(c, "budget-split").length);
  check("Debt Reduction lists it under savings", /Oopsie Fund \$54\.50/.test(text(recs)), true);
  check("and says why it's there", /Capped funds refill before extra principal/.test(text(recs)), true);

  button(card, "Edit").onclick();
  button(card, "Delete").onclick();
  check("Edit opens the fund", calls[0], ["edit", "fund-1"]);

  // Move menu.
  global.__menus = [];
  button(card, "Move").onclick({ clientX: 10, clientY: 10 });
  const menu = global.__menus[0];
  check("Move offers the three places", menu.items.map((i) => [i.title, i.checked]), [["In the hero", false], ["As a card", true], ["In Savings goals", false]]);
  check("the button says it opens a menu", button(card, "Move").attrs["aria-haspopup"], "menu");
  menu.items[0].cb();
  menu.items[1].cb();
  check("choosing a place moves it; choosing where it is does nothing", calls.filter((c) => c[0] === "move"), [["move", "fund-1", "hero"]]);

  ({ root, calls } = await overview({ placement: "hero", breakdown: ask }));
  const hero = byCls(root, "budget-fund-hero")[0];
  check("in the hero: a figure among the figures", hero.parent.classes.has("budget-hero-figures"), true);
  check("with a fund in the hero the figures row is marked to scale up", hero.parent.classes.has("budget-hero-figures-tall"), true);
  check("label, number, bar, cap, ask",
    [text(byCls(hero, "budget-fund-label")[0]).replace("⠿", "").trim(), text(byCls(hero, "budget-fund-number")[0]), byCls(hero, "budget-fund-hero-track").length,
      byCls(hero, "budget-hero-sub").map(text)],
    ["Oopsie Fund", "$640.12", 1, ["$359.88 below its $1000.00 cap", "Move $54.50 in this period"]]);
  check("compact controls", buttonsIn(hero).map((b) => [b._text, [...b.classes].join(" ")]), [["Move", "budget-basis-btn"], ["Edit", "budget-basis-btn"]]);
  check("its account on hover", hero.attrs.title.startsWith("Cal Coast — Personal Savings"), true);
  check("not a card", byCls(root, "budget-fund-card").length, 0);

  ({ root } = await overview({ placement: "goals", breakdown: ask, extraGoals: [{ id: "g1", name: "Moving fund", target_amount: 3000, saved_amount: 250, contributions: [{ id: "c1", amount: 250, date: D(-5), linked_tx_id: null }] }] }));
  const goalsCard = byCls(root, "budget-goals-card")[0];
  const rows = byCls(goalsCard, "budget-goal-row");
  check("in Savings goals: a row after the goals", rows.map((r) => r.classes.has("budget-fund-row")), [false, true]);
  const frow = rows[1];
  check("with its badge and figures", [text(byCls(frow, "budget-goal-name")[0]).replace("⠿", "").trim(), text(byCls(frow, "budget-goal-top")[0].children[1])],
    ["Oopsie Fund capped fund", "$640.12 / $1000.00"]);
  check("where it stands, then what to do, a line each", byCls(frow, "budget-goal-meta").map(text),
    ["$359.88 below the cap · Cal Coast — Personal Savings · as of " + H.formatChartDate(T).replace(`, ${T.slice(0, 4)}`, ""), "Move $54.50 in this period"]);
  const order = goalsCard.children.map((c) => c.classes.has("budget-fund-row") ? "fund" : c.classes.has("budget-apply-scope") ? "note" : c.classes.has("budget-goal-row") ? "goal" : null).filter(Boolean);
  check("after the goals' held-back note, which isn't about it", order, ["goal", "note", "fund"]);
  check("Move, Edit, Delete", buttonsIn(frow).map((b) => b._text), ["Move", "Edit", "Delete"]);
  check("the goals head offers both kinds", buttonsIn(byCls(goalsCard, "budget-goals-head-btns")[0]).map((b) => b._text), ["New goal", "New capped fund"]);

  // States.
  const heroCap = async (o) => byCls(byCls((await overview(Object.assign({ placement: "hero" }, o))).root, "budget-fund-hero")[0], "budget-hero-sub")[0];
  check("hero line at the cap", text(await heroCap({ balance: 1000 })), "At its $1000.00 cap");
  check("hero line over the cap", text(await heroCap({ balance: 1250 })), "$250.00 over its $1000.00 cap");
  const gone = await heroCap({ accounts: [CHK] });
  check("hero line with its account gone", [text(gone), gone.classes.has("budget-negative")], ["$1000.00 cap · its account is gone — edit the fund to choose another", true]);
  let f = (await overview({ balance: 1000 })).root;
  check("at the cap", [text(byCls(f, "budget-fund-meta")[0]).startsWith("At its cap"), byCls(f, "budget-fund-fill")[0].classes.has("budget-progress-done")], [true, true]);
  f = (await overview({ balance: 1250 })).root;
  check("over the cap", text(byCls(f, "budget-fund-meta")[0]).startsWith("$250.00 over the cap"), true);
  f = (await overview({ asOf: D(-9) })).root;
  const staleSpan = byCls(f, "budget-fund-stale")[0];
  check("a stale balance says so", staleSpan && /sync to refresh$/.test(text(staleSpan)), true);
  f = (await overview({ asOf: D(-3) })).root;
  check("three days old isn't stale yet", byCls(f, "budget-fund-stale").length, 0);
  f = (await overview({ accounts: [CHK] })).root;
  check("account gone", [text(byCls(f, "budget-fund-figure")[0]), text(byCls(f, "budget-fund-meta")[0])], ["— of $1000.00 cap", "Its account is gone — edit the fund to choose another"]);
  f = (await overview({ balance: null })).root;
  check("no balance yet", text(byCls(f, "budget-fund-meta")[0]).startsWith("No balance yet"), true);
  f = (await overview({})).root;
  check("no ask in a short period: says there's no surplus", text(byCls(byCls(f, "budget-fund-card")[0], "budget-goal-meta")[1]), "No surplus this period, so nothing to move in");
  f = (await overview({ avail: 200 })).root;
  check("no ask with surplus: says it went elsewhere", text(byCls(byCls(f, "budget-fund-card")[0], "budget-goal-meta")[1]), "Nothing left over for it this period");
  f = (await overview({ balance: 980, avail: 20 })).root;
  check("nearly full: says it's close", /Close to its cap/.test(text(byCls(f, "budget-fund-card")[0])), true);

  // Savings Focus wording.
  f = (await overview({ savingsMode: true, breakdown: [{ id: "g1", target: "Moving fund", amount: 100, reason: "on pace", fund: false }].concat(ask) })).root;
  const sRecs = byCls(f, "budget-card-wide").find((c) => byCls(c, "budget-split").length);
  check("Savings Focus total names both", /\$154\.50 allocated to goals and capped funds\./.test(text(sRecs)), true);
  check("the basis splits them", /− \$100\.00 to goals − \$54\.50 to Oopsie Fund/.test(text(byCls(f, "budget-hero-basis")[0])), true);
  f = (await overview({ savingsMode: true, breakdown: [{ id: "g1", target: "Moving fund", amount: 100, reason: "on pace" }], funds: [] })).root;
  check("without funds the total reads as before", /\$100\.00 allocated to goals\./.test(text(byCls(f, "budget-card-wide").find((c) => byCls(c, "budget-split").length))), true);
}

// ===========================================================================
console.log("\n17. Dragging it somewhere else");
{
  const { root, v, calls } = await overview({ placement: "cards" });
  const slots = byCls(root, "budget-fund-drop");
  check("a hidden drop target in each of the three places", slots.map((s) => [...s.classes].find((c) => /drop-(hero|cards|goals)$/.test(c))), ["budget-fund-drop-hero", "budget-fund-drop-cards", "budget-fund-drop-goals"]);
  const grip = byCls(byCls(root, "budget-fund-card")[0], "budget-fund-grip")[0];
  check("a grip on the fund, out of the tab order", [grip.attrs.draggable, grip.attrs["aria-hidden"]], ["true", "true"]);

  const dt = { data: {}, setData(k, val) { this.data[k] = val; }, setDragImage(n) { this.image = n; } };
  grip.dispatchEvent({ type: "dragstart", dataTransfer: dt });
  check("not marked during dragstart itself (Chromium drops a drag whose source moves)", root.classes.has("budget-fund-dragging"), false);
  await tick();
  check("dragging marks the Overview", [root.classes.has("budget-fund-dragging"), root.classes.has("budget-fund-from-cards")], [true, true]);
  check("carries the fund under a private type", dt.data, { "application/x-budget-fund": "fund-1" });
  check("and drags the whole card", dt.image.classes.has("budget-fund-card"), true);

  const heroSlot = slots[0];
  let prevented = 0;
  const evt = (type) => ({ type, dataTransfer: {}, preventDefault() { prevented++; } });
  heroSlot.dispatchEvent(evt("dragover"));
  check("the hero accepts it", [prevented, heroSlot.classes.has("budget-fund-drop-over")], [1, true]);
  heroSlot.dispatchEvent(evt("dragleave"));
  check("and lets go of the highlight", heroSlot.classes.has("budget-fund-drop-over"), false);
  heroSlot.dispatchEvent(evt("drop"));
  await tick();
  check("dropping there moves it", calls.filter((c) => c[0] === "move"), [["move", "fund-1", "hero"]]);
  check("and the Overview is unmarked", [root.classes.has("budget-fund-dragging"), root.classes.has("budget-fund-from-cards")], [false, false]);

  prevented = 0;
  slots[2].dispatchEvent(evt("dragover"));
  slots[2].dispatchEvent(evt("drop"));
  check("a drop with no fund being dragged is ignored", [prevented, calls.filter((c) => c[0] === "move").length], [0, 1]);

  grip.dispatchEvent({ type: "dragstart", dataTransfer: dt });
  await tick();
  grip.dispatchEvent({ type: "dragend" });
  check("a drag abandoned anywhere unmarks the Overview", [root.classes.has("budget-fund-dragging"), v.fundDrag], [false, null]);

  grip.dispatchEvent({ type: "dragstart", dataTransfer: dt });
  grip.dispatchEvent({ type: "dragend" });
  await tick();
  check("a drag that ends before the mark lands leaves nothing marked", root.classes.has("budget-fund-dragging"), false);

  const none = await overview({ funds: [] });
  check("no fund, no drop targets", byCls(none.root, "budget-fund-drop").length, 0);

  global.document.body.classList.contains = (c) => c === "is-mobile";
  const mobile = await overview({ placement: "cards" });
  global.document.body.classList.contains = () => false;
  check("on a phone: no grip and no targets — Move does it", [byCls(mobile.root, "budget-fund-grip").length, byCls(mobile.root, "budget-fund-drop").length, !!button(byCls(mobile.root, "budget-fund-card")[0], "Move")], [0, 0, true]);
}

// ===========================================================================
console.log("\n18. The pinned-goal card ignores funds");
{
  const { v } = makeView({ settings: { savingsMode: true } });
  const root = el("div");
  await v.renderPinnedGoal(root, { savingsGoals: [fund({ pinned: true })], accounts: ACCOUNTS }, { deadline: null });
  check("only funds: offers to create a goal", /No savings goals yet/.test(text(root)), true);
}

// ===========================================================================
console.log("\n19. Settings");
{
  const DATA = {
    [F.savingsGoals]: [{ id: "g1", name: "Moving", target_amount: 3000, saved_amount: 250, contributions: [] }, fund({ placement: "hero" })],
    [F.accounts]: [CHK, SAV],
    [F.transactions]: [], [F.revolvingDebts]: []
  };
  const app = makeApp(DATA);
  const tab = Object.create(H.BudgetSettingTab.prototype);
  tab.app = app;
  const calls = [];
  tab.plugin = { app, settings: {}, promptCappedFund: (f, done) => calls.push(["fund", f ? f.id : null, typeof done]), deleteCappedFund: async (f) => calls.push(["delete", f.id]), refreshAfterDataChange: async () => {} };
  tab.display = () => calls.push(["display"]);
  tab.sectionOpen = {};
  tab.section = (c) => c;
  tab.countLabel = () => "";
  SettingStub.buttons = [];
  const c = el("div");
  await tab.renderGoalSettings(c);
  check("New capped fund beside New goal", SettingStub.buttons.map((b) => b.label), ["New goal", "New capped fund"]);
  SettingStub.buttons[1].cb();
  check("and it opens the fund modal", calls[0], ["fund", null, "function"]);
  const rows = byCls(c, "budget-cat-row");
  check("the fund is listed with the goals", rows.length, 2);
  check("saying what it follows and where it shows", text(rows[1]).replace(/ Edit Delete$/, ""),
    "Oopsie Fund capped fund $640.12 of a $1000.00 ceiling · follows Cal Coast — Personal Savings · shown in the hero");
  button(rows[1], "Edit").onclick();
  check("Edit opens it", calls[1], ["fund", "fund-1", "function"]);

  let confirm = null;
  const origOpen = H.ConfirmModal.prototype.open;
  H.ConfirmModal.prototype.open = function () { confirm = this.opts; };
  button(rows[1], "Delete").onclick();
  check("Delete says the account is untouched", confirm.body.filter(Boolean), [
    "It stops showing on the Overview and stops asking for surplus.",
    "Cal Coast — Personal Savings stays in your accounts and keeps syncing, and its balance and transactions aren't touched."
  ]);
  await confirm.onConfirm();
  check("and deletes it", calls.slice(-2), [["delete", "fund-1"], ["display"]]);

  // Deleting the account a fund follows warns about it.
  const tab2 = Object.create(H.BudgetSettingTab.prototype);
  tab2.app = app;
  tab2.plugin = { app, promptAddAccount() {}, refreshAfterDataChange: async () => {} };
  tab2.section = (c) => c;
  tab2.countLabel = () => "";
  tab2.display = () => {};
  const c2 = el("div");
  await tab2.renderAccountSettings(c2);
  const savRow = byCls(c2, "budget-cat-row")[1];
  await button(savRow, "Delete").onclick();
  check("deleting its account names the fund", confirm.body.filter(Boolean).pop(),
    "Oopsie Fund follows this account's balance and will show it as missing until pointed at another account.");
  H.ConfirmModal.prototype.open = origOpen;
}

// ===========================================================================
console.log("\n20. The ask holds still once it's followed");
{
  const chkLeg = (id, amt, partner, date = T) => ({ id, date, amount: -amt, account_id: "Main Checking", merchant_raw: "To Savings 00", resolved_category: "Savings", override_label: "Savings", transfer_pair: partner });
  const sLeg = (id, amt, partner, date = T) => ({ id, date, amount: amt, account_id: "Personal Savings", merchant_raw: "Deposit", resolved_category: "Savings", override_label: "Savings", transfer_pair: partner });

  let sh = H.fundShare(fund(), 400, acct(900), { moved: 400 });
  check("having moved all it asked, it asks for nothing more", [sh.amount, sh.periodShare, sh.moved], [0, 400, 400]);
  sh = H.fundShare(fund(), 650, acct(650), { moved: 150 });
  check("having moved part, it asks for the rest", [sh.amount, sh.periodShare], [250, 400]);
  sh = H.fundShare(fund(), 200, acct(1100), { moved: 600 });
  check("moving more than asked: nothing, not a negative", sh.amount, 0);
  check("the reason says what's been moved",
    H.fundReason(H.fundShare(fund(), 650, acct(650), { moved: 150 })),
    "50% full when the period began, so it takes 50% of what's left — eases off near its $1000.00 cap ($150.00 of $400.00 already moved in this period)");
  check("an overdrawn fund isn't said to be topped up", H.fundReason(H.fundShare(fund(), 5000, acct(-20))), "empty, so it takes all of what's left toward its $1000.00 cap");

  const accounts = [CHK, Object.assign({}, SAV), { id: "Other Savings", type: "savings", current_balance: 5 }];
  const txs = [
    chkLeg("c1", 150, "s1", D(-2)), sLeg("s1", 150, "c1", D(-2)),
    chkLeg("c2", 100, "s2", D(-40)), sLeg("s2", 100, "c2", D(-40)),
    { id: "o1", date: D(-1), amount: -30, account_id: "Other Savings", transfer_pair: "s3" }, { id: "s3", date: D(-1), amount: 30, account_id: "Personal Savings", transfer_pair: "o1" },
    { id: "s4", date: D(-1), amount: 999, account_id: "Personal Savings" },
    { id: "s5", date: D(-1), amount: -50, account_id: "Personal Savings", transfer_pair: "c5" }, { id: "c5", date: D(-1), amount: 50, account_id: "Main Checking", transfer_pair: "s5" }
  ];
  check("moves this period: paired with checking, in the period, net of withdrawals",
    H.fundMovesThisPeriod(txs, [fund()], accounts, D(-5), D(9)), { "fund-1": 100 });

  // The audit's scenario: $1000 checking, fund $500 of $1000, $800 surplus.
  const base = {
    todayStr: D(-3), nextPaydayStr: D(11), fixedExpenses: [], installmentDebts: [],
    revolvingDebts: [{ account_id: "Capital One Card", apr: 29.99, balance_anchor: { amount: 5000, date: D(-30) }, applied_payments: [], min_payment_due: 40, due_date: D(40) }],
    bufferMode: "manual", manualBuffer: 300, currentDateStr: T, goals: [fund()],
    categoryMeta: [{ name: "Savings", is_transfer: true }]
  };
  const run = (cash, bal, extraTx = []) => H.runAllocation(Object.assign({}, base, { cashOnHand: cash, accounts: [CHK, Object.assign({}, SAV, { current_balance: bal })], transactions: extraTx }));
  let r = run(1100, 500);
  check("first, it asks for its share", r.savingsBreakdown.map((b) => b.amount), [400]);
  r = run(700, 900, [chkLeg("c", 400, "s"), sLeg("s", 400, "c")]);
  check("after moving it, nothing more this period", [r.savingsBreakdown, r.fundPeriods["fund-1"]], [[], { moved: 400, share: 400 }]);
  check("and the rest still goes to the card", r.payoffBreakdown.map((p) => p.amount), [400]);
  r = run(950, 650, [chkLeg("c", 150, "s"), sLeg("s", 150, "c")]);
  check("after moving part, the rest of the same ask", r.savingsBreakdown.map((b) => b.amount), [250]);
  r = H.runAllocation(Object.assign({}, base, { savingsMode: true, cashOnHand: 700, accounts: [CHK, Object.assign({}, SAV, { current_balance: 900 })], transactions: [chkLeg("c", 400, "s"), sLeg("s", 400, "c")] }));
  check("the same in Savings Focus", [r.savingsBreakdown, r.fundPeriods["fund-1"]], [[], { moved: 400, share: 400 }]);
}

// ===========================================================================
console.log("\n21. A balance too old to trust asks for nothing");
{
  const at = (asOf) => H.allocateToFunds([fund()], 300, acct(640.12, { balance_as_of: asOf }), { todayStr: T }).breakdown.length;
  check("today", at(T), 1);
  check("fourteen days old", at(D(-14)), 1);
  check("fifteen days old", at(D(-15)), 0);
  check("no date at all", at(undefined), 0);

  const { root } = await overview({ asOf: D(-20), avail: 300 });
  const card = byCls(root, "budget-fund-card")[0];
  check("the Overview says why", /Its balance is too old to go by — sync before moving anything in/.test(text(card)), true);
  const noDate = await overview({ asOf: null, avail: 300 });
  check("an undated balance is shown as needing a sync", /sync to refresh/.test(text(byCls(noDate.root, "budget-fund-card")[0])), true);
  const done = await overview({ avail: 300 });
  done.v.lastResult.fundPeriods = { "fund-1": { moved: 400, share: 400 } };
  const root2 = el("div");
  await done.v.renderOverview(root2, done.ctx);
  check("after following the ask: done for this period", /Done for this period — \$400\.00 moved in/.test(text(byCls(root2, "budget-fund-card")[0])), true);
}

// ===========================================================================
console.log("\n22. Spending out of the fund isn't this period's spending");
{
  const base = {
    cashOnHand: 1000, todayStr: D(-3), nextPaydayStr: D(11), fixedExpenses: [], installmentDebts: [], revolvingDebts: [],
    bufferMode: "manual", manualBuffer: 600, currentDateStr: T, categoryMeta: [{ name: "Pet Bills", is_transfer: false }],
    transactions: [
      { id: "vet", date: D(-1), amount: -400, account_id: "Personal Savings", merchant_raw: "VCA ANIMAL HOSPITAL", resolved_category: "Pet Bills" },
      { id: "cafe", date: D(-1), amount: -20, account_id: "Main Checking", merchant_raw: "CAFE", resolved_category: "Eating Out" }
    ]
  };
  const withFund = H.runAllocation(Object.assign({}, base, { goals: [fund()], accounts: ACCOUNTS }));
  check("a vet bill paid from the fund doesn't draw down the allowance", [withFund.bufferSpent, withFund.bufferRemaining], [20, 580]);
  const without = H.runAllocation(Object.assign({}, base, { goals: [], accounts: ACCOUNTS }));
  check("without a fund, that account's spending counts as before", without.bufferSpent, 420);
  check("the helper leaves everything alone when there's no fund", H.withoutFundAccountRows(base.transactions, []).length, 2);
  const refund = Object.assign({}, base, { goals: [fund()], accounts: ACCOUNTS, transactions: [
    { id: "vet", date: D(-2), amount: -80, account_id: "Main Checking", merchant_raw: "VCA", resolved_category: "Pet Bills" },
    { id: "back", date: D(-1), amount: 80, account_id: "Personal Savings", merchant_raw: "VCA REFUND", resolved_category: "Pet Bills" }
  ] });
  check("a refund paid into the fund doesn't hand back checking's allowance", H.runAllocation(refund).bufferSpent, 80);
}

// ===========================================================================
console.log("\n23. Pair links survive merges and id repairs");
{
  const txs = [
    { id: "hold", date: null, pending: true, amount: -150, account_id: "Main Checking", merchant_raw: "To Savings 00", override_label: "Savings", transfer_pair: "s" },
    { id: "posted", date: D(-1), amount: -150, account_id: "Main Checking", merchant_raw: "To Savings 00" },
    { id: "s", date: D(-1), amount: 150, account_id: "Personal Savings", override_label: "Savings", transfer_pair: "hold" }
  ];
  const r = H.mergeSettledHolds(txs, {});
  const by = Object.fromEntries(r.transactions.map((t) => [t.id, t]));
  check("the hold merges into the posted row", [r.merged, !!by.hold], [1, false]);
  check("which takes over the pairing", [by.posted.transfer_pair, by.posted.override_label], ["s", "Savings"]);
  check("and the fund's half follows it", by.s.transfer_pair, "posted");
  check("the input rows aren't mutated", txs[2].transfer_pair, "hold");

  const app = makeApp({ [F.transactions]: [
    { id: "dup", date: T, amount: -9, account_id: "Main Checking" },
    { id: "dup", date: T, amount: -60, account_id: "Main Checking", transfer_pair: "s" },
    { id: "s", date: T, amount: 60, account_id: "Personal Savings", transfer_pair: "dup" }
  ] });
  await H.dedupeTransactionIds(app);
  const after = readFile(app, F.transactions);
  check("a repaired id takes its partner with it", [after[1].id !== "dup", after[2].transfer_pair === after[1].id], [true, true]);
}

// ===========================================================================
console.log("\n24. A fund's transfer isn't offered to a goal");
{
  const txs = [
    { id: "c1", date: T, amount: -250, account_id: "Main Checking", merchant_raw: "To Savings 00", resolved_category: "Savings", transfer_pair: "s1" },
    { id: "c2", date: T, amount: -250, account_id: "Main Checking", merchant_raw: "ONLINE TRANSFER", resolved_category: "Savings" },
    { id: "s1", date: T, amount: 250, account_id: "Personal Savings", resolved_category: "Savings", transfer_pair: "c1" }
  ];
  const goal = { id: "g1", name: "Moving", target_amount: 3000, contributions: [{ id: "k", amount: 250, date: T, linked_tx_id: null }] };
  const got = H.contributionCandidates(goal.contributions[0], txs, [goal], null, { categoryMeta: [{ name: "Savings", is_transfer: true }] });
  check("only the unpaired transfer is a candidate", got.map((t) => t.id), ["c2"]);
  // Audit case A2's other half: a withdrawal from the fund offered as a card payment.
  const card = { account_id: "Capital One Card", apr: 29.99, payment_category: "Credit Card Payment", balance_anchor: { amount: 500, date: D(-30) }, applied_payments: [] };
  const pay = [
    { id: "cc-pay", date: T, amount: -300, account_id: "Main Checking", resolved_category: "Credit Card Payment" },
    { id: "wd-out", date: T, amount: -300, account_id: "Personal Savings", resolved_category: "Savings", transfer_pair: "wd-in" },
    { id: "wd-in", date: T, amount: 300, account_id: "Main Checking", resolved_category: "Savings", transfer_pair: "wd-out" }
  ];
  check("nor to a card as its payment", H.candidatePayments(card, pay, [card], [{ name: "Savings", is_transfer: true }]).map((t) => t.id), ["cc-pay"]);
  const dangling = [{ id: "c9", date: T, amount: -250, account_id: "Main Checking", resolved_category: "Savings", transfer_pair: "gone" }];
  check("a half whose partner is gone is offered again", H.contributionCandidates(goal.contributions[0], dangling, [goal], null, { categoryMeta: [{ name: "Savings", is_transfer: true }] }).map((t) => t.id), ["c9"]);
}

// ===========================================================================
console.log("\n25. New accounts, and saving safely");
{
  let app = makeApp({ [F.accounts]: [] });
  let plugin = makePlugin(app);
  let pending = null;
  H.AddAccountModal.prototype.open = function () { pending = this.onSubmit({ id: "Linked", type: "savings", current_balance: 0, simplefin_id: "ACT-x" }); };
  await plugin.promptAddAccount();
  await pending;
  H.AddAccountModal.prototype.open = function () { pending = this.onSubmit({ id: "Jar", type: "savings", current_balance: 40 }); };
  await plugin.promptAddAccount();
  await pending;
  const accs = readFile(app, F.accounts);
  check("a synced account's blank balance isn't dated (the first sync dates it)", "balance_as_of" in accs[0], false);
  check("a typed balance is dated today", accs[1].balance_as_of, T);

  // Id collisions: a fund still pointing at a deleted account, and old rows.
  app = makeApp({
    [F.accounts]: [CHK],
    [F.savingsGoals]: [fund({ id: "old", name: "Old Cushion", account_id: "Personal Savings" })],
    [F.transactions]: [{ id: "x", date: D(-90), amount: -5, account_id: "Personal Savings 2" }],
    [F.categories]: []
  });
  plugin = makePlugin(app);
  const sfChoice = { value: "sf:ACT-sav", simplefin: { id: "ACT-sav", name: "Personal Savings", org: "Cal Coast", currency: "USD", balance: 640.12 } };
  const made = await plugin.saveCappedFund(null, { name: "New", target_amount: 500, choice: "sf:ACT-sav", placement: "cards" }, [sfChoice]);
  check("the new account takes an id nothing else still uses", made && made.account_id, "Personal Savings 3");
  check("the old fund isn't re-attached to it", readFile(app, F.savingsGoals).find((g) => g.id === "old").account_id, "Personal Savings");
  check("no SimpleFIN date, no balance date", "balance_as_of" in readFile(app, F.accounts).find((a) => a.id === "Personal Savings 3"), false);

  // A refused save leaves nothing behind.
  app = makeApp({ [F.accounts]: [CHK, SAV], [F.savingsGoals]: [fund()], [F.categories]: [] });
  plugin = makePlugin(app);
  global.__notices = [];
  check("a clash is refused", await plugin.saveCappedFund(null, { name: "B", target_amount: 5, choice: "local:Personal Savings" }), null);
  check("with nothing written", [readFile(app, F.accounts).length, readFile(app, F.savingsGoals).length], [2, 1]);

  // While a sync is writing the ledger, the save doesn't race it.
  app = makeApp({
    [F.accounts]: [CHK, SAV], [F.savingsGoals]: [], [F.categories]: [{ name: "Savings", is_transfer: true }],
    [F.transactions]: [
      { id: "c1", date: T, amount: -75, account_id: "Main Checking", merchant_raw: "To Savings 00", resolved_category: "Savings", override_label: "Savings" },
      { id: "s1", date: T, amount: 75, account_id: "Personal Savings", resolved_category: "Uncategorized" }
    ]
  });
  plugin = makePlugin(app);
  plugin.syncing = true;
  const before = app._store[F.transactions];
  await plugin.saveCappedFund(null, { name: "Oopsie Fund", target_amount: 1000, choice: "local:Personal Savings", placement: "cards" });
  check("during a sync the ledger is left to the sync", app._store[F.transactions], before);
  check("but the fund is saved", readFile(app, F.savingsGoals).length, 1);
}

// ===========================================================================
console.log("\n26. The modal explains a savings account waiting to be linked");
{
  SettingStub.texts = []; SettingStub.buttons = []; SettingStub.dropdowns = [];
  const m = new H.CappedFundModal({}, { choices: [{ value: "local:Personal Savings", label: "Personal Savings" }], connected: true, unlinkedLocal: ["Cal Coast Savings"] }, () => {});
  m.open();
  check("says why SimpleFIN accounts aren't offered, and how to fix it",
    /Cal Coast Savings is in your accounts but not linked to SimpleFIN, so SimpleFIN accounts aren't offered here .* Link it under Settings → Accounts/.test(text(m.contentEl)), true);
  SettingStub.texts = []; SettingStub.buttons = []; SettingStub.dropdowns = [];
  const m2 = new H.CappedFundModal({}, { choices: [], connected: true, unlinkedLocal: ["A", "B"] }, () => {});
  m2.open();
  check("with nothing to choose, it's the whole description", /A, B are in your accounts but not linked/.test(text(m2.contentEl)), true);
}

// ===========================================================================
console.log("\n27. Second audit: several funds, telling descriptions, undoing a pair");
{
  // Several funds: a move into one doesn't change the others' asks.
  const two = [fund({ id: "o", name: "Oopsie", account_id: "A" }), fund({ id: "c", name: "Car", account_id: "B" })];
  const accs = (a, b) => [Object.assign({}, SAV, { id: "A", current_balance: a }), Object.assign({}, SAV, { id: "B", current_balance: b })];
  let r = H.allocateToFunds(two, 1000, accs(500, 500), { todayStr: T });
  check("two half-full funds, $1000 surplus: 500 then 250", r.breakdown.map((b) => [b.id, b.amount]), [["o", 500], ["c", 250]]);
  r = H.allocateToFunds(two, 750, accs(500, 750), { todayStr: T, moves: { c: 250 } });
  check("after Car's $250 goes in, Oopsie still asks 500 and Car nothing", [r.breakdown.map((b) => [b.id, b.amount]), r.periods.c], [[["o", 500]], { moved: 250, share: 250 }]);
  r = H.allocateToFunds(two, 250, accs(1000, 750), { todayStr: T, moves: { o: 500, c: 250 } });
  check("after both, nothing more", r.breakdown, []);

  // Descriptions that only look like transfers.
  const t = (o) => Object.assign({ resolved_category: "Uncategorized", override_label: null }, o);
  const cats = [{ name: "Savings", is_transfer: true }];
  const pairWith = (desc, fundDesc = "Deposit") => H.pairFundTransfers([
    t({ id: "c", date: T, amount: -100, account_id: "Main Checking", merchant_raw: desc }),
    t({ id: "s", date: D(1), amount: 100, account_id: "Personal Savings", merchant_raw: fundDesc })
  ], [fund()], cats, { accounts: ACCOUNTS }).length;
  ["SHARE DRAFT #1043", "SAV-ON DRUGS 0412", "INTERNAL REVENUE SERVICE EFTPS", "ONLINE TRANSFER TO SMITH J", "WIRE TRANSFER OUT BENEF JOHN DOE", "OUTGOING WIRE TRANSFER TO ACCOUNT 7731 J DOE"]
    .forEach((d) => check(`"${d}" isn't a transfer to savings`, pairWith(d), 0));
  ["To Savings 00", "Online Transfer to SAV", "TRANSFER TO XXXXXX1234", "Internal Transfer", "Transfer between accounts", "XFER TO CHECKING"]
    .forEach((d) => check(`"${d}" is`, pairWith(d), 1));
  check("pay landing in savings is never the fund's half", pairWith("To Savings 00", "ACME FOODS PAYROLL"), 0);
  const both = [
    t({ id: "c", date: T, amount: -100, account_id: "Main Checking", merchant_raw: "To Savings 00" }),
    t({ id: "stray", date: T, amount: 100, account_id: "Personal Savings", merchant_raw: "MOBILE DEPOSIT" }),
    t({ id: "real", date: T, amount: 100, account_id: "Personal Savings", merchant_raw: "Transfer from Savings 00" })
  ];
  const got = H.pairFundTransfers(both, [fund()], cats, { accounts: ACCOUNTS });
  check("of two same-sized deposits, the one that reads like a transfer is taken", both[got[0].fundIndex].id, "real");

  // Undoing a wrong pair by relabelling it.
  const txs = [
    { id: "chq", date: T, amount: -100, account_id: "Main Checking", merchant_raw: "To Savings 00", resolved_category: "Savings", override_label: "Savings", transfer_pair: "dep" },
    { id: "dep", date: T, amount: 100, account_id: "Personal Savings", resolved_category: "Savings", override_label: "Savings", transfer_pair: "chq" }
  ];
  const byId = (list) => new Map(list.map((x) => [x.id, x]));
  check("a pair stands while both halves are filed alike", H.livePairPartner(txs[0], byId(txs)).id, "dep");
  const relabelled = [Object.assign({}, txs[0], { override_label: "Childcare", resolved_category: "Childcare" }), txs[1]];
  check("relabelling one half ends it", H.livePairPartner(relabelled[0], byId(relabelled)), null);
  check("it no longer counts as moved", H.fundMovesThisPeriod(relabelled, [fund()], ACCOUNTS, D(-5), D(9)), { "fund-1": 0 });
  const bill = { id: "sitter", name: "Sitter", amount: 100, due_day_of_month: Number(T.slice(8)), payment_category: "Childcare", linked_payments: [] };
  check("and it's offered to Mark Paid again",
    H.findCandidateTransactions({ transactions: relabelled, targetAmount: 100, exactAmount: true }).map((x) => x.id), ["chq"]);
  check("while a standing pair isn't", H.findCandidateTransactions({ transactions: txs, targetAmount: 100, exactAmount: true }).map((x) => x.id), []);
  check("a one-sided pointer isn't a pair",
    H.livePairPartner({ id: "a", transfer_pair: "b", resolved_category: "Savings" }, byId([{ id: "b", transfer_pair: "zzz", resolved_category: "Savings" }])), null);

  // Moves: only from the cash-on-hand account, dated when the cash left.
  const leg = (id, acct, date, amt, partner) => ({ id, date, amount: amt, account_id: acct, resolved_category: "Savings", transfer_pair: partner });
  const accounts = [CHK, { id: "Joint Checking", type: "checking", current_balance: 50 }, SAV];
  check("from a second checking account: not a move out of the cash on hand",
    H.fundMovesThisPeriod([leg("j", "Joint Checking", T, -200, "s"), leg("s", "Personal Savings", T, 200, "j")], [fund()], accounts, D(-5), D(9)), { "fund-1": 0 });
  check("left checking last period, landed this one: last period's",
    H.fundMovesThisPeriod([leg("c", "Main Checking", D(-6), -100, "s"), leg("s", "Personal Savings", D(-5), 100, "c")], [fund()], accounts, D(-5), D(9)), { "fund-1": 0 });
  check("left this period, landed next: this period's",
    H.fundMovesThisPeriod([leg("c", "Main Checking", D(8), -100, "s"), leg("s", "Personal Savings", D(9), 100, "c")], [fund()], accounts, D(-5), D(9)), { "fund-1": 100 });
}

// ===========================================================================
console.log("\n28. Second audit: a bill paid from the fund, blank balances, merges, a sync");
{
  // A bill paid from the fund's account still settles the bill.
  const insurer = { id: "f1", name: "Car Insurance", amount: 150, due_day_of_month: Number(D(2).slice(8)), payment_category: "Car Insurance", linked_payments: [] };
  const args = (goals) => ({
    cashOnHand: 1000, todayStr: D(-3), nextPaydayStr: D(11), fixedExpenses: [insurer], installmentDebts: [], revolvingDebts: [],
    bufferMode: "manual", manualBuffer: 300, currentDateStr: T, goals, accounts: ACCOUNTS,
    categoryMeta: [{ name: "Car Insurance", is_transfer: false }],
    transactions: [
      { id: "g", date: D(-1), amount: -150, account_id: "Personal Savings", merchant_raw: "EXAMPLE INSURANCE", resolved_category: "Car Insurance" },
      { id: "v", date: D(-1), amount: -80, account_id: "Personal Savings", merchant_raw: "VET", resolved_category: "Pet Bills" }
    ]
  });
  const without = H.runAllocation(args([]));
  const withFund = H.runAllocation(args([fund()]));
  check("the bill still asks to be matched, fund or no fund",
    [withFund.bufferSpending.unsettled.map((u) => u.id), without.bufferSpending.unsettled.map((u) => u.id)], [["g"], ["g"]]);
  check("and the unreconciled check still pairs it", withFund.unreconciled.pairs.length, without.unreconciled.pairs.length);
  check("while the vet bill from the fund stays off the allowance", [withFund.bufferSpent, without.bufferSpent], [0, 80]);
  check("and still shows where the period's money went", withFund.ownershipSummary.count, without.ownershipSummary.count);

  // Settings → Accounts → Edit, balance left blank on an account with none.
  const app = makeApp({ [F.accounts]: [{ id: "Personal Savings", type: "savings", current_balance: null, simplefin_id: "ACT-sav" }], [F.transactions]: [], [F.revolvingDebts]: [], [F.savingsGoals]: [] });
  const tab = Object.create(H.BudgetSettingTab.prototype);
  tab.app = app;
  tab.plugin = { app, promptAddAccount() {}, refreshAfterDataChange: async () => {}, simplefinLinkContext: async () => ({ simplefinAccounts: [], linkedBy: {} }) };
  tab.section = (c) => c; tab.countLabel = () => ""; tab.display = () => {};
  const c = el("div");
  await tab.renderAccountSettings(c);
  let saving = null;
  const origOpen = H.AddAccountModal.prototype.open;
  H.AddAccountModal.prototype.open = function () { saving = this.onSubmit({ id: "Personal Savings", type: "savings", current_balance: 0, simplefin_id: "ACT-sav" }); };
  await button(byCls(c, "budget-cat-row")[0], "Edit").onclick();
  await saving;
  H.AddAccountModal.prototype.open = origOpen;
  check("a blank balance saved on an undated account isn't dated today", "balance_as_of" in readFile(app, F.accounts)[0], false);

  // A hold merging into a posted row that already has its own pair.
  const merged = H.mergeSettledHolds([
    { id: "hold", pending: true, date: null, amount: -60, account_id: "Main Checking", merchant_raw: "To Savings 00", transfer_pair: "s1" },
    { id: "posted", date: D(-1), amount: -60, account_id: "Main Checking", merchant_raw: "To Savings 00", transfer_pair: "s2" },
    { id: "s1", date: D(-1), amount: 60, account_id: "Personal Savings", transfer_pair: "hold" },
    { id: "s2", date: D(-1), amount: 60, account_id: "Personal Savings", transfer_pair: "posted" }
  ], {});
  const m = Object.fromEntries(merged.transactions.map((x) => [x.id, x]));
  check("the posted row keeps its own pair", m.posted.transfer_pair, "s2");
  check("and the hold's partner isn't made a lopsided second half", m.s1.transfer_pair, "hold");

  // A fund saved during a sync gets its transfers filed when the sync ends.
  const sapp = makeApp({
    [F.accounts]: [CHK, SAV], [F.savingsGoals]: [fund()], [F.categories]: [{ name: "Savings", is_transfer: true }], [F.rules]: [],
    [F.transactions]: [
      { id: "c1", date: T, amount: -75, account_id: "Main Checking", merchant_raw: "To Savings 00", resolved_category: "Uncategorized" },
      { id: "s1", date: T, amount: 75, account_id: "Personal Savings", merchant_raw: "Deposit", resolved_category: "Uncategorized" }
    ]
  });
  sapp.secretStorage.setSecret(H.SIMPLEFIN_SECRET_ID, "https://u:p@bridge.example.org/simplefin");
  const plugin = makePlugin(sapp);
  plugin.fundRelabelPending = true;
  global.__notices = [];
  global.__requestUrl = async () => ({ status: 500, text: "down", json: {} });
  await plugin.syncSimpleFIN();
  check("even a failed sync files them once it's over", readFile(sapp, F.transactions).map((x) => x.resolved_category), ["Savings", "Savings"]);
  check("and forgets the job", plugin.fundRelabelPending, false);
}

// ===========================================================================
console.log("\n29. 1.20.0: the balance glows cyan in every placement");
{
  for (const placement of ["hero", "cards", "goals"]) {
    const { root } = await overview({ placement });
    const glow = byCls(root, "budget-fund-glow");
    check(`${placement}: the balance, and only it, glows`, glow.map((n) => text(n)), ["$640.12"]);
  }
  const { root } = await overview({ placement: "goals", balance: null });
  check("no balance yet: the dash doesn't glow", byCls(root, "budget-fund-glow").length, 0);
  const { root: row } = await overview({ placement: "goals" });
  const amt = byCls(row, "budget-fund-row")[0];
  check("the goal row still reads balance / ceiling", /\$640\.12 \/ \$1000\.00/.test(text(amt)), true);
}

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
})();
