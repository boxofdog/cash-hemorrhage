const { Plugin, Modal, ItemView, Notice, Setting, FuzzySuggestModal, PluginSettingTab, Platform, Menu, requestUrl } = require("obsidian");

// Obsidian sets .is-mobile on <body>; Platform is the documented API but guard
// it in case an older desktop build doesn't expose it.
function isMobileApp() {
  try {
    if (Platform && typeof Platform.isMobile === "boolean") return Platform.isMobile;
  } catch (e) {
    /* fall through */
  }
  return document.body.classList.contains("is-mobile");
}

const VIEW_TYPE = "budget-tracker-dashboard";
const DATA_DIR = "Budget/data";
const IMPORT_DIR = "Budget/imports";
// Where Export Snapshot saves its Markdown and CSV copies.
const EXPORT_DIR = "Budget/exports";
const TX_NOTES_DIR = `${EXPORT_DIR}/Transactions`;

const FILES = {
  accounts: `${DATA_DIR}/accounts.json`,
  revolvingDebts: `${DATA_DIR}/revolving_debts.json`,
  installmentDebts: `${DATA_DIR}/installment_debts.json`,
  fixedExpenses: `${DATA_DIR}/fixed_expenses.json`,
  rules: `${DATA_DIR}/category_rules.json`,
  categories: `${DATA_DIR}/categories.json`,
  transactions: `${DATA_DIR}/transactions.json`,
  paycheckHistory: `${DATA_DIR}/paycheck_history.json`,
  activePeriod: `${DATA_DIR}/active_period.json`,
  debtHistory: `${DATA_DIR}/debt_history.json`,
  subscriptionReviews: `${DATA_DIR}/subscription_reviews.json`,
  savingsGoals: `${DATA_DIR}/savings_goals.json`,
  settings: `${DATA_DIR}/settings.json`,
  bufferSweeps: `${DATA_DIR}/buffer_sweeps.json`,
  portfolioAccounts: `${DATA_DIR}/portfolio_accounts.json`,
  portfolioSnapshots: `${DATA_DIR}/portfolio_snapshots.json`,
  categoryOrder: `${DATA_DIR}/category_order.json`,
  // Loans that have ended (sold, traded in, refinanced, paid off), with how.
  closedLoans: `${DATA_DIR}/closed_loans.json`,
  // What SimpleFIN last reported (account names, balances) and when it was
  // asked — never the connection itself, which lives in secret storage.
  simplefinAccounts: `${DATA_DIR}/simplefin_accounts.json`
};

// The two accounts the portfolio import was first built around. They are no
// longer a fixed list — investment accounts are the user's own, kept in
// portfolio_accounts.json — but these ids are what existing snapshots point at,
// so a vault whose account file has gone missing gets back exactly the ones its
// snapshots still reference, and nothing it never had.
const PF_LEGACY_ACCOUNTS = [
  { id: "fidelity_401k", provider: "Fidelity", type: "401k", label: "Fidelity 401(k)" },
  { id: "fidelity_hsa", provider: "Fidelity", type: "hsa", label: "Fidelity HSA" }
];

// Named so a statement can be recognised as theirs. Anything else is still
// importable under "Other" — the generic wording covers most statements.
const PF_PROVIDERS = ["Fidelity", "Vanguard", "Empower", "Charles Schwab"];

const PF_TYPES = {
  "401k": "401(k)",
  "403b": "403(b)",
  "457b": "457(b)",
  ira: "IRA",
  roth_ira: "Roth IRA",
  hsa: "HSA",
  brokerage: "Brokerage",
  "529": "529 plan",
  pension: "Pension",
  other: "Investment account"
};

// How often statements arrive decides when a missing one is worth mentioning.
// Plenty of retirement plans only publish quarterly, and nagging monthly about
// a statement that doesn't exist yet would teach people to ignore the nag.
const PF_CADENCES = { monthly: "Monthly", quarterly: "Quarterly", none: "Don't remind me" };

// Day of the month from which a missing prior-month statement is worth nagging
// about — statements are not all published on the 1st.
const PORTFOLIO_REMINDER_DAY = 7;

const DEFAULT_SETTINGS = {
  // Buffer: "auto" derives a holdback from run-rate and days remaining;
  // "manual" uses a flat figure.
  bufferMode: "auto",
  manualBuffer: 100,
  // { cadence: "biweekly", anchor_date: "2026-09-01" } — the date half of a pay
  // period is fully determined by this, so it never needs typing again.
  paySchedule: null,
  // Savings Mode: redirects the payoff allocator's surplus into savings goals
  // instead of debt principal. Minimums are still paid — this changes where
  // *extra* money goes, it doesn't skip anything owed. The deadline is optional;
  // without one, goals are paced by their own target dates.
  savingsMode: false,
  savingsDeadline: null
};

const PAY_CADENCES = {
  weekly: { label: "Weekly", days: 7 },
  biweekly: { label: "Every 2 weeks", days: 14 },
  semimonthly: { label: "Twice a month (1st & 15th)", days: null },
  monthly: { label: "Monthly", days: null }
};

// ---------- portfolio statement parsing ----------
//
// Allowlist parser. Statements contain name, address, employee number, division
// and linked bank details; none of that is extracted, so none of it can be
// persisted by accident. Only the named financial fields below are read, and
// the pasted text itself is never written to disk or logged.

function pfNormalizeText(raw) {
  return String(raw || "")
    .replace(/\r\n?/g, "\n")
    .replace(/[\u00a0\u2007\u202f]/g, " ")
    .replace(/[\u2010-\u2015\u2212]/g, "-")
    .replace(/[ \t]+/g, " ");
}

// Currency: strips $ and separators, keeps sign, tolerates (1,234.56) negatives.
function pfMoney(v) {
  if (v == null) return null;
  let s = String(v).trim();
  if (!s) return null;
  const paren = /^\(.*\)$/.test(s);
  s = s.replace(/[()]/g, "").replace(/[$,\s]/g, "");
  if (!/^-?\d+(\.\d+)?$/.test(s)) return null;
  const n = parseFloat(s);
  if (isNaN(n)) return null;
  return round2(paren ? -n : n);
}

function pfPercent(v) {
  if (v == null) return null;
  const s = String(v).replace(/[%\s,]/g, "");
  if (!/^-?\d+(\.\d+)?$/.test(s)) return null;
  const n = parseFloat(s);
  return isNaN(n) ? null : n;
}

const PF_MONTHS = {
  january: 1, february: 2, march: 3, april: 4, may: 5, june: 6,
  july: 7, august: 8, september: 9, october: 10, november: 11, december: 12,
  jan: 1, feb: 2, mar: 3, apr: 4, jun: 6, jul: 7, aug: 8, sep: 9, sept: 9, oct: 10, nov: 11, dec: 12
};

function pfDate(raw) {
  if (!raw) return null;
  const s = String(raw).trim();

  let m = s.match(/^(\d{1,2})\/(\d{1,2})\/(\d{2,4})$/);
  if (m) {
    let y = parseInt(m[3], 10);
    if (y < 100) y += 2000;
    return pfIsoIfValid(y, parseInt(m[1], 10), parseInt(m[2], 10));
  }

  m = s.match(/^([A-Za-z]+)\.?\s+(\d{1,2}),?\s+(\d{4})$/);
  if (m) {
    const mo = PF_MONTHS[m[1].toLowerCase()];
    if (mo) return pfIsoIfValid(parseInt(m[3], 10), mo, parseInt(m[2], 10));
  }

  m = s.match(/^(\d{4})-(\d{2})-(\d{2})$/);
  if (m) return pfIsoIfValid(parseInt(m[1], 10), parseInt(m[2], 10), parseInt(m[3], 10));

  return null;
}

function pfIsoIfValid(y, mo, d) {
  if (!y || !mo || !d || mo < 1 || mo > 12 || d < 1 || d > 31) return null;
  const dt = new Date(y, mo - 1, d);
  if (dt.getFullYear() !== y || dt.getMonth() !== mo - 1 || dt.getDate() !== d) return null;
  return toLocalISO(dt);
}

// Finds a labelled amount. Tolerates the value sitting on the same line or the
// next one, arbitrary whitespace, and repeated page headers.
// Real statements put column headers between a label and its value —
// "Your Personal Rate of Return / This Period 2.4%" — and footnote markers
// after it: "Change in Investment Value * 1.07 2.10". The filler allowance
// covers both, while staying narrow enough not to wander into another row.
const PF_FILLER = "(?:\\s|[:.*†‡]|This\\s+Period|Year-to-Date|Period\\s+to\\s+date|Total)*";

function pfFindAmount(text, labels) {
  for (const label of labels) {
    const esc = label.replace(/[.*+?^${}()|[\]\\]/g, "\\$&").replace(/\s+/g, "\\s+");
    const re = new RegExp(esc + PF_FILLER + "\\s*\\$?\\s*(\\(?-?[\\d,]+\\.?\\d*\\)?)", "i");
    const m = text.match(re);
    if (m) {
      const v = pfMoney(m[1]);
      if (v != null) return v;
    }
  }
  return null;
}

function pfFindPercent(text, labels) {
  for (const label of labels) {
    const esc = label.replace(/[.*+?^${}()|[\]\\]/g, "\\$&").replace(/\s+/g, "\\s+");
    const re = new RegExp(esc + PF_FILLER + "\\s*(-?[\\d,]+\\.?\\d*)\\s*%?", "i");
    const m = text.match(re);
    if (m) {
      const v = pfPercent(m[1]);
      if (v != null) return v;
    }
  }
  return null;
}

// "Statement Period 08/01/2026 - 08/31/2026", "August 1, 2026 to August 31, 2026",
// or the two dates on the line following the label.
function pfFindPeriod(text) {
  const dateAlt =
    "(\\d{1,2}\\/\\d{1,2}\\/\\d{2,4}|[A-Za-z]+\\.?\\s+\\d{1,2},?\\s+\\d{4}|\\d{4}-\\d{2}-\\d{2})";
  const sep = "\\s*(?:-|–|to|through|thru)\\s*";
  const labels = ["Statement Period", "Statement Dates", "Period Covered", "For the Period", "Reporting Period"];

  for (const label of labels) {
    const re = new RegExp(
      label.replace(/\s+/g, "\\s+") + "\\s*[:.]?\\s*" + dateAlt + sep + dateAlt,
      "i"
    );
    const m = text.match(re);
    if (m) {
      const start = pfDate(m[1]);
      const end = pfDate(m[2]);
      if (start && end) return { start, end };
    }
  }

  // Unlabelled range near the top of the document, as a fallback.
  const bare = new RegExp(dateAlt + sep + dateAlt, "i");
  const m = text.slice(0, 2500).match(bare);
  if (m) {
    const start = pfDate(m[1]);
    const end = pfDate(m[2]);
    if (start && end && start <= end) return { start, end };
  }
  return null;
}

// "2026-08" -> the full calendar month. Used only when the document itself
// carries no period and the user picks the month. For an account that gets
// quarterly statements the month is the quarter's last, and the period is the
// three months ending with it.
function pfPeriodFromMonth(monthKey, cadence = "monthly") {
  if (!monthKey || !/^\d{4}-\d{2}$/.test(monthKey)) return null;
  const [y, m] = monthKey.split("-").map(Number);
  if (!y || !m || m < 1 || m > 12) return null;
  const last = new Date(y, m, 0).getDate();
  const end = `${monthKey}-${String(last).padStart(2, "0")}`;
  if (cadence === "quarterly") return { start: toLocalISO(new Date(y, m - 3, 1)), end };
  return { start: `${monthKey}-01`, end };
}

function detectPortfolioStatementType(rawText) {
  const text = pfNormalizeText(rawText);
  const hay = text.toLowerCase();

  const hsaSignals = [
    "fidelity health savings account",
    "health savings account",
    "beginning account value",
    "ending account value"
  ].filter((s) => hay.includes(s)).length;

  const k401Signals = [
    "netbenefits",
    "retirement savings statement",
    "401k plan",
    "401(k) plan",
    "vested balance",
    "your personal rate of return",
    "change in market value",
    "market value of your account"
  ].filter((s) => hay.includes(s)).length;

  // HSA wins ties: an HSA statement can mention retirement wording in
  // boilerplate, but a 401(k) statement does not say "health savings account".
  if (hay.includes("health savings account") && hsaSignals >= 2) return "hsa";
  if (k401Signals >= 2) return "401k";
  if (hsaSignals >= 2) return "hsa";
  return null;
}

// Holdings are read from the specific section that lists them, not scraped
// from anywhere a name happens to precede a number. A loose scraper picked up
// contribution rows ("Employer Contributions $175.66") as if they were funds,
// and wrong holdings are worse than none.
function pfSection(text, startLabels, endLabels) {
  const lower = text.toLowerCase();
  let from = -1;
  for (const l of startLabels) {
    const i = lower.indexOf(l.toLowerCase());
    if (i >= 0 && (from < 0 || i < from)) from = i;
  }
  if (from < 0) return "";
  let to = text.length;
  for (const l of endLabels) {
    const i = lower.indexOf(l.toLowerCase(), from + 1);
    if (i >= 0 && i < to) to = i;
  }
  return text.slice(from, to);
}

// 401(k): the Additional Fund Information table gives the fund name alongside
// its stocks/bonds/other split — the most reliable place to read the name.
function pf401Holdings(text, endingValue) {
  const sec = pfSection(
    text,
    ["Additional Fund Information"],
    ["Blended investments generally", "Your Account Information", "Your Contribution Elections"]
  );
  const out = [];
  const re = /^[ \t]*([A-Z][A-Za-z0-9&'().\/-]*(?:[ \t]+[A-Za-z0-9&'().\/-]+){0,6}?)[ \t]+(\d{1,3})[ \t]*%[ \t]+(\d{1,3})[ \t]*%[ \t]+(\d{1,3})[ \t]*%[ \t]*$/gm;
  let m;
  let guard = 0;
  while ((m = re.exec(sec)) !== null && guard++ < 50) {
    const name = m[1].trim();
    if (/^(blended|investment|total|stocks|bonds|short)/i.test(name)) continue;
    out.push({ name });
  }
  // Only attach a market value when there is exactly one fund and we know the
  // account total — otherwise the split is unknown and inventing it is wrong.
  if (out.length === 1 && typeof endingValue === "number") out[0].market_value = endingValue;
  return out;
}

// HSA: the Top Holdings table, "DESCRIPTION $802 100%". Names can wrap, so the
// value row is matched and the preceding non-numeric lines form the name.
function pfHsaHoldings(text) {
  const sec = pfSection(
    text,
    ["Top Holdings", "Account Holdings", "Holdings"],
    ["Income Summary", "Contributions and Distributions", "Please note that"]
  );
  if (!sec) return [];
  const lines = sec.split("\n").map((l) => l.trim()).filter(Boolean);
  const out = [];
  let nameParts = [];
  for (const line of lines) {
    const m = line.match(/^(.*?)[ \t]*\$?\s*([\d,]+(?:\.\d{2})?)[ \t]+(\d{1,3})[ \t]*%[ \t]*$/);
    if (m) {
      const inline = m[1].trim();
      const name = (inline ? [...nameParts, inline] : nameParts).join(" ").trim();
      nameParts = [];
      const value = pfMoney(m[2]);
      if (!name || /^(total|description|percent|account)/i.test(name)) continue;
      if (value == null) continue;
      out.push({ name, market_value: value });
      continue;
    }
    // Column headers must reset the name buffer, not join it — otherwise
    // "Description Value" ends up prefixed onto the first holding's name.
    if (/^(top holdings|account holdings|holdings|description|value|percent of|account|description\s+value|percent)\b/i.test(line)) {
      nameParts = [];
      continue;
    }
    if (/\d/.test(line) && !/[A-Za-z]{3}/.test(line)) continue;
    nameParts.push(line);
    if (nameParts.length > 4) nameParts.shift();
  }
  return out;
}

function parseFidelityNetBenefitsStatement(rawText, monthHint) {
  const text = pfNormalizeText(rawText);
  const warnings = [];
  const period = pfFindPeriod(text) || pfPeriodFromMonth(monthHint);
  if (!pfFindPeriod(text) && period) warnings.push("Statement period taken from the month you selected.");

  const snapshot = {
    account_id: "fidelity_401k",
    statement_start: period ? period.start : null,
    statement_end: period ? period.end : null,
    beginning_value: pfFindAmount(text, ["Beginning Balance", "Beginning Value"]),
    ending_value: pfFindAmount(text, ["Ending Balance", "Ending Value", "Market Value of Your Account"]),
    vested_value: pfFindAmount(text, ["Vested Balance", "Vested Value"]),
    change_in_market_value: pfFindAmount(text, ["Change In Market Value", "Change in Market Value"]),
    personal_rate_of_return: pfFindPercent(text, [
      "Your Personal Rate of Return",
      "Personal Rate of Return"
    ])
  };

  const holdings = pf401Holdings(text, snapshot.ending_value);
  if (holdings.length) snapshot.holdings = holdings;
  else warnings.push("No fund holdings recognized.");

  // "Stocks Bonds Short-Term/Other" followed by three percentages.
  const alloc = text.match(
    /Stocks\s+Bonds\s+Short-?Term\s*\/?\s*Other[\s\S]{0,120}?(\d{1,3}(?:\.\d+)?)\s*%?\s+(\d{1,3}(?:\.\d+)?)\s*%?\s+(\d{1,3}(?:\.\d+)?)\s*%?/i
  );
  if (alloc) {
    const s = pfPercent(alloc[1]);
    const b = pfPercent(alloc[2]);
    const o = pfPercent(alloc[3]);
    if (s != null && b != null && o != null) {
      snapshot.allocation = { stocks_pct: s, bonds_pct: b, short_term_other_pct: o };
    }
  }
  if (!snapshot.allocation) warnings.push("Asset allocation not recognized.");
  if (snapshot.vested_value == null) warnings.push("Vested balance not recognized.");
  if (snapshot.personal_rate_of_return == null) warnings.push("Personal rate of return not recognized.");

  return { snapshot, warnings, type: "401k" };
}

function parseFidelityHsaStatement(rawText, monthHint) {
  const text = pfNormalizeText(rawText);
  const warnings = [];
  // Fidelity's HSA statement detail view carries no statement period at all, so
  // the month can be supplied explicitly in the import modal. That is user
  // input, not an inferred value.
  const period = pfFindPeriod(text) || pfPeriodFromMonth(monthHint);
  if (!pfFindPeriod(text) && period) warnings.push("Statement period taken from the month you selected.");

  const snapshot = {
    account_id: "fidelity_hsa",
    statement_start: period ? period.start : null,
    statement_end: period ? period.end : null,
    beginning_value: pfFindAmount(text, ["Beginning Account Value", "Beginning Value", "Beginning Balance"]),
    ending_value: pfFindAmount(text, [
      "Ending Account Value",
      "Ending Value",
      "Ending Balance",
      "Account Value"
    ]),
    change_from_last_period: pfFindAmount(text, [
      "Change from Last Period",
      "Change From Last Period",
      "Change in Account Value",
      "Change In Account Value"
    ]),
    // Fidelity's own wording. This is NOT purely market gain — it can include
    // distributions, income and other activity — so it keeps their label.
    change_in_investment_value: pfFindAmount(text, ["Change in Investment Value", "Change In Investment Value"])
  };

  const holdings = pfHsaHoldings(text);
  if (holdings.length) snapshot.holdings = holdings;

  if (snapshot.beginning_value == null) warnings.push("Beginning account value not recognized.");
  if (snapshot.change_from_last_period == null) warnings.push("Change from last period not recognized.");
  if (snapshot.change_in_investment_value == null) warnings.push("Change in investment value not recognized.");

  // Omit rather than invent: strip keys we could not read.
  Object.keys(snapshot).forEach((k) => {
    if (snapshot[k] == null && !["statement_start", "statement_end", "ending_value"].includes(k)) {
      delete snapshot[k];
    }
  });

  return { snapshot, warnings, type: "hsa" };
}

// ---------- portfolio: the universal statement engine ----------
//
// One engine, many statements. Fidelity's 401(k) and HSA parsers above were
// tuned against real statements and are kept exactly as they are — a Fidelity
// statement that imported before imports identically now. Every other statement
// goes through the generic reader below, which looks for the handful of figures
// nearly every investment statement prints (beginning and ending value, money in
// and out, market change, rate of return) under whichever of the common names
// the provider happens to use. Provider profiles only add that provider's own
// wording to the front of the list; they never replace the shared list, so an
// unfamiliar phrasing still has the generic names to fall back on.
//
// Named providers other than Fidelity were written from general knowledge of
// their statements, not from real pasted samples. That is why anything short of
// a confident read goes to a review step instead of being saved.

// Every figure a statement can carry, in the order a card lists them. The keys
// are the stored snapshot's own, so snapshots imported before this engine read
// exactly as they did.
const PF_FIELDS = [
  { key: "beginning_value", label: "Beginning value", kind: "money" },
  { key: "ending_value", label: "Ending value", kind: "money", required: true },
  { key: "contributions", label: "Contributions", kind: "money" },
  { key: "withdrawals", label: "Withdrawals", kind: "money" },
  { key: "income", label: "Dividends & interest", kind: "money" },
  { key: "fees", label: "Fees", kind: "money" },
  { key: "change_in_market_value", label: "Change in market value", kind: "money" },
  { key: "change_from_last_period", label: "Change from last period", kind: "money" },
  // Fidelity's HSA wording, kept: it is not purely market gain.
  { key: "change_in_investment_value", label: "Change in investment value", kind: "money" },
  { key: "vested_value", label: "Vested balance", kind: "money" },
  { key: "personal_rate_of_return", label: "Your personal rate of return", kind: "percent" }
];

// Figures whose label already says the money went out.
const PF_OUTFLOWS = new Set(["withdrawals", "fees"]);

// The shared vocabulary. Order is load-bearing: the first label that finds a
// value wins, so the specific names lead and the loose ones trail.
const PF_BASE_LABELS = {
  beginning_value: [
    "Beginning Balance", "Beginning Value", "Beginning Account Value", "Beginning Market Value",
    "Starting Balance", "Starting Value", "Opening Balance", "Opening Value",
    "Balance at Beginning of Period", "Value at Beginning of Period", "Beginning of Period Value",
    "Previous Balance", "Prior Balance"
  ],
  ending_value: [
    "Ending Balance", "Ending Value", "Ending Account Value", "Ending Market Value",
    "Closing Balance", "Closing Value", "Balance at End of Period", "Value at End of Period",
    "End of Period Value", "Total Account Value", "Market Value of Your Account", "Your Account Balance",
    "Total Account Balance", "Total Value", "Account Value", "Account Balance", "Current Balance", "Total Balance"
  ],
  contributions: ["Total Contributions", "Contributions/Deposits", "Deposits and Contributions", "Contributions", "Deposits", "Additions"],
  withdrawals: ["Total Withdrawals", "Withdrawals/Distributions", "Withdrawals", "Distributions"],
  income: ["Dividends and Interest", "Dividends & Interest", "Dividend and Capital Gain Income", "Total Income", "Dividends", "Income"],
  fees: ["Total Fees", "Fees and Expenses", "Fees & Expenses", "Administrative Fees", "Account Fees", "Fees"],
  change_in_market_value: [
    "Change in Market Value", "Market Value Change", "Change in Value of Investments", "Investment Gain/Loss",
    "Market Gain/Loss", "Gain/Loss", "Investment Earnings", "Change in Value"
  ],
  change_from_last_period: ["Change from Last Period", "Change in Account Value", "Net Change", "Total Change"],
  change_in_investment_value: ["Change in Investment Value"],
  vested_value: ["Total Vested Balance", "Vested Account Balance", "Vested Balance", "Vested Value"],
  personal_rate_of_return: [
    "Your Personal Rate of Return", "Personal Rate of Return", "Personal Performance",
    "Your Rate of Return", "Rate of Return", "Total Return"
  ]
};

// Words that, sitting right before a label, mean the match is a different
// figure. "Account Value" must not read "Beginning Account Value" as the ending
// value, nor "Change in Account Value"; "Contributions" must not read one
// source's line ("Employer Contributions") as the total. Checked in code rather
// than with a regex lookbehind, which older iOS WebKit can't compile.
const PF_AVOID_BEFORE = {
  ending_value:
    /(?:beginning|starting|opening|prior|previous|vested|average|change\s+(?:in|of|from)|net\s+change\s+in|deferral|employee|employer|match|source|fund)\s*$/i,
  // One source's line is never the total.
  contributions:
    /(?:employer|employee|your|company|matching|match|roth|(?:pre|after|before)\s*-?\s*tax|profit[\s-]*sharing|safe\s+harbor|voluntary|elective|non\s*-?\s*elective|deferral|rollover|catch\s*-?\s*up|year-to-date|ytd)\s*$/i,
  // "Capital gain distributions" are income paid out by funds, not money out.
  withdrawals: /(?:employer|employee|your|company|roth|(?:pre|after|before)\s*-?\s*tax|rollover|loan|capital\s+gains?|gain|dividend|income|fund|reinvested|year-to-date|ytd)\s*$/i,
  // Gains on the holdings list, not the account's change for the period.
  change_in_market_value: /(?:year-to-date|ytd|unrealized|realized|short-term|long-term|total\s+unrealized)\s*$/i,
  // "Fixed Income" is an asset class.
  income: /(?:fixed|year-to-date|ytd)\s*$/i,
  personal_rate_of_return: /(?:year-to-date|ytd|annualized|since\s+inception|\d-year|one-year|five-year|ten-year)\s*$/i
};

// Each provider's own wording, tried before the shared list.
const PF_PROFILES = {
  // Exactly the parsers Fidelity statements have always gone through.
  fidelity_401k: { provider: "Fidelity", type: "401k", legacy: (raw, hint) => parseFidelityNetBenefitsStatement(raw, hint) },
  fidelity_hsa: { provider: "Fidelity", type: "hsa", legacy: (raw, hint) => parseFidelityHsaStatement(raw, hint) },
  // Fidelity's other statements (brokerage, IRA) use its account-value wording.
  fidelity: {
    provider: "Fidelity",
    labels: {
      beginning_value: ["Beginning Account Value", "Beginning Net Account Value"],
      ending_value: ["Ending Account Value", "Ending Net Account Value"],
      change_in_investment_value: ["Change in Investment Value"]
    }
  },
  vanguard: {
    provider: "Vanguard",
    labels: {
      beginning_value: ["Beginning balance", "Balance on"],
      ending_value: ["Total account value", "Ending balance", "Your total assets"],
      change_in_market_value: ["Market value change", "Change in market value", "Investment gain/loss"],
      personal_rate_of_return: ["Personal performance", "Your personal rate of return"]
    }
  },
  empower: {
    provider: "Empower",
    labels: {
      beginning_value: ["Beginning Balance"],
      ending_value: ["Ending Balance", "Your Balance", "Account Balance"],
      contributions: ["Total Contributions"],
      change_in_market_value: ["Gain/Loss", "Investment Gain/Loss", "Change in Value"],
      personal_rate_of_return: ["Personal Rate of Return", "Rate of Return"]
    }
  },
  schwab: {
    provider: "Charles Schwab",
    labels: {
      beginning_value: ["Starting Value", "Beginning Value"],
      ending_value: ["Ending Value", "Total Account Value", "Account Value"],
      contributions: ["Deposits"],
      income: ["Dividends and Interest"],
      change_in_market_value: ["Change in Value of Investments"]
    }
  },
  generic: { provider: null, labels: {} }
};

const PF_PROVIDER_PROFILE = { Fidelity: "fidelity", Vanguard: "vanguard", Empower: "empower", "Charles Schwab": "schwab" };

// Recognising the provider. Strong signals are the company's own domain and
// legal names, which only appear on its own statements. A bare mention of the
// name counts for much less, and not at all when it's the start of a fund name:
// a Fidelity 401(k) holding "Vanguard Target Retirement 2050 Trust" is still a
// Fidelity statement.
const PF_BRANDS = {
  Fidelity: {
    strong: ["netbenefits", "fidelity.com", "fidelity investments", "fidelity brokerage services", "national financial services", "fidelity health savings account"],
    name: "fidelity"
  },
  Vanguard: { strong: ["vanguard.com", "vanguard brokerage services", "vanguard marketing corporation"], name: "vanguard" },
  Empower: {
    strong: ["empower.com", "empowermyretirement", "empower retirement", "empower financial services", "empower annuity", "great-west"],
    name: "empower"
  },
  "Charles Schwab": {
    strong: ["schwab.com", "charles schwab & co", "charles schwab and co", "schwab one", "charles schwab bank"],
    name: "schwab"
  }
};
const PF_FUND_WORDS = /\b(?:fund|funds|etf|index|target|trust|admiral|investor|institutional|portfolio|freedom|contrafund|spartan|select|growth|income|value|bond|stock|market|s&p|500|money)\b/i;

function pfCountPhrase(hay, phrase) {
  const esc = phrase.replace(/[.*+?^${}()|[\]\\]/g, "\\$&").replace(/\s+/g, "\\s+");
  const re = new RegExp("(^|[^a-z0-9])" + esc + "(?=$|[^a-z0-9])", "g");
  let n = 0;
  while (re.exec(hay) && n < 5) n++;
  return n;
}

function pfProviderScores(text) {
  const hay = pfNormalizeText(text).toLowerCase();
  const scores = {};
  Object.entries(PF_BRANDS).forEach(([provider, b]) => {
    let score = b.strong.reduce((s, p) => s + (pfCountPhrase(hay, p) ? 3 : 0), 0);
    const re = new RegExp("(^|[^a-z0-9])" + b.name + "(?=$|[^a-z0-9])", "g");
    let m;
    let named = 0;
    while ((m = re.exec(hay)) && named < 5) {
      // The rest of the line — or, when the name ends the line (a fund name a
      // PDF wrapped), the next one.
      const rest = hay.slice(m.index + m[0].length, m.index + m[0].length + 120).split("\n");
      const after = rest[0].trim() ? rest[0] : rest[1] || "";
      if (!PF_FUND_WORDS.test(after)) named++;
    }
    scores[provider] = score + named;
  });
  return scores;
}

// Which kind of account. Counted, not first-found: an IRA statement can mention
// the 401(k) it was rolled over from, but it says IRA more.
const PF_TYPE_SIGNALS = [
  ["hsa", ["health savings account", "hsa"]],
  ["roth_ira", ["roth ira"]],
  // Each mention once: "Rollover IRA" is one mention of an IRA, not two.
  ["ira", ["individual retirement account", "individual retirement arrangement", "ira"]],
  ["401k", ["401(k)", "401k", "401 (k)"]],
  ["403b", ["403(b)", "403b"]],
  ["457b", ["457(b)", "457b"]],
  ["529", ["529 plan", "529 college", "529 savings", "college savings plan"]],
  ["pension", ["pension plan", "defined benefit"]],
  ["brokerage", ["brokerage account", "individual brokerage", "joint brokerage", "individual account", "joint account", "joint tenants", "joint wros", "schwab one", "individual tod", "individual - tod"]]
];

function pfDetectType(text) {
  // Web addresses are ads and links, not the account: "fidelity.com/hsa" in a
  // brokerage statement's footer doesn't make it an HSA statement.
  const hay = pfNormalizeText(text).toLowerCase().replace(/\S+\.(?:com|org|net|gov)\S*/g, " ");
  // "Roth IRA" is an IRA too; counted once, as the more specific of the two.
  const withoutRoth = hay.replace(/roth\s+ira/g, "roth");
  // "Brokerage account" is also the wrapper name for retirement accounts
  // ("Roth IRA Brokerage Account"), so on a tie the retirement type wins.
  const scores = PF_TYPE_SIGNALS.map(([type, phrases]) => [
    type,
    phrases.reduce((s, p) => s + pfCountPhrase(type === "ira" ? withoutRoth : hay, p), 0)
  ]).sort((a, b) => b[1] - a[1] || (a[0] === "brokerage") - (b[0] === "brokerage"));
  const [top, second] = scores;
  if (!top[1]) return { type: null, sure: false };
  // The rule the Fidelity detector always had: an HSA statement can carry
  // retirement boilerplate, but nothing else says "health savings account".
  if (hay.includes("health savings account")) {
    const hsa = scores.find((s) => s[0] === "hsa");
    if (hsa[1] >= top[1]) return { type: "hsa", sure: true };
  }
  // Brokerage losing a tie is for "Roth IRA Brokerage Account" — an HSA only
  // mentioned in passing ("open a Fidelity HSA", in an ad) doesn't get it. An
  // HSA statement says "health savings account" somewhere.
  if (top[0] === "hsa" && !hay.includes("health savings account")) return { type: "hsa", sure: top[1] > second[1] };
  return { type: top[0], sure: top[1] > second[1] || second[0] === "brokerage" };
}

// Provider, account type, and how sure the read is.
function detectPortfolioStatement(rawText) {
  const text = pfNormalizeText(rawText);
  const scores = pfProviderScores(text);
  const ranked = Object.entries(scores).sort((a, b) => b[1] - a[1]);
  const [topName, top] = ranked[0];
  const [secondName, second] = ranked[1];
  const provider = top >= 2 ? topName : null;
  const mixed = !!provider && second >= 2 && second >= top - 1;
  const reasons = [];

  // Fidelity's own statements are recognised exactly as they always were —
  // with one exception. The HSA detector only ever needed "Beginning/Ending
  // Account Value", which every Fidelity brokerage and IRA statement prints
  // too. When nothing says HSA and the statement plainly says what else it
  // is, it isn't read as an HSA.
  // The shortcut only applies to a statement that is plainly Fidelity's and
  // plainly that kind of account. The old detector keys on wording — "Ending
  // Account Value", "Change in Market Value" — that any company's statement can
  // print, so on its own it filed a TIAA 403(b) into the Fidelity 401(k), and a
  // Fidelity brokerage statement with an HSA ad on it into the HSA.
  const kind = pfDetectType(text);
  const legacy = detectPortfolioStatementType(text);
  // NetBenefits statements are workplace plans, and they advertise IRAs and
  // brokerage accounts ("roll old plans into a Fidelity Rollover IRA"). So the
  // 401(k) reader only gives way to a statement that is surely a different
  // workplace plan — a 403(b), a 457(b), a pension, a 529.
  const fits =
    legacy === "hsa"
      ? kind.type === "hsa"
      : !(kind.sure && ["403b", "457b", "pension", "529"].includes(kind.type));
  if (legacy && provider === "Fidelity" && !mixed && fits) {
    const sure = legacy === "401k" || !kind.type || kind.sure;
    if (!sure) reasons.push("Couldn't tell for certain what kind of account this is.");
    return { profileId: `fidelity_${legacy}`, provider: "Fidelity", type: legacy, confidence: sure ? "high" : "low", reasons };
  }

  if (!provider) reasons.push("Couldn't tell which company this statement is from.");
  else if (mixed) reasons.push(`It reads partly like ${topName} and partly like ${secondName}.`);
  if (!kind.type) reasons.push("Couldn't tell what kind of account this is.");
  else if (!kind.sure) reasons.push("Couldn't tell for certain what kind of account this is.");

  return {
    profileId: provider ? PF_PROVIDER_PROFILE[provider] : "generic",
    provider,
    type: kind.type,
    confidence: provider && !mixed && kind.type && kind.sure ? "high" : "low",
    reasons
  };
}

// ---- reading figures ----

const PF_DATE_RE = "(?:\\d{1,2}\\/\\d{1,2}\\/\\d{2,4}|[A-Za-z]{3,9}\\.?\\s+\\d{1,2},?\\s+\\d{4}|\\d{4}-\\d{2}-\\d{2})";
// What can sit between a label and its value: column headings, footnote marks,
// an "as of" date, and a lone footnote number ("Ending Value 1 $12,000.00").
const PF_WIDE_FILLER =
  "(?:\\s|[:.*†‡]|This\\s+(?:Period|Quarter|Month)|Year-to-Date|Quarter-to-Date|Month-to-Date|YTD|QTD|" +
  "Period\\s+to\\s+date|Total|as\\s+of\\s+" + PF_DATE_RE + "|on\\s+" + PF_DATE_RE + "|\\(\\s*" + PF_DATE_RE + "\\s*\\)|" +
  PF_DATE_RE + ")*";
const PF_FOOTNOTE = "(?:[1-9]\\d?\\s+(?=[$(+-]|\\d{1,3}(?:,\\d{3})+|\\d+\\.\\d{2}))?";
// A sign has to touch its number (or its $). "Deposits - 2,000.00" is an empty
// this-period column followed by the year-to-date one, not minus two thousand.
const PF_MONEY_VALUE = "((?:[+-](?=[$(\\d]))?\\$?\\s*\\(?\\s*(?:[+-](?=[$\\d]))?\\$?\\s*(?:\\d{1,3}(?:,\\d{3})+|\\d+)(?:\\.\\d+)?\\s*\\)?)(?![\\d\\/%.,])";
// "-0.85%", "(0.85)%" and "(0.85%)" are all a loss.
const PF_PERCENT_VALUE = "(\\(\\s*\\d{1,3}(?:\\.\\d+)?\\s*(?:\\)\\s*%|%\\s*\\))|[+-]?\\d{1,3}(?:\\.\\d+)?\\s*%)";

// A number reads as money only if it looks like money: a dollar sign, cents,
// or thousands separators. A bare "3" after a label is a footnote or a count,
// and taking it as a balance would be worse than finding nothing.
function pfMoneyLike(raw) {
  const s = String(raw || "");
  // A lone 0 isn't a footnote (they start at 1); it's a figure of nothing.
  return /\$/.test(s) || /\.\d{2}\b/.test(s) || /\d,\d{3}/.test(s) || /^\s*0\s*$/.test(s);
}

function pfParseMoneyToken(raw) {
  let s = String(raw || "").replace(/\s+/g, "");
  let neg = false;
  if (/^[+-]/.test(s)) {
    neg = s[0] === "-";
    s = s.slice(1);
  }
  s = s.replace(/^\$/, "");
  if (/^[+-]/.test(s)) {
    neg = neg !== (s[0] === "-");
    s = s.slice(1);
  }
  const v = pfMoney(s);
  if (v == null) return null;
  return neg ? round2(-v) : v;
}

function pfFindLabeled(text, labels, kind = "money", avoid = null) {
  for (const label of labels || []) {
    const esc = label.replace(/[.*+?^${}()|[\]\\]/g, "\\$&").replace(/\s+/g, "\\s+");
    const value = kind === "percent" ? PF_PERCENT_VALUE : PF_FOOTNOTE + PF_MONEY_VALUE;
    const re = new RegExp("(^|[^A-Za-z])(" + esc + ")" + PF_WIDE_FILLER + value, "gi");
    let m;
    let guard = 0;
    while ((m = re.exec(text)) !== null && guard++ < 50) {
      const at = m.index + m[1].length;
      const lineStart = text.lastIndexOf("\n", at - 1) + 1;
      const before = text.slice(Math.max(lineStart, at - 32), at);
      // A skipped match resumes right after the label, not after the value:
      // the value pattern can swallow the line break that follows it, and the
      // next line's label then has nothing before it to anchor on.
      const skip = () => (re.lastIndex = at + 1);
      if (avoid && avoid.test(before)) {
        skip();
        continue;
      }
      const raw = m[3];
      // Labels across one line and values across the next ("Beginning balance
      // Ending balance" / "$45,102.10 $48,210.55"): the first number below
      // belongs to the first label, whichever label this is. There's no safe
      // way to line columns up from pasted text, so it isn't guessed at.
      const gap = m[0].slice(m[1].length + m[2].length, m[0].lastIndexOf(raw));
      if (gap.includes("\n") && /[A-Za-z]/.test(text.slice(lineStart, at))) {
        const valueAt = m.index + m[0].lastIndexOf(raw);
        const valueLine = text.slice(valueAt, (text.indexOf("\n", valueAt) + 1 || text.length + 1) - 1);
        const figuresOnLine = (valueLine.match(/\$?\(?\d{1,3}(?:,\d{3})*\.\d{2}\)?|\$\d[\d,]*/g) || []).length;
        // Several figures under a line of several labels: which is whose can't
        // be told from pasted text, and a later mention elsewhere is no safer.
        if (figuresOnLine > 1) break;
      }
      // "Rate of Return / Year-to-Date 7.10% / This Period (0.85%)": a value
      // reached by stepping over a year-to-date heading is the year's figure.
      if (/year-to-date|ytd/i.test(gap)) {
        skip();
        continue;
      }
      if (kind === "percent") {
        const neg = /^\s*\(/.test(raw);
        const v = pfPercent(raw.replace(/[()]/g, ""));
        if (v != null) return neg ? -Math.abs(v) : v;
        skip();
        continue;
      }
      if (!pfMoneyLike(raw)) {
        skip();
        continue;
      }
      const v = pfParseMoneyToken(raw);
      if (v != null) return v;
    }
  }
  return null;
}

// Periods the Fidelity reader doesn't need but other statements print:
// "April 1, 2026, through June 30, 2026", "June 1-30, 2026", "April 1 - June 30, 2026".
function pfFindPeriodWide(text) {
  // Every date range the statement prints, labelled ones first. Statements
  // also print year-to-date ranges ("Year-to-date (01/01/2026 - 06/30/2026)"),
  // so a range introduced as year-to-date is never the period, and a range a
  // month or a quarter long wins over a longer one.
  const dateAlt = "(\\d{1,2}\\/\\d{1,2}\\/\\d{2,4}|[A-Za-z]+\\.?\\s+\\d{1,2},?\\s+\\d{4}|\\d{4}-\\d{2}-\\d{2})";
  const sep = "\\s*,?\\s*(?:-|to|through|thru)\\s*";
  const ytd = /(?:year[\s-]*to[\s-]*date|ytd|year\s+ending|calendar\s+year|annual)[^\n]{0,24}$/i;
  const strong = [];
  const loose = [];
  const add = (at, a, b, into = loose) => {
    const start = pfDate(String(a).replace(/,$/, ""));
    const end = pfDate(b);
    if (!start || !end || start > end) return;
    const lineStart = text.lastIndexOf("\n", at - 1) + 1;
    if (ytd.test(text.slice(lineStart, at))) return;
    into.push({ start, end, at });
  };
  // Labels that name the statement's own period come first. Anything else —
  // "Fourth quarter 10/01 - 12/31" on an annual statement, a bare range — is
  // taken in the order the statement prints it.
  const labels = ["Statement Period", "Statement Dates", "Period Covered", "For the Period", "Reporting Period", "Statement for the period"];
  labels.forEach((label) => {
    const re = new RegExp(label.replace(/\s+/g, "\\s+") + "\\s*(?:of|from)?\\s*[:.]?\\s*" + dateAlt + sep + dateAlt, "gi");
    let m;
    let guard = 0;
    while ((m = re.exec(text)) !== null && guard++ < 20) add(m.index, m[1], m[2], strong);
  });
  const bare = new RegExp(dateAlt + sep + dateAlt, "gi");
  const head = text.slice(0, 4000);
  let m;
  let guard = 0;
  while ((m = bare.exec(head)) !== null && guard++ < 40) add(m.index, m[1], m[2]);
  strong.sort((a, b) => a.at - b.at);
  loose.sort((a, b) => a.at - b.at);
  const candidates = [...strong, ...loose];
  if (candidates.length) {
    const first = candidates[0];
    // A range from January 1 that ends where a later-starting one does is the
    // year-to-date column beside the period — unless the statement is annual.
    const annual = /\bannual\b|year-end statement/i.test(text.slice(0, 1500));
    // A range labelled as the statement's period is taken as it says.
    const inner = !strong.length && first.start.slice(5) === "01-01" && !annual && candidates.find((c) => c.end === first.end && c.start > first.start);
    const pick = inner || first;
    return { start: pick.start, end: pick.end };
  }

  // "June 1-30, 2026" and "April 1 - June 30, 2026": one year for both ends.
  const month = "(January|February|March|April|May|June|July|August|September|October|November|December|Jan|Feb|Mar|Apr|Jun|Jul|Aug|Sept?|Oct|Nov|Dec)\\.?";
  m = head.match(new RegExp(month + "\\s+(\\d{1,2})\\s*(?:-|to|through|thru)\\s*(\\d{1,2}),?\\s+(\\d{4})", "i"));
  if (m) {
    const mo = PF_MONTHS[m[1].toLowerCase()];
    const y = parseInt(m[4], 10);
    const start = pfIsoIfValid(y, mo, parseInt(m[2], 10));
    const end = pfIsoIfValid(y, mo, parseInt(m[3], 10));
    if (start && end && start <= end) return { start, end };
  }
  m = head.match(new RegExp(month + "\\s+(\\d{1,2})\\s*(?:-|to|through|thru)\\s*" + month + "\\s+(\\d{1,2}),?\\s+(\\d{4})", "i"));
  if (m) {
    const mo1 = PF_MONTHS[m[1].toLowerCase()];
    const mo2 = PF_MONTHS[m[3].toLowerCase()];
    const y2 = parseInt(m[5], 10);
    const y1 = mo1 > mo2 ? y2 - 1 : y2;
    const start = pfIsoIfValid(y1, mo1, parseInt(m[2], 10));
    const end = pfIsoIfValid(y2, mo2, parseInt(m[4], 10));
    if (start && end && start <= end) return { start, end };
  }
  return null;
}

// A single "as of" date — common on web pages and quarterly statements that
// print only when the period ended.
function pfFindAsOf(text) {
  const re = new RegExp(
    "(quarter\\s+end(?:ed|ing)|period\\s+end(?:ed|ing)|valued?\\s+as\\s+of|balance\\s+as\\s+of|as\\s+of|statement\\s+date)\\s*[:,]?\\s*(" +
      "\\d{1,2}\\/\\d{1,2}\\/\\d{2,4}|[A-Za-z]+\\.?\\s+\\d{1,2},?\\s+\\d{4}|\\d{4}-\\d{2}-\\d{2})",
    "i"
  );
  const m = text.match(re);
  if (!m) return null;
  const end = pfDate(m[2]);
  if (!end) return null;
  return { end, quarter: /quarter/i.test(m[1]) };
}

// The period a statement ending on `end` covers, when only the end is known.
function pfPeriodEndingOn(end, cadence) {
  if (!end) return null;
  const [y, m] = end.split("-").map(Number);
  const back = cadence === "quarterly" ? 2 : 0;
  const d = new Date(y, m - 1 - back, 1);
  return { start: toLocalISO(d), end };
}

// Stocks / bonds / cash, read only when all three are there and add up. A
// statement's asset classes that don't fold into those three are left out
// rather than forced into one.
function pfFindAllocation(text) {
  const accept = (s, b, o) =>
    s != null && b != null && o != null && s + b + o >= 98 && s + b + o <= 102
      ? { stocks_pct: s, bonds_pct: b, short_term_other_pct: o }
      : null;
  const hdr = text.match(
    /Stocks\s+Bonds\s+Short-?Term\s*\/?\s*Other[\s\S]{0,120}?(\d{1,3}(?:\.\d+)?)\s*%?\s+(\d{1,3}(?:\.\d+)?)\s*%?\s+(\d{1,3}(?:\.\d+)?)\s*%?/i
  );
  if (hdr) {
    const got = accept(pfPercent(hdr[1]), pfPercent(hdr[2]), pfPercent(hdr[3]));
    if (got) return got;
  }
  const sec = pfSection(text, ["Asset Allocation", "Asset Mix", "Asset Composition", "Investment Mix", "Asset Class"], []).slice(0, 1200);
  if (!sec) return null;
  const pick = (re) => {
    const m = sec.match(re);
    return m ? pfPercent(m[1]) : null;
  };
  return accept(
    pick(/\b(?:stocks?|equit(?:y|ies))\b[^%\n]{0,40}?(\d{1,3}(?:\.\d+)?)\s*%/i),
    pick(/\b(?:bonds?|fixed income)\b[^%\n]{0,40}?(\d{1,3}(?:\.\d+)?)\s*%/i),
    pick(/\b(?:short-term reserves|short-term\s*\/\s*other|short-term|cash(?:\s+(?:and|&)\s+cash\s+(?:investments|equivalents))?|money market)\b[^%\n]{0,40}?(\d{1,3}(?:\.\d+)?)\s*%/i)
  );
}

// The last four digits of every account number the statement prints. Read
// only to tell accounts apart and never kept — two different numbers mean the
// paste covers more than one account.
function pfAccountTails(text) {
  const out = new Set();
  const re = /(?:account\s*(?:number|no\.?|#)|acct\.?\s*(?:number|no\.?|#)?|ending\s+in)\s*[:#]?\s*([A-Za-z0-9*•xX-]+(?: [A-Za-z0-9*•xX-]+)*)/gi;
  let m;
  let guard = 0;
  while ((m = re.exec(text)) !== null && guard++ < 200) {
    // A linked bank or card account isn't this one.
    const lineStart = text.lastIndexOf("\n", m.index - 1) + 1;
    const prefix = text.slice(lineStart, m.index);
    if (/(?:bank|checking|routing|card|debit|credit)\b[^\n]{0,20}$/i.test(prefix)) continue;
    if (/savings\b[^\n]{0,20}$/i.test(prefix) && !/(?:health|retirement)\s+savings\b[^\n]{0,20}$/i.test(prefix)) continue;
    // The number is the first group, plus further groups only while what came
    // before was masking ("XXXX XXXX 5678"). A balance or "2 of 4" after it on
    // the same line isn't part of it.
    const groups = m[1].split(" ");
    let number = groups[0];
    // Further groups join only while they're more of the number: masking, or
    // three or more digits ("XXXX XXXX 5678", "6789 1234"). A balance
    // ("12,345.67") or a page count ("2 of 4") is not.
    for (let i = 1; i < groups.length && /^(?:[*•xX]+|\d{3,})$/.test(groups[i]); i++) number += " " + groups[i];
    const digits = number.replace(/\D/g, "");
    if (digits.length >= 4) out.add(digits.slice(-4));
  }
  return [...out];
}

// A long dash (— or –) standing alone right after a figure's label is an empty
// column — nothing this period — and reads as 0, so the year-to-date figure
// beside it isn't taken instead. Only long dashes, only after a word: a hyphen
// can be a minus sign ("- $1,234.56"), and a dash between dates is a range.
// Runs on the raw text, before long dashes become hyphens.
function pfNilDashes(raw) {
  return String(raw || "").replace(/([A-Za-z:)])([ \t\u00a0]+)[\u2013\u2014](?=[ \t\u00a0]+[$(\d]|[ \t\u00a0]*(?:\r?\n|$))/g, "$1$2 0 ");
}

function pfParseGeneric(text, profile, monthHint, cadence, figures = null) {
  const warnings = [];
  let period = pfFindPeriodWide(text);
  let periodFrom = period ? "statement" : null;
  if (!period) {
    const asOf = pfFindAsOf(text);
    if (asOf) {
      const span = asOf.quarter ? "quarterly" : cadence;
      period = pfPeriodEndingOn(asOf.end, span);
      periodFrom = "as-of";
      warnings.push(
        `The statement shows only its end date, so it's taken as covering the ${span === "quarterly" ? "quarter" : "month"} up to ${asOf.end}.`
      );
    }
  }
  if (!period) {
    period = pfPeriodFromMonth(monthHint, cadence);
    if (period) {
      periodFrom = "month";
      warnings.push("Statement period taken from the month you selected.");
    }
  }
  // Only the figures read this copy: long dashes standing for "none" are
  // zeros in it (see pfNilDashes). The period above is read from the original.
  figures = figures || text;
  const snapshot = {
    account_id: null,
    statement_start: period ? period.start : null,
    statement_end: period ? period.end : null
  };
  PF_FIELDS.forEach((f) => {
    const labels = [...new Set([...((profile.labels || {})[f.key] || []), ...(PF_BASE_LABELS[f.key] || [])])];
    const v = pfFindLabeled(figures, labels, f.kind, PF_AVOID_BEFORE[f.key] || null);
    if (v == null) return;
    // Money out is printed every which way — "-100.00", "(100.00)", "100.00"
    // under a Withdrawals heading. The label already says which direction it
    // went, so it's stored as the amount, and every statement reads alike.
    snapshot[f.key] = PF_OUTFLOWS.has(f.key) ? Math.abs(v) : v;
  });
  const allocation = pfFindAllocation(text);
  if (allocation) snapshot.allocation = allocation;
  // Holdings are only read for statements whose layout has been checked
  // against real ones. A wrong list of holdings is worse than none.
  return { snapshot, warnings, periodFrom };
}

function validatePortfolioSnapshot(snapshot, type) {
  const missing = [];
  if (!snapshot || !snapshot.statement_start) missing.push("statement start date");
  if (!snapshot || !snapshot.statement_end) missing.push("statement end date");
  if (!snapshot || typeof snapshot.ending_value !== "number") {
    missing.push(type === "hsa" ? "ending account value" : type === "401k" ? "ending balance" : "ending value");
  }
  if (snapshot && snapshot.statement_start && snapshot.statement_end && snapshot.statement_start > snapshot.statement_end) {
    missing.push("a statement period that ends after it starts");
  }
  return { ok: missing.length === 0, missing };
}

// ---- which of the user's accounts a statement belongs to ----

function pfSameProvider(a, b) {
  return String(a || "").trim().toLowerCase() === String(b || "").trim().toLowerCase();
}

function resolvePortfolioAccount(detected, accounts, text) {
  const list = (accounts || []).filter((a) => a && a.id);
  const tails = pfAccountTails(text || "");
  const hinted = (a) => !!a.account_hint && tails.includes(String(a.account_hint));
  const provider = detected && detected.provider;
  const type = detected && detected.type;
  // No recognisable provider: only accounts at providers the reader doesn't
  // know by name could be it.
  const pool = provider
    ? list.filter((a) => pfSameProvider(a.provider, provider))
    : list.filter((a) => !PF_PROVIDERS.some((p) => pfSameProvider(p, a.provider)));
  let candidates = type ? pool.filter((a) => a.type === type) : pool;
  const typeMatched = !!type && candidates.length > 0;
  // No account of that kind at this provider. A single account there is
  // probably it, set up under a different type.
  if (!candidates.length && pool.length === 1) candidates = pool;
  if (candidates.length > 1) {
    const byHint = candidates.filter(hinted);
    if (byHint.length === 1) candidates = byHint;
  }
  if (!candidates.length) {
    // The last 4 alone only speak for a statement whose company is unknown. A
    // Schwab statement is never a Vanguard account, whatever its digits.
    const byHint = provider ? [] : list.filter(hinted);
    if (byHint.length === 1) {
      return { account: byHint[0], candidates: byHint, confident: false, reason: "matched by account number only" };
    }
    // Several accounts at the provider, none of this kind: it's none of them,
    // and they're only offered as choices.
    return { account: null, candidates: pool, confident: false, reason: "none" };
  }
  const account = candidates.length === 1 ? candidates[0] : null;
  let reason = null;
  if (!account) reason = candidates.length ? "several" : "none";
  // The digits saved for the account are on the statement's own list of
  // numbers, or the statement shows none; any other number means it's a
  // different account at the same provider.
  else if (account.account_hint && tails.length && !tails.includes(String(account.account_hint))) reason = "number";
  else if (type && !typeMatched) reason = "type";
  else if (!provider) reason = "provider";
  return { account, candidates, confident: !!account && !reason, reason };
}

function pfSuggestedAccount(detected, period) {
  const provider = (detected && detected.provider) || "";
  const type = (detected && detected.type) || "other";
  const days = period && period.start && period.end ? daysBetween(period.start, period.end) : 0;
  return {
    provider,
    type,
    label: `${provider ? provider + " " : ""}${PF_TYPES[type] || PF_TYPES.other}`.trim(),
    cadence: days > 45 ? "quarterly" : "monthly"
  };
}

// Two snapshots say the same thing, whatever order their keys were written in.
function pfSameSnapshot(a, b) {
  const norm = (s) => {
    const out = {};
    Object.keys(s || {})
      .sort()
      .forEach((k) => {
        if (s[k] != null) out[k] = s[k];
      });
    return JSON.stringify(out);
  };
  return norm(a) === norm(b);
}

// Slow-moving is the premise: a retirement account doesn't normally move 40% in
// a statement. When it seems to, the likelier story is a misread figure or the
// wrong account, so it's shown for a check instead of saved.
const PF_JUMP_SHARE = 0.4;
const PF_JUMP_MIN = 250;

function pfJumpNote(snapshot, snapshots, account) {
  if (!account || !snapshot || typeof snapshot.ending_value !== "number") return null;
  const prior = (snapshots || [])
    .filter((s) => s.account_id === account.id && s.statement_end && (!snapshot.statement_end || s.statement_end < snapshot.statement_end))
    .sort((a, b) => (a.statement_end < b.statement_end ? -1 : 1))
    .slice(-1)[0];
  if (!prior || !(prior.ending_value > 0)) return null;
  const diff = snapshot.ending_value - prior.ending_value;
  const share = Math.abs(diff) / prior.ending_value;
  if (share <= PF_JUMP_SHARE || Math.abs(diff) < PF_JUMP_MIN) return null;
  return (
    `The ending value is ${Math.round(share * 100)}% ${diff > 0 ? "higher" : "lower"} than the last statement ` +
    `($${round2(prior.ending_value).toFixed(2)} on ${prior.statement_end}). That's a big move for this kind of ` +
    "account, so check the figure and the account before saving."
  );
}

// The whole read: which statement, which account, what it says, and whether
// it can be saved as is or needs a look first.
function parsePortfolioStatement(rawText, monthHint, { accounts = [], snapshots = [] } = {}) {
  const text = pfNormalizeText(rawText);
  const detected = detectPortfolioStatement(text);
  const profile = PF_PROFILES[detected.profileId] || PF_PROFILES.generic;
  const resolved = resolvePortfolioAccount(detected, accounts, text);
  const cadence = resolved.account ? pfCadence(resolved.account) : "monthly";

  const parsed = profile.legacy
    ? profile.legacy(rawText, monthHint)
    : pfParseGeneric(text, profile, monthHint, cadence, pfNormalizeText(pfNilDashes(rawText)));
  const snapshot = parsed.snapshot;
  // Fidelity's HSA reader falls back to a bare "Account Value", which also sits
  // inside "Beginning Account Value" — so a paste missing its ending line had
  // its beginning balance saved as the ending one. When the ending value
  // can't be found anywhere but a beginning line, it isn't known, and the
  // review asks for it.
  if (detected.profileId === "fidelity_hsa" && typeof snapshot.ending_value === "number") {
    const guarded = pfFindLabeled(text, ["Ending Account Value", "Ending Value", "Ending Balance", "Account Value"], "money", PF_AVOID_BEFORE.ending_value);
    if (guarded == null) snapshot.ending_value = null;
  }
  // Set in place so the key keeps its position — a stored snapshot is compared
  // with a fresh read of the same statement.
  snapshot.account_id = resolved.account ? resolved.account.id : null;

  // Nothing statement-shaped at all: no period, no ending value, and hardly any
  // of the figures a statement carries. Not worth a review form.
  const found = PF_FIELDS.filter((f) => snapshot[f.key] != null).length;
  if (!profile.legacy && snapshot.ending_value == null && !pfFindPeriodWide(text) && !pfFindAsOf(text) && found < 2) {
    return {
      ok: false,
      autoSave: false,
      detected,
      snapshot: null,
      warnings: [],
      missing: ["a recognizable investment or retirement statement"],
      review: []
    };
  }

  const type = detected.type;
  const check = validatePortfolioSnapshot(snapshot, profile.legacy ? type : null);
  const review = [...detected.reasons];
  const who = resolved.account ? resolved.account.label : null;
  const suggested = pfSuggestedAccount(detected, snapshot.statement_start ? { start: snapshot.statement_start, end: snapshot.statement_end } : null);
  if (resolved.reason === "none") {
    review.push(
      (accounts || []).length
        ? `This reads as ${suggested.label}, and none of your investment accounts matches — choose one, or add it.`
        : "Add the account this statement belongs to."
    );
  } else if (resolved.reason === "several") {
    review.push("More than one of your accounts could be this one — choose which.");
  } else if (resolved.reason === "number") {
    review.push(`The account number on this statement doesn't end in ${resolved.account.account_hint}, the digits saved for ${who}.`);
  } else if (resolved.reason === "type") {
    review.push(`This statement reads as ${PF_TYPES[type] || "a different kind of account"}, but ${who} is set up as ${PF_TYPES[resolved.account.type] || "another kind"}.`);
  } else if (resolved.reason === "provider" && who) {
    review.push(`Filed under ${who} as the only account it could be.`);
  } else if (resolved.reason === "matched by account number only") {
    review.push(`Matched to ${who} by its account number only.`);
  }
  if (!check.ok) review.push(`Couldn't find: ${check.missing.join(", ")}.`);
  // Fidelity's HSA detail view never prints a period, so it has always taken
  // the month picked; anything else that has none gets a look at the dates.
  if (parsed.periodFrom === "month") review.push("The statement shows no dates, so check the period below.");
  if (pfAccountTails(text).length > 1) {
    review.push(
      "This seems to cover more than one account (it shows several account numbers). The figures below may be combined totals."
    );
  }
  const jump = pfJumpNote(snapshot, snapshots, resolved.account);
  if (jump) review.push(jump);

  return {
    ok: true,
    autoSave: detected.confidence === "high" && resolved.confident && check.ok && review.length === 0,
    detected,
    profileId: detected.profileId,
    type,
    account: resolved.account,
    candidates: resolved.candidates,
    suggested,
    snapshot,
    warnings: parsed.warnings || [],
    missing: check.missing,
    review
  };
}

// ---------- portfolio reminders ----------

function portfolioMonthKey(dateStr) {
  return dateStr ? dateStr.slice(0, 7) : null;
}

function previousMonthKey(todayStr) {
  const [y, m] = todayStr.split("-").map(Number);
  const d = new Date(y, m - 1, 1);
  d.setMonth(d.getMonth() - 1);
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}`;
}

function pfCadence(account) {
  return account && Object.prototype.hasOwnProperty.call(PF_CADENCES, account.cadence) ? account.cadence : "monthly";
}

// The last month of the most recent quarter that has fully ended.
function lastQuarterEndKey(todayStr) {
  const [y, m] = todayStr.split("-").map(Number);
  const qm = Math.floor((m - 1) / 3) * 3;
  return qm === 0 ? `${y - 1}-12` : `${y}-${String(qm).padStart(2, "0")}`;
}

function nextMonthKey(key) {
  const [y, m] = key.split("-").map(Number);
  const d = new Date(y, m, 1);
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}`;
}

// "August 2026", or "Q2 2026" for a quarterly account.
function pfPeriodName(monthKey, cadence) {
  if (cadence === "quarterly") {
    const [y, m] = String(monthKey).split("-").map(Number);
    return `Q${Math.ceil(m / 3)} ${y}`;
  }
  return monthNameFromKey(monthKey);
}

// Authoritative on stored snapshot coverage alone — never on whether an import
// was attempted, acknowledged, or a file was seen.
//
// Monthly accounts: last month's statement, from the reminder day on (as it
// always was). Quarterly: the last finished quarter's, from the reminder day of
// the month after it ends, and until one is imported — a quarterly statement
// can take weeks to publish. "Don't remind me" never does.
function portfolioReminders(snapshots, accounts, todayStr = todayLocal(), reminderDay = PORTFOLIO_REMINDER_DAY) {
  const dayOfMonth = parseInt(todayStr.slice(8, 10), 10);
  const monthNow = todayStr.slice(0, 7);
  const snaps = snapshots || [];
  const out = [];
  (accounts || []).filter((a) => a && a.id).forEach((a) => {
    const cadence = pfCadence(a);
    if (cadence === "none") return;
    if (cadence === "quarterly") {
      const q = lastQuarterEndKey(todayStr);
      if (nextMonthKey(q) === monthNow && dayOfMonth < reminderDay) return;
      const covered = snaps.some((s) => s.account_id === a.id && (portfolioMonthKey(s.statement_end) || "") >= q);
      if (!covered) out.push({ account: a, monthKey: q, cadence });
      return;
    }
    if (dayOfMonth < reminderDay) return;
    const wanted = previousMonthKey(todayStr);
    if (!snaps.some((s) => s.account_id === a.id && portfolioMonthKey(s.statement_end) === wanted)) {
      out.push({ account: a, monthKey: wanted, cadence });
    }
  });
  return out;
}

function portfolioReminderText(r) {
  return `${pfPeriodName(r.monthKey, r.cadence)} ${r.account.label} statement hasn't been imported.`;
}

// Investment accounts as stored, tidied: every account has a label, a known
// type and a cadence, whatever an older version of the plugin wrote.
function normalizePortfolioAccounts(list) {
  return (Array.isArray(list) ? list : [])
    .filter((a) => a && typeof a === "object" && a.id)
    .map((a) => {
      const type = Object.prototype.hasOwnProperty.call(PF_TYPES, a.type) ? a.type : "other";
      const provider = String(a.provider || "").trim();
      return Object.assign({}, a, {
        provider,
        type,
        label: String(a.label || "").trim() || pfDefaultLabel(provider, type),
        cadence: pfCadence(a),
        account_hint: /^\d{4}$/.test(String(a.account_hint || "")) ? String(a.account_hint) : null
      });
    });
}

// A missing account file is rebuilt from what the snapshots still reference —
// never from a fixed list, so nobody is nagged about an account they never had.
function seedPortfolioAccounts(snapshots) {
  const used = new Set((snapshots || []).map((s) => s && s.account_id));
  return PF_LEGACY_ACCOUNTS.filter((a) => used.has(a.id)).map((a) => Object.assign({}, a));
}

// An investment account as the user described it, tidied. The last four digits
// are only for telling two accounts of the same kind apart; anything that isn't
// exactly four digits is dropped rather than half-kept.
function pfAccountFromForm(data, existing = null) {
  const provider = String((data && data.provider) || "").trim();
  const type = Object.prototype.hasOwnProperty.call(PF_TYPES, data && data.type) ? data.type : "other";
  const hint = String((data && data.account_hint) || "").replace(/\D/g, "");
  return normalizePortfolioAccounts([
    Object.assign({}, existing || {}, {
      id: (existing && existing.id) || genId("pf"),
      provider,
      type,
      label: String((data && data.label) || "").trim(),
      cadence: data && data.cadence,
      account_hint: hint.length === 4 ? hint : null
    })
  ])[0];
}

// "Fidelity 401(k)", or "Vanguard Roth IRA" — what an account is called until
// someone names it themselves.
function pfDefaultLabel(provider, type) {
  return `${provider ? String(provider).trim() + " " : ""}${PF_TYPES[type] || PF_TYPES.other}`.trim();
}

// A figure as a card or form shows it.
function pfFormatField(field, value) {
  if (value == null || !Number.isFinite(value)) return "";
  return field.kind === "percent" ? `${value}%` : `$${round2(value).toFixed(2)}`;
}

// Builds the snapshot a review form describes. Every figure the form holds is
// re-read from what's typed; anything the statement had that the form doesn't
// show (holdings, allocation) is carried over from the read. A blank field is
// left out, never saved as 0 — a missing figure and a zero one mean different
// things on a card.
function pfSnapshotFromForm(read, form) {
  const errors = [];
  const snapshot = {
    account_id: form.account_id || null,
    statement_start: normalizeDate(form.statement_start || "") || null,
    statement_end: normalizeDate(form.statement_end || "") || null
  };
  PF_FIELDS.forEach((f) => {
    const raw = (form.values || {})[f.key];
    const r = parseMoneyInput(raw, { allowNegative: !PF_OUTFLOWS.has(f.key), percent: f.kind === "percent" });
    if (!r.ok) errors.push(`${f.label}: ${r.message}`);
    else if (!r.empty) snapshot[f.key] = f.kind === "percent" ? r.value : round2(r.value);
  });
  if (read && read.allocation) snapshot.allocation = read.allocation;
  if (read && Array.isArray(read.holdings) && read.holdings.length) snapshot.holdings = read.holdings;
  const check = validatePortfolioSnapshot(snapshot, null);
  if (!snapshot.account_id) errors.unshift("Choose which account this statement belongs to.");
  check.missing.forEach((m) => errors.push(`Missing ${m}.`));
  return { snapshot, errors };
}

// An investment balance typed in by hand, as the snapshot a statement would
// have made: one day, with an ending value.
function buildManualBalance(form) {
  const r = pfSnapshotFromForm(null, {
    account_id: form.account_id,
    statement_start: form.date,
    statement_end: form.date,
    values: { ending_value: form.value }
  });
  if (r.errors.length) return { ok: false, error: r.errors[0].replace(/^Missing ending value\.$/, "Enter what it's worth.") };
  r.snapshot.manual = true;
  return { ok: true, snapshot: r.snapshot };
}

// Where a snapshot goes: one per account per statement end. Re-importing the
// same statement changes nothing; a different read of it needs saying so.
function pfPlaceSnapshot(snapshots, snapshot) {
  const index = (snapshots || []).findIndex(
    (s) => s && s.account_id === snapshot.account_id && s.statement_end === snapshot.statement_end
  );
  if (index < 0) return { status: "new", index };
  return { status: pfSameSnapshot(snapshots[index], snapshot) ? "same" : "replace", index };
}

// Month by month, what everything was worth: each account at its latest
// statement up to that month. Carrying values forward keeps a quarterly account
// in the total for the months between its statements, instead of the combined
// line dipping every time one account has no statement that month.
function portfolioHistory(snapshots, accounts) {
  const ids = (accounts || []).map((a) => a.id);
  const known = new Set(ids);
  const snaps = (snapshots || [])
    .filter((s) => s && known.has(s.account_id) && s.statement_end && Number.isFinite(s.ending_value))
    .sort((a, b) => (a.statement_end < b.statement_end ? -1 : 1));
  const months = [...new Set(snaps.map((s) => portfolioMonthKey(s.statement_end)))].sort();
  return months.map((mk) => {
    let total = 0;
    ids.forEach((id) => {
      let last = null;
      snaps.forEach((s) => {
        if (s.account_id === id && portfolioMonthKey(s.statement_end) <= mk) last = s;
      });
      if (last) total += last.ending_value;
    });
    return { month: mk, value: round2(total) };
  });
}

function monthNameFromKey(key) {
  const names = ["January","February","March","April","May","June","July","August","September","October","November","December"];
  const [y, m] = String(key).split("-").map(Number);
  return `${names[m - 1]} ${y}`;
}

// ---------- storage helpers ----------

async function ensureDataDir(app) {
  const adapter = app.vault.adapter;
  if (!(await adapter.exists(DATA_DIR))) await adapter.mkdir(DATA_DIR);
  if (!(await adapter.exists(IMPORT_DIR))) await adapter.mkdir(IMPORT_DIR);
}

async function readJSON(app, path, fallback) {
  const adapter = app.vault.adapter;
  if (!(await adapter.exists(path))) return fallback;
  try {
    return JSON.parse(await adapter.read(path));
  } catch (e) {
    console.error(`Budget Tracker: failed to parse ${path}`, e);
    return fallback;
  }
}

async function writeJSON(app, path, obj) {
  await app.vault.adapter.write(path, JSON.stringify(obj, null, 2));
}

// ---------- where a balance came from ----------
//
// An account's balance can arrive two ways: SimpleFIN reports it at a sync, or
// it's typed (Update balance, an account's Edit, Enter Paycheck). Each write is
// stamped with when it happened and which way it came, so that when two
// figures disagree the newer one wins, and so the dashboard can say which one
// it's showing. Without the stamp, the pay period's own copy of the checking
// balance — typed at Enter Paycheck — could quietly outlive every sync after it.

// The account whose balance is the period's cash on hand: the checking account
// that syncs through SimpleFIN if there is one, otherwise the first checking
// account. Taking the first checking account regardless meant an old CSV-only
// checking account listed ahead of the synced one kept cash on hand frozen.
function cashAccount(accounts) {
  const checking = (accounts || []).filter((a) => a && a.type === "checking");
  return checking.find((a) => a.simplefin_id) || checking[0] || null;
}

function stampBalance(account, source, at = new Date().toISOString()) {
  if (!account) return account;
  account.balance_updated_at = at;
  account.balance_source = source;
  return account;
}

// Whether this period's paycheck has reached the cash account: a deposit filed
// as Paycheck, or one within 2% of the paycheck entered, since a few days
// before it was entered. Without a paycheck amount there's nothing to add, so
// it counts as landed.
function paycheckLanded(inputs, account, transactions) {
  const amount = Number(inputs && inputs.paycheckAmount) || 0;
  if (!(amount > 0)) return true;
  const from = addDays(inputs.enteredOn || inputs.periodStartStr || inputs.todayStr || todayLocal(), -3);
  const tolerance = Math.max(1, amount * 0.02);
  return (transactions || []).some(
    (t) =>
      t &&
      !t.pending &&
      t.date &&
      t.date >= from &&
      Number(t.amount) > 0 &&
      (!t.account_id || !account || t.account_id === account.id) &&
      (t.resolved_category === "Paycheck" || Math.abs(Number(t.amount) - amount) <= tolerance)
  );
}

// Brings the period's cash-on-hand figure up to the cash account's balance when
// the account's is newer (changed in place; returns whether it did). An account
// balance with no stamp — written before stamps existed — can't be ordered
// against anything, so the period keeps its own until the next sync or edit
// stamps one.
//
// A period entered before its paycheck landed adds the paycheck on top of the
// balance. A newer balance only drops that once the deposit shows up; assuming
// it had landed (as syncing used to) took the paycheck off cash on hand
// whenever a sync came first.
function adoptCashBalance(inputs, accounts, transactions) {
  if (!inputs) return false;
  const acct = cashAccount(accounts);
  if (!acct || acct.current_balance == null || acct.current_balance === "" || !Number.isFinite(Number(acct.current_balance))) return false;
  const at = acct.balance_updated_at || null;
  if (!at) return false;
  if (inputs.checkingBalanceAt && inputs.checkingBalanceAt >= at && inputs.checkingAccountId === acct.id) return false;
  inputs.checkingBalance = round2(Number(acct.current_balance));
  inputs.checkingBalanceAt = at;
  inputs.checkingBalanceSource = acct.balance_source || null;
  inputs.checkingAccountId = acct.id;
  if (!inputs.alreadyDeposited && paycheckLanded(inputs, acct, transactions)) inputs.alreadyDeposited = true;
  inputs.autoRolled = false;
  return true;
}

// "from SimpleFIN · Sep 28, 9:14 AM", "typed · Sep 20" — where a balance came
// from and when, for the dashboard and settings.
function balanceSourceText(source, at) {
  const stamp = at ? new Date(at) : null;
  const age = stamp && !isNaN(stamp.getTime()) ? daysBetween(toLocalISO(stamp), todayLocal()) : 0;
  const when = at ? formatStampShort(at) + (age > SIMPLEFIN_STALE_BALANCE_DAYS ? ` (${age} days old)` : "") : "";
  const how = source === "simplefin" ? "from SimpleFIN" : source === "paycheck" ? "typed in Enter Paycheck" : source ? "entered by hand" : "";
  return [how, when].filter(Boolean).join(" · ");
}

function formatStampShort(iso) {
  const d = new Date(iso);
  if (isNaN(d.getTime())) return "";
  const date = formatChartDate(toLocalISO(d)).replace(`, ${todayLocal().slice(0, 4)}`, "");
  const h = d.getHours();
  const time = `${h % 12 || 12}:${String(d.getMinutes()).padStart(2, "0")} ${h < 12 ? "AM" : "PM"}`;
  return `${date}, ${time}`;
}

// ---------- first-time setup ----------
//
// Everything the plugin keeps, written out so a new vault has the full layout
// from the start: the Budget folder with data, imports and exports, every data
// file at its empty starting value, and a short README. Only what's missing is
// created. A file that exists is never touched, even one that can't be read
// (that's reported, not "repaired" by overwriting someone's data).
//
// Two files are left to appear on their own: the active pay period (written
// when you first enter a paycheck) and the category order (written at the
// first import). Neither has an empty value that means anything.
const SETUP_FOLDERS = ["Budget", DATA_DIR, IMPORT_DIR, EXPORT_DIR];
const SETUP_SKIP = new Set(["activePeriod", "categoryOrder"]);
const SETUP_README = "Budget/README.md";

// A fresh vault's categories. The flags are what matter: card payments and
// savings moves are transfers, not spending; gas is a necessity the budget
// reserves for; a phone bill is a bill. Only used when categories.json doesn't
// exist yet, never merged into one that does.
const STARTER_CATEGORIES = [
  { name: "Groceries", is_transfer: false },
  { name: "Eating Out", is_transfer: false },
  { name: "Gas", is_transfer: false, is_variable_necessity: true },
  { name: "Rent", is_transfer: false },
  { name: "Utilities", is_transfer: false },
  { name: "Phone Bill", is_transfer: false, exclude_from_discretionary: true },
  { name: "Car Insurance", is_transfer: false },
  { name: "Subscription", is_transfer: false },
  { name: "Shopping", is_transfer: false },
  { name: "Entertainment", is_transfer: false },
  { name: "Misc.", is_transfer: false },
  { name: "BNPL", is_transfer: false },
  { name: "Credit Card Payment", is_transfer: true },
  { name: "Savings", is_transfer: true },
  { name: "Paycheck", is_transfer: false },
  { name: "Refund", is_transfer: false }
];

function setupStartingValue(key, settings) {
  if (key === "categories") return STARTER_CATEGORIES.map((c) => Object.assign({}, c));
  if (key === "settings") return Object.assign({}, DEFAULT_SETTINGS, settings || {});
  if (key === "simplefinAccounts") return {};
  return [];
}

const SETUP_README_TEXT = `# Budget Tracker

This folder holds everything the Budget Tracker plugin keeps.

- **data/**: the plugin's own files (accounts, debts, bills, goals, transactions, rules). Change them from the plugin rather than by hand.
- **imports/**: drop bank CSV exports here, then run **Import CSV**. A clean import deletes the CSV, so keep your own copy in another folder.
- **exports/**: **Export** saves read-only Markdown notes here (and a CSV with the snapshot), rewritten on each export. Editing them changes nothing in the plugin.

Open the dashboard from the wallet icon in the ribbon, or the command palette: "Budget Tracker: Open in sidebar". Settings → Budget Tracker has everything else.
`;

// What's there and what isn't, without changing anything.
async function setupStatus(app) {
  const adapter = app.vault.adapter;
  const missingFolders = [];
  for (const f of SETUP_FOLDERS) if (!(await adapter.exists(f))) missingFolders.push(f);
  const missingFiles = [];
  const unreadable = [];
  let present = 0;
  for (const [key, path] of Object.entries(FILES)) {
    if (SETUP_SKIP.has(key)) continue;
    if (!(await adapter.exists(path))) {
      missingFiles.push(path);
      continue;
    }
    present++;
    try {
      JSON.parse(await adapter.read(path));
    } catch (e) {
      unreadable.push(path);
    }
  }
  const readme = await adapter.exists(SETUP_README);
  return { missingFolders, missingFiles, unreadable, present, total: present + missingFiles.length, readme };
}

// Creates whatever's missing. Returns what it made, and what it left alone.
async function setupBudgetVault(app, settings = {}) {
  const adapter = app.vault.adapter;
  const folders = [];
  for (const f of SETUP_FOLDERS) {
    if (!(await adapter.exists(f))) {
      await adapter.mkdir(f);
      folders.push(f);
    }
  }
  const files = [];
  let kept = 0;
  const unreadable = [];
  for (const [key, path] of Object.entries(FILES)) {
    if (SETUP_SKIP.has(key)) continue;
    if (await adapter.exists(path)) {
      kept++;
      try {
        JSON.parse(await adapter.read(path));
      } catch (e) {
        unreadable.push(path);
      }
      continue;
    }
    await writeJSON(app, path, setupStartingValue(key, settings));
    files.push(path);
  }
  if (!(await adapter.exists(SETUP_README))) {
    await adapter.write(SETUP_README, SETUP_README_TEXT);
    files.push(SETUP_README);
  }
  return { folders, files, kept, unreadable, starterCategories: files.includes(FILES.categories) };
}

// ---------- CSV parsing ----------

// Proper quote-aware CSV parser — handles commas and newlines inside quoted
// fields, and escaped quotes ("" inside a quoted field means a literal ").
function parseCSV(text) {
  const rows = [];
  let row = [];
  let field = "";
  let inQuotes = false;
  let i = 0;
  const len = text.length;

  while (i < len) {
    const char = text[i];
    if (inQuotes) {
      if (char === '"') {
        if (text[i + 1] === '"') {
          field += '"';
          i += 2;
          continue;
        }
        inQuotes = false;
        i++;
        continue;
      }
      field += char;
      i++;
      continue;
    }
    if (char === '"') {
      inQuotes = true;
      i++;
      continue;
    }
    if (char === ",") {
      row.push(field);
      field = "";
      i++;
      continue;
    }
    if (char === "\r") {
      i++;
      continue;
    }
    if (char === "\n") {
      row.push(field);
      rows.push(row);
      row = [];
      field = "";
      i++;
      continue;
    }
    field += char;
    i++;
  }
  if (field.length > 0 || row.length > 0) {
    row.push(field);
    rows.push(row);
  }
  return rows.filter((r) => !(r.length === 1 && r[0].trim() === ""));
}

function toNumber(str) {
  if (!str) return 0;
  return parseFloat(String(str).replace(/[$,]/g, "")) || 0;
}

// Normalizes M/D/YYYY, MM/DD/YYYY, or YYYY-MM-DD into YYYY-MM-DD so date
// string comparisons work consistently throughout the plugin.
function normalizeDate(dateStr) {
  if (!dateStr) return dateStr;
  const trimmed = dateStr.trim();
  if (/^\d{4}-\d{2}-\d{2}$/.test(trimmed)) return trimmed;
  const m = trimmed.match(/^(\d{1,2})\/(\d{1,2})\/(\d{4})$/);
  if (m) {
    const [, mo, d, y] = m;
    return `${y}-${mo.padStart(2, "0")}-${d.padStart(2, "0")}`;
  }
  return trimmed;
}

// Locates a column by header name: exact matches first, then substring, so a
// header of "Amount" wins over "Transaction Amount Type" when both exist.
function findCol(header, candidates) {
  for (const c of candidates) {
    const i = header.findIndex((h) => h === c);
    if (i >= 0) return i;
  }
  for (const c of candidates) {
    const i = header.findIndex((h) => h.includes(c));
    if (i >= 0) return i;
  }
  return -1;
}

function cell(row, idx) {
  return idx >= 0 && idx < row.length ? row[idx] : "";
}

// Header aliases, widened to cover the exports people actually have. Order is
// load-bearing: findCol tries an EXACT match against every candidate first, then
// falls back to a substring pass in this same order. So the specific names lead
// and the loose catch-alls trail, which is why "date" can sit in the same list
// as "posting date" without swallowing it.
const DATE_COLS = ["transaction date", "posting date", "posted date", "post date", "trans. date", "clearing date", "date"];
const DESC_COLS = ["description", "payee", "merchant", "extended description", "memo", "name", "title"];
const AMOUNT_COLS = ["amount", "transaction amount", "amount (usd)", "billed amount", "transaction amount (usd)"];
// "category" trails deliberately. It is a last resort for exports that have no
// type column at all, and it only ever decides a SIGN — see the sign-enforcement
// block in parseGenericBank, which falls through to trusting the file whenever
// the value doesn't name a direction.
const TYPE_COLS = ["transaction type", "type", "category"];
const EFFECTIVE_DATE_COLS = ["effective date"];
const STATUS_COLS = ["posting status", "status"];
const TXID_COLS = ["transaction id", "reference number", "reference"];

// Pending holds have no posting date — the bank leaves both date columns empty
// until they settle. The Transaction ID still begins with the expected posting
// date ("20260918 65013 6,750 0"), which is the only date the row carries.
function dateFromTxId(v) {
  const m = String(v || "").trim().match(/^(\d{4})(\d{2})(\d{2})/);
  if (!m) return "";
  const iso = `${m[1]}-${m[2]}-${m[3]}`;
  return isNaN(new Date(`${iso}T00:00:00`).getTime()) ? "" : iso;
}

// Capital One exports come in more than one shape. Older/most common:
//   Transaction Date, Posted Date, Card No., Description, Category, Debit, Credit
// Others use a single signed Amount column, sometimes paired with a
// Transaction Type (Debit/Credit) that carries the sign instead.
// This parser handles all of those and reports when it cannot find an amount
// at all, rather than silently writing every transaction as $0.00.
function parseCapitalOne(csvText, accountId) {
  const rows = parseCSV(csvText);
  if (rows.length < 2) return { transactions: [], warnings: ["The file has no data rows."] };

  const header = rows[0].map((h) => h.toLowerCase().trim());
  const idx = {
    date: findCol(header, DATE_COLS),
    desc: findCol(header, DESC_COLS),
    amount: findCol(header, AMOUNT_COLS),
    debit: findCol(header, ["debit"]),
    credit: findCol(header, ["credit"]),
    type: findCol(header, TYPE_COLS)
  };

  const warnings = [];
  const hasSignedAmount = idx.amount >= 0;
  const hasDebitCredit = idx.debit >= 0 || idx.credit >= 0;

  if (!hasSignedAmount && !hasDebitCredit) {
    warnings.push(
      `Couldn't find an amount column. Headers seen: ${rows[0].join(", ")}. ` +
        "Expected either an \u201cAmount\u201d column or \u201cDebit\u201d/\u201cCredit\u201d columns."
    );
    return { transactions: [], warnings };
  }
  if (idx.date < 0) warnings.push("Couldn't find a date column; dates will be blank.");
  if (idx.desc < 0) warnings.push("Couldn't find a description column; merchant names will be blank.");

  const out = [];
  let zeroCount = 0;

  for (let i = 1; i < rows.length; i++) {
    const r = rows[i];
    if (r.length < 2) continue;

    let amount;
    if (hasSignedAmount) {
      const raw = toNumber(cell(r, idx.amount));
      const typeVal = cell(r, idx.type).toLowerCase();
      // When a type column is present it, not the sign in the file, is authoritative.
      if (typeVal.includes("debit") || typeVal.includes("purchase") || typeVal.includes("withdrawal")) {
        amount = -Math.abs(raw);
      } else if (typeVal.includes("credit") || typeVal.includes("payment") || typeVal.includes("refund") || typeVal.includes("deposit")) {
        amount = Math.abs(raw);
      } else {
        amount = raw; // already signed
      }
    } else {
      const debit = toNumber(cell(r, idx.debit));
      const credit = toNumber(cell(r, idx.credit));
      amount = credit > 0 ? credit : -debit; // spend is negative
    }

    if (amount === 0) zeroCount++;

    out.push({
      id: genId("tx"),
      date: normalizeDate(cell(r, idx.date)),
      merchant_raw: cell(r, idx.desc),
      amount,
      account_id: accountId,
      resolved_category: null,
      override_label: null
    });
  }

  if (out.length > 0 && zeroCount === out.length) {
    warnings.push(
      `Every row parsed as $0.00 \u2014 the amount column was found but held no readable numbers. ` +
        `Headers seen: ${rows[0].join(", ")}.`
    );
  } else if (zeroCount > 0) {
    warnings.push(`${zeroCount} of ${out.length} rows had a $0.00 amount.`);
  }

  return { transactions: out, warnings };
}

// Generic bank adapter: a single signed Amount column, a posting date, and a
// description. Confirmed against an export with columns: Transaction ID,
// Posting Date, Effective Date, Transaction Type, Posting Status, Amount,
// Check Number, Reference Number, Description, Transaction Category, Type,
// Balance, Memo, Extended Description
function parseGenericBank(csvText, accountId, options = {}) {
  const rows = parseCSV(csvText);
  if (rows.length < 2) return { transactions: [], warnings: ["The file has no data rows."] };

  const header = rows[0].map((h) => h.toLowerCase().trim());
  const idx = {
    date: findCol(header, DATE_COLS),
    effective: findCol(header, EFFECTIVE_DATE_COLS),
    status: findCol(header, STATUS_COLS),
    txid: findCol(header, TXID_COLS),
    desc: findCol(header, DESC_COLS),
    amount: findCol(header, AMOUNT_COLS),
    type: findCol(header, TYPE_COLS),
    debit: findCol(header, ["debit"]),
    credit: findCol(header, ["credit"])
  };

  const warnings = [];
  if (idx.amount < 0 && idx.debit < 0 && idx.credit < 0) {
    warnings.push(`Couldn't find an amount column. Headers seen: ${rows[0].join(", ")}.`);
    return { transactions: [], warnings };
  }
  if (idx.date < 0) warnings.push("Couldn't find a date column; dates will be blank.");
  if (idx.desc < 0) warnings.push("Couldn't find a description column; merchant names will be blank.");

  const out = [];
  let zeroCount = 0;
  let undated = 0;
  let pendingCount = 0;

  for (let i = 1; i < rows.length; i++) {
    const r = rows[i];
    if (r.length < 2) continue;

    // Two steps, in this order, and the order is the whole trick.
    //
    // FIRST normalise the file's sign convention. The account flag says "in this
    // export, a positive number means money went OUT" — a statement about the
    // amount column, not about anything else in the row. Flipping it here means
    // everything downstream reasons in one convention: negative is spending.
    //
    // THEN let a type column settle what the sign could not. It only gets a say
    // when the figure is positive, because a negative number is a sign the file
    // has already committed to, and overruling it is how a row categorised
    // "Credit Card Payment" turned a real payment into an inflow.
    //
    // Doing it the other way round double-negates an Apple Card export, which
    // has BOTH positive purchases and a Type column saying "Purchase": the type
    // would force negative, then the flag would flip it straight back.
    let amount;
    if (idx.amount >= 0) {
      let raw = toNumber(cell(r, idx.amount));
      if (options.invertPositiveCharges) raw = -raw;

      if (idx.type >= 0 && raw > 0) {
        const typeVal = cell(r, idx.type).toLowerCase();
        if (
          typeVal.includes("debit") ||
          typeVal.includes("purchase") ||
          typeVal.includes("withdrawal") ||
          typeVal.includes("sale")
        ) {
          amount = -Math.abs(raw);
        } else if (
          typeVal.includes("credit") ||
          typeVal.includes("payment") ||
          typeVal.includes("refund") ||
          typeVal.includes("deposit")
        ) {
          amount = Math.abs(raw);
        } else {
          amount = raw; // ambiguous type — the file's sign is the better guess
        }
      } else {
        // Either no type column, or the file already committed to a sign.
        amount = raw;
      }
    } else {
      // Debit/Credit columns name the direction outright, so there is no sign
      // convention to normalise and the flag deliberately does not apply here.
      // Inverting a column literally labelled "Debit" would only ever be wrong.
      const debit = toNumber(cell(r, idx.debit));
      const credit = toNumber(cell(r, idx.credit));
      amount = credit > 0 ? credit : -debit;
    }
    if (amount === 0) zeroCount++;

    const pending = cell(r, idx.status).toLowerCase().includes("pending");
    if (pending) pendingCount++;

    // Posting Date, then Effective Date, then the date embedded in the
    // Transaction ID — pending holds have both date columns empty.
    const resolvedDate =
      normalizeDate(cell(r, idx.date)) ||
      normalizeDate(cell(r, idx.effective)) ||
      dateFromTxId(cell(r, idx.txid));
    if (!resolvedDate) undated++;

    out.push({
      id: genId("tx"),
      date: resolvedDate,
      merchant_raw: cell(r, idx.desc),
      amount,
      account_id: accountId,
      resolved_category: null,
      override_label: null,
      pending: pending || undefined
    });
  }

  if (out.length > 0 && zeroCount === out.length) {
    warnings.push(`Every row parsed as $0.00. Headers seen: ${rows[0].join(", ")}.`);
  } else if (zeroCount > 0) {
    warnings.push(`${zeroCount} of ${out.length} rows had a $0.00 amount.`);
  }
  if (pendingCount) warnings.push(`${pendingCount} pending transaction(s) imported, dated from the bank's expected posting date.`);
  if (undated) warnings.push(`${undated} row(s) had no usable date at all.`);

  return { transactions: out, warnings };
}

const ADAPTERS = { capital_one: parseCapitalOne, mainbank: parseGenericBank };

// ---------- categorization ----------

function findMatchingRule(merchantRaw, rules) {
  const upper = (merchantRaw || "").toUpperCase();
  const index = rules.findIndex((r) => r.merchant_pattern && upper.includes(r.merchant_pattern.toUpperCase()));
  return index >= 0 ? { rule: rules[index], index } : null;
}

// The name shown in the UI: a rule's nickname if one is set, otherwise the
// best guess from the raw description. merchant_raw is always preserved and
// surfaced as a tooltip.
function displayMerchant(merchantRaw, rules) {
  const hit = findMatchingRule(merchantRaw, rules || []);
  if (hit && hit.rule.display_name) return hit.rule.display_name;
  return guessMerchantKey(merchantRaw);
}

// Grouping key for the subscription audit. Matching a rule is the strongest
// signal available — it consolidates charges whose raw text varies every month.
function subscriptionGroupKey(merchantRaw, rules) {
  const hit = findMatchingRule(merchantRaw, rules || []);
  if (hit) return hit.rule.display_name || hit.rule.merchant_pattern;
  return guessMerchantKey(merchantRaw) || merchantRaw || "Unknown";
}

// What a merchant pattern would actually do, as opposed to how much text it
// contains. Rules are checked in order and the first match wins, and a one-off
// override beats every rule — so a plain substring count overstates what a rule
// will categorize whenever an earlier rule or an override already has some of
// those transactions. This mirrors findMatchingRule exactly.
//
// selfIndex is the rule's position in `rules` when editing an existing one. A
// rule not saved yet is appended at the end, so every existing match beats it.
function patternReach(pattern, transactions, rules = [], selfIndex = null) {
  const p = String(pattern || "").trim().toUpperCase();
  if (!p) return null;
  const list = rules || [];
  const position = selfIndex == null ? list.length : selfIndex;
  const out = { matches: 0, overridden: 0, claimed: 0, categorizes: 0, claimedBy: [] };
  const byRule = new Map();
  (transactions || []).forEach((t) => {
    const raw = String((t && t.merchant_raw) || "").toUpperCase();
    if (!raw.includes(p)) return;
    out.matches++;
    if (t.override_label) {
      out.overridden++;
      return;
    }
    let earlier = -1;
    for (let i = 0; i < position; i++) {
      const r = list[i];
      if (r && r.merchant_pattern && raw.includes(String(r.merchant_pattern).toUpperCase())) {
        earlier = i;
        break;
      }
    }
    if (earlier >= 0) {
      out.claimed++;
      const name = list[earlier].display_name || list[earlier].merchant_pattern;
      byRule.set(name, (byRule.get(name) || 0) + 1);
      return;
    }
    out.categorizes++;
  });
  out.claimedBy = [...byRule.entries()]
    .sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))
    .map(([name, count]) => ({ name, count }));
  return out;
}

// The index a save would edit: the same pattern+label lookup every rule-saving
// path uses. null for a rule that doesn't exist yet.
function ruleIndexOf(rules, rule) {
  if (!rule) return null;
  const i = (rules || []).findIndex(
    (r) => r && r.merchant_pattern === rule.merchant_pattern && r.home_label === rule.home_label
  );
  return i >= 0 ? i : null;
}

// The sentence under a pattern field. `sample` is a raw description the pattern
// is meant to catch — the transaction being labelled — so a pattern that has
// drifted away from its own row says so before anything is saved.
function describePatternReach(reach, sample = null, pattern = "") {
  if (!reach) return { text: "Enter a pattern to see what it would match.", warn: false };
  const tx = (n) => `${n} transaction${n === 1 ? "" : "s"}`;
  const p = String(pattern || "").trim().toUpperCase();
  if (sample && p && !String(sample).toUpperCase().includes(p)) {
    return { text: "Doesn’t match the transaction you’re labelling — check it against the raw bank text above.", warn: true };
  }
  if (reach.matches === 0) {
    return { text: "Matches nothing in your history yet — check it against the raw bank text.", warn: true };
  }
  if (reach.categorizes === reach.matches) {
    return { text: `Will categorize ${tx(reach.matches)}.`, warn: false };
  }
  const why = [];
  reach.claimedBy
    .slice(0, 2)
    .forEach((c) => why.push(`${c.count} already ${c.count === 1 ? "goes" : "go"} to the “${c.name}” rule`));
  const more = reach.claimedBy.slice(2).reduce((s, c) => s + c.count, 0);
  if (more) why.push(`${more} to other rules`);
  if (reach.overridden) why.push(`${reach.overridden} ${reach.overridden === 1 ? "has" : "have"} a one-off override`);
  return {
    text: `Matches ${tx(reach.matches)} — will categorize ${reach.categorizes}. ${why.join("; ")}.`,
    warn: reach.categorizes === 0
  };
}

// Longest shared opening text across a group's raw descriptions, trimmed to a
// word boundary — a sensible default pattern when nicknaming a group.
function commonBaseName(strings) {
  if (!strings || strings.length === 0) return "";
  let prefix = strings[0];
  for (let i = 1; i < strings.length; i++) {
    const s = strings[i];
    let j = 0;
    while (j < prefix.length && j < s.length && prefix[j].toUpperCase() === s[j].toUpperCase()) j++;
    prefix = prefix.slice(0, j);
    if (!prefix) break;
  }
  // Trim trailing separators first ("Kindle Unltd*" -> "Kindle Unltd"); only
  // fall back to cutting at a word boundary if that leaves a partial word.
  prefix = prefix.replace(/[\s*#\-.,:;/\\]+$/, "").trim();
  const nextChar = strings[0].charAt(prefix.length);
  if (prefix.length > 3 && nextChar && /[A-Za-z0-9]/.test(nextChar)) {
    const cut = prefix.lastIndexOf(" ");
    if (cut > 2) prefix = prefix.slice(0, cut);
  }
  return prefix.trim();
}

function matchCategory(merchantRaw, rules) {
  const hit = findMatchingRule(merchantRaw, rules);
  return hit ? hit.rule.home_label : null;
}

function applyCategorization(transactions, rules) {
  for (const t of transactions) {
    if (t.override_label) {
      t.resolved_category = t.override_label; // override wins, but never touch the underlying rule
      continue;
    }
    t.resolved_category = matchCategory(t.merchant_raw, rules) || "Uncategorized";
  }
  return transactions;
}

// ---------- insights ----------

// Months present in the data, newest first, as {key:'2026-09', label:'September 2026'}
// Months that have transactions, newest first. `alsoKey` is added even when
// it has none yet, so the current month is there on the 1st, before the first
// purchase lands, instead of the view staying on last month.
function availableMonths(transactions, alsoKey = null) {
  const set = new Set();
  transactions.forEach((t) => {
    if (t.date && /^\d{4}-\d{2}/.test(t.date)) set.add(t.date.slice(0, 7));
  });
  if (alsoKey && /^\d{4}-\d{2}$/.test(alsoKey) && set.size) set.add(alsoKey);
  const names = ["January","February","March","April","May","June","July","August","September","October","November","December"];
  return [...set]
    .sort()
    .reverse()
    .map((k) => {
      const [y, m] = k.split("-");
      return { key: k, label: `${names[parseInt(m, 10) - 1]} ${y}` };
    });
}

function transactionsInMonth(transactions, monthKey) {
  return transactions.filter((t) => t.date && t.date.slice(0, 7) === monthKey);
}

// Spend that actually reflects choices: excludes transfers and the big fixed
// obligations, since including rent would drown out everything else.
const NON_DISCRETIONARY_PATTERN = /rent|mortgage|insurance|utilit|loan|tuition/i;

function isDiscretionaryCategory(name, categoryMeta) {
  if (!name || name === "Uncategorized") return false;
  const meta = (categoryMeta || []).find((c) => c.name === name);
  if (meta && meta.is_transfer) return false;
  // Variable necessities are reserved separately as committed spending, so
  // counting them here would reserve the same money twice.
  if (meta && meta.is_variable_necessity) return false;
  if (meta && meta.exclude_from_discretionary) return false;
  // One-off but unavoidable (an oil change): out of the allowance, nothing more.
  if (meta && meta.is_necessary_expense) return false;
  return !NON_DISCRETIONARY_PATTERN.test(name);
}

function discretionaryTotal(transactions, categoryMeta) {
  return round2(
    transactions
      .filter((t) => t.amount < 0 && isDiscretionaryCategory(t.resolved_category, categoryMeta))
      .reduce((s, t) => s + Math.abs(t.amount), 0)
  );
}

// Last N months of discretionary spend, oldest first, for the trend chart.
function discretionaryByMonth(transactions, categoryMeta, months = 6) {
  const keys = [...new Set(transactions.filter((t) => t.date).map((t) => t.date.slice(0, 7)))].sort().slice(-months);
  return keys.map((k) => ({
    key: k,
    label: k.slice(5) + "/" + k.slice(2, 4),
    total: discretionaryTotal(transactionsInMonth(transactions, k), categoryMeta)
  }));
}

// Discretionary category totals for one month, matching exactly what the trend
// bar is summing so the parts add up to the whole.
function discretionaryBreakdown(transactions, monthKey, categoryMeta) {
  const rows = new Map();
  transactionsInMonth(transactions, monthKey)
    .filter((t) => t.amount < 0 && isDiscretionaryCategory(t.resolved_category, categoryMeta))
    .forEach((t) => {
      const c = t.resolved_category;
      rows.set(c, round2((rows.get(c) || 0) + Math.abs(t.amount)));
    });
  const out = [...rows.entries()].map(([name, amount]) => ({ name, amount }));
  out.sort((a, b) => b.amount - a.amount);
  const total = round2(out.reduce((s, r) => s + r.amount, 0));
  out.forEach((r, i) => {
    r.pct = total > 0 ? (r.amount / total) * 100 : 0;
    r.color = PIE_COLORS[i % PIE_COLORS.length];
  });
  return { rows: out, total };
}

// Geometry shared by the trend chart and its sandwich drilldown.
const TREND_W = 640;
const TREND_H = 200;
const TREND_PAD = { top: 14, right: 14, bottom: 28, left: 58 };

function buildTrendChart(series, selectedKey = null) {
  if (!series || series.length === 0) return null;
  const W = TREND_W;
  const H = TREND_H;
  const PAD = TREND_PAD;
  const plotW = W - PAD.left - PAD.right;
  const plotH = H - PAD.top - PAD.bottom;
  const maxY = Math.max(...series.map((s) => s.total), 1);

  const slot = plotW / series.length;
  const barW = Math.min(slot * 0.62, 70);

  // Each month is its own group — bar, figure, label — so the drilldown can
  // fade the others out and move this one without redrawing the chart.
  const bars = series
    .map((s, i) => {
      const h = (s.total / maxY) * plotH;
      const x = PAD.left + slot * i + (slot - barW) / 2;
      const y = PAD.top + plotH - h;
      const isLast = i === series.length - 1;
      const isSel = selectedKey && s.key === selectedKey;
      const fill = isSel
        ? "var(--text-accent, #7b6cd9)"
        : isLast
          ? "var(--text-accent, #7b6cd9)"
          : "var(--background-modifier-border)";
      return (
        `<g class="budget-trend-month" data-month="${s.key}">` +
        `<rect class="budget-trend-bar${isSel ? " budget-trend-bar-sel" : ""}" data-month="${s.key}" x="${x.toFixed(1)}" y="${y.toFixed(1)}" width="${barW.toFixed(1)}" height="${Math.max(h, 1).toFixed(1)}" rx="3" fill="${fill}" tabindex="0" role="button" aria-label="${s.label}: $${s.total.toFixed(2)}. Show what it was spent on.">` +
        `<title>${s.label}: $${s.total.toFixed(2)}</title></rect>` +
        `<text class="budget-trend-figure" x="${(x + barW / 2).toFixed(1)}" y="${(y - 4).toFixed(1)}" text-anchor="middle" font-size="8.5" fill="var(--text-muted)">$${Math.round(s.total)}</text>` +
        `<text class="budget-trend-month-label" x="${(x + barW / 2).toFixed(1)}" y="${H - 9}" text-anchor="middle" font-size="8.5" fill="var(--text-muted)">${s.label}</text>` +
        `</g>`
      );
    })
    .join("");

  const grid = [0, maxY / 2, maxY]
    .map((v) => {
      const y = PAD.top + plotH - (v / maxY) * plotH;
      return (
        `<line x1="${PAD.left}" y1="${y.toFixed(1)}" x2="${W - PAD.right}" y2="${y.toFixed(1)}" stroke="var(--background-modifier-border)" stroke-width="1"/>` +
        `<text x="${PAD.left - 8}" y="${(y + 4).toFixed(1)}" text-anchor="end" font-size="8.5" fill="var(--text-muted)">$${Math.round(v)}</text>`
      );
    })
    .join("");

  return (
    `<svg class="budget-trend-chart" viewBox="0 0 ${W} ${H}" width="100%" preserveAspectRatio="xMidYMid meet">` +
    `<g class="budget-trend-grid">${grid}</g>${bars}<g class="budget-trend-stage"></g></svg>`
  );
}

// ---- the sandwich: one month's discretionary spend, drilled down in place ----
//
// The clicked month's bar slides to the left of the chart and grows to its full
// height, and splits into a layer per category, stacked biggest first — the
// sandwich. Each layer's label sits in a column to its right, joined to it by a
// leader line: the category, then what it cost and its share. When there are
// more categories than rows fit, the chart grows taller rather than squeezing
// them, so every layer keeps a label.

const TREND_SANDWICH = {
  left: 14,
  // The pillar: about twice a month's bar, so it still reads as that bar,
  // with the bar's rounded ends scaled to match.
  barW: 120,
  rx: 6,
  right: TREND_W - 14,
  // Rough glyph width of a bold 12px category name, for placing the amounts.
  // (The chart is drawn 640 wide and scaled to the panel, so its text scales
  // too: sizes here are about two-thirds of what they render at on a desktop.)
  nameCharW: 5.3,
  // Where the label column starts, past the bar and the leaders' elbows.
  labelGap: 44,
  // A callout row, and how tight rows may get before the chart grows instead.
  rowH: 18,
  minRowH: 14,
  top: TREND_PAD.top,
  // Room below for the heading, in the row the month labels used.
  bottomPad: TREND_PAD.bottom
};

// Where the bar, each layer and each label goes. Pure: the chart's DOM code
// draws it. rows: [{ name, amount, pct, color }] (discretionaryBreakdown's).
function trendSandwichLayout(rows, geom = {}) {
  const g = Object.assign({}, TREND_SANDWICH, geom);
  const kept = (rows || []).filter((r) => r && r.amount > 0).slice().sort((a, b) => b.amount - a.amount);
  const total = kept.reduce((s, r) => s + r.amount, 0);
  const baseH = TREND_H - g.top - g.bottomPad;
  // A row per callout: rows tighten a little to fit the chart as it is, and
  // only past that does the chart grow.
  const rowH = kept.length ? Math.min(g.rowH, Math.max(g.minRowH, baseH / kept.length)) : g.rowH;
  const plotH = Math.max(baseH, kept.length * rowH);
  const height = g.top + plotH + g.bottomPad;
  const bar = { x: g.left, y: g.top, w: g.barW, h: plotH };

  const slices = [];
  let y = g.top;
  kept.forEach((r) => {
    const h = total > 0 ? (r.amount / total) * plotH : 0;
    slices.push({ i: (rows || []).indexOf(r), name: r.name, amount: r.amount, pct: r.pct != null ? r.pct : (r.amount / total) * 100, color: r.color, x: g.left, y, w: g.barW, h, cy: y + h / 2 });
    y += h;
  });

  // Each label wants to sit level with its layer. Where layers are thinner
  // than a row, labels are pushed apart — down first, then back up if the last
  // ran off the bottom — keeping their order, so no two leaders cross.
  const want = slices.map((sl) => sl.cy);
  const pos = want.slice();
  const first = g.top + rowH / 2;
  const last = g.top + plotH - rowH / 2;
  for (let i = 0; i < pos.length; i++) pos[i] = Math.max(pos[i], i === 0 ? first : pos[i - 1] + rowH);
  for (let i = pos.length - 1; i >= 0; i--) pos[i] = Math.min(pos[i], i === pos.length - 1 ? last : pos[i + 1] - rowH);

  const edge = g.left + g.barW;
  const labelX = edge + g.labelGap;
  // Amounts line up in a column just past the longest name, not at the far
  // edge, so each reads as one line: "Eating Out   $402.20 · 33%".
  const longest = slices.reduce((m, sl) => Math.max(m, String(sl.name).length), 0);
  const figureX = Math.min(labelX + 8 + longest * g.nameCharW + 24, g.right - 120);
  const labels = slices.map((sl, k) => {
    const mid = pos[k];
    return {
      i: sl.i,
      name: sl.name,
      figure: `$${sl.amount.toFixed(2)} · ${Math.round(sl.pct)}%`,
      nameX: labelX,
      figureX,
      baseline: mid + 3.2,
      mid,
      // Out from the layer, across to the label's row, into the label.
      leader: [[edge, sl.cy], [edge + 12, sl.cy], [labelX - 14, mid], [labelX - 6, mid]]
    };
  });
  return { bar, slices, labels, height, rowH, total: Math.round(total * 100) / 100 };
}

// Makes a trend chart's bars open into the sandwich and close again, in place.
// Standard DOM only, like enableChartHover, so it runs unchanged in a browser.
//
//   breakdown(key) -> { rows, total, title }   what a month was spent on
//   onToggle(key|null)                          told what's open, to remember it
//   narrow() -> bool                            true where there's no room for the
//                                               sandwich: onNarrow(key) is called
//                                               instead, for the list below the chart
//   reducedMotion                               skip the animation (defaults to
//                                               the system setting)
//
// Opening: the bar slides to the left and widens as the other months fade; it
// grows to the chart's full height; it splits into a layer per category; the
// leaders and labels come in. Closing runs the same steps backwards.
function enableTrendSandwich(wrap, { breakdown, onToggle = null, narrow = () => false, onNarrow = null, reducedMotion = null } = {}) {
  const svg = wrap && typeof wrap.querySelector === "function" ? wrap.querySelector("svg.budget-trend-chart") : null;
  if (!svg || typeof breakdown !== "function") return null;
  const stage = svg.querySelector(".budget-trend-stage");
  const grid = svg.querySelector(".budget-trend-grid");
  const months = Array.from(svg.querySelectorAll(".budget-trend-month"));
  if (!stage || !months.length) return null;
  const NS = "http://www.w3.org/2000/svg";
  const doc = svg.ownerDocument;
  const win = doc.defaultView || {};
  const reduce =
    reducedMotion != null
      ? !!reducedMotion
      : !!(win.matchMedia && win.matchMedia("(prefers-reduced-motion: reduce)").matches);
  const raf = win.requestAnimationFrame ? win.requestAnimationFrame.bind(win) : (f) => setTimeout(f, 16);
  const clock = () => (win.performance && win.performance.now ? win.performance.now() : Date.now());
  const ease = (t) => (t < 0.5 ? 4 * t * t * t : 1 - Math.pow(-2 * t + 2, 3) / 2);
  const lerp = (a, b, t) => a + (b - a) * t;
  const tween = (ms, step, instant) =>
    new Promise((done) => {
      if (instant || reduce || ms <= 0) {
        step(1);
        done();
        return;
      }
      const t0 = clock();
      const frame = () => {
        const t = Math.min(1, (clock() - t0) / ms);
        step(ease(t));
        if (t < 1) raf(frame);
        else done();
      };
      raf(frame);
    });
  const make = (tag, attrs, parent, text) => {
    const n = doc.createElementNS(NS, tag);
    Object.entries(attrs || {}).forEach(([k, v]) => n.setAttribute(k, String(v)));
    if (text != null) n.textContent = text;
    if (parent) parent.appendChild(n);
    return n;
  };
  const fade = (nodes, v) => nodes.forEach((n) => n && (n.style.opacity = String(v)));
  const num = (n, a) => Number(n.getAttribute(a));

  const state = { open: null, busy: false, bar: null, orig: null, parts: null };

  async function open(key, { instant = false } = {}) {
    if (state.busy || state.open) return false;
    const g = months.find((m) => m.getAttribute("data-month") === key);
    if (!g) return false;
    const bar = g.querySelector(".budget-trend-bar");
    const info = breakdown(key) || {};
    const L = trendSandwichLayout(info.rows || []);
    state.busy = true;
    state.open = key;
    state.bar = bar;
    state.orig = { x: num(bar, "x"), y: num(bar, "y"), w: num(bar, "width"), h: num(bar, "height"), rx: num(bar, "rx") || 3, fill: bar.getAttribute("fill") };
    // An older month's bar is drawn in the border grey; opened, it takes the
    // accent a selected bar has, so it's the month — not a grey slab — that
    // stretches across the chart.
    bar.setAttribute("fill", "var(--text-accent, #7b6cd9)");
    svg.classList.add("budget-trend-open");
    g.classList.add("is-open");
    bar.setAttribute("aria-expanded", "true");

    // Everything the sandwich brings, drawn now and faded in later.
    stage.textContent = "";
    const heading = `${info.title || key} · $${(Number(info.total) || 0).toFixed(2)} discretionary`;
    const group = make("g", { class: "budget-trend-sandwich", tabindex: "0", role: "button", "aria-label": `${heading}. ${L.slices.map((r) => `${r.name} $${r.amount.toFixed(2)}`).join(", ")}. Close.` }, stage);
    const slices = [];
    const extras = [];
    // The slices sit inside the expanded bar's own silhouette — rounded ends
    // and all — so the stack reads as the bar, cut into layers, not as a pile
    // of boxes. The clip is the bar at its final size.
    const clipId = `budget-trend-clip-${Math.random().toString(36).slice(2, 10)}`;
    const defs = make("defs", {}, group);
    const clip = make("clipPath", { id: clipId }, defs);
    make("rect", { x: L.bar.x, y: L.bar.y, width: L.bar.w, height: L.bar.h, rx: TREND_SANDWICH.rx }, clip);
    const sliceGroup = make("g", { class: "budget-trend-slices", "clip-path": `url(#${clipId})` }, group);
    L.slices.forEach((sl, k) => {
      const lb = L.labels[k];
      // A layer and its label are one thing: pointing at either lights both.
      // The slice lives in the clipped group, so it's lit alongside the layer.
      const layer = make("g", { class: "budget-trend-layer", "data-category": sl.name }, group);
      const r = make("rect", {
        class: "budget-trend-slice",
        "data-category": sl.name,
        x: sl.x,
        y: sl.y.toFixed(2),
        width: sl.w,
        // A 1px cut between layers, so each reads as its own block.
        height: Math.max(sl.h - (k < L.slices.length - 1 ? 1 : 0), 0.75).toFixed(2),
        fill: sl.color || "var(--text-accent, #7b6cd9)"
      }, sliceGroup);
      make("title", {}, r, `${sl.name}: $${sl.amount.toFixed(2)} (${Math.round(sl.pct)}%)`);
      const leader = make("polyline", {
        class: "budget-trend-tick",
        points: lb.leader.map(([x, y]) => `${x.toFixed(1)},${y.toFixed(1)}`).join(" "),
        fill: "none",
        stroke: sl.color || "var(--text-faint, var(--text-muted))",
        "stroke-width": "1.25"
      }, layer);
      // The row behind a label takes the pointer too, so a thin layer can be
      // pointed at by its label.
      const hot = make("rect", { class: "budget-trend-label-hit", x: lb.nameX - 6, y: (lb.mid - L.rowH / 2).toFixed(1), width: TREND_SANDWICH.right - lb.nameX + 6, height: L.rowH.toFixed(2), rx: 4, fill: "transparent" }, layer);
      make("title", {}, hot, `${sl.name}: $${sl.amount.toFixed(2)} (${Math.round(sl.pct)}%)`);
      const swatch = make("rect", { class: "budget-trend-swatch-mark", x: lb.nameX - 2, y: (lb.mid - 4).toFixed(1), width: 2.5, height: 8, rx: 1.25, fill: sl.color || "var(--text-accent, #7b6cd9)" }, layer);
      // Light type: the name in the normal ink, the figure muted, and that
      // contrast carries the hierarchy rather than weight.
      const name = make("text", { class: "budget-trend-slice-name", x: lb.nameX + 8, y: lb.baseline.toFixed(1), "font-size": "9.5", "font-weight": "400", fill: "var(--text-normal)" }, layer, lb.name);
      const fig = make("text", { class: "budget-trend-slice-figure", x: lb.figureX.toFixed(1), y: lb.baseline.toFixed(1), "font-size": "9", "font-weight": "400", fill: "var(--text-muted)" }, layer, lb.figure);
      const light = (on) => {
        layer.classList.toggle("is-hot", on);
        r.classList.toggle("is-hot", on);
        // CSS can't ask "does this contain a lit layer" without :has, which is
        // slow to invalidate, so the group says so itself.
        group.classList.toggle("has-hot", !!group.querySelector(".is-hot"));
      };
      [r, hot].forEach((n) => {
        n.addEventListener("pointerenter", () => light(true));
        n.addEventListener("pointerleave", () => light(false));
      });
      slices.push(r);
      extras.push(leader, hot, swatch, name, fig);
    });
    const head = make("text", {
      class: "budget-trend-heading",
      x: TREND_W / 2,
      y: (L.height - 9).toFixed(1),
      "text-anchor": "middle",
      "font-size": "9",
      fill: "var(--text-muted)"
    }, group, L.slices.length ? `${heading} · click to close` : `${info.title || key}: no discretionary spending · click to close`);
    extras.push(head);
    fade([...slices, ...extras], 0);
    state.parts = { g, slices, extras, group, L, fading: [...months.filter((m) => m !== g), grid, g.querySelector(".budget-trend-figure"), g.querySelector(".budget-trend-month-label")] };

    const o = state.orig;
    const B = L.bar;
    const H0 = TREND_H;
    const setHeight = (h) => svg.setAttribute("viewBox", `0 0 ${TREND_W} ${h.toFixed(2)}`);
    // One motion, as the others fade: the bar stretches up to the ceiling
    // while it widens and moves to the left (the chart grows, if it must).
    await tween(460, (t) => {
      fade(state.parts.fading, 1 - t);
      setHeight(lerp(H0, L.height, t));
      bar.setAttribute("x", lerp(o.x, B.x, t).toFixed(2));
      bar.setAttribute("width", lerp(o.w, B.w, t).toFixed(2));
      bar.setAttribute("y", lerp(o.y, B.y, t).toFixed(2));
      bar.setAttribute("height", lerp(o.h, B.h, t).toFixed(2));
      bar.setAttribute("rx", lerp(o.rx, TREND_SANDWICH.rx, t).toFixed(2));
    }, instant);
    // Split into layers.
    await tween(260, (t) => {
      fade(slices, t);
      if (slices.length) bar.style.opacity = String(1 - t);
    }, instant);
    // The leaders and labels.
    await tween(220, (t) => fade(extras, t), instant);
    // Settled: the stylesheet takes over, so a hovered layer can dim.
    [...slices, ...extras].forEach((n) => (n.style.opacity = ""));
    state.busy = false;
    if (onToggle) onToggle(key);
    return true;
  }

  async function close({ instant = false } = {}) {
    if (state.busy || !state.open) return false;
    state.busy = true;
    const { g, slices, extras, fading, L } = state.parts;
    const bar = state.bar;
    const o = state.orig;
    const now = { x: num(bar, "x"), y: num(bar, "y"), w: num(bar, "width"), h: num(bar, "height"), rx: num(bar, "rx") };
    const setHeight = (h) => svg.setAttribute("viewBox", `0 0 ${TREND_W} ${h.toFixed(2)}`);
    fade([...slices, ...extras], 1);
    await tween(160, (t) => fade(extras, 1 - t), instant);
    await tween(220, (t) => {
      fade(slices, 1 - t);
      bar.style.opacity = String(Math.max(Number(bar.style.opacity === "" ? 1 : bar.style.opacity), t));
    }, instant);
    bar.style.opacity = "";
    // The same motion backwards: down from the ceiling and back into its slot.
    await tween(460, (t) => {
      setHeight(lerp(L.height, TREND_H, t));
      bar.setAttribute("x", lerp(now.x, o.x, t).toFixed(2));
      bar.setAttribute("width", lerp(now.w, o.w, t).toFixed(2));
      bar.setAttribute("y", lerp(now.y, o.y, t).toFixed(2));
      bar.setAttribute("height", lerp(now.h, o.h, t).toFixed(2));
      bar.setAttribute("rx", lerp(now.rx, o.rx, t).toFixed(2));
      fade(fading, t);
    }, instant);
    fading.forEach((n) => n && (n.style.opacity = ""));
    if (o.fill != null) bar.setAttribute("fill", o.fill);
    setHeight(TREND_H);
    stage.textContent = "";
    svg.classList.remove("budget-trend-open");
    g.classList.remove("is-open");
    bar.setAttribute("aria-expanded", "false");
    state.open = null;
    state.parts = null;
    state.busy = false;
    if (onToggle) onToggle(null);
    return true;
  }

  const activate = (key, viaKeyboard) => {
    if (narrow()) {
      if (onNarrow) onNarrow(key);
      return;
    }
    if (state.open) {
      close();
      return;
    }
    open(key).then((ok) => {
      if (ok && viaKeyboard && state.parts) state.parts.group.focus();
    });
  };
  months.forEach((m) => {
    const bar = m.querySelector(".budget-trend-bar");
    if (!bar) return;
    bar.setAttribute("aria-expanded", "false");
    bar.addEventListener("click", () => activate(m.getAttribute("data-month"), false));
    bar.addEventListener("keydown", (e) => {
      if (e.key !== "Enter" && e.key !== " ") return;
      e.preventDefault();
      activate(m.getAttribute("data-month"), true);
    });
  });
  stage.addEventListener("click", () => close());
  stage.addEventListener("keydown", (e) => {
    if (e.key !== "Enter" && e.key !== " " && e.key !== "Escape") return;
    e.preventDefault();
    const bar = state.bar;
    close().then(() => bar && bar.focus());
  });

  return { open, close, get openKey() { return state.open; }, get busy() { return state.busy; } };
}

// The calendar month immediately before monthKey ("2026-01" -> "2025-12").
function priorMonthKey(monthKey) {
  if (!monthKey || !/^\d{4}-\d{2}$/.test(monthKey)) return null;
  const [y, m] = monthKey.split("-").map(Number);
  const d = new Date(y, m - 1, 1);
  d.setMonth(d.getMonth() - 1);
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}`;
}

// Total spend for one category in the month before currentMonthKey. Transfer
// categories return 0 — moving money between your own accounts isn't spending,
// so it must never become the baseline for a spending target.
function getPriorMonthCategorySpend(transactions, categoryName, currentMonthKey, categoryMeta) {
  if (!categoryName) return 0;
  const meta = (categoryMeta || []).find((c) => c.name === categoryName);
  if (meta && meta.is_transfer) return 0;

  const prior = priorMonthKey(currentMonthKey);
  if (!prior) return 0;

  return round2(
    (transactions || [])
      .filter((t) => t.amount < 0)
      .filter((t) => t.date && t.date.slice(0, 7) === prior)
      .filter((t) => (t.resolved_category || "Uncategorized") === categoryName)
      .reduce((s, t) => s + Math.abs(t.amount), 0)
  );
}

// "August" beside a month in the same year; "December 2025" beside January.
function targetMonthName(monthKey, beside) {
  if (!monthKey) return "";
  const full = monthLabel(monthKey);
  return beside && String(beside).slice(0, 4) === monthKey.slice(0, 4) ? full.split(" ")[0] : full;
}

function monthLabel(monthKey) {
  if (!monthKey) return "";
  const names = ["January","February","March","April","May","June","July","August","September","October","November","December"];
  const [y, m] = monthKey.split("-");
  return `${names[parseInt(m, 10) - 1]} ${y}`;
}

async function setCategoryTarget(app, name, target) {
  const cats = await readJSON(app, FILES.categories, []);
  const i = cats.findIndex((c) => c.name === name);
  if (i >= 0) {
    if (target > 0) cats[i].monthly_target = round2(target);
    else delete cats[i].monthly_target;
  } else if (target > 0) {
    cats.push({ name, is_transfer: false, monthly_target: round2(target) });
  }
  await writeJSON(app, FILES.categories, cats);
}

// ---------- savings mode ----------

// The goal pinned to the top of the dashboard, chosen by the user.
//
// This used to be inferred from the goal's NAME against a hidden pattern, so a
// goal called "Moving Fund" was pinned and one called "New apartment" was not,
// with nothing on screen to explain the difference or any way to change it. The
// answer is now a flag the Pin button sets, and only one goal carries it.
function findPriorityGoal(goals) {
  // A capped fund has its own placement and never takes the pinned slot.
  return (goals || []).find((g) => g && g.pinned === true && !isCappedFund(g)) || null;
}

// Pins one goal and unpins the rest, so "pinned" can never mean two things at
// once. Passing null clears the pin entirely.
async function setPinnedGoal(app, goalId) {
  const goals = await readJSON(app, FILES.savingsGoals, []);
  let changed = false;
  goals.forEach((g) => {
    const shouldPin = !!goalId && g.id === goalId;
    if (!!g.pinned !== shouldPin) {
      if (shouldPin) g.pinned = true;
      else delete g.pinned;
      changed = true;
    }
  });
  if (changed) await writeJSON(app, FILES.savingsGoals, goals);
  return goals;
}

function savingsStatus(settings, todayStr = todayLocal()) {
  if (!settings || !settings.savingsMode) return null;
  const deadline = settings.savingsDeadline;
  // A deadline is optional — Savings Mode is useful with no end date at all.
  if (!deadline) return { deadline: null, days: null, openEnded: true };
  if (!/^\d{4}-\d{2}-\d{2}$/.test(deadline)) {
    return { deadline: null, days: null, invalid: true };
  }
  const days = daysBetween(todayStr, deadline);
  return {
    deadline,
    days,
    weeks: Math.floor(Math.abs(days) / 7),
    past: days < 0,
    imminent: days >= 0 && days <= 14
  };
}

// Suspending extra payoff is fine for interest-bearing debt — you just pay more
// interest later. It is NOT fine for a deferred-interest plan whose cliff falls
// while Savings Mode is active, where missing the payoff date applies interest
// retroactively to the original amount. That's worth surfacing loudly.
function deferredRisksDuring(installmentDebts, todayStr, deadline) {
  if (!deadline) return [];
  return (installmentDebts || [])
    .filter((d) => d.deferred_interest_risk && d.deferred_interest_risk.applies)
    .filter((d) => {
      const pd = d.deferred_interest_risk.payoff_deadline;
      return pd && pd >= todayStr && pd <= addDays(deadline, 30);
    })
    .map((d) => ({
      provider: debtLabel(d),
      balance: debtBalance(d),
      payoffDeadline: d.deferred_interest_risk.payoff_deadline,
      apr: d.deferred_interest_risk.retroactive_apr,
      principal: d.deferred_interest_risk.original_principal
    }));
}

// What has already gone into each savings goal this pay period, by goal id:
// contributions dated from the period's start up to (not including) the next
// payday. Dated by when they were logged — that's when saved_amount went up,
// and the pace is measured from saved_amount at the period's start. Dating a
// linked one by its bank transfer instead let a contribution logged last
// period count toward this period's pace too, once linked. Money taken back
// out this period counts against it; the total never goes below zero.
function goalMovesThisPeriod(goals, fromStr, toStr) {
  const out = {};
  if (!fromStr) return out;
  regularGoals(goals).forEach((g) => {
    let net = 0;
    (g.contributions || []).forEach((c) => {
      if (!c) return;
      const date = c.date;
      if (!date || date < fromStr || (toStr && date >= toStr)) return;
      net += Number(c.amount) || 0;
    });
    if (net > 0) out[g.id] = round2(net);
  });
  return out;
}

// The savings equivalent of the debt payoff ladder. Debt prioritised by cost of
// carrying (deferred-interest cliffs, then APR); savings prioritises by
// deadline pressure, because a goal with a date can actually be missed.
//
//   Tier 1 — dated goals, soonest first, funded to the pace they need this
//            period to land on time, less what's already gone in this period.
//            Miss the pace and the goal fails, not just costs more.
//   Tier 2 — capped funds, from what the paces left, each taking a share
//            weighted by how empty it is (allocateToFunds). The cushion is
//            protection against the next surprise, so it's rebuilt before any
//            goal gets ahead of its schedule.
//   Tier 3 — leftover tops up dated goals beyond pace, soonest first.
//   Tier 4 — undated goals, least-funded first: wants with no deadline.
//
// Only a goal's own target date makes it dated. The global savings deadline is
// a countdown, not a date for every goal: an undated chef's knife isn't turned
// into an urgent five-paycheck goal because the deadline exists.
//
// A period's pace is measured from where the goal stood when the period began:
// what's left now plus what went in this period, spread over the paychecks
// left. What went in comes off the ask, so a goal that got its $563 pace — or
// $1,054 against it — asks for nothing more until the next period, and the
// surplus goes on to the other tiers.
//
// paychecksFor maps a goal id to how many paychecks remain before its deadline;
// it's passed in because the pay schedule lives outside the allocator.
// accounts is only read for capped funds, whose balance is an account's.
// goalMoves is goalMovesThisPeriod for the period being planned.
function recommendSavings(goals, available, paychecksFor = {}, todayStr = todayLocal(), savingsDeadline = null, accounts = [], fundOpts = {}, goalMoves = {}) {
  void savingsDeadline;
  const now = Math.max(0, round2(available));
  if (now <= 0) return { breakdown: [], total: 0 };

  // The ladder is worked out on the period's starting position — every goal
  // as it stood, and the surplus with what's gone into goals added back — and
  // each goal's ask is then its share less what it's had. Working it out on
  // today's position instead meant money moved into a goal under a later tier
  // shrank the pool the funds' share is taken from, so following the plan
  // changed it. (Funds do the same for their own moves, in allocateToFunds.)
  const open = regularGoals(goals)
    .map((g) => {
      const p = goalProgress(g);
      const moved = Math.max(0, round2((goalMoves && goalMoves[g.id]) || 0));
      return { goal: g, left: round2(p.remaining + moved), nowLeft: p.remaining, pct: p.pct, date: g.target_date || null, moved, share: 0, why: null };
    })
    .filter((x) => x.left > 0);
  let pool = round2(now + open.reduce((sum, x) => sum + x.moved, 0));

  const give = (x, amount, why) => {
    const amt = round2(Math.min(amount, x.left, pool));
    if (amt <= 0) return;
    x.share = round2(x.share + amt);
    x.left = round2(x.left - amt);
    pool = round2(pool - amt);
    if (!x.why) x.why = why;
    else if (!/topped up/.test(x.why)) x.why += ", then topped up";
  };

  const dated = open.filter((x) => x.date).sort((a, b) => a.date.localeCompare(b.date));
  const undated = open.filter((x) => !x.date).sort((a, b) => a.pct - b.pct);

  // Tier 1: the pace each dated goal needs this period.
  dated.forEach((x) => {
    const checks = paychecksFor[x.goal.id];
    const overdue = x.date < todayStr;
    const pace = overdue || !checks || checks < 1 ? x.left : round2(x.left / checks);
    x.pace = pace;
    give(
      x,
      pace,
      overdue
        ? `past its ${x.date} target`
        : checks
          ? `on pace for ${x.date} — ${checks} paycheck${checks === 1 ? "" : "s"} left`
          : `due ${x.date}`
    );
  });

  // Tier 2: capped funds, from what the paces left.
  const funds = allocateToFunds(goals, pool, accounts, Object.assign({ todayStr }, fundOpts));
  pool = round2(pool - funds.total);

  // Tier 3: anything left tops up dated goals ahead of schedule.
  dated.forEach((x) => give(x, x.left, "ahead of pace"));

  // Tier 4: undated goals, least funded first.
  undated.forEach((x) => give(x, x.left, "no deadline — funded after dated goals and funds"));

  // Each goal's ask: its share less what's gone in, never more than it still
  // needs. Where it sits and what it says depend on what's still owed: some of
  // the pace, and it's a pace ask (saying how much is already in); the pace
  // covered, and what's left of its share is a top-up, after the funds.
  const asks = { paced: [], topups: [], undated: [] };
  dated.forEach((x) => {
    const amount = round2(Math.min(x.share - x.moved, x.nowLeft));
    if (!(amount > 0)) return;
    const paceLeft = round2(Math.max(0, (x.pace || 0) - x.moved));
    if (paceLeft > 0) {
      const note = x.moved > 0 ? ` ($${x.moved.toFixed(2)} of $${x.pace.toFixed(2)} already in this period)` : "";
      const base = x.why.replace(/, then topped up$/, "");
      asks.paced.push({ id: x.goal.id, target: x.goal.name, amount, reason: base + note + (amount > paceLeft ? ", then topped up" : "") });
    } else {
      asks.topups.push({ id: x.goal.id, target: x.goal.name, amount, reason: "ahead of pace" });
    }
  });
  undated.forEach((x) => {
    const amount = round2(Math.min(x.share - x.moved, x.nowLeft));
    if (amount > 0) asks.undated.push({ id: x.goal.id, target: x.goal.name, amount, reason: x.why });
  });
  const ordered = [...asks.paced, ...funds.breakdown, ...asks.topups, ...asks.undated];

  let room = now;
  const breakdown = [];
  ordered.forEach((b) => {
    const amount = round2(Math.min(b.amount, room));
    if (!(amount > 0)) return;
    room = round2(room - amount);
    breakdown.push(Object.assign({}, b, { amount }));
  });

  return { breakdown, total: round2(breakdown.reduce((s, b) => s + b.amount, 0)), periods: funds.periods };
}

// ---------- variable necessities ----------

function medianOf(nums) {
  if (!nums || !nums.length) return 0;
  const s = nums.slice().sort((a, b) => a - b);
  const m = Math.floor(s.length / 2);
  return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2;
}

// Forward-looking reserve for spending that's unavoidable but irregular — gas,
// dog food. Learns size and cadence from history and projects only the
// purchases still ahead of the user between now and payday.
//
// Deliberately anchored to currentDateStr, not the pay-period start: this is
// about what's still to come, not what the period as a whole will cost.
function calculateVariableNecessities(transactions, categoryMeta, currentDateStr, nextPaydayStr, ownership = null) {
  const detail = [];
  let totalReserve = 0;

  let flagged = (categoryMeta || []).filter((c) => c && c.is_variable_necessity && c.name);
  if (!flagged.length || !currentDateStr || !nextPaydayStr) {
    return { detail, totalReserve: 0 };
  }

  // Cadence forecasting is a FALLBACK. It exists for costs with no scheduled
  // source of truth — gas, pet food — and must never re-forecast something a
  // tracker already schedules. A category the debt tracker would accept payments
  // in is already modelled as installments and minimums, so projecting it too
  // would reserve the same money twice.
  const skipped = [];
  if (ownership) {
    flagged = flagged.filter((c) => {
      // A transfer category is money moving between accounts, never a purchase
      // to forecast. Previously this fell out of the wider debt-category set;
      // now it is stated, because the set above no longer includes it.
      if (c.is_transfer) {
        skipped.push(c.name);
        return false;
      }
      if (!ownership.isScheduledCategory(c.name)) return true;
      skipped.push(c.name);
      return false;
    });
  }

  // Look back far enough to cross pay-period boundaries — the most recent fill
  // is frequently the day before the current period began.
  const windowStart = addDays(currentDateStr, -60);

  flagged.forEach((meta) => {
    const minAmount = Number(meta.variable_min_amount) || 0;

    const qualifying = (transactions || [])
      .filter((t) => t && t.amount < 0 && t.date)
      .filter((t) => (t.resolved_category || "") === meta.name)
      // A purchase an explicit link has already assigned elsewhere isn't part of
      // this necessity's rhythm, so it must not shape the cadence either.
      .filter((t) => {
        if (!ownership) return true;
        const owner = ownership.ownerOf(t);
        if (!owner) return true;
        return owner.class === "variable_necessity";
      })
      .filter((t) => t.date >= windowStart && t.date <= currentDateStr)
      .map((t) => ({ date: t.date, amount: round2(Math.abs(t.amount)) }))
      // A $3.49 top-up or a $25 partial fill isn't a normal tank and would drag
      // the median down.
      .filter((t) => t.amount >= minAmount)
      .sort((a, b) => (a.date < b.date ? -1 : a.date > b.date ? 1 : 0));

    const recent = qualifying.slice(-8);

    // A rhythm needs purchases on at least two different days. Two on the same
    // day have no gap between them, and defaulting to one day projected a
    // purchase every day until payday — held back from Spendable.
    if (new Set(recent.map((r) => r.date)).size < 2) {
      detail.push({
        category: meta.name,
        sufficientHistory: false,
        medianAmount: 0,
        medianGap: 0,
        lastPurchaseDate: recent.length ? recent[recent.length - 1].date : null,
        projectedDates: [],
        projectedCount: 0,
        reserveAmount: 0
      });
      return;
    }

    const medianAmount = round2(medianOf(recent.map((r) => r.amount)));

    const gaps = [];
    for (let i = 1; i < recent.length; i++) {
      const g = daysBetween(recent[i - 1].date, recent[i].date);
      if (g > 0) gaps.push(g);
    }
    const medianGap = Math.max(1, Math.round(medianOf(gaps.length ? gaps : [1])));

    const lastPurchaseDate = recent[recent.length - 1].date;

    // Phase-aware: step forward from the last actual purchase so the rhythm is
    // preserved, then keep only the steps that land in the remaining window.
    const projectedDates = [];
    let cursor = lastPurchaseDate;
    let guard = 0;
    while (guard++ < 400) {
      cursor = addDays(cursor, medianGap);
      if (cursor >= nextPaydayStr) break;
      if (cursor >= currentDateStr) projectedDates.push(cursor);
    }

    const reserveAmount = round2(projectedDates.length * medianAmount);
    totalReserve += reserveAmount;

    detail.push({
      category: meta.name,
      sufficientHistory: true,
      medianAmount,
      medianGap,
      lastPurchaseDate,
      projectedDates,
      projectedCount: projectedDates.length,
      reserveAmount
    });
  });

  return { detail, totalReserve: round2(totalReserve), skipped };
}

// ---------- capped funds ----------
//
// A capped fund is a savings goal whose balance is a bank account's, not a
// ledger of contributions. It is for money that should sit at a level — an
// emergency buffer, an "oopsie fund" — rather than reach a finish line, so the
// amount it is set to is a ceiling: where it stops asking for surplus, not a
// target to hit by a date.
//
// It lives in savings_goals.json beside ordinary goals, marked kind "capped":
//   target_amount  the ceiling
//   account_id     the account whose live balance IS the fund's balance
//   placement      where the Overview shows it: "hero", "cards" or "goals"
// It never carries saved_amount or contributions. The account is the record,
// so there is nothing to log, match or hold back from free cash.

const FUND_PLACEMENTS = ["hero", "cards", "goals"];
const FUND_PLACEMENT_LABELS = { hero: "In the hero", cards: "As a card", goals: "In Savings goals" };
const FUND_PLACEMENT_PLACES = { hero: "the hero", cards: "the cards", goals: "Savings goals" };
// A suggestion under a dollar is noise — nobody schedules a $0.40 transfer.
const FUND_MIN_SUGGESTION = 1;
// How far apart the two halves of a transfer may post and still be paired.
// Same-bank transfers post the same day; between banks it can take a few
// business days.
const FUND_TRANSFER_WINDOW_DAYS = 3;
// A balance older than this is shown as stale, since the fund claims to be live.
const FUND_STALE_DAYS = 3;
// Older than this, or of unknown age, and the fund asks for nothing: a balance
// SimpleFIN stopped updating weeks ago can't say how much room is left.
const FUND_ASK_MAX_AGE_DAYS = 14;
// What a transfer between your own accounts is called: a phrase that names an
// account, not a bare word. "To Savings 00", "Transfer from SAV x1234", "Internal
// Transfer". Bare words matched too much — "SHARE DRAFT" is a credit-union
// cheque, "SAV-ON" a pharmacy, "INTERNAL REVENUE" the IRS, and "Online Transfer
// to Smith J" a payment to a person. Used only to accept an uncategorised half
// as a transfer; see pairFundTransfers.
const TRANSFER_WORDS = new RegExp(
  [
    "\\b(?:to|from)\\s+(?:share|shr|sav|savings|chk|checking)\\b",
    "\\b(?:transfer|xfer|trnsfr|tfr)\\b.*\\b(?:share|shr|sav|savings|chk|checking|acct|account)\\b",
    "\\b(?:transfer|xfer|trnsfr|tfr)\\b.*(?:\\bx+|\\*+)\\d{2,}\\b",
    "\\binternal\\s+(?:transfer|xfer)\\b",
    "\\bbetween\\s+(?:my\\s+)?accounts\\b"
  ].join("|"),
  "i"
);
// Person-to-person and wire payments can use the same words, and are spending.
const P2P_WORDS = /\b(zelle|venmo|cash ?app|paypal|apple ?cash|square cash|wire)\b/i;
// A deposit into the fund's account that is plainly pay, not a transfer.
const PAY_WORDS = /\b(payroll|direct dep|dir dep|salary|paycheck)\b/i;

function isCappedFund(goal) {
  return !!goal && goal.kind === "capped";
}

function regularGoals(goals) {
  return (goals || []).filter((g) => g && !isCappedFund(g));
}

function cappedFunds(goals) {
  return (goals || []).filter(isCappedFund);
}

function fundPlacement(fund) {
  return FUND_PLACEMENTS.includes(fund && fund.placement) ? fund.placement : "cards";
}

// "Cal Coast — Personal Savings", or the account id when it has no name.
function accountLabel(account) {
  return account ? account.institution || account.id : "";
}

// Where the fund stands, read off its account. `known` is false when the
// account is gone or has no balance yet; everything that acts on the fund
// checks it, because a missing balance is not an empty fund and must never be
// treated as one — that would ask for the whole ceiling.
function fundProgress(fund, accounts) {
  const account = (accounts || []).find((a) => a && a.id === fund.account_id) || null;
  const target = round2(Math.max(0, Number(fund.target_amount) || 0));
  const raw = account ? account.current_balance : null;
  const known = raw != null && raw !== "" && Number.isFinite(Number(raw));
  const saved = known ? round2(Number(raw)) : 0;
  // An overdrawn account holds nothing toward the ceiling, not less than nothing.
  const counted = Math.max(0, saved);
  return {
    saved,
    target,
    remaining: known ? round2(Math.max(0, target - counted)) : 0,
    over: known ? round2(Math.max(0, saved - target)) : 0,
    pct: known && target > 0 ? Math.min(100, (counted / target) * 100) : 0,
    complete: known && target > 0 && saved >= target,
    known,
    account,
    asOf: account ? account.balance_as_of || null : null
  };
}

// Whether the balance is recent enough to act on. An unknown date counts as too
// old: accounts synced before balances carried a date get one at the next sync.
function fundBalanceAge(progress, todayStr = todayLocal()) {
  return progress && progress.asOf ? daysBetween(progress.asOf, todayStr) : null;
}

function fundBalanceFresh(progress, todayStr = todayLocal()) {
  const age = fundBalanceAge(progress, todayStr);
  return age != null && age <= FUND_ASK_MAX_AGE_DAYS;
}

// How much of a surplus a capped fund takes. Its share is weighted by how empty
// it is: empty, it can take the whole surplus; half full, half of it; nine
// tenths full, a tenth. So it eases off as it nears the ceiling instead of
// swallowing surplus to close the last few dollars, while a large surplus still
// fills it: the share is capped only by the room left under the ceiling.
//
// The share is worked out from where the period started, not from now. `moved`
// is what has already gone into the fund from checking this period; the fund's
// balance less that is where it began, and the ask is its share less what's
// been moved. Without it, doing what the fund asked made it ask again: the
// surplus and the room both shrank, the taper re-applied, and "Move $400"
// became "Move $40", then "$21.60", all in the same period.
// `startSurplus` is the surplus as it was before any fund's moves this period
// (allocateToFunds adds them all back); on its own it defaults to this fund's.
function fundShare(fund, surplus, accounts, { moved = 0, startSurplus = null } = {}) {
  const progress = fundProgress(fund, accounts);
  const done = Math.max(0, round2(moved || 0));
  const now = Math.max(0, surplus || 0);
  const none = { amount: 0, weight: 0, progress, moved: done, periodShare: 0 };
  if (!progress.known || !(progress.target > 0)) return none;
  const startSaved = Math.max(0, progress.saved - done);
  const startRoom = Math.max(0, progress.target - startSaved);
  const begin = startSurplus == null ? now + done : Math.max(0, startSurplus);
  if (!(startRoom > 0) || !(begin > 0)) return none;
  const weight = Math.min(1, startRoom / progress.target);
  const periodShare = round2(Math.min(startRoom, begin * weight));
  const amount = round2(Math.min(periodShare - done, progress.remaining, now));
  if (!(amount >= FUND_MIN_SUGGESTION)) return Object.assign(none, { weight, periodShare });
  return { amount, weight, progress, moved: done, periodShare };
}

// Why a fund got what it got, in the words the Overview shows.
function fundReason(share) {
  const p = share.progress;
  const cap = `$${p.target.toFixed(2)} cap`;
  const moved = share.moved > 0 ? ` ($${share.moved.toFixed(2)} of $${share.periodShare.toFixed(2)} already moved in this period)` : "";
  // Only a balance that isn't overdrawn actually lands on the cap.
  if (Math.abs(share.amount - p.remaining) < 0.005 && p.saved >= 0) return `tops it up to its ${cap}${moved}`;
  const when = share.moved > 0 ? " when the period began" : "";
  const startSaved = p.saved - (share.moved || 0);
  if (startSaved <= 0) return `empty${when}, so it takes all of what's left toward its ${cap}${moved}`;
  // Floor, not round: 99.6% full reads "99% full, takes 1%", never "100% full,
  // takes 0%" beside a non-zero amount.
  const full = Math.max(1, Math.floor((startSaved / p.target) * 100));
  return `${full}% full${when}, so it takes ${100 - full}% of what's left \u2014 eases off near its ${cap}${moved}`;
}

// Whether a transfer pair still stands: both rows exist, point at each other,
// and are still filed alike. Relabelling either half (a mis-pair the user
// corrected) ends it, so it stops counting as a move and stops hiding the row
// from Mark Paid and the other candidate lists. The fields are left in place;
// a dead pair is simply ignored.
function livePairPartner(t, byId) {
  if (!t || !t.transfer_pair) return null;
  const partner = byId.get(t.transfer_pair);
  if (!partner || partner.transfer_pair !== t.id) return null;
  if ((partner.resolved_category || "") !== (t.resolved_category || "")) return null;
  return partner;
}

// What has gone into each capped fund from checking this period, net of what
// came back out. Counted from live transfer pairs whose other half is in the
// cash-on-hand account (the first checking account, the one whose balance the
// surplus is measured from), dated by that half: it is when the cash left that
// matters, and a transfer that left last period and landed this one belongs to
// last period.
function fundMovesThisPeriod(transactions, goals, accounts, fromStr, toStr) {
  const funds = cappedFunds(goals).filter((f) => f.account_id);
  const out = {};
  if (!funds.length || !fromStr) return out;
  const cash = cashAccount(accounts);
  if (!cash) return out;
  const byId = new Map((transactions || []).filter((t) => t && t.id).map((t) => [t.id, t]));
  funds.forEach((fund) => {
    let net = 0;
    (transactions || []).forEach((t) => {
      if (!t || t.account_id !== fund.account_id) return;
      const partner = livePairPartner(t, byId);
      if (!partner || partner.account_id !== cash.id || !partner.date) return;
      if (partner.date < fromStr || (toStr && partner.date >= toStr)) return;
      net += Number(t.amount) || 0;
    });
    out[fund.id] = round2(net);
  });
  return out;
}

// Splits a surplus across capped funds, emptiest first, each taking its
// weighted share of what the ones before it left. Only ever handed money that
// is already surplus; it never reaches into obligations or the spending buffer.
// A fund whose balance is unknown or too old to trust asks for nothing.
//
// The split is made on the period's starting position: every fund's moves are
// added back to the surplus first, each share comes out of that, and only then
// does each fund's own moves come off its ask. Adding back one fund's moves at
// a time let a move into one fund change what the others asked for.
// `periods` reports, per fund, what it was due this period and what has been
// moved, so the Overview can say it's done for the period rather than nothing.
function allocateToFunds(goals, surplus, accounts, { moves = {}, todayStr = todayLocal() } = {}) {
  const breakdown = [];
  const periods = {};
  const eligible = cappedFunds(goals)
    .map((fund) => {
      const p = fundProgress(fund, accounts);
      const moved = Math.max(0, round2((moves && moves[fund.id]) || 0));
      const startPct = p.target > 0 ? Math.max(0, p.saved - moved) / p.target : 1;
      return { fund, p, moved, startPct };
    })
    .filter((x) => x.p.known && fundBalanceFresh(x.p, todayStr))
    .sort((a, b) => a.startPct - b.startPct);
  let now = Math.max(0, round2(surplus));
  let start = round2(now + eligible.reduce((sum, x) => sum + x.moved, 0));
  eligible.forEach(({ fund, moved }) => {
    const share = fundShare(fund, now, accounts, { moved, startSurplus: start });
    periods[fund.id] = { moved: share.moved, share: share.periodShare };
    start = round2(Math.max(0, start - share.periodShare));
    if (share.amount <= 0) return;
    breakdown.push({ id: fund.id, target: fund.name, amount: share.amount, reason: fundReason(share), fund: true });
    now = round2(now - share.amount);
  });
  return { breakdown, total: round2(breakdown.reduce((s, b) => s + b.amount, 0)), periods };
}

// Capped funds' accounts. Money in them is the fund's, not this period's cash:
// spending paid straight from a fund mustn't draw down the spending allowance,
// and its history mustn't size the allowance either. A bill paid from one is
// still a bill paid, though, so those rows stay visible to the matching that
// releases a bill's reserve — see classifyBufferSpending's outsideAllowance.
function fundAccountIds(goals) {
  return new Set(cappedFunds(goals).map((f) => f.account_id).filter(Boolean));
}

function withoutFundAccountRows(transactions, goals) {
  const ids = fundAccountIds(goals);
  if (!ids.size) return transactions || [];
  return (transactions || []).filter((t) => !(t && ids.has(t.account_id)));
}

// Which category the two halves of a fund transfer are filed under when
// neither half already has one. "Savings" is where this plugin has always filed
// money moved to savings (see linkContribution). A name someone has made count
// as spending is left alone and the next free name is used, so no existing
// category is ever flipped from spending to transfer.
function fundTransferCategory(categoryMeta) {
  const byName = new Map((categoryMeta || []).filter((c) => c && c.name).map((c) => [c.name, c]));
  for (let n = 1; n < 50; n++) {
    const name = n === 1 ? "Savings" : n === 2 ? "Savings Transfer" : `Savings Transfer ${n - 1}`;
    const c = byName.get(name);
    if (!c) return { name, create: true };
    if (c.is_transfer) return { name, create: false };
  }
  return { name: "Savings Transfer (capped funds)", create: true };
}

// The two halves of transfers between a capped fund's account and any other
// account, so that neither half reads as spending or income.
//
// Deliberately narrow, because a wrong pair hides real spending. The half
// outside the fund is the one that would otherwise count as spending or income,
// so it has to show on its own that it is a transfer:
//   - the fund-side half must be uncategorised, and not labelled by hand;
//   - the other half must be filed as a transfer that isn't a debt payment, or
//     be uncategorised with a description that reads like a transfer ("To Share
//     00", "Online Transfer to SAV"). A $100 ATM withdrawal and a $100 direct
//     deposit into savings two days apart are not a transfer, and neither is a
//     Zelle payment that happens to say "transfer";
//   - never a credit card's row, nor anything filed as a debt payment. A card
//     payment the same size as a savings move on the same payday is common, and
//     pairing with it would leave the real transfer counted as spending;
//   - opposite signs, the same amount to the cent, posted within
//     FUND_TRANSFER_WINDOW_DAYS of each other;
//   - each half pairs once, ever. transfer_pair records the partner, and a half
//     whose partner still exists is never offered again.
// Nearest dates pair first, then a half already filed as a transfer over one
// that only reads like one. Returns what to change; applyFundTransferPairs
// changes it. `accounts` (to know the cards) and `debtCategories` are optional
// so the rules can be tested on their own.
function pairFundTransfers(transactions, goals, categoryMeta, { accounts = null, debtCategories = null } = {}) {
  const funds = cappedFunds(goals).filter((f) => f.account_id);
  if (!funds.length) return [];
  const txs = transactions || [];
  const cards = new Set((accounts || []).filter((a) => a && a.type === "credit_card").map((a) => a.id));
  const debtCats = new Set(["Credit Card Payment", "BNPL"].concat([...(debtCategories || [])]));
  const transferNames = new Set(
    (categoryMeta || []).filter((c) => c && c.is_transfer && c.name && !debtCats.has(c.name)).map((c) => c.name)
  );
  const uncategorised = (t) => !t.override_label && (!t.resolved_category || t.resolved_category === "Uncategorized");
  const readsAsTransfer = (t) => {
    const d = String(t.merchant_raw || "");
    return TRANSFER_WORDS.test(d) && !P2P_WORDS.test(d);
  };
  const byId = new Map(txs.filter((t) => t && t.id).map((t) => [t.id, t]));
  const usable = (t) =>
    !!t &&
    !!t.id &&
    !!t.date &&
    !!t.account_id &&
    Number.isFinite(t.amount) &&
    t.amount !== 0 &&
    !livePairPartner(t, byId);
  const fallback = fundTransferCategory(categoryMeta).name;

  const used = new Set();
  const out = [];
  funds.forEach((fund) => {
    const fundSide = [];
    const otherSide = [];
    txs.forEach((t, i) => {
      if (used.has(i) || !usable(t)) return;
      if (t.account_id === fund.account_id) {
        // Pay landing in savings (a split direct deposit) is income, however
        // neatly its amount lines up with something.
        if (uncategorised(t) && !PAY_WORDS.test(String(t.merchant_raw || ""))) fundSide.push(i);
      } else if (!cards.has(t.account_id)) {
        if (transferNames.has(t.resolved_category) || (uncategorised(t) && readsAsTransfer(t))) otherSide.push(i);
      }
    });
    if (!fundSide.length || !otherSide.length) return;

    const candidates = [];
    fundSide.forEach((fi) => {
      const f = txs[fi];
      otherSide.forEach((oi) => {
        const o = txs[oi];
        if (Math.sign(o.amount) === Math.sign(f.amount)) return;
        if (Math.abs(Math.abs(o.amount) - Math.abs(f.amount)) > 0.005) return;
        // You said these two aren't a transfer.
        if (notTransferTogether(f, o)) return;
        const gap = Math.abs(daysBetween(f.date, o.date));
        if (!(gap <= FUND_TRANSFER_WINDOW_DAYS)) return;
        candidates.push({ fi, oi, gap, filed: transferNames.has(o.resolved_category) ? 0 : 1, told: readsAsTransfer(f) ? 0 : 1 });
      });
    });
    candidates
      // A fund-side row that reads like a transfer beats one that doesn't, so
      // of two same-sized deposits the transfer is taken, not the stray one.
      .sort((a, b) => a.gap - b.gap || a.filed - b.filed || a.told - b.told || a.fi - b.fi || a.oi - b.oi)
      .forEach(({ fi, oi }) => {
        if (used.has(fi) || used.has(oi)) return;
        used.add(fi);
        used.add(oi);
        const other = txs[oi];
        out.push({
          fundId: fund.id,
          fundIndex: fi,
          otherIndex: oi,
          category: transferNames.has(other.resolved_category) ? other.resolved_category : fallback,
          labelOther: uncategorised(other)
        });
      });
  });
  return out;
}

function applyFundTransferPairs(transactions, pairs) {
  (pairs || []).forEach((p) => {
    const f = transactions[p.fundIndex];
    const o = transactions[p.otherIndex];
    if (!f || !o) return;
    f.override_label = p.category;
    f.resolved_category = p.category;
    f.transfer_pair = o.id;
    o.transfer_pair = f.id;
    if (p.labelOther) {
      o.override_label = p.category;
      o.resolved_category = p.category;
    }
  });
  return (pairs || []).length;
}

// ---------- transfers between your own accounts ----------
//
// Money moved from one of your accounts to another shows up twice: -$200 in
// one, +$200 in the other, a day or so apart. Neither half is spending or
// income. The plugin finds halves that match — the same amount to the cent,
// opposite signs, different accounts, within TRANSFER_REVIEW_DAYS — but only
// suggests them: a real purchase can come to exactly what a transfer did, so
// every pair waits for you to say it's a transfer. A confirmed pair is filed as
// a transfer on both sides and kept off the transaction list; a pair you say
// isn't one is never suggested again.
const TRANSFER_REVIEW_DAYS = 5;

function readsLikeTransfer(t) {
  const d = String((t && t.merchant_raw) || "");
  return TRANSFER_WORDS.test(d) && !P2P_WORDS.test(d);
}

// Kept off the transaction list: half of a confirmed pair, or a single row you
// marked as a transfer whose other half isn't in the plugin.
function isHiddenTransfer(t, byId) {
  return !!(t && (t.transfer_single || livePairPartner(t, byId)));
}

function notTransferTogether(a, b) {
  return (a.not_transfer_with || []).includes(b.id) || (b.not_transfer_with || []).includes(a.id);
}

// Pairs worth asking about, newest first. Each row is offered in one pair at
// most: nearest dates first, then a pair whose descriptions both read like a
// transfer ("To Savings 01", "Online Transfer from CHK"). `likely` marks those;
// they're the only ones "confirm all" takes. A row you've marked as a transfer
// on its own is offered with a half that arrives later. With `accounts`, a
// charge on a credit card is never offered: money leaving a card for one of
// your accounts would be a cash advance, and every purchase that happened to
// match a deposit would otherwise be asked about. Payments into a card are.
function transferCandidates(transactions, accounts = null) {
  const cards = new Set((accounts || []).filter((a) => a && a.type === "credit_card").map((a) => a.id));
  const txs = (transactions || []).filter((t) => t && t.id);
  const byId = new Map(txs.map((t) => [t.id, t]));
  const usable = (t) =>
    !!t.date && !t.pending && Number.isFinite(t.amount) && t.amount !== 0 && !!t.account_id && !livePairPartner(t, byId);
  const buckets = new Map();
  txs.filter(usable).forEach((t) => {
    const k = Math.round(Math.abs(t.amount) * 100);
    if (!buckets.has(k)) buckets.set(k, []);
    buckets.get(k).push(t);
  });
  const found = [];
  buckets.forEach((rows) => {
    const outs = rows.filter((t) => t.amount < 0 && !cards.has(t.account_id));
    const ins = rows.filter((t) => t.amount > 0);
    outs.forEach((o) =>
      ins.forEach((i) => {
        if (o.account_id === i.account_id || notTransferTogether(o, i)) return;
        const gap = Math.abs(daysBetween(o.date, i.date));
        if (!(gap <= TRANSFER_REVIEW_DAYS)) return;
        found.push({ out: o, in: i, gap, likely: readsLikeTransfer(o) && readsLikeTransfer(i) });
      })
    );
  });
  found.sort((a, b) => a.gap - b.gap || (b.likely ? 1 : 0) - (a.likely ? 1 : 0) || (a.out.id < b.out.id ? -1 : 1) || (a.in.id < b.in.id ? -1 : 1));
  const used = new Set();
  const out = [];
  found.forEach((c) => {
    if (used.has(c.out.id) || used.has(c.in.id)) return;
    used.add(c.out.id);
    used.add(c.in.id);
    out.push(c);
  });
  const latest = (c) => (c.out.date > c.in.date ? c.out.date : c.in.date);
  return out.sort((a, b) => (latest(a) < latest(b) ? 1 : latest(a) > latest(b) ? -1 : 0));
}

// "Transfer" for a move between your own accounts, unless you've made a
// category by that name that counts as spending — then the next free name.
function accountTransferCategory(categoryMeta) {
  const byName = new Map((categoryMeta || []).filter((c) => c && c.name).map((c) => [c.name, c]));
  for (let n = 1; n < 50; n++) {
    const name = n === 1 ? "Transfer" : n === 2 ? "Account Transfer" : `Account Transfer ${n - 1}`;
    const c = byName.get(name);
    if (!c) return { name, create: true };
    if (c.is_transfer) return { name, create: false };
  }
  return { name: "Transfer (between accounts)", create: true };
}

// What a confirmed transfer is filed under. Money into a card is paying it, so
// it's the card's payment category — that's what the Debts tab and the payment
// matching read. Otherwise a transfer category one half is already filed under
// (Savings, say) is kept, so both halves agree; otherwise Transfer.
function transferCategoryFor(rows, { accounts = [], revolvingDebts = [], categoryMeta = [] } = {}) {
  const card = rows.map((t) => (accounts || []).find((a) => a && a.id === t.account_id)).find((a) => a && a.type === "credit_card");
  if (card) {
    const debt = (revolvingDebts || []).find((d) => d && d.account_id === card.id);
    const name = (debt && debt.payment_category) || "Credit Card Payment";
    return { name, create: !(categoryMeta || []).some((c) => c && c.name === name) };
  }
  const debtCats = new Set(["Credit Card Payment", "BNPL"].concat((revolvingDebts || []).map((d) => d && d.payment_category).filter(Boolean)));
  const transferNames = new Set((categoryMeta || []).filter((c) => c && c.is_transfer && !debtCats.has(c.name)).map((c) => c.name));
  const already = rows.map((t) => t.resolved_category).find((c) => transferNames.has(c));
  if (already) return { name: already, create: false };
  return accountTransferCategory(categoryMeta);
}

// Files a row as a transfer, remembering what you'd labelled it so undoing it
// puts that back.
function fileAsTransfer(t, category) {
  if (!("transfer_prev_label" in t)) t.transfer_prev_label = t.override_label || null;
  t.override_label = category;
  t.resolved_category = category;
}

// Confirms two rows (by id) as one transfer. Changes `transactions` in place.
function confirmTransferPair(transactions, outId, inId, category) {
  const o = (transactions || []).find((t) => t && t.id === outId);
  const i = (transactions || []).find((t) => t && t.id === inId);
  if (!o || !i || o === i) return false;
  [o, i].forEach((t) => {
    fileAsTransfer(t, category);
    delete t.transfer_single;
  });
  o.transfer_pair = i.id;
  i.transfer_pair = o.id;
  return true;
}

// Undoes a transfer, for the row and its other half: what you'd labelled them
// comes back (a pair the plugin filed for a capped fund keeps its label — it
// had none of yours to restore), they're no longer paired, and they won't be
// suggested together again. The caller re-runs categorisation.
function undoTransfer(transactions, id) {
  const t = (transactions || []).find((x) => x && x.id === id);
  if (!t) return [];
  const partner = t.transfer_pair ? (transactions || []).find((x) => x && x.id === t.transfer_pair && x.transfer_pair === t.id) : null;
  const rows = [t, partner].filter(Boolean);
  rows.forEach((r) => {
    if ("transfer_prev_label" in r) {
      if (r.transfer_prev_label) r.override_label = r.transfer_prev_label;
      else delete r.override_label;
      delete r.transfer_prev_label;
    }
    delete r.transfer_pair;
    delete r.transfer_single;
  });
  if (partner) {
    t.not_transfer_with = [...new Set((t.not_transfer_with || []).concat(partner.id))];
    partner.not_transfer_with = [...new Set((partner.not_transfer_with || []).concat(t.id))];
  }
  return rows;
}

// ---------- savings goals ----------

// `accounts` is only needed for a capped fund, whose progress is its account's
// balance; an ordinary goal ignores it.
function goalProgress(goal, accounts = null) {
  if (isCappedFund(goal)) return fundProgress(goal, accounts);
  const target = goal.target_amount || 0;
  const saved = goal.saved_amount || 0;
  return {
    saved: round2(saved),
    target: round2(target),
    remaining: round2(Math.max(0, target - saved)),
    pct: target > 0 ? Math.min(100, (saved / target) * 100) : 0,
    complete: target > 0 && saved >= target
  };
}

// The actual paydays falling in (fromDateStr, toDateStr]. Counting real dates
// matters: a goal due in 21 days is funded by however many paychecks actually
// land in that window, not by 21 divided by some period length.
function paydaysBetween(schedule, fromDateStr, toDateStr) {
  if (!schedule || !schedule.anchor_date || !toDateStr) return null;
  const out = [];
  let cursor = fromDateStr;
  for (let i = 0; i < 400; i++) {
    const next = nextPaydayFrom(schedule, cursor);
    if (!next || next > toDateStr) break;
    // Defensive: if the date doesn't move forward, the schedule can't be walked
    // and looping would just repeat the same day up to the guard limit.
    if (next <= cursor) break;
    out.push(next);
    cursor = next;
  }
  return out;
}

// What each remaining paycheck needs to carry to land the goal on time.
function goalPace(goal, todayStr, periodDays, schedule) {
  if (!goal.target_date) return null;
  const days = daysBetween(todayStr, goal.target_date);
  const remaining = Math.max(0, (goal.target_amount || 0) - (goal.saved_amount || 0));
  if (remaining <= 0) return { days, perPeriod: 0, paychecks: 0, exact: true, onTrack: true };
  if (days <= 0) return { days, perPeriod: remaining, paychecks: 0, exact: true, onTrack: false };

  // Preferred: count the paychecks that actually arrive before the target date.
  const paydays = paydaysBetween(schedule, todayStr, goal.target_date);
  if (paydays) {
    if (paydays.length === 0) {
      // Target lands before the next payday — it all has to come from this one.
      return { days, perPeriod: round2(remaining), paychecks: 0, exact: true, onTrack: false };
    }
    return {
      days,
      paychecks: paydays.length,
      perPeriod: round2(remaining / paydays.length),
      lastPayday: paydays[paydays.length - 1],
      exact: true,
      inferred: !!schedule.inferred,
      onTrack: true
    };
  }

  // Nothing to go on: assume a normal two-week cycle rather than the current
  // period's length, which is often a partial window and badly skews the result.
  const cycle = periodDays && periodDays >= 7 ? periodDays : 14;
  const periods = Math.max(1, days / cycle);
  return { days, perPeriod: round2(remaining / periods), paychecks: null, exact: false, onTrack: true };
}

async function addGoalFunds(app, goalId, amount, note) {
  const goals = await readJSON(app, FILES.savingsGoals, []);
  const idx = goals.findIndex((g) => g.id === goalId);
  if (idx < 0) return null;
  const today = todayLocal();
  goals[idx].saved_amount = round2((goals[idx].saved_amount || 0) + amount);
  goals[idx].contributions = (goals[idx].contributions || []).concat([
    { id: genId("contrib"), date: today, amount: round2(amount), note: note || null, linked_tx_id: null }
  ]);
  await writeJSON(app, FILES.savingsGoals, goals);
  return goals[idx];
}

// Money promised to a goal but not yet actually moved out of checking. It's
// still sitting in the balance, so it has to come off free cash or it gets
// spent twice. Once a contribution is linked to a real transfer the money has
// physically left the account, the balance already reflects it, and deducting
// again here would double-count — so linked contributions are excluded.
function earmarkedSavings(goals) {
  return round2(
    (goals || []).reduce(
      (sum, g) =>
        sum +
        (g.contributions || [])
          .filter((c) => !c.linked_tx_id && c.amount > 0)
          .reduce((s, c) => s + c.amount, 0),
      0
    )
  );
}


// Outgoing transactions that could be this contribution: same amount, not
// already claimed by another contribution, nearest date first.
function contributionCandidates(contribution, transactions, goals, ownership = null, context = {}) {
  const index = ownership || completeOwnership(Object.assign({ goals }, context));
  return findCandidateTransactions({
    transactions,
    ownership: index,
    near: contribution.date,
    targetAmount: contribution.amount,
    exactAmount: true,
    forClass: "savings",
    rank: "date"
  });
}

async function linkContribution(app, goalId, contributionId, tx, savingsCategory = "Savings") {
  const goals = await readJSON(app, FILES.savingsGoals, []);
  const gi = goals.findIndex((g) => g.id === goalId);
  if (gi < 0) return null;
  const ci = (goals[gi].contributions || []).findIndex((c) => c.id === contributionId);
  if (ci < 0) return null;

  goals[gi].contributions[ci].linked_tx_id = tx.id;
  goals[gi].contributions[ci].linked_tx_date = tx.date;
  await writeJSON(app, FILES.savingsGoals, goals);

  // Categorize the matching transaction, and make sure the category counts as a
  // transfer so moving money to savings isn't reported as spending.
  const txs = await readJSON(app, FILES.transactions, []);
  const ti = txs.findIndex((t) => t.id === tx.id);
  if (ti >= 0) {
    txs[ti].override_label = savingsCategory;
    const rules = await readJSON(app, FILES.rules, []);
    applyCategorization(txs, rules);
    await writeJSON(app, FILES.transactions, txs);
  }
  await setCategoryTransfer(app, savingsCategory, true);
  return goals[gi];
}

async function unlinkContribution(app, goalId, contributionId) {
  const goals = await readJSON(app, FILES.savingsGoals, []);
  const gi = goals.findIndex((g) => g.id === goalId);
  if (gi < 0) return null;
  const ci = (goals[gi].contributions || []).findIndex((c) => c.id === contributionId);
  if (ci < 0) return null;
  goals[gi].contributions[ci].linked_tx_id = null;
  delete goals[gi].contributions[ci].linked_tx_date;
  await writeJSON(app, FILES.savingsGoals, goals);
  return goals[gi];
}

async function deleteContribution(app, goalId, contributionId) {
  const goals = await readJSON(app, FILES.savingsGoals, []);
  const gi = goals.findIndex((g) => g.id === goalId);
  if (gi < 0) return null;
  const list = goals[gi].contributions || [];
  const ci = list.findIndex((c) => c.id === contributionId);
  if (ci < 0) return null;
  const removed = list[ci];
  goals[gi].saved_amount = round2(Math.max(0, (goals[gi].saved_amount || 0) - removed.amount));
  list.splice(ci, 1);
  await writeJSON(app, FILES.savingsGoals, goals);
  return goals[gi];
}

// ---------- goals linked to a savings account ----------
//
// An ordinary goal can optionally follow a savings account. Unlike a capped
// fund, whose balance *is* its account's, several goals can share one account,
// so the account's balance can't say how much is each goal's. What it can say
// is where each transfer went: every row in the account — money in, or money
// taken back out — belongs to one of the goals on it, and adds to (or comes
// off) that goal's saved amount as a contribution linked to the row.
//
// One goal on the account: its transfers go to it on their own. Several: each
// transfer waits for you to say which goal it was for. A contribution you
// logged by hand (Add Funds) that the transfer carries out — same amount,
// within GOAL_CONTRIBUTION_MATCH_DAYS — is linked instead of adding the money
// twice, and when only one of the goals has such a contribution, that settles
// which goal the transfer was for.
const GOAL_CONTRIBUTION_MATCH_DAYS = 7;

function accountGoals(goals) {
  return regularGoals(goals).filter((g) => g && g.id && g.account_id);
}

// The contribution on `goal` that `tx` carries out: not yet matched to any
// transaction, the same signed amount to the cent, logged within the window;
// the nearest date wins. `taken` holds contribution ids already spoken for.
function pendingContributionFor(goal, tx, taken = null) {
  let best = null;
  let bestGap = Infinity;
  (goal.contributions || []).forEach((c) => {
    if (!c || c.linked_tx_id || !c.date || (taken && taken.has(c.id))) return;
    if (Math.abs((Number(c.amount) || 0) - tx.amount) > 0.005) return;
    const gap = Math.abs(daysBetween(c.date, tx.date));
    if (gap <= GOAL_CONTRIBUTION_MATCH_DAYS && gap < bestGap) {
      best = c;
      bestGap = gap;
    }
  });
  return best;
}

// Which rows in goal-linked accounts still need a goal. Returns
//   auto — { tx, goalId, contributionId } the rules above settle on their own;
//   ask  — { tx, goalIds, suggested } for you to choose, oldest first.
// A row is left alone when:
//   - a contribution already links it (on any goal);
//   - it's the savings-side half of a transfer whose checking-side half a
//     goal's contribution was matched to by hand (Match transaction) — the
//     same money, already counted;
//   - it's marked "not for a goal" (goal_skip), is still pending, or is dated
//     before every goal on the account started counting (track_from).
// A row whose assignment was undone (goal_review) is always asked about, so
// undoing it doesn't just make the next sync redo it.
function goalTransferQueue(transactions, goals) {
  const out = { auto: [], ask: [] };
  const linked = accountGoals(goals);
  if (!linked.length) return out;
  const txs = (transactions || []).filter((t) => t && t.id);
  const byId = new Map(txs.map((t) => [t.id, t]));
  const accountIds = new Set(linked.map((g) => g.account_id));

  const claimed = new Set();
  (goals || []).forEach((g) => ((g && g.contributions) || []).forEach((c) => c && c.linked_tx_id && claimed.add(c.linked_tx_id)));
  linked.forEach((g) =>
    (g.contributions || []).forEach((c) => {
      const half = c && c.linked_tx_id ? byId.get(c.linked_tx_id) : null;
      if (!half || half.account_id === g.account_id || !half.date || !Number.isFinite(half.amount)) return;
      let best = null;
      let bestGap = Infinity;
      txs.forEach((t) => {
        if (t.account_id !== g.account_id || claimed.has(t.id) || !t.date || !Number.isFinite(t.amount)) return;
        if (Math.sign(t.amount) === Math.sign(half.amount) || Math.abs(t.amount + half.amount) > 0.005) return;
        const gap = Math.abs(daysBetween(half.date, t.date));
        if (gap <= FUND_TRANSFER_WINDOW_DAYS && gap < bestGap) {
          best = t;
          bestGap = gap;
        }
      });
      if (best) claimed.add(best.id);
    })
  );

  const taken = new Set();
  txs
    .filter(
      (t) =>
        accountIds.has(t.account_id) &&
        !claimed.has(t.id) &&
        !t.goal_skip &&
        !t.pending &&
        t.date &&
        Number.isFinite(t.amount) &&
        t.amount !== 0
    )
    .sort((a, b) => (a.date < b.date ? -1 : a.date > b.date ? 1 : 0))
    .forEach((t) => {
      const eligible = linked.filter((g) => g.account_id === t.account_id && (!g.track_from || g.track_from <= t.date));
      if (!eligible.length) return;
      const hits = eligible.map((g) => ({ g, c: pendingContributionFor(g, t, taken) })).filter((h) => h.c);
      if (!t.goal_review && hits.length === 1) {
        taken.add(hits[0].c.id);
        out.auto.push({ tx: t, goalId: hits[0].g.id, contributionId: hits[0].c.id });
      } else if (!t.goal_review && !hits.length && eligible.length === 1) {
        out.auto.push({ tx: t, goalId: eligible[0].id, contributionId: null });
      } else {
        out.ask.push({ tx: t, goalIds: eligible.map((g) => g.id), suggested: hits.map((h) => h.g.id) });
      }
    });
  return out;
}

// Puts a transfer on a goal, in `goals` (changed in place): links the logged
// contribution it carries out when there is one (that money is already in
// saved_amount), otherwise adds it as a new contribution. Money taken back out
// of the account comes off the goal the same way. Returns what it did, or null
// when the goal isn't there.
function assignGoalTransfer(goals, tx, goalId, contributionId = null) {
  const goal = (goals || []).find((g) => g && g.id === goalId && !isCappedFund(g));
  if (!goal || !tx) return null;
  const logged = contributionId
    ? (goal.contributions || []).find((c) => c && c.id === contributionId && !c.linked_tx_id) || null
    : pendingContributionFor(goal, tx);
  if (logged) {
    logged.linked_tx_id = tx.id;
    logged.linked_tx_date = tx.date;
    return { goal, contribution: logged, matched: true };
  }
  const contribution = {
    id: genId("contrib"),
    date: tx.date,
    amount: round2(tx.amount),
    note: null,
    linked_tx_id: tx.id,
    linked_tx_date: tx.date,
    source: "account"
  };
  goal.contributions = (goal.contributions || []).concat([contribution]);
  goal.saved_amount = round2((Number(goal.saved_amount) || 0) + contribution.amount);
  return { goal, contribution, matched: false };
}

// The account-side row of an assigned transfer, filed as a transfer (so money
// arriving in savings isn't read as income, nor money leaving it as spending)
// unless you've already filed it yourself. Its queue flags are cleared.
function fileGoalTransferRow(tx, category) {
  if (!tx) return;
  delete tx.goal_skip;
  delete tx.goal_review;
  const uncategorised = !tx.override_label && (!tx.resolved_category || tx.resolved_category === "Uncategorized");
  if (uncategorised && category) {
    tx.override_label = category;
    tx.resolved_category = category;
  }
}

// What an account-linked goal can follow: savings-type accounts, not checking
// (that's the cash the budget counts), not a card, and not one backing a capped
// fund (its balance is the fund's, all of it).
function goalAccountChoices(accounts, goals, goal = null) {
  const fundAccounts = fundAccountIds(goals);
  return (accounts || [])
    .filter((a) => a && a.id && a.type !== "checking" && a.type !== "credit_card" && (!fundAccounts.has(a.id) || (goal && goal.account_id === a.id)))
    .map((a) => {
      const others = accountGoals(goals).filter((g) => g.account_id === a.id && (!goal || g.id !== goal.id)).map((g) => g.name);
      return { id: a.id, label: accountLabel(a), others };
    });
}

function goalTransfersAddedText(n) {
  return n ? ` Counted ${n} savings transfer${n === 1 ? "" : "s"} toward ${n === 1 ? "its goal" : "their goals"}.` : "";
}

// ---------- subscription audit ----------

const MONTH_DAYS = 30.44;

// Interval in days for each manually selectable cadence.
const CADENCE_PRESETS = {
  weekly: 7,
  biweekly: 14,
  monthly: 30.44,
  quarterly: 91.31,
  semiannual: 182.62,
  yearly: 365.25
};

const CADENCE_LABELS = {
  weekly: "Weekly",
  biweekly: "Biweekly",
  monthly: "Monthly",
  quarterly: "Quarterly",
  semiannual: "Every 6 mo",
  yearly: "Yearly"
};

const SUBSCRIPTION_CATEGORIES = ["subscription"];

// "Flagged to cancel" and "confirmed gone" are different questions. The first is
// a status the user set; the second is a fact derived from evidence, and only
// evidence can retire a row — the same split as class vs settles in debt
// ownership. Conflating them would quietly hide a subscription that is still
// billing, which is the exact failure this feature exists to prevent.
//
// Four conditions, all required. Each one that fails names itself, because a
// button that silently never appears is indistinguishable from a broken one:
//   status    — still flagged keep or unreviewed; nothing to confirm yet
//   cadence   — a single charge with a guessed cadence is not evidence of
//               anything; "one full cadence" has no meaning without a cadence
//   not-due   — the next charge was not expected yet, so its absence proves
//               nothing
//   charged   — something from this merchant posted on or after that date
//   stale     — the account has not imported far enough to have seen it
//
// `stale` is the load-bearing one. Without it, an un-imported CSV looks exactly
// like a cancelled subscription.
function subscriptionPhaseOut({ status, latestDate, cadenceKey, chargeCount, cadenceSource }, opts = {}) {
  const { todayStr, accountIds = [], accountsById = new Map(), lastChargeAnywhere = null, unknownAccount = false } = opts;

  const base = { eligible: false, blockedBy: null, expectedDate: null, staleAccounts: [] };
  if (status !== "cancel") return Object.assign(base, { blockedBy: "status" });

  // An inferred cadence needed two charges to exist; a manual one is the user
  // telling us outright. Only a lone charge with a guessed "monthly" is too
  // thin — it could as easily be an annual plan four months into its year.
  // Setting the cadence by hand is the way out, so this is a prompt, not a wall.
  if (cadenceSource === "assumed" && chargeCount < 2) return Object.assign(base, { blockedBy: "cadence" });

  // The charge that should have arrived is the first renewal AFTER the last one
  // seen — not the next one from today, which is in the future by construction
  // and could never be overdue.
  const expectedDate = nextRenewalDate(latestDate, cadenceKey, addDays(latestDate, 1));
  if (!expectedDate) return Object.assign(base, { blockedBy: "not-due" });
  const withDate = Object.assign(base, { expectedDate });

  if (!(expectedDate < todayStr)) return Object.assign(withDate, { blockedBy: "not-due" });

  // Any charge from this merchant counts, not just the ones that landed in the
  // group: a renewal that posted under a different category, or arrived as a
  // refund, still says the subscription is alive.
  if (lastChargeAnywhere && lastChargeAnywhere >= expectedDate) {
    return Object.assign(withDate, { blockedBy: "charged" });
  }

  // Every account the group ever billed on has to have seen past the expected
  // date — not just one of them, or a service that moved cards would confirm
  // off the stale card's silence.
  if (unknownAccount || accountIds.length === 0) return Object.assign(withDate, { blockedBy: "stale" });
  const staleAccounts = accountIds.filter((id) => {
    const acct = accountsById.get(id);
    const through = acct && acct.last_imported_through;
    return !through || through < expectedDate;
  });
  if (staleAccounts.length) return Object.assign(withDate, { blockedBy: "stale", staleAccounts });

  return Object.assign(withDate, { eligible: true });
}

// Groups real transactions (not fixed_expenses) by merchant so recurring
// charges can be reviewed against what actually hit the account.
//
// `options.accounts` unlocks the phase-out CTA: without it the import-freshness
// condition cannot be checked, so no row is ever offered as confirmable. The
// confirmed/reappeared state is derived regardless, so a group the user already
// retired stays retired for every reader.
function buildSubscriptionAudit(transactions, reviews, rules = [], categoryNames = SUBSCRIPTION_CATEGORIES, options = {}) {
  const wanted = categoryNames.map((c) => c.toLowerCase());
  const reviewMap = new Map((reviews || []).map((r) => [r.merchant_key, r]));
  const accounts = options.accounts || null;
  const todayStr = options.todayStr || todayLocal();
  const includePhasedOut = !!options.includePhasedOut;

  // Only paid for when eligibility is actually being evaluated — every other
  // caller keeps its original single pass over the filtered subset.
  let lastSeenByKey = null;
  let accountsById = null;
  if (accounts) {
    accountsById = new Map((accounts || []).map((a) => [a.id, a]));
    lastSeenByKey = new Map();
    (transactions || []).forEach((t) => {
      if (!t || !t.date) return;
      const k = subscriptionGroupKey(t.merchant_raw, rules);
      const prev = lastSeenByKey.get(k);
      if (!prev || t.date > prev) lastSeenByKey.set(k, t.date);
    });
  }

  const groups = new Map();
  transactions
    .filter((t) => t.amount < 0)
    .filter((t) => wanted.includes((t.resolved_category || "").toLowerCase()))
    .forEach((t) => {
      const key = subscriptionGroupKey(t.merchant_raw, rules);
      if (!groups.has(key)) groups.set(key, []);
      groups.get(key).push(t);
    });

  const out = [];
  groups.forEach((txs, key) => {
    txs.sort((a, b) => (a.date < b.date ? -1 : a.date > b.date ? 1 : 0));
    const latest = txs[txs.length - 1];
    const amounts = txs.map((t) => Math.abs(t.amount));
    const latestAmount = Math.abs(latest.amount);

    // Infer cadence from the gaps between charges; fall back to monthly.
    let intervalDays = null;
    if (txs.length >= 2) {
      const gaps = [];
      for (let i = 1; i < txs.length; i++) {
        const g = daysBetween(txs[i - 1].date, txs[i].date);
        if (g > 0) gaps.push(g);
      }
      if (gaps.length) {
        gaps.sort((a, b) => a - b);
        intervalDays = gaps[Math.floor(gaps.length / 2)]; // median resists odd gaps
      }
    }

    const review = reviewMap.get(key);
    const override = review && review.cadence_override ? review.cadence_override : null;

    // A manual cadence always wins — inference can't know that an annual plan
    // billed once simply hasn't come around again yet.
    let safeInterval;
    let cadenceLabel;
    let cadenceSource;
    if (override && CADENCE_PRESETS[override]) {
      safeInterval = CADENCE_PRESETS[override];
      cadenceLabel = CADENCE_LABELS[override];
      cadenceSource = "manual";
    } else {
      safeInterval = intervalDays && intervalDays >= 1 && intervalDays <= 400 ? intervalDays : MONTH_DAYS;
      cadenceLabel = describeCadence(intervalDays);
      cadenceSource = intervalDays ? "inferred" : "assumed";
    }

    const monthlyEstimate = round2(latestAmount * (MONTH_DAYS / safeInterval));

    // The one cadence everything downstream agrees on. Resolving it here rather
    // than at each call site keeps the date the row DISPLAYS and the date
    // phase-out reasons about from ever drifting apart.
    const cadenceKey = override && CADENCE_PRESETS[override] ? override : inferCadenceKey(intervalDays);

    const storedStatus = review ? review.status : "unreviewed";
    const fadedOutAfter = review && review.faded_out_after ? review.faded_out_after : null;
    const fadedOutAt = review && review.faded_out_at ? review.faded_out_at : null;

    // A charge later than the last one we had when it was retired means it came
    // back — no manual un-phase step, and no way for a resumed charge to stay
    // hidden. Comparing against the evidence rather than the date of the click
    // also survives a backfilled import.
    const resurfaced = !!(fadedOutAt && fadedOutAfter && latest.date > fadedOutAfter);
    // A confirmation with no recorded evidence date cannot be checked for
    // reappearance, so it is not honoured.
    const phasedOut = !!(fadedOutAt && fadedOutAfter) && !resurfaced;

    // Coming back after being confirmed gone is suspicious enough to re-triage
    // rather than silently resume the old verdict.
    const status = resurfaced ? "unreviewed" : storedStatus;

    const groupAccounts = [...new Set(txs.map((t) => t.account_id).filter(Boolean))];
    const phaseOut = accounts
      ? subscriptionPhaseOut(
          { status, latestDate: latest.date, cadenceKey, chargeCount: txs.length, cadenceSource },
          {
            todayStr,
            accountIds: groupAccounts,
            accountsById,
            lastChargeAnywhere: lastSeenByKey.get(key) || null,
            unknownAccount: txs.some((t) => !t.account_id)
          }
        )
      : null;

    const hit = findMatchingRule(latest.merchant_raw, rules);
    out.push({
      key,
      rawSamples: [...new Set(txs.map((t) => t.merchant_raw))],
      accountIds: groupAccounts,
      category: latest.resolved_category || "Subscription",
      matchedRule: hit ? hit.rule : null,
      hasNickname: !!(hit && hit.rule.display_name),
      latestAmount: round2(latestAmount),
      latestDate: latest.date,
      chargeCount: txs.length,
      intervalDays,
      cadenceLabel,
      cadenceSource,
      cadenceOverride: override,
      cadenceKey,
      monthlyEstimate,
      totalSpent: round2(amounts.reduce((s, a) => s + a, 0)),
      status,
      phasedOut,
      fadedOutAt,
      resurfaced,
      phaseOut
    });
  });

  return out
    .filter((s) => includePhasedOut || !s.phasedOut)
    .sort((a, b) => b.monthlyEstimate - a.monthlyEstimate);
}

function describeCadence(intervalDays) {
  if (!intervalDays) return "cadence unknown";
  if (intervalDays <= 9) return "weekly";
  if (intervalDays <= 18) return "biweekly";
  if (intervalDays <= 45) return "monthly";
  if (intervalDays <= 120) return "quarterly";
  if (intervalDays <= 400) return "yearly";
  return "irregular";
}

// Status (keep/cancel) and cadence override are independent: patching one must
// never clobber the other, so this merges into the existing entry.
function inferCadenceKey(intervalDays) {
  if (!intervalDays) return "monthly";
  let best = "monthly";
  let bestDiff = Infinity;
  Object.keys(CADENCE_PRESETS).forEach((k) => {
    const diff = Math.abs(CADENCE_PRESETS[k] - intervalDays);
    if (diff < bestDiff) {
      bestDiff = diff;
      best = k;
    }
  });
  return best;
}

// Next calendar renewal on or after `fromDateStr`, stepping by real months for
// monthly+ cadences rather than a flat day count. A yearly plan billed Sept 1
// must land on Sept 1 next year, not reappear every 30 days; day-of-month alone
// would wrongly match a yearly plan in every month of the period.
function nextRenewalDate(lastChargeDate, cadenceKey, fromDateStr) {
  if (!lastChargeDate) return null;
  const from = new Date(`${fromDateStr}T00:00:00`);
  const cursor = new Date(`${lastChargeDate}T00:00:00`);
  if (isNaN(cursor.getTime())) return null;

  const monthSteps = { monthly: 1, quarterly: 3, semiannual: 6, yearly: 12 };
  const step = monthSteps[cadenceKey];

  if (!step) {
    const days = Math.round(CADENCE_PRESETS[cadenceKey] || 14);
    let guard = 0;
    while (cursor < from && guard++ < 1000) cursor.setDate(cursor.getDate() + days);
    return toLocalISO(cursor);
  }

  const billingDay = cursor.getDate();
  let guard = 0;
  while (cursor < from && guard++ < 400) {
    cursor.setDate(1); // avoid Jan 31 + 1 month overflowing into March
    cursor.setMonth(cursor.getMonth() + step);
    const lastDayOfMonth = new Date(cursor.getFullYear(), cursor.getMonth() + 1, 0).getDate();
    cursor.setDate(Math.min(billingDay, lastDayOfMonth));
  }
  return toLocalISO(cursor);
}

// Subscriptions marked "keep" whose next renewal lands in this pay period and
// which haven't already been charged since that date.
function upcomingSubscriptions(auditRows, transactions, rules, todayStr, nextPaydayStr) {
  const out = [];
  auditRows
    .filter((s) => s.status === "keep")
    .forEach((s) => {
      // The audit row already resolved this; the fallback only covers rows built
      // by hand rather than by buildSubscriptionAudit.
      const cadence = s.cadenceKey || s.cadenceOverride || inferCadenceKey(s.intervalDays);
      const renewal = nextRenewalDate(s.latestDate, cadence, todayStr);
      if (!renewal) return;
      if (!(renewal >= todayStr && renewal < nextPaydayStr)) return;

      // Already posted for this cycle? Then it's in the balance already.
      const alreadyBilled = transactions.some(
        (t) =>
          t.amount < 0 &&
          t.date >= renewal &&
          t.date < nextPaydayStr &&
          subscriptionGroupKey(t.merchant_raw, rules) === s.key
      );
      if (alreadyBilled) return;

      out.push({
        key: s.key,
        amount: s.latestAmount,
        dueDate: renewal,
        cadence,
        cadenceLabel: CADENCE_LABELS[cadence] || cadence
      });
    });
  return out.sort((a, b) => (a.dueDate < b.dueDate ? -1 : a.dueDate > b.dueDate ? 1 : 0));
}

async function patchSubscriptionReview(app, merchantKey, patch) {
  const reviews = await readJSON(app, FILES.subscriptionReviews, []);
  const idx = reviews.findIndex((r) => r.merchant_key === merchantKey);
  const base = idx >= 0 ? reviews[idx] : { merchant_key: merchantKey, status: "unreviewed", cadence_override: null };
  const merged = Object.assign({}, base, patch, {
    merchant_key: merchantKey,
    updated: todayLocal()
  });
  if (idx >= 0) reviews[idx] = merged;
  else reviews.push(merged);
  await writeJSON(app, FILES.subscriptionReviews, reviews);
}

// Changing the flag re-opens the question, so a prior "confirmed gone" stops
// being the current answer — otherwise pressing Keep on a resurfaced row would
// leave a stale confirmation behind to hide it again on the next render.
async function setSubscriptionStatus(app, merchantKey, status) {
  return patchSubscriptionReview(app, merchantKey, { status, faded_out_at: null, faded_out_after: null });
}

// Records WHAT was true when the user confirmed it, not just when they clicked.
// Reappearance is then judged against that evidence.
async function confirmSubscriptionGone(app, merchantKey, latestDate) {
  return patchSubscriptionReview(app, merchantKey, {
    faded_out_at: todayLocal(),
    faded_out_after: latestDate
  });
}

async function setSubscriptionCadence(app, merchantKey, cadence) {
  return patchSubscriptionReview(app, merchantKey, { cadence_override: cadence || null });
}

// ---------- debt tracking ----------

// Balances are DERIVED, never mutated in place:
//   current balance = balance_anchor.amount - sum(applied_payments)
// Each applied payment records its transaction id, so re-importing the same CSV
// can never double-count it. "Edit Balance" resets the anchor and clears the
// ledger, which is the escape hatch when reality and the math disagree.
// A credit card, as opposed to a BNPL plan. The distinction matters because a
// BNPL plan only ever amortizes down, while a card's balance moves in BOTH
// directions — which the anchor-minus-payments model alone cannot express.
function isRevolvingDebt(debt) {
  return !!(debt && !debt.provider && debt.account_id);
}

// Charges and payments posted to the CARD ITSELF since its balance was anchored.
//
// Keyed strictly on the card's own account_id. A card payment appears twice in
// the ledger — negative on the checking side, positive on the card side, a day
// or two apart with different transaction ids — so widening this by merchant or
// amount would subtract every payment twice.
//
// Sign convention on a card account: a purchase is money out (negative), a
// payment or refund is money in (positive).
function cardActivitySince(debt, transactions) {
  const empty = { charges: 0, payments: 0, chargeCount: 0, paymentCount: 0, since: null, latest: null };
  if (!debt || !debt.account_id) return empty;
  const since = debt.balance_anchor ? debt.balance_anchor.date : null;
  if (!since) return empty;

  let charges = 0;
  let payments = 0;
  let chargeCount = 0;
  let paymentCount = 0;
  let latest = null;

  (transactions || []).forEach((t) => {
    if (!t || !t.date || t.account_id !== debt.account_id) return;
    // Strictly after: a balance read on the anchor date already includes that
    // day's posted activity.
    if (t.date <= since) return;
    if (!Number.isFinite(t.amount) || t.amount === 0) return;
    if (t.amount < 0) {
      charges = round2(charges + Math.abs(t.amount));
      chargeCount++;
    } else {
      payments = round2(payments + t.amount);
      paymentCount++;
    }
    if (!latest || t.date > latest) latest = t.date;
  });

  return { charges, payments, chargeCount, paymentCount, since, latest };
}

// What a card actually owes, and the seam the figure came from.
//
// The balance is anchored to a number the user can look up, then moved by the
// activity imported since. Both halves are returned rather than just the total,
// because the card and checking statements import on different cadences — the
// anchor can be days ahead of the transactions or behind them, and a silent
// single number gives no way to tell which.
//
// applied_payments deliberately does NOT reduce a card balance once the card
// ledger is driving it: that ledger already contains every payment as a credit,
// and Apply Payment normally records the CHECKING-side leg, which is a
// different transaction. Counting both subtracts each payment twice.
// applied_payments still does its other job — crediting the billing cycle's
// minimum — which is independent of the balance.
//
// With no imported card activity at all there is nothing to derive from, so it
// falls back to the original anchor-minus-payments figure rather than reporting
// a balance that ignores known payments.
function cardBalanceState(debt, transactions) {
  const anchor = debt && debt.balance_anchor ? round2(debt.balance_anchor.amount || 0) : 0;
  const anchorDate = debt && debt.balance_anchor ? debt.balance_anchor.date : null;
  // Only payments made AFTER the anchor can reduce it — an anchor is a
  // point-in-time balance that already reflects everything before it. Without
  // this, re-anchoring a card to its real balance would immediately subtract
  // payments that figure already included. Dateless payments are pending bank
  // holds and count as current, matching paidForCycle.
  const applied = round2(
    (debt.applied_payments || [])
      .filter((p) => p && (!anchorDate || !p.date || p.date > anchorDate))
      .reduce((s, p) => s + Math.abs(p.amount || 0), 0)
  );
  const activity = cardActivitySince(debt, transactions);
  const derived = !!(activity.since && (activity.chargeCount > 0 || activity.paymentCount > 0));
  const balance = derived
    ? Math.max(0, round2(anchor + activity.charges - activity.payments))
    : Math.max(0, round2(anchor - applied));
  return Object.assign({ anchor, applied, balance, derived }, activity);
}

// Pass `transactions` to get a card's live balance. Without them — or for a BNPL
// plan, where it would be wrong — this is the original anchor-minus-payments
// figure, so every existing call site keeps its old behavior until threaded.
function debtBalance(debt, transactions = null) {
  if (isLoan(debt)) return loanState(debt).balance;
  if (transactions && isRevolvingDebt(debt)) return cardBalanceState(debt, transactions).balance;
  const anchorAmt = debt.balance_anchor ? debt.balance_anchor.amount : 0;
  const applied = (debt.applied_payments || []).reduce((s, p) => s + Math.abs(p.amount), 0);
  return Math.max(0, round2(anchorAmt - applied));
}

function debtLabel(debt) {
  return debt.provider || debt.account_id || "Unnamed debt";
}

// Advances next_due_date / due_date once the current installment is fully
// covered by payments applied since the cycle began. Returns the new date, or
// null if the installment isn't covered yet.
function advanceDueDateIfCovered(debt, kind) {
  if (isLoan(debt)) {
    // A loan's next due date is its first installment not yet paid. Its due
    // dates run from the first payment, so that's pinned before anything moves.
    if (!debt.first_payment_date && debt.next_due_date) debt.first_payment_date = debt.next_due_date;
    const next = loanSchedule(debt).nextDue;
    if (!next || next === debt.next_due_date) return null;
    debt.next_due_date = next;
    return next;
  }
  const isCC = kind === "cc";
  const dueDate = isCC ? debt.due_date : debt.next_due_date;
  const owed = isCC ? debt.min_payment_due || 0 : debt.installment_amount || 0;
  if (!dueDate || owed <= 0) return null;

  const freq = isCC ? "monthly" : debt.frequency || "monthly";
  const stepBack = (dateStr) => {
    if (freq === "weekly") return addDays(dateStr, -7);
    if (freq === "biweekly") return addDays(dateStr, -14);
    const d = new Date(`${dateStr}T00:00:00`);
    d.setMonth(d.getMonth() - 1);
    return toLocalISO(d);
  };
  const stepForward = (dateStr) => {
    if (freq === "weekly") return addDays(dateStr, 7);
    if (freq === "biweekly") return addDays(dateStr, 14);
    const d = new Date(`${dateStr}T00:00:00`);
    const day = d.getDate();
    d.setDate(1);
    d.setMonth(d.getMonth() + 1);
    const last = new Date(d.getFullYear(), d.getMonth() + 1, 0).getDate();
    d.setDate(Math.min(day, last));
    return toLocalISO(d);
  };

  const from = stepBack(dueDate);
  const paid = (debt.applied_payments || [])
    .filter((p) => !p.date || p.date > from)
    .reduce((s, p) => s + Math.abs(p.amount || 0), 0);

  if (paid + 0.005 < owed) return null;

  const next = stepForward(dueDate);
  if (isCC) debt.due_date = next;
  else {
    debt.next_due_date = next;
    if (typeof debt.remaining_installments === "number" && debt.remaining_installments > 0) {
      debt.remaining_installments -= 1;
    }
  }
  return next;
}

// Stable identity for a debt. Keyed on its own id; the name-derived form is
// only a fallback for a record that hasn't been through ensureIds yet. Deriving
// identity from the provider name meant renaming a plan orphaned everything
// that pointed at it — the same lesson as transaction ids in 1.0.0.
function debtKey(debt) {
  if (debt && debt.id) return debt.id;
  return debt.provider ? `bnpl:${debt.provider}` : `cc:${debt.account_id}`;
}

function remainingInstallments(debt) {
  if (isLoan(debt)) {
    const p = loanPayoff(debt);
    return p.never ? Infinity : p.payments;
  }
  if (!debt.installment_amount || debt.installment_amount <= 0) return 0;
  return Math.ceil(debtBalance(debt) / debt.installment_amount);
}

// ---------- loans ----------
//
// A car loan, mortgage, student or personal loan: a fixed monthly payment
// against a balance that charges interest. It's kept with the installment
// plans (installment_debts.json, kind "loan"), so its payment is reserved from
// the pay period it falls in, matched and rolled forward exactly as a plan's
// is. What differs is the balance: part of every payment is interest.
//
// The balance starts from an anchor — what was owed on a date, typed or
// reported by the lender through SimpleFIN — and each payment applied after
// that date pays escrow (a mortgage's taxes and insurance, which never touch
// the balance), then the interest accrued since the last payment, then
// principal. Car, student and personal loans accrue interest daily (simple
// interest), so a first payment 40 days after the loan is funded carries 40
// days of it; a mortgage charges a month's interest at each due date.
//
// A loan that hasn't started just has its first payment date as its next due
// date: nothing is reserved until the pay period that date falls in.
const LOAN_TYPES = {
  car: { label: "Car loan", category: "Car Loan", method: "daily", extra: true },
  mortgage: { label: "Mortgage", category: "Mortgage", method: "monthly", extra: false },
  student: { label: "Student loan", category: "Student Loan", method: "daily", extra: true },
  personal: { label: "Personal loan", category: "Loan Payment", method: "daily", extra: true }
};

function isLoan(debt) {
  return !!debt && debt.kind === "loan";
}

function loanType(debt) {
  return debt && LOAN_TYPES[debt.loan_type] ? debt.loan_type : "personal";
}

function loanMethod(debt) {
  return debt && (debt.interest_method === "daily" || debt.interest_method === "monthly")
    ? debt.interest_method
    : LOAN_TYPES[loanType(debt)].method;
}

// Whether spare cash may go toward it, in the payoff ladder by APR. Off for a
// mortgage unless you turn it on: its rate is usually the lowest you have.
function loanTakesExtra(debt) {
  return typeof debt.extra_payments === "boolean" ? debt.extra_payments : LOAN_TYPES[loanType(debt)].extra;
}

function loanEscrow(debt) {
  return Math.max(0, round2(Number(debt.escrow) || 0));
}

// The part of the monthly payment that pays interest and principal.
function loanPrincipalAndInterest(debt) {
  return Math.max(0, round2((Number(debt.installment_amount) || 0) - loanEscrow(debt)));
}

function loanInterest(balance, apr, method, fromStr, toStr) {
  const r = (Number(apr) || 0) / 100;
  if (!(r > 0) || !(balance > 0)) return 0;
  if (method === "monthly") return round2((balance * r) / 12);
  const days = fromStr && toStr ? Math.max(0, daysBetween(fromStr, toStr)) : 0;
  return round2((balance * r * days) / 365);
}

// A month on, keeping the day it started on where the month has it (Jan 31 →
// Feb 28 → Mar 31, not Mar 28).
function addLoanMonths(dateStr, n, day = null) {
  const [y, m, d] = String(dateStr).split("-").map(Number);
  const want = day || d;
  const total = y * 12 + (m - 1) + n;
  const ny = Math.floor(total / 12);
  const nm = total % 12;
  const last = new Date(ny, nm + 1, 0).getDate();
  return `${ny}-${String(nm + 1).padStart(2, "0")}-${String(Math.min(want, last)).padStart(2, "0")}`;
}

// How early a payment can come and still be for the installment after it:
// 20 days. Earlier than that it's for the month it falls in.
const LOAN_EARLY_DAYS = 20;
const LOAN_DAY_RE = /^\d{4}-\d{2}-\d{2}$/;

// The monthly due dates, from the first payment, keeping its day.
function loanFirstDue(debt) {
  const d = debt && (debt.first_payment_date || debt.next_due_date);
  return d && LOAN_DAY_RE.test(d) ? d : null;
}

// Every run of due dates the loan has had: the ones it had before its due
// date was moved (up to the one that was moved), then the ones it has now.
function loanDueSeries(debt) {
  const out = (debt && Array.isArray(debt.due_history) ? debt.due_history : [])
    .filter((h) => h && LOAN_DAY_RE.test(h.first || "") && LOAN_DAY_RE.test(h.until || ""))
    .map((h) => ({ first: h.first, until: h.until }));
  const first = loanFirstDue(debt);
  if (first) out.push({ first, until: null });
  return out;
}

// Due dates d with fromStr < d <= toStr.
function loanDueDatesBetween(debt, fromStr, toStr) {
  if (!fromStr || !toStr || toStr <= fromStr) return [];
  const out = [];
  loanDueSeries(debt).forEach(({ first, until }) => {
    const day = Number(first.slice(8, 10));
    // Start a month short of fromStr rather than counting up from the first.
    const skip = (Number(fromStr.slice(0, 4)) - Number(first.slice(0, 4))) * 12 + Number(fromStr.slice(5, 7)) - Number(first.slice(5, 7)) - 1;
    for (let k = Math.max(0, skip || 0); k < 1200; k++) {
      const due = addLoanMonths(first, k, day);
      if (due > toStr || (until && due >= until)) break;
      if (due > fromStr) out.push(due);
    }
  });
  return out.sort();
}

const byLoanDate = (a, b) => (a.date < b.date ? -1 : a.date > b.date ? 1 : 0);

// Which monthly installments the applied payments have covered. Each payment
// counts for the installment whose window it falls in — from LOAN_EARLY_DAYS
// before its due date up to that point before the next one (the first
// installment takes anything earlier, back to the day the loan was funded).
// Finishing a month left part-paid comes first (a payment split in two); then
// its own month; then earlier ones still unpaid, most recent first; then, for
// anything left, the months ahead. Payments marked extra toward principal
// don't pay installments at all. Payments before `coverage_from` (set when the
// due dates were moved) already paid the months before the move.
function loanSchedule(debt, { todayStr = todayLocal(), until = null } = {}) {
  const first = loanFirstDue(debt);
  const P = round2(Number(debt.installment_amount) || 0);
  const paidFor = new Map();
  if (!first || !(P > 0)) return { installments: [], nextDue: debt.next_due_date || null, extra: 0, paidFor };
  const day = Number(first.slice(8, 10));
  const payments = (debt.applied_payments || [])
    .map((p, i) => p && { i, extra: !!p.extra, amount: Math.abs(Number(p.amount) || 0), date: p.date || p.applied_on || null })
    .filter((p) => p && !p.extra && (!debt.coverage_from || !p.date || p.date > debt.coverage_from))
    .map((p) => Object.assign(p, { date: p.date || todayStr }))
    .sort(byLoanDate);
  const total = payments.reduce((sum, p) => sum + p.amount, 0);
  const horizon = [until || todayStr, todayStr, payments.length ? payments[payments.length - 1].date : todayStr].sort().pop();
  // Enough installments to take every payment, and a month past the horizon.
  const enough = Math.max(payments.length, Math.ceil(total / P) + 1);
  const dues = [];
  for (let k = 0; k < 1200; k++) {
    const due = addLoanMonths(first, k, day);
    dues.push(due);
    if (k >= enough && due > addLoanMonths(horizon, 1)) break;
  }
  const opens = dues.map((due, k) => (k === 0 ? "0000-00-00" : addDays(due, -LOAN_EARLY_DAYS)));
  const covered = dues.map(() => 0);
  let extra = 0;
  payments.forEach((p) => {
    let w = 0;
    while (w + 1 < dues.length && opens[w + 1] <= p.date) w++;
    const order = [];
    const split = w > 0 && covered[w - 1] > 0.004 && P - covered[w - 1] > 0.004;
    if (split) order.push(w - 1);
    order.push(w);
    for (let j = w - 1; j >= 0; j--) if (!(split && j === w - 1)) order.push(j);
    for (let j = w + 1; j < dues.length; j++) order.push(j);
    let left = p.amount;
    for (const j of order) {
      if (left <= 0.004) break;
      const need = P - covered[j];
      if (need > 0.004) {
        const c = Math.min(need, left);
        covered[j] += c;
        left -= c;
        if (!paidFor.has(p.i)) paidFor.set(p.i, dues[j]);
      }
    }
    extra += Math.max(0, left);
  });
  const installments = dues.map((due, k) => ({ due, covered: round2(covered[k]), remaining: round2(Math.max(0, P - covered[k])) }));
  const next = installments.find((i) => i.remaining > 0.004);
  const marked = (debt.applied_payments || []).filter((p) => p && p.extra).reduce((sum, p) => sum + Math.abs(Number(p.amount) || 0), 0);
  // paidFor: each payment (by its place in applied_payments) → the due date
  // of the installment it went to first.
  return { installments, nextDue: next ? next.due : null, extra: round2(extra + marked), paidFor };
}

// When each payment (by its place in applied_payments) counts for interest.
// A daily-interest loan charges interest up to the day a payment arrives. A
// mortgage charges a month's at each due date, so a payment made ahead of the
// installment it pays counts on that due date — paying a few days early
// doesn't turn the month's interest into principal.
function loanPaymentDates(debt, todayStr = todayLocal()) {
  const out = new Map();
  const sched = loanMethod(debt) === "monthly" ? loanSchedule(debt, { todayStr }) : null;
  (debt.applied_payments || []).forEach((p, i) => {
    if (!p) return;
    const date = p.date || p.applied_on || todayStr;
    const due = sched && !p.extra ? sched.paidFor.get(i) : null;
    out.set(i, due && due > date ? due : date);
  });
  return out;
}

// Where interest starts for the payments after the anchor. The balance (typed
// or the lender's) is what was left after the last payment, and interest has
// run since that payment — not since the day the balance was read. So: the
// last regular payment on or before the anchor (extra toward principal
// leaves the interest owed); failing that, the latest due date on or before
// it; failing that, the day the loan was funded.
function loanAccrualStart(debt, anchorDate, when = null) {
  const on = when || loanPaymentDates(debt, anchorDate);
  const before = (debt.applied_payments || [])
    .map((p, i) => {
      const d = p && !p.extra && (p.date || p.applied_on);
      return d && d <= anchorDate ? on.get(i) : null;
    })
    .filter(Boolean)
    .sort();
  if (before.length) return before[before.length - 1];
  const dues = loanDueDatesBetween(debt, "0000-00-00", anchorDate);
  if (dues.length) return dues[dues.length - 1];
  return debt.loan_date && debt.loan_date <= anchorDate ? debt.loan_date : anchorDate;
}

// Adds the interest and escrow that build up between two dates to `acc`.
// Daily loans: interest on the balance for every day. A mortgage: a month's
// interest, and a month's escrow, at each due date passed — however many
// payments fall between them.
function loanAccrue(debt, acc, toStr) {
  if (!toStr || toStr <= acc.from) return;
  const r = (Number(debt.apr) || 0) / 100;
  // Without due dates to count, the months that have passed.
  const dues = loanFirstDue(debt) ? loanDueDatesBetween(debt, acc.from, toStr).length : Math.round(daysBetween(acc.from, toStr) / 30.4375);
  if (loanMethod(debt) === "monthly") acc.interest += ((acc.balance * r) / 12) * dues;
  else acc.interest += (acc.balance * r * daysBetween(acc.from, toStr)) / 365;
  acc.escrow += loanEscrow(debt) * dues;
  acc.from = toStr;
}

// A payment against what's built up: escrow, then interest, then principal.
// What it doesn't cover stays owed — interest a short payment misses isn't
// forgiven.
function loanPay(acc, amount) {
  let left = amount;
  const e = Math.min(left, acc.escrow);
  acc.escrow -= e;
  left -= e;
  const i = Math.min(left, acc.interest);
  acc.interest -= i;
  left -= i;
  const pr = Math.min(acc.balance, Math.max(0, left));
  acc.balance -= pr;
  return { escrow: e, interest: i, principal: pr };
}

// Where the balance stands after the payments applied since its anchor.
// Payments dated on or before the anchor are already in it (a balance read
// that day includes them) and only count toward the month they paid.
function loanState(debt, todayStr = todayLocal()) {
  const anchor = debt.balance_anchor || {};
  const since = anchor.date || debt.loan_date || todayStr;
  const on = loanPaymentDates(debt, todayStr);
  const acc = { balance: Math.max(0, Number(anchor.amount) || 0), interest: 0, escrow: 0, from: loanAccrualStart(debt, since, on) };
  const payments = (debt.applied_payments || [])
    // An undated payment (applied while it was a pending hold) is dated by
    // when it was applied, not "today" — which would move it every day and
    // past every re-anchor.
    .map((p, i) => p && { i, amount: Math.abs(Number(p.amount) || 0), date: p.date || p.applied_on || null, extra: !!p.extra })
    .filter((p) => p && (!p.date || p.date > since))
    .map((p) => Object.assign(p, { date: p.date || todayStr, on: on.get(p.i) || p.date || todayStr }))
    .sort((a, b) => (a.on < b.on ? -1 : a.on > b.on ? 1 : byLoanDate(a, b)));
  let interestPaid = 0;
  let principalPaid = 0;
  let last = null;
  payments.forEach((p) => {
    loanAccrue(debt, acc, p.on);
    // Extra toward principal is just that: the interest building up is left
    // for the next regular payment.
    const paid = p.extra ? { interest: 0, principal: Math.min(acc.balance, p.amount) } : loanPay(acc, p.amount);
    if (p.extra) acc.balance -= paid.principal;
    interestPaid += paid.interest;
    principalPaid += paid.principal;
    if (!last || p.date > last) last = p.date;
  });
  return {
    balance: round2(acc.balance),
    since,
    lastPaymentDate: last,
    accruesFrom: acc.from,
    // Built up and not yet paid: a short payment's shortfall, or a mortgage
    // month passed without one.
    owedInterest: round2(acc.interest),
    owedEscrow: round2(acc.escrow),
    interestPaid: round2(interestPaid),
    principalPaid: round2(principalPaid),
    paymentsCounted: payments.length,
    started: (debt.applied_payments || []).length > 0
  };
}

// What the loan asks of a pay period [startStr, endStr): each installment
// due in it, and the most recent earlier one still unpaid (a missed payment is
// still owed; older ones are almost always a payment that wasn't applied, and
// reserving every one of them would swallow the budget). Never more than what
// it would take to pay the loan off.
function loanPeriodDues(debt, startStr, endStr, todayStr = todayLocal()) {
  const sched = loanSchedule(debt, { todayStr, until: endStr });
  const st = loanState(debt, todayStr);
  const r = (Number(debt.apr) || 0) / 100;
  let left = round2(st.balance + st.owedInterest + st.owedEscrow + (st.balance * r) / 12 + loanEscrow(debt));
  if (!(st.balance > 0.005) && !(st.owedInterest > 0.005) && !(st.owedEscrow > 0.005)) return [];
  const inPer = sched.installments.filter((i) => i.due >= startStr && i.due < endStr);
  const overdue = sched.installments.filter((i) => i.due < startStr && i.remaining > 0.004 && (!debt.loan_date || i.due > debt.loan_date)).pop();
  const P = round2(Number(debt.installment_amount) || 0);
  return (overdue ? [overdue] : []).concat(inPer).map((i) => {
    const due = round2(Math.min(P, i.covered + Math.max(0, left)));
    const remaining = round2(Math.max(0, due - i.covered));
    left = round2(left - remaining);
    return { due: i.due, amount: due, paid: i.covered, remaining, settled: i.covered > 0 && remaining <= 0.005, overdue: i === overdue };
  });
}

// The rest of the loan at its payment (plus `extra` a month): how many
// payments, the last one's date, and the interest still to come. `never` when
// the payment doesn't cover the interest, so the balance would never fall.
function loanPayoff(debt, { todayStr = todayLocal(), extra = 0 } = {}) {
  const st = loanState(debt, todayStr);
  const acc = { balance: st.balance, interest: st.owedInterest, escrow: st.owedEscrow, from: st.accruesFrom };
  const pay = round2((Number(debt.installment_amount) || 0) + Math.max(0, Number(extra) || 0));
  if (!(acc.balance > 0.005) && !(acc.interest > 0.005)) return { payments: 0, payoffDate: null, interest: 0, done: true, never: false };
  // Judged on a full month, so a first payment that falls short only because
  // it covers a long first stretch isn't mistaken for one that never will.
  const monthly = (acc.balance * ((Number(debt.apr) || 0) / 100)) / 12 + loanEscrow(debt);
  if (!(pay > monthly + 0.004)) return { payments: 0, payoffDate: null, interest: 0, done: false, never: true };
  const sched = loanSchedule(debt, { todayStr });
  const first = loanFirstDue(debt) || addLoanMonths(todayStr, 1);
  const day = Number(first.slice(8, 10));
  let due = sched.nextDue || debt.next_due_date || addLoanMonths(todayStr, 1, day);
  if (due < acc.from) due = acc.from;
  // A month already part-paid needs only the rest.
  const part = sched.installments.find((i) => i.due === due && i.covered > 0.004);
  let amount = part ? round2(part.remaining + Math.max(0, Number(extra) || 0)) : pay;
  let payments = 0;
  let interest = acc.interest;
  while ((acc.balance > 0.005 || acc.interest > 0.005) && payments < 1200) {
    const before = acc.interest;
    loanAccrue(debt, acc, due);
    interest += acc.interest - before;
    loanPay(acc, amount);
    amount = pay;
    payments++;
    if (acc.balance > 0.005 || acc.interest > 0.005) due = addLoanMonths(due, 1, day);
  }
  return { payments, payoffDate: due, interest: round2(interest), done: false, never: payments >= 1200 };
}

// Whether payments being applied to a loan look like extra toward principal:
// the installment for the window they fall in is already paid, and they don't
// add up to about one installment (a regular payment made early would).
function loanExtraSuggested(debt, picked, todayStr = todayLocal()) {
  if (!isLoan(debt) || !(picked || []).length) return false;
  const P = Number(debt.installment_amount) || 0;
  const sum = picked.reduce((s, c) => s + Math.abs(Number(c.amount) || 0), 0);
  if (P > 0 && Math.abs(sum - P) <= P * 0.1) return false;
  const date = picked.map((c) => c.date || todayStr).sort()[0];
  const sched = loanSchedule(debt, { todayStr });
  const opens = sched.installments.map((i, k) => (k === 0 ? "0000-00-00" : addDays(i.due, -LOAN_EARLY_DAYS)));
  let w = 0;
  while (w + 1 < opens.length && opens[w + 1] <= date) w++;
  // This month's installment, or last month's while this one isn't due yet,
  // already paid: this money is on top of it.
  const own = sched.installments[w];
  const prev = w > 0 ? sched.installments[w - 1] : null;
  return !!(own && own.remaining <= 0.004) || (!!prev && prev.remaining <= 0.004 && !!own && own.due > date);
}

// What paying `extra` more a month would save: months sooner, interest less.
function loanExtraSavings(debt, extra, todayStr = todayLocal()) {
  const base = loanPayoff(debt, { todayStr });
  const faster = loanPayoff(debt, { todayStr, extra });
  if (base.done || base.never || faster.never) return null;
  return { months: base.payments - faster.payments, interest: round2(base.interest - faster.interest), payoffDate: faster.payoffDate };
}

// Worth less owed, when you've given what it's worth.
function loanEquity(debt, todayStr = todayLocal()) {
  const value = Number(debt.estimated_value);
  if (!(value > 0)) return null;
  return round2(value - loanState(debt, todayStr).balance);
}

// Payments Apply Payment offers a loan: from a few days before this month's
// billing cycle began, not from the balance anchor as for a plan. A loan that
// syncs re-anchors every sync, and a payment made just before one would
// otherwise never be offered — its month would stay due and be reserved again.
function loanMatchFrom(debt) {
  const due = debt.next_due_date;
  if (!due || !LOAN_DAY_RE.test(due)) return debt.loan_date || null;
  const from = addDays(addLoanMonths(due, -1), -5);
  return debt.loan_date && debt.loan_date > from ? debt.loan_date : from;
}

function totalDebt(revolving, installment, transactions = null) {
  return round2(
    revolving.reduce((s, d) => s + debtBalance(d, transactions), 0) +
      installment.reduce((s, d) => s + debtBalance(d), 0)
  );
}

// ---------- financial snapshot (export) ----------
//
// Everything the dashboard knows, in one place, for pasting into a note or
// handing to someone: cash, credit, goals, debts, bills, subscriptions, the
// irregular necessities, investments and the monthly cash flow they add up to.
// Each figure comes from the same function the dashboard uses for it, so the
// export never disagrees with the screen.

// The spending a necessity's monthly rate is measured over.
const NECESSITY_WINDOW_DAYS = 90;

// How many of each pay or payment cadence land in a month.
const PER_MONTH = { weekly: 4.33, biweekly: 2.166, semimonthly: 2, monthly: 1 };
const PAY_CADENCE_NAMES = { weekly: "Weekly", biweekly: "Every 2 weeks", semimonthly: "Twice a month", monthly: "Monthly" };

function snapshotMoney(v) {
  const n = round2(Number(v) || 0);
  return n < 0 ? `-$${formatMoneyInput(-n)}` : `$${formatMoneyInput(n)}`;
}

function snapshotNumber(v) {
  return v != null && v !== "" && Number.isFinite(Number(v)) ? round2(Number(v)) : null;
}

// Pure: the caller reads the files. `data` holds what they contain; `settings`
// is the plugin's (for the pay schedule).
function buildFinancialSnapshot(data = {}, { todayStr = todayLocal(), settings = {} } = {}) {
  const accounts = (data.accounts || []).filter((a) => a && a.id);
  const goals = data.goals || [];
  const revolving = data.revolvingDebts || [];
  const installments = data.installmentDebts || [];
  const fixedExpenses = (data.fixedExpenses || []).filter(Boolean);
  const transactions = data.transactions || [];
  const rules = data.rules || [];
  const categoryMeta = data.categoryMeta || [];
  const sum = (rows, key) => round2(rows.reduce((s, r) => s + (Number(r[key]) || 0), 0));

  // Cash: every account that isn't a card. A capped fund's account says so.
  const fundByAccount = new Map(cappedFunds(goals).map((f) => [f.account_id, f]));
  const cash = accounts
    .filter((a) => a.type !== "credit_card")
    .map((a) => ({
      name: accountLabel(a),
      type: a.type || "account",
      balance: snapshotNumber(a.current_balance),
      asOf: a.balance_as_of || null,
      fund: fundByAccount.has(a.id) ? fundByAccount.get(a.id).name : null
    }));
  const cashTotal = sum(cash.filter((c) => c.balance != null), "balance");

  // Credit: limit less balance. A card tracked on the Debts tab is at its live
  // balance there, so the card's row and its debt agree; otherwise it's the
  // account's balance, as the dashboard's Total Flexibility counts it.
  const credit = accounts
    .filter((a) => a.type === "credit_card")
    .map((a) => {
      const limit = snapshotNumber(a.credit_limit);
      const debt = revolving.find((d) => d && d.account_id === a.id);
      const balance = debt ? debtBalance(debt, transactions) : snapshotNumber(a.current_balance) || 0;
      return { accountId: a.id, name: accountLabel(a), limit, balance, available: limit != null ? round2(limit - balance) : null };
    });
  const creditAvailable = sum(credit.filter((c) => c.available != null), "available");

  // Savings goals, and capped funds (whose balance is their account's).
  const savings = regularGoals(goals).map((g) => {
    const p = goalProgress(g);
    return { name: g.name, saved: p.saved, target: p.target, remaining: p.remaining, targetDate: g.target_date || null };
  });
  const funds = cappedFunds(goals).map((f) => {
    const p = fundProgress(f, accounts);
    return { name: f.name, balance: p.known ? p.saved : null, cap: p.target, account: p.account ? accountLabel(p.account) : null };
  });

  // Debts: cards at their live balance, plans at theirs, and what each costs a
  // month at minimum. Paid-off debts cost nothing.
  const cards = revolving.map((d) => {
    const balance = debtBalance(d, transactions);
    return {
      name: debtLabel(d),
      accountId: d.account_id || null,
      balance,
      apr: snapshotNumber(d.apr),
      minimum: balance > 0 ? round2(Number(d.min_payment_due) || 0) : 0,
      dueDate: d.due_date || null
    };
  });
  const plans = installments.map((d) => {
    const balance = debtBalance(d);
    const frequency = d.frequency || "monthly";
    const installment = round2(Number(d.installment_amount) || 0);
    const left = balance > 0 ? remainingInstallments(d) : 0;
    return {
      name: debtLabel(d),
      balance,
      installment,
      frequency,
      // A loan's rate; a plan has none. A loan whose payment can't cover its
      // interest has no count of payments left.
      apr: isLoan(d) ? snapshotNumber(d.apr) : null,
      remaining: Number.isFinite(left) ? left : null,
      monthly: balance > 0 ? round2(installment * (PER_MONTH[frequency] || 1)) : 0,
      nextDue: d.next_due_date || null
    };
  });
  const debtTotal = round2(sum(cards, "balance") + sum(plans, "balance"));
  const debtMonthly = round2(sum(cards, "minimum") + sum(plans, "monthly"));

  // Recurring bills, as a month: a monthly bill is its amount; one every N days
  // is its amount scaled to a month.
  const bills = fixedExpenses.map((f) => {
    const amount = round2(Number(f.amount) || 0);
    const rolling = isRollingExpense(f);
    return {
      name: f.name || "Bill",
      category: f.category || null,
      amount,
      cadence: rolling ? `every ${f.interval_days} days` : `monthly, day ${f.due_day_of_month || "?"}`,
      monthly: rolling ? round2(amount * (MONTH_DAYS / Math.max(1, Number(f.interval_days) || 30))) : amount
    };
  });
  const billsMonthly = sum(bills, "monthly");

  // Subscriptions still being paid: not flagged to cancel, not faded out. One
  // that's also set up as a bill is counted there, not twice.
  const billNames = fixedExpenses.map((f) => String(f.name || "").toLowerCase().replace(/[^a-z0-9]/g, "")).filter((n) => n.length >= 3);
  const isBill = (key) => {
    const k = String(key || "").toLowerCase().replace(/[^a-z0-9]/g, "");
    return k.length >= 3 && billNames.some((n) => n.includes(k) || k.includes(n));
  };
  const subscriptions = buildSubscriptionAudit(transactions, data.reviews || [], rules, undefined, { accounts, todayStr })
    .filter((s) => s.status !== "cancel" && !s.phasedOut && !isBill(s.key))
    .map((s) => ({ name: s.key, cadence: s.cadenceLabel, latest: s.latestAmount, monthly: s.monthlyEstimate, status: s.status }));
  const subscriptionsMonthly = sum(subscriptions, "monthly");

  // Irregular necessities (gas, pet food): the typical purchase and how often
  // it comes, as the dashboard projects them, and what they actually cost a
  // month — the last 90 days' spending as a monthly rate. Typical × frequency
  // alone runs wild when purchases cluster (two on one day reads as "every
  // day"), so the rate is what the cash flow counts. Categories a bill or debt
  // already schedules are left to those, as they are on the dashboard.
  const ownership = completeOwnership({ fixedExpenses, installmentDebts: installments, revolvingDebts: revolving, goals, categoryMeta, rules });
  const budgetTx = withoutFundAccountRows(transactions, goals);
  const since = addDays(todayStr, -NECESSITY_WINDOW_DAYS);
  const necessities = calculateVariableNecessities(budgetTx, categoryMeta, todayStr, addDays(todayStr, 31), ownership)
    .detail.map((d) => {
      const spent = round2(
        budgetTx
          .filter((t) => t && t.amount < 0 && t.date > since && t.date <= todayStr && (t.resolved_category || "") === d.category)
          .reduce((s, t) => s - t.amount, 0)
      );
      const known = d.sufficientHistory !== false && d.medianGap > 0;
      return {
        name: d.category,
        typical: known ? d.medianAmount : null,
        everyDays: known ? d.medianGap : null,
        spent90: spent,
        monthly: round2((spent / NECESSITY_WINDOW_DAYS) * MONTH_DAYS)
      };
    });
  const necessitiesMonthly = sum(necessities, "monthly");

  // Investments: each account at its latest statement.
  const pfAccounts = normalizePortfolioAccounts(data.portfolioAccounts || []);
  const investments = pfAccounts.map((a) => {
    const latest = (data.portfolioSnapshots || [])
      .filter((s) => s && s.account_id === a.id && Number.isFinite(s.ending_value))
      .sort((x, y) => (x.statement_end < y.statement_end ? -1 : 1))
      .slice(-1)[0];
    return { name: a.label, kind: [a.provider, PF_TYPES[a.type]].filter(Boolean).join(" "), value: latest ? latest.ending_value : null, asOf: latest ? latest.statement_end : null };
  });
  const investedTotal = sum(investments.filter((i) => i.value != null), "value");

  // Income: the latest paycheck — the one entered with Enter Paycheck, or the
  // latest deposit filed as Paycheck, whichever is newer — at the pay cadence.
  const entered = (data.paycheckHistory || [])
    .filter((p) => p && p.date && Number(p.amount) > 0)
    .sort((a, b) => (a.date < b.date ? -1 : 1))
    .slice(-1)[0];
  const deposit = findLatestPaycheck(transactions);
  let paycheck = null;
  if (entered && (!deposit || entered.date >= deposit.date)) paycheck = { amount: round2(Number(entered.amount)), date: entered.date, source: "entered" };
  else if (deposit) paycheck = { amount: round2(deposit.amount), date: deposit.date, source: "deposit" };
  const schedule = resolvePaySchedule(settings, transactions);
  const cadence = schedule && PER_MONTH[schedule.cadence] ? schedule.cadence : null;
  const monthlyIncome = paycheck && cadence ? round2(paycheck.amount * PER_MONTH[cadence]) : null;
  const monthlyOutflow = round2(debtMonthly + billsMonthly + subscriptionsMonthly + necessitiesMonthly);

  return {
    date: todayStr,
    cash,
    cashTotal,
    credit,
    creditAvailable,
    savings,
    funds,
    cards,
    plans,
    debtTotal,
    debtMonthly,
    bills,
    billsMonthly,
    subscriptions,
    subscriptionsMonthly,
    necessities,
    necessitiesMonthly,
    investments,
    investedTotal,
    income: {
      paycheck,
      cadence,
      cadenceInferred: !!(schedule && schedule.inferred),
      monthly: monthlyIncome,
      outflow: monthlyOutflow,
      surplus: monthlyIncome != null ? round2(monthlyIncome - monthlyOutflow) : null
    }
  };
}

// A Markdown table: header, rows, and a bold total row when there is one.
function snapshotTable(head, rows, total = null) {
  const cell = (v) => String(v == null ? "—" : v).replace(/\|/g, "\\|").replace(/\n/g, " ");
  const line = (cols) => `| ${cols.map(cell).join(" | ")} |`;
  const align = head.map((h, i) => (i === 0 ? "---" : "---:"));
  const out = [line(head), `| ${align.join(" | ")} |`, ...rows.map(line)];
  if (total) out.push(line(total.map((t, i) => (t == null || t === "" ? "" : `**${t}**`))));
  return out.join("\n");
}

// `only` limits the note to some sections (and drops the title and the closing
// note), for the one-kind-of-data exports.
function snapshotMarkdown(snap, { only = null } = {}) {
  const want = (key) => !only || only.includes(key);
  const m = snapshotMoney;
  const d = (iso) => (iso ? formatChartDate(iso) : "—");
  const out = [];
  if (!only) out.push(`# Financial snapshot — ${formatChartDate(snap.date)}`, "");
  const inc = snap.income;
  if (want("glance")) {
    out.push("## At a glance", "");
    out.push(
      snapshotTable(["", "Amount"], [
        ["Cash on hand", m(snap.cashTotal)],
        ["Credit available", m(snap.creditAvailable)],
        ["Total debt", m(snap.debtTotal)],
        ["Invested (latest statements)", m(snap.investedTotal)],
        ["Estimated monthly income", inc.monthly != null ? m(inc.monthly) : "—"],
        ["Estimated monthly outgoings", m(inc.outflow)]
      ], ["Net surplus / deficit per month", inc.surplus != null ? m(inc.surplus) : "—"]),
      ""
    );
  }

  if (want("income")) {
    out.push("## Income & cash flow", "");
    out.push(
      snapshotTable(["", "Amount"], [
        ["Latest paycheck", inc.paycheck ? `${m(inc.paycheck.amount)} (${d(inc.paycheck.date)})` : "none recorded"],
        ["Pay cadence", inc.cadence ? PAY_CADENCE_NAMES[inc.cadence] + (inc.cadenceInferred ? " (detected)" : "") : "not set"],
        ["Estimated monthly net income", inc.monthly != null ? m(inc.monthly) : "—"],
        ["Debt minimums", `-${m(snap.debtMonthly)}`],
        ["Recurring bills", `-${m(snap.billsMonthly)}`],
        ["Subscriptions", `-${m(snap.subscriptionsMonthly)}`],
        ["Projected necessities", `-${m(snap.necessitiesMonthly)}`]
      ], ["Net surplus / deficit", inc.surplus != null ? m(inc.surplus) : "—"]),
      ""
    );
  }

  if (want("cash")) {
    out.push("## Cash", "");
    out.push(
      snapshotTable(["Account", "Type", "Balance", "As of"],
        snap.cash.map((c) => [c.name + (c.fund ? ` (${c.fund})` : ""), c.type, c.balance != null ? m(c.balance) : "—", c.asOf ? d(c.asOf) : "—"]),
        ["Total", "", m(snap.cashTotal), ""]),
      ""
    );
  }

  if (want("credit")) {
    if (snap.credit.length) {
      out.push("## Credit", "");
      out.push(
        snapshotTable(["Card", "Limit", "Balance", "Available"],
          snap.credit.map((c) => [c.name, c.limit != null ? m(c.limit) : "no limit set", m(c.balance), c.available != null ? m(c.available) : "—"]),
          ["Total available", "", "", m(snap.creditAvailable)]),
        ""
      );
    }
  }

  if (want("savings")) {
    if (snap.savings.length || snap.funds.length) {
      out.push("## Savings", "");
      const rows = [
        ...snap.savings.map((g) => [g.name, m(g.saved), m(g.target), g.targetDate ? d(g.targetDate) : "no date"]),
        ...snap.funds.map((f) => [`${f.name} (capped fund)`, f.balance != null ? m(f.balance) : "—", m(f.cap), "—"])
      ];
      const saved = round2(snap.savings.reduce((s, g) => s + g.saved, 0) + snap.funds.reduce((s, f) => s + (f.balance || 0), 0));
      out.push(snapshotTable(["Goal", "Saved", "Target", "By"], rows, ["Total saved", m(saved), "", ""]), "");
    }
  }

  if (want("debts")) {
    out.push("## Debts", "");
    const debtRows = [
      // Paid-off debts aren't listed; they'd add a row of zeros.
      ...snap.cards.filter((c) => c.balance > 0).map((c) => [c.name, m(c.balance), c.apr != null ? `${c.apr}% APR` : "—", `${m(c.minimum)} min`]),
      ...snap.plans.filter((p) => p.balance > 0).map((p) => [
        p.name,
        m(p.balance),
        `${p.apr != null ? `${p.apr}% APR, ` : ""}${m(p.installment)} ${p.frequency}, ${p.remaining != null ? `${p.remaining} left` : "never paid off at this payment"}`,
        `${m(p.monthly)}/mo`
      ])
    ];
    out.push(debtRows.length ? snapshotTable(["Debt", "Balance", "Terms", "Monthly"], debtRows, ["Total", m(snap.debtTotal), "", `${m(snap.debtMonthly)}/mo`]) : "_No debts tracked._", "");
  }

  if (want("bills")) {
    if (snap.bills.length) {
      out.push("## Recurring bills", "");
      out.push(snapshotTable(["Bill", "Amount", "When", "Monthly"], snap.bills.map((b) => [b.name, m(b.amount), b.cadence, m(b.monthly)]), ["Total", "", "", m(snap.billsMonthly)]), "");
    }
  }

  if (want("subscriptions")) {
    out.push("## Subscriptions", "");
    out.push(snap.subscriptions.length
      ? snapshotTable(["Service", "Cadence", "Last charge", "Monthly"], snap.subscriptions.map((s) => [s.name, s.cadence, m(s.latest), m(s.monthly)]), ["Total", "", "", m(snap.subscriptionsMonthly)])
      : "_No active subscriptions._", "");
  }

  if (want("necessities")) {
    if (snap.necessities.length) {
      out.push("## Projected necessities", "");
      out.push(snapshotTable(["Category", "Typical purchase", "Every", "Last 90 days", "Per month"],
        snap.necessities.map((n) => [n.name, n.typical != null ? m(n.typical) : "—", n.everyDays != null ? `${n.everyDays} day${n.everyDays === 1 ? "" : "s"}` : "not enough history", m(n.spent90), m(n.monthly)]),
        ["Total", "", "", "", m(snap.necessitiesMonthly)]), "");
    }
  }

  if (want("investments")) {
    if (snap.investments.length) {
      out.push("## Investments", "");
      out.push(snapshotTable(["Account", "Kind", "Value", "Statement"],
        snap.investments.map((i) => [i.name, i.kind || "—", i.value != null ? m(i.value) : "—", i.asOf ? d(i.asOf) : "none yet"]),
        ["Total", "", m(snap.investedTotal), ""]), "");
    }
  }

  if (!only) out.push("_Monthly figures are estimates: pay × paychecks a month, bills and debts at their scheduled amounts, subscriptions from their usual charge and spacing, and necessities at the last 90 days' rate._");
  return out.join("\n") + "\n";
}

// The same figures for a spreadsheet, as stacked tables: one block per kind of
// figure, each with its own header row, separated by a blank row. Every amount,
// rate and count is a bare number (1450.00, 29.99, 11) so it can be summed and
// charted as it lands; a figure that doesn't apply is an empty cell.
const SNAPSHOT_ACCOUNT_TYPES = { checking: "Checking", savings: "Savings", cash: "Cash", credit_card: "Credit card" };

function snapshotCSV(snap) {
  const n = (v, dp = 2) => (v == null || !Number.isFinite(Number(v)) ? "" : Number(v).toFixed(dp));
  const rate = (v) => (v == null || !Number.isFinite(Number(v)) ? "" : String(Math.round(Number(v) * 1000) / 1000));
  const inc = snap.income;
  const blocks = [];

  // 1. Summary & cash flow. Outgoings are positive: income less them is the surplus.
  blocks.push([
    ["Metric", "Amount"],
    ["Latest paycheck", n(inc.paycheck && inc.paycheck.amount)],
    ["Paychecks per month", inc.cadence ? rate(PER_MONTH[inc.cadence]) : ""],
    ["Estimated monthly income", n(inc.monthly)],
    ["Debt minimums (monthly)", n(snap.debtMonthly)],
    ["Recurring bills (monthly)", n(snap.billsMonthly)],
    ["Subscriptions (monthly)", n(snap.subscriptionsMonthly)],
    ["Projected necessities (monthly)", n(snap.necessitiesMonthly)],
    ["Total monthly outgoings", n(inc.outflow)],
    ["Net surplus / deficit (monthly)", n(inc.surplus)],
    ["Total cash", n(snap.cashTotal)],
    ["Credit available", n(snap.creditAvailable)],
    ["Total debt", n(snap.debtTotal)],
    ["Invested", n(snap.investedTotal)]
  ]);

  // 2. Cash & savings. A capped fund's cap sits on the account that holds it;
  // savings goals are money set aside inside these accounts, so the Type column
  // tells them apart (summing everything would count that money twice).
  const heldFunds = new Set(snap.cash.filter((c) => c.fund).map((c) => c.fund));
  const fundCap = new Map(snap.funds.map((f) => [f.name, f.cap]));
  blocks.push([
    ["Account", "Type", "Balance", "Target Goal", "Target Date"],
    ...snap.cash.map((c) => [
      c.fund ? `${c.name} (${c.fund})` : c.name,
      SNAPSHOT_ACCOUNT_TYPES[c.type] || c.type,
      n(c.balance),
      c.fund ? n(fundCap.get(c.fund)) : "",
      ""
    ]),
    ...snap.funds.filter((f) => !heldFunds.has(f.name)).map((f) => [f.name, "Capped fund", n(f.balance), n(f.cap), ""]),
    ...snap.savings.map((g) => [g.name, "Savings goal", n(g.saved), n(g.target), g.targetDate || ""])
  ]);

  // 3. Debts & credit: one row per lender. A card carries its limit and what's
  // left of it; a plan carries its monthly cost and how long it has to run.
  const cardByAccount = new Map(snap.cards.filter((c) => c.accountId).map((c) => [c.accountId, c]));
  const debtRows = [];
  snap.credit.forEach((c) => {
    const card = cardByAccount.get(c.accountId);
    if (!(c.balance > 0) && c.limit == null) return; // paid off, nothing to borrow against
    debtRows.push([card ? card.name : c.name, n(c.balance), n(c.limit), n(c.available), card ? rate(card.apr) : "", card ? n(card.minimum) : "", ""]);
  });
  const listed = new Set(snap.credit.map((c) => c.accountId));
  snap.cards.filter((c) => c.balance > 0 && !(c.accountId && listed.has(c.accountId))).forEach((c) => {
    debtRows.push([c.name, n(c.balance), "", "", rate(c.apr), n(c.minimum), ""]);
  });
  snap.plans.filter((p) => p.balance > 0).forEach((p) => {
    // Payments left, as months: a monthly plan's count as is; otherwise the
    // count over payments a month (7 biweekly payments ≈ 3.2 months).
    const months = p.remaining == null ? null : p.frequency === "monthly" ? p.remaining : Math.round((p.remaining / (PER_MONTH[p.frequency] || 1)) * 10) / 10;
    debtRows.push([p.name, n(p.balance), "", "", rate(p.apr), n(p.monthly), rate(months)]);
  });
  blocks.push([["Lender", "Balance", "Credit Limit", "Available Credit", "APR (%)", "Monthly Min", "Remaining Months"], ...debtRows]);

  // 4. Subscriptions & necessities, with recurring bills alongside so the block
  // holds every non-debt outgoing the surplus counts.
  const cap = (t) => (t ? String(t).charAt(0).toUpperCase() + String(t).slice(1) : "");
  blocks.push([
    ["Item", "Category", "Monthly Cost", "Billing Cadence"],
    ...snap.bills.map((b) => [b.name, "Bill", n(b.monthly), cap(b.cadence).replace(/^Monthly, day (.+)$/, "Monthly (day $1)")]),
    ...snap.subscriptions.map((s) => [s.name, "Subscription", n(s.monthly), cap(s.cadence)]),
    ...snap.necessities.map((x) => [x.name, "Necessity", n(x.monthly), x.everyDays != null ? `Every ${x.everyDays} day${x.everyDays === 1 ? "" : "s"}` : "Irregular"])
  ]);

  // 5. Investments, each at its latest statement.
  if (snap.investments.length) {
    blocks.push([
      ["Account", "Kind", "Value", "Statement Date"],
      ...snap.investments.map((i) => [i.name, i.kind || "", n(i.value), i.asOf || ""])
    ]);
  }

  const q = (v) => {
    const t = String(v == null ? "" : v);
    return /[",\n\r]/.test(t) ? `"${t.replace(/"/g, '""')}"` : t;
  };
  return blocks.map((rows) => rows.map((r) => r.map(q).join(",")).join("\r\n")).join("\r\n\r\n") + "\r\n";
}

// Reads everything the snapshot needs and builds it.
// ---------- transaction notes ----------

// One markdown note per month, plus an index linking them, so the transaction
// history can be searched, linked and queried from inside Obsidian. It is a
// read-only copy: the plugin never reads these notes back, and every export
// rewrites them. Pure so a test can check the notes without a vault.
function buildTransactionNotes(transactions, accounts = []) {
  const accountName = new Map((accounts || []).filter((a) => a && a.id).map((a) => [a.id, accountLabel(a)]));
  const NOTE_WARNING = "Made by Budget Tracker. Changes here are overwritten the next time you export.";
  const byMonth = new Map();
  const undated = [];
  (transactions || []).forEach((t) => {
    if (!t) return;
    if (isISODateString(t.date)) {
      const key = t.date.slice(0, 7);
      if (!byMonth.has(key)) byMonth.set(key, []);
      byMonth.get(key).push(t);
    } else {
      undated.push(t);
    }
  });

  const totals = (list) => {
    let moneyIn = 0;
    let moneyOut = 0;
    list.forEach((t) => {
      const a = Number(t.amount) || 0;
      if (a > 0) moneyIn += a;
      else moneyOut -= a;
    });
    return { moneyIn: round2(moneyIn), moneyOut: round2(moneyOut) };
  };
  const row = (t) => [
    t.date || "no date",
    `${t.merchant_raw || "—"}${t.pending ? " (pending)" : ""}`,
    t.override_label || t.resolved_category || "Uncategorized",
    t.account_id ? accountName.get(t.account_id) || t.account_id : "—",
    snapshotMoney(t.amount)
  ];
  const sorted = (list) =>
    list.slice().sort((a, b) => String(a.date || "").localeCompare(String(b.date || "")) || String(a.id || "").localeCompare(String(b.id || "")));
  const head = ["Date", "Merchant", "Category", "Account", "Amount"];
  const noteName = (key) => `Transactions ${key}`;

  const files = [];
  const indexRows = [];
  [...byMonth.keys()].sort().reverse().forEach((key) => {
    const list = sorted(byMonth.get(key));
    const { moneyIn, moneyOut } = totals(list);
    files.push({
      name: noteName(key),
      content: [
        "---",
        `month: ${key}`,
        `transactions: ${list.length}`,
        `money_in: ${moneyIn.toFixed(2)}`,
        `money_out: ${moneyOut.toFixed(2)}`,
        "---",
        `# Transactions ${monthLabel(key)}`,
        "",
        `${list.length} transaction${list.length === 1 ? "" : "s"} · in ${snapshotMoney(moneyIn)} · out ${snapshotMoney(moneyOut)}`,
        "",
        snapshotTable(head, list.map(row)),
        "",
        `_${NOTE_WARNING}_`,
        ""
      ].join("\n")
    });
    indexRows.push([`[[${noteName(key)}|${monthLabel(key)}]]`, list.length, snapshotMoney(moneyIn), snapshotMoney(moneyOut)]);
  });

  if (undated.length) {
    const list = undated.slice();
    files.push({
      name: "Transactions no date",
      content: ["# Transactions with no date", "", "Usually bank holds that haven't posted yet.", "", snapshotTable(head, list.map(row)), "", `_${NOTE_WARNING}_`, ""].join("\n")
    });
    indexRows.push(["[[Transactions no date|No date]]", list.length, "—", "—"]);
  }

  files.push({
    name: "Transactions",
    content: [
      "# Transactions",
      "",
      indexRows.length ? snapshotTable(["Month", "Transactions", "In", "Out"], indexRows) : "No transactions yet.",
      "",
      `_${NOTE_WARNING}_`,
      ""
    ].join("\n")
  });
  return files;
}

// ---------- one kind of data, as a note ----------

// What the "one kind of data" export offers, in the order it's listed.
const EXPORT_KINDS = [
  { key: "transactions", label: "Transactions" },
  { key: "spending", label: "Spending by month" },
  { key: "debts", label: "Debts" },
  { key: "income", label: "Income" },
  { key: "accounts", label: "Cash and credit" },
  { key: "savings", label: "Savings goals" },
  { key: "bills", label: "Bills and subscriptions" },
  { key: "portfolio", label: "Portfolio" }
];

const EXPORT_NOTE_WARNING = "Made by Budget Tracker. Changes here are overwritten the next time you export.";

// A note's title, a date property, the body and the overwrite warning.
function exportNote(title, body, todayStr) {
  return ["---", `exported: ${todayStr}`, "---", `# ${title}`, "", ...body, "", `_${EXPORT_NOTE_WARNING}_`, ""].join("\n");
}

// The files for one kind of data, as { path, content } with the path under
// Budget/exports. Pure: `data` is what readExportData returns.
function buildDataNotes(kind, data, { todayStr = todayLocal(), settings = {} } = {}) {
  if (kind === "transactions") {
    return buildTransactionNotes(data.transactions, data.accounts).map((f) => ({ path: `Transactions/${f.name}.md`, content: f.content }));
  }
  const snap = buildFinancialSnapshot(data, { todayStr, settings });
  const sections = (keys) => snapshotMarkdown(snap, { only: keys }).trimEnd().split("\n");
  // A section that repeats the note's own title doesn't need its heading.
  const one = (name, body) => {
    const at = body.indexOf(`## ${name}`);
    const lines = at === 0 ? body.slice(2) : body;
    return [{ path: `${name}.md`, content: exportNote(name, lines, todayStr) }];
  };

  if (kind === "debts") return one("Debts", sections(["debts"]));
  if (kind === "accounts") return one("Cash and credit", sections(["cash", "credit"]));
  if (kind === "savings") return one("Savings goals", sections(["savings"]));
  if (kind === "bills") return one("Bills and subscriptions", sections(["bills", "subscriptions", "necessities"]));

  if (kind === "income") {
    const history = (data.paycheckHistory || []).filter((p) => p && p.date && Number(p.amount) > 0).sort((a, b) => (a.date < b.date ? 1 : -1));
    const body = sections(["income"]);
    if (history.length) {
      body.push("", "## Paychecks you entered", "", snapshotTable(["Date", "Amount"], history.map((p) => [p.date, snapshotMoney(p.amount)])));
    }
    return one("Income", body);
  }

  if (kind === "portfolio") {
    const accounts = normalizePortfolioAccounts(data.portfolioAccounts || []);
    const label = new Map(accounts.map((a) => [a.id, a.label]));
    const rows = (data.portfolioSnapshots || [])
      .filter((s) => s && s.statement_end && Number.isFinite(s.ending_value))
      .sort((a, b) => (a.statement_end < b.statement_end ? 1 : a.statement_end > b.statement_end ? -1 : 0))
      .map((s) => [
        label.get(s.account_id) || s.account_id || "—",
        s.statement_end,
        s.beginning_value != null ? snapshotMoney(s.beginning_value) : "—",
        s.contributions != null ? snapshotMoney(s.contributions) : "—",
        snapshotMoney(s.ending_value)
      ]);
    const body = sections(["investments"]);
    if (rows.length) body.push("", "## Statements and balances", "", snapshotTable(["Account", "Period end", "Beginning", "Contributions", "Ending"], rows));
    return one("Portfolio", body);
  }

  if (kind === "spending") {
    const meta = data.categoryMeta || [];
    const body = [];
    availableMonths(data.transactions || []).forEach((mo) => {
      const { totals, transferTotal } = categorySpendTotals(transactionsInMonth(data.transactions, mo.key), meta);
      const entries = Object.entries(totals).sort((a, b) => b[1] - a[1]);
      if (!entries.length && !transferTotal) return;
      const total = round2(entries.reduce((s, [, v]) => s + v, 0));
      body.push(`## ${mo.label}`, "");
      body.push(entries.length
        ? snapshotTable(["Category", "Spent", "Share"], entries.map(([c, v]) => [c, snapshotMoney(round2(v)), total > 0 ? `${Math.round((v / total) * 100)}%` : "—"]), ["Total", snapshotMoney(total), ""])
        : "_No spending._");
      if (transferTotal > 0) body.push("", `Transfers between your own accounts, not counted above: ${snapshotMoney(round2(transferTotal))}`);
      body.push("");
    });
    if (!body.length) body.push("No spending yet.");
    return one("Spending by month", body);
  }
  return [];
}

// Every kind, for a full export.
function buildFullExportNotes(data, opts) {
  return EXPORT_KINDS.flatMap((k) => buildDataNotes(k.key, data, opts));
}

// A new transaction from the Add transaction form, or why it can't be saved.
// `amount` is typed positive and `direction` says which way the money went, so
// nobody has to remember the sign. A category you pick is your own choice and
// beats the rules; left on automatic, the rules decide as they do for imports.
function buildManualTransaction(form, rules = []) {
  const date = normalizeDate(form.date || "");
  if (!isISODateString(date)) return { ok: false, error: "Enter a date." };
  const merchant = String(form.merchant || "").trim();
  if (!merchant) return { ok: false, error: "Enter what it was for." };
  const r = parseMoneyInput(form.amount, {});
  if (!r.ok) return { ok: false, error: `Amount: ${r.message}` };
  if (r.empty || !(r.value > 0)) return { ok: false, error: "Enter an amount above zero." };
  if (!form.account_id) return { ok: false, error: "Choose an account." };
  const amount = round2(form.direction === "in" ? r.value : -r.value);
  const tx = {
    id: genId("tx"),
    date,
    merchant_raw: merchant,
    amount,
    account_id: form.account_id,
    resolved_category: null,
    override_label: form.category || null,
    manual: true
  };
  applyCategorization([tx], rules);
  return { ok: true, tx };
}

// Every file the exports read, in the shape buildFinancialSnapshot takes.
async function readExportData(app) {
  const read = (f, d) => readJSON(app, f, d);
  return {
    accounts: await read(FILES.accounts, []),
    goals: await read(FILES.savingsGoals, []),
    revolvingDebts: await read(FILES.revolvingDebts, []),
    installmentDebts: await read(FILES.installmentDebts, []),
    fixedExpenses: await read(FILES.fixedExpenses, []),
    transactions: await read(FILES.transactions, []),
    reviews: await read(FILES.subscriptionReviews, []),
    rules: await read(FILES.rules, []),
    categoryMeta: await read(FILES.categories, []),
    paycheckHistory: await read(FILES.paycheckHistory, []),
    portfolioAccounts: await read(FILES.portfolioAccounts, []),
    portfolioSnapshots: await read(FILES.portfolioSnapshots, [])
  };
}

async function generateFinancialSnapshot(app, settings = {}) {
  const data = await readExportData(app);
  const snapshot = buildFinancialSnapshot(data, { settings });
  return { snapshot, markdown: snapshotMarkdown(snapshot), csv: snapshotCSV(snapshot) };
}

// Re-anchors a card debt to a balance the user just stated, and keeps the
// account record holding the same figure. These lived in two files with an
// account_id between them that nothing ever read, so editing the balance in one
// place left the other showing a number from weeks ago.
//
// applied_payments is deliberately KEPT: it no longer reduces a card balance,
// but it still credits the billing cycle's minimum, and wiping it would make a
// minimum you already paid reappear as due.
// `asOf` is the date the balance was true as of — a bank feed reports its own,
// which can be a day behind. Card activity is counted strictly after it.
async function reanchorCardBalance(app, accountId, newBalance, asOf = null) {
  if (!accountId) return false;
  const today = asOf && isISODateString(asOf) ? asOf : todayLocal();
  const amount = round2(newBalance);
  let touched = false;

  const accounts = await readJSON(app, FILES.accounts, []);
  const ai = accounts.findIndex((a) => a.id === accountId);
  if (ai >= 0 && round2(accounts[ai].current_balance ?? 0) !== amount) {
    accounts[ai].current_balance = amount;
    stampBalance(accounts[ai], "manual");
    await writeJSON(app, FILES.accounts, accounts);
    touched = true;
  }

  const revolving = await readJSON(app, FILES.revolvingDebts, []);
  const di = revolving.findIndex((d) => d.account_id === accountId);
  if (di >= 0) {
    revolving[di].balance_anchor = { amount, date: today };
    // The record used to carry a third copy of the balance here. The anchor and
    // the account record are the two real sources; a third that nothing read
    // only looked authoritative.
    delete revolving[di].current_balance;
    await writeJSON(app, FILES.revolvingDebts, revolving);
    touched = true;
  }
  return touched;
}

// Backfills the anchor/ledger fields onto debts created before this model existed.
async function ensureDebtAnchors(app) {
  const today = todayLocal();
  let changed = false;

  const revolving = await readJSON(app, FILES.revolvingDebts, []);
  revolving.forEach((d) => {
    if (!d.payment_category) {
      d.payment_category = "Credit Card Payment";
      changed = true;
    }
    if (!d.balance_anchor) {
      d.balance_anchor = { amount: d.current_balance || 0, date: today };
      changed = true;
    }
    if (!d.applied_payments) d.applied_payments = [];
  });
  if (changed) await writeJSON(app, FILES.revolvingDebts, revolving);

  changed = false;
  const installment = await readJSON(app, FILES.installmentDebts, []);
  installment.forEach((d) => {
    // payment_category is what tells the resolver a category is debt-class
    // money. Plans created before the field existed have none, so a single
    // legacy plan could leave its whole category reading as ordinary spending.
    if (!d.payment_category) {
      d.payment_category = isLoan(d) ? LOAN_TYPES[loanType(d)].category : "BNPL";
      changed = true;
    }
    if (!d.balance_anchor) {
      const amt = (d.installment_amount || 0) * (d.remaining_installments || 0);
      d.balance_anchor = { amount: round2(amt), date: today };
      changed = true;
    }
    if (!d.applied_payments) d.applied_payments = [];
  });
  if (changed) await writeJSON(app, FILES.installmentDebts, installment);

  return { revolving, installment };
}

// Transactions that look like they could pay down this debt: money out, not
// already applied to ANY debt, and (when the debt names a payment category)
// matching that category.
// Categories a debt payment could plausibly live in. Anything outside this set
// (Groceries, Gas, Retail...) is never offered, so routine spending can't be
// mistakenly applied against a balance.
function debtPaymentCategories(debt, categoryMeta) {
  // Uncategorized is included deliberately: a real payment that hasn't been
  // labeled yet would otherwise be invisible here. It's a small share of rows.
  const allowed = new Set(["BNPL", "Credit Card Payment", "Uncategorized"]);
  if (debt && debt.payment_category) allowed.add(debt.payment_category);
  (categoryMeta || []).forEach((c) => {
    if (c.is_transfer && c.name) allowed.add(c.name);
  });
  return allowed;
}

// Classes that stay eligible as a candidate for ANY obligation.
//
// "discretionary" means nothing has claimed the transaction — the normal state
// of a payment the user is about to link. "transfer" is money moving between
// accounts, which is how a card payment or a savings transfer actually appears,
// so excluding it would hide the very transactions those flows need.
//
// Everything else names a specific obligation, and a transaction that already
// belongs to one is not a candidate for a different one: a gas fill is not a
// phone bill, and offering it invites exactly the mis-filing the ownership model
// exists to prevent.
const NEUTRAL_CANDIDATE_CLASSES = new Set(["discretionary", "transfer"]);

function candidateClassAllowed(cls, forClass) {
  if (!forClass || !cls) return true;
  return cls === forClass || NEUTRAL_CANDIDATE_CLASSES.has(cls);
}

// The index a candidate list falls back to when the caller didn't supply one.
//
// Every field is named explicitly, and the point is that they are ALL named: a
// partial index doesn't fail, it under-classifies. Leave out categoryMeta and
// nothing knows Gas is a necessity or that Credit Card Payment belongs to a
// card, so those transactions read as ordinary spending — and ordinary spending
// is the one class every obligation accepts as a candidate. A fuel purchase then
// turns up in the list of things that might have paid the phone bill, which is
// precisely what the class gate exists to stop.
//
// Adding a field to buildOwnershipIndex should mean adding it here too; keeping
// the list spelled out rather than spread-through is what makes that visible.
function completeOwnership({
  fixedExpenses = [],
  installmentDebts = [],
  revolvingDebts = [],
  goals = [],
  categoryMeta = [],
  subscriptionKeys = [],
  rules = []
} = {}) {
  return buildOwnershipIndex({
    fixedExpenses,
    installmentDebts,
    revolvingDebts,
    goals,
    categoryMeta,
    subscriptionKeys,
    rules
  });
}

// One candidate finder behind every "which transaction was this?" flow.
//
// The three call sites — debt payments, fixed-expense payments, savings
// contributions — were each doing the same job with a different idea of what
// "unclaimed" means. Debt suggestions excluded only debt-linked transactions,
// so a payment already linked to a fixed expense or a savings goal could still
// be offered as a debt payment and claimed a second time.
//
// Exclusion now comes from the ownership index, which already knows what every
// transaction settles, so it cannot drift per call site again.
function findCandidateTransactions({
  transactions = [],
  ownership = null,
  excludeIds = null,
  notBefore = null,
  categories = null,
  near = null,
  windowDays = null,
  targetAmount = null,
  exactAmount = false,
  reviewGate = false,
  rank = "amount",
  forClass = null,
  limit = 0
}) {
  const extra = excludeIds instanceof Set ? excludeIds : new Set(excludeIds || []);
  let accountedElsewhere = 0;
  // A half of a transfer paired with a capped fund's account is money moved
  // into or out of that fund. It paid no bill and no debt, and counting it
  // toward a goal as well would count the same dollars twice. Only a pair that
  // still stands hides a row; one the user has relabelled no longer does.
  const byId = new Map((transactions || []).filter((t) => t && t.id).map((t) => [t.id, t]));

  let out = (transactions || [])
    .filter((t) => t && t.id && t.amount < 0)
    .filter((t) => !livePairPartner(t, byId))
    // Anything already settling an obligation belongs to that obligation.
    .filter((t) => !(ownership && ownership.settlementOf(t)))
    .filter((t) => !extra.has(t.id))
    // Already the right KIND of money for some other obligation. Counted so the
    // caller can say "those are accounted for elsewhere" instead of showing a
    // bare empty list.
    .filter((t) => {
      if (!ownership || !forClass) return true;
      if (candidateClassAllowed(ownership.classOf(t), forClass)) return true;
      accountedElsewhere++;
      return false;
    });

  if (reviewGate) {
    // "Already applied" is an explicit assertion that the balance reflects this
    // payment; "not a payment" that it never was one. Both hide it for good.
    out = out
      .filter((t) => t.debt_payment_review_status !== "already_applied")
      .filter((t) => !t.excluded_from_debt_payments);
  }
  if (notBefore) out = out.filter((t) => !t.date || t.date >= notBefore);
  if (categories) out = out.filter((t) => categories.has(t.resolved_category || ""));
  if (near && windowDays) {
    const from = addDays(near, -windowDays);
    const to = addDays(near, windowDays);
    out = out.filter((t) => t.date && t.date >= from && t.date <= to);
  }
  if (exactAmount && targetAmount != null) {
    out = out.filter((t) => Math.abs(Math.abs(t.amount) - Math.abs(targetAmount)) < 0.005);
  }

  const byDate = (a, b) => {
    if (!near) return a.date < b.date ? 1 : a.date > b.date ? -1 : 0;
    return Math.abs(daysBetween(near, a.date || near)) - Math.abs(daysBetween(near, b.date || near));
  };

  out.sort((a, b) => {
    if (rank === "category") {
      // Known payment categories first, unlabelled guesses after.
      const aUnk = (a.resolved_category || "Uncategorized") === "Uncategorized" ? 1 : 0;
      const bUnk = (b.resolved_category || "Uncategorized") === "Uncategorized" ? 1 : 0;
      if (aUnk !== bUnk) return aUnk - bUnk;
      return byDate(a, b);
    }
    if (rank === "amount" && targetAmount != null) {
      const da = Math.abs(Math.abs(a.amount) - Math.abs(targetAmount));
      const db = Math.abs(Math.abs(b.amount) - Math.abs(targetAmount));
      if (Math.abs(da - db) > 0.005) return da - db;
    }
    return byDate(a, b);
  });

  const result = limit > 0 ? out.slice(0, limit) : out;
  // Metadata for the empty state, hidden so spreads and JSON ignore it.
  Object.defineProperty(result, "accountedElsewhere", {
    value: accountedElsewhere,
    enumerable: false
  });
  return result;
}

function candidatePayments(debt, transactions, allDebts, categoryMeta = [], ownership = null, context = {}) {
  const index =
    ownership ||
    completeOwnership(
      Object.assign(
        {
          installmentDebts: allDebts.filter((d) => d && d.provider),
          revolvingDebts: allDebts.filter((d) => d && !d.provider),
          categoryMeta
        },
        context
      )
    );
  return findCandidateTransactions({
    transactions,
    ownership: index,
    notBefore: isLoan(debt) ? loanMatchFrom(debt) : debt.balance_anchor ? debt.balance_anchor.date : null,
    categories: debtPaymentCategories(debt, categoryMeta),
    reviewGate: true,
    forClass: "debt",
    rank: "category"
  });
}

async function logDebtSnapshot(app, revolving, installment, transactions = null) {
  const total = totalDebt(revolving, installment, transactions);
  const history = await readJSON(app, FILES.debtHistory, []);
  const today = todayLocal();

  const idx = history.findIndex((h) => h.date === today);
  if (idx >= 0) {
    if (history[idx].total_debt === total) return history; // nothing changed
    history[idx].total_debt = total;
  } else {
    history.push({ date: today, total_debt: total });
  }
  history.sort((a, b) => (a.date < b.date ? -1 : 1));
  await writeJSON(app, FILES.debtHistory, history);
  return history;
}

// Builds an SVG line chart of total debt over time, with an optional dotted
// projection to $0 based on the current period's paydown rate.
// The debt burndown line, and — with `opts` — any other value over time drawn
// the same way (the Portfolio tab's). opts: ariaLabel(first, last) for the
// chart's accessible name, xLabel(date) for the two axis dates, pointLabel(date)
// for what the hover readout calls a point (data-label), and cls for the svg.
function buildDebtChart(history, projection, opts = {}) {
  const W = 640;
  const H = 220;
  const PAD = { top: 16, right: 16, bottom: 30, left: 58 };
  const plotW = W - PAD.left - PAD.right;
  const plotH = H - PAD.top - PAD.bottom;

  if (!history || history.length === 0) return null;

  const toDays = (d) => Math.round(new Date(`${d}T00:00:00`).getTime() / 86400000);
  const pts = history.map((h) => ({ x: toDays(h.date), y: h.total_debt, date: h.date }));

  let projPts = [];
  if (projection && projection.zeroDate && projection.perDay > 0) {
    const last = pts[pts.length - 1];
    projPts = [
      { x: last.x, y: last.y, date: last.date },
      { x: toDays(projection.zeroDate), y: 0, date: projection.zeroDate }
    ];
  }

  const allX = pts.concat(projPts).map((p) => p.x);
  const allY = pts.concat(projPts).map((p) => p.y);
  const minX = Math.min(...allX);
  const maxX = Math.max(...allX);
  const dataMax = Math.max(...allY, 1);
  // Zoomed, the axis fits the line (with a little air) instead of running down
  // to $0, which is what makes a few weeks of paydown visible. Not the default:
  // a chart that doesn't start at zero should be asked for.
  let minY = 0;
  let maxY = dataMax;
  if (opts.zoom) {
    const lo = Math.min(...allY);
    const pad = (dataMax - lo) * 0.12 || dataMax * 0.1 || 1;
    minY = Math.max(0, lo - pad);
    maxY = dataMax + pad;
  }

  const spanX = maxX - minX || 1;
  const sx = (x) => PAD.left + ((x - minX) / spanX) * plotW;
  const sy = (y) => PAD.top + plotH - ((y - minY) / (maxY - minY || 1)) * plotH;

  const line = (arr) => arr.map((p, i) => `${i === 0 ? "M" : "L"} ${sx(p.x).toFixed(1)} ${sy(p.y).toFixed(1)}`).join(" ");

  // y gridlines at 0 / 50% / 100%
  const yTicks = [minY, (minY + maxY) / 2, maxY];
  const grid = yTicks
    .map(
      (v) =>
        `<line x1="${PAD.left}" y1="${sy(v).toFixed(1)}" x2="${W - PAD.right}" y2="${sy(v).toFixed(1)}" stroke="var(--background-modifier-border)" stroke-width="1"/>` +
        `<text x="${PAD.left - 8}" y="${(sy(v) + 4).toFixed(1)}" text-anchor="end" font-size="10" fill="var(--text-muted)">$${Math.round(v).toLocaleString()}</text>`
    )
    .join("");

  const fmtDate = opts.xLabel || ((d) => d.slice(5)); // MM-DD
  const xLabels =
    `<text x="${PAD.left}" y="${H - 10}" font-size="10" fill="var(--text-muted)">${fmtDate(history[0].date)}</text>` +
    (projPts.length
      ? `<text x="${W - PAD.right}" y="${H - 10}" text-anchor="end" font-size="10" fill="var(--text-muted)">${fmtDate(projPts[1].date)} (proj.)</text>`
      : `<text x="${W - PAD.right}" y="${H - 10}" text-anchor="end" font-size="10" fill="var(--text-muted)">${fmtDate(history[history.length - 1].date)}</text>`);

  const projPath = projPts.length
    ? `<path d="${line(projPts)}" fill="none" stroke="var(--text-muted)" stroke-width="2" stroke-dasharray="5 4" opacity="0.8"/>`
    : "";

  const solid =
    pts.length > 1
      ? `<path d="${line(pts)}" fill="none" stroke="var(--text-accent, #7b6cd9)" stroke-width="2.5" stroke-linejoin="round"/>`
      : "";

  // Each point carries its own date and exact value for the hover layer
  // (enableChartHover). The projected payoff gets an unpainted marker so the
  // crosshair can land on it too.
  const dots = pts
    .map(
      (p) =>
        `<circle class="budget-chart-pt" cx="${sx(p.x).toFixed(1)}" cy="${sy(p.y).toFixed(1)}" r="3" fill="var(--text-accent, #7b6cd9)" data-date="${p.date}" data-value="${p.y.toFixed(2)}"` +
        (opts.pointLabel ? ` data-label="${escapeAttr(opts.pointLabel(p.date))}"` : "") +
        "/>"
    )
    .join("");
  const projMark = projPts.length
    ? `<circle class="budget-chart-pt" cx="${sx(projPts[1].x).toFixed(1)}" cy="${sy(0).toFixed(1)}" r="0" data-date="${projPts[1].date}" data-value="0.00" data-projected="1"/>`
    : "";

  // Drawn last so it sits over everything and takes the pointer; padded a little
  // past the plot so the first and last points are easy to reach.
  const focusLayer =
    `<g class="budget-chart-focus" visibility="hidden" pointer-events="none">` +
    `<line class="budget-chart-guide" x1="0" x2="0" y1="${PAD.top}" y2="${(PAD.top + plotH).toFixed(1)}" stroke="var(--text-faint, var(--text-muted))" stroke-width="1"/>` +
    `<circle class="budget-chart-ring" cx="0" cy="0" r="5.5" fill="var(--background-primary)" stroke="var(--text-accent, #7b6cd9)" stroke-width="2.5"/>` +
    `</g>`;
  const hit = `<rect class="budget-chart-hit" x="${PAD.left - 10}" y="${PAD.top}" width="${plotW + 20}" height="${plotH}" fill="transparent" pointer-events="all"/>`;

  const first = pts[0];
  const last = pts[pts.length - 1];
  const label =
    (opts.ariaLabel
      ? opts.ariaLabel(first, last)
      : `Total debt, ${first.date} to ${last.date}: $${first.y.toFixed(2)} to $${last.y.toFixed(2)}.`) +
    " Use the arrow keys to read each point.";

  return (
    `<svg class="budget-debt-chart${opts.cls ? " " + opts.cls : ""}" viewBox="0 0 ${W} ${H}" width="100%" preserveAspectRatio="xMidYMid meet" tabindex="0" role="img" aria-label="${label}">` +
    `${grid}${projPath}${solid}${dots}${projMark}${xLabels}${focusLayer}${hit}</svg>`
  );
}

function escapeAttr(s) {
  return String(s == null ? "" : s).replace(/&/g, "&amp;").replace(/"/g, "&quot;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}

// The Portfolio tab's value over time: the debt chart's line, crosshair and
// readout, with each point at the end of its month — the value is each
// account's latest statement as of then — and read out as the month.
function buildPortfolioChart(history) {
  if (!history || !history.length) return null;
  const monthEnd = (mk) => {
    const [y, m] = mk.split("-").map(Number);
    return toLocalISO(new Date(y, m, 0));
  };
  const short = (iso) => {
    const months = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
    return `${months[Number(iso.slice(5, 7)) - 1]} ${iso.slice(0, 4)}`;
  };
  return buildDebtChart(
    history.map((p) => ({ date: monthEnd(p.month), total_debt: p.value })),
    null,
    {
      cls: "budget-pf-chart",
      xLabel: short,
      pointLabel: (d) => `End of ${monthLabel(d.slice(0, 7))}`,
      ariaLabel: (first, last) =>
        `Combined investment value, ${monthLabel(first.date.slice(0, 7))} to ${monthLabel(last.date.slice(0, 7))}: ` +
        `$${first.y.toFixed(2)} to $${last.y.toFixed(2)}.`
    }
  );
}

// "$4,213.07" — the full figure, to the cent. The axis rounds; this is the one
// place a reader goes for the exact number.
function formatChartMoney(value) {
  return `$${formatMoneyInput(Number(value) || 0)}`;
}

// "Sep 22, 2026". Built by hand rather than toLocaleDateString, whose output
// depends on the machine's locale settings.
function formatChartDate(iso) {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(String(iso || ""));
  if (!m) return String(iso || "");
  const months = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
  return `${months[Number(m[2]) - 1]} ${Number(m[3])}, ${m[1]}`;
}

// "Oct 6" this year, "Oct 6, 2027" any other, for lines of small text where the
// year is noise.
function formatShortDate(iso) {
  const full = formatChartDate(iso);
  const year = todayLocal().slice(0, 4);
  return full.endsWith(`, ${year}`) ? full.slice(0, -(year.length + 2)) : full;
}

// The point closest to x, ties to the earlier one.
function nearestIndexByX(points, x) {
  let best = -1;
  let bestDist = Infinity;
  (points || []).forEach((p, i) => {
    const d = Math.abs(p.x - x);
    if (d < bestDist) {
      bestDist = d;
      best = i;
    }
  });
  return best;
}

// Crosshair and readout for the debt chart. Hover anywhere over the plot and it
// snaps to the nearest date; nobody should have to land a cursor on a 6px dot
// and wait for the browser's own tooltip to read a number. A tap or drag works
// the same on touch, and the chart takes keyboard focus — arrow keys step
// through the points, Home/End jump to the ends, Escape clears.
//
// Standard DOM only, no Obsidian helpers, so it runs unchanged in a plain
// browser. Returns null when there's nothing to attach to.
function enableChartHover(wrap) {
  const svg = wrap && typeof wrap.querySelector === "function" ? wrap.querySelector("svg") : null;
  if (!svg) return null;
  const focus = svg.querySelector(".budget-chart-focus");
  const guide = svg.querySelector(".budget-chart-guide");
  const ring = svg.querySelector(".budget-chart-ring");
  const hit = svg.querySelector(".budget-chart-hit");
  const marks = Array.from(svg.querySelectorAll(".budget-chart-pt"));
  if (!focus || !guide || !ring || !hit || marks.length === 0) return null;

  const pts = marks.map((m) => ({
    x: Number(m.getAttribute("cx")),
    y: Number(m.getAttribute("cy")),
    date: m.getAttribute("data-date"),
    label: m.getAttribute("data-label"),
    value: Number(m.getAttribute("data-value")),
    projected: m.getAttribute("data-projected") === "1"
  }));
  const lastActual = pts.reduce((k, p, i) => (p.projected ? k : i), 0);

  const doc = wrap.ownerDocument;
  const tip = doc.createElement("div");
  tip.className = "budget-chart-tip";
  tip.setAttribute("aria-live", "polite");
  const valueEl = doc.createElement("div");
  valueEl.className = "budget-chart-tip-value";
  const dateEl = doc.createElement("div");
  dateEl.className = "budget-chart-tip-date";
  tip.appendChild(valueEl);
  tip.appendChild(dateEl);
  tip.hidden = true;
  wrap.appendChild(tip);

  const toScreen = (x, y, inverse) => {
    const ctm = svg.getScreenCTM();
    if (!ctm) return null;
    const p = svg.createSVGPoint();
    p.x = x;
    p.y = y;
    return p.matrixTransform(inverse ? ctm.inverse() : ctm);
  };

  let current = -1;
  const show = (i) => {
    if (i < 0 || i >= pts.length) return;
    current = i;
    const p = pts[i];
    guide.setAttribute("x1", p.x);
    guide.setAttribute("x2", p.x);
    ring.setAttribute("cx", p.x);
    ring.setAttribute("cy", p.y);
    focus.setAttribute("visibility", "visible");

    valueEl.textContent = formatChartMoney(p.value);
    dateEl.textContent = p.projected
      ? `Projected payoff \u00b7 ${formatChartDate(p.date)}`
      : p.label || formatChartDate(p.date);
    tip.hidden = false;

    // Centred over the point and kept inside the card; drops below the point
    // when there's no room above it.
    const at = toScreen(p.x, p.y, false);
    if (!at) return;
    const box = wrap.getBoundingClientRect();
    const w = tip.offsetWidth;
    const h = tip.offsetHeight;
    const left = Math.min(Math.max(at.x - box.left - w / 2, 0), Math.max(wrap.clientWidth - w, 0));
    let top = at.y - box.top - h - 12;
    if (top < 0) top = at.y - box.top + 14;
    tip.style.left = `${Math.round(left)}px`;
    tip.style.top = `${Math.round(top)}px`;
  };
  const hide = () => {
    current = -1;
    focus.setAttribute("visibility", "hidden");
    tip.hidden = true;
  };
  const track = (e) => {
    const v = toScreen(e.clientX, e.clientY, true);
    if (v) show(nearestIndexByX(pts, v.x));
  };

  hit.addEventListener("pointermove", track);
  hit.addEventListener("pointerdown", track);
  // A finger lifting off counts as leaving; on touch the readout stays until a
  // tap somewhere else, or it would vanish the instant it appeared.
  hit.addEventListener("pointerleave", (e) => {
    if (e.pointerType !== "touch") hide();
  });
  const outside = (e) => {
    if (!wrap.isConnected) {
      doc.removeEventListener("pointerdown", outside, true);
      return;
    }
    if (!wrap.contains(e.target)) hide();
  };
  doc.addEventListener("pointerdown", outside, true);

  svg.addEventListener("focus", () => show(current >= 0 ? current : lastActual));
  svg.addEventListener("blur", hide);
  svg.addEventListener("keydown", (e) => {
    const from = current >= 0 ? current : lastActual;
    let next = null;
    if (e.key === "ArrowLeft") next = Math.max(0, from - 1);
    else if (e.key === "ArrowRight") next = Math.min(pts.length - 1, from + 1);
    else if (e.key === "Home") next = 0;
    else if (e.key === "End") next = pts.length - 1;
    else if (e.key === "Escape") {
      hide();
      return;
    }
    if (next == null) return;
    e.preventDefault();
    show(next);
  });

  return { show, hide, points: pts };
}

// Projects when total debt hits $0 at the current period's paydown rate.
function projectPayoff(totalNow, result) {
  if (!result || totalNow <= 0) return null;
  const perPeriod = (result.recommendedExtraPayoff || 0) + (result.requiredMinimums || 0);
  if (perPeriod <= 0) return null;

  const periodDays = Math.max(daysBetween(result.todayStr, result.nextPaydayStr), 1);
  const perDay = perPeriod / periodDays;
  if (perDay <= 0) return null;

  const daysToZero = Math.ceil(totalNow / perDay);
  if (!isFinite(daysToZero) || daysToZero > 365 * 15) return null; // don't draw absurd horizons

  const zero = new Date(`${todayLocal()}T00:00:00`);
  zero.setDate(zero.getDate() + daysToZero);
  return { perDay, perPeriod, daysToZero, zeroDate: toLocalISO(zero) };
}

// ---------- category management ----------

// Categories aren't stored in one place: a name can live on a rule's home_label,
// on a transaction's override_label, and in categories.json (transfer flag).
// This gathers every known name with usage counts so the UI can list them.
function collectCategories(rules, transactions, categoryMeta) {
  const map = new Map();
  const touch = (name) => {
    if (!name || name === "Uncategorized") return null;
    if (!map.has(name))
      map.set(name, {
        name,
        ruleCount: 0,
        txCount: 0,
        overrideCount: 0,
        isTransfer: false,
        isScheduled: false,
        monthlyTarget: 0,
        isVariableNecessity: false,
        variableMinAmount: 0
      });
    return map.get(name);
  };

  rules.forEach((r) => {
    const e = touch(r.home_label);
    if (e) e.ruleCount++;
  });
  transactions.forEach((t) => {
    const e = touch(t.resolved_category);
    if (e) e.txCount++;
    if (t.override_label) {
      const o = touch(t.override_label);
      if (o) o.overrideCount++;
    }
  });
  categoryMeta.forEach((c) => {
    const e = touch(c.name);
    if (e) {
      e.isTransfer = !!c.is_transfer;
      e.monthlyTarget = c.monthly_target || 0;
      e.isVariableNecessity = !!c.is_variable_necessity;
      e.variableMinAmount = c.variable_min_amount || 0;
      e.isScheduled = !!c.exclude_from_discretionary;
      e.isNecessaryExpense = !!c.is_necessary_expense;
    }
  });

  return [...map.values()].sort((a, b) => a.name.localeCompare(b.name));
}

// Declares that a category's spending is a scheduled bill rather than living
// spending. This is the class signal for bills the app has no other record of —
// no fixed expense, no debt, no subscription — which is otherwise indistinguishable
// from ordinary spending. It sets the flag the resolver has always read and that,
// until now, nothing could write.
async function setCategoryScheduled(app, name, isScheduled) {
  const cats = await readJSON(app, FILES.categories, []);
  const idx = cats.findIndex((c) => c.name === name);
  if (idx >= 0) {
    if (isScheduled) cats[idx].exclude_from_discretionary = true;
    else delete cats[idx].exclude_from_discretionary;
  } else if (isScheduled) {
    cats.push({ name, is_transfer: false, exclude_from_discretionary: true });
  }
  await writeJSON(app, FILES.categories, cats);
}

async function setCategoryNecessity(app, name, isNecessity, minAmount) {
  const cats = await readJSON(app, FILES.categories, []);
  const idx = cats.findIndex((c) => c.name === name);
  const patch = {};
  if (isNecessity) {
    patch.is_variable_necessity = true;
    patch.variable_min_amount = round2(Number(minAmount) || 0);
  }
  if (idx >= 0) {
    if (isNecessity) Object.assign(cats[idx], patch);
    else {
      delete cats[idx].is_variable_necessity;
      delete cats[idx].variable_min_amount;
    }
  } else if (isNecessity) {
    cats.push(Object.assign({ name, is_transfer: false }, patch));
  }
  await writeJSON(app, FILES.categories, cats);
}

// The one place a category's type is decided from the settings dialog: exactly
// one of these, so a category can't end up both a transfer and a necessity.
// kind: "spending" | "variable_necessity" | "scheduled_bill" | "necessary_expense" | "transfer".
async function setCategoryKind(app, name, kind, minAmount) {
  const cats = await readJSON(app, FILES.categories, []);
  let idx = cats.findIndex((c) => c.name === name);
  if (idx < 0) {
    if (kind === "spending") return;
    cats.push({ name, is_transfer: false });
    idx = cats.length - 1;
  }
  const c = cats[idx];
  c.is_transfer = false;
  delete c.is_variable_necessity;
  delete c.variable_min_amount;
  delete c.exclude_from_discretionary;
  delete c.is_necessary_expense;
  if (kind === "transfer") c.is_transfer = true;
  else if (kind === "variable_necessity") {
    c.is_variable_necessity = true;
    c.variable_min_amount = round2(Number(minAmount) || 0);
  } else if (kind === "scheduled_bill") c.exclude_from_discretionary = true;
  else if (kind === "necessary_expense") c.is_necessary_expense = true;
  await writeJSON(app, FILES.categories, cats);
}

// What a category currently is, strongest setting first, for showing in the dialog.
function categoryKindOf(c) {
  if (!c) return "spending";
  if (c.isTransfer || c.is_transfer) return "transfer";
  if (c.isVariableNecessity || c.is_variable_necessity) return "variable_necessity";
  if (c.isScheduled || c.exclude_from_discretionary) return "scheduled_bill";
  if (c.isNecessaryExpense || c.is_necessary_expense) return "necessary_expense";
  return "spending";
}

async function setCategoryTransfer(app, name, isTransfer) {
  const cats = await readJSON(app, FILES.categories, []);
  const idx = cats.findIndex((c) => c.name === name);
  if (idx >= 0) cats[idx].is_transfer = isTransfer;
  else cats.push({ name, is_transfer: isTransfer });
  await writeJSON(app, FILES.categories, cats);
}

// Renames a category everywhere it appears. If newName already exists the two
// merge, which is intentional — it's how you clean up typo duplicates.
// Moves every record that names a category from one name to another (or off it
// entirely, when `newName` is null and the category is being deleted).
//
// payment_category is the field that tells the resolver "charges for this bill
// or debt land in that category". It is a NAME, so a rename that only touches
// rules and transactions leaves it pointing at a category that no longer exists,
// and the tracker silently stops recognising its own payments — the Phone Co /
// Phone Bill failure, reintroduced by a rename.
async function repointPaymentCategories(app, oldName, newName) {
  let moved = 0;
  for (const file of [FILES.fixedExpenses, FILES.installmentDebts, FILES.revolvingDebts]) {
    const records = await readJSON(app, file, []);
    let changed = false;
    records.forEach((r) => {
      if (r && r.payment_category === oldName) {
        r.payment_category = newName;
        // The learned flag records that the app inferred this from a payment.
        // A deliberate rename or reassignment supersedes that inference, so the
        // flag goes with it rather than claiming the new value was learned.
        if (!newName) delete r.payment_category_learned;
        changed = true;
        moved++;
      }
    });
    if (changed) await writeJSON(app, file, records);
  }
  return moved;
}

async function renameCategory(app, oldName, newName) {
  const rules = await readJSON(app, FILES.rules, []);
  const txs = await readJSON(app, FILES.transactions, []);
  const cats = await readJSON(app, FILES.categories, []);

  let rulesUpdated = 0;
  let overridesUpdated = 0;
  const paymentCategoriesUpdated = await repointPaymentCategories(app, oldName, newName);

  rules.forEach((r) => {
    if (r.home_label === oldName) {
      r.home_label = newName;
      rulesUpdated++;
    }
  });
  txs.forEach((t) => {
    if (t.override_label === oldName) {
      t.override_label = newName;
      overridesUpdated++;
    }
  });

  // Merging discards the source row, so every flag on it has to be carried
  // across or it is silently lost. Each one is a setting the user made
  // deliberately and would have to notice was gone to set again:
  //
  //   is_transfer               — stops the category counting as spending
  //   is_variable_necessity     — puts it in the forecast instead
  //   variable_min_amount       — the floor that forecast uses
  //   exclude_from_discretionary— marks it a scheduled bill
  //   is_necessary_expense      — unavoidable one-off, out of the allowance
  //   monthly_target            — the budget target for it
  //
  // Booleans are OR'd, since a flag set on either side was meant. Values are
  // only taken when the target hasn't got one, so a merge can never overwrite a
  // figure the target already had.
  const sourceIdx = cats.findIndex((c) => c.name === oldName);
  const targetIdx = cats.findIndex((c) => c.name === newName);
  if (sourceIdx >= 0) {
    if (targetIdx >= 0 && targetIdx !== sourceIdx) {
      const from = cats[sourceIdx];
      const into = cats[targetIdx];
      ["is_transfer", "is_variable_necessity", "exclude_from_discretionary", "is_necessary_expense"].forEach((flag) => {
        if (from[flag]) into[flag] = true;
      });
      ["variable_min_amount", "monthly_target"].forEach((field) => {
        if (into[field] == null && from[field] != null) into[field] = from[field];
      });
      cats.splice(sourceIdx, 1);
    } else {
      cats[sourceIdx].name = newName;
    }
  }

  await writeJSON(app, FILES.rules, rules);
  applyCategorization(txs, rules);
  await writeJSON(app, FILES.transactions, txs);
  await writeJSON(app, FILES.categories, cats);
  await carryCategoryOrder(app, oldName, newName);

  return { rulesUpdated, overridesUpdated, paymentCategoriesUpdated };
}

// ---------- category ordering ----------

// Category dropdowns list what you actually use first. The order is a snapshot
// taken when transactions are imported, not recomputed every time a dropdown
// opens: a list that reshuffles each time you relabel something is harder to
// find things in, not easier.
const CATEGORY_USAGE_WINDOW_DAYS = 90;

// Most-used first, by count over the recent window; ties go to all-time count,
// then the name. The window runs back from the newest transaction rather than
// from today, so a vault that hasn't been imported into for a while still ranks
// by what was last in use instead of flattening everything to zero.
function computeCategoryUsageOrder(transactions, { windowDays = CATEGORY_USAGE_WINDOW_DAYS } = {}) {
  const list = transactions || [];
  const latest = list.reduce(
    (m, t) => (t && typeof t.date === "string" && /^\d{4}-\d{2}-\d{2}$/.test(t.date) && t.date > m ? t.date : m),
    ""
  );
  const since = latest ? addDays(latest, -windowDays) : null;
  const recent = new Map();
  const allTime = new Map();
  list.forEach((t) => {
    const c = t && t.resolved_category;
    if (!c || c === "Uncategorized") return;
    allTime.set(c, (allTime.get(c) || 0) + 1);
    if (since && t.date && t.date > since) recent.set(c, (recent.get(c) || 0) + 1);
  });
  return [...allTime.keys()].sort(
    (a, b) =>
      (recent.get(b) || 0) - (recent.get(a) || 0) || allTime.get(b) - allTime.get(a) || a.localeCompare(b)
  );
}

// The snapshot every category dropdown reads. Module-level because the plugin is
// one instance per vault and seven different modals build category lists;
// threading it through each constructor would buy nothing.
let categoryUsageOrder = [];

function setCategoryUsageOrder(order) {
  categoryUsageOrder = Array.isArray(order) ? order.filter((n) => typeof n === "string") : [];
}

// Orders names for a dropdown: ranked names in snapshot order, then anything the
// snapshot hasn't seen (a category created since the last import), alphabetically.
function sortCategoriesByUse(names, order = categoryUsageOrder) {
  const ranked = order || [];
  const rank = new Map(ranked.map((n, i) => [n, i]));
  const unranked = ranked.length;
  return [...new Set((names || []).filter(Boolean))].sort((a, b) => {
    const ra = rank.has(a) ? rank.get(a) : unranked;
    const rb = rank.has(b) ? rank.get(b) : unranked;
    return ra - rb || a.localeCompare(b);
  });
}

async function refreshCategoryUsageOrder(app, transactions = null) {
  const txs = transactions || (await readJSON(app, FILES.transactions, []));
  const order = computeCategoryUsageOrder(txs);
  await writeJSON(app, FILES.categoryOrder, {
    computed_at: todayLocal(),
    window_days: CATEGORY_USAGE_WINDOW_DAYS,
    order
  });
  setCategoryUsageOrder(order);
  return order;
}

async function loadCategoryUsageOrder(app) {
  const saved = await readJSON(app, FILES.categoryOrder, null);
  if (saved && Array.isArray(saved.order)) {
    setCategoryUsageOrder(saved.order);
    return categoryUsageOrder;
  }
  // No import has taken a snapshot yet — first run, or first run after upgrading.
  return refreshCategoryUsageOrder(app);
}

// A rename or delete changes a category's name, not how much it's used, so the
// snapshot follows it rather than waiting for the next import. Renaming onto a
// category that already exists is a merge; the merged one keeps whichever of the
// two positions was higher. `newName` null means deleted with nowhere to go.
async function carryCategoryOrder(app, oldName, newName) {
  const saved = await readJSON(app, FILES.categoryOrder, null);
  if (!saved || !Array.isArray(saved.order)) return;
  const order = saved.order.slice();
  const from = order.indexOf(oldName);
  if (from < 0) return;
  const into = newName ? order.indexOf(newName) : -1;
  if (!newName) {
    order.splice(from, 1);
  } else if (into < 0) {
    order[from] = newName;
  } else {
    order[Math.min(from, into)] = newName;
    order.splice(Math.max(from, into), 1);
  }
  await writeJSON(app, FILES.categoryOrder, Object.assign({}, saved, { order }));
  setCategoryUsageOrder(order);
}

// ---------- pay schedule ----------

// The next payday strictly after fromDateStr, derived from an anchor payday and
// a cadence. Deterministic, so the date half of a pay period never needs typing.
function nextPaydayFrom(schedule, fromDateStr) {
  if (!schedule || !schedule.anchor_date || !schedule.cadence) return null;
  const spec = PAY_CADENCES[schedule.cadence];
  if (!spec) return null;

  const from = new Date(`${fromDateStr}T00:00:00`);
  const cursor = new Date(`${schedule.anchor_date}T00:00:00`);
  if (isNaN(cursor.getTime()) || isNaN(from.getTime())) return null;

  let guard = 0;

  if (spec.days) {
    // Fixed-day cadences are CALENDAR schedules, not elapsed-hour schedules.
    // Convert both local dates to UTC day ordinals before doing the division so
    // crossing a DST boundary cannot make a 14-day interval look like
    // 13 days + 23 hours or 14 days + 1 hour.
    const msPerDay = 86400000;
    const step = spec.days;
    const calendarDay = (d) =>
      Math.floor(Date.UTC(d.getFullYear(), d.getMonth(), d.getDate()) / msPerDay);
    const diffDays = calendarDay(from) - calendarDay(cursor);
    const periods = Math.floor(diffDays / step) + 1;

    cursor.setDate(cursor.getDate() + periods * step);

    // Guarantee strictly-after even if an unusual local-time transition makes
    // Date comparison behave unexpectedly. setDate() advances calendar days.
    while (cursor <= from) cursor.setDate(cursor.getDate() + step);
    return toLocalISO(cursor);
  }

  if (schedule.cadence === "semimonthly") {
    const d = new Date(from);
    for (let i = 0; i < 70; i++) {
      d.setDate(d.getDate() + 1);
      if (d.getDate() === 1 || d.getDate() === 15) return toLocalISO(d);
    }
    return null;
  }

  // monthly: same day-of-month as the anchor
  const day = cursor.getDate();
  const d = new Date(from);
  d.setDate(1);
  for (let i = 0; i < 24; i++) {
    const lastDay = new Date(d.getFullYear(), d.getMonth() + 1, 0).getDate();
    const candidate = new Date(d.getFullYear(), d.getMonth(), Math.min(day, lastDay));
    if (candidate > from) return toLocalISO(candidate);
    d.setMonth(d.getMonth() + 1);
  }
  return null;
}

// The payday on or before a date — i.e. when the current period began.
function currentPeriodStart(schedule, onDateStr) {
  const next = nextPaydayFrom(schedule, onDateStr);
  if (!next) return null;
  const spec = PAY_CADENCES[schedule.cadence];
  if (spec && spec.days) return addDays(next, -spec.days);
  const d = new Date(`${next}T00:00:00`);
  if (schedule.cadence === "semimonthly") {
    d.setDate(d.getDate() - 1);
    for (let i = 0; i < 40; i++) {
      if (d.getDate() === 1 || d.getDate() === 15) return toLocalISO(d);
      d.setDate(d.getDate() - 1);
    }
    return null;
  }
  d.setMonth(d.getMonth() - 1);
  return toLocalISO(d);
}

// Guesses a schedule from paycheck-categorized deposits, so the setting can be
// filled in with one click instead of by hand.
// The schedule to use: the saved setting when it's complete, otherwise one
// inferred from paycheck history. Falling back to detection means goal pacing
// is right even before the setting has been filled in.
function resolvePaySchedule(settings, transactions) {
  const saved = settings && settings.paySchedule;
  if (saved && saved.cadence && saved.anchor_date) return saved;
  const detected = detectPaySchedule(transactions || []);
  if (detected) return { cadence: detected.cadence, anchor_date: detected.anchor_date, inferred: true };
  return null;
}

function detectPaySchedule(transactions) {
  const pays = transactions
    .filter((t) => t.amount > 0 && (t.resolved_category || "") === "Paycheck" && t.date)
    .sort((a, b) => (a.date < b.date ? -1 : 1));
  if (pays.length < 2) return null;

  const gaps = [];
  for (let i = 1; i < pays.length; i++) {
    const g = daysBetween(pays[i - 1].date, pays[i].date);
    if (g > 0) gaps.push(g);
  }
  if (!gaps.length) return null;
  gaps.sort((a, b) => a - b);
  const median = gaps[Math.floor(gaps.length / 2)];

  let cadence = null;
  if (median >= 6 && median <= 8) {
    cadence = "weekly";
  } else if (median >= 13 && median <= 18) {
    // Biweekly and semimonthly overlap on gap length alone, so distinguish them
    // by shape instead: biweekly is always exactly 14 days and drifts across
    // the month, while semimonthly alternates (14 / 16-17) and keeps landing on
    // the same two days of the month.
    const allExactly14 = gaps.every((g) => g === 14);
    const daysOfMonth = new Set(pays.map((p) => Number(p.date.slice(8, 10))));
    if (allExactly14) cadence = "biweekly";
    else if (daysOfMonth.size <= 2) cadence = "semimonthly";
    else cadence = "biweekly";
  } else if (median >= 26 && median <= 34) {
    cadence = "monthly";
  }
  if (!cadence) return null;

  return {
    cadence,
    anchor_date: pays[pays.length - 1].date,
    sampleSize: pays.length,
    medianGap: median
  };
}

// Works out how much cash to hold back for ordinary spending across the rest of
// the pay period, instead of a flat number that's wrong in both directions.
//
// Per discretionary category it picks a daily burn rate:
//   over target      -> assume the habit continues: max(last month, this month)
//   on/under target  -> the target itself
//   no target        -> last month's actual
// then scales by days remaining and adds 15% for the unforeseen.
//
// Returns an object rather than a bare number: the dashboard needs daysLeft and
// the per-category breakdown to explain where the figure came from.
function calculateDynamicBuffer(transactions, categoryMeta, todayStr, nextPaydayStr) {
  const daysLeft = daysBetween(todayStr, nextPaydayStr);
  if (daysLeft <= 0) return { total: 0, daysLeft: 0, detail: [] };

  const monthKey = todayStr.slice(0, 7);
  const thisMonth = transactionsInMonth(transactions, monthKey);

  const names = new Set();
  (categoryMeta || []).forEach((c) => c.name && names.add(c.name));
  (transactions || []).forEach((t) => {
    if (t.resolved_category) names.add(t.resolved_category);
  });

  let totalHoldback = 0;
  const detail = [];

  names.forEach((name) => {
    if (!isDiscretionaryCategory(name, categoryMeta)) return;

    const meta = (categoryMeta || []).find((c) => c.name === name);
    const target = meta && meta.monthly_target > 0 ? meta.monthly_target : null;

    const currentActual = round2(
      thisMonth
        .filter((t) => t.amount < 0 && (t.resolved_category || "") === name)
        .reduce((s, t) => s + Math.abs(t.amount), 0)
    );
    const lastMonthActual = getPriorMonthCategorySpend(transactions, name, monthKey, categoryMeta);

    let daily;
    let basis;
    if (target != null) {
      if (currentActual > target) {
        // The target is already blown, so budgeting to it would under-reserve.
        daily = Math.max(lastMonthActual, currentActual) / 30.4;
        basis = "over target";
      } else {
        daily = target / 30.4;
        basis = "on target";
      }
    } else {
      daily = lastMonthActual / 30.4;
      basis = "no target";
    }

    const hold = daily * daysLeft;
    if (hold > 0) {
      detail.push({
        name,
        basis,
        target,
        currentActual,
        lastMonthActual,
        daily: round2(daily),
        hold: round2(hold)
      });
    }
    totalHoldback += hold;
  });

  detail.sort((a, b) => b.hold - a.hold);
  return { total: round2(totalHoldback * 1.15), daysLeft, detail };
}

// ---------- transaction ownership ----------
//
// One question, one answer: "which financial bucket owns this transaction?"
//
// Before this existed, every subsystem worked that out for itself — the buffer
// classifier rebuilt its own exclusion sets, the necessity projector looked only
// at category flags, and the committed math looked only at payment ledgers. Each
// had a partial view, so the same dollars could be reserved as an obligation AND
// charged to the spending allowance. Adding a feature meant adding another
// chance to disagree.
//
// NOTHING HERE IS PERSISTED. The index is rebuilt from the source trackers on
// every run. A stored owner would be a second copy of a truth that already lives
// in those trackers, and it would go stale the moment a payment is applied, a
// category is retyped, or a transaction is deleted. Deriving it means a
// recategorization simply produces a different answer next time, with no
// migration and nothing to repair.
//
// PRECEDENCE — explicit links always outrank inference:
//
//   1. debt               applied_payments[].tx_id        explicit
//   2. fixed_expense      linked_payments[].tx_id         explicit
//   3. savings            contributions[].linked_tx_id    explicit
//   4. subscription       merchant matches a kept sub     inferred
//   5. transfer           category is_transfer            inferred
//   6. variable_necessity category is_variable_necessity  inferred
//   7. fixed_expense      category name looks scheduled   inferred (legacy)
//   8. discretionary      nothing stronger claimed it     fallback
//
// Tier 7 is the pre-existing NON_DISCRETIONARY_PATTERN heuristic. It is kept so
// 1.5/1.6 behavior is preserved, but it is the weakest signal there is and any
// explicit link supersedes it. It is deliberately not extended — the answer to
// "my category isn't recognized" is to link the payment, not to add a word.
//
// Inflows are not "funded by" anything, so they are typed income and the buffer
// keeps its own per-category refund netting for them.
const OWNER_TYPES = [
  "debt",
  "fixed_expense",
  "savings",
  "subscription",
  "transfer",
  "card_payment",
  "variable_necessity",
  "necessary_expense",
  "income",
  "discretionary"
];

// Buckets that reserve their own money elsewhere in the engine. A transaction
// owned by any of these must never also consume the spending allowance.
const RESERVED_OWNER_TYPES = new Set([
  "debt",
  "fixed_expense",
  "savings",
  "subscription",
  "transfer",
  "variable_necessity",
  "necessary_expense"
]);

// Of those, the ones where an unlinked transaction leaves the user something to
// DO. Listing anything else is what put rows in the match window that could not
// be matched to anything.
//
// Excluded, and why:
//
//   variable_necessity — a gas fill settles itself by pushing its own forecast
//                        forward. There is no "which gas bill was that?"
//   transfer           — money moving between your own accounts isn't paying
//                        anything; it already netted out.
//   subscription       — settles itself the moment the charge posts, which is
//                        why startMatchFlow's only possible answer for one is a
//                        notice saying there is nothing to match. A row whose
//                        button can only say "never mind" is a dead end, and
//                        removing it is the point of this set.
//
// savings is listed for correctness rather than effect. A contribution does need
// an explicit link, and if a savings-class row could ever turn up unlinked this
// is where it would belong — but class "savings" is *produced by* that link
// (it is the only tier that establishes it), so a savings-class row always has
// `settles` set and can never reach this filter. An unlinked transfer to savings
// is transfer-class, and the place that surfaces a contribution still waiting
// for its transaction is the goal's own ledger, which flags it as held back from
// free cash.
const MATCHABLE_OWNER_TYPES = new Set(["debt", "fixed_expense", "savings"]);

function buildOwnershipIndex({
  fixedExpenses = [],
  installmentDebts = [],
  revolvingDebts = [],
  goals = [],
  categoryMeta = [],
  subscriptionKeys = [],
  rules = []
} = {}) {
  // Two independent facts, resolved separately.
  //
  //   class    — what KIND of money this is. A BNPL debit is debt-class money
  //              whether or not the app yet knows which of six plans it paid.
  //   settles  — which exact obligation instance it discharged. Only an explicit
  //              link can establish this.
  //
  // Conflating them was a real bug: requiring an exact settlement before a
  // transaction could count as non-discretionary meant every unlinked debt
  // payment fell through to the spending allowance and was charged as ordinary
  // living spending. Class governs the allowance; settlement governs whether a
  // reserve in committed can be released.
  const settlements = new Map();
  const settle = (txId, type, ref, label) => {
    if (!txId || settlements.has(txId)) return;
    settlements.set(txId, { type, ref, label });
  };

  []
    .concat(installmentDebts || [], revolvingDebts || [])
    .forEach((d) => (d.applied_payments || []).forEach((p) => settle(p && p.tx_id, "debt", debtKey(d), debtLabel(d))));
  (fixedExpenses || []).forEach((f) =>
    (f.linked_payments || []).forEach((p) => settle(p && p.tx_id, "fixed_expense", f.id || f.name, f.name))
  );
  (goals || []).forEach((g) =>
    (g.contributions || []).forEach((c) => settle(c && c.linked_tx_id, "savings", g.id, g.name))
  );

  const subKeys = new Set(subscriptionKeys || []);
  const metaByName = new Map((categoryMeta || []).filter((c) => c && c.name).map((c) => [c.name, c]));
  const allDebts = [].concat(installmentDebts || [], revolvingDebts || []);

  // Categories the DEBTS THEMSELVES declare as where their payments land. Every
  // debt carries payment_category, set when it was created, so this is the
  // user's own configuration rather than a list of names baked into the code.
  const debtClassCategories = new Map();
  allDebts.forEach((d) => {
    if (d && d.payment_category) debtClassCategories.set(d.payment_category, debtLabel(d));
  });

  // Where a fixed expense's charges land. payment_category is the declared
  // answer, mirroring debts; the expense NAME is a fallback for expenses that
  // predate the field or were never told. The fallback only works when the two
  // happen to be named alike — "Phone bill" against "Phone Bill" — which is a
  // coincidence, not a design, and is exactly why the declared field exists:
  // an expense called "Phone Co" whose charges are categorized "Phone Bill"
  // has no name match at all.
  const norm = (v) => String(v || "").toLowerCase().replace(/[^a-z0-9]/g, "");
  const fixedClassCategories = new Map();
  (fixedExpenses || []).forEach((f) => {
    if (!f) return;
    if (f.name) fixedClassCategories.set(norm(f.name), f.name);
  });
  // Declared second so it wins on collision.
  (fixedExpenses || []).forEach((f) => {
    if (f && f.payment_category) fixedClassCategories.set(norm(f.payment_category), f.name || f.payment_category);
  });

  // Categories a tracker already SCHEDULES payments in — debts and fixed
  // expenses that have declared where their charges land, plus the expense-name
  // fallback. This is deliberately narrower than debtPaymentCategories, which
  // also sweeps in "Uncategorized" and every transfer category because it
  // answers a different question ("could this row be a payment?" rather than
  // "does something already schedule this category?").
  const scheduledCategories = new Set();
  allDebts.forEach((d) => {
    if (d && d.payment_category) scheduledCategories.add(d.payment_category);
  });
  (fixedExpenses || []).forEach((f) => {
    if (!f) return;
    if (f.payment_category) scheduledCategories.add(f.payment_category);
    if (f.name) scheduledCategories.add(f.name);
  });

  function ownerOf(tx) {
    if (!tx) return null;
    const category = tx.resolved_category || "Uncategorized";
    const base = { category, settles: null, explicit: false };

    // 1. Explicit link — establishes class AND settlement together.
    const hit = tx.id ? settlements.get(tx.id) : null;
    if (hit) {
      return Object.assign({}, base, {
        class: hit.type,
        settles: hit,
        explicit: true,
        label: hit.label,
        ref: hit.ref,
        basis: "linked transaction"
      });
    }

    if (Number.isFinite(tx.amount) && tx.amount > 0) {
      return Object.assign({}, base, { class: "income", label: category, ref: null, basis: "money in" });
    }

    // 2. Class without settlement. Each tier says what KIND of money this is
    //    while leaving the exact obligation unknown, so the allowance can exclude
    //    it while committed keeps reserving until a link is made.
    //
    //    PRECEDENCE IS THE WHOLE POINT HERE, so the tiers are a list rather than
    //    a run of `if`s whose order looks incidental and can be rearranged by
    //    accident. A category can satisfy more than one test at once and the
    //    winner has to be decided, not discovered:
    //
    //      "Credit Card Payment" is the card's payment_category AND is flagged
    //      as a transfer. Transfer used to be checked first, so a card payment
    //      resolved as transfer-class money. Both classes are excluded from the
    //      allowance, so the number stayed right and the bug stayed invisible —
    //      but a transfer names no obligation, so the payment could never be
    //      offered for matching and could never pair with the card's minimum.
    //      The card simply never saw its own payments.
    //
    //    Declared intent beats inferred intent: a category a debt or a bill
    //    NAMES as where its payments land is that thing, whatever else it also
    //    happens to be flagged as. Only once nothing has claimed the category do
    //    the softer signals get a turn.
    const meta = metaByName.get(category) || null;
    const subKey = subKeys.size ? subscriptionGroupKey(tx.merchant_raw, rules) : null;

    const TIERS = [
      // Declared by a tracker: "payments for this land in that category."
      {
        when: () => debtClassCategories.has(category),
        owner: () => ({ class: "debt", label: category, ref: null, basis: "category a tracked debt takes payments in" })
      },
      {
        when: () => fixedClassCategories.has(norm(category)),
        owner: () => ({
          class: "fixed_expense",
          label: fixedClassCategories.get(norm(category)),
          ref: null,
          basis: "category matches a tracked fixed expense"
        })
      },
      // Savings has no category-based tier on purpose. A goal never declares a
      // category, so the only thing that can say a transaction is a savings
      // contribution is an explicit link — which is tier 1 above. Inventing a
      // "Savings" name convention here would make the resolver guess.

      // Inferred from behaviour: recurring charges the audit is already tracking.
      {
        when: () => !!subKey && subKeys.has(subKey),
        owner: () => ({ class: "subscription", label: subKey, ref: subKey, basis: "matches a kept subscription" })
      },
      // Flags the user set on the category itself.
      {
        when: () => !!(meta && meta.is_transfer),
        owner: () => ({ class: "transfer", label: category, ref: category, basis: "transfer category" })
      },
      {
        when: () => !!(meta && meta.is_variable_necessity),
        owner: () => ({ class: "variable_necessity", label: category, ref: category, basis: "variable necessity category" })
      },
      {
        when: () => !!(meta && meta.exclude_from_discretionary),
        owner: () => ({ class: "fixed_expense", label: category, ref: null, basis: "category marked as a scheduled bill" })
      },
      {
        when: () => !!(meta && meta.is_necessary_expense),
        owner: () => ({ class: "necessary_expense", label: category, ref: null, basis: "category marked as a necessary expense" })
      },
      // Weakest of all: the category is merely NAMED like a bill.
      {
        when: () => category !== "Uncategorized" && NON_DISCRETIONARY_PATTERN.test(category),
        owner: () => ({ class: "fixed_expense", label: category, ref: null, basis: "category name looks like a scheduled bill" })
      }
    ];

    for (const tier of TIERS) {
      if (tier.when()) return Object.assign({}, base, tier.owner());
    }

    return Object.assign({}, base, {
      class: "discretionary", label: category, ref: null, basis: "nothing stronger claimed it"
    });
  }

  return {
    ownerOf,
    // What kind of money this is — what the allowance asks.
    classOf: (tx) => {
      const o = ownerOf(tx);
      return o ? o.class : null;
    },
    typeOf: (tx) => {
      const o = ownerOf(tx);
      return o ? o.class : null;
    },
    // Which exact obligation it discharged — what a reserve release asks.
    settlementOf: (tx) => {
      const o = ownerOf(tx);
      return o ? o.settles : null;
    },
    // Does another bucket fund this, whether or not we know which instance?
    isReserved: (tx) => {
      const o = ownerOf(tx);
      return !!(o && RESERVED_OWNER_TYPES.has(o.class));
    },
    // "Is this category already on a schedule somewhere?" — asked by the
    // necessity forecaster, which must not predict what a tracker already knows.
    isScheduledCategory: (name) => {
      if (!name) return false;
      if (scheduledCategories.has(name)) return true;
      const n = norm(name);
      return [...scheduledCategories].some((c) => norm(c) === n);
    },
    settlementCount: settlements.size,
    scheduledCategories
  };
}

// Everything this paycheck is responsible for, gathered from whichever tracker
// owns it. This is a VIEW, not a store: the debt tracker still owns schedules
// and balances, the subscription tracker still owns recurrence, the fixed
// expense tracker still owns ordinary bills. Nothing is copied into
// fixed_expenses.json, so there is still exactly one authoritative record of
// each obligation and no second copy to drift.
function buildPeriodObligations({
  periodFixed = [],
  periodFixedPaid = [],
  dueInstallments = [],
  dueRevolvingMins = [],
  upcomingSubs = [],
  todayStr = null,
  nextPaydayStr = null
}) {
  const out = [];

  const pushFixed = (f, settled) =>
    out.push({
      source: "fixed_expense",
      ref: f.id || f.name,
      label: f.name,
      amount: round2(f.amount || 0),
      paid: settled ? round2(f.amount || 0) : 0,
      remaining: settled ? 0 : round2(f.amount || 0),
      dueDate: (todayStr && nextPaydayStr && fixedExpenseDueInRange(f, todayStr, nextPaydayStr)) || null,
      settled: !!settled
    });
  periodFixed.forEach((f) => pushFixed(f, false));
  periodFixedPaid.forEach((f) => pushFixed(f, true));

  const pushDebt = (d, dueDate) =>
    out.push({
      source: "debt",
      ref: debtKey(d),
      label: debtLabel(d),
      amount: round2(d._due || 0),
      paid: round2(d._paidThisPeriod || 0),
      remaining: round2(d._remaining || 0),
      dueDate: dueDate || null,
      settled: !!d._settled
    });
  dueInstallments.forEach((d) => pushDebt(d, d.next_due_date));
  dueRevolvingMins.forEach((d) => pushDebt(d, d.due_date));

  upcomingSubs.forEach((s) =>
    out.push({
      source: "subscription",
      ref: s.key,
      label: s.key,
      amount: round2(s.amount || 0),
      paid: 0,
      remaining: round2(s.amount || 0),
      dueDate: s.dueDate || null,
      settled: false
    })
  );

  return out.sort((a, b) => {
    const da = a.dueDate || "9999-12-31";
    const db = b.dueDate || "9999-12-31";
    return da < db ? -1 : da > db ? 1 : 0;
  });
}

// Which single bucket absorbed each outgoing transaction this period.
// Exists so the question "where did this money go?" has one checkable answer
// rather than being reconstructed differently by whoever is asking.
// Moving cash between your own accounts, or into a savings goal, is net-neutral,
// so those rows are left out. A card payment is the exception: cash did leave, so it is listed and
// counted, as its own "card_payment" line (shown apart, since it pays off
// spending already made on the card). cardPaymentCategories names those.
function summarizeOwnership(transactions, periodStartStr, nextPaydayStr, ownership, cardPaymentCategories = null) {
  const byType = {};
  let total = 0;
  let count = 0;
  if (!ownership || !periodStartStr || !nextPaydayStr) return { byType: [], total: 0, count: 0 };

  (transactions || []).forEach((t) => {
    if (!t || !t.date || !(t.amount < 0)) return;
    if (t.date < periodStartStr || t.date >= nextPaydayStr) return;
    const amount = round2(Math.abs(t.amount));
    if (amount <= 0) return;
    const owner = ownership.ownerOf(t);
    let type = owner ? owner.class : "discretionary";
    // Money moved to a savings goal is the same money in another place.
    if (type === "savings") return;
    if (type === "transfer") {
      const isCard = cardPaymentCategories && cardPaymentCategories.has(t.override_label || t.resolved_category);
      if (!isCard) return;
      type = "card_payment";
    }
    if (!byType[type]) byType[type] = { type, amount: 0, count: 0, explicit: 0 };
    byType[type].amount = round2(byType[type].amount + amount);
    byType[type].count++;
    if (owner && owner.settles) byType[type].explicit++;
    total = round2(total + amount);
    count++;
  });

  return {
    byType: OWNER_TYPES.filter((t) => byType[t]).map((t) => byType[t]),
    total,
    count
  };
}

// Obligations still reserved while a transaction that looks like it settled them
// sits unowned. This is the gap that quietly double-counts: the reserve stays in
// committed because no link exists, and the same money also draws down the
// allowance because nothing claimed the transaction.
//
// It deliberately REPORTS rather than auto-applies. Matching on amount alone is
// how a $50 dinner once stood in for a $50 insurance bill; the user confirms
// which transaction it was, and the existing Apply Payment / Mark Paid flows
// record it. Each obligation offers at most one candidate and each transaction
// is offered once, so a repeated amount can't produce a cascade of false pairs.
function findUnreconciledObligations({ periodObligations = [], unsettled = [] }) {
  const open = periodObligations.filter((o) => !o.settled && o.remaining > 0.005);
  if (!open.length || !unsettled.length) return { pairs: [], total: 0, needsMatching: [], openByClass: {} };

  // Matching exists to RELEASE A RESERVE. If nothing of this transaction's kind
  // is still being held back this period, linking it moves no money and there is
  // nothing to ask about — the allowance already excluded it on class alone.
  // Prompting anyway is what made the review bar feel like noise.
  const openByClass = {};
  open.forEach((o) => {
    openByClass[o.source] = round2((openByClass[o.source] || 0) + o.remaining);
  });
  const needsMatching = unsettled.filter((t) => (openByClass[t.class] || 0) > 0.005);

  // Candidates are transactions already known to be the RIGHT KIND of money but
  // not yet tied to an instance. Pairing within a class is what makes this safe:
  // a restaurant bill is discretionary-class and can never be offered for a
  // fixed-expense obligation, which is exactly how a $50 dinner once stood in
  // for a $50 insurance bill.
  const available = needsMatching.slice().sort((a, b) => (a.date < b.date ? -1 : 1));
  const taken = new Set();
  const pairs = [];

  open.forEach((o) => {
    const hit = available.find(
      (t) => !taken.has(t.id) && t.class === o.source && Math.abs(t.amount - o.remaining) < 0.005
    );
    if (!hit) return;
    taken.add(hit.id);
    pairs.push({ obligation: o, candidate: hit });
  });

  return {
    pairs,
    total: round2(pairs.reduce((s, p) => s + p.candidate.amount, 0)),
    needsMatching,
    openByClass
  };
}

// ---------- pay-period buffer spend-down ----------

// Outgoing transactions that could be the real payment behind a fixed expense.
// Mirrors the debt-payment candidate list: a window around the due date, with
// the closest amounts first, and anything another bucket has already claimed
// filtered out. The user picks; nothing is inferred from the amount alone.
function fixedExpenseCandidates(expense, transactions, fixedExpenses, goals, installmentDebts, revolvingDebts, dueDateStr, ownership = null, context = {}) {
  if (!expense || !dueDateStr) return [];
  const index =
    ownership ||
    completeOwnership(Object.assign({ fixedExpenses, goals, installmentDebts, revolvingDebts }, context));
  return findCandidateTransactions({
    transactions,
    ownership: index,
    near: dueDateStr,
    windowDays: 12,
    targetAmount: expense.amount || 0,
    forClass: "fixed_expense",
    rank: "amount",
    limit: 40
  });
}

// The buffer is an allowance for the pay period, not a wall of money that stays
// reserved no matter what happens. Once ordinary spending actually occurs it has
// left the account, so continuing to hold the full original figure would charge
// the same dollars twice — once as a lower bank balance, once as a reservation.
//
// The governing rule is: every outgoing transaction settles the bucket that
// funded it. The engine already settles most buckets by itself:
//
//   fixed expense marked paid   -> drops out of periodFixed
//   subscription already billed -> dropped by upcomingSubscriptions
//   debt payment applied        -> netted by paidForCycle
//   variable necessity bought   -> pushes its own projection forward
//   savings transfer linked     -> stops being earmarked
//
// So the only job here is to decide what is LEFT — ordinary living spending —
// and let that consume the allowance. Anything a committed bucket has already
// settled must be excluded, or the same transaction is counted twice.
//
// Everything is derived from the transaction list on every run. Nothing is
// incremented or stored, so edits, refunds, recategorizations and deletions
// simply produce a different answer next time rather than corrupting a counter.
function classifyBufferSpending({
  transactions = [],
  periodStartStr,
  nextPaydayStr,
  categoryMeta = [],
  fixedExpenses = [],
  installmentDebts = [],
  revolvingDebts = [],
  subscriptionKeys = [],
  rules = [],
  goals = [],
  ownership = null,
  // Accounts whose ordinary spending isn't this period's (capped funds). Their
  // bill and debt payments are still sorted and matched below.
  outsideAllowance = null
}) {
  const empty = { spent: 0, byCategory: [], settled: {}, considered: 0, unowned: [], unsettled: [] };
  const outside = outsideAllowance instanceof Set ? outsideAllowance : new Set(outsideAllowance || []);
  if (!periodStartStr || !nextPaydayStr) return empty;

  // The classifier no longer works out what a transaction means. It asks.
  // Rebuilding exclusion logic here is exactly how the buffer and the committed
  // math came to disagree about the same dollars.
  const index =
    ownership ||
    buildOwnershipIndex({
      fixedExpenses,
      installmentDebts,
      revolvingDebts,
      goals,
      categoryMeta,
      subscriptionKeys,
      rules
    });

  // Same window the rest of the period math uses: inclusive of payday, exclusive
  // of the next one, so a transaction belongs to exactly one period.
  const inWindow = (t) => t && t.date && t.date >= periodStartStr && t.date < nextPaydayStr;

  const settled = {};
  const debits = new Map();
  const credits = new Map();
  const unowned = [];
  // Class says another bucket funds it, but no link says which obligation it
  // discharged. These are what the reconciliation check pairs against open
  // obligations — a far stronger signal than trawling ordinary spending for a
  // matching amount.
  const unsettled = [];
  let considered = 0;

  const period = (transactions || [])
    .filter(inWindow)
    .slice()
    .sort((a, b) => (a.date < b.date ? -1 : a.date > b.date ? 1 : 0));

  period.forEach((t) => {
    if (!(t.amount < 0)) return;
    const amount = round2(Math.abs(t.amount));
    if (amount <= 0) return;
    considered++;

    const owner = index.ownerOf(t);
    // The allowance asks about CLASS, not settlement. A debt payment is debt
    // money whether or not the app yet knows which plan it paid, so it must not
    // be charged as ordinary living spending just because it is unlinked.
    if (owner && RESERVED_OWNER_TYPES.has(owner.class)) {
      settled[owner.class] = round2((settled[owner.class] || 0) + amount);
      // Only classes that own a named obligation can be matched to one. A gas
      // fill or an account transfer is reserved money with nothing to point at,
      // so listing it asks the user to do something impossible.
      if (!owner.settles && MATCHABLE_OWNER_TYPES.has(owner.class)) {
        unsettled.push({
          id: t.id, date: t.date, amount,
          category: t.resolved_category || "Uncategorized",
          merchant_raw: t.merchant_raw,
          class: owner.class,
          basis: owner.basis
        });
      }
      return;
    }
    if (outside.has(t.account_id)) return;

    const category = t.resolved_category || "Uncategorized";
    unowned.push({ id: t.id, date: t.date, amount, category, merchant_raw: t.merchant_raw });
    debits.set(category, round2((debits.get(category) || 0) + amount));
  });

  // Refunds and reversals give the allowance back. They are netted per category
  // and can never push a category below zero.
  //
  // Ownership is not consulted for inflows: money coming in isn't "funded by" a
  // bucket. The rule is narrower instead — an unlabeled DEBIT is ordinary
  // spending, but an unlabeled CREDIT is almost never a refund. It's a payroll
  // deposit, a reimbursement, or money moved in. Guessing wrong on a credit
  // hands back allowance that was never recovered, which is the worse failure.
  period.forEach((t) => {
    if (!(t.amount > 0)) return;
    if (outside.has(t.account_id)) return;
    const owner = index.ownerOf(t);
    if (owner && owner.explicit) return;
    const category = t.resolved_category || "Uncategorized";
    if (category === "Uncategorized") return;
    if (!debits.has(category)) return;
    credits.set(category, round2((credits.get(category) || 0) + round2(t.amount)));
  });

  const byCategory = [];
  let spent = 0;
  debits.forEach((gross, category) => {
    const refunded = credits.get(category) || 0;
    const net = round2(Math.max(0, gross - refunded));
    if (net > 0) byCategory.push({ category, gross, refunded, net });
    spent = round2(spent + net);
  });
  byCategory.sort((a, b) => b.net - a.net);

  return { spent: round2(spent), byCategory, settled, considered, unowned, unsettled };
}

// The spending allowance for a pay period, captured once at its start.
//
// Auto mode's figure is derived partly from the CURRENT month's actual spend, so
// re-deriving it mid-period returns a different number than the one the user was
// shown — and the period stops reconciling. Persisting it keeps the allowance
// stable, which is what makes "you spent $227 of your $350" a true statement.
function captureBufferAllocation({
  transactions = [],
  categoryMeta = [],
  periodStartStr,
  nextPaydayStr,
  bufferMode = "auto",
  manualBuffer = 100
}) {
  const mode = bufferMode === "manual" ? "manual" : "auto";
  if (mode === "manual") {
    const amount = round2(manualBuffer || 0);
    return {
      amount,
      mode,
      manualBuffer: amount,
      capturedAt: todayLocal(),
      capturedFor: periodStartStr || null,
      detail: [],
      daysLeft: daysBetween(periodStartStr, nextPaydayStr)
    };
  }
  const calc = calculateDynamicBuffer(transactions, categoryMeta, periodStartStr, nextPaydayStr);
  return {
    amount: calc.total,
    mode,
    capturedAt: todayLocal(),
    capturedFor: periodStartStr || null,
    detail: calc.detail,
    daysLeft: calc.daysLeft
  };
}

// Whether the stored snapshot has to be retaken. Only a deliberate change counts
// — switching buffer mode, editing the manual amount, or starting a new period.
// Passive recalculation never retakes it, because that is exactly the retroactive
// rewriting of history this snapshot exists to prevent.
function bufferAllocationStale(snapshot, bufferMode, manualBuffer, periodStartStr) {
  if (!snapshot || typeof snapshot.amount !== "number" || !isFinite(snapshot.amount)) return true;
  const mode = bufferMode === "manual" ? "manual" : "auto";
  if (snapshot.mode !== mode) return true;
  if (mode === "manual" && round2(snapshot.manualBuffer ?? snapshot.amount) !== round2(manualBuffer || 0)) {
    return true;
  }
  if (periodStartStr && snapshot.capturedFor && snapshot.capturedFor !== periodStartStr) return true;
  return false;
}

// ---------- allocation algorithm ----------

function inPeriod(dateStr, todayStr, nextPaydayStr) {
  return dateStr >= todayStr && dateStr < nextPaydayStr;
}

function runAllocation({ cashOnHand, todayStr, nextPaydayStr, fixedExpenses, installmentDebts, revolvingDebts, upcomingSubs = [], earmarked = 0, savingsMode = false, goals = [], paychecksFor = {}, transactions = [], categoryMeta = [], bufferMode = "auto", manualBuffer = 100, currentDateStr = null, savingsDeadline = null, bufferAllocation = null, subscriptionKeys = [], rules = [], accounts = [] }) {
  // todayStr is the FIXED pay-period start, so obligations that came due earlier
  // in the period stay visible. The discretionary buffer is a forward-looking
  // reserve and must count from the actual current date instead.
  const currentDate = currentDateStr || todayStr;
  // Spending out of a capped fund's own account is the fund's business, not
  // this period's: the allowance's sizing reads these rows, and its charging
  // leaves those accounts out (outsideAllowance below).
  const budgetTx = withoutFundAccountRows(transactions, goals);
  // What has already been moved into each fund this period, so its ask holds
  // still once it's been followed.
  const fundMoves = fundMovesThisPeriod(transactions, goals, accounts, todayStr, nextPaydayStr);
  const fundOpts = { moves: fundMoves, todayStr: currentDate };
  // And into each savings goal, so a goal that's had its pace stops asking.
  const goalMoves = goalMovesThisPeriod(goals, todayStr, nextPaydayStr);

  // One index, built once, consulted by every subsystem below. This is what
  // stops the buffer, the necessity projector and the committed math forming
  // three different opinions about the same transaction.
  const ownership = buildOwnershipIndex({
    fixedExpenses,
    installmentDebts,
    revolvingDebts,
    goals,
    categoryMeta,
    subscriptionKeys,
    rules
  });

  const dueThisPeriod = fixedExpenses.filter((f) => fixedExpenseDueInRange(f, todayStr, nextPaydayStr));
  const isPaid = (f) => {
    // Rolling expenses advance their own next_due_date when paid, so being
    // still due here already means unpaid.
    if (isRollingExpense(f)) return false;
    const dueInstance = fixedExpenseDueInRange(f, todayStr, nextPaydayStr);
    return !!(f.last_paid_date && dueInstance && f.last_paid_date >= dueInstance);
  };
  // Paid items are surfaced separately so the UI can show them (with an undo)
  // rather than having them silently vanish from the list.
  const periodFixedPaid = dueThisPeriod.filter(isPaid);
  const periodFixed = dueThisPeriod.filter((f) => !isPaid(f));
  const periodFixedTotal = periodFixed.reduce((sum, f) => sum + f.amount, 0);

  // A payment already applied inside this period has left the account, so the
  // balance the user entered already reflects it. Charging the full minimum on
  // top would subtract the same money twice. Credit is partial, not binary:
  // paying $20 of a $62.50 installment leaves $42.50 still owed this period.
  // Credit is scoped to the debt's BILLING CYCLE, not the pay period. A payment
  // made before the period started still covers the installment it was for —
  // paying early shouldn't make the credit invisible and charge the minimum
  // again. The cycle runs from the previous due date up to this one.
  const cycleStart = (dueDateStr, frequency) => {
    if (!dueDateStr) return null;
    if (frequency === "weekly") return addDays(dueDateStr, -7);
    if (frequency === "biweekly") return addDays(dueDateStr, -14);
    const d = new Date(`${dueDateStr}T00:00:00`);
    if (isNaN(d.getTime())) return null;
    d.setMonth(d.getMonth() - 1);
    return toLocalISO(d);
  };

  const paidForCycle = (d, dueDateStr, frequency) => {
    const from = cycleStart(dueDateStr, frequency);
    return round2(
      (d.applied_payments || [])
        // A payment with no date is one deliberately applied to this debt —
        // pending bank holds carry no posting date. Ignoring it silently
        // charges the minimum a second time, so count it for the current cycle.
        .filter((p) => !p.date || !from || p.date > from)
        .reduce((s, p) => s + Math.abs(p.amount || 0), 0)
    );
  };

  const annotate = (d, due, dueDateStr, frequency) => {
    const paid = paidForCycle(d, dueDateStr, frequency);
    const remaining = Math.max(0, round2(due - paid));
    return Object.assign(Object.create(Object.getPrototypeOf(d) || Object.prototype), d, {
      _due: round2(due),
      _paidThisPeriod: paid,
      _remaining: remaining,
      _settled: paid > 0 && remaining <= 0.005
    });
  };

  const dueInstallments = installmentDebts
    .filter((d) => !isLoan(d) && inPeriod(d.next_due_date, todayStr, nextPaydayStr))
    .map((d) => annotate(d, d.installment_amount || 0, d.next_due_date, d.frequency));
  // Loans answer from their own schedule: which installments fall in this
  // period, and whether each is paid.
  const loanReserved = new Map();
  installmentDebts.filter(isLoan).forEach((d) => {
    loanPeriodDues(d, todayStr, nextPaydayStr, currentDate).forEach((row) => {
      dueInstallments.push(
        Object.assign(Object.create(Object.getPrototypeOf(d) || Object.prototype), d, {
          next_due_date: row.due,
          _due: row.amount,
          _paidThisPeriod: row.paid,
          _remaining: row.remaining,
          _settled: row.settled,
          _overdue: row.overdue
        })
      );
      loanReserved.set(debtKey(d), round2((loanReserved.get(debtKey(d)) || 0) + row.remaining));
    });
  });

  const dueRevolvingMins = revolvingDebts
    .filter((d) => inPeriod(d.due_date, todayStr, nextPaydayStr))
    .map((d) => annotate(d, d.min_payment_due || 0, d.due_date, "monthly"));

  const minimumsPaid = round2(
    dueInstallments.reduce((s, d) => s + d._paidThisPeriod, 0) +
      dueRevolvingMins.reduce((s, d) => s + d._paidThisPeriod, 0)
  );

  const requiredMinimums = round2(
    dueInstallments.reduce((s, d) => s + d._remaining, 0) +
      dueRevolvingMins.reduce((s, d) => s + d._remaining, 0)
  );

  // Subscriptions you've chosen to keep that will actually bill before the next
  // paycheck are real obligations, not background noise.
  const periodSubsTotal = round2(upcomingSubs.reduce((s, x) => s + x.amount, 0));

  // Unavoidable but irregular spending still ahead of us this period. It joins
  // committed obligations rather than the discretionary buffer, so it reduces
  // what Savings Mode recommends before it ever touches spending money.
  const variableNecessities = calculateVariableNecessities(
    budgetTx,
    categoryMeta,
    currentDate,
    nextPaydayStr,
    ownership
  );
  const variableNecessitiesTotal = variableNecessities.totalReserve;

  // The umbrella view: everything this paycheck answers for, whichever tracker
  // it came from. Built from the same annotated records the totals above use, so
  // the list and the arithmetic cannot disagree.
  const periodObligations = buildPeriodObligations({
    periodFixed,
    periodFixedPaid,
    dueInstallments,
    dueRevolvingMins,
    upcomingSubs,
    todayStr,
    nextPaydayStr
  });

  const committed =
    periodFixedTotal + requiredMinimums + periodSubsTotal + round2(earmarked) + variableNecessitiesTotal;

  const bufferCalc = calculateDynamicBuffer(budgetTx, categoryMeta, currentDate, nextPaydayStr);

  // This period's spending allowance. The snapshot is authoritative; the live
  // figure is only a fallback for a period that predates snapshotting, or for a
  // caller that doesn't keep period state (the launcher block, tests).
  const allocatedBuffer =
    bufferAllocation && typeof bufferAllocation.amount === "number" && isFinite(bufferAllocation.amount)
      ? round2(bufferAllocation.amount)
      : bufferMode === "auto"
        ? bufferCalc.total
        : round2(manualBuffer || 0);

  const bufferSpending = classifyBufferSpending({
    transactions,
    outsideAllowance: fundAccountIds(goals),
    periodStartStr: todayStr,
    nextPaydayStr,
    ownership
  });
  const bufferSpent = bufferSpending.spent;
  const bufferRemaining = round2(Math.max(0, allocatedBuffer - bufferSpent));
  const bufferOverrun = round2(Math.max(0, bufferSpent - allocatedBuffer));

  // Only the UNSPENT part of the allowance still needs holding back. The spent
  // part already left the account, so reserving it again would deduct the same
  // money twice and wrongly shrink savings capacity just because planned
  // spending happened. Overrun needs no separate deduction for the same reason:
  // cash on hand has already fallen by it, so it reduces what's available on
  // its own.
  const effectiveBuffer = bufferRemaining;

  const availableForDebt = cashOnHand - committed - effectiveBuffer;

  const payoffBreakdown = [];
  // Savings Mode short-circuits the whole priority ladder. Minimums were
  // already counted above; what changes is that nothing extra is recommended,
  // so the surplus stays liquid instead of going to principal.
  let remaining = savingsMode ? 0 : Math.max(availableForDebt, 0);

  // priority: deferred-interest BNPL closest to deadline, then revolving by APR desc, then other installments
  const deferredRisk = installmentDebts
    .filter((d) => !isLoan(d) && d.deferred_interest_risk && d.deferred_interest_risk.applies)
    .sort((a, b) => new Date(a.deferred_interest_risk.payoff_deadline) - new Date(b.deferred_interest_risk.payoff_deadline));

  for (const d of deferredRisk) {
    if (remaining <= 0) break;
    // debtBalance() is authoritative: the stored installment count / balance
    // can lag behind applied payments, which would recommend paying more than
    // is actually owed.
    const chunk = Math.min(remaining, debtBalance(d));
    if (chunk > 0) {
      payoffBreakdown.push({ target: debtLabel(d), amount: round2(chunk), reason: "deferred-interest deadline approaching" });
      remaining -= chunk;
    }
  }

  // Capped funds refill before extra principal, and after deferred-interest
  // cliffs. A cliff is a dated, retroactive charge — the one thing worth
  // clearing even ahead of a cushion — while an emergency buffer is what stops
  // the next surprise landing on a card at its APR. The share is weighted by
  // how empty the fund is, so a nearly full fund leaves nearly everything to
  // the ladder below. In Savings Focus the funds come after goals instead,
  // inside recommendSavings.
  const debtModeFunds = savingsMode ? null : allocateToFunds(goals, remaining, accounts, fundOpts);
  if (debtModeFunds) remaining -= debtModeFunds.total;

  // Cards and loans that take extra, highest rate first: a 29.99% card before
  // a 7% car loan. A mortgage sits out unless it's been told otherwise.
  const revolvingByAPR = [...revolvingDebts, ...installmentDebts.filter((d) => isLoan(d) && loanTakesExtra(d) && Number(d.apr) > 0)].sort(
    (a, b) => (Number(b.apr) || 0) - (Number(a.apr) || 0)
  );
  for (const d of revolvingByAPR) {
    if (remaining <= 0) break;
    // Live balance: a card that has been charged since its anchor owes more than
    // the anchor says, and recommending against the stale figure under-pays it.
    // A loan's payment already set aside this period isn't asked for again.
    const owed = isLoan(d) ? Math.max(0, round2(debtBalance(d) - (loanReserved.get(debtKey(d)) || 0))) : debtBalance(d, transactions);
    const chunk = Math.min(remaining, owed);
    if (chunk > 0) {
      payoffBreakdown.push({ target: debtLabel(d), amount: round2(chunk), reason: `highest APR (${d.apr}%)` });
      remaining -= chunk;
    }
  }

  const otherInstallments = installmentDebts.filter((d) => !isLoan(d) && !deferredRisk.includes(d));
  for (const d of otherInstallments) {
    if (remaining <= 0) break;
    const chunk = Math.min(remaining, debtBalance(d));
    if (chunk > 0) {
      payoffBreakdown.push({ target: debtLabel(d), amount: round2(chunk), reason: "0% installment payoff" });
      remaining -= chunk;
    }
  }

  const recommendedExtraPayoff = savingsMode ? 0 : payoffBreakdown.reduce((s, p) => s + p.amount, 0);

  // In Savings Mode the same surplus that would have gone to principal is
  // distributed across goals instead. In Debt Reduction the only savings are
  // capped funds, already carved out above.
  const savingsPlan = savingsMode
    ? recommendSavings(goals, Math.max(availableForDebt, 0), paychecksFor, currentDate, savingsDeadline, accounts, fundOpts, goalMoves)
    : debtModeFunds;
  const recommendedSavings = savingsPlan.total;

  // The buffer is money reserved for ordinary spending over the days remaining,
  // so free cash is what's left beyond that — not everything unspent.
  const freeCash = cashOnHand - committed - recommendedExtraPayoff - recommendedSavings - effectiveBuffer;

  return {
    periodFixed,
    periodFixedPaid,
    periodFixedTotal,
    requiredMinimums,
    dueInstallments,
    dueRevolvingMins,
    availableForDebt,
    payoffBreakdown,
    recommendedExtraPayoff,
    freeCash,
    savingsMode,
    minimumsPaid,
    savingsBreakdown: savingsPlan.breakdown,
    recommendedSavings,
    fundPeriods: savingsPlan.periods || {},
    upcomingSubs,
    periodSubsTotal,
    earmarked: round2(earmarked),
    committed: round2(committed),
    variableNecessities,
    variableNecessitiesTotal,
    cashOnHand: round2(cashOnHand),
    obligationShortfall: round2(Math.max(0, committed - cashOnHand)),
    effectiveBuffer,
    bufferMode,
    bufferCalc,
    allocatedBuffer,
    bufferSpent,
    bufferRemaining,
    bufferOverrun,
    bufferSpending,
    bufferAllocation,
    periodObligations,
    ownershipSummary: summarizeOwnership(
      transactions,
      todayStr,
      nextPaydayStr,
      ownership,
      new Set(["Credit Card Payment"].concat((revolvingDebts || []).map((d) => d && d.payment_category).filter(Boolean)))
    ),
    unreconciled: findUnreconciledObligations({
      periodObligations,
      unsettled: bufferSpending.unsettled
    }),
    // A true shortfall means obligations exceed cash; failing to fully fund the
    // discretionary allowance is a milder situation and is surfaced separately.
    deficit: cashOnHand - committed < 0
  };
}

// Resolves when a fixed expense is next due within a pay period, for either
// shape: a fixed day of the month, or a rolling interval carrying its own date.
// Rolling items that are already overdue are included rather than silently
// dropped — money still owed shouldn't vanish from the budget.
function fixedExpenseDueInRange(expense, todayStr, nextPaydayStr) {
  if (expense.interval_days && expense.next_due_date) {
    return expense.next_due_date < nextPaydayStr ? expense.next_due_date : null;
  }
  if (expense.due_day_of_month) {
    return getDueDateInRange(expense.due_day_of_month, todayStr, nextPaydayStr);
  }
  return null;
}

function isRollingExpense(expense) {
  return !!(expense && expense.interval_days && expense.next_due_date);
}

// Records a fixed expense as paid for a cycle, linking the real transaction when
// the user picked one. Mirrors applied_payments on debts: one record per
// payment, keyed by transaction id, so a re-import can't create a second link.
function recordFixedPayment(expense, paidForDate, tx) {
  expense.last_paid_date = paidForDate;
  // Learn where this bill's charges land, once, from the first payment linked to
  // it. Linking is the user stating "this transaction is that bill", which also
  // answers "what category does that bill arrive in" — so the next charge is
  // recognised without being linked at all.
  if (!expense.payment_category && tx && tx.resolved_category && tx.resolved_category !== "Uncategorized") {
    expense.payment_category = tx.resolved_category;
    // Flagged so the editor can explain why a field the user never filled in
    // suddenly has a value, rather than leaving them to wonder.
    expense.payment_category_learned = true;
  }
  if (!Array.isArray(expense.linked_payments)) expense.linked_payments = [];
  if (tx && tx.id && !expense.linked_payments.some((p) => p && p.tx_id === tx.id)) {
    expense.linked_payments.push({
      tx_id: tx.id,
      amount: round2(Math.abs(tx.amount || 0)),
      date: tx.date || paidForDate,
      paid_for: paidForDate
    });
  }
  if (isRollingExpense(expense)) expense.next_due_date = addDays(paidForDate, expense.interval_days);
  return expense;
}

// Undo drops only the link made for that cycle, so a rolling expense keeps the
// history of every other cycle it has been through.
function clearFixedPayment(expense, paidForDate) {
  if (Array.isArray(expense.linked_payments) && paidForDate) {
    expense.linked_payments = expense.linked_payments.filter((p) => p && p.paid_for !== paidForDate);
  }
  return expense;
}

function addDays(dateStr, days) {
  const d = new Date(`${dateStr}T00:00:00`);
  if (isNaN(d.getTime())) return dateStr;
  d.setDate(d.getDate() + Math.round(days));
  return toLocalISO(d);
}

// What "due on the 31st" means in a month that doesn't have one. A bill due on
// the 29th, 30th or 31st lands on the last day of any shorter month; without
// this the strict day match never fires and the obligation silently disappears
// from the budget for February, April, June, September and November.
function dueDayInMonth(dayOfMonth, year, monthIndex) {
  // Day 0 of the following month is the last day of this one.
  const lastDay = new Date(year, monthIndex + 1, 0).getDate();
  return Math.min(dayOfMonth, lastDay);
}

function getDueDateInRange(dayOfMonth, todayStr, nextPaydayStr) {
  if (!dayOfMonth) return null;
  // Parse as LOCAL midnight. `new Date("2026-09-01")` is parsed as UTC, which
  // west of UTC is 17:00 on August 31 local. getDate() then reads local, so both
  // ends of the window sat seven hours early and the LAST day of the period was
  // never tested — a bill due on the day before payday silently dropped out of
  // the budget. It also put getMonth() in the previous month at the boundary,
  // which would give the clamp below the wrong month length.
  const cur = new Date(`${todayStr}T00:00:00`);
  const end = new Date(`${nextPaydayStr}T00:00:00`);
  if (isNaN(cur.getTime()) || isNaN(end.getTime())) return null;
  while (cur < end) {
    if (cur.getDate() === dueDayInMonth(dayOfMonth, cur.getFullYear(), cur.getMonth())) {
      return toLocalISO(cur);
    }
    cur.setDate(cur.getDate() + 1);
  }
  return null;
}

function nextDueDateOnOrAfter(dayOfMonth, fromDateStr) {
  if (!dayOfMonth) return null;
  const cur = new Date(`${fromDateStr}T00:00:00`);
  if (isNaN(cur.getTime())) return null;
  // Clamping guarantees a hit within 31 days; 62 leaves margin without ever
  // running long enough to matter.
  for (let i = 0; i < 62; i++) {
    if (cur.getDate() === dueDayInMonth(dayOfMonth, cur.getFullYear(), cur.getMonth())) {
      return toLocalISO(cur);
    }
    cur.setDate(cur.getDate() + 1);
  }
  return null;
}

// A monotonic counter is what actually guarantees uniqueness here: a CSV import
// creates hundreds of records inside the same millisecond, and Date.now() plus a
// small random suffix collides constantly at that rate. Collisions are severe —
// transaction ids are referenced by debt payment ledgers and savings
// contributions, so a duplicate silently points at the wrong transaction.
let __idCounter = 0;
function genId(prefix) {
  __idCounter += 1;
  const ts = Date.now().toString(36);
  const seq = __idCounter.toString(36);
  const rand = Math.random().toString(36).slice(2, 8);
  return `${prefix}-${ts}-${seq}-${rand}`;
}

// Repairs transactions that were written with colliding ids. The first record in
// a duplicate group keeps the id, so existing references stay pointed at a real
// transaction; the rest are reassigned.
async function dedupeTransactionIds(app) {
  const txs = await readJSON(app, FILES.transactions, []);
  if (txs.length === 0) return { repaired: 0, missing: 0 };

  const seen = new Set();
  let repaired = 0;
  let missing = 0;

  txs.forEach((t) => {
    if (!t.id) {
      t.id = genId("tx");
      missing++;
      seen.add(t.id);
      return;
    }
    if (seen.has(t.id)) {
      const old = t.id;
      t.id = genId("tx");
      repaired++;
      // A capped fund's transfer partner that pointed back at this row.
      if (t.transfer_pair) {
        const partner = txs.find((x) => x && x.id === t.transfer_pair && x.transfer_pair === old);
        if (partner) partner.transfer_pair = t.id;
      }
    }
    seen.add(t.id);
  });

  if (repaired || missing) await writeJSON(app, FILES.transactions, txs);
  return { repaired, missing };
}

// Collapses a bank hold and its settled charge back into the one transaction
// they always were.
//
// Holds imported before the expected-posting date was read out of the
// Transaction ID carry no date, and the import's pending reconciliation used to
// require a date on both sides. So those holds could never settle: the posted
// charge was filed as a second row and the pair sat in the vault forever. That
// is harmless for the period math — an undated row is outside every window — but
// it quietly breaks payment links, because Apply Payment offered the hold (it
// was the row that existed at the time) and linked THAT id. The posted charge
// stayed unclaimed, so the budget kept asking the user to match a payment they
// had already applied.
//
// Deliberately conservative. A hold is merged only when exactly one settled
// charge could be its other half, and never when the two carry links to
// different obligations; anything else is reported and left alone. Guessing here
// would silently delete a real transaction.
function mergeSettledHolds(transactions, { installmentDebts = [], revolvingDebts = [], fixedExpenses = [], goals = [] } = {}) {
  const rows = (transactions || []).slice();
  const linkOwner = new Map();
  [].concat(installmentDebts || [], revolvingDebts || []).forEach((d) =>
    (d.applied_payments || []).forEach((p) => p && p.tx_id && linkOwner.set(p.tx_id, `debt:${debtKey(d)}`))
  );
  (fixedExpenses || []).forEach((f) =>
    (f.linked_payments || []).forEach((p) => p && p.tx_id && linkOwner.set(p.tx_id, `fixed:${f.id || f.name}`))
  );
  (goals || []).forEach((g) =>
    (g.contributions || []).forEach((c) => c && c.linked_tx_id && linkOwner.set(c.linked_tx_id, `goal:${g.id}`))
  );

  const LEAD_IN = /^(pos hold|hold|pending|pos debit|point of sale withdrawal|recurring withdrawal debit card|withdrawal debit card|debit card purchase|purchase authorized on)[\s,:;-]*/;
  const core = (v) => {
    let s = String(v || "").toLowerCase().trim();
    let prev;
    do {
      prev = s;
      s = s.replace(LEAD_IN, "");
    } while (s !== prev);
    return s.replace(/\s+/g, " ").trim();
  };
  const looksLikeSame = (hold, posted) => {
    if (hold.merchant_raw === posted.merchant_raw) return true;
    const x = core(hold.merchant_raw);
    const y = core(posted.merchant_raw);
    if (!x || !y) return false;
    if (x === y) return true;
    const [short, long] = x.length <= y.length ? [x, y] : [y, x];
    return short.length >= 6 && long.startsWith(short);
  };

  const isHold = (t) => !!(t && (t.pending || !t.date));
  const holds = rows.filter((t) => t && t.id && isHold(t) && Number.isFinite(t.amount));
  const settledRows = rows.filter((t) => t && t.id && !isHold(t));

  const relink = [];
  const drop = new Set();
  const skipped = [];
  // A hold paired with a capped fund's transfer: its partner has to follow it
  // to the posted row, or the pair is broken and the posted row can be paired
  // a second time.
  const pairMoves = new Map();

  holds.forEach((hold) => {
    const matches = settledRows.filter(
      (t) => !drop.has(t.id) && t.account_id === hold.account_id && t.amount === hold.amount && looksLikeSame(hold, t)
    );
    if (matches.length !== 1) {
      if (matches.length > 1 && linkOwner.has(hold.id)) {
        skipped.push(`${hold.merchant_raw || "(no description)"} — ${matches.length} settled charges could be its other half.`);
      }
      return;
    }
    const posted = matches[0];
    const holdOwner = linkOwner.get(hold.id) || null;
    const postedOwner = linkOwner.get(posted.id) || null;
    // Two different obligations each believing they own one of the pair is a
    // real disagreement, not a duplicate. Leave it for the user.
    if (holdOwner && postedOwner && holdOwner !== postedOwner) {
      skipped.push(`${hold.merchant_raw || "(no description)"} — the hold and the posted charge are applied to different things.`);
      return;
    }
    drop.add(hold.id);
    // The settled row is the one to keep: it has the real posting date and the
    // full description. Anything the user set on the hold that the settled row
    // lacks comes across with it.
    const idx = rows.findIndex((t) => t.id === posted.id);
    if (idx >= 0) {
      const keep = Object.assign({}, rows[idx]);
      if (!keep.override_label && hold.override_label) keep.override_label = hold.override_label;
      if (!keep.transfer_pair && hold.transfer_pair) keep.transfer_pair = hold.transfer_pair;
      // Only when the posted row now carries the hold's pair. If it already had
      // one of its own, the hold's partner is left pointing at nothing — a dead
      // pair, free to be paired again — rather than half of a lopsided one.
      if (hold.transfer_pair && keep.transfer_pair === hold.transfer_pair) pairMoves.set(hold.id, posted.id);
      if (hold.excluded_from_debt_payments) keep.excluded_from_debt_payments = true;
      if (!keep.debt_payment_review_status && hold.debt_payment_review_status) {
        keep.debt_payment_review_status = hold.debt_payment_review_status;
      }
      keep.pending = undefined;
      rows[idx] = keep;
    }
    if (holdOwner) relink.push({ from: hold.id, to: posted.id, date: posted.date || null });
  });

  rows.forEach((t, i) => {
    if (t && t.transfer_pair && pairMoves.has(t.transfer_pair)) {
      rows[i] = Object.assign({}, t, { transfer_pair: pairMoves.get(t.transfer_pair) });
    }
  });

  return {
    transactions: rows.filter((t) => !(t && drop.has(t.id))),
    relink,
    merged: drop.size,
    skipped
  };
}

// Runs the hold/settled merge across the vault and repairs the links that
// pointed at the row it removed. Writes only the files that actually changed.
async function repairSettledHolds(app) {
  const transactions = await readJSON(app, FILES.transactions, []);
  if (!transactions.length) return { merged: 0, relinked: 0, skipped: [] };

  const installmentDebts = await readJSON(app, FILES.installmentDebts, []);
  const revolvingDebts = await readJSON(app, FILES.revolvingDebts, []);
  const fixedExpenses = await readJSON(app, FILES.fixedExpenses, []);
  const goals = await readJSON(app, FILES.savingsGoals, []);

  const result = mergeSettledHolds(transactions, {
    installmentDebts,
    revolvingDebts,
    fixedExpenses,
    goals
  });

  // Runs whether or not anything merged: a duplicate link can exist on its own,
  // from applying both the hold and the posted charge to the same obligation.
  let relinked = 0;
  let deduped = 0;
  [
    [installmentDebts, "applied_payments"],
    [revolvingDebts, "applied_payments"],
    [fixedExpenses, "linked_payments"],
    [goals, "contributions"]
  ].forEach(([records, field]) => {
    const r = applyTransactionRelinks(records, result.relink, field);
    relinked += r.moved;
    deduped += r.deduped;
  });

  if (result.merged) await writeJSON(app, FILES.transactions, result.transactions);
  if (relinked || deduped) {
    await writeJSON(app, FILES.installmentDebts, installmentDebts);
    await writeJSON(app, FILES.revolvingDebts, revolvingDebts);
    await writeJSON(app, FILES.fixedExpenses, fixedExpenses);
    await writeJSON(app, FILES.savingsGoals, goals);
  }
  return { merged: result.merged, relinked, deduped, skipped: result.skipped };
}

// Points every stored payment link at the surviving transaction id, then drops
// links that have become duplicates of each other. Mirrors the three ledgers the
// ownership index reads, so a repaired link is visible to every subsystem at
// once.
//
// The dedupe is not housekeeping. One transaction can only have paid a given
// obligation once, so two links to the same id mean the amount is counted twice
// against the balance — which is how a $24.37 installment ended up recorded as
// $48.74 paid, rolling its due date forward a cycle early. That can happen
// without any merge at all: the user applies the bank hold, the charge posts as
// a second row, and they apply that too.
function applyTransactionRelinks(records, relink, field) {
  const map = new Map((relink || []).map((r) => [r.from, r.to]));
  // A payment applied while it was an undated hold takes the settled row's
  // date. Left undated it would count as "today" forever — for a loan, every
  // later month's payment, and again after every re-anchor.
  const dates = new Map((relink || []).filter((r) => r.date).map((r) => [r.to, r.date]));
  const key = field === "contributions" ? "linked_tx_id" : "tx_id";
  let moved = 0;
  let deduped = 0;

  (records || []).forEach((rec) => {
    if (!rec || !Array.isArray(rec[field])) return;

    if (map.size) {
      rec[field].forEach((entry) => {
        if (!entry) return;
        const next = map.get(entry[key]);
        if (next) {
          entry[key] = next;
          if (field === "applied_payments" && !entry.date && dates.get(next)) entry.date = dates.get(next);
          moved++;
        }
      });
    }

    // Keep the entry that carries a date — it came from the settled charge and
    // is the one with real provenance.
    const best = new Map();
    rec[field].forEach((entry) => {
      if (!entry || !entry[key]) return;
      const seen = best.get(entry[key]);
      if (!seen) best.set(entry[key], entry);
      else if (!seen.date && entry.date) best.set(entry[key], entry);
    });
    const kept = rec[field].filter((entry) => !entry || !entry[key] || best.get(entry[key]) === entry);
    if (kept.length !== rec[field].length) {
      deduped += rec[field].length - kept.length;
      rec[field] = kept;
    }
  });
  return { moved, deduped };
}

// Backfills a stable id on any record missing one (e.g. fixed expenses added
// before the "Mark as Paid" feature existed). Without this, id-based lookups
// can match the wrong record since `undefined === undefined` is true.
async function ensureIds(app, filePath, prefix) {
  const items = await readJSON(app, filePath, []);
  let changed = false;
  items.forEach((item) => {
    if (!item.id) {
      item.id = genId(prefix);
      changed = true;
    }
  });
  if (changed) await writeJSON(app, filePath, items);
  return items;
}

// Backfills the linked_payments ledger on fixed expenses. Deliberately does NOT
// try to guess which transaction paid an expense that was already marked paid —
// that guess is exactly the amount-matching this ledger replaced. Those show a
// "Link payment" button on the dashboard instead.
async function ensureFixedExpenseLinks(app) {
  const items = await readJSON(app, FILES.fixedExpenses, []);
  let changed = false;
  items.forEach((e) => {
    if (!Array.isArray(e.linked_payments)) {
      e.linked_payments = [];
      changed = true;
    }
  });
  if (changed) await writeJSON(app, FILES.fixedExpenses, items);
  return items;
}

function round2(n) {
  return Math.round(n * 100) / 100;
}

// ---------- pie chart (spend by category) ----------

// Obsidian's own palette, so the chart follows the user's theme and light/dark
// instead of fighting it. These resolve in an SVG `fill` attribute as well as in
// an inline style, so both the slices and the legend swatches track the theme.
//
// Each carries a fallback. A custom theme that doesn't define one of these would
// otherwise leave `fill` with an unresolvable value, and an unresolvable paint
// renders BLACK — one missing variable would mean an invisible slice on a dark
// background rather than a slightly wrong colour. The fallbacks are Obsidian's
// own defaults, so they only ever show up when the theme has nothing to say.
// Category colours, in the fixed order they're handed out. Built from the UI's
// own colours so charts sit in the same register as the rest of the dashboard:
// the accent lavender (#A28AF6, the title and progress bars) and the Oopsie
// Fund's cyan (#4ECCCC) lead, then hues at their brightness — a bright tier at
// the glow colours' lightness and a soft tier of pastels — with Spendable's
// green (#42CC6C) and the dashboard's red (#F64848) in among them. Eighteen
// before any repeats.
// Order checked with the dataviz palette validator on the dark card (#262626):
// every neighbouring pair — stacked slices, adjacent pie wedges, including
// the wrap from last to first — stays apart for colour-blind and normal vision
// (adjacent ΔE ≥ 8.8 CVD, ≥ 15.5 normal), and every colour clears 3:1
// against the card.
const PIE_COLORS = [
  "#A28AF6", // lavender — the UI accent
  "#4ECCCC", // cyan — the Oopsie Fund
  "#F08E55", // apricot
  "#E4D098", // sand
  "#E287CB", // orchid
  "#42CC6C", // green — Spendable's
  "#A1DAFC", // sky
  "#F64848", // red — the dashboard's
  "#DF9C32", // amber
  "#87A7FD", // periwinkle
  "#F183A5", // rose
  "#BCDDAB", // pistachio
  "#1BBDE2", // cerulean
  "#9CB84B", // olive-lime
  "#98E2D7", // seafoam
  "#C98FEA", // violet
  "#20C79E", // jade
  "#EBC1EC" // pink mist
];

// Obsidian's plugin rules forbid assigning innerHTML. The charts are built as
// SVG strings, so parse them as SVG and attach the result instead.
function setSvgContent(host, svgMarkup) {
  if (!svgMarkup) return;
  const markup = /^\s*<svg\b[^>]*\bxmlns=/.test(svgMarkup)
    ? svgMarkup
    : String(svgMarkup).replace(/^\s*<svg\b/, '<svg xmlns="http://www.w3.org/2000/svg"');
  const doc = new DOMParser().parseFromString(markup, "image/svg+xml");
  if (doc.getElementsByTagName("parsererror").length) return;
  host.appendChild(document.importNode(doc.documentElement, true));
}

function escapeHtml(str) {
  return String(str).replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
}

// Guesses a short, reusable merchant name out of a noisy bank description by
// stripping common prefixes (processor codes, POS reference numbers) and
// cutting off everything from the first noise marker onward (dates, card
// numbers, trailing city/state, store numbers). Not perfect for every bank's
// format, but it's editable in the UI — the goal is "much shorter and more
// reusable than the full raw line," not a flawless parse.
const US_STATES = new Set(
  ("AL AK AZ AR CA CO CT DE FL GA HI ID IL IN IA KS KY LA ME MD MA MI MN MS MO MT NE NV NH NJ NM NY NC ND OH OK " +
    "OR PA RI SC SD TN TX UT VT VA WA WV WI WY DC PR").split(" ")
);

// Removes a trailing state code and up to two preceding city words. Only fires
// when the last token is a real state abbreviation, so names like
// "ACME FOODS, INC." are left alone.
const COMMON_CITIES = new Set(
  ("PORTLAND SEATTLE TACOMA SPOKANE VANCOUVER SALEM EUGENE BEAVERTON GRESHAM HILLSBORO TIGARD TROUTDALE " +
    "BELLEVUE REDMOND KIRKLAND EVERETT RENTON KENT OLYMPIA BOISE DENVER PHOENIX TUCSON AUSTIN DALLAS HOUSTON " +
    "CHICAGO ATLANTA MIAMI ORLANDO TAMPA BOSTON BROOKLYN QUEENS MANHATTAN PHILADELPHIA PITTSBURGH DETROIT " +
    "MINNEAPOLIS DENVERCO SACRAMENTO OAKLAND BERKELEY PASADENA GLENDALE ANAHEIM IRVINE FREMONT SUNNYVALE " +
    "CUPERTINO MOUNTAINVIEW PALOALTO SANJOSE FRANCISCO ANGELES DIEGO VEGAS ANTONIO JOSE YORK ORLEANS " +
    "NASHVILLE MEMPHIS LOUISVILLE COLUMBUS CLEVELAND CINCINNATI INDIANAPOLIS MILWAUKEE OMAHA WICHITA " +
    "ALBUQUERQUE MESA RALEIGH CHARLOTTE RICHMOND NORFOLK BALTIMORE NEWARK JERSEY BUFFALO ROCHESTER SYRACUSE").split(" ")
);

const MULTIWORD_CITY_PREFIXES = new Set(
  ("SAN LAS LOS NEW LAKE FORT FT ST SAINT WEST EAST NORTH SOUTH PORT GRAND SANTA MOUNT PALM BAY VILLAGE").split(" ")
);

function stripTrailingCityState(s) {
  const tokens = s.trim().split(/\s+/);
  if (tokens.length < 2) return s;
  if (!US_STATES.has(tokens[tokens.length - 1])) return s;

  tokens.pop(); // drop the state

  // Only remove the preceding word when it's recognizably a city. Blindly
  // popping a token turns "Amazon Prime WA" into "Amazon" and "SPOTIFY USA NY"
  // into "SPOTIFY", which merges unrelated merchants. Leaving an unknown city
  // in place is harmless — it's at least consistent across charges.
  const last = (tokens[tokens.length - 1] || "").toUpperCase();
  if (tokens.length > 1 && COMMON_CITIES.has(last)) {
    tokens.pop();
    const prev = (tokens[tokens.length - 1] || "").toUpperCase();
    if (tokens.length > 1 && MULTIWORD_CITY_PREFIXES.has(prev)) tokens.pop();
  }
  return tokens.join(" ");
}

function guessMerchantKey(raw) {
  if (!raw) return "";
  let s = raw.trim();

  s = s.replace(/^#\d+\s+POS\s+/i, "");
  s = s.replace(/^POS\s+/i, "");
  s = s.replace(/^Withdrawal Debit Card\s+/i, "");
  s = s.replace(/^SQ\s*\*\s*/i, "");
  s = s.replace(/^TST\*\s*/i, "");

  // Billing noise that varies per charge and would otherwise split one
  // merchant into a new group every month.

  // Phone numbers: 888-802-3080, 855-836-39987, 800.555.1212, (888) 802-3080
  s = s.replace(/\(?\b\d{3}\)?[-.\s]\d{3}[-.\s]\d{4,5}\b/g, " ");

  // Support URLs and billing paths: g.co/helppay, amzn.com/bill, help.max.com/x
  s = s.replace(/\b[\w.-]+\.[a-z]{2,}\/\S*/gi, " ");

  // Reference codes after an asterisk, but ONLY when they look like codes
  // (contain a digit) — "Klarna*TikTok Shop" must keep its suffix, while
  // "Kindle Unltd*HL1CB5" must lose it.
  s = s.replace(/\*\s*(?=[A-Za-z0-9]*\d)[A-Za-z0-9]{3,14}\b/g, " ");

  // Bare trailing reference blobs: 6+ chars of mixed letters AND digits
  s = s.replace(/\b(?=[A-Z0-9]*\d)(?=[A-Z0-9]*[A-Z])[A-Z0-9]{6,}\b/g, " ");

  s = s.replace(/\s{2,}/g, " ").trim();

  const cutMarkers = [/\bDate\s+\d/i, /\bTYPE:/i, /\s-\s/, /\s#/, /\bCard\s\d/i];
  let cutIndex = s.length;
  for (const marker of cutMarkers) {
    const m = s.match(marker);
    if (m && m.index < cutIndex) cutIndex = m.index;
  }
  s = s.slice(0, cutIndex).trim();

  // Trailing "CITY ST" is location noise, and it splits one merchant into
  // several groups when the same service bills from different cities.
  s = stripTrailingCityState(s);

  // BNPL providers: keep just the provider name for broad matching across plans
  const bnplMatch = s.match(/^(Klarna|Affirm|Afterpay)\b/i);
  if (bnplMatch) s = bnplMatch[1];

  return s.trim() || raw.trim();
}

function filterTransactionsByRange(transactions, range, periodBounds) {
  if (range === "period" && periodBounds) {
    return transactions.filter((t) => t.date >= periodBounds.todayStr && t.date < periodBounds.nextPaydayStr);
  }
  if (range === "30d") {
    const cutoff = new Date();
    cutoff.setDate(cutoff.getDate() - 30);
    const cutoffStr = toLocalISO(cutoff);
    return transactions.filter((t) => t.date >= cutoffStr);
  }
  return transactions; // "all"
}

function sameTxFields(a, b) {
  return (
    a.date === b.date &&
    a.merchant_raw === b.merchant_raw &&
    a.amount === b.amount &&
    a.account_id === b.account_id
  );
}


// Reconciles a fresh bank export against transactions already stored in the
// tracker. Exact duplicates are ignored. A settled charge can replace its
// earlier pending version while preserving the existing transaction id and any
// user-applied metadata. Ambiguous pending matches are deliberately left
// unresolved instead of guessing; the import UI keeps the source CSV so the
// user can review those rows.
//
// `holdsOnly` is for a source that identifies its transactions itself (SimpleFIN
// ids): identical fields then prove nothing — two same-price fares on one day
// are two charges — so only a bank hold waiting to settle is matched.
function reconcileImport(existing, incoming, { holdsOnly = false } = {}) {
  const merged = (existing || []).map((t) => Object.assign({}, t));
  let added = 0;
  let updated = 0;
  let skipped = 0;
  let unresolved = 0;
  const issues = [];

  const describe = (tx) =>
    `${tx && tx.date ? tx.date : "undated"} · ${tx && tx.merchant_raw ? tx.merchant_raw : "(no description)"} · ` +
    `$${Math.abs(Number(tx && tx.amount) || 0).toFixed(2)}`;

  const calendarDistance = (a, b) => {
    const parse = (s) => {
      const m = String(s || "").match(/^(\d{4})-(\d{2})-(\d{2})$/);
      return m ? Date.UTC(Number(m[1]), Number(m[2]) - 1, Number(m[3])) : NaN;
    };
    const left = parse(a);
    const right = parse(b);
    return Number.isFinite(left) && Number.isFinite(right) ? Math.abs(Math.round((right - left) / 86400000)) : Infinity;
  };

  // A stored hold may carry no date at all. The bank leaves both date columns
  // empty until a charge settles, and rows imported before the expected-posting
  // date was read out of the Transaction ID have nothing else to fall back on.
  //
  // Those rows must still be recognised as holds, or they can never settle: both
  // matchers below used to require a date on BOTH sides, so an undated hold was
  // unreachable and its posted twin was filed as a second, separate charge. Any
  // payment link made against the hold then pointed at a row the budget no
  // longer treated as real, which is how an applied BNPL payment could keep
  // showing up as unmatched.
  const isHold = (t) => !!(t && (t.pending || !t.date));

  // Dates only constrain the match when both rows actually have one.
  const datesCompatible = (a, b) => !a.date || !b.date || calendarDistance(a.date, b.date) <= 3;

  // Banks truncate a hold's description and rewrite it on posting:
  //   "POS Hold, ZIP* BEST BUY"
  //   "Withdrawal Debit Card ZIP* BEST BUY 183-37823729 NY Date 09/08/26 ..."
  // Strip the boilerplate lead-in and the hold's text is a prefix of the posted
  // one. Requiring a decent run of characters keeps "POS Hold, SQ *" from
  // swallowing an unrelated charge.
  const LEAD_IN = /^(pos hold|hold|pending|pos debit|point of sale withdrawal|recurring withdrawal debit card|withdrawal debit card|debit card purchase|purchase authorized on)[\s,:;-]*/;
  const merchantCore = (v) => {
    let s = String(v || "").toLowerCase().trim();
    let prev;
    do {
      prev = s;
      s = s.replace(LEAD_IN, "");
    } while (s !== prev);
    return s.replace(/\s+/g, " ").trim();
  };
  const sameMerchant = (a, b) => {
    if (a.merchant_raw === b.merchant_raw) return true;
    const x = merchantCore(a.merchant_raw);
    const y = merchantCore(b.merchant_raw);
    if (!x || !y) return false;
    if (x === y) return true;
    const [short, long] = x.length <= y.length ? [x, y] : [y, x];
    return short.length >= 6 && long.startsWith(short);
  };

  const samePendingCore = (a, b) =>
    !!a && !!b && a.account_id === b.account_id && a.amount === b.amount && sameMerchant(a, b) && datesCompatible(a, b);

  // The loose matcher only WITHHOLDS a row for review, so it deliberately keeps
  // the original requirement that both sides carry a date. With no date and no
  // merchant agreement it would be matching on amount alone, which is weak
  // enough to hold back a legitimate new charge.
  const samePendingLoose = (a, b) =>
    !!a &&
    !!b &&
    a.account_id === b.account_id &&
    a.amount === b.amount &&
    !!a.date &&
    !!b.date &&
    calendarDistance(a.date, b.date) <= 3;

  const settlePendingAt = (idx, tx) => {
    const prev = merged[idx];
    merged[idx] = Object.assign({}, prev, tx, {
      id: prev.id || tx.id,
      // Never discard a deliberate one-off category override when a pending
      // bank hold is replaced by its settled form.
      override_label: prev.override_label || tx.override_label || null
    });
    // `pending: undefined` is omitted by JSON.stringify, which is exactly what
    // we want once the settled transaction replaces the hold.
    if (!tx.pending) merged[idx].pending = undefined;
    updated++;
  };

  for (const tx of incoming || []) {
    if (!tx || !tx.date || !tx.account_id || !Number.isFinite(tx.amount) || tx.amount === 0) {
      unresolved++;
      issues.push(`Unresolved row: ${describe(tx)} — missing/invalid date, account, or amount.`);
      continue;
    }

    const exactIdx = merged.findIndex((t) => (!holdsOnly || isHold(t)) && sameTxFields(t, tx));
    if (exactIdx >= 0) {
      const prev = merged[exactIdx];
      if (isHold(prev) && !tx.pending) settlePendingAt(exactIdx, tx);
      else skipped++;
      continue;
    }

    // Settled transactions may post a day or two away from the bank's expected
    // pending date. Reconcile only when there is one unambiguous candidate.
    if (!tx.pending) {
      const pendingExact = [];
      merged.forEach((t, i) => {
        if (isHold(t) && samePendingCore(t, tx)) pendingExact.push(i);
      });

      // A source with ids can't leave a charge waiting on review: the same posted
      // charge comes back at every sync and would stop on the same hold each
      // time, forever. So it settles the closest hold it could be — among holds
      // of the same amount on the same account, which one changes no total.
      if (holdsOnly) {
        const pool = pendingExact.length ? pendingExact : [];
        if (!pool.length) {
          merged.forEach((t, i) => {
            if (isHold(t) && samePendingLoose(t, tx)) pool.push(i);
          });
        }
        if (pool.length) {
          const dist = (i) => {
            const d = calendarDistance(merged[i].date, tx.date);
            return Number.isFinite(d) ? d : 1e6;
          };
          settlePendingAt(pool.slice().sort((a, b) => dist(a) - dist(b) || a - b)[0], tx);
          continue;
        }
      }

      if (pendingExact.length === 1) {
        settlePendingAt(pendingExact[0], tx);
        continue;
      }
      if (pendingExact.length > 1) {
        unresolved++;
        issues.push(
          `Ambiguous pending match: ${describe(tx)} matched ${pendingExact.length} existing pending rows. Nothing was guessed.`
        );
        continue;
      }

      // Same account/amount/date neighborhood but a changed description is
      // suspicious enough to require review rather than silently creating what
      // could be a duplicate settled charge.
      const pendingLoose = [];
      merged.forEach((t, i) => {
        if (isHold(t) && samePendingLoose(t, tx)) pendingLoose.push(i);
      });
      if (pendingLoose.length > 0) {
        unresolved++;
        issues.push(
          `Possible pending match needs review: ${describe(tx)} has ${pendingLoose.length} nearby pending row(s) with the same amount but a different description.`
        );
        continue;
      }
    }

    merged.push(Object.assign({}, tx));
    added++;
  }

  return { merged, added, updated, skipped, unresolved, issues };
}

// ---------- SimpleFIN ----------
//
// Optional bank sync through SimpleFIN Bridge. Accounts that aren't linked keep
// using Import CSV; nothing here runs unless the user connects and presses Sync.
//
// The protocol, briefly: a setup token is a base64-encoded claim URL. POSTing to
// it once returns an access URL with Basic-auth credentials in it; the token is
// spent. GET {access}/accounts then returns accounts, balances and transactions.
// The Bridge expects about 24 requests a day and disables access for going well
// past that. It now recommends asking for no more than 45 days at a time, and
// warns (and says it may later refuse) when asked for more.

// Obsidian's secret-storage id rules: lowercase alphanumeric and dashes.
const SIMPLEFIN_SECRET_ID = "budget-tracker-simplefin-access";
// 43 rather than 45: the Bridge measures the span itself, from the start date
// the request gives (the earlier of local and UTC midnight, which west of UTC
// is up to a day before local midnight) to the moment it arrives. 43 stays
// inside 45 at any hour in any timezone.
const SIMPLEFIN_MAX_DAYS = 43;
// The Bridge's own advice: overlap each fetch by about five days so nothing
// posting late falls between two syncs. De-duplication absorbs the overlap.
const SIMPLEFIN_OVERLAP_DAYS = 5;
// Stops short of the Bridge's ~24/day, where tokens start getting disabled.
const SIMPLEFIN_DAILY_LIMIT = 20;
// How long after a purchase it can post. Only used when SimpleFIN gives the
// posting date alone, to recognise the same purchase in a CSV dated the day it
// was made.
const SIMPLEFIN_POSTING_LAG_DAYS = 7;
// A request that hasn't answered by then is given up on, so a hung connection
// can't leave Sync stuck.
const SIMPLEFIN_TIMEOUT_MS = 60000;
// A balance SimpleFIN dates more than this many days back is its bank not
// having refreshed SimpleFIN, and the sync notice says so rather than leaving
// an old figure to look like the plugin ignoring a new one.
const SIMPLEFIN_STALE_BALANCE_DAYS = 2;

// The Bridge's advice about the request itself ("Requested date range exceeds
// recommended range…"), not a problem with any account's data. It mustn't
// hold accounts back from counting as imported: it names no account, so it
// read as covering all of them, no account's import date ever moved, and every
// sync asked for the full window again — which is what set the warning off.
const SIMPLEFIN_ADVISORY = /recommended range|may be capped/i;
// A bank connection SimpleFIN can't sign in to any more.
const SIMPLEFIN_AUTH = /auth(entication)? required|may need attention|re-?authenticat|credentials|sign(ed)? ?in|log(ged)? ?in|password|\bmfa\b|verification code/i;

// The sync notice's problem lines, one per bank rather than one per account.
// A connection SimpleFIN has lost its sign-in to says to sign in again at the
// Bridge, with how old its balances now are; one that's simply behind says
// how far. Returns the lines, and which errors they've explained (those stay
// out of the details list).
function simplefinConnectionProblems(errors, linkedPairs, todayStr = todayLocal()) {
  const fmt = (d) => formatChartDate(d).replace(`, ${todayStr.slice(0, 4)}`, "");
  const orgOf = (sf, local) => (sf && sf.org) || (local && (local.institution || local.id)) || "A bank";
  const stale = (pair) => !!(pair.sf && pair.sf.balanceDate && daysBetween(pair.sf.balanceDate, todayStr) > SIMPLEFIN_STALE_BALANCE_DAYS);
  const norm = (x) => String(x || "").toLowerCase().replace(/[^a-z0-9]/g, "");
  const explained = new Set();
  const covered = new Set();
  const signIn = new Map(); // bank name → oldest balance date among its accounts
  (errors || []).forEach((e) => {
    if (SIMPLEFIN_ADVISORY.test(e.message)) {
      explained.add(e);
      return;
    }
    if (!SIMPLEFIN_AUTH.test(e.message)) return;
    const named = /connection to (.+?) (?:may|needs|requires|has|is)\b/i.exec(e.message);
    const name = named ? named[1].trim() : null;
    // The accounts it's about: by connection, by account, or by the bank it names.
    const pairs = linkedPairs.filter(({ sf, local }) => {
      if (!sf) return false;
      if (e.connId || e.accountId) return (e.connId && sf.connId === e.connId) || (e.accountId && sf.id === e.accountId);
      if (!name) return false;
      const n = norm(name);
      return [sf.org, sf.name, local && local.institution, local && local.id].some((x) => norm(x) && (norm(x) === n || norm(x).includes(n) || n.includes(norm(x))));
    });
    const org = name || (pairs[0] ? orgOf(pairs[0].sf, pairs[0].local) : "A bank connection");
    const dates = pairs.filter(stale).map((pr) => pr.sf.balanceDate).sort();
    const prev = signIn.has(org) ? signIn.get(org) : undefined;
    signIn.set(org, [prev, dates[0]].filter(Boolean).sort()[0] || null);
    pairs.forEach((pr) => covered.add(pr));
    explained.add(e);
  });
  const lines = [...signIn].map(([org, date]) => `${org} needs you to sign in again at SimpleFIN Bridge.` + (date ? ` Its balances are from ${fmt(date)}.` : ""));
  const behind = new Map();
  linkedPairs.forEach((pr) => {
    if (covered.has(pr) || !stale(pr)) return;
    const org = orgOf(pr.sf, pr.local);
    if (!behind.has(org) || pr.sf.balanceDate < behind.get(org)) behind.set(org, pr.sf.balanceDate);
  });
  behind.forEach((date, org) => lines.push(`${org}: SimpleFIN has nothing newer than ${fmt(date)} yet.`));
  return { lines, explained };
}

function withSimpleFINTimeout(promise, ms = SIMPLEFIN_TIMEOUT_MS) {
  let timer;
  const timeout = new Promise((_, reject) => {
    timer = setTimeout(() => reject(new SimpleFINError("timeout", "SimpleFIN didn’t answer in time. Try again in a few minutes.")), ms);
  });
  return Promise.race([promise, timeout]).finally(() => clearTimeout(timer));
}

class SimpleFINError extends Error {
  constructor(kind, message) {
    super(message);
    this.kind = kind;
  }
}

// The access URL carries a username and password. Anything that might end up in
// a notice or the console goes through this first.
function redactSimpleFIN(text) {
  return String(text == null ? "" : text)
    .replace(/(https?:\/\/)[^\s/@]+@/gi, "$1[redacted]@")
    .replace(/Basic\s+[A-Za-z0-9+/=]+/g, "Basic [redacted]");
}

// Splits an access URL into the endpoint and an Authorization header. Browsers
// refuse URLs with credentials in them, so they travel as a header instead.
// Returns null for anything that isn't an https URL with credentials.
function parseSimpleFINAccessUrl(raw) {
  let u;
  try {
    u = new URL(String(raw || "").trim());
  } catch (e) {
    return null;
  }
  if (u.protocol !== "https:" || !u.username) return null;
  let auth;
  try {
    auth = btoa(`${decodeURIComponent(u.username)}:${decodeURIComponent(u.password)}`);
  } catch (e) {
    return null;
  }
  u.username = "";
  u.password = "";
  return { base: u.toString().replace(/\/+$/, ""), authHeader: `Basic ${auth}` };
}

// A setup token or access URL pasted where an account id belongs. Either is a
// credential, and the account id is saved in the vault.
function looksLikeSimpleFINCredential(value) {
  const v = String(value || "").trim();
  if (!v) return false;
  if (/:\/\/|@/.test(v)) return true;
  try {
    return /^https?:\/\//i.test(atob(v.replace(/\s+/g, "")));
  } catch (e) {
    return false;
  }
}

// Accepts either what SimpleFIN Bridge hands out (a setup token) or an access
// URL someone already has. A setup token is claimed here — once; SimpleFIN
// won't honour it a second time — and the access URL comes back.
async function claimSimpleFINToken(input, { request = requestUrl, timeoutMs = SIMPLEFIN_TIMEOUT_MS } = {}) {
  const value = String(input || "").trim();
  if (!value) throw new SimpleFINError("input", "Paste a SimpleFIN setup token first.");
  if (parseSimpleFINAccessUrl(value)) return value;

  let claimUrl;
  try {
    claimUrl = atob(value.replace(/\s+/g, ""));
  } catch (e) {
    throw new SimpleFINError("input", "That doesn’t look like a SimpleFIN setup token.");
  }
  let parsed;
  try {
    parsed = new URL(claimUrl);
  } catch (e) {
    throw new SimpleFINError("input", "That doesn’t look like a SimpleFIN setup token.");
  }
  if (parsed.protocol !== "https:") throw new SimpleFINError("input", "That doesn’t look like a SimpleFIN setup token.");

  let res;
  try {
    res = await withSimpleFINTimeout(request({ url: claimUrl, method: "POST", throw: false }), timeoutMs);
  } catch (e) {
    if (e instanceof SimpleFINError) throw e;
    throw new SimpleFINError("network", "Couldn’t reach SimpleFIN — check your connection and try again.");
  }
  if (res.status === 403) {
    throw new SimpleFINError(
      "claimed",
      "That setup token has already been used, or has expired. Create a new one in SimpleFIN Bridge."
    );
  }
  if (res.status < 200 || res.status >= 300) {
    throw new SimpleFINError("http", `SimpleFIN couldn’t connect (HTTP ${res.status}).`);
  }
  const access = String(res.text || "").trim();
  if (!parseSimpleFINAccessUrl(access)) {
    throw new SimpleFINError("payload", "SimpleFIN answered, but not with a connection this plugin can use.");
  }
  return access;
}

// Calendar date for a SimpleFIN timestamp (seconds since the epoch). Banks that
// only know the day send it as midnight UTC; read in local time west of UTC
// that would land the day before, so exact midnight UTC is taken as a date.
function simplefinDate(seconds) {
  const n = Number(seconds);
  if (!Number.isFinite(n) || n <= 0) return null;
  if (n % 86400 === 0) return new Date(n * 1000).toISOString().slice(0, 10);
  return toLocalISO(new Date(n * 1000));
}

function simplefinStamp(seconds) {
  const n = Number(seconds);
  if (!Number.isFinite(n) || n <= 0) return null;
  const d = new Date(n * 1000);
  return isNaN(d.getTime()) ? null : d.toISOString();
}

// The start of a day, as a timestamp: whichever of local and UTC midnight comes
// first, so a posting stamped either way on the first day is included.
function simplefinEpoch(dateStr) {
  const local = new Date(`${dateStr}T00:00:00`).getTime();
  const utc = Date.parse(`${dateStr}T00:00:00Z`);
  return Math.floor(Math.min(local, utc) / 1000);
}

// One shape out of either protocol version. v2 lists errors as objects in
// `errlist` and institutions as `connections`; v1 sent `errors` as plain strings
// and an `org` on each account. Asking for v2 doesn't guarantee getting it.
function normalizeSimpleFINPayload(json) {
  if (!json || typeof json !== "object" || !Array.isArray(json.accounts)) {
    throw new SimpleFINError("payload", "SimpleFIN sent back something that isn’t account data.");
  }
  const num = (v) => {
    const n = Number(v);
    return v === "" || v == null || !Number.isFinite(n) ? null : n;
  };
  const errors = [];
  const pushError = (e) => {
    if (typeof e === "string" && e.trim()) errors.push({ message: e.trim(), accountId: null, connId: null, code: null });
    else if (e && typeof e.msg === "string") {
      errors.push({
        message: e.msg.trim(),
        accountId: e.account_id != null ? String(e.account_id) : null,
        connId: e.conn_id != null ? String(e.conn_id) : null,
        code: e.code || null
      });
    }
  };
  (Array.isArray(json.errlist) ? json.errlist : []).forEach(pushError);
  (Array.isArray(json.errors) ? json.errors : []).forEach(pushError);

  const connections = new Map(
    (Array.isArray(json.connections) ? json.connections : []).filter((c) => c && c.conn_id).map((c) => [c.conn_id, c])
  );
  const accounts = [];
  const counts = new Map();
  json.accounts.forEach((a) => {
    if (!a || a.id == null) return;
    const id = String(a.id);
    counts.set(id, (counts.get(id) || 0) + 1);
    const conn = connections.get(a.conn_id);
    accounts.push({
      id,
      name: String(a.name || id),
      org: String((conn && conn.name) || (a.org && (a.org.name || a.org.domain)) || ""),
      connId: a.conn_id != null ? String(a.conn_id) : null,
      currency: String(a.currency || "USD").toUpperCase(),
      balance: num(a.balance),
      balanceDate: simplefinDate(a["balance-date"]),
      // The moment the bank's figure is from, to order it against a typed one.
      balanceAt: simplefinStamp(a["balance-date"]),
      transactions: Array.isArray(a.transactions) ? a.transactions : []
    });
  });
  // Account ids are only unique within a connection. Two connections using the
  // same one means a link can't say which is meant, so neither is used.
  const ambiguous = [...counts.entries()].filter(([, n]) => n > 1).map(([id]) => id);
  return { accounts, errors, ambiguous };
}

// GET /accounts through Obsidian's requestUrl, which runs outside the browser
// sandbox and so isn't subject to CORS. `request` is injectable for tests.
async function fetchSimpleFINData(
  accessUrl,
  { startDate = null, balancesOnly = false, request = requestUrl, timeoutMs = SIMPLEFIN_TIMEOUT_MS } = {}
) {
  const parsed = parseSimpleFINAccessUrl(accessUrl);
  if (!parsed) throw new SimpleFINError("auth", "The saved SimpleFIN connection is unreadable. Reconnect in Settings.");

  const params = new URLSearchParams();
  params.set("version", "2");
  // Always bounded: leaving start-date off asks for everything and is the
  // quickest way to burn through the day's allowance.
  if (startDate) params.set("start-date", String(simplefinEpoch(startDate)));
  if (balancesOnly) params.set("balances-only", "1");

  let res;
  try {
    res = await withSimpleFINTimeout(
      request({
        url: `${parsed.base}/accounts?${params.toString()}`,
        method: "GET",
        headers: { Authorization: parsed.authHeader, Accept: "application/json" },
        throw: false
      }),
      timeoutMs
    );
  } catch (e) {
    if (e instanceof SimpleFINError) throw e;
    throw new SimpleFINError("network", "Couldn’t reach SimpleFIN — check your connection and try again.");
  }
  if (res.status === 403) {
    throw new SimpleFINError(
      "auth",
      "SimpleFIN turned the connection down — access may have been revoked. Reconnect in Settings with a new setup token."
    );
  }
  if (res.status === 402) throw new SimpleFINError("payment", "SimpleFIN says the Bridge subscription needs attention.");
  if (res.status < 200 || res.status >= 300) {
    throw new SimpleFINError("http", `SimpleFIN returned an error (HTTP ${res.status}).`);
  }
  let json;
  try {
    json = typeof res.json === "object" && res.json ? res.json : JSON.parse(res.text);
  } catch (e) {
    throw new SimpleFINError("payload", "SimpleFIN sent back something that isn’t account data.");
  }
  return normalizeSimpleFINPayload(json);
}

// Where the next fetch should start: five days before the least-recently
// imported linked account, never further back than the Bridge allows. An
// account never imported at all gets the full SIMPLEFIN_MAX_DAYS.
function simplefinStartDate(linkedAccounts, todayStr) {
  const floor = addDays(todayStr, -SIMPLEFIN_MAX_DAYS);
  const earliest = (linkedAccounts || [])
    .map((a) => (a.last_imported_through ? addDays(a.last_imported_through, -SIMPLEFIN_OVERLAP_DAYS) : floor))
    .reduce((m, d) => (d < m ? d : m), todayStr);
  return earliest < floor ? floor : earliest;
}

// SimpleFIN transactions in the plugin's own shape. Each keeps the SimpleFIN
// account and transaction ids it came with: transaction ids are only unique
// within an account, so the pair is the identity checked on every later sync.
// It also keeps the posting date, which recognising the same purchase in a CSV
// needs whenever the bank's CSV dates by posting rather than by purchase.
function simplefinToLocalTransactions(sfAccount, localAccount) {
  const out = [];
  let pending = 0;
  let zero = 0;
  let invalid = 0;
  (sfAccount.transactions || []).forEach((t) => {
    if (!t || typeof t !== "object") return;
    // Not requested, and skipped if sent anyway: a pending charge can post under
    // a new id or never post at all, and either way would be counted twice. The
    // protocol lets a pending one arrive as `posted: 0` without the flag.
    if (t.pending || !(Number(t.posted) > 0)) {
      pending++;
      return;
    }
    let amount = Number(String(t.amount == null ? "" : t.amount).replace(/[,$\s]/g, ""));
    const posted = simplefinDate(t.posted);
    if (t.id == null || String(t.amount == null ? "" : t.amount).trim() === "" || !Number.isFinite(amount) || !posted) {
      invalid++;
      return;
    }
    amount = round2(amount);
    if (amount === 0) {
      zero++;
      return;
    }
    // SimpleFIN defines the sign itself — positive is money in — which is this
    // plugin's convention too. The account's "exports purchases as positive"
    // setting is deliberately NOT applied: it describes the bank's CSV files, not
    // this feed. An Amex account needs it on for its CSVs, and would have every
    // purchase read as income if it were applied here.
    out.push({
      id: genId("tx"),
      date: simplefinDate(t.transacted_at) || posted,
      merchant_raw: String(t.description || t.payee || "").trim(),
      amount,
      account_id: localAccount.id,
      resolved_category: null,
      override_label: null,
      simplefin_account: sfAccount.id,
      simplefin_id: String(t.id),
      simplefin_posted: posted
    });
  });
  return { transactions: out, pending, zero, invalid };
}

// Words about how a purchase was made rather than who it was with. Two
// descriptions of one purchase from two sources share a merchant word, not these.
const SIMPLEFIN_STOP_WORDS = new Set([
  "POS", "HOLD", "WITHDRAWAL", "DEBIT", "CREDIT", "CARD", "PURCHASE", "RECURRING", "PAYMENT", "ONLINE", "ACH",
  "TRANSFER", "CHECKCARD", "VISA", "MASTERCARD", "TST", "DATE", "COM", "WWW", "INC", "LLC", "USA", "THE", "AND",
  "PENDING", "AUTHORIZED", "POINT", "SALE", "DEPOSIT", "FROM", "BILL", "PAY", "ELECTRONIC"
]);

function merchantWords(text) {
  return new Set(
    String(text || "")
      .toUpperCase()
      .split(/[^A-Z]+/)
      .filter((w) => w.length >= 3 && !SIMPLEFIN_STOP_WORDS.has(w))
  );
}

// The dates a synced row could be recognised by in a CSV. A CSV carries one
// date — the purchase or the posting, depending on the bank. A synced row knows
// its posting date and usually its purchase date; when the two are the same
// day, the purchase date may simply not have been sent.
function simplefinRowDates(row) {
  const posted = row.simplefin_posted || row.date;
  const bought = row.date && row.date !== posted ? row.date : null;
  return { bought, posted };
}

// How many days apart a CSV date and a synced row are, or null when they can't
// be one transaction: within three days of either of its dates, or — when only
// the posting date is known — up to a week before it (a purchase can take that
// long to post) and three days after.
function csvToSyncedGap(csvDate, syncedRow) {
  if (!csvDate) return null;
  const { bought, posted } = simplefinRowDates(syncedRow);
  if (!posted) return null;
  if (bought) {
    const g = Math.min(Math.abs(daysBetween(csvDate, bought)), Math.abs(daysBetween(csvDate, posted)));
    return g <= 3 ? g : null;
  }
  const before = daysBetween(csvDate, posted); // > 0: the CSV date is earlier
  return before < -3 || before > SIMPLEFIN_POSTING_LAG_DAYS ? null : Math.abs(before);
}

// Pairs incoming transactions with the same transactions already in the ledger
// from the other source — SimpleFIN against CSV, or CSV against SimpleFIN.
// Neither side carries the other's id, so the id check can't see these.
//
// A pair needs the same account, the same amount to the cent, and compatible
// dates (`gapOf`, null when they can't match). Descriptions come from different
// sources and are compared loosely. Pairing is one to one and settled across
// the whole batch at once, best pairs first — a shared merchant word, then the
// closest dates — so two same-price purchases on neighbouring days each find
// their own row whatever order either side lists them.
function pairAcrossSources(existing, incoming, gapOf) {
  const words = incoming.map((tx) => merchantWords(tx && tx.merchant_raw));
  const options = [];
  incoming.forEach((tx, k) => {
    if (!tx || !tx.date || !tx.account_id || !Number.isFinite(tx.amount)) return;
    existing.forEach((t, i) => {
      if (!t || t.pending || !t.date) return;
      if (t.account_id !== tx.account_id || t.amount !== tx.amount) return;
      const gap = gapOf(t, tx);
      if (gap == null) return;
      const shared = [...merchantWords(t.merchant_raw)].some((w) => words[k].has(w));
      options.push({ k, i, shared, gap });
    });
  });
  options.sort((a, b) => b.shared - a.shared || a.gap - b.gap || a.k - b.k || a.i - b.i);

  const taken = new Set();
  const pairs = new Map(); // incoming index -> existing index
  options.forEach(({ k, i }) => {
    if (pairs.has(k) || taken.has(i)) return;
    pairs.set(k, i);
    taken.add(i);
  });
  return pairs;
}

// SimpleFIN rows against what's already in the ledger.
//
// A row this same SimpleFIN account already sent is a different transaction —
// the id check said so. One stamped by another SimpleFIN account is from before
// a relink (a bank connection re-added in SimpleFIN comes back with new ids) and
// pairs like a CSV row.
//
// The window: the batch holds what posted since `windowStart`, so a ledger row
// dated inside it has its twin in the batch. A row dated before it usually
// doesn't — its twin posted earlier and wasn't asked for — so it only pairs with
// a transaction that could have been bought before the window too.
function matchSimpleFINToLedger(existing, incoming, windowStart) {
  return pairAcrossSources(existing, incoming, (t, tx) => {
    if (t.simplefin_id && t.simplefin_account === tx.simplefin_account) return null;
    if (windowStart && t.date < windowStart) {
      const { bought, posted } = simplefinRowDates(tx);
      const earliest = bought || addDays(posted, -SIMPLEFIN_POSTING_LAG_DAYS);
      if (earliest >= windowStart) return null;
    }
    return csvToSyncedGap(t.date, tx);
  });
}

// CSV rows against transactions SimpleFIN already brought in — an account that
// was synced, unlinked, and is now getting a CSV. Those CSV rows are skipped.
// Only synced rows dated within the CSV's own span are considered: a history
// file ending the day before syncing began must not lose its last rows to the
// first synced ones.
function matchCSVToSimpleFIN(existing, incoming) {
  const span = new Map(); // account -> [first, last] date in the CSV
  (incoming || []).forEach((tx) => {
    if (!tx || !tx.date || !tx.account_id) return;
    const r = span.get(tx.account_id);
    if (!r) span.set(tx.account_id, [tx.date, tx.date]);
    else {
      if (tx.date < r[0]) r[0] = tx.date;
      if (tx.date > r[1]) r[1] = tx.date;
    }
  });
  return pairAcrossSources(existing, incoming, (t, tx) => {
    if (!t.simplefin_id) return null;
    const r = span.get(t.account_id);
    if (!r || t.date < r[0] || t.date > r[1]) return null;
    return csvToSyncedGap(tx.date, t);
  });
}

// Brings SimpleFIN transactions into the ledger without ever counting one twice:
//   1. an id already in the ledger (for that SimpleFIN account) is skipped;
//   2. the same transaction already imported from CSV is claimed — stamped with
//      its SimpleFIN id so the next sync recognises it by id — rather than added;
//   3. everything else goes through the CSV importer's reconciliation for one
//      job only — settling a bank hold imported earlier into its posted form —
//      and is otherwise added. Matching fields are not treated as a duplicate
//      here; the id already answered that.
// Claimed rows keep their own id, date, description and labels, so every payment
// link and override pointing at them keeps working.
function mergeSimpleFINTransactions(existing, incoming, windowStart = null) {
  const ledger = (existing || []).map((t) => Object.assign({}, t));
  const key = (acct, id) => `${acct}::${id}`;
  const known = new Set(
    ledger.filter((t) => t && t.simplefin_id && t.simplefin_account).map((t) => key(t.simplefin_account, t.simplefin_id))
  );

  let duplicates = 0;
  const fresh = [];
  (incoming || []).forEach((tx) => {
    const k = key(tx.simplefin_account, tx.simplefin_id);
    if (known.has(k)) {
      duplicates++;
      return;
    }
    known.add(k); // a batch repeating an id counts once
    fresh.push(tx);
  });

  const pairs = matchSimpleFINToLedger(ledger, fresh, windowStart);
  pairs.forEach((i, k) => {
    ledger[i].simplefin_account = fresh[k].simplefin_account;
    ledger[i].simplefin_id = fresh[k].simplefin_id;
    if (fresh[k].simplefin_posted) ledger[i].simplefin_posted = fresh[k].simplefin_posted;
  });
  const rest = fresh.filter((_, k) => !pairs.has(k));

  const r = reconcileImport(ledger, rest, { holdsOnly: true });
  return {
    merged: r.merged,
    added: r.added,
    claimed: pairs.size,
    settled: r.updated,
    duplicates: duplicates + r.skipped,
    unresolved: r.unresolved,
    issues: r.issues || []
  };
}

// The balance to store for a linked account. Banks sign card balances through
// SimpleFIN both ways — some report what's owed as negative, some as positive —
// so a card takes the size of the figure. The one case that reads wrong is a
// card that has been overpaid into credit, which is rare and small.
function simplefinLocalBalance(localAccount, sfAccount) {
  if (!sfAccount || sfAccount.balance == null) return null;
  return localAccount.type === "credit_card" ? round2(Math.abs(sfAccount.balance)) : round2(sfAccount.balance);
}

// What a sync does to loans linked to a SimpleFIN account: each takes the
// lender's balance (its size — lenders report what's owed either sign) as its
// new anchor, dated and timed by the lender. A balance typed after the lender's
// figure is newer and is kept, as for an account. `now` caps a lender's time
// that's ahead of this clock.
function simplefinLoanUpdates(loans, byId, now = new Date().toISOString(), { ambiguous = [] } = {}) {
  const out = { updates: [], kept: [], missing: [], refused: [] };
  (loans || []).forEach((loan) => {
    if (!isLoan(loan) || !loan.simplefin_id) return;
    // The same checks a linked account gets: an id two connections share
    // can't say which is meant, and a balance in another currency isn't dollars.
    if (ambiguous.includes(loan.simplefin_id)) {
      out.refused.push({ loan, why: "two SimpleFIN connections use the same account id, so its balance can't be followed" });
      return;
    }
    const sf = byId.get(loan.simplefin_id);
    if (!sf) {
      out.missing.push(loan);
      return;
    }
    if (sf.currency && sf.currency !== "USD") {
      out.refused.push({ loan, why: `SimpleFIN reports it in ${sf.currency}, and this plugin budgets in dollars` });
      return;
    }
    if (sf.balance == null || !Number.isFinite(Number(sf.balance))) return;
    const at = sf.balanceAt ? (sf.balanceAt < now ? sf.balanceAt : now) : now;
    const a = loan.balance_anchor || {};
    if (a.source && a.source !== "simplefin" && a.at && a.at > at) {
      out.kept.push(loan);
      return;
    }
    out.updates.push({ id: loan.id, amount: round2(Math.abs(Number(sf.balance))), date: sf.balanceDate || toLocalISO(new Date(at)), at, was: loanState(loan).balance });
  });
  return out;
}

// "Chase — Freedom Unlimited · $590.46"
function simplefinAccountLabel(a) {
  if (!a) return "";
  const bal = typeof a.balance === "number" ? ` · $${formatMoneyInput(Math.abs(a.balance))}` : "";
  return `${a.org ? `${a.org} — ` : ""}${a.name || a.id}${bal}`;
}

// Resolves a transaction to its index. An id match is only trusted when it's
// unambiguous AND the record actually looks like the same transaction — a
// duplicate id would otherwise silently resolve to a different row.
function findTxIndex(all, tx) {
  if (tx.id) {
    const matches = [];
    all.forEach((t, i) => {
      if (t.id === tx.id) matches.push(i);
    });
    if (matches.length === 1) {
      const hit = matches[0];
      if (!tx.date || sameTxFields(all[hit], tx)) return hit;
    } else if (matches.length > 1) {
      // Ambiguous id: fall through to field matching rather than guessing.
      const exact = matches.find((i) => sameTxFields(all[i], tx));
      if (exact !== undefined) return exact;
    }
  }
  return all.findIndex((t) => sameTxFields(t, tx));
}

function categoryIncomeTotals(transactions, categories = []) {
  const transferSet = new Set(categories.filter((c) => c.is_transfer).map((c) => c.name));
  const totals = {};
  let transferTotal = 0;
  transactions.forEach((t) => {
    if (t.amount > 0) {
      const cat = t.resolved_category || "Uncategorized";
      if (transferSet.has(cat)) {
        transferTotal += t.amount;
        return;
      }
      totals[cat] = (totals[cat] || 0) + t.amount;
    }
  });
  return { totals, transferTotal };
}

function categorySpendTotals(transactions, categories = []) {
  const transferSet = new Set(categories.filter((c) => c.is_transfer).map((c) => c.name));
  const totals = {};
  let transferTotal = 0;
  transactions.forEach((t) => {
    if (t.amount < 0) {
      const cat = t.resolved_category || "Uncategorized";
      if (transferSet.has(cat)) {
        transferTotal += Math.abs(t.amount);
        return;
      }
      totals[cat] = (totals[cat] || 0) + Math.abs(t.amount);
    }
  });
  return { totals, transferTotal };
}

function buildPieSlices(totals) {
  const entries = Object.entries(totals)
    .filter(([, v]) => v > 0)
    .sort((a, b) => b[1] - a[1]);
  const total = entries.reduce((s, [, v]) => s + v, 0);
  if (total === 0) return { slices: [], total: 0 };

  const cx = 100, cy = 100, r = 90;
  let angle = -90; // start at 12 o'clock
  const slices = entries.map(([cat, val], i) => {
    const fraction = val / total;
    const startAngle = angle;
    const endAngle = angle + fraction * 360;
    angle = endAngle;
    const large = endAngle - startAngle > 180 ? 1 : 0;
    const rad = (deg) => (Math.PI / 180) * deg;
    const x1 = cx + r * Math.cos(rad(startAngle));
    const y1 = cy + r * Math.sin(rad(startAngle));
    const x2 = cx + r * Math.cos(rad(endAngle));
    const y2 = cy + r * Math.sin(rad(endAngle));
    // A near-full-circle single-category case needs two arcs to render correctly
    const path =
      fraction >= 0.9999
        ? `M ${cx - r} ${cy} A ${r} ${r} 0 1 1 ${cx + r} ${cy} A ${r} ${r} 0 1 1 ${cx - r} ${cy} Z`
        : `M ${cx} ${cy} L ${x1.toFixed(2)} ${y1.toFixed(2)} A ${r} ${r} 0 ${large} 1 ${x2.toFixed(2)} ${y2.toFixed(2)} Z`;
    return { path, color: PIE_COLORS[i % PIE_COLORS.length], category: cat, amount: val, pct: fraction * 100 };
  });
  return { slices, total };
}

// ---------- Modals ----------

// Finds the most recent income transaction categorized as a paycheck, so the
// paycheck modal can pre-fill the amount instead of making you look it up.
function findLatestPaycheck(transactions, categoryName = "Paycheck") {
  const candidates = transactions.filter(
    (t) => t.amount > 0 && (t.resolved_category || "") === categoryName
  );
  if (candidates.length === 0) return null;
  return candidates.sort((a, b) => (a.date < b.date ? 1 : a.date > b.date ? -1 : 0))[0];
}

// Deposits that could be the paycheck being entered, newest first: money into a
// checking account, not already filed as something other than a paycheck, and
// dated in this pay period — from three days before it began, since direct
// deposit often lands early. With no pay schedule to go on, the last two weeks.
// Last period's paycheck falls outside either way.
function paycheckDepositCandidates(transactions, accounts, { schedule = null, todayStr = todayLocal(), limit = 3 } = {}) {
  const checking = new Set((accounts || []).filter((a) => a.type === "checking").map((a) => a.id));
  const start = schedule ? currentPeriodStart(schedule, todayStr) : null;
  const from = start ? addDays(start, -3) : addDays(todayStr, -14);
  return (transactions || [])
    .filter((t) => t && t.amount > 0 && t.date && t.date >= from)
    .filter((t) => !checking.size || checking.has(t.account_id))
    .filter((t) => {
      const cat = t.resolved_category || "Uncategorized";
      return cat === "Uncategorized" || cat === "Paycheck";
    })
    .sort((a, b) => (a.date < b.date ? 1 : a.date > b.date ? -1 : b.amount - a.amount))
    .slice(0, limit);
}

// All dates in this plugin are LOCAL calendar dates (YYYY-MM-DD). Using
// toISOString() converts to UTC first, so west of UTC an evening becomes
// tomorrow's date, and east of UTC a parsed local midnight becomes yesterday.
// Both matter here because due dates and pay periods are compared as strings.
function toLocalISO(dateObj) {
  const y = dateObj.getFullYear();
  const m = String(dateObj.getMonth() + 1).padStart(2, "0");
  const d = String(dateObj.getDate()).padStart(2, "0");
  return `${y}-${m}-${d}`;
}

// A real calendar date in YYYY-MM-DD. The pattern alone isn't enough: Date
// silently rolls 2026-02-31 forward to March 3, so the round-trip is what
// actually rejects it.
function isISODateString(value) {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(value || "")) return false;
  const d = new Date(`${value}T00:00:00`);
  return !isNaN(d.getTime()) && toLocalISO(d) === value;
}

function todayLocal() {
  return toLocalISO(new Date());
}

function daysBetween(fromStr, toStr) {
  const from = new Date(`${fromStr}T00:00:00`);
  const to = new Date(`${toStr}T00:00:00`);
  return Math.round((to - from) / 86400000);
}

// Returns an error message string, or null if the date is usable.
function validateNextPayday(nextPaydayStr, todayStr = todayLocal()) {
  if (!nextPaydayStr || !nextPaydayStr.trim()) {
    return "Pick your next expected payday.";
  }
  const normalized = normalizeDate(nextPaydayStr.trim());
  if (!/^\d{4}-\d{2}-\d{2}$/.test(normalized)) {
    return `"${nextPaydayStr}" isn't a valid date.`;
  }
  const parsed = new Date(`${normalized}T00:00:00`);
  if (isNaN(parsed.getTime())) {
    return `"${nextPaydayStr}" isn't a real calendar date.`;
  }
  // JS silently rolls invalid days over (Feb 30 -> Mar 2), so verify the parsed
  // date still matches what was typed before trusting it.
  const [y, m, d] = normalized.split("-").map(Number);
  if (parsed.getFullYear() !== y || parsed.getMonth() + 1 !== m || parsed.getDate() !== d) {
    return `"${nextPaydayStr}" isn't a real calendar date — check the day of the month.`;
  }
  const diff = daysBetween(todayStr, normalized);
  if (diff < 0) {
    return `That payday (${normalized}) is in the past. Enter your NEXT payday, not the last one.`;
  }
  if (diff > 35) {
    return `That payday (${normalized}) is ${diff} days away. A pay period over 35 days is almost certainly a typo — check the year and month.`;
  }
  return null;
}

// ---------- label inbox ----------

// Open/closed state for the Transactions tab's label inbox. It only sets a class
// and ARIA; the stylesheet does the motion. Uses nothing but the methods
// Obsidian adds to every element (toggleClass, setAttr, setText), so the same
// function runs unchanged in a plain browser under test.
function bindInboxToggle({ inbox, badge, action }, { open = false, onChange = null } = {}) {
  let state = !!open;
  const apply = () => {
    inbox.toggleClass("budget-inbox-open", state);
    badge.setAttr("aria-expanded", state ? "true" : "false");
    if (action) action.setText(state ? "Hide" : "Review");
  };
  apply();
  badge.addEventListener("click", () => {
    state = !state;
    apply();
    if (onChange) onChange(state);
  });
  return { isOpen: () => state };
}

// ---------- form inputs ----------

// Where a live message about a field goes: under the field's description, so it
// reads as part of the setting rather than a stray line beside the input.
function fieldNoteHost(setting, input) {
  return (setting && (setting.descEl || setting.settingEl)) || (input && input.parentElement) || null;
}

// One message line under a field, created on first use and reused after, so
// repeated keystrokes update it in place rather than stacking lines.
function fieldNote(host, cls) {
  let el = null;
  return (text, { warn = false } = {}) => {
    if (!host) return;
    if (!text) {
      if (el) {
        el.remove();
        el = null;
      }
      return;
    }
    if (!el) el = host.createDiv({ cls });
    el.setText(text);
    el.toggleClass("budget-field-note-warn", !!warn);
  };
}

// A calendar picker instead of a typed YYYY-MM-DD field. A native date input
// always reports YYYY-MM-DD, or "" when cleared, so validation and storage are
// untouched — only how the date gets chosen changes. `month` gives a YYYY-MM
// month picker instead.
function bindDateInput(text, value, { month = false } = {}) {
  const input = text.inputEl;
  input.type = month ? "month" : "date";
  input.addClass("budget-date-input");
  const raw = String(value == null ? "" : value).trim();
  const clean = month ? raw : normalizeDate(raw) || "";
  const ok = month ? /^\d{4}-\d{2}$/.test(clean) : isISODateString(clean);
  text.setValue(ok ? clean : "");
  return text;
}

// Reads money the way a person types it: "$1,234.50", " 1234.5 ", "-40", "-$40"
// and "(40)" all mean what they look like. Anything else is refused with a
// reason. parseFloat reads "12abc" as 12 and "1,234" as 1, and a trailing
// "|| 0" turned every typo into a silent $0 — this is what replaces both.
//
// `percent` reads an APR instead: a trailing % is allowed, up to three decimals.
function parseMoneyInput(raw, { allowNegative = false, percent = false } = {}) {
  const fail = (message) => ({ ok: false, empty: false, value: null, message });
  let s = String(raw == null ? "" : raw).trim();
  if (!s) return { ok: true, empty: true, value: null, message: null };

  let negative = false;
  if (/^\(.*\)$/.test(s)) {
    negative = true;
    s = s.slice(1, -1);
  }
  s = s.replace(/\s+/g, "");
  if (percent) s = s.replace(/%$/, "");
  else s = s.replace(/^\$/, "");
  if (s.startsWith("-")) {
    negative = !negative;
    s = s.slice(1);
  }
  if (!percent) s = s.replace(/^\$/, "");

  if (!/\d/.test(s) || !/^[\d,]*\.?\d*$/.test(s)) {
    return fail(percent ? "Not a percentage — digits only, like 24.99." : "Not an amount — digits only, like 1250.00.");
  }
  const [whole, frac = ""] = s.split(".");
  if (whole.includes(",") && !/^\d{1,3}(,\d{3})+$/.test(whole)) {
    return fail("Commas only go between thousands, like 1,250.00.");
  }
  const maxDecimals = percent ? 3 : 2;
  if (frac.length > maxDecimals) {
    return fail(percent ? "Three decimal places at most." : "Cents only go two places, like 12.50.");
  }
  const magnitude = Number(`${whole.replace(/,/g, "") || "0"}.${frac || "0"}`);
  if (negative && magnitude !== 0 && !allowNegative) return fail("Can’t be negative here.");
  return { ok: true, empty: false, value: negative ? -magnitude : magnitude, message: null };
}

// The canonical form a money field settles into once you leave it: two places
// and thousands separators. Percentages keep only the precision they had.
function formatMoneyInput(value, { percent = false } = {}) {
  if (typeof value !== "number" || !isFinite(value)) return "";
  if (percent) return String(Math.round(value * 1000) / 1000);
  const fixed = Math.abs(value).toFixed(2);
  const [whole, cents] = fixed.split(".");
  return `${value < 0 ? "-" : ""}${whole.replace(/\B(?=(\d{3})+(?!\d))/g, ",")}.${cents}`;
}

// The save-side gate that pairs with bindMoneyInput. It runs the same parser, so
// a field that showed no error can't then be refused at save, and one that did
// can't slip through. Returns the number, or null after saying what's wrong.
// An empty optional field comes back as `fallback`.
function requireMoney(raw, label, opts = {}) {
  const { allowNegative = false, percent = false, optional = false } = opts;
  // Not a destructuring default: `fallback: undefined` is a real request (an
  // unset credit limit), and a default would quietly turn it into 0.
  const fallback = Object.prototype.hasOwnProperty.call(opts, "fallback") ? opts.fallback : 0;
  const r = parseMoneyInput(raw, { allowNegative, percent });
  if (!r.ok) {
    new Notice(`${label}: ${r.message}`);
    return null;
  }
  if (r.empty) {
    if (optional) return fallback;
    new Notice(`Enter the ${label.toLowerCase()}.`);
    return null;
  }
  return r.value;
}

// Live checking for a money field. It deliberately doesn't filter keystrokes —
// rewriting a field under the caret while you type fights you. It checks every
// keystroke, says what's wrong under the field for as long as it's wrong, and
// tidies the number into its canonical form once you leave. The tidied value is
// sent through the field's own change handler so the owner's copy agrees.
//
// Returns the text component for chaining; `text.moneyCheck()` re-runs the check
// for code that writes the field programmatically.
function bindMoneyInput(text, setting, opts = {}) {
  const input = text.inputEl;
  // The iOS decimal pad has no minus key, so fields that may go negative keep
  // the full keyboard.
  if (!opts.allowNegative) input.setAttr("inputmode", "decimal");
  input.setAttr("autocomplete", "off");
  input.setAttr("spellcheck", "false");
  input.addClass("budget-money-input");

  const note = fieldNote(fieldNoteHost(setting, input), "budget-field-note budget-field-error");
  const check = () => {
    const r = parseMoneyInput(input.value, opts);
    note(r.ok ? null : r.message, { warn: true });
    input.toggleClass("budget-input-invalid", !r.ok);
    input.setAttr("aria-invalid", r.ok ? "false" : "true");
    return r;
  };
  input.addEventListener("input", check);
  input.addEventListener("blur", () => {
    const r = check();
    if (!r.ok || r.empty) return;
    const tidy = formatMoneyInput(r.value, opts);
    if (tidy === input.value) return;
    input.value = tidy;
    if (typeof input.dispatchEvent === "function" && typeof Event === "function") {
      input.dispatchEvent(new Event("input", { bubbles: true }));
    }
  });
  text.moneyCheck = check;
  return text;
}

// The live "what would this pattern catch" line under a merchant-pattern field.
// Returns a refresh function to call with the current pattern.
function bindPatternReach(setting, { transactions, rules, selfIndex = null, sample = null }) {
  const note = fieldNote(fieldNoteHost(setting, null), "budget-field-note budget-match-count");
  return (pattern) => {
    const d = describePatternReach(patternReach(pattern, transactions, rules, selfIndex), sample, pattern);
    note(d.text, { warn: d.warn });
  };
}

// The first-run tour. Plain data so the wording is easy to find and test;
// **double asterisks** mark the names of things you'll see on screen.
const TOUR_PAGES = [
  { title: "Welcome", body: "Budget Tracker works out what you owe before your next paycheck and what's left to spend. This quick tour takes a minute." },
  { title: "How it thinks", body: "Bills, debt payments and savings come first. What's left is yours to spend until payday." },
  { title: "Set up your files", body: "Press **Set up** in settings once. It creates the Budget folder in your vault, where your data stays. If you use Obsidian Sync, turn on **Sync all other types** in Settings → Sync, or your data won't reach your other devices." },
  { title: "Enter your most recent paycheck", body: "Run **Enter paycheck** and give it two dates: when your latest paycheck arrived, and when you expect the next one. From those two dates the plugin works out your pay cadence, and every pay period after that follows it." },
  { title: "Add what you owe", body: "On the Debts tab, add cards, loans and buy-now-pay-later plans. Bills and subscriptions go in Settings." },
  { title: "Bring in transactions", body: "Import a CSV from your bank, or connect SimpleFIN to sync. Then label each merchant yourself and set a rule for it. It's upfront work, but once your transactions are classified, the plugin sorts new ones for you." },
  { title: "Pick your focus", body: "Debt reduction sends spare cash to debt. Savings focus sends it to your goals. Switch any time and everything updates." },
  { title: "You're set", body: "Reopen this tour any time from the command palette: **Budget Tracker: Show tour**." }
];

// Splits "a **b** c" into [text, bold] pieces for building spans without innerHTML.
function tourSegments(text) {
  return String(text).split("**").map((t, i) => ({ text: t, bold: i % 2 === 1 })).filter((p) => p.text);
}

class IntroTourModal extends Modal {
  constructor(app, onClose = () => {}) {
    super(app);
    this.page = 0;
    this.onCloseCb = onClose;
  }
  onOpen() {
    this.modalEl.addClass("budget-tour-modal");
    this.draw();
  }
  draw() {
    const { contentEl } = this;
    contentEl.empty();
    const p = TOUR_PAGES[this.page];
    const last = this.page === TOUR_PAGES.length - 1;
    contentEl.createDiv({ cls: "budget-muted budget-tour-step", text: `${this.page + 1} of ${TOUR_PAGES.length}` });
    contentEl.createEl("h2", { text: p.title });
    const body = contentEl.createEl("p", { cls: "budget-tour-body" });
    tourSegments(p.body).forEach((seg) => (seg.bold ? body.createEl("strong", { text: seg.text }) : body.createSpan({ text: seg.text })));
    const row = contentEl.createDiv({ cls: "budget-tour-btns" });
    if (!last) {
      const skip = row.createEl("button", { text: "Skip tour", cls: "budget-btn" });
      skip.onclick = () => this.close();
    }
    if (this.page > 0) {
      const back = row.createEl("button", { text: "Back", cls: "budget-btn" });
      back.onclick = () => {
        this.page--;
        this.draw();
      };
    }
    const next = row.createEl("button", { text: last ? "Done" : "Next", cls: "budget-btn mod-cta" });
    next.onclick = () => {
      if (last) return this.close();
      this.page++;
      this.draw();
    };
  }
  onClose() {
    this.contentEl.empty();
    this.onCloseCb();
  }
}

// The export dialog. Each row does its job and closes the dialog.
class ExportModal extends Modal {
  constructor(app, actions) {
    super(app);
    this.actions = actions;
    this.kind = EXPORT_KINDS[0].key;
  }
  onOpen() {
    const { contentEl } = this;
    contentEl.createEl("h2", { text: "Export" });
    const go = (fn) => () => {
      this.close();
      return fn();
    };
    new Setting(contentEl)
      .setName("Snapshot")
      .setDesc("Where you stand today, in one note and a CSV. Also copied.")
      .addButton((b) => b.setButtonText("Export").setCta().onClick(go(() => this.actions.snapshot())));
    new Setting(contentEl)
      .setName("Full export")
      .setDesc("The snapshot, plus a note for each kind of data.")
      .addButton((b) => b.setButtonText("Export").onClick(go(() => this.actions.full())));
    new Setting(contentEl)
      .setName("One kind of data")
      .addDropdown((dd) => {
        EXPORT_KINDS.forEach((k) => dd.addOption(k.key, k.label));
        dd.setValue(this.kind).onChange((v) => (this.kind = v));
      })
      .addButton((b) => b.setButtonText("Export").onClick(go(() => this.actions.kind(this.kind))));
  }
  onClose() {
    this.contentEl.empty();
  }
}

// Add a transaction by hand.
class ManualTransactionModal extends Modal {
  constructor(app, { accounts, categories, rules }, onSubmit) {
    super(app);
    this.accounts = accounts;
    this.categories = categories;
    this.rules = rules;
    this.onSubmit = onSubmit;
  }
  onOpen() {
    const { contentEl } = this;
    contentEl.createEl("h2", { text: "Add transaction" });
    const form = { date: todayLocal(), merchant: "", amount: "", direction: "out", account_id: this.accounts[0].id, category: "" };
    new Setting(contentEl).setName("Date").addText((t) => bindDateInput(t, form.date).onChange((v) => (form.date = v.trim())));
    new Setting(contentEl).setName("What it was for").addText((t) => t.setPlaceholder("Merchant or note").onChange((v) => (form.merchant = v)));
    const amountRow = new Setting(contentEl).setName("Amount");
    amountRow.addDropdown((dd) => {
      dd.addOption("out", "Money out");
      dd.addOption("in", "Money in");
      dd.setValue("out").onChange((v) => (form.direction = v));
    });
    amountRow.addText((t) => bindMoneyInput(t, amountRow, {}).onChange((v) => (form.amount = v)));
    new Setting(contentEl).setName("Account").addDropdown((dd) => {
      this.accounts.forEach((a) => dd.addOption(a.id, accountLabel(a)));
      dd.setValue(form.account_id).onChange((v) => (form.account_id = v));
    });
    new Setting(contentEl).setName("Category").addDropdown((dd) => {
      dd.addOption("", "Automatic");
      this.categories.forEach((c) => dd.addOption(c, c));
      dd.setValue("").onChange((v) => (form.category = v));
    });
    const error = contentEl.createDiv({ cls: "budget-field-error" });
    new Setting(contentEl)
      .addButton((b) => b.setButtonText("Cancel").onClick(() => this.close()))
      .addButton((b) =>
        b.setButtonText("Add").setCta().onClick(() => {
          const r = buildManualTransaction(form, this.rules);
          if (!r.ok) {
            error.setText(r.error);
            return;
          }
          this.close();
          this.onSubmit(r.tx);
        })
      );
  }
  onClose() {
    this.contentEl.empty();
  }
}

// Type in what an investment account is worth on a date.
class ManualBalanceModal extends Modal {
  constructor(app, { accounts }, onSubmit) {
    super(app);
    this.accounts = accounts;
    this.onSubmit = onSubmit;
  }
  onOpen() {
    const { contentEl } = this;
    contentEl.createEl("h2", { text: "Add balance" });
    const form = { account_id: this.accounts[0].id, date: todayLocal(), value: "" };
    new Setting(contentEl).setName("Account").addDropdown((dd) => {
      this.accounts.forEach((a) => dd.addOption(a.id, a.label));
      dd.setValue(form.account_id).onChange((v) => (form.account_id = v));
    });
    new Setting(contentEl).setName("As of").addText((t) => bindDateInput(t, form.date).onChange((v) => (form.date = v.trim())));
    const valueRow = new Setting(contentEl).setName("Worth");
    valueRow.addText((t) => bindMoneyInput(t, valueRow, {}).onChange((v) => (form.value = v)));
    const error = contentEl.createDiv({ cls: "budget-field-error" });
    new Setting(contentEl)
      .addButton((b) => b.setButtonText("Cancel").onClick(() => this.close()))
      .addButton((b) =>
        b.setButtonText("Save").setCta().onClick(() => {
          const r = buildManualBalance(form);
          if (!r.ok) {
            error.setText(r.error);
            return;
          }
          this.close();
          this.onSubmit(r.snapshot);
        })
      );
  }
  onClose() {
    this.contentEl.empty();
  }
}

class PaycheckModal extends Modal {
  constructor(app, onSubmit, prefill = {}) {
    super(app);
    this.onSubmit = onSubmit;
    this.prefill = prefill;
  }
  onOpen() {
    const { contentEl } = this;
    contentEl.createEl("h2", { text: "Enter Paycheck" });

    const detected = this.prefill.detectedPaycheck || null;
    const scheduled = this.prefill.scheduledNextPayday || null;
    const deposits = this.prefill.recentDeposits || [];
    const rules = this.prefill.rules || [];
    // A deposit already filed as a paycheck in this period is this paycheck.
    // An unfiled one is only picked by the user: choosing it files it as
    // Paycheck, and that shouldn't happen to a refund because it was newest.
    let chosen = deposits.find((t) => t.resolved_category === "Paycheck") || null;
    let amount = chosen ? chosen.amount.toFixed(2) : detected ? detected.amount.toFixed(2) : "";
    let nextPayday = scheduled || "";
    let checking = this.prefill.checkingBalance != null ? String(this.prefill.checkingBalance) : "";
    let alreadyDeposited = true;
    let amountText = null;
    let hint = null;
    const radios = [];

    const choose = (t, { fill = true } = {}) => {
      chosen = t;
      radios.forEach((r) => {
        r.input.checked = r.tx === t;
        r.row.toggleClass("budget-apply-chosen", r.tx === t && !!t);
      });
      // The last-paycheck hint describes an amount a picked deposit replaces.
      if (hint) hint.style.display = t ? "none" : "";
      if (t && fill) {
        amount = t.amount.toFixed(2);
        if (amountText) {
          amountText.setValue(amount);
          amountText.moneyCheck();
        }
      }
    };

    if (deposits.length) {
      contentEl.createEl("p", {
        text: "Recent deposits to checking. Pick the one that's this paycheck and it's filed as Paycheck:",
        cls: "budget-muted budget-apply-scope"
      });
      const list = contentEl.createDiv({ cls: "budget-apply-list budget-deposit-list" });
      const addRow = (t) => {
        const row = list.createEl("label", { cls: "budget-apply-row budget-deposit-row" });
        const input = row.createEl("input", { type: "radio" });
        input.name = "budget-paycheck-deposit";
        input.onchange = () => {
          if (input.checked) choose(t);
        };
        radios.push({ tx: t, input, row });
        const label = row.createDiv({ cls: "budget-apply-label" });
        if (t) {
          label.createDiv({ text: displayMerchant(t.merchant_raw, rules) || "Deposit" }).setAttr("title", t.merchant_raw || "");
          const meta = label.createDiv({ cls: "budget-apply-meta" });
          meta.createSpan({ text: t.date });
          meta.createSpan({ text: t.resolved_category || "Uncategorized" });
          if (t.pending) meta.createSpan({ text: "pending" });
          row.createSpan({ text: `+$${t.amount.toFixed(2)}`, cls: "budget-amount budget-positive" });
        } else {
          label.createDiv({ text: "None of these" });
        }
      };
      deposits.forEach(addRow);
      addRow(null);
      choose(chosen, { fill: false });
    }

    if (detected) {
      hint = contentEl.createEl("p", {
        text: `Auto-filled from your most recent Paycheck transaction: $${detected.amount.toFixed(2)} on ${detected.date} (${guessMerchantKey(detected.merchant_raw)}). Change it if this check differs.`,
        cls: "budget-muted budget-autodetect-hint"
      });
      if (chosen) hint.style.display = "none";
    }

    const amountSetting = new Setting(contentEl).setName("Paycheck amount");
    amountSetting.addText((t) => {
      amountText = bindMoneyInput(t, amountSetting)
        .setValue(amount)
        .onChange((v) => {
          amount = v;
          // A typed amount that isn't the chosen deposit's means it isn't that
          // deposit. (The field tidies to "1,748.95" on leaving, which still is.)
          if (!chosen) return;
          const r = parseMoneyInput(v);
          if (!r.ok || r.empty || Math.abs(r.value - chosen.amount) > 0.005) choose(null, { fill: false });
        });
    });
    if (detected) {
      amountSetting.addExtraButton((b) =>
        b
          .setIcon("rotate-ccw")
          .setTooltip("Reset to detected amount")
          .onClick(() => {
            amount = detected.amount.toFixed(2);
            if (chosen && Math.abs(chosen.amount - detected.amount) > 0.005) choose(null, { fill: false });
            if (amountText) {
              amountText.setValue(amount);
              amountText.moneyCheck();
            }
          })
      );
    }

    new Setting(contentEl)
      .setName("Has this paycheck already hit your checking account?")
      .setDesc(
        "On = your checking balance below already includes it, so it won't be added twice. " +
          "Off = you're entering it ahead of time and your balance below doesn't include it yet."
      )
      .addToggle((tg) => tg.setValue(true).onChange((v) => (alreadyDeposited = v)));

    const checkingSetting = new Setting(contentEl)
      .setName("Current checking balance")
      .setDesc("Your actual balance right now, whatever the account says today.");
    checkingSetting.addText((t) =>
      bindMoneyInput(t, checkingSetting, { allowNegative: true }).setValue(checking).onChange((v) => (checking = v))
    );

    const paydaySetting = new Setting(contentEl).setName("Next expected payday");
    if (scheduled) {
      paydaySetting.setDesc(
        `Filled in from your pay schedule (${this.prefill.scheduleLabel}). Only change this for an off-cycle check.`
      );
    } else {
      paydaySetting.setDesc("Set a pay schedule in Settings and this fills itself in from now on.");
    }
    paydaySetting.addText((t) => bindDateInput(t, nextPayday).onChange((v) => (nextPayday = v)));
    new Setting(contentEl).addButton((b) =>
      b
        .setButtonText("Calculate")
        .setCta()
        .onClick(() => {
          const error = validateNextPayday(nextPayday);
          if (error) {
            new Notice(error, 6000);
            return; // keep the modal open so the value can be corrected
          }
          // Blank still means zero, as it always has. A typo no longer does.
          const paycheckAmount = requireMoney(amount, "Paycheck amount", { optional: true });
          if (paycheckAmount == null) return;
          const checkingBalance = requireMoney(checking, "Checking balance", { allowNegative: true, optional: true });
          if (checkingBalance == null) return;
          this.close();
          this.onSubmit({
            paycheckAmount,
            checkingBalance,
            alreadyDeposited,
            nextPaydayStr: nextPayday,
            deposit: chosen
          });
        })
    );
  }
  onClose() {
    this.contentEl.empty();
  }
}

// Handles both creating and editing a BNPL plan. Installment amount, count and
// total balance are kept in sync live: editing any two updates the third.
// A loan: what it is, what's owed and since when, the rate, the payment and
// when it's due, and — optionally — the lender's SimpleFIN account for its
// balance. The things most loans never change (what it's worth, the category
// its payments are filed under, whether spare cash goes toward it) are folded
// under More. `sfChoices` are SimpleFIN accounts from the last sync.
class LoanModal extends Modal {
  constructor(app, { existing = null, prefill = null, sfChoices = [] } = {}, onSubmit) {
    super(app);
    this.existing = existing;
    this.prefill = prefill;
    this.sfChoices = sfChoices || [];
    this.onSubmit = onSubmit;
  }
  onOpen() {
    const { contentEl } = this;
    const e = this.existing || this.prefill || {};
    const isEdit = !!(this.existing && this.existing.id);
    const started = isEdit && (this.existing.applied_payments || []).length > 0;
    contentEl.createEl("h2", { text: isEdit ? `Edit ${debtLabel(this.existing)}` : "Add a loan" });
    const anchor = e.balance_anchor || {};
    const d = {
      type: LOAN_TYPES[e.loan_type] ? e.loan_type : "car",
      name: e.provider || "",
      balance: isEdit ? String(loanState(this.existing).balance) : anchor.amount != null ? String(anchor.amount) : "",
      asOf: isEdit ? todayLocal() : anchor.date || todayLocal(),
      apr: e.apr != null ? String(e.apr) : "",
      payment: e.installment_amount != null ? String(e.installment_amount) : "",
      escrow: e.escrow ? String(e.escrow) : "",
      due: e.next_due_date || "",
      category: e.payment_category || "",
      value: e.estimated_value ? String(e.estimated_value) : "",
      sf: e.simplefin_id || "",
      extra: typeof e.extra_payments === "boolean" ? e.extra_payments : null
    };
    // Compared as numbers: the field tidies "24788.47" to "24,788.47" when you
    // leave it, and that isn't a change.
    const startBalance = parseMoneyInput(d.balance, {}).ok ? round2(parseMoneyInput(d.balance, {}).value || 0) : null;
    let escrowSetting = null;
    let categoryText = null;
    let extraToggle = null;

    new Setting(contentEl).setName("Type").addDropdown((dd) => {
      Object.entries(LOAN_TYPES).forEach(([k, v]) => dd.addOption(k, v.label));
      dd.setValue(d.type).onChange((v) => {
        const before = LOAN_TYPES[d.type];
        d.type = v;
        if (escrowSetting) escrowSetting.settingEl.toggleClass("budget-hidden", v !== "mortgage");
        // Defaults follow the type until you've changed them yourself.
        if (!d.category || d.category === before.category) {
          d.category = LOAN_TYPES[v].category;
          if (categoryText) categoryText.setValue(d.category);
        }
        if (d.extra === null && extraToggle) extraToggle.setValue(LOAN_TYPES[v].extra);
      });
    });
    new Setting(contentEl)
      .setName("Name")
      .addText((t) => t.setPlaceholder("e.g. Credit union auto loan").setValue(d.name).onChange((v) => (d.name = v)));
    const balSetting = new Setting(contentEl)
      .setName("Balance")
      .setDesc(isEdit ? "What you owe now. Change it only to correct it." : "What you owe. For a new loan, the amount financed.");
    balSetting.addText((t) => bindMoneyInput(t, balSetting).setValue(d.balance).onChange((v) => (d.balance = v)));
    new Setting(contentEl)
      .setName("As of")
      .setDesc(isEdit ? "Only used if you change the balance." : "The funding date, or your last payment date if you're already paying it. Interest counts from here.")
      .addText((t) => bindDateInput(t, d.asOf).onChange((v) => (d.asOf = v)));
    const aprSetting = new Setting(contentEl).setName("APR (%)");
    aprSetting.addText((t) => bindMoneyInput(t, aprSetting, { percent: true }).setValue(d.apr).onChange((v) => (d.apr = v)));
    const paySetting = new Setting(contentEl).setName("Monthly payment");
    paySetting.addText((t) => bindMoneyInput(t, paySetting).setValue(d.payment).onChange((v) => (d.payment = v)));
    escrowSetting = new Setting(contentEl)
      .setName("Escrow in that payment")
      .setDesc("Taxes and insurance collected with the payment. They don't lower the balance.");
    escrowSetting.addText((t) => bindMoneyInput(t, escrowSetting).setValue(d.escrow).onChange((v) => (d.escrow = v)));
    escrowSetting.settingEl.toggleClass("budget-hidden", d.type !== "mortgage");
    new Setting(contentEl)
      .setName(started ? "Next payment" : "First payment")
      .setDesc(started ? "" : "Nothing is set aside for it until the pay period this falls in.")
      .addText((t) => bindDateInput(t, d.due).onChange((v) => (d.due = v)));

    const choices = this.sfChoices.slice();
    if (d.sf && !choices.some((c) => c.id === d.sf)) choices.unshift({ id: d.sf, label: `${d.sf} (not in the last sync)` });
    new Setting(contentEl)
      .setName("Balance from SimpleFIN")
      .setDesc(
        choices.length
          ? "The lender's own balance at each sync. Not linked, the balance is worked out from your payments."
          : "No SimpleFIN accounts yet. To use the lender's balance, add the lender in SimpleFIN Bridge, sync, then edit the loan."
      )
      .addDropdown((dd) => {
        dd.addOption("", "Not linked — calculate it");
        choices.forEach((c) => dd.addOption(c.id, c.label));
        dd.setValue(d.sf).onChange((v) => (d.sf = v));
      });

    const more = contentEl.createEl("details", { cls: "budget-loan-more" });
    more.createEl("summary", { text: "More" });
    const valueSetting = new Setting(more).setName("What it's worth (optional)").setDesc("For equity: worth less owed. Update it now and then.");
    valueSetting.addText((t) => bindMoneyInput(t, valueSetting).setValue(d.value).onChange((v) => (d.value = v)));
    new Setting(more)
      .setName("Payment category")
      .setDesc("Its payments are filed under this, so Apply Payment can find them.")
      .addText((t) => {
        categoryText = t;
        t.setValue(d.category || LOAN_TYPES[d.type].category).onChange((v) => (d.category = v));
      });
    if (!d.category) d.category = LOAN_TYPES[d.type].category;
    new Setting(more)
      .setName("Put spare cash toward it")
      .setDesc("In Debt Reduction, ranked by APR after higher-rate debts.")
      .addToggle((tg) => {
        extraToggle = tg;
        tg.setValue(d.extra === null ? LOAN_TYPES[d.type].extra : d.extra).onChange((v) => (d.extra = v));
      });

    new Setting(contentEl).addButton((b) =>
      b
        .setButtonText(isEdit ? "Save" : "Add loan")
        .setCta()
        .onClick(() => {
          if (!d.name.trim()) {
            new Notice("Give the loan a name.");
            return;
          }
          const balance = requireMoney(d.balance, "Balance");
          if (balance == null) return;
          const apr = requireMoney(d.apr, "APR", { percent: true, optional: true });
          if (apr == null) return;
          const payment = requireMoney(d.payment, "Monthly payment");
          if (payment == null) return;
          if (!(payment > 0)) {
            new Notice("The monthly payment has to be more than $0.");
            return;
          }
          const escrow = d.type === "mortgage" ? requireMoney(d.escrow, "Escrow", { optional: true }) : 0;
          if (escrow == null) return;
          if (escrow >= payment) {
            new Notice("Escrow has to be less than the whole payment.");
            return;
          }
          const value = requireMoney(d.value, "What it's worth", { optional: true });
          if (value == null) return;
          const due = normalizeDate(String(d.due || "").trim());
          if (!/^\d{4}-\d{2}-\d{2}$/.test(due || "")) {
            new Notice(`Pick the ${started ? "next" : "first"} payment date.`);
            return;
          }
          const asOf = normalizeDate(String(d.asOf || "").trim()) || todayLocal();
          if (!/^\d{4}-\d{2}-\d{2}$/.test(asOf)) {
            new Notice("Pick the date the balance is from.");
            return;
          }
          this.close();
          this.onSubmit({
            loan_type: d.type,
            name: d.name.trim(),
            balance: round2(balance),
            balanceChanged: !isEdit || round2(balance) !== startBalance,
            asOf,
            apr: round2(apr),
            payment: round2(payment),
            escrow: round2(escrow || 0),
            due,
            category: (d.category || LOAN_TYPES[d.type].category).trim(),
            value: value > 0 ? round2(value) : null,
            simplefin_id: d.sf || null,
            extra: d.extra
          });
        })
    );
  }
  onClose() {
    this.contentEl.empty();
  }
}

// How a loan ends. Sold: what it sold for, the payoff and costs, and what came
// to you (or what you covered). Traded in: its trade-in value against the
// payoff, carried into the next loan. Refinanced: the payoff the new loan
// starts from. Paid off: just the date. For a sale, the money that moved can be
// picked out so it's filed right — proceeds aren't income, a shortfall is a
// payment on the loan. `candidates(sign, amount, date)` supplies the choices.
class CloseLoanModal extends Modal {
  constructor(app, loan, { candidates = () => [], rules = [] } = {}, onSubmit, onDelete = null) {
    super(app);
    this.loan = loan;
    this.candidates = candidates;
    this.rules = rules;
    this.onSubmit = onSubmit;
    this.onDelete = onDelete;
  }
  onOpen() {
    const { contentEl } = this;
    const this_ = this;
    const loan = this.loan;
    const balance = loanState(loan).balance;
    contentEl.createEl("h2", { text: `Close ${debtLabel(loan)}` });
    const d = { reason: "sold", date: todayLocal(), price: "", payoff: balance ? String(balance) : "", fees: "", tx: null };
    const shown = { price: ["sold", "traded"], payoff: ["sold", "traded", "refinanced"], fees: ["sold"] };
    const settings = {};
    const refresh = () => {
      Object.entries(shown).forEach(([k, reasons]) => settings[k] && settings[k].settingEl.toggleClass("budget-hidden", !reasons.includes(d.reason)));
      if (settings.price) settings.price.nameEl && settings.price.setName(d.reason === "traded" ? "Trade-in value" : "Sold for");
      drawResult();
    };
    new Setting(contentEl).setName("What happened").addDropdown((dd) => {
      [["sold", "Sold it"], ["traded", "Traded it in"], ["refinanced", "Refinanced"], ["paid", "Paid it off"]].forEach(([k, v]) => dd.addOption(k, v));
      dd.setValue(d.reason).onChange((v) => {
        d.reason = v;
        d.tx = null;
        refresh();
      });
    });
    new Setting(contentEl).setName("Date").addText((t) => bindDateInput(t, d.date).onChange((v) => ((d.date = v), drawResult())));
    settings.price = new Setting(contentEl).setName("Sold for");
    settings.price.addText((t) => bindMoneyInput(t, settings.price).onChange((v) => ((d.price = v), drawResult())));
    settings.payoff = new Setting(contentEl).setName("Payoff amount").setDesc("What the lender needed to close it, from their payoff quote.");
    settings.payoff.addText((t) => bindMoneyInput(t, settings.payoff).setValue(d.payoff).onChange((v) => ((d.payoff = v), drawResult())));
    settings.fees = new Setting(contentEl).setName("Selling costs (optional)");
    settings.fees.addText((t) => bindMoneyInput(t, settings.fees).onChange((v) => ((d.fees = v), drawResult())));

    const resultEl = contentEl.createDiv({ cls: "budget-loan-result" });
    const pickEl = contentEl.createDiv({ cls: "budget-loan-pick" });
    const num = (v) => {
      const r = parseMoneyInput(v, {});
      return r.ok && !r.empty ? r.value : null;
    };
    const outcome = () => {
      const price = num(d.price);
      const payoff = num(d.payoff);
      const fees = num(d.fees) || 0;
      if (d.reason === "sold" && price != null && payoff != null) return round2(price - payoff - fees);
      if (d.reason === "traded" && price != null && payoff != null) return round2(price - payoff);
      return null;
    };
    const money = (v) => `$${Math.abs(v).toFixed(2)}`;
    function drawResult() {
      resultEl.empty();
      pickEl.empty();
      const r = outcome();
      if (d.reason !== "sold") d.tx = null;
      if (r == null) {
        d.tx = null;
        return;
      }
      resultEl.setText(
        d.reason === "sold"
          ? r >= 0
            ? `${money(r)} to you.`
            : `You covered ${money(r)} — it sold for less than was owed.`
          : r >= 0
            ? `${money(r)} toward the next one.`
            : `${money(r)} owed on it carries into the next loan.`
      );
      if (d.reason !== "sold" || Math.abs(r) < 0.005) {
        d.tx = null;
        return;
      }
      // The money that moved, so it's filed as what it is.
      const list = this_.candidates(r > 0 ? 1 : -1, Math.abs(r), d.date);
      // A pick that's no longer on the list (the result changed sign) isn't a pick.
      if (d.tx && !list.some((t) => t.id === d.tx)) d.tx = null;
      if (!list.length) return;
      pickEl.createDiv({ text: r > 0 ? "Which deposit was it?" : "Which payment covered it?", cls: "budget-loan-pick-title" });
      const none = pickEl.createEl("label", { cls: "budget-loan-pick-row" });
      const noneInput = none.createEl("input", { attr: { type: "radio", name: "budget-loan-pick" } });
      noneInput.checked = !d.tx;
      noneInput.onchange = () => (d.tx = null);
      none.createSpan({ text: "None of these / not yet" });
      list.forEach((t) => {
        const row = pickEl.createEl("label", { cls: "budget-loan-pick-row" });
        const input = row.createEl("input", { attr: { type: "radio", name: "budget-loan-pick" } });
        input.checked = d.tx === t.id;
        input.onchange = () => (d.tx = t.id);
        row.createSpan({ text: `${t.date} · ${displayMerchant(t.merchant_raw, this_.rules)} · ${t.amount > 0 ? "+" : "-"}$${Math.abs(t.amount).toFixed(2)}` });
      });
    }
    refresh();

    const btnRow = contentEl.createDiv({ cls: "budget-modal-btn-row" });
    if (this.onDelete) {
      const del = btnRow.createEl("button", { text: "Added by mistake? Delete it", cls: "budget-link-btn budget-loan-delete" });
      del.onclick = () => {
        this.close();
        this.onDelete();
      };
    }
    const go = btnRow.createEl("button", { text: "Close loan", cls: "mod-cta" });
    go.onclick = () => {
      const date = normalizeDate(String(d.date || "").trim());
      if (!/^\d{4}-\d{2}-\d{2}$/.test(date || "")) {
        new Notice("Pick the date.");
        return;
      }
      const price = d.reason === "sold" || d.reason === "traded" ? requireMoney(d.price, d.reason === "traded" ? "Trade-in value" : "Sold for") : null;
      if ((d.reason === "sold" || d.reason === "traded") && price == null) return;
      const payoff = d.reason !== "paid" ? requireMoney(d.payoff, "Payoff amount") : null;
      if (d.reason !== "paid" && payoff == null) return;
      const fees = d.reason === "sold" ? requireMoney(d.fees, "Selling costs", { optional: true }) : 0;
      if (fees == null) return;
      this.close();
      this.onSubmit({
        reason: d.reason,
        date,
        price: price != null ? round2(price) : null,
        payoff: payoff != null ? round2(payoff) : null,
        fees: round2(fees || 0),
        result: d.reason === "sold" ? round2(price - payoff - (fees || 0)) : d.reason === "traded" ? round2(price - payoff) : null,
        txId: d.reason === "sold" ? d.tx : null
      });
    };
  }
  onClose() {
    this.contentEl.empty();
  }
}

// "Asset Sale", as a transfer: what selling something brings in isn't income
// (it's mostly your own equity coming back) and mustn't be read as pay.
function assetSaleCategory(categoryMeta) {
  const byName = new Map((categoryMeta || []).filter((c) => c && c.name).map((c) => [c.name, c]));
  for (const name of ["Asset Sale", "Asset Sale Proceeds", "Sale Proceeds"]) {
    const c = byName.get(name);
    if (!c) return { name, create: true };
    if (c.is_transfer) return { name, create: false };
  }
  return { name: "Asset Sale (transfer)", create: true };
}

// One line for a closed loan, from how it ended.
function closedLoanSummary(rec) {
  const c = (rec && rec.closed) || {};
  const m = (v) => `$${Math.abs(Number(v) || 0).toFixed(2)}`;
  const when = c.date ? formatChartDate(c.date) : "";
  if (c.reason === "sold") {
    return [`Sold ${when} for ${m(c.price)}`, `paid off ${m(c.payoff)}`, c.fees ? `${m(c.fees)} in costs` : null, c.result >= 0 ? `${m(c.result)} to you` : `you covered ${m(c.result)}`]
      .filter(Boolean)
      .join(" · ");
  }
  if (c.reason === "traded") {
    return [`Traded in ${when} for ${m(c.price)}`, `paid off ${m(c.payoff)}`, c.result >= 0 ? `${m(c.result)} toward the next one` : `${m(c.result)} rolled into the next loan`].join(" · ");
  }
  if (c.reason === "refinanced") return `Refinanced ${when} · paid off ${m(c.payoff)}`;
  return `Paid off ${when}`;
}

class BNPLModal extends Modal {
  constructor(app, onSubmit, existing = null) {
    super(app);
    this.onSubmit = onSubmit;
    this.existing = existing;
  }
  onOpen() {
    const { contentEl } = this;
    const e = this.existing;
    const isEdit = !!e;
    contentEl.createEl("h2", { text: isEdit ? `Edit BNPL plan: ${e.provider}` : "Add BNPL Plan" });

    const currentBalance = isEdit ? debtBalance(e) : 0;
    const appliedCount = isEdit ? (e.applied_payments || []).length : 0;

    const d = {
      provider: isEdit ? e.provider || "" : "",
      installment_amount: isEdit ? String(e.installment_amount || "") : "",
      remaining_installments: isEdit ? String(remainingInstallments(e)) : "",
      balance: isEdit ? currentBalance.toFixed(2) : "",
      frequency: isEdit ? e.frequency || "monthly" : "monthly",
      next_due_date: isEdit ? e.next_due_date || "" : "",
      hasDeferredRisk: isEdit ? !!(e.deferred_interest_risk && e.deferred_interest_risk.applies) : false,
      retroactive_apr: isEdit && e.deferred_interest_risk ? String(e.deferred_interest_risk.retroactive_apr || "") : "",
      payoff_deadline: isEdit && e.deferred_interest_risk ? e.deferred_interest_risk.payoff_deadline || "" : "",
      original_principal: isEdit && e.deferred_interest_risk ? String(e.deferred_interest_risk.original_principal || "") : ""
    };

    new Setting(contentEl)
      .setName("Provider / item")
      .setDesc("e.g. \u201cAffirm \u2014 Sofa\u201d or \u201cKlarna \u2014 TikTok Shop\u201d")
      .addText((t) => t.setValue(d.provider).onChange((v) => (d.provider = v)));

    contentEl.createEl("h3", { text: "Balance", cls: "budget-modal-section" });
    contentEl.createEl("p", {
      text: "Change the installment amount or count and the total updates. Or type the true total directly and the count is recalculated.",
      cls: "budget-muted"
    });

    let amtInput, cntInput, balInput, balText;
    let editingBalanceDirectly = false;

    // Only for the live installment/total arithmetic while typing, where a half-
    // typed figure should count as zero. Saving goes through requireMoney.
    const num = (v) => {
      const r = parseMoneyInput(v);
      return r.ok && !r.empty ? r.value : 0;
    };

    const syncFromParts = () => {
      if (editingBalanceDirectly) return;
      const total = num(d.installment_amount) * num(d.remaining_installments);
      d.balance = total.toFixed(2);
      if (balInput) {
        balInput.value = d.balance;
        if (balText) balText.moneyCheck();
      }
    };
    const syncFromBalance = () => {
      const amt = num(d.installment_amount);
      if (amt <= 0) return;
      const cnt = Math.ceil(num(d.balance) / amt);
      d.remaining_installments = String(cnt);
      if (cntInput) cntInput.value = d.remaining_installments;
    };

    const amtSetting = new Setting(contentEl).setName("Installment amount");
    amtSetting.addText((t) => {
      amtInput = t.inputEl;
      bindMoneyInput(t, amtSetting);
      t.setValue(d.installment_amount).onChange((v) => {
        d.installment_amount = v;
        syncFromParts();
      });
    });

    new Setting(contentEl)
      .setName("Remaining installments")
      .addText((t) => {
        cntInput = t.inputEl;
        t.setValue(d.remaining_installments).onChange((v) => {
          d.remaining_installments = v;
          syncFromParts();
        });
      });

    const balSetting = new Setting(contentEl)
      .setName("Total balance owed")
      .setDesc(
        isEdit && appliedCount
          ? `Tracker shows $${currentBalance.toFixed(2)} (anchor minus ${appliedCount} applied payment${appliedCount === 1 ? "" : "s"}). Changing this sets a new baseline and clears that history.`
          : "The exact amount still owed on this plan right now."
      );
    // Added after the Setting exists: the field's live message needs the Setting
    // itself, and inside its own constructor chain it isn't assigned yet.
    balSetting.addText((t) => {
      balInput = t.inputEl;
      balText = bindMoneyInput(t, balSetting);
      t.setValue(d.balance).onChange((v) => {
        editingBalanceDirectly = true;
        d.balance = v;
        syncFromBalance();
        editingBalanceDirectly = false;
      });
    });

    contentEl.createEl("h3", { text: "Schedule", cls: "budget-modal-section" });

    new Setting(contentEl).setName("Frequency").addDropdown((dd) =>
      dd
        .addOption("monthly", "Monthly")
        .addOption("biweekly", "Biweekly")
        .setValue(d.frequency)
        .onChange((v) => (d.frequency = v))
    );

    new Setting(contentEl)
      .setName("Next due date")
      .addText((t) => bindDateInput(t, d.next_due_date).onChange((v) => (d.next_due_date = v)));

    contentEl.createEl("h3", { text: "Deferred interest", cls: "budget-modal-section" });

    const riskFields = contentEl.createDiv();
    const toggleRiskFields = () => {
      riskFields.style.display = d.hasDeferredRisk ? "" : "none";
    };

    new Setting(contentEl)
      .setName("Has a deferred-interest cliff?")
      .setDesc("0% only if paid off by a deadline \u2014 miss it and interest applies retroactively to the original amount.")
      .addToggle((tg) =>
        tg.setValue(d.hasDeferredRisk).onChange((v) => {
          d.hasDeferredRisk = v;
          toggleRiskFields();
        })
      );
    contentEl.appendChild(riskFields);

    const aprSetting = new Setting(riskFields).setName("Retroactive APR (%)");
    aprSetting.addText((t) =>
      bindMoneyInput(t, aprSetting, { percent: true }).setValue(d.retroactive_apr).onChange((v) => (d.retroactive_apr = v))
    );
    new Setting(riskFields)
      .setName("Payoff deadline")
      .addText((t) => bindDateInput(t, d.payoff_deadline).onChange((v) => (d.payoff_deadline = v)));
    const principalSetting = new Setting(riskFields)
      .setName("Original principal")
      .setDesc("What interest would be charged on if the deadline is missed.");
    principalSetting.addText((t) =>
      bindMoneyInput(t, principalSetting).setValue(d.original_principal).onChange((v) => (d.original_principal = v))
    );
    toggleRiskFields();

    new Setting(contentEl).addButton((b) =>
      b
        .setButtonText(isEdit ? "Save changes" : "Add plan")
        .setCta()
        .onClick(() => {
          if (!d.provider.trim()) {
            new Notice("Give the plan a provider / item name.");
            return;
          }
          const amt = requireMoney(d.installment_amount, "Installment amount");
          if (amt == null) return;
          if (amt <= 0) {
            new Notice("Installment amount must be greater than 0.");
            return;
          }
          const bal = requireMoney(d.balance, "Total balance owed", { optional: true });
          if (bal == null) return;
          if (d.hasDeferredRisk && !d.payoff_deadline.trim()) {
            new Notice("A deferred-interest plan needs a payoff deadline.");
            return;
          }

          const plan = {
            provider: d.provider.trim(),
            installment_amount: round2(amt),
            frequency: d.frequency,
            remaining_installments: parseInt(d.remaining_installments) || 0,
            next_due_date: d.next_due_date.trim()
          };
          if (d.hasDeferredRisk) {
            const apr = requireMoney(d.retroactive_apr, "Retroactive APR", { percent: true, optional: true });
            if (apr == null) return;
            const principal = requireMoney(d.original_principal, "Original principal", { optional: true });
            if (principal == null) return;
            plan.deferred_interest_risk = {
              applies: true,
              retroactive_apr: apr,
              payoff_deadline: d.payoff_deadline.trim(),
              original_principal: principal
            };
          }
          this.close();
          // balanceChanged tells the caller whether to reset the anchor/ledger
          this.onSubmit(plan, round2(bal), isEdit ? Math.abs(bal - currentBalance) > 0.005 : true);
        })
    );
  }
  onClose() {
    this.contentEl.empty();
  }
}

class AddFixedExpenseModal extends Modal {
  constructor(app, onSubmit, existing = null, categoryNames = []) {
    super(app);
    this.onSubmit = onSubmit;
    this.existing = existing;
    this.categoryNames = categoryNames;
  }
  onOpen() {
    const { contentEl } = this;
    const e = this.existing;
    contentEl.createEl("h2", { text: e ? `Edit: ${e.name}` : "Add Fixed Expense" });
    const data = e
      ? {
          name: e.name || "",
          amount: String(e.amount ?? ""),
          expense_type: isRollingExpense(e) ? "rolling" : "monthly",
          due_day_of_month: e.due_day_of_month ? String(e.due_day_of_month) : "",
          next_due_date: e.next_due_date || "",
          interval_days: e.interval_days ? String(e.interval_days) : "",
          payment_category: e.payment_category || "",
          payment_category_learned: !!e.payment_category_learned,
          flagged: !!e.flagged_for_review
        }
      : {
      name: "",
      amount: "",
      expense_type: "monthly",
      due_day_of_month: "",
      next_due_date: "",
      interval_days: "",
      payment_category: "",
      payment_category_learned: false,
      flagged: false
    };

    new Setting(contentEl).setName("Name").addText((t) => t.setValue(data.name).onChange((v) => (data.name = v)));
    const amountSetting = new Setting(contentEl).setName("Amount");
    amountSetting.addText((t) =>
      bindMoneyInput(t, amountSetting).setValue(data.amount).onChange((v) => (data.amount = v))
    );

    // The same field debts carry. An expense's NAME rarely matches the category
    // its charges land in — "Phone Co" against "Phone Bill" — so without this
    // the plugin has no way to know they are the same thing, and every charge
    // reads as ordinary spending.
    new Setting(contentEl)
      .setName("Payment category")
      .setDesc(
        "Transactions in this category are treated as payments toward this bill, even when the merchant name " +
          "doesn't match the bill's name. Leave it blank and it's filled in the first time you link a payment." +
          (e && e.payment_category_learned && e.payment_category
            ? "  \u2014 Learned from a linked payment."
            : "")
      )
      .addDropdown((d) => {
        d.addOption("", "\u2014 none \u2014");
        sortCategoriesByUse(this.categoryNames).forEach((n) => d.addOption(n, n));
        if (data.payment_category && !this.categoryNames.includes(data.payment_category)) {
          d.addOption(data.payment_category, data.payment_category);
        }
        d.setValue(data.payment_category || "");
        d.onChange((v) => {
          data.payment_category = v;
          data.payment_category_learned = false;
        });
      });

    const monthlyFields = contentEl.createDiv();
    const rollingFields = contentEl.createDiv();
    const syncFields = () => {
      monthlyFields.style.display = data.expense_type === "monthly" ? "" : "none";
      rollingFields.style.display = data.expense_type === "rolling" ? "" : "none";
    };

    new Setting(contentEl)
      .setName("Expense type")
      .setDesc("Rent and subscriptions land on a set day. Things like dog food come due every so many days instead.")
      .addDropdown((d) =>
        d
          .addOption("monthly", "Monthly on a specific day")
          .addOption("rolling", "Rolling interval (every X days)")
          .setValue(data.expense_type)
          .onChange((v) => {
            data.expense_type = v;
            syncFields();
          })
      );

    contentEl.appendChild(monthlyFields);
    contentEl.appendChild(rollingFields);

    new Setting(monthlyFields)
      .setName("Due day of month")
      .setDesc("1\u201331. Months that are too short fall back to the last day.")
      .addText((t) => t.setValue(data.due_day_of_month).onChange((v) => (data.due_day_of_month = v)));

    new Setting(rollingFields)
      .setName("Next expected date")
      .setDesc("When you next expect to pay it.")
      .addText((t) => bindDateInput(t, data.next_due_date).onChange((v) => (data.next_due_date = v)));
    new Setting(rollingFields)
      .setName("Cadence in days")
      .setDesc("e.g. 35 for roughly every five weeks. Marking it paid advances this automatically.")
      .addText((t) => t.setValue(data.interval_days).onChange((v) => (data.interval_days = v)));

    syncFields();

    new Setting(contentEl)
      .setName("Flag for subscription review")
      .addToggle((tg) => tg.setValue(data.flagged).onChange((v) => (data.flagged = v)));

    new Setting(contentEl).addButton((b) =>
      b
        .setButtonText(e ? "Save changes" : "Save")
        .setCta()
        .onClick(() => {
          if (!data.name.trim()) {
            new Notice("Give the expense a name.");
            return;
          }
          const amount = requireMoney(data.amount, "Amount");
          if (amount == null) return;
          if (amount <= 0) {
            new Notice("Enter an amount greater than 0.");
            return;
          }

          const expense = {
            name: data.name.trim(),
            amount: round2(amount),
            payment_category: (data.payment_category || "").trim() || null,
            payment_category_learned: !!data.payment_category_learned,
            flagged_for_review: data.flagged
          };

          if (data.expense_type === "rolling") {
            const interval = parseInt(data.interval_days);
            if (!interval || interval < 1) {
              new Notice("Cadence must be at least 1 day.");
              return;
            }
            const next = normalizeDate((data.next_due_date || "").trim());
            if (!/^\d{4}-\d{2}-\d{2}$/.test(next)) {
              new Notice("Pick the next expected date.");
              return;
            }
            expense.interval_days = interval;
            expense.next_due_date = next;
          } else {
            const day = parseInt(data.due_day_of_month);
            if (!day || day < 1 || day > 31) {
              new Notice("Due day must be between 1 and 31.");
              return;
            }
            expense.due_day_of_month = day;
          }

          this.close();
          this.onSubmit(expense);
        })
    );
  }
  onClose() {
    this.contentEl.empty();
  }
}

class AddAccountModal extends Modal {
  // `existing` switches this to an edit, mirroring AddFixedExpenseModal. The id
  // is shown but not editable: every transaction, credit-card term and import
  // marker refers to an account BY id, so changing it here would silently
  // orphan all of them. Renaming the display name is what people actually want,
  // and that is what Institution is.
  // `context.simplefinAccounts` is what SimpleFIN last reported, for the link
  // dropdown; `context.linkedBy` maps a SimpleFIN id to the local account that
  // already has it, so one bank account can't be linked twice.
  constructor(app, onSubmit, existing = null, context = {}) {
    super(app);
    this.onSubmit = onSubmit;
    this.existing = existing;
    this.simplefinAccounts = context.simplefinAccounts || [];
    this.linkedBy = context.linkedBy || {};
  }
  onOpen() {
    const { contentEl } = this;
    const e = this.existing;
    contentEl.createEl("h2", { text: e ? `Edit: ${e.institution || e.id}` : "Add Account" });

    const data = e
      ? {
          id: e.id || "",
          type: e.type || "checking",
          institution: e.institution || "",
          current_balance: e.current_balance != null ? String(e.current_balance) : "",
          credit_limit: e.credit_limit != null ? String(e.credit_limit) : "",
          csv_source: e.csv_source || "mainbank",
          invert_positive_charges: !!e.invert_positive_charges,
          simplefin_id: e.simplefin_id || ""
        }
      : {
          id: "",
          type: "checking",
          institution: "",
          current_balance: "",
          credit_limit: "",
          csv_source: "mainbank",
          invert_positive_charges: false,
          simplefin_id: ""
        };

    const idSetting = new Setting(contentEl).setName("Account ID");
    if (e) {
      idSetting
        .setDesc(
          "Fixed once the account exists — transactions, card terms and import markers all refer to it. " +
            "Change Institution below to rename what you see."
        )
        .addText((t) => {
          t.setValue(data.id);
          if (t.inputEl) {
            t.inputEl.disabled = true;
            t.inputEl.setAttr("title", "An account's ID can't change after it's created");
          }
        });
    } else {
      idSetting
        .setDesc("A short unique name you'll recognize, e.g. 'checking-mainbank'")
        .addText((t) => t.setValue(data.id).onChange((v) => (data.id = v)));
    }

    new Setting(contentEl).setName("Type").addDropdown((d) =>
      d
        .addOption("checking", "Checking")
        .addOption("savings", "Savings")
        .addOption("credit_card", "Credit Card")
        .setValue(data.type)
        .onChange((v) => (data.type = v))
    );

    new Setting(contentEl)
      .setName("Institution")
      .addText((t) => t.setValue(data.institution).onChange((v) => (data.institution = v)));

    const balanceSetting = new Setting(contentEl)
      .setName("Current balance")
      .setDesc("For checking/savings: what's in it. For credit cards: what you owe right now.");
    balanceSetting.addText((t) =>
      bindMoneyInput(t, balanceSetting, { allowNegative: true })
        .setValue(data.current_balance)
        .onChange((v) => (data.current_balance = v))
    );

    const limitSetting = new Setting(contentEl)
      .setName("Credit limit")
      .setDesc("Only needed for credit cards — leave blank otherwise");
    limitSetting.addText((t) =>
      bindMoneyInput(t, limitSetting).setValue(data.credit_limit).onChange((v) => (data.credit_limit = v))
    );

    new Setting(contentEl)
      .setName("CSV source")
      .setDesc("Which adapter should parse this account's CSV exports")
      .addDropdown((d) =>
        d
          .addOption("capital_one", "Capital One")
          .addOption("mainbank", "Universal / Auto-detect (Chase, Amex, BofA, etc.)")
          .setValue(data.csv_source)
          .onChange((v) => (data.csv_source = v))
      );

    // Most exports write spending as a negative number. Some cards bill the
    // other way round, and nothing in the file says so — there is no header and
    // no type column to read it from, so it has to be told.
    new Setting(contentEl)
      .setName("Exports purchases as positive numbers")
      .setDesc("Turn this on for Amex or Apple Card exports where spending is listed as positive numbers.")
      .addToggle((tg) =>
        tg.setValue(!!data.invert_positive_charges).onChange((v) => (data.invert_positive_charges = v))
      );

    // Which SimpleFIN account feeds this one. SimpleFIN's ids are opaque, so it's
    // chosen from what SimpleFIN last reported rather than typed; before a
    // connection there's nothing to choose from, and a plain field stands in.
    // linkedBy never includes the account being edited, so any hit is another one.
    const others = (id) => !!this.linkedBy[id];
    const sfSetting = new Setting(contentEl)
      .setName("SimpleFIN account")
      .setDesc(
        this.simplefinAccounts.length
          ? "Linking it means Sync Transactions brings in its transactions and balance, and Import CSV stops being used for it."
          : "Connect SimpleFIN under Settings → Bank sync to pick this from a list."
      );
    if (this.simplefinAccounts.length) {
      sfSetting.addDropdown((d) => {
        d.addOption("", "Not linked");
        this.simplefinAccounts.forEach((a) =>
          d.addOption(a.id, `${simplefinAccountLabel(a)}${others(a.id) ? ` (linked to ${this.linkedBy[a.id]})` : ""}`)
        );
        if (data.simplefin_id && !this.simplefinAccounts.some((a) => a.id === data.simplefin_id)) {
          d.addOption(data.simplefin_id, `Linked to ${data.simplefin_id} (not in SimpleFIN's last report)`);
        }
        d.setValue(data.simplefin_id).onChange((v) => (data.simplefin_id = v));
      });
    } else {
      sfSetting.addText((t) =>
        t.setPlaceholder("SimpleFIN account id").setValue(data.simplefin_id).onChange((v) => (data.simplefin_id = v))
      );
    }

    new Setting(contentEl).addButton((b) =>
      b
        .setButtonText(e ? "Save changes" : "Save")
        .setCta()
        .onClick(() => {
          const currentBalance = requireMoney(data.current_balance, "Current balance", {
            allowNegative: true,
            optional: true
          });
          if (currentBalance == null) return;
          const creditLimit = requireMoney(data.credit_limit, "Credit limit", { optional: true, fallback: undefined });
          if (creditLimit === null) return;
          const simplefinId = String(data.simplefin_id || "").trim();
          if (looksLikeSimpleFINCredential(simplefinId)) {
            new Notice(
              "That's a SimpleFIN setup token or connection, not an account id — it wasn't saved. Paste it under Settings → Bank sync instead."
            );
            return;
          }
          if (simplefinId && others(simplefinId)) {
            new Notice(
              `That SimpleFIN account is already linked to ${this.linkedBy[simplefinId]}. Linking it twice would import every transaction twice.`
            );
            return;
          }
          this.close();
          const patch = {
            id: e ? e.id : data.id,
            type: data.type,
            institution: data.institution,
            current_balance: currentBalance,
            credit_limit: creditLimit || undefined,
            csv_source: data.csv_source,
            invert_positive_charges: !!data.invert_positive_charges,
            simplefin_id: simplefinId || null
          };
          // An edit must not reset how far the account has been imported, or the
          // next import would re-offer everything already in the ledger.
          patch.last_imported_through = e ? e.last_imported_through || null : null;
          this.onSubmit(patch);
        })
    );
  }
  onClose() {
    this.contentEl.empty();
  }
}

class AddRevolvingDebtModal extends Modal {
  constructor(app, creditCardAccounts, onSubmit) {
    super(app);
    this.creditCardAccounts = creditCardAccounts;
    this.onSubmit = onSubmit;
  }
  onOpen() {
    const { contentEl } = this;
    contentEl.createEl("h2", { text: "Add Credit Card Terms" });

    if (this.creditCardAccounts.length === 0) {
      contentEl.createEl("p", {
        text: "No credit card accounts found yet — run 'Add Account' first and set its type to Credit Card."
      });
      return;
    }

    const data = {
      account_id: this.creditCardAccounts[0].id,
      current_balance: "",
      statement_balance: "",
      apr: "",
      min_payment_due: "",
      due_date: ""
    };

    new Setting(contentEl).setName("Which credit card").addDropdown((d) => {
      this.creditCardAccounts.forEach((a) => d.addOption(a.id, `${a.institution} (${a.id})`));
      d.onChange((v) => (data.account_id = v));
    });
    const moneySetting = (name, key, opts = {}, desc = null) => {
      const setting = new Setting(contentEl).setName(name);
      if (desc) setting.setDesc(desc);
      setting.addText((t) => bindMoneyInput(t, setting, opts).onChange((v) => (data[key] = v)));
    };
    moneySetting("Current balance", "current_balance");
    moneySetting(
      "Statement balance",
      "statement_balance",
      {},
      "What was owed as of the last statement — this is what your minimum payment is based on"
    );
    moneySetting("APR (%)", "apr", { percent: true });
    moneySetting("Minimum payment due", "min_payment_due");
    new Setting(contentEl)
      .setName("Due date")
      .addText((t) => bindDateInput(t, data.due_date).onChange((v) => (data.due_date = v)));

    new Setting(contentEl).addButton((b) =>
      b
        .setButtonText("Save")
        .setCta()
        .onClick(() => {
          const current = requireMoney(data.current_balance, "Current balance", { optional: true });
          if (current == null) return;
          const statement = requireMoney(data.statement_balance, "Statement balance", { optional: true });
          if (statement == null) return;
          const apr = requireMoney(data.apr, "APR", { percent: true, optional: true });
          if (apr == null) return;
          const minimum = requireMoney(data.min_payment_due, "Minimum payment due", { optional: true });
          if (minimum == null) return;
          this.close();
          this.onSubmit({
            account_id: data.account_id,
            current_balance: current,
            statement_balance: statement,
            apr,
            min_payment_due: minimum,
            due_date: data.due_date
          });
        })
    );
  }
  onClose() {
    this.contentEl.empty();
  }
}

class AccountPickerModal extends FuzzySuggestModal {
  constructor(app, accounts, onChoose) {
    super(app);
    this.accounts = accounts;
    this.onChoose = onChoose;
  }
  getItems() {
    return this.accounts;
  }
  getItemText(item) {
    return `${item.institution} — ${item.id} (${item.type})`;
  }
  onChooseItem(item) {
    this.onChoose(item);
  }
}

class FixedExpensePickerModal extends FuzzySuggestModal {
  constructor(app, expenses, onChoose) {
    super(app);
    this.expenses = expenses;
    this.onChoose = onChoose;
  }
  getItems() {
    return this.expenses;
  }
  getItemText(item) {
    return `${item.name} — $${item.amount.toFixed(2)} (due day ${item.due_day_of_month})`;
  }
  onChooseItem(item) {
    this.onChoose(item);
  }
}

class MarkPaidModal extends Modal {
  constructor(app, expense, defaultDate, onSubmit, plugin, rules = []) {
    super(app);
    this.expense = expense;
    this.defaultDate = defaultDate;
    this.onSubmit = onSubmit;
    // The candidate list depends on the due date, and the due date is editable,
    // so the modal loads candidates itself rather than being handed a snapshot
    // that goes stale the moment the user retypes the date.
    this.plugin = plugin;
    this.rules = rules;
    this.candidates = [];
    this.chosenTx = null;
    this.paidForDate = defaultDate;
    this.loadToken = 0;
    this.reloadTimer = null;
  }

  static get DATE_HINT() {
    return "Pick the due date this payment covers.";
  }
  onOpen() {
    const { contentEl } = this;
    contentEl.createEl("h2", { text: `Mark Paid: ${this.expense.name}` });

    new Setting(contentEl)
      .setName("This payment covers the due date of")
      .setDesc(
        "Defaults to the next upcoming due date for this expense. Change it if you're " +
          "catching up a different cycle — the transaction list below follows it."
      )
      .addText((t) =>
        bindDateInput(t, this.defaultDate).onChange((v) => {
          this.paidForDate = v;
          // Invalidate SYNCHRONOUSLY with the edit. Only the lookup is worth
          // debouncing; the stale state is not. Deferring this too left the
          // previous cycle's list on screen and still selected during the wait,
          // so pressing Mark Paid inside that window filed the newly typed date
          // against the old cycle's transaction.
          this.loadToken++;
          this.chosenTx = null;
          this.candidates = [];

          const valid = isISODateString(v);
          this.renderCandidates(
            valid ? "Loading transactions…" : MarkPaidModal.DATE_HINT
          );

          if (this.reloadTimer) clearTimeout(this.reloadTimer);
          // The field fires on every keystroke, so a half-typed date would
          // otherwise hit the vault repeatedly.
          if (valid) this.reloadTimer = setTimeout(() => this.reloadCandidates(), 250);
        })
      );

    contentEl.createEl("h3", { text: "Which transaction was it?" });
    contentEl.createEl("p", {
      text:
        "Linking the real transaction is what stops it being counted twice — once as this bill, " +
        "and again out of your spending allowance. Closest amounts are listed first. " +
        "You can skip this, but then the payment will come out of your allowance.",
      cls: "budget-muted budget-apply-scope"
    });

    this.listEl = contentEl.createDiv({ cls: "budget-apply-list" });
    this.renderCandidates(
      isISODateString(this.paidForDate) ? "Loading transactions…" : MarkPaidModal.DATE_HINT
    );

    new Setting(contentEl)
      .addButton((b) =>
        b
          .setButtonText("Mark Paid")
          .setCta()
          .onClick(() => {
            // Submitting a blank or impossible date used to write it straight to
            // last_paid_date, which either did nothing or set a due date that no
            // cycle could ever match.
            if (!isISODateString(this.paidForDate)) {
              new Notice(MarkPaidModal.DATE_HINT);
              return;
            }
            this.close();
            this.onSubmit(this.paidForDate, this.chosenTx);
          })
      )
      .addButton((b) => b.setButtonText("Cancel").onClick(() => this.close()));

    this.reloadCandidates();
  }

  async reloadCandidates() {
    const date = this.paidForDate;
    if (!isISODateString(date)) {
      this.loadToken++;
      this.candidates = [];
      this.chosenTx = null;
      this.renderCandidates(MarkPaidModal.DATE_HINT);
      return;
    }
    // Out-of-order responses: a slow load for an earlier date must not overwrite
    // the list for the date the user has since typed.
    const token = ++this.loadToken;
    const list = await this.plugin.fixedPaymentCandidates(this.expense, date);
    if (token !== this.loadToken || !this.listEl) return;
    this.candidates = list;
    // A transaction picked for one cycle shouldn't stay selected for another.
    if (this.chosenTx && !list.some((c) => c.id === this.chosenTx.id)) this.chosenTx = null;
    this.renderCandidates();
  }

  renderCandidates(emptyMessage) {
    if (!this.listEl) return;
    this.listEl.empty();

    if (!this.candidates.length) {
      const hidden = this.candidates.accountedElsewhere || 0;
      this.listEl.createEl("p", {
        text:
          emptyMessage ||
          (hidden
            ? `No matching payment found in this date range. ${hidden} nearby transaction${hidden === 1 ? " is" : "s are"} already accounted for elsewhere \u2014 as a debt payment, a subscription, or something you'll need to buy.`
            : "No matching payment found in this date range. Import the statement first, or mark it paid without linking."),
        cls: "budget-muted"
      });
      return;
    }

    const rows = [];
    this.candidates.forEach((t) => {
      const row = this.listEl.createDiv({ cls: "budget-apply-row" });
      const cb = row.createEl("input", { type: "radio" });
      cb.name = "budget-fixed-link";
      if (this.chosenTx && this.chosenTx.id === t.id) {
        cb.checked = true;
        row.addClass("budget-apply-chosen");
      }
      cb.onchange = () => {
        if (cb.checked) this.chosenTx = t;
        rows.forEach((r) => r.row.toggleClass("budget-apply-chosen", r.cb === cb));
      };
      rows.push({ row, cb });

      const exact = Math.abs(Math.abs(t.amount) - Math.abs(this.expense.amount || 0)) < 0.005;
      const label = row.createDiv({ cls: "budget-apply-label" });
      label.createDiv({ text: displayMerchant(t.merchant_raw, this.rules) }).setAttr("title", t.merchant_raw);
      const meta = label.createDiv({ cls: "budget-apply-meta" });
      meta.createSpan({ text: t.date });
      meta.createSpan({ text: t.resolved_category || "Uncategorized" });
      if (exact) meta.createSpan({ text: "exact amount", cls: "budget-badge budget-badge-pinned" });
      row.createSpan({ text: `$${Math.abs(t.amount).toFixed(2)}`, cls: "budget-amount" });
    });
  }

  onClose() {
    if (this.reloadTimer) clearTimeout(this.reloadTimer);
    // Invalidate any load still in flight so it can't touch a torn-down DOM.
    this.loadToken++;
    this.listEl = null;
    this.contentEl.empty();
  }
}

class OverrideModal extends Modal {
  constructor(app, tx, existingLabels, onSubmit, rules = []) {
    super(app);
    this.tx = tx;
    this.existingLabels = existingLabels;
    this.onSubmit = onSubmit;
    this.rules = rules;
  }
  onOpen() {
    const { contentEl } = this;
    contentEl.createEl("h2", { text: "Move this transaction" });
    contentEl.createEl("p", {
      text: `${this.tx.date}  ${displayMerchant(this.tx.merchant_raw, this.rules)}  $${Math.abs(this.tx.amount).toFixed(2)}`,
      cls: "budget-muted"
    });
    contentEl.createEl("p", {
      text: "This only changes this one transaction \u2014 it won't touch the merchant's usual rule.",
      cls: "budget-muted"
    });

    let selected = "";
    let typed = "";
    if (this.existingLabels.length > 0) {
      new Setting(contentEl).setName("Move to existing category").addDropdown((d) => {
        d.addOption("", "— choose —");
        sortCategoriesByUse(this.existingLabels).forEach((l) => d.addOption(l, l));
        d.onChange((v) => (selected = v));
      });
    }
    new Setting(contentEl).setName("Or type a new category").addText((t) => t.onChange((v) => (typed = v)));

    new Setting(contentEl).addButton((b) =>
      b
        .setButtonText("Move")
        .setCta()
        .onClick(() => {
          const label = (typed && typed.trim()) || selected;
          if (!label) {
            new Notice("Pick a category from the dropdown, or type a new one.");
            return; // keep the modal open so the choice isn't lost
          }
          this.close();
          this.onSubmit(label);
        })
    );
  }
  onClose() {
    this.contentEl.empty();
  }
}

// One dialog for what used to be five buttons on every category row: its name
// and how it counts. Exactly one type at a time, so a category can't be both a
// transfer and a necessity.
const CATEGORY_KINDS = [
  ["spending", "Spending", "Draws down your spending allowance."],
  ["variable_necessity", "Variable necessity", "Unavoidable and regular, like gas. Projected ahead from your purchases and reserved."],
  ["scheduled_bill", "Scheduled bill", "A recurring bill the plugin has no other record of. Stays out of your allowance."],
  ["necessary_expense", "Necessary expense", "Unavoidable but one-off, like an oil change. Stays out of your allowance; nothing is projected or reserved."],
  ["transfer", "Transfer", "Money moving between your own accounts."]
];

class CategorySettingsModal extends Modal {
  constructor(app, category, allNames, onSave) {
    super(app);
    this.category = category;
    this.allNames = allNames;
    this.onSave = onSave;
  }
  onOpen() {
    const { contentEl } = this;
    const c = this.category;
    contentEl.createEl("h2", { text: `\u201c${c.name}\u201d` });

    let name = c.name;
    let kind = categoryKindOf(c);
    let minAmount = c.variableMinAmount || 0;

    const warnEl = contentEl.createEl("p", { cls: "budget-muted budget-merge-warning" });
    warnEl.style.display = "none";
    const refreshWarning = () => {
      const trimmed = name.trim();
      const collides = trimmed && trimmed !== c.name && this.allNames.includes(trimmed);
      if (collides) {
        warnEl.setText(
          `\u201c${trimmed}\u201d already exists \u2014 saving will MERGE these two categories into one. This can't be undone automatically.`
        );
        warnEl.style.display = "";
      } else {
        warnEl.style.display = "none";
      }
    };

    new Setting(contentEl).setName("Name").addText((t) =>
      t.setValue(name).onChange((v) => {
        name = v;
        refreshWarning();
      })
    );

    const hintEl = contentEl.createEl("p", { cls: "budget-muted budget-cat-kind-hint" });
    let minSetting = null;
    const refreshKind = () => {
      const row = CATEGORY_KINDS.find((k) => k[0] === kind);
      hintEl.setText(row ? row[2] : "");
      if (minSetting) minSetting.settingEl.toggleClass("budget-hidden", kind !== "variable_necessity");
    };

    new Setting(contentEl).setName("Treat as").addDropdown((dd) => {
      CATEGORY_KINDS.forEach(([k, label]) => dd.addOption(k, label));
      dd.setValue(kind).onChange((v) => {
        kind = v;
        refreshKind();
      });
    });
    contentEl.appendChild(hintEl);

    minSetting = new Setting(contentEl).setName("Ignore purchases under").addText((t) => {
      t.setPlaceholder("$0");
      t.setValue(minAmount ? String(minAmount) : "");
      bindMoneyInput(t, null);
      t.onChange((v) => {
        const r = parseMoneyInput(v);
        if (r.ok) minAmount = r.empty ? 0 : r.value;
      });
    });
    refreshKind();

    new Setting(contentEl).addButton((b) =>
      b
        .setButtonText("Save")
        .setCta()
        .onClick(() => {
          const trimmed = name.trim();
          if (!trimmed) {
            new Notice("Category name can't be empty.");
            return;
          }
          if (trimmed === "Uncategorized") {
            new Notice("\u201cUncategorized\u201d is reserved \u2014 pick a different name.");
            return;
          }
          this.close();
          this.onSave({ name: trimmed, kind, minAmount: round2(minAmount || 0) });
        })
    );
  }
  onClose() {
    this.contentEl.empty();
  }
}

class RenameCategoryModal extends Modal {
  constructor(app, category, allNames, onSubmit) {
    super(app);
    this.category = category;
    this.allNames = allNames;
    this.onSubmit = onSubmit;
  }
  onOpen() {
    const { contentEl } = this;
    const c = this.category;
    contentEl.createEl("h2", { text: `Rename \u201c${c.name}\u201d` });

    const usage = [];
    if (c.ruleCount) usage.push(`${c.ruleCount} rule${c.ruleCount === 1 ? "" : "s"}`);
    if (c.txCount) usage.push(`${c.txCount} transaction${c.txCount === 1 ? "" : "s"}`);
    if (c.overrideCount) usage.push(`${c.overrideCount} one-off override${c.overrideCount === 1 ? "" : "s"}`);
    contentEl.createEl("p", {
      text: usage.length ? `Used by ${usage.join(", ")}. All of them will be updated.` : "Not used by anything yet.",
      cls: "budget-muted"
    });

    let newName = c.name;
    const warnEl = contentEl.createEl("p", { cls: "budget-muted budget-merge-warning" });
    warnEl.style.display = "none";

    const refreshWarning = () => {
      const trimmed = newName.trim();
      const collides = trimmed && trimmed !== c.name && this.allNames.includes(trimmed);
      if (collides) {
        warnEl.setText(
          `\u201c${trimmed}\u201d already exists \u2014 saving will MERGE these two categories into one. This can't be undone automatically.`
        );
        warnEl.style.display = "";
      } else {
        warnEl.style.display = "none";
      }
    };

    new Setting(contentEl)
      .setName("New name")
      .addText((t) =>
        t.setValue(newName).onChange((v) => {
          newName = v;
          refreshWarning();
        })
      );

    new Setting(contentEl).addButton((b) =>
      b
        .setButtonText("Rename")
        .setCta()
        .onClick(() => {
          const trimmed = newName.trim();
          if (!trimmed) {
            new Notice("Category name can't be empty.");
            return;
          }
          if (trimmed === "Uncategorized") {
            new Notice("\u201cUncategorized\u201d is reserved \u2014 pick a different name.");
            return;
          }
          if (trimmed === c.name) {
            this.close();
            return;
          }
          this.close();
          this.onSubmit(trimmed);
        })
    );
  }
  onClose() {
    this.contentEl.empty();
  }
}

class EditBalanceModal extends Modal {
  constructor(app, debt, onSubmit, transactions = null) {
    super(app);
    this.debt = debt;
    this.onSubmit = onSubmit;
    this.transactions = transactions;
  }
  onOpen() {
    const { contentEl } = this;
    const d = this.debt;
    const isInstallment = !!d.provider;
    contentEl.createEl("h2", { text: `Edit balance: ${debtLabel(d)}` });

    const appliedCount = (d.applied_payments || []).length;
    const cardState = !isInstallment && this.transactions ? cardBalanceState(d, this.transactions) : null;
    const shown = cardState ? cardState.balance : debtBalance(d);

    contentEl.createEl("p", {
      text:
        `Tracker currently shows $${shown.toFixed(2)}` +
        (cardState && cardState.derived
          ? ` (anchor $${cardState.anchor.toFixed(2)} from ${cardState.since}, plus $${cardState.charges.toFixed(2)} charged and less $${cardState.payments.toFixed(2)} paid since).`
          : appliedCount
            ? ` (anchor $${d.balance_anchor.amount.toFixed(2)} minus ${appliedCount} applied payment${appliedCount === 1 ? "" : "s"}).`
            : ".") +
        " Saving here resets the baseline to whatever you enter and clears the applied-payment history, so the tracker matches reality again.",
      cls: "budget-muted"
    });

    if (cardState) {
      contentEl.createEl("p", {
        text:
          "Enter the balance your card shows right now. It re-anchors to today, so only activity imported " +
          "after today counts toward it \u2014 anything already in that figure won't be added again.",
        cls: "budget-muted budget-apply-scope"
      });
    }

    let value = String(shown.toFixed(2));
    let installments = String(remainingInstallments(d));
    let balanceText = null;

    if (isInstallment) {
      new Setting(contentEl)
        .setName("Remaining installments")
        .setDesc(`At $${(d.installment_amount || 0).toFixed(2)} each.`)
        .addText((t) =>
          t.setValue(installments).onChange((v) => {
            installments = v;
            const n = parseInt(v);
            if (!isNaN(n)) {
              value = String((n * (d.installment_amount || 0)).toFixed(2));
              // The balance field shows what Save will store. It used to keep
              // showing the old figure while Save quietly used the new one.
              if (balanceText) {
                balanceText.setValue(value);
                balanceText.moneyCheck();
              }
            }
          })
        );
    }

    const balanceSetting = new Setting(contentEl).setName(
      isInstallment ? "Or set the remaining balance directly" : "Current balance owed"
    );
    balanceSetting.addText((t) => {
      balanceText = bindMoneyInput(t, balanceSetting).setValue(value).onChange((v) => (value = v));
    });

    new Setting(contentEl).addButton((b) =>
      b
        .setButtonText("Save balance")
        .setCta()
        .onClick(() => {
          const n = requireMoney(value, "Balance");
          if (n == null) return;
          this.close();
          this.onSubmit(round2(n));
        })
    );
  }
  onClose() {
    this.contentEl.empty();
  }
}

class ApplyPaymentModal extends Modal {
  constructor(app, debt, candidates, onSubmit, rules = [], categoryMeta = [], onReviewChange = null, transactions = null) {
    super(app);
    this.transactions = transactions;
    this.debt = debt;
    this.candidates = candidates.slice();
    this.onSubmit = onSubmit;
    this.rules = rules;
    this.categoryMeta = categoryMeta;
    this.onReviewChange = onReviewChange;
  }
  onOpen() {
    const { contentEl } = this;
    const d = this.debt;
    contentEl.createEl("h2", { text: `Apply payments: ${debtLabel(d)}` });
    const cardMode = isRevolvingDebt(d) && this.transactions;
    const liveBalance = cardMode ? cardBalanceState(d, this.transactions).balance : debtBalance(d);

    contentEl.createEl("p", {
      text: cardMode
        ? `Current balance $${liveBalance.toFixed(2)}, taken from this card's own imported activity. ` +
          `Applying a payment here credits it against this cycle's minimum \u2014 it does not reduce the balance, because the card's ledger already records the payment as a credit. Counting both would subtract it twice.`
        : `Current balance $${liveBalance.toFixed(2)}. Tick payments that still need to reduce this balance. ` +
          `Applied transactions are normally hidden by transaction id; if an older or reconciled import reappears even though the balance already reflects it, use \u201cAlready applied\u201d instead of applying it again.`,
      cls: "budget-muted"
    });

    const catList = [...debtPaymentCategories(d, this.categoryMeta)].join(", ");
    contentEl.createEl("p", {
      text: `Showing transactions categorized as: ${catList}. Uncategorized ones are included in case a real payment hasn't been labeled yet \u2014 they're marked and listed last. Routine spending (groceries, gas, retail) is never shown.`,
      cls: "budget-muted budget-apply-scope"
    });

    if (this.candidates.length === 0) {
      const hidden = this.candidates.accountedElsewhere || 0;
      contentEl.createEl("p", {
        text: hidden
          ? `No unmatched payments found. ${hidden} nearby transaction${hidden === 1 ? " is" : "s are"} already accounted for elsewhere \u2014 as a bill, a subscription, or something you'll need to buy.`
          : "No unapplied payments found in those categories since this balance was set.",
        cls: "budget-muted"
      });
      return;
    }

    const chosen = new Set();
    const totalEl = contentEl.createEl("p", { cls: "budget-muted budget-apply-total" });
    // For a loan: whether what's picked is extra toward principal (so next
    // month is still due) or the payment itself. Suggested — this month already
    // paid, and an amount that isn't an installment — until you set it.
    const loan = isLoan(d);
    const extraState = { value: false, touched: false, toggle: null };
    const pickedNow = () => this.candidates.filter((c) => chosen.has(c.id));
    const suggestExtra = () => loanExtraSuggested(d, pickedNow());
    const refreshTotal = () => {
      const picked = pickedNow();
      const sum = picked.reduce((s, c) => s + Math.abs(c.amount), 0);
      if (loan && !extraState.touched) {
        extraState.value = suggestExtra();
        if (extraState.toggle) extraState.toggle.setValue(extraState.value);
      }
      // A loan's balance falls by the principal part only; the rest is interest.
      const after = loan
        ? loanState(Object.assign({}, d, { applied_payments: (d.applied_payments || []).concat(picked.map((c) => ({ amount: Math.abs(c.amount), date: c.date, extra: extraState.value || undefined }))) })).balance
        : Math.max(0, debtBalance(d) - sum);
      totalEl.setText(
        sum <= 0
          ? "Nothing selected yet."
          : cardMode
            ? `Crediting $${sum.toFixed(2)} against this cycle's minimum.`
            : `Applying $${sum.toFixed(2)} \u2192 new balance $${after.toFixed(2)}`
      );
    };
    refreshTotal();

    const list = contentEl.createDiv({ cls: "budget-apply-list" });

    const renderRow = (t) => {
      const row = list.createDiv({ cls: "budget-apply-row" });
      const cb = row.createEl("input", { type: "checkbox" });
      cb.onchange = () => {
        if (cb.checked) chosen.add(t.id);
        else chosen.delete(t.id);
        refreshTotal();
      };
      const isUnknown = (t.resolved_category || "Uncategorized") === "Uncategorized";
      if (isUnknown) row.addClass("budget-apply-unknown");

      const label = row.createDiv({ cls: "budget-apply-label" });
      label.createDiv({ text: displayMerchant(t.merchant_raw, this.rules) }).setAttr("title", t.merchant_raw);
      const meta = label.createDiv({ cls: "budget-apply-meta" });
      meta.createSpan({ text: t.date });
      if (isUnknown) {
        meta.createSpan({ text: "uncategorized", cls: "budget-badge budget-badge-empty" });
      } else {
        meta.createSpan({ text: t.resolved_category });
      }
      row.createSpan({ text: `$${Math.abs(t.amount).toFixed(2)}`, cls: "budget-amount" });

      const appliedBtn = row.createEl("button", { text: "Already applied", cls: "budget-btn" });
      appliedBtn.setAttr(
        "title",
        "This really was a debt payment, but the current balance already reflects it. Hide it from future suggestions without reducing the balance again."
      );
      appliedBtn.onclick = async () => {
        const all = await readJSON(this.app, FILES.transactions, []);
        const idx = findTxIndex(all, t);
        if (idx < 0) {
          new Notice("Couldn’t find that transaction in the saved ledger, so nothing was changed. Refresh and try again.", 9000);
          return;
        }

        // Keep this distinct from `excluded_from_debt_payments`: the latter
        // means it was never a debt payment. This status means it WAS a payment
        // but must not be applied again because the balance already includes it.
        all[idx].debt_payment_review_status = "already_applied";
        all[idx].debt_payment_debt_key = debtKey(this.debt);
        all[idx].debt_payment_reviewed_at = todayLocal();
        delete all[idx].excluded_from_debt_payments;
        await writeJSON(this.app, FILES.transactions, all);

        chosen.delete(t.id);
        this.candidates = this.candidates.filter((c) => c.id !== t.id);
        row.remove();
        refreshTotal();
        if (this.onReviewChange) await this.onReviewChange();
        new Notice(
          `Marked as already applied to ${debtLabel(this.debt)} without changing the balance: ${displayMerchant(t.merchant_raw, this.rules)}`
        );
        if (this.candidates.length === 0) {
          list.createEl("p", { text: "Nothing left to review.", cls: "budget-muted" });
        }
      };

      const dismissBtn = row.createEl("button", { text: "Not a payment", cls: "budget-btn budget-btn-dismiss" });
      dismissBtn.setAttr("title", "Hide this from debt payment suggestions permanently");
      dismissBtn.onclick = async () => {
        const all = await readJSON(this.app, FILES.transactions, []);
        const idx = findTxIndex(all, t);
        if (idx < 0) {
          new Notice("Couldn’t find that transaction in the saved ledger, so nothing was changed. Refresh and try again.", 9000);
          return;
        }
        all[idx].excluded_from_debt_payments = true;
        await writeJSON(this.app, FILES.transactions, all);

        chosen.delete(t.id);
        this.candidates = this.candidates.filter((c) => c.id !== t.id);
        row.remove();
        refreshTotal();
        if (this.onReviewChange) await this.onReviewChange();
        new Notice(`Hidden from debt payment suggestions: ${displayMerchant(t.merchant_raw, this.rules)}`);
        if (this.candidates.length === 0) {
          list.createEl("p", { text: "Nothing left to review.", cls: "budget-muted" });
        }
      };
    };

    this.candidates.slice(0, 40).forEach(renderRow);

    if (loan) {
      new Setting(contentEl)
        .setName("Extra toward principal")
        .setDesc("Next month's payment is still due. Leave it off for a regular payment, early or not.")
        .addToggle((tg) => {
          extraState.toggle = tg;
          tg.setValue(extraState.value).onChange((v) => {
            extraState.value = v;
            extraState.touched = true;
            refreshTotal();
          });
        });
    }

    new Setting(contentEl).addButton((b) =>
      b
        .setButtonText("Apply selected")
        .setCta()
        .onClick(() => {
          const picked = this.candidates.filter((c) => chosen.has(c.id));
          if (picked.length === 0) {
            new Notice("Select at least one payment.");
            return;
          }
          this.close();
          this.onSubmit(picked, { extra: loan && extraState.value });
        })
    );
  }
  onClose() {
    this.contentEl.empty();
  }
}

class RenameSubscriptionModal extends Modal {
  constructor(app, group, allTx, onSubmit, rules = []) {
    super(app);
    this.group = group;
    this.allTx = allTx;
    this.onSubmit = onSubmit;
    this.rules = rules || [];
  }
  onOpen() {
    const { contentEl } = this;
    const g = this.group;
    contentEl.createEl("h2", { text: `Rename: ${g.key}` });

    let nickname = g.matchedRule && g.matchedRule.display_name ? g.matchedRule.display_name : g.key;
    let pattern = g.matchedRule ? g.matchedRule.merchant_pattern : commonBaseName(g.rawSamples) || g.key;

    if (g.rawSamples.length > 1) {
      const det = contentEl.createEl("details", { cls: "budget-raw-samples" });
      det.createEl("summary", { text: `${g.rawSamples.length} raw descriptions in this group` });
      g.rawSamples.slice(0, 12).forEach((r) => det.createEl("div", { text: r, cls: "budget-sub-meta" }));
    }

    new Setting(contentEl)
      .setName("Display nickname")
      .setDesc("Clean name shown everywhere, e.g. \u201cKindle Unlimited\u201d or \u201cGoogle \u2014 Relay for Reddit\u201d.")
      .addText((t) => t.setValue(nickname).onChange((v) => (nickname = v)));

    const patternSetting = new Setting(contentEl)
      .setName("Pattern to match")
      .setDesc("Widen this to pull in charges that are currently splitting into separate groups.");
    const refreshReach = bindPatternReach(patternSetting, {
      transactions: this.allTx,
      rules: this.rules,
      selfIndex: ruleIndexOf(this.rules, g.matchedRule)
    });
    patternSetting.addText((t) =>
      t.setValue(pattern).onChange((v) => {
        pattern = v;
        refreshReach(pattern);
      })
    );
    refreshReach(pattern);

    new Setting(contentEl).addButton((b) =>
      b
        .setButtonText("Save nickname")
        .setCta()
        .onClick(() => {
          if (!nickname.trim()) {
            new Notice("Give it a display name.");
            return;
          }
          if (!pattern.trim()) {
            new Notice("A pattern is required so future charges match too.");
            return;
          }
          this.close();
          this.onSubmit({ nickname: nickname.trim(), pattern: pattern.trim() });
        })
    );
  }
  onClose() {
    this.contentEl.empty();
  }
}

class SavingsGoalModal extends Modal {
  // `accountChoices` is goalAccountChoices(...): the savings accounts this goal
  // may follow. With none, the account setting isn't shown at all.
  constructor(app, onSubmit, existing = null, { accountChoices = [] } = {}) {
    super(app);
    this.onSubmit = onSubmit;
    this.existing = existing;
    this.accountChoices = accountChoices || [];
  }
  onOpen() {
    const { contentEl } = this;
    const e = this.existing;
    const isEdit = !!(e && e.id);
    contentEl.createEl("h2", { text: isEdit ? `Edit goal: ${e.name}` : "New savings goal" });
    const d = {
      name: e ? e.name : "",
      target_amount: e ? String(e.target_amount || "") : "",
      saved_amount: e ? String(e.saved_amount || 0) : "0",
      target_date: e ? e.target_date || "" : "",
      account_id: e ? e.account_id || "" : "",
      track_from: e ? e.track_from || "" : ""
    };

    new Setting(contentEl)
      .setName("Goal name")
      .setDesc("e.g. Emergency Fund, Car Repairs, Vet Bill")
      .addText((t) => t.setValue(d.name).onChange((v) => (d.name = v)));
    const targetSetting = new Setting(contentEl).setName("Target amount");
    targetSetting.addText((t) =>
      bindMoneyInput(t, targetSetting).setValue(d.target_amount).onChange((v) => (d.target_amount = v))
    );
    const savedSetting = new Setting(contentEl).setName("Already saved").setDesc("What's set aside for this today.");
    savedSetting.addText((t) =>
      bindMoneyInput(t, savedSetting).setValue(d.saved_amount).onChange((v) => (d.saved_amount = v))
    );
    new Setting(contentEl)
      .setName("Target date (optional)")
      .setDesc("Used to suggest a per-paycheck pace.")
      .addText((t) => bindDateInput(t, d.target_date).onChange((v) => (d.target_date = v)));

    // Optional: the savings account the goal's money lives in. Its transfers
    // then count toward the goal without logging each one by hand.
    const choices = this.accountChoices.slice();
    if (d.account_id && !choices.some((c) => c.id === d.account_id)) {
      choices.unshift({ id: d.account_id, label: `${d.account_id} (no longer in your accounts)`, others: [] });
    }
    let fromSetting = null;
    let fromInput = null;
    const showFrom = () => fromSetting && fromSetting.settingEl.toggleClass("budget-hidden", !d.account_id);
    if (choices.length) {
      new Setting(contentEl)
        .setName("Savings account (optional)")
        .setDesc(
          "Transfers into and out of this account count toward the goal. If other goals use the same account, you'll pick the goal for each transfer."
        )
        .addDropdown((dd) => {
          dd.addOption("", "None — I'll log contributions myself");
          choices.forEach((c) => dd.addOption(c.id, c.label + (c.others.length ? ` (also ${c.others.join(", ")})` : "")));
          dd.setValue(d.account_id).onChange((v) => {
            // A new account starts counting today unless you say otherwise:
            // its older history is money that was there before this goal.
            if (v && v !== (e && e.account_id)) d.track_from = todayLocal();
            if (!v) d.track_from = "";
            d.account_id = v;
            if (fromInput) fromInput.setValue(d.track_from);
            showFrom();
          });
        });
      fromSetting = new Setting(contentEl)
        .setName("Count transfers from")
        .setDesc("Transfers on or after this date count toward the goal. Set it earlier to include ones already imported.")
        .addText((t) => {
          fromInput = bindDateInput(t, d.track_from).onChange((v) => (d.track_from = v));
        });
      showFrom();
    }

    new Setting(contentEl).addButton((b) =>
      b
        .setButtonText(isEdit ? "Save changes" : "Create goal")
        .setCta()
        .onClick(() => {
          if (!d.name.trim()) {
            new Notice("Give the goal a name.");
            return;
          }
          const target = requireMoney(d.target_amount, "Target amount");
          if (target == null) return;
          if (target <= 0) {
            new Notice("Target amount must be greater than 0.");
            return;
          }
          const saved = requireMoney(d.saved_amount, "Already saved", { optional: true });
          if (saved == null) return;
          const date = d.target_date.trim() ? normalizeDate(d.target_date.trim()) : "";
          if (date && !/^\d{4}-\d{2}-\d{2}$/.test(date)) {
            new Notice("Pick a target date, or leave it blank.");
            return;
          }
          let from = null;
          if (d.account_id) {
            from = String(d.track_from || "").trim() ? normalizeDate(String(d.track_from).trim()) : todayLocal();
            if (!/^\d{4}-\d{2}-\d{2}$/.test(from)) {
              new Notice("Pick the date to count transfers from.");
              return;
            }
          }
          this.close();
          this.onSubmit({
            name: d.name.trim(),
            target_amount: round2(target),
            saved_amount: round2(saved),
            target_date: date || null,
            account_id: d.account_id || null,
            track_from: from
          });
        })
    );
  }
  onClose() {
    this.contentEl.empty();
  }
}

// Creates or edits a capped fund: a name, a ceiling, the account it follows and
// where it sits on the Overview. There's no "already saved" and no date — the
// account's balance is what's saved, and a buffer has no finish line.
//
// `choices` come from the plugin (fundAccountChoices) so this modal never reads
// the vault itself; `openBankSync` is how it sends someone to set sync up when
// there is nothing to choose yet.
class CappedFundModal extends Modal {
  constructor(app, { existing = null, choices = [], connected = false, unlinkedLocal = [], openBankSync = null } = {}, onSubmit) {
    super(app);
    this.existing = existing;
    this.choices = choices || [];
    this.unlinkedLocal = unlinkedLocal || [];
    this.connected = connected;
    this.openBankSync = openBankSync;
    this.onSubmit = onSubmit;
  }
  onOpen() {
    const { contentEl } = this;
    contentEl.addClass("budget-fund-modal");
    const e = this.existing;
    contentEl.createEl("h2", { text: e ? `Edit ${e.name}` : "New capped fund" });
    contentEl.createEl("p", {
      text:
        "A fund that follows a savings account. Its balance is the account's balance at each sync, so there's " +
        "nothing to log by hand. It asks for a share of your surplus until it reaches its ceiling, and less the " +
        "closer it gets.",
      cls: "budget-muted"
    });

    const d = {
      name: e ? e.name : "Oopsie Fund",
      target_amount: e && e.target_amount != null ? String(e.target_amount) : "",
      choice: e && e.account_id ? `local:${e.account_id}` : "",
      placement: e ? fundPlacement(e) : "cards"
    };

    new Setting(contentEl)
      .setName("Name")
      .setDesc("Oopsie Fund, Bullshit Balance — whatever you'll recognise.")
      .addText((t) => t.setValue(d.name).onChange((v) => (d.name = v)));

    const capSetting = new Setting(contentEl)
      .setName("Ceiling")
      .setDesc("Where it stops asking for surplus. The account can hold more; the fund just won't ask for it.");
    capSetting.addText((t) => bindMoneyInput(t, capSetting).setValue(d.target_amount).onChange((v) => (d.target_amount = v)));

    const acct = new Setting(contentEl).setName("Account");
    // A savings account already here but not linked may be the one they want.
    // Adding it again from SimpleFIN would import its history twice, so those
    // aren't offered, and this says how to get it listed.
    const waiting = this.unlinkedLocal.length
      ? `${this.unlinkedLocal.join(", ")} ${this.unlinkedLocal.length === 1 ? "is" : "are"} in your accounts but not linked to ` +
        "SimpleFIN, so SimpleFIN accounts aren't offered here \u2014 adding one could import the same history twice. " +
        "Link it under Settings \u2192 Accounts (Edit \u2192 SimpleFIN account) and it will be listed."
      : "";
    if (this.choices.length) {
      acct.setDesc("Use an account that holds only this fund \u2014 all of its balance counts toward the ceiling.");
      acct.addDropdown((dd) => {
        dd.addOption("", "Choose an account\u2026");
        this.choices.forEach((c) => dd.addOption(c.value, c.label));
        dd.setValue(d.choice).onChange((v) => (d.choice = v));
      });
      if (waiting) contentEl.createEl("p", { text: waiting, cls: "budget-muted budget-fund-waiting" });
    } else {
      acct.setDesc(
        waiting ||
          (this.connected
            ? "SimpleFIN hasn't reported an account to use yet. Sync once, then try again."
            : "The balance comes from bank sync, so connect SimpleFIN first.")
      );
      if (!this.connected && this.openBankSync) {
        acct.addButton((b) =>
          b.setButtonText("Set up bank sync").onClick(() => {
            this.close();
            this.openBankSync();
          })
        );
      }
    }

    new Setting(contentEl)
      .setName("Show it")
      .setDesc("Where it sits on the Overview. Move it any time.")
      .addDropdown((dd) => {
        FUND_PLACEMENTS.forEach((p) => dd.addOption(p, FUND_PLACEMENT_LABELS[p]));
        dd.setValue(d.placement).onChange((v) => (d.placement = v));
      });

    new Setting(contentEl).addButton((b) =>
      b
        .setButtonText(e ? "Save changes" : "Create fund")
        .setCta()
        .onClick(() => {
          const name = String(d.name || "").trim();
          if (!name) {
            new Notice("Give the fund a name.");
            return;
          }
          const cap = requireMoney(d.target_amount, "Ceiling");
          if (cap == null) return;
          if (cap <= 0) {
            new Notice("The ceiling has to be more than $0.");
            return;
          }
          const chosen = this.choices.find((c) => c.value === d.choice);
          if (!chosen) {
            new Notice(
              this.choices.length
                ? "Choose the account this fund follows."
                : "There's no account for it to follow yet. Set up bank sync first."
            );
            return;
          }
          if (chosen.missing) {
            new Notice("That account is gone. Choose another one.");
            return;
          }
          if (chosen.takenBy) {
            new Notice(`${chosen.takenBy} already follows that account. One account can back one fund.`);
            return;
          }
          this.close();
          this.onSubmit({
            name,
            target_amount: round2(cap),
            choice: d.choice,
            placement: FUND_PLACEMENTS.includes(d.placement) ? d.placement : "cards"
          });
        })
    );
  }
  onClose() {
    this.contentEl.empty();
  }
}

// Offered once, when a pay period closes with part of its spending allowance
// unspent. The leftover is real money the user already decided they could live
// without, so it's the cleanest sweep candidate there is — but nothing moves
// until they say so, and declining is recorded so it is never asked again.
// The "still need matching" list, one place to clear them from.
//
// Deliberately plain: a payment, what it probably paid, and one button. The
// suggestion comes from the same amount-and-class pairing the Overview uses, and
// is never applied without the user choosing it.
// Plain-language names for the kinds of money the match list can contain. The
// resolver's own vocabulary never reaches the screen.
const KIND_LABELS = {
  debt: "debt payment",
  fixed_expense: "bill",
  subscription: "subscription"
};

// "Which of these did it pay?" — asked when more than one thing could be the
// answer, which is the normal case rather than an edge case: six BNPL plans all
// take payments in the same category, so the category alone can never decide.
//
// Before this existed the flow gave up at exactly that point and dropped the
// user on the Debts tab with a notice, which made the whole match window look
// broken. Nothing is inferred here; the list is shown and the user picks.
class PickObligationModal extends Modal {
  constructor(app, { tx, options = [], rules = [], title = "What did this pay?" }, onPick) {
    super(app);
    this.tx = tx;
    this.options = options;
    this.rules = rules;
    this.title = title;
    this.onPick = onPick;
  }
  onOpen() {
    const { contentEl } = this;
    contentEl.addClass("budget-match-modal");
    contentEl.createEl("h2", { text: this.title });

    const amount = Math.abs(Number(this.tx && this.tx.amount) || 0);
    contentEl.createEl("p", {
      text:
        `${displayMerchant(this.tx && this.tx.merchant_raw, this.rules)} — ` +
        `$${amount.toFixed(2)}${this.tx && this.tx.date ? ` on ${this.tx.date}` : ""}.`,
      cls: "budget-muted"
    });

    const list = contentEl.createDiv({ cls: "budget-apply-list" });
    this.options.forEach((opt) => {
      const row = list.createDiv({ cls: "budget-apply-row" });
      const label = row.createDiv({ cls: "budget-apply-label" });
      label.createDiv({ text: opt.label });
      const meta = label.createDiv({ cls: "budget-apply-meta" });
      if (opt.sublabel) meta.createSpan({ text: opt.sublabel });
      // An exact amount match is a strong hint but never an instruction — this
      // is the same amount-matching that once let a $50 dinner stand in for a
      // $50 insurance bill, so it is shown and not acted on.
      if (opt.amount != null && Math.abs(Math.abs(opt.amount) - amount) < 0.005) {
        meta.createSpan({ text: "same amount", cls: "budget-badge budget-badge-pinned" });
      }
      if (opt.amount != null) {
        row.createSpan({ text: `$${Math.abs(opt.amount).toFixed(2)}`, cls: "budget-amount" });
      }
      const btn = row.createEl("button", { text: "This one", cls: "budget-btn budget-review-btn" });
      btn.onclick = async () => {
        this.close();
        await this.onPick(opt);
      };
    });

    new Setting(contentEl).addButton((b) => b.setButtonText("Cancel").onClick(() => this.close()));
  }
  onClose() {
    this.contentEl.empty();
  }
}

class MatchPaymentsModal extends Modal {
  constructor(app, plugin, { payments = [], pairs = [], obligations = [], rules = [] }) {
    super(app);
    this.plugin = plugin;
    this.payments = payments;
    this.pairs = pairs;
    this.obligations = obligations;
    this.rules = rules;
  }
  onOpen() {
    const { contentEl } = this;
    contentEl.addClass("budget-match-modal");
    contentEl.createEl("h2", { text: "Payments to match" });
    contentEl.createEl("p", {
      text:
        "Each of these is already treated as a bill or debt payment rather than spending. " +
        "Matching one tells the budget which obligation it paid, so the money still being held " +
        "back for that obligation is released.",
      cls: "budget-muted"
    });

    const suggestionFor = (tx) => {
      const hit = this.pairs.find((p) => p.candidate && p.candidate.id === tx.id);
      return hit ? hit.obligation : null;
    };

    const list = contentEl.createDiv({ cls: "budget-apply-list" });
    this.payments.forEach((tx) => {
      const row = list.createDiv({ cls: "budget-apply-row" });
      const label = row.createDiv({ cls: "budget-apply-label" });
      label
        .createDiv({ text: displayMerchant(tx.merchant_raw, this.rules) })
        .setAttr("title", tx.merchant_raw || "");
      const meta = label.createDiv({ cls: "budget-apply-meta" });
      meta.createSpan({ text: tx.date });
      if (tx.category) meta.createSpan({ text: tx.category });
      const sug = suggestionFor(tx);
      if (sug) meta.createSpan({ text: `probably ${sug.label}`, cls: "budget-badge budget-badge-pinned" });
      else if (KIND_LABELS[tx.class]) meta.createSpan({ text: KIND_LABELS[tx.class] });
      row.createSpan({ text: `$${tx.amount.toFixed(2)}`, cls: "budget-amount" });

      const btn = row.createEl("button", { text: "Match", cls: "budget-btn budget-review-btn" });
      btn.onclick = async () => {
        this.close();
        await this.plugin.startMatchFlow(tx, sug, this.obligations);
      };
    });

    new Setting(contentEl).addButton((b) => b.setButtonText("Done").setCta().onClick(() => this.close()));
  }
  onClose() {
    this.contentEl.empty();
  }
}

class BufferSweepModal extends Modal {
  constructor(app, { remaining, allocated, spent, periodStart, periodEnd, plan }, onSubmit) {
    super(app);
    this.remaining = remaining;
    this.allocated = allocated;
    this.spent = spent;
    this.periodStart = periodStart;
    this.periodEnd = periodEnd;
    // plan(amount) -> { breakdown, total }, supplied by the caller so the split
    // comes from recommendSavings rather than a second allocator living here.
    this.plan = plan;
    this.onSubmit = onSubmit;
    this.amount = remaining;
  }
  onOpen() {
    const { contentEl } = this;
    contentEl.addClass("budget-sweep-modal");
    contentEl.createEl("h2", { text: "Unspent allowance" });
    contentEl.createEl("p", {
      text:
        `You finished ${this.periodStart} → ${this.periodEnd} with $${this.remaining.toFixed(2)} of your ` +
        `$${this.allocated.toFixed(2)} spending allowance unused ($${this.spent.toFixed(2)} spent).`
    });
    contentEl.createEl("p", {
      text:
        "It's split across your goals the same way any surplus would be — dated goals at the pace they " +
        "need first, then top-ups. Each contribution is held back from free cash until you match it to the " +
        "real transfer.",
      cls: "budget-muted budget-apply-scope"
    });

    const planBox = contentEl.createDiv({ cls: "budget-apply-list" });
    const totalEl = contentEl.createEl("p", { cls: "budget-muted budget-apply-total" });

    const renderPlan = () => {
      planBox.empty();
      const { breakdown, total } = this.plan(this.amount);
      breakdown.forEach((b) => {
        const row = planBox.createDiv({ cls: "budget-apply-row" });
        const label = row.createDiv({ cls: "budget-apply-label" });
        label.createDiv({ text: b.target });
        label.createDiv({ text: b.reason, cls: "budget-apply-meta" });
        row.createSpan({ text: `$${b.amount.toFixed(2)}`, cls: "budget-amount" });
      });
      if (!breakdown.length) {
        planBox.createEl("p", { text: "No goal has room for this right now.", cls: "budget-muted" });
      }
      const leftover = round2(this.amount - total);
      totalEl.setText(
        leftover > 0.005
          ? `$${total.toFixed(2)} to goals. $${leftover.toFixed(2)} won't fit — every goal it could reach is already at its target, so that stays as free cash.`
          : `$${total.toFixed(2)} to goals.`
      );
      return total;
    };
    renderPlan();

    const sweepSetting = new Setting(contentEl)
      .setName("Amount")
      .setDesc("Defaults to the whole unspent allowance. Lower it if some of that money is already spoken for.");
    sweepSetting.addText((t) =>
      bindMoneyInput(t, sweepSetting)
        .setValue(this.remaining.toFixed(2))
        .onChange((v) => {
          const r = parseMoneyInput(v);
          this.amount = r.ok && !r.empty ? round2(Math.min(Math.max(0, r.value), this.remaining)) : 0;
          renderPlan();
        })
    );

    new Setting(contentEl)
      .addButton((b) =>
        b
          .setButtonText("Add to savings")
          .setCta()
          .onClick(() => {
            if (this.amount <= 0) {
              new Notice("Enter an amount.");
              return;
            }
            const { breakdown, total } = this.plan(this.amount);
            if (!breakdown.length || total <= 0) {
              new Notice("No goal has room for this right now.");
              return;
            }
            this.close();
            this.onSubmit({ action: "sweep", breakdown, amount: total });
          })
      )
      .addButton((b) =>
        b.setButtonText("Not this time").onClick(() => {
          this.close();
          this.onSubmit({ action: "dismiss" });
        })
      );
  }
  onClose() {
    this.contentEl.empty();
    // Closing without choosing leaves the sweep PENDING, not dismissed. The
    // offer only appears at a period boundary, so treating a stray close as a
    // permanent decline destroyed the opportunity and stranded the money.
  }
}

class AddFundsModal extends Modal {
  constructor(app, goal, freeCash, onSubmit) {
    super(app);
    this.goal = goal;
    this.freeCash = freeCash;
    this.onSubmit = onSubmit;
  }
  onOpen() {
    const { contentEl } = this;
    const g = this.goal;
    const p = goalProgress(g);
    contentEl.createEl("h2", { text: `Add funds: ${g.name}` });
    contentEl.createEl("p", {
      text: `$${p.saved.toFixed(2)} of $${p.target.toFixed(2)} saved \u2014 $${p.remaining.toFixed(2)} to go.`,
      cls: "budget-muted"
    });
    if (this.freeCash != null) {
      contentEl.createEl("p", {
        text:
          `Free cash this period: $${this.freeCash.toFixed(2)}. This amount is held back from free cash right away, ` +
          "even before the transfer actually posts \u2014 match it to the real transaction later and it stops being held back.",
        cls: "budget-muted budget-apply-scope"
      });
    }

    let amount = "";
    let note = "";
    const moveSetting = new Setting(contentEl)
      .setName("Amount to move")
      .setDesc("Negative takes money back out of the goal.");
    moveSetting.addText((t) => bindMoneyInput(t, moveSetting, { allowNegative: true }).onChange((v) => (amount = v)));
    new Setting(contentEl).setName("Note (optional)").addText((t) => t.onChange((v) => (note = v)));

    if (p.remaining > 0) {
      new Setting(contentEl).addButton((b) =>
        b.setButtonText(`Fill remaining ($${p.remaining.toFixed(2)})`).onClick(() => {
          this.close();
          this.onSubmit(p.remaining, note);
        })
      );
    }

    new Setting(contentEl).addButton((b) =>
      b
        .setButtonText("Add funds")
        .setCta()
        .onClick(() => {
          const n = requireMoney(amount, "Amount to move", { allowNegative: true });
          if (n == null) return;
          if (n === 0) {
            new Notice("Enter an amount.");
            return;
          }
          this.close();
          this.onSubmit(round2(n), note);
        })
    );
  }
  onClose() {
    this.contentEl.empty();
  }
}

class LinkContributionModal extends Modal {
  constructor(app, goal, contribution, candidates, onSubmit, rules = []) {
    super(app);
    this.goal = goal;
    this.contribution = contribution;
    this.candidates = candidates;
    this.onSubmit = onSubmit;
    this.rules = rules;
  }
  onOpen() {
    const { contentEl } = this;
    const c = this.contribution;
    contentEl.createEl("h2", { text: "Match this contribution to a transaction" });
    contentEl.createEl("p", {
      text: `$${c.amount.toFixed(2)} recorded on ${c.date} for ${this.goal.name}.`,
      cls: "budget-muted"
    });
    contentEl.createEl("p", {
      text:
        "Linking doesn't move any more money. It marks the transfer as this contribution, categorizes " +
        "it as Savings (a transfer, so it won't count as spending), and stops the amount being held " +
        "back from free cash \u2014 your balance already reflects it.",
      cls: "budget-muted budget-apply-scope"
    });

    if (this.candidates.length === 0) {
      contentEl.createEl("p", {
        text: `No unclaimed outgoing transaction for exactly $${Math.abs(c.amount).toFixed(2)} found. Import the export containing the transfer, then try again.`,
        cls: "budget-muted"
      });
      return;
    }

    const list = contentEl.createDiv({ cls: "budget-apply-list" });
    this.candidates.slice(0, 25).forEach((t) => {
      const row = list.createDiv({ cls: "budget-apply-row" });
      const label = row.createDiv({ cls: "budget-apply-label" });
      label.createDiv({ text: displayMerchant(t.merchant_raw, this.rules) }).setAttr("title", t.merchant_raw);
      const gap = Math.abs(daysBetween(c.date, t.date || c.date));
      label.createDiv({
        text: `${t.date} \u00b7 ${t.resolved_category || "Uncategorized"}${gap ? ` \u00b7 ${gap} day${gap === 1 ? "" : "s"} from the contribution` : " \u00b7 same day"}`,
        cls: "budget-apply-meta"
      });
      row.createSpan({ text: `$${Math.abs(t.amount).toFixed(2)}`, cls: "budget-amount" });
      const pick = row.createEl("button", { text: "Link", cls: "budget-btn mod-cta" });
      pick.onclick = () => {
        this.close();
        this.onSubmit(t);
      };
    });
  }
  onClose() {
    this.contentEl.empty();
  }
}

class TargetTunerModal extends Modal {
  constructor(app, categoryName, baseline, baselineMonthKey, currentTarget, onSubmit) {
    super(app);
    this.categoryName = categoryName;
    this.baseline = baseline;
    this.baselineMonthKey = baselineMonthKey;
    this.currentTarget = currentTarget || 0;
    this.onSubmit = onSubmit;
  }
  onOpen() {
    const { contentEl } = this;
    contentEl.createEl("h2", { text: `Tune Target: ${this.categoryName}` });

    if (this.baseline <= 0) {
      contentEl.createEl("p", {
        text: `No spending recorded for ${this.categoryName} in ${monthLabel(this.baselineMonthKey)}, so there's no baseline to cut from. Set a target by hand in Settings instead.`,
        cls: "budget-muted"
      });
      return;
    }

    contentEl.createEl("p", {
      text: `Spent in ${monthLabel(this.baselineMonthKey)}: $${this.baseline.toFixed(2)}`,
      cls: "budget-tuner-baseline"
    });
    if (this.currentTarget > 0) {
      contentEl.createEl("p", {
        text: `Current target: $${this.currentTarget.toFixed(2)}/mo`,
        cls: "budget-muted"
      });
    }

    // Start at the existing target's implied reduction, rounded to the step.
    let reduction = 0;
    if (this.currentTarget > 0 && this.currentTarget < this.baseline) {
      const implied = (1 - this.currentTarget / this.baseline) * 100;
      reduction = Math.min(60, Math.max(0, Math.round(implied / 5) * 5));
    }

    const preview = contentEl.createDiv({ cls: "budget-tuner-preview" });
    const targetEl = preview.createDiv({ cls: "budget-tuner-target" });
    const savedEl = preview.createDiv({ cls: "budget-tuner-saved" });

    const sliderWrap = contentEl.createDiv({ cls: "budget-tuner-slider-wrap" });
    const slider = sliderWrap.createEl("input", { cls: "budget-tuner-slider" });
    slider.type = "range";
    slider.min = "0";
    slider.max = "60";
    slider.step = "5";
    slider.value = String(reduction);

    const ticks = sliderWrap.createDiv({ cls: "budget-tuner-ticks" });
    ["0%", "15%", "30%", "45%", "60%"].forEach((t) => ticks.createSpan({ text: t }));

    const calcTarget = (pct) => round2(this.baseline * (1 - pct / 100));

    const refresh = () => {
      const pct = parseInt(slider.value, 10) || 0;
      const target = calcTarget(pct);
      const freed = round2(this.baseline - target);
      targetEl.setText(`Target: $${target.toFixed(2)}/mo (${pct === 0 ? "no change" : `-${pct}%`})`);
      savedEl.setText(
        pct === 0
          ? "Matches last month's spending \u2014 nothing freed up."
          : `+$${freed.toFixed(2)}/mo freed up \u00b7 $${(freed * 12).toFixed(2)} a year`
      );
      savedEl.toggleClass("budget-positive", pct > 0);
    };

    slider.addEventListener("input", refresh);
    refresh();

    new Setting(contentEl).addButton((b) =>
      b
        .setButtonText("Save target")
        .setCta()
        .onClick(() => {
          const pct = parseInt(slider.value, 10) || 0;
          this.close();
          this.onSubmit(calcTarget(pct), pct);
        })
    );
  }
  onClose() {
    this.contentEl.empty();
  }
}

// Free cash is only as good as the balance it's derived from, and an
// auto-rolled period reuses the last known figure. This makes correcting it a
// single step instead of a full Enter Paycheck round trip.
class QuickBalanceModal extends Modal {
  constructor(app, accounts, onSubmit) {
    super(app);
    this.accounts = accounts;
    this.onSubmit = onSubmit;
  }
  onOpen() {
    const { contentEl } = this;
    contentEl.createEl("h2", { text: "Update balances" });
    contentEl.createEl("p", {
      text: "Everything on the dashboard is calculated from these. If free cash looks wrong, it's almost always because one of these is stale.",
      cls: "budget-muted"
    });

    if (!this.accounts.length) {
      contentEl.createEl("p", { text: "No accounts yet — add one first.", cls: "budget-muted" });
      return;
    }

    const values = {};
    this.accounts.forEach((a) => {
      values[a.id] = String(a.current_balance ?? 0);
      const setting = new Setting(contentEl)
        .setName(`${a.institution || a.id}`)
        .setDesc(
          a.type === "credit_card"
            ? `Credit card — what you owe right now${a.credit_limit ? ` (limit $${a.credit_limit})` : ""}`
            : `${a.type} — what's in it right now`
        );
      setting.addText((t) =>
        bindMoneyInput(t, setting, { allowNegative: true }).setValue(values[a.id]).onChange((v) => (values[a.id] = v))
      );
    });

    new Setting(contentEl).addButton((b) =>
      b
        .setButtonText("Save balances")
        .setCta()
        .onClick(() => {
          const patch = {};
          for (const a of this.accounts) {
            const n = requireMoney(values[a.id], a.institution || a.id, { allowNegative: true });
            if (n == null) return;
            patch[a.id] = round2(n);
          }
          this.close();
          this.onSubmit(patch);
        })
    );
  }
  onClose() {
    this.contentEl.empty();
  }
}

class ConfirmModal extends Modal {
  constructor(app, { title, body, confirmText = "Delete", onConfirm }) {
    super(app);
    this.opts = { title, body, confirmText, onConfirm };
  }
  onOpen() {
    const { contentEl } = this;
    contentEl.createEl("h2", { text: this.opts.title });
    (Array.isArray(this.opts.body) ? this.opts.body : [this.opts.body])
      .filter(Boolean)
      .forEach((line) => contentEl.createEl("p", { text: line, cls: "budget-muted" }));
    new Setting(contentEl)
      .addButton((b) => b.setButtonText("Cancel").onClick(() => this.close()))
      .addButton((b) =>
        b
          .setButtonText(this.opts.confirmText)
          .setWarning()
          .onClick(() => {
            this.close();
            this.opts.onConfirm();
          })
      );
  }
  onClose() {
    this.contentEl.empty();
  }
}

// Deleting a category isn't just removing a row: rules produce it and
// transactions carry it. Those have to go somewhere, so the choice is explicit
// rather than silently dumping everything into Uncategorized.
class DeleteCategoryModal extends Modal {
  constructor(app, category, allCategories, dependents, onConfirm) {
    super(app);
    this.category = category;
    this.allCategories = allCategories;
    // Bills and debts that declared this category as where their charges land.
    // They are the quiet casualty of a delete: nothing visibly breaks, the
    // tracker just stops recognising its own payments.
    this.dependents = dependents || [];
    this.onConfirm = onConfirm;
  }
  onOpen() {
    const { contentEl } = this;
    const c = this.category;
    contentEl.createEl("h2", { text: `Delete “${c.name}”` });

    const bits = [];
    if (c.ruleCount) bits.push(`${c.ruleCount} rule${c.ruleCount === 1 ? "" : "s"}`);
    if (c.txCount) bits.push(`${c.txCount} transaction${c.txCount === 1 ? "" : "s"}`);
    if (c.overrideCount) bits.push(`${c.overrideCount} override${c.overrideCount === 1 ? "" : "s"}`);

    contentEl.createEl("p", {
      text: bits.length ? `Currently used by ${bits.join(", ")}.` : "Not used by anything.",
      cls: "budget-muted"
    });

    if (this.dependents.length) {
      contentEl.createEl("p", {
        text:
          `${this.dependents.join(", ")} ${this.dependents.length === 1 ? "expects" : "expect"} ` +
          `charges in this category. ${this.dependents.length === 1 ? "It follows" : "They follow"} ` +
          "whatever you choose below, so payments keep being recognised.",
        cls: "budget-muted"
      });
    }

    let target = "";
    const options = sortCategoriesByUse(this.allCategories.filter((x) => x.name !== c.name).map((x) => x.name));

    if (bits.length) {
      new Setting(contentEl)
        .setName("Move its transactions and rules to")
        .setDesc("Leave as Uncategorized to strip the label instead.")
        .addDropdown((d) => {
          d.addOption("", "Uncategorized");
          options.forEach((n) => d.addOption(n, n));
          d.onChange((v) => (target = v));
        });
      contentEl.createEl("p", {
        text: "Rules pointing at this category are re-pointed too, so future imports follow the same choice.",
        cls: "budget-muted"
      });
    }

    new Setting(contentEl)
      .addButton((b) => b.setButtonText("Cancel").onClick(() => this.close()))
      .addButton((b) =>
        b
          .setButtonText("Delete category")
          .setWarning()
          .onClick(() => {
            this.close();
            this.onConfirm(target || null);
          })
      );
  }
  onClose() {
    this.contentEl.empty();
  }
}

async function deleteCategory(app, name, reassignTo) {
  const cats = await readJSON(app, FILES.categories, []);
  const rules = await readJSON(app, FILES.rules, []);
  const txs = await readJSON(app, FILES.transactions, []);

  let rulesChanged = 0;
  let txChanged = 0;

  // Bills and debts that declared this as where their charges land follow the
  // reassignment, or lose the declaration entirely when there is nowhere to
  // point. Leaving it aimed at a deleted category is the worst of the three:
  // the tracker looks configured and quietly matches nothing.
  const paymentCategoriesChanged = await repointPaymentCategories(app, name, reassignTo || null);

  if (reassignTo) {
    rules.forEach((r) => {
      if (r.home_label === name) {
        r.home_label = reassignTo;
        rulesChanged++;
      }
    });
    txs.forEach((t) => {
      if (t.override_label === name) {
        t.override_label = reassignTo;
        txChanged++;
      }
    });
  } else {
    // No target: drop the rules entirely and clear overrides, which lets the
    // transactions fall back to Uncategorized.
    for (let i = rules.length - 1; i >= 0; i--) {
      if (rules[i].home_label === name) {
        rules.splice(i, 1);
        rulesChanged++;
      }
    }
    txs.forEach((t) => {
      if (t.override_label === name) {
        t.override_label = null;
        txChanged++;
      }
    });
  }

  const nextCats = cats.filter((c) => c.name !== name);
  await writeJSON(app, FILES.categories, nextCats);
  await writeJSON(app, FILES.rules, rules);
  applyCategorization(txs, rules);
  await writeJSON(app, FILES.transactions, txs);
  await carryCategoryOrder(app, name, reassignTo || null);
  return { rulesChanged, txChanged, paymentCategoriesChanged };
}

// An investment account: which company, what kind, what to call it, and how
// often its statements come. Nothing here is a balance — balances only ever
// come from imported statements.
class PortfolioAccountModal extends Modal {
  constructor(app, { existing = null, prefill = null, others = [], onCancel = null } = {}, onSubmit) {
    super(app);
    this.existing = existing;
    this.prefill = prefill;
    this.others = others || [];
    this.onSubmit = onSubmit;
    this.onCancel = onCancel;
    this.submitted = false;
  }
  onOpen() {
    const { contentEl } = this;
    contentEl.addClass("budget-pf-account-modal");
    const e = this.existing;
    const p = e || this.prefill || {};
    contentEl.createEl("h2", { text: e ? `Edit ${e.label}` : "New investment account" });
    contentEl.createEl("p", {
      text:
        "A slow-moving account — retirement, HSA, brokerage — tracked from the statements you paste. " +
        "It never counts toward cash, Spendable, goals or debt.",
      cls: "budget-muted"
    });

    const known = PF_PROVIDERS.find((x) => pfSameProvider(x, p.provider));
    const d = {
      providerChoice: known || (p.provider ? "__other" : ""),
      otherProvider: known ? "" : String(p.provider || ""),
      type: Object.prototype.hasOwnProperty.call(PF_TYPES, p.type) ? p.type : "401k",
      label: String(p.label || ""),
      cadence: pfCadence(p),
      account_hint: p.account_hint ? String(p.account_hint) : ""
    };
    const provider = () => (d.providerChoice === "__other" ? d.otherProvider.trim() : d.providerChoice);
    // The name follows the company and type until someone types their own.
    let named = !!e || (!!p.label && p.label !== pfDefaultLabel(p.provider, p.type));
    let labelText = null;
    const suggest = () => {
      if (named || !labelText) return;
      d.label = pfDefaultLabel(provider(), d.type);
      labelText.setValue(d.label);
    };

    new Setting(contentEl)
      .setName("Company")
      .setDesc("Named companies' statements are recognised on sight. Any other works too.")
      .addDropdown((dd) => {
        dd.addOption("", "Choose…");
        PF_PROVIDERS.forEach((x) => dd.addOption(x, x));
        dd.addOption("__other", "Other…");
        dd.setValue(d.providerChoice).onChange((v) => {
          d.providerChoice = v;
          otherRow.settingEl.toggleClass("budget-hidden", v !== "__other");
          suggest();
        });
      });
    const otherRow = new Setting(contentEl)
      .setName("Company name")
      .addText((t) =>
        t
          .setPlaceholder("e.g. TIAA")
          .setValue(d.otherProvider)
          .onChange((v) => {
            d.otherProvider = v;
            suggest();
          })
      );
    otherRow.settingEl.toggleClass("budget-hidden", d.providerChoice !== "__other");

    new Setting(contentEl).setName("Kind of account").addDropdown((dd) => {
      Object.entries(PF_TYPES).forEach(([k, v]) => dd.addOption(k, v));
      dd.setValue(d.type).onChange((v) => {
        d.type = v;
        suggest();
      });
    });

    new Setting(contentEl).setName("Name").addText((t) => {
      labelText = t;
      t.setValue(d.label).onChange((v) => {
        d.label = v;
        named = !!v.trim();
      });
    });
    if (!d.label) suggest();

    new Setting(contentEl)
      .setName("Statements come")
      .setDesc("Decides when a missing statement is worth a reminder. Many retirement plans only publish quarterly.")
      .addDropdown((dd) => {
        Object.entries(PF_CADENCES).forEach(([k, v]) => dd.addOption(k, v));
        dd.setValue(d.cadence).onChange((v) => (d.cadence = v));
      });

    new Setting(contentEl)
      .setName("Last 4 of account number")
      .setDesc("Optional. Only used to tell two accounts of the same kind apart.")
      .addText((t) => {
        t.inputEl.setAttr("inputmode", "numeric");
        t.inputEl.setAttr("maxlength", "4");
        t.setValue(d.account_hint).onChange((v) => (d.account_hint = v));
      });

    new Setting(contentEl).addButton((b) =>
      b
        .setButtonText(e ? "Save changes" : "Add account")
        .setCta()
        .onClick(() => {
          if (!provider()) {
            new Notice(d.providerChoice === "__other" ? "Enter the company's name." : "Choose the company.");
            return;
          }
          const hint = String(d.account_hint || "").trim();
          if (hint && !/^\d{4}$/.test(hint)) {
            new Notice("The last 4 has to be exactly four digits, or left blank.");
            return;
          }
          const account = pfAccountFromForm(
            { provider: provider(), type: d.type, label: d.label, cadence: d.cadence, account_hint: hint },
            e
          );
          const clash = this.others.find((o) => o.id !== account.id && o.label.toLowerCase() === account.label.toLowerCase());
          if (clash) {
            new Notice(`There's already an account called ${clash.label}. Give this one a different name.`);
            return;
          }
          // Names are checked against the list read when the form opened; the
          // save itself re-checks against the file (savePortfolioAccount).
          this.submitted = true;
          this.close();
          this.onSubmit(account);
        })
    );
  }
  onClose() {
    this.contentEl.empty();
    if (!this.submitted && this.onCancel) this.onCancel();
  }
}

class PortfolioImportModal extends Modal {
  constructor(app, plugin, onImported) {
    super(app);
    this.plugin = plugin;
    this.onImported = onImported;
    // Held in a closure only. Never written to disk, never logged.
    this.pastedText = "";
  }

  onOpen() {
    this.modalEl.addClass("budget-portfolio-modal");
    const { contentEl } = this;
    contentEl.createEl("h2", { text: "Import Portfolio Statement" });
    contentEl.createEl("p", {
      text:
        "Open a statement from a retirement, HSA or brokerage account — Fidelity, Vanguard, Empower, Schwab or " +
        "another company — then Select All, Copy, and paste it below.",
      cls: "budget-muted"
    });
    contentEl.createEl("p", {
      text:
        "Only balances, dates, holdings and allocation are read. Name, address, employee number and " +
        "bank details are ignored and never saved, and the pasted text itself is never written to disk. The last " +
        "4 digits of the account number are looked at to match the statement to your account, and aren't kept.",
      cls: "budget-muted budget-apply-scope"
    });

    // Only consulted when the pasted statement carries no period of its own —
    // Fidelity's HSA detail view does not include one. For a quarterly account
    // it's the quarter's last month.
    const defaultMonth = previousMonthKey(todayLocal());
    this.monthHint = this.monthHint || defaultMonth;
    new Setting(contentEl)
      .setName("Statement month")
      .setDesc("Used only if the pasted text has no statement period. For a quarterly statement, the quarter's last month.")
      .addText((t) =>
        bindDateInput(t, this.monthHint, { month: true }).onChange((v) => (this.monthHint = v.trim()))
      );

    const ta = contentEl.createEl("textarea", {
      cls: "budget-portfolio-textarea",
      attr: { placeholder: "Paste statement text here…", rows: "12", spellcheck: "false" }
    });
    ta.value = this.pastedText;
    ta.addEventListener("input", () => (this.pastedText = ta.value));

    this.resultEl = contentEl.createDiv({ cls: "budget-portfolio-result" });

    new Setting(contentEl)
      .addButton((b) => b.setButtonText("Cancel").onClick(() => this.close()))
      .addButton((b) =>
        b
          .setButtonText("Parse Statement")
          .setCta()
          .onClick(() => this.handleParse(ta))
      );
  }

  showResult(kind, title, lines) {
    this.resultEl.empty();
    const box = this.resultEl.createDiv({
      cls: `budget-portfolio-report budget-portfolio-${kind}`
    });
    box.createDiv({ text: title, cls: "budget-portfolio-report-title" });
    (lines || []).forEach((l) => box.createDiv({ text: l, cls: "budget-portfolio-report-line" }));
  }

  async handleParse(ta) {
    const text = ta.value;
    if (!text || !text.trim()) {
      this.showResult("fail", "Nothing pasted", ["Paste the statement text first."]);
      return;
    }

    const accounts = await this.plugin.loadPortfolioAccounts();
    const snapshots = await readJSON(this.app, FILES.portfolioSnapshots, []);
    const parsed = parsePortfolioStatement(text, this.monthHint, { accounts, snapshots });

    if (!parsed.ok) {
      // Textarea intentionally left intact so the user can retry.
      this.showResult("fail", "Import failed — nothing was saved", [
        ...parsed.missing.map((m) => `Could not identify: ${m}`),
        "The pasted text has been kept so you can check and try again."
      ]);
      return;
    }

    if (parsed.autoSave) {
      await this.store(ta, parsed.snapshot, parsed.account, parsed.warnings, "Statement imported");
      return;
    }
    // Only the digits are kept for the review — enough to fill in a new
    // account's last 4 when the statement shows exactly one number.
    const tails = pfAccountTails(pfNormalizeText(text));
    this.showReview(ta, parsed, accounts, tails.length === 1 ? tails[0] : "");
  }

  // Anything short of a sure read: what it found, laid out to check and fix,
  // with the account to file it under. Nothing is saved until Save.
  showReview(ta, parsed, accounts, hint) {
    this.resultEl.empty();
    const box = this.resultEl.createDiv({ cls: "budget-portfolio-report budget-portfolio-review" });
    box.createDiv({ text: "Check this before it's saved", cls: "budget-portfolio-report-title" });
    parsed.review.forEach((l) => box.createDiv({ text: l, cls: "budget-portfolio-report-line" }));
    (parsed.warnings || []).forEach((w) => box.createDiv({ text: `Note: ${w}`, cls: "budget-portfolio-report-line budget-muted" }));

    const read = parsed.snapshot;
    const suggested = Object.assign({}, parsed.suggested, hint ? { account_hint: hint } : {});
    const candidateIds = new Set((parsed.candidates || []).map((a) => a.id));
    const form = {
      account_id: parsed.account ? parsed.account.id : (parsed.candidates || []).length ? "" : "__new",
      statement_start: read.statement_start || "",
      statement_end: read.statement_end || "",
      values: {}
    };

    const fields = box.createDiv({ cls: "budget-pf-review-form" });
    new Setting(fields)
      .setName("Account")
      .setDesc(parsed.account ? "" : `Reads as ${suggested.label || "an investment account"}.`)
      .addDropdown((dd) => {
        dd.addOption("", "Choose…");
        // Accounts it could be come first, then the rest.
        const ordered = [...accounts.filter((a) => candidateIds.has(a.id)), ...accounts.filter((a) => !candidateIds.has(a.id))];
        ordered.forEach((a) => dd.addOption(a.id, a.label));
        dd.addOption("__new", `New account: ${suggested.label || "Investment account"}…`);
        dd.setValue(form.account_id).onChange((v) => (form.account_id = v));
      });
    new Setting(fields)
      .setName("Statement period")
      .addText((t) => bindDateInput(t, form.statement_start).onChange((v) => (form.statement_start = v.trim())))
      .addText((t) => bindDateInput(t, form.statement_end).onChange((v) => (form.statement_end = v.trim())));

    const addField = (host, f) => {
      const found = read[f.key] != null;
      const opts = { allowNegative: !PF_OUTFLOWS.has(f.key), percent: f.kind === "percent" };
      form.values[f.key] = found ? formatMoneyInput(read[f.key], opts) : "";
      const row = new Setting(host).setName(f.label + (f.kind === "percent" ? " (%)" : ""));
      row.setDesc(found ? "Found on the statement" : f.required ? "Not found — type it in" : "Not found");
      row.settingEl.addClass(found ? "budget-pf-found" : "budget-pf-missing");
      row.addText((t) =>
        bindMoneyInput(t, row, opts)
          .setValue(form.values[f.key])
          .onChange((v) => (form.values[f.key] = v))
      );
    };
    const shown = PF_FIELDS.filter((f) => f.required || f.key === "beginning_value" || read[f.key] != null);
    const rest = PF_FIELDS.filter((f) => !shown.includes(f));
    shown.forEach((f) => addField(fields, f));
    if (rest.length) {
      const more = fields.createEl("details", { cls: "budget-pf-more" });
      more.createEl("summary", { text: `Add a figure it didn't find (${rest.length})` });
      rest.forEach((f) => addField(more, f));
    }

    new Setting(box)
      .addButton((b) => b.setButtonText("Start over").onClick(() => this.resultEl.empty()))
      .addButton((b) =>
        b
          .setButtonText("Save snapshot")
          .setCta()
          .onClick(() => this.saveReviewed(ta, parsed, form, accounts, suggested))
      );
  }

  async saveReviewed(ta, parsed, form, accounts, suggested) {
    // One save at a time: a second press while the account form is open
    // would otherwise make the account twice.
    if (this.saving) return;
    const creating = form.account_id === "__new";
    const built = pfSnapshotFromForm(parsed.snapshot, Object.assign({}, form, { account_id: creating ? "__new" : form.account_id }));
    if (built.errors.length) {
      new Notice(built.errors[0]);
      return;
    }
    const warnings = parsed.warnings || [];
    if (!creating) {
      // Read again: the account may have been deleted in Settings while this
      // form was open, and a statement filed under it would belong to nothing.
      const account = (await this.plugin.loadPortfolioAccounts()).find((a) => a.id === form.account_id);
      if (!account) {
        new Notice("That account is gone. Choose another one.");
        return;
      }
      await this.store(ta, built.snapshot, account, warnings, "Statement imported");
      return;
    }
    // The account is only created once the snapshot is known to be saveable,
    // so a form with a mistake in it can't leave a stray empty account behind.
    this.saving = true;
    this.plugin.promptPortfolioAccount(null, async (account) => {
      this.saving = false;
      if (!account) return;
      built.snapshot.account_id = account.id;
      await this.store(ta, built.snapshot, account, warnings, "Account added and statement imported");
    }, suggested, () => (this.saving = false));
  }

  async store(ta, snapshot, account, warnings, title) {
    const snapshots = await readJSON(this.app, FILES.portfolioSnapshots, []);
    const place = pfPlaceSnapshot(snapshots, snapshot);
    if (place.status === "same") {
      this.showResult("ok", "Already imported", [
        `${account.label} — ${snapshot.statement_start} to ${snapshot.statement_end}`,
        "This statement is already stored and identical. Nothing changed."
      ]);
      return;
    }
    if (place.status === "replace") {
      const old = snapshots[place.index];
      new ConfirmModal(this.app, {
        title: `Replace the ${pfPeriodName(portfolioMonthKey(snapshot.statement_end), pfCadence(account))} snapshot?`,
        body: [
          `${account.label} already has a snapshot ending ${snapshot.statement_end}, and this one has different values.`,
          `Stored ending value $${round2(old.ending_value).toFixed(2)} → new $${round2(snapshot.ending_value).toFixed(2)}.`
        ],
        confirmText: "Replace",
        onConfirm: async () => {
          const list = await readJSON(this.app, FILES.portfolioSnapshots, []);
          const again = pfPlaceSnapshot(list, snapshot);
          if (again.index >= 0) list[again.index] = snapshot;
          else list.push(snapshot);
          await writeJSON(this.app, FILES.portfolioSnapshots, list);
          this.finish(ta, account, snapshot, warnings, "Snapshot replaced");
        }
      }).open();
      return;
    }
    snapshots.push(snapshot);
    snapshots.sort((a, b) => (a.statement_end < b.statement_end ? -1 : 1));
    await writeJSON(this.app, FILES.portfolioSnapshots, snapshots);
    this.finish(ta, account, snapshot, warnings, title);
  }

  finish(ta, account, s, warnings, title) {
    const lines = [`${account.label} — ${s.statement_start} to ${s.statement_end}`];
    PF_FIELDS.forEach((f) => {
      if (s[f.key] != null) lines.push(`${f.label} ${pfFormatField(f, s[f.key])}`);
    });
    if (s.allocation)
      lines.push(
        `Allocation ${s.allocation.stocks_pct}% stocks · ${s.allocation.bonds_pct}% bonds · ${s.allocation.short_term_other_pct}% short-term/other`
      );
    if (s.holdings && s.holdings.length) lines.push(`${s.holdings.length} holding(s) captured`);
    (warnings || []).forEach((w) => lines.push(`Note: ${w}`));

    this.showResult("ok", title, lines);
    ta.value = "";
    this.pastedText = "";
    new Notice(`${account.label}: ${s.statement_end} snapshot saved.`, 8000);
    if (this.onImported) this.onImported();
  }

  onClose() {
    this.pastedText = "";
    this.contentEl.empty();
  }
}

class ManageTransfersModal extends Modal {
  constructor(app, categoryNames, categoryMeta, onSubmit) {
    super(app);
    this.categoryNames = categoryNames;
    this.categoryMeta = categoryMeta;
    this.onSubmit = onSubmit;
  }
  onOpen() {
    const { contentEl } = this;
    contentEl.createEl("h2", { text: "Manage Transfer Categories" });
    contentEl.createEl("p", {
      text:
        "Turn on any category that's really money moving between your own accounts \u2014 like paying your " +
        "credit card bill from checking \u2014 rather than actual spending. Transfer categories are excluded " +
        "from the spending pie chart.",
      cls: "budget-muted"
    });
    const state = { ...this.categoryMeta };
    if (this.categoryNames.length === 0) {
      contentEl.createEl("p", { text: "No categories yet \u2014 label some transactions first." });
    }
    this.categoryNames.forEach((name) => {
      new Setting(contentEl).setName(name).addToggle((tg) => tg.setValue(!!state[name]).onChange((v) => (state[name] = v)));
    });
    new Setting(contentEl).addButton((b) =>
      b
        .setButtonText("Save")
        .setCta()
        .onClick(() => {
          this.close();
          this.onSubmit(state);
        })
    );
  }
  onClose() {
    this.contentEl.empty();
  }
}

class ImportResultModal extends Modal {
  constructor(app, summary) {
    super(app);
    this.summary = summary || {};
  }

  onOpen() {
    const { contentEl } = this;
    const s = this.summary;
    const status = s.status || "failed";
    const title = s.title || (
      status === "success"
        ? "Import succeeded"
        : status === "review"
          ? "Import succeeded — review needed"
          : "Import failed");

    contentEl.createEl("h2", { text: title });

    if (s.filePath) {
      contentEl.createEl("p", {
        text: `Source: ${s.filePath}${s.accountId ? ` → ${s.accountId}` : ""}`,
        cls: "budget-muted"
      });
    }

    if (s.counts) {
      const c = s.counts;
      contentEl.createEl("p", {
        text:
          `${c.added || 0} new · ${c.updated || 0} pending→settled · ` +
          `${c.skipped || 0} duplicate${(c.skipped || 0) === 1 ? "" : "s"} skipped` +
          ((c.unresolved || 0) ? ` · ${c.unresolved} unresolved` : ""),
        cls: "budget-amount-hint"
      });
    }

    if (s.message) contentEl.createEl("p", { text: s.message });

    if (s.notes && s.notes.length) {
      contentEl.createEl("h3", { text: "Notes" });
      const list = contentEl.createEl("ul");
      s.notes.forEach((msg) => list.createEl("li", { text: msg }));
    }

    if (s.issues && s.issues.length) {
      contentEl.createEl("h3", { text: "Review these issues" });
      const list = contentEl.createEl("ul");
      s.issues.forEach((msg) => list.createEl("li", { text: msg }));
    }

    const disposition =
      s.sourceRemoved
        ? "The source CSV was removed from Budget/imports after the clean import."
        : s.filePath
          ? "The source CSV was kept in Budget/imports so you can review or retry it."
          : null;
    if (disposition) contentEl.createEl("p", { text: disposition, cls: "budget-muted" });

    new Setting(contentEl).addButton((b) =>
      b
        .setButtonText("Close")
        .setCta()
        .onClick(() => this.close())
    );
  }

  onClose() {
    this.contentEl.empty();
  }
}

class ImportSourceModal extends FuzzySuggestModal {
  constructor(app, files, onChoose) {
    super(app);
    this.files = files;
    this.onChoose = onChoose;
  }
  getItems() {
    return this.files;
  }
  getItemText(item) {
    return item.path;
  }
  onChooseItem(item) {
    this.onChoose(item);
  }
}

class LabelModal extends Modal {
  constructor(app, merchant, amount, existingLabels, onSubmit, existingRule = null, context = {}) {
    super(app);
    this.merchant = merchant;
    this.amount = amount;
    this.existingLabels = existingLabels;
    this.onSubmit = onSubmit;
    this.existingRule = existingRule;
    // For the live match line under the pattern. Without them the field still
    // works; it just can't say what it would catch.
    this.transactions = context.transactions || null;
    this.rules = context.rules || [];
    // Offered when the caller can file a transfer.
    this.onTransfer = context.onTransfer || null;
  }
  // Three things to decide — category, name, and whether it's this charge or
  // every one like it — so that's what's on screen. The pattern that decides
  // "every one like it" is folded into one line that opens to edit it, and the
  // explanations the old version carried are gone: the buttons say it.
  onOpen() {
    const { contentEl } = this;
    contentEl.addClass("budget-label-modal");
    const rule = this.existingRule;
    let pattern = rule ? rule.merchant_pattern : guessMerchantKey(this.merchant);
    let selected = rule ? rule.home_label : "";
    const startName = rule && rule.display_name ? rule.display_name : "";
    let nickname = startName;
    let typed = "";
    let creating = false;

    const head = contentEl.createDiv({ cls: "budget-label-head" });
    head.createEl("h2", { text: startName || guessMerchantKey(this.merchant) || "Transaction", cls: "budget-label-name" });
    const isIncome = this.amount > 0;
    head.createSpan({
      text: `${isIncome ? "+" : "-"}$${Math.abs(this.amount).toFixed(2)}`,
      cls: `budget-label-amount ${isIncome ? "budget-positive" : "budget-negative"}`
    });
    contentEl.createDiv({ text: this.merchant, cls: "budget-muted budget-label-raw" });

    // Category: the list, with a new one as its last choice.
    const dropdownLabels = sortCategoriesByUse(this.existingLabels.concat(selected ? [selected] : []));
    let newSetting = null;
    if (dropdownLabels.length > 0) {
      new Setting(contentEl).setName("Category").addDropdown((d) => {
        d.addOption("", "— choose —");
        dropdownLabels.forEach((l) => d.addOption(l, l));
        d.addOption("__new", "New category…");
        d.setValue(selected);
        d.onChange((v) => {
          creating = v === "__new";
          selected = creating ? "" : v;
          if (newSetting) newSetting.settingEl.toggleClass("budget-hidden", !creating);
        });
      });
    } else {
      creating = true;
    }
    newSetting = new Setting(contentEl)
      .setName(dropdownLabels.length ? "New category" : "Category")
      .addText((t) => t.setPlaceholder("e.g. Eating Out").onChange((v) => (typed = v)));
    newSetting.settingEl.toggleClass("budget-hidden", !creating);

    new Setting(contentEl)
      .setName("Name")
      .addText((t) => t.setPlaceholder(guessMerchantKey(this.merchant)).setValue(nickname).onChange((v) => (nickname = v)));

    // What "Apply to all" means, in one line; opened, the pattern and what it
    // would catch.
    const scope = contentEl.createEl("details", { cls: "budget-label-scope" });
    const summary = scope.createEl("summary");
    const setSummary = () => summary.setText(`Applies to: “${pattern.trim() || "—"}”`);
    setSummary();
    const patternSetting = new Setting(scope)
      .setName("Pattern to match")
      .setDesc("Charges containing this text. Shorten it to catch every version of this merchant.");
    const refreshReach = this.transactions
      ? bindPatternReach(patternSetting, {
          transactions: this.transactions,
          rules: this.rules,
          selfIndex: ruleIndexOf(this.rules, rule),
          sample: this.merchant
        })
      : () => {};
    patternSetting.addText((t) =>
      t.setValue(pattern).onChange((v) => {
        pattern = v;
        setSummary();
        refreshReach(pattern);
      })
    );
    refreshReach(pattern);

    const resolveLabel = () => (creating ? (typed || "").trim() : selected);
    const btnRow = contentEl.createDiv({ cls: "budget-modal-btn-row budget-label-btns" });
    if (this.onTransfer) {
      const tb = btnRow.createEl("button", { text: "It's a transfer", cls: "budget-label-transfer" });
      tb.setAttr("title", "Money moved between your own accounts: not spending or income, and off the transaction list");
      tb.onclick = () => {
        this.close();
        this.onTransfer();
      };
    }
    // The two answers stay together, whatever the width.
    const answers = btnRow.createDiv({ cls: "budget-label-answers" });
    const overrideBtn = answers.createEl("button", { text: "Just this one" });
    overrideBtn.setAttr("title", "Change only this transaction; its usual rule stays as it is");
    overrideBtn.onclick = () => {
      const label = resolveLabel();
      if (!label) {
        new Notice("Pick a category first.");
        return;
      }
      this.close();
      // A name belongs to the merchant, so it's only saved with Apply to all.
      if (nickname.trim() !== startName) new Notice("Category changed for this one. A new name only saves with Apply to all.");
      this.onSubmit({ mode: "override", pattern: null, label, nickname: null });
    };
    const ruleBtn = answers.createEl("button", { text: "Apply to all", cls: "mod-cta" });
    ruleBtn.setAttr("title", "Every transaction matching the pattern, now and in future imports");
    ruleBtn.onclick = () => {
      const label = resolveLabel();
      if (!label) {
        new Notice("Pick a category first.");
        return;
      }
      if (!pattern.trim()) {
        scope.open = true;
        new Notice("Apply to all needs a pattern to match.");
        return;
      }
      this.close();
      this.onSubmit({ mode: "rule", pattern: pattern.trim(), label, nickname: nickname.trim() });
    };
  }
  onClose() {
    this.contentEl.empty();
  }
}

class EditRuleModal extends Modal {
  constructor(app, rule, onSubmit, context = {}) {
    super(app);
    this.rule = rule;
    this.onSubmit = onSubmit;
    this.transactions = context.transactions || null;
    this.rules = context.rules || [];
    this.index = context.index != null ? context.index : null;
  }
  onOpen() {
    const { contentEl } = this;
    contentEl.createEl("h2", { text: "Edit rule" });
    let pattern = this.rule.merchant_pattern;
    let label = this.rule.home_label;
    let nickname = this.rule.display_name || "";

    const patternSetting = new Setting(contentEl)
      .setName("Pattern to match")
      .setDesc("Shorten this to just the merchant name if it's currently a whole raw transaction line — that's usually why it stops matching future transactions.");
    const refreshReach = this.transactions
      ? bindPatternReach(patternSetting, {
          transactions: this.transactions,
          rules: this.rules,
          selfIndex: this.index
        })
      : () => {};
    patternSetting.addText((t) =>
      t.setValue(pattern).onChange((v) => {
        pattern = v;
        refreshReach(pattern);
      })
    );
    refreshReach(pattern);

    new Setting(contentEl)
      .setName("Home label")
      .setDesc("Renaming this retroactively relabels every transaction using this rule, except ones you've individually overridden.")
      .addText((t) => t.setValue(label).onChange((v) => (label = v)));

    new Setting(contentEl)
      .setName("Display nickname (optional)")
      .setDesc("Shown instead of the raw bank description wherever this rule matches.")
      .addText((t) => t.setValue(nickname).onChange((v) => (nickname = v)));

    new Setting(contentEl).addButton((b) =>
      b
        .setButtonText("Save")
        .setCta()
        .onClick(() => {
          this.close();
          this.onSubmit({ pattern: pattern.trim(), label: label.trim(), nickname: nickname.trim() });
        })
    );
  }
  onClose() {
    this.contentEl.empty();
  }
}

// ---------- Dashboard view ----------

class BudgetDashboardView extends ItemView {
  constructor(leaf, plugin) {
    super(leaf);
    this.plugin = plugin;
    this.lastResult = null;
    this.pieRange = null; // null = auto (period if available, else 30d)
    this.expandedSpendCategory = null;
    this.expandedIncomeCategory = null;
    this.activePieTab = "spending"; // which half of the cash-flow card is showing
    this.activeTab = "overview";
    this.insightsMonth = null;
    this.trendMonth = null; // month expanded in the trend chart
    this.sectionOpen = {};   // collapsible open/closed, survives re-render
    this.scrollMemory = {};  // per-tab scroll offset
  }
  getViewType() {
    return VIEW_TYPE;
  }
  getDisplayText() {
    return "Budget Tracker";
  }
  getIcon() {
    return "wallet";
  }
  async onOpen() {
    // If the plugin restored a saved pay period but nothing has been rendered
    // yet this session, recompute it so the dashboard comes up populated.
    if (!this.lastResult && this.plugin.lastPaycheckInputs) {
      const result = await this.plugin.recalculate();
      if (result) return; // recalculate() -> setResult() -> render()
    }
    await this.render();
  }
  setResult(result) {
    this.lastResult = result;
    this.render();
  }

  // Single path for everything LabelModal can return, so the uncategorized list
  // and the recent-transactions feed behave identically.
  async handleLabelSubmit(tx, { mode, pattern, label, nickname }, existingRule) {
    if (!label) return;
    const all = await readJSON(this.app, FILES.transactions, []);
    const rules = await readJSON(this.app, FILES.rules, []);

    if (mode === "override") {
      const idx = findTxIndex(all, tx);
      if (idx < 0) return;
      all[idx].override_label = label;
      applyCategorization(all, rules);
      await writeJSON(this.app, FILES.transactions, all);
      new Notice(`This transaction only \u2192 ${label}`);
      this.render();
      return;
    }

    if (!pattern) return;

    let msg;
    const existingIdx = existingRule
      ? rules.findIndex(
          (r) => r.merchant_pattern === existingRule.merchant_pattern && r.home_label === existingRule.home_label
        )
      : -1;

    const nick = (nickname || "").trim();
    if (existingIdx >= 0) {
      rules[existingIdx].merchant_pattern = pattern;
      rules[existingIdx].home_label = label;
      if (nick) rules[existingIdx].display_name = nick;
      else delete rules[existingIdx].display_name;
      msg = `Rule updated: "${pattern}" \u2192 ${label}`;
    } else {
      const newRule = { merchant_pattern: pattern, home_label: label };
      if (nick) newRule.display_name = nick;
      rules.push(newRule);
      msg = `Rule saved: "${pattern}" \u2192 ${label}`;
    }
    if (nick) msg += ` (shown as "${nick}")`;
    await writeJSON(this.app, FILES.rules, rules);

    // A lingering one-off override would keep beating the rule that was just
    // asked for, making it look like nothing happened. Clear it on this row.
    const txIdx = findTxIndex(all, tx);
    if (txIdx >= 0 && all[txIdx].override_label) {
      all[txIdx].override_label = null;
      msg += " (cleared this row's one-off override)";
    }

    applyCategorization(all, rules);
    await writeJSON(this.app, FILES.transactions, all);
    new Notice(msg);
    this.render();
  }
  // Serialized for the same reason the settings render is: renderView() empties
  // the container and then awaits, so two calls that overlap across any of those
  // awaits both paint into the same container and the tab comes out with two of
  // everything. Twenty-five call sites fire this, several of them from handlers
  // that also trigger a recalculation, so overlapping is routine rather than
  // exotic.
  //
  // A request arriving mid-render is collapsed into exactly one follow-up no
  // matter how many arrive, so a burst of updates costs one extra render rather
  // than one per update.
  render() {
    if (this._rendering) {
      this._renderQueued = true;
      return this._renderPromise || Promise.resolve();
    }
    this._rendering = true;
    this._renderQueued = false;
    this._renderPromise = this.renderView()
      .catch((e) => {
        console.error("Budget Tracker: dashboard render failed", e);
      })
      .finally(() => {
        this._rendering = false;
        if (this._renderQueued) this.render();
      });
    return this._renderPromise;
  }

  async renderView() {
    const container = this.contentEl || this.containerEl.children[1];
    // Capture BEFORE empty() wipes the DOM, otherwise scrollTop reads 0.
    const prevScroll = this.scrollMemory[this.activeTab] != null && container.scrollTop === 0
      ? this.scrollMemory[this.activeTab]
      : container.scrollTop;
    this.scrollMemory[this.activeTab] = prevScroll;
    container.empty();
    container.addClass("budget-dashboard");
    if (isMobileApp()) container.addClass("budget-mobile");

    container.createEl("h2", { text: "Budget Tracker", cls: "budget-title" });

    // ---- Action bar: everything reachable without the command palette ----
    const actions = container.createDiv({ cls: "budget-action-bar" });
    const addAction = (label, handler, opts = {}) => {
      const btn = actions.createEl("button", {
        text: label,
        cls: `budget-action-btn${opts.primary ? " mod-cta" : ""}`
      });
      if (opts.tooltip) btn.setAttr("title", opts.tooltip);
      btn.onclick = () => handler();
      return btn;
    };

    addAction("Enter Paycheck", () => this.plugin.promptEnterPaycheck(), {
      primary: true,
      tooltip: "Start a new pay period and recalculate your budget"
    });
    addAction("Import CSV", () => this.plugin.promptImportCSV(), {
      tooltip: `Import a bank export from ${IMPORT_DIR}`
    });
    const shortLabels = isMobileApp();
    this.renderSyncButton(addAction, shortLabels);
    addAction(shortLabels ? "Mark Paid" : "Mark Bill Paid", () => this.plugin.promptMarkFixedPaid(), {
      tooltip: "Record a recurring bill as paid and link the transaction that paid it"
    });
    addAction("Export", () => this.plugin.promptExport(), {
      tooltip: `A snapshot, everything, or one kind of data, saved to ${EXPORT_DIR}`
    });
    // The bar is for what you do DURING a pay period. Adding accounts, plans,
    // card terms and bills is setup, and setup now lives in one place instead of
    // being split between here and Settings.
    addAction(shortLabels ? "Settings" : "Settings & Setup", () => this.plugin.openSettings(), {
      tooltip: "Accounts, bills, debts, goals, categories, merchant rules and the buffer"
    });

    // Right-aligned in the action bar, which had a screen's width of nothing to
    // the right of the last button. Living here rather than in the Overview body
    // also means it is reachable from every tab and before the first paycheck is
    // entered — it is a global mode, like the tabs themselves, not a property of
    // one view.
    this.renderStrategySwitch(actions);


    // ---- View tabs ----
    this.renderTabs(container);

    const ctx = await this.loadRenderContext();
    const body = container.createDiv({ cls: "budget-tab-body" });

    if (this.activeTab === "debts") await this.renderDebts(body, ctx);
    else if (this.activeTab === "transactions") await this.renderTransactions(body, ctx);
    else if (this.activeTab === "subscriptions") await this.renderSubscriptions(body, ctx);
    else if (this.activeTab === "insights") await this.renderInsights(body, ctx);
    else if (this.activeTab === "portfolio") await this.renderPortfolio(body, ctx);
    else await this.renderOverview(body, ctx);

    // Restore the scroll offset captured before empty() so clicking a row
    // button doesn't throw the view back to the top.
    requestAnimationFrame(() => {
      container.scrollTop = prevScroll;
    });
  }

  renderTabs(container) {
    const mobile = isMobileApp();
    const tabs = [
      { id: "overview", label: mobile ? "Home" : "Overview" },
      { id: "debts", label: "Debts" },
      { id: "transactions", label: mobile ? "Txns" : "Transactions" },
      { id: "subscriptions", label: mobile ? "Subs" : "Subscriptions" },
      { id: "insights", label: mobile ? "Trends" : "Insights" },
      { id: "portfolio", label: mobile ? "Invest" : "Portfolio" }
    ];
    const bar = container.createDiv({ cls: "budget-tabs" });
    tabs.forEach((t) => {
      const btn = bar.createEl("button", {
        text: t.label,
        cls: `budget-tab${this.activeTab === t.id ? " budget-tab-active" : ""}`
      });
      btn.onclick = () => {
        if (this.activeTab === t.id) return;
        this.activeTab = t.id;
        this.scrollMemory[t.id] = 0;
        this.render();
      };
    });
  }

  // Bank sync. Always in the bar so it can be found; without a connection it's
  // dimmed and takes you to where the token goes, rather than doing nothing.
  // While a sync runs it reads "Syncing…" and won't take another click — the
  // guard is on the plugin, so a re-render mid-sync can't hand back a live
  // button, and every request counts against SimpleFIN's daily allowance.
  renderSyncButton(addAction, shortLabels = false) {
    const connected = this.plugin.hasSimpleFINConnection();
    const idle = shortLabels ? "Sync" : "Sync Transactions";
    const busyText = "Syncing…";
    const busy = !!this.plugin.syncing;
    let label = null;
    const btn = addAction("", async () => {
      if (!this.plugin.hasSimpleFINConnection()) {
        this.plugin.openSettings({ focus: "simplefin" });
        return;
      }
      if (this.plugin.syncing) return;
      label.setText(busyText);
      btn.disabled = true;
      btn.addClass("budget-sync-busy");
      try {
        await this.plugin.syncSimpleFIN();
      } finally {
        // The sync re-renders the bar; this only matters if it stopped early.
        label.setText(idle);
        btn.disabled = false;
        btn.toggleClass("budget-sync-busy", false);
      }
    }, {
      tooltip: connected
        ? "Pull new transactions and balances from your bank through SimpleFIN"
        : "Set up bank sync with SimpleFIN — opens Settings"
    });
    btn.addClass("budget-sync-btn");
    label = btn.createSpan({ cls: "budget-sync-label", text: busy ? busyText : idle });
    // Both labels, invisible, in the same spot: the button keeps the width of
    // the longer one, so the rest of the bar doesn't shift as a sync starts and
    // finishes.
    [idle, busyText].forEach((t) => btn.createSpan({ cls: "budget-sync-sizer", text: t, attr: { "aria-hidden": "true" } }));
    btn.addClass(connected ? "budget-sync-on" : "budget-sync-off");
    if (!connected) btn.setAttr("aria-description", "Not set up yet. Opens Settings to connect SimpleFIN.");
    if (busy) {
      btn.disabled = true;
      btn.addClass("budget-sync-busy");
    }
    return btn;
  }

  async loadRenderContext() {
    const allTx = await readJSON(this.app, FILES.transactions, []);
    const rules = await readJSON(this.app, FILES.rules, []);
    const revolvingDebts = await readJSON(this.app, FILES.revolvingDebts, []);
    const installmentDebts = await readJSON(this.app, FILES.installmentDebts, []);
    const categoryMetaList = await readJSON(this.app, FILES.categories, []);
    const savingsGoals = await readJSON(this.app, FILES.savingsGoals, []);
    const fixedExpenses = await readJSON(this.app, FILES.fixedExpenses, []);
    const subscriptionReviews = await readJSON(this.app, FILES.subscriptionReviews, []);
    const subscriptionKeys = buildSubscriptionAudit(allTx, subscriptionReviews, rules)
      .filter((s) => s.status === "keep")
      .map((s) => s.key);

    return {
      allTx,
      rules,
      // Rules' categories, plus any category that exists without a rule yet
      // (a new vault's starter set), so the label picker offers them too.
      existingLabels: [...new Set(rules.map((r) => r.home_label).concat(categoryMetaList.map((c) => c && c.name)))]
        .filter((n) => n && n !== "Uncategorized")
        .sort(),
      revolvingDebts,
      installmentDebts,
      allDebts: revolvingDebts.concat(installmentDebts),
      categoryMetaList,
      accounts: await readJSON(this.app, FILES.accounts, []),
      savingsGoals,
      fixedExpenses,
      subscriptionKeys,
      // One index for the whole render. Every tab that asks "what owns this
      // transaction?" gets the same answer, instead of each call site building
      // its own from whatever it happened to have loaded.
      ownership: completeOwnership({
        fixedExpenses,
        installmentDebts,
        revolvingDebts,
        goals: savingsGoals,
        categoryMeta: categoryMetaList,
        subscriptionKeys,
        rules
      })
    };
  }

  // Collapsible wrapper. Open/closed state lives on the view, so it survives
  // re-renders, and toggling only flips the <details> element — no re-render.
  collapsible(container, id, title, subtitle, defaultOpen = true) {
    if (!(id in this.sectionOpen)) this.sectionOpen[id] = defaultOpen;
    const det = container.createEl("details", { cls: "budget-collapsible" });
    det.open = this.sectionOpen[id];
    const sum = det.createEl("summary", { cls: "budget-collapsible-summary" });
    sum.createSpan({ text: title, cls: "budget-collapsible-title" });
    if (subtitle) sum.createSpan({ text: subtitle, cls: "budget-collapsible-sub" });
    det.addEventListener("toggle", () => {
      this.sectionOpen[id] = det.open;
    });
    return det.createDiv({ cls: "budget-collapsible-body" });
  }

  async renderOverview(container, ctx) {
    const { allTx, rules, existingLabels, categoryMetaList } = ctx;
    // Dragging a capped fund marks this element, which is what reveals the
    // places it can be dropped.
    this.overviewEl = container;
    this.fundDrag = null;

    const sav = savingsStatus(this.plugin.settings);
    if (sav) {
      // The banner only earns its space when it carries something the strategy
      // switch below it doesn't: a deadline countdown, or a malformed date to
      // fix. Open-ended, it just repeated "Savings Focus is on" directly above
      // a control that says so and can change it.
      if (!sav.openEnded) this.renderSavingsBanner(container, sav, ctx);
      await this.renderPinnedGoal(container, ctx, sav);
    }

    if (!this.lastResult) {
      const empty = container.createDiv({ cls: "budget-card budget-empty" });
      const expired = this.plugin.expiredPeriod;
      if (expired && expired.nextPaydayStr) {
        empty.createEl("p", {
          text: `Your last pay period ended ${expired.nextPaydayStr}. Set a pay schedule in Settings and periods will roll over on their own.`
        });
      } else {
        empty.createEl("p", { text: "Run \u2018Enter Paycheck\u2019 to generate a budget for this pay period." });
      }
      return;
    }

    const r = this.lastResult;
    this.renderPeriodHero(container, r, ctx);
    this.renderAlerts(container, r, ctx);

    const grid = container.createDiv({ cls: "budget-grid" });
    this.renderObligationsCard(grid, r, ctx);
    this.renderSubsCard(grid, r);
    this.renderFundCards(grid, r, ctx);
    this.renderRecommendationsCard(grid, r);

    this.renderGoalsCard(container, ctx);

    // Both charts read the same window, so it is resolved once here rather than
    // each chart deriving it and risking them disagreeing.
    const periodBounds = this.lastResult
      ? { todayStr: this.lastResult.todayStr, nextPaydayStr: this.lastResult.nextPaydayStr }
      : null;
    const effectiveRange = this.pieRange || (periodBounds ? "period" : "30d");
    const scope = {
      periodBounds,
      effectiveRange,
      scopedTx: filterTransactionsByRange(ctx.allTx, effectiveRange, periodBounds)
    };
    this.renderCashFlowChart(container, ctx, scope);
  }

  // The period bar and the three headline figures. Everything here reads from
  // the allocation result; nothing is computed.
  renderPeriodHero(container, r, ctx) {

    const todayStr = todayLocal();
    const daysLeft = daysBetween(todayStr, r.nextPaydayStr);
    if (r.autoRolled) {
      const banner = container.createDiv({ cls: "budget-warning-soft" });
      banner.createSpan({
        text: "New pay period started automatically from your schedule. Numbers use your last known checking balance \u2014 confirm it to be accurate. "
      });
      const confirmBtn = banner.createEl("button", { text: "Enter this paycheck", cls: "budget-btn mod-cta" });
      confirmBtn.onclick = () => this.plugin.promptEnterPaycheck();
    }

    const periodBar = container.createDiv({ cls: "budget-period-bar" });
    periodBar.createSpan({ text: `Pay period ${r.todayStr} \u2192 ${r.nextPaydayStr}` });
    periodBar.createSpan({
      text: daysLeft <= 0 ? "next payday is today" : `${daysLeft} day${daysLeft === 1 ? "" : "s"} to next payday`,
      cls: "budget-period-days"
    });

    const hero = container.createDiv({ cls: "budget-hero" });

    // The free-cash block used to lead here, and it showed the same figure as
    // "Recommended savings" further down whenever Savings Mode was on — the
    // allocator sweeps everything available into goals, so "to stash" and the
    // savings recommendation are the same dollars counted twice. What is left is
    // the pair of numbers you actually check before spending: what's still
    // spendable, and what's reachable including credit.
    //
    // Spendable is a live figure: the allowance minus what has already gone out
    // of it this period, not the untouched original.
    // The figures share a row of their own, so the hero can stack: numbers,
    // then what they were derived from, then the ways to check them.
    // A fund dragged into the hero is a taller tile than the figures beside it
    // (a bar, its status and two buttons under the number). The figures grow to
    // match, rather than leaving a gap under them.
    const funds = cappedFunds(ctx && ctx.savingsGoals);
    const heroFunds = funds.filter((f) => fundPlacement(f) === "hero");
    const figures = hero.createDiv({ cls: "budget-hero-figures" + (heroFunds.length ? " budget-hero-figures-tall" : "") });
    const spendBlock = figures.createDiv({ cls: "budget-hero-block" });
    spendBlock.createEl("div", { text: "Spendable till payday", cls: "budget-hero-label" });
    const remainingBuffer = r.bufferRemaining != null ? r.bufferRemaining : r.effectiveBuffer || 0;
    // Safe to be unconditionally positive: bufferRemaining is clamped at zero
    // upstream (`Math.max(0, allocated - spent)`), and an overrun is reported by
    // the subtitle below rather than by this figure going negative.
    spendBlock.createEl("div", {
      text: `$${remainingBuffer.toFixed(2)}`,
      cls: "budget-hero-number budget-positive"
    });
    if ((r.bufferOverrun || 0) > 0.005) {
      spendBlock.createEl("div", {
        text: `$${r.bufferOverrun.toFixed(2)} over your $${(r.allocatedBuffer || 0).toFixed(2)} allowance`,
        cls: "budget-hero-sub budget-negative"
      });
    } else if ((r.bufferSpent || 0) > 0.005) {
      spendBlock.createEl("div", {
        text: `of $${(r.allocatedBuffer || 0).toFixed(2)} allowance`,
        cls: "budget-hero-sub"
      });
    }

    // Only worth a slot once it's actually non-zero — i.e. every goal funded.
    if (r.freeCash > 0.005) {
      const leftBlock = figures.createDiv({ cls: "budget-hero-block budget-hero-secondary" });
      leftBlock.createEl("div", {
        text: r.savingsMode ? "Surplus beyond goals" : "Surplus",
        cls: "budget-hero-label"
      });
      leftBlock.createEl("div", { text: `$${r.freeCash.toFixed(2)}`, cls: "budget-hero-number-sm" });
    }

    const flexBlock = figures.createDiv({ cls: "budget-hero-block budget-hero-secondary" });
    flexBlock.createEl("div", { text: "Total flexibility (incl. credit)", cls: "budget-hero-label" });
    flexBlock.createEl("div", { text: `$${r.totalFlexibility.toFixed(2)}`, cls: "budget-hero-number" });

    heroFunds.forEach((f) => this.renderFundHero(figures, f, ctx, r));
    if (funds.length) this.fundDropSlot(figures, "hero", "Drop here to show it in the hero");

    // Where the headline number came from. It sat inside the free-cash block
    // and went with it, but it explains the whole hero rather than one figure,
    // so it belongs under all of them.
    const basis = hero.createDiv({ cls: "budget-hero-basis" });
    // Must invert every term freeCash subtracts, or the reconstructed
    // cash-on-hand understates what's actually in the account.
    const cashOnHand = round2(
      r.freeCash +
        (r.committed || 0) +
        (r.recommendedExtraPayoff || 0) +
        (r.recommendedSavings || 0) +
        (r.effectiveBuffer || 0)
    );
    const deductions = [];
    if (r.committed) deductions.push(`$${r.committed.toFixed(2)} committed`);
    if (r.effectiveBuffer) deductions.push(`$${r.effectiveBuffer.toFixed(2)} held for daily spend`);
    // Capped funds are part of recommendedSavings, but "to goals" would
    // misdescribe them, so they're named apart.
    const fundAsks = (r.savingsBreakdown || []).filter((b) => b && b.fund);
    const toFunds = round2(fundAsks.reduce((s, b) => s + b.amount, 0));
    const toGoals = round2((r.recommendedSavings || 0) - toFunds);
    if (toGoals > 0.005) deductions.push(`$${toGoals.toFixed(2)} to goals`);
    if (toFunds > 0.005) {
      deductions.push(`$${toFunds.toFixed(2)} to ${fundAsks.length === 1 ? fundAsks[0].target : "capped funds"}`);
    }
    if (r.recommendedExtraPayoff) deductions.push(`$${r.recommendedExtraPayoff.toFixed(2)} to debt`);
    basis.createSpan({
      text: `from $${cashOnHand.toFixed(2)} on hand` + (deductions.length ? ` − ${deductions.join(" − ")}` : "")
    });
    // Which balance "on hand" is, and where it came from, so a figure that
    // hasn't moved can be told apart from one that was never updated.
    const cs = r.cashSource;
    if (cs && (cs.account || cs.source || cs.at)) {
      const from = balanceSourceText(cs.source, cs.at);
      basis.createSpan({
        text:
          `${cs.account || "Checking"} $${(cs.balance || 0).toFixed(2)}` +
          (from ? ` ${from}` : " (not updated since this period began)") +
          (cs.paycheckPending ? ` + $${cs.paycheckPending.toFixed(2)} paycheck not in yet` : ""),
        cls: "budget-hero-source"
      });
    }
    const fixBtn = basis.createEl("button", { text: "Update balance", cls: "budget-basis-btn" });
    fixBtn.onclick = () => this.plugin.promptQuickBalance();

    // The three ways to check the spending allowance, moved here from the
    // obligations card. They explain the Spendable number above them, so they
    // sit with it rather than under a list of bills.
    this.renderBufferDetail(hero, r);

    if (r.deficit) {
      // Must match result.deficit's definition: obligations vs cash on hand.
      // freeCash also nets off the discretionary buffer, recommended payoff
      // and recommended savings, which overstated the shortfall.
      const gap =
        r.obligationShortfall != null
          ? r.obligationShortfall
          : Math.max(0, round2((r.committed || 0) - (r.cashOnHand || 0)));
      // Names all five things `committed` adds up, not the three it used to.
      // Earmarked savings and projected necessities are often the larger half,
      // so a user comparing the figure against their bills couldn't make it
      // reconcile and had no way to tell which part was missing.
      container.createDiv({ cls: "budget-warning" }).setText(
        `Short by about $${gap.toFixed(2)}: fixed costs, minimum payments, subscriptions, earmarked savings ` +
          "and projected necessities exceed your cash on hand."
      );
    }

    // A sweep offered at a period boundary and left undecided lives on here,
  }

  // Which of the two things a surplus can do. This was a toggle buried in
  // settings called "Savings Mode", which made it read as an option on the
  // budget rather than the choice the whole allocation turns on — the payoff
  // ladder, the savings pacing and half the copy on this page all change with
  // it. A switch above the numbers says that plainly, and shows which one is
  // running without anyone having to go looking for it.
  renderStrategySwitch(container) {
    const stratWrap = container.createDiv({ cls: "budget-strategy-wrap" });
    const group = stratWrap.createDiv({ cls: "budget-segmented budget-segmented-lg" });

    const choose = (label, wantSavings) => {
      const on = !!this.plugin.settings.savingsMode === wantSavings;
      const b = group.createEl("button", {
        text: label,
        cls: `budget-segment${on ? " budget-segment-on" : ""}`
      });
      b.setAttr(
        "title",
        wantSavings
          ? "Pause extra debt payoff and route the surplus into savings goals"
          : "Send the surplus to debt principal beyond the minimums"
      );
      b.onclick = async () => {
        if (on) return;
        this.plugin.settings.savingsMode = wantSavings;
        await writeJSON(this.app, FILES.settings, this.plugin.settings);
        new Notice(
          wantSavings
            ? "Savings Focus \u2014 extra payoff paused, surplus routed to your goals."
            : "Debt Reduction \u2014 surplus goes to principal beyond the minimums."
        );
        // Recalculates rather than just repainting: the strategy changes what
        // the allocator does, so every number on this page has to move with it.
        await this.plugin.refreshAfterDataChange();
      };
      return b;
    };
    choose("Debt Reduction", false);
    choose("Savings Focus", true);
  }

  // The three ways to check the Spendable figure: where every dollar this
  // period went, what has drawn the allowance down, and how the allowance was
  // arrived at. All three used to hang off the obligations card, which put an
  // explanation of the spending allowance under a list of bills. They explain
  // the hero number, so they live with it.
  renderBufferDetail(hero, r) {
    const box = hero.createDiv({ cls: "budget-hero-detail" });

    const spentSoFar = r.bufferSpent || 0;
    const alloc = r.bufferAllocation || null;
    const bc = (alloc && alloc.mode === "auto" && alloc.detail && alloc.detail.length ? alloc : r.bufferCalc) || {
      daysLeft: 0,
      detail: []
    };

    // Every outgoing dollar this period, and the one bucket that absorbed it.
    // The reconciliation answer in full: if a transaction isn't here, no bucket
    // claimed it; if it's here twice, something is wrong.
    const own = r.ownershipSummary;
    if (own && own.count) {
      const OWNER_LABELS = {
        debt: "Debt payments",
        fixed_expense: "Fixed bills",
        subscription: "Subscriptions",
        card_payment: "Card payments",
        variable_necessity: "Variable necessities",
        necessary_expense: "Necessary expenses",
        discretionary: "Spending allowance",
        income: "Money in"
      };
      const ownBox = this.collapsible(
        box,
        "ownership-breakdown",
        "Where this period's money went",
        `$${own.total.toFixed(2)} across ${own.count} transaction${own.count === 1 ? "" : "s"}`,
        false
      );
      own.byType.forEach((b) => {
        const isCard = b.type === "card_payment";
        const row = ownBox.createDiv({ cls: "budget-fixed-row" + (isCard ? " budget-owner-card" : "") });
        const col = row.createDiv({ cls: "budget-fixed-name budget-buffer-text" });
        col.createDiv({ text: OWNER_LABELS[b.type] || b.type });
        col.createDiv({
          text:
            `${b.count} transaction${b.count === 1 ? "" : "s"}` +
            (b.explicit ? ` · ${b.explicit} linked` : b.type === "discretionary" ? "" : " · matched by category"),
          cls: "budget-buffer-sub"
        });
        if (isCard) col.createDiv({ text: "Pays off spending already counted on the card", cls: "budget-buffer-sub budget-owner-card-note" });
        row.createSpan({ text: `$${b.amount.toFixed(2)}`, cls: "budget-amount" });
      });
    }

    // Where the spending actually went, so the number is checkable rather than
    // something the user has to take on faith.
    const spendDetail = (r.bufferSpending && r.bufferSpending.byCategory) || [];
    if (spendDetail.length) {
      const spentBox = this.collapsible(
        box,
        "buffer-spent",
        "What's used it",
        `$${spentSoFar.toFixed(2)} across ${spendDetail.length} categor${spendDetail.length === 1 ? "y" : "ies"}`,
        false
      );
      spentBox.createEl("p", {
        text: "Known bills and debt payments are accounted for separately — this is just your own spending.",
        cls: "budget-muted budget-apply-scope"
      });

      spendDetail.forEach((d) => {
        const row = spentBox.createDiv({ cls: "budget-fixed-row" });
        const col = row.createDiv({ cls: "budget-fixed-name budget-buffer-text" });
        col.createDiv({ text: d.category });
        if (d.refunded > 0.005) {
          col.createDiv({
            text: `$${d.gross.toFixed(2)} spent less $${d.refunded.toFixed(2)} refunded`,
            cls: "budget-buffer-sub"
          });
        }
        row.createSpan({ text: `$${d.net.toFixed(2)}`, cls: "budget-amount" });
      });
    }

    if (r.bufferMode === "auto" && bc.detail && bc.detail.length) {
      const breakdown = this.collapsible(
        box,
        "buffer-detail",
        "What that's made of",
        `${bc.detail.length} categor${bc.detail.length === 1 ? "y" : "ies"}`,
        false
      );
      bc.detail.forEach((d) => {
        const row = breakdown.createDiv({ cls: "budget-fixed-row" });
        const col = row.createDiv({ cls: "budget-fixed-name budget-buffer-text" });
        col.createDiv({ text: d.name });
        col.createDiv({
          text:
            d.basis === "over target"
              ? `over its $${d.target.toFixed(2)} target — assuming $${d.daily.toFixed(2)}/day continues`
              : d.basis === "on target"
                ? `on target — $${d.daily.toFixed(2)}/day`
                : `no target — last month's pace, $${d.daily.toFixed(2)}/day`,
          cls: "budget-buffer-sub"
        });
        row.createSpan({ text: `$${d.hold.toFixed(2)}`, cls: "budget-amount" });
      });
      breakdown.createEl("p", {
        text: "Plus 15% for the unforeseen. Only discretionary categories count — rent, insurance and transfers are already obligations.",
        cls: "budget-muted"
      });
    }
  }

  // Anything that needs saying before the numbers: an auto-rolled period, an
  // undecided sweep, a real deficit, an unreconciled obligation, an overrun.
  renderAlerts(container, r, ctx) {
    const { rules } = ctx;
    // so closing the modal doesn't strand the money until the next payday.
    const sweepSlot = container.createDiv();
    this.plugin.pendingSweep().then((rec) => {
      if (!rec || !sweepSlot.isConnected) return;
      const row = sweepSlot.createDiv({ cls: "budget-warning-soft budget-sweep-pending" });
      row.createSpan({
        text:
          `You finished ${rec.period_start} → ${rec.period_end} with $${rec.remaining.toFixed(2)} of your ` +
          `spending allowance unused.`
      });
      const reviewBtn = row.createEl("button", { text: "Move it to savings", cls: "budget-btn" });
      reviewBtn.onclick = () => this.plugin.openSweepModal(rec);
    });

    // Payments the budget already knows are bills or debt — it just doesn't know
    // WHICH one yet. This is ordinary bookkeeping, not a financial problem: the
    // spendable number is already correct, because these were never counted as
    // spending. Matching them only releases the reserve still held for the
    // obligation they paid. So it gets one quiet line, not a card.
    // Gated on there still being an open obligation of that kind: if nothing is
    // being held back, matching releases nothing and the line shouldn't appear.
    const needsMatching = (r.unreconciled && r.unreconciled.needsMatching) || [];
    if (needsMatching.length) {
      const row = container.createDiv({ cls: "budget-warning-soft budget-review-row" });
      const text = row.createDiv({ cls: "budget-review-text" });
      text.createDiv({
        text: `${needsMatching.length} payment${needsMatching.length === 1 ? "" : "s"} still need${needsMatching.length === 1 ? "s" : ""} matching`
      });
      text.createDiv({
        text:
          "These aren't counted as spending. Matching them tells the budget which bill or debt they already paid, " +
          "so it stops holding money back for it.",
        cls: "budget-review-sub"
      });
      const review = row.createEl("button", { text: "Review", cls: "budget-btn budget-review-btn mod-cta" });
      review.onclick = () => {
        new MatchPaymentsModal(this.app, this.plugin, {
          payments: needsMatching,
          pairs: (r.unreconciled && r.unreconciled.pairs) || [],
          obligations: r.periodObligations || [],
          rules: ctx.rules
        }).open();
      };
    }

    // Overspending the allowance is not a deficit — obligations are still
    // covered — but the money came out of what goals or debt were going to get,
    // so it shouldn't pass silently.
    if ((r.bufferOverrun || 0) > 0.005) {
      container.createDiv({ cls: "budget-warning-soft" }).setText(
        `You're $${r.bufferOverrun.toFixed(2)} past this period's $${(r.allocatedBuffer || 0).toFixed(2)} spending allowance. ` +
          `That came out of money earmarked for goals or debt, not out of thin air.`
      );
    }

  }

  // What this paycheck answers for, and what is left of the spending allowance.
  renderObligationsCard(grid, r, ctx) {
    const { rules } = ctx;
    const fixedCard = grid.createDiv({ cls: "budget-card" });
    fixedCard.createEl("h4", { text: "Due this pay period" });
    fixedCard.createEl("p", {
      text: "Bills, debt payments and subscriptions the budget already knows you owe.",
      cls: "budget-muted budget-card-sub"
    });
    const paidList = r.periodFixedPaid || [];
    if (r.periodFixed.length === 0 && paidList.length === 0) {
      fixedCard.createEl("p", { text: "None due before your next paycheck.", cls: "budget-muted" });
    } else {
      r.periodFixed.forEach((f) => {
        const row = fixedCard.createDiv({ cls: "budget-fixed-row" });
        row.createSpan({ text: f.name, cls: "budget-fixed-name" });
        row.createSpan({ text: `$${f.amount.toFixed(2)}`, cls: "budget-amount" });
        const payBtn = row.createEl("button", { text: "Mark Paid", cls: "budget-btn" });
        payBtn.onclick = async () => {
          const dueInstance = fixedExpenseDueInRange(f, r.todayStr, r.nextPaydayStr);
          if (!dueInstance) return;
          // Goes through the same modal as the settings flow, so the real
          // transaction gets linked here too. Without the link the payment
          // would be charged again against the spending allowance.
          const rules = await readJSON(this.app, FILES.rules, []);
          new MarkPaidModal(
            this.app,
            f,
            dueInstance,
            async (paidForDate, tx) => {
              const all = await readJSON(this.app, FILES.fixedExpenses, []);
              const idx = all.findIndex((e) => (f.id ? e.id === f.id : e.name === f.name));
              if (idx >= 0) {
                recordFixedPayment(all[idx], paidForDate, tx);
                await writeJSON(this.app, FILES.fixedExpenses, all);
                new Notice(
                  isRollingExpense(all[idx])
                    ? `"${f.name}" paid \u2014 next due ${all[idx].next_due_date}`
                    : `Marked "${f.name}" paid for ${paidForDate}`
                );
                await this.plugin.recalculate();
              }
            },
            this.plugin,
            rules
          ).open();
        };
      });

      paidList.forEach((f) => {
        const row = fixedCard.createDiv({ cls: "budget-fixed-row budget-fixed-paid" });
        const paidLabel = row.createDiv({ cls: "budget-fixed-name" });
        paidLabel.createDiv({ text: `${f.name} \u2014 paid` });
        // An expense marked paid with no linked transaction is the one case
        // that still double-counts: it's out of committed, but its real
        // payment is indistinguishable from ordinary spending, so it also
        // eats the allowance. Say so rather than guessing which one it was.
        const linkedForCycle = (f.linked_payments || []).some(
          (p) => p && f.last_paid_date && p.paid_for === f.last_paid_date
        );
        if (!linkedForCycle) {
          paidLabel.createDiv({ text: "no transaction linked", cls: "budget-buffer-sub" });
        }
        row.createSpan({ text: `$${f.amount.toFixed(2)}`, cls: "budget-amount" });

        if (!linkedForCycle) {
          const linkBtn = row.createEl("button", { text: "Link payment", cls: "budget-btn" });
          linkBtn.onclick = async () => {
            const rules = await readJSON(this.app, FILES.rules, []);
            new MarkPaidModal(
              this.app,
              f,
              f.last_paid_date,
              async (paidForDate, tx) => {
                if (!tx) return;
                const all = await readJSON(this.app, FILES.fixedExpenses, []);
                const idx = all.findIndex((e) => (f.id ? e.id === f.id : e.name === f.name));
                if (idx < 0) return;
                // Linking after the fact must not advance a rolling due date
                // a second time, so the link is recorded directly.
                if (!Array.isArray(all[idx].linked_payments)) all[idx].linked_payments = [];
                if (!all[idx].linked_payments.some((p) => p && p.tx_id === tx.id)) {
                  all[idx].linked_payments.push({
                    tx_id: tx.id,
                    amount: round2(Math.abs(tx.amount || 0)),
                    date: tx.date || paidForDate,
                    paid_for: f.last_paid_date
                  });
                }
                await writeJSON(this.app, FILES.fixedExpenses, all);
                new Notice(`Linked ${displayMerchant(tx.merchant_raw, rules)} to "${f.name}".`);
                await this.plugin.recalculate();
              },
              this.plugin,
              rules
            ).open();
          };
        }

        const undoBtn = row.createEl("button", { text: "Undo", cls: "budget-btn" });
        undoBtn.onclick = async () => {
          const all = await readJSON(this.app, FILES.fixedExpenses, []);
          const idx = all.findIndex((e) => (f.id ? e.id === f.id : e.name === f.name));
          if (idx >= 0) {
            const paidFor = all[idx].last_paid_date;
            if (isRollingExpense(all[idx]) && paidFor) {
              all[idx].next_due_date = paidFor; // roll back
            }
            clearFixedPayment(all[idx], paidFor);
            all[idx].last_paid_date = null;
            await writeJSON(this.app, FILES.fixedExpenses, all);
            new Notice(`Marked "${f.name}" as unpaid again`);
            await this.plugin.recalculate();
          }
        };
      });
    }

    // Minimum payments, showing what's already been paid this period so a
    // settled one reads as settled rather than silently disappearing.
    const mins = (r.dueInstallments || []).concat(r.dueRevolvingMins || []);
    mins.forEach((d) => {
      const li = fixedCard.createDiv({
        cls: `budget-fixed-row${d._settled ? " budget-fixed-paid" : ""}`
      });
      const label = d.provider || d.account_id || "Minimum payment";
      li.createSpan({
        text: d._settled
          ? `${label} — paid`
          : d._paidThisPeriod > 0
            ? `${label} — $${d._paidThisPeriod.toFixed(2)} paid`
            : `${label} minimum`,
        cls: "budget-fixed-name"
      });
      li.createSpan({
        text: d._settled ? `$${d._due.toFixed(2)}` : `$${d._remaining.toFixed(2)}`,
        cls: "budget-amount"
      });
    });

    if (r.earmarked > 0) {
      const li = fixedCard.createDiv({ cls: "budget-fixed-row" });
      li.createSpan({ text: "Earmarked for savings goals", cls: "budget-fixed-name" });
      li.createSpan({ text: `$${r.earmarked.toFixed(2)}`, cls: "budget-amount" });
    }

    // The buffer row and the three drill-downs that explained it moved to the
    // hero, beside the Spendable figure they describe; the standalone
    // necessities card is now nested under subscriptions. What is left here is
    // exactly what the card claims to be: things due this pay period.

    if (r.minimumsPaid > 0) {
      fixedCard.createEl("p", {
        text: `$${r.minimumsPaid.toFixed(2)} total paid in minimums this period.`,
        cls: "budget-muted"
      });
    }

  }

  // Kept subscriptions billing before payday.
  renderSubsCard(grid, r) {
    const subsDue = r.upcomingSubs || [];
    const subsCard = grid.createDiv({ cls: "budget-card" });
    const subsHead = subsCard.createDiv({ cls: "budget-sub-head" });
    subsHead.createEl("h4", { text: "Upcoming subscriptions due" });
    if (subsDue.length) {
      subsHead.createSpan({ text: `$${r.periodSubsTotal.toFixed(2)}`, cls: "budget-sub-total" });
      const list = subsCard.createEl("ul", { cls: "budget-list" });
      subsDue.forEach((s) => {
        const li = list.createEl("li");
        const nameCol = li.createDiv({ cls: "budget-sub-text-col" });
        nameCol.createDiv({ text: s.key });
        nameCol.createDiv({ text: `renews ${s.dueDate} \u00b7 ${s.cadenceLabel}`, cls: "budget-sub-meta" });
        li.createSpan({ text: `$${s.amount.toFixed(2)}`, cls: "budget-amount" });
      });
    } else {
      subsCard.createEl("p", {
        text: "None billing before your next paycheck. Only subscriptions marked \u201cKeep\u201d are counted here.",
        cls: "budget-muted"
      });
    }

    // Projected necessities used to own a whole card. It is the same kind of
    // thing as a subscription — money the budget expects to go out before
    // payday that nobody sent a bill for — so it shares this one, below a rule.
    const vn = r.variableNecessities;
    if (vn && vn.detail && vn.detail.length) {
      const nHead = subsCard.createDiv({ cls: "budget-sub-head budget-nested-head" });
      nHead.createEl("h4", { text: "Projected necessities" });
      nHead.createSpan({
        text: `$${(r.variableNecessitiesTotal || 0).toFixed(2)}`,
        cls: "budget-sub-total"
      });

      vn.detail.forEach((d) => {
        const row = subsCard.createDiv({ cls: "budget-fixed-row budget-necessity-row" });
        const col = row.createDiv({ cls: "budget-fixed-name budget-buffer-text" });
        col.createDiv({ text: d.category });
        if (!d.sufficientHistory) {
          col.createDiv({ text: "Not enough history to estimate", cls: "budget-buffer-sub" });
          row.createSpan({ text: "—", cls: "budget-amount budget-muted" });
          return;
        }
        // The explanatory paragraph under this list is gone; each row already
        // says it is a forecast from purchase history, which is the part that
        // mattered.
        col.createDiv({
          text:
            `~${d.projectedCount} ${d.projectedCount === 1 ? "purchase" : "purchases"} before payday · ` +
            `~$${d.medianAmount.toFixed(2)} each · typical gap ${d.medianGap} day${d.medianGap === 1 ? "" : "s"}`,
          cls: "budget-buffer-sub"
        });
        row.createSpan({ text: `$${d.reserveAmount.toFixed(2)}`, cls: "budget-amount" });
      });
    }
  }

  // Where surplus is recommended to go — debt on one side, goals on the other.
  //
  // These were two separate cards in a two-column grid, which meant two narrow
  // boxes answering halves of one question, and Savings Mode made it worse: the
  // savings card only appeared when the mode was on, so the payoff card sat
  // beside a hole. One full-width card with two columns says what is actually
  // true — these are the two places a surplus can go, and the mode decides which
  // one gets it.
  renderRecommendationsCard(grid, r) {
    // No card heading: the two column headers already say what this is, and a
    // title above them was a third label for the same thing.
    const card = grid.createDiv({ cls: "budget-card budget-card-wide" });
    const split = card.createDiv({ cls: "budget-split" });

    // ---- Debt payoff ----
    const payoff = split.createDiv();
    payoff.createEl("h5", { text: "Recommended payoff" });
    if (r.savingsMode) {
      payoff.createEl("p", {
        text:
          "Paused while Savings Focus is on \u2014 switch to Debt Reduction at the top of the " +
          "dashboard to see payoff targets.",
        cls: "budget-muted"
      });
    } else if (!r.payoffBreakdown || r.payoffBreakdown.length === 0) {
      payoff.createEl("p", { text: "Nothing recommended beyond minimums this period.", cls: "budget-muted" });
    } else {
      const list = payoff.createEl("ul", { cls: "budget-list" });
      r.payoffBreakdown.forEach((p) => {
        const li = list.createEl("li");
        li.createSpan({ text: p.target });
        li.createSpan({ text: `$${p.amount.toFixed(2)}`, cls: "budget-amount" });
        li.createEl("div", { text: p.reason, cls: "budget-muted budget-reason" });
      });
    }

    // ---- Savings ----
    const savings = split.createDiv();
    savings.createEl("h5", { text: "Recommended savings" });
    const listSavings = (entries) => {
      const list = savings.createEl("ul", { cls: "budget-list" });
      entries.forEach((b) => {
        const li = list.createEl("li");
        li.createSpan({ text: b.target });
        li.createSpan({ text: `$${b.amount.toFixed(2)}`, cls: "budget-amount budget-positive" });
        li.createEl("div", { text: b.reason, cls: "budget-muted budget-reason" });
      });
    };
    if (!r.savingsMode) {
      // In Debt Reduction the only savings are capped funds, which refill
      // ahead of extra principal. Said so, because otherwise money going to a
      // fund while the switch says "Debt Reduction" looks like a mistake.
      const fundAsks = (r.savingsBreakdown || []).filter((b) => b && b.fund);
      if (fundAsks.length) {
        listSavings(fundAsks);
        savings.createEl("p", {
          text:
            "Capped funds refill before extra principal; the rest of the surplus goes to debt. Switch to " +
            "Savings Focus at the top of the dashboard to route it to your goals instead.",
          cls: "budget-muted"
        });
        return;
      }
      // Previously this column simply did not exist when the mode was off,
      // which read as "savings isn't a thing" rather than "it's switched off".
      savings.createEl("p", {
        text:
          "Debt Reduction is on, so surplus goes to principal. Switch to Savings Focus at the top " +
          "of the dashboard to route it to your goals instead.",
        cls: "budget-muted"
      });
    } else {
      const sb = r.savingsBreakdown || [];
      if (!sb.length) {
        savings.createEl("p", {
          text:
            (r.availableForDebt || 0) <= 0
              ? "Nothing left to allocate after obligations and your safety buffer."
              : "No goals with anything left to fund. Create one and it'll be allocated here.",
          cls: "budget-muted"
        });
      } else {
        listSavings(sb);
        savings.createEl("p", {
          text: `$${r.recommendedSavings.toFixed(2)} allocated to goals${sb.some((b) => b && b.fund) ? " and capped funds" : ""}.`,
          cls: "budget-muted"
        });
      }
    }
  }

  // ---- Capped funds ----
  //
  // One fund, three looks, depending on where it has been put: a figure in the
  // hero, a card of its own among the cards, or a row in Savings goals. What it
  // says is the same everywhere and comes from fundFacts, so the three can only
  // differ in layout.

  fundFacts(fund, ctx, r) {
    const p = fundProgress(fund, (ctx && ctx.accounts) || []);
    const entry = ((r && r.savingsBreakdown) || []).find((b) => b && b.fund && b.id === fund.id) || null;
    const today = todayLocal();
    // Stale once it's a few days old; with no date at all it's stale too — an
    // account synced before balances were dated, which the next sync fixes.
    const age = fundBalanceAge(p, today);
    const stale = !!p.account && p.known && (age == null || age > FUND_STALE_DAYS);
    const tooOld = !!p.account && p.known && !fundBalanceFresh(p, today);

    let status;
    let statusCls = "";
    if (!p.account) {
      status = "Its account is gone — edit the fund to choose another";
      statusCls = "budget-negative";
    } else if (!p.known) {
      status = "No balance yet — it arrives with the next sync";
    } else if (p.over > 0.005) {
      status = `$${p.over.toFixed(2)} over the cap`;
    } else if (p.complete) {
      status = "At its cap";
    } else {
      status = `$${p.remaining.toFixed(2)} below the cap`;
    }

    // The hero's one line under the bar: the cap is already in it, so it isn't
    // repeated as "of $1000 cap \u00b7 $359 below the cap".
    const cap = `$${p.target.toFixed(2)} cap`;
    let capLine;
    if (!p.account || !p.known) capLine = `${cap} \u00b7 ${status.charAt(0).toLowerCase()}${status.slice(1)}`;
    else if (p.over > 0.005) capLine = `$${p.over.toFixed(2)} over its ${cap}`;
    else if (p.complete) capLine = `At its ${cap}`;
    else capLine = `$${p.remaining.toFixed(2)} below its ${cap}`;

    let source = "";
    if (p.account) {
      const asOf = p.asOf ? formatChartDate(p.asOf).replace(`, ${today.slice(0, 4)}`, "") : "";
      source = `${accountLabel(p.account)}${asOf ? ` \u00b7 as of ${asOf}` : ""}${stale ? " \u2014 sync to refresh" : ""}`;
    }

    // What to do this period, or why there's nothing to do.
    const period = (r && r.fundPeriods && r.fundPeriods[fund.id]) || null;
    let ask = null;
    if (entry) ask = `Move $${entry.amount.toFixed(2)} in this period`;
    else if (tooOld) ask = "Its balance is too old to go by \u2014 sync before moving anything in";
    else if (p.known && p.remaining > 0 && r) {
      if (period && period.moved > 0 && period.moved >= period.share - 0.005) {
        ask = `Done for this period \u2014 $${period.moved.toFixed(2)} moved in`;
      } else if ((r.availableForDebt || 0) <= 0) ask = "No surplus this period, so nothing to move in";
      else if (p.pct >= 95) ask = "Close to its cap, so it isn't asking for anything this period";
      else ask = "Nothing left over for it this period";
    }
    // Status and source as one run of text. The meta row is a wrapping flex
    // row, so separate pieces broke onto new lines that began with a dot.
    const meta = source ? `${status} \u00b7 ${source}` : status;
    const metaCls = statusCls || (stale ? "budget-fund-stale" : "");
    return { p, entry, stale, status, statusCls, source, ask, capLine, meta, metaCls };
  }

  fundBar(parent, p, extra = "") {
    const track = parent.createDiv({ cls: `budget-progress-track budget-fund-track${extra ? ` ${extra}` : ""}` });
    const fill = track.createDiv({ cls: `budget-progress-fill budget-fund-fill${p.complete ? " budget-progress-done" : ""}` });
    fill.style.width = `${p.pct.toFixed(1)}%`;
    track.setAttr("role", "progressbar");
    track.setAttr("aria-valuemin", "0");
    track.setAttr("aria-valuemax", String(p.target));
    track.setAttr("aria-valuenow", String(Math.max(0, p.saved)));
    return track;
  }

  // Desktop only. Dragging needs a pointer and Obsidian's mobile web views don't
  // start an HTML drag from a touch, so on a phone the Move button is the way.
  fundGrip(parent, fund, source) {
    if (isMobileApp()) return null;
    const grip = parent.createSpan({ text: "\u283F", cls: "budget-fund-grip" });
    grip.setAttr("draggable", "true");
    // The Move button next to it does the same thing and is reachable by
    // keyboard; the grip is a pointer shortcut, so it stays out of the tab order.
    grip.setAttr("aria-hidden", "true");
    grip.setAttr("title", "Drag to the hero, the cards or Savings goals");
    grip.addEventListener("dragstart", (e) => {
      const from = fundPlacement(fund);
      this.fundDrag = { id: fund.id, from };
      if (e && e.dataTransfer) {
        e.dataTransfer.effectAllowed = "move";
        // A private type, so dropping it into a note doesn't paste anything.
        e.dataTransfer.setData("application/x-budget-fund", fund.id);
        if (source && typeof e.dataTransfer.setDragImage === "function") e.dataTransfer.setDragImage(source, 12, 12);
      }
      // Marked on the next tick, not now. Revealing the drop targets moves the
      // page under the pointer, and Chromium abandons a drag whose source moves
      // during dragstart.
      const root = this.overviewEl;
      if (root) {
        setTimeout(() => {
          if (!this.fundDrag || this.overviewEl !== root) return;
          root.addClass("budget-fund-dragging");
          root.addClass(`budget-fund-from-${from}`);
        }, 0);
      }
    });
    grip.addEventListener("dragend", () => this.endFundDrag());
    return grip;
  }

  endFundDrag() {
    this.fundDrag = null;
    const root = this.overviewEl;
    if (!root) return;
    ["budget-fund-dragging"].concat(FUND_PLACEMENTS.map((p) => `budget-fund-from-${p}`)).forEach((c) => root.toggleClass(c, false));
  }

  // Where a dragged fund can land. Hidden until a drag starts.
  fundDropSlot(parent, placement, text) {
    if (isMobileApp()) return null;
    const slot = parent.createDiv({ cls: `budget-fund-drop budget-fund-drop-${placement}`, text });
    const accept = (e) => {
      if (!this.fundDrag) return false;
      if (e && typeof e.preventDefault === "function") e.preventDefault();
      if (e && e.dataTransfer) e.dataTransfer.dropEffect = "move";
      return true;
    };
    slot.addEventListener("dragenter", (e) => {
      if (accept(e)) slot.addClass("budget-fund-drop-over");
    });
    slot.addEventListener("dragover", (e) => {
      if (accept(e)) slot.addClass("budget-fund-drop-over");
    });
    slot.addEventListener("dragleave", () => slot.toggleClass("budget-fund-drop-over", false));
    slot.addEventListener("drop", async (e) => {
      if (!accept(e)) return;
      const id = this.fundDrag.id;
      this.endFundDrag();
      await this.plugin.moveCappedFund(id, placement);
    });
    return slot;
  }

  fundMoveButton(parent, fund, cls = "budget-btn") {
    const btn = parent.createEl("button", { text: "Move", cls });
    btn.setAttr("aria-haspopup", "menu");
    btn.setAttr("title", "Choose where this fund shows on the Overview");
    btn.onclick = (evt) => this.openFundMoveMenu(fund, btn, evt);
    return btn;
  }

  openFundMoveMenu(fund, btn, evt) {
    const menu = new Menu();
    const here = fundPlacement(fund);
    FUND_PLACEMENTS.forEach((p) => {
      menu.addItem((item) => {
        const canCheck = typeof item.setChecked === "function";
        item.setTitle(canCheck || p !== here ? FUND_PLACEMENT_LABELS[p] : `${FUND_PLACEMENT_LABELS[p]} (here now)`);
        if (canCheck) item.setChecked(p === here);
        item.onClick(() => {
          if (p !== here) this.plugin.moveCappedFund(fund.id, p);
        });
      });
    });
    // Anchored to the button rather than the pointer, so opening it from the
    // keyboard puts it somewhere sensible instead of the window's corner.
    const rect = btn && typeof btn.getBoundingClientRect === "function" ? btn.getBoundingClientRect() : null;
    if (rect) menu.showAtPosition({ x: rect.left, y: rect.bottom });
    else if (evt) menu.showAtMouseEvent(evt);
    return menu;
  }

  fundButtons(parent, fund, ctx, { compact = false } = {}) {
    const cls = compact ? "budget-basis-btn" : "budget-btn";
    this.fundMoveButton(parent, fund, cls);
    const edit = parent.createEl("button", { text: "Edit", cls });
    edit.onclick = () => this.plugin.promptCappedFund(fund);
    if (compact) return;
    const del = parent.createEl("button", { text: "Delete", cls: "budget-btn budget-btn-danger" });
    del.onclick = () => this.confirmDeleteFund(fund, ctx);
  }

  confirmDeleteFund(fund, ctx) {
    const account = ((ctx && ctx.accounts) || []).find((a) => a.id === fund.account_id);
    new ConfirmModal(this.app, {
      title: `Delete “${fund.name}”?`,
      body: [
        "It stops showing on the Overview and stops asking for surplus.",
        account
          ? `${accountLabel(account)} stays in your accounts and keeps syncing, and its balance and transactions aren't touched. Remove it under Settings → Accounts if you don't want it at all.`
          : null
      ],
      onConfirm: async () => {
        await this.plugin.deleteCappedFund(fund);
      }
    }).open();
  }

  // In the hero: a figure beside Spendable and Total flexibility.
  renderFundHero(figures, fund, ctx, r) {
    const f = this.fundFacts(fund, ctx, r);
    const block = figures.createDiv({ cls: "budget-hero-block budget-hero-secondary budget-fund budget-fund-hero" });
    if (f.source) block.setAttr("title", f.source);
    const label = block.createDiv({ cls: "budget-hero-label budget-fund-label" });
    this.fundGrip(label, fund, block);
    label.createSpan({ text: fund.name });
    block.createEl("div", {
      text: f.p.known ? `$${f.p.saved.toFixed(2)}` : "—",
      cls: `budget-hero-number budget-fund-number${f.p.known ? " budget-fund-glow" : ""}`
    });
    this.fundBar(block, f.p, "budget-fund-hero-track");
    block.createEl("div", { text: f.capLine, cls: `budget-hero-sub ${f.statusCls}`.trim() });
    if (f.ask) block.createEl("div", { text: f.ask, cls: `budget-hero-sub${f.entry ? " budget-fund-ask" : ""}` });
    if (f.stale) block.createEl("div", { text: f.source, cls: "budget-hero-sub budget-fund-stale" });
    this.fundButtons(block.createDiv({ cls: "budget-fund-hero-btns" }), fund, ctx, { compact: true });
  }

  // Among the cards: a full-width card of its own.
  renderFundCard(grid, fund, ctx, r) {
    const f = this.fundFacts(fund, ctx, r);
    const card = grid.createDiv({ cls: "budget-card budget-card-wide budget-fund budget-fund-card" });
    const head = card.createDiv({ cls: "budget-sub-head" });
    const title = head.createDiv({ cls: "budget-fund-title" });
    this.fundGrip(title, fund, card);
    title.createEl("h4", { text: fund.name });
    title.createSpan({ text: "capped fund", cls: "budget-badge budget-badge-fund" });
    const fig = head.createDiv({ cls: "budget-fund-figure" });
    fig.createSpan({ text: f.p.known ? `$${f.p.saved.toFixed(2)}` : "—", cls: `budget-fund-number${f.p.known ? " budget-fund-glow" : ""}` });
    fig.createSpan({ text: ` of $${f.p.target.toFixed(2)} cap`, cls: "budget-fund-cap" });
    this.fundBar(card, f.p, "budget-fund-card-track");

    card.createDiv({ cls: "budget-goal-meta budget-fund-meta" }).createSpan({ text: f.meta, cls: f.metaCls });

    if (f.entry) {
      const ask = card.createDiv({ cls: "budget-fund-ask-row" });
      ask.createSpan({ text: f.ask, cls: "budget-fund-ask" });
      ask.createSpan({ text: ` — ${f.entry.reason}`, cls: "budget-muted" });
    } else if (f.ask) {
      card.createDiv({ text: f.ask, cls: "budget-goal-meta" });
    }
    this.fundButtons(card.createDiv({ cls: "budget-goal-btns" }), fund, ctx);
  }

  // In Savings goals: a row like the goals around it, minus the parts that
  // don't apply — no Add Funds, no pin, no contributions ledger.
  renderFundGoalRow(goalsCard, fund, ctx, r) {
    const f = this.fundFacts(fund, ctx, r);
    const row = goalsCard.createDiv({ cls: "budget-goal-row budget-fund budget-fund-row" });
    const top = row.createDiv({ cls: "budget-goal-top" });
    const nameEl = top.createDiv({ cls: "budget-goal-name" });
    this.fundGrip(nameEl, fund, row);
    nameEl.createSpan({ text: fund.name });
    nameEl.createSpan({ text: "capped fund", cls: "budget-badge budget-badge-fund" });
    if (f.p.complete) nameEl.createSpan({ text: "at cap", cls: "budget-badge budget-badge-keep" });
    // The balance and the ceiling as two parts, so the balance can carry the
    // fund's glow the way it does in the hero and on its card.
    const amt = top.createSpan({ cls: "budget-amount" });
    amt.createSpan({ text: f.p.known ? `$${f.p.saved.toFixed(2)}` : "—", cls: `budget-fund-number${f.p.known ? " budget-fund-glow" : ""}` });
    amt.createSpan({ text: ` / $${f.p.target.toFixed(2)}` });
    this.fundBar(row, f.p);
    row.createDiv({ cls: "budget-goal-meta budget-fund-meta" }).createSpan({ text: f.meta, cls: f.metaCls });
    if (f.ask) row.createDiv({ cls: "budget-goal-meta" }).createSpan({ text: f.ask, cls: f.entry ? "budget-fund-ask" : "" });
    this.fundButtons(row.createDiv({ cls: "budget-goal-btns" }), fund, ctx);
  }

  renderFundCards(grid, r, ctx) {
    const funds = cappedFunds(ctx && ctx.savingsGoals);
    funds.filter((f) => fundPlacement(f) === "cards").forEach((f) => this.renderFundCard(grid, f, ctx, r));
    if (funds.length) this.fundDropSlot(grid, "cards", "Drop here to show it as a card");
  }

  // Transfers in an account several goals share, waiting for you to say which
  // goal each was for. Same badge-and-panel as the label inbox; one button per
  // goal (the one a logged contribution points to marked as the likely one),
  // and "Not for a goal" for interest, a stray deposit, or money that was
  // there before.
  renderGoalTransferInbox(container, ask, ctx) {
    const { rules } = ctx;
    const goalsById = new Map(regularGoals(ctx.savingsGoals).map((g) => [g.id, g]));
    const n = ask.length;
    if (!this.goalInboxId) this.goalInboxId = `budget-goal-inbox-${Math.random().toString(36).slice(2, 8)}`;
    const inbox = container.createDiv({ cls: "budget-inbox budget-goal-inbox" });
    const badge = inbox.createEl("button", { cls: "budget-inbox-badge", attr: { type: "button", "aria-controls": this.goalInboxId } });
    badge.createSpan({ text: "!", cls: "budget-inbox-dot", attr: { "aria-hidden": "true" } });
    badge.createSpan({
      text: n === 1 ? "1 savings transfer needs a goal" : `${n} savings transfers need a goal`,
      cls: "budget-inbox-text"
    });
    const action = badge.createSpan({ cls: "budget-inbox-action" });
    badge.createSpan({ cls: "budget-inbox-chevron", attr: { "aria-hidden": "true" } });
    const panel = inbox.createDiv({
      cls: "budget-inbox-panel",
      attr: { id: this.goalInboxId, role: "region", "aria-label": "Savings transfers that need a goal" }
    });
    const list = panel.createDiv({ cls: "budget-inbox-panel-inner" }).createDiv({ cls: "budget-card budget-inbox-list" });
    // Newest first, like the label inbox.
    const queue = ask.slice().sort((a, b) => (a.tx.date < b.tx.date ? 1 : a.tx.date > b.tx.date ? -1 : 0));
    const shown = queue.slice(0, isMobileApp() ? 10 : 20);
    const account = (id) => (ctx.accounts || []).find((a) => a && a.id === id);
    shown.forEach(({ tx, goalIds, suggested }) => {
      const row = list.createDiv({ cls: "budget-recent-row budget-inbox-row budget-goal-inbox-row" });
      const main = row.createDiv({ cls: "budget-recent-main" });
      main.createSpan({ text: displayMerchant(tx.merchant_raw, rules), cls: "budget-recent-name" }).setAttr("title", tx.merchant_raw || "");
      main.createSpan({ text: `${tx.date} \u00b7 ${accountLabel(account(tx.account_id)) || tx.account_id}`, cls: "budget-recent-date" });
      const meta = row.createDiv({ cls: "budget-recent-meta" });
      const into = tx.amount > 0;
      meta.createSpan({
        text: into ? `+$${tx.amount.toFixed(2)}` : `-$${Math.abs(tx.amount).toFixed(2)}`,
        cls: into ? "budget-positive budget-tx-amount" : "budget-negative budget-tx-amount"
      });
      const btns = row.createDiv({ cls: "budget-goal-btns budget-goal-inbox-btns" });
      const answer = async (goalId, label) => {
        const done = await this.plugin.answerGoalTransfer(tx.id, goalId);
        if (!done) {
          new Notice("That transfer or goal has changed since this opened. Take another look.");
        } else if (done.skipped) {
          new Notice("Left out of your goals.");
        } else {
          new Notice(
            `$${Math.abs(tx.amount).toFixed(2)} ${into ? "added to" : "taken off"} ${label}` +
              (done.matched ? ", matched to the contribution you logged." : ".")
          );
        }
        await this.plugin.refreshAfterDataChange();
      };
      goalIds.forEach((id) => {
        const g = goalsById.get(id);
        if (!g) return;
        const likely = (suggested || []).includes(id);
        const b = btns.createEl("button", { text: g.name, cls: `budget-btn${likely ? " mod-cta" : ""}` });
        b.setAttr("title", likely ? `You logged a contribution of this amount to ${g.name}` : `${into ? "Add this to" : "Take this off"} ${g.name}`);
        b.onclick = () => answer(id, g.name);
      });
      const skip = btns.createEl("button", { text: "Not for a goal", cls: "budget-btn" });
      skip.setAttr("title", "Interest, a stray deposit, or money that was already there — don't count it toward any goal");
      skip.onclick = () => answer(null, "");
    });
    if (n > shown.length) {
      list.createEl("p", { text: `${n - shown.length} more after these.`, cls: "budget-muted budget-inbox-more" });
    }
    bindInboxToggle({ inbox, badge, action }, { open: !!this.goalInboxOpen, onChange: (open) => (this.goalInboxOpen = open) });
  }

  renderGoalsCard(container, ctx) {
    const { allTx, rules } = ctx;
    const txById = new Map((allTx || []).filter((t) => t && t.id).map((t) => [t.id, t]));
    // ---- Savings goals ----
    // Capped funds share the goals file but not this list, unless one has been
    // put here; they render after the goals, which is also the order surplus
    // reaches them.
    const goals = regularGoals(ctx.savingsGoals);
    const allFunds = cappedFunds(ctx.savingsGoals);
    const fundsHere = allFunds.filter((f) => fundPlacement(f) === "goals");
    const goalsCard = container.createDiv({ cls: "budget-card budget-goals-card" });
    const goalsHead = goalsCard.createDiv({ cls: "budget-sub-head" });
    goalsHead.createEl("h4", { text: "Savings goals" });
    const headBtns = goalsHead.createDiv({ cls: "budget-goals-head-btns" });
    const addGoalBtn = headBtns.createEl("button", { text: "New goal", cls: "budget-btn" });
    addGoalBtn.onclick = () => {
    new SavingsGoalModal(this.app, async (goal) => {
      goal.id = genId("goal");
      goal.contributions = [];
      if (!goal.account_id) {
        delete goal.account_id;
        delete goal.track_from;
      }
      const list = await readJSON(this.app, FILES.savingsGoals, []);
      list.push(goal);
      await writeJSON(this.app, FILES.savingsGoals, list);
      const added = goal.account_id ? await this.plugin.assignGoalTransfersNow() : 0;
      new Notice(`Created goal: ${goal.name}.` + goalTransfersAddedText(added));
      await this.plugin.refreshAfterDataChange();
    }, null, { accountChoices: goalAccountChoices(ctx.accounts, ctx.savingsGoals) }).open();
    };
    const addFundBtn = headBtns.createEl("button", { text: "New capped fund", cls: "budget-btn" });
    addFundBtn.setAttr("title", "A fund that follows a savings account's balance, up to a ceiling");
    addFundBtn.onclick = () => this.plugin.promptCappedFund();

    if (allFunds.length) this.fundDropSlot(goalsCard, "goals", "Drop here to show it in Savings goals");

    const transferQueue = goalTransferQueue(allTx, ctx.savingsGoals);
    if (transferQueue.ask.length) this.renderGoalTransferInbox(goalsCard, transferQueue.ask, ctx);

    if (goals.length === 0 && !fundsHere.length) {
    goalsCard.createEl("p", {
      text: "No goals yet. Sinking funds are useful for irregular costs \u2014 vet bills, car repairs, annual renewals.",
      cls: "budget-muted"
    });
    } else {
    const periodDays = this.lastResult ? Math.max(daysBetween(this.lastResult.todayStr, this.lastResult.nextPaydayStr), 1) : 14;
    goals.forEach((g) => {
      const p = goalProgress(g);
      const row = goalsCard.createDiv({ cls: "budget-goal-row" });

      const top = row.createDiv({ cls: "budget-goal-top" });
      const nameEl = top.createDiv({ cls: "budget-goal-name" });
      nameEl.createSpan({ text: g.name });
      if (p.complete) nameEl.createSpan({ text: "funded", cls: "budget-badge budget-badge-keep" });
      top.createSpan({
        text: `$${p.saved.toFixed(2)} / $${p.target.toFixed(2)}`,
        cls: "budget-amount"
      });

      const track = row.createDiv({ cls: "budget-progress-track" });
      const fill = track.createDiv({ cls: `budget-progress-fill${p.complete ? " budget-progress-done" : ""}` });
      fill.style.width = `${p.pct.toFixed(1)}%`;

      // One quiet line under the bar: what's left, the pace it asks, and which
      // account it follows. Notes that only matter sometimes live in the
      // tooltip instead of taking a line of their own.
      const meta = row.createDiv({ cls: "budget-goal-meta" });
      const pace = goalPace(g, todayLocal(), periodDays, resolvePaySchedule(this.plugin.settings, allTx));
      const bits = [];
      let note = "";
      const due = g.target_date ? formatShortDate(g.target_date) : "";
      if (p.complete) {
        bits.push("Goal reached.");
      } else if (pace && g.target_date) {
        bits.push(`$${p.remaining.toFixed(2)} to go`);
        if (pace.days <= 0) {
          bits.push(`target date ${due} has passed`);
        } else if (pace.paychecks === 0) {
          bits.push(`no paycheck before ${due}, so it all comes from this one`);
        } else if (pace.exact) {
          bits.push(`${pace.paychecks} paycheck${pace.paychecks === 1 ? "" : "s"} of $${pace.perPeriod.toFixed(2)}`, `by ${due}`);
          if (pace.inferred) note = "Pay schedule inferred from your paycheck history.";
        } else {
          bits.push(`about $${pace.perPeriod.toFixed(2)} a paycheck`, `by ${due} (${pace.days} days)`);
          note = "Set a pay schedule in Settings for an exact count.";
        }
      } else {
        bits.push(`$${p.remaining.toFixed(2)} to go`);
      }
      const goalAccount = g.account_id ? (ctx.accounts || []).find((a) => a && a.id === g.account_id) : null;
      if (g.account_id) {
        bits.push(
          `follows ${goalAccount ? accountLabel(goalAccount) : `${g.account_id} (no longer in your accounts)`}` +
            (g.track_from ? ` since ${formatShortDate(g.track_from)}` : "")
        );
      }
      const metaSpan = meta.createSpan({ text: bits.join(" \u00b7 ") });
      if (note) metaSpan.setAttr("title", note);

      const btns = row.createDiv({ cls: "budget-goal-btns" });

      // Pinning is one goal at a time, so this toggles rather than accumulates.
      const pinBtn = btns.createEl("button", {
        text: g.pinned ? "Unpin" : "Pin to dashboard",
        cls: `budget-btn${g.pinned ? " budget-btn-necessity" : ""}`
      });
      pinBtn.setAttr(
        "title",
        g.pinned
          ? "Stop showing this goal at the top of the Overview"
          : "Show this goal at the top of the Overview, replacing whatever is pinned now"
      );
      pinBtn.onclick = async () => {
        await setPinnedGoal(this.app, g.pinned ? null : g.id);
        new Notice(g.pinned ? `Unpinned ${g.name}.` : `Pinned ${g.name} to the dashboard.`);
        await this.plugin.refreshAfterDataChange();
      };

      const fundBtn = btns.createEl("button", { text: "Add Funds", cls: "budget-btn mod-cta" });
      fundBtn.onclick = () => {
        new AddFundsModal(this.app, g, this.lastResult ? this.lastResult.freeCash : null, async (amount, note) => {
          const updated = await addGoalFunds(this.app, g.id, amount, note);
          if (updated) {
            new Notice(
              `$${Math.abs(amount).toFixed(2)} ${amount < 0 ? "removed from" : "added to"} ${updated.name}.` +
                (amount > 0 ? " Held back from free cash until matched to a transfer." : "")
            );
            await this.plugin.refreshAfterDataChange();
          }
        }).open();
      };
      const editBtn = btns.createEl("button", { text: "Edit", cls: "budget-btn" });
      editBtn.onclick = () => {
        new SavingsGoalModal(
          this.app,
          async (patch) => {
            const list = await readJSON(this.app, FILES.savingsGoals, []);
            const i = list.findIndex((x) => x.id === g.id);
            if (i >= 0) {
              list[i] = Object.assign({}, list[i], patch);
              if (!list[i].account_id) {
                delete list[i].account_id;
                delete list[i].track_from;
              }
              await writeJSON(this.app, FILES.savingsGoals, list);
              const added = list[i].account_id ? await this.plugin.assignGoalTransfersNow() : 0;
              new Notice(`Updated ${patch.name}.` + goalTransfersAddedText(added));
              await this.plugin.refreshAfterDataChange();
            }
          },
          g,
          { accountChoices: goalAccountChoices(ctx.accounts, ctx.savingsGoals, g) }
        ).open();
      };

      const delGoal = btns.createEl("button", { text: "Delete", cls: "budget-btn budget-btn-danger" });
      delGoal.onclick = () => {
        const pr = goalProgress(g);
        const unlinked = (g.contributions || []).filter((c) => !c.linked_tx_id && c.amount > 0).length;
        new ConfirmModal(this.app, {
          title: `Delete “${g.name}”?`,
          body: [
            `$${pr.saved.toFixed(2)} of contribution history will be removed along with the goal.`,
            unlinked
              ? `${unlinked} unmatched contribution${unlinked === 1 ? "" : "s"} are currently held back from free cash — deleting returns that money to spendable.`
              : null,
            g.account_id ? "Its transfers won't be offered to the other goals on the account." : null,
            "This doesn't move any real money; it only stops tracking the goal."
          ],
          onConfirm: async () => {
            const list = await readJSON(this.app, FILES.savingsGoals, []);
            // Its account's transfers stay out of the queue rather than landing
            // on whichever goal is left on the account at the next sync.
            await this.plugin.releaseGoalTransfers((g.contributions || []).map((c) => c && c.linked_tx_id), { skip: true });
            await writeJSON(this.app, FILES.savingsGoals, list.filter((x) => x.id !== g.id));
            new Notice(`Deleted ${g.name}.`);
            await this.plugin.refreshAfterDataChange();
          }
        }).open();
      };

      // ---- Contributions ledger ----
      const contribs = (g.contributions || []).slice().sort((a, b) => (a.date < b.date ? 1 : -1));
      if (contribs.length) {
        const heldBack = round2(
          contribs.filter((c) => !c.linked_tx_id && c.amount > 0).reduce((s, c) => s + c.amount, 0)
        );
        const body = this.collapsible(
          row,
          `goal-contribs-${g.id}`,
          "Contributions",
          heldBack > 0 ? `${contribs.length} \u00b7 $${heldBack.toFixed(2)} held back from free cash` : String(contribs.length),
          false
        );

        contribs.forEach((c) => {
          const cr = body.createDiv({ cls: "budget-contrib-row" });
          const left = cr.createDiv({ cls: "budget-contrib-main" });
          left.createSpan({
            text: `${c.amount < 0 ? "-" : "+"}$${Math.abs(c.amount).toFixed(2)}`,
            cls: `budget-amount ${c.amount < 0 ? "budget-negative" : "budget-positive"}`
          });
          const meta = left.createDiv({ cls: "budget-contrib-meta" });
          meta.createSpan({ text: c.date });
          if (c.note) meta.createSpan({ text: c.note });
          const linkedTx = c.linked_tx_id ? txById.get(c.linked_tx_id) : null;
          const fromAccount = !!(linkedTx && g.account_id && linkedTx.account_id === g.account_id);
          if (c.linked_tx_id && fromAccount) {
            meta.createSpan({
              text: c.amount < 0 ? "taken out of savings" : "transfer to savings",
              cls: "budget-badge budget-badge-keep"
            });
          } else if (c.linked_tx_id) {
            meta.createSpan({ text: "matched to transaction", cls: "budget-badge budget-badge-keep" });
          } else if (c.amount > 0) {
            meta.createSpan({ text: "held back from free cash", cls: "budget-badge budget-badge-manual" });
          }

          const acts = cr.createDiv({ cls: "budget-contrib-btns" });
          if (c.linked_tx_id && fromAccount && c.source === "account") {
            // Added from the account, so undoing it takes it off the goal and
            // puts the transfer back in the queue to be assigned again.
            const unassign = acts.createEl("button", { text: "Unassign", cls: "budget-btn" });
            unassign.setAttr("title", "Take this transfer off the goal; it goes back to the transfers waiting for a goal");
            unassign.onclick = async () => {
              await deleteContribution(this.app, g.id, c.id);
              await this.plugin.releaseGoalTransfers([c.linked_tx_id]);
              new Notice("Unassigned \u2014 it's back with the transfers waiting for a goal.");
              await this.plugin.refreshAfterDataChange();
            };
          } else if (c.linked_tx_id) {
            const unlink = acts.createEl("button", { text: "Unmatch", cls: "budget-btn" });
            unlink.onclick = async () => {
              await unlinkContribution(this.app, g.id, c.id);
              if (fromAccount) await this.plugin.releaseGoalTransfers([c.linked_tx_id]);
              new Notice("Unmatched \u2014 this amount is held back from free cash again.");
              await this.plugin.refreshAfterDataChange();
            };
          } else if (c.amount > 0) {
            const link = acts.createEl("button", { text: "Match transaction", cls: "budget-btn" });
            link.onclick = () => {
              const cands = contributionCandidates(c, allTx, goals, ctx.ownership);
              new LinkContributionModal(
                this.app,
                g,
                c,
                cands,
                async (tx) => {
                  await linkContribution(this.app, g.id, c.id, tx);
                  new Notice(`Matched to ${displayMerchant(tx.merchant_raw, rules)} on ${tx.date}.`);
                  await this.plugin.refreshAfterDataChange();
                },
                rules
              ).open();
            };
          }
          if (c.source === "account" && fromAccount) return;
          const del = acts.createEl("button", { text: "Remove", cls: "budget-btn budget-btn-danger" });
          del.onclick = async () => {
            await deleteContribution(this.app, g.id, c.id);
            if (fromAccount) await this.plugin.releaseGoalTransfers([c.linked_tx_id]);
            new Notice("Contribution removed.");
            await this.plugin.refreshAfterDataChange();
          };
        });
      }
    });

    const totalHeld = earmarkedSavings(goals);
    if (totalHeld > 0) {
      goalsCard.createEl("p", {
        text: `$${totalHeld.toFixed(2)} is held back from free cash for goals. Match a contribution to its transfer transaction once it shows up in an import and it stops being held back \u2014 your balance will already account for it.`,
        cls: "budget-muted budget-apply-scope"
      });
    }

    // After the goals and their note, which is about goals, not funds.
    fundsHere.forEach((f) => this.renderFundGoalRow(goalsCard, f, ctx, this.lastResult));
    }

  }

  // One card, two views. Spending and income were two full-height cards
  // stacked down the page showing the same shape of thing about the same
  // window, so the second was always below the fold and the range select on
  // the first silently governed both. A toggle makes that relationship
  // explicit and halves the scrolling.
  //
  // The two branches are the previous methods' bodies unchanged: same totals,
  // same slices, same drill-downs, same Move and mark-as-transfer actions.
  renderCashFlowChart(container, ctx, scope) {
    const { allTx, rules, categoryMetaList } = ctx;
    const { periodBounds, effectiveRange, scopedTx } = scope;
    const showing = this.activePieTab === "income" ? "income" : "spending";

    const pieCard = container.createDiv({ cls: "budget-card budget-pie-card" });
    const pieHeader = pieCard.createDiv({ cls: "budget-pie-header" });

    // Switching view clears the open drill-down: it belongs to the other
    // dataset, and leaving it set reopens a category that isn't on screen.
    const toggle = pieHeader.createDiv({ cls: "budget-segmented" });
    const tabBtn = (label, key) => {
      const b = toggle.createEl("button", {
        text: label,
        cls: `budget-segment${showing === key ? " budget-segment-on" : ""}`
      });
      b.onclick = () => {
        if (this.activePieTab === key) return;
        this.activePieTab = key;
        this.expandedSpendCategory = null;
        this.expandedIncomeCategory = null;
        this.render();
      };
      return b;
    };
    tabBtn("Spending", "spending");
    tabBtn("Income", "income");

    // One range select for both views, which is what it always governed.
    const rangeSelect = pieHeader.createEl("select", { cls: "budget-range-select" });
    const rangeOptions = [
      { value: "period", label: "This pay period", disabled: !periodBounds },
      { value: "30d", label: "Last 30 days" },
      { value: "all", label: "All time (everything imported)" }
    ];
    rangeOptions.forEach((o) => {
      const opt = rangeSelect.createEl("option", { text: o.label, value: o.value });
      if (o.disabled) opt.disabled = true;
    });
    rangeSelect.value = effectiveRange;
    rangeSelect.onchange = (e) => {
      this.pieRange = e.target.value;
      this.expandedSpendCategory = null;
      this.expandedIncomeCategory = null;
      this.render();
    };

    if (showing === "spending") {
      if (!periodBounds) {
      pieCard.createEl("p", {
        text: "Run 'Enter Paycheck' to unlock \u2018This pay period\u2019 scoping.",
        cls: "budget-muted"
      });
      }

      const { totals, transferTotal } = categorySpendTotals(scopedTx, categoryMetaList);
      const { slices, total } = buildPieSlices(totals);

      if (slices.length === 0) {
      pieCard.createEl("p", { text: "No spend in this range yet.", cls: "budget-muted" });
      if (transferTotal > 0) {
        pieCard.createEl("p", { text: `(There is $${transferTotal.toFixed(2)} in transfer-only spend for this range, excluded from the chart.)`, cls: "budget-muted" });
      }
      } else {
      const pieWrap = pieCard.createDiv({ cls: "budget-pie-wrap" });
      const svgParts = slices
        .map((s) => `<path d="${s.path}" fill="${s.color}"><title>${escapeHtml(s.category)}: $${s.amount.toFixed(2)}</title></path>`)
        .join("");
      const chartDiv = pieWrap.createDiv({ cls: "budget-pie-chart" });
      setSvgContent(chartDiv, `<svg viewBox="0 0 200 200" preserveAspectRatio="xMidYMid meet">${svgParts}</svg>`);

      const legend = pieWrap.createDiv({ cls: "budget-pie-legend" });
      slices.forEach((s) => {
        const row = legend.createDiv({ cls: "budget-legend-row budget-legend-clickable" });
        row.createSpan({ cls: "budget-legend-swatch" }).style.backgroundColor = s.color;
        row.createSpan({ text: s.category, cls: "budget-legend-label" });
        row.createSpan({ text: `$${s.amount.toFixed(2)} (${s.pct.toFixed(0)}%)`, cls: "budget-legend-amount" });
        row.onclick = () => {
          this.expandedSpendCategory = this.expandedSpendCategory === s.category ? null : s.category;
          this.render();
        };
      });
      pieCard.createEl("p", { text: `Total spend in range: $${total.toFixed(2)} \u2014 click a category to see its transactions`, cls: "budget-muted" });
      if (transferTotal > 0) {
        pieCard.createEl("p", {
          text: `Transfers excluded from this chart: $${transferTotal.toFixed(2)} (run 'Manage Transfer Categories' to change which ones count)`,
          cls: "budget-muted"
        });
      }

      if (this.expandedSpendCategory) {
        const catTx = scopedTx.filter((t) => t.amount < 0 && (t.resolved_category || "Uncategorized") === this.expandedSpendCategory);
        const drill = pieCard.createDiv({ cls: "budget-drilldown" });
        const drillHead = drill.createDiv({ cls: "budget-drill-head" });
        drillHead.createEl("h5", { text: `${this.expandedSpendCategory} (${catTx.length} transactions)` });

        if (this.expandedSpendCategory !== "Uncategorized") {
          const transferBtn = drillHead.createEl("button", {
            text: "Not spending \u2014 mark as transfer",
            cls: "budget-btn"
          });
          transferBtn.setAttr(
            "title",
            "Money moved between your own accounts (e.g. paying your credit card from checking). Excluded from spending totals."
          );
          transferBtn.onclick = async () => {
            await setCategoryTransfer(this.app, this.expandedSpendCategory, true);
            new Notice(`\u201c${this.expandedSpendCategory}\u201d is now treated as a transfer and excluded from spending.`);
            this.expandedSpendCategory = null;
            this.render();
          };
        }
        const drillLabels = [...new Set(rules.map((r) => r.home_label).concat(slices.map((s) => s.category)))].sort();
        catTx
          .sort((a, b) => (a.date < b.date ? 1 : -1))
          .forEach((t) => {
            const row = drill.createDiv({ cls: "budget-tx-row" });
            row.createSpan({
              text: `${t.date}  ${displayMerchant(t.merchant_raw, rules)}  $${Math.abs(t.amount).toFixed(2)}`,
              cls: "budget-tx-text"
            }).setAttr("title", t.merchant_raw);
            const moveBtn = row.createEl("button", { text: "Move", cls: "budget-btn" });
            moveBtn.onclick = () => {
              new OverrideModal(this.app, t, drillLabels, async (newLabel) => {
                const all = await readJSON(this.app, FILES.transactions, []);
                const idx = findTxIndex(all, t);
                if (idx < 0) {
                  new Notice("Couldn't locate that transaction in transactions.json \u2014 try re-importing.", 8000);
                  return;
                }
                all[idx].override_label = newLabel;
                const currentRules = await readJSON(this.app, FILES.rules, []);
                applyCategorization(all, currentRules);
                await writeJSON(this.app, FILES.transactions, all);
                new Notice(`Moved to ${newLabel}`);
                this.render();
              }, rules).open();
            };
          });
      }
      }
    } else {
      // ---- Income by category (mirrors the spending chart) ----
      const { totals: incomeTotals, transferTotal: incomeTransferTotal } = categoryIncomeTotals(scopedTx, categoryMetaList);
      const { slices: incomeSlices, total: incomeTotal } = buildPieSlices(incomeTotals);

      if (incomeSlices.length === 0) {
      pieCard.createEl("p", { text: "No categorized income in this range yet.", cls: "budget-muted" });
      if (incomeTransferTotal > 0) {
        pieCard.createEl("p", {
          text: `(There is $${incomeTransferTotal.toFixed(2)} in transfer-only income for this range, excluded from the chart.)`,
          cls: "budget-muted"
        });
      }
      } else {
      const incomeWrap = pieCard.createDiv({ cls: "budget-pie-wrap" });
      const incomeSvg = incomeSlices
        .map((s) => `<path d="${s.path}" fill="${s.color}"><title>${escapeHtml(s.category)}: $${s.amount.toFixed(2)}</title></path>`)
        .join("");
      setSvgContent(
        incomeWrap.createDiv({ cls: "budget-pie-chart" }),
        `<svg viewBox="0 0 200 200" preserveAspectRatio="xMidYMid meet">${incomeSvg}</svg>`
      );

      const incomeLegend = incomeWrap.createDiv({ cls: "budget-pie-legend" });
      incomeSlices.forEach((s) => {
        const row = incomeLegend.createDiv({ cls: "budget-legend-row budget-legend-clickable" });
        row.createSpan({ cls: "budget-legend-swatch" }).style.backgroundColor = s.color;
        row.createSpan({ text: s.category, cls: "budget-legend-label" });
        row.createSpan({ text: `$${s.amount.toFixed(2)} (${s.pct.toFixed(0)}%)`, cls: "budget-legend-amount" });
        row.onclick = () => {
          this.expandedIncomeCategory = this.expandedIncomeCategory === s.category ? null : s.category;
          this.render();
        };
      });

      pieCard.createEl("p", {
        text: `Total income in range: $${incomeTotal.toFixed(2)} \u2014 click a category to see its deposits`,
        cls: "budget-muted"
      });
      if (incomeTransferTotal > 0) {
        pieCard.createEl("p", {
          text: `Transfers excluded from this chart: $${incomeTransferTotal.toFixed(2)}`,
          cls: "budget-muted"
        });
      }

      if (this.expandedIncomeCategory) {
        const incomeTx = scopedTx.filter(
          (t) => t.amount > 0 && (t.resolved_category || "Uncategorized") === this.expandedIncomeCategory
        );
        const drill = pieCard.createDiv({ cls: "budget-drilldown" });
        const drillHead = drill.createDiv({ cls: "budget-drill-head" });
        drillHead.createEl("h5", {
          text: `${this.expandedIncomeCategory} (${incomeTx.length} deposit${incomeTx.length === 1 ? "" : "s"})`
        });

        if (this.expandedIncomeCategory !== "Uncategorized") {
          const xferBtn = drillHead.createEl("button", {
            text: "Not income \u2014 mark as transfer",
            cls: "budget-btn"
          });
          xferBtn.setAttr(
            "title",
            "Money moved in from your own accounts rather than earned. Excluded from income and spending totals."
          );
          xferBtn.onclick = async () => {
            await setCategoryTransfer(this.app, this.expandedIncomeCategory, true);
            new Notice(`\u201c${this.expandedIncomeCategory}\u201d is now treated as a transfer and excluded from income.`);
            this.expandedIncomeCategory = null;
            this.render();
          };
        }

        const incomeLabels = [
          ...new Set(rules.map((r) => r.home_label).concat(incomeSlices.map((s) => s.category)))
        ].sort();

        incomeTx
          .sort((a, b) => (a.date < b.date ? 1 : -1))
          .forEach((t) => {
            const row = drill.createDiv({ cls: "budget-tx-row" });
            row
              .createSpan({
                text: `${t.date}  ${displayMerchant(t.merchant_raw, rules)}  +$${t.amount.toFixed(2)}`,
                cls: "budget-tx-text budget-positive"
              })
              .setAttr("title", t.merchant_raw);
            const moveBtn = row.createEl("button", { text: "Move", cls: "budget-btn" });
            moveBtn.onclick = () => {
              new OverrideModal(
                this.app,
                t,
                incomeLabels,
                async (newLabel) => {
                  const all = await readJSON(this.app, FILES.transactions, []);
                  const idx = findTxIndex(all, t);
                  if (idx >= 0) {
                    all[idx].override_label = newLabel;
                    const currentRules = await readJSON(this.app, FILES.rules, []);
                    applyCategorization(all, currentRules);
                    await writeJSON(this.app, FILES.transactions, all);
                    new Notice(`Moved to ${newLabel}`);
                    this.render();
                  }
                },
                rules
              ).open();
            };
          });
      }
      }
    }
  }

  renderSavingsBanner(container, sav, ctx) {
    const modeLabel = "Savings Focus";
    const banner = container.createDiv({
      cls: `budget-reloc-banner${sav.past ? " budget-reloc-past" : sav.imminent ? " budget-reloc-imminent" : ""}`
    });

    if (sav.invalid) {
      banner.createDiv({ text: modeLabel, cls: "budget-reloc-title" });
      banner.createDiv({
        text: "The saved deadline isn\u2019t a valid date \u2014 pick it again in Settings.",
        cls: "budget-reloc-sub"
      });
      return;
    }

    const left = banner.createDiv({ cls: "budget-reloc-left" });
    left.createDiv({ text: `\u{1F6A8} ${modeLabel}`, cls: "budget-reloc-title" });
    left.createDiv({
      text: sav.past
        ? `Deadline ${sav.deadline} has passed — turn this off in settings when you're done.`
        : "Extra debt payoff is paused. Minimums are still covered; the surplus is routed into your goals.",
      cls: "budget-reloc-sub"
    });

    if (sav.openEnded) return; // no deadline set — no countdown to show

    const right = banner.createDiv({ cls: "budget-reloc-count" });
    right.createDiv({
      text: sav.past ? `${Math.abs(sav.days)}` : `${sav.days}`,
      cls: "budget-reloc-days"
    });
    right.createDiv({
      text: sav.past
        ? `day${Math.abs(sav.days) === 1 ? "" : "s"} ago`
        : `day${sav.days === 1 ? "" : "s"} to deadline${sav.weeks >= 2 ? ` · ~${sav.weeks} weeks` : ""}`,
      cls: "budget-reloc-days-label"
    });

    // Pausing payoff is cheap for interest-bearing debt and expensive for a
    // deferred-interest plan that lapses mid-move.
    const risks = deferredRisksDuring(
      ctx.installmentDebts,
      todayLocal(),
      sav.deadline
    );
    risks.forEach((r) => {
      const warn = container.createDiv({ cls: "budget-warning" });
      warn.setText(
        `${r.provider} is 0% only until ${r.payoffDeadline}. Miss that and ${r.apr}% applies retroactively to the original $${(r.principal || 0).toFixed(2)} — $${r.balance.toFixed(2)} is still owed. This one is worth clearing even while hoarding cash.`
      );
    });
  }

  async renderPinnedGoal(container, ctx, sav) {
    const goal = findPriorityGoal(ctx.savingsGoals || []);

    if (!goal) {
      const hint = container.createDiv({ cls: "budget-card budget-reloc-hint" });
      // Capped funds can't be pinned — they have a placement of their own.
      const goals = regularGoals(ctx.savingsGoals);
      if (goals.length) {
        // Goals exist, none is pinned. Say what to press rather than describing
        // a naming convention the user can't see.
        hint.createEl("p", {
          text: "No goal pinned. Press “Pin to dashboard” on any savings goal below to track it here.",
          cls: "budget-muted"
        });
        return;
      }
      hint.createEl("p", {
        text: "No savings goals yet. Create one and you can pin it here to keep it in front of you.",
        cls: "budget-muted"
      });
      const btn = hint.createEl("button", { text: "Create a savings goal", cls: "budget-btn mod-cta" });
      btn.onclick = () => {
        new SavingsGoalModal(this.app, async (g) => {
          g.id = genId("goal");
          g.contributions = [];
          // The first goal created from here is the one this card is for, so it
          // arrives pinned rather than needing a second press.
          g.pinned = true;
          const list = await readJSON(this.app, FILES.savingsGoals, []);
          list.forEach((x) => delete x.pinned);
          list.push(g);
          await writeJSON(this.app, FILES.savingsGoals, list);
          new Notice(`Created ${g.name} and pinned it here.`);
          this.render();
        }, { name: "", target_amount: "", saved_amount: "0", target_date: sav.deadline || "" }).open();
      };
      return;
    }

    const p = goalProgress(goal);
    const card = container.createDiv({ cls: "budget-card budget-pinned-goal" });

    const head = card.createDiv({ cls: "budget-goal-top" });
    const name = head.createDiv({ cls: "budget-goal-name" });
    name.createSpan({ text: goal.name });
    name.createSpan({ text: "pinned", cls: "budget-badge budget-badge-pinned" });
    head.createSpan({ text: `$${p.saved.toFixed(2)} / $${p.target.toFixed(2)}`, cls: "budget-amount" });

    const track = card.createDiv({ cls: "budget-progress-track budget-pinned-track" });
    const fill = track.createDiv({
      cls: `budget-progress-fill budget-pinned-fill${p.complete ? " budget-pinned-done" : ""}`
    });
    fill.style.width = `${p.pct.toFixed(1)}%`;

    const meta = card.createDiv({ cls: "budget-goal-meta" });
    if (p.complete) {
      meta.createSpan({ text: "Funded. Anything further is cushion." , cls: "budget-positive" });
    } else {
      const pace = goalPace(
        goal,
        todayLocal(),
        this.lastResult ? Math.max(daysBetween(this.lastResult.todayStr, this.lastResult.nextPaydayStr), 1) : 14,
        resolvePaySchedule(this.plugin.settings, ctx.allTx)
      );
      const bits = [`$${p.remaining.toFixed(2)} to go`];
      if (sav.deadline && !sav.past) {
        const paydays = paydaysBetween(
          resolvePaySchedule(this.plugin.settings, ctx.allTx),
          todayLocal(),
          sav.deadline
        );
        if (paydays && paydays.length) {
          bits.push(
            `${paydays.length} paycheck${paydays.length === 1 ? "" : "s"} before ${sav.deadline}`,
            `$${(p.remaining / paydays.length).toFixed(2)} each`
          );
        } else if (pace && pace.perPeriod) {
          bits.push(`about $${pace.perPeriod.toFixed(2)} per paycheck`);
        }
      }
      meta.createSpan({ text: bits.join(" \u00b7 ") });
    }

    const btns = card.createDiv({ cls: "budget-goal-btns" });
    // Unpin from the card itself, so undoing it doesn't mean hunting for the
    // goal further down the page.
    const unpin = btns.createEl("button", { text: "Unpin", cls: "budget-btn" });
    unpin.setAttr("title", "Stop showing this goal at the top of the Overview");
    unpin.onclick = async () => {
      await setPinnedGoal(this.app, null);
      new Notice(`Unpinned ${goal.name}.`);
      await this.plugin.refreshAfterDataChange();
    };
    const fund = btns.createEl("button", { text: "Add Funds", cls: "budget-btn mod-cta" });
    fund.onclick = () => {
      new AddFundsModal(this.app, goal, this.lastResult ? this.lastResult.freeCash : null, async (amount, note) => {
        const updated = await addGoalFunds(this.app, goal.id, amount, note);
        if (updated) {
          new Notice(`$${Math.abs(amount).toFixed(2)} into ${updated.name}.`);
          await this.plugin.refreshAfterDataChange();
        }
      }).open();
    };
    const edit = btns.createEl("button", { text: "Edit", cls: "budget-btn" });
    edit.onclick = () => {
      new SavingsGoalModal(
        this.app,
        async (patch) => {
          const list = await readJSON(this.app, FILES.savingsGoals, []);
          const i = list.findIndex((x) => x.id === goal.id);
          if (i >= 0) {
            list[i] = Object.assign({}, list[i], patch);
            await writeJSON(this.app, FILES.savingsGoals, list);
            this.render();
          }
        },
        goal
      ).open();
    };
  }

  // A loan's own lines under its terms: when it's paid off and what interest
  // is left, what an extra $50 a month would do, what it's worth against what's
  // owed, and where the balance comes from.
  renderLoanDetail(textCol, nameLine, loan) {
    const today = todayLocal();
    const st = loanState(loan, today);
    if (!st.started && loan.next_due_date && loan.next_due_date > today) {
      nameLine.createSpan({ text: `starts ${formatChartDate(loan.next_due_date)}`, cls: "budget-badge budget-badge-manual" });
    }
    const p = loanPayoff(loan, { todayStr: today });
    const month = (d) => {
      const [y, m] = String(d).split("-");
      return `${["Jan","Feb","Mar","Apr","May","Jun","Jul","Aug","Sep","Oct","Nov","Dec"][Number(m) - 1]} ${y}`;
    };
    if (p.never) {
      textCol.createDiv({ text: "The payment doesn't cover the interest, so this never gets paid off. Check the payment and APR.", cls: "budget-debt-meta budget-debt-stale" });
    } else if (!p.done) {
      textCol.createDiv({
        text: `${p.payments} payment${p.payments === 1 ? "" : "s"} left \u00b7 paid off ${month(p.payoffDate)} \u00b7 $${p.interest.toFixed(2)} interest to go`,
        cls: "budget-debt-meta"
      });
      const faster = loanExtraSavings(loan, 50, today);
      if (faster && faster.months > 0) {
        textCol.createDiv({
          text: `$50 more a month: paid off ${faster.months} month${faster.months === 1 ? "" : "s"} sooner, $${faster.interest.toFixed(2)} less interest`,
          cls: "budget-debt-meta budget-loan-extra"
        });
      }
    }
    // What it's worth and where the balance comes from share one quiet line.
    const equity = loanEquity(loan, today);
    const worth =
      equity != null
        ? `Worth ~$${Number(loan.estimated_value).toFixed(2)} \u00b7 ${equity >= 0 ? `$${equity.toFixed(2)} equity` : `$${Math.abs(equity).toFixed(2)} underwater`}`
        : "";
    const a = loan.balance_anchor || {};
    const since = st.paymentsCounted ? `, less ${st.paymentsCounted} payment${st.paymentsCounted === 1 ? "" : "s"} since` : "";
    const source =
      a.source === "simplefin"
        ? `Balance from SimpleFIN on ${formatShortDate(a.date)}${since}`
        : loan.simplefin_id
          ? "Linked to SimpleFIN \u2014 the lender's balance comes in at the next sync"
          : st.paymentsCounted
            ? `Balance from $${(Number(a.amount) || 0).toFixed(2)} on ${formatShortDate(a.date || loan.loan_date || today)}${since}`
            : `Balance as entered ${formatShortDate(a.date || loan.loan_date || today)}`;
    textCol.createDiv({
      text: [worth, source].filter(Boolean).join(" \u00b7 "),
      cls: `budget-debt-meta budget-debt-seam${equity != null && equity < 0 ? " budget-debt-stale" : ""}`
    });
  }

  async renderDebts(container, ctx) {
    const { allTx, revolvingDebts, installmentDebts, allDebts, categoryMetaList } = ctx;
    const accounts = ctx.accounts || [];
    // The render's single index. Without fixed expenses, goals and subscription
    // keys in it, this tab's Apply Payment list would still offer a transaction
    // already linked to a bill or a contribution — the exact cross-class leak
    // the ownership index exists to close.
    const ownership = ctx.ownership;
    // ---- Current debts + progress ----
    const debtCard = container.createDiv({ cls: "budget-card budget-debt-card" });
    const debtHead = debtCard.createDiv({ cls: "budget-debt-head" });
    debtHead.createEl("h4", { text: "Current debts" });
    const grandTotal = totalDebt(revolvingDebts, installmentDebts, allTx);
    debtHead.createSpan({ text: `$${grandTotal.toFixed(2)} total`, cls: "budget-debt-total" });
    const addLoan = debtHead.createEl("button", { text: "Add loan", cls: "budget-btn budget-debt-add" });
    addLoan.setAttr("title", "A car loan, mortgage, student or personal loan");
    addLoan.onclick = () => this.plugin.promptLoan();

    if (allDebts.length === 0) {
      debtCard.createEl("p", {
        text: "No debts tracked yet \u2014 add a loan here, or card terms and BNPL plans in Settings \u2192 Debts & plans.",
        cls: "budget-muted"
      });
    } else {
      const renderDebtRow = (debt, kind) => {
        // A card's balance is the anchor plus what has posted to it since. Both
        // halves get shown below, because the card and checking statements
        // import on different cadences and a single number hides which one is
        // behind.
        const cardState = kind === "cc" ? cardBalanceState(debt, allTx) : null;
        const bal = cardState ? cardState.balance : debtBalance(debt);
        const row = debtCard.createDiv({ cls: "budget-debt-row" });

        const textCol = row.createDiv({ cls: "budget-debt-text-col" });
        const nameLine = textCol.createDiv({ cls: "budget-debt-name" });
        nameLine.createSpan({ text: debtLabel(debt) });
        nameLine.createSpan({ text: kind === "cc" ? "credit card" : kind === "loan" ? LOAN_TYPES[loanType(debt)].label.toLowerCase() : "BNPL", cls: "budget-badge budget-badge-transfer" });
        const loanDetail = kind === "loan";
        if (debt.deferred_interest_risk && debt.deferred_interest_risk.applies) {
          nameLine.createSpan({
            text: `0% until ${debt.deferred_interest_risk.payoff_deadline}`,
            cls: "budget-badge budget-badge-warn"
          });
        }

        const bits = [];
        if ((kind === "cc" || kind === "loan") && debt.apr) bits.push(`${debt.apr}% APR`);
        if (kind === "loan") {
          const started = (debt.applied_payments || []).length > 0;
          const next = loanSchedule(debt).nextDue || debt.next_due_date;
          bits.push(`$${(debt.installment_amount || 0).toFixed(2)}/mo`);
          // Before the first payment, the "starts" badge says when. After, a due
          // date already past is a payment not applied yet.
          const soon = !started && next && next > todayLocal();
          if (next && !soon) bits.push(!started || next < todayLocal() ? `${formatChartDate(next)} payment not applied` : `next ${formatChartDate(next)}`);
        }
        if (kind === "bnpl") {
          const left = remainingInstallments(debt);
          bits.push(`${left} \u00d7 $${(debt.installment_amount || 0).toFixed(2)} left`);
          if (debt.next_due_date) bits.push(`next ${formatShortDate(debt.next_due_date)}`);
        }
        const applied = (debt.applied_payments || []).length;
        if (applied && kind !== "loan") bits.push(`${applied} payment${applied === 1 ? "" : "s"} applied`);
        textCol.createDiv({ text: bits.join(" \u00b7 "), cls: "budget-debt-meta" });
        if (loanDetail) this.renderLoanDetail(textCol, nameLine, debt);

        if (cardState) {
          // One quiet line: where the balance started, what has posted since,
          // and how recent the import is. The anchor and the ledger can be days
          // apart, and saying so beats a figure that silently stops at the last
          // import.
          const parts = [`from $${cardState.anchor.toFixed(2)}${cardState.since ? ` on ${formatShortDate(cardState.since)}` : ""}`];
          if (cardState.derived) {
            if (cardState.chargeCount) {
              parts.push(`+$${cardState.charges.toFixed(2)} in ${cardState.chargeCount} charge${cardState.chargeCount === 1 ? "" : "s"}`);
            }
            if (cardState.paymentCount) {
              parts.push(`\u2212$${cardState.payments.toFixed(2)} in ${cardState.paymentCount} payment${cardState.paymentCount === 1 ? "" : "s"}`);
            }
          } else {
            parts.push("nothing posted since");
          }
          const acct = accounts.find((a) => a.id === debt.account_id);
          const through = acct && acct.last_imported_through;
          let behind = 0;
          if (through) {
            behind = daysBetween(through, todayLocal());
            parts.push(
              behind > 0
                ? `imported through ${formatShortDate(through)} (${behind} day${behind === 1 ? "" : "s"} behind)`
                : `imported through ${formatShortDate(through)}`
            );
          }
          textCol.createDiv({
            text: parts.join(" \u00b7 "),
            cls: `budget-debt-meta budget-debt-seam${behind > 3 ? " budget-debt-stale" : ""}`
          });
        }

        const amtCol = row.createDiv({ cls: "budget-debt-amt-col" });
        amtCol.createSpan({ text: `$${bal.toFixed(2)}`, cls: "budget-amount" });

        const pending = candidatePayments(debt, allTx, allDebts, categoryMetaList, ownership);
        const btnCol = row.createDiv({ cls: "budget-debt-btn-col" });

        const applyBtn = btnCol.createEl("button", {
          text: pending.length ? `Apply payment (${pending.length})` : "Apply payment",
          cls: pending.length ? "budget-btn mod-cta" : "budget-btn"
        });
        applyBtn.onclick = () => {
          new ApplyPaymentModal(this.app, debt, pending, async (picked, opts = {}) => {
            const file = kind === "cc" ? FILES.revolvingDebts : FILES.installmentDebts;
            const list = await readJSON(this.app, file, []);
            const idx = list.findIndex((d) => debtKey(d) === debtKey(debt));
            if (idx < 0) return;
            list[idx].applied_payments = (list[idx].applied_payments || []).concat(
              picked.map((p) => Object.assign({ tx_id: p.id, amount: Math.abs(p.amount), date: p.date, applied_on: todayLocal() }, opts.extra ? { extra: true } : {}))
            );

            // Once an installment is covered, roll the due date forward. Without
            // this the Overview has to infer "is it still due?" from payment
            // dates, which disagrees with the Debts tab the moment a payment was
            // made outside the current pay period — e.g. prepaying before import.
            const advanced = advanceDueDateIfCovered(list[idx], kind);

            await writeJSON(this.app, file, list);
            const sum = picked.reduce((s, p) => s + Math.abs(p.amount), 0);
            new Notice(
              `Applied $${sum.toFixed(2)} to ${debtLabel(debt)}.` +
                (advanced ? ` Installment covered — next due ${advanced}.` : ""),
              9000
            );
            await this.plugin.snapshotDebt();
            await this.plugin.refreshAfterDataChange();
          }, ctx.rules, categoryMetaList, async () => {
            // The debt row captured its candidate list when it rendered. Refresh
            // after a review decision so reopening Apply Payment cannot reuse a
            // stale list that still contains the transaction we just dismissed.
            await this.plugin.refreshAfterDataChange();
          }, allTx).open();
        };

        // Everything that changes the debt itself sits behind one Edit menu, so
        // a row shows its balance and the one thing you do most: apply a payment.
        const deleteDebt = () => {
          new ConfirmModal(this.app, {
            title: `Delete “${debtLabel(debt)}”?`,
            body: [
              `Removes the debt, its $${bal.toFixed(2)} balance and its applied-payment history.`,
              "Transactions stay put — only the debt record goes. Use this when something is paid off or was added by mistake."
            ],
            onConfirm: async () => {
              const file = kind === "cc" ? FILES.revolvingDebts : FILES.installmentDebts;
              const list = await readJSON(this.app, file, []);
              await writeJSON(this.app, file, list.filter((d) => debtKey(d) !== debtKey(debt)));
              new Notice(`Deleted ${debtLabel(debt)}.`);
              await this.plugin.snapshotDebt();
              await this.plugin.refreshAfterDataChange();
            }
          }).open();
        };

        const editBalance = () => {
          new EditBalanceModal(this.app, debt, async (newBalance) => {
            const file = kind === "cc" ? FILES.revolvingDebts : FILES.installmentDebts;
            const list = await readJSON(this.app, file, []);
            const idx = list.findIndex((d) => debtKey(d) === debtKey(debt));
            if (idx < 0) return;
            const today = todayLocal();
            list[idx].balance_anchor = { amount: newBalance, date: today };
            if (kind === "cc") {
              // Keep the payment ledger: for a card it credits the cycle
              // minimum rather than the balance, and clearing it would make an
              // already-paid minimum look due again.
            } else {
              list[idx].applied_payments = [];
              if (list[idx].installment_amount > 0) {
                list[idx].remaining_installments = Math.ceil(newBalance / list[idx].installment_amount);
              }
            }
            await writeJSON(this.app, file, list);
            if (kind === "cc") await reanchorCardBalance(this.app, list[idx].account_id, newBalance);
            new Notice(`${debtLabel(debt)} balance set to $${newBalance.toFixed(2)}.`);
            await this.plugin.snapshotDebt();
            await this.plugin.refreshAfterDataChange();
          }, allTx).open();
        };

        const entries =
          kind === "loan"
            ? [
                { title: "Edit loan", run: () => this.plugin.promptLoan(debt) },
                { title: "Close loan\u2026", run: () => this.plugin.promptCloseLoan(debt), hint: "Sold, traded in, refinanced or paid off" }
              ]
            : [
                ...(kind === "bnpl" ? [{ title: "Edit plan", run: () => this.plugin.promptEditBNPL(debt) }] : []),
                { title: kind === "bnpl" ? "Set balance" : "Edit balance", run: editBalance },
                { separator: true },
                { title: "Delete\u2026", run: deleteDebt, warn: true }
              ];
        const editMenuBtn = btnCol.createEl("button", { text: "Edit", cls: "budget-btn budget-btn-menu" });
        editMenuBtn.setAttr("aria-haspopup", "menu");
        editMenuBtn.setAttr("title", entries.filter((e) => e.title).map((e) => e.title.replace("\u2026", "")).join(" · "));
        editMenuBtn.onclick = (evt) => {
          const menu = new Menu();
          entries.forEach((e) => {
            if (e.separator) {
              menu.addSeparator();
              return;
            }
            menu.addItem((item) => {
              item.setTitle(e.title);
              if (e.warn && typeof item.setWarning === "function") item.setWarning(true);
              item.onClick(e.run);
            });
          });
          const rect = typeof editMenuBtn.getBoundingClientRect === "function" ? editMenuBtn.getBoundingClientRect() : null;
          if (rect) menu.showAtPosition({ x: rect.left, y: rect.bottom });
          else menu.showAtMouseEvent(evt);
        };
      };

      revolvingDebts.forEach((d) => renderDebtRow(d, "cc"));
      installmentDebts.forEach((d) => renderDebtRow(d, isLoan(d) ? "loan" : "bnpl"));
    }

    // Loans that have ended, with how, and a way back for one closed by mistake.
    const closedLoans = await readJSON(this.app, FILES.closedLoans, []);
    if (closedLoans.length) {
      const box = this.collapsible(debtCard, "closed-loans", "Closed loans", String(closedLoans.length), false);
      closedLoans
        .slice()
        .sort((a, b) => ((a.closed && a.closed.date) < (b.closed && b.closed.date) ? 1 : -1))
        .forEach((rec) => {
          const row = box.createDiv({ cls: "budget-debt-row budget-loan-closed" });
          const text = row.createDiv({ cls: "budget-debt-text-col" });
          text.createDiv({ text: debtLabel(rec), cls: "budget-debt-name" });
          text.createDiv({ text: closedLoanSummary(rec), cls: "budget-debt-meta" });
          const btn = row.createDiv({ cls: "budget-debt-btn-col" }).createEl("button", { text: "Reopen", cls: "budget-btn" });
          btn.setAttr("title", "Closed by mistake? Put it back as it was");
          btn.onclick = async () => {
            const back = await this.plugin.reopenLoan(rec.id);
            if (back) new Notice(`${debtLabel(back)} is open again.`);
            await this.plugin.snapshotDebt();
            await this.plugin.refreshAfterDataChange();
          };
        });
    }

    // ---- Total debt progress ----
    const history = await readJSON(this.app, FILES.debtHistory, []);
    if (history.length > 0) {
      const progressCard = container.createDiv({ cls: "budget-card budget-progress-card" });
      progressCard.createEl("h4", { text: "Total debt progress" });

      const projection = projectPayoff(grandTotal, this.lastResult);
      // Two views of the same history. The payoff view runs the line out to
      // debt-free, which squeezes the weeks you have actually lived into a
      // sliver; progress shows just those, scaled to fit.
      const view = projection && this.debtChartView === "payoff" ? "payoff" : "progress";
      if (projection) {
        const toggle = progressCard.createDiv({ cls: "budget-segmented budget-debt-chart-toggle" });
        [["progress", "Progress"], ["payoff", "Payoff"]].forEach(([key, label]) => {
          const b = toggle.createEl("button", { text: label, cls: `budget-segment${view === key ? " budget-segment-on" : ""}` });
          b.setAttr("title", key === "progress" ? "Where your balance has gone so far" : "The line out to debt-free");
          b.onclick = () => {
            if (view === key) return;
            this.debtChartView = key;
            this.render();
          };
        });
      }
      const svg = view === "payoff" ? buildDebtChart(history, projection) : buildDebtChart(history, null, { zoom: true });
      if (svg) {
        const chartWrap = progressCard.createDiv({ cls: "budget-chart-wrap budget-debt-chart-wrap" });
        setSvgContent(chartWrap, svg);
        enableChartHover(chartWrap);
      }

      if (history.length === 1) {
        progressCard.createEl("p", {
          text: "Only one data point so far \u2014 the line fills in as balances change over time.",
          cls: "budget-muted"
        });
      } else if (view === "progress") {
        const first = history[0];
        const last = history[history.length - 1];
        const change = round2(first.total_debt - last.total_debt);
        progressCard.createEl("p", {
          text:
            change > 0.005
              ? `Down $${change.toFixed(2)} since ${formatShortDate(first.date)}, from $${first.total_debt.toFixed(2)} to $${last.total_debt.toFixed(2)}.`
              : change < -0.005
                ? `Up $${Math.abs(change).toFixed(2)} since ${formatShortDate(first.date)}, from $${first.total_debt.toFixed(2)} to $${last.total_debt.toFixed(2)}.`
                : `No change since ${formatShortDate(first.date)}.`,
          cls: "budget-muted"
        });
      }
      if (projection) {
        const months = Math.round(projection.daysToZero / 30.4);
        progressCard.createEl("p", {
          text:
            `At this period's pace ($${projection.perPeriod.toFixed(2)} per period), debt-free around ${projection.zeroDate} \u2014 roughly ${months} month${months === 1 ? "" : "s"}.` +
            (view === "payoff" ? " Dotted line shows that projection." : ""),
          cls: "budget-muted"
        });
      } else if (grandTotal > 0) {
        progressCard.createEl("p", {
          text: "Run \u2018Enter Paycheck\u2019 to see a projected payoff date based on your current paydown rate.",
          cls: "budget-muted"
        });
      }
    }

  }

  // Inbox zero. When something needs a label, a notification sits under the tabs
  // and opens a panel of just those transactions; when nothing does, neither is
  // drawn at all — no "all clear" card taking up the top of the screen. Recent
  // transactions is the tab's main content, full width, underneath.
  async renderTransactions(container, ctx) {
    // Possible transfers are asked about first, and their halves aren't also
    // asked for a label: say it's a transfer and neither needs one.
    const transfers = transferCandidates(ctx.allTx, ctx.accounts);
    const inReview = new Set(transfers.flatMap((c) => [c.out.id, c.in.id]));
    if (transfers.length) this.renderTransferInbox(container, transfers, ctx);
    else this.transferInboxOpen = false;

    const uncategorized = ctx.allTx.filter((t) => t.resolved_category === "Uncategorized" && !inReview.has(t.id));

    if (uncategorized.length) {
      this.renderLabelInbox(container, uncategorized, ctx);
    } else {
      // The next batch — after an import, say — should arrive as a closed
      // notification, not already expanded because the last one was.
      this.inboxOpen = false;
    }

    this.renderRecentTransactions(container, ctx);
  }

  // The badge and the panel it opens. The panel sits in the page flow, so
  // opening it pushes Recent transactions down instead of floating over them.
  //
  // Labelling re-renders the whole view, so whether the panel is open is kept
  // on the view: clearing a queue one transaction at a time shouldn't mean
  // reopening it after every label. A panel drawn already open doesn't replay
  // the slide — CSS only animates a change, not an element's first paint. And
  // once the last one is labelled, the next render simply doesn't draw either.
  renderLabelInbox(container, uncategorized, ctx) {
    const { allTx, rules, existingLabels } = ctx;
    const n = uncategorized.length;
    // Per view, since the dashboard can be open in two panes at once.
    if (!this.inboxId) this.inboxId = `budget-inbox-${Math.random().toString(36).slice(2, 8)}`;

    const inbox = container.createDiv({ cls: "budget-inbox" });
    const badge = inbox.createEl("button", {
      cls: "budget-inbox-badge",
      attr: { type: "button", "aria-controls": this.inboxId }
    });
    badge.createSpan({ text: "!", cls: "budget-inbox-dot", attr: { "aria-hidden": "true" } });
    badge.createSpan({
      text: n === 1 ? "1 transaction needs a label" : `${n} transactions need labels`,
      cls: "budget-inbox-text"
    });
    const action = badge.createSpan({ cls: "budget-inbox-action" });
    badge.createSpan({ cls: "budget-inbox-chevron", attr: { "aria-hidden": "true" } });

    const panel = inbox.createDiv({
      cls: "budget-inbox-panel",
      attr: { id: this.inboxId, role: "region", "aria-label": "Transactions that need labels" }
    });
    const inner = panel.createDiv({ cls: "budget-inbox-panel-inner" });
    const list = inner.createDiv({ cls: "budget-card budget-inbox-list" });

    // Newest first, like any inbox.
    const queue = uncategorized
      .slice()
      .sort((a, b) => (a.date < b.date ? 1 : a.date > b.date ? -1 : 0));
    const shown = queue.slice(0, isMobileApp() ? 10 : 20);
    shown.forEach((t) => {
      const row = list.createDiv({ cls: "budget-recent-row budget-inbox-row" });
      const main = row.createDiv({ cls: "budget-recent-main" });
      main.createSpan({ text: displayMerchant(t.merchant_raw, rules), cls: "budget-recent-name" }).setAttr("title", t.merchant_raw);
      main.createSpan({ text: t.date || "pending", cls: "budget-recent-date" });

      const meta = row.createDiv({ cls: "budget-recent-meta" });
      const isIncome = t.amount > 0;
      meta.createSpan({
        text: isIncome ? `+$${t.amount.toFixed(2)}` : `-$${Math.abs(t.amount).toFixed(2)}`,
        cls: isIncome ? "budget-positive budget-tx-amount" : "budget-negative budget-tx-amount"
      });
      const btn = meta.createEl("button", { text: "Label", cls: "budget-btn mod-cta budget-inbox-label-btn" });
      btn.onclick = () => this.openLabelModal(t, existingLabels, ctx);
    });
    if (n > shown.length) {
      list.createEl("p", {
        text: `${n - shown.length} more after these \u2014 they move up as you label.`,
        cls: "budget-muted budget-inbox-more"
      });
    }

    bindInboxToggle({ inbox, badge, action }, { open: !!this.inboxOpen, onChange: (open) => (this.inboxOpen = open) });
  }

  // The tab's main content: the latest transactions, full width, each with its
  // category and a way to change it.
  // Pairs that look like money moved between your own accounts, for you to
  // confirm. Same badge-and-panel as the label inbox. Each shows both halves;
  // Transfer files both and takes them off the list, Not a transfer stops the
  // pair being suggested. Pairs whose descriptions both read like a transfer
  // can be confirmed together, since a shop's charge never reads like one.
  renderTransferInbox(container, candidates, ctx) {
    const { rules } = ctx;
    const n = candidates.length;
    if (!this.transferInboxId) this.transferInboxId = `budget-transfer-inbox-${Math.random().toString(36).slice(2, 8)}`;
    const inbox = container.createDiv({ cls: "budget-inbox budget-transfer-inbox" });
    const badge = inbox.createEl("button", { cls: "budget-inbox-badge", attr: { type: "button", "aria-controls": this.transferInboxId } });
    badge.createSpan({ text: "!", cls: "budget-inbox-dot", attr: { "aria-hidden": "true" } });
    badge.createSpan({ text: n === 1 ? "1 possible transfer to review" : `${n} possible transfers to review`, cls: "budget-inbox-text" });
    const action = badge.createSpan({ cls: "budget-inbox-action" });
    badge.createSpan({ cls: "budget-inbox-chevron", attr: { "aria-hidden": "true" } });
    const panel = inbox.createDiv({ cls: "budget-inbox-panel", attr: { id: this.transferInboxId, role: "region", "aria-label": "Possible transfers between your accounts" } });
    const list = panel.createDiv({ cls: "budget-inbox-panel-inner" }).createDiv({ cls: "budget-card budget-inbox-list" });
    list.createEl("p", {
      text: "Same amount out of one account and into another. Confirm the ones that are you moving your own money; a purchase that happens to match isn't.",
      cls: "budget-muted budget-transfer-intro"
    });
    const likely = candidates.filter((c) => c.likely);
    if (likely.length > 1) {
      const all = list.createEl("button", { text: `Confirm all ${likely.length} that read like transfers`, cls: "budget-btn budget-transfer-all" });
      all.onclick = async () => {
        const done = await this.plugin.confirmTransfers(likely.map((c) => ({ outId: c.out.id, inId: c.in.id })));
        new Notice(`Filed ${done} transfer${done === 1 ? "" : "s"} and took ${done === 1 ? "it" : "them"} off the list.`);
        await this.plugin.refreshAfterDataChange();
      };
    }
    const accountName = (id) => {
      const a = (ctx.accounts || []).find((x) => x && x.id === id);
      return a ? accountLabel(a) : id;
    };
    const shown = candidates.slice(0, isMobileApp() ? 10 : 20);
    shown.forEach((c) => {
      const row = list.createDiv({ cls: "budget-transfer-pair" });
      [c.out, c.in].forEach((t) => {
        const half = row.createDiv({ cls: "budget-recent-row budget-transfer-half" });
        const main = half.createDiv({ cls: "budget-recent-main" });
        main.createSpan({ text: displayMerchant(t.merchant_raw, rules), cls: "budget-recent-name" }).setAttr("title", t.merchant_raw || "");
        main.createSpan({ text: `${t.date} \u00b7 ${accountName(t.account_id)}`, cls: "budget-recent-date" });
        const into = t.amount > 0;
        half.createDiv({ cls: "budget-recent-meta" }).createSpan({
          text: into ? `+$${t.amount.toFixed(2)}` : `-$${Math.abs(t.amount).toFixed(2)}`,
          cls: into ? "budget-positive budget-tx-amount" : "budget-negative budget-tx-amount"
        });
      });
      const btns = row.createDiv({ cls: "budget-goal-btns budget-transfer-btns" });
      const yes = btns.createEl("button", { text: "Transfer", cls: "budget-btn mod-cta" });
      yes.setAttr("title", "Both are you moving your own money: file them as a transfer and take them off the list");
      yes.onclick = async () => {
        await this.plugin.confirmTransfers([{ outId: c.out.id, inId: c.in.id }]);
        new Notice("Filed as a transfer and taken off the list.");
        await this.plugin.refreshAfterDataChange();
      };
      const no = btns.createEl("button", { text: "Not a transfer", cls: "budget-btn" });
      no.setAttr("title", "They just happen to match; don't suggest these two again");
      no.onclick = async () => {
        await this.plugin.dismissTransferPair(c.out.id, c.in.id);
        await this.plugin.refreshAfterDataChange();
      };
    });
    if (n > shown.length) list.createEl("p", { text: `${n - shown.length} more after these.`, cls: "budget-muted budget-inbox-more" });
    bindInboxToggle({ inbox, badge, action }, { open: !!this.transferInboxOpen, onChange: (open) => (this.transferInboxOpen = open) });
  }

  renderRecentTransactions(container, ctx) {
    const { allTx, rules } = ctx;
    const recentOuter = container.createDiv({ cls: "budget-card budget-recent-card" });
    // Confirmed transfers between your own accounts are kept off the list;
    // Show brings them back, each with a way to undo it.
    const txById = new Map(allTx.filter((t) => t && t.id).map((t) => [t.id, t]));
    const newestFirst = [...allTx].sort((a, b) => (a.date < b.date ? 1 : a.date > b.date ? -1 : 0));
    const limit = isMobileApp() ? 8 : 15;
    const visible = newestFirst.filter((t) => !isHiddenTransfer(t, txById));
    const recent = (this.showTransfers ? newestFirst : visible).slice(0, limit);
    // The hidden ones that would have been on this list: all of them when it
    // isn't full, otherwise those as new as the oldest row it shows.
    const oldestVisible = visible.length >= limit ? visible[limit - 1].date : null;
    const hiddenHere = newestFirst.filter((t) => isHiddenTransfer(t, txById) && (!oldestVisible || t.date >= oldestVisible)).length;
    const recentCard = this.collapsible(
      recentOuter,
      "recent-tx",
      "Recent transactions",
      `${recent.length} shown`,
      true
    );
    const addTx = recentCard.createDiv({ cls: "budget-goal-btns budget-add-tx" }).createEl("button", { text: "Add transaction", cls: "budget-btn" });
    addTx.onclick = () => this.plugin.promptAddTransaction();
    if (recent.length === 0 && !hiddenHere) {
      recentCard.createEl("p", { text: "Nothing yet.", cls: "budget-muted" });
      return;
    }
    const allLabels = [...new Set(rules.map((r) => r.home_label).concat(allTx.map((t) => t.resolved_category).filter(Boolean)))]
      .filter((l) => l !== "Uncategorized")
      .sort();
    recent.forEach((t) => {
      const row = recentCard.createDiv({ cls: "budget-recent-row" });

      const main = row.createDiv({ cls: "budget-recent-main" });
      const nameEl = main.createSpan({ text: displayMerchant(t.merchant_raw, rules), cls: "budget-recent-name" });
      nameEl.setAttr("title", t.merchant_raw);
      main.createSpan({ text: t.date, cls: "budget-recent-date" });

      const meta = row.createDiv({ cls: "budget-recent-meta" });
      const cat = t.resolved_category || "Uncategorized";
      const badge = meta.createSpan({
        text: cat,
        cls: `budget-badge${cat === "Uncategorized" ? " budget-badge-empty" : ""}${t.override_label ? " budget-badge-override" : ""}`
      });
      if (t.override_label) badge.setAttr("title", "One-off override \u2014 not from a merchant rule");

      const isIncome = t.amount > 0;
      meta.createSpan({
        text: isIncome ? `+$${t.amount.toFixed(2)}` : `-$${Math.abs(t.amount).toFixed(2)}`,
        cls: isIncome ? "budget-positive budget-tx-amount" : "budget-negative budget-tx-amount"
      });

      if (isHiddenTransfer(t, txById)) {
        row.addClass("budget-recent-transfer");
        const undo = meta.createEl("button", { text: "Not a transfer", cls: "budget-btn" });
        undo.setAttr("title", "Put it back on the list, labelled as it was");
        undo.onclick = async () => {
          await this.plugin.undoTransferRow(t.id);
          new Notice("Back on the list.");
          await this.plugin.refreshAfterDataChange();
        };
        return;
      }
      const changeBtn = meta.createEl("button", { text: "Change", cls: "budget-btn" });
      changeBtn.onclick = () => this.openLabelModal(t, allLabels, ctx);
    });
    if (hiddenHere) {
      const foot = recentCard.createDiv({ cls: "budget-recent-hidden" });
      foot.createSpan({
        text: this.showTransfers
          ? `Showing ${hiddenHere} transfer${hiddenHere === 1 ? "" : "s"} between your accounts.`
          : `${hiddenHere} transfer${hiddenHere === 1 ? "" : "s"} between your accounts hidden.`,
        cls: "budget-muted"
      });
      const toggle = foot.createEl("button", { text: this.showTransfers ? "Hide" : "Show", cls: "budget-basis-btn" });
      toggle.onclick = () => {
        this.showTransfers = !this.showTransfers;
        this.render();
      };
    }
  }

  // The label window, with "It's a transfer between my accounts" as one of
  // its answers.
  openLabelModal(t, labels, ctx) {
    const { allTx, rules } = ctx;
    const hit = findMatchingRule(t.merchant_raw, rules);
    new LabelModal(
      this.app,
      t.merchant_raw,
      t.amount,
      labels,
      (payload) => this.handleLabelSubmit(t, payload, hit ? hit.rule : null),
      hit ? hit.rule : null,
      {
        transactions: allTx,
        rules,
        onTransfer: async () => {
          const cat = await this.plugin.markTransfer(t.id);
          if (cat) new Notice(`Filed as ${cat} and taken off the list. If its other half turns up, you'll be asked to confirm the pair.`, 7000);
          await this.plugin.refreshAfterDataChange();
        }
      }
    ).open();
  }

  // Long-term / invested assets. Deliberately read-only and entirely separate
  // from the pay-period engine: nothing here feeds cash on hand, committed,
  // free cash, the buffer, savings or debt.
  async renderPortfolio(container) {
    const snapshots = await readJSON(this.app, FILES.portfolioSnapshots, []);
    const accounts = await this.plugin.loadPortfolioAccounts();

    const latestFor = (id) =>
      snapshots
        .filter((s) => s.account_id === id)
        .sort((a, b) => (a.statement_end < b.statement_end ? -1 : 1))
        .slice(-1)[0] || null;

    const latest = accounts.map((a) => ({ account: a, snap: latestFor(a.id) }));
    const funded = latest.filter((x) => x.snap && Number.isFinite(x.snap.ending_value));
    const total = round2(funded.reduce((s, x) => s + x.snap.ending_value, 0));

    // Deliberately styled unlike the cash hero: this is money you cannot spend,
    // and it should never read as part of the pay-period numbers.
    const panel = container.createDiv({ cls: "budget-pf-hero" });

    const main = panel.createDiv({ cls: "budget-pf-hero-main" });
    const labelRow = main.createDiv({ cls: "budget-pf-hero-label" });
    labelRow.createSpan({ text: "Long-term invested assets" });
    labelRow.createSpan({ text: "not spendable", cls: "budget-badge budget-pf-badge" });
    main.createDiv({ text: `$${total.toFixed(2)}`, cls: "budget-pf-hero-value" });
    main.createDiv({
      text: funded.length
        ? `Across ${funded.length} account${funded.length === 1 ? "" : "s"}, latest statements`
        : accounts.length
          ? "No statements imported yet"
          : "No investment accounts yet",
      cls: "budget-pf-hero-sub"
    });

    // Split bar showing each account's share of the total.
    if (total > 0) {
      const split = main.createDiv({ cls: "budget-pf-split" });
      funded.forEach((x, i) => {
        const pct = Math.max(0, (x.snap.ending_value / total) * 100);
        const seg = split.createDiv({ cls: "budget-pf-split-seg" });
        seg.style.width = `${pct.toFixed(2)}%`;
        seg.style.backgroundColor = PIE_COLORS[i % PIE_COLORS.length];
        seg.setAttr("title", `${x.account.label}: $${round2(x.snap.ending_value).toFixed(2)} (${pct.toFixed(0)}%)`);
      });

      const legend = main.createDiv({ cls: "budget-pf-legend" });
      funded.forEach((x, i) => {
        const item = legend.createDiv({ cls: "budget-pf-legend-item" });
        item.createSpan({ cls: "budget-pf-legend-dot" }).style.backgroundColor =
          PIE_COLORS[i % PIE_COLORS.length];
        item.createSpan({ text: x.account.label, cls: "budget-pf-legend-name" });
        item.createSpan({
          text: `$${round2(x.snap.ending_value).toFixed(2)}`,
          cls: "budget-pf-legend-value"
        });
      });
    }

    const side = panel.createDiv({ cls: "budget-pf-hero-side" });
    const importBtn = side.createEl("button", { text: "Import statement", cls: "budget-pf-import mod-cta" });
    importBtn.onclick = () => this.plugin.promptPortfolioImport();
    side.createDiv({
      text: "Paste a retirement, HSA or brokerage statement",
      cls: "budget-pf-hero-sub"
    });
    const addBtn = side.createEl("button", { text: "Add account", cls: "budget-btn budget-pf-add" });
    addBtn.onclick = () => this.plugin.promptPortfolioAccount(null, null);
    if (accounts.length) {
      const balBtn = side.createEl("button", { text: "Add balance", cls: "budget-btn budget-pf-add" });
      balBtn.setAttr("title", "Type in what an account is worth, without a statement");
      balBtn.onclick = () => this.plugin.promptAddInvestmentBalance();
    }

    // Reminders derive purely from stored snapshot coverage.
    const due = portfolioReminders(snapshots, accounts);
    due.forEach((r) => {
      const warn = container.createDiv({ cls: "budget-warning-soft budget-portfolio-reminder" });
      warn.createSpan({ text: portfolioReminderText(r) });
      const b = warn.createEl("button", { text: "Import", cls: "budget-btn mod-cta" });
      b.onclick = () => this.plugin.promptPortfolioImport();
    });

    if (!accounts.length) {
      container.createDiv({ cls: "budget-card" }).createEl("p", {
        text:
          "Import a statement and the account is set up from it, or add one first. Any company's statement " +
          "works; Fidelity, Vanguard, Empower and Schwab are recognised on sight.",
        cls: "budget-muted"
      });
      return;
    }

    const grid = container.createDiv({ cls: "budget-grid" });

    latest.forEach(({ account, snap }) => {
      const cadence = pfCadence(account);
      const card = grid.createDiv({ cls: "budget-card budget-portfolio-card" });
      const ch = card.createDiv({ cls: "budget-sub-head" });
      ch.createEl("h4", { text: account.label });
      const kind = [account.provider, PF_TYPES[account.type], cadence === "quarterly" ? "quarterly" : null]
        .filter(Boolean)
        .join(" · ");

      if (!snap) {
        ch.createSpan({ text: "no statements yet", cls: "budget-muted" });
        if (kind) card.createDiv({ text: kind, cls: "budget-muted budget-pf-kind" });
        card.createEl("p", {
          text: "Import a statement to start tracking this account.",
          cls: "budget-muted"
        });
        return;
      }

      const missing = due.find((r) => r.account.id === account.id);
      ch.createSpan({
        text: missing ? `${pfPeriodName(missing.monthKey, cadence)} statement missing` : `Updated through ${snap.statement_end}`,
        cls: `budget-muted${missing ? " budget-negative" : ""}`
      });
      if (kind) card.createDiv({ text: kind, cls: "budget-muted budget-pf-kind" });

      card.createDiv({ text: `$${round2(snap.ending_value).toFixed(2)}`, cls: "budget-portfolio-value" });
      card.createDiv({
        text: `Ending value · statement ${snap.statement_start} to ${snap.statement_end}`,
        cls: "budget-muted"
      });

      const rows = card.createEl("ul", { cls: "budget-list" });
      PF_FIELDS.forEach((f) => {
        if (f.key === "ending_value" || snap[f.key] == null || !Number.isFinite(snap[f.key])) return;
        const li = rows.createEl("li", { text: f.label });
        li.createSpan({ text: pfFormatField(f, snap[f.key]), cls: "budget-amount" });
      });

      if (snap.allocation) {
        card.createEl("h5", { text: "Allocation", cls: "budget-portfolio-sub" });
        const a = snap.allocation;
        const bar = card.createDiv({ cls: "budget-ribbon" });
        [
          ["Stocks", a.stocks_pct, PIE_COLORS[0]],
          ["Bonds", a.bonds_pct, PIE_COLORS[1]],
          ["Short-term/other", a.short_term_other_pct, PIE_COLORS[2]]
        ].forEach(([name, pct, color]) => {
          if (!pct) return;
          const seg = bar.createDiv({ cls: "budget-ribbon-seg" });
          seg.style.backgroundColor = color;
          seg.style.width = `${pct}%`;
          seg.setAttr("title", `${name}: ${pct}%`);
        });
        card.createDiv({
          text: `${a.stocks_pct}% stocks · ${a.bonds_pct}% bonds · ${a.short_term_other_pct}% short-term/other`,
          cls: "budget-muted"
        });
      }

      if (snap.holdings && snap.holdings.length) {
        const body = this.collapsible(card, `pf-holdings-${account.id}`, "Holdings", `${snap.holdings.length}`, false);
        snap.holdings.forEach((h) => {
          const r2 = body.createDiv({ cls: "budget-fixed-row" });
          r2.createSpan({ text: h.name, cls: "budget-fixed-name" });
          // A statement with several funds rarely breaks the ending value down
          // per fund, and inventing that split would be worse than not showing
          // it — so the parser leaves market_value unset and this says so
          // plainly rather than rendering $NaN.
          if (Number.isFinite(h.market_value)) {
            r2.createSpan({ text: `$${round2(h.market_value).toFixed(2)}`, cls: "budget-amount" });
          } else {
            r2.createSpan({ text: "value unavailable", cls: "budget-muted" });
          }
        });
      }
    });

    // What everything was worth, month by month. Each account carries its
    // latest statement forward, so a quarterly account doesn't drop out of the
    // total in the months between its statements.
    const history = portfolioHistory(snapshots, accounts);
    if (history.length >= 2) {
      const chart = container.createDiv({ cls: "budget-card" });
      chart.createEl("h4", { text: "Value over time" });
      const svg = buildPortfolioChart(history);
      if (svg) {
        // Same wrapper as the debt chart: it positions the readout.
        const wrap = chart.createDiv({ cls: "budget-chart-wrap budget-debt-chart-wrap" });
        setSvgContent(wrap, svg);
        enableChartHover(wrap);
      }
      chart.createEl("p", {
        text:
          "Combined value at the end of each month, from each account's latest statement. Informational only — " +
          "these balances never affect budgeting, free cash or debt recommendations.",
        cls: "budget-muted"
      });
    } else if (funded.length) {
      container.createDiv({ cls: "budget-card" }).createEl("p", {
        text: "Import another month's statement to see a trend.",
        cls: "budget-muted"
      });
    }
  }

  async renderInsights(container, ctx) {
    const { allTx, categoryMetaList } = ctx;

    const currentKey = todayLocal().slice(0, 7);
    const months = availableMonths(allTx, currentKey);
    if (months.length === 0) {
      container.createDiv({ cls: "budget-card" }).createEl("p", {
        text: "No transactions imported yet \u2014 import a bank export to see monthly insights.",
        cls: "budget-muted"
      });
      return;
    }

    const selected =
      this.insightsMonth && months.some((m) => m.key === this.insightsMonth)
        ? this.insightsMonth
        : months.some((m) => m.key === currentKey)
          ? currentKey
          : months[0].key;

    // ---- Target vs actual ----
    const targetCard = container.createDiv({ cls: "budget-card" });
    const head = targetCard.createDiv({ cls: "budget-sub-head" });
    head.createEl("h4", { text: "Budget targets" });
    const monthSelect = head.createEl("select", { cls: "budget-range-select" });
    months.forEach((m) => monthSelect.createEl("option", { text: m.label, value: m.key }));
    monthSelect.value = selected;
    monthSelect.onchange = (e) => {
      this.insightsMonth = e.target.value;
      this.render();
    };

    const monthTx = transactionsInMonth(allTx, selected);
    const { totals } = categorySpendTotals(monthTx, categoryMetaList);
    const targeted = (categoryMetaList || []).filter((c) => (c.monthly_target || 0) > 0);

    // Setting a target used to live in Settings, next to the rename and delete
    // buttons, which put a budgeting decision in a housekeeping screen and split
    // it from the chart showing whether the target was being met. It belongs
    // here, beside the thing it changes.
    //
    // Only categories a target can do anything for are offered. Rather than
    // hand-rolling that test, this asks the two things that already know:
    //
    //   isDiscretionaryCategory — the same predicate the spending allowance uses,
    //     so the picker and the chart agree on what counts as discretionary. It
    //     rules out transfers, variable necessities, categories flagged as
    //     scheduled bills, and ones named like a bill.
    //   ownership.isScheduledCategory — whether a debt or bill tracker already
    //     schedules payments in it. BNPL is budgeted by six installment plans and
    //     Phone Bill by a fixed expense; a monthly target on either would be a
    //     second opinion about money that is already accounted for.
    //
    // The last condition is the plain one: a spending target only means anything
    // for a category you actually spend in, which is what keeps Paycheck, Misc
    // Income and Refund out of a list of things to budget.
    const spentIn = new Set();
    (allTx || []).forEach((t) => {
      if (t && t.amount < 0 && t.resolved_category) spentIn.add(t.resolved_category);
    });
    const untargeted = collectCategories(ctx.rules || [], allTx, categoryMetaList || [])
      .filter(
        (c) =>
          spentIn.has(c.name) &&
          !(c.monthlyTarget > 0) &&
          isDiscretionaryCategory(c.name, categoryMetaList) &&
          !(ctx.ownership && ctx.ownership.isScheduledCategory(c.name))
      );
    const byUse = sortCategoriesByUse(untargeted.map((c) => c.name));
    untargeted.sort((a, b) => byUse.indexOf(a.name) - byUse.indexOf(b.name));

    if (untargeted.length) {
      const adder = targetCard.createDiv({ cls: "budget-goal-btns" });
      const pick = adder.createEl("select", { cls: "budget-range-select" });
      pick.createEl("option", { text: "Add a target…", value: "" });
      untargeted.forEach((c) => pick.createEl("option", { text: c.name, value: c.name }));

      const addBtn = adder.createEl("button", { text: "Set target", cls: "budget-btn" });
      addBtn.setAttr("title", `Set a monthly target, based on what you spent in ${monthLabel(priorMonthKey(selected))}`);
      addBtn.onclick = () => {
        const name = pick.value;
        if (!name) {
          new Notice("Pick a category first.");
          return;
        }
        // Same modal, same arguments as the Tune button on an existing row —
        // with 0 as the current target, because this one doesn't have one yet.
        const baseline = getPriorMonthCategorySpend(allTx, name, selected, categoryMetaList);
        new TargetTunerModal(
          this.app,
          name,
          baseline,
          priorMonthKey(selected),
          0,
          async (newTarget, pct) => {
            await setCategoryTarget(this.app, name, newTarget);
            new Notice(
              `${name} target set to $${newTarget.toFixed(2)}/mo` + (pct ? ` (-${pct}%).` : "."),
              7000
            );
            this.render();
          }
        ).open();
      };
    }

    if (targeted.length === 0) {
      targetCard.createEl("p", {
        text: untargeted.length
          ? "No monthly targets yet. Pick a category above to set one, and this card will track your spending against it."
          : "No categories are eligible for a monthly target yet — transfers, necessities and scheduled bills are budgeted elsewhere.",
        cls: "budget-muted"
      });
    } else {
      targeted
        .slice()
        .sort((a, b) => a.name.localeCompare(b.name))
        .forEach((c) => {
          const actual = round2(totals[c.name] || 0);
          const target = round2(c.monthly_target);
          const pct = target > 0 ? (actual / target) * 100 : 0;
          const over = actual > target;

          // Four lines, each with one job. Top: what it is and where it
          // stands. Subtitle: what the target asks. Bar. Bottom: how this
          // month compares with the last, and how much room is left.
          const row = targetCard.createDiv({ cls: "budget-goal-row budget-target-row" });
          const top = row.createDiv({ cls: "budget-goal-top" });

          const nameCol = top.createDiv({ cls: "budget-goal-name" });
          nameCol.createSpan({ text: c.name });

          const baseline = getPriorMonthCategorySpend(allTx, c.name, selected, categoryMetaList);
          const priorKey = priorMonthKey(selected);
          const prior = targetMonthName(priorKey, selected);

          const tuneBtn = nameCol.createEl("button", { text: "Tune", cls: "budget-btn" });
          tuneBtn.setAttr(
            "title",
            baseline > 0
              ? `Set this target as a cut from ${monthLabel(priorMonthKey(selected))} spending ($${baseline.toFixed(2)})`
              : `No ${monthLabel(priorMonthKey(selected))} spending to base a cut on`
          );
          tuneBtn.onclick = () => {
            new TargetTunerModal(
              this.app,
              c.name,
              baseline,
              priorMonthKey(selected),
              target,
              async (newTarget, pct) => {
                await setCategoryTarget(this.app, c.name, newTarget);
                new Notice(
                  `${c.name} target set to $${newTarget.toFixed(2)}/mo` + (pct ? ` (-${pct}%).` : "."),
                  7000
                );
                this.render();
              }
            ).open();
          };

          top.createSpan({
            text: `$${actual.toFixed(2)} / $${target.toFixed(2)}`,
            cls: `budget-amount budget-target-amount${over ? " budget-target-over" : ""}`
          });

          // What the target asks of you. A cut from last month reads as one;
          // anything else — no last month, or a target at or above it — is
          // just the figure.
          const cut = baseline > 0 ? ((baseline - target) / baseline) * 100 : 0;
          const aim = row.createDiv({
            text: cut >= 0.5 ? `Goal: ${Math.round(cut)}% reduction vs ${prior}` : `Target: $${target.toFixed(2)}/mo`,
            cls: "budget-target-aim"
          });
          if (baseline > 0) {
            aim.setAttr(
              "title",
              `${monthLabel(priorKey)}: $${baseline.toFixed(2)} → target $${target.toFixed(2)}` +
                (cut >= 0.5 ? ` · frees $${(baseline - target).toFixed(2)}/mo` : "")
            );
          }

          const track = row.createDiv({ cls: "budget-progress-track" });
          const fill = track.createDiv({
            cls: `budget-progress-fill${over ? " budget-progress-over" : ""}`
          });
          fill.style.width = `${Math.min(100, pct).toFixed(1)}%`;
          if (over) {
            // A second bar shows how far past the line it went.
            const spill = track.createDiv({ cls: "budget-progress-spill" });
            spill.style.width = `${Math.min(100, pct - 100).toFixed(1)}%`;
          }

          const status = row.createDiv({ cls: "budget-target-status" });
          const trend = status.createSpan({ cls: "budget-target-trend" });
          if (baseline > 0) {
            const delta = round2(actual - baseline);
            trend.setText(
              delta === 0 ? `same as ${prior}` : `${delta > 0 ? "+" : "-"}$${Math.abs(delta).toFixed(2)} vs ${prior}`
            );
            trend.addClass(delta > 0 ? "budget-target-up" : delta < 0 ? "budget-target-down" : "budget-target-flat");
          }
          status.createSpan({
            text: over
              ? `+$${(actual - target).toFixed(2)} over budget (${Math.round(pct)}%)`
              : `$${(target - actual).toFixed(2)} left (${Math.round(pct)}%)`,
            cls: `budget-target-room${over ? " budget-target-over" : ""}`
          });
        });
    }

    // ---- Month-over-month discretionary trend ----
    const trendCard = container.createDiv({ cls: "budget-card" });
    trendCard.createEl("h4", { text: "Discretionary spend by month" });
    trendCard.createEl("p", {
      text: "Excludes transfers and non-discretionary categories (rent, insurance, utilities, loans) so the trend reflects choices rather than fixed obligations.",
      cls: "budget-muted"
    });

    const series = discretionaryByMonth(allTx, categoryMetaList, isMobileApp() ? 4 : 6);
    if (series.length < 2) {
      trendCard.createEl("p", {
        text: "Need at least two months of imported data to show a trend.",
        cls: "budget-muted"
      });
    } else {
      const sel = this.trendMonth && series.some((s) => s.key === this.trendMonth) ? this.trendMonth : null;
      // On a desktop the month opens inside the chart (the sandwich). A phone,
      // or a pane narrower than a phone, hasn't the width, so it gets the list
      // below the chart instead.
      const narrow = () => {
        if (isMobileApp()) return true;
        const w = typeof window !== "undefined" ? window : null;
        return !!(w && w.matchMedia && w.matchMedia("(max-width: 700px)").matches);
      };
      const inChart = !narrow();
      const svg = buildTrendChart(series, inChart ? null : sel);
      const wrap = trendCard.createDiv({ cls: "budget-chart-wrap budget-trend-wrap" });
      if (svg) {
        setSvgContent(wrap, svg);
        const sandwich = enableTrendSandwich(wrap, {
          breakdown: (key) => Object.assign(discretionaryBreakdown(allTx, key, categoryMetaList), { title: monthLabel(key) }),
          onToggle: (key) => (this.trendMonth = key),
          narrow,
          onNarrow: (key) => {
            this.trendMonth = this.trendMonth === key ? null : key;
            this.render();
          }
        });
        // Re-rendered with a month open: it's shown open, without the animation.
        if (sandwich && inChart && sel) sandwich.open(sel, { instant: true });
      }

      if (sel && !inChart) {
        const { rows, total } = discretionaryBreakdown(allTx, sel, categoryMetaList);
        const panel = trendCard.createDiv({ cls: "budget-trend-panel" });

        const head = panel.createDiv({ cls: "budget-trend-panel-head" });
        head.createDiv({ text: monthLabel(sel), cls: "budget-trend-panel-title" });
        head.createSpan({ text: `$${total.toFixed(2)} discretionary`, cls: "budget-amount" });
        const close = head.createEl("button", { text: "Close", cls: "budget-btn" });
        close.onclick = () => {
          this.trendMonth = null;
          this.render();
        };

        if (!rows.length) {
          panel.createEl("p", { text: "No discretionary spending recorded that month.", cls: "budget-muted" });
        } else {
          // One stacked ribbon showing proportion at a glance…
          const ribbon = panel.createDiv({ cls: "budget-ribbon" });
          rows.forEach((r, i) => {
            const seg = ribbon.createDiv({ cls: "budget-ribbon-seg" });
            seg.style.backgroundColor = r.color;
            seg.style.width = `${r.pct.toFixed(2)}%`;
            seg.style.animationDelay = `${i * 40}ms`;
            seg.setAttr("title", `${r.name}: $${r.amount.toFixed(2)} (${r.pct.toFixed(0)}%)`);
          });

          // …then the itemised rows, each growing from zero on a stagger.
          const list = panel.createDiv({ cls: "budget-trend-rows" });
          rows.forEach((r, i) => {
            const row = list.createDiv({ cls: "budget-trend-row" });
            row.style.animationDelay = `${i * 45}ms`;

            const label = row.createDiv({ cls: "budget-trend-label" });
            label.createSpan({ cls: "budget-trend-swatch" }).style.backgroundColor = r.color;
            label.createSpan({ text: r.name });

            const track = row.createDiv({ cls: "budget-trend-track" });
            const fill = track.createDiv({ cls: "budget-trend-fill" });
            fill.style.backgroundColor = r.color;
            fill.style.width = `${Math.max(r.pct, 1).toFixed(2)}%`;
            fill.style.animationDelay = `${i * 45}ms`;

            row.createSpan({
              text: `$${r.amount.toFixed(2)}`,
              cls: "budget-amount budget-trend-amount"
            });
            row.createSpan({ text: `${r.pct.toFixed(0)}%`, cls: "budget-muted budget-trend-pct" });
          });

          panel.createEl("p", {
            text: "Tap another bar to compare, or the same one again to collapse.",
            cls: "budget-muted"
          });
        }
      }

      const last = series[series.length - 1];
      const prev = series[series.length - 2];
      const delta = round2(last.total - prev.total);
      const pctChange = prev.total > 0 ? (delta / prev.total) * 100 : 0;
      const avg = round2(series.reduce((s, x) => s + x.total, 0) / series.length);

      const summary = trendCard.createEl("p", { cls: "budget-muted" });
      if (delta < 0) {
        summary.createSpan({
          text: `Down $${Math.abs(delta).toFixed(2)} (${Math.abs(pctChange).toFixed(0)}%) from last month.`,
          cls: "budget-positive"
        });
      } else if (delta > 0) {
        summary.createSpan({
          text: `Up $${delta.toFixed(2)} (${pctChange.toFixed(0)}%) from last month.`,
          cls: "budget-negative"
        });
      } else {
        summary.createSpan({ text: "Flat versus last month." });
      }
      summary.createSpan({ text: `  Average across ${series.length} months: $${avg.toFixed(2)}.` });

      if (last.key === todayLocal().slice(0, 7)) {
        trendCard.createEl("p", {
          text: "The current month is still in progress, so its bar will keep growing.",
          cls: "budget-muted"
        });
      }
    }
  }

  async renderSubscriptions(container, ctx) {
    const { allTx, rules, accounts } = ctx;
    const subCard = container.createDiv({ cls: "budget-card" });
    const subHead = subCard.createDiv({ cls: "budget-sub-head" });
    subHead.createEl("h4", { text: "Subscription audit" });

    const reviews = await readJSON(this.app, FILES.subscriptionReviews, []);
    // This is the one screen that needs the retired groups as well — to say how
    // many there are — and the only one with the account data phase-out needs.
    const allRows = buildSubscriptionAudit(allTx, reviews, rules, undefined, {
      accounts: accounts || [],
      todayStr: todayLocal(),
      includePhasedOut: true
    });
    const gone = allRows.filter((s) => s.phasedOut);
    const subs = allRows.filter((s) => !s.phasedOut);

    if (subs.length === 0 && gone.length > 0) {
      subCard.createEl("p", {
        text: `Nothing left to review — ${gone.length === 1 ? "1 subscription is" : `${gone.length} subscriptions are`} confirmed gone.`,
        cls: "budget-muted"
      });
      this.renderGoneSubscriptions(subCard, gone);
    } else if (subs.length === 0) {
      subCard.createEl("p", {
        text: "No transactions categorized \u201cSubscription\u201d yet. Label a few recurring charges with that category and they'll show up here.",
        cls: "budget-muted"
      });
    } else {
      const active = subs.filter((s) => s.status !== "cancel");
      const flagged = subs.filter((s) => s.status === "cancel");
      const activeMonthly = round2(active.reduce((s, x) => s + x.monthlyEstimate, 0));
      const flaggedMonthly = round2(flagged.reduce((s, x) => s + x.monthlyEstimate, 0));

      subHead.createSpan({
        text: `$${activeMonthly.toFixed(2)}/mo across ${active.length} active`,
        cls: "budget-sub-total"
      });

      if (flaggedMonthly > 0) {
        subCard.createEl("p", {
          text: `$${flaggedMonthly.toFixed(2)}/mo flagged to cancel \u2014 that's $${(flaggedMonthly * 12).toFixed(2)}/year back if you follow through.`,
          cls: "budget-muted budget-sub-savings"
        });
      }

      const subList = this.collapsible(
        subCard,
        "sub-list",
        "All tracked subscriptions",
        `${subs.length} merchant${subs.length === 1 ? "" : "s"}`,
        true
      );
      subs.forEach((s) => {
        // A flagged row is dimmed because it's on its way out. One that can
        // finally be confirmed is the opposite — it's the row asking for a
        // click, so it comes back to full strength.
        const confirmable = !!(s.phaseOut && s.phaseOut.eligible);
        const row = subList.createDiv({
          cls: `budget-sub-row${s.status === "cancel" ? " budget-sub-cancel" : ""}${confirmable ? " budget-sub-confirmable" : ""}`
        });

        const textCol = row.createDiv({ cls: "budget-sub-text-col" });
        const nameLine = textCol.createDiv({ cls: "budget-sub-name" });
        nameLine.createSpan({ text: s.key });
        if (s.status === "keep") nameLine.createSpan({ text: "keep", cls: "budget-badge budget-badge-keep" });
        if (s.status === "cancel") nameLine.createSpan({ text: "cancel", cls: "budget-badge budget-badge-warn" });
        // Back after being confirmed gone. Saying so is the whole point of
        // resetting it to unreviewed \u2014 otherwise it just looks like a new row.
        if (s.resurfaced) {
          nameLine.createSpan({ text: "charged again", cls: "budget-badge budget-badge-warn" });
        }

        const metaLine = textCol.createDiv({ cls: "budget-sub-meta" });
        metaLine.createSpan({
          text: `last charged ${s.latestDate} \u00b7 ${s.chargeCount} charge${s.chargeCount === 1 ? "" : "s"}`
        });
        if (s.cadenceSource === "manual") {
          metaLine.createSpan({ text: "cadence set by you", cls: "budget-badge budget-badge-manual" });
        } else if (s.cadenceSource === "assumed") {
          metaLine.createSpan({ text: "cadence assumed monthly", cls: "budget-badge budget-badge-empty" });
        }

        if (s.resurfaced) {
          textCol.createDiv({
            text: `You confirmed this was gone on ${s.fadedOutAt}, but it charged again on ${s.latestDate}. Worth a second look.`,
            cls: "budget-sub-meta budget-sub-watch"
          });
        }

        // Why the confirm button is or isn't there. A flag with no visible
        // progress is the thing this feature was supposed to fix, so the row
        // says what it is still waiting on.
        const po = s.phaseOut;
        if (po && s.status === "cancel" && !s.resurfaced) {
          let note = null;
          if (po.eligible) {
            note = `Nothing since ${s.latestDate} — the next was due ${po.expectedDate} and never arrived.`;
          } else if (po.blockedBy === "not-due") {
            note = `Next charge expected ${po.expectedDate} \u2014 nothing to confirm until that passes.`;
          } else if (po.blockedBy === "cadence") {
            note = "Only one charge on record, so there's no billing pattern to measure against. Set a cadence above and this can be confirmed.";
          } else if (po.blockedBy === "charged") {
            note = `A charge from this merchant posted on or after ${po.expectedDate} \u2014 it may not have stopped.`;
          } else if (po.blockedBy === "stale") {
            const names = (po.staleAccounts || []).map((id) => {
              const acct = (accounts || []).find((a) => a.id === id);
              const label = acct ? acct.institution || acct.id : id;
              const through = acct && acct.last_imported_through;
              return through ? `${label} (through ${through})` : label;
            });
            note = names.length
              ? `Can't confirm yet \u2014 import ${names.join(" and ")} past ${po.expectedDate} first.`
              : "Can't confirm yet \u2014 these charges aren't tied to an imported account.";
          }
          if (note) {
            const noteLine = textCol.createDiv({
              cls: `budget-sub-meta${po.eligible ? " budget-sub-ready" : " budget-sub-watch"}`
            });
            noteLine.createSpan({ text: note });

            // The CTA belongs to the explanation, not to the Rename/Keep/Flag
            // cluster. Put it in that cluster and this row's buttons get wider
            // than every other row's, which drags the amount column out of
            // line with the rest of the list — measured at 120px adrift.
            if (po.eligible) {
              const goneBtn = noteLine.createEl("button", {
                text: "Confirm it's gone",
                cls: "budget-btn mod-cta budget-sub-cta"
              });
              goneBtn.setAttr(
                "title",
                `Hide this from the audit. Its ${s.cadenceLabel} charge was due ${po.expectedDate} and didn't post. It comes back on its own if it ever charges again.`
              );
              goneBtn.onclick = async () => {
                await confirmSubscriptionGone(this.app, s.key, s.latestDate);
                new Notice(`${s.key} confirmed gone — it'll come back if it charges again.`);
                this.render();
              };
            }
          }
        }

        const amtCol = row.createDiv({ cls: "budget-sub-amt-col" });
        amtCol.createDiv({ text: `$${s.monthlyEstimate.toFixed(2)}/mo`, cls: "budget-amount" });
        if (Math.abs(s.monthlyEstimate - s.latestAmount) > 0.01) {
          amtCol.createDiv({ text: `$${s.latestAmount.toFixed(2)} each`, cls: "budget-sub-meta" });
        }

        const btnCol = row.createDiv({ cls: "budget-sub-btn-col" });

        // Cadence is independent of keep/cancel — set either without touching the other.
        const cadenceSelect = btnCol.createEl("select", { cls: "budget-cadence-select" });
        // Kept short so the fixed-width control doesn't need to stretch.
        cadenceSelect.createEl("option", {
          text: s.intervalDays ? `Auto \u00b7 ${describeCadence(s.intervalDays)}` : "Auto \u00b7 guess",
          value: ""
        });
        Object.keys(CADENCE_LABELS).forEach((k) =>
          cadenceSelect.createEl("option", { text: CADENCE_LABELS[k], value: k })
        );
        cadenceSelect.value = s.cadenceOverride || "";
        cadenceSelect.setAttr("title", "Billing cadence — overrides what's inferred from charge history");
        cadenceSelect.onchange = async (e) => {
          await setSubscriptionCadence(this.app, s.key, e.target.value || null);
          new Notice(
            e.target.value
              ? `${s.key} set to ${CADENCE_LABELS[e.target.value]}.`
              : `${s.key} cadence back to auto-detect.`
          );
          this.render();
        };

        // No Delete button here. A subscription is a spending pattern the audit
        // detected, not a record to remove — it is managed with Keep/Cancel. The
        // button that used to sit here was wired to the CATEGORY delete flow and
        // referenced variables that exist only in Settings, so it threw the
        // moment it was clicked. Category deletion lives in Settings → Categories.
        const renameBtn = btnCol.createEl("button", { text: "Rename", cls: "budget-btn" });
        renameBtn.setAttr("title", "Give this a clean display name and consolidate its charges");
        renameBtn.onclick = () => {
          new RenameSubscriptionModal(this.app, s, allTx, async ({ nickname, pattern }) => {
            const currentRules = await readJSON(this.app, FILES.rules, []);
            const idx = s.matchedRule
              ? currentRules.findIndex(
                  (r) => r.merchant_pattern === s.matchedRule.merchant_pattern && r.home_label === s.matchedRule.home_label
                )
              : -1;

            if (idx >= 0) {
              currentRules[idx].merchant_pattern = pattern;
              currentRules[idx].display_name = nickname;
            } else {
              currentRules.push({ merchant_pattern: pattern, home_label: s.category, display_name: nickname });
            }
            await writeJSON(this.app, FILES.rules, currentRules);

            const txs = await readJSON(this.app, FILES.transactions, []);
            applyCategorization(txs, currentRules);
            await writeJSON(this.app, FILES.transactions, txs);

            // Carry any existing review state over to the new group key.
            if (s.key !== nickname) {
              const reviewList = await readJSON(this.app, FILES.subscriptionReviews, []);
              const old = reviewList.find((r) => r.merchant_key === s.key);
              if (old) {
                await patchSubscriptionReview(this.app, nickname, {
                  status: old.status,
                  cadence_override: old.cadence_override || null,
                  // Without these a rename would resurrect something already
                  // confirmed gone, under a new key and with no evidence trail.
                  faded_out_at: old.faded_out_at || null,
                  faded_out_after: old.faded_out_after || null
                });
              }
            }

            new Notice(`Now shown as "${nickname}".`);
            this.render();
          }, rules).open();
        };

        const keepBtn = btnCol.createEl("button", {
          text: "Keep",
          cls: `budget-btn${s.status === "keep" ? " mod-cta" : ""}`
        });
        keepBtn.onclick = async () => {
          await setSubscriptionStatus(this.app, s.key, s.status === "keep" ? "unreviewed" : "keep");
          this.render();
        };

        const cancelBtn = btnCol.createEl("button", {
          text: "Flag to cancel",
          cls: `budget-btn${s.status === "cancel" ? " budget-btn-danger-active" : " budget-btn-danger"}`
        });
        cancelBtn.onclick = async () => {
          await setSubscriptionStatus(this.app, s.key, s.status === "cancel" ? "unreviewed" : "cancel");
          this.render();
        };
      });

      this.renderGoneSubscriptions(subCard, gone);
    }
  }

  // Retired groups still get one line. A subscription that vanished with no
  // trace is indistinguishable from one the audit lost track of, and the
  // transactions behind it are untouched either way.
  renderGoneSubscriptions(subCard, gone) {
    if (!gone || gone.length === 0) return;
    const saved = round2(gone.reduce((s, x) => s + x.monthlyEstimate, 0));
    const note = subCard.createEl("p", { cls: "budget-muted budget-sub-gone" });
    note.createSpan({
      text: `Confirmed gone: ${gone.map((g) => g.key).join(", ")}.`
    });
    if (saved > 0) {
      note.createSpan({ text: ` That's $${(saved * 12).toFixed(2)}/year no longer going out.` });
    }
    note.createSpan({ text: " Any of them will reappear here if a new charge posts." });
  }
}

// ---------- Plugin ----------

class BudgetSettingTab extends PluginSettingTab {
  constructor(app, plugin) {
    super(app, plugin);
    this.plugin = plugin;
  }

  // Obsidian calls display() to build the settings tab, and twenty controls in
  // it call display() again after they change something. The body awaits the
  // vault twenty-six times and only empties the container at the very start, so
  // a second run that begins while the first is still awaiting empties the
  // container out from under it and both then append into the same element —
  // producing headers from one run interleaved with lists from the other.
  //
  // Serialising is the fix rather than a staleness check at every await: one
  // render at a time, and a request made during a render collapses into exactly
  // one follow-up no matter how many arrive.
  display() {
    if (this._rendering) {
      this._renderQueued = true;
      return;
    }
    this._rendering = true;
    this._renderQueued = false;
    return this.renderSettings()
      .catch((e) => {
        console.error("Budget Tracker: settings render failed", e);
      })
      .finally(() => {
        this._rendering = false;
        if (this._renderQueued) this.display();
      });
  }

  async renderSettings() {
    const { containerEl } = this;
    containerEl.empty();
    await this.renderSetupSettings(containerEl);
    await this.renderBufferSettings(containerEl);
    await this.renderSavingsSettings(containerEl);
    await this.renderPayScheduleSettings(containerEl);
    await this.renderBankSyncSettings(containerEl);
    await this.renderAccountSettings(containerEl);
    await this.renderPortfolioSettings(containerEl);
    await this.renderFixedExpenseSettings(containerEl);
    await this.renderDebtSettings(containerEl);
    await this.renderGoalSettings(containerEl);
    await this.renderCategorySettings(containerEl);
    await this.renderRuleSettings(containerEl);
  }

  // First-time setup: one button that lays out every folder and data file. It
  // leads the page while anything is missing, since nothing else in here has
  // anywhere to save until it's done; once everything's in place it shrinks to
  // one line with the same button, for putting back a file that was deleted.
  async renderSetupSettings(containerEl) {
    const st = await setupStatus(this.app);
    const missing = st.missingFiles.length + st.missingFolders.length + (st.readme ? 0 : 1);
    if (missing) {
      new Setting(containerEl).setName("Setup").setHeading();
      const fresh = st.present === 0;
      new Setting(containerEl)
        .setName(fresh ? "Set up Budget Tracker" : "Create missing files")
        .setDesc(
          fresh
            ? `Creates the Budget folder in this vault with data, imports and exports inside, every data file the plugin uses, a starter set of categories and a short README. Run this once after installing.`
            : `${st.missingFiles.length ? `${st.missingFiles.length} of the plugin's ${st.total} data files ${st.missingFiles.length === 1 ? "is" : "are"} missing` : "Some of its folders are missing"}. This creates only what's missing; your existing data isn't changed.`
        )
        .addButton((b) =>
          b
            .setButtonText(fresh ? "Set up" : "Create missing files")
            .setCta()
            .onClick(async () => {
              await this.plugin.setupFiles();
              this.display();
            })
        );
    } else {
      new Setting(containerEl)
        .setName("Data files")
        .setDesc(
          `All ${st.total} data files and the Budget, data, imports and exports folders are in place.` +
            (st.unreadable.length ? ` Can't be read: ${st.unreadable.join(", ")}.` : "")
        )
        .addButton((b) =>
          b.setButtonText("Check again").onClick(async () => {
            await this.plugin.setupFiles();
            this.display();
          })
        );
    }
  }

  // How much cash is held back for ordinary spending.

  // Settings grew from three knobs to eight sections, six of them lists that can
  // run to dozens of rows. Collapsing the lists keeps the settings you actually
  // tune — buffer, savings, pay schedule — visible without scrolling past every
  // category you have ever created. Open/closed state survives the re-render
  // that every control in here triggers.
  countLabel(n, singular, plural) {
    return `${n} ${n === 1 ? singular : plural || singular + "s"}`;
  }

  section(containerEl, id, title, count, defaultOpen = false) {
    if (!this._openSections) this._openSections = {};
    if (!(id in this._openSections)) this._openSections[id] = defaultOpen;
    const det = containerEl.createEl("details", { cls: "budget-collapsible budget-settings-section" });
    det.open = this._openSections[id];
    const sum = det.createEl("summary", { cls: "budget-collapsible-summary" });
    sum.createSpan({ text: title, cls: "budget-collapsible-title" });
    if (count) sum.createSpan({ text: count, cls: "budget-collapsible-sub" });
    det.addEventListener("toggle", () => {
      this._openSections[id] = det.open;
    });
    return det.createDiv({ cls: "budget-collapsible-body" });
  }

  async renderBufferSettings(containerEl) {
    containerEl.addClass("budget-settings");

    containerEl.createEl("h2", { text: "Budget Tracker" });

    new Setting(containerEl)
      .setName("Buffer mode")
      .setDesc(
        "How much cash to hold back for ordinary spending. Auto works it out from your " +
          "targets, last month's actuals and the days left in the period; manual is a flat figure."
      )
      .addDropdown((d) =>
        d
          .addOption("auto", "Smart auto-detect")
          .addOption("manual", "Manual flat amount")
          .setValue(this.plugin.settings.bufferMode || "auto")
          .onChange(async (v) => {
            this.plugin.settings.bufferMode = v;
            await writeJSON(this.app, FILES.settings, this.plugin.settings);
            await this.plugin.refreshAfterDataChange();
            this.display();
          })
      );

    if ((this.plugin.settings.bufferMode || "auto") === "manual") {
      const bufferSetting = new Setting(containerEl)
        .setName("Manual buffer")
        .setDesc(
          "Flat spending allowance for each pay period. Ordinary spending draws it down as it happens; " +
            "changing it here re-sets the current period's allowance."
        );
      bufferSetting.addText((t) =>
          bindMoneyInput(t, bufferSetting).setValue(String(this.plugin.settings.manualBuffer ?? 100)).onChange(async (v) => {
            // Saved as you type, so only a complete, valid figure is written;
            // anything else is flagged under the field and left unsaved.
            const r = parseMoneyInput(v);
            if (!r.ok || r.empty) return;
            if (round2(r.value) === this.plugin.settings.manualBuffer) return;
            const n = r.value;
            this.plugin.settings.manualBuffer = round2(n);
            await writeJSON(this.app, FILES.settings, this.plugin.settings);
            await this.plugin.refreshAfterDataChange();
          })
        );
    } else if (this.plugin.lastResult && this.plugin.lastResult.bufferCalc) {
      const lr = this.plugin.lastResult;
      const bc = lr.bufferCalc;
      const allocated = lr.allocatedBuffer != null ? lr.allocatedBuffer : bc.total;
      const remaining = lr.bufferRemaining != null ? lr.bufferRemaining : bc.total;
      containerEl.createEl("p", {
        text:
          `This period's allowance is $${allocated.toFixed(2)}, with $${remaining.toFixed(2)} still unspent. ` +
          `It was worked out across ${bc.detail.length} categor${bc.detail.length === 1 ? "y" : "ies"} at the start of the period ` +
          `and stays fixed until the next payday, so spending can be measured against it.`,
        cls: "budget-muted budget-apply-scope"
      });
    }

    // ---- Categories ----
    // ---- Savings Mode ----
  }

  // Savings Mode and its optional deadline.
  async renderSavingsSettings(containerEl) {
    containerEl.createEl("h3", { text: "Strategy" });
    containerEl.createEl("p", {
      text:
        "Where a surplus goes once obligations and your spending allowance are covered. " +
        "Minimum payments are treated as obligations either way — Savings Focus suspends " +
        "acceleration, it doesn't skip anything owed.",
      cls: "budget-muted"
    });

    // No toggle here any more. The strategy is the choice the whole allocation
    // turns on, so it lives above the numbers it changes rather than three
    // screens away from them; a second control here would be a second source of
    // truth for the same setting.
    if (!this.plugin.settings.savingsMode) {
      containerEl.createEl("p", {
        text:
          "You are currently in Debt Reduction mode. Extra surplus is recommended toward debt " +
          "principal. Switch to Savings Focus on the dashboard to set a savings deadline and pace goals.",
        cls: "budget-muted"
      });
      return;
    }

    new Setting(containerEl)
      .setName("Deadline (optional)")
      .setDesc("Shows a countdown to it. Goals are paced by their own target dates; a goal with none stays undated. Leave blank for open-ended saving.")
      .addText((t) => {
        bindDateInput(t, this.plugin.settings.savingsDeadline);
        t.inputEl.addEventListener("change", async () => {
          const raw = t.inputEl.value.trim();
          const norm = normalizeDate(raw);
          if (raw && !/^\d{4}-\d{2}-\d{2}$/.test(norm)) {
            new Notice(`"${raw}" isn't a valid date.`, 7000);
            return;
          }
          this.plugin.settings.savingsDeadline = norm || null;
          await writeJSON(this.app, FILES.settings, this.plugin.settings);
          new Notice(norm ? `Savings Focus deadline set to ${norm}.` : "Savings Focus deadline cleared.");
          await this.plugin.refreshAfterDataChange();
          this.display();
        });
      });

    if (this.plugin.settings.savingsMode) {
      const st = savingsStatus(this.plugin.settings);
      if (st && st.days != null) {
        containerEl.createEl("p", {
          text: st.past
            ? `That date passed ${Math.abs(st.days)} days ago.`
            : `${st.days} days from today.`,
          cls: "budget-muted budget-apply-scope"
        });
      }
    }

  }

  // The cadence every pay-period date is derived from.
  async renderPayScheduleSettings(containerEl) {
    containerEl.createEl("h3", { text: "Pay schedule" });
    containerEl.createEl("p", {
      text:
        "Your payday follows a fixed cycle even though the amount varies, so set it once here " +
        "and the next payday is calculated for you \u2014 no more typing a date every period.",
      cls: "budget-muted"
    });

    const sched = this.plugin.settings.paySchedule || { cadence: "biweekly", anchor_date: "" };

    new Setting(containerEl)
      .setName("Pay cadence")
      .addDropdown((d) => {
        Object.keys(PAY_CADENCES).forEach((k) => d.addOption(k, PAY_CADENCES[k].label));
        d.setValue(sched.cadence || "biweekly");
        d.onChange(async (v) => {
          this.plugin.settings.paySchedule = Object.assign({}, this.plugin.settings.paySchedule, {
            cadence: v,
            anchor_date: (this.plugin.settings.paySchedule || {}).anchor_date || ""
          });
          await writeJSON(this.app, FILES.settings, this.plugin.settings);
          this.display();
        });
      });

    new Setting(containerEl)
      .setName("A known payday")
      .setDesc("Any past payday works as the anchor; everything else is counted from it.")
      .addText((t) => {
        bindDateInput(t, sched.anchor_date);
        // Save on blur/enter rather than per keystroke, so a half-typed date
        // isn't silently rejected and left looking saved.
        t.inputEl.addEventListener("change", async () => {
          const raw = t.inputEl.value.trim();
          if (!raw) {
            this.plugin.settings.paySchedule = null;
            await writeJSON(this.app, FILES.settings, this.plugin.settings);
            new Notice("Pay schedule cleared.");
            this.display();
            return;
          }
          const norm = normalizeDate(raw);
          if (!/^\d{4}-\d{2}-\d{2}$/.test(norm)) {
            new Notice(`"${raw}" isn't a valid date.`, 7000);
            return;
          }
          this.plugin.settings.paySchedule = { cadence: sched.cadence || "biweekly", anchor_date: norm };
          await writeJSON(this.app, FILES.settings, this.plugin.settings);
          new Notice(`Pay schedule saved: ${PAY_CADENCES[sched.cadence || "biweekly"].label.toLowerCase()} from ${norm}.`);
          this.plugin.refreshDashboard();
          this.display();
        });
      });

    const schedNow = this.plugin.settings.paySchedule;
    if (schedNow && schedNow.anchor_date) {
      const today = todayLocal();
      const upcoming = [];
      let cursor = today;
      for (let i = 0; i < 4; i++) {
        const n = nextPaydayFrom(schedNow, cursor);
        if (!n) break;
        upcoming.push(n);
        cursor = n;
      }
      if (upcoming.length) {
        containerEl.createEl("p", {
          text: `Next paydays: ${upcoming.join("  \u00b7  ")}`,
          cls: "budget-muted budget-apply-scope"
        });
      }
    }

    new Setting(containerEl)
      .setName("Detect from my transactions")
      .setDesc("Reads deposits categorized \u201cPaycheck\u201d and infers the cadence and anchor date.")
      .addButton((b) =>
        b.setButtonText("Detect").onClick(async () => {
          const txs = await readJSON(this.app, FILES.transactions, []);
          const found = detectPaySchedule(txs);
          if (!found) {
            new Notice(
              "Couldn't detect a schedule. Needs at least two deposits categorized \u201cPaycheck\u201d with a regular gap.",
              8000
            );
            return;
          }
          this.plugin.settings.paySchedule = { cadence: found.cadence, anchor_date: found.anchor_date };
          await writeJSON(this.app, FILES.settings, this.plugin.settings);
          new Notice(
            `Detected ${PAY_CADENCES[found.cadence].label.toLowerCase()} pay (median ${found.medianGap} days across ${found.sampleSize} deposits), anchored to ${found.anchor_date}.`,
            9000
          );
          this.display();
        })
      );

  }

  // Checking and credit accounts.
  // Bank sync. Not collapsed like the lists below it: the dashboard's dimmed
  // Sync button deep-links here, and there has to be a visible field to land on.
  async renderBankSyncSettings(containerEl) {
    const wrap = containerEl.createDiv({ cls: "budget-sync-settings" });
    wrap.createEl("h3", { text: "Bank sync (SimpleFIN)" });
    wrap.createEl("p", {
      text:
        "Optional. Pulls posted transactions and balances straight from your bank through SimpleFIN Bridge, " +
        "in place of CSV exports. Accounts you don't link keep using Import CSV.",
      cls: "budget-muted"
    });
    // SimpleFIN is a third-party bridge and banks drop out of it now and then, so
    // say so up front rather than after someone wonders where a transaction went.
    wrap.createEl("p", {
      text: "(Unstable) Some transactions may not appear until you use Adjust on SimpleFIN Bridge's website.",
      cls: "budget-sync-unstable"
    });

    const focusRequested = this.plugin.settingsFocus === "simplefin";
    if (focusRequested) this.plugin.settingsFocus = null;
    const land = (el) => {
      if (!focusRequested || !el) return;
      wrap.addClass("budget-settings-flash");
      requestAnimationFrame(() => {
        if (typeof el.scrollIntoView === "function") el.scrollIntoView({ block: "center", behavior: "smooth" });
        if (typeof el.focus === "function") el.focus();
      });
    };

    if (!this.plugin.hasSimpleFINConnection()) {
      let token = "";
      const tokenSetting = new Setting(wrap)
        .setName("SimpleFIN setup token")
        .setDesc(
          "Create one in SimpleFIN Bridge and paste it here. It's used once to connect, then thrown away. " +
            "The connection is kept in this device's secret storage, not in your vault, so each device connects on its own."
        );
      let input = null;
      tokenSetting.addText((t) => {
        input = t.inputEl;
        input.type = "password";
        input.setAttr("autocomplete", "off");
        input.setAttr("spellcheck", "false");
        input.addClass("budget-sync-token");
        t.setPlaceholder("Paste setup token").onChange((v) => (token = v));
      });
      tokenSetting.addButton((b) =>
        b
          .setButtonText("Connect")
          .setCta()
          .onClick(async () => {
            if (!token.trim()) {
              new Notice("Paste a SimpleFIN setup token first.");
              return;
            }
            b.setButtonText("Connecting…");
            if (b.setDisabled) b.setDisabled(true);
            try {
              const data = await this.plugin.connectSimpleFIN(token);
              const n = data.accounts.length;
              new Notice(
                data.warning
                  ? `Connected to SimpleFIN, but couldn't list your accounts yet: ${data.warning} Pressing Sync will try again.`
                  : n
                  ? `Connected to SimpleFIN — found ${n} account${n === 1 ? "" : "s"}. Link ${n === 1 ? "it" : "them"} under Accounts, then press Sync.`
                  : "Connected to SimpleFIN, but it didn't report any accounts yet. Add a bank connection in SimpleFIN Bridge.",
                10000
              );
            } catch (e) {
              const message = e instanceof SimpleFINError ? e.message : "Something unexpected went wrong.";
              console.error("Budget Tracker: SimpleFIN connect failed —", redactSimpleFIN(e && e.message ? e.message : e));
              new Notice(`Couldn't connect: ${message}`, 10000);
            }
            this.display();
          })
      );
      land(input);
      return;
    }

    const cache = await readJSON(this.app, FILES.simplefinAccounts, {});
    const known = cache.accounts || [];
    const accounts = await readJSON(this.app, FILES.accounts, []);
    const loanIds = (await readJSON(this.app, FILES.installmentDebts, [])).filter((d) => isLoan(d) && d.simplefin_id).map((d) => d.simplefin_id);
    const linkedIds = new Set(accounts.map((a) => a.simplefin_id).filter(Boolean).concat(loanIds));
    const last = cache.last_sync && cache.last_sync.at ? new Date(cache.last_sync.at) : null;
    const status = new Setting(wrap)
      .setName("Connected")
      .setDesc(
        `${known.length} SimpleFIN account${known.length === 1 ? "" : "s"} · ` +
          `${linkedIds.size} linked · ` +
          (last && !isNaN(last.getTime())
            ? `last synced ${formatChartDate(toLocalISO(last))} at ${last.toLocaleTimeString([], { hour: "numeric", minute: "2-digit" })}`
            : "not synced yet")
      );
    status.addButton((b) =>
      b
        .setButtonText("Disconnect")
        .setWarning()
        .onClick(() => {
          new ConfirmModal(this.app, {
            title: "Disconnect SimpleFIN on this device?",
            body: [
              "Sync stops on this device. Transactions already imported stay, and account links are kept, so reconnecting picks up where it left off.",
              "To connect again you'll need a new setup token from SimpleFIN Bridge."
            ],
            confirmText: "Disconnect",
            onConfirm: async () => {
              await this.plugin.disconnectSimpleFIN();
              new Notice("SimpleFIN disconnected on this device.");
              this.display();
            }
          }).open();
        })
    );
    land(status.settingEl);

    const unlinked = known.filter((a) => !linkedIds.has(a.id));
    if (unlinked.length) {
      const note = wrap.createDiv({ cls: "budget-sync-unlinked" });
      note.createDiv({
        text: `Not linked yet — Edit an account below and choose it under “SimpleFIN account”:`,
        cls: "budget-muted"
      });
      const list = note.createEl("ul");
      unlinked.forEach((a) => list.createEl("li", { text: simplefinAccountLabel(a) }));
    }
  }

  async renderAccountSettings(containerEl) {
    containerEl = this.section(containerEl, "accounts", "Accounts", this.countLabel((await readJSON(this.app, FILES.accounts, [])).length, "account"));
    const accts = await readJSON(this.app, FILES.accounts, []);

    new Setting(containerEl).addButton((b) =>
      b
        .setButtonText("Add account")
        .setCta()
        .onClick(() => this.plugin.promptAddAccount(() => this.display()))
    );

    if (!accts.length) {
      containerEl.createEl("p", { text: "No accounts yet.", cls: "budget-muted" });
    } else {
      const ac = containerEl.createDiv({ cls: "budget-settings-cats" });
      const cashAcctHere = cashAccount(accts);
      accts.forEach((a) => {
        const row = ac.createDiv({ cls: "budget-cat-row" });
        const textCol = row.createDiv({ cls: "budget-cat-text-col" });
        textCol.createDiv({ text: `${a.institution || a.id}`, cls: "budget-cat-name" });
        textCol.createDiv({
          text: `${a.type} · $${(a.current_balance ?? 0).toFixed(2)}` +
            (a.credit_limit ? ` of $${a.credit_limit} limit` : "") +
            ` · id ${a.id}` +
            (a.simplefin_id ? " · syncs via SimpleFIN" : ""),
          cls: "budget-cat-usage"
        });
        // Where the balance came from, and which account the budget counts as
        // cash — the two things to check when a figure looks stuck.
        const from = balanceSourceText(a.balance_source, a.balance_updated_at);
        const isCash = cashAcctHere && cashAcctHere.id === a.id;
        const origin = from
          ? `Balance ${from}`
          : a.simplefin_id
            ? "Balance not yet dated by a sync"
            : a.balance_as_of
              ? `Balance as of ${formatChartDate(a.balance_as_of)}`
              : "";
        if (origin || isCash) {
          textCol.createDiv({
            text: [origin, isCash ? "the budget's cash on hand" : ""].filter(Boolean).join(" \u00b7 "),
            cls: "budget-cat-usage budget-account-source"
          });
        }
        const btnCol = row.createDiv({ cls: "budget-cat-btn-col" });

        const edit = btnCol.createEl("button", { text: "Edit", cls: "budget-btn" });
        edit.onclick = async () => {
          const context = await this.plugin.simplefinLinkContext(a.id);
          new AddAccountModal(
            this.app,
            async (patch) => {
              const list = await readJSON(this.app, FILES.accounts, []);
              const i = list.findIndex((x) => x.id === a.id);
              if (i < 0) return;
              // A blank field saves as 0; on an account that had no balance, that
              // isn't a figure someone typed, so it isn't dated as one.
              const retyped =
                patch.current_balance != null &&
                patch.current_balance !== list[i].current_balance &&
                !(list[i].current_balance == null && patch.current_balance === 0);
              list[i] = Object.assign({}, list[i], patch);
              if (retyped) stampBalance(Object.assign(list[i], { balance_as_of: todayLocal() }), "manual");
              // A blank credit limit means "no limit", which has to remove the
              // field rather than store undefined.
              if (patch.credit_limit === undefined) delete list[i].credit_limit;
              if (!patch.simplefin_id) delete list[i].simplefin_id;
              await writeJSON(this.app, FILES.accounts, list);
              new Notice(`Updated ${patch.institution || a.id}.`);
              await this.plugin.refreshAfterDataChange();
              this.display();
            },
            a,
            context
          ).open();
        };

        const del = btnCol.createEl("button", { text: "Delete", cls: "budget-btn budget-btn-danger" });
        del.onclick = async () => {
          const txs = await readJSON(this.app, FILES.transactions, []);
          const owned = txs.filter((t) => t.account_id === a.id).length;
          const debts = await readJSON(this.app, FILES.revolvingDebts, []);
          const linked = debts.filter((d) => d.account_id === a.id).length;
          const funds = cappedFunds(await readJSON(this.app, FILES.savingsGoals, [])).filter((f) => f.account_id === a.id);
          new ConfirmModal(this.app, {
            title: `Delete account “${a.id}”?`,
            body: [
              owned ? `${owned} imported transaction${owned === 1 ? "" : "s"} reference this account and will be left orphaned — they stay in your history but no longer belong to an account.` : "No transactions reference this account.",
              linked ? `${linked} credit card term record${linked === 1 ? "" : "s"} point here and will stop resolving. Delete those from the Debts tab too.` : null,
              funds.length
                ? `${funds.map((f) => f.name).join(" and ")} follow${funds.length === 1 ? "s" : ""} this account's balance and will show it as missing until pointed at another account.`
                : null
            ],
            onConfirm: async () => {
              const list = await readJSON(this.app, FILES.accounts, []);
              await writeJSON(this.app, FILES.accounts, list.filter((x) => x.id !== a.id));
              new Notice(`Deleted account ${a.id}.`);
              await this.plugin.refreshAfterDataChange();
              this.display();
            }
          }).open();
        };
      });
    }

  }

  // Investment accounts: kept apart from the bank accounts above because
  // nothing about them is cash. Their balances only come from statements.
  async renderPortfolioSettings(containerEl) {
    const accounts = await this.plugin.loadPortfolioAccounts();
    containerEl = this.section(containerEl, "portfolio", "Investment accounts", this.countLabel(accounts.length, "account"));
    containerEl.createEl("p", {
      text:
        "Retirement, HSA and brokerage accounts tracked on the Portfolio tab from pasted statements. " +
        "Read-only: they never count toward cash, Spendable, goals or debt.",
      cls: "budget-muted"
    });
    new Setting(containerEl).addButton((b) =>
      b
        .setButtonText("Add investment account")
        .setCta()
        .onClick(() => this.plugin.promptPortfolioAccount(null, () => this.display()))
    );
    if (!accounts.length) {
      containerEl.createEl("p", { text: "No investment accounts yet.", cls: "budget-muted" });
      return;
    }
    const snaps = await readJSON(this.app, FILES.portfolioSnapshots, []);
    const list = containerEl.createDiv({ cls: "budget-settings-cats" });
    accounts.forEach((a) => {
      const count = snaps.filter((s) => s.account_id === a.id).length;
      const row = list.createDiv({ cls: "budget-cat-row" });
      const textCol = row.createDiv({ cls: "budget-cat-text-col" });
      textCol.createDiv({ text: a.label, cls: "budget-cat-name" });
      textCol.createDiv({
        text: [
          a.provider || null,
          PF_TYPES[a.type],
          pfCadence(a) === "none" ? "no reminders" : `${PF_CADENCES[pfCadence(a)].toLowerCase()} statements`,
          a.account_hint ? `ends ${a.account_hint}` : null,
          this.countLabel(count, "statement")
        ]
          .filter(Boolean)
          .join(" · "),
        cls: "budget-cat-usage"
      });
      const btnCol = row.createDiv({ cls: "budget-cat-btn-col" });
      const edit = btnCol.createEl("button", { text: "Edit", cls: "budget-btn" });
      edit.onclick = () => this.plugin.promptPortfolioAccount(a, () => this.display());
      const del = btnCol.createEl("button", { text: "Delete", cls: "budget-btn budget-btn-danger" });
      del.onclick = () => {
        new ConfirmModal(this.app, {
          title: `Delete ${a.label}?`,
          body: [
            count
              ? `Its ${this.countLabel(count, "imported statement")} will be deleted with it, and drop out of the Portfolio total and chart.`
              : "It has no imported statements."
          ],
          confirmText: "Delete",
          onConfirm: async () => {
            await this.plugin.deletePortfolioAccount(a);
            this.display();
          }
        }).open();
      };
    });
  }

  // Recurring bills, and the category each one's charges land in.

  // Debts, which are configuration in exactly the sense accounts are — they were
  // reachable only from the dashboard, so half the plugin's setup lived in one
  // place and half in another.
  async renderDebtSettings(containerEl) {
    containerEl = this.section(containerEl, "debts", "Debts & plans", this.countLabel((await readJSON(this.app, FILES.revolvingDebts, [])).length + (await readJSON(this.app, FILES.installmentDebts, [])).length, "debt"));
    containerEl.createEl("p", {
      text:
        "Credit card terms, BNPL plans and loans. Balances are derived from the ledger rather than typed, so editing " +
        "here changes the terms \u2014 use Edit Balance on the Debts tab to re-anchor what is actually owed.",
      cls: "budget-muted"
    });

    const revolving = await readJSON(this.app, FILES.revolvingDebts, []);
    const installment = await readJSON(this.app, FILES.installmentDebts, []);
    const transactions = await readJSON(this.app, FILES.transactions, []);

    const add = new Setting(containerEl);
    add.addButton((btn) =>
      btn.setButtonText("Add credit card terms").onClick(() => this.plugin.promptAddCreditCardTerms())
    );
    add.addButton((btn) => btn.setButtonText("Add BNPL plan").onClick(() => this.plugin.promptAddBNPL()));
    add.addButton((btn) => btn.setButtonText("Add loan").onClick(() => this.plugin.promptLoan()));

    if (!revolving.length && !installment.length) {
      containerEl.createEl("p", { text: "Nothing tracked yet.", cls: "budget-muted" });
      return;
    }

    const list = containerEl.createDiv({ cls: "budget-settings-cats" });
    const row = (d, kind) => {
      const el = list.createDiv({ cls: "budget-cat-row" });
      const textCol = el.createDiv({ cls: "budget-cat-text-col" });
      const nameLine = textCol.createDiv({ cls: "budget-cat-name" });
      nameLine.createSpan({ text: debtLabel(d) });
      nameLine.createSpan({
        text: kind === "cc" ? "credit card" : kind === "loan" ? LOAN_TYPES[loanType(d)].label.toLowerCase() : "BNPL",
        cls: "budget-badge budget-badge-transfer"
      });
      if (d.payment_category) {
        nameLine.createSpan({ text: d.payment_category, cls: "budget-badge budget-badge-empty" });
      }
      const bal = debtBalance(d, kind === "cc" ? transactions : null);
      const bits = [`$${bal.toFixed(2)} owed`];
      if (kind === "cc") {
        if (d.apr) bits.push(`${d.apr}% APR`);
        if (d.min_payment_due) bits.push(`$${d.min_payment_due.toFixed(2)} minimum`);
        if (d.due_date) bits.push(`due ${d.due_date}`);
      } else if (kind === "loan") {
        if (d.apr) bits.push(`${d.apr}% APR`);
        bits.push(`$${(d.installment_amount || 0).toFixed(2)}/mo`);
        if (d.next_due_date) bits.push(`${(d.applied_payments || []).length ? "next" : "first payment"} ${d.next_due_date}`);
        if (d.simplefin_id) bits.push("balance via SimpleFIN");
      } else {
        bits.push(`${remainingInstallments(d)} \u00d7 $${(d.installment_amount || 0).toFixed(2)}`);
        if (d.next_due_date) bits.push(`next ${d.next_due_date}`);
      }
      textCol.createDiv({ text: bits.join(" \u00b7 "), cls: "budget-cat-usage" });

      const btnCol = el.createDiv({ cls: "budget-cat-btn-col" });
      if (kind === "loan") {
        btnCol.createEl("button", { text: "Edit", cls: "budget-btn" }).onclick = () => this.plugin.promptLoan(d);
        btnCol.createEl("button", { text: "Close", cls: "budget-btn" }).onclick = () => this.plugin.promptCloseLoan(d);
        return;
      }
      if (kind === "bnpl") {
        const edit = btnCol.createEl("button", { text: "Edit", cls: "budget-btn" });
        edit.onclick = () => this.plugin.promptEditBNPL(d);
      }
      const del = btnCol.createEl("button", { text: "Delete", cls: "budget-btn budget-btn-danger" });
      del.onclick = () => {
        const applied = (d.applied_payments || []).length;
        new ConfirmModal(this.app, {
          title: `Delete \u201c${debtLabel(d)}\u201d?`,
          body: [
            applied
              ? `${applied} applied payment${applied === 1 ? "" : "s"} recorded against it will be removed too, so its payment history is lost.`
              : "No payments have been applied to it yet.",
            "Transactions themselves are not deleted \u2014 only the debt and its links."
          ],
          onConfirm: async () => {
            const file = kind === "cc" ? FILES.revolvingDebts : FILES.installmentDebts;
            const all = await readJSON(this.app, file, []);
            await writeJSON(this.app, file, all.filter((x) => debtKey(x) !== debtKey(d)));
            new Notice(`Deleted ${debtLabel(d)}.`);
            await this.plugin.refreshAfterDataChange();
            this.display();
          }
        }).open();
      };
    };
    revolving.forEach((d) => row(d, "cc"));
    installment.forEach((d) => row(d, isLoan(d) ? "loan" : "bnpl"));
  }

  // Savings goals were dashboard-only for the same reason. Contributions stay on
  // the dashboard, where they belong; the goals themselves are configuration.
  async renderGoalSettings(containerEl) {
    containerEl = this.section(containerEl, "goals", "Savings goals", this.countLabel((await readJSON(this.app, FILES.savingsGoals, [])).length, "goal"));
    const goals = await readJSON(this.app, FILES.savingsGoals, []);
    const accounts = await readJSON(this.app, FILES.accounts, []);

    new Setting(containerEl)
      .addButton((btn) =>
        btn.setButtonText("New goal").onClick(() => {
          new SavingsGoalModal(this.app, async (goal) => {
            goal.id = genId("goal");
            goal.contributions = [];
            const list = await readJSON(this.app, FILES.savingsGoals, []);
            list.push(goal);
            await writeJSON(this.app, FILES.savingsGoals, list);
            new Notice(`Created goal: ${goal.name}`);
            await this.plugin.refreshAfterDataChange();
            this.display();
          }).open();
        })
      )
      .addButton((btn) =>
        btn
          .setButtonText("New capped fund")
          .setTooltip("A fund that follows a savings account's balance, up to a ceiling")
          .onClick(() => this.plugin.promptCappedFund(null, () => this.display()))
      );

    if (!goals.length) {
      containerEl.createEl("p", { text: "No goals yet.", cls: "budget-muted" });
      return;
    }

    const list = containerEl.createDiv({ cls: "budget-settings-cats" });
    goals.forEach((g) => {
      if (isCappedFund(g)) {
        this.renderFundSettingsRow(list, g, accounts);
        return;
      }
      const p = goalProgress(g);
      const row = list.createDiv({ cls: "budget-cat-row" });
      const textCol = row.createDiv({ cls: "budget-cat-text-col" });
      const nameLine = textCol.createDiv({ cls: "budget-cat-name" });
      nameLine.createSpan({ text: g.name });
      if (p.complete) nameLine.createSpan({ text: "funded", cls: "budget-badge budget-badge-pinned" });
      const bits = [`$${p.saved.toFixed(2)} of $${p.target.toFixed(2)}`];
      if (g.target_date) bits.push(`by ${g.target_date}`);
      const unlinked = (g.contributions || []).filter((c) => !c.linked_tx_id && c.amount > 0).length;
      if (unlinked) bits.push(`${unlinked} contribution${unlinked === 1 ? "" : "s"} awaiting a transfer`);
      textCol.createDiv({ text: bits.join(" \u00b7 "), cls: "budget-cat-usage" });

      const btnCol = row.createDiv({ cls: "budget-cat-btn-col" });
      const edit = btnCol.createEl("button", { text: "Edit", cls: "budget-btn" });
      edit.onclick = () => {
        new SavingsGoalModal(
          this.app,
          async (patch) => {
            const all = await readJSON(this.app, FILES.savingsGoals, []);
            const i = all.findIndex((x) => x.id === g.id);
            if (i < 0) return;
            all[i] = Object.assign({}, all[i], patch, { id: g.id, contributions: all[i].contributions || [] });
            await writeJSON(this.app, FILES.savingsGoals, all);
            new Notice(`Updated ${patch.name}.`);
            await this.plugin.refreshAfterDataChange();
            this.display();
          },
          g
        ).open();
      };
      const del = btnCol.createEl("button", { text: "Delete", cls: "budget-btn budget-btn-danger" });
      del.onclick = () => {
        const contribs = (g.contributions || []).length;
        new ConfirmModal(this.app, {
          title: `Delete \u201c${g.name}\u201d?`,
          body: [
            contribs
              ? `${contribs} contribution${contribs === 1 ? "" : "s"} recorded against it will be removed, and any still unmatched will stop being held back from free cash.`
              : "No contributions have been recorded against it.",
            "Transactions themselves are not deleted."
          ],
          onConfirm: async () => {
            const all = await readJSON(this.app, FILES.savingsGoals, []);
            await writeJSON(this.app, FILES.savingsGoals, all.filter((x) => x.id !== g.id));
            new Notice(`Deleted goal: ${g.name}`);
            await this.plugin.refreshAfterDataChange();
            this.display();
          }
        }).open();
      };
    });
  }

  // A capped fund in the settings list: what it follows and where it shows,
  // with Edit and Delete. Moving it is on the Overview, where you can see it.
  renderFundSettingsRow(list, fund, accounts) {
    const p = fundProgress(fund, accounts);
    const row = list.createDiv({ cls: "budget-cat-row" });
    const textCol = row.createDiv({ cls: "budget-cat-text-col" });
    const nameLine = textCol.createDiv({ cls: "budget-cat-name" });
    nameLine.createSpan({ text: fund.name });
    nameLine.createSpan({ text: "capped fund", cls: "budget-badge budget-badge-fund" });
    if (p.complete) nameLine.createSpan({ text: "at cap", cls: "budget-badge budget-badge-pinned" });
    const bits = [
      p.known ? `$${p.saved.toFixed(2)} of a $${p.target.toFixed(2)} ceiling` : `$${p.target.toFixed(2)} ceiling`,
      p.account ? `follows ${accountLabel(p.account)}` : "its account is gone",
      `shown ${FUND_PLACEMENT_LABELS[fundPlacement(fund)].toLowerCase()}`
    ];
    textCol.createDiv({ text: bits.join(" \u00b7 "), cls: "budget-cat-usage" });

    const btnCol = row.createDiv({ cls: "budget-cat-btn-col" });
    const edit = btnCol.createEl("button", { text: "Edit", cls: "budget-btn" });
    edit.onclick = () => this.plugin.promptCappedFund(fund, () => this.display());
    const del = btnCol.createEl("button", { text: "Delete", cls: "budget-btn budget-btn-danger" });
    del.onclick = () => {
      new ConfirmModal(this.app, {
        title: `Delete \u201c${fund.name}\u201d?`,
        body: [
          "It stops showing on the Overview and stops asking for surplus.",
          p.account
            ? `${accountLabel(p.account)} stays in your accounts and keeps syncing, and its balance and transactions aren't touched.`
            : null
        ],
        onConfirm: async () => {
          await this.plugin.deleteCappedFund(fund);
          this.display();
        }
      }).open();
    };
  }

  async renderFixedExpenseSettings(containerEl) {
    const allCategoryNames = (await readJSON(this.app, FILES.categories, []))
      .map((c) => c && c.name)
      .filter(Boolean);

    containerEl = this.section(
      containerEl,
      "fixed",
      "Fixed expenses",
      this.countLabel((await readJSON(this.app, FILES.fixedExpenses, [])).length, "bill")
    );
    containerEl.createEl("p", {
      text: "Every recurring bill, whether or not it's due this period. Rent, insurance, subscriptions — edit or remove them here.",
      cls: "budget-muted"
    });

    const fixedList = await readJSON(this.app, FILES.fixedExpenses, []);
    if (!fixedList.length) {
      containerEl.createEl("p", { text: "None yet — add one from the dashboard.", cls: "budget-muted" });
    } else {
      const fx = containerEl.createDiv({ cls: "budget-settings-cats" });
      fixedList
        .slice()
        .sort((a, b) => a.name.localeCompare(b.name))
        .forEach((f) => {
          const row = fx.createDiv({ cls: "budget-cat-row" });
          const textCol = row.createDiv({ cls: "budget-cat-text-col" });
          const nameLine = textCol.createDiv({ cls: "budget-cat-name" });
          nameLine.createSpan({ text: f.name });
          if (f.payment_category) {
            nameLine.createSpan({
              text: f.payment_category + (f.payment_category_learned ? " (learned)" : ""),
              cls: "budget-badge budget-badge-transfer"
            });
          } else {
            nameLine.createSpan({ text: "no payment category", cls: "budget-badge budget-badge-empty" });
          }
          if (f.flagged_for_review) {
            nameLine.createSpan({ text: "review", cls: "budget-badge budget-badge-empty" });
          }
          textCol.createDiv({
            text: isRollingExpense(f)
              ? `$${(f.amount || 0).toFixed(2)} · every ${f.interval_days} days · next ${f.next_due_date}`
              : `$${(f.amount || 0).toFixed(2)} · monthly on day ${f.due_day_of_month}` +
                (f.last_paid_date ? ` · last paid ${f.last_paid_date}` : ""),
            cls: "budget-cat-usage"
          });

          const btnCol = row.createDiv({ cls: "budget-cat-btn-col" });
          const edit = btnCol.createEl("button", { text: "Edit", cls: "budget-btn" });
          edit.onclick = () => {
            new AddFixedExpenseModal(
              this.app,
              async (patch) => {
                const list = await readJSON(this.app, FILES.fixedExpenses, []);
                const i = list.findIndex((x) => (f.id ? x.id === f.id : x.name === f.name));
                if (i < 0) return;
                // A monthly expense edited into a rolling one (or back) must not
                // keep the other shape's fields, or both would look valid.
                const merged = Object.assign({}, list[i], patch);
                if (patch.interval_days) delete merged.due_day_of_month;
                else {
                  delete merged.interval_days;
                  delete merged.next_due_date;
                }
                list[i] = merged;
                await writeJSON(this.app, FILES.fixedExpenses, list);
                new Notice(`Updated ${patch.name}.`);
                this.plugin.refreshAfterDataChange();
                this.display();
              },
              f,
              allCategoryNames
            ).open();
          };

          const del = btnCol.createEl("button", { text: "Delete", cls: "budget-btn budget-btn-danger" });
          del.onclick = () => {
            new ConfirmModal(this.app, {
              title: `Delete “${f.name}”?`,
              body: [
                `$${(f.amount || 0).toFixed(2)} will stop being counted as an obligation in every future period.`,
                "Past periods already calculated aren't changed."
              ],
              onConfirm: async () => {
                const list = await readJSON(this.app, FILES.fixedExpenses, []);
                const next = list.filter((x) => (f.id ? x.id !== f.id : x.name !== f.name));
                await writeJSON(this.app, FILES.fixedExpenses, next);
                new Notice(`Deleted ${f.name}.`);
                await this.plugin.refreshAfterDataChange();
                this.display();
              }
            }).open();
          };
        });
    }

  }

  // Category names, targets and funding classification.
  async renderCategorySettings(containerEl) {
    containerEl = this.section(containerEl, "categories", "Categories", this.countLabel((await readJSON(this.app, FILES.categories, [])).length, "category", "categories"));
    containerEl.createEl("p", {
      text: "How each category counts. Open Settings to rename it or change how it's treated.",
      cls: "budget-muted"
    });

    const allRules = await readJSON(this.app, FILES.rules, []);
    const allTxs = await readJSON(this.app, FILES.transactions, []);
    const catMeta = await readJSON(this.app, FILES.categories, []);
    const categories = collectCategories(allRules, allTxs, catMeta);

    // Which bills and debts name each category as where their charges land, so
    // a delete can say what it is about to disconnect.
    const payers = [].concat(
      (await readJSON(this.app, FILES.fixedExpenses, [])).map((e) => ({ name: e.name, cat: e.payment_category })),
      (await readJSON(this.app, FILES.installmentDebts, [])).map((d) => ({ name: debtLabel(d), cat: d.payment_category })),
      (await readJSON(this.app, FILES.revolvingDebts, [])).map((d) => ({ name: debtLabel(d), cat: d.payment_category }))
    );
    const dependentsOf = (name) => payers.filter((p) => p.cat === name).map((p) => p.name);

    if (categories.length === 0) {
      containerEl.createEl("p", { text: "No categories yet \u2014 label a transaction to create one.", cls: "budget-muted" });
    } else {
      const catList = containerEl.createDiv({ cls: "budget-settings-cats" });
      const allNames = categories.map((c) => c.name);

      categories.forEach((c) => {
        const row = catList.createDiv({ cls: "budget-cat-row" });

        const textCol = row.createDiv({ cls: "budget-cat-text-col" });
        const nameLine = textCol.createDiv({ cls: "budget-cat-name" });
        nameLine.createSpan({ text: c.name });
        if (c.isTransfer) nameLine.createSpan({ text: "transfer", cls: "budget-badge budget-badge-transfer" });
        if (c.isScheduled) nameLine.createSpan({ text: "scheduled bill", cls: "budget-badge budget-badge-pinned" });
        if (c.isVariableNecessity) nameLine.createSpan({ text: "necessity", cls: "budget-badge budget-badge-pinned" });
        if (c.isNecessaryExpense) nameLine.createSpan({ text: "necessary expense", cls: "budget-badge budget-badge-pinned" });

        const bits = [];
        if (c.ruleCount) bits.push(`${c.ruleCount} rule${c.ruleCount === 1 ? "" : "s"}`);
        if (c.txCount) bits.push(`${c.txCount} txn${c.txCount === 1 ? "" : "s"}`);
        if (c.overrideCount) bits.push(`${c.overrideCount} override${c.overrideCount === 1 ? "" : "s"}`);
        textCol.createDiv({ text: bits.join(" \u00b7 ") || "unused", cls: "budget-cat-usage" });

        const btnCol = row.createDiv({ cls: "budget-cat-btn-col" });

        const settingsBtn = btnCol.createEl("button", { text: "Settings", cls: "budget-btn" });
        settingsBtn.onclick = () => {
          new CategorySettingsModal(this.app, c, allNames, async ({ name, kind, minAmount }) => {
            let renamed = "";
            if (name !== c.name) {
              const { rulesUpdated, overridesUpdated, paymentCategoriesUpdated } = await renameCategory(this.app, c.name, name);
              renamed =
                ` Renamed \u2014 ${rulesUpdated} rule(s), ${overridesUpdated} override(s)` +
                (paymentCategoriesUpdated ? `, ${paymentCategoriesUpdated} bill/debt still pointing at it` : "") +
                " updated.";
            }
            await setCategoryKind(this.app, name, kind, minAmount);
            new Notice(`Saved \u201c${name}\u201d.${renamed}`);
            this.plugin.refreshDashboard();
            this.display();
          }).open();
        };

        const deleteBtn = btnCol.createEl("button", { text: "Delete", cls: "budget-btn budget-btn-danger" });
        deleteBtn.setAttr("title", "Remove this category, moving or clearing everything that uses it");
        deleteBtn.onclick = () => {
          new DeleteCategoryModal(this.app, c, categories, dependentsOf(c.name), async (reassignTo) => {
            const { rulesChanged, txChanged, paymentCategoriesChanged } = await deleteCategory(
              this.app,
              c.name,
              reassignTo
            );
            const moved = [];
            if (rulesChanged) moved.push(`${rulesChanged} rule${rulesChanged === 1 ? "" : "s"}`);
            if (txChanged) moved.push(`${txChanged} transaction${txChanged === 1 ? "" : "s"}`);
            if (paymentCategoriesChanged) {
              moved.push(`${paymentCategoriesChanged} bill/debt${paymentCategoriesChanged === 1 ? "" : "s"}`);
            }
            new Notice(
              `Deleted “${c.name}”` +
                (moved.length
                  ? reassignTo
                    ? ` — ${moved.join(", ")} moved to ${reassignTo}.`
                    : ` — ${moved.join(", ")} cleared.`
                  : "."),
              9000
            );
            this.plugin.refreshDashboard();
            this.display();
          }).open();
        };
      });
    }

  }

  // Merchant patterns that assign categories on import.
  async renderRuleSettings(containerEl) {
    containerEl = this.section(containerEl, "rules", "Category rules", this.countLabel((await readJSON(this.app, FILES.rules, [])).length, "rule"));
    containerEl.createEl("p", {
      text:
        "Each rule maps a merchant pattern to a category. Any transaction whose description contains " +
        "the pattern gets that category automatically. Editing a rule relabels matching transactions " +
        "retroactively, except ones you've overridden individually.",
      cls: "budget-muted"
    });

    const rules = await readJSON(this.app, FILES.rules, []);

    if (rules.length === 0) {
      containerEl.createEl("p", {
        text: "No rules yet \u2014 label a transaction from the dashboard to create one.",
        cls: "budget-muted"
      });
      return;
    }

    const search = containerEl.createEl("input", {
      type: "text",
      cls: "budget-settings-search",
      attr: { placeholder: `Filter ${rules.length} rules\u2026` }
    });

    const listEl = containerEl.createDiv({ cls: "budget-settings-rules" });

    const renderRules = (filter = "") => {
      listEl.empty();
      const needle = filter.trim().toLowerCase();
      const shown = rules
        .map((rule, i) => ({ rule, i }))
        .filter(
          ({ rule }) =>
            !needle ||
            rule.merchant_pattern.toLowerCase().includes(needle) ||
            rule.home_label.toLowerCase().includes(needle)
        );

      if (shown.length === 0) {
        listEl.createEl("p", { text: "No rules match that filter.", cls: "budget-muted" });
        return;
      }

      shown.forEach(({ rule, i }) => {
        const row = listEl.createDiv({ cls: "budget-rule-row" });
        const textCol = row.createDiv({ cls: "budget-rule-text-col" });
        const patternEl = textCol.createDiv({ text: rule.merchant_pattern, cls: "budget-rule-pattern" });
        patternEl.setAttr("title", rule.merchant_pattern);
        textCol.createDiv({ text: rule.home_label, cls: "budget-rule-label" });

        const btnCol = row.createDiv({ cls: "budget-rule-btn-col" });
        const editBtn = btnCol.createEl("button", { text: "Edit", cls: "budget-btn" });
        editBtn.onclick = async () => {
          // Read fresh so the live match line reflects what's actually stored now.
          const [ruleTxs, ruleList] = await Promise.all([
            readJSON(this.app, FILES.transactions, []),
            readJSON(this.app, FILES.rules, [])
          ]);
          new EditRuleModal(this.app, rule, async ({ pattern, label, nickname }) => {
            if (!label || !pattern) return;
            const currentRules = await readJSON(this.app, FILES.rules, []);
            currentRules[i].merchant_pattern = pattern;
            currentRules[i].home_label = label;
            if (nickname) currentRules[i].display_name = nickname;
            else delete currentRules[i].display_name;
            await writeJSON(this.app, FILES.rules, currentRules);
            const txs = await readJSON(this.app, FILES.transactions, []);
            applyCategorization(txs, currentRules);
            await writeJSON(this.app, FILES.transactions, txs);
            new Notice(`Updated: "${pattern}" -> ${label}`);
            this.plugin.refreshDashboard();
            this.display();
          }, { transactions: ruleTxs, rules: ruleList, index: i }).open();
        };

        const delBtn = btnCol.createEl("button", { text: "Delete", cls: "budget-btn budget-btn-danger" });
        delBtn.onclick = async () => {
          const currentRules = await readJSON(this.app, FILES.rules, []);
          currentRules.splice(i, 1);
          await writeJSON(this.app, FILES.rules, currentRules);
          const txs = await readJSON(this.app, FILES.transactions, []);
          applyCategorization(txs, currentRules);
          await writeJSON(this.app, FILES.transactions, txs);
          new Notice(`Deleted rule for ${rule.merchant_pattern}`);
          this.plugin.refreshDashboard();
          this.display();
        };
      });
    };

    search.oninput = (e) => renderRules(e.target.value);
    renderRules();
  }

}

module.exports = class BudgetTrackerPlugin extends Plugin {
  // Opens the tour; closing it either way means it won't open by itself again.
  showTour() {
    new IntroTourModal(this.app, async () => {
      if (this.settings && !this.settings.tourSeen) {
        this.settings.tourSeen = true;
        await writeJSON(this.app, FILES.settings, this.settings);
      }
    }).open();
  }

  async onload() {
    await ensureDataDir(this.app);
    await ensureIds(this.app, FILES.fixedExpenses, "fixed");
    await ensureIds(this.app, FILES.installmentDebts, "bnpl");
    await ensureIds(this.app, FILES.revolvingDebts, "cc");
    await ensureFixedExpenseLinks(this.app);
    await ensureDebtAnchors(this.app);

    const idRepair = await dedupeTransactionIds(this.app);
    if (idRepair.repaired || idRepair.missing) {
      new Notice(
        `Budget Tracker: repaired ${idRepair.repaired} duplicate and ${idRepair.missing} missing transaction id(s). ` +
          "Older imports could generate colliding ids, which made Move affect the wrong row. " +
          "Spot-check any applied debt payments or matched savings contributions.",
        15000
      );
    }

    // Bank holds that never got collapsed into the charge that replaced them.
    // Left alone they orphan payment links, which shows up as the budget asking
    // to match a payment that was already applied.
    const holdRepair = await repairSettledHolds(this.app);
    if (holdRepair.merged || holdRepair.deduped) {
      const parts = [];
      if (holdRepair.merged) {
        parts.push(
          `merged ${holdRepair.merged} bank hold${holdRepair.merged === 1 ? "" : "s"} into the charge that replaced ` +
            (holdRepair.merged === 1 ? "it" : "them")
        );
      }
      if (holdRepair.relinked) {
        parts.push(`moved ${holdRepair.relinked} payment link${holdRepair.relinked === 1 ? "" : "s"} onto it`);
      }
      // Worth calling out on its own: this one changes a balance, because the
      // obligation was recorded as paid twice by the same transaction.
      if (holdRepair.deduped) {
        parts.push(
          `removed ${holdRepair.deduped} payment${holdRepair.deduped === 1 ? "" : "s"} that had been applied twice ` +
            "(the balance it was applied to will go up by that amount, which is the correct figure)"
        );
      }
      new Notice(`Budget Tracker: ${parts.join("; ")}.`, 15000);
    }

    await loadCategoryUsageOrder(this.app);

    // Read the raw file first: once DEFAULT_SETTINGS is merged in, manualBuffer
    // always looks present, so there's no way to tell whether the saved file
    // actually had it. The distinction matters — a user who deliberately set
    // manualBuffer must not have it clobbered by a legacy safetyBuffer.
    const savedSettings = await readJSON(this.app, FILES.settings, {});
    const hadManualBuffer = Object.prototype.hasOwnProperty.call(savedSettings, "manualBuffer");

    this.settings = Object.assign({}, DEFAULT_SETTINGS, savedSettings);

    let settingsMigrated = false;

    // safetyBuffer became manualBuffer in 1.2.0. Idempotent: once the legacy key
    // is gone this block never runs again.
    if (Object.prototype.hasOwnProperty.call(savedSettings, "safetyBuffer")) {
      if (!hadManualBuffer) {
        const legacy = Number(savedSettings.safetyBuffer);
        this.settings.manualBuffer = isNaN(legacy) ? DEFAULT_SETTINGS.manualBuffer : legacy;
      }
      delete this.settings.safetyBuffer;
      settingsMigrated = true;
    }

    // Savings Mode migration: carry legacy Relocation Mode settings over.
    if (this.settings.relocationMode !== undefined) {
      this.settings.savingsMode = !!this.settings.relocationMode;
      this.settings.savingsDeadline = this.settings.relocationDeadline || null;
      delete this.settings.relocationMode;
      delete this.settings.relocationDeadline;
      settingsMigrated = true;
    }

    // Savings Mode is called Savings Mode. The setting that let it be renamed
    // bought one string and cost a lookup at every site that displayed it, so
    // the stored value is cleared rather than left to linger in the file.
    if (this.settings.savingsLabel !== undefined) {
      delete this.settings.savingsLabel;
      settingsMigrated = true;
    }

    if (settingsMigrated) await writeJSON(this.app, FILES.settings, this.settings);

    // Only a brand-new install gets the tour on its own: anyone with a saved
    // settings file already knows their way around. Everyone can reopen it.
    const showTourFirst = !savedSettings.tourSeen && Object.keys(savedSettings).length === 0;

    this.registerView(VIEW_TYPE, (leaf) => new BudgetDashboardView(leaf, this));

    this.addSettingTab(new BudgetSettingTab(this.app, this));

    // A ```budget``` code block turns any note into a launcher. On mobile this
    // is the reliable entry point: the note can be bookmarked or starred, and
    // bookmarks DO appear in the mobile sidebar.
    this.registerMarkdownCodeBlockProcessor("budget", (source, el) => {
      this.renderLauncherBlock(el);
    });

    const pfAccounts = await this.ensurePortfolioAccounts();

    // Restore an in-flight pay period so the dashboard survives reloads.
    await this.loadActivePeriod();

    // Nudge once on load if last month's statements are missing. Derived purely
    // from stored snapshot coverage.
    const pfSnaps = await readJSON(this.app, FILES.portfolioSnapshots, []);
    const pfDue = portfolioReminders(pfSnaps, pfAccounts);
    if (pfDue.length) {
      new Notice(
        pfDue
          .map(portfolioReminderText)
          .join("\n"),
        12000
      );
    }

    this.addRibbonIcon("wallet", "Open Budget Tracker", () => this.activateView());
    if (showTourFirst) {
      const ws = this.app.workspace;
      if (ws && typeof ws.onLayoutReady === "function") ws.onLayoutReady(() => this.showTour());
    }

    this.addCommand({
      id: "open-budget-dashboard",
      name: "Open dashboard",
      callback: () => this.activateView()
    });

    this.addCommand({ id: "set-up-files", name: "Set up data files and folders", callback: () => this.setupFiles() });
    this.addCommand({ id: "show-tour", name: "Show tour", callback: () => this.showTour() });
    this.addCommand({ id: "enter-paycheck", name: "Enter paycheck", callback: () => this.promptEnterPaycheck() });
    this.addCommand({ id: "add-account", name: "Add account", callback: () => this.promptAddAccount() });
    this.addCommand({ id: "add-revolving-debt", name: "Add credit card terms", callback: () => this.promptAddCreditCardTerms() });
    this.addCommand({ id: "add-bnpl-plan", name: "Add BNPL plan", callback: () => this.promptAddBNPL() });
    this.addCommand({ id: "add-loan", name: "Add loan (car, mortgage, student, personal)", callback: () => this.promptLoan() });
    this.addCommand({ id: "add-fixed-expense", name: "Add fixed expense", callback: () => this.promptAddFixedExpense() });
    this.addCommand({ id: "mark-fixed-expense-paid", name: "Mark fixed expense as paid", callback: () => this.promptMarkFixedPaid() });
    this.addCommand({ id: "manage-transfer-categories", name: "Manage transfer categories", callback: () => this.promptManageTransfers() });
    this.addCommand({ id: "import-bank-csv", name: "Import bank CSV", callback: () => this.promptImportCSV() });
    this.addCommand({ id: "open-budget-settings", name: "Open settings and rules", callback: () => this.openSettings() });
    this.addCommand({ id: "sync-simplefin", name: "Sync transactions (SimpleFIN)", callback: () => this.syncSimpleFIN() });
    this.addCommand({ id: "export-data", name: "Export\u2026", callback: () => this.promptExport() });
    this.addCommand({ id: "add-transaction", name: "Add transaction", callback: () => this.promptAddTransaction() });
    this.addCommand({ id: "add-investment-balance", name: "Add investment balance", callback: () => this.promptAddInvestmentBalance() });
    this.addCommand({ id: "export-transaction-notes", name: "Export transactions to notes", callback: () => this.exportTransactionNotes() });
    this.addCommand({ id: "export-financial-snapshot", name: "Export financial snapshot", callback: () => this.exportSnapshot() });
    this.addCommand({
      id: "import-portfolio-statement",
      name: "Import portfolio statement",
      callback: () => this.promptPortfolioImport()
    });
    this.addCommand({
      id: "update-balances",
      name: "Update account balances",
      callback: () => this.promptQuickBalance()
    });
    this.addCommand({
      id: "toggle-relocation-mode",
      name: "Toggle strategy: debt reduction or savings focus",
      callback: () => this.toggleRelocationMode()
    });
    this.addCommand({
      id: "open-budget-dashboard-sidebar",
      name: "Open in sidebar",
      callback: () => this.activateView("sidebar")
    });
    this.addCommand({
      id: "create-budget-dashboard-note",
      name: "Create bookmarkable note",
      callback: () => this.createDashboardNote()
    });
  }

  // Re-runs the budget math when a period is active, otherwise just repaints.
  // Every data-changing action funnels through here so the dashboard is never stale.
  async refreshAfterDataChange() {
    if (this.lastPaycheckInputs) await this.recalculate();
    else this.refreshDashboard();
  }

  // `focus` names a field for the settings tab to scroll to and select once it
  // has drawn — the tab renders asynchronously, so it picks this up itself.
  openSettings({ focus = null } = {}) {
    this.settingsFocus = focus;
    const setting = this.app.setting;
    if (setting && typeof setting.open === "function") {
      setting.open();
      if (typeof setting.openTabById === "function") setting.openTabById(this.manifest.id);
    } else {
      new Notice("Open Settings \u2192 Community plugins \u2192 Budget Tracker.");
    }
  }

  // ---------- SimpleFIN ----------

  // The access URL is a password to every linked bank account, so it never goes
  // in the vault. Obsidian's secret storage (1.11.4+) keeps it outside the vault
  // files, per device; older versions fall back to Obsidian's vault-scoped local
  // storage, which is also kept out of the vault files.
  getSimpleFINAccess() {
    const ss = this.app && this.app.secretStorage;
    if (ss && typeof ss.getSecret === "function") {
      try {
        const v = ss.getSecret(SIMPLEFIN_SECRET_ID);
        if (v) return String(v);
      } catch (e) {
        /* fall through */
      }
    }
    if (this.app && typeof this.app.loadLocalStorage === "function") {
      const v = this.app.loadLocalStorage(SIMPLEFIN_SECRET_ID);
      if (v) return String(v);
    }
    return null;
  }

  setSimpleFINAccess(value) {
    const ss = this.app && this.app.secretStorage;
    let stored = false;
    if (ss && typeof ss.setSecret === "function") {
      try {
        ss.setSecret(SIMPLEFIN_SECRET_ID, value || "");
        stored = true;
      } catch (e) {
        /* fall back below */
      }
    }
    if (this.app && typeof this.app.saveLocalStorage === "function") {
      // Only a fallback: once the keychain holds it, any older copy is cleared.
      this.app.saveLocalStorage(SIMPLEFIN_SECRET_ID, stored ? null : value || null);
      if (value) stored = true;
    }
    if (value && !stored) {
      throw new SimpleFINError("storage", "This version of Obsidian has nowhere safe to keep the connection. Update Obsidian and try again.");
    }
  }

  hasSimpleFINConnection() {
    return !!this.getSimpleFINAccess();
  }

  // Checked before a setup token is claimed: a token works once, so claiming
  // one with nowhere to keep the result would simply waste it.
  canStoreSimpleFINAccess() {
    const ss = this.app && this.app.secretStorage;
    return !!((ss && typeof ss.setSecret === "function") || (this.app && typeof this.app.saveLocalStorage === "function"));
  }

  // requestUrl, with each request logged against the daily allowance as it
  // goes out — not before, so input rejected without a request costs nothing.
  simplefinRequest() {
    return async (req) => {
      await this.logSimpleFINRequest();
      return requestUrl(req);
    };
  }

  // Sync state shows on every open dashboard, not just the first.
  refreshAllDashboards() {
    const leaves = this.app && this.app.workspace ? this.app.workspace.getLeavesOfType(VIEW_TYPE) : [];
    if (!leaves.length) return this.refreshDashboard();
    leaves.forEach((l) => l.view && typeof l.view.render === "function" && l.view.render());
  }

  // Every request counts against the Bridge's daily allowance, whether or not it
  // succeeds, so it's logged before it goes out.
  async simplefinAllowance() {
    const cache = await readJSON(this.app, FILES.simplefinAccounts, {});
    const now = Date.now();
    const recent = (cache.requests || []).filter((t) => Number.isFinite(t) && now - t < 86400000);
    return { cache, recent, ok: recent.length < SIMPLEFIN_DAILY_LIMIT };
  }

  async logSimpleFINRequest() {
    const { cache, recent } = await this.simplefinAllowance();
    await writeJSON(this.app, FILES.simplefinAccounts, Object.assign({}, cache, { requests: recent.concat(Date.now()) }));
  }

  async rememberSimpleFINAccounts(accounts, extra = {}) {
    const cache = await readJSON(this.app, FILES.simplefinAccounts, {});
    await writeJSON(
      this.app,
      FILES.simplefinAccounts,
      Object.assign({}, cache, extra, {
        fetched_at: new Date().toISOString(),
        accounts: accounts.map((a) => ({
          id: a.id,
          name: a.name,
          org: a.org,
          currency: a.currency,
          balance: a.balance,
          balance_date: a.balanceDate
        }))
      })
    );
  }

  // Claims the token if it is one, stores the connection, and asks once for
  // balances only — which both proves the connection works and lists the
  // accounts, so they can be linked before the first real sync.
  async connectSimpleFIN(input) {
    if (!this.canStoreSimpleFINAccess()) {
      throw new SimpleFINError("storage", "This version of Obsidian has nowhere safe to keep the connection. Update Obsidian and try again.");
    }
    // Connecting takes two requests: the claim, then the account list.
    const { recent } = await this.simplefinAllowance();
    if (recent.length + 2 > SIMPLEFIN_DAILY_LIMIT) {
      throw new SimpleFINError("quota", `SimpleFIN has been asked ${recent.length} times in the last 24 hours. Try again later.`);
    }
    const request = this.simplefinRequest();
    const access = await claimSimpleFINToken(input, { request });
    // Stored before anything else can fail: a setup token can't be claimed twice.
    this.setSimpleFINAccess(access);
    this.refreshDashboard();
    // From here on it IS connected, so a failure listing accounts is reported as
    // that rather than as a failed connection. Sync lists them again.
    try {
      const data = await fetchSimpleFINData(access, { balancesOnly: true, request });
      await this.rememberSimpleFINAccounts(data.accounts);
      return data;
    } catch (e) {
      if (!(e instanceof SimpleFINError)) console.error("Budget Tracker: SimpleFIN account list failed —", redactSimpleFIN(e && e.message));
      return { accounts: [], errors: [], ambiguous: [], warning: e instanceof SimpleFINError ? e.message : "Something unexpected went wrong." };
    }
  }

  // Forgets the connection on this device. Account links stay, so reconnecting
  // picks up where it left off.
  async disconnectSimpleFIN() {
    this.setSimpleFINAccess(null);
    this.refreshDashboard();
  }

  async syncSimpleFIN() {
    if (this.syncing) return null;
    const access = this.getSimpleFINAccess();
    if (!access) {
      this.openSettings({ focus: "simplefin" });
      return null;
    }
    const allowance = await this.simplefinAllowance();
    if (!allowance.ok) {
      new Notice(
        `SimpleFIN has been asked ${allowance.recent.length} times in the last 24 hours. It allows about 24 a day ` +
          "and turns access off for going well past that, so this one is being skipped. Try again later.",
        10000
      );
      return null;
    }

    this.syncing = true;
    this.refreshAllDashboards();
    let wrote = false;
    try {
      const today = todayLocal();
      const accounts = await readJSON(this.app, FILES.accounts, []);
      const linked = accounts.filter((a) => a.simplefin_id);
      // Loans follow a SimpleFIN account for its balance only; their payments
      // are seen from checking, where they leave.
      const loanLinks = (await readJSON(this.app, FILES.installmentDebts, [])).filter((d) => isLoan(d) && d.simplefin_id);
      const startDate = simplefinStartDate(linked, today);

      const data = await fetchSimpleFINData(access, {
        startDate,
        balancesOnly: linked.length === 0,
        request: this.simplefinRequest()
      });

      const byId = new Map(data.accounts.map((a) => [a.id, a]));
      const issues = [];
      const notes = [];
      // Connection problems are summed up in a line per bank; anything else
      // SimpleFIN reports goes in the details as it said it.
      const problems = simplefinConnectionProblems(
        data.errors,
        linked
          .map((local) => ({ local, sf: byId.get(local.simplefin_id) || null }))
          .concat(loanLinks.map((l) => ({ local: { id: l.id, institution: debtLabel(l) }, sf: byId.get(l.simplefin_id) || null }))),
        today
      );
      data.errors.filter((e) => !problems.explained.has(e)).forEach((e) => issues.push(`From your bank via SimpleFIN: ${e.message}`));
      // An error names an account, a whole bank connection, or nothing. Whatever
      // it covers may have come back incomplete, so those accounts don't count
      // as imported through today — the next sync reaches back over the gap.
      // Advice about the request itself covers nothing.
      const errorCovers = (sf) =>
        data.errors.some((e) =>
          !SIMPLEFIN_ADVISORY.test(e.message) && (e.accountId ? e.accountId === sf.id : e.connId ? e.connId === sf.connId : true)
        );

      let ledger = await readJSON(this.app, FILES.transactions, []);
      const totals = { added: 0, claimed: 0, settled: 0, duplicates: 0 };
      const balances = {};
      const asOf = {}; // each account's balance is as of its own date
      const balanceAt = {}; // …and moment, which is what orders it against a typed one
      const syncStartedAt = new Date().toISOString();
      const clean = [];

      for (const local of linked) {
        const label = local.institution || local.id;
        const sf = byId.get(local.simplefin_id);
        if (data.ambiguous.includes(local.simplefin_id)) {
          issues.push(`${label}: two SimpleFIN connections use the same account id, so this link can't be followed. Nothing was imported for it.`);
          continue;
        }
        if (!sf) {
          issues.push(`${label}: SimpleFIN didn't include this account. It may have been removed from your SimpleFIN connection.`);
          continue;
        }
        if (sf.currency !== "USD") {
          issues.push(`${label}: SimpleFIN reports it in ${sf.currency}, and this plugin budgets in dollars. Nothing was imported for it.`);
          continue;
        }
        const rows = simplefinToLocalTransactions(sf, local);
        if (rows.invalid) {
          issues.push(
            `${label}: ${rows.invalid} transaction${rows.invalid === 1 ? "" : "s"} from SimpleFIN had no usable id, date or amount and ${rows.invalid === 1 ? "wasn't" : "weren't"} imported.`
          );
        }
        const r = mergeSimpleFINTransactions(ledger, rows.transactions, startDate);
        ledger = r.merged;
        totals.added += r.added;
        totals.claimed += r.claimed;
        totals.settled += r.settled;
        totals.duplicates += r.duplicates;
        issues.push(...r.issues.map((x) => `${label}: ${x}`));

        const bal = simplefinLocalBalance(local, sf);
        if (bal != null) {
          balances[local.id] = bal;
          if (sf.balanceDate) asOf[local.id] = sf.balanceDate;
          // Never later than now: a bank clock ahead of this one mustn't make its
          // figure outrank one typed a minute ago.
          if (sf.balanceAt) balanceAt[local.id] = sf.balanceAt < syncStartedAt ? sf.balanceAt : syncStartedAt;
        }
        // The import marker only moves for an account that came through cleanly,
        // the same rule the CSV importer follows.
        if (!r.issues.length && !rows.invalid && !errorCovers(sf)) clean.push(local.id);
      }

      const linkedIds = new Set(linked.map((a) => a.simplefin_id).concat(loanLinks.map((l) => l.simplefin_id)));
      const unlinked = data.accounts.filter((a) => !linkedIds.has(a.id));

      // Nothing is written until everything above has succeeded.
      let fundTransfers = 0;
      let goalTransfers = 0;
      // A balance typed after the moment SimpleFIN's figure is from is newer
      // than it, and stays: a bank that hasn't refreshed SimpleFIN in five days
      // mustn't put a five-day-old balance over one entered this morning.
      const keptTyped = [];
      Object.keys(balances).forEach((id) => {
        const local = accounts.find((a) => a && a.id === id);
        if (local && balanceAt[id] && local.balance_source && local.balance_source !== "simplefin" && local.balance_updated_at && local.balance_updated_at > balanceAt[id]) {
          keptTyped.push(local);
          delete balances[id];
          delete asOf[id];
        }
      });
      const loanUpdates = simplefinLoanUpdates(loanLinks, byId, syncStartedAt, { ambiguous: data.ambiguous || [] });
      loanUpdates.refused.forEach((x) => issues.push(`${debtLabel(x.loan)}: ${x.why}. Its balance wasn't changed.`));
      loanUpdates.missing.forEach((l) => issues.push(`${debtLabel(l)}: SimpleFIN didn't include its account. It may have been removed from your SimpleFIN connection.`));
      loanUpdates.kept.forEach((l) => keptTyped.push({ id: l.id, institution: debtLabel(l) }));
      const loansChanged = loanUpdates.updates.filter((u) => Math.abs(u.amount - u.was) >= 0.005).length;
      const balancesChanged = loansChanged + Object.keys(balances).filter((id) => {
        const local = accounts.find((a) => a && a.id === id);
        return !local || local.current_balance == null || Math.abs(round2(Number(local.current_balance)) - balances[id]) >= 0.005;
      }).length;
      if (linked.length) {
        const rules = await readJSON(this.app, FILES.rules, []);
        applyCategorization(ledger, rules);
        wrote = true;
        // After categorising, so it can tell an uncategorised half from one the
        // rules have already filed; before writing, so it lands in this write.
        fundTransfers = await this.pairFundTransfersIn(ledger);
        goalTransfers = await this.assignGoalTransfersIn(ledger);
        await writeJSON(this.app, FILES.transactions, ledger);
        await refreshCategoryUsageOrder(this.app, ledger);
        if (Object.keys(balances).length) await this.applyBalancePatch(balances, { asOf, at: balanceAt, source: "simplefin" });
        if (clean.length) {
          const list = await readJSON(this.app, FILES.accounts, []);
          list.forEach((a) => {
            if (clean.includes(a.id)) a.last_imported_through = today;
          });
          await writeJSON(this.app, FILES.accounts, list);
        }
      }
      if (loanUpdates.updates.length) {
        const plans = await readJSON(this.app, FILES.installmentDebts, []);
        loanUpdates.updates.forEach((u) => {
          const loan = plans.find((d) => d && d.id === u.id);
          if (loan) loan.balance_anchor = { amount: u.amount, date: u.date, at: u.at, source: "simplefin" };
        });
        await writeJSON(this.app, FILES.installmentDebts, plans);
        wrote = true;
        await this.snapshotDebt();
      }
      await this.rememberSimpleFINAccounts(data.accounts, {
        last_sync: { at: new Date().toISOString(), added: totals.added, claimed: totals.claimed }
      });

      const plural = (n, one, many) => `${n} ${n === 1 ? one : many}`;
      let msg;
      if (!linked.length && !loanLinks.length) {
        msg = data.accounts.length
          ? `Found ${plural(data.accounts.length, "SimpleFIN account", "SimpleFIN accounts")}, none linked yet. Link them in Settings → Accounts (Edit → SimpleFIN account), then sync again.`
          : "SimpleFIN didn't report any accounts. Add a bank connection in SimpleFIN Bridge first.";
      } else {
        // Short on purpose: what came in, then only what needs you. Matched CSV
        // rows and filed transfers are housekeeping and go in the details.
        const head = [totals.added ? `Synced ${plural(totals.added, "new transaction", "new transactions")}` : "Synced \u2014 nothing new"];
        if (balancesChanged) head.push(plural(balancesChanged, "balance updated", "balances updated"));
        const lines = [head.join(" \u00b7 ") + "."];
        lines.push(...problems.lines);
        if (keptTyped.length) lines.push(`Kept your newer typed balance for ${keptTyped.map((a) => accountLabel(a)).join(", ")}.`);
        if (unlinked.length) lines.push(`${plural(unlinked.length, "SimpleFIN account isn't", "SimpleFIN accounts aren't")} linked yet.`);
        if (issues.length) lines.push(`${plural(issues.length, "other issue", "other issues")} \u2014 see details.`);
        msg = lines.join("\n");
        if (totals.claimed) notes.push(`Matched ${plural(totals.claimed, "transaction", "transactions")} you'd already imported from CSV instead of adding ${totals.claimed === 1 ? "it" : "them"} again.`);
        if (fundTransfers) notes.push(`Filed ${plural(fundTransfers, "transfer", "transfers")} with a capped fund's account as ${fundTransfers === 1 ? "a transfer" : "transfers"}, so ${fundTransfers === 1 ? "it isn't" : "they aren't"} counted as spending or income.`);
        if (goalTransfers) notes.push(`Added ${plural(goalTransfers, "savings transfer", "savings transfers")} to ${goalTransfers === 1 ? "its goal" : "their goals"}.`);
      }
      new Notice(msg, issues.length || problems.lines.length ? 12000 : 6000);
      if (totals.settled) notes.push(`${plural(totals.settled, "pending charge", "pending charges")} from earlier imports settled into ${totals.settled === 1 ? "its" : "their"} posted form.`);
      if (issues.length) {
        new ImportResultModal(this.app, {
          title: "Sync finished \u2014 needs a look",
          status: "review",
          message: msg,
          notes,
          issues,
          sourceRemoved: false
        }).open();
      }

      await this.refreshAfterDataChange();
      return { ...totals, unlinked: unlinked.length, issues };
    } catch (e) {
      // Past the first write, some of the sync is saved. Running it again is
      // safe — ids stop anything coming in twice, and balances are simply set
      // again — so that's what the message says to do.
      const message = wrote
        ? "It stopped partway through saving. Sync again to finish — nothing will be imported twice."
        : e instanceof SimpleFINError
        ? e.message
        : "Something unexpected went wrong. Nothing was changed.";
      console.error("Budget Tracker: SimpleFIN sync failed —", redactSimpleFIN(e && e.message ? e.message : e));
      new Notice(`SimpleFIN sync failed: ${message}`, 10000);
      if (wrote) await this.refreshAfterDataChange().catch(() => {});
      return { error: message };
    } finally {
      this.syncing = false;
      // A fund saved while this sync ran skipped filing old transfers so as not
      // to race this write. Now it can.
      if (this.fundRelabelPending) {
        this.fundRelabelPending = false;
        try {
          if (await this.relabelFundTransfers()) await this.refreshAfterDataChange();
        } catch (e) {
          console.error("Budget Tracker: filing capped-fund transfers after sync failed \u2014", e && e.message);
        }
      }
      this.refreshAllDashboards();
    }
  }

  async toggleRelocationMode() {
    this.settings.savingsMode = !this.settings.savingsMode;
    await writeJSON(this.app, FILES.settings, this.settings);
    const st = savingsStatus(this.settings);
    new Notice(
      this.settings.savingsMode
        ? `Savings Focus${st && st.days != null ? ` — ${st.days} days to deadline` : ""}. Extra debt payoff paused; surplus routed to savings goals.`
        : "Debt Reduction — surplus goes to principal beyond the minimums.",
      9000
    );
    await this.activateView();
    await this.refreshAfterDataChange();
  }

  // Builds the snapshot, copies the Markdown to the clipboard, and saves it with
  // a CSV copy to Budget/exports (one of each per day; a later export that day
  // replaces them). The files are the fallback when the clipboard can't be
  // written — some mobile builds refuse.
  // Settings → Setup, and the command. Creates whatever's missing, says what it
  // did, and refreshes anything open so it reads the new files.
  async setupFiles() {
    let r;
    try {
      r = await setupBudgetVault(this.app, this.settings);
    } catch (e) {
      console.error("Budget Tracker: setup failed", e);
      new Notice(`Couldn't finish setting up: ${e && e.message ? e.message : e}. Anything already created stays.`, 10000);
      return null;
    }
    const n = r.files.length;
    let msg = n || r.folders.length
      ? `Budget Tracker is set up: created ${n} file${n === 1 ? "" : "s"}` +
        (r.folders.length ? ` and ${r.folders.length} folder${r.folders.length === 1 ? "" : "s"}` : "") +
        (r.kept ? `. ${r.kept} existing file${r.kept === 1 ? " was" : "s were"} left as ${r.kept === 1 ? "it was" : "they were"}.` : ".")
      : "Everything's already in place. Nothing was changed.";
    if (r.starterCategories) msg += " Added a starter set of categories.";
    if (r.unreadable.length) msg += ` ${r.unreadable.length === 1 ? "One file can't" : `${r.unreadable.length} files can't`} be read and ${r.unreadable.length === 1 ? "was" : "were"} left alone: ${r.unreadable.join(", ")}.`;
    new Notice(msg, r.unreadable.length ? 15000 : 7000);
    if (n && typeof this.refreshAfterDataChange === "function") await this.refreshAfterDataChange();
    return r;
  }

  // Opens the export dialog: snapshot, everything, or one kind of data.
  promptExport() {
    new ExportModal(this.app, {
      snapshot: () => this.exportSnapshot(),
      full: () => this.exportEverything(),
      kind: (key) => this.exportKind(key)
    }).open();
  }

  // Saves files under Budget/exports, making any folders they need.
  async writeExportFiles(files) {
    const adapter = this.app.vault.adapter;
    const made = new Set();
    for (const f of files) {
      const parts = `${EXPORT_DIR}/${f.path}`.split("/").slice(0, -1);
      let dir = "";
      for (const p of parts) {
        dir = dir ? `${dir}/${p}` : p;
        if (made.has(dir)) continue;
        if (!(await adapter.exists(dir))) await adapter.mkdir(dir);
        made.add(dir);
      }
      await adapter.write(`${EXPORT_DIR}/${f.path}`, f.content);
    }
  }

  async exportKind(kind) {
    if (kind === "transactions") return this.exportTransactionNotes();
    const label = (EXPORT_KINDS.find((k) => k.key === kind) || {}).label || kind;
    try {
      const data = await readExportData(this.app);
      const files = buildDataNotes(kind, data, { settings: this.settings || {} });
      await this.writeExportFiles(files);
      new Notice(`Exported ${label.toLowerCase()} to ${EXPORT_DIR}.`, 6000);
      return files;
    } catch (e) {
      console.error("Budget Tracker: export failed", e);
      new Notice("Couldn't export \u2014 see the console for details.");
      return null;
    }
  }

  // The snapshot, plus a note for every kind of data.
  async exportEverything() {
    try {
      const snap = await this.exportSnapshot({ copy: false });
      if (!snap || !snap.saved) throw new Error("snapshot not saved");
      const data = await readExportData(this.app);
      const files = buildFullExportNotes(data, { settings: this.settings || {} });
      await this.writeExportFiles(files);
      new Notice(`Full export saved to ${EXPORT_DIR}.`, 6000);
      return files;
    } catch (e) {
      console.error("Budget Tracker: full export failed", e);
      new Notice("Couldn't finish the full export \u2014 see the console for details.");
      return null;
    }
  }

  // Add a transaction by hand, for anyone who'd rather not link or import.
  async promptAddTransaction() {
    const accounts = (await readJSON(this.app, FILES.accounts, [])).filter((a) => a && a.id);
    if (!accounts.length) {
      new Notice("Add an account first.");
      return;
    }
    const rules = await readJSON(this.app, FILES.rules, []);
    const all = await readJSON(this.app, FILES.transactions, []);
    const meta = await readJSON(this.app, FILES.categories, []);
    const categories = sortCategoriesByUse(collectCategories(rules, all, meta).map((c) => c.name));
    new ManualTransactionModal(this.app, { accounts, categories, rules }, async (tx) => {
      const fresh = await readJSON(this.app, FILES.transactions, []);
      fresh.push(tx);
      await writeJSON(this.app, FILES.transactions, fresh);
      const acct = accounts.find((a) => a.id === tx.account_id);
      new Notice(`Added ${snapshotMoney(tx.amount)} to ${accountLabel(acct) || "your account"}.`);
      await this.refreshAfterDataChange();
    }).open();
  }

  // Type in what an investment account is worth, without a statement.
  async promptAddInvestmentBalance() {
    const accounts = await this.loadPortfolioAccounts();
    if (!accounts.length) {
      new Notice("Add an investment account first.");
      return;
    }
    new ManualBalanceModal(this.app, { accounts }, async (snapshot) => {
      const list = await readJSON(this.app, FILES.portfolioSnapshots, []);
      const place = pfPlaceSnapshot(list, snapshot);
      const save = async () => {
        const fresh = await readJSON(this.app, FILES.portfolioSnapshots, []);
        const again = pfPlaceSnapshot(fresh, snapshot);
        if (again.index >= 0) fresh[again.index] = snapshot;
        else fresh.push(snapshot);
        fresh.sort((a, b) => (a.statement_end < b.statement_end ? -1 : 1));
        await writeJSON(this.app, FILES.portfolioSnapshots, fresh);
        new Notice("Balance saved.");
        this.refreshDashboard();
      };
      if (place.status === "same") {
        new Notice("That balance is already saved.");
        return;
      }
      if (place.status === "replace") {
        const old = list[place.index];
        new ConfirmModal(this.app, {
          title: "Replace the saved balance?",
          body: `There's already one for ${snapshot.statement_end}: $${round2(old.ending_value).toFixed(2)} \u2192 $${round2(snapshot.ending_value).toFixed(2)}.`,
          confirmText: "Replace",
          onConfirm: save
        }).open();
        return;
      }
      await save();
    }).open();
  }

  // Writes the transaction notes into Budget/exports/Transactions.
  async exportTransactionNotes() {
    try {
      const transactions = await readJSON(this.app, FILES.transactions, []);
      const accounts = await readJSON(this.app, FILES.accounts, []);
      const files = buildTransactionNotes(transactions, accounts);
      const adapter = this.app.vault.adapter;
      for (const dir of [EXPORT_DIR.split("/")[0], EXPORT_DIR, TX_NOTES_DIR]) {
        if (!(await adapter.exists(dir))) await adapter.mkdir(dir);
      }
      for (const f of files) await adapter.write(`${TX_NOTES_DIR}/${f.name}.md`, f.content);
      const months = files.filter((f) => /^Transactions \d{4}-\d{2}$/.test(f.name)).length;
      new Notice(`Exported ${transactions.length} transaction${transactions.length === 1 ? "" : "s"} to ${TX_NOTES_DIR} (${months} month${months === 1 ? "" : "s"}).`, 6000);
      return { files, months };
    } catch (e) {
      console.error("Budget Tracker: transaction export failed", e);
      new Notice("Couldn't export the transactions \u2014 see the console for details.");
      return null;
    }
  }

  // `copy: false` is for a full export, which only saves.
  async exportSnapshot({ copy = true } = {}) {
    let built;
    try {
      built = await generateFinancialSnapshot(this.app, this.settings || {});
    } catch (e) {
      console.error("Budget Tracker: snapshot failed", e);
      new Notice("Couldn't build the financial snapshot — see the console for details.");
      return null;
    }
    const base = `${EXPORT_DIR}/Snapshot - ${built.snapshot.date}`;
    let saved = false;
    try {
      const adapter = this.app.vault.adapter;
      const root = EXPORT_DIR.split("/")[0];
      if (!(await adapter.exists(root))) await adapter.mkdir(root);
      if (!(await adapter.exists(EXPORT_DIR))) await adapter.mkdir(EXPORT_DIR);
      await adapter.write(`${base}.md`, built.markdown);
      await adapter.write(`${base}.csv`, built.csv);
      saved = true;
    } catch (e) {
      console.error("Budget Tracker: couldn't save the snapshot files", e);
    }
    let copied = false;
    try {
      const clip = copy && typeof navigator !== "undefined" && navigator.clipboard;
      if (clip && typeof clip.writeText === "function") {
        await clip.writeText(built.markdown);
        copied = true;
      }
    } catch (e) {
      copied = false;
    }
    if (!copy) return Object.assign({ copied: false, saved, path: saved ? base : null }, built);
    new Notice(
      copied
        ? `Financial snapshot copied to clipboard!${saved ? ` Saved to ${base}.md and .csv.` : ""}`
        : saved
          ? `Couldn't reach the clipboard — the snapshot is saved to ${base}.md (and .csv).`
          : "Couldn't copy or save the snapshot.",
      5000
    );
    return Object.assign({ copied, saved, path: saved ? base : null }, built);
  }

  async promptPortfolioImport() {
    new PortfolioImportModal(this.app, this, () => this.refreshDashboard()).open();
  }

  // Investment accounts are the user's own, kept in portfolio_accounts.json and
  // deliberately separate from FILES.accounts — they are never reconciled
  // against cash balances. A missing file is rebuilt from what existing
  // snapshots point at (a vault from before accounts were editable); an empty
  // one stays empty, because that's someone who deleted them all.
  async loadPortfolioAccounts() {
    const stored = await readJSON(this.app, FILES.portfolioAccounts, null);
    if (Array.isArray(stored)) return normalizePortfolioAccounts(stored);
    const snapshots = await readJSON(this.app, FILES.portfolioSnapshots, []);
    const seeded = seedPortfolioAccounts(snapshots);
    await writeJSON(this.app, FILES.portfolioAccounts, seeded);
    return normalizePortfolioAccounts(seeded);
  }

  async ensurePortfolioAccounts() {
    return this.loadPortfolioAccounts();
  }

  // Adds or replaces one account, by id.
  async savePortfolioAccount(account) {
    const list = await this.loadPortfolioAccounts();
    const i = list.findIndex((a) => a.id === account.id);
    if (i >= 0) list[i] = account;
    else list.push(account);
    await writeJSON(this.app, FILES.portfolioAccounts, list);
    return account;
  }

  async promptPortfolioAccount(existing, onDone, prefill = null, onCancel = null) {
    const others = await this.loadPortfolioAccounts();
    const modal = new PortfolioAccountModal(this.app, { existing, prefill, others, onCancel }, async (account) => {
      // Checked again against the file: two forms open at once each checked a
      // list read before the other saved.
      const now = await this.loadPortfolioAccounts();
      const clash = now.find((o) => o.id !== account.id && o.label.toLowerCase() === account.label.toLowerCase());
      if (clash) {
        new Notice(`There's already an account called ${clash.label}. Nothing was saved.`);
        if (onCancel) onCancel();
        return;
      }
      await this.savePortfolioAccount(account);
      new Notice(`${existing ? "Updated" : "Added"} ${account.label}.`);
      if (onDone) await onDone(account);
      await this.refreshDashboard();
    });
    modal.open();
  }

  // Removing an account removes its statements with it — they'd otherwise sit
  // in the file belonging to nothing, and come back if an account were ever
  // given the same id.
  async deletePortfolioAccount(account) {
    const list = await this.loadPortfolioAccounts();
    await writeJSON(this.app, FILES.portfolioAccounts, list.filter((a) => a.id !== account.id));
    const snaps = await readJSON(this.app, FILES.portfolioSnapshots, []);
    const kept = snaps.filter((s) => s.account_id !== account.id);
    if (kept.length !== snaps.length) await writeJSON(this.app, FILES.portfolioSnapshots, kept);
    new Notice(`Deleted ${account.label}${kept.length !== snaps.length ? ` and its ${snaps.length - kept.length} statement(s)` : ""}.`);
    await this.refreshDashboard();
  }

  async promptQuickBalance() {
    const accounts = await readJSON(this.app, FILES.accounts, []);
    new QuickBalanceModal(this.app, accounts, async (patch) => {
      await this.applyBalancePatch(patch);
      new Notice("Balances updated.");
      await this.refreshAfterDataChange();
    }).open();
  }

  // One path for "these accounts now have these balances", whether typed into
  // the quick editor or reported by a bank feed. A card balance is the same fact
  // the Debts tab reports, so the card is re-anchored rather than left with two
  // figures; checking drives the period's cash on hand, so that moves too.
  // `asOf` is one date for every account, or a map of account id to date.
  // `source` is "simplefin" for a sync and "manual" for anything typed; each
  // account written is stamped with it and the moment the figure is from (see
  // stampBalance), which is how the pay period knows its own copy of checking
  // is out of date. `at` is that moment — SimpleFIN's balance time, one per
  // account — and is now for anything typed. Stamping a sync's figures with
  // the time of the sync let a bank's five-day-old balance pass for newer than
  // one typed that morning.
  async applyBalancePatch(patch, { asOf = null, at = null, source = "manual" } = {}) {
    const list = await readJSON(this.app, FILES.accounts, []);
    const dateFor = (id) => (asOf && typeof asOf === "object" ? asOf[id] || null : asOf) || todayLocal();
    const now = new Date().toISOString();
    const stampFor = (id) => (at && typeof at === "object" ? at[id] || null : at) || now;
    list.forEach((a) => {
      if (patch[a.id] != null) {
        a.current_balance = patch[a.id];
        // When the figure is from. A capped fund shows it, because it claims to
        // be the account's live balance and a stale one should look stale.
        a.balance_as_of = dateFor(a.id);
        stampBalance(a, source, stampFor(a.id));
      }
    });
    await writeJSON(this.app, FILES.accounts, list);

    for (const a of list) {
      if (a.type === "credit_card" && patch[a.id] != null) {
        await reanchorCardBalance(this.app, a.id, patch[a.id], asOf && typeof asOf === "object" ? asOf[a.id] || null : asOf);
      }
    }

    // The period's cash on hand follows at once; recalculate would catch it up
    // anyway, but callers that don't recalculate still see the new figure.
    if (this.lastPaycheckInputs) adoptCashBalance(this.lastPaycheckInputs, list, await readJSON(this.app, FILES.transactions, []));
    return list;
  }


  // Takes a payment that needs matching straight to the modal that can record
  // it, with the transaction already in the list rather than leaving the user to
  // find it again.
  //
  // `obligation` is the Overview's suggestion and is usually ABSENT: it only
  // exists when one open obligation happens to match the amount to the cent. The
  // ordinary case is six BNPL plans that all take payments in the same category,
  // where the category cannot possibly decide which one was paid.
  //
  // So the rule is: go straight through when there is exactly one thing this
  // could be, and otherwise ASK. What it must never do is give up. An earlier
  // version bounced the user to the Debts tab with a notice whenever the answer
  // was ambiguous, which is the normal case, and is why the whole match window
  // looked non-functional.
  async startMatchFlow(tx, obligation, periodObligations = []) {
    const kind = (obligation && obligation.source) || (tx && tx.class) || null;
    const category = (tx && (tx.resolved_category || tx.category)) || "";
    const amountOf = Math.abs(Number(tx && tx.amount) || 0);

    if (kind === "subscription") {
      new Notice(
        "Subscriptions settle themselves once the charge posts — there's nothing to match.",
        7000
      );
      return;
    }

    // ---- a bill ----------------------------------------------------------
    if (kind === "fixed_expense") {
      const expenses = await readJSON(this.app, FILES.fixedExpenses, []);
      const dueDateOf = (e) => {
        const hit = (periodObligations || []).find(
          (o) => o && o.source === "fixed_expense" && o.ref === (e.id || e.name)
        );
        return (
          (hit && hit.dueDate) || (obligation && obligation.dueDate) || (tx && tx.date) || todayLocal()
        );
      };

      let expense = obligation ? expenses.find((e) => (e.id || e.name) === obligation.ref) : null;
      if (!expense) {
        const norm = (v) => String(v || "").toLowerCase().replace(/[^a-z0-9]/g, "");
        const byCategory = expenses.filter(
          (e) => e && (e.payment_category === category || (category && norm(e.name) === norm(category)))
        );
        const options = byCategory.length ? byCategory : expenses;
        if (options.length === 1) expense = options[0];
        else if (options.length > 1) {
          new PickObligationModal(
            this.app,
            {
              tx,
              rules: await readJSON(this.app, FILES.rules, []),
              title: "Which bill did this pay?",
              options: options
                .map((e) => ({
                  source: "fixed_expense",
                  ref: e.id || e.name,
                  label: e.name,
                  sublabel: `due ${dueDateOf(e)}`,
                  amount: e.amount != null ? e.amount : null,
                  _expense: e
                }))
                .sort((a, b) => {
                  const da = a.amount == null ? Infinity : Math.abs(Math.abs(a.amount) - amountOf);
                  const db = b.amount == null ? Infinity : Math.abs(Math.abs(b.amount) - amountOf);
                  return da - db;
                })
            },
            async (opt) => {
              await this.openMarkPaidFor(opt._expense, dueDateOf(opt._expense), tx);
            }
          ).open();
          return;
        }
      }

      if (expense) {
        await this.openMarkPaidFor(expense, dueDateOf(expense), tx);
        return;
      }
      new Notice(
        "There's no bill set up for this yet — add it under Fixed expenses and it'll match from then on.",
        9000
      );
      return;
    }

    // ---- a debt ----------------------------------------------------------
    const revolving = await readJSON(this.app, FILES.revolvingDebts, []);
    const installment = await readJSON(this.app, FILES.installmentDebts, []);
    const allDebts = revolving.concat(installment);

    let debt = obligation ? allDebts.find((d) => debtKey(d) === obligation.ref) : null;
    if (!debt) {
      const byCategory = allDebts.filter(
        (d) => d && d.payment_category && d.payment_category === category
      );
      const options = byCategory.length ? byCategory : allDebts;
      if (options.length === 1) debt = options[0];
      else if (options.length > 1) {
        const dueOf = (d) => d.next_due_date || d.due_date || "";
        const owedOf = (d) => {
          const v = isRevolvingDebt(d) ? d.minimum_payment : d.installment_amount;
          return v != null ? v : null;
        };
        new PickObligationModal(
          this.app,
          {
            tx,
            rules: await readJSON(this.app, FILES.rules, []),
            title: "Which debt did this pay?",
            options: options
              .map((d) => ({
                source: "debt",
                ref: debtKey(d),
                label: debtLabel(d),
                sublabel: dueOf(d) ? `next due ${dueOf(d)}` : "",
                amount: owedOf(d),
                _debt: d
              }))
              .sort((a, b) => {
                const da = a.amount == null ? Infinity : Math.abs(Math.abs(a.amount) - amountOf);
                const db = b.amount == null ? Infinity : Math.abs(Math.abs(b.amount) - amountOf);
                if (Math.abs(da - db) > 0.005) return da - db;
                return (a.sublabel || "") < (b.sublabel || "") ? -1 : 1;
              })
          },
          async (opt) => {
            await this.openApplyPaymentFor(opt._debt, tx);
          }
        ).open();
        return;
      }
    }

    if (!debt) {
      new Notice("There are no debts set up to apply this to yet.", 7000);
      return;
    }
    await this.openApplyPaymentFor(debt, tx);
  }

  // Mark Paid, opened on one specific bill with the transaction already chosen.
  async openMarkPaidFor(expense, dueDateStr, tx) {
    if (!expense) return;
    const ref = expense.id || expense.name;
    const rules = await readJSON(this.app, FILES.rules, []);
    new MarkPaidModal(
      this.app,
      expense,
      dueDateStr || (tx && tx.date) || todayLocal(),
      async (paidForDate, picked) => {
        const all = await readJSON(this.app, FILES.fixedExpenses, []);
        const idx = all.findIndex((e) => (e.id || e.name) === ref);
        if (idx < 0) return;
        recordFixedPayment(all[idx], paidForDate, picked || tx);
        await writeJSON(this.app, FILES.fixedExpenses, all);
        new Notice(`"${expense.name}" marked paid.`);
        await this.recalculate();
      },
      this,
      rules
    ).open();
  }

  // Apply Payment, opened on one specific debt, with the transaction the user
  // came here to match guaranteed to be in the list even when it falls outside
  // the window the list normally uses.
  async openApplyPaymentFor(debt, tx) {
    if (!debt) return;
    const isCard = isRevolvingDebt(debt);
    const kind = isCard ? "cc" : "bnpl";
    const transactions = await readJSON(this.app, FILES.transactions, []);
    const rules = await readJSON(this.app, FILES.rules, []);
    const categoryMeta = await readJSON(this.app, FILES.categories, []);
    const goals = await readJSON(this.app, FILES.savingsGoals, []);
    const fixedExpenses = await readJSON(this.app, FILES.fixedExpenses, []);
    const revolving = await readJSON(this.app, FILES.revolvingDebts, []);
    const installment = await readJSON(this.app, FILES.installmentDebts, []);
    const allDebts = revolving.concat(installment);

    // Built through completeOwnership so this list can't be weaker than the one
    // the Debts tab shows. Without rules and subscription keys, a kept
    // subscription charge isn't recognised as subscription money here, reads as
    // ordinary spending, and ordinary spending is the one class every obligation
    // accepts — so it turns up as a candidate for paying down a debt.
    const ownership = completeOwnership({
      fixedExpenses,
      installmentDebts: installment,
      revolvingDebts: revolving,
      goals,
      categoryMeta,
      rules,
      subscriptionKeys: await this.keptSubscriptionKeys(transactions, rules)
    });

    const candidates = candidatePayments(debt, transactions, allDebts, categoryMeta, ownership);
    if (tx && tx.id && !candidates.some((c) => c.id === tx.id)) {
      const full = transactions.find((t) => t && t.id === tx.id);
      if (full) candidates.unshift(full);
    }

    new ApplyPaymentModal(
      this.app,
      debt,
      candidates,
      async (picked, opts = {}) => {
        const file = isCard ? FILES.revolvingDebts : FILES.installmentDebts;
        const list = await readJSON(this.app, file, []);
        const idx = list.findIndex((d) => debtKey(d) === debtKey(debt));
        if (idx < 0) return;
        list[idx].applied_payments = (list[idx].applied_payments || []).concat(
          picked.map((p) => Object.assign({ tx_id: p.id, amount: Math.abs(p.amount), date: p.date, applied_on: todayLocal() }, opts.extra ? { extra: true } : {}))
        );
        const advanced = advanceDueDateIfCovered(list[idx], kind);
        await writeJSON(this.app, file, list);
        const sum = picked.reduce((acc, p) => acc + Math.abs(p.amount), 0);
        new Notice(
          `Applied $${sum.toFixed(2)} to ${debtLabel(debt)}.` +
            (advanced ? ` Installment covered — next due ${advanced}.` : ""),
          9000
        );
        await this.snapshotDebt();
        await this.refreshAfterDataChange();
      },
      rules,
      categoryMeta,
      async () => {
        await this.refreshAfterDataChange();
      },
      transactions
    ).open();
  }

  async promptEnterPaycheck() {
    const txs = await readJSON(this.app, FILES.transactions, []);
    const accounts = await readJSON(this.app, FILES.accounts, []);
    const rules = await readJSON(this.app, FILES.rules, []);
    const checkingAcct = cashAccount(accounts);
    const today = todayLocal();
    const schedule = resolvePaySchedule(this.settings, txs);
    const cadence = schedule && PAY_CADENCES[schedule.cadence];
    const prefill = {
      detectedPaycheck: findLatestPaycheck(txs),
      checkingBalance: checkingAcct ? checkingAcct.current_balance : null,
      recentDeposits: paycheckDepositCandidates(txs, accounts, { schedule, todayStr: today }),
      rules,
      scheduledNextPayday: schedule ? nextPaydayFrom(schedule, today) : null,
      scheduleLabel: cadence ? `${cadence.label.toLowerCase()}${schedule.inferred ? ", detected from your paychecks" : ""}` : ""
    };

    new PaycheckModal(
      this.app,
      async ({ paycheckAmount, checkingBalance, alreadyDeposited, nextPaydayStr, deposit }) => {
        // Filed before anything reads the ledger: pay-schedule detection and
        // the income figures both go by Paycheck-labelled deposits.
        const ledger = (deposit && (await this.labelPaycheckDeposit(deposit))) || txs;
        // The period runs payday → payday, not entry-date → payday. Using the
        // day the paycheck happened to be entered orphans everything that
        // landed earlier in the period, including the paycheck itself.
        const sched = resolvePaySchedule(this.settings, ledger);
        const periodStartStr = (sched && currentPeriodStart(sched, todayLocal())) || todayLocal();
        // Grab the outgoing period before it's replaced — its unspent allowance
        // is the sweep candidate, and it's unreachable once this is overwritten.
        const closingPeriod = this.lastPaycheckInputs;
        // Left at the prefilled figure, it's still the account's balance, with
        // the account's own stamp; typed over, it's newer than that, until the
        // next sync or balance update is newer still.
        const kept = checkingAcct && checkingAcct.current_balance != null && round2(Number(checkingAcct.current_balance)) === round2(Number(checkingBalance));
        this.lastPaycheckInputs = {
          paycheckAmount,
          checkingBalance,
          alreadyDeposited,
          nextPaydayStr,
          periodStartStr,
          enteredOn: todayLocal(),
          checkingAccountId: checkingAcct ? checkingAcct.id : null,
          checkingBalanceAt: kept && checkingAcct.balance_updated_at ? checkingAcct.balance_updated_at : new Date().toISOString(),
          checkingBalanceSource: kept ? checkingAcct.balance_source || null : "paycheck"
        };

        const history = await readJSON(this.app, FILES.paycheckHistory, []);
        history.push({ date: periodStartStr, amount: paycheckAmount, alreadyDeposited, nextPaydayStr });
        await writeJSON(this.app, FILES.paycheckHistory, history);

        await this.activateView();
        const result = await this.recalculate();
        if (result) new Notice(`Free cash this period: $${result.freeCash.toFixed(2)}`);
        await this.offerBufferSweep(closingPeriod, periodStartStr);
      },
      prefill
    ).open();
  }

  // The deposit picked in Enter Paycheck is the paycheck, so it's filed as one —
  // for that transaction only, the same as labelling it by hand. Returns the
  // updated ledger, or null if nothing changed.
  async labelPaycheckDeposit(tx) {
    const all = await readJSON(this.app, FILES.transactions, []);
    const idx = findTxIndex(all, tx);
    if (idx < 0) {
      new Notice("Couldn't find that deposit any more, so it wasn't labelled. The paycheck was still entered.", 8000);
      return null;
    }
    if (all[idx].resolved_category === "Paycheck") return null;
    all[idx].override_label = "Paycheck";
    applyCategorization(all, await readJSON(this.app, FILES.rules, []));
    await writeJSON(this.app, FILES.transactions, all);
    new Notice(`Filed the $${all[idx].amount.toFixed(2)} deposit on ${all[idx].date} as Paycheck.`);
    return all;
  }

  // Works out what the just-closed period actually had left of its spending
  // allowance. Recomputed from that period's own boundaries rather than read off
  // the last dashboard result, so transactions that imported after the dashboard
  // was last open are included.
  async closingBufferState(inputs) {
    if (!inputs) return null;
    const periodStart = inputs.periodStartStr || inputs.todayStr;
    const periodEnd = inputs.nextPaydayStr;
    const allocation = inputs.bufferAllocation;
    if (!periodStart || !periodEnd) return null;
    // No snapshot means the period ran entirely before this feature existed.
    // Inventing an allowance retroactively would be guesswork, so it's skipped.
    if (!allocation || typeof allocation.amount !== "number" || !isFinite(allocation.amount)) return null;

    const transactions = await readJSON(this.app, FILES.transactions, []);
    const rules = await readJSON(this.app, FILES.rules, []);
    const reviews = await readJSON(this.app, FILES.subscriptionReviews, []);
    const auditRows = buildSubscriptionAudit(transactions, reviews, rules);
    const goalsNow = await readJSON(this.app, FILES.savingsGoals, []);

    const spending = classifyBufferSpending({
      transactions,
      outsideAllowance: fundAccountIds(goalsNow),
      periodStartStr: periodStart,
      nextPaydayStr: periodEnd,
      categoryMeta: await readJSON(this.app, FILES.categories, []),
      fixedExpenses: await readJSON(this.app, FILES.fixedExpenses, []),
      installmentDebts: await readJSON(this.app, FILES.installmentDebts, []),
      revolvingDebts: await readJSON(this.app, FILES.revolvingDebts, []),
      subscriptionKeys: auditRows.filter((s) => s.status === "keep").map((s) => s.key),
      rules,
      goals: await readJSON(this.app, FILES.savingsGoals, [])
    });

    const allocated = round2(allocation.amount);
    const spent = spending.spent;
    return {
      periodStart,
      periodEnd,
      allocated,
      spent,
      remaining: round2(Math.max(0, allocated - spent)),
      overrun: round2(Math.max(0, spent - allocated))
    };
  }

  // How many paychecks each dated goal has left before its deadline. Shared by
  // recalculate and the sweep so both pace goals identically.
  async goalPaychecksMap(goals, fromDateStr, transactions) {
    const schedule = resolvePaySchedule(this.settings, transactions || []);
    const out = {};
    // Only a goal's own date paces it; the global deadline is a countdown, and a
    // capped fund has no date at all.
    regularGoals(goals).forEach((g) => {
      const target = g.target_date;
      if (!target) return;
      const list = paydaysBetween(schedule, fromDateStr, target);
      if (list) out[g.id] = list.length;
    });
    return out;
  }

  // ---------- capped funds ----------

  // Pairs and files transfers with capped funds' accounts, in a ledger that is
  // about to be written. The caller writes it; this only changes it. Returns how
  // many transfers were filed.
  async pairFundTransfersIn(ledger) {
    const goals = await readJSON(this.app, FILES.savingsGoals, []);
    if (!cappedFunds(goals).length) return 0;
    const categories = await readJSON(this.app, FILES.categories, []);
    const accounts = await readJSON(this.app, FILES.accounts, []);
    const debts = (await readJSON(this.app, FILES.revolvingDebts, [])).concat(await readJSON(this.app, FILES.installmentDebts, []));
    const debtCategories = debts.map((d) => d && d.payment_category).filter(Boolean);
    const pairs = pairFundTransfers(ledger, goals, categories, { accounts, debtCategories });
    if (!pairs.length) return 0;
    // The category has to count as a transfer before anything is filed under
    // it. Done first, so a write that fails after it leaves an unused transfer
    // category rather than transfers filed under one that counts as spending.
    const cat = fundTransferCategory(categories);
    if (cat.create && pairs.some((p) => p.category === cat.name)) await setCategoryTransfer(this.app, cat.name, true);
    return applyFundTransferPairs(ledger, pairs);
  }

  // ---------- transfers between your own accounts ----------

  // Confirms suggested pairs ([{ outId, inId }]): both halves filed as a
  // transfer and paired. Returns how many.
  async confirmTransfers(pairs) {
    const ledger = await readJSON(this.app, FILES.transactions, []);
    const accounts = await readJSON(this.app, FILES.accounts, []);
    const revolvingDebts = await readJSON(this.app, FILES.revolvingDebts, []);
    const categoryMeta = await readJSON(this.app, FILES.categories, []);
    const byId = new Map(ledger.filter((t) => t && t.id).map((t) => [t.id, t]));
    const created = new Set();
    let n = 0;
    for (const { outId, inId } of pairs || []) {
      const rows = [byId.get(outId), byId.get(inId)];
      if (rows.some((t) => !t)) continue;
      const cat = transferCategoryFor(rows, { accounts, revolvingDebts, categoryMeta });
      if (cat.create && !created.has(cat.name)) {
        // The category counts as a transfer before anything is filed under it.
        await setCategoryTransfer(this.app, cat.name, true);
        categoryMeta.push({ name: cat.name, is_transfer: true });
        created.add(cat.name);
      }
      if (confirmTransferPair(ledger, outId, inId, cat.name)) n++;
    }
    if (n) await writeJSON(this.app, FILES.transactions, ledger);
    return n;
  }

  // "Not a transfer": these two are never suggested together again.
  async dismissTransferPair(outId, inId) {
    const ledger = await readJSON(this.app, FILES.transactions, []);
    const o = ledger.find((t) => t && t.id === outId);
    const i = ledger.find((t) => t && t.id === inId);
    if (!o || !i) return false;
    o.not_transfer_with = [...new Set((o.not_transfer_with || []).concat(i.id))];
    i.not_transfer_with = [...new Set((i.not_transfer_with || []).concat(o.id))];
    await writeJSON(this.app, FILES.transactions, ledger);
    return true;
  }

  // One row you say is a transfer, from the label window. Its other half may
  // not be in the plugin at all (an account that doesn't sync), so it's filed
  // and kept off the list on its own; if a matching half is here or turns up,
  // the pair is suggested for you to confirm like any other.
  async markTransfer(txId) {
    const ledger = await readJSON(this.app, FILES.transactions, []);
    const t = ledger.find((x) => x && x.id === txId);
    if (!t) return null;
    const cat = transferCategoryFor([t], {
      accounts: await readJSON(this.app, FILES.accounts, []),
      revolvingDebts: await readJSON(this.app, FILES.revolvingDebts, []),
      categoryMeta: await readJSON(this.app, FILES.categories, [])
    });
    if (cat.create) await setCategoryTransfer(this.app, cat.name, true);
    fileAsTransfer(t, cat.name);
    t.transfer_single = true;
    await writeJSON(this.app, FILES.transactions, ledger);
    return cat.name;
  }

  // "Not a transfer" on a confirmed one: back on the list as it was.
  async undoTransferRow(txId) {
    const ledger = await readJSON(this.app, FILES.transactions, []);
    const rows = undoTransfer(ledger, txId);
    if (!rows.length) return 0;
    applyCategorization(ledger, await readJSON(this.app, FILES.rules, []));
    await writeJSON(this.app, FILES.transactions, ledger);
    return rows.length;
  }

  // ---------- goals linked to a savings account ----------

  // Puts the transfers the rules settle (goalTransferQueue's `auto`) on their
  // goals, in a ledger that is about to be written; the caller writes it. The
  // goals are written here, first: a contribution linked to a row that then
  // fails to save is found again by id at the next import, while a row filed
  // without its contribution would just look handled. Returns how many.
  async assignGoalTransfersIn(ledger) {
    const goals = await readJSON(this.app, FILES.savingsGoals, []);
    if (!accountGoals(goals).length) return 0;
    const { auto } = goalTransferQueue(ledger, goals);
    if (!auto.length) return 0;
    const categories = await readJSON(this.app, FILES.categories, []);
    const cat = fundTransferCategory(categories);
    let n = 0;
    auto.forEach((a) => {
      if (assignGoalTransfer(goals, a.tx, a.goalId, a.contributionId)) {
        fileGoalTransferRow(a.tx, cat.name);
        n++;
      }
    });
    if (!n) return 0;
    if (cat.create) await setCategoryTransfer(this.app, cat.name, true);
    await writeJSON(this.app, FILES.savingsGoals, goals);
    return n;
  }

  // The same over the whole ledger — when a goal is linked to an account, or
  // starts counting from an earlier date, so transfers already imported count.
  async assignGoalTransfersNow() {
    const ledger = await readJSON(this.app, FILES.transactions, []);
    const n = await this.assignGoalTransfersIn(ledger);
    if (n) await writeJSON(this.app, FILES.transactions, ledger);
    return n;
  }

  // Your answer for one transfer: a goal's id, or null for "not for a goal".
  async answerGoalTransfer(txId, goalId) {
    const ledger = await readJSON(this.app, FILES.transactions, []);
    const tx = ledger.find((t) => t && t.id === txId);
    if (!tx) return null;
    if (!goalId) {
      tx.goal_skip = true;
      delete tx.goal_review;
      await writeJSON(this.app, FILES.transactions, ledger);
      return { skipped: true };
    }
    const goals = await readJSON(this.app, FILES.savingsGoals, []);
    const done = assignGoalTransfer(goals, tx, goalId);
    if (!done) return null;
    const categories = await readJSON(this.app, FILES.categories, []);
    const cat = fundTransferCategory(categories);
    if (cat.create) await setCategoryTransfer(this.app, cat.name, true);
    await writeJSON(this.app, FILES.savingsGoals, goals);
    fileGoalTransferRow(tx, cat.name);
    await writeJSON(this.app, FILES.transactions, ledger);
    return done;
  }

  // Undoing an assignment puts the row back in front of you, flagged so the
  // next sync asks rather than quietly assigning it again. `skip` instead marks
  // rows as not for any goal (a deleted goal's transfers). Rows outside the
  // goal-linked accounts are left alone.
  async releaseGoalTransfers(txIds, { skip = false } = {}) {
    const ids = new Set((txIds || []).filter(Boolean));
    if (!ids.size) return 0;
    const goals = await readJSON(this.app, FILES.savingsGoals, []);
    const accountIds = new Set(accountGoals(goals).map((g) => g.account_id));
    const ledger = await readJSON(this.app, FILES.transactions, []);
    let n = 0;
    ledger.forEach((t) => {
      if (!t || !ids.has(t.id) || !accountIds.has(t.account_id)) return;
      if (skip) {
        t.goal_skip = true;
        delete t.goal_review;
      } else {
        t.goal_review = true;
        delete t.goal_skip;
      }
      n++;
    });
    if (n) await writeJSON(this.app, FILES.transactions, ledger);
    return n;
  }

  // The same, over the whole ledger as it stands — for when a fund is created
  // or pointed at another account, and transfers already imported should be
  // filed without waiting for the next import.
  async relabelFundTransfers() {
    const ledger = await readJSON(this.app, FILES.transactions, []);
    const n = await this.pairFundTransfersIn(ledger);
    if (n) await writeJSON(this.app, FILES.transactions, ledger);
    return n;
  }

  // What a capped fund can be bound to. Its balance has to follow the account,
  // so only accounts that sync through SimpleFIN qualify, plus SimpleFIN
  // accounts not yet added here (choosing one adds it). Checking and cards are
  // left out: checking is the cash the budget already counts, and a card
  // balance is debt, not savings.
  async fundAccountChoices(fund = null) {
    const accounts = await readJSON(this.app, FILES.accounts, []);
    const goals = await readJSON(this.app, FILES.savingsGoals, []);
    const cache = await readJSON(this.app, FILES.simplefinAccounts, {});
    const connected = this.hasSimpleFINConnection();
    const takenBy = new Map(
      cappedFunds(goals)
        .filter((f) => !fund || f.id !== fund.id)
        .map((f) => [f.account_id, f.name])
    );
    const money = (v) => (v != null && Number.isFinite(Number(v)) ? ` \u00b7 $${formatMoneyInput(Number(v))}` : "");
    const choices = [];
    const linked = new Set();
    const unlinkedLocal = [];
    accounts.forEach((a) => {
      if (a.simplefin_id) linked.add(a.simplefin_id);
      const current = !!fund && fund.account_id === a.id;
      const spendable = a.type === "checking" || a.type === "credit_card";
      if (!spendable && !a.simplefin_id && !current) unlinkedLocal.push(accountLabel(a));
      if (!current && (spendable || !a.simplefin_id)) return;
      const taken = takenBy.get(a.id) || null;
      choices.push({
        value: `local:${a.id}`,
        label:
          `${accountLabel(a)}${money(a.current_balance)}` +
          (a.simplefin_id ? "" : " (doesn't sync)") +
          (taken ? ` (used by ${taken})` : ""),
        takenBy: taken
      });
    });
    // Adding a SimpleFIN account here is only offered when nothing already in
    // your accounts could be the same one. A savings account kept by CSV and
    // not linked yet may well be it, and adding it again would import its whole
    // history a second time under a new name. Linking it (Settings → Accounts)
    // is the path that recognises what's already imported.
    if (connected && !unlinkedLocal.length) {
      (cache.accounts || []).forEach((sf) => {
        if (!sf || !sf.id || linked.has(sf.id)) return;
        if (sf.currency && sf.currency !== "USD") return;
        // A savings account below zero is almost certainly a card reported the
        // usual way; it can't back a fund.
        if (sf.balance != null && Number(sf.balance) < 0) return;
        choices.push({ value: `sf:${sf.id}`, label: `${simplefinAccountLabel(sf)} \u2014 adds it to your accounts`, simplefin: sf });
      });
    }
    // An edit whose account was deleted still has to show something selected.
    if (fund && fund.account_id && !choices.some((c) => c.value === `local:${fund.account_id}`)) {
      choices.unshift({ value: `local:${fund.account_id}`, label: `${fund.account_id} (no longer in your accounts)`, missing: true });
    }
    return { choices, connected, unlinkedLocal: connected ? unlinkedLocal : [] };
  }


  async promptCappedFund(existing = null, onDone = null) {
    const { choices, connected, unlinkedLocal } = await this.fundAccountChoices(existing);
    new CappedFundModal(
      this.app,
      {
        existing,
        choices,
        connected,
        unlinkedLocal,
        openBankSync: () => this.openSettings({ focus: "simplefin" })
      },
      async (data) => {
        const saved = await this.saveCappedFund(existing, data, choices);
        if (saved && onDone) await onDone(saved);
      }
    ).open();
  }

  // Creates or updates a capped fund. Choosing a SimpleFIN account that isn't
  // in the plugin yet adds it as a savings account first, linked to that feed.
  async saveCappedFund(existing, data, choices = []) {
    const choice = String(data.choice || "");
    const goals = await readJSON(this.app, FILES.savingsGoals, []);
    const accounts = await readJSON(this.app, FILES.accounts, []);
    let accountId = null;
    let added = null;
    if (choice.startsWith("local:")) {
      accountId = choice.slice("local:".length);
    } else if (choice.startsWith("sf:")) {
      const sfId = choice.slice("sf:".length);
      const offered = choices.find((c) => c.value === choice);
      const sf = offered && offered.simplefin;
      // Linked meanwhile (another device, another modal): use that account
      // rather than linking the same feed twice, which imports everything twice.
      const already = accounts.find((a) => a.simplefin_id === sfId);
      if (already) {
        accountId = already.id;
      } else {
        if (!sf) {
          new Notice("That SimpleFIN account isn't in the last report any more. Sync, then try again.");
          return null;
        }
        // A fresh id: not another account's, not one a fund still points at,
        // and not one old transactions still carry — the new account would
        // quietly inherit either.
        const inUse = new Set(accounts.map((a) => a.id));
        goals.forEach((g) => g && g.account_id && inUse.add(g.account_id));
        (await readJSON(this.app, FILES.transactions, [])).forEach((t) => t && t.account_id && inUse.add(t.account_id));
        const base = String(sf.name || "Savings").trim() || "Savings";
        let id = base;
        for (let n = 2; inUse.has(id); n++) id = `${base} ${n}`;
        added = {
          id,
          type: "savings",
          institution: sf.org ? `${sf.org} \u2014 ${base}` : base,
          current_balance: sf.balance != null && Number.isFinite(Number(sf.balance)) ? round2(Number(sf.balance)) : null,
          csv_source: "mainbank",
          invert_positive_charges: false,
          simplefin_id: sfId,
          last_imported_through: null
        };
        // Dated only when SimpleFIN dated it. An undated balance asks for
        // nothing until the first sync dates it.
        if (added.current_balance != null && sf.balance_date) added.balance_as_of = sf.balance_date;
        if (added.current_balance != null) stampBalance(added, "simplefin");
        accountId = id;
      }
    }
    if (!accountId) {
      new Notice("Choose the account this fund follows.");
      return null;
    }

    // Checked before anything is written, so a refusal leaves nothing behind.
    const clash = cappedFunds(goals).find((f) => f.account_id === accountId && (!existing || f.id !== existing.id));
    if (clash) {
      // Two funds on one account would each count the same dollars.
      new Notice(`${clash.name} already follows that account. One account can back one fund.`);
      return null;
    }
    const i = existing ? goals.findIndex((g) => g.id === existing.id) : -1;
    if (existing && i < 0) {
      new Notice(`Couldn't find ${existing.name} any more, so nothing was saved.`);
      return null;
    }

    if (added) {
      accounts.push(added);
      await writeJSON(this.app, FILES.accounts, accounts);
    }
    const fields = {
      name: data.name,
      target_amount: data.target_amount,
      account_id: accountId,
      placement: FUND_PLACEMENTS.includes(data.placement) ? data.placement : "cards"
    };
    let fund;
    if (existing) {
      goals[i] = Object.assign({}, goals[i], fields, { kind: "capped" });
      fund = goals[i];
    } else {
      fund = Object.assign({ id: genId("fund"), kind: "capped" }, fields);
      goals.push(fund);
    }
    await writeJSON(this.app, FILES.savingsGoals, goals);

    // A sync in flight is about to rewrite the ledger and pairs transfers as it
    // does; relabelling now would race it for the same file.
    // Remembered, and run when the sync finishes.
    if (this.syncing) this.fundRelabelPending = true;
    const filed = this.syncing ? 0 : await this.relabelFundTransfers();
    const account = added || accounts.find((a) => a.id === accountId);
    const bits = [
      existing ? `Updated ${fund.name}.` : `Created ${fund.name}, following ${accountLabel(account) || accountId}.`
    ];
    if (added) bits.push("It was added to your accounts; its transactions come in with the next sync.");
    if (filed) bits.push(`${filed} transfer${filed === 1 ? "" : "s"} with it ${filed === 1 ? "was" : "were"} filed as ${filed === 1 ? "a transfer" : "transfers"}.`);
    new Notice(bits.join(" "), 8000);
    await this.refreshAfterDataChange();
    return fund;
  }

  async moveCappedFund(fundId, placement) {
    if (!FUND_PLACEMENTS.includes(placement)) return false;
    const goals = await readJSON(this.app, FILES.savingsGoals, []);
    const i = goals.findIndex((g) => g.id === fundId && isCappedFund(g));
    if (i < 0 || fundPlacement(goals[i]) === placement) return false;
    goals[i].placement = placement;
    await writeJSON(this.app, FILES.savingsGoals, goals);
    new Notice(`${goals[i].name} moved to ${FUND_PLACEMENT_PLACES[placement]}.`);
    // Where it shows changes nothing the allocator reads, so a repaint will do.
    this.refreshAllDashboards();
    return true;
  }

  async deleteCappedFund(fund) {
    const goals = await readJSON(this.app, FILES.savingsGoals, []);
    await writeJSON(this.app, FILES.savingsGoals, goals.filter((g) => g.id !== fund.id));
    new Notice(`Deleted ${fund.name}. Its account and transactions are untouched.`);
    await this.refreshAfterDataChange();
  }

  async upsertSweepRecord(patch) {
    const all = await readJSON(this.app, FILES.bufferSweeps, []);
    const idx = all.findIndex((s) => s && s.period_start === patch.period_start);
    if (idx >= 0) all[idx] = Object.assign({}, all[idx], patch);
    else all.push(patch);
    await writeJSON(this.app, FILES.bufferSweeps, all);
    return all;
  }

  // A period that closed with allowance left over and no decision recorded yet.
  // The remaining figure is recomputed from source every time rather than read
  // back, so transactions that imported after the period closed are picked up.
  async pendingSweep() {
    const all = await readJSON(this.app, FILES.bufferSweeps, []);
    const pending = all.filter((s) => s && s.status === "pending");
    for (const rec of pending) {
      const state = await this.closingBufferState({
        periodStartStr: rec.period_start,
        nextPaydayStr: rec.period_end,
        bufferAllocation: { amount: rec.allocated }
      });
      if (!state) continue;
      if (state.remaining > 0.005) return Object.assign({}, rec, state);
      // Late imports consumed the rest of it; there's nothing to sweep.
      await this.upsertSweepRecord({
        period_start: rec.period_start,
        status: "dismissed",
        remaining: 0,
        spent: state.spent,
        decided_on: todayLocal(),
        resolved_reason: "allowance fully spent by later imports"
      });
    }
    return null;
  }

  async offerBufferSweep(closingInputs, newPeriodStart) {
    const state = await this.closingBufferState(closingInputs);
    if (!state || state.remaining <= 0.005) return;
    if (state.periodStart === newPeriodStart) return; // same period re-entered

    // One decision per period, keyed by period start. "pending" is a real state:
    // it survives a closed modal, a crash or a reload, and the dashboard can
    // surface it again. Only swept/dismissed are final.
    const sweeps = await readJSON(this.app, FILES.bufferSweeps, []);
    const existing = sweeps.find((s) => s && s.period_start === state.periodStart);
    if (existing && (existing.status === "swept" || existing.status === "dismissed")) return;

    await this.upsertSweepRecord({
      period_start: state.periodStart,
      period_end: state.periodEnd,
      allocated: state.allocated,
      spent: state.spent,
      remaining: state.remaining,
      status: "pending",
      noticed_on: (existing && existing.noticed_on) || todayLocal()
    });

    await this.openSweepModal(state);
  }

  async openSweepModal(state) {
    const goals = await readJSON(this.app, FILES.savingsGoals, []);
    // Sweeps record contributions; a capped fund takes none.
    const fundable = regularGoals(goals).filter((g) => goalProgress(g).remaining > 0.005);
    if (!fundable.length) {
      // offerBufferSweep has already written a pending record by this point, so
      // returning quietly leaves a "Move it to savings" button on the dashboard
      // that does nothing when pressed. Resolve it instead of stranding it.
      await this.upsertSweepRecord({
        period_start: state.periodStart,
        status: "dismissed",
        decided_on: todayLocal(),
        resolved_reason: "no open goals available"
      });
      new Notice("No open savings goals have room for this allowance. Sweep dismissed.");
      await this.refreshAfterDataChange();
      return;
    }

    const transactions = await readJSON(this.app, FILES.transactions, []);
    const paychecksFor = await this.goalPaychecksMap(fundable, state.periodEnd, transactions);
    const savingsDeadline = this.settings.savingsMode ? this.settings.savingsDeadline || null : null;

    // The split comes from the same allocator that distributes ordinary surplus,
    // so pacing, deadlines and priority all apply — and give() already caps each
    // goal at its own remaining target, so nothing can be overfunded.
    const plan = (amount) => recommendSavings(fundable, amount, paychecksFor, state.periodEnd, savingsDeadline);

    new BufferSweepModal(
      this.app,
      {
        remaining: state.remaining,
        allocated: state.allocated,
        spent: state.spent,
        periodStart: state.periodStart,
        periodEnd: state.periodEnd,
        plan
      },
      async ({ action, breakdown, amount }) => {
        if (action !== "sweep") {
          await this.upsertSweepRecord({
            period_start: state.periodStart,
            status: "dismissed",
            decided_on: todayLocal()
          });
          await this.refreshAfterDataChange();
          return;
        }

        const note = `Unspent allowance, ${state.periodStart} → ${state.periodEnd}`;
        const applied = [];
        for (const b of breakdown) {
          const goal = await addGoalFunds(this.app, b.id, b.amount, note);
          if (goal) applied.push({ goal_id: b.id, goal_name: goal.name, amount: b.amount });
        }

        if (!applied.length) {
          new Notice("Couldn't find those goals — nothing was moved.");
          return;
        }

        const moved = round2(applied.reduce((s, a) => s + a.amount, 0));
        await this.upsertSweepRecord({
          period_start: state.periodStart,
          status: "swept",
          decided_on: todayLocal(),
          amount: moved,
          distribution: applied
        });
        new Notice(
          applied.length === 1
            ? `$${moved.toFixed(2)} added to ${applied[0].goal_name}. Match it to the real transfer once it posts.`
            : `$${moved.toFixed(2)} split across ${applied.length} goals. Match each to its real transfer once it posts.`
        );
        await this.refreshAfterDataChange();
      }
    ).open();
  }

  // `onDone` runs only after an account is actually saved. The modal returns as
  // soon as it opens, so a caller that needs to re-render its own list can't do
  // it by awaiting this call.
  // What the account modal needs to offer SimpleFIN links.
  async simplefinLinkContext(exceptId = null) {
    const cache = await readJSON(this.app, FILES.simplefinAccounts, {});
    const accounts = await readJSON(this.app, FILES.accounts, []);
    const linkedBy = {};
    accounts.forEach((a) => {
      if (a.simplefin_id && a.id !== exceptId) linkedBy[a.simplefin_id] = a.institution || a.id;
    });
    // A loan following one for its balance has it too.
    (await readJSON(this.app, FILES.installmentDebts, [])).forEach((d) => {
      if (isLoan(d) && d.simplefin_id) linkedBy[d.simplefin_id] = debtLabel(d);
    });
    return { simplefinAccounts: this.hasSimpleFINConnection() ? cache.accounts || [] : [], linkedBy };
  }

  async promptAddAccount(onDone = null) {
    const context = await this.simplefinLinkContext();
    new AddAccountModal(this.app, async (account) => {
      if (!account.id) {
        new Notice("Account ID is required.");
        return;
      }
      const accounts = await readJSON(this.app, FILES.accounts, []);
      if (accounts.some((a) => a.id === account.id)) {
        new Notice(`An account with ID "${account.id}" already exists.`);
        return;
      }
      if (!account.simplefin_id) delete account.simplefin_id;
      // A typed balance is as of today. A synced account's balance comes from
      // its first sync, and a blank field saves as 0, so dating that 0 today
      // would pass it off as a real, fresh balance.
      if (!account.simplefin_id && account.current_balance != null) stampBalance(Object.assign(account, { balance_as_of: todayLocal() }), "manual");
      accounts.push(account);
      await writeJSON(this.app, FILES.accounts, accounts);
      new Notice(`Added account: ${account.id}`);
      await this.refreshAfterDataChange();
      if (onDone) await onDone(account);
    }, null, context).open();
  }

  async promptAddCreditCardTerms() {
    const accounts = await readJSON(this.app, FILES.accounts, []);
    const creditCardAccounts = accounts.filter((a) => a.type === "credit_card");
    new AddRevolvingDebtModal(this.app, creditCardAccounts, async (debt) => {
      const today = todayLocal();
      const typedBalance = Number.isFinite(debt.current_balance) ? round2(debt.current_balance) : null;
      // The balance typed here is a point-in-time anchor, not a stored field.
      delete debt.current_balance;
      if (!debt.payment_category) debt.payment_category = "Credit Card Payment";

      const debts = await readJSON(this.app, FILES.revolvingDebts, []);
      const idx = debts.findIndex((d) => d.account_id === debt.account_id);
      if (idx >= 0) {
        // Editing terms must not wipe the payment ledger or re-anchor at $0.
        // Only a balance actually typed re-anchors; everything else merges.
        const prev = debts[idx];
        debts[idx] = Object.assign({}, prev, debt, {
          id: prev.id || genId("cc"),
          applied_payments: prev.applied_payments || [],
          balance_anchor:
            typedBalance != null ? { amount: typedBalance, date: today } : prev.balance_anchor || { amount: 0, date: today }
        });
        if (typedBalance != null) await reanchorCardBalance(this.app, debt.account_id, typedBalance);
      } else {
        debt.id = genId("cc");
        debt.balance_anchor = { amount: typedBalance != null ? typedBalance : 0, date: today };
        debt.applied_payments = [];
        debts.push(debt);
      }
      await writeJSON(this.app, FILES.revolvingDebts, debts);
      new Notice(`Saved credit card terms for: ${debt.account_id}`);
      await this.snapshotDebt();
      await this.refreshAfterDataChange();
    }).open();
  }

  async promptAddBNPL() {
    new BNPLModal(this.app, async (plan, balance) => {
      const today = todayLocal();
      plan.id = genId("bnpl");
      plan.balance_anchor = { amount: balance, date: today };
      plan.applied_payments = [];
      plan.payment_category = "BNPL";
      const plans = await readJSON(this.app, FILES.installmentDebts, []);
      plans.push(plan);
      await writeJSON(this.app, FILES.installmentDebts, plans);
      new Notice(`Added BNPL plan: ${plan.provider}`);
      await this.snapshotDebt();
      await this.refreshAfterDataChange();
    }).open();
  }

  // ---------- loans ----------

  // SimpleFIN accounts a loan can take its balance from: every account in the
  // last sync that isn't already an account here or another loan's.
  async loanSimplefinChoices(loan = null) {
    const cache = await readJSON(this.app, FILES.simplefinAccounts, {});
    const accounts = await readJSON(this.app, FILES.accounts, []);
    const plans = await readJSON(this.app, FILES.installmentDebts, []);
    const taken = new Set(
      accounts.map((a) => a.simplefin_id).filter(Boolean).concat(plans.filter((d) => isLoan(d) && d.simplefin_id && (!loan || d.id !== loan.id)).map((d) => d.simplefin_id))
    );
    return (cache.accounts || [])
      .filter((sf) => sf && sf.id && !taken.has(sf.id))
      .map((sf) => ({ id: sf.id, label: simplefinAccountLabel(sf) }));
  }

  async promptLoan(existing = null, prefill = null) {
    const sfChoices = await this.loanSimplefinChoices(existing);
    new LoanModal(this.app, { existing, prefill, sfChoices }, async (data) => {
      const saved = await this.saveLoan(existing, data);
      if (saved) {
        new Notice(`${existing ? "Updated" : "Added"} ${saved.provider}.`);
        await this.snapshotDebt();
        await this.refreshAfterDataChange();
      }
    }).open();
  }

  // Adds a loan or updates one. A balance you change becomes its new anchor,
  // as of the date given; its payments are kept, because they're what says this
  // month is paid.
  async saveLoan(existing, data) {
    const plans = await readJSON(this.app, FILES.installmentDebts, []);
    const idx = existing ? plans.findIndex((d) => debtKey(d) === debtKey(existing)) : -1;
    if (existing && idx < 0) return null;
    const loan = idx >= 0 ? plans[idx] : { id: genId("loan"), kind: "loan", frequency: "monthly", applied_payments: [] };
    // The due dates run monthly from the first payment. Before it's made,
    // changing it just moves them; after, a changed next payment date starts
    // them again from there, and the payments before it are left to the months
    // they already paid.
    const started = (loan.applied_payments || []).length > 0;
    const prevDue = started ? loanSchedule(loan).nextDue || loan.next_due_date : null;
    if (!started) {
      loan.first_payment_date = data.due;
      delete loan.coverage_from;
      delete loan.due_history;
    } else if (data.due !== prevDue) {
      // The dates it ran on until now stay for the interest charged at them;
      // payments count toward the new ones from the new first one's window.
      const oldFirst = loanFirstDue(loan);
      if (oldFirst && prevDue && prevDue > oldFirst) loan.due_history = (loan.due_history || []).concat([{ first: oldFirst, until: prevDue }]);
      loan.first_payment_date = data.due;
      loan.coverage_from = addDays(data.due, -LOAN_EARLY_DAYS);
    }
    if (!loan.first_payment_date) loan.first_payment_date = data.due;
    Object.assign(loan, {
      loan_type: data.loan_type,
      provider: data.name,
      apr: data.apr,
      installment_amount: data.payment,
      next_due_date: data.due,
      payment_category: data.category,
      frequency: "monthly"
    });
    if (data.loan_type === "mortgage" && data.escrow > 0) loan.escrow = data.escrow;
    else delete loan.escrow;
    if (data.value > 0) loan.estimated_value = data.value;
    else delete loan.estimated_value;
    if (data.simplefin_id) loan.simplefin_id = data.simplefin_id;
    else delete loan.simplefin_id;
    if (typeof data.extra === "boolean") loan.extra_payments = data.extra;
    if (!existing || data.balanceChanged) {
      loan.balance_anchor = { amount: data.balance, date: data.asOf, at: new Date().toISOString(), source: "manual" };
      if (!existing) loan.loan_date = data.asOf;
    }
    if (idx >= 0) plans[idx] = loan;
    else plans.push(loan);
    await writeJSON(this.app, FILES.installmentDebts, plans);
    return loan;
  }

  async promptCloseLoan(loan) {
    const transactions = await readJSON(this.app, FILES.transactions, []);
    const rules = await readJSON(this.app, FILES.rules, []);
    const byId = new Map(transactions.filter((t) => t && t.id).map((t) => [t.id, t]));
    // The money a sale moved: within a month of it, the right direction,
    // closest in amount first.
    const candidates = (sign, amount, date) =>
      transactions
        .filter(
          (t) =>
            t && t.date && !t.pending && Math.sign(t.amount) === sign && !isHiddenTransfer(t, byId) &&
            t.resolved_category !== "Paycheck" && Math.abs(daysBetween(date, t.date)) <= 30
        )
        .sort((a, b) => Math.abs(Math.abs(a.amount) - amount) - Math.abs(Math.abs(b.amount) - amount))
        .slice(0, 5);
    new CloseLoanModal(
      this.app,
      loan,
      { candidates, rules },
      async (info) => {
        const rec = await this.closeLoan(loan, info);
        if (!rec) return;
        new Notice(`Closed ${debtLabel(loan)}. ${closedLoanSummary(rec)}.`, 9000);
        await this.snapshotDebt();
        await this.refreshAfterDataChange();
        // The next loan starts where this one ended.
        if (info.reason === "refinanced") {
          await this.promptLoan(null, {
            loan_type: loan.loan_type,
            provider: loan.provider,
            balance_anchor: { amount: info.payoff, date: info.date }
          });
        } else if (info.reason === "traded") {
          await this.promptLoan(null, { loan_type: loan.loan_type, balance_anchor: { date: info.date } });
        }
      },
      () => this.confirmDeleteLoan(loan)
    ).open();
  }

  // Moves a loan to the closed list, with how it ended, and files the money a
  // sale moved: proceeds as an Asset Sale (not income), a shortfall you
  // covered as a payment on the loan.
  async closeLoan(loan, info) {
    const plans = await readJSON(this.app, FILES.installmentDebts, []);
    const idx = plans.findIndex((d) => debtKey(d) === debtKey(loan));
    if (idx < 0) return null;
    const live = plans[idx];
    const rec = Object.assign({}, live, {
      closed: {
        reason: info.reason,
        date: info.date,
        price: info.price,
        payoff: info.payoff,
        fees: info.fees || 0,
        result: info.result,
        balance: loanState(live).balance,
        paid: round2((live.applied_payments || []).reduce((s, p) => s + Math.abs(Number(p.amount) || 0), 0)),
        tx_id: info.txId || null
      }
    });
    if (info.txId) {
      const ledger = await readJSON(this.app, FILES.transactions, []);
      const t = ledger.find((x) => x && x.id === info.txId);
      if (t) {
        let cat = live.payment_category || LOAN_TYPES[loanType(live)].category;
        if (t.amount > 0) {
          const meta = await readJSON(this.app, FILES.categories, []);
          const c = assetSaleCategory(meta);
          if (c.create) await setCategoryTransfer(this.app, c.name, true);
          cat = c.name;
        }
        if (!("transfer_prev_label" in t)) t.transfer_prev_label = t.override_label || null;
        t.override_label = cat;
        t.resolved_category = cat;
        await writeJSON(this.app, FILES.transactions, ledger);
      }
    }
    // Its payments stay a bill, not spending, once it's no longer tracked: a
    // category named like one (Car Loan, Mortgage) already is; another is
    // marked so.
    const payCat = live.payment_category;
    if (payCat && !NON_DISCRETIONARY_PATTERN.test(payCat)) await setCategoryScheduled(this.app, payCat, true);
    const closed = await readJSON(this.app, FILES.closedLoans, []);
    closed.push(rec);
    await writeJSON(this.app, FILES.closedLoans, closed);
    plans.splice(idx, 1);
    await writeJSON(this.app, FILES.installmentDebts, plans);
    return rec;
  }

  // Back from the closed list, as it was.
  async reopenLoan(id) {
    const closed = await readJSON(this.app, FILES.closedLoans, []);
    const idx = closed.findIndex((d) => d && d.id === id);
    if (idx < 0) return null;
    const rec = Object.assign({}, closed[idx]);
    // The money the close filed goes back to how it was labelled.
    const txId = rec.closed && rec.closed.tx_id;
    if (txId) {
      const ledger = await readJSON(this.app, FILES.transactions, []);
      const t = ledger.find((x) => x && x.id === txId);
      if (t && "transfer_prev_label" in t) {
        if (t.transfer_prev_label) t.override_label = t.transfer_prev_label;
        else delete t.override_label;
        delete t.transfer_prev_label;
        applyCategorization(ledger, await readJSON(this.app, FILES.rules, []));
        await writeJSON(this.app, FILES.transactions, ledger);
      }
    }
    delete rec.closed;
    const plans = await readJSON(this.app, FILES.installmentDebts, []);
    plans.push(rec);
    await writeJSON(this.app, FILES.installmentDebts, plans);
    closed.splice(idx, 1);
    await writeJSON(this.app, FILES.closedLoans, closed);
    return rec;
  }

  confirmDeleteLoan(loan) {
    new ConfirmModal(this.app, {
      title: `Delete “${debtLabel(loan)}”?`,
      body: [
        "For a loan added by mistake. It's removed with its payment history, and isn't kept in Closed loans.",
        "Transactions stay put. To record a loan that ended, close it instead."
      ],
      onConfirm: async () => {
        const plans = await readJSON(this.app, FILES.installmentDebts, []);
        await writeJSON(this.app, FILES.installmentDebts, plans.filter((d) => debtKey(d) !== debtKey(loan)));
        new Notice(`Deleted ${debtLabel(loan)}.`);
        await this.snapshotDebt();
        await this.refreshAfterDataChange();
      }
    }).open();
  }

  async promptEditBNPL(existing) {
    new BNPLModal(
      this.app,
      async (plan, balance, balanceChanged) => {
        const plans = await readJSON(this.app, FILES.installmentDebts, []);
        const idx = plans.findIndex((p) => debtKey(p) === debtKey(existing));
        if (idx < 0) return;
        const prev = plans[idx];
        const merged = Object.assign({}, prev, plan);
        merged.payment_category = prev.payment_category || "BNPL";
        if (!plan.deferred_interest_risk) delete merged.deferred_interest_risk;
        if (balanceChanged) {
          // New baseline: the applied-payment ledger is already reflected in
          // the number the user just typed, so start it over.
          merged.balance_anchor = { amount: balance, date: todayLocal() };
          merged.applied_payments = [];
        }
        plans[idx] = merged;
        await writeJSON(this.app, FILES.installmentDebts, plans);
        new Notice(`Updated ${merged.provider}.`);
        await this.snapshotDebt();
        await this.refreshAfterDataChange();
      },
      existing
    ).open();
  }

  async promptAddFixedExpense() {
    const categoryNames = (await readJSON(this.app, FILES.categories, []))
      .map((c) => c && c.name)
      .filter(Boolean);
    new AddFixedExpenseModal(this.app, async (expense) => {
      expense.id = genId("fixed");
      expense.last_paid_date = null;
      const expenses = await readJSON(this.app, FILES.fixedExpenses, []);
      expenses.push(expense);
      await writeJSON(this.app, FILES.fixedExpenses, expenses);
      new Notice(`Added fixed expense: ${expense.name}`);
      await this.refreshAfterDataChange();
    }, null, categoryNames).open();
  }

  async promptMarkFixedPaid() {
    const expenses = await readJSON(this.app, FILES.fixedExpenses, []);
    if (expenses.length === 0) {
      new Notice("No fixed expenses yet \u2014 add one first.");
      return;
    }
    new FixedExpensePickerModal(this.app, expenses, async (expense) => {
      const todayStr = todayLocal();
      const defaultDue = isRollingExpense(expense)
        ? expense.next_due_date
        : nextDueDateOnOrAfter(expense.due_day_of_month, todayStr);
      const rules = await readJSON(this.app, FILES.rules, []);
      new MarkPaidModal(
        this.app,
        expense,
        defaultDue,
        async (paidForDate, tx) => {
          const all = await readJSON(this.app, FILES.fixedExpenses, []);
          const idx = all.findIndex((e) => e.id === expense.id);
          if (idx >= 0) {
            recordFixedPayment(all[idx], paidForDate, tx);
            await writeJSON(this.app, FILES.fixedExpenses, all);
            new Notice(
              isRollingExpense(all[idx])
                ? `"${expense.name}" paid \u2014 next due ${all[idx].next_due_date}`
                : `Marked "${expense.name}" as paid through ${paidForDate}`
            );
            await this.refreshAfterDataChange();
          }
        },
        this,
        rules
      ).open();
    }).open();
  }

  // Shared by both Mark Paid entry points, so the two can't drift apart.
  async fixedPaymentCandidates(expense, dueDateStr) {
    const transactions = await readJSON(this.app, FILES.transactions, []);
    const rules = await readJSON(this.app, FILES.rules, []);
    return fixedExpenseCandidates(
      expense,
      transactions,
      await readJSON(this.app, FILES.fixedExpenses, []),
      await readJSON(this.app, FILES.savingsGoals, []),
      await readJSON(this.app, FILES.installmentDebts, []),
      await readJSON(this.app, FILES.revolvingDebts, []),
      dueDateStr,
      null,
      {
        categoryMeta: await readJSON(this.app, FILES.categories, []),
        rules,
        subscriptionKeys: await this.keptSubscriptionKeys(transactions, rules)
      }
    );
  }

  // The subscriptions the audit is still keeping. Needed wherever an ownership
  // index is built outside runAllocation, so a recurring charge is recognised as
  // subscription money there too rather than reading as ordinary spending.
  async keptSubscriptionKeys(transactions = null, rules = null) {
    const txs = transactions || (await readJSON(this.app, FILES.transactions, []));
    const rls = rules || (await readJSON(this.app, FILES.rules, []));
    const reviews = await readJSON(this.app, FILES.subscriptionReviews, []);
    return buildSubscriptionAudit(txs, reviews, rls)
      .filter((s) => s.status === "keep")
      .map((s) => s.key);
  }

  async promptManageTransfers() {
    const allTx = await readJSON(this.app, FILES.transactions, []);
    const rules = await readJSON(this.app, FILES.rules, []);
    const categories = await readJSON(this.app, FILES.categories, []);
    const names = new Set();
    allTx.forEach((t) => names.add(t.resolved_category || "Uncategorized"));
    rules.forEach((r) => names.add(r.home_label));
    categories.forEach((c) => names.add(c.name));
    names.delete("Uncategorized");

    const categoryMeta = {};
    categories.forEach((c) => (categoryMeta[c.name] = c.is_transfer));

    new ManageTransfersModal(this.app, [...names].sort(), categoryMeta, async (state) => {
      const prior = await readJSON(this.app, FILES.categories, []);
      const newCategories = Object.entries(state).map(([name, is_transfer]) => {
        const existing = prior.find((c) => c.name === name) || {};
        // Keep any target already set — this modal only edits transfer flags.
        return Object.assign({}, existing, { name, is_transfer });
      });
      await writeJSON(this.app, FILES.categories, newCategories);
      new Notice("Updated transfer categories.");
      await this.refreshAfterDataChange();
    }).open();
  }

  async promptImportCSV() {
    const showResult = (summary) => new ImportResultModal(this.app, summary).open();
    const files = this.app.vault.getFiles().filter((f) => f.path.startsWith(IMPORT_DIR) && f.extension === "csv");

    if (files.length === 0) {
      showResult({
        status: "failed",
        message: `No CSV files were found in ${IMPORT_DIR}.`,
        issues: [`Drop a bank export into ${IMPORT_DIR} and try again.`],
        sourceRemoved: false
      });
      return;
    }

    const accounts = await readJSON(this.app, FILES.accounts, []);
    if (accounts.length === 0) {
      showResult({
        status: "failed",
        message: "The import cannot start because there are no accounts configured.",
        issues: ["Add an account first so the plugin knows which account owns the CSV transactions."],
        sourceRemoved: false
      });
      return;
    }

    new ImportSourceModal(this.app, files, async (file) => {
      new AccountPickerModal(this.app, accounts, async (account) => {
        const filePath = file.path;
        const accountId = account.id;
        let transactionsWritten = false;

        // One source per account. A CSV for an account that also syncs would
        // bring its transactions in a second time under different descriptions.
        if (account.simplefin_id) {
          showResult({
            status: "failed",
            filePath,
            accountId,
            message: "This account syncs through SimpleFIN, so the CSV wasn't imported.",
            issues: [
              `${account.institution || accountId} gets its transactions from Sync Transactions. Importing a CSV for it as well would bring the same transactions in twice.`,
              "To import a CSV for it anyway — older history, say — unlink it first under Settings → Accounts. Rows SimpleFIN already brought in are recognised and skipped, and if you link it again, the next sync recognises the CSV's rows the same way."
            ],
            sourceRemoved: false
          });
          return;
        }

        try {
          const source = account.csv_source || "mainbank";
          const adapter = ADAPTERS[source];
          if (!adapter) {
            showResult({
              status: "failed",
              filePath,
              accountId,
              message: "The CSV was not imported.",
              issues: [`No adapter found for csv_source "${source}" on account ${accountId}.`],
              sourceRemoved: false
            });
            return;
          }

          const csvText = await this.app.vault.read(file);
          const parsed = adapter(csvText, accountId, {
            invertPositiveCharges: !!account.invert_positive_charges
          });
          const newTx = parsed.transactions || [];
          const notes = [];
          const issues = [];

          // Pending rows are normal bank-export behavior, not an import failure.
          // Other parser warnings are review-worthy and keep the source file.
          (parsed.warnings || []).forEach((w) => {
            if (/^\d+ pending transaction\(s\) imported, dated from the bank's expected posting date\.$/.test(w)) {
              notes.push(w);
            } else {
              issues.push(w);
            }
          });

          if (newTx.length === 0) {
            if (!issues.length) issues.push("The parser produced zero transactions.");
            showResult({
              status: "failed",
              filePath,
              accountId,
              message: "Nothing was imported.",
              notes,
              issues,
              sourceRemoved: false
            });
            return;
          }

          const rules = await readJSON(this.app, FILES.rules, []);
          const existing = await readJSON(this.app, FILES.transactions, []);
          // Anything SimpleFIN already brought in for this account (it was synced
          // before being unlinked) is already here under the feed's description,
          // which an exact-duplicate check would never recognise.
          const synced = matchCSVToSimpleFIN(existing, newTx);
          const reconciliation = reconcileImport(existing, synced.size ? newTx.filter((_, k) => !synced.has(k)) : newTx);
          const { merged, added, updated, unresolved } = reconciliation;
          const skipped = reconciliation.skipped + synced.size;
          issues.push(...(reconciliation.issues || []));
          if (synced.size) {
            notes.push(
              `${synced.size} row${synced.size === 1 ? " was" : "s were"} already imported by SimpleFIN sync and ${synced.size === 1 ? "was" : "were"} skipped.`
            );
            // Listed, so a skip that was wrong can be seen rather than assumed.
            const shown = [...synced.keys()].sort((a, b) => a - b);
            shown.slice(0, 20).forEach((k) => {
              const t = newTx[k];
              notes.push(`Skipped as already synced: ${t.date} · ${t.merchant_raw} · $${Math.abs(t.amount).toFixed(2)}`);
            });
            if (shown.length > 20) notes.push(`…and ${shown.length - 20} more.`);
          }

          const handled = added + updated + skipped + unresolved;
          if (handled !== newTx.length) {
            issues.push(
              `Reconciliation count mismatch: parsed ${newTx.length} row(s) but accounted for ${handled}.`
            );
          }

          applyCategorization(merged, rules);
          const fundTransfers = await this.pairFundTransfersIn(merged);
          if (fundTransfers) {
            notes.push(
              `${fundTransfers} transfer${fundTransfers === 1 ? "" : "s"} with a capped fund's account ${fundTransfers === 1 ? "was" : "were"} filed as ${fundTransfers === 1 ? "a transfer" : "transfers"}, so ${fundTransfers === 1 ? "it isn't" : "they aren't"} counted as spending or income.`
            );
          }
          const goalTransfers = await this.assignGoalTransfersIn(merged);
          if (goalTransfers) {
            notes.push(`${goalTransfers} savings transfer${goalTransfers === 1 ? " was" : "s were"} added to ${goalTransfers === 1 ? "its goal" : "their goals"}.`);
          }
          await writeJSON(this.app, FILES.transactions, merged);
          transactionsWritten = true;
          // Category dropdowns re-rank here and only here, so their order holds
          // still between imports instead of shifting with every relabel.
          await refreshCategoryUsageOrder(this.app, merged);

          // Only claim the account is fully imported through today when every row
          // parsed/reconciled cleanly. Review-needed imports still keep the good
          // rows that were safe to merge, but they do not advance this marker.
          if (issues.length === 0) {
            account.last_imported_through = todayLocal();
            const updatedAccounts = accounts.map((a) => (a.id === accountId ? account : a));
            await writeJSON(this.app, FILES.accounts, updatedAccounts);
          }

          await this.refreshAfterDataChange();

          let sourceRemoved = false;
          if (issues.length === 0) {
            try {
              const liveFile = this.app.vault.getAbstractFileByPath(filePath);
              if (liveFile) {
                if (!this.app.fileManager || typeof this.app.fileManager.trashFile !== "function") {
                  throw new Error("Obsidian's safe trash API is unavailable.");
                }
                await this.app.fileManager.trashFile(liveFile);
              }
              sourceRemoved = true;
            } catch (cleanupError) {
              issues.push(`Import was clean, but the source CSV could not be removed: ${cleanupError.message || cleanupError}`);
            }
          }

          showResult({
            status: issues.length ? "review" : "success",
            filePath,
            accountId,
            counts: { added, updated, skipped, unresolved },
            notes,
            issues,
            sourceRemoved,
            message: issues.length
              ? "Safe rows were imported, but at least one issue needs review."
              : "All parsed rows reconciled cleanly."
          });
        } catch (error) {
          console.error("Budget Tracker CSV import failed:", error);
          showResult({
            status: "failed",
            filePath,
            accountId,
            message: transactionsWritten
              ? "The import failed after transaction data may already have been written. Re-running the same CSV is safe because duplicates are reconciled."
              : "The CSV was not imported.",
            issues: [error && error.message ? error.message : String(error)],
            sourceRemoved: false
          });
        }
      }).open();
    }).open();
  }

  async snapshotDebt() {
    const revolving = await readJSON(this.app, FILES.revolvingDebts, []);
    const installment = await readJSON(this.app, FILES.installmentDebts, []);
    const transactions = await readJSON(this.app, FILES.transactions, []);
    return logDebtSnapshot(this.app, revolving, installment, transactions);
  }

  async renderLauncherBlock(el) {
    el.empty();
    el.addClass("budget-launcher");

    const btn = el.createEl("button", { text: "Open Budget Tracker", cls: "budget-launcher-btn mod-cta" });
    btn.onclick = () => this.activateView();

    const summary = el.createDiv({ cls: "budget-launcher-summary" });
    try {
      const result = this.lastPaycheckInputs ? await this.recalculate() : null;
      if (result) {
        const cash = summary.createDiv({ cls: "budget-launcher-stat" });
        cash.createDiv({ text: "Free cash", cls: "budget-launcher-label" });
        cash.createDiv({
          text: `$${result.freeCash.toFixed(2)}`,
          cls: `budget-launcher-value ${result.freeCash < 0 ? "budget-negative" : "budget-positive"}`
        });

        const period = summary.createDiv({ cls: "budget-launcher-stat" });
        period.createDiv({ text: "Next payday", cls: "budget-launcher-label" });
        period.createDiv({ text: result.nextPaydayStr || "\u2014", cls: "budget-launcher-value-sm" });

        const revolving = await readJSON(this.app, FILES.revolvingDebts, []);
        const installment = await readJSON(this.app, FILES.installmentDebts, []);
        const debt = totalDebt(revolving, installment);
        if (debt > 0) {
          const debtEl = summary.createDiv({ cls: "budget-launcher-stat" });
          debtEl.createDiv({ text: "Total debt", cls: "budget-launcher-label" });
          debtEl.createDiv({ text: `$${debt.toFixed(2)}`, cls: "budget-launcher-value-sm" });
        }
      } else {
        summary.createDiv({
          text: "No active pay period \u2014 open the dashboard and run Enter Paycheck.",
          cls: "budget-muted"
        });
      }
    } catch (e) {
      summary.createDiv({ text: "Couldn't load budget data.", cls: "budget-muted" });
      console.error("Budget Tracker launcher block:", e);
    }
  }

  // Creates (or opens) a note containing the launcher block, so there's
  // something concrete to bookmark on mobile.
  async createDashboardNote() {
    // Notes made before the rename keep their old name, so they're reused, not duplicated.
    const legacyPath = "Budget/Budget Dashboard.md";
    const path = this.app.vault.getAbstractFileByPath(legacyPath) ? legacyPath : "Budget/Budget Tracker.md";
    const body = [
      "# Budget Tracker",
      "",
      "```budget",
      "```",
      "",
      "Bookmark this note (long-press it in the file list) so the dashboard is",
      "one tap away from the mobile sidebar.",
      ""
    ].join("\n");

    let file = this.app.vault.getAbstractFileByPath(path);
    if (!file) {
      if (!(await this.app.vault.adapter.exists(DATA_DIR))) await ensureDataDir(this.app);
      file = await this.app.vault.create(path, body);
      new Notice("Created \u201cBudget/Budget Tracker\u201d \u2014 bookmark it for quick access.", 9000);
    }
    const leaf = this.app.workspace.getLeaf(isMobileApp() ? false : "tab");
    await leaf.openFile(file);
  }

  refreshDashboard() {
    this.app.workspace.getLeavesOfType(VIEW_TYPE).forEach((l) => l && l.view && typeof l.view.render === "function" && l.view.render());
  }

  async recalculate() {
    if (!this.lastPaycheckInputs) return null;
    // Cash on hand is the checking account's balance whenever that's newer than
    // the period's copy — a sync here, or one on another device that reached
    // this vault since the period was loaded. Done first, so everything below
    // works from the current figure, and it's what gets saved with the period.
    adoptCashBalance(
      this.lastPaycheckInputs,
      await readJSON(this.app, FILES.accounts, []),
      await readJSON(this.app, FILES.transactions, [])
    );
    const { paycheckAmount, checkingBalance, alreadyDeposited, nextPaydayStr } = this.lastPaycheckInputs;
    // The period START stays fixed at whenever the paycheck was entered — it does
    // NOT advance to today. Moving it forward would silently drop fixed expenses
    // that came due earlier in the period but haven't been paid yet.
    let todayStr = this.lastPaycheckInputs.periodStartStr || this.lastPaycheckInputs.todayStr;

    // Repair periods stored before the start was derived from the schedule.
    // Without this an existing period keeps its entry-date start forever.
    const schedForStart = resolvePaySchedule(
      this.settings,
      await readJSON(this.app, FILES.transactions, [])
    );
    if (schedForStart) {
      const trueStart = currentPeriodStart(schedForStart, todayLocal());
      if (trueStart && trueStart !== todayStr && trueStart <= todayLocal()) {
        todayStr = trueStart;
        this.lastPaycheckInputs.periodStartStr = trueStart;
      }
    }

    const fixedExpenses = await readJSON(this.app, FILES.fixedExpenses, []);
    const installmentDebts = await readJSON(this.app, FILES.installmentDebts, []);
    const revolvingDebts = await readJSON(this.app, FILES.revolvingDebts, []);

    const allTxForSubs = await readJSON(this.app, FILES.transactions, []);
    await logDebtSnapshot(this.app, revolvingDebts, installmentDebts, allTxForSubs);

    const subRules = await readJSON(this.app, FILES.rules, []);
    const subReviews = await readJSON(this.app, FILES.subscriptionReviews, []);
    const auditRows = buildSubscriptionAudit(allTxForSubs, subReviews, subRules);
    const upcomingSubs = upcomingSubscriptions(auditRows, allTxForSubs, subRules, todayStr, nextPaydayStr);
    // Every kept subscription, not just the ones still upcoming. One that has
    // already billed this period is deliberately absent from upcomingSubs, and
    // that is exactly the charge the buffer must not also be asked to fund.
    const subscriptionKeys = auditRows.filter((s) => s.status === "keep").map((s) => s.key);
    const goalsForEarmark = await readJSON(this.app, FILES.savingsGoals, []);
    const earmarked = earmarkedSavings(goalsForEarmark);

    // How many paychecks each dated goal has left, so the allocator can pace it.
    const paychecksFor = await this.goalPaychecksMap(goalsForEarmark, todayStr, allTxForSubs);

    // If the paycheck already landed, checking balance already includes it —
    // don't add it again. If it hasn't landed yet, add it to the balance.
    const cashOnHand = alreadyDeposited ? checkingBalance : checkingBalance + paycheckAmount;

    const categoryMeta = await readJSON(this.app, FILES.categories, []);
    // Read before allocating: a capped fund's balance is its account's.
    const accounts = await readJSON(this.app, FILES.accounts, []);

    // Capture the period's spending allowance if it hasn't been captured yet, or
    // if the user deliberately changed it. Periods created before this feature
    // existed get a snapshot on their first recalculation, which is why an
    // in-flight period keeps working without a migration step.
    const bufferModeNow = this.settings.bufferMode || "auto";
    const manualBufferNow = this.settings.manualBuffer ?? 100;
    if (bufferAllocationStale(this.lastPaycheckInputs.bufferAllocation, bufferModeNow, manualBufferNow, todayStr)) {
      this.lastPaycheckInputs.bufferAllocation = captureBufferAllocation({
        transactions: withoutFundAccountRows(allTxForSubs, goalsForEarmark),
        categoryMeta,
        periodStartStr: todayStr,
        nextPaydayStr,
        bufferMode: bufferModeNow,
        manualBuffer: manualBufferNow
      });
    }

    const result = runAllocation({
      cashOnHand,
      todayStr,
      nextPaydayStr,
      fixedExpenses,
      installmentDebts,
      revolvingDebts,
      upcomingSubs,
      earmarked,
      savingsMode: !!this.settings.savingsMode,
      goals: goalsForEarmark,
      paychecksFor,
      transactions: allTxForSubs,
      categoryMeta,
      bufferMode: bufferModeNow,
      manualBuffer: manualBufferNow,
      // todayStr above is the pay-period start; this is the real date.
      currentDateStr: todayLocal(),
      savingsDeadline: this.settings.savingsMode ? this.settings.savingsDeadline || null : null,
      bufferAllocation: this.lastPaycheckInputs.bufferAllocation,
      subscriptionKeys,
      rules: subRules,
      accounts
    });

    const totalAvailableCredit = accounts
      .filter((a) => a.type === "credit_card")
      .reduce((s, a) => s + (a.credit_limit - a.current_balance), 0);

    // Spendable cash is the buffer plus any true surplus; adding credit on top
    // gives the "if I really had to" figure. Using freeCash alone reported just
    // the credit line, since freeCash is normally zero.
    result.totalFlexibility = round2(result.freeCash + (result.effectiveBuffer || 0) + totalAvailableCredit);
    result.todayStr = todayStr;
    result.nextPaydayStr = nextPaydayStr;
    result.autoRolled = !!this.lastPaycheckInputs.autoRolled;
    const cashAcct = accounts.find((a) => a && a.id === this.lastPaycheckInputs.checkingAccountId) || cashAccount(accounts);
    result.cashSource = {
      account: cashAcct ? accountLabel(cashAcct) : null,
      balance: round2(Number(checkingBalance) || 0),
      at: this.lastPaycheckInputs.checkingBalanceAt || null,
      source: this.lastPaycheckInputs.checkingBalanceSource || null,
      paycheckPending: !alreadyDeposited && (Number(paycheckAmount) || 0) > 0 ? round2(Number(paycheckAmount)) : 0
    };

    await writeJSON(this.app, FILES.activePeriod, {
      inputs: this.lastPaycheckInputs,
      savedAt: todayLocal(),
      result
    });

    this.lastResult = result;
    // Every open dashboard, not just the first: a second one (a sidebar and a
    // tab, say) otherwise kept showing the figures from before.
    this.app.workspace.getLeavesOfType(VIEW_TYPE).forEach((l) => l && l.view && typeof l.view.setResult === "function" && l.view.setResult(result));

    // Flush a sweep left over from an auto-rolled period, once the dashboard has
    // something to show behind the modal. Cleared first so a re-entrant
    // recalculation can't open it twice.
    if (this.pendingSweepClosing) {
      const pending = this.pendingSweepClosing;
      this.pendingSweepClosing = null;
      await this.offerBufferSweep(pending, todayStr);
    }
    return result;
  }

  // Restores an in-flight pay period after a reload. Returns true if a still-valid
  // period was loaded. Results are recomputed rather than replayed from disk, so
  // anything that changed since (payments marked, imports, edited debts) is picked up.
  async loadActivePeriod() {
    const saved = await readJSON(this.app, FILES.activePeriod, null);
    if (!saved || !saved.inputs) return false;

    const todayStr = todayLocal();
    const { nextPaydayStr } = saved.inputs;

    if (!nextPaydayStr || todayStr >= nextPaydayStr) {
      // The period lapsed. With a pay schedule we know exactly when the new one
      // started and ends, so roll it forward rather than blanking the dashboard.
      const schedule = this.settings.paySchedule;
      const rolledNext = schedule ? nextPaydayFrom(schedule, todayStr) : null;
      const rolledStart = schedule ? currentPeriodStart(schedule, todayStr) : null;

      if (rolledNext && rolledStart) {
        const accounts = await readJSON(this.app, FILES.accounts, []);
        const checking = cashAccount(accounts);
        // A period can also close by simply lapsing, without Enter Paycheck ever
        // being run. Hold onto it so its unspent allowance still gets offered,
        // rather than disappearing when the roll overwrites it.
        if (rolledStart !== (saved.inputs.periodStartStr || saved.inputs.todayStr)) {
          this.pendingSweepClosing = saved.inputs;
        }
        this.lastPaycheckInputs = {
          paycheckAmount: 0,
          checkingBalance: checking ? checking.current_balance : saved.inputs.checkingBalance,
          alreadyDeposited: true,
          nextPaydayStr: rolledNext,
          periodStartStr: rolledStart,
          autoRolled: true,
          checkingAccountId: checking ? checking.id : null,
          checkingBalanceAt: checking ? checking.balance_updated_at || null : saved.inputs.checkingBalanceAt || null,
          checkingBalanceSource: checking ? checking.balance_source || null : saved.inputs.checkingBalanceSource || null
        };
        this.expiredPeriod = null;
        return true;
      }

      this.expiredPeriod = { nextPaydayStr };
      return false;
    }

    this.lastPaycheckInputs = saved.inputs;
    this.expiredPeriod = null;
    return true;
  }

  // target: "auto" (main area) or "sidebar". The sidebar option matters on
  // mobile, because a view living in the left drawer shows up in the drawer's
  // view switcher — which is where people actually look for it on a phone.
  async activateView(target = "auto") {
    const existing = this.app.workspace.getLeavesOfType(VIEW_TYPE);
    if (existing.length > 0 && target !== "sidebar") {
      this.app.workspace.revealLeaf(existing[0]);
      return existing[0];
    }

    let leaf = null;
    if (target === "sidebar") {
      // Reuse an existing sidebar leaf if the view is already docked there.
      const docked = existing.find((l) => this.app.workspace.getLeftLeaf && l.getRoot() !== this.app.workspace.rootSplit);
      if (docked) {
        this.app.workspace.revealLeaf(docked);
        return docked;
      }
      leaf = this.app.workspace.getLeftLeaf(false);
    } else {
      // Phones don't really use tabs; opening in place is less disorienting.
      leaf = this.app.workspace.getLeaf(isMobileApp() ? false : "tab");
    }

    if (!leaf) leaf = this.app.workspace.getLeaf(true);
    if (!leaf) {
      new Notice("Couldn't open Budget Tracker \u2014 no available pane.");
      return null;
    }

    await leaf.setViewState({ type: VIEW_TYPE, active: true });
    this.app.workspace.revealLeaf(leaf);
    return leaf;
  }

  onunload() {}
};
