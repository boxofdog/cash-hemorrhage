# Mutations for sinking funds: the due dates, the paychecks that fund them, what's
# held back, and how they're paid, undone and followed through SimpleFIN.
# Run: python3 tools/mutate.py tools/mutations/sinking.py
# A mutation whose old text no longer matches reports NOT FOUND: update its text
# to the new code rather than deleting it.

TESTS = ["test-sinking.js", "test-sinking-sync.js", "test-fund.js"]

MUTATIONS = [
 ("due date can be the day itself (after)", "    const due = sinkingDueIn(day, y, mo - 1 + i);\n    if (due > dateStr) return due;", "    const due = sinkingDueIn(day, y, mo - 1 + i);\n    if (due >= dateStr) return due;"),
 ("due date can be the day itself (before)", "    const due = sinkingDueIn(day, y, mo - 1 - i);\n    if (due < dateStr) return due;", "    const due = sinkingDueIn(day, y, mo - 1 - i);\n    if (due <= dateStr) return due;"),
 ("a paycheck on the due date funds it", "paydaysBetween(schedule, addDays(prevDue, -1), addDays(due, -1))", "paydaysBetween(schedule, addDays(prevDue, -1), due)"),
 ("a paycheck on the previous due date doesn't", "paydaysBetween(schedule, addDays(prevDue, -1), addDays(due, -1))", "paydaysBetween(schedule, prevDue, addDays(due, -1))"),
 ("paychecks still to come count as received", "    received = paydays.filter((p) => p <= todayStr).length;", "    received = paydays.length;"),
 ("more checks than the window can have been received", "  if (received > total) received = total;", ""),
 ("savings don't lower the hold", "    hold: round2(Math.max(0, target - saved)),", "    hold: target,"),
 ("savings beyond the bill count", "  const saved = round2(Math.min(amount, Math.max(0, Number(fund.saved_amount) || 0)));", "  const saved = round2(Math.max(0, Number(fund.saved_amount) || 0));"),
 ("a negative balance counts", "  const saved = round2(Math.min(amount, Math.max(0, Number(fund.saved_amount) || 0)));", "  const saved = round2(Math.min(amount, Number(fund.saved_amount) || 0));"),
 ("each check carries the whole bill", "    perCheck: round2(amount / total),", "    perCheck: amount,"),
 ("a schedule with no paychecks in the window is believed", "doesn't know) is as good as none: go by the pay period's length instead.\n  if (paydays && paydays.length) {", "doesn't know) is as good as none: go by the pay period's length instead.\n  if (paydays) {"),
 ("the pay-period fallback rounds up", "    total = Math.max(1, Math.round(daysBetween(prevDue, due) / len));", "    total = Math.max(1, Math.ceil(daysBetween(prevDue, due) / len));"),
 ("the pay-period fallback counts none received", "    received = Math.max(0, Math.floor(daysBetween(prevDue, todayStr) / len) + 1);", "    received = 0;"),
 ("a fund with no day is planned anyway", "if (!(day >= 1 && day <= 31) || !(amount > 0)) return null;", "if (!(amount > 0)) return null;"),
 ("paying doesn't move the fund on", "  fund.paid_through = dueDate;\n  if (!fund.payment_category", "  if (!fund.payment_category"),
 ("paying forgets the link", "  fund.linked_payments.push({\n    tx_id: tx && tx.id ? tx.id : null,", "  fund.linked_payments.push({\n    tx_id: null,"),
 ("undo leaves the due date paid", "  if (gone && gone.paid_for && day >= 1) fund.paid_through = sinkingDueBefore(day, gone.paid_for);", ""),
 ("undo takes the earliest", "if (p && (!list[last] || String(p.paid_for || \"\") >= String(list[last].paid_for || \"\"))) last = i;", "if (p && (!list[last] || String(p.paid_for || \"\") <= String(list[last].paid_for || \"\"))) last = i;"),
 ("it isn't committed", "variableNecessitiesTotal + sinkingHeld;", "variableNecessitiesTotal;"),
 ("a taken-over bill is still due", "!(f.id && replacedBills.has(f.id)) && fixedExpenseDueInRange", "fixedExpenseDueInRange"),
 ("every bill is taken over", "!(f.id && replacedBills.has(f.id)) && fixedExpenseDueInRange", "!f.id && fixedExpenseDueInRange"),
 ("logged contributions are held too", "(isSinkingFund(g) ? [] : g.contributions || [])", "(g.contributions || [])"),
 ("a fund is a regular goal", "return (goals || []).filter((g) => g && !isCappedFund(g) && !isSinkingFund(g));", "return (goals || []).filter((g) => g && !isCappedFund(g));"),
 ("a fund can't follow an account", "  return assignableGoals(goals).filter((g) => g && g.id && g.account_id);", "  return regularGoals(goals).filter((g) => g && g.id && g.account_id);"),
 ("its payment isn't a bill paid", "    (g.linked_payments || []).forEach((p) => settle(p && p.tx_id, \"fixed_expense\", g.id, g.name))", "    (g.linked_payments || []).forEach((p) => settle(p && p.tx_id, \"savings\", g.id, g.name))"),
 ("its category isn't read as a bill", "    if (g.payment_category) fixedClassCategories.set(norm(g.payment_category), g.name);", ""),
 ("recalculate leaves them out", "      sinkingRows: sinkingHolds(goalsForEarmark, {", "      sinkingRows: [].concat(sinkingHolds([], {"),
 ("the inbox can't offer a fund", "const goalsById = new Map(assignableGoals(ctx.savingsGoals).map((g) => [g.id, g]));", "const goalsById = new Map(regularGoals(ctx.savingsGoals).map((g) => [g.id, g]));"),
 ("paid out of savings doesn't come off it", "if (tx && f.account_id && tx.account_id === f.account_id && tx.amount < 0) {", "if (false) {"),
 ("a new fund starts behind", "{ paid_through: sinkingDueBefore(data.due_day_of_month, addDays(today, 1)) }", "{}"),
 ("Paid isn't on the Overview row", "      const paid = li.createEl(\"button\", { text: \"Paid\", cls: \"budget-btn\" });", "      const paid = el(\"div\").createEl(\"button\", { text: \"Paid\", cls: \"budget-btn\" });"),
 ("a fund can be pinned", "      if (!sinkRow) {\n      // Pinning is one goal at a time", "      if (true) {\n      // Pinning is one goal at a time"),
 ("Edit opens the goal dialog", "        if (sinkRow) {\n          this.plugin.promptSinkingFund(g);\n          return;\n        }", ""),
 ("Delete is the goal's", "        if (sinkRow) {\n          this.plugin.confirmDeleteSinkingFund(g);\n          return;\n        }", ""),
 ("a rolling bill can be set aside", "if (!takenBy && f.id && f.due_day_of_month && !isRollingExpense(f)) {", "if (!takenBy && f.id) {"),
 ("deleting keeps its transfers out of the queue's way", "await this.releaseGoalTransfers((g.contributions || []).map((c) => c && c.linked_tx_id), { skip: true });\n        await writeJSON(this.app, FILES.savingsGoals, list.filter((x) => x.id !== g.id));\n        new Notice(`Deleted ${g.name}.`);", "await writeJSON(this.app, FILES.savingsGoals, list.filter((x) => x.id !== g.id));\n        new Notice(`Deleted ${g.name}.`);"),
]
