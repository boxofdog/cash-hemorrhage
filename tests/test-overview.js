// Regression tests for the 1.10.0 Overview consolidation. These assert where
// things ENDED UP, because the whole change is about moving content — a test
// that only checked something was gone would pass if it had been lost.
const P = require("./paths.js");
global.document = { body: { classList: { contains: () => false } } };
const fs = require("fs");
const H = require("./harness.js");
const HF = require("./harness-for.js")(P.MAIN);
const { el } = H;

let pass = 0, fail = 0;
function check(name, got, want) {
  const ok = JSON.stringify(got) === JSON.stringify(want);
  if (ok) { pass++; console.log(`  PASS  ${name}`); }
  else { fail++; console.log(`  FAIL  ${name}: got ${JSON.stringify(got)}, want ${JSON.stringify(want)}`); }
}

const RESULT = JSON.parse(fs.readFileSync(P.FIXTURES + "/fixture-result.json", "utf8"));
const CTX = JSON.parse(fs.readFileSync(P.FIXTURES + "/fixture-ctx.json", "utf8"));
CTX.ownership = H.completeOwnership({
  fixedExpenses: [], installmentDebts: CTX.installmentDebts, revolvingDebts: CTX.revolvingDebts,
  goals: CTX.savingsGoals, categoryMeta: CTX.categoryMetaList, rules: CTX.rules
});

function makeView(state = {}) {
  const v = Object.create(HF.BudgetDashboardView.prototype);
  Object.assign(v, {
    sectionOpen: {}, scrollMemory: {}, activeTab: "overview",
    pieRange: null, expandedSpendCategory: null, expandedIncomeCategory: null,
    activePieTab: "spending", app: {}, lastResult: RESULT,
    plugin: {
      settings: { savingsMode: false, bufferMode: "manual", manualBuffer: 350 },
      expiredPeriod: null, lastResult: null,
      promptEnterPaycheck() {}, promptQuickBalance() {}, hasSimpleFINConnection() { return false; }, syncing: false,
      recalculate: async () => {}, refreshAfterDataChange: async () => {},
      fixedPaymentCandidates: async () => [], pendingSweep: async () => null, openSweepModal: async () => {}
    }
  }, state);
  return v;
}
const text = (n) => [n._text || ""].concat((n.children || []).map(text)).join(" ");
function find(n, pred, out = []) {
  if (pred(n)) out.push(n);
  (n.children || []).forEach((k) => find(k, pred, out));
  return out;
}
const byClass = (n, c) => find(n, (x) => x.classes && x.classes.has(c));
const kids = (n, c) => (n.children || []).filter((k) => k.classes && k.classes.has(c));

async function renderOverview(state) {
  const v = makeView(state);
  const c = el("div");
  await v.renderOverview(c, CTX);
  await new Promise((r) => setTimeout(r, 40));
  return { root: c, view: v };
}

(async () => {

// ===========================================================================
console.log("\n1. The hero shows two numbers, not a number and its own duplicate");
{
  const { root } = await renderOverview();
  const hero = byClass(root, "budget-hero")[0];
  check("there is one hero", !!hero, true);

  const labels = byClass(hero, "budget-hero-label").map((n) => n._text);
  check("the duplicated free-cash block is gone", labels.some((l) => /stash|Free cash/i.test(l)), false);
  check("Spendable leads", labels[0], "Spendable till payday");

  // Both headline figures are full-size now.
  const big = byClass(hero, "budget-hero-number").length;
  const small = byClass(hero, "budget-hero-number-sm").length;
  check("two primary numbers", big, 2);
  check("and none of them small", small, 0);
  // Safe unconditionally: bufferRemaining is clamped at zero upstream, so this
  // figure never goes negative and the green can never contradict it.
  const spend = byClass(hero, "budget-hero-number")[0];
  check("Spendable reads as money you have", spend.classes.has("budget-positive"), true);

  // The basis line explains the whole hero, so it hangs off the hero itself
  // rather than being trapped inside a block that no longer exists.
  const basis = byClass(hero, "budget-hero-basis");
  check("the basis line survived", basis.length, 1);
  check("as a direct child of the hero", kids(hero, "budget-hero-basis").length, 1);
  check("carrying its Update balance button", text(basis[0]).includes("Update balance"), true);
  // It gets its own row from the hero being a column stack, not from an inline
  // width. The stack is what makes the figures row fill the bar.
  // Comments stripped: a rule that EXPLAINS why it dropped a property still
  // contains the word, and asserting against the raw text would match it.
  const CSS0 = fs.readFileSync(P.STYLES, "utf8")
    .replace(/\/\*[\s\S]*?\*\//g, "");
  check("the hero stacks", /\.budget-hero\s*\{[^}]*flex-direction:\s*column/.test(CSS0), true);
  check("and no longer wraps its children into lines", /\.budget-hero\s*\{[^}]*flex-wrap/.test(CSS0), false);
  check("the figures share a row of their own", byClass(hero, "budget-hero-figures").length, 1);
}

console.log("\n  the buffer drill-downs moved into the hero with it");
{
  const { root } = await renderOverview();
  const hero = byClass(root, "budget-hero")[0];
  const titles = byClass(hero, "budget-collapsible-title").map((n) => n._text);
  check("'Where this period's money went' is in the hero", titles.includes("Where this period's money went"), true);

  // And no longer under the list of bills.
  const cards = byClass(root, "budget-card");
  const due = cards.find((c) => text(c).includes("Due this pay period"));
  check("the obligations card has no collapsibles left", byClass(due, "budget-collapsible").length, 0);
}

// ===========================================================================
console.log("\n2. The obligations card is only what's due");
{
  const { root } = await renderOverview();
  const due = byClass(root, "budget-card").find((c) => text(c).includes("Due this pay period"));
  check("no 'Cash held for daily spend' row", text(due).includes("Cash held for daily spend"), false);
  check("no buffer row at all", byClass(due, "budget-buffer-row").length, 0);
  check("the bills are still there", text(due).includes("Phone Co"), true);
  check("and so are the minimums", text(due).includes("Affirm - Tablet"), true);
  check("the minimums-paid line is one sentence", /total paid in minimums this period\./.test(text(due)), true);
  check("not the old explanation", text(due).includes("not counted again"), false);
}

// ===========================================================================
console.log("\n3. Necessities sit under subscriptions");
{
  const { root } = await renderOverview();
  check("no standalone necessities card", byClass(root, "budget-necessity-card").length, 0);

  const subs = byClass(root, "budget-card").find((c) => text(c).includes("Upcoming subscriptions due"));
  check("the heading moved into the subscriptions card", text(subs).includes("Projected necessities"), true);
  check("with its rows", byClass(subs, "budget-necessity-row").length > 0, true);
  check(
    "and the explanatory paragraph is gone",
    text(subs).includes("Things you'll probably need to buy before payday"),
    false
  );
  check("each row still says it is a forecast", /purchases? before payday/.test(text(subs)), true);
}

// ===========================================================================
console.log("\n4. Savings and payoff share one full-width card");
{
  const { root } = await renderOverview();
  check("the old payoff method is gone", typeof HF.BudgetDashboardView.prototype.renderPayoffCard, "undefined");
  check("replaced by one card builder", typeof HF.BudgetDashboardView.prototype.renderRecommendationsCard, "function");

  const rec = byClass(root, "budget-card-wide")[0];
  check("there is one such card", !!rec, true);
  check("it spans the grid", rec.classes.has("budget-card-wide"), true);
  check("no separate savings card", byClass(root, "budget-savings-plan").length, 0);

  const split = (rec.children || []).find((k) => k.classes && k.classes.has("budget-split"));
  check("with a two-column layout inside", !!split, true);
  check("holding both halves", (split.children || []).length, 2);

  // The layout is a stylesheet rule now rather than an inline style, so the
  // rule has to exist for the markup to mean anything.
  const CSS = fs.readFileSync(P.STYLES, "utf8");
  check("the span rule exists", /\.budget-card-wide\s*\{[^}]*grid-column:\s*1\s*\/\s*-1/.test(CSS), true);
  check("and wraps rather than squashing", /\.budget-split\s*\{[^}]*auto-fit, minmax\(280px, 1fr\)/.test(CSS), true);
  check("payoff on the left", text(split.children[0]).includes("Recommended payoff"), true);
  check("savings on the right", text(split.children[1]).includes("Recommended savings"), true);
}

console.log("\n  the savings column explains itself when the mode is off");
{
  const modeOff = Object.assign({}, RESULT, { savingsMode: false });
  const { root } = await renderOverview({ lastResult: modeOff });
  const rec = byClass(root, "budget-card-wide")[0];
  // It used to render nothing at all, which read as "savings isn't a thing"
  // rather than "it's switched off".
  check("it says why it is empty", text(rec).includes("Debt Reduction is on"), true);
  check("and points at the switch, not a settings page", text(rec).includes("top of the dashboard"), true);
  check("no card title competing with the column headers", find(rec, (n) => n.tag === "h4").length, 0);
}

console.log("\n  with the mode on, the real breakdown appears");
{
  const withMode = Object.assign({}, RESULT, {
    savingsMode: true,
    savingsBreakdown: [{ target: "Dog food", amount: 120, reason: "paced to its deadline" }],
    recommendedSavings: 120
  });
  const { root } = await renderOverview({ lastResult: withMode });
  const rec = byClass(root, "budget-card-wide")[0];
  check("the goal is listed", text(rec).includes("Dog food"), true);
  check("with its reason", text(rec).includes("paced to its deadline"), true);
  check("and payoff says it is paused", text(rec).includes("Paused while Savings Focus is on"), true);
  // Copy trimmed: the long version explained the mechanics of minimum payments
  // in a column that is only there to say the other column has the money.
  check("naming where to change it", text(rec).includes("switch to Debt Reduction at the top of the dashboard"), true);
  check("without the old paragraph", text(rec).includes("held as cash instead of sent to principal"), false);
  check("and the total is one line", text(rec).includes("$120.00 allocated to goals."), true);
  check("not the old explanation", text(rec).includes("Dated goals are funded to the pace"), false);
}

// ===========================================================================
console.log("\n5. One cash-flow card, two views");
{
  check("the old chart methods are gone", [
    typeof HF.BudgetDashboardView.prototype.renderSpendChart,
    typeof HF.BudgetDashboardView.prototype.renderIncomeChart
  ], ["undefined", "undefined"]);
  check("replaced by one", typeof HF.BudgetDashboardView.prototype.renderCashFlowChart, "function");

  const { root } = await renderOverview({ pieRange: "all" });
  check("one pie card", byClass(root, "budget-pie-card").length, 1);
  check("and no separate income card", byClass(root, "budget-income-card").length, 0);

  const header = byClass(root, "budget-pie-header")[0];
  const btns = find(header, (n) => n.tag === "button").map((b) => b._text);
  check("a two-way toggle in the header", btns, ["Spending", "Income"]);
  check("no 'Spending by category' heading any more", text(root).includes("Spending by category"), false);
  check("nor 'Income by category'", text(root).includes("Income by category"), false);

  const active = find(header, (n) => n.tag === "button" && n.classes.has("budget-segment-on")).map((b) => b._text);
  check("the showing view is marked", active, ["Spending"]);
  check("as one joined control, not two buttons", byClass(header, "budget-segmented").length, 1);

  // The range select governs both views, and there is only one of it now.
  check("one range select", byClass(root, "budget-range-select").length, 1);
}

console.log("\n  the income view carries its own drill-down and actions");
{
  const { root } = await renderOverview({
    pieRange: "all",
    activePieTab: "income",
    expandedIncomeCategory: "Paycheck"
  });
  const pie = byClass(root, "budget-pie-card")[0];
  const t = text(pie);
  check("income totals are shown", t.includes("Total income in range"), true);
  check("the slice is legible", t.includes("Paycheck"), true);
  check("the drill-down opened", byClass(pie, "budget-drilldown").length, 1);
  check("with a real deposit in it", t.includes("ACME FOODS, INC."), true);
  check("the mark-as-transfer action survived", t.includes("Not income — mark as transfer"), true);
  check("and every row can still be moved", find(pie, (n) => n.tag === "button" && n._text === "Move").length > 0, true);

  const active = find(byClass(root, "budget-pie-header")[0], (n) => n.tag === "button" && n.classes.has("budget-segment-on"))
    .map((b) => b._text);
  check("the toggle follows the view", active, ["Income"]);
}

console.log("\n  the spending view carries its own too");
{
  const { root } = await renderOverview({
    pieRange: "all",
    activePieTab: "spending",
    expandedSpendCategory: "Eating Out"
  });
  const pie = byClass(root, "budget-pie-card")[0];
  const t = text(pie);
  check("spend totals are shown", t.includes("Total spend in range"), true);
  check("the drill-down opened", byClass(pie, "budget-drilldown").length, 1);
  check("the mark-as-transfer action survived", t.includes("Not spending — mark as transfer"), true);
  check("and every row can still be moved", find(pie, (n) => n.tag === "button" && n._text === "Move").length > 0, true);
}

console.log("\n  switching view clears the other view's open drill-down");
{
  const { root, view } = await renderOverview({ pieRange: "all", expandedSpendCategory: "Eating Out" });
  view.render = () => {};
  const incomeBtn = find(byClass(root, "budget-pie-header")[0], (n) => n.tag === "button" && n._text === "Income")[0];
  incomeBtn.onclick();
  check("the view switched", view.activePieTab, "income");
  // Leaving it set would reopen a category that isn't in the other dataset.
  check("the spending drill-down was cleared", view.expandedSpendCategory, null);
  check("and the income one too", view.expandedIncomeCategory, null);
}

console.log("\n  pressing the view you are already on does nothing");
{
  const { root, view } = await renderOverview({ pieRange: "all", expandedSpendCategory: "Eating Out" });
  let rendered = 0;
  view.render = () => { rendered++; };
  const spendBtn = find(byClass(root, "budget-pie-header")[0], (n) => n.tag === "button" && n._text === "Spending")[0];
  spendBtn.onclick();
  check("no re-render", rendered, 0);
  check("and the open drill-down is left alone", view.expandedSpendCategory, "Eating Out");
}

// ===========================================================================
console.log("\nThe grid still holds the cards it should");
{
  const { root } = await renderOverview();
  const grid = byClass(root, "budget-grid")[0];
  const headings = kids(grid, "budget-card").map((c) => {
    const h = find(c, (n) => n.tag === "h4")[0];
    return h ? h._text : "(no h4)";
  });
  check("three cards, in order", headings, [
    "Due this pay period",
    "Upcoming subscriptions due",
    // The surplus card's column headers are its labels; a title above them was
    // a third name for the same thing.
    "(no h4)"
  ]);
  check("and the last one is the surplus card", kids(grid, "budget-card")[2].classes.has("budget-card-wide"), true);
}


// ===========================================================================
console.log("\nThe chart palette (1.22.2: the UI's own colours, eighteen of them)");
{
  const SRC = fs.readFileSync(P.MAIN, "utf8");
  check("eighteen colours, led by the UI's lavender and the Oopsie cyan", [H.PIE_COLORS.length, H.PIE_COLORS[0], H.PIE_COLORS[1]], [18, "#A28AF6", "#4ECCCC"]);
  check("the dashboard's green and red in the middle", [H.PIE_COLORS.indexOf("#42CC6C") + 1, H.PIE_COLORS.indexOf("#F64848") + 1], [6, 8]);
  check("all different", new Set(H.PIE_COLORS).size, 18);
  check("every entry is a literal hex colour (an unresolvable SVG fill renders black)", H.PIE_COLORS.every((c) => /^#[0-9A-F]{6}$/.test(c)), true);

  // The slices and the legend swatches both have to resolve it, and they take
  // different paths: an SVG presentation attribute and a CSSOM style setter.
  check("slices set it as an SVG fill attribute", /fill="\$\{s\.color\}"/.test(SRC), true);
  check("swatches set it through the CSSOM", /\.style\.backgroundColor = s\.color/.test(SRC), true);
}


// ===========================================================================
console.log("\nStrategy is a switch in the action bar, not a setting");
{
  // It lives in renderView's action bar now, not the Overview body, so it has
  // to be rendered through the whole view to be seen at all.
  const renderFull = async (savingsMode) => {
    const v = makeView();
    v.plugin = Object.assign({}, v.plugin, {
      settings: { savingsMode, bufferMode: "manual", manualBuffer: 350 },
      promptImportCSV() {}, promptMarkFixedPaid() {}, openSettings() {}
    });
    v.contentEl = el("div");
    v.loadRenderContext = async () => CTX;
    await v.renderView();
    await new Promise((r) => setTimeout(r, 40));
    return v.contentEl;
  };
  const seg = (root) => find(byClass(root, "budget-strategy-wrap")[0], (n) => n.tag === "button");

  const d = await renderFull(false);
  const db = seg(d);
  check("two choices", db.map((b) => b._text), ["Debt Reduction", "Savings Focus"]);
  check("Debt Reduction is the live one", db.filter((b) => b.classes.has("budget-segment-on")).map((b) => b._text), ["Debt Reduction"]);

  const sv = await renderFull(true);
  check("Savings Focus is the live one",
    seg(sv).filter((b) => b.classes.has("budget-segment-on")).map((b) => b._text), ["Savings Focus"]);

  // Inside the action bar, so it is reachable from every tab rather than only
  // from the Overview body.
  const bar = byClass(sv, "budget-action-bar")[0];
  check("it sits in the action bar", byClass(bar, "budget-strategy-wrap").length, 1);
  check("as its last item", [...(bar.children[bar.children.length - 1].classes || [])].join("."), "budget-strategy-wrap");
  check("and not in the Overview body", byClass((await renderOverview()).root, "budget-strategy-wrap").length, 0);

  // Which also means it is there before the first paycheck has been entered.
  const fresh = makeView({ lastResult: null });
  fresh.plugin = Object.assign({}, fresh.plugin, {
    settings: { savingsMode: false }, promptImportCSV() {}, promptMarkFixedPaid() {}, openSettings() {}
  });
  fresh.contentEl = el("div");
  fresh.loadRenderContext = async () => CTX;
  await fresh.renderView();
  await new Promise((r) => setTimeout(r, 40));
  check("and on an empty dashboard", byClass(fresh.contentEl, "budget-strategy-wrap").length, 1);

  // Pushed right rather than centred, and given a row of its own on a phone so
  // the action bar's horizontal scroll can't hide it.
  const CSS = fs.readFileSync(P.STYLES, "utf8").replace(/\/\*[\s\S]*?\*\//g, "");
  check("right-aligned in the bar", /\.budget-strategy-wrap\s*\{[^}]*margin-left:\s*auto/.test(CSS), true);
  check("full width on a phone", /\.budget-strategy-wrap\s*\{[^}]*flex:\s*0 0 100%/.test(CSS), true);
  check("and the bar wraps there instead of scrolling",
    /@media \(max-width: 700px\)[\s\S]{0,400}\.budget-action-bar\s*\{[^}]*flex-wrap:\s*wrap/.test(CSS), true);
}

console.log("\n  pressing a choice writes it and recalculates");
{
  const written = {};
  let recalculated = 0;
  const v = makeView();
  v.plugin.settings = { savingsMode: false };
  v.plugin.refreshAfterDataChange = async () => { recalculated++; };
  v.app = { vault: { adapter: {
    exists: async () => true, read: async () => "{}",
    write: async (k, val) => { written[k] = JSON.parse(val); }
  } } };
  const c = el("div");
  v.renderStrategySwitch(c);
  const btns = find(c, (n) => n.tag === "button");

  await btns[1].onclick();                       // Savings Focus
  check("the setting flipped", v.plugin.settings.savingsMode, true);
  check("and was persisted", written["Budget/data/settings.json"].savingsMode, true);
  // Repainting alone would leave every figure showing the old strategy's plan.
  check("and the budget was recalculated", recalculated, 1);

  await btns[0].onclick();                       // the one already off is now on
  check("pressing the live choice does nothing", recalculated, 1);
}

console.log("\n  the banner only appears when it says something the switch doesn't");
{
  // Open-ended Savings Focus: the switch already carries the whole message.
  const open = await renderOverview({ plugin: Object.assign({}, makeView().plugin, {
    settings: { savingsMode: true, savingsDeadline: null, bufferMode: "manual", manualBuffer: 350 } }) });
  check("no banner with no deadline", byClass(open.root, "budget-reloc-banner").length, 0);

  // With a deadline there is a countdown, which the switch does not carry.
  const dated = await renderOverview({ plugin: Object.assign({}, makeView().plugin, {
    settings: { savingsMode: true, savingsDeadline: "2026-12-01", bufferMode: "manual", manualBuffer: 350 } }) });
  check("a banner when there is a countdown", byClass(dated.root, "budget-reloc-banner").length, 1);
  check("under the new name", text(dated.root).includes("Savings Focus"), true);
  check("and not the old one", text(dated.root).includes("SAVINGS MODE"), false);
}

console.log("\n  the copy names the switch, not a settings toggle");
{
  const sv = await renderOverview({ plugin: Object.assign({}, makeView().plugin, {
    settings: { savingsMode: true, bufferMode: "manual", manualBuffer: 350 } }) });
  const rec = byClass(sv.root, "budget-card-wide")[0];
  check("paused payoff points at the switch", text(rec).includes("switch to Debt Reduction at the top of the dashboard"), true);
  check("not at a toggle", text(rec).includes("turn off to see debt paydown"), false);

  const d = await renderOverview({ lastResult: Object.assign({}, RESULT, { savingsMode: false }) });
  const recD = byClass(d.root, "budget-card-wide")[0];
  check("the savings column points at it too", text(recD).includes("Switch to Savings Focus at the top"), true);
  check("and no longer says Settings", text(recD).includes("Turn it on in Settings"), false);
}

console.log("\n  Settings describes the strategy rather than duplicating the control");
{
  const SRC = fs.readFileSync(P.MAIN, "utf8");
  const start = SRC.indexOf("async renderSavingsSettings(");
  const body = SRC.slice(start, SRC.indexOf("\n  async ", start + 10));
  check("the section is called Strategy", /createEl\("h3", \{ text: "Strategy" \}\)/.test(body), true);
  // A second control for the same setting is a second source of truth.
  check("no toggle left in settings", /addToggle/.test(body), false);
  check("Debt Reduction gets an explanation", body.includes("You are currently in Debt Reduction mode"), true);
  check("and returns before the deadline field", body.indexOf("return;") < body.indexOf("Deadline (optional)"), true);
  check("which only Savings Focus sees", body.includes("Deadline (optional)"), true);
}

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
})();
