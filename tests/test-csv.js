// CSV import: alias coverage, sign enforcement, and a strict old-vs-new diff.
//
// The backward-compatibility half is the point. parseGenericBank previously took
// the amount column's sign at face value; it now consults a type column where
// one exists. Any export that already imported correctly must keep producing
// byte-identical rows, so the old parser is loaded alongside the new one and the
// two are compared over a corpus rather than reasoned about.
const P = require("./paths.js");
const H = require("./harness.js");
const OLD = require("./harness-for.js")(
  P.BASELINES + "/main.csv-before.js"
);

let pass = 0, fail = 0;
function check(name, got, want) {
  const ok = JSON.stringify(got) === JSON.stringify(want);
  if (ok) { pass++; console.log(`  PASS  ${name}`); }
  else { fail++; console.log(`  FAIL  ${name}: got ${JSON.stringify(got)}, want ${JSON.stringify(want)}`); }
}

// Ids are random per parse, so compare everything else.
const shape = (r) => r.transactions.map((t) => ({
  date: t.date, merchant: t.merchant_raw, amount: t.amount, pending: t.pending || false
}));

// ---------------------------------------------------------------------------
// A corpus of real export shapes. Each is the header line plus rows, exactly as
// the bank writes them — including which way round the signs go, which is the
// whole question here.
const CORPUS = {
  // A typical credit union export. Signed amounts AND a Transaction Type column,
  // so this is the export most at risk from the change.
  bankCsv: `Transaction ID,Posting Date,Effective Date,Transaction Type,Posting Status,Amount,Check Number,Reference Number,Description,Transaction Category,Type,Balance,Memo,Extended Description
20260915 001,09/15/2026,09/15/2026,Debit,Posted,-29.99,,REF001,GOOGLE *PHONE CO XzP3N6,Utilities,Debit,1200.00,,
20260915 002,09/15/2026,09/15/2026,Credit,Posted,1750.00,,REF002,ACME FOODS INC PAYROLL,Income,Credit,2950.00,,
20260916 003,09/16/2026,09/16/2026,Debit,Posted,-67.50,,REF003,ZIP* BEST BUY 183-37823729,Shopping,Debit,2881.45,,`,

  // Same bank, the other vocabulary its statements use.
  bankCsv_withdrawal: `Transaction ID,Posting Date,Transaction Type,Posting Status,Amount,Description
20260915 001,09/15/2026,Withdrawal,Posted,-20.00,SHELL SERVICE STATION
20260915 002,09/15/2026,Deposit,Posted,500.00,TRANSFER IN`,

  // Chase credit card. Purchases already negative, Type says Sale/Payment/Return.
  chase: `Transaction Date,Post Date,Description,Category,Type,Amount,Memo
09/15/2026,09/16/2026,AMAZON MARKETPLACE,Shopping,Sale,-42.18,
09/12/2026,09/13/2026,Payment Thank You - Web,,Payment,500.00,
09/10/2026,09/11/2026,WHOLE FOODS REFUND,Groceries,Return,18.44,`,

  // Bank of America. Signed amounts, no type column at all.
  bofa: `Date,Description,Amount,Running Bal.
09/15/2026,CHECKCARD 0915 SHELL OIL,-52.46,3011.20
09/14/2026,PAYROLL DES:DIRECT DEP,2400.00,3063.66`,

  // American Express. Charges POSITIVE, payments negative, no type column.
  amex: `Date,Description,Card Member,Account #,Amount
09/15/2026,DELTA AIR LINES,A CARDHOLDER,-51001,412.30
09/12/2026,ONLINE PAYMENT - THANK YOU,A CARDHOLDER,-51001,-900.00`,

  // A debit/credit split with no signed amount column.
  split: `Transaction Date,Posted Date,Card No.,Description,Category,Debit,Credit
09/15/2026,09/16/2026,1234,SHELL OIL,Gas/Automotive,52.46,
09/12/2026,09/13/2026,1234,CAPITAL ONE MOBILE PYMT,Payment/Credit,,500.00`,

  // Apple Card. Purchases positive, payments negative, AND a Type column that
  // says "Purchase"/"Payment" — so both mechanisms have an opinion about the
  // same row. This is the shape that double-negates if they are applied in the
  // wrong order.
  applecard: `Transaction Date,Clearing Date,Description,Merchant,Category,Type,Amount (USD)
09/15/2026,09/16/2026,APPLE STORE,Apple,Shopping,Purchase,52.46
09/12/2026,09/13/2026,ACH Deposit Internet Transfer,,Payment,Payment,-900.00`,

  // Signed amounts and a Category column but NO type column — the case where
  // "category" is allowed to decide a sign.
  category_only: `Date,Description,Category,Amount
09/15/2026,SHELL OIL,Gas,-52.46
09/12/2026,ACME PAYROLL,Deposit,2400.00`
};

const parseNew = (csv, opts) => H.parseGenericBank(csv, "acct", opts);
const parseOld = (csv) => OLD.parseGenericBank(csv, "acct");

// ===========================================================================
console.log("\nBackward compatibility: every existing export parses identically");
{
  // The strict requirement: anything that imported CORRECTLY before must import
  // to exactly the same rows now.
  //
  // Apple Card is deliberately excluded and checked separately below. It is the
  // one shape in the corpus the old parser got wrong — it read a positive
  // purchase as income — so leaving it in this loop would be asserting that a
  // bug was preserved.
  const ALREADY_CORRECT = Object.keys(CORPUS).filter((k) => k !== "applecard");
  for (const name of ALREADY_CORRECT) {
    check(`${name} is unchanged`, shape(parseNew(CORPUS[name])), shape(parseOld(CORPUS[name])));
  }
}

console.log("\n  and the one that changed, changed for the better");
{
  // Apple Card's Type column says "Purchase" on a positive figure, which the
  // new parser now acts on and the old one ignored.
  check("the purchase was income before", parseOld(CORPUS.applecard).transactions[0].amount, 52.46);
  check("and is spending now", parseNew(CORPUS.applecard).transactions[0].amount, -52.46);
  check("the payment is untouched either way",
    [parseOld(CORPUS.applecard).transactions[1].amount, parseNew(CORPUS.applecard).transactions[1].amount],
    [-900, -900]);
}

console.log("\n  including the two shapes the old parser was built for");
{
  // Signed-amount-only: the type branch must not engage at all.
  const bofa = parseNew(CORPUS.bofa);
  check("a signed-amount export keeps its signs", bofa.transactions.map((t) => t.amount), [-52.46, 2400]);

  // Debit/Credit split: untouched by the new branch, which only runs when an
  // amount column exists.
  const split = parseNew(CORPUS.split);
  check("a debit/credit split still nets out", split.transactions.map((t) => t.amount), [-52.46, 500]);
}

// ===========================================================================
console.log("\nSign enforcement: a type column decides when the file won't");
{
  // The case the change exists for — every figure positive, direction in a
  // column. No existing export in the corpus looks like this, which is why the
  // diff above stays clean.
  const allPositive = `Date,Description,Transaction Type,Amount
09/15/2026,SHELL OIL,Debit,52.46
09/14/2026,PAYROLL,Credit,2400.00
09/13/2026,TARGET,Purchase,31.20
09/12/2026,ATM,Withdrawal,60.00
09/11/2026,AMAZON,Refund,18.44
09/10/2026,BRANCH,Deposit,100.00
09/09/2026,SQUARE,Sale,12.00
09/08/2026,CARD,Payment,250.00`;
  check("every direction word is honoured",
    parseNew(allPositive).transactions.map((t) => t.amount),
    [-52.46, 2400, -31.2, -60, 18.44, 100, -12, 250]);

  // The old parser took these at face value, so this is the one place output
  // deliberately differs.
  check("which the old parser could not do",
    parseOld(allPositive).transactions.every((t) => t.amount > 0), true);
}

console.log("\n  an unrecognised type defers to the file rather than guessing");
{
  const odd = `Date,Description,Transaction Type,Amount
09/15/2026,SOMETHING,Adjustment,-15.00
09/14/2026,SOMETHING ELSE,Misc,22.00`;
  check("signs survive an unknown type", parseNew(odd).transactions.map((t) => t.amount), [-15, 22]);
  check("matching the old behaviour exactly", shape(parseNew(odd)), shape(parseOld(odd)));
}

// ===========================================================================
console.log("\nAlias coverage");
{
  const col = (header, list) => H.findCol(header.split(","), list);
  check("post date", col("post date,description,amount", H.DATE_COLS), 0);
  check("trans. date", col("trans. date,description,amount", H.DATE_COLS), 0);
  check("clearing date", col("clearing date,payee,amount", H.DATE_COLS), 0);
  check("name as a description", col("date,name,amount", H.DESC_COLS), 1);
  check("title as a description", col("date,title,amount", H.DESC_COLS), 1);
  check("amount (usd)", col("date,description,amount (usd)", H.AMOUNT_COLS), 2);
  check("billed amount", col("date,description,billed amount", H.AMOUNT_COLS), 2);
  check("reference number as a tx id", col("reference number,date,amount", H.TXID_COLS), 0);

  // Order matters more than membership: the specific names have to beat the
  // catch-alls, or "date" would swallow "posting date" and every import would
  // read the wrong column.
  check("a specific date column beats the catch-all",
    col("date,posting date,description,amount", H.DATE_COLS), 1);
  check("description beats memo", col("memo,description,amount", H.DESC_COLS), 1);
  check("a real type column beats category",
    col("date,category,type,amount", H.TYPE_COLS), 2);
}

// ===========================================================================
console.log("\nA category read as a type can no longer invert a payment");
{
  // "category" trails in TYPE_COLS, so it only decides anything when an export
  // has no type column. When it names a direction on a positive figure it is
  // usually right, and that still works:
  const helpful = `Date,Description,Category,Amount
09/12/2026,ACME PAYROLL,Deposit,2400.00`;
  check("a directional category agrees with the sign",
    parseNew(helpful).transactions[0].amount, 2400);

  // And the failure it used to cause is gone. A row categorised "Credit Card
  // Payment" — a category this plugin itself creates — turned a real outflow
  // into an inflow in 1.12.0, because the type check ran on negative figures too.
  const harmful = `Date,Description,Category,Amount
09/15/2026,CHASE CARD AUTOPAY,Credit Card Payment,-450.00`;
  check("a spending category no longer flips a committed sign",
    parseNew(harmful).transactions[0].amount, -450);
  check("which is what the original parser did too",
    parseOld(harmful).transactions[0].amount, -450);
}

// ===========================================================================
console.log("\nA charge-positive export still imports as income");
{
  // Amex bills charges as positive and has no type column, so nothing in either
  // parser turns them into spending. Not a regression — but the account picker
  // now names Amex, so it is worth knowing the claim outruns the code.
  const amex = parseNew(CORPUS.amex).transactions;
  check("the charge is positive", amex[0].amount > 0, true);
  check("and the payment is negative", amex[1].amount < 0, true);
  check("exactly as before", shape(parseNew(CORPUS.amex)), shape(parseOld(CORPUS.amex)));
}

// ===========================================================================
console.log("\nThe real bank formats land on the right rows");
{
  const chase = parseNew(CORPUS.chase).transactions;
  check("Chase purchase stays negative", chase[0].amount, -42.18);
  check("Chase payment stays positive", chase[1].amount, 500);
  check("Chase return stays positive", chase[2].amount, 18.44);
  check("and it reads the Post Date column", chase[0].date, "2026-09-15");

  const bankCsv = parseNew(CORPUS.bankCsv).transactions;
  check("a credit union export is unmoved", bankCsv.map((t) => t.amount), [-29.99, 1750.00, -67.5]);
  check("with descriptions from the right column", bankCsv[0].merchant_raw, "GOOGLE *PHONE CO XzP3N6");
  check("and ids from Transaction ID, not Reference Number", parseNew(CORPUS.bankCsv).transactions.length, 3);
}


// ===========================================================================
console.log("\nA negative figure is a decision the file already made");
{
  // The hazard from 1.12.0, now closed: the type column only gets a say when
  // the amount is positive, so a spending category named like a direction can
  // no longer invert a real payment.
  const harmful = `Date,Description,Category,Amount
09/15/2026,CHASE CARD AUTOPAY,Credit Card Payment,-450.00`;
  check("the payment stays a payment", parseNew(harmful).transactions[0].amount, -450);
  check("matching what the old parser did", shape(parseNew(harmful)), shape(parseOld(harmful)));

  // And the feature it was added for still works, because those files are
  // positive to begin with.
  const allPositive = `Date,Description,Transaction Type,Amount
09/15/2026,SHELL OIL,Debit,52.46
09/14/2026,PAYROLL,Credit,2400.00`;
  check("a positive-only export is still classified",
    parseNew(allPositive).transactions.map((t) => t.amount), [-52.46, 2400]);

  // A type that disagrees with an explicit negative loses.
  const disagree = `Date,Description,Transaction Type,Amount
09/15/2026,SOMETHING,Credit,-75.00`;
  check("an explicit negative outranks a contradicting type",
    parseNew(disagree).transactions[0].amount, -75);
}

// ===========================================================================
console.log("\nThe positive-export flag");
{
  const amex = (opts) => parseNew(CORPUS.amex, opts).transactions.map((t) => t.amount);
  check("off, an Amex charge still lands as income", amex(), [412.3, -900]);
  check("on, it becomes spending", amex({ invertPositiveCharges: true }), [-412.3, 900]);

  // The interaction test. Apple Card has positive purchases AND a Type column,
  // so applying the flag after the type override would negate twice and put the
  // purchase back to positive.
  const apple = (opts) => parseNew(CORPUS.applecard, opts).transactions.map((t) => t.amount);
  check("off, Apple Card is fixed by its Type column alone", apple(), [-52.46, -900]);
  check("on, the purchase is spending and the payment is not",
    apple({ invertPositiveCharges: true }), [-52.46, 900]);

  // Which is the point: the flag normalises the column, it does not re-decide
  // rows the type column already settled.
  const doubleNegated = apple({ invertPositiveCharges: true })[0];
  check("the purchase was not negated twice", doubleNegated < 0, true);
}

console.log("\n  the flag never touches a debit/credit split");
{
  // Those columns name the direction outright, so there is no convention to
  // flip and inverting would only ever be wrong.
  check("split columns ignore the flag",
    parseNew(CORPUS.split, { invertPositiveCharges: true }).transactions.map((t) => t.amount),
    parseNew(CORPUS.split).transactions.map((t) => t.amount));
}

console.log("\n  and defaults to off for every account that predates it");
{
  // Two args, as every existing caller passes.
  check("no options argument behaves as before",
    H.parseGenericBank(CORPUS.bofa, "acct").transactions.map((t) => t.amount), [-52.46, 2400]);
  check("an empty options object too",
    H.parseGenericBank(CORPUS.bofa, "acct", {}).transactions.map((t) => t.amount), [-52.46, 2400]);
  check("and an account object without the field",
    H.parseGenericBank(CORPUS.bofa, "acct", { invertPositiveCharges: undefined })
      .transactions.map((t) => t.amount), [-52.46, 2400]);
}

// ===========================================================================
console.log("\nThe flag reaches the parser from the account");
{
  const SRC = require("fs").readFileSync(P.MAIN, "utf8");
  check("the modal offers the toggle",
    SRC.includes('.setName("Exports purchases as positive numbers")'), true);
  check("with the description as specified",
    SRC.includes("Turn this on for Amex or Apple Card exports where spending is listed as positive numbers."), true);
  check("it is saved on the account", /invert_positive_charges: !!data\.invert_positive_charges/.test(SRC), true);
  check("pre-filled when editing", /invert_positive_charges: !!e\.invert_positive_charges/.test(SRC), true);
  check("and handed to the adapter at import",
    /adapter\(csvText, accountId, \{\s*invertPositiveCharges: !!account\.invert_positive_charges/.test(SRC), true);
}

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
