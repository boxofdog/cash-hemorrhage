// 1.26.0 — Transfers between your own accounts: suggested, never assumed.
// Matching halves are offered for you to confirm; a confirmed pair is filed as
// a transfer and kept off the transaction list; a rejected pair never returns.
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
const F = H.FILES;
const T = H.todayLocal();
const D = (n) => H.addDays(T, n);

const tx = (id, date, amount, account, merchant, o = {}) => Object.assign({ id, date, amount, account_id: account, merchant_raw: merchant, resolved_category: "Uncategorized" }, o);
// The pair from the field: out of one Credit Union account, into another, same day.
const OUT = () => tx("out", D(-3), -1054.77, "Credit Union Savings", "To Savings 01", { resolved_category: "Savings" });
const IN = () => tx("in", D(-3), 1054.77, "Credit Union Checking", "From Savings 00");
const pairs = (txs) => H.transferCandidates(txs).map((c) => [c.out.id, c.in.id, c.likely]);

(async () => {
// ===========================================================================
console.log("\n1. What's suggested");
{
  check("the two halves of a move between accounts", pairs([OUT(), IN()]), [["out", "in", true]]);
  check("not within one account", pairs([OUT(), Object.assign(IN(), { account_id: "Credit Union Savings" })]), []);
  check("not two of the same sign", pairs([OUT(), Object.assign(IN(), { amount: -1054.77 })]), []);
  check("not a cent apart", pairs([OUT(), Object.assign(IN(), { amount: 1054.76 })]), []);
  check("up to five days apart", pairs([OUT(), Object.assign(IN(), { date: D(2) })]), [["out", "in", true]]);
  check("not six", pairs([OUT(), Object.assign(IN(), { date: D(3) })]), []);
  check("not pending, undated, or without an account",
    [pairs([OUT(), Object.assign(IN(), { pending: true })]), pairs([OUT(), Object.assign(IN(), { date: "" })]), pairs([OUT(), Object.assign(IN(), { account_id: null })])], [[], [], []]);
  const shop = tx("amzn", D(-3), -54, "Card", "AMAZON MKTPL*2K4");
  const dep = tx("dep", D(-2), 54, "Credit Union Checking", "From Savings 00");
  check("a purchase that happens to match is still offered — but not as likely", pairs([shop, dep]), [["amzn", "dep", false]]);
  const cardsKnown = (txs) => H.transferCandidates(txs, [{ id: "Card", type: "credit_card" }]).map((c) => [c.out.id, c.in.id]);
  check("a charge on a card isn't: that would be a cash advance, not a transfer", cardsKnown([shop, dep]), []);
  check("a payment into a card is", cardsKnown([tx("pay", D(-2), -300, "Credit Union Checking", "CAPITAL ONE ONLINE PMT"), tx("cr", D(-1), 300, "Card", "PAYMENT THANK YOU")]), [["pay", "cr"]]);
  check("likely only when both read like a transfer", pairs([tx("a", D(-1), -20, "X", "Online Transfer to SAV 01"), tx("b", D(-1), 20, "Y", "From Savings 00")]), [["a", "b", true]]);
  check("a Zelle payment never reads like one", pairs([tx("z", D(-1), -20, "X", "Zelle transfer to Savings 01"), tx("b", D(-1), 20, "Y", "From Savings 00")])[0][2], false);

  const near = tx("in2", D(-2), 1054.77, "Ally", "From Savings 00");
  check("one half, two candidates: the nearest date, each row offered once", pairs([OUT(), near, IN()]), [["out", "in", true]]);
  const other = tx("in3", D(-3), 1054.77, "Ally", "ATM DEPOSIT");
  check("an equal gap: the one that reads like a transfer", pairs([OUT(), other, IN()]), [["out", "in", true]]);
  const older = [tx("o1", D(-30), -10, "A", "To Savings 01"), tx("i1", D(-30), 10, "B", "From Savings 00")];
  check("newest first", pairs(older.concat([OUT(), IN()])).map((p) => p[0]), ["out", "o1"]);
}

// ===========================================================================
console.log("\n2. What isn't suggested again");
{
  const [o, i] = [OUT(), IN()];
  H.confirmTransferPair([o, i], "out", "in", "Savings");
  check("a confirmed pair", pairs([o, i]), []);
  const [o2, i2] = [Object.assign(OUT(), { not_transfer_with: ["in"] }), IN()];
  check("a pair you said isn't one", pairs([o2, i2]), []);
  const third = tx("in4", D(-3), 1054.77, "Ally", "From Savings 09");
  check("…though either can still pair with something else", pairs([o2, i2, third]), [["out", "in4", true]]);
  const single = Object.assign(IN(), { transfer_single: true, override_label: "Transfer", resolved_category: "Transfer" });
  check("a row you marked a transfer on its own is offered with its other half", pairs([OUT(), single]), [["out", "in", true]]);
  const fund = [{ id: "f", kind: "capped", name: "Oopsie", target_amount: 1000, account_id: "Sav" }];
  const rows = [tx("chk", D(-1), -100, "Checking", "To Savings 01", { resolved_category: "Savings", not_transfer_with: ["sav"] }), tx("sav", D(-1), 100, "Sav", "From Savings 00")];
  check("a capped fund's pairing respects it too", H.pairFundTransfers(rows, fund, [{ name: "Savings", is_transfer: true }]).length, 0);
}

// ===========================================================================
console.log("\n3. What a confirmed transfer is filed as");
{
  const cats = [{ name: "Savings", is_transfer: true }, { name: "Credit Card Payment", is_transfer: true }, { name: "Groceries" }];
  const accounts = [{ id: "Card", type: "credit_card" }, { id: "Chk", type: "checking" }];
  const cat = (rows, o = {}) => H.transferCategoryFor(rows, Object.assign({ accounts, categoryMeta: cats, revolvingDebts: [] }, o));
  check("a half already filed as a transfer: both take that", cat([OUT(), IN()]), { name: "Savings", create: false });
  check("neither: Transfer, created as a transfer", cat([tx("a", T, -5, "Chk", "x"), tx("b", T, 5, "Sav", "y")]), { name: "Transfer", create: true });
  check("money into a card is paying it", cat([tx("a", T, -5, "Chk", "x"), tx("b", T, 5, "Card", "y")]), { name: "Credit Card Payment", create: false });
  check("…under the card's own payment category", cat([tx("a", T, -5, "Chk", "x"), tx("b", T, 5, "Card", "y")], { revolvingDebts: [{ account_id: "Card", payment_category: "Chase Payment" }] }), { name: "Chase Payment", create: true });
  check("a debt's category isn't borrowed for a move between bank accounts", cat([tx("a", T, -5, "Chk", "x", { resolved_category: "Credit Card Payment" }), tx("b", T, 5, "Sav", "y")]).name, "Transfer");
  check("a Transfer category you use for spending is left alone", H.accountTransferCategory([{ name: "Transfer", is_transfer: false }]), { name: "Account Transfer", create: true });

  const o = Object.assign(OUT(), { override_label: "Savings" });
  const i = IN();
  const byId = () => new Map([[o.id, o], [i.id, i]]);
  check("confirming files both and pairs them", [H.confirmTransferPair([o, i], "out", "in", "Savings"), o.resolved_category, i.resolved_category, o.transfer_pair, i.transfer_pair], [true, "Savings", "Savings", "in", "out"]);
  check("both are kept off the list", [H.isHiddenTransfer(o, byId()), H.isHiddenTransfer(i, byId())], [true, true]);
  check("and neither is spending or income", [H.categorySpendTotals([o, i], [{ name: "Savings", is_transfer: true }]).totals, H.categoryIncomeTotals([o, i], [{ name: "Savings", is_transfer: true }]).totals], [{}, {}]);
  check("relabelling one half by hand ends the pair, and it's back on the list", (() => { i.override_label = "Paycheck"; i.resolved_category = "Paycheck"; return H.isHiddenTransfer(o, byId()); })(), false);
}

// ===========================================================================
console.log("\n4. Undoing one");
{
  const rules = [{ merchant_pattern: "Savings 01", home_label: "Savings" }];
  const o = Object.assign(OUT(), { resolved_category: "Savings" });
  const i = Object.assign(IN(), { override_label: "Misc Income", resolved_category: "Misc Income" });
  const ledger = [o, i];
  H.confirmTransferPair(ledger, "out", "in", "Savings");
  const back = H.undoTransfer(ledger, "in");
  H.applyCategorization(ledger, rules);
  check("both halves come back", back.map((r) => r.id).sort(), ["in", "out"]);
  check("labelled as they were: a hand label restored, a rule's recomputed", [i.override_label, i.resolved_category, "override_label" in o, o.resolved_category], ["Misc Income", "Misc Income", false, "Savings"]);
  check("unpaired, and not suggested together again", [o.transfer_pair, i.transfer_pair, pairs(ledger)], [undefined, undefined, []]);
  const fundPair = [tx("f1", T, -50, "Chk", "To Savings 01", { override_label: "Savings", resolved_category: "Savings", transfer_pair: "f2" }), tx("f2", T, 50, "Sav", "From Savings 00", { override_label: "Savings", resolved_category: "Savings", transfer_pair: "f1" })];
  H.undoTransfer(fundPair, "f1");
  check("a pair a capped fund filed keeps its label (there's no earlier one of yours)", fundPair.map((t) => t.override_label), ["Savings", "Savings"]);
  const single = [Object.assign(IN(), { transfer_single: true, transfer_prev_label: null, override_label: "Transfer", resolved_category: "Transfer" })];
  H.undoTransfer(single, "in");
  check("a single one comes back unlabelled", ["override_label" in single[0], single[0].transfer_single], [false, undefined]);
}

// ===========================================================================
console.log("\n5. The plugin");
{
  function makeApp(files = {}) {
    const store = {};
    Object.entries(files).forEach(([k, v]) => (store[k] = JSON.stringify(v)));
    return { _store: store, vault: { adapter: { exists: async (p) => p in store, read: async (p) => store[p], write: async (p, d) => { store[p] = d; }, mkdir: async () => {} } } };
  }
  const read = (app, p) => JSON.parse(app._store[p]);
  const plugin = (app) => Object.assign(Object.create(H.__PluginClass.prototype), { app, settings: {}, async refreshAfterDataChange() {} });
  const cat = (app, n) => read(app, F.categories).find((c) => c.name === n);

  let app = makeApp({
    [F.transactions]: [OUT(), IN(), tx("a", D(-1), -20, "Chk", "Online Transfer to SAV"), tx("b", D(-1), 20, "Sav", "Online Transfer from CHK")],
    [F.categories]: [{ name: "Savings", is_transfer: true }],
    [F.accounts]: [], [F.revolvingDebts]: [], [F.rules]: []
  });
  let p = plugin(app);
  check("confirming several at once", await p.confirmTransfers([{ outId: "out", inId: "in" }, { outId: "a", inId: "b" }]), 2);
  const led = read(app, F.transactions);
  check("each pair filed its own way", led.map((t) => [t.id, t.resolved_category, t.transfer_pair]), [["out", "Savings", "in"], ["in", "Savings", "out"], ["a", "Transfer", "b"], ["b", "Transfer", "a"]]);
  check("a new Transfer category counts as a transfer", cat(app, "Transfer").is_transfer, true);
  check("nothing left to suggest", H.transferCandidates(led).length, 0);
  check("undo, from either half", await p.undoTransferRow("b"), 2);
  check("…back to Uncategorized, since no rule covers it", read(app, F.transactions).filter((t) => ["a", "b"].includes(t.id)).map((t) => [t.resolved_category, t.transfer_pair]), [["Uncategorized", undefined], ["Uncategorized", undefined]]);

  app = makeApp({ [F.transactions]: [OUT(), IN()], [F.categories]: [], [F.accounts]: [], [F.revolvingDebts]: [], [F.rules]: [] });
  p = plugin(app);
  check("not a transfer", await p.dismissTransferPair("out", "in"), true);
  check("…and never suggested again", H.transferCandidates(read(app, F.transactions)).length, 0);
  check("a pair that's gone", await p.dismissTransferPair("out", "nope"), false);

  app = makeApp({ [F.transactions]: [tx("x", D(-1), -300, "Chk", "Transfer to Mom's account")], [F.categories]: [], [F.accounts]: [], [F.revolvingDebts]: [], [F.rules]: [] });
  p = plugin(app);
  check("one row marked a transfer on its own", await p.markTransfer("x"), "Transfer");
  const x = read(app, F.transactions)[0];
  check("…filed, and kept off the list", [x.resolved_category, x.transfer_single, H.isHiddenTransfer(x, new Map())], ["Transfer", true, true]);
  check("…under a category that counts as a transfer", cat(app, "Transfer").is_transfer, true);
  check("a row that's gone", await p.markTransfer("nope"), null);
}

// ===========================================================================
console.log("\n6. The Transactions tab");
{
  async function render(allTx, { showTransfers = false } = {}) {
    const calls = [];
    const v = Object.create(H.BudgetDashboardView.prototype);
    Object.assign(v, {
      app: {}, sectionOpen: {}, scrollMemory: {}, showTransfers,
      plugin: {
        settings: {},
        async confirmTransfers(p) { calls.push(["confirm", p]); return p.length; },
        async dismissTransferPair(o, i) { calls.push(["dismiss", o, i]); return true; },
        async undoTransferRow(id) { calls.push(["undo", id]); return 2; },
        async markTransfer(id) { calls.push(["mark", id]); return "Transfer"; },
        async refreshAfterDataChange() {}
      }
    });
    v.render = () => calls.push(["render"]);
    const root = el("div");
    const ctx = { allTx, rules: [], existingLabels: [], accounts: [{ id: "Credit Union Savings", type: "savings", institution: "Credit Union Personal Savings" }, { id: "Credit Union Checking", type: "checking", institution: "Credit Union" }], categoryMetaList: [] };
    await v.renderTransactions(root, ctx);
    return { root, calls, v };
  }
  const coffee = tx("cof", D(-1), -4.5, "Credit Union Checking", "STARBUCKS");
  let { root, calls } = await render([OUT(), IN(), coffee]);
  const inbox = byCls(root, "budget-transfer-inbox")[0];
  check("the tab asks about it", text(byCls(inbox, "budget-inbox-text")[0]), "1 possible transfer to review");
  const pair = byCls(inbox, "budget-transfer-pair")[0];
  check("showing both halves, with accounts", byCls(pair, "budget-transfer-half").map((h) => text(h)),
    [`To Savings 01 ${D(-3)} · Credit Union Personal Savings -$1054.77`, `From Savings 00 ${D(-3)} · Credit Union +$1054.77`]);
  await button(pair, "Transfer").onclick();
  await button(pair, "Not a transfer").onclick();
  check("Transfer confirms it; Not a transfer dismisses it", calls.filter((c) => c[0] !== "render"), [["confirm", [{ outId: "out", inId: "in" }]], ["dismiss", "out", "in"]]);
  check("its uncategorised half isn't also asked for a label", byCls(root, "budget-inbox").filter((b) => !b.classes.has("budget-transfer-inbox")).length, 1);
  const labelInbox = byCls(root, "budget-inbox").find((b) => !b.classes.has("budget-transfer-inbox"));
  check("…only the coffee is", [text(byCls(labelInbox, "budget-inbox-text")[0]), /From Savings 00/.test(text(labelInbox))], ["1 transaction needs a label", false]);
  check("one pair: no confirm-all", byCls(inbox, "budget-transfer-all").length, 0);

  const many = [OUT(), IN(), tx("a", D(-1), -20, "X", "Online Transfer to SAV"), tx("b", D(-1), 20, "Y", "Online Transfer from CHK"), tx("s", D(-2), -54, "X", "AMAZON"), tx("d", D(-2), 54, "Y", "From Savings 00")];
  ({ root, calls } = await render(many));
  const all = byCls(root, "budget-transfer-all")[0];
  check("several that read like transfers can be confirmed together — not the one that doesn't", text(all), "Confirm all 2 that read like transfers");
  await all.onclick();
  check("…exactly those", calls[0], ["confirm", [{ outId: "a", inId: "b" }, { outId: "out", inId: "in" }]]);

  const [o, i] = [OUT(), IN()];
  H.confirmTransferPair([o, i], "out", "in", "Savings");
  ({ root, calls } = await render([o, i, coffee]));
  const names = (r) => byCls(byCls(r, "budget-recent-card")[0], "budget-recent-name").map(text);
  check("confirmed transfers are off the list", names(root), ["STARBUCKS"]);
  check("…and nothing asks about them", byCls(root, "budget-transfer-inbox").length, 0);
  const foot = byCls(root, "budget-recent-hidden")[0];
  check("a line says how many are hidden", text(foot), "2 transfers between your accounts hidden. Show");
  button(foot, "Show").onclick();
  check("Show brings them back", calls.pop(), ["render"]);
  ({ root, calls } = await render([o, i, coffee], { showTransfers: true }));
  check("shown: all three, newest first", names(root), ["STARBUCKS", "To Savings 01", "From Savings 00"]);
  const hiddenRow = byCls(root, "budget-recent-transfer")[0];
  check("a transfer shown offers only Not a transfer", buttonsIn(hiddenRow).map((b) => b._text), ["Not a transfer"]);
  await button(hiddenRow, "Not a transfer").onclick();
  check("…which undoes it", calls[0], ["undo", "out"]);
  check("and the line offers Hide", text(byCls(root, "budget-recent-hidden")[0]), "Showing 2 transfers between your accounts. Hide");

  // The label window offers "It's a transfer".
  let captured = null;
  const orig = H.LabelModal.prototype.open;
  H.LabelModal.prototype.open = function () { captured = this; };
  ({ root, calls } = await render([coffee]));
  button(byCls(root, "budget-recent-card")[0], "Change").onclick();
  check("Change opens the label window with a transfer answer", typeof captured.onTransfer, "function");
  await captured.onTransfer();
  check("…which marks it", calls[0], ["mark", "cof"]);
  H.LabelModal.prototype.open = orig;
  const m = new H.LabelModal({}, "STARBUCKS", -4.5, [], () => {}, null, { onTransfer: () => calls.push(["pressed"]) });
  m.onOpen();
  const b = button(m.contentEl, "It's a transfer");
  check("the window shows the button", !!b, true);
  b.onclick();
  check("pressing it hands over", calls.pop(), ["pressed"]);
  const m2 = new H.LabelModal({}, "STARBUCKS", -4.5, [], () => {}, null, {});
  m2.onOpen();
  check("…and doesn't where the caller can't file one", !!button(m2.contentEl, "It's a transfer"), false);
}

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
})().catch((e) => { console.error(e); process.exit(1); });
