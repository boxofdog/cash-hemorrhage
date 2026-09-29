// Categories settings: one Settings dialog per category instead of five
// buttons, and a "necessary expense" type for unavoidable one-off spending
// (an oil change) that stays out of the spending allowance without being
// projected or reserved.
global.document = { body: { classList: { contains: () => false } } };
const H = require("./harness.js");
const { el, allText, SettingStub } = H;

let pass = 0, fail = 0;
function check(name, got, want) {
  const ok = JSON.stringify(got) === JSON.stringify(want);
  if (ok) { pass++; console.log(`  PASS  ${name}`); }
  else { fail++; console.log(`  FAIL  ${name}: got ${JSON.stringify(got)}, want ${JSON.stringify(want)}`); }
}
const F = H.FILES;
const START = "2026-09-15", END = "2026-09-29";

function makeApp(seed = {}) {
  const store = Object.assign({ [F.categories]: [] }, seed);
  return {
    _store: store,
    vault: { adapter: {
      exists: async (k) => k in store,
      read: async (k) => JSON.stringify(store[k] ?? []),
      write: async (k, v) => { store[k] = JSON.parse(v); }
    } }
  };
}
const flags = (app, name) => {
  const c = app._store[F.categories].find((x) => x.name === name) || {};
  return ["is_transfer", "is_variable_necessity", "exclude_from_discretionary", "is_necessary_expense"].filter((k) => c[k]);
};

(async () => {
// ===========================================================================
console.log("\n1. One type at a time");
{
  const app = makeApp({ [F.categories]: [{ name: "Gas", is_transfer: false, is_variable_necessity: true, variable_min_amount: 20, exclude_from_discretionary: true }] });
  await H.setCategoryKind(app, "Gas", "necessary_expense");
  check("necessary expense clears every other type", flags(app, "Gas"), ["is_necessary_expense"]);
  check("and the necessity minimum with it", app._store[F.categories][0].variable_min_amount, undefined);
  await H.setCategoryKind(app, "Gas", "variable_necessity", 25.5);
  check("variable necessity keeps its minimum", [flags(app, "Gas"), app._store[F.categories][0].variable_min_amount], [["is_variable_necessity"], 25.5]);
  await H.setCategoryKind(app, "Gas", "transfer");
  check("transfer is exclusive too", flags(app, "Gas"), ["is_transfer"]);
  await H.setCategoryKind(app, "Gas", "scheduled_bill");
  check("scheduled bill", flags(app, "Gas"), ["exclude_from_discretionary"]);
  await H.setCategoryKind(app, "Gas", "spending");
  check("spending clears them all", flags(app, "Gas"), []);
  await H.setCategoryKind(app, "Oil change", "necessary_expense");
  check("a category with no record yet is created", flags(app, "Oil change"), ["is_necessary_expense"]);
  await H.setCategoryKind(app, "Brand new", "spending");
  check("spending on an unknown category writes nothing", app._store[F.categories].some((c) => c.name === "Brand new"), false);

  check("the dialog reads the strongest setting", [
    H.categoryKindOf({ isTransfer: true, isVariableNecessity: true }),
    H.categoryKindOf({ isVariableNecessity: true, isScheduled: true }),
    H.categoryKindOf({ isScheduled: true, isNecessaryExpense: true }),
    H.categoryKindOf({ isNecessaryExpense: true }),
    H.categoryKindOf({})
  ], ["transfer", "variable_necessity", "scheduled_bill", "necessary_expense", "spending"]);
}

// ===========================================================================
console.log("\n2. A necessary expense stays out of the allowance");
{
  const meta = (extra) => [{ name: "Car Maintenance", is_transfer: false }, { name: "Eating Out", is_transfer: false }].map((c) => c.name === "Car Maintenance" ? Object.assign(c, extra) : c);
  const tx = (id, amt, cat) => ({ id, date: "2026-09-18", amount: amt, resolved_category: cat, merchant_raw: "SHOP", account_id: "Main Checking" });
  const run = (categoryMeta, txs) => H.runAllocation({
    cashOnHand: 1000, todayStr: START, nextPaydayStr: END, currentDateStr: "2026-09-20",
    fixedExpenses: [], installmentDebts: [], revolvingDebts: [], upcomingSubs: [], earmarked: 0,
    savingsMode: false, goals: [], paychecksFor: {}, transactions: txs, categoryMeta,
    bufferMode: "manual", manualBuffer: 350,
    bufferAllocation: { amount: 350, mode: "manual", manualBuffer: 350, capturedFor: START },
    subscriptionKeys: [], rules: []
  });
  const oil = [tx("o1", -64.5, "Car Maintenance")];

  const ordinary = run(meta({}), oil);
  const necessary = run(meta({ is_necessary_expense: true }), oil);
  check("as ordinary spending it draws the allowance down", ordinary.bufferRemaining, 350 - 64.5);
  check("as a necessary expense the allowance is untouched", necessary.bufferRemaining, 350);
  check("nothing is reserved or projected for it", necessary.committed, run(meta({}), []).committed);
  check("it is owned as a necessary expense", necessary.ownershipSummary.byType.map((b) => b.type), ["necessary_expense"]);
  check("and counted once in where the money went", [necessary.ownershipSummary.total, necessary.ownershipSummary.count], [64.5, 1]);
  check("it is not asked about as an unmatched bill", necessary.unreconciled.pairs.length + necessary.unreconciled.needsMatching.length, 0);
  check("the discretionary test agrees", [
    H.isDiscretionaryCategory("Car Maintenance", meta({})),
    H.isDiscretionaryCategory("Car Maintenance", meta({ is_necessary_expense: true }))
  ], [true, false]);
  const app = makeApp({ [F.categories]: meta({ is_necessary_expense: true }) });
  const listed = H.collectCategories([], oil, app._store[F.categories]).find((c) => c.name === "Car Maintenance");
  check("settings list knows it", listed.isNecessaryExpense, true);
}

// ===========================================================================
console.log("\n3. Merging keeps the type");
{
  const app = makeApp({ [F.categories]: [{ name: "Oil", is_necessary_expense: true }, { name: "Car Maintenance" }], [F.rules]: [], [F.transactions]: [], [F.fixedExpenses]: [], [F.installmentDebts]: [], [F.revolvingDebts]: [] });
  await H.renameCategory(app, "Oil", "Car Maintenance");
  check("a flag set on either side survives a merge", flags(app, "Car Maintenance"), ["is_necessary_expense"]);
}

// ===========================================================================
console.log("\n4. The Settings dialog");
{
  const cat = (over = {}) => Object.assign({ name: "Car Maintenance", ruleCount: 2, txCount: 5, overrideCount: 0 }, over);
  const open = (c, onSave) => {
    SettingStub.texts = []; SettingStub.dropdowns = []; SettingStub.buttons = [];
    const m = new H.CategorySettingsModal({}, c, ["Car Maintenance", "Gas"], onSave || (() => {}));
    m.contentEl = el("div");
    m.onOpen();
    return m;
  };
  let m = open(cat());
  const dd = SettingStub.dropdowns.find((d) => d.settingName === "Treat as");
  check("five types, in order", dd.options.map((o) => o.label), ["Spending", "Variable necessity", "Scheduled bill", "Necessary expense", "Transfer"]);
  check("starts on the category's current type", dd.value, "spending");
  check("a hint explains the choice", /Draws down your spending allowance/.test(allText(m.contentEl)), true);
  m = open(cat({ isNecessaryExpense: true }));
  check("an existing necessary expense opens on it", SettingStub.dropdowns.find((d) => d.settingName === "Treat as").value, "necessary_expense");
  m = open(cat({ isVariableNecessity: true, variableMinAmount: 20 }));
  check("a variable necessity opens on it, with its minimum", [SettingStub.dropdowns.find((d) => d.settingName === "Treat as").value, SettingStub.texts.find((t) => t.settingName === "Ignore purchases under").inputEl.value], ["variable_necessity", "20"]);

  const saved = [];
  m = open(cat({ isNecessaryExpense: true }), (p) => saved.push(p));
  SettingStub.buttons.find((b) => b.label === "Save").cb();
  check("saving hands back the name and type together", saved, [{ name: "Car Maintenance", kind: "necessary_expense", minAmount: 0 }]);
  m = open(cat({ isVariableNecessity: true, variableMinAmount: 20 }), (p) => saved.push(p));
  SettingStub.buttons.find((b) => b.label === "Save").cb();
  check("a necessity keeps its minimum through a save", saved[1], { name: "Car Maintenance", kind: "variable_necessity", minAmount: 20 });
}

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
})();
