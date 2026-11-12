// A sinking fund end to end with SimpleFIN: the transfer into its savings account
// is seen on sync, lands on the fund, and the plan holds back that much less.
const H = require("./harness.js");
const { el, allText } = H;
global.requestAnimationFrame = (fn) => setTimeout(fn, 0);

let pass = 0, fail = 0;
function check(name, got, want) {
  const ok = JSON.stringify(got) === JSON.stringify(want);
  if (ok) { pass++; console.log(`  PASS  ${name}`); }
  else { fail++; console.log(`  FAIL  ${name}: got ${JSON.stringify(got)}, want ${JSON.stringify(want)}`); }
}
const T = H.todayLocal();
const D = (n) => H.addDays(T, n);
const at = (d, h = 12) => Math.floor(new Date(`${d}T${String(h).padStart(2, "0")}:00:00`).getTime() / 1000);
const F = H.FILES;

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
function makePlugin(app, settings = {}) {
  const p = Object.create(H.__PluginClass.prototype);
  Object.assign(p, { app, manifest: { id: "budget-tracker" }, settings, syncing: false, openSettings() {} });
  p.setSimpleFINAccess("https://demo:s3cr3t@bridge.example/simplefin");
  return p;
}
const when = () => Math.ceil(Date.now() / 1000) + 1;
function bank({ checking = [], savings = [] }) {
  const json = {
    accounts: [
      { id: "ACT-chk", name: "Checking", conn_id: "C1", currency: "USD", balance: "2500", "balance-date": when(), transactions: checking },
      { id: "ACT-sav", name: "Savings", conn_id: "C1", currency: "USD", balance: "500", "balance-date": when(), transactions: savings }
    ],
    errlist: [], connections: [{ conn_id: "C1", name: "Example Credit Union" }]
  };
  global.__requestUrl = async () => ({ status: 200, json, text: JSON.stringify(json) });
}

(async () => {
  // Paydays are every other week; this period began 2 days ago and ends in 12.
  const settings = { paySchedule: { cadence: "biweekly", anchor_date: D(-2) } };
  // Rent is due 20 days out, so the cycle began 10 days ago and this is the second of the checks in it.
  const dueDay = Number(D(20).slice(8, 10));
  const fund = { id: "sink1", kind: "sinking", name: "Rent", target_amount: 1500, due_day_of_month: dueDay, account_id: "ACT-sav-local", track_from: D(-30), contributions: [], saved_amount: 0, linked_payments: [], paid_through: H.sinkingDueBefore(dueDay, D(20)) };
  const files = {
    [F.accounts]: [
      { id: "Credit Union", type: "checking", institution: "Credit Union", current_balance: 2500, simplefin_id: "ACT-chk", last_imported_through: D(-2) },
      { id: "ACT-sav-local", type: "savings", institution: "Savings", current_balance: 0, simplefin_id: "ACT-sav", last_imported_through: D(-2) }
    ],
    [F.savingsGoals]: [fund],
    [F.activePeriod]: { inputs: { paycheckAmount: 1600, checkingBalance: 2500, alreadyDeposited: true, nextPaydayStr: D(12), periodStartStr: D(-2) }, savedAt: D(-2) }
  };
  const app = makeApp(files);
  const p = makePlugin(app, settings);
  await p.loadActivePeriod();
  await p.recalculate();

  const before = p.lastResult;
  const row = before.sinkingRows[0];
  check("the plan is in the period's result", [before.sinkingRows.length, row.name, row.amount, row.due], [1, "Rent", 1500, D(20)]);
  check("it holds back what's due by now, out of what's free", [before.sinkingHeld, before.committed >= before.sinkingHeld], [row.hold, true]);
  check("with paychecks left to fund it", [row.total >= 2, row.perCheck, row.hold > 0], [true, Math.round((1500 / row.total) * 100) / 100, true]);

  // The savings account sees $500 arrive, and checking sees it leave.
  bank({
    checking: [{ id: "c-out", posted: at(D(-1)), amount: "-500.00", description: "Transfer to Savings" }],
    savings: [{ id: "s-in", posted: at(D(-1)), amount: "500.00", description: "Transfer from Checking" }]
  });
  global.__notices = [];
  await p.syncSimpleFIN();
  const goals = read(app, F.savingsGoals);
  const f = goals[0];
  check("sync sees the transfer and it lands on the fund, with nothing to ask", [f.saved_amount, f.contributions.length, f.contributions[0] && f.contributions[0].amount, f.contributions[0] && f.contributions[0].source], [500, 1, 500, "account"]);
  const after = p.lastResult.sinkingRows[0];
  check("the fund has $500 in savings", [after.saved, after.target], [500, row.target]);
  check("so the plan holds back that much less", [after.hold, Math.round((before.sinkingHeld - p.lastResult.sinkingHeld) * 100) / 100], [Math.max(0, Math.round((row.target - 500) * 100) / 100), Math.min(500, row.target)]);
  check("and syncing the same transfer again doesn't count it twice", await (async () => { await p.syncSimpleFIN(); return read(app, F.savingsGoals)[0].saved_amount; })(), 500);

  // Sharing the account with a goal: you're asked which.
  const app2 = makeApp(Object.assign({}, files, { [F.savingsGoals]: [fund, { id: "g1", name: "Trip", target_amount: 800, saved_amount: 0, account_id: "ACT-sav-local", track_from: D(-30), contributions: [] }] }));
  const p2 = makePlugin(app2, settings);
  await p2.loadActivePeriod();
  bank({ savings: [{ id: "s-in", posted: at(D(-1)), amount: "500.00", description: "Transfer from Checking" }] });
  await p2.syncSimpleFIN();
  const g2 = read(app2, F.savingsGoals);
  check("with a goal on the same account, it's asked about and nothing is guessed", [g2[0].saved_amount, g2[1].saved_amount, H.goalTransferQueue(read(app2, F.transactions), g2).ask.map((a) => a.goalIds)], [0, 0, [["sink1", "g1"]]]);
  await p2.answerGoalTransfer(H.goalTransferQueue(read(app2, F.transactions), g2).ask[0].tx.id, "sink1");
  check("and your answer puts it on the fund", read(app2, F.savingsGoals)[0].saved_amount, 500);

  console.log(`\n${pass} passed, ${fail} failed`);
  process.exit(fail ? 1 : 0);
})().catch((e) => { console.error(e); process.exit(1); });
