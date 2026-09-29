// Regression tests for the 1.9.0 UI/UX refactors. Each section locks down the
// behaviour a user would notice, not the shape of the code that produces it.
const P = require("./paths.js");
const H = require("./harness.js");
const { el, allText, SettingStub } = H;

let pass = 0, fail = 0;
function check(name, got, want) {
  const ok = JSON.stringify(got) === JSON.stringify(want);
  if (ok) { pass++; console.log(`  PASS  ${name}`); }
  else { fail++; console.log(`  FAIL  ${name}: got ${JSON.stringify(got)}, want ${JSON.stringify(want)}`); }
}

const FILES = {
  savingsGoals: "Budget/data/savings_goals.json",
  accounts: "Budget/data/accounts.json",
  categories: "Budget/data/categories.json"
};
function makeApp(seed = {}) {
  const store = Object.assign({ [FILES.savingsGoals]: [], [FILES.accounts]: [], [FILES.categories]: [] }, seed);
  return {
    _store: store,
    vault: { adapter: {
      exists: async (k) => k in store,
      read: async (k) => JSON.stringify(store[k] ?? []),
      write: async (k, v) => { store[k] = JSON.parse(v); }
    } }
  };
}
const SRC = require("fs").readFileSync(P.MAIN, "utf8");
// Anchored to a DEFINITION at class-member indent. Matching anywhere would find
// the call site first and return the caller's body instead, which quietly makes
// every assertion about the method meaningless.
function methodBody(name) {
  const lines = SRC.split("\n");
  const start = lines.findIndex((l) => new RegExp(`^  (async )?${name}\\(`).test(l));
  if (start < 0) throw new Error(`no definition found for ${name}`);
  let end = lines.length;
  for (let i = start + 1; i < lines.length; i++) {
    if (/^  (async )?[A-Za-z_][A-Za-z0-9_]*\(/.test(lines[i])) { end = i; break; }
  }
  return lines.slice(start, end).join("\n");
}

(async () => {

// ===========================================================================
console.log("\n1. Savings Mode has one name");
{
  check("the setting is gone from the defaults", "savingsLabel" in H.DEFAULT_SETTINGS, false);
  // The only mention left is the migration that deletes a stored value.
  check("nothing reads it for display", /settings\.savingsLabel \|\|/.test(SRC), false);
  check("and nothing writes it", /settings\.savingsLabel =/.test(SRC), false);
  check("no 'Mode label' setting is rendered", /Mode label/.test(SRC), false);
  check("the name is still shown", /"Savings Mode"/.test(SRC), true);

  // A stored value from an older version is cleared rather than left behind.
  const migration = SRC.slice(SRC.indexOf("Savings Mode is called Savings Mode"), SRC.indexOf("Savings Mode is called Savings Mode") + 400);
  check("an old stored label is deleted on load", /delete this\.settings\.savingsLabel/.test(migration), true);
  check("and the file is rewritten when it was", /settingsMigrated = true/.test(migration), true);
}

// ===========================================================================
console.log("\n2. Pinning a goal is something you press");
{
  check("the hidden name pattern is gone", /PRIORITY_GOAL_PATTERN/.test(SRC), false);

  const goals = [
    { id: "g1", name: "New apartment", target_amount: 2000, saved_amount: 100, contributions: [] },
    { id: "g2", name: "Moving Fund", target_amount: 500, saved_amount: 400, contributions: [] }
  ];
  check("nothing is pinned by default", H.findPriorityGoal(goals), null);

  // The old behaviour: "Moving Fund" would have won on its name alone.
  goals[0].pinned = true;
  check("the flagged goal wins, whatever it is called", H.findPriorityGoal(goals).id, "g1");
  check("and its name is irrelevant", H.findPriorityGoal(goals).name, "New apartment");
}

console.log("\n  only one goal can be pinned at a time");
{
  const app = makeApp({
    [FILES.savingsGoals]: [
      { id: "g1", name: "A", pinned: true },
      { id: "g2", name: "B" },
      { id: "g3", name: "C" }
    ]
  });
  await H.setPinnedGoal(app, "g2");
  const saved = app._store[FILES.savingsGoals];
  check("the new one is pinned", saved.find((g) => g.id === "g2").pinned, true);
  check("the old one is not", "pinned" in saved.find((g) => g.id === "g1"), false);
  check("exactly one is pinned", saved.filter((g) => g.pinned).length, 1);
  check("and findPriorityGoal agrees", H.findPriorityGoal(saved).id, "g2");
}

console.log("\n  unpinning clears it without pinning something else");
{
  const app = makeApp({ [FILES.savingsGoals]: [{ id: "g1", name: "A", pinned: true }, { id: "g2", name: "B" }] });
  await H.setPinnedGoal(app, null);
  check("none is pinned", app._store[FILES.savingsGoals].filter((g) => g.pinned).length, 0);
  check("and the dashboard shows nothing pinned", H.findPriorityGoal(app._store[FILES.savingsGoals]), null);
  check("the flag is removed, not set false", "pinned" in app._store[FILES.savingsGoals][0], false);
}

console.log("\n  pinning an already-pinned goal is a no-op, not a toggle-off");
{
  const app = makeApp({ [FILES.savingsGoals]: [{ id: "g1", name: "A", pinned: true }] });
  await H.setPinnedGoal(app, "g1");
  check("it stays pinned", app._store[FILES.savingsGoals][0].pinned, true);
}

console.log("\n  the empty state says what to press, not what to name things");
{
  const empty = methodBody("renderPinnedGoal");
  check("no naming convention is described", /Relocation.{0,20}in the name|with .Move./.test(empty), false);
  check("it names the button instead", /Pin to dashboard/.test(empty), true);
}

// ===========================================================================
console.log("\n3. Accounts can be edited, not only deleted");
{
  let saved = null;
  const modal = new H.AddAccountModal({}, (patch) => { saved = patch; }, {
    id: "Main Checking",
    type: "checking",
    institution: "Credit Union",
    current_balance: 554.51,
    csv_source: "mainbank",
    last_imported_through: "2026-09-20"
  });
  modal.contentEl = el("div");
  modal.close = () => {};
  SettingStub.buttons.length = 0;
  modal.onOpen();

  const text = allText(modal.contentEl);
  check("the title says Edit", text.includes("Edit: Credit Union"), true);
  check("fields are pre-filled", text.includes("554.51") && text.includes("Credit Union"), true);
  check("it explains why the ID is fixed", /transactions, card terms and import markers/.test(text), true);

  const btn = SettingStub.buttons.find((b) => b.label === "Save changes");
  check("the save button says it is an edit", !!btn, true);
  await btn.cb();
  check("the id is carried through unchanged", saved.id, "Main Checking");
  check("and import progress is preserved", saved.last_imported_through, "2026-09-20");
}

console.log("\n  adding an account still starts blank");
{
  let saved = null;
  const modal = new H.AddAccountModal({}, (patch) => { saved = patch; });
  modal.contentEl = el("div");
  modal.close = () => {};
  SettingStub.buttons.length = 0;
  modal.onOpen();
  check("the title says Add", allText(modal.contentEl).includes("Add Account"), true);
  const btn = SettingStub.buttons.find((b) => b.label === "Save");
  check("the plain Save button is used", !!btn, true);
  await btn.cb();
  check("a new account has no import history", saved.last_imported_through, null);
}

console.log("\n  the settings section offers both actions");
{
  const body = methodBody("renderAccountSettings");
  check("an Add account button exists", /setButtonText\("Add account"\)/.test(body), true);
  check("each row has Edit", /text: "Edit"/.test(body), true);
  check("and still has Delete", /text: "Delete"/.test(body), true);
  check("Edit opens the account modal with the row", /new AddAccountModal\(/.test(body), true);
  // The modal returns as soon as it opens, so the list has to be re-rendered
  // from the save callback rather than by awaiting the prompt.
  check("Add re-renders once the save lands", /promptAddAccount\(\(\) => this\.display\(\)\)/.test(body), true);
  check("and promptAddAccount takes that callback", /async promptAddAccount\(onDone = null\)/.test(SRC), true);
}

// ===========================================================================
console.log("\n4. Budget targets live where the budget math is");
{
  const cats = methodBody("renderCategorySettings");
  check("no target input in settings", /budget-target-input"/.test(cats), false);
  check("no reduce dropdown in settings", /budget-reduce-select/.test(cats), false);
  check("each row offers only Settings and Delete", [/text: "Settings"/.test(cats), /text: "Delete"/.test(cats)], [true, true]);
  ["Mark necessity", "Scheduled bill", "Mark as transfer", "Rename"].forEach((label) =>
    check(`${label} moved out of the row`, cats.includes(`text: "${label}"`), false)
  );
  check("the description is one short line", /How each category counts\./.test(cats) && !/Mark a category as a transfer/.test(cats), true);

  const ins = methodBody("renderInsights");
  check("Insights offers a category picker", /Add a target/.test(ins), true);
  check("with a Set target button", /text: "Set target"/.test(ins), true);
  check("opening the same tuner the Tune buttons use", (ins.match(/new TargetTunerModal\(/g) || []).length, 2);
  check("and saving through the same writer", (ins.match(/setCategoryTarget\(/g) || []).length, 2);
}

console.log("\n  only categories a target can act on are offered");
{
  const rules = [{ merchant_pattern: "TACO", home_label: "Eating Out" }];
  const txs = [
    { id: "t1", date: "2026-09-02", amount: -20, resolved_category: "Eating Out" },
    { id: "t2", date: "2026-09-03", amount: -40, resolved_category: "Gas" },
    { id: "t3", date: "2026-09-04", amount: -500, resolved_category: "Savings" },
    { id: "t4", date: "2026-09-05", amount: -33, resolved_category: "Phone Bill" },
    { id: "t5", date: "2026-09-06", amount: -60, resolved_category: "Groceries" },
    { id: "t6", date: "2026-09-07", amount: -15, resolved_category: "Entertainment" }
  ];
  const meta = [
    { name: "Gas", is_variable_necessity: true },
    { name: "Savings", is_transfer: true },
    { name: "Groceries", monthly_target: 400 },
    { name: "Entertainment" }
  ];
  const ownership = H.completeOwnership({
    fixedExpenses: [{ id: "f1", name: "Phone Co", payment_category: "Phone Bill" }],
    installmentDebts: [{ id: "d1", provider: "ZIP", payment_category: "BNPL" }],
    categoryMeta: meta,
    rules
  });

  // Mirrors the filter the picker applies.
  const spentIn = new Set(txs.filter((t) => t.amount < 0).map((t) => t.resolved_category));
  const offered = H.collectCategories(rules, txs, meta)
    .filter(
      (c) =>
        spentIn.has(c.name) &&
        !(c.monthlyTarget > 0) &&
        H.isDiscretionaryCategory(c.name, meta) &&
        !ownership.isScheduledCategory(c.name)
    )
    .map((c) => c.name)
    .sort();

  check("discretionary categories are offered", offered, ["Eating Out", "Entertainment"]);
  check("a necessity is not", offered.includes("Gas"), false);
  check("a transfer is not", offered.includes("Savings"), false);
  check("a bill a tracker already schedules is not", offered.includes("Phone Bill"), false);
  check("and one already targeted is not offered twice", offered.includes("Groceries"), false);
}

console.log("\n  nor is anything you don't actually spend in");
{
  // Income categories have no business in a list of spending targets. The rule
  // is plain: a target only means something where money goes out.
  const txs = [
    { id: "t1", date: "2026-09-02", amount: 2400, resolved_category: "Paycheck" },
    { id: "t2", date: "2026-09-03", amount: 40, resolved_category: "Refund" },
    { id: "t3", date: "2026-09-04", amount: -20, resolved_category: "Eating Out" }
  ];
  const meta = [{ name: "Paycheck" }, { name: "Refund" }, { name: "Eating Out" }];
  const ownership = H.completeOwnership({ categoryMeta: meta });
  const spentIn = new Set(txs.filter((t) => t.amount < 0).map((t) => t.resolved_category));
  const offered = H.collectCategories([], txs, meta)
    .filter(
      (c) =>
        spentIn.has(c.name) &&
        !(c.monthlyTarget > 0) &&
        H.isDiscretionaryCategory(c.name, meta) &&
        !ownership.isScheduledCategory(c.name)
    )
    .map((c) => c.name);
  check("only the one with outflows", offered, ["Eating Out"]);
}

console.log("\n  the picker uses the same definition the allowance does");
{
  const ins = methodBody("renderInsights");
  check("it asks isDiscretionaryCategory", /isDiscretionaryCategory\(c\.name, categoryMetaList\)/.test(ins), true);
  check("and the ownership index about schedules", /isScheduledCategory\(c\.name\)/.test(ins), true);
  check("rather than re-deriving the flags", /!c\.isTransfer && !c\.isVariableNecessity/.test(ins), false);
}

console.log("\n  the tuner still writes a target the card can read back");
{
  const app = makeApp({ [FILES.categories]: [{ name: "Eating Out" }] });
  await H.setCategoryTarget(app, "Eating Out", 150);
  check("the target is stored", app._store[FILES.categories][0].monthly_target, 150);

  const shown = app._store[FILES.categories].filter((c) => (c.monthly_target || 0) > 0).map((c) => c.name);
  check("so the card now tracks it", shown, ["Eating Out"]);

  // And it stops being offered in the picker.
  const stillOffered = H.collectCategories([], [{ id: "t", date: "2026-09-02", amount: -20, resolved_category: "Eating Out" }], app._store[FILES.categories])
    .filter((c) => !c.isTransfer && !c.isVariableNecessity && !c.isScheduled && !(c.monthlyTarget > 0))
    .map((c) => c.name);
  check("and drops out of the picker", stillOffered, []);

  await H.setCategoryTarget(app, "Eating Out", 0);
  check("clearing it removes the field", "monthly_target" in app._store[FILES.categories][0], false);
}

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
})();
