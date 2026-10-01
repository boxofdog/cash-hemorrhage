// 1.25.1 — Cash on hand follows the checking account's newest balance.
// Each balance write is stamped with when and how it arrived (SimpleFIN or
// typed); the pay period keeps a stamp for its own copy; the newer one wins.
const P = require("./paths.js");
global.document = { body: { classList: { contains: () => false } } };
global.requestAnimationFrame = (fn) => setTimeout(fn, 0);
const fs = require("fs");
const H = require("./harness.js");
const { el, allText } = H;

let pass = 0, fail = 0;
function check(name, got, want) {
  const ok = JSON.stringify(got) === JSON.stringify(want);
  if (ok) { pass++; console.log(`  PASS  ${name}`); }
  else { fail++; console.log(`  FAIL  ${name}: got ${JSON.stringify(got)}, want ${JSON.stringify(want)}`); }
}
const find = (n, pred, out = []) => { if (pred(n)) out.push(n); (n.children || []).forEach((c) => find(c, pred, out)); return out; };
const byCls = (n, cls) => find(n, (x) => x.classes && x.classes.has(cls));
const text = (n) => allText(n).replace(/\s+/g, " ").trim();

const T = H.todayLocal();
const D = (n) => H.addDays(T, n);
const at = (d, h = 12) => Math.floor(new Date(`${d}T${String(h).padStart(2, "0")}:00:00`).getTime() / 1000);
const F = H.FILES;
const tick = (ms = 5) => new Promise((r) => setTimeout(r, ms));

function makeApp(files = {}) {
  const store = {};
  Object.entries(files).forEach(([k, v]) => (store[k] = JSON.stringify(v)));
  const secrets = {};
  return {
    _store: store,
    vault: { adapter: { exists: async (p) => p in store, read: async (p) => store[p], write: async (p, d) => { store[p] = d; }, mkdir: async () => {}, list: async () => ({ files: [], folders: [] }) }, getFiles: () => [] },
    secretStorage: { getSecret: (id) => secrets[id] ?? null, setSecret: (id, v) => { secrets[id] = v; } },
    workspace: { _leaves: [], getLeavesOfType() { return this._leaves; } }
  };
}
const read = (app, p) => JSON.parse(app._store[p]);
function makePlugin(app) {
  const p = Object.create(H.__PluginClass.prototype);
  Object.assign(p, { app, manifest: { id: "budget-tracker" }, settings: {}, syncing: false, openSettings() {} });
  p.setSimpleFINAccess("https://demo:s3cr3t@bridge.example/simplefin");
  return p;
}
// The bank's figure is dated now unless a test says otherwise, as a bank that
// has just refreshed SimpleFIN would date it.
function bank(balance, { balanceDate = null, transactions = [], id = "ACT-chk", errlist = [] } = {}) {
  // Rounded up: a bank time in the same second as a balance typed a moment
  // ago would otherwise read as older than it. (The sync caps it at now.)
  const when = balanceDate ? at(balanceDate, 9) : Math.ceil(Date.now() / 1000) + 1;
  const json = { accounts: [{ id, name: "Checking", conn_id: "C1", currency: "USD", balance: String(balance), "balance-date": when, transactions }], errlist,
    connections: [{ conn_id: "C1", name: "Example Credit Union" }] };
  global.__requestUrl = async () => ({ status: 200, json, text: JSON.stringify(json) });
}
const period = (bal, o = {}) => ({ inputs: Object.assign({ paycheckAmount: 1600, checkingBalance: bal, alreadyDeposited: true, nextPaydayStr: D(7), periodStartStr: D(-7) }, o), savedAt: D(-7) });
const CHK = (o = {}) => Object.assign({ id: "Credit Union", type: "checking", institution: "Credit Union", current_balance: 1000, simplefin_id: "ACT-chk", last_imported_through: D(-2) }, o);

(async () => {
// ===========================================================================
console.log("\n1. Which account is cash on hand");
{
  check("the checking account that syncs, even listed second",
    H.cashAccount([{ id: "old", type: "checking" }, { id: "sf", type: "checking", simplefin_id: "x" }, { id: "sav", type: "savings", simplefin_id: "y" }]).id, "sf");
  check("otherwise the first checking account", H.cashAccount([{ id: "sav", type: "savings" }, { id: "a", type: "checking" }, { id: "b", type: "checking" }]).id, "a");
  check("none", H.cashAccount([{ id: "card", type: "credit_card" }]), null);
}

// ===========================================================================
console.log("\n2. Newer wins");
{
  const acct = (bal, atIso, source = "simplefin", o = {}) => [Object.assign(CHK({ current_balance: bal, balance_updated_at: atIso, balance_source: source }), o)];
  let inputs = { checkingBalance: 1000, alreadyDeposited: true, checkingBalanceAt: "2026-09-20T10:00:00.000Z", checkingAccountId: "Credit Union" };
  check("a newer account balance replaces the period's", [H.adoptCashBalance(inputs, acct(1500, "2026-09-21T10:00:00.000Z"), []), inputs.checkingBalance, inputs.checkingBalanceSource, inputs.checkingBalanceAt],
    [true, 1500, "simplefin", "2026-09-21T10:00:00.000Z"]);
  check("an older one doesn't", [H.adoptCashBalance(inputs, acct(900, "2026-09-19T10:00:00.000Z"), []), inputs.checkingBalance], [false, 1500]);
  check("nor the same one again", H.adoptCashBalance(inputs, acct(1500, "2026-09-21T10:00:00.000Z"), []), false);
  check("an account balance with no stamp can't be ordered: the period keeps its own",
    [H.adoptCashBalance(inputs, [CHK({ current_balance: 2000 })], []), inputs.checkingBalance], [false, 1500]);
  const legacy = { checkingBalance: 1000, alreadyDeposited: true };
  check("a period from before stamps takes any stamped balance", [H.adoptCashBalance(legacy, acct(1500, "2026-09-21T10:00:00.000Z"), []), legacy.checkingBalance], [true, 1500]);
  const moved = { checkingBalance: 1000, alreadyDeposited: true, checkingBalanceAt: "2026-09-25T10:00:00.000Z", checkingAccountId: "Old CSV" };
  check("a period counting a different account moves to the cash account", [H.adoptCashBalance(moved, acct(1500, "2026-09-21T10:00:00.000Z"), []), moved.checkingBalance, moved.checkingAccountId], [true, 1500, "Credit Union"]);
  check("no balance on the account: nothing to take", H.adoptCashBalance({ checkingBalance: 5 }, acct(null, "2026-09-21T10:00:00.000Z"), []), false);
  check("no period: nothing to do", H.adoptCashBalance(null, acct(1, "2026-09-21T10:00:00.000Z"), []), false);
}

// ===========================================================================
console.log("\n3. A paycheck that hadn't landed");
{
  const acct = [CHK({ current_balance: 1500, balance_updated_at: new Date().toISOString(), balance_source: "simplefin" })];
  const base = () => ({ paycheckAmount: 1600, checkingBalance: 900, alreadyDeposited: false, enteredOn: D(-1), periodStartStr: D(-10) });
  const dep = (o) => Object.assign({ id: "d", date: D(0), amount: 1600, account_id: "Credit Union", resolved_category: "Transfer" }, o);
  let i = base();
  H.adoptCashBalance(i, acct, []);
  check("no deposit yet: still added on top of the new balance", [i.checkingBalance, i.alreadyDeposited], [1500, false]);
  i = base(); H.adoptCashBalance(i, acct, [dep({ resolved_category: "Paycheck", amount: 1612.4 })]);
  check("a deposit filed as Paycheck: landed", i.alreadyDeposited, true);
  i = base(); H.adoptCashBalance(i, acct, [dep({ amount: 1620 })]);
  check("one within 2% of the paycheck: landed", i.alreadyDeposited, true);
  i = base(); H.adoptCashBalance(i, acct, [dep({ amount: 1700 })]);
  check("a different amount, not filed as pay: not", i.alreadyDeposited, false);
  i = base(); H.adoptCashBalance(i, acct, [dep({ date: D(-5), resolved_category: "Paycheck" })]);
  check("last paycheck, from before this one was entered: not", i.alreadyDeposited, false);
  i = base(); H.adoptCashBalance(i, acct, [dep({ pending: true })]);
  check("still pending: not", i.alreadyDeposited, false);
  i = base(); H.adoptCashBalance(i, acct, [dep({ account_id: "Savings" })]);
  check("into another account: not", i.alreadyDeposited, false);
  check("no paycheck amount: nothing to add, counts as landed", H.paycheckLanded({ paycheckAmount: 0 }, acct[0], []), true);
}

// ===========================================================================
console.log("\n4. Syncing");
{
  // A: two checking accounts, the synced one listed second.
  let app = makeApp({ [F.accounts]: [{ id: "Old CSV Checking", type: "checking", current_balance: 900 }, CHK()], [F.activePeriod]: period(1000) });
  let p = makePlugin(app);
  await p.loadActivePeriod();
  bank(1500);
  global.__notices = [];
  await p.syncSimpleFIN();
  check("an unsynced checking account listed first no longer freezes cash on hand", read(app, F.activePeriod).inputs.checkingBalance, 1500);
  const a = read(app, F.accounts)[1];
  check("the synced account is stamped as from SimpleFIN", [a.current_balance, a.balance_source, typeof a.balance_updated_at], [1500, "simplefin", "string"]);
  check("the period records where its figure came from", [read(app, F.activePeriod).inputs.checkingBalanceSource, read(app, F.activePeriod).inputs.checkingAccountId], ["simplefin", "Credit Union"]);
  check("the result says so for the dashboard", [p.lastResult.cashSource.account, p.lastResult.cashSource.source, p.lastResult.cashSource.balance], ["Credit Union", "simplefin", 1500]);

  // B: synced on another device; this one still holds the period it loaded.
  const files = { [F.accounts]: [CHK()], [F.activePeriod]: period(1000) };
  const desk = makeApp(files); const desktop = makePlugin(desk); await desktop.loadActivePeriod();
  const phoneApp = makeApp(files); const phone = makePlugin(phoneApp); await phone.loadActivePeriod();
  bank(1500);
  await phone.syncSimpleFIN();
  desk._store[F.accounts] = phoneApp._store[F.accounts];
  desk._store[F.activePeriod] = phoneApp._store[F.activePeriod];
  await desktop.recalculate();
  check("a device that didn't sync takes the synced balance, not the one it had loaded", [desktop.lastResult.cashOnHand, read(desk, F.activePeriod).inputs.checkingBalance], [1500, 1500]);

  // C: synced before the paycheck lands.
  app = makeApp({ [F.accounts]: [CHK()], [F.activePeriod]: period(1000, { alreadyDeposited: false, enteredOn: D(-1) }) });
  p = makePlugin(app); await p.loadActivePeriod();
  bank(1500);
  await p.syncSimpleFIN();
  check("the paycheck isn't dropped from cash on hand", [p.lastResult.cashOnHand, p.lastResult.cashSource.paycheckPending], [3100, 1600]);
  await tick(5); // two syncs in one millisecond would share a stamp
  bank(3100, { transactions: [{ id: "pay", posted: at(T), amount: "1600.00", description: "ACME PAYROLL" }] });
  await p.syncSimpleFIN();
  check("once it's in, it isn't counted twice", [p.lastResult.cashOnHand, p.lastResult.cashSource.paycheckPending], [3100, 0]);

  // D: two dashboards open.
  app = makeApp({ [F.accounts]: [CHK()], [F.activePeriod]: period(1000) });
  const leaf = () => ({ view: { lastResult: null, renders: 0, render() { this.renders++; }, setResult(r) { this.lastResult = r; } } });
  const l1 = leaf(), l2 = leaf();
  app.workspace._leaves = [l1, l2];
  p = makePlugin(app); await p.loadActivePeriod();
  bank(1500);
  await p.syncSimpleFIN();
  check("every open dashboard gets the new figures", [l1.view.lastResult.cashOnHand, l2.view.lastResult.cashOnHand], [1500, 1500]);
  l1.view.renders = 0; l2.view.renders = 0;
  p.refreshDashboard();
  check("and every one redraws", [l1.view.renders, l2.view.renders], [1, 1]);

  // The notice says what each balance did, and when SimpleFIN is behind.
  app = makeApp({ [F.accounts]: [CHK()], [F.activePeriod]: period(1000) });
  p = makePlugin(app); await p.loadActivePeriod();
  global.__notices = [];
  bank(1000, { balanceDate: D(-4) });
  await p.syncSimpleFIN();
  const note = global.__notices.pop().split("\n");
  check("the notice is short: nothing new, and no balance changed", note[0], "Synced \u2014 nothing new.");
  check("a balance SimpleFIN dates days back gets one line", note[1], `Example Credit Union: SimpleFIN has nothing newer than ${H.formatChartDate(D(-4)).replace(`, ${T.slice(0, 4)}`, "")} yet.`);
  bank(1000, { balanceDate: D(-1) });
  await p.syncSimpleFIN();
  check("a day old doesn't", global.__notices.pop(), "Synced \u2014 nothing new.");
  bank(1500);
  await p.syncSimpleFIN();
  check("a changed balance is counted, not itemised", global.__notices.pop(), "Synced \u2014 nothing new \u00b7 1 balance updated.");

  // The regression: the bank last refreshed SimpleFIN days ago, and a balance
  // typed since then is newer. It stays — on the account and on the dashboard.
  app = makeApp({ [F.accounts]: [CHK({ balance_updated_at: "2026-01-01T00:00:00.000Z", balance_source: "simplefin" })], [F.activePeriod]: period(1000) });
  p = makePlugin(app); await p.loadActivePeriod();
  await p.applyBalancePatch({ "Credit Union": 612.4 });
  await p.recalculate();
  global.__notices = [];
  bank(537.67, { balanceDate: D(-5), errlist: [{ code: "con.auth", msg: "Connection to Example Credit Union may need attention. Auth required", conn_id: "C1" }] });
  await p.syncSimpleFIN();
  check("a days-old synced balance doesn't replace a newer typed one", [read(app, F.accounts)[0].current_balance, read(app, F.accounts)[0].balance_source, p.lastResult.cashOnHand], [612.4, "manual", 612.4]);
  const lines = global.__notices.pop().split("\n");
  check("the notice: sign in again, and that the typed figure was kept", lines.slice(1), [
    `Example Credit Union needs you to sign in again at SimpleFIN Bridge. Its balances are from ${H.formatChartDate(D(-5)).replace(`, ${T.slice(0, 4)}`, "")}.`,
    "Kept your newer typed balance for Credit Union."
  ]);
  const byName = (acctLabel, org) => H.simplefinConnectionProblems(
    [{ message: "Connection to Example Credit Union may need attention. Auth required" }],
    [{ local: { id: "Credit Union", institution: acctLabel }, sf: { id: "x", org, balanceDate: D(-5) } }], T).lines;
  check("an error naming the bank, with no ids, still covers its accounts: one line", byName("Credit Union", "Example Credit Union").length, 1);
  check("…matched by the account's own name too", byName("Example Credit Union", "").length, 1);
  bank(640);
  await p.syncSimpleFIN();
  check("once the bank sends a newer figure, it's used", [read(app, F.accounts)[0].current_balance, p.lastResult.cashOnHand], [640, 640]);
  check("a synced balance is stamped with the bank's time, not the sync's", read(app, F.accounts)[0].balance_updated_at <= new Date().toISOString(), true);
  app = makeApp({ [F.accounts]: [CHK()], [F.activePeriod]: period(1000) });
  p = makePlugin(app); await p.loadActivePeriod();
  bank(800, { balanceDate: D(-3) });
  await p.syncSimpleFIN();
  check("…the bank's own date, however old", read(app, F.accounts)[0].balance_updated_at, new Date(at(D(-3), 9) * 1000).toISOString());

  // Left by 1.25.1, which stamped synced balances with the time of the sync:
  // an old Credit Union figure marked as synced this morning. When the bank reconnects,
  // its balance may be timed earlier this morning, and it must still go in —
  // only a typed balance is kept over a sync's, never an earlier sync's.
  app = makeApp({ [F.accounts]: [CHK({ current_balance: 537.67, balance_updated_at: new Date(Date.now() + 3600000).toISOString(), balance_source: "simplefin" })], [F.activePeriod]: period(537.67) });
  p = makePlugin(app); await p.loadActivePeriod();
  bank(702.15, { balanceDate: D(-1) });
  await p.syncSimpleFIN();
  check("a fresh bank figure replaces one a sync mis-stamped as newer", [read(app, F.accounts)[0].current_balance, read(app, F.accounts)[0].balance_updated_at], [702.15, new Date(at(D(-1), 9) * 1000).toISOString()]);
}

// ===========================================================================
console.log("\n5. Typing a balance");
{
  let app = makeApp({ [F.accounts]: [CHK()], [F.activePeriod]: period(1000) });
  let p = makePlugin(app); await p.loadActivePeriod();
  bank(1500);
  await p.syncSimpleFIN();
  await tick(5);
  await p.applyBalancePatch({ "Credit Union": 1450 });
  await p.recalculate();
  check("an update typed after a sync is newer, so it's used", [p.lastResult.cashOnHand, p.lastResult.cashSource.source, read(app, F.accounts)[0].balance_source], [1450, "manual", "manual"]);
  await tick(5);
  bank(1480);
  await p.syncSimpleFIN();
  check("and the next sync is newer again", [p.lastResult.cashOnHand, p.lastResult.cashSource.source], [1480, "simplefin"]);

  // Enter Paycheck: the prefilled figure keeps the account's stamp; typing over it doesn't.
  let captured = null;
  const orig = H.PaycheckModal.prototype.open;
  H.PaycheckModal.prototype.open = function () { captured = this; };
  Object.assign(p, { activateView: async () => {}, offerBufferSweep: async () => {} });
  await p.promptEnterPaycheck();
  check("Enter Paycheck prefills the cash account's balance", captured.prefill.checkingBalance, 1480);
  const stampBefore = read(app, F.accounts)[0].balance_updated_at;
  await captured.onSubmit({ paycheckAmount: 1600, checkingBalance: 1480, alreadyDeposited: true, nextPaydayStr: D(14) });
  let i = read(app, F.activePeriod).inputs;
  check("left as prefilled: still the synced figure, with the sync's stamp", [i.checkingBalanceSource, i.checkingBalanceAt === stampBefore, i.enteredOn], ["simplefin", true, T]);
  await tick(5);
  await captured.onSubmit({ paycheckAmount: 1600, checkingBalance: 1390, alreadyDeposited: true, nextPaydayStr: D(14) });
  i = read(app, F.activePeriod).inputs;
  check("typed over: that figure, marked as typed, newer than the sync", [p.lastResult.cashOnHand, i.checkingBalanceSource, i.checkingBalanceAt > stampBefore], [1390, "paycheck", true]);
  await tick(5);
  bank(1395);
  await p.syncSimpleFIN();
  check("…until the next sync", p.lastResult.cashOnHand, 1395);
  H.PaycheckModal.prototype.open = orig;

  // A card's balance changed from the Debts tab is stamped as typed too.
  app = makeApp({ [F.accounts]: [{ id: "chase", type: "credit_card", current_balance: 500 }], [F.revolvingDebts]: [{ id: "d", account_id: "chase", balance_anchor: { amount: 500, date: D(-3) } }] });
  await H.reanchorCardBalance(app, "chase", 420);
  check("a card re-anchored by hand is stamped as typed", read(app, F.accounts)[0].balance_source, "manual");
}

// ===========================================================================
console.log("\n6. Where it shows");
{
  check("from SimpleFIN", H.balanceSourceText("simplefin", `${T}T16:14:00.000Z`).startsWith("from SimpleFIN · "), true);
  check("typed", [H.balanceSourceText("manual", null), H.balanceSourceText("paycheck", null), H.balanceSourceText(null, null)], ["entered by hand", "typed in Enter Paycheck", ""]);
  // Today at 9:14, so the balance is fresh whenever the suite runs. A fixed
  // date goes stale and picks up an "N days old" note.
  const d = new Date(`${T}T09:14:00`);
  check("with a short date and time", H.formatStampShort(d.toISOString()), `${H.formatChartDate(T).replace(`, ${T.slice(0, 4)}`, "")}, 9:14 AM`);
  const old = new Date(`${D(-5)}T09:00:00`).toISOString();
  check("an old synced balance says how old", H.balanceSourceText("simplefin", old), `from SimpleFIN · ${H.formatStampShort(old)} (5 days old)`);

  const RESULT = JSON.parse(fs.readFileSync(P.FIXTURES + "/fixture-result.json", "utf8"));
  const CTX = JSON.parse(fs.readFileSync(P.FIXTURES + "/fixture-ctx.json", "utf8"));
  const hero = (cashSource) => {
    const v = Object.create(H.BudgetDashboardView.prototype);
    Object.assign(v, { sectionOpen: {}, scrollMemory: {}, app: {}, plugin: { settings: {}, promptQuickBalance() {} } });
    const root = el("div");
    v.renderPeriodHero(root, Object.assign({}, RESULT, { cashSource }), CTX);
    return byCls(root, "budget-hero-source").map(text);
  };
  check("the hero names the balance and where it came from",
    hero({ account: "Credit Union", balance: 1480, source: "simplefin", at: d.toISOString(), paycheckPending: 0 })[0], `Credit Union $1480.00 from SimpleFIN · ${H.formatStampShort(d.toISOString())}`);
  check("…and a paycheck still to come", hero({ account: "Credit Union", balance: 900, source: "paycheck", at: d.toISOString(), paycheckPending: 1600 })[0].endsWith("+ $1600.00 paycheck not in yet"), true);
  check("…or that it hasn't been updated", hero({ account: "Credit Union", balance: 900, source: null, at: null, paycheckPending: 0 })[0], "Credit Union $900.00 (not updated since this period began)");
  check("an old result without the field shows nothing extra", hero(undefined), []);

  const tab = Object.create(H.BudgetSettingTab.prototype);
  const app = makeApp({ [F.accounts]: [
    { id: "Old CSV Checking", type: "checking", current_balance: 900, balance_as_of: "2026-08-01" },
    CHK({ balance_updated_at: d.toISOString(), balance_source: "simplefin" }),
    { id: "sav", type: "savings", simplefin_id: "ACT-sav", current_balance: 10 }
  ] });
  tab.app = app;
  tab.plugin = { simplefinLinkContext: async () => ({}), promptAddAccount() {} };
  tab.sectionOpen = {};
  tab.display = () => {};
  const root = el("div");
  await tab.renderAccountSettings(root);
  check("settings: where each balance came from, and which is cash on hand", byCls(root, "budget-account-source").map(text), [
    `Balance as of ${H.formatChartDate("2026-08-01")}`,
    `Balance from SimpleFIN · ${H.formatStampShort(d.toISOString())} · the budget's cash on hand`,
    "Balance not yet dated by a sync"
  ]);
}

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
})().catch((e) => { console.error(e); process.exit(1); });
