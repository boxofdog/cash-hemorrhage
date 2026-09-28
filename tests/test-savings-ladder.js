// 1.20.0 — the Savings Focus ladder: what's gone into a goal this period comes
// off its ask, capped funds come before goals get ahead of schedule, and only a
// goal's own date makes it dated.
global.document = { body: { classList: { contains: () => false } } };
const H = require("./harness.js");

let pass = 0, fail = 0;
function check(name, got, want) {
  const ok = JSON.stringify(got) === JSON.stringify(want);
  if (ok) { pass++; console.log(`  PASS  ${name}`); }
  else { fail++; console.log(`  FAIL  ${name}: got ${JSON.stringify(got)}, want ${JSON.stringify(want)}`); }
}
const T = H.todayLocal();
const D = (n) => H.addDays(T, n);
const START = D(-3), PAYDAY = D(11);

const SAV = { id: "Personal Savings", type: "savings", current_balance: 640.12, balance_as_of: T };
const CHK = { id: "Main Checking", type: "checking", current_balance: 900 };
const ACCOUNTS = [CHK, SAV];
const fund = () => ({ id: "fund-1", kind: "capped", name: "Oopsie Fund", target_amount: 1000, account_id: "Personal Savings", placement: "cards" });
const c = (date, amount, o = {}) => Object.assign({ id: "c" + Math.random(), date, amount, linked_tx_id: null }, o);
const plan = (goals, amount, checks = {}, moves = {}, deadline = null) =>
  H.recommendSavings(goals, amount, checks, T, deadline, ACCOUNTS, {}, moves);
const ids = (r) => r.breakdown.map((b) => [b.id, b.amount]);

(async () => {
// ===========================================================================
console.log("\n1. What's gone into each goal this period");
{
  const goals = [
    { id: "a", name: "Moving", target_amount: 3000, saved_amount: 1000, contributions: [
      c(D(-10), 400),                                  // last period
      c(START, 150),                                   // first day counts
      c(D(2), 100),
      c(D(20), 999),                                   // logged later...
      c(D(4), 50, { linked_tx_id: "t1", linked_tx_date: D(-20) }), // logged this period: counts, whenever it moved
      c(D(-15), 75, { linked_tx_id: "t2", linked_tx_date: D(1) }),  // logged last period: doesn't, even if linked to a transfer now
      c(PAYDAY, 60)                                    // payday is the next period
    ] },
    { id: "b", name: "Knife", target_amount: 200, saved_amount: 0, contributions: [c(D(1), 80), c(D(2), -120)] },
    { id: "z", name: "Nothing", target_amount: 100, saved_amount: 0 },
    fund()
  ];
  const m = H.goalMovesThisPeriod(goals, START, PAYDAY);
  // Dated by when it was logged: that's when saved_amount went up, and the
  // pace is measured from saved_amount at the period's start.
  check("counts what was logged this period, whatever the transfer's date", m.a, 300);
  check("money taken back out this period can't make it negative", m.b, undefined);
  check("goals with nothing in, and capped funds, aren't listed", Object.keys(m).sort(), ["a"]);
  check("no period, no moves", H.goalMovesThisPeriod(goals, null, PAYDAY), {});
}

// ===========================================================================
console.log("\n2. A goal that's had its pace stops asking");
{
  // $2,252 left over 4 paychecks = $563 a period.
  const g = (saved, contribs) => ({ id: "g", name: "Moving", target_amount: 5000, saved_amount: saved, target_date: D(60), contributions: contribs });
  let r = plan([g(2748, [])], 2000, { g: 4 });
  check("nothing in yet: the $563 pace", r.breakdown[0].amount >= 563 && /on pace/.test(r.breakdown[0].reason), true);
  check("…then topped up with the rest, as before", ids(r), [["g", 2000]]);

  // $1,054 moved this period: saved is now 3,802, left 1,198. The period began
  // with 2,252 left, so its pace was 563 — already covered.
  r = plan([g(3802, [])], 1000, { g: 4 }, { g: 1054 });
  check("$1,054 in against a $563 pace: nothing more at pace", r.breakdown.find((b) => /on pace/.test(b.reason)), undefined);
  check("and the whole surplus goes on down the ladder (here, a top-up)", ids(r), [["g", 1000]]);
  check("the top-up says so", r.breakdown[0].reason, "ahead of pace");

  // $200 in: the period began 2,452 short ($613 pace); $413 still to go. Paced
  // on today's remaining instead it would ask (2,252 / 4) - 200 = $363.
  r = plan([{ id: "g", name: "Moving", target_amount: 5000, saved_amount: 2748, target_date: D(60) }], 413, { g: 4 }, { g: 200 });
  check("part of the pace in: the rest of it, measured from the period's start", ids(r), [["g", 413]]);
  check("and the reason says how much is already in", r.breakdown[0].reason, `on pace for ${D(60)} — 4 paychecks left ($200.00 of $613.00 already in this period)`);

  const overdue = { id: "o", name: "Late", target_amount: 1000, saved_amount: 700, target_date: D(-5) };
  r = plan([overdue], 1000, {}, { o: 200 });
  check("overdue: still everything that's left, whatever went in", ids(r), [["o", 300]]);
  check("overdue reason", r.breakdown[0].reason, `past its ${D(-5)} target ($200.00 of $500.00 already in this period)`);
  check("moves for an undated goal don't change it", ids(plan([{ id: "u", name: "Knife", target_amount: 90, saved_amount: 10 }], 500, {}, { u: 10 })), [["u", 80]]);
}

// ===========================================================================
console.log("\n3. The ladder: dated paces, the cushion, top-ups, then undated");
{
  const dated = { id: "d", name: "Moving", target_amount: 3000, saved_amount: 2000, target_date: D(60) }; // $1000 over 4 = 250
  const later = { id: "l", name: "Trip", target_amount: 800, saved_amount: 0, target_date: D(120) };       // $800 over 8 = 100
  const knife = { id: "k", name: "Chef Knife", target_amount: 180, saved_amount: 0 };
  let r = plan([knife, later, dated, fund()], 1000, { d: 4, l: 8 });
  // Paces: d 250, l 100 → 650 left. Fund 64% full takes 36% of 650 = 233.92
  // (capped to the $359.88 of room). 416.08 left: d tops up its other 750 →
  // takes 416.08, l and the knife get nothing more.
  check("soonest pace first, then the next, then the fund's share of what's left", r.breakdown.map((b) => b.id), ["d", "l", "fund-1"]);
  check("amounts", ids(r), [["d", 666.08], ["l", 100], ["fund-1", 233.92]]);
  check("the fund comes before any goal gets ahead of schedule", /then topped up/.test(r.breakdown[0].reason), true);
  check("undated waits for all of it", r.breakdown.some((b) => b.id === "k"), false);

  r = plan([knife, later, dated, fund()], 3000, { d: 4, l: 8 });
  check("enough for everything: undated last", r.breakdown.map((b) => b.id), ["d", "l", "fund-1", "k"]);
  check("the knife's reason", r.breakdown[3].reason, "no deadline — funded after dated goals and funds");
  check("totals add up", r.total, Math.round(r.breakdown.reduce((s, b) => s + b.amount, 0) * 100) / 100);

  // With the pace already met, the fund draws on the whole surplus.
  // Began $1,400 short with $900 of surplus: $350 pace, the fund 36% of the
  // $550 left ($197.93), the goal topped up with the other $352.07. $400 is
  // in, so the goal still has $302.07 of its share to come — as a top-up,
  // after the fund.
  r = plan([dated, fund()], 500, { d: 4 }, { d: 400 });
  check("pace met: the fund first, the rest of the goal's share as a top-up", r.breakdown.map((b) => [b.id, b.amount, b.reason.slice(0, 13)]), [["fund-1", 197.93, "64% full, so "], ["d", 302.07, "ahead of pace"]]);
  check("no goals: the fund alone", ids(plan([fund()], 300)), [["fund-1", 107.96]]);
  check("no surplus: nothing", plan([dated, fund()], 0, { d: 4 }), { breakdown: [], total: 0 });
  check("the fund's period is reported", Object.keys(plan([dated, fund()], 500, { d: 4 }).periods), ["fund-1"]);
}

// ===========================================================================
console.log("\n4. Only a goal's own date makes it dated");
{
  const knife = { id: "k", name: "Chef Knife", target_amount: 180, saved_amount: 0 };
  const fund1 = fund();
  const r = plan([knife, fund1], 500, {}, {}, D(35));
  check("a savings deadline doesn't turn an undated goal into a paced one", r.breakdown.map((b) => [b.id, b.reason.slice(0, 11)]), [["fund-1", "64% full, s"], ["k", "no deadline"]]);

  // The pacing map only counts paychecks for goals with their own date.
  const p = Object.create(H.__PluginClass.prototype);
  p.settings = { savingsMode: true, savingsDeadline: D(35), paySchedule: { cadence: "biweekly", anchor_date: D(-3) } };
  const map = await p.goalPaychecksMap([knife, { id: "d", name: "Dated", target_amount: 100, target_date: D(30) }, fund1], D(-3), []);
  check("paychecks are counted only for goals with their own date", Object.keys(map), ["d"]);
}

// ===========================================================================
console.log("\n5. End to end: runAllocation remembers the period");
{
  const base = {
    cashOnHand: 2000, todayStr: START, nextPaydayStr: PAYDAY, fixedExpenses: [], installmentDebts: [], revolvingDebts: [],
    bufferMode: "manual", manualBuffer: 300, currentDateStr: T, savingsMode: true, accounts: ACCOUNTS
  };
  const goal = (contribs, saved) => ({ id: "g", name: "Moving", target_amount: 5000, saved_amount: saved, target_date: D(60), contributions: contribs });
  let r = H.runAllocation(Object.assign({}, base, { goals: [goal([], 2748), fund()], paychecksFor: { g: 4 } }));
  check("nothing in yet: the goal's pace comes first", [r.savingsBreakdown[0].id, /on pace/.test(r.savingsBreakdown[0].reason)], ["g", true]);
  // $1,054 moved this period (linked to the transfer, so not earmarked again).
  const moved = [c(D(-1), 1054, { linked_tx_id: "t", linked_tx_date: D(-1) })];
  r = H.runAllocation(Object.assign({}, base, { cashOnHand: 2000 - 1054, goals: [goal(moved, 3802), fund()], paychecksFor: { g: 4 } }));
  check("after $1,054 went in: the fund comes first, the goal only gets a top-up",
    [r.savingsBreakdown[0].id, r.savingsBreakdown.find((b) => b.id === "g").reason], ["fund-1", "ahead of pace"]);
  // Last period's contribution doesn't count.
  const old = [c(D(-20), 1054, { linked_tx_id: "t", linked_tx_date: D(-20) })];
  r = H.runAllocation(Object.assign({}, base, { cashOnHand: 2000 - 1054, goals: [goal(old, 3802), fund()], paychecksFor: { g: 4 } }));
  check("a contribution from last period doesn't count toward this one", [r.savingsBreakdown[0].id, /on pace/.test(r.savingsBreakdown[0].reason)], ["g", true]);
  r = H.runAllocation(Object.assign({}, base, { savingsMode: false, goals: [goal(moved, 3802), fund()], paychecksFor: { g: 4 }, revolvingDebts: [] }));
  check("Debt Reduction is unchanged: only the fund", r.savingsBreakdown.map((b) => b.id), ["fund-1"]);
}

// ===========================================================================
console.log("\n6. Audit: following the plan doesn't change it");
{
  const acc = (bal, moved = 0) => [CHK, Object.assign({}, SAV, { current_balance: bal })];
  const goal = (saved) => ({ id: "g", name: "Move", target_amount: 5000, saved_amount: saved, target_date: D(60) });
  const f = fund();
  const rs = (goals, avail, accounts, gm = {}, fm = {}) =>
    H.recommendSavings(goals, avail, { g: 4 }, T, null, accounts, { moves: fm, todayStr: T }, gm);
  let r = rs([goal(1000), f], 2000, acc(200));
  check("before: the goal's pace, the fund's share, the goal's top-up", ids(r), [["g", 1200], ["fund-1", 800]]);
  r = rs([goal(2200), f], 800, acc(200), { g: 1200 });
  check("after moving the goal's $1,200: just the fund's $800, unchanged", ids(r), [["fund-1", 800]]);
  const u = (saved) => ({ id: "u", name: "Knife", target_amount: 200 + 0, saved_amount: saved });
  r = rs([u(0), f], 1000, acc(200));
  check("undated: before", ids(r), [["fund-1", 800], ["u", 200]]);
  r = rs([u(200), f], 800, acc(200), { u: 200 });
  check("undated: after moving its $200, the fund's ask is unchanged", ids(r), [["fund-1", 800]]);
  r = rs([goal(1000), f], 1200, acc(1000), {}, { "fund-1": 800 });
  check("after moving the fund's $800: just the goal's $1,200", ids(r), [["g", 1200]]);

  // Linking last period's contribution to a transfer made this period.
  const g2 = { id: "g2", name: "Trip", target_amount: 2000, saved_amount: 1000, target_date: D(60),
    contributions: [{ id: "x", date: D(-12), amount: 500, linked_tx_id: null }] };
  const before = H.goalMovesThisPeriod([g2], START, PAYDAY);
  g2.contributions[0].linked_tx_id = "t";
  g2.contributions[0].linked_tx_date = D(1);
  check("linking last period's contribution doesn't make it this period's", [before, H.goalMovesThisPeriod([g2], START, PAYDAY)], [{}, {}]);

  // More moved into a goal than its share can't be spent again elsewhere.
  r = rs([goal(4000), u(0), f], 300, acc(200), { g: 3000 });
  check("never more asked than there is", r.total <= 300, true);
}

console.log("\n7. Property: follow the plan, plan again");
{
  let seed = 12345;
  const rnd = () => ((seed = (seed * 1103515245 + 12345) % 2147483648) / 2147483648);
  const pick = (a) => a[Math.floor(rnd() * a.length)];
  let stable = 0, partial = 0, conserved = 0;
  const N = 300;
  for (let i = 0; i < N; i++) {
    const nGoals = 1 + Math.floor(rnd() * 3);
    const goals = [];
    const checks = {};
    for (let k = 0; k < nGoals; k++) {
      const target = 200 + Math.round(rnd() * 5000);
      const saved = Math.round(rnd() * target * 0.8);
      const dated = rnd() < 0.6;
      const g = { id: "g" + k, name: "G" + k, target_amount: target, saved_amount: saved };
      if (dated) { g.target_date = D(pick([-5, 20, 45, 90, 200])); checks[g.id] = pick([0, 1, 2, 4, 8]); }
      goals.push(g);
    }
    const withFund = rnd() < 0.7;
    const bal = Math.round(rnd() * 900);
    if (withFund) goals.push(fund());
    const accounts = [CHK, Object.assign({}, SAV, { current_balance: bal })];
    const avail = Math.round(rnd() * 3000);
    const plan0 = H.recommendSavings(goals, avail, checks, T, null, accounts, { moves: {}, todayStr: T }, {});
    if (plan0.total <= avail + 0.01) conserved++;
    // Follow every ask.
    const follow = (plan, only) => {
      const g2 = JSON.parse(JSON.stringify(goals));
      const gm = {}, fm = {};
      let bal2 = bal, left = avail;
      plan.breakdown.forEach((b, idx) => {
        if (only != null && idx !== only) return;
        left = Math.round((left - b.amount) * 100) / 100;
        if (b.fund) { bal2 += b.amount; fm[b.id] = b.amount; }
        else { const g = g2.find((x) => x.id === b.id); g.saved_amount = Math.round((g.saved_amount + b.amount) * 100) / 100; gm[b.id] = b.amount; }
      });
      const acc2 = [CHK, Object.assign({}, SAV, { current_balance: Math.round(bal2 * 100) / 100 })];
      return H.recommendSavings(g2, left, checks, T, null, acc2, { moves: fm, todayStr: T }, gm);
    };
    const after = follow(plan0);
    if (after.breakdown.every((b) => b.amount <= 0.05)) stable++;
    else if (i < 3 || stable < 5) console.log("    unstable:", JSON.stringify(plan0.breakdown.map((b) => [b.id, b.amount])), "→", JSON.stringify(after.breakdown.map((b) => [b.id, b.amount])));
    // Follow only the first ask: the rest of the plan stays as it was.
    if (!plan0.breakdown.length) { partial++; continue; }
    const rest = follow(plan0, 0);
    const want = plan0.breakdown.slice(1).map((b) => [b.id, b.amount]);
    const got = rest.breakdown.filter((b) => b.amount > 0.05).map((b) => [b.id, b.amount]);
    const close = want.length === got.length && want.every((w, j) => w[0] === got[j][0] && Math.abs(w[1] - got[j][1]) <= 0.05);
    if (close) partial++;
    else if (partial > i - 3) console.log("    partial:", JSON.stringify(want), "→", JSON.stringify(got));
  }
  check(`never asks for more than the surplus (${N} random plans)`, conserved, N);
  check(`following the whole plan leaves nothing more to ask (${N} random plans)`, stable, N);
  check(`following the first ask leaves the rest of the plan as it was (${N} random plans)`, partial, N);
}

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
})().catch((e) => { console.error(e); process.exit(1); });
