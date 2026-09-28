// Drives startMatchFlow against stubs: "the method exists" is not the same
// claim as "clicking Match opens something you can finish the link in".
const H = require("./harness.js");
const { el, SettingStub, allText, allRows } = H;
const Plugin = H.__PluginClass;

let pass = 0, fail = 0;
function check(name, got, want) {
  const ok = got === want;
  if (ok) { pass++; console.log(`  PASS  ${name}`); }
  else { fail++; console.log(`  FAIL  ${name}: got ${JSON.stringify(got)}, want ${JSON.stringify(want)}`); }
}

const CARD = { id: "cc1", account_id: "Capital One Card", payment_category: "Credit Card Payment",
  apr: 29.99, min_payment_due: 40, due_date: "2026-09-25",
  balance_anchor: { amount: 500, date: "2026-09-01" }, applied_payments: [] };
const ZIP = { id: "d_zip", provider: "ZIP", installment_amount: 67.5, payment_category: "BNPL",
  next_due_date: "2026-09-22", frequency: "monthly",
  balance_anchor: { amount: 135, date: "2026-09-01" }, applied_payments: [] };
const GFI = { id: "f_phone", name: "Phone Co", amount: 33.81, due_day_of_month: 20,
  payment_category: "Phone Bill", linked_payments: [] };

const TX = {
  bnpl: { id: "t_bnpl", date: "2026-09-18", amount: -67.5, resolved_category: "BNPL", merchant_raw: "ZIP*SWITCH" },
  bill: { id: "t_bill", date: "2026-09-19", amount: -33.81, resolved_category: "Phone Bill", merchant_raw: "PHONE CO" },
  card: { id: "t_card", date: "2026-09-20", amount: -200, resolved_category: "Credit Card Payment", merchant_raw: "CAPITAL ONE" }
};

function makePlugin() {
  const store = {
    "Budget/data/revolving_debts.json": [CARD],
    "Budget/data/installment_debts.json": [ZIP],
    "Budget/data/fixed_expenses.json": [GFI],
    "Budget/data/transactions.json": Object.values(TX),
    "Budget/data/category_rules.json": [],
    "Budget/data/categories.json": [
      { name: "BNPL", is_transfer: false },
      { name: "Phone Bill", is_transfer: false },
      { name: "Credit Card Payment", is_transfer: true }
    ],
    "Budget/data/savings_goals.json": []
  };
  const opened = [];
  const notices = [];
  const p = Object.create(Plugin.prototype);
  p.app = {
    vault: { adapter: {
      exists: async (k) => k in store,
      read: async (k) => JSON.stringify(store[k] ?? []),
      write: async (k, v) => { store[k] = JSON.parse(v); }
    } },
    workspace: { getLeavesOfType: () => [] }
  };
  p.settings = {};
  p.activateView = async () => { opened.push("view"); };
  p.recalculate = async () => { opened.push("recalculate"); };
  p.refreshAfterDataChange = async () => {};
  p.snapshotDebt = async () => {};
  p._store = store; p._opened = opened; p._notices = notices;
  return p;
}

// Capture which modal class gets opened, and keep a handle on it.
function instrument() {
  const seen = [];
  for (const name of ["ApplyPaymentModal", "MarkPaidModal", "PickObligationModal"]) {
    const C = H[name];
    if (!C) continue;
    const orig = C.prototype.open;
    C.prototype.open = function () {
      seen.push({ name, modal: this });
      this.contentEl = el("div");
      if (this.onOpen) this.onOpen();
    };
    C.prototype.__origOpen = orig;
  }
  return seen;
}

(async () => {
  const seen = instrument();

  console.log("\nA bill payment opens the bill's own flow");
  {
    seen.length = 0;
    const p = makePlugin();
    await p.startMatchFlow(TX.bill, { source: "fixed_expense", ref: "f_phone", label: "Phone Co", dueDate: "2026-09-20" });
    check("a modal opened", seen.length, 1);
    check("and it is Mark Paid", seen[0] && seen[0].name, "MarkPaidModal");
  }

  console.log("\nA debt payment opens Apply Payment, pre-filled");
  {
    seen.length = 0;
    const p = makePlugin();
    await p.startMatchFlow(TX.bnpl, { source: "debt", ref: "d_zip", label: "ZIP" });
    check("a modal opened", seen.length, 1);
    check("and it is Apply Payment", seen[0] && seen[0].name, "ApplyPaymentModal");
    const modal = seen[0].modal;
    check("against the right debt", modal.debt.id, "d_zip");
    check("with the transaction in the list", modal.candidates.some((c) => c.id === TX.bnpl.id), true);
    check("and it is visible in the rendered rows", allText(modal.contentEl).includes("67.50"), true);
  }

  console.log("\nApplying actually records the payment");
  {
    seen.length = 0;
    const p = makePlugin();
    await p.startMatchFlow(TX.bnpl, { source: "debt", ref: "d_zip", label: "ZIP" });
    const modal = seen[0].modal;
    await modal.onSubmit([TX.bnpl]);
    const saved = p._store["Budget/data/installment_debts.json"][0];
    check("applied_payments gained the link", saved.applied_payments.length, 1);
    check("with the right transaction id", saved.applied_payments[0].tx_id, TX.bnpl.id);
    check("and the right amount", saved.applied_payments[0].amount, 67.5);
    check("the covered installment rolled forward", saved.next_due_date !== "2026-09-22", true);
  }

  console.log("\nNo suggestion: a single matching debt is inferred");
  {
    seen.length = 0;
    const p = makePlugin();
    await p.startMatchFlow(TX.card, null);
    check("still opens Apply Payment", seen[0] && seen[0].name, "ApplyPaymentModal");
    check("on the only debt taking that category", seen[0].modal.debt.id, "cc1");
  }

  console.log("\nNo suggestion and an ambiguous category ASKS rather than giving up");
  {
    seen.length = 0;
    const p = makePlugin();
    // Two plans both taking "BNPL". This is the ordinary case, not an edge one:
    // six plans sharing a category is how the user's data actually looks, and
    // the old code bounced them to the Debts tab every single time.
    p._store["Budget/data/installment_debts.json"] = [
      ZIP, Object.assign({}, ZIP, { id: "d_two", provider: "Affirm", installment_amount: 22.22 })
    ];
    await p.startMatchFlow(TX.bnpl, null);
    check("opens the chooser", seen[0] && seen[0].name, "PickObligationModal");
    check("with both plans offered", seen[0].modal.options.length, 2);
    check("exact-amount match first", seen[0].modal.options[0].label, "ZIP");
    check("and does NOT bounce to the tab", p._opened.includes("view"), false);
  }

  console.log("\nPicking from the chooser finishes the job");
  {
    seen.length = 0;
    const p = makePlugin();
    p._store["Budget/data/installment_debts.json"] = [
      ZIP, Object.assign({}, ZIP, { id: "d_two", provider: "Affirm", installment_amount: 22.22 })
    ];
    await p.startMatchFlow(TX.bnpl, null);
    const picker = seen[0].modal;
    await picker.onPick(picker.options[0]);
    check("Apply Payment opens next", seen[1] && seen[1].name, "ApplyPaymentModal");
    check("on the plan that was picked", seen[1].modal.debt.id, "d_zip");
    check("with the transaction already in the list", seen[1].modal.candidates.some((c) => c.id === TX.bnpl.id), true);
  }

  console.log("\nAn ambiguous BILL asks too");
  {
    seen.length = 0;
    const p = makePlugin();
    p._store["Budget/data/fixed_expenses.json"] = [
      GFI, Object.assign({}, GFI, { id: "f_two", name: "Backup phone", amount: 12 })
    ];
    await p.startMatchFlow(Object.assign({}, TX.bill, { class: "fixed_expense" }), null);
    check("opens the chooser", seen[0] && seen[0].name, "PickObligationModal");
    check("over both bills", seen[0].modal.options.length, 2);
    await seen[0].modal.onPick(seen[0].modal.options[0]);
    check("and lands on Mark Paid", seen[1] && seen[1].name, "MarkPaidModal");
  }

  console.log("\nNothing in the flow ever dead-ends on the user's own shape of data");
  {
    seen.length = 0;
    const p = makePlugin();
    // Six plans, one category — the real vault.
    p._store["Budget/data/installment_debts.json"] = [0, 1, 2, 3, 4, 5].map((i) =>
      Object.assign({}, ZIP, { id: `d_${i}`, provider: `Plan ${i}`, installment_amount: 10 + i })
    );
    await p.startMatchFlow(TX.bnpl, null);
    check("still opens something", seen.length, 1);
    check("and it is the chooser", seen[0].name, "PickObligationModal");
    check("listing all six", seen[0].modal.options.length, 6);
    check("no tab switch", p._opened.includes("view"), false);
  }

  console.log("\nA subscription says there is nothing to do");
  {
    seen.length = 0;
    const p = makePlugin();
    await p.startMatchFlow({ id: "t_sub", date: "2026-09-19", amount: -15.99 }, { source: "subscription", ref: "Netflix", label: "Netflix" });
    check("opens no modal", seen.length, 0);
  }

  console.log("\nA stale suggestion does not throw");
  {
    seen.length = 0;
    const p = makePlugin();
    await p.startMatchFlow(TX.bill, { source: "fixed_expense", ref: "deleted_id", label: "Gone" });
    check("falls through without crashing", true, true);
  }

  console.log(`\n${pass} passed, ${fail} failed`);
  process.exit(fail ? 1 : 0);
})();
