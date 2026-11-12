# Mutations for applying a payment made before a debt's balance was set.
# Run: python3 tools/mutate.py tools/mutations/retro-payments.py
# A mutation whose old text no longer matches reports NOT FOUND: update its text
# to the new code rather than deleting it.

TESTS = ["test-retro-payments.js", "test-deletes.js"]

MUTATIONS = [
 ("plan takes earlier payments off again", "    .filter((p) => p && (!anchorDate || !p.date || p.date >= anchorDate))\n    .reduce((s, p) => s + Math.abs(p.amount), 0);", "    .filter((p) => p)\n    .reduce((s, p) => s + Math.abs(p.amount), 0);"),
 ("plan ignores the anchor day's payment", "(!anchorDate || !p.date || p.date >= anchorDate))\n    .reduce((s, p) => s + Math.abs(p.amount), 0);", "(!anchorDate || !p.date || p.date > anchorDate))\n    .reduce((s, p) => s + Math.abs(p.amount), 0);"),
 ("plan ignores undated holds", "(!anchorDate || !p.date || p.date >= anchorDate))\n    .reduce((s, p) => s + Math.abs(p.amount), 0);", "(!anchorDate || (!!p.date && p.date >= anchorDate)))\n    .reduce((s, p) => s + Math.abs(p.amount), 0);"),
 ("preview balance counts it twice", "        : debtBalance(Object.assign({}, d, { applied_payments: (d.applied_payments || []).concat(picked.map((c) => ({ amount: Math.abs(c.amount), date: c.date }))) }));", "        : Math.max(0, debtBalance(d) - sum);"),
 ("search floors the date again", "searchDebits(this.transactions, { query: box.value, excludeIds", "searchDebits(this.transactions, { query: box.value, notBefore: floor, excludeIds"),
 ("no tag on an earlier payment", "          if (floor && t.date && t.date < floor) meta.createSpan", "          if (false) meta.createSpan"),
 ("search stays shut with nothing suggested", "      if (!this.candidates.length) {\n        finder.open = true;", "      if (false) {\n        finder.open = true;"),
 ("search opens even with suggestions", "      if (!this.candidates.length) {\n        finder.open = true;", "      if (true) {\n        finder.open = true;"),
 ("Apply on a paid row", "      if (!d._settled) {\n        const apply", "      if (true) {\n        const apply"),
 ("no Apply on an unpaid row", "      if (!d._settled) {\n        const apply", "      if (false) {\n        const apply"),
 ("Apply opens the wrong debt", "this.plugin.openApplyPaymentForKey(debtKey(d));", "this.plugin.openApplyPaymentForKey(d.provider);"),
 ("key lookup misses", "const debt = revolving.concat(installment).find((d) => d && debtKey(d) === key);", "const debt = revolving.find((d) => d && debtKey(d) === key);"),
]
