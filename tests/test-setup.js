// 1.25.0 — First-time setup: one button lays out every folder and data file,
// only ever creating what's missing.
const P = require("./paths.js");
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
const F = H.FILES;

// A vault: files and folders, and a log of every write so "nothing was
// touched" can be checked, not assumed.
function makeApp(files = {}, folders = []) {
  const store = {};
  const dirs = new Set(folders);
  const writes = [];
  Object.entries(files).forEach(([k, v]) => (store[k] = typeof v === "string" ? v : JSON.stringify(v)));
  return {
    _store: store, _dirs: dirs, _writes: writes,
    vault: { adapter: {
      exists: async (p) => p in store || dirs.has(p),
      read: async (p) => store[p],
      write: async (p, d) => { writes.push(p); store[p] = d; },
      mkdir: async (p) => { writes.push(p + "/"); dirs.add(p); }
    } }
  };
}
const read = (app, p) => JSON.parse(app._store[p]);
const DATA_FILES = Object.entries(F).filter(([k]) => !H.SETUP_SKIP.has(k));
// How many data files setup makes; counted, so a new file doesn't break these.
const N = DATA_FILES.length;

(async () => {
// ===========================================================================
console.log("\n1. A new vault");
{
  const app = makeApp();
  let st = await H.setupStatus(app);
  check("everything is missing", [st.present, st.missingFiles.length, st.missingFolders, st.readme], [0, N, ["Budget", "Budget/data", "Budget/imports", "Budget/exports"], false]);
  const r = await H.setupBudgetVault(app, { bufferMode: "manual" });
  check("the four folders, parent first", r.folders, ["Budget", "Budget/data", "Budget/imports", "Budget/exports"]);
  check("every data file but the two that appear on their own, and the README", [r.files.length, r.files.includes(F.activePeriod), r.files.includes(F.categoryOrder), r.files.includes("Budget/README.md")], [N + 1, false, false, true]);
  check("each at the value the plugin already treats a missing file as",
    DATA_FILES.filter(([k]) => !["categories", "settings", "simplefinAccounts"].includes(k)).every(([, p]) => JSON.stringify(read(app, p)) === "[]"), true);
  check("SimpleFIN's report starts as an empty object", read(app, F.simplefinAccounts), {});
  check("settings: the defaults, with what's already set kept", read(app, F.settings), Object.assign({}, H.DEFAULT_SETTINGS, { bufferMode: "manual" }));
  const cats = read(app, F.categories);
  check("a starter set of categories", cats.map((c) => c.name), H.STARTER_CATEGORIES.map((c) => c.name));
  check("card payments and savings moves are transfers, not spending", cats.filter((c) => c.is_transfer).map((c) => c.name), ["Credit Card Payment", "Savings"]);
  check("gas is a necessity; the phone bill is a bill", [cats.find((c) => c.name === "Gas").is_variable_necessity, cats.find((c) => c.name === "Phone Bill").exclude_from_discretionary], [true, true]);
  check("reports the starter categories", r.starterCategories, true);
  check("the README says what each folder is for", /imports\/\*\*: drop bank CSV exports here/.test(app._store["Budget/README.md"]) && /exports\/\*\*: \*\*Export\*\* saves/.test(app._store["Budget/README.md"]), true);
  check("data files are pretty-printed JSON like the rest", app._store[F.categories].startsWith("[\n  {"), true);

  st = await H.setupStatus(app);
  check("afterwards: nothing missing", [st.present, st.total, st.missingFiles.length, st.missingFolders.length, st.readme, st.unreadable], [N, N, 0, 0, true, []]);
  const before = app._writes.length;
  const again = await H.setupBudgetVault(app, {});
  check("run again: nothing created, nothing written", [again.folders.length, again.files.length, again.kept, app._writes.length - before], [0, 0, N, 0]);
}

// ===========================================================================
console.log("\n2. A vault with data already in it");
{
  const txs = [{ id: "t1", date: "2026-09-01", amount: -5, resolved_category: "Snacks" }];
  const mine = [{ name: "Snacks", is_transfer: false, monthly_target: 80 }];
  const app = makeApp({ [F.transactions]: txs, [F.categories]: mine, [F.accounts]: "{not json", "Budget/README.md": "my notes" }, ["Budget", "Budget/data"]);
  const r = await H.setupBudgetVault(app, {});
  check("existing files are left exactly as they were", [read(app, F.transactions), read(app, F.categories), app._store["Budget/README.md"]], [txs, mine, "my notes"]);
  check("no starter categories mixed into yours", r.starterCategories, false);
  check("a file that can't be read is reported, not overwritten", [r.unreadable, app._store[F.accounts]], [[F.accounts], "{not json"]);
  check("only the missing folders and files are made", [r.folders, r.files.length, r.kept], [["Budget/imports", "Budget/exports"], N - 3, 3]);
  check("never a write to a file that existed", app._writes.filter((p) => [F.transactions, F.categories, F.accounts, "Budget/README.md"].includes(p)), []);
  check("status reports the unreadable one too", (await H.setupStatus(app)).unreadable, [F.accounts]);
}

// ===========================================================================
console.log("\n3. The plugin reads the new files the way it read none");
{
  const app = makeApp();
  await H.setupBudgetVault(app, {});
  const plugin = Object.assign(Object.create(H.__PluginClass.prototype), { app, settings: {} });
  check("investment accounts: an empty list, none invented", await plugin.loadPortfolioAccounts(), []);
  const v = Object.create(H.BudgetDashboardView.prototype);
  Object.assign(v, { app, plugin });
  const ctx = await v.loadRenderContext();
  check("the label picker offers the starter categories", ctx.existingLabels.includes("Groceries") && ctx.existingLabels.includes("Credit Card Payment"), true);
  check("…sorted, never Uncategorized", [ctx.existingLabels.slice().sort().join() === ctx.existingLabels.join(), ctx.existingLabels.includes("Uncategorized")], [true, false]);
  const withRules = makeApp({ [F.rules]: [{ match: "SHELL", home_label: "Gas" }, { match: "CHEWY", home_label: "Pet Bills" }], [F.categories]: [{ name: "Gas" }, { name: "Uncategorized" }, { name: "Savings", is_transfer: true }] });
  const v2 = Object.assign(Object.create(H.BudgetDashboardView.prototype), { app: withRules, plugin });
  check("rules' categories and categories without a rule, once each", (await v2.loadRenderContext()).existingLabels, ["Gas", "Pet Bills", "Savings"]);
}

// ===========================================================================
console.log("\n4. The button");
{
  const notices = () => global.__notices || [];
  global.__notices = [];
  const app = makeApp({}, ["Budget", "Budget/data", "Budget/imports"]); // what loading the plugin already makes
  let refreshed = 0;
  const plugin = Object.assign(Object.create(H.__PluginClass.prototype), { app, settings: {}, async refreshAfterDataChange() { refreshed++; } });
  const r = await plugin.setupFiles();
  check("says what it made", notices().pop(), `Budget Tracker is set up: created ${N + 1} files and 1 folder. Added a starter set of categories.`);
  check("and refreshes the dashboard", [r.files.length, refreshed], [N + 1, 1]);
  await plugin.setupFiles();
  check("nothing to do says so", notices().pop(), "Everything's already in place. Nothing was changed.");
  check("…without a refresh", refreshed, 1);
  delete app._store[F.debtHistory];
  app._store[F.bufferSweeps] = "oops";
  await plugin.setupFiles();
  check("a deleted file put back; an unreadable one named", notices().pop(),
    `Budget Tracker is set up: created 1 file. ${N - 1} existing files were left as they were. One file can't be read and was left alone: ${F.bufferSweeps}.`);
  const broken = Object.assign(Object.create(H.__PluginClass.prototype), { app: { vault: { adapter: { exists: async () => false, mkdir: async () => { throw new Error("read-only vault"); } } } }, settings: {} });
  check("a failure is reported, not thrown", [await broken.setupFiles(), notices().pop()], [null, "Couldn't finish setting up: read-only vault. Anything already created stays."]);
}

// ===========================================================================
console.log("\n5. Settings");
{
  async function renderSetup(app) {
    const tab = Object.create(H.BudgetSettingTab.prototype);
    const calls = [];
    tab.app = app;
    tab.plugin = { async setupFiles() { calls.push("setup"); } };
    tab.display = () => calls.push("display");
    const root = el("div");
    SettingStub.buttons = [];
    await tab.renderSetupSettings(root);
    return { root, calls, buttons: SettingStub.buttons.slice() };
  }
  const names = (root) => find(root, (x) => x.classes && x.classes.has("setting-name")).map(text);
  let { root, calls, buttons } = await renderSetup(makeApp({}, ["Budget", "Budget/data", "Budget/imports"]));
  check("a new install: a Setup heading and one button", [names(root), buttons.map((b) => b.label)], [["Setup", "Set up Budget Tracker"], ["Set up"]]);
  check("it says what it will make", /Creates the Budget folder .* data, imports and exports .* a starter set of categories/.test(text(root)), true);
  await buttons[0].cb();
  check("pressing it sets up, then redraws the tab", calls, ["setup", "display"]);

  const partial = makeApp();
  await H.setupBudgetVault(partial, {});
  delete partial._store[F.debtHistory];
  ({ root, buttons } = await renderSetup(partial));
  check("a file gone: says how many, and only makes those", [names(root)[1], buttons[0].label, new RegExp(`1 of the plugin's ${N} data files is missing`).test(text(root)), /existing data isn't changed/.test(text(root))], ["Create missing files", "Create missing files", true, true]);

  const done = makeApp();
  await H.setupBudgetVault(done, {});
  ({ root, buttons } = await renderSetup(done));
  check("all in place: one quiet line, no heading", [names(root), buttons.map((b) => b.label)], [["Data files"], ["Check again"]]);
  check("…saying so", new RegExp(`All ${N} data files and the Budget, data, imports and exports folders are in place\\.`).test(text(root)), true);

  // It leads the page: nothing else in settings has anywhere to save until it's done.
  const src = require("fs").readFileSync(P.MAIN, "utf8");
  const body = src.slice(src.indexOf("async renderSettings() {"), src.indexOf("async renderSettings() {") + 400);
  check("first in the settings tab", /containerEl\.empty\(\);\s*await this\.renderSetupSettings\(containerEl\);\s*await this\.renderBufferSettings/.test(body), true);
  check("and a command for it", /id: "set-up-files", name: "Set up data files and folders", callback: \(\) => this\.setupFiles\(\)/.test(src), true);
}

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
})().catch((e) => { console.error(e); process.exit(1); });
