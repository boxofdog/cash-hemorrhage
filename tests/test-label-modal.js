// 1.26.1 — The label window, simplified: name and amount, category, name, and
// "just this one" or "apply to all", with the rule's pattern folded away.
global.document = { body: { classList: { contains: () => false } } };
const H = require("./harness.js");
const { allText, SettingStub } = H;

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
const type = (t, v) => { t.inputEl.value = v; t.inputEl.dispatchEvent({ type: "input" }); };

function open(modal) {
  SettingStub.texts = [];
  SettingStub.dropdowns = [];
  SettingStub.buttons = [];
  modal.onOpen();
  const fields = {};
  SettingStub.texts.forEach((t) => { if (t.settingName && !fields[t.settingName]) fields[t.settingName] = t; });
  const lists = {};
  SettingStub.dropdowns.forEach((d) => { if (d.settingName) lists[d.settingName] = d; });
  return { el: modal.contentEl, fields, lists };
}
const RAW = "Recurring Withdrawal Debit Card GOOGLE *G1SK002M 855-836-3987 CA Date 09/23/26";
const LABELS = ["Subscription", "Eating Out", "Groceries"];
const rule = { merchant_pattern: "Recurring Withdrawal Debit Card GOOGLE", home_label: "Subscription", display_name: "Relay for Reddit" };

(async () => {
console.log("\n1. What's on screen");
{
  const got = [];
  const m = new H.LabelModal({}, RAW, -1.99, LABELS, (p) => got.push(p), rule, { transactions: [{ merchant_raw: RAW }], rules: [rule], onTransfer: () => got.push("transfer") });
  const { el, fields, lists } = open(m);
  check("the name and amount on one line", [text(byCls(el, "budget-label-name")[0]), text(byCls(el, "budget-label-amount")[0])], ["Relay for Reddit", "-$1.99"]);
  check("the bank's text under it", text(byCls(el, "budget-label-raw")[0]), RAW);
  check("the old heading and hint are gone", /Categorize transaction|money going OUT|How should this apply|Or type a new category|Display nickname/.test(text(el)), false);
  check("fields: category, name, and the pattern (folded)", Object.keys(lists).concat(Object.keys(fields)), ["Category", "New category", "Name", "Pattern to match"]);
  check("the rule's category chosen, the new-category field hidden", [lists.Category.value, fields["New category"].setting.settingEl.classes.has("budget-hidden")], ["Subscription", true]);
  check("its name filled in", fields.Name.inputEl.value, "Relay for Reddit");
  const scope = byCls(el, "budget-label-scope")[0];
  check("what 'all' means, on one closed line", [scope.tag, scope.open, text(find(scope, (x) => x.tag === "summary")[0])], ["details", false, "Applies to: “Recurring Withdrawal Debit Card GOOGLE”"]);
  check("the match count is inside it", byCls(scope, "budget-match-count").length, 1);
  type(fields["Pattern to match"], "GOOGLE *G1SK");
  check("the line follows the pattern", text(find(scope, (x) => x.tag === "summary")[0]), "Applies to: “GOOGLE *G1SK”");
  check("three buttons: transfer apart, then the two answers", buttonsIn(byCls(el, "budget-label-btns")[0]).map((b) => b._text), ["It's a transfer", "Just this one", "Apply to all"]);
  button(el, "Apply to all").onclick();
  check("Apply to all saves the rule with its name", got.pop(), { mode: "rule", pattern: "GOOGLE *G1SK", label: "Subscription", nickname: "Relay for Reddit" });
}

console.log("\n2. Choosing");
{
  let got = [];
  let m = open(new H.LabelModal({}, "RIGOBERTOS TACO 44", -12, LABELS, (p) => got.push(p)));
  check("no rule: nothing chosen yet, the name is a placeholder", [m.lists.Category.value, m.fields.Name.inputEl.value], ["", ""]);
  check("the category list ends with a new one", m.lists.Category.options.map((o) => o.label).slice(-1), ["New category…"]);
  global.__notices = [];
  button(m.el, "Just this one").onclick();
  check("no category: asks for one, saves nothing", [got.length, global.__notices.pop()], [0, "Pick a category first."]);
  m.lists.Category.choose("Eating Out");
  button(m.el, "Just this one").onclick();
  check("Just this one: this transaction only", got.pop(), { mode: "override", pattern: null, label: "Eating Out", nickname: null });

  m = open(new H.LabelModal({}, "RIGOBERTOS TACO 44", -12, LABELS, (p) => got.push(p)));
  m.lists.Category.choose("__new");
  check("New category… opens a field for it", m.fields["New category"].setting.settingEl.classes.has("budget-hidden"), false);
  type(m.fields["New category"], "  Tacos ");
  type(m.fields.Name, "Rigoberto's");
  button(m.el, "Apply to all").onclick();
  check("…and uses what's typed", got.pop(), { mode: "rule", pattern: "RIGOBERTOS TACO 44", label: "Tacos", nickname: "Rigoberto's" });
  m = open(new H.LabelModal({}, "RIGOBERTOS TACO 44", -12, LABELS, (p) => got.push(p)));
  m.lists.Category.choose("__new");
  m.lists.Category.choose("Groceries");
  check("choosing from the list again hides it", m.fields["New category"].setting.settingEl.classes.has("budget-hidden"), true);

  m = open(new H.LabelModal({}, "RIGOBERTOS TACO 44", -12, LABELS, (p) => got.push(p)));
  m.lists.Category.choose("Eating Out");
  type(m.fields["Pattern to match"], "   ");
  global.__notices = [];
  button(m.el, "Apply to all").onclick();
  check("Apply to all with no pattern: opens it and says so", [got.length, byCls(m.el, "budget-label-scope")[0].open, global.__notices.pop()], [0, true, "Apply to all needs a pattern to match."]);

  got = [];
  m = open(new H.LabelModal({}, "RIGOBERTOS TACO 44", -12, LABELS, (p) => got.push(p)));
  m.lists.Category.choose("Eating Out");
  type(m.fields.Name, "Rigoberto's");
  global.__notices = [];
  button(m.el, "Just this one").onclick();
  check("a name typed with Just this one: category saved, and it says the name wasn't", [got.pop().mode, global.__notices.pop()], ["override", "Category changed for this one. A new name only saves with Apply to all."]);

  m = open(new H.LabelModal({}, "FIRST EVER", -3, [], (p) => got.push(p)));
  check("no categories yet: just a field for one", [Object.keys(m.lists).length, m.fields.Category.setting.settingEl.classes.has("budget-hidden")], [0, false]);
  type(m.fields.Category, "Coffee");
  button(m.el, "Just this one").onclick();
  check("…and it's used", got.pop().label, "Coffee");
  check("no transfer button when the caller can't file one", !!button(m.el, "It's a transfer"), false);
  const income = open(new H.LabelModal({}, "PAYROLL", 1612.4, LABELS, () => {}));
  check("money in reads as money in", [text(byCls(income.el, "budget-label-amount")[0]), byCls(income.el, "budget-label-amount")[0].classes.has("budget-positive")], ["+$1612.40", true]);
}

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
})().catch((e) => { console.error(e); process.exit(1); });
