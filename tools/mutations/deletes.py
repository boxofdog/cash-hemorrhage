# Mutations for deleting a transaction, taking a payment back off a debt, and
# removing saved balances, targets and closed loans.
# Run: python3 tools/mutate.py tools/mutations/deletes.py
# A mutation whose old text no longer matches reports NOT FOUND: update its text
# to the new code rather than deleting it.

TESTS = ["test-deletes.js"]

MUTATIONS = [
 ("sync id not remembered", "if (tx && tx.simplefin_id && tx.simplefin_account) keys.push(", "if (false) keys.push("),
 ("row text not remembered", "  if (tx) keys.push(`tx:${tx.date", "  if (false) keys.push(`tx:${tx.date"),
 ("nothing is skipped", "const kept = (rows || []).filter((t) => !transactionDeleteKeys(t).some((k) => gone.has(k)));", "const kept = (rows || []);"),
 ("dropped not counted", "return { kept, dropped: (rows || []).length - kept.length };", "return { kept, dropped: 0 };"),
 ("debt links ignored", "if (d && (d.applied_payments || []).some((p) => p && p.tx_id === txId)) out.push", "if (false) out.push"),
 ("bill links ignored", "if (f && (f.linked_payments || []).some((p) => p && p.tx_id === txId)) out.push", "if (false) out.push"),
 ("goal links ignored", "if (g && (g.contributions || []).some((c) => c && c.linked_tx_id === txId)) out.push", "if (false) out.push"),
 ("transfer partner left pointing", "      const copy = Object.assign({}, t);\n      delete copy.transfer_pair;\n      return copy;", "      return t;"),
 ("wrong row removed", "    .filter((t) => t !== gone)", "    .filter((t) => t === gone)"),
 ("delete ignores links", "    if (links.length) return { ok: false, reason: `Counted toward", "    if (false) return { ok: false, reason: `Counted toward"),
 ("bank row not remembered", "    if (!r.removed.manual) {\n      const deleted", "    if (false) {\n      const deleted"),
 ("typed row remembered too", "    if (!r.removed.manual) {\n      const deleted", "    if (true) {\n      const deleted"),
 ("confirm skipped for a counted row", "    if (links.length) {\n      new Notice(`Counted toward", "    if (false) {\n      new Notice(`Counted toward"),
 ("apply doesn't remember the move", "    last.rolled = { from: dueBefore || null, to: advanced };", "    last.rolled = undefined;"),
 ("undo forgets the count", "      if (typeof entry.rolled.remaining === \"number\") record.remaining_installments = entry.rolled.remaining;", ""),
 ("undo overwrites a changed date", "    if (entry.rolled.from && current === entry.rolled.to) {", "    if (entry.rolled.from) {"),
 ("undo takes the wrong payment", "  record.applied_payments = list.filter((_, i) => i !== index);", "  record.applied_payments = list.filter((_, i) => i === index);"),
 ("loan due date not recomputed", "    restoredDue = advanceDueDateIfCovered(record, kind);\n  } else if (entry.rolled) {", "    restoredDue = null;\n  } else if (entry.rolled) {"),
 ("card due date not restored", "      if (isCC) record.due_date = entry.rolled.from;\n      else record.next_due_date = entry.rolled.from;", "      if (isCC) record.due_date = record.due_date;\n      else record.next_due_date = entry.rolled.from;"),
 ("snapshot removal too wide", "(s && s.account_id === accountId && s.statement_end === statementEnd)", "(s && s.statement_end === statementEnd)"),
 ("snapshot removal too narrow", "(s && s.account_id === accountId && s.statement_end === statementEnd)", "(s && s.account_id === accountId)"),
 ("search offers money in", "t.amount < 0 && !skip.has(t.id))", "!skip.has(t.id))"),
 ("search offers applied rows", "!skip.has(t.id))\n    .filter((t) => !livePairPartner", "true)\n    .filter((t) => !livePairPartner"),
 ("search ignores the balance date", ".filter((t) => !notBefore || !t.date || t.date >= notBefore)", ""),
 ("search matches only the merchant", "return text.includes(q) || (!!amountQ && Math.abs(t.amount).toFixed(2).includes(amountQ));", "return text.includes(q);"),
 ("search offers a row another bill counts", "          if (settled) {\n            row.createSpan({ text: `counts toward", "          if (false) {\n            row.createSpan({ text: `counts toward"),
 ("removing a target removes more", "    else delete cats[i].monthly_target;", "    else cats.splice(i, 1);"),
 ("closed loan delete takes all", "closed.filter((d) => !(d && d.id === rec.id))", "[]"),
 ("clear schedule does nothing", "            this.plugin.settings.paySchedule = null;\n            await writeJSON(this.app, FILES.settings, this.plugin.settings);\n            new Notice(\"Pay schedule cleared.\");\n            this.plugin.refreshDashboard();\n            this.display();\n          })\n        );\n    }", "            new Notice(\"Pay schedule cleared.\");\n          })\n        );\n    }"),
]
