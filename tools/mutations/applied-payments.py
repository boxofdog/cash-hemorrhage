# Mutations for changing applied payments after the fact: moving one to another
# debt, correcting one, taking one back, the list under a debt, and the
# Overview naming the payments it counted.
# Run: python3 tools/mutate.py tools/mutations/applied-payments.py
# A mutation whose old text no longer matches reports NOT FOUND: update its text
# to the new code rather than deleting it.

TESTS = ["test-applied-payments.js", "test-deletes.js", "test-retro-payments.js", "test-loans.js"]

MUTATIONS = [
 ("a plan can move to a loan", "isRevolvingDebt(a) === isRevolvingDebt(b) && isLoan(a) === isLoan(b);", "isRevolvingDebt(a) === isRevolvingDebt(b);"),
 ("a plan can move to a card", "isRevolvingDebt(a) === isRevolvingDebt(b) && isLoan(a) === isLoan(b);", "isLoan(a) === isLoan(b);"),
 ("a move leaves it on the first debt", "  const taken = undoAppliedPayment(from, index, kind);\n  if (!taken.ok)", "  const taken = { ok: true, restoredDue: null };\n  if (!taken.ok)"),
 ("a move never reaches the second", "  const advanced = applyPickedPayments(to, [moved], { extra: !!entry.extra }, kind);", "  const advanced = null;"),
 ("a move forgets the transaction", "const moved = { id: entry.tx_id, amount: entry.amount, date: entry.date };", "const moved = { id: undefined, amount: entry.amount, date: entry.date };"),
 ("a move forgets the amount", "const moved = { id: entry.tx_id, amount: entry.amount, date: entry.date };", "const moved = { id: entry.tx_id, amount: 0, date: entry.date };"),
 ("a move forgets the date", "const moved = { id: entry.tx_id, amount: entry.amount, date: entry.date };", "const moved = { id: entry.tx_id, amount: entry.amount, date: null };"),
 ("a move forgets it was extra", "{ extra: !!entry.extra }, kind);", "{ extra: false }, kind);"),
 ("a payment can be added twice", "if (entry.tx_id && (to.applied_payments || []).some((p) => p && p.tx_id === entry.tx_id)) return", "if (false) return"),
 ("a payment can move onto its own debt", "if (!from || !to || from === to) return { ok: false, why: \"same\" };", "if (!from || !to) return { ok: false, why: \"same\" };"),
 ("a move takes the wrong payment off", "const entry = (from.applied_payments || [])[index];\n  if (!entry) return { ok: false, why: \"missing\" };\n  if (entry.tx_id", "const entry = (from.applied_payments || [])[0];\n  if (!entry) return { ok: false, why: \"missing\" };\n  if (entry.tx_id"),
 ("a correction keeps the minus sign", "round2(Math.abs(Number(changes.amount)))", "round2(Number(changes.amount))"),
 ("a correction can be zero", "if (hasAmount && !(amount > 0)) return", "if (hasAmount && !(amount >= 0)) return"),
 ("a correction takes any date", "if (changes.date != null && !isISODateString(changes.date)) return { ok: false, why: \"date\" };", ""),
 ("a correction ignores the date", "  if (changes.date != null) entry.date = changes.date;\n", ""),
 ("a correction ignores the amount", "  if (hasAmount) entry.amount = amount;\n", ""),
 ("a correction never moves the due date", "  const advanced = advanceDueDateIfCovered(record, kind);\n  if (advanced && !isLoan(record) && !entry.rolled) {", "  const advanced = null;\n  if (advanced && !isLoan(record) && !entry.rolled) {"),
 ("a correction forgets that it moved the date", "    entry.rolled = { from: dueBefore || null, to: advanced };\n", ""),
 ("a plan gets the extra flag", "if (isLoan(record) && \"extra\" in changes) {", "if (\"extra\" in changes) {"),
 ("a loan's flag can't be cleared", "    else delete entry.extra;\n  }\n  const advanced", "  }\n  const advanced"),
 ("a copied debt keeps the shared id", "if (!item.id || seen.has(item.id)) {", "if (!item.id) {"),
 ("every debt gets a new id", "if (!item.id || seen.has(item.id)) {", "if (true) {"),
 ("cards and plans share a file", "    const file = kind === \"cc\" ? FILES.revolvingDebts : FILES.installmentDebts;\n    const list = await readJSON(this.app, file, []);\n    const result = change(list);", "    const file = FILES.installmentDebts;\n    const list = await readJSON(this.app, file, []);\n    const result = change(list);"),
 ("a refused change is saved anyway", "    if (!result || !result.ok) return result || { ok: false };\n    await writeJSON(this.app, file, list);", "    await writeJSON(this.app, file, list);\n    if (!result || !result.ok) return result || { ok: false };"),
 ("a change doesn't refresh the screens", "    await this.snapshotDebt();\n    await this.refreshAfterDataChange();\n    return result;\n  }\n\n  async unapplyPayment", "    return result;\n  }\n\n  async unapplyPayment"),
 ("Unapply takes the first payment", "undoAppliedPayment(list[at], index, kind);\n    });\n    if (r.ok) new Notice(`Took the", "undoAppliedPayment(list[at], 0, kind);\n    });\n    if (r.ok) new Notice(`Took the"),
 ("Move goes the wrong way", "return moveAppliedPayment(from, index, to, kind);", "return moveAppliedPayment(to, index, from, kind);"),
 ("Move names the wrong debt", "toName = debtLabel(to);", "toName = debtLabel(from);"),
 ("Edit changes the first payment", "editAppliedPayment(list[at], index, changes, kind);", "editAppliedPayment(list[at], 0, changes, kind);"),
 ("the Overview counts a payment from the due date's cycle start", "return (d.applied_payments || []).filter((p) => !p.date || !from || p.date > from);", "return (d.applied_payments || []).filter((p) => !p.date || !from || p.date >= from);"),
 ("the Overview names nothing", "const counted = (d._payments || []).filter((p) => p.amount > 0);", "const counted = [];"),
 ("the Overview names a zero payment", "const counted = (d._payments || []).filter((p) => p.amount > 0);", "const counted = (d._payments || []);"),
 ("the Overview names every payment ever", "_payments: cyclePayments(d, dueDateStr, frequency).map(", "_payments: (d.applied_payments || []).map("),
 ("Move to lists every debt", "const others = (ctx.allDebts || []).filter((d) => d && debtKey(d) !== key && sameDebtKind(d, debt));", "const others = (ctx.allDebts || []).filter((d) => d && debtKey(d) !== key);"),
 ("Move to lists the debt itself", "const others = (ctx.allDebts || []).filter((d) => d && debtKey(d) !== key && sameDebtKind(d, debt));", "const others = (ctx.allDebts || []).filter((d) => d && sameDebtKind(d, debt));"),
 ("the link only opens", "this.sectionOpen[appliedKey] = !appliedOpen;", "this.sectionOpen[appliedKey] = true;"),
 ("the link doesn't redraw", "            this.sectionOpen[appliedKey] = !appliedOpen;\n            this.render();", "            this.sectionOpen[appliedKey] = !appliedOpen;"),
 ("Unapply acts on the list's position", "undo.onclick = () => this.plugin.unapplyPayment(key, kind, i);", "undo.onclick = () => this.plugin.unapplyPayment(key, kind, 0);"),
 ("Edit acts on the list's position", "(changes) => this.plugin.editPayment(key, kind, i, changes)", "(changes) => this.plugin.editPayment(key, kind, 0, changes)"),
 ("the list is oldest first", "((b.p.date || \"\") < (a.p.date || \"\") ? -1 : (b.p.date || \"\") > (a.p.date || \"\") ? 1 : b.i - a.i))\n      .forEach(({ p, i }) => {\n        const line", "((a.p.date || \"\") < (b.p.date || \"\") ? -1 : (a.p.date || \"\") > (b.p.date || \"\") ? 1 : a.i - b.i))\n      .forEach(({ p, i }) => {\n        const line"),
 ("a deleted transaction isn't said to be", "p.tx_id ? \"(transaction deleted)\" : \"Typed in\"", "p.tx_id ? \"Typed in\" : \"Typed in\""),
 ("the menu entry does nothing", "run: () => { this.sectionOpen[appliedKey] = true; this.render(); }", "run: () => {}"),
 ("the loan's flag shows on a plan", "    if (this.isLoanDebt) {\n      new Setting(contentEl).setName(\"Extra toward principal\")", "    if (true) {\n      new Setting(contentEl).setName(\"Extra toward principal\")"),
 ("the dialog accepts a zero amount", "          if (!(amount > 0)) {\n            new Notice(\"Amount must be above 0.\");", "          if (false) {\n            new Notice(\"Amount must be above 0.\");"),
]
