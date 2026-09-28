// Universal portfolio import (1.19.0): any company's investment statement, read
// into the user's own investment accounts, saved on its own only when sure.
const P = require("./paths.js");
global.document = { body: { classList: { contains: () => false } } };
const H = require("./harness.js");
const OLD = require("./harness-for.js")(P.BASELINES + "/main.pf-before.js");
const FX = require("./fixtures/fixtures-portfolio.js");
const { el, allText, SettingStub } = H;

let pass = 0, fail = 0;
function check(name, got, want) {
  const ok = JSON.stringify(got) === JSON.stringify(want);
  if (ok) { pass++; console.log(`  PASS  ${name}`); }
  else { fail++; console.log(`  FAIL  ${name}: got ${JSON.stringify(got)}, want ${JSON.stringify(want)}`); }
}
const tick = (ms = 5) => new Promise((r) => setTimeout(r, ms));
const T = H.todayLocal();
const F = H.FILES;
const find = (n, pred, out = []) => { if (pred(n)) out.push(n); (n.children || []).forEach((c) => find(c, pred, out)); return out; };
const byCls = (n, cls) => find(n, (x) => x.classes && x.classes.has(cls));
const text = (n) => allText(n).replace(/\s+/g, " ").trim();
const buttonsIn = (n) => find(n, (x) => x.tag === "button");
const button = (n, label) => buttonsIn(n).find((b) => b._text === label);
const resetStubs = () => { SettingStub.texts = []; SettingStub.buttons = []; SettingStub.dropdowns = []; global.__notices = []; };
const press = (label) => { const b = SettingStub.buttons.filter((x) => x.label === label).pop(); if (!b) throw new Error("no button " + label); return b.cb(); };
const type = (t, v) => { t.inputEl.value = v; t.inputEl.dispatchEvent({ type: "input" }); };
const field = (n) => SettingStub.texts.filter((t) => t.settingName === n).pop();
const dd = (n) => SettingStub.dropdowns.filter((d) => d.settingName === n).pop();

const LEGACY = H.PF_LEGACY_ACCOUNTS.map((a) => Object.assign({}, a));
const acct = (o) => H.normalizePortfolioAccounts([o])[0];
const parse = (txt, accounts = [], snapshots = [], hint = "2026-08") => H.parsePortfolioStatement(txt, hint, { accounts, snapshots });

function makeApp(files = {}) {
  const store = {};
  Object.entries(files).forEach(([k, v]) => (store[k] = JSON.stringify(v)));
  return {
    _store: store,
    vault: {
      adapter: {
        exists: async (p) => p in store,
        read: async (p) => store[p],
        write: async (p, d) => { store[p] = d; },
        mkdir: async () => {},
        list: async () => ({ files: [], folders: [] })
      },
      getFiles: () => [],
      read: async () => ""
    },
    secretStorage: { getSecret: () => null, setSecret: () => {} },
    loadLocalStorage: () => null,
    saveLocalStorage: () => {}
  };
}
const readFile = (app, p) => (p in app._store ? JSON.parse(app._store[p]) : undefined);
function makePlugin(app) {
  const p = Object.create(H.__PluginClass.prototype);
  Object.assign(p, { app, manifest: { id: "budget-tracker" }, settings: {}, _refreshes: 0, refreshDashboard() { this._refreshes++; } });
  return p;
}

(async () => {
// ===========================================================================
console.log("\n1. Fidelity statements read exactly as they always did");
{
  for (const name of ["fidelity401k", "fidelityHsa"]) {
    const now = parse(FX[name], LEGACY);
    const was = OLD.parsePortfolioStatement(FX[name], "2026-08");
    check(`${name}: same snapshot as 1.18.0`, now.snapshot, was.snapshot);
    check(`${name}: same notes`, now.warnings, was.warnings);
    check(`${name}: saved without a review`, [now.ok, now.autoSave, now.review], [true, true, []]);
  }
  // Every figure the old reader took, under many variations of the 401(k).
  const variants = [
    FX.fidelity401k.replace("Vested Balance $53,900.10\n", ""),
    FX.fidelity401k.replace("Statement Period: 07/01/2026 - 07/31/2026\n", ""),
    FX.fidelity401k.replace("This Period 2.1%", "This Period -0.4%"),
    FX.fidelity401k.replace(/\$55,000\.55/, "$1,255,000.55"),
    FX.fidelity401k.replace("Ending Balance $55,000.55", "Market Value of Your Account $55,000.55")
  ];
  variants.forEach((v, i) => {
    const now = parse(v, LEGACY), was = OLD.parsePortfolioStatement(v, "2026-08");
    check(`401(k) variant ${i + 1}: same snapshot`, now.snapshot, was.snapshot);
  });
  const hsaNoEnd = FX.fidelityHsa.replace("Ending Account Value $802.00\n", "");
  check("an HSA missing its ending line isn't saved with the beginning balance as the ending one", [parse(hsaNoEnd, LEGACY).autoSave, parse(hsaNoEnd, LEGACY).missing], [false, ["ending account value"]]);
}

// ===========================================================================
console.log("\n2. Whose statement, and what kind of account");
{
  const det = (n) => { const d = H.detectPortfolioStatement(FX[n]); return [d.provider, d.type, d.confidence]; };
  check("Fidelity 401(k)", det("fidelity401k"), ["Fidelity", "401k", "high"]);
  check("Fidelity HSA", det("fidelityHsa"), ["Fidelity", "hsa", "high"]);
  check("Fidelity brokerage is not read as an HSA", det("fidelityBrokerage"), ["Fidelity", "brokerage", "high"]);
  check("Vanguard Roth IRA (not plain IRA, not brokerage)", det("vanguardRoth"), ["Vanguard", "roth_ira", "high"]);
  check("Empower 401(k)", det("empower401k"), ["Empower", "401k", "high"]);
  check("Schwab One brokerage", det("schwabOne"), ["Charles Schwab", "brokerage", "high"]);
  check("an unknown company's HSA: type known, company not, so not sure", det("genericHsa"), [null, "hsa", "low"]);
  check("not a statement at all", det("notAStatement"), [null, null, "low"]);
  // A Fidelity 401(k) holding Vanguard funds is still Fidelity's.
  const holdsVanguard = FX.fidelity401k.replace("FID FREEDOM 2055 K6", "VANGUARD TARGET RETIREMENT 2055 TRUST") + "\nVanguard Institutional Index Fund";
  check("fund names don't make it Vanguard's", H.detectPortfolioStatement(holdsVanguard).provider, "Fidelity");
  // A statement that only says the company's name, twice, is enough.
  check("the bare name, not in a fund, counts", H.detectPortfolioStatement("Vanguard\nStatement\nVanguard account\nEnding balance $10.00").provider, "Vanguard");
  check("once isn't enough", H.detectPortfolioStatement("Vanguard\nEnding balance $10.00").provider, null);
  const rolled = "Rollover IRA statement\nIRA summary\nFunds rolled over from your former 401(k)\nIRA ending value";
  check("an IRA that mentions the 401(k) it came from is an IRA", H.pfDetectType(rolled).type, "ira");
}

// ===========================================================================
console.log("\n3. The figures on each statement");
{
  const pick = (n, keys) => { const s = parse(FX[n]).snapshot; return keys.map((k) => s[k]); };
  check("Fidelity brokerage", pick("fidelityBrokerage", ["statement_start", "statement_end", "beginning_value", "ending_value", "change_in_investment_value"]),
    ["2026-08-01", "2026-08-31", 29500, 30123.45, 623.45]);
  check("Vanguard: this quarter's column, not year-to-date", pick("vanguardRoth", ["statement_start", "statement_end", "beginning_value", "ending_value", "contributions", "income", "change_in_market_value", "personal_rate_of_return"]),
    ["2026-04-01", "2026-06-30", 45102.1, 48210.55, 1750, 212.4, 1146.05, 6.89]);
  check("Vanguard asset mix", parse(FX.vanguardRoth).snapshot.allocation, { stocks_pct: 82.1, bonds_pct: 15.9, short_term_other_pct: 2 });
  check("Empower: the total, not one source's contributions", pick("empower401k", ["contributions", "fees", "change_in_market_value", "ending_value", "vested_value", "personal_rate_of_return"]),
    [3600, 12.5, 2118.73, 66726.67, 64100, 3.42]);
  check("Empower asset classes that aren't stocks/bonds/cash are left out, not forced", parse(FX.empower401k).snapshot.allocation, undefined);
  check("Schwab", pick("schwabOne", ["statement_start", "statement_end", "beginning_value", "contributions", "withdrawals", "income", "change_in_market_value", "ending_value"]),
    ["2026-06-01", "2026-06-30", 24950.12, 500, 100, 38.22, 22.54, 25410.88]);
  check("Schwab allocation from its composition", parse(FX.schwabOne).snapshot.allocation, { stocks_pct: 75, bonds_pct: 20, short_term_other_pct: 5 });
  check("generic HSA: distributions are withdrawals, stored as the amount", pick("genericHsa", ["withdrawals", "change_in_market_value", "ending_value"]), [45.1, 41.77, 3506.67]);
  check("money out reads the same however it's printed", ["-100.00", "(100.00)", "100.00", "$-100.00"].map((v) => parse(`Vanguard\nvanguard.com\nWithdrawals ${v}\nEnding balance $5.00`).snapshot.withdrawals), [100, 100, 100, 100]);
  check("a loss stays a loss", parse("Vanguard\nvanguard.com\nMarket value change ($1,234.56)\nEnding balance $5.00").snapshot.change_in_market_value, -1234.56);
  check("no holdings are guessed for unchecked layouts", ["vanguardRoth", "schwabOne", "empower401k"].map((n) => parse(FX[n]).snapshot.holdings), [undefined, undefined, undefined]);
}

// ===========================================================================
console.log("\n4. Labels that only look like the right one");
{
  const L = (t, k) => H.pfFindLabeled(t, H.PF_BASE_LABELS[k], "money", ({ ending_value: 1, contributions: 1, withdrawals: 1 })[k] ? { ending_value: /(?:beginning|starting|opening|prior|previous|vested|average|change\s+(?:in|of|from)|net\s+change\s+in)\s*$/i, contributions: /(?:employer|employee|your|company|matching|match|roth|pre-?tax|after-?tax|rollover|catch-?up)\s*$/i, withdrawals: /x^/ }[k] : null);
  const gen = (t) => parse("Vanguard\nvanguard.com\nStatement Period: 06/01/2026 - 06/30/2026\n" + t).snapshot;
  check("'Beginning Account Value' is never the ending value", gen("Beginning Account Value $100.00\nAccount Value $150.00").ending_value, 150);
  check("'Change in Account Value' is never the ending value", gen("Change in Account Value $20.00\nAccount Value $150.00").ending_value, 150);
  check("'Employer Contributions' is never the total", gen("Employer Contributions $500.00").contributions, undefined);
  check("a bare number after a label isn't money", gen("Ending Balance 3\nTotal Value $1,000.00").ending_value, 1000);
  check("a footnote mark and 'as of' date are stepped over", gen("Ending Value 1 $12,000.00").ending_value, 12000);
  check("'as of' dates between the label and value", gen("Total account value as of 06/30/2026 $9,876.54").ending_value, 9876.54);
  check("a percentage is not a balance", gen("Ending Balance 12%\nTotal Value $1,000.00").ending_value, 1000);
  check("year-to-date change isn't this period's", gen("YTD Change in Market Value $900.00\nChange in Market Value $50.00").change_in_market_value, 50);
  void L;
}

// ===========================================================================
console.log("\n5. Statement periods in the shapes statements print them");
{
  const W = (t) => H.pfFindPeriodWide(t);
  check("MM/DD/YYYY - MM/DD/YYYY", W("Statement Period: 04/01/2026 - 06/30/2026"), { start: "2026-04-01", end: "2026-06-30" });
  check("'April 1, 2026, through June 30, 2026'", W("April 1, 2026, through June 30, 2026"), { start: "2026-04-01", end: "2026-06-30" });
  check("'June 1-30, 2026'", W("Statement Period: June 1-30, 2026"), { start: "2026-06-01", end: "2026-06-30" });
  check("'April 1 - June 30, 2026'", W("For April 1 - June 30, 2026"), { start: "2026-04-01", end: "2026-06-30" });
  check("'Nov 1 - Jan 31, 2027' crosses the year", W("Nov 1 - Jan 31, 2027"), { start: "2026-11-01", end: "2027-01-31" });
  check("a period that ends before it starts is refused", W("Statement Period: 06/30/2026 - 04/01/2026"), null);
  check("…and flagged if it's all there is", parse("Vanguard\nvanguard.com\nStatement Period: 06/30/2026 - 04/01/2026\nEnding balance $5.00").autoSave, false);
  check("an 'as of' date alone", H.pfFindAsOf("Balance as of 09/22/2026"), { end: "2026-09-22", quarter: false });
  check("'quarter ended' means a quarter", H.pfFindAsOf("Quarter ended June 30, 2026"), { end: "2026-06-30", quarter: true });
  const asOf = parse(FX.empowerAsOf);
  check("an end date alone covers the month up to it, and says so", [asOf.snapshot.statement_start, asOf.snapshot.statement_end, asOf.warnings.length], ["2026-09-01", "2026-09-22", 1]);
  check("a quarter end alone covers the quarter", H.parsePortfolioStatement("Vanguard\nvanguard.com\nQuarter ended June 30, 2026\nEnding balance $5.00", "2026-08").snapshot.statement_start, "2026-04-01");
  check("month picked, monthly account", H.pfPeriodFromMonth("2026-06"), { start: "2026-06-01", end: "2026-06-30" });
  check("month picked, quarterly account: the three months ending with it", H.pfPeriodFromMonth("2026-06", "quarterly"), { start: "2026-04-01", end: "2026-06-30" });
  check("month picked, quarter crossing the year", H.pfPeriodFromMonth("2026-02", "quarterly"), { start: "2025-12-01", end: "2026-02-28" });
  const q = acct({ id: "e", provider: "Empower", type: "401k", cadence: "quarterly" });
  const noPeriod = "Empower\nempower.com\n401(k) plan\nEnding Balance $70,000.00";
  check("no period on the paste: a quarterly account takes the quarter", H.parsePortfolioStatement(noPeriod, "2026-06", { accounts: [q] }).snapshot.statement_start, "2026-04-01");
}

// ===========================================================================
console.log("\n6. Which of your accounts it is");
{
  const V_ROTH = acct({ id: "vr", provider: "Vanguard", type: "roth_ira", label: "Roth" });
  const V_BROK = acct({ id: "vb", provider: "Vanguard", type: "brokerage", label: "Taxable" });
  const E1 = acct({ id: "e1", provider: "Empower", type: "401k", label: "Old job", account_hint: "1111" });
  const E2 = acct({ id: "e2", provider: "Empower", type: "401k", label: "New job", account_hint: "4321" });
  const HE = acct({ id: "he", provider: "HealthEquity", type: "hsa", label: "HSA" });
  const all = [...LEGACY.map(acct), V_ROTH, V_BROK, E1, E2, HE];

  let r = parse(FX.vanguardRoth, all);
  check("company and kind match one account: sure, saved", [r.account.id, r.autoSave], ["vr", true]);
  r = parse(FX.empower401k, all);
  check("two of the same kind: the last 4 decide", [r.account.id, r.autoSave], ["e2", true]);
  r = parse(FX.empower401k.replace("XXXXX4321", "XXXXX9999"), all);
  check("two of the same kind, number matches neither: asks which", [r.account, r.candidates.map((a) => a.id), r.autoSave], [null, ["e1", "e2"], false]);
  r = parse(FX.empower401k, [acct({ id: "e", provider: "Empower", type: "401k", label: "E", account_hint: "1111" })]);
  check("the only such account, but the number on the statement is another: review", [r.account.id, r.autoSave, /doesn't end in 1111/.test(r.review.join(" "))], ["e", false, true]);
  r = parse(FX.genericHsa, all);
  check("unknown company: only accounts at companies it doesn't know by name", [r.account && r.account.id, r.autoSave, r.review[0]], ["he", false, "Couldn't tell which company this statement is from."]);
  r = parse(FX.schwabOne, all);
  check("no account at that company: offers to add one", [r.account, r.candidates, r.suggested.label, r.autoSave], [null, [], "Charles Schwab Brokerage", false]);
  r = parse(FX.vanguardRoth, [V_BROK]);
  check("the only account there, set up as another kind: filed, but flagged", [r.account.id, r.autoSave, /reads as Roth IRA, but Taxable is set up as Brokerage/.test(r.review.join(" "))], ["vb", false, true]);
  r = parse(FX.schwabOne, [acct({ id: "x", provider: "Vanguard", type: "brokerage", account_hint: "5678" })]);
  check("an account at another company isn't chosen just by its last 4 when a company is known", r.account, null);
  r = parse(FX.genericHsa.replace("HealthEquity\n", ""), [acct({ id: "z", provider: "Vanguard", type: "brokerage", account_hint: "9911" })]);
  check("with no company known, the last 4 alone can suggest one — for review", [r.account && r.account.id, r.autoSave], ["z", false]);
  check("company names compare loosely", H.pfSameProvider(" charles schwab ", "Charles Schwab"), true);
  const sug = H.pfSuggestedAccount({ provider: "Empower", type: "401k" }, { start: "2026-04-01", end: "2026-06-30" });
  check("a statement covering a quarter suggests a quarterly account", sug, { provider: "Empower", type: "401k", label: "Empower 401(k)", cadence: "quarterly" });
}

// ===========================================================================
console.log("\n7. Saved on its own only when everything is sure");
{
  const V = acct({ id: "vr", provider: "Vanguard", type: "roth_ira", label: "Roth" });
  const prior = (v, end = "2026-03-31") => [{ account_id: "vr", statement_start: "2026-01-01", statement_end: end, ending_value: v }];
  check("a normal quarter: saved", parse(FX.vanguardRoth, [V], prior(45102.1)).autoSave, true);
  let r = parse(FX.vanguardRoth, [V], prior(20000));
  check("more than 40% up on the last statement: review, and says why", [r.autoSave, /141% higher than the last statement \(\$20000\.00 on 2026-03-31\)/.test(r.review.join(" "))], [false, true]);
  r = parse(FX.vanguardRoth, [V], prior(100000));
  check("more than 40% down: review", [r.autoSave, /52% lower/.test(r.review.join(" "))], [false, true]);
  check("a big share of a tiny balance isn't flagged", H.pfJumpNote({ ending_value: 300 }, [{ account_id: "a", statement_end: "2026-01-31", ending_value: 100 }], { id: "a" }), null);
  check("only earlier statements are compared", parse(FX.vanguardRoth, [V], prior(10, "2026-09-30")).autoSave, true);
  r = parse(FX.vanguardCombined, [V]);
  check("a paste covering two accounts: review, and says the figures may be totals", [r.autoSave, /more than one account/.test(r.review.join(" "))], [false, true]);
  r = parse(FX.vanguardRoth.replace(/Ending balance.*\n/, "").replace(/Total account value.*\n/, ""), [V]);
  check("no ending value found: review, naming what's missing", [r.ok, r.autoSave, r.missing], [true, false, ["ending value"]]);
  r = parse(FX.notAStatement, [V]);
  check("nothing statement-shaped: refused outright", [r.ok, r.missing], [false, ["a recognizable investment or retirement statement"]]);
  r = parse(FX.genericHsa, [acct({ id: "he", provider: "HealthEquity", type: "hsa" })]);
  check("an unknown company is never saved without a look", r.autoSave, false);
}

// ===========================================================================
console.log("\n8. Investment accounts");
{
  const n = H.normalizePortfolioAccounts([
    { id: "fidelity_401k", provider: "Fidelity", type: "401k", label: "Fidelity 401(k)" },
    { id: "x", provider: " Vanguard ", type: "crypto", label: "", account_hint: "12345" },
    null, { provider: "no id" }
  ]);
  check("an old account gains a monthly cadence and keeps its id", [n[0].id, n[0].cadence, n[0].account_hint], ["fidelity_401k", "monthly", null]);
  check("an unknown kind is 'other', a blank name is made up, a bad last 4 is dropped", [n[1].type, n[1].label, n[1].provider, n[1].account_hint], ["other", "Vanguard Investment account", "Vanguard", null]);
  check("junk rows are dropped", n.length, 2);
  check("a missing file comes back as only the old accounts the snapshots use", H.seedPortfolioAccounts([{ account_id: "fidelity_hsa" }]).map((a) => a.id), ["fidelity_hsa"]);
  check("a fresh vault starts with none", H.seedPortfolioAccounts([]), []);
  const made = H.pfAccountFromForm({ provider: "Empower", type: "401k", label: "  ", cadence: "quarterly", account_hint: "x4-3-2-1" });
  check("made from the form", [made.provider, made.type, made.label, made.cadence, made.account_hint, /^pf-/.test(made.id)], ["Empower", "401k", "Empower 401(k)", "quarterly", "4321", true]);
  const kept = H.pfAccountFromForm({ provider: "Empower", type: "ira", label: "Rolled", cadence: "none" }, made);
  check("editing keeps the id", [kept.id === made.id, kept.type, kept.cadence, kept.account_hint], [true, "ira", "none", null]);

  let app = makeApp({ [F.portfolioSnapshots]: [{ account_id: "fidelity_401k", statement_end: "2026-07-31", ending_value: 1 }] });
  let p = makePlugin(app);
  check("missing file: rebuilt from the snapshots and written", [(await p.loadPortfolioAccounts()).map((a) => a.id), readFile(app, F.portfolioAccounts).map((a) => a.id)], [["fidelity_401k"], ["fidelity_401k"]]);
  app = makeApp({ [F.portfolioAccounts]: [], [F.portfolioSnapshots]: [{ account_id: "fidelity_401k", statement_end: "2026-07-31", ending_value: 1 }] });
  p = makePlugin(app);
  check("an empty list stays empty — they were deleted on purpose", await p.loadPortfolioAccounts(), []);
  app = makeApp({});
  p = makePlugin(app);
  check("a brand-new vault gets no Fidelity accounts it never had", await p.ensurePortfolioAccounts(), []);

  app = makeApp({
    [F.portfolioAccounts]: LEGACY,
    [F.portfolioSnapshots]: [{ account_id: "fidelity_401k", statement_end: "2026-07-31", ending_value: 1 }, { account_id: "fidelity_hsa", statement_end: "2026-07-31", ending_value: 2 }]
  });
  p = makePlugin(app);
  await p.savePortfolioAccount(Object.assign(acct(LEGACY[0]), { label: "Work 401(k)" }));
  check("saving replaces by id", readFile(app, F.portfolioAccounts).map((a) => a.label), ["Work 401(k)", "Fidelity HSA"]);
  global.__notices = [];
  await p.deletePortfolioAccount(acct(LEGACY[1]));
  check("deleting takes its statements with it, and only its", [readFile(app, F.portfolioAccounts).map((a) => a.id), readFile(app, F.portfolioSnapshots).map((s) => s.account_id), global.__notices.pop()],
    [["fidelity_401k"], ["fidelity_401k"], "Deleted Fidelity HSA and its 1 statement(s)."]);
}

// ===========================================================================
console.log("\n9. Reminders follow each account's schedule");
{
  const M = acct({ id: "m", label: "Monthly", cadence: "monthly" });
  const Q = acct({ id: "q", label: "Quarterly", cadence: "quarterly" });
  const N = acct({ id: "n", label: "Never", cadence: "none" });
  const due = (snaps, today) => H.portfolioReminders(snaps, [M, Q, N], today).map((r) => [r.account.id, r.monthKey]);
  check("before the 7th: nothing for last month yet, but a quarter already overdue still asks", due([], "2026-08-05"), [["q", "2026-06"]]);
  check("after the 7th in a quarter's second month: last month for monthly, last quarter for quarterly", due([], "2026-08-10"), [["m", "2026-07"], ["q", "2026-06"]]);
  check("the month after a quarter ends waits for the 7th", due([], "2026-07-05"), []);
  check("then asks for it", due([], "2026-07-08"), [["m", "2026-06"], ["q", "2026-06"]]);
  check("covered by any statement ending in or after the quarter's last month", due([{ account_id: "q", statement_end: "2026-06-30" }, { account_id: "m", statement_end: "2026-07-31" }], "2026-08-10"), []);
  check("'don't remind me' never does", H.portfolioReminders([], [N], "2026-08-10"), []);
  check("January asks for last December's quarter", due([], "2027-01-10").find((x) => x[0] === "q"), ["q", "2026-12"]);
  check("reminder text for a quarter", H.portfolioReminderText({ account: Q, monthKey: "2026-06", cadence: "quarterly" }), "Q2 2026 Quarterly statement hasn't been imported.");
  check("reminder text for a month", H.portfolioReminderText({ account: M, monthKey: "2026-07", cadence: "monthly" }), "July 2026 Monthly statement hasn't been imported.");
}

// ===========================================================================
console.log("\n10. The total over time");
{
  const A = acct({ id: "a" }), B = acct({ id: "b", cadence: "quarterly" });
  const snaps = [
    { account_id: "a", statement_end: "2026-04-30", ending_value: 100 },
    { account_id: "b", statement_end: "2026-04-30", ending_value: 1000 },
    { account_id: "a", statement_end: "2026-05-31", ending_value: 110 },
    { account_id: "a", statement_end: "2026-06-30", ending_value: 120 },
    { account_id: "b", statement_end: "2026-06-30", ending_value: 1100 },
    { account_id: "gone", statement_end: "2026-05-31", ending_value: 99999 }
  ];
  check("a quarterly account carries forward instead of dropping out", H.portfolioHistory(snaps, [A, B]), [
    { month: "2026-04", value: 1100 }, { month: "2026-05", value: 1110 }, { month: "2026-06", value: 1220 }
  ]);
  check("a deleted account's statements aren't counted", H.portfolioHistory(snaps, [A]).map((x) => x.value), [100, 110, 120]);
}

// ===========================================================================
console.log("\n11. Building a snapshot from the review form");
{
  const read = { allocation: { stocks_pct: 1, bonds_pct: 2, short_term_other_pct: 97 }, holdings: [{ name: "X" }] };
  let r = H.pfSnapshotFromForm(read, { account_id: "a", statement_start: "2026-06-01", statement_end: "2026-06-30",
    values: { ending_value: "1,234.50", beginning_value: "", withdrawals: "40", change_in_market_value: "-12.00", personal_rate_of_return: "3.25" } });
  check("typed figures, blanks left out, holdings and allocation carried", [r.errors, r.snapshot], [[], {
    account_id: "a", statement_start: "2026-06-01", statement_end: "2026-06-30",
    ending_value: 1234.5, withdrawals: 40, change_in_market_value: -12, personal_rate_of_return: 3.25,
    allocation: read.allocation, holdings: read.holdings
  }]);
  r = H.pfSnapshotFromForm({}, { account_id: "", statement_start: "", statement_end: "2026-06-30", values: { ending_value: "abc", withdrawals: "-5" } });
  check("every problem is named, account first", r.errors, [
    "Choose which account this statement belongs to.",
    "Ending value: Not an amount — digits only, like 1250.00.",
    "Withdrawals: Can’t be negative here.",
    "Missing statement start date.",
    "Missing ending value."
  ]);
  const snaps = [{ account_id: "a", statement_end: "2026-06-30", ending_value: 5, statement_start: "2026-06-01" }];
  check("new", H.pfPlaceSnapshot(snaps, { account_id: "b", statement_end: "2026-06-30" }).status, "new");
  check("same, whatever the key order", H.pfPlaceSnapshot(snaps, { statement_start: "2026-06-01", ending_value: 5, statement_end: "2026-06-30", account_id: "a" }).status, "same");
  check("different figures replace", H.pfPlaceSnapshot(snaps, { account_id: "a", statement_start: "2026-06-01", statement_end: "2026-06-30", ending_value: 6 }), { status: "replace", index: 0 });
}

// ===========================================================================
console.log("\n12. Importing");
function importModal(app, plugin) {
  resetStubs();
  const imported = [];
  const m = new H.PortfolioImportModal(app, plugin, () => imported.push(1));
  m.app = app;
  m.modalEl = el("div");
  m.open();
  const ta = find(m.contentEl, (x) => x.tag === "textarea")[0];
  const paste = async (t) => { ta.value = t; m.pastedText = t; await press("Parse Statement"); await tick(); };
  return { m, ta, paste, imported, result: () => text(m.resultEl) };
}
{
  // A sure read files itself.
  let app = makeApp({ [F.portfolioAccounts]: LEGACY, [F.portfolioSnapshots]: [] });
  let p = makePlugin(app);
  let s = importModal(app, p);
  check("the paste box explains it takes any company's statement", /Fidelity, Vanguard, Empower, Schwab or another company/.test(text(s.m.contentEl)), true);
  await s.paste(FX.fidelity401k);
  check("a sure Fidelity read saves straight away", [readFile(app, F.portfolioSnapshots).length, readFile(app, F.portfolioSnapshots)[0].account_id, s.imported.length, s.ta.value], [1, "fidelity_401k", 1, ""]);
  check("and reports every figure it saved", /Statement imported .* Ending value \$55000\.55 .* Your personal rate of return 2\.1% .* 1 holding\(s\) captured/.test(s.result()), true);
  s = importModal(app, p);
  await s.paste(FX.fidelity401k);
  check("the same statement again changes nothing", [/Already imported/.test(s.result()), readFile(app, F.portfolioSnapshots).length, s.imported.length], [true, 1, 0]);

  // A different read of a stored statement asks first.
  let confirm = null;
  const origOpen = H.ConfirmModal.prototype.open;
  H.ConfirmModal.prototype.open = function () { confirm = this.opts; };
  s = importModal(app, p);
  await s.paste(FX.fidelity401k.replace("$55,000.55", "$55,100.55"));
  check("a changed read of the same statement asks before replacing", [confirm && confirm.title, readFile(app, F.portfolioSnapshots)[0].ending_value], ["Replace the July 2026 snapshot?", 55000.55]);
  await confirm.onConfirm();
  check("and replaces it on confirm", [readFile(app, F.portfolioSnapshots).length, readFile(app, F.portfolioSnapshots)[0].ending_value], [1, 55100.55]);
  H.ConfirmModal.prototype.open = origOpen;

  // Not a statement.
  s = importModal(app, p);
  await s.paste(FX.notAStatement);
  check("not a statement: nothing saved, the paste is kept to fix", [/Import failed/.test(s.result()), s.ta.value === FX.notAStatement], [true, true]);

  // The review step: a Schwab statement, no Schwab account yet.
  app = makeApp({ [F.portfolioAccounts]: LEGACY, [F.portfolioSnapshots]: [] });
  p = makePlugin(app);
  s = importModal(app, p);
  await s.paste(FX.schwabOne);
  check("an unsure read isn't saved", readFile(app, F.portfolioSnapshots), []);
  check("it says why, and shows what it read", /Check this before it's saved .*This reads as Charles Schwab Brokerage, and none of your investment accounts matches/.test(s.result()), true);
  check("the account list offers adding it, chosen already since nothing matches",
    [dd("Account").value, dd("Account").options.map((o) => o.label)], ["__new", ["Choose…", "Fidelity 401(k)", "Fidelity HSA", "New account: Charles Schwab Brokerage…"]]);
  check("what it found is filled in and marked", [field("Ending value").inputEl.value, field("Withdrawals").inputEl.value, field("Beginning value").inputEl.value], ["25,410.88", "100.00", "24,950.12"]);
  check("figures it didn't find are tucked under 'add a figure'", /Add a figure it didn't find \(5\)/.test(s.result()), true);
  check("the period is filled in", SettingStub.texts.filter((t) => t.settingName === "Statement period").map((t) => t.inputEl.value), ["2026-06-01", "2026-06-30"]);

  // Saving a new account from the review: the account form opens prefilled,
  // and the statement is filed under what it makes.
  let accountModal = null;
  const origAcctOpen = H.PortfolioAccountModal.prototype.open;
  H.PortfolioAccountModal.prototype.open = function () { accountModal = this; resetStubsKeep(); this.onOpen(); };
  function resetStubsKeep() { SettingStub.texts = []; SettingStub.buttons = []; SettingStub.dropdowns = []; }
  type(field("Ending value"), "25,500.00");
  await press("Save snapshot");
  await tick();
  check("the account form opens with what the statement said, last 4 included",
    [dd("Company").value, dd("Kind of account").value, field("Name").inputEl.value, dd("Statements come").value, field("Last 4 of account number").inputEl.value],
    ["Charles Schwab", "brokerage", "Charles Schwab Brokerage", "monthly", "5678"]);
  check("nothing is saved yet", [readFile(app, F.portfolioAccounts).length, readFile(app, F.portfolioSnapshots)], [2, []]);
  await press("Add account");
  await tick(20);
  const accounts = readFile(app, F.portfolioAccounts);
  const snaps = readFile(app, F.portfolioSnapshots);
  check("the account is added, and the statement filed under it with the corrected figure",
    [accounts.length, accounts[2].label, accounts[2].account_hint, snaps.length, snaps[0].account_id === accounts[2].id, snaps[0].ending_value, snaps[0].withdrawals],
    [3, "Charles Schwab Brokerage", "5678", 1, true, 25500, 100]);
  check("and it says so", /Account added and statement imported/.test(s.result()), true);

  // Next month's Schwab statement files itself.
  s = importModal(app, p);
  await s.paste(FX.schwabOne.replace(/June 1-30, 2026/, "July 1-31, 2026").replace(/06\/30\/2026/g, "07/31/2026"));
  check("next time, the same kind of statement saves on its own", [readFile(app, F.portfolioSnapshots).length, /Statement imported/.test(s.result())], [2, true]);

  // A review with a mistake can't leave a stray account behind.
  app = makeApp({ [F.portfolioAccounts]: [], [F.portfolioSnapshots]: [] });
  p = makePlugin(app);
  s = importModal(app, p);
  await s.paste(FX.genericHsa);
  accountModal = null;
  type(field("Ending value"), "");
  global.__notices = [];
  await press("Save snapshot");
  check("a missing figure is caught before any account is made", [accountModal, global.__notices.pop(), readFile(app, F.portfolioAccounts)], [null, "Missing ending value.", []]);

  // Choosing an existing account instead.
  app = makeApp({ [F.portfolioAccounts]: [acct({ id: "hsa1", provider: "HealthEquity", type: "hsa", label: "My HSA" }), acct({ id: "b", provider: "Vanguard", type: "brokerage", label: "B" })], [F.portfolioSnapshots]: [] });
  p = makePlugin(app);
  s = importModal(app, p);
  await s.paste(FX.genericHsa);
  check("an unknown company's HSA is offered the HSA it's probably filed under", [dd("Account").value, dd("Account").options[1].label], ["hsa1", "My HSA"]);
  await press("Save snapshot");
  await tick();
  check("saved under the chosen account", readFile(app, F.portfolioSnapshots).map((x) => [x.account_id, x.ending_value]), [["hsa1", 3506.67]]);
  H.PortfolioAccountModal.prototype.open = origAcctOpen;

  // The pasted text is never written anywhere.
  const blob = JSON.stringify(app._store) + JSON.stringify(makeApp()._store);
  check("nothing from the paste but the figures is stored", ["Health Savings Account Statement", "9911", "Account ending", "Investment Earnings"].map((w) => blob.includes(w)), [false, false, false, false]);
}

// ===========================================================================
console.log("\n13. The account form");
{
  const open = (opts = {}) => {
    resetStubs();
    let got = null, closed = false;
    const m = new H.PortfolioAccountModal({}, opts, (a) => { got = a; });
    m.close = () => { closed = true; };
    m.open();
    return { m, got: () => got, closed: () => closed };
  };
  let s = open();
  check("a new account starts unchosen, as a 401(k), monthly", [dd("Company").value, dd("Kind of account").value, dd("Statements come").value], ["", "401k", "monthly"]);
  check("every kind of account is offered", dd("Kind of account").options.map((o) => o.value), Object.keys(H.PF_TYPES));
  check("Other company is offered, its name box hidden until chosen", [dd("Company").options.map((o) => o.value).pop(), field("Company name").setting.settingEl.classes.has("budget-hidden")], ["__other", true]);
  await press("Add account");
  check("no company: refused", [s.got(), global.__notices.pop()], [null, "Choose the company."]);
  dd("Company").choose("Vanguard");
  check("the name follows the company and kind", field("Name").inputEl.value, "Vanguard 401(k)");
  dd("Kind of account").choose("roth_ira");
  check("…as either changes", field("Name").inputEl.value, "Vanguard Roth IRA");
  type(field("Name"), "Retirement");
  dd("Kind of account").choose("ira");
  check("until you name it yourself", field("Name").inputEl.value, "Retirement");
  type(field("Last 4 of account number"), "12a4");
  await press("Add account");
  check("a last 4 that isn't four digits is refused", global.__notices.pop(), "The last 4 has to be exactly four digits, or left blank.");
  type(field("Last 4 of account number"), "1234");
  dd("Statements come").choose("quarterly");
  await press("Add account");
  check("saved", [s.closed(), s.got().provider, s.got().type, s.got().label, s.got().cadence, s.got().account_hint], [true, "Vanguard", "ira", "Retirement", "quarterly", "1234"]);

  s = open();
  dd("Company").choose("__other");
  check("choosing Other shows the name box", field("Company name").setting.settingEl.classes.has("budget-hidden"), false);
  await press("Add account");
  check("Other with no name: refused", global.__notices.pop(), "Enter the company's name.");
  type(field("Company name"), "TIAA");
  check("the name follows a typed company too", field("Name").inputEl.value, "TIAA 401(k)");
  await press("Add account");
  check("any company works", [s.got().provider, s.got().label], ["TIAA", "TIAA 401(k)"]);

  const mine = acct({ id: "x1", provider: "TIAA", type: "403b", label: "Pension-ish", cadence: "none" });
  s = open({ existing: mine, others: [mine, acct({ id: "x2", provider: "Fidelity", type: "hsa", label: "HSA" })] });
  check("editing an account at an unnamed company shows it as Other", [dd("Company").value, field("Company name").inputEl.value, dd("Statements come").value, field("Name").inputEl.value], ["__other", "TIAA", "none", "Pension-ish"]);
  type(field("Name"), "hsa");
  await press("Save changes");
  check("two accounts can't share a name", global.__notices.pop(), "There's already an account called HSA. Give this one a different name.");
  type(field("Name"), "Pension-ish");
  await press("Save changes");
  check("an edit keeps its id", s.got().id, "x1");
}

// ===========================================================================
console.log("\n14. Settings");
{
  const app = makeApp({
    [F.portfolioAccounts]: [acct({ id: "a", provider: "Empower", type: "401k", label: "Work", cadence: "quarterly", account_hint: "4321" }), acct({ id: "b", provider: "Fidelity", type: "hsa", label: "HSA", cadence: "none" })],
    [F.portfolioSnapshots]: [{ account_id: "a", statement_end: "2026-06-30", ending_value: 1 }, { account_id: "a", statement_end: "2026-03-31", ending_value: 1 }]
  });
  const plugin = makePlugin(app);
  const tab = Object.create(H.BudgetSettingTab.prototype);
  Object.assign(tab, { app, plugin, _openSections: { portfolio: true }, display() { tab._displayed = (tab._displayed || 0) + 1; } });
  resetStubs();
  const root = el("div");
  await tab.renderPortfolioSettings(root);
  const t = text(root);
  check("its own section, with a count", /Investment accounts.*2 accounts/.test(t), true);
  check("each account says what it is and how many statements it has", [/Work Empower · 401\(k\) · quarterly statements · ends 4321 · 2 statements/.test(t), /HSA Fidelity · HSA · no reminders · 0 statements/.test(t)], [true, true]);
  check("says it's read-only", /never count toward cash, Spendable, goals or debt/.test(t), true);
  let confirm = null;
  const origOpen = H.ConfirmModal.prototype.open;
  H.ConfirmModal.prototype.open = function () { confirm = this.opts; };
  button(root, "Delete").onclick();
  check("deleting warns its statements go too", [confirm.title, confirm.body], ["Delete Work?", ["Its 2 imported statements will be deleted with it, and drop out of the Portfolio total and chart."]]);
  await confirm.onConfirm();
  check("and does it", [readFile(app, F.portfolioAccounts).map((a) => a.id), readFile(app, F.portfolioSnapshots), tab._displayed], [["b"], [], 1]);
  H.ConfirmModal.prototype.open = origOpen;
  const empty = el("div");
  const tab2 = Object.assign(Object.create(H.BudgetSettingTab.prototype), { app: makeApp({ [F.portfolioAccounts]: [] }), plugin: makePlugin(makeApp({ [F.portfolioAccounts]: [] })), _openSections: { portfolio: true } });
  await tab2.renderPortfolioSettings(empty);
  check("none yet", /No investment accounts yet\./.test(text(empty)), true);
}

// ===========================================================================
console.log("\n15. The Portfolio tab");
async function portfolioTab(files) {
  const app = makeApp(files);
  const plugin = makePlugin(app);
  const opened = [];
  plugin.promptPortfolioImport = () => opened.push("import");
  plugin.promptPortfolioAccount = (a) => opened.push(["account", a]);
  const v = Object.create(H.BudgetDashboardView.prototype);
  Object.assign(v, { app, plugin, sectionOpen: {}, scrollMemory: {} });
  const root = el("div");
  await v.renderPortfolio(root);
  return { root, opened, t: text(root) };
}
{
  let r = await portfolioTab({});
  check("nothing yet: says how to start, with both ways in", [/No investment accounts yet/.test(r.t), /the account is set up from it, or add one first/.test(r.t), !!button(r.root, "Import statement"), !!button(r.root, "Add account")], [true, true, true, true]);
  button(r.root, "Add account").onclick();
  check("Add account opens the form", r.opened, [["account", null]]);
  check("no Fidelity-only wording left", /Fidelity 401\(k\) or HSA/.test(r.t), false);

  const today = T;
  const lastMonthEnd = (() => { const [y, m] = today.split("-").map(Number); const d = new Date(y, m - 1, 0); return H.toLocalISO(d); })();
  const lastMonthStart = lastMonthEnd.slice(0, 8) + "01";
  const accs = [
    acct({ id: "fidelity_401k", provider: "Fidelity", type: "401k", label: "Fidelity 401(k)" }),
    acct({ id: "e", provider: "Empower", type: "401k", label: "Old job", cadence: "none" }),
    acct({ id: "n", provider: "Vanguard", type: "roth_ira", label: "Roth" })
  ];
  r = await portfolioTab({
    [F.portfolioAccounts]: accs,
    [F.portfolioSnapshots]: [
      { account_id: "fidelity_401k", statement_start: lastMonthStart, statement_end: lastMonthEnd, ending_value: 1000, beginning_value: 900, personal_rate_of_return: 2.1 },
      { account_id: "e", statement_start: "2026-01-01", statement_end: "2026-03-31", ending_value: 500, contributions: 50, withdrawals: 10, fees: 1.25 },
      { account_id: "gone", statement_start: "2026-01-01", statement_end: "2026-01-31", ending_value: 99999 }
    ]
  });
  check("the total is the accounts you have, not stray statements", /\$1500\.00 Across 2 accounts/.test(r.t), true);
  const cards = byCls(r.root, "budget-portfolio-card").map(text);
  check("each card says what the account is", [/Fidelity · 401\(k\)/.test(cards[0]), /Empower · 401\(k\)/.test(cards[1]), /Vanguard · Roth IRA/.test(cards[2])], [true, true, true]);
  check("an up-to-date account reads as updated", /Updated through/.test(cards[0]), true);
  check("an account without reminders isn't called missing", /Updated through 2026-03-31/.test(cards[1]), true);
  check("new figures show on the card", [/Contributions \$50\.00/.test(cards[1]), /Withdrawals \$10\.00/.test(cards[1]), /Fees \$1\.25/.test(cards[1])], [true, true, true]);
  check("rate of return as a percentage", /Your personal rate of return 2\.1%/.test(cards[0]), true);
  check("an account with no statements yet", /Roth no statements yet .* Import a statement to start tracking/.test(cards[2]), true);
  check("reminders only for the accounts that are due", byCls(r.root, "budget-portfolio-reminder").map(text).length, T.slice(8) >= "07" ? 1 : 0);

  // One account's missing statement doesn't mark every card missing.
  r = await portfolioTab({
    [F.portfolioAccounts]: [acct({ id: "a", label: "A" }), acct({ id: "b", label: "B" })],
    [F.portfolioSnapshots]: [
      { account_id: "a", statement_start: lastMonthStart, statement_end: lastMonthEnd, ending_value: 1 },
      { account_id: "b", statement_start: "2025-01-01", statement_end: "2025-01-31", ending_value: 1 }
    ]
  });
  const two = byCls(r.root, "budget-portfolio-card").map(text);
  if (T.slice(8) >= "07") check("only the late account says missing", [/statement missing/.test(two[0]), /statement missing/.test(two[1])], [false, true]);
  else check("(before the 7th nothing is missing)", [/statement missing/.test(two[0]), /statement missing/.test(two[1])], [false, false]);

  // The chart carries a quarterly account forward.
  r = await portfolioTab({
    [F.portfolioAccounts]: [acct({ id: "a", label: "A" }), acct({ id: "q", label: "Q", cadence: "quarterly" })],
    [F.portfolioSnapshots]: [
      { account_id: "a", statement_start: "2026-04-01", statement_end: "2026-04-30", ending_value: 100 },
      { account_id: "q", statement_start: "2026-02-01", statement_end: "2026-04-30", ending_value: 1000 },
      { account_id: "a", statement_start: "2026-05-01", statement_end: "2026-05-31", ending_value: 110 }
    ]
  });
  check("a trend chart once there are two months", /Value over time/.test(r.t), true);
  check("quarterly card is labelled quarterly", /· quarterly/.test(byCls(r.root, "budget-portfolio-card").map(text)[1]), true);
}

// ===========================================================================
console.log("\n16. Audit: other companies' statements aren't filed as Fidelity's");
{
  const F401 = acct({ id: "fidelity_401k", provider: "Fidelity", type: "401k", label: "Fidelity 401(k)" });
  const FHSA = acct({ id: "fidelity_hsa", provider: "Fidelity", type: "hsa", label: "Fidelity HSA" });
  const T403 = acct({ id: "t403", provider: "TIAA", type: "403b", label: "TIAA 403(b)" });
  const F403 = acct({ id: "f403", provider: "Fidelity", type: "403b", label: "Fidelity 403(b)" });
  const FBRK = acct({ id: "fb", provider: "Fidelity", type: "brokerage", label: "Fidelity brokerage" });
  const HE = acct({ id: "he", provider: "HealthEquity", type: "hsa", label: "HealthEquity HSA" });
  const tiaa = "TIAA\nRetirement Plan Statement\nState University 403(b) Plan\nStatement Period: 07/01/2026 - 07/31/2026\nBeginning Balance $40,000.00\nChange in Market Value $500.00\nEnding Balance $40,500.00\nVested Balance $40,500.00";
  let r = parse(tiaa, [F401, T403]);
  check("a TIAA 403(b) worded like NetBenefits isn't saved into the Fidelity 401(k)", [r.profileId, r.account && r.account.id, r.autoSave], ["generic", "t403", false]);
  r = parse(tiaa.replace("TIAA\n", "Principal Financial Group\n").replace("403(b)", "401(k)"), [F401]);
  check("nor is another company's 401(k)", [r.account, r.autoSave], [null, false]);
  const fid403 = FX.fidelity401k.replace("ACME CORPORATION 401(K) PLAN", "STATE UNIVERSITY 403(B) PLAN");
  r = parse(fid403, [F401, F403]);
  check("a Fidelity 403(b) goes to the 403(b), not the 401(k)", [r.detected.type, r.account && r.account.id], ["403b", "f403"]);
  r = parse(FX.fidelityBrokerage + "\nSave for healthcare with a Fidelity HSA. Visit fidelity.com/hsa", [FHSA, FBRK]);
  check("a brokerage statement with an HSA ad isn't saved into the HSA", r.autoSave, false);
  const heText = "HealthEquity\nStatement Period 07/01/2026 - 07/31/2026\nHealth Savings Account\nBeginning Account Value $3,210.00\nEnding Account Value $3,506.67";
  r = parse(heText, [FHSA, HE]);
  check("another company's HSA using Fidelity's wording isn't filed as Fidelity's", [r.profileId, r.account && r.account.id !== "fidelity_hsa", r.autoSave], ["generic", true, false]);
  const noBrand = FX.fidelityHsa.replace("Fidelity Health Savings Account", "Health Savings Account").replace("FIDELITY 500 INDEX FUND", "VANGUARD\nTOTAL STOCK MKT IDX") + "\nVANGUARD\nTOTAL BOND MKT IDX";
  check("a fund name wrapped onto the next line doesn't make it Vanguard's", H.detectPortfolioStatement(noBrand).provider, null);
  check("…and without Fidelity's name it's reviewed, not saved", parse(noBrand, [FHSA]).autoSave, false);
}

console.log("\n17. Audit: columns, dashes, zeros and losses");
{
  const V = acct({ id: "v", provider: "Vanguard", type: "roth_ira", label: "Roth" });
  const S = acct({ id: "s", provider: "Charles Schwab", type: "brokerage", label: "Schwab" });
  const E = acct({ id: "e", provider: "Empower", type: "401k", label: "Empower" });
  const head = (co, kind) => `${co}\n${kind}\nStatement Period: 07/01/2026 - 07/31/2026\n`;
  let r = parse(head("Vanguard\nvanguard.com", "Roth IRA") + "Beginning balance Ending balance\n$45,102.10 $48,210.55", [V]);
  check("labels on one line, values on the next: the ending value isn't guessed", [r.snapshot.ending_value, r.autoSave], [null, false]);
  r = parse(head("Charles Schwab & Co., Inc.\nschwab.com", "Schwab One brokerage account") + "Starting Value $24,950.12 $22,100.00\nDeposits — 2,000.00\nWithdrawals — (400.00)\nEnding Value $24,950.12 $24,950.12", [S]);
  check("a dash for 'none this period' is 0, not the year-to-date figure or a negative", [r.snapshot.contributions, r.snapshot.withdrawals], [0, 0]);
  r = parse(head("Charles Schwab & Co., Inc.\nschwab.com", "Schwab One brokerage account") + "Withdrawals 0 2,000.00\nFees 0 12.00\nEnding Value $24,950.12", [S]);
  check("a printed 0 is 0, not a footnote before the year-to-date figure", [r.snapshot.withdrawals, r.snapshot.fees], [0, 0]);
  check("the period survives the dash handling", r.snapshot.statement_start, "2026-07-01");
  r = parse(head("Empower\nempower.com", "401(k) plan") + "Ending Balance $60,500.00\nGain/Loss −$520.44\nPersonal Rate of Return −0.85%\nYear-to-date\nGain/Loss $4,100.00\nRate of Return 7.10%", [E]);
  check("a PDF's minus sign (U+2212) is a loss, not a reason to take the year-to-date row", [r.snapshot.change_in_market_value, r.snapshot.personal_rate_of_return], [-520.44, -0.85]);
  check("(0.85)% and (0.85%) are losses", [
    parse(head("Empower\nempower.com", "401(k) plan") + "Ending Balance $1.00\nPersonal Rate of Return (0.85)%", [E]).snapshot.personal_rate_of_return,
    parse(head("Empower\nempower.com", "401(k) plan") + "Ending Balance $1.00\nPersonal Rate of Return (0.85%)", [E]).snapshot.personal_rate_of_return
  ], [-0.85, -0.85]);
  check("a sign has to touch its number", H.pfFindLabeled("Deposits - 2,000.00", ["Deposits"], "money", null), null);
  check("an attached minus still is one", parse(head("Vanguard\nvanguard.com", "Roth IRA") + "Ending balance $1.00\nMarket value change -$1,234.56", [V]).snapshot.change_in_market_value, -1234.56);
}

console.log("\n18. Audit: rows that share a label");
{
  const V = acct({ id: "v", provider: "Vanguard", type: "roth_ira", label: "Roth" });
  const E = acct({ id: "e", provider: "Empower", type: "401k", label: "Empower" });
  const base = "Vanguard\nvanguard.com\nRoth IRA\nStatement Period: 07/01/2026 - 07/31/2026\nBeginning balance $10,000.00\nEnding balance $10,100.00\n";
  const snap = (t, a = [V]) => parse(t, a).snapshot;
  check("'Fixed Income' in the asset mix isn't income", snap(base + "Asset mix\nFixed Income $4,000.00").income, undefined);
  check("'Capital gain distributions' aren't withdrawals", snap(base + "Capital gain distributions $55.00").withdrawals, undefined);
  check("'Unrealized Gain/Loss' on holdings isn't the period's change", snap(base + "Investment earnings $100.00\nHoldings\nUnrealized Gain/Loss $1,100.00").change_in_market_value, 100);
  const e = "Empower\nempower.com\n401(k) plan\nStatement Period: 07/01/2026 - 07/31/2026\nEnding Balance $64,620.44\n";
  check("before-tax and profit sharing lines aren't the total", snap(e + "Before-Tax Contributions $2,400.00\nProfit Sharing Contributions $1,200.00", [E]).contributions, undefined);
  check("but a total line still is", snap(e + "Before-Tax Contributions $2,400.00\nTotal Contributions $3,600.00", [E]).contributions, 3600);
}

console.log("\n19. Audit: periods and dates");
{
  const V = acct({ id: "r", provider: "Vanguard", type: "roth_ira", label: "Roth", cadence: "quarterly" });
  let r = parse("Vanguard\nvanguard.com\nRoth IRA\nYear-to-date (01/01/2026 - 06/30/2026)\nApril 1, 2026, through June 30, 2026\nEnding balance $48,210.55", [V]);
  check("a year-to-date range isn't the period", [r.snapshot.statement_start, r.snapshot.statement_end], ["2026-04-01", "2026-06-30"]);
  check("a quarter beats a longer range printed first", H.pfFindPeriodWide("01/01/2026 - 06/30/2026\n04/01/2026 - 06/30/2026").start, "2026-04-01");
  check("a range introduced as year-to-date is skipped, however short", H.pfFindPeriodWide("YTD 06/01/2026 - 06/30/2026\nJuly 1, 2026 through July 31, 2026"), { start: "2026-07-01", end: "2026-07-31" });
  check("an annual statement still reads as a year", H.pfFindPeriodWide("Statement Period: 01/01/2025 - 12/31/2025"), { start: "2025-01-01", end: "2025-12-31" });
  r = parse("Vanguard\nvanguard.com\nRoth IRA\nEnding balance $48,210.55", [V]);
  check("no dates at all: never saved on the month picked, and says so", [r.autoSave, r.review.includes("The statement shows no dates, so check the period below.")], [false, true]);
  check("Fidelity's HSA detail (no dates, by design) still saves on the month picked", parse(FX.fidelityHsa, LEGACY).autoSave, true);
}

console.log("\n20. Audit: account numbers");
{
  check("a balance after the account number isn't part of it", H.pfAccountTails("Account Number: XXXX-5678 12,345.67"), ["5678"]);
  check("nor a page count", H.pfAccountTails("Account Number: XXXX-5678 2 of 4"), ["5678"]);
  check("masked groups are joined", H.pfAccountTails("Account number **** **** 5678"), ["5678"]);
  check("a linked bank account isn't this account", H.pfAccountTails("Account number XXXX-5678\nContributions from bank account ending in 4321"), ["5678"]);
  const RH = acct({ id: "rh", provider: "Vanguard", type: "roth_ira", label: "Roth", account_hint: "5678" });
  const r = parse(FX.vanguardRoth.replace("Account number: XXXX-5678", "Account number: XXXX-5678 2 of 4"), [RH]);
  check("so the saved last 4 still match, and it saves", [r.autoSave, r.review], [true, []]);
}

console.log("\n21. Audit: saving from the review");
{
  const app = makeApp({ [F.portfolioAccounts]: [], [F.portfolioSnapshots]: [] });
  const p = makePlugin(app);
  let opened = 0;
  let pending = null;
  const orig = H.PortfolioAccountModal.prototype.open;
  H.PortfolioAccountModal.prototype.open = function () { opened++; pending = this; };
  const s = importModal(app, p);
  await s.paste(FX.schwabOne);
  await press("Save snapshot");
  await tick();
  await press("Save snapshot");
  await tick();
  check("pressing Save twice opens one account form", opened, 1);
  pending.onClose();
  await press("Save snapshot");
  await tick();
  check("closing it without saving lets Save work again", opened, 2);
  H.PortfolioAccountModal.prototype.open = orig;

  // The account chosen is deleted while the review is open.
  const app2 = makeApp({ [F.portfolioAccounts]: [acct({ id: "he", provider: "HealthEquity", type: "hsa", label: "HSA" })], [F.portfolioSnapshots]: [] });
  const p2 = makePlugin(app2);
  const s2 = importModal(app2, p2);
  await s2.paste(FX.genericHsa);
  await p2.deletePortfolioAccount(acct({ id: "he", label: "HSA" }));
  global.__notices = [];
  await press("Save snapshot");
  await tick();
  check("an account deleted meanwhile isn't saved to", [readFile(app2, F.portfolioSnapshots), global.__notices.pop()], [[], "That account is gone. Choose another one."]);

  // Two forms open at once can't make two accounts of one name.
  const app3 = makeApp({ [F.portfolioAccounts]: [] });
  const p3 = makePlugin(app3);
  const forms = [];
  H.PortfolioAccountModal.prototype.open = function () { forms.push(this); };
  await p3.promptPortfolioAccount(null, null);
  await p3.promptPortfolioAccount(null, null);
  const a = H.pfAccountFromForm({ provider: "Vanguard", type: "ira", label: "IRA" });
  const b = H.pfAccountFromForm({ provider: "Vanguard", type: "ira", label: "ira" });
  await forms[0].onSubmit(a);
  global.__notices = [];
  await forms[1].onSubmit(b);
  check("the second of two open forms with one name is refused at save", [readFile(app3, F.portfolioAccounts).length, global.__notices.pop()], [1, "There's already an account called IRA. Nothing was saved."]);
  H.PortfolioAccountModal.prototype.open = orig;
}

// ===========================================================================
console.log("\n22. Second audit: what the first round's fixes broke");
{
  const FI = acct({ id: "fi", provider: "Fidelity", type: "ira", label: "Fidelity IRA" });
  const accts = [...LEGACY.map(acct), FI];
  const promo = FX.fidelity401k + "\nConsolidate your retirement savings: roll old workplace plans into a Fidelity Rollover IRA.";
  let r = parse(promo, accts);
  check("a 401(k) statement with a Rollover IRA ad stays the 401(k), exactly as before", [r.profileId, r.account.id, r.autoSave, r.snapshot], ["fidelity_401k", "fidelity_401k", true, OLD.parsePortfolioStatement(promo, "2026-08").snapshot]);
  const unnamed = FX.fidelity401k.replace("ACME CORPORATION 401(K) PLAN", "ACME CORPORATION SAVINGS PLAN") + "\nYou may be able to roll this balance into an IRA.";
  check("a plan not named 401(k) that mentions an IRA still reads as Fidelity's 401(k)", [parse(unnamed, accts).profileId, parse(unnamed, accts).account.id], ["fidelity_401k", "fidelity_401k"]);
  check("'Rollover IRA' is one mention of an IRA", H.pfDetectType("Rollover IRA\n401(k)\n401(k)").type, "401k");

  const V = acct({ id: "v", provider: "Vanguard", type: "brokerage", label: "Brokerage" });
  const base = "Vanguard\nvanguard.com\nIndividual brokerage account\nStatement Period: 07/01/2026 - 07/31/2026\nBeginning balance $10,000.00\nEnding balance $8,765.44\n";
  const snap = (t, a = [V]) => parse(t, a).snapshot;
  check("a hyphen standing apart from its number isn't read as 0", snap(base + "Market value change - $1,234.56").change_in_market_value, undefined);
  check("…nor with no $", snap(base + "Market value change - 1,234.56").change_in_market_value, undefined);
  check("a long dash after a label is still 'none'", snap(base + "Deposits — 2,000.00").contributions, 0);
  check("a long dash between dates isn't a zero", snap(base + "Market value change 04/01/2026 – 06/30/2026 $1,146.05").change_in_market_value, undefined);
  check("nor is one inside words", snap(base.replace("Individual brokerage account", "401(k) plan") + "Pre – Tax Contributions $400.00", [acct({ id: "v", provider: "Vanguard", type: "401k" })]).contributions, undefined);
  check("pfNilDashes only touches a dash after a word", H.pfNilDashes("Deposits — 2,000.00\n04/01/2026 – 06/30/2026\nFees —\nPre – Tax"), "Deposits  0  2,000.00\n04/01/2026 – 06/30/2026\nFees  0 \nPre – Tax");

  const E = acct({ id: "e", provider: "Empower", type: "401k", label: "E" });
  const eb = "Empower\nempower.com\nACME 401(k) Plan\nStatement Period: 07/01/2026 - 07/31/2026\n";
  check("a label with words before it and its one value below still reads", snap(eb + "Summary: Ending Balance\n$64,620.44\nEmployee Deferral Ending Balance $43,400.00", [E]).ending_value, 64620.44);
  check("…as does 'Your Ending Balance' over its figure", snap(eb + "Your Ending Balance\n$64,620.44", [E]).ending_value, 64620.44);
  check("one source's ending balance is never the account's", snap(eb + "Employee Deferral Ending Balance $43,400.00", [E]).ending_value, undefined);
  check("a figure reached past a year-to-date heading isn't this period's", snap(eb + "Ending Balance $1,000.00\nPersonal Rate of Return\nYear-to-Date 7.10%\nThis Period (0.85%)", [E]).personal_rate_of_return, undefined);

  const annual = "Vanguard\nvanguard.com\nIndividual brokerage account\nAnnual Statement\nJanuary 1, 2026, through December 31, 2026\nFourth quarter 10/01/2026 - 12/31/2026 Year-to-date 01/01/2026 - 12/31/2026\nBeginning balance $10,000.00\nEnding balance $11,000.00";
  check("an annual statement isn't filed as its fourth quarter", [snap(annual).statement_start, snap(annual).statement_end], ["2026-01-01", "2026-12-31"]);
  check("a range labelled as the statement's period wins wherever it is", H.pfFindPeriodWide("Fourth quarter 10/01/2026 - 12/31/2026\nStatement Period: 01/01/2026 - 12/31/2026"), { start: "2026-01-01", end: "2026-12-31" });

  check("'Health Savings Account Number' is this account's number", H.pfAccountTails("Health Savings Account Number: XXXX9911"), ["9911"]);
  check("…and 'Retirement Savings Account #'", H.pfAccountTails("Retirement Savings Account #12345678"), ["5678"]);
  check("but a savings account at a bank isn't", H.pfAccountTails("Account number XXXX9911\nFunded from savings account ending in 4321"), ["9911"]);
  check("spaced digit groups are one number", H.pfAccountTails("Account Number: 6789 1234"), ["1234"]);
  const A = acct({ id: "a", provider: "HealthEquity", type: "hsa", label: "Mine", account_hint: "9911" });
  const B = acct({ id: "b", provider: "HealthEquity", type: "hsa", label: "Spouse", account_hint: "2222" });
  check("two HSAs at one company are told apart by the last 4", parse(FX.genericHsa.replace("Account ending in 9911", "Health Savings Account Number: XXXX9911"), [A, B]).account.id, "a");
}

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
})().catch((e) => { console.error(e); process.exit(1); });
