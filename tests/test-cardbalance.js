const H = require("./harness.js");
const { cardBalanceState, cardActivitySince, debtBalance, totalDebt, isRevolvingDebt, round2 } = H;

let pass = 0, fail = 0;
function check(name, got, want, tol = 0.005) {
  const ok = typeof want === "number" ? Math.abs(got - want) < tol : got === want;
  if (ok) { pass++; console.log(`  PASS  ${name}`); }
  else { fail++; console.log(`  FAIL  ${name}: got ${JSON.stringify(got)}, want ${JSON.stringify(want)}`); }
}

const CARD = "Capital One Card";
const card = (over = {}) => Object.assign({
  account_id: CARD, apr: 29.99, min_payment_due: 40, due_date: "2026-10-05",
  balance_anchor: { amount: 590.46, date: "2026-09-11" }, applied_payments: []
}, over);
const bnpl = (over = {}) => Object.assign({
  provider: "Klarna", installment_amount: 49.48, next_due_date: "2026-10-04",
  balance_anchor: { amount: 197.92, date: "2026-09-01" }, applied_payments: []
}, over);

let n = 0;
const tx = (date, amount, account = CARD, cat = "Shopping") =>
  ({ id: `t${++n}`, date, amount, account_id: account, resolved_category: cat, merchant_raw: "M" });

console.log("\nClassification");
{
  check("a card is revolving", isRevolvingDebt(card()), true);
  check("a BNPL plan is not", isRevolvingDebt(bnpl()), false);
  check("a debt with neither field is not", isRevolvingDebt({ balance_anchor: {} }), false);
}

console.log("\nCharges raise the balance (the whole point)");
{
  const txs = [tx("2026-09-12", -40), tx("2026-09-14", -81.84)];
  const s = cardBalanceState(card(), txs);
  check("charges summed", s.charges, 121.84);
  check("balance rose above the anchor", s.balance, 590.46 + 121.84);
  check("marked as derived", s.derived, true);
  check("debtBalance agrees when given the ledger", debtBalance(card(), txs), 712.30);
  check("debtBalance without the ledger stays at the anchor", debtBalance(card()), 590.46);
}

console.log("\nPayments lower it");
{
  const txs = [tx("2026-09-12", -40), tx("2026-09-20", 200, CARD, "Credit Card Payment")];
  const s = cardBalanceState(card(), txs);
  check("payments summed", s.payments, 200);
  check("balance nets both directions", s.balance, 590.46 + 40 - 200);
}

console.log("\nA payment is never counted twice");
{
  // The real shape: the card sees a credit, checking sees a debit, different
  // ids a day apart. Apply Payment records the CHECKING leg.
  const cardLeg = tx("2026-09-20", 425, CARD, "Credit Card Payment");
  const checkLeg = tx("2026-09-21", -425, "Main Checking", "Credit Card Payment");
  const d = card({ applied_payments: [{ tx_id: checkLeg.id, amount: 425, date: "2026-09-21" }] });
  const s = cardBalanceState(d, [cardLeg, checkLeg]);
  check("only the card leg counts", s.payments, 425);
  check("balance subtracts it exactly once", s.balance, 590.46 - 425);
  check("NOT double-subtracted", s.balance !== round2(590.46 - 850), true);

  // The checking leg must never be mistaken for card activity.
  const onlyChecking = cardActivitySince(card(), [checkLeg]);
  check("checking-side rows are ignored entirely", onlyChecking.paymentCount + onlyChecking.chargeCount, 0);
}

console.log("\nAnchor boundary");
{
  const txs = [tx("2026-09-10", -100), tx("2026-09-11", -50), tx("2026-09-12", -25)];
  const s = cardBalanceState(card(), txs);
  check("only activity strictly after the anchor counts", s.charges, 25);
  check("charge count matches", s.chargeCount, 1);
}

console.log("\nRe-anchoring");
{
  // The bug this exposed: re-anchor to a real balance while payments are on
  // file, and the old fallback subtracted payments the figure already included.
  const d = card({
    balance_anchor: { amount: 590.46, date: "2026-09-20" },
    applied_payments: [{ tx_id: "old", amount: 425, date: "2026-09-05" }]
  });
  const s = cardBalanceState(d, []);
  check("pre-anchor payments do not reduce a fresh anchor", s.balance, 590.46);
  check("falls back when nothing is imported since", s.derived, false);

  const after = cardBalanceState(
    card({
      balance_anchor: { amount: 590.46, date: "2026-09-20" },
      applied_payments: [{ tx_id: "new", amount: 100, date: "2026-09-22" }]
    }), []);
  check("post-anchor payments still count in the fallback", after.balance, 490.46);
}

console.log("\nFallback preserves old behaviour with no card import");
{
  const d = card({ applied_payments: [{ tx_id: "p", amount: 90.46, date: "2026-09-15" }] });
  check("anchor minus payments when nothing imported", cardBalanceState(d, []).balance, 500);
  check("and via debtBalance", debtBalance(d, []), 500);
}

console.log("\nBNPL is untouched");
{
  const txs = [tx("2026-09-12", -40, "Main Checking")];
  const b = bnpl({ applied_payments: [{ tx_id: "x", amount: 49.48, date: "2026-09-05" }] });
  check("BNPL ignores the ledger entirely", debtBalance(b, txs), round2(197.92 - 49.48));
  check("same with no ledger", debtBalance(b), round2(197.92 - 49.48));
}

console.log("\nFloors and totals");
{
  const txs = [tx("2026-09-12", 5000, CARD, "Credit Card Payment")];
  check("overpayment floors at zero, never negative", cardBalanceState(card(), txs).balance, 0);

  const charged = [tx("2026-09-12", -121.84)];
  check("totalDebt uses the live card balance", totalDebt([card()], [bnpl()], charged), round2(712.30 + 197.92));
  check("totalDebt without a ledger uses anchors", totalDebt([card()], [bnpl()]), round2(590.46 + 197.92));
}

console.log("\nAgainst the sample ledger");
{
  const txs = JSON.parse(require("fs").readFileSync(require("path").join(__dirname, "fixtures", "fixture-ctx.json"), "utf8")).allTx;
  const d = card({ balance_anchor: { amount: 590.46, date: "2026-08-05" } });
  const s = cardBalanceState(d, txs);
  console.log(`   anchored $590.46 on 2026-08-05 -> +$${s.charges.toFixed(2)} in ${s.chargeCount} charges, ` +
              `-$${s.payments.toFixed(2)} in ${s.paymentCount} payments -> $${s.balance.toFixed(2)}`);
  check("real ledger produces a derived balance", s.derived, true);
  check("real charges are non-zero", s.charges > 0, true);
  check("latest activity is tracked", s.latest >= "2026-09-01", true);

  // Nothing from the checking account may leak in.
  const leaked = txs.filter((t) => t.account_id !== CARD && t.date > "2026-08-05");
  const cardOnly = txs.filter((t) => t.account_id === CARD && t.date > "2026-08-05");
  const expectCharges = round2(cardOnly.filter((t) => t.amount < 0).reduce((a, t) => a + Math.abs(t.amount), 0));
  check(`only card rows counted (${leaked.length} checking rows excluded)`, s.charges, expectCharges);
}

console.log("\nDebt identity survives a rename");
{
  const plan = { id: "bnpl_1", provider: "ZIP - Switch 2", installment_amount: 67.5 };
  const before = H.debtKey(plan);
  plan.provider = "Zip (Nintendo Switch 2)";
  check("key is unchanged after renaming the provider", H.debtKey(plan), before);
  check("key is the stable id", before, "bnpl_1");

  const legacy = { provider: "Klarna", installment_amount: 49.48 };
  check("a record without an id still resolves (pre-migration)", H.debtKey(legacy), "bnpl:Klarna");
  const legacyCard = { account_id: "Capital One Card", apr: 29.99 };
  check("legacy card key", H.debtKey(legacyCard), "cc:Capital One Card");
}

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
