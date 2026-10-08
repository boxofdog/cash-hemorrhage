// A row you typed in next to the bank's row for it: suggested, never merged on its own.
const H = require("./harness.js");
const { el, allText } = H;

let pass = 0, fail = 0;
function check(name, got, want) {
  const ok = JSON.stringify(got) === JSON.stringify(want);
  if (ok) { pass++; console.log(`  PASS  ${name}`); }
  else { fail++; console.log(`  FAIL  ${name}: got ${JSON.stringify(got)}, want ${JSON.stringify(want)}`); }
}
const find = (n, pred, out = []) => { if (pred(n)) out.push(n); (n.children || []).forEach((c) => find(c, pred, out)); return out; };
const byCls = (n, c) => find(n, (x) => x.classes && x.classes.has(c));
const buttons = (n) => find(n, (x) => x.tag === "button");
const text = (n) => allText(n).replace(/\s+/g, " ").trim();
const F = H.FILES;

const tx = (id, date, amount, merchant, extra = {}) => Object.assign({ id, date, amount, merchant_raw: merchant, account_id: "chk", resolved_category: "Gas" }, extra);

(async () => {
console.log("\n1. Which pairs are suggested");
{
  const ledger = [
    tx("m1", "2026-10-02", -40.25, "Shell", { manual: true, override_label: "Fuel" }),
    tx("b1", "2026-10-03", -40.25, "SHELL OIL 123"),
    tx("b2", "2026-10-03", -40.26, "SHELL OIL 123"),
    tx("b3", "2026-10-08", -40.25, "SHELL OIL 123"),
    tx("b4", "2026-10-03", -40.25, "SHELL OIL 123", { account_id: "sav" }),
    tx("b5", "2026-10-03", -40.25, "SHELL OIL 123", { pending: true })
  ];
  const c = H.manualDuplicateCandidates(ledger);
  check("same account, same amount to the cent, a day apart", c.map((x) => [x.manual.id, x.bank.id]), [["m1", "b1"]]);
  check("another cent, another account, five days off, or pending: not suggested", c.length, 1);
  check("two typed rows are never each other's match", H.manualDuplicateCandidates([tx("m1", "2026-10-02", -5, "A", { manual: true }), tx("m2", "2026-10-02", -5, "B", { manual: true })]), []);
  check("each row is offered once, nearest first", H.manualDuplicateCandidates([
    tx("m1", "2026-10-02", -9, "Coffee", { manual: true }), tx("m2", "2026-10-05", -9, "Coffee", { manual: true }),
    tx("b1", "2026-10-05", -9, "COFFEE SHOP"), tx("b2", "2026-10-02", -9, "COFFEE SHOP")]).map((x) => [x.manual.id, x.bank.id]).sort(), [["m1", "b2"], ["m2", "b1"]]);
  check("Not the same keeps them from coming back", H.manualDuplicateCandidates(ledger.map((t) => (t.id === "m1" ? Object.assign({}, t, { not_duplicate_with: ["b1"] }) : t))).length, 0);
}

console.log("\n2. Merging");
{
  const ledger = [
    tx("m1", "2026-10-02", -40.25, "Shell", { manual: true, override_label: "Fuel", transfer_pair: "x1" }),
    tx("b1", "2026-10-03", -40.25, "SHELL OIL 123", { simplefin_id: "S1", simplefin_account: "A" }),
    tx("x1", "2026-10-02", 40.25, "Other", { account_id: "sav", transfer_pair: "m1" })
  ];
  const r = H.mergeManualIntoBank(ledger, "m1", "b1");
  const by = Object.fromEntries(r.transactions.map((t) => [t.id, t]));
  check("the typed row goes and the bank's stays, ids and all", [r.ok, Object.keys(by).sort(), by.b1.simplefin_id, by.b1.merchant_raw, by.b1.date], [true, ["b1", "x1"], "S1", "SHELL OIL 123", "2026-10-03"]);
  check("your category carries over", by.b1.override_label, "Fuel");
  check("a transfer pairing follows it", [by.b1.transfer_pair, by.x1.transfer_pair], ["x1", "b1"]);
  check("its payment links are pointed at the bank's row", r.relink, [{ from: "m1", to: "b1", date: "2026-10-03" }]);
  check("the bank's own category isn't overwritten", H.mergeManualIntoBank([ledger[0], Object.assign({}, ledger[1], { override_label: "Gas" })], "m1", "b1").transactions[0].override_label, "Gas");
  check("it won't merge the wrong way round, or two typed rows", [H.mergeManualIntoBank(ledger, "b1", "m1").ok, H.mergeManualIntoBank([ledger[0], Object.assign({}, ledger[0], { id: "m2" })], "m1", "m2").ok], [false, false]);
  check("and leaves the original untouched", ledger.length, 3);
}

console.log("\n3. Sync no longer claims a typed row");
{
  const existing = [tx("m1", "2026-10-02", -40.25, "Shell", { manual: true })];
  const incoming = [tx("n1", "2026-10-03", -40.25, "SHELL OIL 123", { simplefin_id: "S1", simplefin_account: "A", simplefin_posted: "2026-10-03" })];
  const r = H.mergeSimpleFINTransactions(existing, incoming);
  check("both rows are kept, nothing claimed", [r.merged.length, r.claimed, r.merged.find((t) => t.id === "m1").simplefin_id], [2, 0, undefined]);
  check("and now the pair is suggested", H.manualDuplicateCandidates(r.merged).length, 1);
  const plain = [tx("c1", "2026-10-02", -40.25, "Shell")];
  check("an ordinary CSV row is still claimed", H.mergeSimpleFINTransactions(plain, incoming).claimed, 1);
}

console.log("\n4. The plugin: merge and dismiss");
{
  const store = {
    [F.transactions]: JSON.stringify([tx("m1", "2026-10-02", -40.25, "Shell", { manual: true }), tx("b1", "2026-10-03", -40.25, "SHELL OIL 123")]),
    [F.installmentDebts]: JSON.stringify([{ id: "d1", applied_payments: [{ tx_id: "m1", amount: 40.25 }] }]),
    [F.revolvingDebts]: "[]", [F.fixedExpenses]: "[]", [F.savingsGoals]: "[]"
  };
  const app = { vault: { adapter: { exists: async (p) => p in store, read: async (p) => store[p], write: async (p, d) => { store[p] = d; } } } };
  const plugin = Object.create(H.__PluginClass.prototype);
  plugin.app = app;
  const before = store[F.transactions];
  await plugin.dismissManualDuplicate("m1", "b1");
  const dismissed = JSON.parse(store[F.transactions]);
  check("Not the same marks both, and nothing else", [dismissed.length, dismissed[0].not_duplicate_with, dismissed[1].not_duplicate_with], [2, ["b1"], ["m1"]]);
  check("and they stop being suggested", H.manualDuplicateCandidates(dismissed).length, 0);
  store[F.transactions] = before;
  check("Same purchase merges", await plugin.mergeManualDuplicate("m1", "b1"), true);
  check("one row left, the bank's", JSON.parse(store[F.transactions]).map((t) => t.id), ["b1"]);
  check("the debt's payment link follows", JSON.parse(store[F.installmentDebts])[0].applied_payments[0].tx_id, "b1");
  check("a stale pair does nothing", await plugin.mergeManualDuplicate("m1", "b1"), false);
}

console.log("\n5. The notice on the Transactions tab");
{
  const ledger = [tx("m1", "2026-10-02", -40.25, "Shell", { manual: true }), tx("b1", "2026-10-03", -40.25, "SHELL OIL 123", { resolved_category: "Uncategorized" })];
  const v = Object.create(H.BudgetDashboardView.prototype);
  const calls = [];
  Object.assign(v, { app: {}, scrollMemory: {}, sectionOpen: {}, plugin: { mergeManualDuplicate: async (a, b) => calls.push(["merge", a, b]), dismissManualDuplicate: async (a, b) => calls.push(["dismiss", a, b]), refreshAfterDataChange: async () => {} } });
  let labelled = null;
  v.renderLabelInbox = (c, list) => (labelled = list.map((t) => t.id));
  v.renderRecentTransactions = () => {};
  const root = el("div");
  await v.renderTransactions(root, { allTx: ledger, accounts: [{ id: "chk", institution: "Cal Coast" }], rules: [], existingLabels: [] });
  const t = text(root);
  check("it says how many, shows both and where each came from", [t.includes("1 possible duplicate to review"), t.includes("added by you"), t.includes("from the bank")], [true, true, true]);
  check("the bank's row waits to be labelled until you've answered", labelled, null);
  const btns = buttons(root).map((b) => b._text);
  check("two buttons", btns.filter((x) => x === "Same purchase" || x === "Not the same"), ["Same purchase", "Not the same"]);
  await buttons(root).find((b) => b._text === "Same purchase").onclick();
  await buttons(root).find((b) => b._text === "Not the same").onclick();
  check("each does its thing", calls, [["merge", "m1", "b1"], ["dismiss", "m1", "b1"]]);
  const none = el("div");
  labelled = null;
  await v.renderTransactions(none, { allTx: [ledger[1]], accounts: [], rules: [], existingLabels: [] });
  check("with no typed row there's no notice, and the label queue is unchanged", [text(none).includes("duplicate"), labelled], [false, ["b1"]]);
}

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
})().catch((e) => { console.error(e); process.exit(1); });
