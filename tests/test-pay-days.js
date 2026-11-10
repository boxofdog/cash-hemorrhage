// Twice a month on any two days (10th and 25th, not just the 1st and 15th).
const H = require("./harness.js");
const { el, allText, SettingStub } = H;

let pass = 0, fail = 0;
function check(name, got, want) {
  const ok = JSON.stringify(got) === JSON.stringify(want);
  if (ok) { pass++; console.log(`  PASS  ${name}`); }
  else { fail++; console.log(`  FAIL  ${name}: got ${JSON.stringify(got)}, want ${JSON.stringify(want)}`); }
}
const S = (days) => Object.assign({ cadence: "semimonthly", anchor_date: "2026-01-10" }, days ? { days } : {});

console.log("\n1. The next payday and the period's start");
check("10th and 25th: from the 1st, the 10th", H.nextPaydayFrom(S([10, 25]), "2026-10-01"), "2026-10-10");
check("strictly after: on the 10th, the 25th", H.nextPaydayFrom(S([10, 25]), "2026-10-10"), "2026-10-25");
check("after the 25th, the 10th of next month", H.nextPaydayFrom(S([10, 25]), "2026-10-25"), "2026-11-10");
check("across the new year", H.nextPaydayFrom(S([10, 25]), "2026-12-26"), "2027-01-10");
check("the order they were typed doesn't matter", H.nextPaydayFrom(S([25, 10]), "2026-10-01"), "2026-10-10");
check("the period began on the last payday: mid-period", H.currentPeriodStart(S([10, 25]), "2026-10-15"), "2026-10-10");
check("on a payday, it began that day", H.currentPeriodStart(S([10, 25]), "2026-10-25"), "2026-10-25");
check("before the first payday of the month, it began last month's second", H.currentPeriodStart(S([10, 25]), "2026-10-03"), "2026-09-25");
check("early January reaches back into December", H.currentPeriodStart(S([10, 25]), "2027-01-05"), "2026-12-25");

console.log("\n2. Schedules saved before this setting");
check("no days: the 1st and 15th, as before", [H.nextPaydayFrom(S(), "2026-10-01"), H.nextPaydayFrom(S(), "2026-10-15"), H.nextPaydayFrom(S(), "2026-10-20")], ["2026-10-15", "2026-11-01", "2026-11-01"]);
check("the period start is unchanged too", [H.currentPeriodStart(S(), "2026-10-20"), H.currentPeriodStart(S(), "2026-10-05")], ["2026-10-15", "2026-10-01"]);
check("nonsense days fall back to the 1st and 15th", [H.semimonthlyDays(S([0, 40])), H.semimonthlyDays(S([5])), H.semimonthlyDays(S([5, 5])), H.semimonthlyDays(S(["x", "y"]))], [[1, 15], [1, 15], [1, 15], [1, 15]]);

console.log("\n3. Short months");
check("the 30th is February's last day", H.nextPaydayFrom(S([15, 30]), "2027-02-16"), "2027-02-28");
check("and a leap February's", H.nextPaydayFrom(S([15, 30]), "2028-02-16"), "2028-02-29");
check("the 31st in a 30-day month", H.nextPaydayFrom(S([15, 31]), "2026-11-16"), "2026-11-30");
check("a month with the day keeps it", H.nextPaydayFrom(S([15, 30]), "2026-10-16"), "2026-10-30");

console.log("\n4. Counting paychecks before a goal date");
check("10th and 25th between Oct 1 and Nov 30: four", H.paydaysBetween(S([10, 25]), "2026-10-01", "2026-11-30"), ["2026-10-10", "2026-10-25", "2026-11-10", "2026-11-25"]);
check("goal pace counts them", H.goalPace({ target_date: "2026-11-30", target_amount: 400, saved_amount: 0 }, "2026-10-01", 15, S([10, 25])).paychecks, 4);

console.log("\n5. Wording");
check("it names the days", [H.payCadenceLabel(S([10, 25])), H.payCadenceLabel(S()), H.payCadenceLabel({ cadence: "biweekly" })], ["twice a month (10th & 25th)", "twice a month (1st & 15th)", "every 2 weeks"]);
check("days typed out of order are read in order", [H.semimonthlyDays(S([25, 10])), H.payCadenceLabel(S([25, 10]))], [[10, 25], "twice a month (10th & 25th)"]);
check("ordinals", [1, 2, 3, 4, 11, 12, 13, 21, 22, 23, 30, 31].map(H.dayOrdinal), ["1st", "2nd", "3rd", "4th", "11th", "12th", "13th", "21st", "22nd", "23rd", "30th", "31st"]);

console.log("\n6. Detecting it");
const pays = (dates) => dates.map((d, i) => ({ id: `p${i}`, date: d, amount: 1500, resolved_category: "Paycheck" }));
const d1 = H.detectPaySchedule(pays(["2026-08-10", "2026-08-25", "2026-09-10", "2026-09-25", "2026-10-10"]));
check("paychecks on the 10th and 25th are read as those days", [d1.cadence, d1.days], ["semimonthly", [10, 25]]);
const d2 = H.detectPaySchedule(pays(["2026-08-01", "2026-08-15", "2026-09-01", "2026-09-15"]));
check("the 1st and 15th too", [d2.cadence, d2.days], ["semimonthly", [1, 15]]);
const d3 = H.detectPaySchedule(pays(["2026-08-07", "2026-08-21", "2026-09-04", "2026-09-18"]));
check("every 14 days is still every two weeks, with no days", [d3.cadence, d3.days], ["biweekly", null]);
check("a detected schedule carries the days into use", H.resolvePaySchedule({}, pays(["2026-08-10", "2026-08-25", "2026-09-10", "2026-09-25"])).days, [10, 25]);
check("a saved schedule wins over detection", H.resolvePaySchedule({ paySchedule: S([5, 20]) }, pays(["2026-08-10", "2026-08-25", "2026-09-10", "2026-09-25"])).days, [5, 20]);

console.log("\n7. The setting");
(async () => {
  const written = [];
  const app = { vault: { adapter: { exists: async () => false, read: async () => "{}", write: async (p, d) => written.push(d) } } };
  const notices = (global.__notices = []);
  const mk = (paySchedule) => {
    const tab = Object.create(H.BudgetSettingTab.prototype);
    tab.app = app;
    tab.plugin = { settings: { paySchedule }, refreshDashboard() {} };
    tab.display = () => {};
    return tab;
  };
  const run = async (paySchedule) => {
    SettingStub.texts = []; SettingStub.dropdowns = []; SettingStub.buttons = [];
    const tab = mk(paySchedule);
    const root = el("div");
    await tab.renderPayScheduleSettings(root);
    return { tab, root };
  };
  let r = await run(S([10, 25]));
  const names = (root) => allText(root).replace(/\s+/g, " ");
  check("twice a month shows the two days, not a known payday", [names(r.root).includes("Paydays each month"), names(r.root).includes("A known payday")], [true, false]);
  check("the inputs hold the saved days", SettingStub.texts.map((t) => t.inputEl.value), ["10", "25"]);
  check("and the next paydays use them", /Next paydays: \d{4}-\d{2}-(10|25)/.test(names(r.root)), true);
  const typeDays = async (a, b) => {
    const [ta, tb] = SettingStub.texts;
    ta.inputEl.value = a; ta.inputEl.dispatchEvent({ type: "input" });
    tb.inputEl.value = b; tb.inputEl.dispatchEvent({ type: "input" });
    notices.length = 0;
    ta.inputEl.dispatchEvent({ type: "change" });
    await new Promise((res) => setTimeout(res, 5));
  };
  await typeDays("5", "20");
  check("typing two days saves them, in order, and says so", [r.tab.plugin.settings.paySchedule.days, r.tab.plugin.settings.paySchedule.cadence, notices.pop()], [[5, 20], "semimonthly", "Pay schedule saved: twice a month (5th & 20th)."]);
  await typeDays("20", "5");
  check("typed the other way round, still in order", r.tab.plugin.settings.paySchedule.days, [5, 20]);
  const before = JSON.stringify(r.tab.plugin.settings.paySchedule);
  await typeDays("0", "20");
  check("a day outside 1 to 31 is refused and nothing changes", [notices.pop(), JSON.stringify(r.tab.plugin.settings.paySchedule)], ["Enter two days from 1 to 31.", before]);
  await typeDays("12", "12");
  check("the same day twice is refused", [notices.pop(), JSON.stringify(r.tab.plugin.settings.paySchedule)], ["Enter two different days.", before]);
  await typeDays("", "20");
  check("a blank is refused", notices.pop(), "Enter two days from 1 to 31.");
  r = await run(S());
  check("a schedule with no days shows the 1st and 15th", SettingStub.texts.map((t) => t.inputEl.value), ["1", "15"]);
  r = await run({ cadence: "biweekly", anchor_date: "2026-09-04" });
  check("other cadences keep the known-payday field", [names(r.root).includes("A known payday"), names(r.root).includes("Paydays each month")], [true, false]);
  // Saving a payday while on another cadence keeps the twice-a-month days for when you switch back.
  r = await run({ cadence: "biweekly", anchor_date: "2026-09-04", days: [10, 25] });
  const anchorBox = SettingStub.texts[0];
  anchorBox.inputEl.value = "2026-09-18";
  anchorBox.inputEl.dispatchEvent({ type: "change" });
  await new Promise((res) => setTimeout(res, 5));
  check("changing the known payday keeps the saved days", [r.tab.plugin.settings.paySchedule.anchor_date, r.tab.plugin.settings.paySchedule.days], ["2026-09-18", [10, 25]]);
  r = await run(null);
  check("no schedule yet: the usual fields", names(r.root).includes("A known payday"), true);

  console.log(`\n${pass} passed, ${fail} failed`);
  process.exit(fail ? 1 : 0);
})().catch((e) => { console.error(e); process.exit(1); });
