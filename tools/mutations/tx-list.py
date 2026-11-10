# Mutations for the Transactions list (Recent / All transactions / filters), for
# taking back dismissed suggestions, and for removing a debt-chart point.
# Run: python3 tools/mutate.py tools/mutations/tx-list.py
# A mutation whose old text no longer matches reports NOT FOUND: update its text
# to the new code rather than deleting it.

TESTS = ["test-tx-list.js", "test-transfers.js", "test-inbox.js"]

MUTATIONS = [
 ("range from the wrong end", "const cutoff = mode === \"all\" ? addDays(todayStr, -days) : null;", "const cutoff = mode === \"all\" ? addDays(todayStr, days) : null;"),
 ("range excludes its edge", "const inRange = (t) => !cutoff || !t.date || t.date >= cutoff;", "const inRange = (t) => !cutoff || !t.date || t.date > cutoff;"),
 ("undated holds dropped from a range", "const inRange = (t) => !cutoff || !t.date || t.date >= cutoff;", "const inRange = (t) => !cutoff || (!!t.date && t.date >= cutoff);"),
 ("money in ignored", "  if (moneyIn) rows = rows.filter((t) => t.amount > 0);", ""),
 ("money in takes money out", "  if (moneyIn) rows = rows.filter((t) => t.amount > 0);", "  if (moneyIn) rows = rows.filter((t) => t.amount < 0);"),
 ("hide transfers keeps categories", "const isTransfer = (t) => isPair(t) || transferCats.has(t.resolved_category);", "const isTransfer = (t) => isPair(t);"),
 ("hide transfers keeps pairs", "const isTransfer = (t) => isPair(t) || transferCats.has(t.resolved_category);", "const isTransfer = (t) => transferCats.has(t.resolved_category);"),
 ("hide transfers loses to show pairs", "const visible = (t) => (hideTransfers ? !isTransfer(t) : showPairs || !isPair(t));", "const visible = (t) => (showPairs ? true : hideTransfers ? !isTransfer(t) : !isPair(t));"),
 ("pairs shown by default", "const visible = (t) => (hideTransfers ? !isTransfer(t) : showPairs || !isPair(t));", "const visible = (t) => (hideTransfers ? !isTransfer(t) : true);"),
 ("recent has no limit", "      shown = base.slice(0, limit);", "      shown = base;"),
 ("recent filter ignores hide transfers", "    shown = rows.filter(visible).slice(0, limit);", "    shown = rows.slice(0, limit);"),
 ("no cap on a long range", "  if (mode === \"all\" && shown.length > TX_ROW_CAP) {", "  if (false) {"),
 ("older ignores the filters", "const hasOlder = !!cutoff && rows.filter((t) => t.date && t.date < cutoff && visible(t)).length > 0;", "const hasOlder = !!cutoff && rowsAll.filter((t) => t.date && t.date < cutoff).length > 0;"),
 ("older never offered", "const hasOlder = !!cutoff && rows.filter((t) => t.date && t.date < cutoff && visible(t)).length > 0;", "const hasOlder = false;"),
 ("next range goes nowhere", "  const next = TX_RANGE_STEPS.find((d) => d > days);\n  return next || TX_ALL_DAYS;", "  return days;"),
 ("switching list keeps the old range", "        this.txMode = key;\n        this.txDays = TX_RANGE_STEPS[0];", "        this.txMode = key;"),
 ("filter chips don't toggle", "        this[key] = !on;", "        this[key] = on;"),
 ("transfer dismissal keeps one side", "      copy.not_transfer_with = (copy.not_transfer_with || []).filter((x) => !ids.has(x));", "      copy.not_transfer_with = copy.not_transfer_with;"),
 ("duplicate dismissal keeps one side", "      copy.not_duplicate_with = (copy.not_duplicate_with || []).filter((x) => !ids.has(x));", "      copy.not_duplicate_with = copy.not_duplicate_with;"),
 ("bring back a transfer clears the duplicates too", "    if (item.kind === \"transfer\") {\n      copy.not_transfer_with", "    if (item.kind === \"transfer\") {\n      delete copy.not_duplicate_with;\n      copy.not_transfer_with"),
 ("payment bring back leaves the flag", "      delete copy.excluded_from_debt_payments;\n      if (copy.debt_payment_review_status", "      if (copy.debt_payment_review_status"),
 ("already applied bring back leaves its notes", "        delete copy.debt_payment_debt_key;\n", ""),
 ("a pair listed twice", "        if (seen.has(key)) return;\n        seen.add(key);", "        seen.add(key);"),
 ("dismissed with a missing row listed", "        const other = byId.get(otherId);\n        if (!other) return;", "        const other = byId.get(otherId) || { id: otherId };"),
 ("debt point removal too wide", "const kept = (history || []).filter((h) => !(h && h.date === date));", "const kept = [];"),
 ("today's point offered", "          if (h.date !== todayStr) {\n            const gone", "          if (true) {\n            const gone"),
]
