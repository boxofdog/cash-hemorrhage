// Enter Paycheck: picking this paycheck's deposit from the ledger.
global.document = { body: { classList: { contains: () => false } } };
const H = require("./harness.js");
const { el, allText, SettingStub } = H;

let pass = 0, fail = 0;
function check(name, got, want) {
  const ok = JSON.stringify(got) === JSON.stringify(want);
  if (ok) { pass++; console.log(`  PASS  ${name}`); }
  else { fail++; console.log(`  FAIL  ${name}: got ${JSON.stringify(got)}, want ${JSON.stringify(want)}`); }
}
const T = H.todayLocal();
const D = (n) => H.addDays(T, n);
const F = H.FILES;

const ACCOUNTS = [
  { id: "checking", type: "checking", current_balance: 900 },
  { id: "savings", type: "savings", current_balance: 50 },
  { id: "card", type: "credit_card", current_balance: 300 }
];
const tx = (o) => Object.assign({ id: `t${Math.random().toString(36).slice(2, 8)}`, account_id: "checking", resolved_category: "Uncategorized", override_label: null }, o);

function openModal(modal) {
  SettingStub.texts = [];
  SettingStub.buttons = [];
  modal.open();
  const fields = {};
  SettingStub.texts.forEach((t) => { if (t.settingName && !fields[t.settingName]) fields[t.settingName] = t; });
  const find = (n, pred, out = []) => { if (pred(n)) out.push(n); (n.children || []).forEach((c) => find(c, pred, out)); return out; };
  const rows = () => find(modal.contentEl, (n) => n.classes && n.classes.has("budget-deposit-row"));
  const radio = (row) => row.children.find((c) => c.tag === "radio");
  return {
    modal, fields, buttons: SettingStub.buttons.slice(), rows,
    rowText: () => rows().map((r) => allText(r).replace(/\s+/g, " ").trim()),
    checked: () => rows().map((r) => radio(r).checked),
    chosen: () => rows().map((r) => r.classes.has("budget-apply-chosen")),
    pick: (i) => { const r = radio(rows()[i]); r.checked = true; r.onchange(); }
  };
}
const type = (t, v) => { t.inputEl.value = v; t.inputEl.dispatchEvent({ type: "input" }); };
const press = (buttons, label) => buttons.find((x) => x.label === label).cb();

(async () => {
// ===========================================================================
console.log("\n1. Which deposits are offered");
{
  const sched = { cadence: "biweekly", anchor_date: D(0) }; // payday today
  const txs = [
    tx({ id: "pay-now", date: D(0), merchant_raw: "ACME FOODS PAYROLL", amount: 1748.95 }),
    tx({ id: "early", date: D(-2), merchant_raw: "ZELLE FROM MOM", amount: 40 }),
    tx({ id: "too-early", date: D(-4), merchant_raw: "REFUND", amount: 12 }),
    tx({ id: "last-pay", date: D(-14), merchant_raw: "ACME FOODS PAYROLL", amount: 1702.1, resolved_category: "Paycheck" }),
    tx({ id: "savings-in", date: D(0), amount: 200, account_id: "savings" }),
    tx({ id: "card-pay", date: D(0), amount: 300, account_id: "card" }),
    tx({ id: "transfer", date: D(0), amount: 75, resolved_category: "Transfer" }),
    tx({ id: "spend", date: D(0), amount: -20 }),
    tx({ id: "undated", amount: 99, pending: true })
  ];
  const ids = (list) => list.map((t) => t.id);
  let got = H.paycheckDepositCandidates(txs, ACCOUNTS, { schedule: sched, todayStr: T });
  check("this period's deposits into checking, newest first", ids(got), ["pay-now", "early"]);
  check("last period's paycheck isn't offered", got.some((t) => t.id === "last-pay"), false);
  check("from three days before the period began (early direct deposit)",
    ids(H.paycheckDepositCandidates([tx({ id: "e3", date: D(-3), amount: 5 })], ACCOUNTS, { schedule: sched, todayStr: T })), ["e3"]);
  check("savings, card and already-filed rows are left out", ["savings-in", "card-pay", "transfer", "spend"].some((i) => ids(got).includes(i)), false);

  const mid = { cadence: "biweekly", anchor_date: D(-5) }; // period began 5 days ago
  got = H.paycheckDepositCandidates(txs, ACCOUNTS, { schedule: mid, todayStr: T });
  check("mid-period, the window starts before the period's payday", ids(got), ["pay-now", "early", "too-early"]);

  got = H.paycheckDepositCandidates(txs, ACCOUNTS, { schedule: null, todayStr: T });
  check("no schedule: the last two weeks", ids(got), ["pay-now", "early", "too-early"]);
  check("capped at three", H.paycheckDepositCandidates(
    [1, 2, 3, 4, 5].map((n) => tx({ id: `d${n}`, date: D(-n), amount: n })), ACCOUNTS, { todayStr: T }).length, 3);
  check("already filed as Paycheck is offered (it may be this one)",
    ids(H.paycheckDepositCandidates([tx({ id: "p", date: D(0), amount: 10, resolved_category: "Paycheck" })], ACCOUNTS, { todayStr: T })), ["p"]);
  check("with no checking account set up, any account", ids(H.paycheckDepositCandidates(txs, [], { todayStr: T })).includes("savings-in"), true);
}

// ===========================================================================
console.log("\n2. Nothing is chosen for you unless it's already a paycheck");
{
  const deposits = [
    tx({ id: "refund", date: D(0), merchant_raw: "AMAZON REFUND", amount: 23.4 }),
    tx({ id: "pay", date: D(-1), merchant_raw: "ACME FOODS PAYROLL", amount: 1748.95 })
  ];
  const detected = { amount: 1702.1, date: D(-14), merchant_raw: "ACME FOODS PAYROLL" };
  let got = null;
  const m = openModal(new H.PaycheckModal({}, (r) => (got = r), { recentDeposits: deposits, detectedPaycheck: detected, scheduledNextPayday: D(14) }));
  check("the deposits and a way out", m.rowText(), ["AMAZON REFUND " + D(0) + " Uncategorized +$23.40", "ACME FOODS PAYROLL " + D(-1) + " Uncategorized +$1748.95", "None of these"]);
  check("none picked: the newest deposit is a refund", m.checked(), [false, false, true]);
  check("the amount comes from the last paycheck, as before", m.fields["Paycheck amount"].inputEl.value, "1702.10");
  check("with the hint saying so", allText(m.modal.contentEl).includes(`Auto-filled from your most recent Paycheck transaction: $1702.10 on ${D(-14)}`), true);
  check("they're radio buttons, so they work from the keyboard", m.rows().map((r) => r.tag), ["label", "label", "label"]);
  const hintShown = (mm) => { const find = (n) => (n.classes && n.classes.has("budget-autodetect-hint") ? n : (n.children || []).map(find).find(Boolean)); const h = find(mm.modal.contentEl); return !!h && h.style.display !== "none"; };
  m.pick(1);
  check("picking a deposit hides the last-paycheck hint it replaces", hintShown(m), false);
  m.pick(2);
  check("None of these brings it back", hintShown(m), true);
  press(m.buttons, "Calculate");
  check("submitting without picking labels nothing", got && got.deposit, null);

  const m2 = openModal(new H.PaycheckModal({}, () => {}, {
    recentDeposits: [tx({ id: "p", date: D(0), merchant_raw: "ACME FOODS PAYROLL", amount: 1748.95, resolved_category: "Paycheck" })],
    detectedPaycheck: detected
  }));
  check("a deposit already filed as Paycheck is picked", m2.checked(), [true, false]);
  check("and fills the amount", m2.fields["Paycheck amount"].inputEl.value, "1748.95");
  check("with no auto-fill hint to contradict it", hintShown(m2), false);
}

// ===========================================================================
console.log("\n3. Picking, changing your mind, and typing");
{
  const deposits = [
    tx({ id: "pay", date: D(0), merchant_raw: "ACME FOODS PAYROLL", amount: 1748.95 }),
    tx({ id: "zelle", date: D(-1), merchant_raw: "ZELLE FROM MOM", amount: 40 })
  ];
  const detected = { amount: 1702.1, date: D(-14), merchant_raw: "ACME FOODS PAYROLL" };
  let got = null;
  const m = openModal(new H.PaycheckModal({}, (r) => (got = r), { recentDeposits: deposits, detectedPaycheck: detected, scheduledNextPayday: D(14) }));
  const amt = m.fields["Paycheck amount"];
  m.pick(0);
  check("picking a deposit fills its amount", amt.inputEl.value, "1748.95");
  check("and marks it", [m.checked(), m.chosen()], [[true, false, false], [true, false, false]]);
  m.pick(1);
  check("picking another moves the mark", [m.checked(), amt.inputEl.value], [[false, true, false], "40.00"]);
  m.pick(0);
  type(amt, "1,748.95");
  check("the field tidying the same amount keeps the pick", m.checked(), [true, false, false]);
  type(amt, "1,700");
  check("a different typed amount drops it (commas read correctly)", m.checked(), [false, false, true]);
  press(m.buttons, "Calculate");
  check("so nothing is labelled", [got.deposit, got.paycheckAmount], [null, 1700]);

  const m3 = openModal(new H.PaycheckModal({}, (r) => (got = r), { recentDeposits: deposits, detectedPaycheck: detected, scheduledNextPayday: D(14) }));
  m3.pick(0);
  // The reset control is an icon button, so it has no label text.
  const reset = m3.buttons.find((b) => !b.label);
  reset.cb();
  check("Reset to the detected amount drops a pick it doesn't match", [m3.checked(), m3.fields["Paycheck amount"].inputEl.value], [[false, false, true], "1702.10"]);
  m3.pick(1);
  m3.pick(2);
  check("None of these clears it", m3.chosen(), [false, false, false]);

  const m4 = openModal(new H.PaycheckModal({}, (r) => (got = r), { recentDeposits: deposits, scheduledNextPayday: D(14) }));
  m4.pick(0);
  press(m4.buttons, "Calculate");
  check("a pick is submitted with the paycheck", [got.deposit && got.deposit.id, got.paycheckAmount], ["pay", 1748.95]);

  const m5 = openModal(new H.PaycheckModal({}, (r) => (got = r), { detectedPaycheck: detected, scheduledNextPayday: D(14) }));
  check("no deposits: the modal is as it was", [m5.rows().length, m5.fields["Paycheck amount"].inputEl.value, allText(m5.modal.contentEl).includes("Auto-filled")], [0, "1702.10", true]);
}

// ===========================================================================
console.log("\n4. Entering the paycheck files the deposit");
{
  const makeApp = (files) => {
    const store = {};
    Object.entries(files).forEach(([k, v]) => (store[k] = JSON.stringify(v)));
    return { _store: store, vault: { adapter: {
      exists: async (p) => p in store, read: async (p) => store[p], write: async (p, d) => { store[p] = d; },
      mkdir: async () => {}, list: async () => ({ files: [], folders: [] }) } } };
  };
  const read = (app, p) => JSON.parse(app._store[p]);
  const run = async (files, settings, submit) => {
    const app = makeApp(files);
    const p = Object.create(H.__PluginClass.prototype);
    let opened = null;
    Object.assign(p, {
      app, settings, lastPaycheckInputs: null,
      activateView: async () => {}, recalculate: async () => null, offerBufferSweep: async () => {}
    });
    const orig = H.PaycheckModal.prototype.open;
    H.PaycheckModal.prototype.open = function () { opened = this; };
    await p.promptEnterPaycheck();
    H.PaycheckModal.prototype.open = orig;
    global.__notices = [];
    if (submit) await opened.onSubmit(submit(opened.prefill));
    return { app, p, prefill: opened.prefill };
  };
  const ledger = [
    { id: "pay", date: D(0), merchant_raw: "ACME FOODS PAYROLL", amount: 1748.95, account_id: "checking", resolved_category: "Uncategorized", override_label: null },
    { id: "last", date: D(-14), merchant_raw: "ACME FOODS PAYROLL", amount: 1702.1, account_id: "checking", resolved_category: "Paycheck", override_label: "Paycheck" }
  ];
  const settings = { paySchedule: { cadence: "biweekly", anchor_date: D(0) } };
  const files = { [F.transactions]: ledger, [F.accounts]: ACCOUNTS, [F.rules]: [] };

  let r = await run(files, settings, null);
  check("this paycheck's deposit is offered", r.prefill.recentDeposits.map((t) => t.id), ["pay"]);
  check("the next payday comes from the pay schedule", r.prefill.scheduledNextPayday, D(14));
  check("which the modal names", r.prefill.scheduleLabel, "every 2 weeks");

  r = await run(files, settings, (pf) => ({ paycheckAmount: 1748.95, checkingBalance: 900, alreadyDeposited: true, nextPaydayStr: D(14), deposit: pf.recentDeposits[0] }));
  const row = read(r.app, F.transactions).find((t) => t.id === "pay");
  check("the picked deposit is filed as Paycheck, this transaction only", [row.override_label, row.resolved_category], ["Paycheck", "Paycheck"]);
  check("and says so", global.__notices.includes(`Filed the $1748.95 deposit on ${D(0)} as Paycheck.`), true);
  check("the paycheck is still entered", [r.p.lastPaycheckInputs.paycheckAmount, read(r.app, F.paycheckHistory).length], [1748.95, 1]);
  check("the rest of the ledger is untouched", read(r.app, F.transactions).find((t) => t.id === "last"), ledger[1]);

  r = await run(files, settings, (pf) => ({ paycheckAmount: 1748.95, checkingBalance: 900, alreadyDeposited: true, nextPaydayStr: D(14), deposit: null }));
  check("no pick, no label", read(r.app, F.transactions).find((t) => t.id === "pay").override_label, null);

  const filed = [Object.assign({}, ledger[0], { resolved_category: "Paycheck" }), ledger[1]];
  r = await run({ [F.transactions]: filed, [F.accounts]: ACCOUNTS, [F.rules]: [] }, settings,
    (pf) => ({ paycheckAmount: 1748.95, checkingBalance: 900, alreadyDeposited: true, nextPaydayStr: D(14), deposit: pf.recentDeposits[0] }));
  check("a deposit a rule already files as Paycheck isn't given an override", read(r.app, F.transactions)[0].override_label, null);

  r = await run(files, settings, (pf) => ({ paycheckAmount: 1748.95, checkingBalance: 900, alreadyDeposited: true, nextPaydayStr: D(14),
    deposit: Object.assign({}, pf.recentDeposits[0], { id: "gone", date: D(-40) }) }));
  check("a deposit that's gone meanwhile isn't guessed at", read(r.app, F.transactions).every((t) => t.id !== "pay" || t.override_label === null), true);
  check("the paycheck still goes in, and it says why nothing was labelled",
    [r.p.lastPaycheckInputs.paycheckAmount, global.__notices.some((n) => /Couldn't find that deposit/.test(n))], [1748.95, true]);

  // With no saved schedule, detection reads Paycheck-labelled deposits — so the
  // freshly filed one counts toward it.
  const noSched = [ledger[0], ledger[1], Object.assign({}, ledger[1], { id: "older", date: D(-28), amount: 1690 })];
  r = await run({ [F.transactions]: noSched, [F.accounts]: ACCOUNTS, [F.rules]: [] }, {},
    (pf) => ({ paycheckAmount: 1748.95, checkingBalance: 900, alreadyDeposited: true, nextPaydayStr: D(14), deposit: pf.recentDeposits[0] }));
  check("a detected schedule is labelled as detected", r.prefill.scheduleLabel, "every 2 weeks, detected from your paychecks");
  check("and the new paycheck starts the period today", r.p.lastPaycheckInputs.periodStartStr, T);
}

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
})().catch((e) => { console.error(e); process.exit(1); });
