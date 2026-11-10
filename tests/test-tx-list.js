// The Transactions list (Recent, All transactions, filters), and taking back what
// you dismissed, and removing a bad point from the debt chart.
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
const F = H.FILES;
const T = H.todayLocal();
const D = (n) => H.addDays(T, n);
let n = 0;
const tx = (date, amount, merchant, extra = {}) => Object.assign({ id: `t${++n}`, date, amount, merchant_raw: merchant, account_id: "chk", resolved_category: "Shopping" }, extra);

(async () => {
console.log("\n1. What the list shows");
{
  const ledger = [
    tx(D(-1), -5, "A"), tx(D(-3), 2000, "PAYROLL", { resolved_category: "Paycheck" }), tx(D(-10), -7, "B"), tx(D(-20), -9, "C"), tx(D(-45), -11, "D"), tx(D(-200), -13, "E"),
    tx(D(-2), -50, "CARD PAYMENT", { resolved_category: "Credit Card Payment" }),
    tx(D(-2), -100, "TO SAVINGS", { id: "p1", transfer_pair: "p2" }), tx(D(-2), 100, "FROM CHK", { id: "p2", transfer_pair: "p1", account_id: "sav" })
  ];
  const meta = [{ name: "Credit Card Payment", is_transfer: true }];
  const names = (o) => H.transactionListView(ledger, Object.assign({ categoryMeta: meta, todayStr: T }, o)).rows.map((t) => t.merchant_raw);
  check("recent: the newest few, confirmed transfer pairs left off", names({ limit: 4 }), ["A", "CARD PAYMENT", "PAYROLL", "B"]);
  check("recent, pairs asked for", names({ limit: 4, showPairs: true }), ["A", "CARD PAYMENT", "TO SAVINGS", "FROM CHK"]);
  check("all, two weeks: only what's inside it", names({ mode: "all", days: 14 }), ["A", "CARD PAYMENT", "PAYROLL", "B"]);
  check("all, a month", names({ mode: "all", days: 30 }), ["A", "CARD PAYMENT", "PAYROLL", "B", "C"]);
  check("all, a step at a time, then everything", [30, 60, 90, 180, 365].map((d) => names({ mode: "all", days: d }).length), [5, 6, 6, 6, 7]);
  check("the range is measured from today, edges included", H.transactionListView([tx(D(-14), -1, "EDGE"), tx(D(-15), -1, "JUST OUT")], { mode: "all", days: 14, todayStr: T }).rows.map((t) => t.merchant_raw), ["EDGE"]);
  check("money in", names({ mode: "all", days: 365, moneyIn: true }), ["PAYROLL"]);
  check("money in with pairs shown includes the incoming half", names({ mode: "all", days: 365, moneyIn: true, showPairs: true }), ["FROM CHK", "PAYROLL"]);
  check("hide transfers: pairs and transfer categories both go", names({ mode: "all", days: 365, hideTransfers: true }), ["A", "PAYROLL", "B", "C", "D", "E"]);
  check("hide transfers in recent too", names({ limit: 3, hideTransfers: true }), ["A", "PAYROLL", "B"]);
  check("hide transfers beats showing pairs", names({ mode: "all", days: 365, hideTransfers: true, showPairs: true }).includes("TO SAVINGS"), false);
  check("both filters together", names({ mode: "all", days: 365, moneyIn: true, hideTransfers: true }), ["PAYROLL"]);

  const v14 = H.transactionListView(ledger, { mode: "all", days: 14, categoryMeta: meta, todayStr: T });
  check("all: older exists, and the cutoff is today minus the range", [v14.hasOlder, v14.cutoff], [true, D(-14)]);
  check("all: pairs hidden within the range are counted", v14.hiddenPairs, 2);
  check("all, everything shown: nothing older", H.transactionListView(ledger, { mode: "all", days: 365, categoryMeta: meta, todayStr: T }).hasOlder, false);
  check("older that a filter hides doesn't count", H.transactionListView(ledger, { mode: "all", days: 14, moneyIn: true, categoryMeta: meta, todayStr: T }).hasOlder, false);
  check("recent: pairs hidden among the newest are counted", H.transactionListView(ledger, { limit: 4, categoryMeta: meta }).hiddenPairs, 2);
  check("undated bank holds are as new as anything", H.transactionListView([tx(D(-1), -5, "OLD"), tx(null, -3, "HOLD")], { mode: "all", days: 14, todayStr: T }).rows.map((t) => t.merchant_raw), ["HOLD", "OLD"]);
  const big = Array.from({ length: 300 }, (_, i) => tx(D(-1), -1 - i, `X${i}`));
  const bv = H.transactionListView(big, { mode: "all", days: 14, todayStr: T });
  check("a long range is capped, and says how many more", [bv.rows.length, bv.capped], [250, 50]);
  check("the range steps", [H.nextTxRange(14), H.nextTxRange(30), H.nextTxRange(365), H.nextTxRange(36500)], [30, 60, 36500, 36500]);
}

console.log("\n2. The screen");
{
  const mkView = (state = {}) => {
    const calls = [];
    const v = Object.create(H.BudgetDashboardView.prototype);
    Object.assign(v, { app: {}, sectionOpen: {}, scrollMemory: {}, plugin: { settings: {}, promptAddTransaction: () => calls.push("add"), refreshAfterDataChange: async () => {} } }, state);
    v.render = () => calls.push("render");
    return { v, calls };
  };
  const ledger = [tx(D(-1), -5, "A"), tx(D(-3), 2000, "PAYROLL", { resolved_category: "Paycheck" }), tx(D(-20), -9, "C"), tx(D(-200), -13, "E")];
  const draw = async (state, rows = ledger) => {
    const { v, calls } = mkView(state);
    const root = el("div");
    v.renderRecentTransactions(root, { allTx: rows, rules: [], categoryMetaList: [] });
    return { root, v, calls, card: byCls(root, "budget-recent-card")[0] };
  };
  const names = (r) => byCls(r.card, "budget-recent-name").map(text);
  let r = await draw({});
  check("by default it's the recent list", [text(byCls(r.card, "budget-collapsible-title")[0]), names(r)], ["Recent transactions", ["A", "PAYROLL", "C", "E"]]);
  check("with the switch, Manual Add and the two filters", [byCls(r.card, "budget-segment").map(text), !!button(r.card, "Manual Add"), byCls(r.card, "budget-filter-chip").map(text)], [["Recent", "All transactions"], true, ["Money in", "Hide transfers"]]);
  check("Recent is the one that's on", byCls(r.card, "budget-segment-on").map(text), ["Recent"]);
  button(r.card, "All transactions").onclick();
  check("choosing All starts it small", [r.v.txMode, r.v.txDays, r.calls.pop()], ["all", 14, "render"]);
  r = await draw({ txMode: "all", txDays: 14 });
  check("All is titled, and holds two weeks", [text(byCls(r.card, "budget-collapsible-title")[0]), names(r)], ["All transactions", ["A", "PAYROLL"]]);
  const range = byCls(r.card, "budget-tx-range")[0];
  check("it says how far back, and offers older", [/^Since /.test(text(range)), !!button(range, "Show older")], [true, true]);
  button(range, "Show older").onclick();
  check("Show older goes back a step", r.v.txDays, 30);
  r = await draw({ txMode: "all", txDays: 30 });
  check("a month holds the next one", names(r), ["A", "PAYROLL", "C"]);
  button(byCls(r.card, "budget-tx-range")[0], "Show older").onclick();
  r = await draw({ txMode: "all", txDays: 365 });
  check("a year holds everything here, and says so", [names(r), text(byCls(r.card, "budget-tx-range")[0]), !!button(r.card, "Show older")], [["A", "PAYROLL", "C", "E"], "That's everything.", false]);
  r = await draw({ txMode: "all", txDays: 36500 });
  check("the last step is everything", names(r).length, 4);
  r = await draw({ txMode: "all", txDays: 365, txMoneyIn: true });
  check("Money in shows only that, and is marked on", [names(r), byCls(r.card, "budget-filter-chip-on").map(text), button(r.card, "Money in").attrs["aria-pressed"]], [["PAYROLL"], ["Money in"], "true"]);
  button(r.card, "Money in").onclick();
  check("pressing it again turns it off", [r.v.txMoneyIn, r.calls.pop()], [false, "render"]);
  button(r.card, "Hide transfers").onclick();
  check("Hide transfers turns on", [r.v.txHideTransfers, r.calls.pop()], [true, "render"]);
  r = await draw({ txMoneyIn: true, txHideTransfers: false });
  check("the filters work in Recent too", names(r), ["PAYROLL"]);
  r = await draw({ txMoneyIn: true }, [tx(D(-1), -5, "A")]);
  check("a filter that leaves nothing says so", [names(r), text(r.card).includes("Nothing matches.")], [[], true]);
  r = await draw({}, []);
  check("no transactions at all says nothing yet", text(r.card).includes("Nothing yet."), true);
  r = await draw({ txMoneyIn: true, txMode: "recent", txDays: 14 });
  button(r.card, "Manual Add").onclick();
  check("Manual Add is still there", r.calls.pop(), "add");
  r = await draw({ txMode: "all", txDays: 90 });
  button(r.card, "Recent").onclick();
  check("switching back to Recent starts the next All small again", [r.v.txMode, r.v.txDays], ["recent", 14]);
}

console.log("\n3. Dismissed suggestions");
{
  const a = tx(D(-1), -20, "OUT", { id: "a", not_transfer_with: ["b"], not_duplicate_with: ["b"] });
  const b = tx(D(-1), 20, "IN", { id: "b", account_id: "sav", not_transfer_with: ["a"], not_duplicate_with: ["a"] });
  const c = tx(D(-2), -30, "AFFIRM", { id: "c", excluded_from_debt_payments: true });
  const d = tx(D(-3), -40, "KLARNA", { id: "d", debt_payment_review_status: "already_applied", debt_payment_debt_key: "k", debt_payment_reviewed_at: D(0) });
  const e = tx(D(-4), -5, "FINE", { id: "e" });
  const ledger = [a, b, c, d, e];
  const items = H.dismissedSuggestions(ledger);
  check("each dismissal is one item, a pair counted once", items.map((i) => [i.kind, i.ids.join("+"), i.why || null]), [["transfer", "a+b", null], ["duplicate", "a+b", null], ["payment", "c", "not a payment"], ["payment", "d", "already applied"]]);
  check("a dismissal whose other row is gone isn't listed", H.dismissedSuggestions([a, c]).map((i) => i.kind), ["payment"]);
  const after = (item) => H.bringBackDismissed(ledger, item);
  const t = after(items[0]);
  check("bringing back a transfer pair frees both rows, and leaves the duplicate dismissal", [t[0].not_transfer_with, t[1].not_transfer_with, t[0].not_duplicate_with], [undefined, undefined, ["b"]]);
  const dp = after(items[1]);
  check("and the other way round", [dp[0].not_duplicate_with, dp[0].not_transfer_with], [undefined, ["b"]]);
  check("a payment kept out comes back", after(items[2])[2].excluded_from_debt_payments, undefined);
  const ap = after(items[3])[3];
  check("so does one marked already applied, with its notes", [ap.debt_payment_review_status, ap.debt_payment_debt_key, ap.debt_payment_reviewed_at], [undefined, undefined, undefined]);
  check("nothing else is touched", [after(items[2])[4], ledger[2].excluded_from_debt_payments], [e, true]);
  check("once everything's back, nothing's listed", H.dismissedSuggestions(items.reduce((l, i) => H.bringBackDismissed(l, i), ledger)), []);

  const modal = new H.DismissedModal({}, items, [], async (item) => { ledger.splice(0, ledger.length, ...H.bringBackDismissed(ledger, item)); return H.dismissedSuggestions(ledger); });
  modal.onOpen();
  const heads = find(modal.contentEl, (x) => x.tag === "h4").map(text);
  check("grouped by kind", heads, ["Not transfers", "Not duplicates", "Kept out of debt payments"]);
  const rows = byCls(modal.contentEl, "budget-apply-row");
  check("each says what it is", [text(rows[0]).includes("OUT") && text(rows[0]).includes("IN"), text(rows[2]).includes("not a payment"), text(rows[3]).includes("already applied")], [true, true, true]);
  await button(rows[2], "Bring back").onclick();
  check("Bring back takes that one off the list and redraws", [byCls(modal.contentEl, "budget-apply-row").length, text(modal.contentEl).includes("AFFIRM")], [3, false]);
  const empty = new H.DismissedModal({}, [], [], async () => null);
  empty.onOpen();
  check("nothing dismissed says so", text(empty.contentEl).includes("Nothing dismissed."), true);

  // The settings row, and the plugin method.
  const store = { [F.transactions]: JSON.stringify([a, b, c]), [F.rules]: "[]" };
  const app = { vault: { adapter: { exists: async (p) => p in store, read: async (p) => store[p], write: async (p, d) => { store[p] = d; } } } };
  SettingStub.buttons = [];
  const tab = Object.create(H.BudgetSettingTab.prototype);
  tab.app = app;
  tab.plugin = { openDismissed: () => (tab.opened = true) };
  const root = el("div");
  await tab.renderDismissedSettings(root);
  check("Settings says how many, and has Review", [text(root), SettingStub.buttons.map((x) => x.label)], ["Dismissed suggestions 3 you said no to. Review", ["Review"]]);
  SettingStub.buttons[0].cb();
  check("Review opens the list", tab.opened, true);
  store[F.transactions] = JSON.stringify([e]);
  const tab2 = Object.create(H.BudgetSettingTab.prototype);
  tab2.app = app; tab2.plugin = {};
  const root2 = el("div");
  await tab2.renderDismissedSettings(root2);
  check("none dismissed says none", text(root2).includes("None."), true);

  const plugin = Object.create(H.__PluginClass.prototype);
  plugin.app = app;
  plugin.refreshAfterDataChange = async () => {};
  store[F.transactions] = JSON.stringify([a, b, c]);
  let opened = null;
  const orig = H.DismissedModal.prototype.open;
  H.DismissedModal.prototype.open = function () { opened = this; };
  await plugin.openDismissed();
  H.DismissedModal.prototype.open = orig;
  const left = await opened.onBringBack(opened.items[0]);
  check("through the plugin it writes the ledger and returns what's left", [left.length, JSON.parse(store[F.transactions])[0].not_transfer_with], [2, undefined]);
}

console.log("\n4. A bad point on the debt chart");
{
  const hist = [{ date: "2026-09-01", total_debt: 900 }, { date: "2026-09-10", total_debt: 99999 }, { date: T, total_debt: 800 }];
  const r = H.removeDebtHistoryPoint(hist, "2026-09-10");
  check("one day's point goes", [r.removed, r.history.map((h) => h.date)], [1, ["2026-09-01", T]]);
  check("a date that isn't there changes nothing", H.removeDebtHistoryPoint(hist, "2020-01-01").removed, 0);

  const store = { [F.debtHistory]: JSON.stringify(hist), [F.closedLoans]: "[]" };
  const app = { vault: { adapter: { exists: async (p) => p in store, read: async (p) => store[p], write: async (p, d) => { store[p] = d; } } } };
  const confirms = [];
  H.ConfirmModal.prototype.open = function () { confirms.push(this.opts); };
  const plugin = Object.create(H.__PluginClass.prototype);
  plugin.app = app;
  plugin.refreshAfterDataChange = async () => {};
  plugin.confirmRemoveDebtPoint(hist[1]);
  check("it asks first, naming the point", [confirms[0].title, confirms[0].body[0]], ["Remove this point?", "2026-09-10 · $99999.00"]);
  check("nothing's gone yet", JSON.parse(store[F.debtHistory]).length, 3);
  await confirms[0].onConfirm();
  check("then it is", JSON.parse(store[F.debtHistory]).map((h) => h.date), ["2026-09-01", T]);

  // On the Debts tab.
  const v = Object.create(H.BudgetDashboardView.prototype);
  const asked = [];
  Object.assign(v, { app, sectionOpen: {}, scrollMemory: {}, lastResult: null, plugin: { confirmRemoveDebtPoint: (p) => asked.push(p.date) } });
  store[F.debtHistory] = JSON.stringify(hist);
  const root = el("div");
  await v.renderDebts(root, { allTx: [], revolvingDebts: [], installmentDebts: [], allDebts: [], categoryMetaList: [], accounts: [], ownership: null, rules: [] });
  const box = byCls(root, "budget-debt-points")[0];
  check("saved points are listed newest first, today's without a Remove", [byCls(box, "budget-fixed-name").map(text), buttons(box).length], [[`${T} · today`, "2026-09-10", "2026-09-01"], 2]);
  buttons(box)[0].onclick();
  check("Remove asks about that one", asked, ["2026-09-10"]);
}

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
})().catch((e) => { console.error(e); process.exit(1); });
