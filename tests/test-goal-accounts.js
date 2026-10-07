// 1.24.0 — Savings goals linked to a savings account: which transfers go to
// which goal, what assigning one does, and the Savings tab's inbox and rows.
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

const T = H.todayLocal();
const D = (n) => H.addDays(T, n);
const SAV = "Personal Savings";
const HYSA = "Ally HYSA";
const tx = (id, date, amount, account = SAV, o = {}) => Object.assign({ id, date, amount, account_id: account, merchant_raw: amount > 0 ? "Transfer from Savings 00" : "Transfer to Savings 00", resolved_category: "Uncategorized" }, o);
const goal = (id, name, o = {}) => Object.assign({ id, name, target_amount: 1000, saved_amount: 0, contributions: [] }, o);
const q = (txs, goals) => {
  const r = H.goalTransferQueue(txs, goals);
  return { auto: r.auto.map((a) => [a.tx.id, a.goalId, a.contributionId]), ask: r.ask.map((a) => [a.tx.id, a.goalIds, a.suggested]) };
};

(async () => {
// ===========================================================================
console.log("\n1. Which transfers go where");
{
  check("no goal follows an account: nothing to do", q([tx("t1", D(-1), 100)], [goal("a", "Trip")]), { auto: [], ask: [] });

  const one = [goal("a", "Trip", { account_id: SAV, track_from: D(-10) })];
  check("one goal on the account: its transfers go to it on their own",
    q([tx("t1", D(-3), 100), tx("t2", D(-1), -40)], one), { auto: [["t1", "a", null], ["t2", "a", null]], ask: [] });
  check("before it started counting: left alone", q([tx("old", D(-11), 500)], one), { auto: [], ask: [] });
  check("the start date itself counts", q([tx("t0", D(-10), 5)], one).auto.length, 1);
  check("another account's rows aren't its", q([tx("chk", D(-1), -100, "Main Checking")], one), { auto: [], ask: [] });
  check("pending, undated, zero: left alone",
    q([tx("p", D(-1), 100, SAV, { pending: true }), tx("u", "", 100), tx("z", D(-1), 0)], one), { auto: [], ask: [] });
  check("marked not for a goal: left alone", q([tx("s", D(-1), 100, SAV, { goal_skip: true })], one), { auto: [], ask: [] });
  check("an undone assignment is asked about, even with one goal", q([tx("r", D(-1), 100, SAV, { goal_review: true })], one), { auto: [], ask: [["r", ["a"], []]] });
  check("no start date: everything on the account counts", q([tx("t1", "2020-01-01", 100)], [goal("a", "Trip", { account_id: SAV })]).auto.length, 1);

  const two = [goal("a", "Trip", { account_id: SAV }), goal("b", "Car", { account_id: SAV }), goal("c", "Elsewhere", { account_id: HYSA })];
  check("two goals on one account: you're asked, oldest first, with only that account's goals",
    q([tx("t2", D(-1), 50), tx("t1", D(-4), 100)], two), { auto: [], ask: [["t1", ["a", "b"], []], ["t2", ["a", "b"], []]] });
  check("the other account's single goal still goes on its own",
    q([tx("h1", D(-2), 75, HYSA)], two), { auto: [["h1", "c", null]], ask: [] });

  const staggered = [goal("a", "Trip", { account_id: SAV, track_from: D(-20) }), goal("b", "Car", { account_id: SAV, track_from: D(-5) })];
  check("before the second goal started, the first is the only one it could be",
    q([tx("t1", D(-8), 100), tx("t2", D(-2), 100)], staggered), { auto: [["t1", "a", null]], ask: [["t2", ["a", "b"], []]] });

  const capped = [{ id: "f", kind: "capped", name: "Oopsie", target_amount: 1000, account_id: SAV }];
  check("a capped fund's account isn't a goal's", q([tx("t1", D(-1), 100)], capped), { auto: [], ask: [] });
}

// ===========================================================================
console.log("\n2. Contributions you logged yourself");
{
  const logged = (id, amount, date, o = {}) => Object.assign({ id, date, amount, note: null, linked_tx_id: null }, o);
  const goals = () => [
    goal("a", "Trip", { account_id: SAV, saved_amount: 100, contributions: [logged("ca", 100, D(-3))] }),
    goal("b", "Car", { account_id: SAV })
  ];
  check("only one goal logged this amount: the transfer is that contribution",
    q([tx("t1", D(-1), 100)], goals()), { auto: [["t1", "a", "ca"]], ask: [] });
  check("a different amount: asked", q([tx("t1", D(-1), 120)], goals()).ask.map((a) => a[0]), ["t1"]);
  check("logged more than a week apart: asked",
    q([tx("t1", D(-1), 100)], [goal("a", "Trip", { account_id: SAV, contributions: [logged("ca", 100, D(-9))] }), goal("b", "Car", { account_id: SAV })]).ask.length, 1);
  check("one contribution settles one transfer, the earlier one", q([tx("t2", D(-1), 100), tx("t1", D(-2), 100)], goals()),
    { auto: [["t1", "a", "ca"]], ask: [["t2", ["a", "b"], []]] });
  const both = goals();
  both[1].contributions = [logged("cb", 100, D(-2))];
  check("both logged it: asked, both suggested", q([tx("t1", D(-1), 100)], both), { auto: [], ask: [["t1", ["a", "b"], ["a", "b"]]] });
  check("a withdrawal matches a logged withdrawal",
    q([tx("w", D(-1), -60)], [goal("a", "Trip", { account_id: SAV, contributions: [logged("cw", -60, D(-1))] }), goal("b", "Car", { account_id: SAV })]).auto,
    [["w", "a", "cw"]]);
  check("an undone one is asked even when a contribution matches", q([tx("t1", D(-1), 100, SAV, { goal_review: true })], goals()).ask, [["t1", ["a", "b"], ["a"]]]);
}

// ===========================================================================
console.log("\n3. Already counted");
{
  const matched = [
    goal("a", "Trip", { account_id: SAV, saved_amount: 100, contributions: [{ id: "c1", date: D(-4), amount: 100, linked_tx_id: "chk1", linked_tx_date: D(-4) }] }),
    goal("b", "Car", { account_id: SAV })
  ];
  const chk = tx("chk1", D(-4), -100, "Main Checking", { resolved_category: "Savings" });
  check("the savings side of a transfer whose checking side you matched by hand isn't counted again",
    q([chk, tx("sv1", D(-3), 100)], matched), { auto: [], ask: [] });
  check("…only within a few days of it", q([chk, tx("sv1", D(0), 100)], matched).ask.map((a) => a[0]), ["sv1"]);
  check("…and only the one row", q([chk, tx("sv1", D(-3), 100), tx("sv2", D(-3), 100)], matched).ask.map((a) => a[0]), ["sv2"]);
  const linkedHere = [goal("a", "Trip", { account_id: SAV, contributions: [{ id: "c1", date: D(-1), amount: 100, linked_tx_id: "sv1" }] }), goal("b", "Car", { account_id: SAV })];
  check("a row a contribution already links isn't offered", q([tx("sv1", D(-1), 100)], linkedHere), { auto: [], ask: [] });
  const onOther = [goal("x", "Old goal", { contributions: [{ id: "c1", date: D(-1), amount: 100, linked_tx_id: "sv1" }] }), goal("a", "Trip", { account_id: SAV })];
  check("…whichever goal links it", q([tx("sv1", D(-1), 100)], onOther), { auto: [], ask: [] });
}

// ===========================================================================
console.log("\n4. Assigning");
{
  let goals = [goal("a", "Trip", { account_id: SAV, saved_amount: 200 }), goal("b", "Car", { account_id: SAV })];
  const t1 = tx("t1", D(-2), 150);
  const r = H.assignGoalTransfer(goals, t1, "a");
  check("a new contribution, linked, from the account", [r.matched, r.contribution.date, r.contribution.amount, r.contribution.linked_tx_id, r.contribution.source], [false, D(-2), 150, "t1", "account"]);
  check("adds to the goal", goals[0].saved_amount, 350);
  H.assignGoalTransfer(goals, tx("t2", D(-1), -80), "a");
  check("money taken out comes off it", goals[0].saved_amount, 270);
  check("the other goal untouched", [goals[1].saved_amount, goals[1].contributions.length], [0, 0]);
  check("not held back from free cash: the money's already left checking", H.earmarkedSavings(goals), 0);
  check("counts as this period's move toward the goal", H.goalMovesThisPeriod(goals, D(-7), D(7)), { a: 70 });

  goals = [goal("a", "Trip", { account_id: SAV, saved_amount: 100, contributions: [{ id: "ca", date: D(-3), amount: 100, note: "paycheck", linked_tx_id: null }] })];
  check("before: the logged contribution is held back", H.earmarkedSavings(goals), 100);
  const m = H.assignGoalTransfer(goals, tx("t1", D(-1), 100), "a");
  check("the contribution you logged is linked instead of adding again", [m.matched, goals[0].saved_amount, goals[0].contributions.length, goals[0].contributions[0].linked_tx_id], [true, 100, 1, "t1"]);
  check("…and stops being held back", H.earmarkedSavings(goals), 0);
  goals = [goal("a", "Trip", { contributions: [{ id: "c1", date: D(-1), amount: 100, linked_tx_id: null }, { id: "c2", date: D(-1), amount: 100, linked_tx_id: null }] })];
  H.assignGoalTransfer(goals, tx("t1", D(-1), 100), "a", "c2");
  check("the contribution named is the one linked", goals[0].contributions.map((c) => c.linked_tx_id), [null, "t1"]);
  check("a capped fund can't be assigned to", H.assignGoalTransfer([{ id: "f", kind: "capped", name: "Oopsie" }], tx("t1", D(-1), 1), "f"), null);
  check("nor a goal that's gone", H.assignGoalTransfer([], tx("t1", D(-1), 1), "a"), null);

  const row = tx("t1", D(-1), 100, SAV, { goal_review: true });
  H.fileGoalTransferRow(row, "Savings");
  check("an unfiled row is filed as a transfer, its flags cleared", [row.override_label, row.resolved_category, row.goal_review], ["Savings", "Savings", undefined]);
  const mine = tx("t2", D(-1), 0.42, SAV, { override_label: "Interest", resolved_category: "Interest" });
  H.fileGoalTransferRow(mine, "Savings");
  check("one you've filed yourself keeps its category", mine.resolved_category, "Interest");
}

// ===========================================================================
console.log("\n5. Which accounts a goal can follow");
{
  const accounts = [
    { id: "Main Checking", type: "checking", institution: "Credit Union" },
    { id: SAV, type: "savings", institution: "Cal Coast — Personal Savings" },
    { id: HYSA, type: "savings", institution: "Ally" },
    { id: "Card", type: "credit_card" }
  ];
  const goals = [{ id: "f", kind: "capped", name: "Oopsie", account_id: SAV }, goal("a", "Trip", { account_id: HYSA }), goal("b", "Car")];
  check("savings accounts, not checking, a card, or a capped fund's", H.goalAccountChoices(accounts, goals).map((c) => [c.id, c.label, c.others]), [[HYSA, "Ally", ["Trip"]]]);
  check("editing a goal doesn't list it as sharing with itself", H.goalAccountChoices(accounts, goals, goals[1]).map((c) => c.others), [[]]);
}

// ===========================================================================
console.log("\n6. The plugin: imports, answers, undoing");
{
  const F = H.FILES;
  function makeApp(files = {}) {
    const store = {};
    Object.entries(files).forEach(([k, v]) => (store[k] = JSON.stringify(v)));
    return { _store: store, vault: { adapter: { exists: async (p) => p in store, read: async (p) => store[p], write: async (p, d) => { store[p] = d; }, mkdir: async () => {} } } };
  }
  const read = (app, p) => JSON.parse(app._store[p]);
  const plugin = (app) => Object.assign(Object.create(H.__PluginClass.prototype), { app, settings: {}, async refreshAfterDataChange() {} });

  const goals = [goal("a", "Trip", { account_id: SAV, saved_amount: 10 }), goal("b", "Car", { account_id: HYSA })];
  let app = makeApp({ [F.savingsGoals]: goals, [F.categories]: [{ name: "Groceries" }] });
  let p = plugin(app);
  const ledger = [tx("t1", D(-2), 100), tx("h1", D(-1), 40, HYSA), tx("chk", D(-2), -100, "Main Checking")];
  check("an import puts each transfer on its goal", await p.assignGoalTransfersIn(ledger), 2);
  let saved = read(app, F.savingsGoals);
  check("the goals are written", saved.map((g) => [g.id, g.saved_amount, g.contributions.map((c) => c.linked_tx_id)]), [["a", 110, ["t1"]], ["b", 40, ["h1"]]]);
  check("the rows are filed as a transfer, for the caller to write", ledger.map((t) => t.resolved_category), ["Savings", "Savings", "Uncategorized"]);
  check("…under a category that counts as a transfer", read(app, F.categories).find((c) => c.name === "Savings").is_transfer, true);
  check("run again, nothing more", await p.assignGoalTransfersIn(ledger), 0);

  const shared = [goal("a", "Trip", { account_id: SAV }), goal("b", "Car", { account_id: SAV })];
  app = makeApp({ [F.savingsGoals]: shared, [F.categories]: [], [F.transactions]: [tx("t1", D(-2), 100), tx("t2", D(-1), 0.35), tx("chk", D(-2), -100, "Main Checking")] });
  p = plugin(app);
  check("a shared account: nothing assigned on its own", await p.assignGoalTransfersNow(), 0);
  let done = await p.answerGoalTransfer("t1", "b");
  check("your answer puts it on that goal", [done.matched, read(app, F.savingsGoals).map((g) => g.saved_amount)], [false, [0, 100]]);
  check("…and files the row", read(app, F.transactions)[0].resolved_category, "Savings");
  done = await p.answerGoalTransfer("t2", null);
  check("not for a goal: marked, and no goal changes", [done.skipped, read(app, F.transactions)[1].goal_skip, read(app, F.savingsGoals).map((g) => g.saved_amount)], [true, true, [0, 100]]);
  check("nothing left to ask", H.goalTransferQueue(read(app, F.transactions), read(app, F.savingsGoals)).ask.length, 0);
  check("a transaction that's gone", await p.answerGoalTransfer("nope", "a"), null);

  // Undo: the contribution comes off, the transfer comes back to be asked.
  const cid = read(app, F.savingsGoals)[1].contributions[0].id;
  await H.deleteContribution(app, "b", cid);
  check("undoing flags the row for review", await p.releaseGoalTransfers(["t1", "not-a-row"]), 1);
  check("…so it's asked again, not reassigned", H.goalTransferQueue(read(app, F.transactions), read(app, F.savingsGoals)).ask.map((a) => a.tx.id), ["t1"]);
  await p.releaseGoalTransfers(["t1"], { skip: true });
  check("a deleted goal's transfers are marked not for a goal", [read(app, F.transactions)[0].goal_skip, read(app, F.transactions)[0].goal_review], [true, undefined]);
  check("rows outside goal accounts are left alone", [await p.releaseGoalTransfers(["chk"], { skip: true }), read(app, F.transactions)[2].goal_skip], [0, undefined]);
}

// ===========================================================================
console.log("\n7. The goal modal");
{
  function openModal(modal) {
    SettingStub.texts = [];
    SettingStub.buttons = [];
    SettingStub.dropdowns = [];
    modal.open();
    const fields = {};
    SettingStub.texts.forEach((t) => { if (t.settingName && !fields[t.settingName]) fields[t.settingName] = t; });
    return { modal, fields, buttons: SettingStub.buttons.slice(), dropdowns: SettingStub.dropdowns.slice() };
  }
  const type = (t, v) => { t.inputEl.value = v; t.inputEl.dispatchEvent({ type: "input" }); };
  const press = (buttons, label) => buttons.find((b) => b.label === label).cb();
  const choices = [{ id: SAV, label: "Cal Coast — Personal Savings", others: ["Trip"] }];

  let got = null;
  let m = openModal(new H.SavingsGoalModal({}, (r) => (got = r)));
  check("no accounts to follow: no account setting", m.dropdowns.length, 0);
  type(m.fields["Goal name"], "Car");
  type(m.fields["Target amount"], "500");
  press(m.buttons, "Create goal");
  check("…and the goal follows none", [got.account_id, got.track_from], [null, null]);

  got = null;
  m = openModal(new H.SavingsGoalModal({}, (r) => (got = r), null, { accountChoices: choices }));
  const dd = m.dropdowns[0];
  check("the account setting: none, or each account, saying which goals share it", dd.options.map((o) => o.label), ["None — I'll log contributions myself", "Cal Coast — Personal Savings (also Trip)"]);
  check("the start date is hidden until an account is chosen", m.fields["Count transfers from"].setting.settingEl.classes.has("budget-hidden"), true);
  dd.choose(SAV);
  check("choosing one shows it, starting today", [m.fields["Count transfers from"].setting.settingEl.classes.has("budget-hidden"), m.fields["Count transfers from"].inputEl.value], [false, T]);
  type(m.fields["Goal name"], "Car");
  type(m.fields["Target amount"], "500");
  type(m.fields["Count transfers from"], "2026-08-01");
  press(m.buttons, "Create goal");
  check("saved with the account and start date", [got.account_id, got.track_from], [SAV, "2026-08-01"]);

  got = null;
  const existing = goal("a", "Trip", { account_id: SAV, track_from: "2026-07-01" });
  m = openModal(new H.SavingsGoalModal({}, (r) => (got = r), existing, { accountChoices: choices }));
  check("editing keeps its account and date", [m.dropdowns[0].value, m.fields["Count transfers from"].inputEl.value], [SAV, "2026-07-01"]);
  m.dropdowns[0].choose("");
  press(m.buttons, "Save changes");
  check("unlinking clears both", [got.account_id, got.track_from], [null, null]);

  got = null;
  m = openModal(new H.SavingsGoalModal({}, (r) => (got = r), goal("a", "Trip", { account_id: "Gone Savings", track_from: "2026-07-01" }), { accountChoices: choices }));
  check("an account that's gone still shows as chosen", [m.dropdowns[0].value, m.dropdowns[0].options[1].label], ["Gone Savings", "Gone Savings (no longer in your accounts)"]);
}

// ===========================================================================
console.log("\n8. The Savings tab");
{
  const accounts = [{ id: "Main Checking", type: "checking" }, { id: SAV, type: "savings", institution: "Cal Coast — Personal Savings" }];
  async function render(goals, txs) {
    const answers = [];
    const released = [];
    const v = Object.create(H.BudgetDashboardView.prototype);
    Object.assign(v, {
      app: {},
      plugin: {
        settings: {},
        async answerGoalTransfer(id, goalId) { answers.push([id, goalId]); return goalId ? { matched: false } : { skipped: true }; },
        async releaseGoalTransfers(ids, o) { released.push([ids, !!(o && o.skip)]); return ids.length; },
        async refreshAfterDataChange() {},
        promptCappedFund() {}
      },
      sectionOpen: {}, scrollMemory: {}, lastResult: null
    });
    v.render = () => {};
    const root = el("div");
    const ctx = { allTx: txs, rules: [], accounts, savingsGoals: goals, categoryMetaList: [], ownership: null };
    v.renderGoalsCard(root, ctx);
    return { root, answers, released };
  }
  const goals = [
    goal("a", "Trip", { account_id: SAV, track_from: "2026-01-01", contributions: [{ id: "ca", date: D(-2), amount: 100, linked_tx_id: null }], saved_amount: 100 }),
    goal("b", "Car", { account_id: SAV, track_from: "2026-01-01", contributions: [{ id: "cb", date: D(-5), amount: 40, linked_tx_id: "sv0", source: "account" }], saved_amount: 40 }),
    goal("c", "Chef's knife")
  ];
  const txs = [tx("sv0", D(-5), 40), tx("sv1", D(-1), 100), tx("sv2", D(-3), 25)];
  // sv1 matches Trip's logged $100 alone, so it's auto (the next sync does it): only sv2 is asked.
  let { root, answers } = await render(goals, txs);
  const inbox = byCls(root, "budget-goal-inbox")[0];
  check("the inbox says how many are waiting", text(byCls(inbox, "budget-inbox-text")[0]), "1 savings transfer needs a goal");
  const row = byCls(inbox, "budget-goal-inbox-row")[0];
  check("each shows what, when, where and how much", [text(byCls(row, "budget-recent-date")[0]), text(byCls(row, "budget-tx-amount")[0])], [`${D(-3)} · Cal Coast — Personal Savings`, "+$25.00"]);
  check("a button per goal on the account, then Not for a goal", buttonsIn(byCls(row, "budget-goal-inbox-btns")[0]).map((b) => b._text), ["Trip", "Car", "Not for a goal"]);
  await button(row, "Car").onclick();
  await button(row, "Not for a goal").onclick();
  check("pressing one answers it", answers, [["sv2", "b"], ["sv2", null]]);

  const both = clone(goals);
  both[1].contributions.push({ id: "cb2", date: D(-1), amount: 100, linked_tx_id: null });
  ({ root } = await render(both, txs));
  const likely = buttonsIn(byCls(root, "budget-goal-inbox-row")[0]).filter((b) => b.classes.has("mod-cta")).map((b) => b._text);
  check("goals you logged the amount to are marked as the likely ones", likely, ["Trip", "Car"]);

  ({ root } = await render([goal("a", "Trip", { account_id: SAV })], [tx("sv1", D(-1), 100, SAV, { goal_review: true })]));
  check("one goal, one undone transfer: still asked", byCls(root, "budget-goal-inbox").length, 1);
  ({ root } = await render([goal("c", "Chef's knife")], txs));
  check("nothing waiting: no inbox", byCls(root, "budget-goal-inbox").length, 0);

  let r = await render(goals, txs);
  const rows = byCls(r.root, "budget-goal-row");
  check("a linked goal says what it follows, in the same line as its pace", text(byCls(rows[0], "budget-goal-meta")[0]).includes(`follows Cal Coast — Personal Savings since ${H.formatShortDate("2026-01-01")}`), true);
  check("an unlinked one doesn't", text(byCls(rows[2], "budget-goal-meta")[0]).includes("follows"), false);
  check("no separate follows line", byCls(rows[0], "budget-goal-link").length, 0);
  const contrib = byCls(rows[1], "budget-contrib-row")[0];
  check("a transfer from the account is labelled so, with Unassign and no Remove",
    [text(byCls(contrib, "budget-badge")[0]), buttonsIn(contrib).map((b) => b._text)], ["transfer to savings", ["Unassign"]]);
  const logged = byCls(rows[0], "budget-contrib-row")[0];
  check("a contribution you logged keeps Match and Remove", buttonsIn(logged).map((b) => b._text), ["Match transaction", "Remove"]);
}

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
})().catch((e) => { console.error(e); process.exit(1); });
