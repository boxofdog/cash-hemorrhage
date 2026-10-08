// Transaction notes: one markdown note per month, an index, and the export command.
const H = require("./harness.js");

let pass = 0, fail = 0;
function check(name, got, want) {
  const ok = JSON.stringify(got) === JSON.stringify(want);
  if (ok) { pass++; console.log(`  PASS  ${name}`); }
  else { fail++; console.log(`  FAIL  ${name}: got ${JSON.stringify(got)}, want ${JSON.stringify(want)}`); }
}
const F = H.FILES;

const accounts = [{ id: "chk", institution: "Cal Coast Checking" }];
const tx = [
  { id: "a", date: "2026-09-03", merchant_raw: "SHELL OIL 123", amount: -44.2, account_id: "chk", resolved_category: "Gas" },
  { id: "b", date: "2026-09-01", merchant_raw: "PAYROLL | ACME", amount: 2000, account_id: "chk", resolved_category: "Paycheck" },
  { id: "c", date: "2026-08-30", merchant_raw: "COFFEE", amount: -5.5, account_id: "gone", resolved_category: "Uncategorized", override_label: "Eating Out", pending: true },
  { id: "d", date: null, merchant_raw: "HOLD", amount: -10, account_id: null, resolved_category: null }
];
const files = H.buildTransactionNotes(tx, accounts);
const by = Object.fromEntries(files.map((f) => [f.name, f.content]));

console.log("\n1. The notes");
check("a note per month, one for undated, and the index", files.map((f) => f.name), ["Transactions 2026-09", "Transactions 2026-08", "Transactions no date", "Transactions"]);
const sep = by["Transactions 2026-09"];
check("properties for the month", sep.split("---")[1].trim().split("\n"), ["month: 2026-09", "transactions: 2", "money_in: 2000.00", "money_out: 44.20"]);
check("oldest first, with account names, and a pipe in a merchant doesn't break the table",
  sep.split("\n").filter((l) => l.startsWith("| 2026")),
  ["| 2026-09-01 | PAYROLL \\| ACME | Paycheck | Cal Coast Checking | $2,000.00 |", "| 2026-09-03 | SHELL OIL 123 | Gas | Cal Coast Checking | -$44.20 |"]);
check("your label wins, pending is marked, an unknown account shows its id", by["Transactions 2026-08"].split("\n").find((l) => l.startsWith("| 2026")), "| 2026-08-30 | COFFEE (pending) | Eating Out | gone | -$5.50 |");
check("undated ones get their own note", by["Transactions no date"].includes("| no date | HOLD | Uncategorized | — | -$10.00 |"), true);
check("the index links each month, newest first", by["Transactions"].split("\n").filter((l) => l.includes("[[")).map((l) => l.split("|")[1].trim()),
  ["[[Transactions 2026-09\\", "[[Transactions 2026-08\\", "[[Transactions no date\\"]);
check("the alias bar is escaped so the table survives", by["Transactions"].includes("[[Transactions 2026-09\\|September 2026]]"), true);
check("every note says edits are overwritten", files.every((f) => f.content.includes("Changes here are overwritten")), true);
check("no transactions: just an index that says so", H.buildTransactionNotes([], []).map((f) => [f.name, f.content.includes("No transactions yet.")]), [["Transactions", true]]);

console.log("\n2. The export command");
(async () => {
  const store = { [F.transactions]: JSON.stringify(tx), [F.accounts]: JSON.stringify(accounts) };
  const dirs = new Set();
  const writes = {};
  const app = { vault: { adapter: {
    exists: async (p) => p in store || dirs.has(p),
    read: async (p) => store[p],
    mkdir: async (p) => dirs.add(p),
    write: async (p, d) => { writes[p] = d; }
  } } };
  global.__notices = [];
  const plugin = Object.create(H.__PluginClass.prototype);
  plugin.app = app;
  const res = await plugin.exportTransactionNotes();
  check("it writes into Budget/exports/Transactions", Object.keys(writes).sort(), [
    "Budget/exports/Transactions/Transactions 2026-08.md", "Budget/exports/Transactions/Transactions 2026-09.md",
    "Budget/exports/Transactions/Transactions no date.md", "Budget/exports/Transactions/Transactions.md"]);
  check("it makes the folders first", [...dirs], ["Budget", "Budget/exports", "Budget/exports/Transactions"]);
  check("a short notice", global.__notices.pop(), "Exported 4 transactions to Budget/exports/Transactions (2 months).");
  check("and never touches the data", store[F.transactions], JSON.stringify(tx));
  await plugin.exportTransactionNotes();
  check("exporting again rewrites, nothing piles up", Object.keys(writes).length, 4);
  console.log(`\n${pass} passed, ${fail} failed`);
  process.exit(fail ? 1 : 0);
})();
