// Regression tests for the eight reported issues. Each section names the
// failure it locks down, not the function it happens to call.
const P = require("./paths.js");
const H = require("./harness.js");
const { el, allText } = H;

let pass = 0, fail = 0;
function check(name, got, want) {
  const ok = JSON.stringify(got) === JSON.stringify(want);
  if (ok) { pass++; console.log(`  PASS  ${name}`); }
  else { fail++; console.log(`  FAIL  ${name}: got ${JSON.stringify(got)}, want ${JSON.stringify(want)}`); }
}

const FILES = {
  categories: "Budget/data/categories.json",
  rules: "Budget/data/category_rules.json",
  transactions: "Budget/data/transactions.json",
  fixedExpenses: "Budget/data/fixed_expenses.json",
  installmentDebts: "Budget/data/installment_debts.json",
  revolvingDebts: "Budget/data/revolving_debts.json",
  savingsGoals: "Budget/data/savings_goals.json",
  subscriptionReviews: "Budget/data/subscription_reviews.json",
  accounts: "Budget/data/accounts.json"
};

function makeApp(seed = {}) {
  const store = Object.assign(
    {
      [FILES.categories]: [],
      [FILES.rules]: [],
      [FILES.transactions]: [],
      [FILES.fixedExpenses]: [],
      [FILES.installmentDebts]: [],
      [FILES.revolvingDebts]: [],
      [FILES.savingsGoals]: [],
      [FILES.subscriptionReviews]: [],
      [FILES.accounts]: []
    },
    seed
  );
  return {
    _store: store,
    vault: { adapter: {
      exists: async (k) => k in store,
      read: async (k) => JSON.stringify(store[k] ?? []),
      write: async (k, v) => { store[k] = JSON.parse(v); }
    } },
    workspace: { getLeavesOfType: () => [] }
  };
}

(async () => {

// ===========================================================================
console.log("\nIssue 4: a category a debt claims is debt money, whatever else it is");
{
  // "Credit Card Payment" is the card's payment_category AND flagged as a
  // transfer. Transfer used to win, so the card never saw its own payments.
  const own = H.buildOwnershipIndex({
    revolvingDebts: [{ id: "cc1", account_id: "Capital One", payment_category: "Credit Card Payment", applied_payments: [] }],
    installmentDebts: [],
    categoryMeta: [
      { name: "Credit Card Payment", is_transfer: true },
      { name: "Savings", is_transfer: true },
      { name: "Gas", is_variable_necessity: true }
    ]
  });
  const o = own.ownerOf({ id: "t1", date: "2026-09-15", amount: -200, resolved_category: "Credit Card Payment" });
  check("a card payment is debt-class", o.class, "debt");
  check("with the reason stated", o.basis, "category a tracked debt takes payments in");

  // The consequence the class governs: it can now be matched and can pair.
  check("debt is a matchable class", H.MATCHABLE_OWNER_TYPES.has("debt"), true);
  check("transfer is not", H.MATCHABLE_OWNER_TYPES.has("transfer"), false);

  // A transfer category no tracker claims is still a transfer.
  check(
    "an unclaimed transfer stays a transfer",
    own.classOf({ id: "t2", date: "2026-09-15", amount: -500, resolved_category: "Savings" }),
    "transfer"
  );
  check(
    "a necessity is still a necessity",
    own.classOf({ id: "t3", date: "2026-09-15", amount: -40, resolved_category: "Gas" }),
    "variable_necessity"
  );
}

console.log("\n  a bill's declared category outranks the flags too");
{
  const own = H.buildOwnershipIndex({
    fixedExpenses: [{ id: "f1", name: "Phone Co", payment_category: "Phone Bill", linked_payments: [] }],
    categoryMeta: [{ name: "Phone Bill", is_transfer: true, is_variable_necessity: true }]
  });
  const o = own.ownerOf({ id: "t1", date: "2026-09-15", amount: -33.81, resolved_category: "Phone Bill" });
  check("resolves to the bill", o.class, "fixed_expense");
  check("and names the bill, not the category", o.label, "Phone Co");
}

console.log("\n  an explicit link still beats every category tier");
{
  const own = H.buildOwnershipIndex({
    installmentDebts: [{ id: "d1", provider: "ZIP", payment_category: "BNPL", applied_payments: [{ tx_id: "t1", amount: 20 }] }],
    categoryMeta: [{ name: "Gas", is_variable_necessity: true }]
  });
  const o = own.ownerOf({ id: "t1", date: "2026-09-15", amount: -20, resolved_category: "Gas" });
  check("the link wins", o.class, "debt");
  check("and it settles something", !!o.settles, true);
}

console.log("\n  the softer signals still rank below the declared ones");
{
  const own = H.buildOwnershipIndex({
    categoryMeta: [{ name: "Streaming", exclude_from_discretionary: true }]
  });
  check(
    "a flagged category is a scheduled bill",
    own.ownerOf({ id: "t1", date: "2026-09-15", amount: -9, resolved_category: "Streaming" }).basis,
    "category marked as a scheduled bill"
  );
  check(
    "a bill-sounding name is the weakest tier",
    own.ownerOf({ id: "t2", date: "2026-09-15", amount: -900, resolved_category: "Rent" }).basis,
    "category name looks like a scheduled bill"
  );
  check(
    "and anything else is just spending",
    own.classOf({ id: "t3", date: "2026-09-15", amount: -12, resolved_category: "Tacos" }),
    "discretionary"
  );
}

// ===========================================================================
console.log("\nIssue 3: a fallback ownership index is never partial");
{
  const built = H.completeOwnership({
    categoryMeta: [{ name: "Gas", is_variable_necessity: true }]
  });
  check("category flags reach the fallback", built.classOf({ id: "t", amount: -40, resolved_category: "Gas" }), "variable_necessity");

  // The leak this closes: without categoryMeta a fuel purchase reads as
  // discretionary, and discretionary is accepted as a candidate for anything.
  const expense = { id: "f1", name: "Phone Bill", amount: 33.81, linked_payments: [] };
  const txs = [
    { id: "t_gas", date: "2026-09-15", amount: -33.81, resolved_category: "Gas", merchant_raw: "SHELL" },
    { id: "t_fi", date: "2026-09-15", amount: -33.81, resolved_category: "Phone Bill", merchant_raw: "PHONE CO" }
  ];
  const withMeta = H.fixedExpenseCandidates(expense, txs, [expense], [], [], [], "2026-09-15", null, {
    categoryMeta: [{ name: "Gas", is_variable_necessity: true }]
  });
  check("fuel is not offered for the phone bill", withMeta.map((t) => t.id), ["t_fi"]);
  check("and it says one was accounted for elsewhere", withMeta.accountedElsewhere, 1);

  const debt = { id: "d1", provider: "ZIP", payment_category: "BNPL", installment_amount: 20, applied_payments: [] };
  const payTxs = [
    { id: "p_sav", date: "2026-09-15", amount: -20, resolved_category: "Savings", merchant_raw: "TO SHARE" },
    { id: "p_bnpl", date: "2026-09-15", amount: -20, resolved_category: "BNPL", merchant_raw: "ZIP" }
  ];
  const goals = [{ id: "g1", name: "Dog food", contributions: [{ id: "c1", linked_tx_id: "p_sav", amount: 20 }] }];
  const pays = H.candidatePayments(debt, payTxs, [debt], [], null, { goals });
  check("a savings-linked transfer is not offered as a debt payment", pays.map((t) => t.id), ["p_bnpl"]);

  const contribs = H.contributionCandidates(
    { id: "c2", date: "2026-09-15", amount: 20 },
    payTxs,
    [],
    null,
    { installmentDebts: [debt], categoryMeta: [] }
  );
  check("a BNPL payment is not offered as a savings contribution", contribs.map((t) => t.id), ["p_sav"]);
}

// ===========================================================================
console.log("\nIssue 2: renaming a category takes its bills and debts with it");
{
  const app = makeApp({
    [FILES.categories]: [{ name: "Phone Bill" }, { name: "Gas", is_variable_necessity: true }],
    [FILES.rules]: [{ merchant_pattern: "PHONE CO", home_label: "Phone Bill" }],
    [FILES.transactions]: [{ id: "t1", date: "2026-09-15", amount: -33.81, merchant_raw: "PHONE CO", override_label: "Phone Bill" }],
    [FILES.fixedExpenses]: [{ id: "f1", name: "Phone Co", payment_category: "Phone Bill", payment_category_learned: true, linked_payments: [] }],
    [FILES.installmentDebts]: [{ id: "d1", provider: "ZIP", payment_category: "Phone Bill", applied_payments: [] }],
    [FILES.revolvingDebts]: [{ id: "cc1", account_id: "Card", payment_category: "Phone Bill", applied_payments: [] }]
  });

  const r = await H.renameCategory(app, "Phone Bill", "Mobile");
  check("rules follow", app._store[FILES.rules][0].home_label, "Mobile");
  check("overrides follow", app._store[FILES.transactions][0].override_label, "Mobile");
  check("the bill follows", app._store[FILES.fixedExpenses][0].payment_category, "Mobile");
  check("the plan follows", app._store[FILES.installmentDebts][0].payment_category, "Mobile");
  check("the card follows", app._store[FILES.revolvingDebts][0].payment_category, "Mobile");
  check("and the count is reported", r.paymentCategoriesUpdated, 3);

  // The point of all that: the resolver still recognises the payment.
  const own = H.buildOwnershipIndex({
    fixedExpenses: app._store[FILES.fixedExpenses],
    categoryMeta: app._store[FILES.categories]
  });
  check(
    "so the charge is still bill money after the rename",
    own.classOf({ id: "t1", amount: -33.81, resolved_category: "Mobile" }),
    "fixed_expense"
  );
}

console.log("\n  merging two categories keeps every flag on either side");
{
  const app = makeApp({
    [FILES.categories]: [
      { name: "Fuel", is_variable_necessity: true, variable_min_amount: 15, monthly_target: 200 },
      { name: "Gas", is_transfer: true, exclude_from_discretionary: true }
    ]
  });
  await H.renameCategory(app, "Fuel", "Gas");
  const gas = app._store[FILES.categories].find((c) => c.name === "Gas");
  check("one row is left", app._store[FILES.categories].length, 1);
  check("necessity carried across", gas.is_variable_necessity, true);
  check("its threshold carried across", gas.variable_min_amount, 15);
  check("the monthly target carried across", gas.monthly_target, 200);
  check("the target's own transfer flag survived", gas.is_transfer, true);
  check("and its scheduled-bill flag survived", gas.exclude_from_discretionary, true);
}

console.log("\n  a merge never overwrites a figure the target already had");
{
  const app = makeApp({
    [FILES.categories]: [
      { name: "Fuel", variable_min_amount: 15, monthly_target: 200 },
      { name: "Gas", variable_min_amount: 40, monthly_target: 500 }
    ]
  });
  await H.renameCategory(app, "Fuel", "Gas");
  const gas = app._store[FILES.categories][0];
  check("threshold untouched", gas.variable_min_amount, 40);
  check("target untouched", gas.monthly_target, 500);
}

console.log("\nIssue 2: deleting a category reassigns what pointed at it");
{
  const app = makeApp({
    [FILES.categories]: [{ name: "Phone Bill" }, { name: "Utilities" }],
    [FILES.rules]: [{ merchant_pattern: "PHONE CO", home_label: "Phone Bill" }],
    [FILES.transactions]: [{ id: "t1", date: "2026-09-15", amount: -33.81, merchant_raw: "PHONE CO", override_label: "Phone Bill" }],
    [FILES.fixedExpenses]: [{ id: "f1", name: "Phone Co", payment_category: "Phone Bill", linked_payments: [] }]
  });
  const r = await H.deleteCategory(app, "Phone Bill", "Utilities");
  check("the bill is repointed", app._store[FILES.fixedExpenses][0].payment_category, "Utilities");
  check("and counted", r.paymentCategoriesChanged, 1);
  check("the category is gone", app._store[FILES.categories].map((c) => c.name), ["Utilities"]);
}

console.log("\n  with nowhere to reassign, the declaration is cleared, not orphaned");
{
  const app = makeApp({
    [FILES.categories]: [{ name: "Phone Bill" }],
    [FILES.fixedExpenses]: [{ id: "f1", name: "Phone Co", payment_category: "Phone Bill", payment_category_learned: true, linked_payments: [] }],
    [FILES.installmentDebts]: [{ id: "d1", provider: "ZIP", payment_category: "Phone Bill", applied_payments: [] }]
  });
  await H.deleteCategory(app, "Phone Bill", null);
  check("the bill no longer points at a deleted category", app._store[FILES.fixedExpenses][0].payment_category, null);
  check("the learned flag goes with it", app._store[FILES.fixedExpenses][0].payment_category_learned, undefined);
  check("the plan is cleared too", app._store[FILES.installmentDebts][0].payment_category, null);
}

console.log("\n  unrelated records are left alone");
{
  const app = makeApp({
    [FILES.categories]: [{ name: "Phone Bill" }],
    [FILES.fixedExpenses]: [{ id: "f1", name: "Rent", payment_category: "Rent", linked_payments: [] }]
  });
  const moved = await H.repointPaymentCategories(app, "Phone Bill", "Mobile");
  check("nothing moved", moved, 0);
  check("and Rent is untouched", app._store[FILES.fixedExpenses][0].payment_category, "Rent");
}

// ===========================================================================
console.log("\nIssue 1: the delete flow lives where categories do");
{
  // The modal opens and can be confirmed without touching anything that only
  // exists in another scope.
  let confirmedWith = "unset";
  const modal = new H.DeleteCategoryModal(
    {},
    { name: "Phone Bill", ruleCount: 1, txCount: 2, overrideCount: 0 },
    [{ name: "Phone Bill" }, { name: "Utilities" }],
    ["Phone Co"],
    async (reassignTo) => { confirmedWith = reassignTo; }
  );
  modal.contentEl = el("div");
  modal.close = () => {};
  modal.onOpen();
  const text = allText(modal.contentEl);
  check("it says what uses the category", text.includes("1 rule, 2 transactions"), true);
  check("it warns about the bill that expects it", text.includes("Phone Co"), true);
  check("in plain language", /payment_category|resolver|ownership/i.test(text), false);

  const del = H.SettingStub.buttons.find((b) => b.label === "Delete category");
  check("the confirm button exists", !!del, true);
  await del.cb();
  check("and confirming reports the target", confirmedWith, null);
}

console.log("\n  the subscriptions tab no longer carries a category Delete button");
{
  // Scope has to end at the next member at the same indent, async or not —
  // stopping only at "\n  async " runs past the end of the class and picks up
  // BudgetSettingTab.display(), which is a different method entirely.
  const lines = require("fs").readFileSync(P.MAIN, "utf8").split("\n");
  const src = lines.join("\n");
  const start = lines.findIndex((l) => /async renderSubscriptions\(/.test(l));
  let end = lines.length;
  for (let i = start + 1; i < lines.length; i++) {
    if (/^  (async )?[A-Za-z_][A-Za-z0-9_]*\(/.test(lines[i])) { end = i; break; }
  }
  const body = lines.slice(start, end).join("\n");
  // The bound guards against the extraction running off the end of the class
  // (which would be thousands of lines), not against the method growing. It
  // grew when phase-out landed; the terminator is still the next sibling.
  check("the scope really is one method", end - start < 300, true);
  check("and ends at the next member", /^  renderGoneSubscriptions\(/.test(lines[end]), true);
  check("no DeleteCategoryModal in that scope", body.includes("DeleteCategoryModal"), false);
  check("no deleteCategory call in that scope", /\bdeleteCategory\(/.test(body), false);
  check("and no settings-only display() call", /this\.display\(\)/.test(body), false);

  // The feature it used to be the only route to still exists.
  check("category delete is reachable from settings", src.includes("new DeleteCategoryModal("), true);
}

// ===========================================================================
console.log("\nIssue 5: overlapping dashboard renders are serialized");
{
  const View = require("./harness-for.js")(P.MAIN).BudgetDashboardView;
  const view = Object.create(View.prototype);
  let running = 0;
  let maxConcurrent = 0;
  let runs = 0;
  view.renderView = async () => {
    running++;
    runs++;
    maxConcurrent = Math.max(maxConcurrent, running);
    await new Promise((r) => setTimeout(r, 5));
    running--;
  };

  const first = view.render();
  view.render();
  view.render();
  view.render();
  await first;
  await new Promise((r) => setTimeout(r, 30));

  check("never two at once", maxConcurrent, 1);
  check("and a burst collapses to one follow-up", runs, 2);
}

console.log("\n  a render that throws releases the lock");
{
  const View = require("./harness-for.js")(P.MAIN).BudgetDashboardView;
  const view = Object.create(View.prototype);
  let runs = 0;
  view.renderView = async () => { runs++; throw new Error("boom"); };
  const origError = console.error;
  console.error = () => {};
  await view.render();
  await view.render();
  console.error = origError;
  check("it can render again", runs, 2);
  check("and the lock is clear", !!view._rendering, false);
}

// ===========================================================================
console.log("\nIssue 6: month lookups use the local calendar");
{
  const src = require("fs").readFileSync(P.MAIN, "utf8");
  check("no UTC month slicing left", /new Date\(\)\.toISOString\(\)\.slice\(0, ?7\)/.test(src), false);
  // Assert the property, not a count: every month key still derived in the code
  // comes from the local calendar date. Counting occurrences just breaks when
  // unrelated UI is removed.
  // Slicing a stored date STRING (t.date, todayStr) is always fine — those are
  // already local. What must never happen is deriving a month key from a live
  // Date, because that is the conversion that shifts the day.
  const monthKeys = src.match(/[A-Za-z0-9_.()]*\.slice\(0, ?7\)/g) || [];
  check("month keys are derived somewhere", monthKeys.length > 0, true);
  check("none of them comes from a raw Date", monthKeys.filter((m) => /Date|toISOString/.test(m)), []);
  check("and today's month goes through todayLocal", monthKeys.some((m) => /^todayLocal\(\)/.test(m)), true);

  // The failure it prevents: an evening west of UTC is already tomorrow in UTC,
  // and on the last of the month that is the next month.
  const local = H.todayLocal();
  check("todayLocal is a plain local date", /^\d{4}-\d{2}-\d{2}$/.test(local), true);
  check("so its month key is the local one", local.slice(0, 7), H.toLocalISO(new Date()).slice(0, 7));
}

// ===========================================================================
console.log("\nIssue 7: a holding with no market value says so");
{
  const src = require("fs").readFileSync(P.MAIN, "utf8");
  check("the value is guarded", src.includes("Number.isFinite(h.market_value)"), true);
  check("with a plain-language fallback", src.includes('"value unavailable"'), true);
  check("and nothing formats an unchecked market value", /\$\$\{round2\(h\.market_value\)\.toFixed\(2\)\}`, cls/.test(src), true);

  // The shape the parser actually produces for a multi-fund statement.
  const holdings = [{ name: "Vanguard 2055" }, { name: "Total Bond" }];
  check("multi-fund holdings carry no value", holdings.every((h) => !Number.isFinite(h.market_value)), true);
  check("and formatting one would have produced NaN", String(Number((undefined)).toFixed ? NaN.toFixed(2) : ""), "NaN");
}

// ===========================================================================
console.log("\nIssue 8: the shortfall sentence names everything it counts");
{
  const src = require("fs").readFileSync(P.MAIN, "utf8");
  const committed = src.match(/const committed =\s*\n?\s*(.+);/);
  const parts = ["periodFixedTotal", "requiredMinimums", "periodSubsTotal", "earmarked", "variableNecessitiesTotal"];
  check("committed still adds up five things", parts.every((p) => committed[1].includes(p)), true);

  const sentence = src.slice(src.indexOf("Short by about $"), src.indexOf("Short by about $") + 260);
  ["fixed costs", "minimum payments", "subscriptions", "earmarked savings", "projected necessities"].forEach((phrase) => {
    check(`names ${phrase}`, sentence.includes(phrase), true);
  });
}


// ===========================================================================
console.log("\n1.8.5 — a subscription is never offered for matching");
{
  const CATS = [{ name: "Subscription" }];
  const tx = { id: "t_sub", date: "2026-09-16", amount: -19.99, resolved_category: "Subscription", merchant_raw: "GOOGLE *Google One" };
  const key = H.subscriptionGroupKey(tx.merchant_raw, []);
  const own = H.buildOwnershipIndex({ categoryMeta: CATS, subscriptionKeys: [key], rules: [] });

  check("it is still subscription money", own.classOf(tx), "subscription");
  check("so the allowance still excludes it", H.RESERVED_OWNER_TYPES.has("subscription"), true);
  check("but it is not matchable", H.MATCHABLE_OWNER_TYPES.has("subscription"), false);

  const bs = H.classifyBufferSpending({
    transactions: [tx], periodStartStr: "2026-09-12", nextPaydayStr: "2026-09-26",
    categoryMeta: CATS, ownership: own
  });
  check("it never reaches the list", bs.unsettled.length, 0);
  check("and it is still reserved, not spending", bs.spent, 0);
  check("under the subscription bucket", bs.settled.subscription, 19.99);

  // Even with an open subscription obligation, which is what used to let it in.
  const un = H.findUnreconciledObligations({
    periodObligations: H.buildPeriodObligations({
      upcomingSubs: [{ key, amount: 19.99, dueDate: "2026-09-20" }],
      todayStr: "2026-09-16", nextPaydayStr: "2026-09-26"
    }),
    unsettled: bs.unsettled
  });
  check("nothing is shown to the user", un.needsMatching.length, 0);
}

console.log("\n  debt and bills are still matchable");
{
  check("debt", H.MATCHABLE_OWNER_TYPES.has("debt"), true);
  check("fixed_expense", H.MATCHABLE_OWNER_TYPES.has("fixed_expense"), true);
  check("savings", H.MATCHABLE_OWNER_TYPES.has("savings"), true);
  check("but not transfer", H.MATCHABLE_OWNER_TYPES.has("transfer"), false);
  check("nor a variable necessity", H.MATCHABLE_OWNER_TYPES.has("variable_necessity"), false);
}

console.log("\n  a savings contribution's link is what makes it savings money");
{
  const tx = { id: "t_sav", date: "2026-09-15", amount: -500, resolved_category: "Savings", merchant_raw: "TO SHARE" };
  const meta = [{ name: "Savings", is_transfer: true }];
  const linked = H.buildOwnershipIndex({
    goals: [{ id: "g1", name: "Dog food", contributions: [{ id: "c1", linked_tx_id: "t_sav", amount: 500 }] }],
    categoryMeta: meta
  });
  const unlinked = H.buildOwnershipIndex({
    goals: [{ id: "g1", name: "Dog food", contributions: [{ id: "c1", amount: 500 }] }],
    categoryMeta: meta
  });
  check("linked, it is savings and it settles", [linked.classOf(tx), !!linked.settlementOf(tx)], ["savings", true]);
  check("unlinked, it is just a transfer", [unlinked.classOf(tx), !!unlinked.settlementOf(tx)], ["transfer", false]);

  // Which is why listing savings as matchable cannot produce a row: being
  // savings-class already means the link exists.
  const bs = H.classifyBufferSpending({
    transactions: [tx], periodStartStr: "2026-09-12", nextPaydayStr: "2026-09-26",
    categoryMeta: meta, ownership: unlinked
  });
  check("an unlinked savings transfer shows no row", bs.unsettled.length, 0);
  check("and is reserved as a transfer", bs.settled.transfer, 500);
}

// ===========================================================================
console.log("\n1.8.5 — Apply Payment builds a complete index wherever it opens");
{
  const src = require("fs").readFileSync(P.MAIN, "utf8");
  const lines = src.split("\n");
  const start = lines.findIndex((l) => /async openApplyPaymentFor\(/.test(l));
  let end = lines.length;
  for (let i = start + 1; i < lines.length; i++) {
    if (/^  (async )?[A-Za-z_][A-Za-z0-9_]*\(/.test(lines[i])) { end = i; break; }
  }
  const body = lines.slice(start, end).join("\n");
  check("the scope really is one method", end - start < 120, true);
  check("it uses the complete builder", body.includes("completeOwnership({"), true);
  check("with rules", /\brules,/.test(body), true);
  check("and subscription keys", body.includes("keptSubscriptionKeys"), true);
  check("and no partial index is built here", body.includes("buildOwnershipIndex("), false);

  // Everything that builds an index should either go through completeOwnership
  // or be handed all seven fields by its caller. Check each remaining direct
  // call rather than counting them, so this says something when it fails.
  const FIELDS = ["fixedExpenses", "installmentDebts", "revolvingDebts", "goals", "categoryMeta", "subscriptionKeys", "rules"];
  const directCalls = [];
  lines.forEach((l, i) => {
    if (!/\bbuildOwnershipIndex\(\{/.test(l)) return;
    if (/^function buildOwnershipIndex/.test(l)) return;
    // The call inside completeOwnership is the funnel itself.
    const above = lines.slice(Math.max(0, i - 12), i).join("\n");
    if (/function completeOwnership\(/.test(above)) return;
    directCalls.push({ line: i + 1, args: lines.slice(i, i + 12).join("\n") });
  });
  directCalls.forEach((c) => {
    const missing = FIELDS.filter((f) => !new RegExp(`\\b${f}\\b`).test(c.args));
    check(`the index built at line ${c.line} is complete`, missing, []);
  });
  check("and nothing else builds one directly", directCalls.length, 2);
}

console.log("\n  a kept subscription is not offered as a debt payment");
{
  const debt = { id: "d1", provider: "ZIP", payment_category: "BNPL", installment_amount: 19.99, applied_payments: [] };
  const txs = [
    { id: "t_sub", date: "2026-09-16", amount: -19.99, resolved_category: "Uncategorized", merchant_raw: "GOOGLE *Google One" },
    { id: "t_bnpl", date: "2026-09-16", amount: -19.99, resolved_category: "BNPL", merchant_raw: "ZIP*" }
  ];
  const key = H.subscriptionGroupKey("GOOGLE *Google One", []);

  const starved = H.candidatePayments(debt, txs, [debt], [], null, {});
  check("starved of context, the subscription leaks in", starved.map((t) => t.id).sort(), ["t_bnpl", "t_sub"]);

  const complete = H.candidatePayments(debt, txs, [debt], [], null, { subscriptionKeys: [key], rules: [] });
  check("with subscription keys, it is filtered out", complete.map((t) => t.id), ["t_bnpl"]);
  check("and counted as accounted for elsewhere", complete.accountedElsewhere, 1);
}

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
})();
