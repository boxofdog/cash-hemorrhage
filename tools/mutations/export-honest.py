# Mutations for the honest export: what a plan costs a month, income from a few
# paychecks, each paycheck once, subscription notes, partial months, and the
# transfer-free totals.
# Run: python3 tools/mutate.py tools/mutations/export-honest.py
# A mutation whose old text no longer matches reports NOT FOUND: update its text
# to the new code rather than deleting it.

TESTS = ["test-export-health.js", "test-snapshot.js", "test-tx-notes.js", "test-export-manual.js"]

MUTATIONS = [
 ("a plan can cost more than what's left", "monthly: balance > 0 ? round2(Math.min(perMonth, balance)) : 0,", "monthly: balance > 0 ? round2(perMonth) : 0,"),
 ("a plan down to its last payments isn't marked", "capped: balance > 0 && perMonth > balance,", "capped: false,"),
 ("biweekly pay is 2.166 a month", "biweekly: 26 / 12,", "biweekly: 2.166,"),
 ("weekly pay is 4.33 a month", "weekly: 52 / 12,", "weekly: 4.33,"),
 ("paychecks 4 days apart are one", "const PAYCHECK_MATCH_DAYS = 3;", "const PAYCHECK_MATCH_DAYS = 5;"),
 ("paychecks 3 days apart aren't", "if (gap <= PAYCHECK_MATCH_DAYS) pairs.push({ date, i, gap });", "if (gap < PAYCHECK_MATCH_DAYS) pairs.push({ date, i, gap });"),
 ("a deposit goes to the first entry, not the nearest", "pairs.sort((a, b) => a.gap - b.gap || (a.date < b.date ? -1 : a.date > b.date ? 1 : 0) || a.i - b.i);", "pairs.sort((a, b) => (a.date < b.date ? -1 : a.date > b.date ? 1 : 0) || a.i - b.i);"),
 ("repeats aren't counted", "return { rows, duplicates: entries - byDate.size };", "return { rows, duplicates: 0 };"),
 ("oldest paycheck first", "  rows.sort((a, b) => (a.date < b.date ? 1 : a.date > b.date ? -1 : 0));\n  return { rows, duplicates", "  rows.sort((a, b) => (a.date < b.date ? -1 : a.date > b.date ? 1 : 0));\n  return { rows, duplicates"),
 ("any deposit is a paycheck", "(t.resolved_category || \"\") === category)\n    .sort((a, b) => (a.date < b.date ? -1 : a.date > b.date ? 1 : 0));", "true)\n    .sort((a, b) => (a.date < b.date ? -1 : a.date > b.date ? 1 : 0));"),
 ("a deposit is listed even when it matched", "    if (!taken.has(i)) rows.push({ date: t.date, amount: round2(t.amount), source: \"deposit\" });", "    rows.push({ date: t.date, amount: round2(t.amount), source: \"deposit\" });"),
 ("the average takes seven", "const PAYCHECK_AVERAGE_COUNT = 6;", "const PAYCHECK_AVERAGE_COUNT = 7;"),
 ("income is the latest, not the average", "const basis = average ? average.amount : paycheck ? paycheck.amount : null;", "const basis = paycheck ? paycheck.amount : null;"),
 ("the range is the whole history", "high: Math.max(...recent.map((p) => p.amount))", "high: Math.max(...paychecks.map((p) => p.amount))"),
 ("an entry that matched a deposit reads as both", "source: newest.source === \"deposit\" ? \"deposit\" : \"entered\"", "source: newest.source"),
 ("an extra month needs only the usual", ".filter(([, n]) => n > usual)", ".filter(([, n]) => n >= usual)"),
 ("the year ahead is shorter", "const to = toLocalISO(new Date(y, mo + 11, 0));", "const to = toLocalISO(new Date(y, mo + 9, 0));"),
 ("entering a paycheck again adds a line", "const kept = (history || []).filter((p) => !(p && entry && p.date === entry.date));", "const kept = (history || []).slice();"),
 ("Enter Paycheck adds a line each time", "const history = recordPaycheckEntry(await readJSON(this.app, FILES.paycheckHistory, []), { date: periodStartStr, amount: paycheckAmount, alreadyDeposited, nextPaydayStr });", "const history = [...(await readJSON(this.app, FILES.paycheckHistory, [])), { date: periodStartStr, amount: paycheckAmount, alreadyDeposited, nextPaydayStr }];"),
 ("a one-charge subscription isn't noted", "if (s.cadenceSource === \"assumed\") flags.push({ kind: \"one charge\" });", ""),
 ("any credit counts", "t.date >= s.latestDate && (subscriptionGroupKey", "true && (subscriptionGroupKey"),
 ("two charges are enough to call it varying", "if (seen.length >= 3 && Math.max", "if (seen.length >= 2 && Math.max"),
 ("any change in price is varying", "Math.max(...seen) > Math.min(...seen) * 1.5)", "Math.max(...seen) > Math.min(...seen) * 1.0)"),
 ("the flagged share is the whole", "sum(subscriptions.filter((s) => s.flags.length), \"monthly\");", "sum(subscriptions, \"monthly\");"),
 ("a noted subscription is left out of the total", "const subscriptionsMonthly = sum(subscriptions, \"monthly\");", "const subscriptionsMonthly = sum(subscriptions.filter((s) => !s.flags.length), \"monthly\");"),
 ("a month that starts late is whole", "const from = cov.first > start && cov.first <= end ? cov.first : start;", "const from = start;"),
 ("this month is whole", "if (cov.todayStr >= start && cov.todayStr <= end) to =", "if (false) to ="),
 ("this month goes through today", "to = cov.last && cov.last >= start && cov.last < cov.todayStr ? cov.last : cov.todayStr;", "to = cov.todayStr;"),
 ("the last day of the month is treated as over", "if (cov.todayStr >= start && cov.todayStr <= end) to", "if (cov.todayStr >= start && cov.todayStr < end) to"),
 ("split deposits are separate paychecks", "if (total + amount <= byDate.get(date) + 0.005) {", "if (false) {"),
 ("any nearby deposit is folded in", "if (total + amount <= byDate.get(date) + 0.005) {", "if (true) {"),
 ("the transactions export forgets what's a transfer", "buildTransactionNotes(transactions, accounts, { categoryMeta: await readJSON(this.app, FILES.categories, []) });", "buildTransactionNotes(transactions, accounts);"),
 ("transfers count as income", "        if (!own) incomeIn += a;", "        incomeIn += a;"),
 ("transfers count as spending", "        if (!own) spendOut -= a;", "        spendOut -= a;"),
 ("a confirmed pair isn't a transfer", "return (t) => isHiddenTransfer(t, byId) || cats.has(t.resolved_category);", "return (t) => cats.has(t.resolved_category);"),
 ("a transfer category isn't a transfer", "return (t) => isHiddenTransfer(t, byId) || cats.has(t.resolved_category);", "return (t) => isHiddenTransfer(t, byId);"),
 ("cash is as of the newest balance", "const oldest = (dates) => dates.filter(Boolean).sort()[0] || null;", "const oldest = (dates) => dates.filter(Boolean).sort().reverse()[0] || null;"),
 ("a balance exactly a week old is stale", "daysBetween(c.asOf, todayStr) > STALE_BALANCE_DAYS", "daysBetween(c.asOf, todayStr) >= STALE_BALANCE_DAYS"),
 ("old uncategorized rows count", "t.date && t.date > since && t.date <= todayStr && !(t.override_label)", "t.date && t.date <= todayStr && !(t.override_label)"),
 ("labelled rows count as uncategorized", " && !(t.override_label) && (!t.resolved_category", " && (!t.resolved_category"),
 ("a card at its limit is over it", "c.limit != null && c.balance > c.limit", "c.limit != null && c.balance >= c.limit"),
]
