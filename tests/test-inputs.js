// 1.14.0 — date pickers, money fields, live pattern reach, category order by
// use, and chart hover.
//
// The input changes replace ad hoc parsing at ~20 save sites, so the
// differential section proves every well-formed figure parses to exactly what
// it did before; only malformed ones change, and they change from "silently a
// different number" to "refused with a reason". The browser section runs the
// real event handlers in Chromium, since the DOM shim can't tell whether a
// blur-then-reformat or a crosshair actually works.
const P = require("./paths.js");
global.document = { body: { classList: { contains: () => false } } };
const fs = require("fs");
const H = require("./harness.js");
const { el, SettingStub } = H;

let pass = 0, fail = 0;
function check(name, got, want) {
  const ok = JSON.stringify(got) === JSON.stringify(want);
  if (ok) { pass++; console.log(`  PASS  ${name}`); }
  else { fail++; console.log(`  FAIL  ${name}: got ${JSON.stringify(got)}, want ${JSON.stringify(want)}`); }
}
const SRC = fs.readFileSync(P.MAIN, "utf8");
const text = (n) => [n._text || ""].concat((n.children || []).map(text)).join(" ");
function find(n, pred, out = []) {
  if (pred(n)) out.push(n);
  (n.children || []).forEach((k) => find(k, pred, out));
  return out;
}
const byClass = (n, c) => find(n, (x) => x.classes && x.classes.has(c));
const notices = () => (global.__notices || []);
const clearNotices = () => { global.__notices = []; };
function fakeApp(files = {}) {
  const store = Object.assign({}, Object.fromEntries(Object.entries(files).map(([k, v]) => [k, JSON.stringify(v)])));
  return {
    _store: store,
    read: (k) => (k in store ? JSON.parse(store[k]) : undefined),
    vault: { adapter: {
      exists: async (p) => p in store, read: async (p) => store[p],
      write: async (p, d) => { store[p] = d; }, mkdir: async () => {}, list: async () => ({ files: [], folders: [] })
    } }
  };
}
// Open a modal and hand back the text fields it rendered, keyed by setting name.
function openModal(modal) {
  SettingStub.texts = [];
  SettingStub.buttons = [];
  modal.open();
  const fields = {};
  SettingStub.texts.forEach((t) => { if (t.settingName && !fields[t.settingName]) fields[t.settingName] = t; });
  return { modal, fields, buttons: SettingStub.buttons.slice() };
}
const type = (t, v) => { t.inputEl.value = v; t.inputEl.dispatchEvent({ type: "input" }); };
const blur = (t) => t.inputEl.dispatchEvent({ type: "blur" });
const press = (buttons, label) => { const b = buttons.find((x) => x.label === label); if (!b) throw new Error(`no button ${label}`); return b.cb(); };

(async () => {

// ===========================================================================
console.log("\n1. Money: the parser");
{
  const v = (raw, o) => { const r = H.parseMoneyInput(raw, o); return r.ok ? (r.empty ? "empty" : r.value) : "ERR"; };
  check("plain", v("1234.5"), 1234.5);
  check("dollar sign and thousands", v("$1,234.50"), 1234.5);
  check("surrounding space", v("  42 "), 42);
  check("leading decimal", v(".5"), 0.5);
  check("trailing decimal point", v("5."), 5);
  check("zero", v("0"), 0);
  check("blank is empty, not zero", v(""), "empty");
  check("negative refused by default", v("-40"), "ERR");
  check("negative allowed where asked", v("-40", { allowNegative: true }), -40);
  check("minus before the dollar sign", v("-$40", { allowNegative: true }), -40);
  check("minus after the dollar sign", v("$-40", { allowNegative: true }), -40);
  check("accounting parentheses", v("(40)", { allowNegative: true }), -40);
  check("trailing junk refused (parseFloat said 12)", v("12abc"), "ERR");
  check("comma as a decimal refused (parseFloat said 1)", v("15,49"), "ERR");
  check("European grouping refused (the old code read 1.23456)", v("1.234,56"), "ERR");
  check("third decimal place refused", v("15.499"), "ERR");
  check("a lone dollar sign refused", v("$"), "ERR");
  check("a lone point refused", v("."), "ERR");
  check("two points refused", v("1.2.3"), "ERR");
  check("letters refused", v("abc"), "ERR");
  check("percent: plain", v("24.99", { percent: true }), 24.99);
  check("percent: trailing %", v("24.99%", { percent: true }), 24.99);
  check("percent: three places", v("24.999", { percent: true }), 24.999);
  check("percent: four places refused", v("24.9999", { percent: true }), "ERR");
  check("percent: dollar sign refused", v("$24", { percent: true }), "ERR");

  const msg = (raw, o) => H.parseMoneyInput(raw, o).message;
  check("says why: junk", msg("12abc"), "Not an amount — digits only, like 1250.00.");
  check("says why: commas", msg("15,49"), "Commas only go between thousands, like 1,250.00.");
  check("says why: cents", msg("15.499"), "Cents only go two places, like 12.50.");
  check("says why: negative", msg("-5"), "Can’t be negative here.");
}

console.log("\n2. Money: formatting and round trip");
{
  check("thousands and cents", H.formatMoneyInput(1234.5), "1,234.50");
  check("millions", H.formatMoneyInput(1000000), "1,000,000.00");
  check("negative", H.formatMoneyInput(-40), "-40.00");
  check("zero", H.formatMoneyInput(0), "0.00");
  check("small", H.formatMoneyInput(0.07), "0.07");
  check("percent keeps its own precision", H.formatMoneyInput(24.99, { percent: true }), "24.99");
  check("percent drops trailing zeros", H.formatMoneyInput(5, { percent: true }), "5");
  let roundTrips = 0, tried = 0;
  for (let cents = -250000; cents <= 250000; cents += 137) {
    const v = cents / 100;
    tried++;
    const back = H.parseMoneyInput(H.formatMoneyInput(v), { allowNegative: true });
    if (back.ok && back.value === v) roundTrips++;
  }
  check(`format then parse returns the same figure (${tried} values)`, roundTrips, tried);
}

console.log("\n3. Money: differential against the old parsing");
{
  // The save sites did one of two things before. Most stripped $ and commas
  // and then ran parseFloat; the paycheck, account and card-terms forms ran
  // parseFloat on the raw text, which stops at the first comma.
  const old = (raw) => { const n = parseFloat(String(raw).replace(/[$,]/g, "")); return isNaN(n) ? 0 : n; };
  const oldNoStrip = (raw) => parseFloat(raw) || 0;
  const wellFormed = ["0", "1", "12.5", "12.50", "99.99", "1234.56", "1,234.56", "$1,234.56", "$0.07", ".5",
    "250", "100000", "12,345,678.90", " 42 ", "$ 42", "5."];
  const same = wellFormed.filter((w) => { const r = H.parseMoneyInput(w); return r.ok && r.value === old(w); });
  check(`every well-formed figure parses exactly as the stripping sites did (${wellFormed.length})`, same.length, wellFormed.length);
  const plain = ["0", "1", "12.5", "99.99", "1234.56", "250", "100000", " 42 ", ".5", "5."];
  const samePlain = plain.filter((w) => H.parseMoneyInput(w).value === oldNoStrip(w));
  check(`and plain figures exactly as the non-stripping sites did (${plain.length})`, samePlain.length, plain.length);
  // Where the non-stripping sites were simply wrong about a correct figure.
  check("a $1,100.00 paycheck used to be saved as $1", [oldNoStrip("1,100.00"), H.parseMoneyInput("1,100.00").value], [1, 1100]);
  check("a $2,500 account balance used to be saved as $2", [oldNoStrip("2,500"), H.parseMoneyInput("2,500").value], [2, 2500]);
  const noStripSites = ["paycheckAmount: parseFloat(amount)", "checkingBalance: parseFloat(checking)",
    "current_balance: parseFloat(data.current_balance)", "min_payment_due: parseFloat(data.min_payment_due)"];
  const before = fs.readFileSync(P.BASELINES + "/main.ux-before.js", "utf8");
  check("those sites really did skip the comma strip before", noStripSites.every((x) => before.includes(x)), true);
  check("and none of them survive", noStripSites.some((x) => SRC.includes(x)), false);

  // The inputs where the old code quietly produced a different number.
  const silent = { "12abc": 12, "15,49": 1549, "1.234,56": 1.23456, "15.499": 15.499, "abc": 0, "$": 0 };
  Object.entries(silent).forEach(([raw, was]) => {
    check(`"${raw}": old code saved ${was}, now refused`, [old(raw), H.parseMoneyInput(raw).ok], [was, false]);
  });
}

console.log("\n4. Money: the save-side gate");
{
  clearNotices();
  check("valid passes through", H.requireMoney("1,250.00", "Amount"), 1250);
  check("invalid refuses", H.requireMoney("12abc", "Amount"), null);
  check("and says which field", notices().pop(), "Amount: Not an amount — digits only, like 1250.00.");
  check("blank required refuses", H.requireMoney("", "Target amount"), null);
  check("with a readable message", notices().pop(), "Enter the target amount.");
  check("blank optional falls back", H.requireMoney("", "Balance", { optional: true }), 0);
  check("custom fallback", H.requireMoney("", "Limit", { optional: true, fallback: undefined }), undefined);
}

console.log("\n5. Money: live feedback in a field");
{
  const setting = new SettingStub(el("div")).setName("Amount");
  let owned = null;
  let t;
  setting.addText((x) => { t = H.bindMoneyInput(x, setting).setValue("").onChange((v) => (owned = v)); });
  check("gets the decimal keypad on mobile", t.inputEl.attrs.inputmode, "decimal");
  check("styled as a money field", t.inputEl.classes.has("budget-money-input"), true);
  type(t, "12abc");
  const errs = () => byClass(setting.node, "budget-field-error");
  check("a typo shows a message while typing", errs().map((e) => e._text), ["Not an amount — digits only, like 1250.00."]);
  check("the field is marked invalid", [t.inputEl.classes.has("budget-input-invalid"), t.inputEl.attrs["aria-invalid"]], [true, "true"]);
  type(t, "12abcd");
  check("repeated keystrokes don't stack messages", errs().length, 1);
  type(t, "1234.5");
  check("fixing it clears the message", errs().length, 0);
  check("and the invalid mark", t.inputEl.classes.has("budget-input-invalid"), false);
  blur(t);
  check("leaving the field tidies it", t.inputEl.value, "1,234.50");
  check("and the owner sees the tidied value", owned, "1,234.50");
  type(t, "");
  blur(t);
  check("blank stays blank on blur", t.inputEl.value, "");

  const neg = new SettingStub(el("div")).setName("Checking");
  let tn;
  neg.addText((x) => { tn = H.bindMoneyInput(x, neg, { allowNegative: true }); });
  check("fields that may go negative keep the full keyboard (iOS decimal pad has no minus)", tn.inputEl.attrs.inputmode, undefined);
}

console.log("\n6. Money: every modal refuses a typo instead of saving a different number");
{
  // Paycheck: a typo refuses; blank still means zero, as it always did.
  let got = null;
  let m = openModal(new H.PaycheckModal({}, (r) => (got = r), { scheduledNextPayday: H.addDays(H.todayLocal(), 7) }));
  type(m.fields["Paycheck amount"], "1,1OO.00");
  clearNotices();
  press(m.buttons, "Calculate");
  check("paycheck with a letter O is refused", got, null);
  check("with the field named", notices()[0], "Paycheck amount: Not an amount — digits only, like 1250.00.");
  type(m.fields["Paycheck amount"], "$1,100.00");
  type(m.fields["Current checking balance"], "-12.40");
  press(m.buttons, "Calculate");
  check("paycheck with commas and a negative balance", [got && got.paycheckAmount, got && got.checkingBalance], [1100, -12.4]);
  got = null;
  m = openModal(new H.PaycheckModal({}, (r) => (got = r), { scheduledNextPayday: H.addDays(H.todayLocal(), 7) }));
  press(m.buttons, "Calculate");
  check("paycheck left blank still submits as $0", got && got.paycheckAmount, 0);

  // Fixed expense.
  got = null;
  m = openModal(new H.AddFixedExpenseModal({}, (r) => (got = r), null, []));
  type(m.fields["Name"], "Rent");
  type(m.fields["Amount"], "1.450,00");
  press(m.buttons, "Save");
  check("fixed expense with European grouping refused", got, null);
  type(m.fields["Amount"], "1,450.00");
  type(m.fields["Due day of month"], "1");
  press(m.buttons, "Save");
  check("and saved once corrected", got && got.amount, 1450);

  // Savings goal.
  got = null;
  m = openModal(new H.SavingsGoalModal({}, (r) => (got = r)));
  type(m.fields["Goal name"], "Trip");
  type(m.fields["Target amount"], "2000");
  type(m.fields["Already saved"], "12abc");
  press(m.buttons, "Create goal");
  check("goal with a junk saved amount refused (was saved as $12)", got, null);
  type(m.fields["Already saved"], "");
  press(m.buttons, "Create goal");
  check("blank saved amount is zero", got && [got.target_amount, got.saved_amount], [2000, 0]);

  // BNPL — also the regression for a TDZ bug caught in review: the balance
  // field referenced its own Setting before it was assigned, which would throw
  // the moment the modal opened.
  got = null;
  let opened = true;
  try { m = openModal(new H.BNPLModal({}, (plan, bal) => (got = { plan, bal }))); } catch (e) { opened = e.message; }
  check("BNPL modal opens", opened, true);
  type(m.fields["Provider / item"], "Affirm — Sofa");
  type(m.fields["Installment amount"], "87.5");
  type(m.fields["Remaining installments"], "4");
  check("the total follows the parts", m.fields["Total balance owed"].inputEl.value, "350.00");
  type(m.fields["Installment amount"], "87.5x");
  press(m.buttons, "Add plan");
  check("BNPL with a junk installment refused", got, null);
  type(m.fields["Installment amount"], "87.50");
  press(m.buttons, "Add plan");
  check("and saved once corrected", got && [got.plan.installment_amount, got.bal], [87.5, 350]);

  // Card terms — APR is a percent field.
  got = null;
  m = openModal(new H.AddRevolvingDebtModal({}, [{ id: "cc1", institution: "Capital One" }], (r) => (got = r)));
  type(m.fields["APR (%)"], "29.99%");
  type(m.fields["Current balance"], "214.15");
  press(m.buttons, "Save");
  check("card terms accept a trailing %", got && [got.apr, got.current_balance], [29.99, 214.15]);
  got = null;
  m = openModal(new H.AddRevolvingDebtModal({}, [{ id: "cc1", institution: "Capital One" }], (r) => (got = r)));
  type(m.fields["Minimum payment due"], "4O");
  press(m.buttons, "Save");
  check("and refuse a letter O in the minimum (was saved as $4)", got, null);

  // Quick balances name the account that's wrong.
  got = null;
  m = openModal(new H.QuickBalanceModal({}, [{ id: "a1", institution: "Credit Union", type: "checking", current_balance: 10 }], (r) => (got = r)));
  type(m.fields["Credit Union"], "55.1.2");
  clearNotices();
  press(m.buttons, "Save balances");
  check("quick balance refuses and names the account", [got, notices()[0]], [null, "Credit Union: Not an amount — digits only, like 1250.00."]);

  // Edit Balance: the installment count now updates the visible balance field.
  got = null;
  const plan = { provider: "Klarna", installment_amount: 25, remaining_installments: 4, balance_anchor: { amount: 100, date: "2026-09-01" }, applied_payments: [] };
  m = openModal(new H.EditBalanceModal({}, plan, (n) => (got = n)));
  type(m.fields["Remaining installments"], "2");
  check("the balance field shows what Save will store", m.fields["Or set the remaining balance directly"].inputEl.value, "50.00");
  press(m.buttons, "Save balance");
  check("and Save stores it", got, 50);
}

// ===========================================================================
console.log("\n7. Dates: pickers everywhere a date was typed");
{
  const t = { inputEl: el("input"), setValue(v) { this.inputEl.value = v; return this; } };
  H.bindDateInput(t, "2026-09-22");
  check("becomes a date input", t.inputEl.type, "date");
  check("keeps an ISO value", t.inputEl.value, "2026-09-22");
  const legacy = { inputEl: el("input"), setValue(v) { this.inputEl.value = v; return this; } };
  H.bindDateInput(legacy, "9/5/2026");
  check("an old M/D/YYYY value is carried over", legacy.inputEl.value, "2026-09-05");
  const junk = { inputEl: el("input"), setValue(v) { this.inputEl.value = v; return this; } };
  H.bindDateInput(junk, "2026-02-31");
  check("an impossible date starts empty rather than wrong", junk.inputEl.value, "");
  const month = { inputEl: el("input"), setValue(v) { this.inputEl.value = v; return this; } };
  H.bindDateInput(month, "2026-08", { month: true });
  check("month picker", [month.inputEl.type, month.inputEl.value], ["month", "2026-08"]);

  // Every modal's date field is a picker.
  const dateField = (m, name) => m.fields[name] && m.fields[name].inputEl.type;
  check("paycheck: next payday", dateField(openModal(new H.PaycheckModal({}, () => {}, {})), "Next expected payday"), "date");
  const bnpl = openModal(new H.BNPLModal({}, () => {}));
  check("BNPL: next due date", dateField(bnpl, "Next due date"), "date");
  check("BNPL: payoff deadline", dateField(bnpl, "Payoff deadline"), "date");
  check("fixed expense: next expected date", dateField(openModal(new H.AddFixedExpenseModal({}, () => {}, null, [])), "Next expected date"), "date");
  check("card terms: due date", dateField(openModal(new H.AddRevolvingDebtModal({}, [{ id: "c", institution: "C" }], () => {})), "Due date"), "date");
  check("savings goal: target date", dateField(openModal(new H.SavingsGoalModal({}, () => {})), "Target date (optional)"), "date");

  // The settings-tab fields, the Mark Paid field and the statement month are
  // checked at the source: each goes through bindDateInput.
  const bound = (label) => {
    const i = SRC.indexOf(label);
    return i >= 0 && /bindDateInput\(/.test(SRC.slice(i, i + 600));
  };
  check("settings: savings deadline", bound('.setName("Deadline (optional)")'), true);
  check("settings: known payday", bound('.setName("A known payday")'), true);
  check("mark paid: due date covered", bound('.setName("This payment covers the due date of")'), true);
  check("portfolio: statement month", bound('.setName("Statement month")') && /month: true/.test(SRC.slice(SRC.indexOf('.setName("Statement month")'), SRC.indexOf('.setName("Statement month")') + 400)), true);

  // Nothing a person reads still asks them to type a format.
  const strings = SRC.split("\n").filter((l) => !/^\s*\/\//.test(l)).join("\n")
    .match(/(["`])(?:(?!\1)[^\\\n]|\\.)*\1/g) || [];
  check("no user-visible string mentions YYYY-MM-DD", strings.filter((x) => /YYYY-MM/.test(x)), []);
  check("no example date left to go stale in a message", strings.filter((x) => /e\.g\. 20\d\d-/.test(x)), []);
  check("payday message", H.validateNextPayday(""), "Pick your next expected payday.");
}

// ===========================================================================
console.log("\n8. Pattern reach: what a rule would actually catch");
{
  const txs = [
    { merchant_raw: "AMAZON MKTPLACE PMTS" }, { merchant_raw: "AMAZON PRIME*2K3" }, { merchant_raw: "AMZN DIGITAL" },
    { merchant_raw: "AMAZON FRESH", override_label: "Groceries" },
    { merchant_raw: "KINDLE UNLTD*A1" }, { merchant_raw: "SHELL OIL 123" }, { merchant_raw: "SHELL OIL 456" },
    { merchant_raw: "RIGOBERTOS TACO" }
  ];
  const rules = [{ merchant_pattern: "AMAZON PRIME", home_label: "Subscription", display_name: "Prime" }, { merchant_pattern: "SHELL", home_label: "Gas" }];
  const r = H.patternReach("amazon", txs, rules);
  check("counts text matches, case-insensitive", r.matches, 3);
  check("an override beats every rule", r.overridden, 1);
  check("an earlier rule wins its matches", r.claimedBy, [{ name: "Prime", count: 1 }]);
  check("so the new rule would categorize the rest", r.categorizes, 1);
  check("blank pattern means nothing to report", H.patternReach("  ", txs, rules), null);

  // Editing the FIRST rule: nothing sits ahead of it.
  const edit = H.patternReach("amazon", txs, rules, 0);
  check("editing rule 0: nothing ahead of it", [edit.claimed, edit.categorizes], [0, 2]);

  // Property check against the real categorizer: append the pattern as a rule
  // with a sentinel label, run applyCategorization, count the sentinel. The
  // reach must agree for every pattern, both for a new rule and an edited one.
  // The fixture is 438 real transactions with no rules, so a rule set is built
  // from them: the commonest merchant words, plus deliberately overlapping
  // pairs (a word and a longer phrase containing it) so rule order decides
  // real outcomes, and a scattering of one-off overrides.
  const corpus = (JSON.parse(fs.readFileSync(P.FIXTURES + "/fixture-ctx.json", "utf8")).allTx || [])
    .map((t, i) => Object.assign({}, t, { override_label: i % 17 === 0 ? "Override" : null }));
  const freq = new Map();
  corpus.forEach((t) => String(t.merchant_raw || "").toUpperCase().split(/[^A-Z0-9]+/).filter((w) => w.length >= 3)
    .forEach((w) => freq.set(w, (freq.get(w) || 0) + 1)));
  const words = [...freq.entries()].sort((a, b) => b[1] - a[1]).map(([w]) => w).slice(0, 120);
  const baseRules = [];
  words.slice(0, 30).forEach((w, i) => {
    if (i % 3 === 0) {
      const longer = corpus.map((t) => String(t.merchant_raw || "").toUpperCase()).find((r) => r.includes(w + " "));
      if (longer) baseRules.push({ merchant_pattern: longer.slice(longer.indexOf(w), longer.indexOf(w) + w.length + 4).trim(), home_label: "Narrow" + i });
    }
    baseRules.push({ merchant_pattern: w, home_label: "Broad" + i });
  });
  check("the derived rule set is non-trivial", baseRules.length >= 30, true);
  let agreeNew = 0, agreeEdit = 0;
  words.forEach((w, i) => {
    const sentinel = "__SENTINEL__";
    const copyNew = corpus.map((t) => Object.assign({}, t));
    H.applyCategorization(copyNew, baseRules.concat([{ merchant_pattern: w, home_label: sentinel }]));
    if (copyNew.filter((t) => t.resolved_category === sentinel).length === H.patternReach(w, corpus, baseRules).categorizes) agreeNew++;

    const k = i % Math.max(baseRules.length, 1);
    const edited = baseRules.map((x, j) => (j === k ? { merchant_pattern: w, home_label: sentinel } : x));
    const copyEdit = corpus.map((t) => Object.assign({}, t));
    H.applyCategorization(copyEdit, edited);
    if (copyEdit.filter((t) => t.resolved_category === sentinel).length === H.patternReach(w, corpus, baseRules, k).categorizes) agreeEdit++;
  });
  check(`new-rule reach agrees with the categorizer (${words.length} patterns, ${corpus.length} transactions)`, agreeNew, words.length);
  check(`edited-rule reach agrees with the categorizer (${words.length} patterns)`, agreeEdit, words.length);
}

console.log("\n9. Pattern reach: the sentence under the field");
{
  const d = (p, txs, rules, self, sample) => H.describePatternReach(H.patternReach(p, txs, rules, self), sample, p);
  const txs = [{ merchant_raw: "SHELL OIL 1" }, { merchant_raw: "SHELL OIL 2" }, { merchant_raw: "SHELLFISH SHACK" }];
  check("empty", H.describePatternReach(null).text, "Enter a pattern to see what it would match.");
  check("clean", d("SHELL OIL", txs, []).text, "Will categorize 2 transactions.");
  check("singular", d("SHACK", txs, []).text, "Will categorize 1 transaction.");
  const partial = d("SHELL", txs, [{ merchant_pattern: "SHELLFISH", home_label: "Eating Out" }]);
  check("names what's already taken", partial.text, "Matches 3 transactions — will categorize 2. 1 already goes to the “SHELLFISH” rule.");
  check("a partial overlap isn't a warning", partial.warn, false);
  const plural = d("SHELL", txs, [{ merchant_pattern: "SHELL OIL", home_label: "Gas" }]);
  check("plural agrees too", plural.text, "Matches 3 transactions \u2014 will categorize 1. 2 already go to the \u201cSHELL OIL\u201d rule.");
  const none = d("ZZZ", txs, []);
  check("no matches is a warning", [none.text, none.warn], ["Matches nothing in your history yet — check it against the raw bank text.", true]);
  const drift = d("SHEL OIL", txs, [], null, "SHELL OIL 1");
  check("a pattern that no longer matches its own row says so first", [drift.warn, /labelling/.test(drift.text)], [true, true]);
  const eaten = d("SHELL", [{ merchant_raw: "SHELL" }], [{ merchant_pattern: "SHE", home_label: "X" }]);
  check("catching nothing at all is a warning", eaten.warn, true);
}

console.log("\n10. Pattern reach: live in all three modals");
{
  const txs = [{ merchant_raw: "RIGOBERTOS TACO SHOP 44" }, { merchant_raw: "RIGOBERTOS TACO SHOP 45" }, { merchant_raw: "TACO BELL 9" }];
  const rules = [{ merchant_pattern: "TACO BELL", home_label: "Eating Out" }];
  const note = (m) => byClass(m.modal.contentEl, "budget-match-count").map((x) => x._text);

  let m = openModal(new H.LabelModal({}, "RIGOBERTOS TACO SHOP 44", -12, ["Eating Out"], () => {}, null, { transactions: txs, rules }));
  // The guessed pattern keeps the store number, so it catches only this row and
  // not its "45" sibling — exactly what the live line is there to reveal.
  check("label modal: shows reach on open (a too-narrow guess is visible at once)", note(m), ["Will categorize 1 transaction."]);
  type(m.fields["Pattern to match"], "RIGOBERTOS");
  check("label modal: shortening it picks up the sibling", note(m), ["Will categorize 2 transactions."]);
  type(m.fields["Pattern to match"], "TACO");
  check("label modal: updates as you type", note(m), ["Matches 3 transactions — will categorize 2. 1 already goes to the “TACO BELL” rule."]);
  type(m.fields["Pattern to match"], "RIGOBERTO TACOS");
  check("label modal: warns when it stops matching its own row", /labelling/.test(note(m)[0]), true);
  check("label modal: one line, updated in place", note(m).length, 1);
  m = openModal(new H.LabelModal({}, "X", -1, [], () => {}));
  check("label modal without history: no line, no crash", note(m), []);

  m = openModal(new H.EditRuleModal({}, rules[0], () => {}, { transactions: txs, rules, index: 0 }));
  check("edit rule: shows reach", note(m), ["Will categorize 1 transaction."]);
  type(m.fields["Pattern to match"], "TACO");
  check("edit rule: as rule 0 it wins everything it matches", note(m), ["Will categorize 3 transactions."]);

  const group = { key: "RIGOBERTOS", rawSamples: ["RIGOBERTOS TACO SHOP 44"], matchedRule: null, category: "Eating Out" };
  m = openModal(new H.RenameSubscriptionModal({}, group, txs, () => {}, rules));
  type(m.fields["Pattern to match"], "TACO");
  check("rename subscription: accounts for rule order too", note(m), ["Matches 3 transactions — will categorize 2. 1 already goes to the “TACO BELL” rule."]);
  check("the old count line above the field is gone", /createEl\("p", \{ cls: "budget-muted budget-match-count" \}\)/.test(SRC), false);
}

// ===========================================================================
console.log("\n11. Category order: ranking");
{
  const tx = (date, c) => ({ date, resolved_category: c });
  const txs = [
    // Car Repairs: heavy all-time, nothing recent.
    ...Array.from({ length: 12 }, (_, i) => tx(`2026-0${1 + (i % 3)}-1${i % 9}`, "Car Repairs")),
    ...Array.from({ length: 9 }, () => tx("2026-09-10", "Groceries")),
    ...Array.from({ length: 6 }, () => tx("2026-09-12", "Gas")),
    ...Array.from({ length: 6 }, () => tx("2026-08-20", "Eating Out")),
    ...Array.from({ length: 3 }, () => tx("2026-09-01", "Uncategorized")),
    tx("2026-09-15", "Zoo")
  ];
  const order = H.computeCategoryUsageOrder(txs);
  check("most-used recently comes first", order.slice(0, 3), ["Groceries", "Eating Out", "Gas"]);
  check("a tie goes alphabetical", order.indexOf("Eating Out") < order.indexOf("Gas"), true);
  check("heavy but stale sinks below anything recent", order.indexOf("Car Repairs") > order.indexOf("Zoo"), true);
  check("Uncategorized is never ranked", order.includes("Uncategorized"), false);

  // The window runs back from the newest transaction, not from today.
  const old = [tx("2024-03-01", "A"), tx("2024-03-02", "B"), tx("2024-03-02", "B"), tx("2023-01-01", "A"), tx("2023-01-01", "A")];
  check("an old vault still ranks by what was last used", H.computeCategoryUsageOrder(old), ["B", "A"]);

  check("used first, then never-used alphabetically", H.sortCategoriesByUse(["Zoo", "Car Repairs", "Gas", "Groceries", "Art"], ["Groceries", "Gas"]), ["Groceries", "Gas", "Art", "Car Repairs", "Zoo"]);
  check("duplicates dropped", H.sortCategoriesByUse(["Gas", "Gas", "", null], ["Gas"]), ["Gas"]);
  // With no snapshot the result is exactly the old alphabetical order.
  const names = ["Rent", "Eating Out", "Gas", "Car Repairs", "Groceries", "Phone Bill"];
  check("no snapshot: identical to the old alphabetical sort", H.sortCategoriesByUse(names, []), names.slice().sort());
}

console.log("\n12. Category order: taken at import, held between imports");
{
  const F = H.FILES;
  const txs = [{ date: "2026-09-10", resolved_category: "Groceries" }, { date: "2026-09-10", resolved_category: "Groceries" }, { date: "2026-09-11", resolved_category: "Gas" }];
  const app = fakeApp({ [F.transactions]: txs });
  const loaded = await H.loadCategoryUsageOrder(app);
  check("first load with no snapshot takes one", loaded, ["Groceries", "Gas"]);
  check("and writes it", app.read(F.categoryOrder).order, ["Groceries", "Gas"]);

  // Relabel everything to Gas without importing: the snapshot must not move.
  app._store[F.transactions] = JSON.stringify(txs.map((t) => Object.assign({}, t, { resolved_category: "Gas" })).concat([{ date: "2026-09-12", resolved_category: "Gas" }]));
  check("a later load keeps the stored order", await H.loadCategoryUsageOrder(app), ["Groceries", "Gas"]);
  check("an import re-ranks", await H.refreshCategoryUsageOrder(app), ["Gas"]);

  // The import path calls it right after writing transactions; startup loads it.
  const imp = SRC.slice(SRC.indexOf("async promptImportCSV("));
  const w = imp.indexOf("await writeJSON(this.app, FILES.transactions, merged);");
  check("import re-ranks right after writing transactions", w > 0 && /^\s*transactionsWritten = true;[\s\S]{0,300}refreshCategoryUsageOrder\(this\.app, merged\)/.test(imp.slice(w + 60)), true);
  check("startup loads the snapshot", /async onload\(\)[\s\S]*?await loadCategoryUsageOrder\(this\.app\);/.test(SRC), true);
}

console.log("\n13. Category order: follows renames and deletes");
{
  const F = H.FILES;
  const mk = (order) => fakeApp({ [F.categoryOrder]: { order }, [F.rules]: [], [F.transactions]: [], [F.categories]: [], [F.fixedExpenses]: [], [F.installmentDebts]: [], [F.revolvingDebts]: [] });
  let app = mk(["Groceries", "Gas", "Food"]);
  await H.carryCategoryOrder(app, "Gas", "Fuel");
  check("rename keeps the position", app.read(F.categoryOrder).order, ["Groceries", "Fuel", "Food"]);
  app = mk(["Groceries", "Gas", "Food"]);
  await H.carryCategoryOrder(app, "Food", "Groceries");
  check("merge keeps the higher position", app.read(F.categoryOrder).order, ["Groceries", "Gas"]);
  app = mk(["Groceries", "Gas", "Food"]);
  await H.carryCategoryOrder(app, "Food", "Gas");
  check("merge downward takes the merged-in rank", app.read(F.categoryOrder).order, ["Groceries", "Gas"]);
  app = mk(["Groceries", "Gas", "Food"]);
  await H.carryCategoryOrder(app, "Gas", null);
  check("delete removes it", app.read(F.categoryOrder).order, ["Groceries", "Food"]);

  app = mk(["Groceries", "Gas"]);
  await H.renameCategory(app, "Gas", "Fuel");
  check("renameCategory carries the order", app.read(F.categoryOrder).order, ["Groceries", "Fuel"]);
  await H.deleteCategory(app, "Groceries", null);
  check("deleteCategory carries the order", app.read(F.categoryOrder).order, ["Fuel"]);
  H.setCategoryUsageOrder([]);
}

console.log("\n14. Category order: every category dropdown uses it");
{
  H.setCategoryUsageOrder(["Groceries", "Gas", "Eating Out"]);
  const optionsIn = (root) => find(root, (x) => x.classes && x.classes.has("setting-option")).map((x) => x._text);
  const labels = ["Car Repairs", "Eating Out", "Gas", "Groceries", "Rent"];

  let m = openModal(new H.OverrideModal({}, { date: "2026-09-01", merchant_raw: "X", amount: -1 }, labels, () => {}));
  check("move-transaction dropdown", optionsIn(m.modal.contentEl), ["— choose —", "Groceries", "Gas", "Eating Out", "Car Repairs", "Rent"]);
  m = openModal(new H.LabelModal({}, "X", -1, labels, () => {}));
  check("categorize dropdown, by use, then a new one", optionsIn(m.modal.contentEl), ["— choose —", "Groceries", "Gas", "Eating Out", "Car Repairs", "Rent", "New category…"]);
  m = openModal(new H.AddFixedExpenseModal({}, () => {}, null, labels));
  check("bill payment-category dropdown", optionsIn(m.modal.contentEl).filter((o) => labels.includes(o)), ["Groceries", "Gas", "Eating Out", "Car Repairs", "Rent"]);
  m = openModal(new H.DeleteCategoryModal({}, { name: "Rent", ruleCount: 1, txCount: 1, overrideCount: 0 }, labels.map((name) => ({ name })), [], () => {}));
  check("delete-category reassignment dropdown", optionsIn(m.modal.contentEl), ["Uncategorized", "Groceries", "Gas", "Eating Out", "Car Repairs"]);
  const ins = SRC.slice(SRC.indexOf("const untargeted = collectCategories("), SRC.indexOf('pick.createEl("option", { text: "Add a target'));
  check("insights target picker", /sortCategoriesByUse\(untargeted\.map/.test(ins) && !/localeCompare/.test(ins), true);
  H.setCategoryUsageOrder([]);
}

// ===========================================================================
console.log("\n15. Chart: the markup the hover layer reads");
{
  const history = [
    { date: "2026-07-01", total_debt: 5100.25 }, { date: "2026-08-01", total_debt: 4821.5 }, { date: "2026-09-01", total_debt: 4213.07 }
  ];
  const svg = H.buildDebtChart(history, { zeroDate: "2027-06-01", perDay: 14 });
  const pts = [...svg.matchAll(/class="budget-chart-pt"[^>]*data-date="([^"]+)" data-value="([^"]+)"/g)].map((m) => [m[1], m[2]]);
  check("each point carries its exact value", pts.slice(0, 3), [["2026-07-01", "5100.25"], ["2026-08-01", "4821.50"], ["2026-09-01", "4213.07"]]);
  check("the projected payoff is reachable too", /data-date="2027-06-01" data-value="0.00" data-projected="1"/.test(svg), true);
  check("a hit layer covers the plot", /class="budget-chart-hit"/.test(svg), true);
  check("and sits on top", svg.lastIndexOf("budget-chart-hit") > svg.lastIndexOf("budget-chart-pt"), true);
  check("the chart takes keyboard focus", /tabindex="0"/.test(svg), true);
  check("with a summary for screen readers", /aria-label="Total debt, 2026-07-01 to 2026-09-01: \$5100\.25 to \$4213\.07\./.test(svg), true);
  check("the 6px native tooltips are gone", /<title>/.test(svg), false);

  check("nearest point", H.nearestIndexByX([{ x: 10 }, { x: 50 }, { x: 90 }], 62), 1);
  check("ties go to the earlier point", H.nearestIndexByX([{ x: 10 }, { x: 50 }], 30), 0);
  check("money to the cent", H.formatChartMoney(4213.07), "$4,213.07");
  check("date", H.formatChartDate("2026-09-22"), "Sep 22, 2026");
  check("in the shim, hover attaches to nothing and doesn't throw", H.enableChartHover(el("div")), null);
}

// ===========================================================================
console.log("\n16. In a real browser");
if (P.noBrowser()) console.log("  SKIP  no Playwright/Chromium here");
else {
  const { chromium } = require("playwright");
  const browser = await chromium.launch();
  const page = await browser.newPage({ viewport: { width: 900, height: 700 } });
  const css = fs.readFileSync(P.STYLES, "utf8");
  const PREVIEW = fs.readFileSync(P.PREVIEWS + "/preview.js", "utf8");
  const THEME = PREVIEW.slice(PREVIEW.indexOf("const THEME = `") + 15, PREVIEW.indexOf("`;\n\nfunction makeView"));
  const history = [
    { date: "2026-06-01", total_debt: 5320.4 }, { date: "2026-07-01", total_debt: 5100.25 },
    { date: "2026-08-01", total_debt: 4821.5 }, { date: "2026-09-01", total_debt: 4213.07 }
  ];
  const svg = H.buildDebtChart(history, { zeroDate: "2027-06-01", perDay: 14 });
  // The real functions, not copies: their own source text, injected verbatim.
  const fns = ["enableChartHover", "nearestIndexByX", "formatChartMoney", "formatChartDate", "formatMoneyInput",
    "parseMoneyInput", "bindMoneyInput", "fieldNote", "fieldNoteHost", "bindDateInput", "normalizeDate",
    "isISODateString", "toLocalISO"].map((n) => H[n].toString()).join("\n");
  // Obsidian's own DOM helpers — the plugin assumes them, so the page gets them.
  const obsidian = `
    HTMLElement.prototype.setAttr = function (k, v) { this.setAttribute(k, v); };
    HTMLElement.prototype.addClass = function (c) { this.classList.add(c); };
    HTMLElement.prototype.toggleClass = function (c, on) { this.classList.toggle(c, !!on); };
    HTMLElement.prototype.setText = function (t) { this.textContent = t; };
    HTMLElement.prototype.createDiv = function (o = {}) { const d = document.createElement("div"); if (o.cls) d.className = o.cls; if (o.text) d.textContent = o.text; this.appendChild(d); return d; };
    function textComponent(input) { return { inputEl: input, setValue(v) { input.value = v == null ? "" : v; return this; }, onChange(cb) { input.addEventListener("input", () => cb(input.value)); return this; } }; }`;
  await page.setContent(`<!doctype html><html><head><style>${THEME}\n${css}</style></head>
    <body class="theme-dark"><div class="budget-card budget-progress-card" style="width:640px">
      <div id="wrap" class="budget-chart-wrap budget-debt-chart-wrap">${svg}</div></div>
      <div class="setting-item"><div id="desc" class="setting-item-description">Amount</div><input id="money" type="text"></div>
      <input id="date" type="text">
      <script>${obsidian}\n${fns}
        window.hover = enableChartHover(document.getElementById("wrap"));
        window.owned = null;
        bindMoneyInput(textComponent(document.getElementById("money")), { descEl: document.getElementById("desc") }).onChange((v) => (window.owned = v));
        window.picked = null;
        bindDateInput(textComponent(document.getElementById("date")), "2026-09-22").onChange((v) => (window.picked = v));
      </script></body></html>`);

  const tip = async () => page.evaluate(() => {
    const t = document.querySelector(".budget-chart-tip");
    const w = document.getElementById("wrap").getBoundingClientRect();
    const r = t.getBoundingClientRect();
    return { hidden: t.hidden, value: t.querySelector(".budget-chart-tip-value").textContent,
      date: t.querySelector(".budget-chart-tip-date").textContent,
      inside: r.left >= w.left - 0.5 && r.right <= w.right + 0.5,
      ring: document.querySelector(".budget-chart-focus").getAttribute("visibility") };
  });
  const box = await page.evaluate(() => { const r = document.querySelector(".budget-chart-hit").getBoundingClientRect(); return { x: r.x, y: r.y, w: r.width, h: r.height }; });

  check("hover attached", await page.evaluate(() => !!window.hover && window.hover.points.length), 5);
  // Aim at the plot's left edge, well away from the 6px dot vertically.
  await page.mouse.move(box.x + 12, box.y + box.h - 5);
  let t = await tip();
  check("hovering anywhere near the first date snaps to it", [t.hidden, t.value, t.date], [false, "$5,320.40", "Jun 1, 2026"]);
  check("the readout stays inside the card", t.inside, true);
  check("the crosshair shows", t.ring, "visible");
  const dot = await page.evaluate(() => { const c = document.querySelectorAll(".budget-chart-pt")[3]; const r = c.getBoundingClientRect(); return { x: r.x + r.width / 2 }; });
  await page.mouse.move(dot.x + 9, box.y + 10);
  t = await tip();
  check("drifting a few pixels off a point still reads that point", [t.value, t.date], ["$4,213.07", "Sep 1, 2026"]);
  await page.mouse.move(box.x + box.w - 4, box.y + box.h / 2);
  t = await tip();
  check("the far end reads the projection", [t.value, t.date], ["$0.00", "Projected payoff · Jun 1, 2027"]);
  check("the right-edge readout still fits", t.inside, true);
  await page.mouse.move(5, 650);
  t = await tip();
  check("leaving the chart clears it", [t.hidden, t.ring], [true, "hidden"]);

  await page.focus(".budget-debt-chart");
  t = await tip();
  check("keyboard focus opens on the latest real point", t.value, "$4,213.07");
  await page.keyboard.press("ArrowLeft");
  check("arrow left steps back", (await tip()).value, "$4,821.50");
  await page.keyboard.press("Home");
  check("home jumps to the start", (await tip()).value, "$5,320.40");
  await page.keyboard.press("Escape");
  check("escape clears", (await tip()).hidden, true);

  // Touch: a tap shows the readout and it stays up until you tap elsewhere.
  const touch = await browser.newContext({ hasTouch: true, viewport: { width: 900, height: 700 } });
  const tp = await touch.newPage();
  await tp.setContent(await page.content());
  await tp.evaluate(() => { document.querySelector(".budget-chart-tip").remove(); window.hover = enableChartHover(document.getElementById("wrap")); });
  await tp.touchscreen.tap(box.x + 12, box.y + box.h / 2);
  await tp.waitForTimeout(50);
  check("a tap opens the readout and it stays up", await tp.evaluate(() => !document.querySelector(".budget-chart-tip").hidden), true);
  await tp.touchscreen.tap(5, 650);
  await tp.waitForTimeout(50);
  check("tapping elsewhere closes it", await tp.evaluate(() => document.querySelector(".budget-chart-tip").hidden), true);
  await touch.close();

  // Money field: real keystrokes, a real blur.
  await page.click("#money");
  await page.keyboard.type("12abc");
  const err = await page.evaluate(() => { const e = document.querySelector("#desc .budget-field-error"); return e && e.textContent; });
  check("typing a typo shows the message under the description", err, "Not an amount — digits only, like 1250.00.");
  check("with an error border", await page.evaluate(() => getComputedStyle(document.getElementById("money")).borderTopColor !== getComputedStyle(document.getElementById("date")).borderTopColor), true);
  await page.fill("#money", "");
  await page.keyboard.type("1234.5");
  check("fixing it removes the message", await page.evaluate(() => document.querySelectorAll("#desc .budget-field-error").length), 0);
  await page.click("#date");
  check("leaving tidies the figure", await page.inputValue("#money"), "1,234.50");
  check("and the owner received the tidied value", await page.evaluate(() => window.owned), "1,234.50");

  // Date field: a real picker, and it reports ISO.
  check("date field is a native picker", await page.evaluate(() => document.getElementById("date").type), "date");
  check("showing the stored date", await page.inputValue("#date"), "2026-09-22");
  await page.fill("#date", "2026-10-06");
  check("picking a date reports it as YYYY-MM-DD", await page.evaluate(() => window.picked), "2026-10-06");

  await browser.close();
}

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
})().catch((e) => { console.error(e); process.exit(1); });
