# Mutations for suggesting a typed-in transaction's bank twin and merging it.
# Run: python3 tools/mutate.py tools/mutations/manual-duplicates.py
# A mutation whose old text no longer matches reports NOT FOUND: update its text
# to the new code rather than deleting it.

TESTS = ["test-manual-duplicates.js"]

MUTATIONS = [
 ("window too wide", "const DUPLICATE_REVIEW_DAYS = 3;", "const DUPLICATE_REVIEW_DAYS = 5;"),
 ("window too narrow", "const DUPLICATE_REVIEW_DAYS = 3;", "const DUPLICATE_REVIEW_DAYS = 2;"),
 ("amount not compared", "if (b.account_id !== m.account_id || cents(b) !== cents(m)) return;", "if (b.account_id !== m.account_id) return;"),
 ("account not compared", "if (b.account_id !== m.account_id || cents(b) !== cents(m)) return;", "if (cents(b) !== cents(m)) return;"),
 ("dismissal ignored", "      if ((m.not_duplicate_with || []).includes(b.id) || (b.not_duplicate_with || []).includes(m.id)) return;\n", ""),
 ("pending bank rows offered", "const bank = txs.filter((t) => !t.manual && t.date && !t.pending && Number.isFinite(t.amount));", "const bank = txs.filter((t) => !t.manual && t.date && Number.isFinite(t.amount));"),
 ("typed rows offered as bank rows", "const bank = txs.filter((t) => !t.manual && t.date", "const bank = txs.filter((t) => t.date"),
 ("a row offered twice", "    if (used.has(c.manual.id) || used.has(c.bank.id)) return;\n", ""),
 ("sync claims typed rows", "      if (t.manual) return;\n      if (t.account_id !== tx.account_id", "      if (t.account_id !== tx.account_id"),
 ("merge keeps the typed row", "    transactions: rows.filter((t) => t !== m),", "    transactions: rows.filter((t) => t !== b),"),
 ("category not carried", "if (!b.override_label && m.override_label) b.override_label = m.override_label;", ""),
 ("category overwrites the bank's", "if (!b.override_label && m.override_label) b.override_label = m.override_label;", "if (m.override_label) b.override_label = m.override_label;"),
 ("pairing not carried", "const takesPair = !b.transfer_pair && !!m.transfer_pair;", "const takesPair = false;"),
 ("bank's pairing overwritten", "const takesPair = !b.transfer_pair && !!m.transfer_pair;", "const takesPair = !!m.transfer_pair;"),
 ("freed partner left dangling", "    else delete t.transfer_pair;", ""),
 ("no relink", "    relink: [{ from: m.id, to: b.id, date: b.date }]", "    relink: []"),
 ("merges the wrong way round", "if (!m || !b || !m.manual || b.manual) return", "if (!m || !b) return"),
 ("dismiss marks one side", "    b.not_duplicate_with = [...new Set((b.not_duplicate_with || []).concat(a.id))];\n", ""),
 ("bank row not held back from labelling", "    duplicates.forEach((d) => inReview.add(d.bank.id));\n", ""),
]
