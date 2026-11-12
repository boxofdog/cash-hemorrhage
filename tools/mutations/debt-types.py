# Mutations for the debt chart by kind of debt, and for scaling around a big step.
# Run: python3 tools/mutate.py tools/mutations/debt-types.py
# A mutation whose old text no longer matches reports NOT FOUND: update its text
# to the new code rather than deleting it.

TESTS = ["test-debt-types.js", "test-charts.js", "test-tx-list.js", "test-loans.js"]

MUTATIONS = [
 ("cards counted as plans", "    card: sum(revolving, (d) => debtBalance(d, transactions)),", "    card: sum(revolving, (d) => 0),"),
 ("loans counted with plans", "    plan: sum((installment || []).filter((d) => !isLoan(d)), (d) => debtBalance(d)),", "    plan: sum((installment || []), (d) => debtBalance(d)),"),
 ("loans left out", "    loan: sum((installment || []).filter(isLoan), (d) => debtBalance(d))", "    loan: 0"),
 ("kinds not saved on a new point", "    history.push({ date: today, total_debt: total, types });", "    history.push({ date: today, total_debt: total });"),
 ("kinds not added to a point without them", "JSON.stringify(history[idx].types) === JSON.stringify(types)) return history;", "true) return history;"),
 ("an unchanged point rewritten", "    if (history[idx].total_debt === total && JSON.stringify", "    if (false && history[idx].total_debt === total && JSON.stringify"),
 ("kinds not updated", "    history[idx].types = types;\n", ""),
 ("a kind ignores which points recorded it", "    .filter((h) => h && h.types && Number.isFinite(h.types[type]))\n", ""),
 ("a kind charts the total", "    .map((h) => ({ date: h.date, total_debt: h.types[type] }));", "    .map((h) => ({ date: h.date, total_debt: h.total_debt }));"),
 ("a zero balance dropped", "Number.isFinite(h.types[type]))", "!!h.types[type])"),
 ("no step ever found", "  if (!(jump >= 3 * Math.max(spread(before), spread(after), 1))) return null;", "  return null;"),
 ("every wobble is a step", "  if (!(jump >= 3 * Math.max(spread(before), spread(after), 1))) return null;", ""),
 ("the step needn't dwarf the wobble", "  if (!(jump >= 3 * Math.max(spread(before), spread(after), 1))) return null;", "  if (!(jump >= 1 * Math.max(spread(before), spread(after), 1))) return null;"),
 ("the shorter side is scaled to", "  return { index: at, coreBefore: before.length > after.length };", "  return { index: at, coreBefore: before.length <= after.length };"),
 ("a tie goes to the earlier side", "  return { index: at, coreBefore: before.length > after.length };", "  return { index: at, coreBefore: before.length >= after.length };"),
 ("under three points still judged", "  if (!ys || ys.length < 3) return null;", "  if (!ys || ys.length < 1) return null;"),
 ("the axis still fits the jump", "    const core = shift ? (shift.coreBefore ? pts.slice(0, shift.index) : pts.slice(shift.index)).map((p) => p.y) : allY;", "    const core = allY;"),
 ("a payoff line is cut too", "    shift = projPts.length ? null : detectLevelShift(pts.map((p) => p.y));", "    shift = detectLevelShift(pts.map((p) => p.y));"),
 ("off-scale points drawn solid", "(isClipped(p) ? `fill=\"var(--background-primary)\" stroke=\"var(--text-accent, #7b6cd9)\" stroke-width=\"2\"` : `fill=\"var(--text-accent, #7b6cd9)\"`)", "`fill=\"var(--text-accent, #7b6cd9)\"`"),
 ("off-scale points not clamped", "  const sy = (y) => PAD.top + plotH - ((Math.min(Math.max(y, minY), maxY) - minY) / (maxY - minY || 1)) * plotH;", "  const sy = (y) => PAD.top + plotH - ((y - minY) / (maxY - minY || 1)) * plotH;"),
 ("no note of where it really is", "  const off = pts.filter(isClipped);", "  const off = [];"),
 ("the note points the wrong way", "${up ? \"\\u2191\" : \"\\u2193\"}", "${up ? \"\\u2193\" : \"\\u2191\"}"),
 ("the switch shows with one kind", "      if (present.length >= 2) {\n        const kinds", "      if (present.length >= 1) {\n        const kinds"),
 ("a kind you've lost stays chosen", "const type = present.length >= 2 && present.includes(this.debtChartType) ? this.debtChartType : \"all\";", "const type = present.length >= 2 ? this.debtChartType || \"all\" : \"all\";"),
 ("a kind gets the total's payoff line", "const projection = type === \"all\" ? projectPayoff(grandTotal, this.lastResult) : null;", "const projection = projectPayoff(grandTotal, this.lastResult);"),
 ("a kind charts the total's points", "const series = debtChartSeries(history, type);", "const series = history;"),
 ("no word that it's kept from a date", "(type !== \"all\" && first.date > history[0].date ? \" Kept by kind from then.\" : \"\")", "\"\""),
 ("choosing a kind doesn't stick", "            this.debtChartType = key;\n            this.render();", "            this.render();"),
]
