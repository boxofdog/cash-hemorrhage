# Mutations for the 1.27.0 loan core (loanSchedule, loanState, loanPeriodDues,
# loanPayoff, and the loan UI and file handling). Every one was killed by the
# suite when written, except "_first window (equivalent)", which can't change
# anything observable: installment 0's window start is never read.
#
# Run: python3 tools/mutate.py tools/mutations/loans.py
# When main.js changes, a mutation whose old text no longer matches reports
# NOT FOUND — update its text to the new code rather than deleting it.

TESTS = ["test-loans.js", "test-reconcile.js"]

MUTATIONS = [
 ("escrow skipped", "  const e = Math.min(left, acc.escrow);", "  const e = 0;"),
 ("short payment forgives interest", "  acc.interest -= i;\n  left -= i;", "  acc.interest = 0;\n  left -= i;"),
 ("mortgage accrues daily", 'if (loanMethod(debt) === "monthly") acc.interest', 'if (false) acc.interest'),
 ("escrow not per due", "acc.escrow += loanEscrow(debt) * dues;", "acc.escrow += loanEscrow(debt);"),
 ("accrual from the anchor", "  if (before.length) return before[before.length - 1];", "  return anchorDate;"),
 ("accrual never from funding", "return debt.loan_date && debt.loan_date <= anchorDate ? debt.loan_date : anchorDate;", "return anchorDate;"),
 ("applied_on ignored (state)", ".map((p, i) => p && { i, amount: Math.abs(Number(p.amount) || 0), date: p.date || p.applied_on || null, extra: !!p.extra })", ".map((p, i) => p && { i, amount: Math.abs(Number(p.amount) || 0), date: p.date || null, extra: !!p.extra })"),
 ("extra treated as regular (state)", "const paid = p.extra ? {", "const paid = false ? {"),
 ("extra counted toward installments", ".filter((p) => p && !p.extra && (!debt.coverage_from", ".filter((p) => p && (!debt.coverage_from"),
 ("no early window", "(k === 0 ? \"0000-00-00\" : addDays(due, -LOAN_EARLY_DAYS))", "(k === 0 ? \"0000-00-00\" : addDays(due, -30))"),
 ("_first window (equivalent)", "const opens = dues.map((due, k) => (k === 0 ? \"0000-00-00\"", "const opens = dues.map((due, k) => (k === 0 ? addDays(due, -LOAN_EARLY_DAYS)"),
 ("no pay-ahead", "    for (let j = w + 1; j < dues.length; j++) order.push(j);\n    let left", "    let left"),
 ("no split-first", "    if (split) order.push(w - 1);", ""),
 ("mortgage early not deferred", "out.set(i, due && due > date ? due : date);", "out.set(i, date);"),
 ("accrual start counts extra", "const d = p && !p.extra && (p.date || p.applied_on);", "const d = p && (p.date || p.applied_on);"),
 ("accrual start ignores deferral", "return d && d <= anchorDate ? on.get(i) : null;", "return d && d <= anchorDate ? d : null;"),
 ("history ignored", "  const out = (debt && Array.isArray(debt.due_history) ? debt.due_history : [])", "  const out = ([])"),
 ("history saved wrong", "loan.due_history = (loan.due_history || []).concat([{ first: oldFirst, until: prevDue }]);", ""),
 ("coverage a month early", "loan.coverage_from = addDays(data.due, -LOAN_EARLY_DAYS);", "loan.coverage_from = addDays(addLoanMonths(data.due, -1), -LOAN_EARLY_DAYS);"),
 ("payoff full first", "let amount = part ? round2(part.remaining + Math.max(0, Number(extra) || 0)) : pay;", "let amount = pay;"),
 ("bad date accepted", "  return d && LOAN_DAY_RE.test(d) ? d : null;", "  return d || null;"),
 ("too few installments", "if (k >= enough && due > addLoanMonths(horizon, 1)) break;", "if (due > addLoanMonths(horizon, 1)) break;"),
 ("overdue dropped", "return (overdue ? [overdue] : []).concat(inPer)", "return [].concat(inPer)"),
 ("every overdue kept", "return (overdue ? [overdue] : []).concat(inPer)", "return sched.installments.filter((i) => i.due < startStr && i.remaining > 0.004).concat(inPer)"),
 ("no payoff cap", "const due = round2(Math.min(P, i.covered + Math.max(0, left)));", "const due = P;"),
 ("paid-off still reserves", "  if (!(st.balance > 0.005) && !(st.owedInterest > 0.005) && !(st.owedEscrow > 0.005)) return [];\n  const inPer", "  const inPer"),
 ("first payment not pinned", "if (!debt.first_payment_date && debt.next_due_date) debt.first_payment_date = debt.next_due_date;", ""),
 ("extra never suggested", "  if (P > 0 && Math.abs(sum - P) <= P * 0.1) return false;", "  return false;"),
 ("extra always suggested", "  if (!isLoan(debt) || !(picked || []).length) return false;\n  const P", "  if (!isLoan(debt) || !(picked || []).length) return false;\n  return true;\n  const P"),
 ("currency check gone", "    if (sf.currency && sf.currency !== \"USD\") {", "    if (false) {"),
 ("ambiguous check gone", "    if (ambiguous.includes(loan.simplefin_id)) {", "    if (false) {"),
 ("close leaves category discretionary", "if (payCat && !NON_DISCRETIONARY_PATTERN.test(payCat)) await setCategoryScheduled(this.app, payCat, true);", ""),
 ("reopen leaves label", "        applyCategorization(ledger, await readJSON(this.app, FILES.rules, []));\n        await writeJSON(this.app, FILES.transactions, ledger);\n      }\n    }\n    delete rec.closed;", "      }\n    }\n    delete rec.closed;"),
 ("loans backfilled as BNPL", "d.payment_category = isLoan(d) ? LOAN_TYPES[loanType(d)].category : \"BNPL\";", "d.payment_category = \"BNPL\";"),
 ("stale pick kept", "      if (d.tx && !list.some((t) => t.id === d.tx)) d.tx = null;", ""),
 ("relink date not filled", "if (field === \"applied_payments\" && !entry.date && dates.get(next)) entry.date = dates.get(next);", ""),
 ("apply drops extra flag", "picked.map((p) => Object.assign({ tx_id: p.id, amount: Math.abs(p.amount), date: p.date, applied_on: todayLocal() }, opts.extra ? { extra: true } : {}))\n        );\n        const advanced", "picked.map((p) => Object.assign({ tx_id: p.id, amount: Math.abs(p.amount), date: p.date, applied_on: todayLocal() }, {}))\n        );\n        const advanced"),
 ("balance blur re-anchors", "balanceChanged: !isEdit || round2(balance) !== startBalance,", "balanceChanged: true,"),
]
