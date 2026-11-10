# Mutations for twice-a-month paydays on any two days.
# Run: python3 tools/mutate.py tools/mutations/pay-days.py
TESTS = ["test-pay-days.js"]

MUTATIONS = [
 ("days ignored", "return days.length === 2 ? days : [1, 15];", "return [1, 15];"),
 ("no fallback", "return days.length === 2 ? days : [1, 15];", "return days.length === 2 ? days : [];"),
 ("days not sorted", ".sort((a, b) => a - b);\n  return days.length === 2", ";\n  return days.length === 2"),
 ("short months not clamped", "Math.min(d, last)", "d"),
 ("looks one month back too few", "for (let off = -1; off <= 2; off++) {", "for (let off = 0; off <= 2; off++) {"),
 ("looks too few months ahead", "for (let off = -1; off <= 2; off++) {", "for (let off = -1; off <= 0; off++) {"),
 ("next payday not strictly after", ".find((d) => d > fromDateStr) || null", ".find((d) => d >= fromDateStr) || null"),
 ("period start strictly before", ".filter((x) => x <= onDateStr);", ".filter((x) => x < onDateStr);"),
 ("detection forgets the days", "if (daysOfMonth.size === 2) days = [...daysOfMonth].sort((a, b) => a - b);", ""),
 ("detected days not used", "Object.assign({ cadence: detected.cadence, anchor_date: detected.anchor_date, inferred: true }, detected.days ? { days: detected.days } : {})", "{ cadence: detected.cadence, anchor_date: detected.anchor_date, inferred: true }"),
 ("same day accepted", "        if (a === b) {\n          new Notice(\"Enter two different days.\", 6000);\n          return;\n        }\n", ""),
 ("days saved unsorted", "days: [a, b].sort((x, y) => x - y)", "days: [a, b]"),
 ("anchor save drops the days", "Object.assign({}, this.plugin.settings.paySchedule, { cadence: sched.cadence || \"biweekly\", anchor_date: norm })", "{ cadence: sched.cadence || \"biweekly\", anchor_date: norm }"),
]
