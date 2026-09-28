const { Plugin, Modal, ItemView, Notice, Setting, FuzzySuggestModal, PluginSettingTab, Platform } = require("obsidian");

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
  portfolioSnapshots: `${DATA_DIR}/portfolio_snapshots.json`
};

const PORTFOLIO_ACCOUNTS = [
  { id: "fidelity_401k", provider: "Fidelity", type: "401k", label: "Fidelity 401(k)" },
  { id: "fidelity_hsa", provider: "Fidelity", type: "hsa", label: "Fidelity HSA" }
];

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
    .replace(/[\u2010-\u2015]/g, "-")
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
// carries no period and the user picks the month.
function pfPeriodFromMonth(monthKey) {
  if (!monthKey || !/^\d{4}-\d{2}$/.test(monthKey)) return null;
  const [y, m] = monthKey.split("-").map(Number);
  if (!y || !m || m < 1 || m > 12) return null;
  const last = new Date(y, m, 0).getDate();
  return { start: `${monthKey}-01`, end: `${monthKey}-${String(last).padStart(2, "0")}` };
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

function validatePortfolioSnapshot(snapshot, type) {
  const missing = [];
  if (!type || !PORTFOLIO_ACCOUNTS.some((a) => a.type === type)) missing.push("recognized statement type");
  if (!snapshot || !snapshot.account_id) missing.push("account mapping");
  if (!snapshot || !snapshot.statement_start) missing.push("statement start date");
  if (!snapshot || !snapshot.statement_end) missing.push("statement end date");
  if (!snapshot || typeof snapshot.ending_value !== "number") {
    missing.push(type === "hsa" ? "ending account value" : "ending balance");
  }
  if (snapshot && snapshot.statement_start && snapshot.statement_end && snapshot.statement_start > snapshot.statement_end) {
    missing.push("a statement period that ends after it starts");
  }
  return { ok: missing.length === 0, missing };
}

function parsePortfolioStatement(rawText, monthHint) {
  const type = detectPortfolioStatementType(rawText);
  if (!type) {
    return {
      ok: false,
      type: null,
      snapshot: null,
      warnings: [],
      missing: ["a recognizable Fidelity 401(k) or HSA statement"]
    };
  }
  const parsed =
    type === "hsa"
      ? parseFidelityHsaStatement(rawText, monthHint)
      : parseFidelityNetBenefitsStatement(rawText, monthHint);
  const check = validatePortfolioSnapshot(parsed.snapshot, type);
  return {
    ok: check.ok,
    type,
    snapshot: parsed.snapshot,
    warnings: parsed.warnings,
    missing: check.missing
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

// Authoritative on stored snapshot coverage alone — never on whether an import
// was attempted, acknowledged, or a file was seen.
function portfolioReminders(snapshots, accounts, todayStr = todayLocal(), reminderDay = PORTFOLIO_REMINDER_DAY) {
  const dayOfMonth = parseInt(todayStr.slice(8, 10), 10);
  if (dayOfMonth < reminderDay) return [];
  const wanted = previousMonthKey(todayStr);
  return (accounts || [])
    .filter(
      (a) => !(snapshots || []).some((s) => s.account_id === a.id && portfolioMonthKey(s.statement_end) === wanted)
    )
    .map((a) => ({ account: a, monthKey: wanted }));
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
function availableMonths(transactions) {
  const set = new Set();
  transactions.forEach((t) => {
    if (t.date && /^\d{4}-\d{2}/.test(t.date)) set.add(t.date.slice(0, 7));
  });
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

function buildTrendChart(series, selectedKey = null) {
  if (!series || series.length === 0) return null;
  const W = 640;
  const H = 200;
  const PAD = { top: 14, right: 14, bottom: 28, left: 58 };
  const plotW = W - PAD.left - PAD.right;
  const plotH = H - PAD.top - PAD.bottom;
  const maxY = Math.max(...series.map((s) => s.total), 1);

  const slot = plotW / series.length;
  const barW = Math.min(slot * 0.62, 70);

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
        `<rect class="budget-trend-bar${isSel ? " budget-trend-bar-sel" : ""}" data-month="${s.key}" x="${x.toFixed(1)}" y="${y.toFixed(1)}" width="${barW.toFixed(1)}" height="${Math.max(h, 1).toFixed(1)}" rx="3" fill="${fill}">` +
        `<title>${s.label}: $${s.total.toFixed(2)}</title></rect>` +
        `<text x="${(x + barW / 2).toFixed(1)}" y="${(y - 4).toFixed(1)}" text-anchor="middle" font-size="10" fill="var(--text-muted)">$${Math.round(s.total)}</text>` +
        `<text x="${(x + barW / 2).toFixed(1)}" y="${H - 9}" text-anchor="middle" font-size="10" fill="var(--text-muted)">${s.label}</text>`
      );
    })
    .join("");

  const grid = [0, maxY / 2, maxY]
    .map((v) => {
      const y = PAD.top + plotH - (v / maxY) * plotH;
      return (
        `<line x1="${PAD.left}" y1="${y.toFixed(1)}" x2="${W - PAD.right}" y2="${y.toFixed(1)}" stroke="var(--background-modifier-border)" stroke-width="1"/>` +
        `<text x="${PAD.left - 8}" y="${(y + 4).toFixed(1)}" text-anchor="end" font-size="10" fill="var(--text-muted)">$${Math.round(v)}</text>`
      );
    })
    .join("");

  return `<svg viewBox="0 0 ${W} ${H}" width="100%" preserveAspectRatio="xMidYMid meet">${grid}${bars}</svg>`;
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
  return (goals || []).find((g) => g && g.pinned === true) || null;
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

// The savings equivalent of the debt payoff ladder. Debt prioritised by cost of
// carrying (deferred-interest cliffs, then APR); savings prioritises by
// deadline pressure, because a goal with a date can actually be missed.
//
//   Tier 1 — dated goals, soonest first, funded to the pace they need to land
//            on time. This is the analogue of clearing a deferred-interest
//            cliff: miss the pace and the goal fails, not just costs more.
//   Tier 2 — leftover tops up dated goals beyond pace, soonest first.
//   Tier 3 — undated goals, least-funded first, so nothing stalls at zero.
//
// paychecksFor maps a goal id to how many paychecks remain before its deadline;
// it's passed in because the pay schedule lives outside the allocator.
function recommendSavings(goals, available, paychecksFor = {}, todayStr = todayLocal(), savingsDeadline = null) {
  const breakdown = [];
  let remaining = Math.max(0, round2(available));
  if (remaining <= 0) return { breakdown, total: 0 };

  const open = (goals || [])
    .map((g) => {
      const p = goalProgress(g);
      // A goal's own target date wins; failing that, the global Savings Mode
      // deadline acts as its effective deadline. paychecksFor was already
      // computed on this basis, so without it a goal paced against the global
      // deadline was still being classified as undated.
      const effectiveDate = g.target_date || savingsDeadline || null;
      return { goal: g, remaining: p.remaining, pct: p.pct, date: effectiveDate, ownDate: !!g.target_date };
    })
    .filter((x) => x.remaining > 0);

  if (!open.length) return { breakdown, total: 0 };

  const give = (entry, amount, reason) => {
    const amt = round2(Math.min(amount, entry.remaining, remaining));
    if (amt <= 0) return;
    const existing = breakdown.find((b) => b.id === entry.goal.id);
    if (existing) {
      // Keep the reason that first justified the allocation; a later top-up
      // supplements it rather than replacing the explanation.
      existing.amount = round2(existing.amount + amt);
      if (!/topped up/.test(existing.reason)) existing.reason += ", then topped up";
    } else {
      breakdown.push({ id: entry.goal.id, target: entry.goal.name, amount: amt, reason });
    }
    entry.remaining = round2(entry.remaining - amt);
    remaining = round2(remaining - amt);
  };

  const dated = open.filter((x) => x.date).sort((a, b) => a.date.localeCompare(b.date));
  const undated = open.filter((x) => !x.date).sort((a, b) => a.pct - b.pct);

  // Tier 1: the pace each dated goal needs this period.
  dated.forEach((x) => {
    if (remaining <= 0) return;
    const checks = paychecksFor[x.goal.id];
    const overdue = x.date < todayStr;
    const need = overdue || !checks || checks < 1 ? x.remaining : round2(x.remaining / checks);
    give(
      x,
      need,
      overdue
        ? `past its ${x.date} ${x.ownDate ? "target" : "move-out deadline"}`
        : checks
          ? `on pace for ${x.date}${x.ownDate ? "" : " (savings deadline)"} — ${checks} paycheck${checks === 1 ? "" : "s"} left`
          : `due ${x.date}`
    );
  });

  // Tier 2: anything left tops up dated goals ahead of schedule.
  dated.forEach((x) => {
    if (remaining <= 0) return;
    give(x, x.remaining, "ahead of pace");
  });

  // Tier 3: undated goals, least funded first.
  undated.forEach((x) => {
    if (remaining <= 0) return;
    give(x, x.remaining, "no deadline — funded after dated goals");
  });

  return { breakdown, total: round2(breakdown.reduce((s, b) => s + b.amount, 0)) };
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

    if (recent.length < 2) {
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

// ---------- savings goals ----------

function goalProgress(goal) {
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

// Groups real transactions (not fixed_expenses) by merchant so recurring
// charges can be reviewed against what actually hit the account.
function buildSubscriptionAudit(transactions, reviews, rules = [], categoryNames = ["subscription"]) {
  const wanted = categoryNames.map((c) => c.toLowerCase());
  const reviewMap = new Map((reviews || []).map((r) => [r.merchant_key, r]));

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

    const hit = findMatchingRule(latest.merchant_raw, rules);
    out.push({
      key,
      rawSamples: [...new Set(txs.map((t) => t.merchant_raw))],
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
      monthlyEstimate,
      totalSpent: round2(amounts.reduce((s, a) => s + a, 0)),
      status: review ? review.status : "unreviewed"
    });
  });

  return out.sort((a, b) => b.monthlyEstimate - a.monthlyEstimate);
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
      const cadence = s.cadenceOverride || inferCadenceKey(s.intervalDays);
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

async function setSubscriptionStatus(app, merchantKey, status) {
  return patchSubscriptionReview(app, merchantKey, { status });
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
  if (!debt.installment_amount || debt.installment_amount <= 0) return 0;
  return Math.ceil(debtBalance(debt) / debt.installment_amount);
}

function totalDebt(revolving, installment, transactions = null) {
  return round2(
    revolving.reduce((s, d) => s + debtBalance(d, transactions), 0) +
      installment.reduce((s, d) => s + debtBalance(d), 0)
  );
}

// Re-anchors a card debt to a balance the user just stated, and keeps the
// account record holding the same figure. These lived in two files with an
// account_id between them that nothing ever read, so editing the balance in one
// place left the other showing a number from weeks ago.
//
// applied_payments is deliberately KEPT: it no longer reduces a card balance,
// but it still credits the billing cycle's minimum, and wiping it would make a
// minimum you already paid reappear as due.
async function reanchorCardBalance(app, accountId, newBalance) {
  if (!accountId) return false;
  const today = todayLocal();
  const amount = round2(newBalance);
  let touched = false;

  const accounts = await readJSON(app, FILES.accounts, []);
  const ai = accounts.findIndex((a) => a.id === accountId);
  if (ai >= 0 && round2(accounts[ai].current_balance ?? 0) !== amount) {
    accounts[ai].current_balance = amount;
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
      d.payment_category = "BNPL";
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

  let out = (transactions || [])
    .filter((t) => t && t.id && t.amount < 0)
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
    notBefore: debt.balance_anchor ? debt.balance_anchor.date : null,
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
function buildDebtChart(history, projection) {
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
  const maxY = Math.max(...allY, 1);

  const spanX = maxX - minX || 1;
  const sx = (x) => PAD.left + ((x - minX) / spanX) * plotW;
  const sy = (y) => PAD.top + plotH - (y / maxY) * plotH;

  const line = (arr) => arr.map((p, i) => `${i === 0 ? "M" : "L"} ${sx(p.x).toFixed(1)} ${sy(p.y).toFixed(1)}`).join(" ");

  // y gridlines at 0 / 50% / 100%
  const yTicks = [0, maxY / 2, maxY];
  const grid = yTicks
    .map(
      (v) =>
        `<line x1="${PAD.left}" y1="${sy(v).toFixed(1)}" x2="${W - PAD.right}" y2="${sy(v).toFixed(1)}" stroke="var(--background-modifier-border)" stroke-width="1"/>` +
        `<text x="${PAD.left - 8}" y="${(sy(v) + 4).toFixed(1)}" text-anchor="end" font-size="10" fill="var(--text-muted)">$${Math.round(v).toLocaleString()}</text>`
    )
    .join("");

  const fmtDate = (d) => d.slice(5); // MM-DD
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

  const dots = pts
    .map(
      (p) =>
        `<circle cx="${sx(p.x).toFixed(1)}" cy="${sy(p.y).toFixed(1)}" r="3" fill="var(--text-accent, #7b6cd9)"><title>${p.date}: $${p.y.toFixed(2)}</title></circle>`
    )
    .join("");

  return `<svg viewBox="0 0 ${W} ${H}" width="100%" preserveAspectRatio="xMidYMid meet">${grid}${projPath}${solid}${dots}${xLabels}</svg>`;
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
      ["is_transfer", "is_variable_necessity", "exclude_from_discretionary"].forEach((flag) => {
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

  return { rulesUpdated, overridesUpdated, paymentCategoriesUpdated };
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
  "variable_necessity",
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
  "variable_necessity"
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
function summarizeOwnership(transactions, periodStartStr, nextPaydayStr, ownership) {
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
    const type = owner ? owner.class : "discretionary";
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
  ownership = null
}) {
  const empty = { spent: 0, byCategory: [], settled: {}, considered: 0, unowned: [], unsettled: [] };
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

function runAllocation({ cashOnHand, todayStr, nextPaydayStr, fixedExpenses, installmentDebts, revolvingDebts, upcomingSubs = [], earmarked = 0, savingsMode = false, goals = [], paychecksFor = {}, transactions = [], categoryMeta = [], bufferMode = "auto", manualBuffer = 100, currentDateStr = null, savingsDeadline = null, bufferAllocation = null, subscriptionKeys = [], rules = [] }) {
  // todayStr is the FIXED pay-period start, so obligations that came due earlier
  // in the period stay visible. The discretionary buffer is a forward-looking
  // reserve and must count from the actual current date instead.
  const currentDate = currentDateStr || todayStr;

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
    .filter((d) => inPeriod(d.next_due_date, todayStr, nextPaydayStr))
    .map((d) => annotate(d, d.installment_amount || 0, d.next_due_date, d.frequency));

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
    transactions,
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

  const bufferCalc = calculateDynamicBuffer(transactions, categoryMeta, currentDate, nextPaydayStr);

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
    .filter((d) => d.deferred_interest_risk && d.deferred_interest_risk.applies)
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

  const revolvingByAPR = [...revolvingDebts].sort((a, b) => b.apr - a.apr);
  for (const d of revolvingByAPR) {
    if (remaining <= 0) break;
    // Live balance: a card that has been charged since its anchor owes more than
    // the anchor says, and recommending against the stale figure under-pays it.
    const chunk = Math.min(remaining, debtBalance(d, transactions));
    if (chunk > 0) {
      payoffBreakdown.push({ target: debtLabel(d), amount: round2(chunk), reason: `highest APR (${d.apr}%)` });
      remaining -= chunk;
    }
  }

  const otherInstallments = installmentDebts.filter((d) => !deferredRisk.includes(d));
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
  // distributed across goals instead.
  const savingsPlan = savingsMode
    ? recommendSavings(goals, Math.max(availableForDebt, 0), paychecksFor, currentDate, savingsDeadline)
    : { breakdown: [], total: 0 };
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
    ownershipSummary: summarizeOwnership(transactions, todayStr, nextPaydayStr, ownership),
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
      t.id = genId("tx");
      repaired++;
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
      if (hold.excluded_from_debt_payments) keep.excluded_from_debt_payments = true;
      if (!keep.debt_payment_review_status && hold.debt_payment_review_status) {
        keep.debt_payment_review_status = hold.debt_payment_review_status;
      }
      keep.pending = undefined;
      rows[idx] = keep;
    }
    if (holdOwner) relink.push({ from: hold.id, to: posted.id });
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
const PIE_COLORS = [
  "var(--color-blue, #086ddd)",
  "var(--color-green, #08b94e)",
  "var(--color-orange, #ec7500)",
  "var(--color-purple, #7852ee)",
  "var(--color-red, #e93147)",
  "var(--color-cyan, #00bfbc)",
  "var(--color-yellow, #e0ac00)",
  "var(--color-pink, #d53984)",
  "var(--color-accent, #7b6cd9)"
];

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
function reconcileImport(existing, incoming) {
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

    const exactIdx = merged.findIndex((t) => sameTxFields(t, tx));
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
    return "Enter your next expected payday (YYYY-MM-DD).";
  }
  const normalized = normalizeDate(nextPaydayStr.trim());
  if (!/^\d{4}-\d{2}-\d{2}$/.test(normalized)) {
    return `"${nextPaydayStr}" isn't a valid date. Use YYYY-MM-DD, e.g. 2026-09-22.`;
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
    let amount = detected ? String(detected.amount.toFixed(2)) : "";
    let nextPayday = scheduled || "";
    let checking = this.prefill.checkingBalance != null ? String(this.prefill.checkingBalance) : "";
    let alreadyDeposited = true;

    if (detected) {
      contentEl.createEl("p", {
        text: `Auto-filled from your most recent Paycheck transaction: $${detected.amount.toFixed(2)} on ${detected.date} (${guessMerchantKey(detected.merchant_raw)}). Change it if this check differs.`,
        cls: "budget-muted budget-autodetect-hint"
      });
    }

    const amountSetting = new Setting(contentEl).setName("Paycheck amount");
    amountSetting.addText((t) => t.setValue(amount).onChange((v) => (amount = v)));
    if (detected) {
      amountSetting.addExtraButton((b) =>
        b
          .setIcon("rotate-ccw")
          .setTooltip("Reset to detected amount")
          .onClick(() => {
            amount = String(detected.amount.toFixed(2));
            const input = amountSetting.controlEl.querySelector("input");
            if (input) input.value = amount;
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

    new Setting(contentEl)
      .setName("Current checking balance")
      .setDesc("Your actual balance right now, whatever the account says today.")
      .addText((t) => t.setValue(checking).onChange((v) => (checking = v)));

    const paydaySetting = new Setting(contentEl).setName("Next expected payday");
    if (scheduled) {
      paydaySetting.setDesc(
        `Filled in from your pay schedule (${this.prefill.scheduleLabel}). Only change this for an off-cycle check.`
      );
    } else {
      paydaySetting.setDesc(
        "YYYY-MM-DD. Set a pay schedule in Settings and this fills itself in from now on."
      );
    }
    paydaySetting.addText((t) => t.setValue(nextPayday).onChange((v) => (nextPayday = v)));
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
          this.close();
          this.onSubmit({
            paycheckAmount: parseFloat(amount) || 0,
            checkingBalance: parseFloat(checking) || 0,
            alreadyDeposited,
            nextPaydayStr: nextPayday
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

    let amtInput, cntInput, balInput;
    let editingBalanceDirectly = false;

    const num = (v) => {
      const n = parseFloat(String(v).replace(/[$,]/g, ""));
      return isNaN(n) ? 0 : n;
    };

    const syncFromParts = () => {
      if (editingBalanceDirectly) return;
      const total = num(d.installment_amount) * num(d.remaining_installments);
      d.balance = total.toFixed(2);
      if (balInput) balInput.value = d.balance;
    };
    const syncFromBalance = () => {
      const amt = num(d.installment_amount);
      if (amt <= 0) return;
      const cnt = Math.ceil(num(d.balance) / amt);
      d.remaining_installments = String(cnt);
      if (cntInput) cntInput.value = d.remaining_installments;
    };

    new Setting(contentEl)
      .setName("Installment amount")
      .addText((t) => {
        amtInput = t.inputEl;
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
      )
      .addText((t) => {
        balInput = t.inputEl;
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
      .setDesc("YYYY-MM-DD")
      .addText((t) => t.setValue(d.next_due_date).onChange((v) => (d.next_due_date = v)));

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

    new Setting(riskFields)
      .setName("Retroactive APR (%)")
      .addText((t) => t.setValue(d.retroactive_apr).onChange((v) => (d.retroactive_apr = v)));
    new Setting(riskFields)
      .setName("Payoff deadline")
      .setDesc("YYYY-MM-DD")
      .addText((t) => t.setValue(d.payoff_deadline).onChange((v) => (d.payoff_deadline = v)));
    new Setting(riskFields)
      .setName("Original principal")
      .setDesc("What interest would be charged on if the deadline is missed.")
      .addText((t) => t.setValue(d.original_principal).onChange((v) => (d.original_principal = v)));
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
          const amt = num(d.installment_amount);
          const bal = num(d.balance);
          if (amt <= 0) {
            new Notice("Installment amount must be greater than 0.");
            return;
          }
          if (bal < 0) {
            new Notice("Balance can't be negative.");
            return;
          }
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
            plan.deferred_interest_risk = {
              applies: true,
              retroactive_apr: num(d.retroactive_apr),
              payoff_deadline: d.payoff_deadline.trim(),
              original_principal: num(d.original_principal)
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
    new Setting(contentEl).setName("Amount").addText((t) => t.setValue(data.amount).onChange((v) => (data.amount = v)));

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
        [...new Set(this.categoryNames)].sort().forEach((n) => d.addOption(n, n));
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
      .setDesc("YYYY-MM-DD \u2014 when you next expect to pay it.")
      .addText((t) => t.setValue(data.next_due_date).onChange((v) => (data.next_due_date = v)));
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
          const amount = parseFloat(String(data.amount).replace(/[$,]/g, ""));
          if (isNaN(amount) || amount <= 0) {
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
              new Notice("Next expected date must be YYYY-MM-DD.");
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
  constructor(app, onSubmit, existing = null) {
    super(app);
    this.onSubmit = onSubmit;
    this.existing = existing;
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
          invert_positive_charges: !!e.invert_positive_charges
        }
      : {
          id: "",
          type: "checking",
          institution: "",
          current_balance: "",
          credit_limit: "",
          csv_source: "mainbank",
          invert_positive_charges: false
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

    new Setting(contentEl)
      .setName("Current balance")
      .setDesc("For checking/savings: what's in it. For credit cards: what you owe right now.")
      .addText((t) => t.setValue(data.current_balance).onChange((v) => (data.current_balance = v)));

    new Setting(contentEl)
      .setName("Credit limit")
      .setDesc("Only needed for credit cards — leave blank otherwise")
      .addText((t) => t.setValue(data.credit_limit).onChange((v) => (data.credit_limit = v)));

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

    new Setting(contentEl).addButton((b) =>
      b
        .setButtonText(e ? "Save changes" : "Save")
        .setCta()
        .onClick(() => {
          this.close();
          const patch = {
            id: e ? e.id : data.id,
            type: data.type,
            institution: data.institution,
            current_balance: parseFloat(data.current_balance) || 0,
            credit_limit: data.credit_limit ? parseFloat(data.credit_limit) : undefined,
            csv_source: data.csv_source,
            invert_positive_charges: !!data.invert_positive_charges
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
    new Setting(contentEl).setName("Current balance").addText((t) => t.onChange((v) => (data.current_balance = v)));
    new Setting(contentEl)
      .setName("Statement balance")
      .setDesc("What was owed as of the last statement — this is what your minimum payment is based on")
      .addText((t) => t.onChange((v) => (data.statement_balance = v)));
    new Setting(contentEl).setName("APR (%)").addText((t) => t.onChange((v) => (data.apr = v)));
    new Setting(contentEl).setName("Minimum payment due").addText((t) => t.onChange((v) => (data.min_payment_due = v)));
    new Setting(contentEl).setName("Due date (YYYY-MM-DD)").addText((t) => t.onChange((v) => (data.due_date = v)));

    new Setting(contentEl).addButton((b) =>
      b
        .setButtonText("Save")
        .setCta()
        .onClick(() => {
          this.close();
          this.onSubmit({
            account_id: data.account_id,
            current_balance: parseFloat(data.current_balance) || 0,
            statement_balance: parseFloat(data.statement_balance) || 0,
            apr: parseFloat(data.apr) || 0,
            min_payment_due: parseFloat(data.min_payment_due) || 0,
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
    return "Enter the due date this payment covers as YYYY-MM-DD.";
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
        t.setValue(this.defaultDate || "").onChange((v) => {
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
        this.existingLabels.forEach((l) => d.addOption(l, l));
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

    if (isInstallment) {
      new Setting(contentEl)
        .setName("Remaining installments")
        .setDesc(`At $${(d.installment_amount || 0).toFixed(2)} each.`)
        .addText((t) =>
          t.setValue(installments).onChange((v) => {
            installments = v;
            const n = parseInt(v);
            if (!isNaN(n)) value = String((n * (d.installment_amount || 0)).toFixed(2));
          })
        );
    }

    new Setting(contentEl)
      .setName(isInstallment ? "Or set the remaining balance directly" : "Current balance owed")
      .addText((t) => t.setValue(value).onChange((v) => (value = v)));

    new Setting(contentEl).addButton((b) =>
      b
        .setButtonText("Save balance")
        .setCta()
        .onClick(() => {
          const n = parseFloat(String(value).replace(/[$,]/g, ""));
          if (isNaN(n) || n < 0) {
            new Notice("Enter a balance of 0 or more.");
            return;
          }
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
    const refreshTotal = () => {
      const sum = this.candidates.filter((c) => chosen.has(c.id)).reduce((s, c) => s + Math.abs(c.amount), 0);
      totalEl.setText(
        sum <= 0
          ? "Nothing selected yet."
          : cardMode
            ? `Crediting $${sum.toFixed(2)} against this cycle's minimum.`
            : `Applying $${sum.toFixed(2)} \u2192 new balance $${Math.max(0, debtBalance(d) - sum).toFixed(2)}`
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
          this.onSubmit(picked);
        })
    );
  }
  onClose() {
    this.contentEl.empty();
  }
}

class RenameSubscriptionModal extends Modal {
  constructor(app, group, allTx, onSubmit) {
    super(app);
    this.group = group;
    this.allTx = allTx;
    this.onSubmit = onSubmit;
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

    const countEl = contentEl.createEl("p", { cls: "budget-muted budget-match-count" });
    const refreshCount = () => {
      const p = pattern.trim().toUpperCase();
      if (!p) {
        countEl.setText("Enter a pattern to see what it would match.");
        return;
      }
      const n = this.allTx.filter((t) => (t.merchant_raw || "").toUpperCase().includes(p)).length;
      countEl.setText(`Matches ${n} transaction${n === 1 ? "" : "s"} in your history.`);
    };

    new Setting(contentEl)
      .setName("Pattern to match")
      .setDesc("Widen this to pull in charges that are currently splitting into separate groups.")
      .addText((t) =>
        t.setValue(pattern).onChange((v) => {
          pattern = v;
          refreshCount();
        })
      );
    refreshCount();

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
  constructor(app, onSubmit, existing = null) {
    super(app);
    this.onSubmit = onSubmit;
    this.existing = existing;
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
      target_date: e ? e.target_date || "" : ""
    };

    new Setting(contentEl)
      .setName("Goal name")
      .setDesc("e.g. Emergency Fund, Car Repairs, Vet Bill")
      .addText((t) => t.setValue(d.name).onChange((v) => (d.name = v)));
    new Setting(contentEl).setName("Target amount").addText((t) => t.setValue(d.target_amount).onChange((v) => (d.target_amount = v)));
    new Setting(contentEl)
      .setName("Already saved")
      .setDesc("What's set aside for this today.")
      .addText((t) => t.setValue(d.saved_amount).onChange((v) => (d.saved_amount = v)));
    new Setting(contentEl)
      .setName("Target date (optional)")
      .setDesc("YYYY-MM-DD. Used to suggest a per-paycheck pace.")
      .addText((t) => t.setValue(d.target_date).onChange((v) => (d.target_date = v)));

    new Setting(contentEl).addButton((b) =>
      b
        .setButtonText(isEdit ? "Save changes" : "Create goal")
        .setCta()
        .onClick(() => {
          const num = (v) => parseFloat(String(v).replace(/[$,]/g, ""));
          if (!d.name.trim()) {
            new Notice("Give the goal a name.");
            return;
          }
          const target = num(d.target_amount);
          if (isNaN(target) || target <= 0) {
            new Notice("Target amount must be greater than 0.");
            return;
          }
          const saved = num(d.saved_amount) || 0;
          if (saved < 0) {
            new Notice("Saved amount can't be negative.");
            return;
          }
          const date = d.target_date.trim() ? normalizeDate(d.target_date.trim()) : "";
          if (date && !/^\d{4}-\d{2}-\d{2}$/.test(date)) {
            new Notice("Target date must be YYYY-MM-DD.");
            return;
          }
          this.close();
          this.onSubmit({
            name: d.name.trim(),
            target_amount: round2(target),
            saved_amount: round2(saved),
            target_date: date || null
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

    new Setting(contentEl)
      .setName("Amount")
      .setDesc("Defaults to the whole unspent allowance. Lower it if some of that money is already spoken for.")
      .addText((t) =>
        t.setValue(this.remaining.toFixed(2)).onChange((v) => {
          const n = parseFloat(String(v).replace(/[$,]/g, ""));
          this.amount = isNaN(n) ? 0 : round2(Math.min(Math.max(0, n), this.remaining));
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
    new Setting(contentEl).setName("Amount to move").addText((t) => t.onChange((v) => (amount = v)));
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
          const n = parseFloat(String(amount).replace(/[$,]/g, ""));
          if (isNaN(n) || n === 0) {
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
      new Setting(contentEl)
        .setName(`${a.institution || a.id}`)
        .setDesc(
          a.type === "credit_card"
            ? `Credit card — what you owe right now${a.credit_limit ? ` (limit $${a.credit_limit})` : ""}`
            : `${a.type} — what's in it right now`
        )
        .addText((t) => t.setValue(values[a.id]).onChange((v) => (values[a.id] = v)));
    });

    new Setting(contentEl).addButton((b) =>
      b
        .setButtonText("Save balances")
        .setCta()
        .onClick(() => {
          const patch = {};
          for (const id of Object.keys(values)) {
            const n = parseFloat(String(values[id]).replace(/[$,]/g, ""));
            if (isNaN(n)) {
              new Notice("Balances must be numbers.");
              return;
            }
            patch[id] = round2(n);
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
    const options = this.allCategories.filter((x) => x.name !== c.name).map((x) => x.name);

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
  return { rulesChanged, txChanged, paymentCategoriesChanged };
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
      text: "Open your Fidelity statement, Select All, Copy, then paste the statement text below.",
      cls: "budget-muted"
    });
    contentEl.createEl("p", {
      text:
        "Only balances, dates, holdings and allocation are read. Name, address, employee number and " +
        "bank details are ignored and never saved, and the pasted text itself is never written to disk.",
      cls: "budget-muted budget-apply-scope"
    });

    // Only consulted when the pasted statement carries no period of its own —
    // Fidelity's HSA detail view does not include one.
    const defaultMonth = previousMonthKey(todayLocal());
    this.monthHint = this.monthHint || defaultMonth;
    new Setting(contentEl)
      .setName("Statement month")
      .setDesc("Used only if the pasted text has no statement period. YYYY-MM.")
      .addText((t) =>
        t.setValue(this.monthHint).onChange((v) => (this.monthHint = v.trim()))
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

    const parsed = parsePortfolioStatement(text, this.monthHint);

    if (!parsed.ok) {
      // Textarea intentionally left intact so the user can retry.
      this.showResult("fail", "Import failed — nothing was saved", [
        ...parsed.missing.map((m) => `Could not identify: ${m}`),
        "The pasted text has been kept so you can check and try again."
      ]);
      return;
    }

    const account = PORTFOLIO_ACCOUNTS.find((a) => a.id === parsed.snapshot.account_id);
    const snapshots = await readJSON(this.app, FILES.portfolioSnapshots, []);
    const existingIdx = snapshots.findIndex(
      (s) => s.account_id === parsed.snapshot.account_id && s.statement_end === parsed.snapshot.statement_end
    );

    if (existingIdx >= 0) {
      const same = JSON.stringify(snapshots[existingIdx]) === JSON.stringify(parsed.snapshot);
      if (same) {
        this.showResult("ok", "Already imported", [
          `${account.label} — ${parsed.snapshot.statement_start} to ${parsed.snapshot.statement_end}`,
          "This statement is already stored and identical. Nothing changed."
        ]);
        return;
      }
      new ConfirmModal(this.app, {
        title: `Replace the ${monthNameFromKey(portfolioMonthKey(parsed.snapshot.statement_end))} snapshot?`,
        body: [
          `${account.label} already has a snapshot ending ${parsed.snapshot.statement_end}, and the pasted statement has different values.`,
          `Stored ending value $${round2(snapshots[existingIdx].ending_value).toFixed(2)} → pasted $${round2(parsed.snapshot.ending_value).toFixed(2)}.`
        ],
        confirmText: "Replace",
        onConfirm: async () => {
          const list = await readJSON(this.app, FILES.portfolioSnapshots, []);
          const i = list.findIndex(
            (s) => s.account_id === parsed.snapshot.account_id && s.statement_end === parsed.snapshot.statement_end
          );
          if (i >= 0) list[i] = parsed.snapshot;
          else list.push(parsed.snapshot);
          await writeJSON(this.app, FILES.portfolioSnapshots, list);
          this.finish(ta, account, parsed, "Snapshot replaced");
        }
      }).open();
      return;
    }

    snapshots.push(parsed.snapshot);
    snapshots.sort((a, b) => (a.statement_end < b.statement_end ? -1 : 1));
    await writeJSON(this.app, FILES.portfolioSnapshots, snapshots);
    this.finish(ta, account, parsed, "Statement imported");
  }

  finish(ta, account, parsed, title) {
    const s = parsed.snapshot;
    const lines = [
      `${account.label} — ${s.statement_start} to ${s.statement_end}`,
      `Ending value $${round2(s.ending_value).toFixed(2)}`
    ];
    if (s.beginning_value != null) lines.push(`Beginning value $${round2(s.beginning_value).toFixed(2)}`);
    if (s.vested_value != null) lines.push(`Vested balance $${round2(s.vested_value).toFixed(2)}`);
    if (s.change_in_market_value != null)
      lines.push(`Change in market value $${round2(s.change_in_market_value).toFixed(2)}`);
    if (s.change_from_last_period != null)
      lines.push(`Change from last period $${round2(s.change_from_last_period).toFixed(2)}`);
    if (s.change_in_investment_value != null)
      lines.push(`Change in investment value $${round2(s.change_in_investment_value).toFixed(2)}`);
    if (s.personal_rate_of_return != null)
      lines.push(`Personal rate of return ${s.personal_rate_of_return}%`);
    if (s.allocation)
      lines.push(
        `Allocation ${s.allocation.stocks_pct}% stocks · ${s.allocation.bonds_pct}% bonds · ${s.allocation.short_term_other_pct}% short-term/other`
      );
    if (s.holdings && s.holdings.length) lines.push(`${s.holdings.length} holding(s) captured`);
    (parsed.warnings || []).forEach((w) => lines.push(`Note: ${w}`));

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
    const title =
      status === "success"
        ? "Import succeeded"
        : status === "review"
          ? "Import succeeded — review needed"
          : "Import failed";

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
  constructor(app, merchant, amount, existingLabels, onSubmit, existingRule = null) {
    super(app);
    this.merchant = merchant;
    this.amount = amount;
    this.existingLabels = existingLabels;
    this.onSubmit = onSubmit;
    this.existingRule = existingRule;
  }
  onOpen() {
    const { contentEl } = this;
    contentEl.createEl("h2", { text: "Categorize transaction" });
    contentEl.createEl("p", { text: (this.existingRule && this.existingRule.display_name) || guessMerchantKey(this.merchant), cls: "budget-modal-merchant" });
    contentEl.createEl("p", { text: this.merchant, cls: "budget-muted budget-modal-raw" });

    const isIncome = this.amount > 0;
    const amountLine = contentEl.createEl("p", {
      text: isIncome
        ? `+$${this.amount.toFixed(2)} \u2014 this is money coming IN (e.g. Paycheck, Misc Income, or a Transfer in)`
        : `-$${Math.abs(this.amount).toFixed(2)} \u2014 this is money going OUT`,
      cls: isIncome ? "budget-positive budget-amount-hint" : "budget-negative budget-amount-hint"
    });

    const rule = this.existingRule;
    let pattern = rule ? rule.merchant_pattern : guessMerchantKey(this.merchant);
    let selected = rule ? rule.home_label : "";
    let nickname = rule && rule.display_name ? rule.display_name : "";
    let typed = "";

    if (rule) {
      contentEl.createEl("p", {
        text: `Currently matched by the rule \u201c${rule.merchant_pattern}\u201d \u2192 ${rule.home_label}. Editing below updates that rule for every matching transaction.`,
        cls: "budget-muted budget-existing-rule-hint"
      });
    }

    new Setting(contentEl)
      .setName("Pattern to match")
      .setDesc(
        "Only used by \u201cSave as Merchant Rule\u201d. Future transactions containing this text will auto-categorize. " +
          "Pre-filled with a guess at the merchant name \u2014 shorten or fix it so it'll actually match next time (e.g. just \u2018RIGOBERTOS\u2019, not the whole line)."
      )
      .addText((t) => t.setValue(pattern).onChange((v) => (pattern = v)));

    new Setting(contentEl)
      .setName("Display nickname (optional)")
      .setDesc("A clean name shown everywhere in the UI, e.g. \u201cKindle Unlimited\u201d. The raw bank text is kept as a tooltip.")
      .addText((t) => t.setValue(nickname).onChange((v) => (nickname = v)));

    const dropdownLabels = [...new Set(this.existingLabels.concat(selected ? [selected] : []))].filter(Boolean).sort();
    if (dropdownLabels.length > 0) {
      new Setting(contentEl).setName("Use an existing category").addDropdown((d) => {
        d.addOption("", "— choose —");
        dropdownLabels.forEach((l) => d.addOption(l, l));
        d.setValue(selected);
        d.onChange((v) => (selected = v));
      });
    }

    new Setting(contentEl)
      .setName("Or type a new category")
      .setDesc(this.existingLabels.length > 0 ? "Leave blank to use the dropdown selection above." : "")
      .addText((t) => t.onChange((v) => (typed = v)));

    const resolveLabel = () => (typed && typed.trim()) || selected;

    new Setting(contentEl)
      .setName("How should this apply?")
      .setDesc(
        "A merchant rule auto-categorizes this merchant every time it appears, now and in future imports. " +
          "A one-off override changes only this single transaction and leaves the merchant's usual rule untouched."
      );

    const btnRow = contentEl.createDiv({ cls: "budget-modal-btn-row" });

    const ruleBtn = btnRow.createEl("button", {
      text: rule ? "Update Merchant Rule" : "Save as Merchant Rule",
      cls: "mod-cta"
    });
    ruleBtn.onclick = () => {
      const label = resolveLabel();
      if (!label) {
        new Notice("Pick or type a category first.");
        return;
      }
      if (!pattern.trim()) {
        new Notice("A merchant rule needs a pattern to match. Fill that in, or use the one-off override instead.");
        return;
      }
      this.close();
      this.onSubmit({ mode: "rule", pattern: pattern.trim(), label, nickname: nickname.trim() });
    };

    const overrideBtn = btnRow.createEl("button", { text: "Apply Just Once (Override)" });
    overrideBtn.onclick = () => {
      const label = resolveLabel();
      if (!label) {
        new Notice("Pick or type a category first.");
        return;
      }
      this.close();
      this.onSubmit({ mode: "override", pattern: null, label, nickname: null });
    };
  }
  onClose() {
    this.contentEl.empty();
  }
}

class EditRuleModal extends Modal {
  constructor(app, rule, onSubmit) {
    super(app);
    this.rule = rule;
    this.onSubmit = onSubmit;
  }
  onOpen() {
    const { contentEl } = this;
    contentEl.createEl("h2", { text: "Edit rule" });
    let pattern = this.rule.merchant_pattern;
    let label = this.rule.home_label;
    let nickname = this.rule.display_name || "";

    new Setting(contentEl)
      .setName("Pattern to match")
      .setDesc("Shorten this to just the merchant name if it's currently a whole raw transaction line — that's usually why it stops matching future transactions.")
      .addText((t) => t.setValue(pattern).onChange((v) => (pattern = v)));

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
    return "Budget Dashboard";
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

    container.createEl("h2", { text: "Budget Dashboard", cls: "budget-title" });

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
    addAction(shortLabels ? "Mark Paid" : "Mark Bill Paid", () => this.plugin.promptMarkFixedPaid(), {
      tooltip: "Record a recurring bill as paid and link the transaction that paid it"
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
      existingLabels: [...new Set(rules.map((r) => r.home_label))].sort(),
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
    const figures = hero.createDiv({ cls: "budget-hero-figures" });
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
    if (r.recommendedSavings) deductions.push(`$${r.recommendedSavings.toFixed(2)} to goals`);
    if (r.recommendedExtraPayoff) deductions.push(`$${r.recommendedExtraPayoff.toFixed(2)} to debt`);
    basis.createSpan({
      text: `from $${cashOnHand.toFixed(2)} on hand` + (deductions.length ? ` − ${deductions.join(" − ")}` : "")
    });
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
        savings: "Savings transfers",
        subscription: "Subscriptions",
        transfer: "Transfers between accounts",
        variable_necessity: "Variable necessities",
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
        const row = ownBox.createDiv({ cls: "budget-fixed-row" });
        const col = row.createDiv({ cls: "budget-fixed-name budget-buffer-text" });
        col.createDiv({ text: OWNER_LABELS[b.type] || b.type });
        col.createDiv({
          text:
            `${b.count} transaction${b.count === 1 ? "" : "s"}` +
            (b.explicit ? ` · ${b.explicit} linked` : b.type === "discretionary" ? "" : " · matched by category"),
          cls: "budget-buffer-sub"
        });
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
    if (!r.savingsMode) {
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
        const list = savings.createEl("ul", { cls: "budget-list" });
        sb.forEach((b) => {
          const li = list.createEl("li");
          li.createSpan({ text: b.target });
          li.createSpan({ text: `$${b.amount.toFixed(2)}`, cls: "budget-amount budget-positive" });
          li.createEl("div", { text: b.reason, cls: "budget-muted budget-reason" });
        });
        savings.createEl("p", {
          text: `$${r.recommendedSavings.toFixed(2)} allocated to goals.`,
          cls: "budget-muted"
        });
      }
    }
  }

  renderGoalsCard(container, ctx) {
    const { allTx, rules } = ctx;
    // ---- Savings goals ----
    const goals = ctx.savingsGoals || [];
    const goalsCard = container.createDiv({ cls: "budget-card budget-goals-card" });
    const goalsHead = goalsCard.createDiv({ cls: "budget-sub-head" });
    goalsHead.createEl("h4", { text: "Savings goals" });
    const addGoalBtn = goalsHead.createEl("button", { text: "New goal", cls: "budget-btn" });
    addGoalBtn.onclick = () => {
    new SavingsGoalModal(this.app, async (goal) => {
      goal.id = genId("goal");
      goal.contributions = [];
      const list = await readJSON(this.app, FILES.savingsGoals, []);
      list.push(goal);
      await writeJSON(this.app, FILES.savingsGoals, list);
      new Notice(`Created goal: ${goal.name}`);
      this.render();
    }).open();
    };

    if (goals.length === 0) {
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

      const meta = row.createDiv({ cls: "budget-goal-meta" });
      const pace = goalPace(g, todayLocal(), periodDays, resolvePaySchedule(this.plugin.settings, allTx));
      if (p.complete) {
        meta.createSpan({ text: "Goal reached." });
      } else if (pace && g.target_date) {
        let paceText;
        if (pace.days <= 0) {
          paceText = `$${p.remaining.toFixed(2)} to go \u00b7 target date ${g.target_date} has passed`;
        } else if (pace.paychecks === 0) {
          paceText = `$${p.remaining.toFixed(2)} to go \u00b7 no paycheck lands before ${g.target_date}, so it all has to come from this one`;
        } else if (pace.exact) {
          paceText =
            `$${p.remaining.toFixed(2)} to go \u00b7 ${pace.paychecks} paycheck${pace.paychecks === 1 ? "" : "s"} before ${g.target_date} \u00b7 $${pace.perPeriod.toFixed(2)} each` +
            (pace.inferred ? " (cadence inferred from your paycheck history)" : "");
        } else {
          paceText = `$${p.remaining.toFixed(2)} to go \u00b7 by ${g.target_date} (${pace.days} days) \u00b7 roughly $${pace.perPeriod.toFixed(2)} per paycheck (set a pay schedule for an exact count)`;
        }
        meta.createSpan({ text: paceText });
      } else {
        meta.createSpan({ text: `$${p.remaining.toFixed(2)} to go` });
      }

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
              await writeJSON(this.app, FILES.savingsGoals, list);
              new Notice(`Updated ${patch.name}.`);
              this.render();
            }
          },
          g
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
            "This doesn't move any real money; it only stops tracking the goal."
          ],
          onConfirm: async () => {
            const list = await readJSON(this.app, FILES.savingsGoals, []);
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
          heldBack > 0
            ? `${contribs.length} \u00b7 $${heldBack.toFixed(2)} held back from free cash`
            : `${contribs.length} \u00b7 all matched to transactions`,
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
          if (c.linked_tx_id) {
            meta.createSpan({ text: "matched to transaction", cls: "budget-badge budget-badge-keep" });
          } else if (c.amount > 0) {
            meta.createSpan({ text: "held back from free cash", cls: "budget-badge budget-badge-manual" });
          }

          const acts = cr.createDiv({ cls: "budget-contrib-btns" });
          if (c.linked_tx_id) {
            const unlink = acts.createEl("button", { text: "Unmatch", cls: "budget-btn" });
            unlink.onclick = async () => {
              await unlinkContribution(this.app, g.id, c.id);
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
          const del = acts.createEl("button", { text: "Remove", cls: "budget-btn budget-btn-danger" });
          del.onclick = async () => {
            await deleteContribution(this.app, g.id, c.id);
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
      chartDiv.innerHTML = `<svg viewBox="0 0 200 200" preserveAspectRatio="xMidYMid meet">${svgParts}</svg>`;

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
      incomeWrap.createDiv({ cls: "budget-pie-chart" }).innerHTML =
        `<svg viewBox="0 0 200 200" preserveAspectRatio="xMidYMid meet">${incomeSvg}</svg>`;

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
        text: "Set a valid deadline (YYYY-MM-DD) in settings.",
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
      const goals = ctx.savingsGoals || [];
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

    if (allDebts.length === 0) {
      debtCard.createEl("p", {
        text: "No debts tracked yet \u2014 use \u201cCredit Card Terms\u201d or \u201cAdd BNPL Plan\u201d above.",
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
        nameLine.createSpan({ text: kind === "cc" ? "credit card" : "BNPL", cls: "budget-badge budget-badge-transfer" });
        if (debt.deferred_interest_risk && debt.deferred_interest_risk.applies) {
          nameLine.createSpan({
            text: `0% until ${debt.deferred_interest_risk.payoff_deadline}`,
            cls: "budget-badge budget-badge-warn"
          });
        }

        const bits = [];
        if (kind === "cc" && debt.apr) bits.push(`${debt.apr}% APR`);
        if (kind === "bnpl") {
          const left = remainingInstallments(debt);
          bits.push(`${left} \u00d7 $${(debt.installment_amount || 0).toFixed(2)} left`);
          if (debt.next_due_date) bits.push(`next ${debt.next_due_date}`);
        }
        const applied = (debt.applied_payments || []).length;
        if (applied) bits.push(`${applied} payment${applied === 1 ? "" : "s"} applied`);
        textCol.createDiv({ text: bits.join(" \u00b7 "), cls: "budget-debt-meta" });

        if (cardState) {
          const parts = [`anchored $${cardState.anchor.toFixed(2)}${cardState.since ? ` on ${cardState.since}` : ""}`];
          if (cardState.derived) {
            if (cardState.chargeCount) {
              parts.push(`+$${cardState.charges.toFixed(2)} in ${cardState.chargeCount} charge${cardState.chargeCount === 1 ? "" : "s"}`);
            }
            if (cardState.paymentCount) {
              parts.push(`\u2212$${cardState.payments.toFixed(2)} in ${cardState.paymentCount} payment${cardState.paymentCount === 1 ? "" : "s"}`);
            }
          } else {
            parts.push("no card activity imported since");
          }
          textCol.createDiv({ text: parts.join(" \u00b7 "), cls: "budget-debt-meta budget-debt-seam" });

          // The anchor and the ledger can be days apart. Saying so beats
          // presenting a figure that silently stops at the last import.
          const acct = accounts.find((a) => a.id === debt.account_id);
          const through = acct && acct.last_imported_through;
          if (through) {
            const behind = daysBetween(through, todayLocal());
            textCol.createDiv({
              text:
                behind > 0
                  ? `Card imported through ${through} \u2014 ${behind} day${behind === 1 ? "" : "s"} of activity may not be counted yet.`
                  : `Card imported through ${through}.`,
              cls: `budget-debt-meta${behind > 3 ? " budget-debt-stale" : ""}`
            });
          }
        }

        const amtCol = row.createDiv({ cls: "budget-debt-amt-col" });
        amtCol.createSpan({ text: `$${bal.toFixed(2)}`, cls: "budget-amount" });

        const pending = candidatePayments(debt, allTx, allDebts, categoryMetaList, ownership);
        const btnCol = row.createDiv({ cls: "budget-debt-btn-col" });

        const applyBtn = btnCol.createEl("button", {
          text: pending.length ? `Apply Payment (${pending.length})` : "Apply Payment",
          cls: pending.length ? "budget-btn mod-cta" : "budget-btn"
        });
        applyBtn.onclick = () => {
          new ApplyPaymentModal(this.app, debt, pending, async (picked) => {
            const file = kind === "cc" ? FILES.revolvingDebts : FILES.installmentDebts;
            const list = await readJSON(this.app, file, []);
            const idx = list.findIndex((d) => debtKey(d) === debtKey(debt));
            if (idx < 0) return;
            list[idx].applied_payments = (list[idx].applied_payments || []).concat(
              picked.map((p) => ({ tx_id: p.id, amount: Math.abs(p.amount), date: p.date }))
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

        if (kind === "bnpl") {
          const editPlanBtn = btnCol.createEl("button", { text: "Edit Plan", cls: "budget-btn" });
          editPlanBtn.onclick = () => this.plugin.promptEditBNPL(debt);
        }

        const delDebt = btnCol.createEl("button", { text: "Delete", cls: "budget-btn budget-btn-danger" });
        delDebt.onclick = () => {
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

        const editBtn = btnCol.createEl("button", {
          text: kind === "bnpl" ? "Set Balance" : "Edit Balance",
          cls: "budget-btn"
        });
        editBtn.onclick = () => {
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
      };

      revolvingDebts.forEach((d) => renderDebtRow(d, "cc"));
      installmentDebts.forEach((d) => renderDebtRow(d, "bnpl"));
    }

    // ---- Total debt progress ----
    const history = await readJSON(this.app, FILES.debtHistory, []);
    if (history.length > 0) {
      const progressCard = container.createDiv({ cls: "budget-card budget-progress-card" });
      progressCard.createEl("h4", { text: "Total debt progress" });

      const projection = projectPayoff(grandTotal, this.lastResult);
      const svg = buildDebtChart(history, projection);
      if (svg) {
        const chartWrap = progressCard.createDiv({ cls: "budget-chart-wrap" });
        chartWrap.innerHTML = svg;
      }

      if (history.length === 1) {
        progressCard.createEl("p", {
          text: "Only one data point so far \u2014 the line fills in as balances change over time.",
          cls: "budget-muted"
        });
      }
      if (projection) {
        const months = Math.round(projection.daysToZero / 30.4);
        progressCard.createEl("p", {
          text: `At this period's pace ($${projection.perPeriod.toFixed(2)} per period), debt-free around ${projection.zeroDate} \u2014 roughly ${months} month${months === 1 ? "" : "s"}. Dotted line shows that projection.`,
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

  async renderTransactions(container, ctx) {
    const { allTx, rules, existingLabels } = ctx;
    const grid2 = container.createDiv({ cls: "budget-grid" });

    const uncatOuter = grid2.createDiv({ cls: "budget-card" });
    const uncategorized = allTx.filter((t) => t.resolved_category === "Uncategorized");
    const uncatCard = this.collapsible(
      uncatOuter,
      "uncategorized",
      "Uncategorized transactions",
      uncategorized.length ? `${uncategorized.length} need labels` : "all clear",
      true
    );
    if (uncategorized.length === 0) {
      uncatCard.createEl("p", { text: "None \u2014 everything's categorized.", cls: "budget-muted" });
    } else {
      uncategorized.slice(0, isMobileApp() ? 10 : 20).forEach((t) => {
        const row = uncatCard.createDiv({ cls: "budget-tx-row" });
        const isIncome = t.amount > 0;
        row.createSpan({ text: `${t.date}  ${displayMerchant(t.merchant_raw, rules)}  `, cls: "budget-tx-text" }).setAttr(
          "title",
          t.merchant_raw
        );
        row.createSpan({
          text: isIncome ? `+$${t.amount.toFixed(2)}` : `-$${Math.abs(t.amount).toFixed(2)}`,
          cls: isIncome ? "budget-positive budget-tx-amount" : "budget-negative budget-tx-amount"
        });
        const btn = row.createEl("button", { text: "Label", cls: "budget-btn" });
        btn.onclick = () => {
          const hit = findMatchingRule(t.merchant_raw, rules);
          new LabelModal(
            this.app,
            t.merchant_raw,
            t.amount,
            existingLabels,
            (payload) => this.handleLabelSubmit(t, payload, hit ? hit.rule : null),
            hit ? hit.rule : null
          ).open();
        };
      });
    }

    // ---- Recent transactions review feed ----
    const recentOuter = grid2.createDiv({ cls: "budget-card" });
    const recent = [...allTx].sort((a, b) => (a.date < b.date ? 1 : a.date > b.date ? -1 : 0)).slice(0, isMobileApp() ? 8 : 15);
    const recentCard = this.collapsible(
      recentOuter,
      "recent-tx",
      "Recent transactions",
      `${recent.length} shown`,
      true
    );
    if (recent.length === 0) {
      recentCard.createEl("p", { text: "Nothing imported yet.", cls: "budget-muted" });
    } else {
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

        const changeBtn = meta.createEl("button", { text: "Change", cls: "budget-btn" });
        changeBtn.onclick = () => {
          const hit = findMatchingRule(t.merchant_raw, rules);
          new LabelModal(
            this.app,
            t.merchant_raw,
            t.amount,
            allLabels,
            (payload) => this.handleLabelSubmit(t, payload, hit ? hit.rule : null),
            hit ? hit.rule : null
          ).open();
        };
      });
    }

  }

  // Long-term / invested assets. Deliberately read-only and entirely separate
  // from the pay-period engine: nothing here feeds cash on hand, committed,
  // free cash, the buffer, savings or debt.
  async renderPortfolio(container) {
    const snapshots = await readJSON(this.app, FILES.portfolioSnapshots, []);
    const accounts = PORTFOLIO_ACCOUNTS;

    const latestFor = (id) =>
      snapshots
        .filter((s) => s.account_id === id)
        .sort((a, b) => (a.statement_end < b.statement_end ? -1 : 1))
        .slice(-1)[0] || null;

    const latest = accounts.map((a) => ({ account: a, snap: latestFor(a.id) }));
    const total = round2(latest.reduce((s, x) => s + (x.snap ? x.snap.ending_value || 0 : 0), 0));
    const funded = latest.filter((x) => x.snap);

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
        : "No statements imported yet",
      cls: "budget-pf-hero-sub"
    });

    // Split bar showing each account's share of the total.
    if (total > 0) {
      const split = main.createDiv({ cls: "budget-pf-split" });
      funded.forEach((x, i) => {
        const pct = (x.snap.ending_value / total) * 100;
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
      text: "Paste a Fidelity 401(k) or HSA statement",
      cls: "budget-pf-hero-sub"
    });

    // Reminders derive purely from stored snapshot coverage.
    const due = portfolioReminders(snapshots, accounts);
    due.forEach((r) => {
      const warn = container.createDiv({ cls: "budget-warning-soft budget-portfolio-reminder" });
      warn.createSpan({
        text: `${monthNameFromKey(r.monthKey)} ${r.account.label} statement hasn't been imported.`
      });
      const b = warn.createEl("button", { text: "Import", cls: "budget-btn mod-cta" });
      b.onclick = () => this.plugin.promptPortfolioImport();
    });

    const grid = container.createDiv({ cls: "budget-grid" });

    latest.forEach(({ account, snap }) => {
      const card = grid.createDiv({ cls: "budget-card budget-portfolio-card" });
      const ch = card.createDiv({ cls: "budget-sub-head" });
      ch.createEl("h4", { text: account.label });

      if (!snap) {
        ch.createSpan({ text: "no statements yet", cls: "budget-muted" });
        card.createEl("p", {
          text: "Import a statement to start tracking this account.",
          cls: "budget-muted"
        });
        return;
      }

      const covered = snapshots.some(
        (s) => s.account_id === account.id && portfolioMonthKey(s.statement_end) === previousMonthKey(todayLocal())
      );
      ch.createSpan({
        text: covered || due.length === 0 ? `Updated through ${snap.statement_end}` : `${monthNameFromKey(previousMonthKey(todayLocal()))} statement missing`,
        cls: `budget-muted${covered || due.length === 0 ? "" : " budget-negative"}`
      });

      card.createDiv({ text: `$${round2(snap.ending_value).toFixed(2)}`, cls: "budget-portfolio-value" });
      card.createDiv({
        text: `Ending value · statement ${snap.statement_start} to ${snap.statement_end}`,
        cls: "budget-muted"
      });

      const rows = card.createEl("ul", { cls: "budget-list" });
      const row = (label, value) => {
        const li = rows.createEl("li", { text: label });
        li.createSpan({ text: value, cls: "budget-amount" });
      };

      if (snap.beginning_value != null) row("Beginning value", `$${round2(snap.beginning_value).toFixed(2)}`);
      if (snap.change_in_market_value != null)
        row("Change in market value", `$${round2(snap.change_in_market_value).toFixed(2)}`);
      if (snap.change_from_last_period != null)
        row("Change from last period", `$${round2(snap.change_from_last_period).toFixed(2)}`);
      // Fidelity's wording is kept: this is not purely market gain.
      if (snap.change_in_investment_value != null)
        row("Change in investment value", `$${round2(snap.change_in_investment_value).toFixed(2)}`);
      if (snap.vested_value != null) row("Vested balance", `$${round2(snap.vested_value).toFixed(2)}`);
      if (snap.personal_rate_of_return != null)
        row("Your personal rate of return", `${snap.personal_rate_of_return}%`);

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

    // History of monthly ending values.
    const months = [...new Set(snapshots.map((s) => portfolioMonthKey(s.statement_end)))].sort();
    if (months.length >= 2) {
      const chart = container.createDiv({ cls: "budget-card" });
      chart.createEl("h4", { text: "Monthly ending values" });
      const pts = months.map((mk) => ({
        date: `${mk}-01`,
        value: round2(
          snapshots
            .filter((s) => portfolioMonthKey(s.statement_end) === mk)
            .reduce((sum, s) => sum + (s.ending_value || 0), 0)
        )
      }));
      const svg = buildDebtChart(pts.map((p) => ({ date: p.date, total_debt: p.value })), null);
      if (svg) chart.createDiv({ cls: "budget-chart-wrap" }).innerHTML = svg;
      chart.createEl("p", {
        text: "Combined ending value across imported statements. Informational only — these balances never affect budgeting, free cash or debt recommendations.",
        cls: "budget-muted"
      });
    } else if (snapshots.length) {
      container.createDiv({ cls: "budget-card" }).createEl("p", {
        text: "Import a second month to see a trend.",
        cls: "budget-muted"
      });
    }
  }

  async renderInsights(container, ctx) {
    const { allTx, categoryMetaList } = ctx;

    const months = availableMonths(allTx);
    if (months.length === 0) {
      container.createDiv({ cls: "budget-card" }).createEl("p", {
        text: "No transactions imported yet \u2014 import a bank export to see monthly insights.",
        cls: "budget-muted"
      });
      return;
    }

    const currentKey = todayLocal().slice(0, 7);
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
      )
      .sort((a, b) => a.name.localeCompare(b.name));

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

          const row = targetCard.createDiv({ cls: "budget-goal-row" });
          const top = row.createDiv({ cls: "budget-goal-top" });

          const nameCol = top.createDiv({ cls: "budget-goal-name" });
          nameCol.createSpan({ text: c.name });

          const baseline = getPriorMonthCategorySpend(allTx, c.name, selected, categoryMetaList);

          // What this target is actually asking of you, relative to what you
          // spent last month. A target with no baseline to compare against
          // isn't a reduction, so nothing is shown in that case.
          if (baseline > 0) {
            const deltaPct = ((target - baseline) / baseline) * 100;
            const cut = deltaPct < 0;
            const flat = Math.abs(deltaPct) < 0.5;
            const aim = nameCol.createSpan({
              text: flat ? "same as last mo" : `${cut ? "−" : "+"}${Math.abs(deltaPct).toFixed(0)}% vs last mo`,
              cls: `budget-badge budget-aim${cut ? " budget-aim-cut" : flat ? "" : " budget-aim-up"}`
            });
            aim.setAttr(
              "title",
              `${monthLabel(priorMonthKey(selected))}: $${baseline.toFixed(2)} → target $${target.toFixed(2)}` +
                (cut ? ` · frees $${(baseline - target).toFixed(2)}/mo` : "")
            );
          }

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
            cls: `budget-amount${over ? " budget-negative" : ""}`
          });

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

          const metaRow = row.createDiv({ cls: `budget-goal-meta${over ? " budget-negative" : ""}` });
          metaRow.createSpan({
            text: over
              ? `$${(actual - target).toFixed(2)} over budget (${Math.round(pct)}%)`
              : `$${(target - actual).toFixed(2)} left (${Math.round(pct)}%)`
          });
          if (baseline > 0) {
            const delta = round2(actual - baseline);
            metaRow.createSpan({
              text:
                delta < 0
                  ? `\u00b7 $${Math.abs(delta).toFixed(2)} less than ${monthLabel(priorMonthKey(selected))}`
                  : delta > 0
                    ? `\u00b7 $${delta.toFixed(2)} more than ${monthLabel(priorMonthKey(selected))}`
                    : `\u00b7 same as ${monthLabel(priorMonthKey(selected))}`,
              cls: delta < 0 ? "budget-positive" : delta > 0 ? "budget-negative" : ""
            });
          }
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
      const svg = buildTrendChart(series, sel);
      const wrap = trendCard.createDiv({ cls: "budget-chart-wrap budget-trend-wrap" });
      if (svg) {
        wrap.innerHTML = svg;
        // innerHTML means the rects only exist now, so bind after insertion.
        wrap.querySelectorAll(".budget-trend-bar").forEach((rect) => {
          rect.addEventListener("click", () => {
            const key = rect.getAttribute("data-month");
            this.trendMonth = this.trendMonth === key ? null : key;
            this.render();
          });
        });
      }

      if (sel) {
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
    const { allTx, rules } = ctx;
    const subCard = container.createDiv({ cls: "budget-card" });
    const subHead = subCard.createDiv({ cls: "budget-sub-head" });
    subHead.createEl("h4", { text: "Subscription audit" });

    const reviews = await readJSON(this.app, FILES.subscriptionReviews, []);
    const subs = buildSubscriptionAudit(allTx, reviews, rules);

    if (subs.length === 0) {
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
        const row = subList.createDiv({
          cls: `budget-sub-row${s.status === "cancel" ? " budget-sub-cancel" : ""}`
        });

        const textCol = row.createDiv({ cls: "budget-sub-text-col" });
        const nameLine = textCol.createDiv({ cls: "budget-sub-name" });
        nameLine.createSpan({ text: s.key });
        if (s.status === "keep") nameLine.createSpan({ text: "keep", cls: "budget-badge budget-badge-keep" });
        if (s.status === "cancel") nameLine.createSpan({ text: "cancel", cls: "budget-badge budget-badge-warn" });

        const metaLine = textCol.createDiv({ cls: "budget-sub-meta" });
        metaLine.createSpan({
          text: `last charged ${s.latestDate} \u00b7 ${s.chargeCount} charge${s.chargeCount === 1 ? "" : "s"}`
        });
        if (s.cadenceSource === "manual") {
          metaLine.createSpan({ text: "cadence set by you", cls: "budget-badge budget-badge-manual" });
        } else if (s.cadenceSource === "assumed") {
          metaLine.createSpan({ text: "cadence assumed monthly", cls: "budget-badge budget-badge-empty" });
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
                  cadence_override: old.cadence_override || null
                });
              }
            }

            new Notice(`Now shown as "${nickname}".`);
            this.render();
          }).open();
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
    }
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
    await this.renderBufferSettings(containerEl);
    await this.renderSavingsSettings(containerEl);
    await this.renderPayScheduleSettings(containerEl);
    await this.renderAccountSettings(containerEl);
    await this.renderFixedExpenseSettings(containerEl);
    await this.renderDebtSettings(containerEl);
    await this.renderGoalSettings(containerEl);
    await this.renderCategorySettings(containerEl);
    await this.renderRuleSettings(containerEl);
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
      new Setting(containerEl)
        .setName("Manual buffer")
        .setDesc(
          "Flat spending allowance for each pay period. Ordinary spending draws it down as it happens; " +
            "changing it here re-sets the current period's allowance."
        )
        .addText((t) =>
          t.setValue(String(this.plugin.settings.manualBuffer ?? 100)).onChange(async (v) => {
            const n = parseFloat(String(v).replace(/[$,]/g, ""));
            if (isNaN(n) || n < 0) return;
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
      .setDesc("YYYY-MM-DD. Shows a countdown and paces goals that have no target date of their own. Leave blank for open-ended saving.")
      .addText((t) => {
        t.setValue(this.plugin.settings.savingsDeadline || "");
        t.inputEl.addEventListener("change", async () => {
          const raw = t.inputEl.value.trim();
          const norm = normalizeDate(raw);
          if (raw && !/^\d{4}-\d{2}-\d{2}$/.test(norm)) {
            new Notice(`"${raw}" isn't a valid date. Use YYYY-MM-DD.`, 7000);
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
      .setDesc("YYYY-MM-DD \u2014 any past payday works as the anchor; everything else is counted from it.")
      .addText((t) => {
        t.setValue(sched.anchor_date || "");
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
            new Notice(`"${raw}" isn't a valid date. Use YYYY-MM-DD, e.g. 2026-09-01.`, 7000);
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
      accts.forEach((a) => {
        const row = ac.createDiv({ cls: "budget-cat-row" });
        const textCol = row.createDiv({ cls: "budget-cat-text-col" });
        textCol.createDiv({ text: `${a.institution || a.id}`, cls: "budget-cat-name" });
        textCol.createDiv({
          text: `${a.type} · $${(a.current_balance ?? 0).toFixed(2)}` +
            (a.credit_limit ? ` of $${a.credit_limit} limit` : "") +
            ` · id ${a.id}`,
          cls: "budget-cat-usage"
        });
        const btnCol = row.createDiv({ cls: "budget-cat-btn-col" });

        const edit = btnCol.createEl("button", { text: "Edit", cls: "budget-btn" });
        edit.onclick = () => {
          new AddAccountModal(
            this.app,
            async (patch) => {
              const list = await readJSON(this.app, FILES.accounts, []);
              const i = list.findIndex((x) => x.id === a.id);
              if (i < 0) return;
              list[i] = Object.assign({}, list[i], patch);
              // A blank credit limit means "no limit", which has to remove the
              // field rather than store undefined.
              if (patch.credit_limit === undefined) delete list[i].credit_limit;
              await writeJSON(this.app, FILES.accounts, list);
              new Notice(`Updated ${patch.institution || a.id}.`);
              await this.plugin.refreshAfterDataChange();
              this.display();
            },
            a
          ).open();
        };

        const del = btnCol.createEl("button", { text: "Delete", cls: "budget-btn budget-btn-danger" });
        del.onclick = async () => {
          const txs = await readJSON(this.app, FILES.transactions, []);
          const owned = txs.filter((t) => t.account_id === a.id).length;
          const debts = await readJSON(this.app, FILES.revolvingDebts, []);
          const linked = debts.filter((d) => d.account_id === a.id).length;
          new ConfirmModal(this.app, {
            title: `Delete account “${a.id}”?`,
            body: [
              owned ? `${owned} imported transaction${owned === 1 ? "" : "s"} reference this account and will be left orphaned — they stay in your history but no longer belong to an account.` : "No transactions reference this account.",
              linked ? `${linked} credit card term record${linked === 1 ? "" : "s"} point here and will stop resolving. Delete those from the Debts tab too.` : null
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

  // Recurring bills, and the category each one's charges land in.

  // Debts, which are configuration in exactly the sense accounts are — they were
  // reachable only from the dashboard, so half the plugin's setup lived in one
  // place and half in another.
  async renderDebtSettings(containerEl) {
    containerEl = this.section(containerEl, "debts", "Debts & plans", this.countLabel((await readJSON(this.app, FILES.revolvingDebts, [])).length + (await readJSON(this.app, FILES.installmentDebts, [])).length, "debt"));
    containerEl.createEl("p", {
      text:
        "Credit card terms and BNPL plans. Balances are derived from the ledger rather than typed, so editing " +
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
        text: kind === "cc" ? "credit card" : "BNPL",
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
      } else {
        bits.push(`${remainingInstallments(d)} \u00d7 $${(d.installment_amount || 0).toFixed(2)}`);
        if (d.next_due_date) bits.push(`next ${d.next_due_date}`);
      }
      textCol.createDiv({ text: bits.join(" \u00b7 "), cls: "budget-cat-usage" });

      const btnCol = el.createDiv({ cls: "budget-cat-btn-col" });
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
    installment.forEach((d) => row(d, "bnpl"));
  }

  // Savings goals were dashboard-only for the same reason. Contributions stay on
  // the dashboard, where they belong; the goals themselves are configuration.
  async renderGoalSettings(containerEl) {
    containerEl = this.section(containerEl, "goals", "Savings goals", this.countLabel((await readJSON(this.app, FILES.savingsGoals, [])).length, "goal"));
    const goals = await readJSON(this.app, FILES.savingsGoals, []);

    new Setting(containerEl).addButton((btn) =>
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
    );

    if (!goals.length) {
      containerEl.createEl("p", { text: "No goals yet.", cls: "budget-muted" });
      return;
    }

    const list = containerEl.createDiv({ cls: "budget-settings-cats" });
    goals.forEach((g) => {
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
      text:
        "Rename a category to fix a typo or merge duplicates \u2014 the change applies to every rule, " +
        "transaction and override using it. Mark a category as a transfer when it's money moving " +
        "between your own accounts (like a credit card payment). Mark it a necessity when it's " +
        "unavoidable but irregular (gas, pet food): those get projected ahead from your purchase " +
        "history and reserved before savings. Mark it a scheduled bill when it's a recurring bill " +
        "the plugin has no other record of — a phone or internet bill with no fixed expense behind " +
        "it — which keeps it out of your spending allowance without reserving anything for it. " +
        "All three stop a category counting against your spending allowance.",
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

        const bits = [];
        if (c.ruleCount) bits.push(`${c.ruleCount} rule${c.ruleCount === 1 ? "" : "s"}`);
        if (c.txCount) bits.push(`${c.txCount} txn${c.txCount === 1 ? "" : "s"}`);
        if (c.overrideCount) bits.push(`${c.overrideCount} override${c.overrideCount === 1 ? "" : "s"}`);
        textCol.createDiv({ text: bits.join(" \u00b7 ") || "unused", cls: "budget-cat-usage" });

        const btnCol = row.createDiv({ cls: "budget-cat-btn-col" });

        // Variable necessity: unavoidable but irregular. Reserved as committed
        // spending rather than counted in the discretionary buffer.
        if (!c.isTransfer) {
          const necBtn = btnCol.createEl("button", {
            text: c.isVariableNecessity ? "Necessity ✓" : "Mark necessity",
            cls: `budget-btn${c.isVariableNecessity ? " budget-btn-necessity" : ""}`
          });
          necBtn.setAttr(
            "title",
            c.isVariableNecessity
              ? `Projected ahead each period from your purchase history. Ignores purchases under $${(c.variableMinAmount || 0).toFixed(2)}.`
              : "Unavoidable but irregular — gas, pet food. Reserved from savings rather than from spending money."
          );
          necBtn.onclick = async () => {
            if (c.isVariableNecessity) {
              await setCategoryNecessity(this.app, c.name, false);
              new Notice(`${c.name} is no longer a variable necessity.`);
            } else {
              await setCategoryNecessity(this.app, c.name, true, c.variableMinAmount || 0);
              new Notice(`${c.name} marked as a variable necessity.`);
            }
            this.plugin.refreshDashboard();
            this.display();
          };

          // For bills the app has no other record of. A tracked fixed expense,
          // debt or subscription already confers this; declaring it here covers
          // the case where a category IS the only record that a bill exists.
          const schedBtn = btnCol.createEl("button", {
            text: c.isScheduled ? "Scheduled bill \u2713" : "Scheduled bill",
            cls: `budget-btn${c.isScheduled ? " budget-btn-necessity" : ""}`
          });
          schedBtn.setAttr(
            "title",
            c.isScheduled
              ? "Paid from committed money. Spending here doesn't draw down your spending allowance."
              : "A recurring bill rather than living spending \u2014 phone, internet, a car payment. Keeps it out of your spending allowance."
          );
          schedBtn.onclick = async () => {
            await setCategoryScheduled(this.app, c.name, !c.isScheduled);
            new Notice(
              c.isScheduled
                ? `${c.name} is back to ordinary spending.`
                : `${c.name} marked as a scheduled bill \u2014 it no longer draws down your spending allowance.`
            );
            this.plugin.refreshDashboard();
            this.display();
          };

          if (c.isVariableNecessity) {
            const minInput = btnCol.createEl("input", {
              type: "text",
              cls: "budget-target-input budget-min-input",
              attr: {
                placeholder: "min $",
                value: c.variableMinAmount ? String(c.variableMinAmount) : ""
              }
            });
            minInput.setAttr(
              "title",
              "Minimum qualifying purchase — smaller ones are ignored so a partial fill doesn't skew the estimate."
            );
            minInput.onchange = async () => {
              const raw = minInput.value.trim();
              const n = raw ? parseFloat(raw.replace(/[$,]/g, "")) : 0;
              if (raw && (isNaN(n) || n < 0)) {
                new Notice("Enter a number of 0 or more, or leave it blank.");
                return;
              }
              await setCategoryNecessity(this.app, c.name, true, n);
              new Notice(
                n > 0 ? `${c.name}: ignoring purchases under $${round2(n).toFixed(2)}.` : `${c.name}: no minimum.`
              );
              this.plugin.refreshDashboard();
              this.display();
            };
          }
        }

        const transferBtn = btnCol.createEl("button", {
          text: c.isTransfer ? "Count as spending" : "Mark as transfer",
          cls: "budget-btn"
        });
        transferBtn.onclick = async () => {
          await setCategoryTransfer(this.app, c.name, !c.isTransfer);
          new Notice(
            c.isTransfer
              ? `\u201c${c.name}\u201d now counts as spending again.`
              : `\u201c${c.name}\u201d is now treated as a transfer.`
          );
          this.plugin.refreshDashboard();
          this.display();
        };

        const renameBtn = btnCol.createEl("button", { text: "Rename", cls: "budget-btn" });
        renameBtn.onclick = () => {
          new RenameCategoryModal(this.app, c, allNames, async (newName) => {
            const { rulesUpdated, overridesUpdated, paymentCategoriesUpdated } = await renameCategory(
              this.app,
              c.name,
              newName
            );
            new Notice(
              `Renamed to \u201c${newName}\u201d \u2014 ${rulesUpdated} rule(s), ${overridesUpdated} override(s)` +
                (paymentCategoriesUpdated
                  ? `, ${paymentCategoriesUpdated} bill/debt still pointing at it`
                  : "") +
                " updated."
            );
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
        editBtn.onclick = () => {
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
          }).open();
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

    this.registerView(VIEW_TYPE, (leaf) => new BudgetDashboardView(leaf, this));

    this.addSettingTab(new BudgetSettingTab(this.app, this));

    // A ```budget``` code block turns any note into a launcher. On mobile this
    // is the reliable entry point: the note can be bookmarked or starred, and
    // bookmarks DO appear in the mobile sidebar.
    this.registerMarkdownCodeBlockProcessor("budget", (source, el) => {
      this.renderLauncherBlock(el);
    });

    await this.ensurePortfolioAccounts();

    // Restore an in-flight pay period so the dashboard survives reloads.
    await this.loadActivePeriod();

    // Nudge once on load if last month's statements are missing. Derived purely
    // from stored snapshot coverage.
    const pfSnaps = await readJSON(this.app, FILES.portfolioSnapshots, []);
    const pfDue = portfolioReminders(pfSnaps, PORTFOLIO_ACCOUNTS);
    if (pfDue.length) {
      new Notice(
        pfDue
          .map((r) => `${monthNameFromKey(r.monthKey)} ${r.account.label} statement hasn't been imported.`)
          .join("\n"),
        12000
      );
    }

    this.addRibbonIcon("wallet", "Open Budget Dashboard", () => this.activateView());

    this.addCommand({
      id: "open-budget-dashboard",
      name: "Open Budget Dashboard",
      callback: () => this.activateView()
    });

    this.addCommand({ id: "enter-paycheck", name: "Enter Paycheck", callback: () => this.promptEnterPaycheck() });
    this.addCommand({ id: "add-account", name: "Add Account", callback: () => this.promptAddAccount() });
    this.addCommand({ id: "add-revolving-debt", name: "Add Credit Card Terms", callback: () => this.promptAddCreditCardTerms() });
    this.addCommand({ id: "add-bnpl-plan", name: "Add BNPL Plan", callback: () => this.promptAddBNPL() });
    this.addCommand({ id: "add-fixed-expense", name: "Add Fixed Expense", callback: () => this.promptAddFixedExpense() });
    this.addCommand({ id: "mark-fixed-expense-paid", name: "Mark Fixed Expense as Paid", callback: () => this.promptMarkFixedPaid() });
    this.addCommand({ id: "manage-transfer-categories", name: "Manage Transfer Categories", callback: () => this.promptManageTransfers() });
    this.addCommand({ id: "import-bank-csv", name: "Import Bank CSV", callback: () => this.promptImportCSV() });
    this.addCommand({ id: "open-budget-settings", name: "Open Budget Settings & Rules", callback: () => this.openSettings() });
    this.addCommand({
      id: "import-portfolio-statement",
      name: "Import Portfolio Statement",
      callback: () => this.promptPortfolioImport()
    });
    this.addCommand({
      id: "update-balances",
      name: "Update account balances",
      callback: () => this.promptQuickBalance()
    });
    this.addCommand({
      id: "toggle-relocation-mode",
      name: "Toggle strategy: Debt Reduction / Savings Focus",
      callback: () => this.toggleRelocationMode()
    });
    this.addCommand({
      id: "open-budget-dashboard-sidebar",
      name: "Open Budget Dashboard in sidebar",
      callback: () => this.activateView("sidebar")
    });
    this.addCommand({
      id: "create-budget-dashboard-note",
      name: "Create Budget Dashboard note (bookmarkable)",
      callback: () => this.createDashboardNote()
    });
  }

  // Re-runs the budget math when a period is active, otherwise just repaints.
  // Every data-changing action funnels through here so the dashboard is never stale.
  async refreshAfterDataChange() {
    if (this.lastPaycheckInputs) await this.recalculate();
    else this.refreshDashboard();
  }

  openSettings() {
    const setting = this.app.setting;
    if (setting && typeof setting.open === "function") {
      setting.open();
      if (typeof setting.openTabById === "function") setting.openTabById(this.manifest.id);
    } else {
      new Notice("Open Settings \u2192 Community plugins \u2192 Budget Tracker.");
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

  async promptPortfolioImport() {
    new PortfolioImportModal(this.app, this, () => this.refreshDashboard()).open();
  }

  // Seeded once so the reminder logic has accounts to check against. Portfolio
  // accounts are deliberately separate from FILES.accounts — they are never
  // reconciled against cash balances.
  async ensurePortfolioAccounts() {
    const existing = await readJSON(this.app, FILES.portfolioAccounts, null);
    if (Array.isArray(existing) && existing.length) return existing;
    await writeJSON(this.app, FILES.portfolioAccounts, PORTFOLIO_ACCOUNTS);
    return PORTFOLIO_ACCOUNTS;
  }

  async promptQuickBalance() {
    const accounts = await readJSON(this.app, FILES.accounts, []);
    new QuickBalanceModal(this.app, accounts, async (patch) => {
      const list = await readJSON(this.app, FILES.accounts, []);
      list.forEach((a) => {
        if (patch[a.id] != null) a.current_balance = patch[a.id];
      });
      await writeJSON(this.app, FILES.accounts, list);

      // A card balance typed here is the same fact the Debts tab reports, so
      // re-anchor the card to it rather than letting the two drift.
      for (const a of list) {
        if (a.type === "credit_card" && patch[a.id] != null) {
          await reanchorCardBalance(this.app, a.id, patch[a.id]);
        }
      }

      // The period's cash-on-hand is driven by checking, so update the live
      // figure too rather than waiting for the next paycheck entry.
      const checking = list.find((a) => a.type === "checking");
      if (checking && this.lastPaycheckInputs) {
        this.lastPaycheckInputs.checkingBalance = checking.current_balance;
        this.lastPaycheckInputs.alreadyDeposited = true;
        this.lastPaycheckInputs.autoRolled = false;
      }
      new Notice("Balances updated.");
      await this.refreshAfterDataChange();
    }).open();
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
      async (picked) => {
        const file = isCard ? FILES.revolvingDebts : FILES.installmentDebts;
        const list = await readJSON(this.app, file, []);
        const idx = list.findIndex((d) => debtKey(d) === debtKey(debt));
        if (idx < 0) return;
        list[idx].applied_payments = (list[idx].applied_payments || []).concat(
          picked.map((p) => ({ tx_id: p.id, amount: Math.abs(p.amount), date: p.date }))
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
    const checkingAcct = accounts.find((a) => a.type === "checking");
    const prefill = {
      detectedPaycheck: findLatestPaycheck(txs),
      checkingBalance: checkingAcct ? checkingAcct.current_balance : null
    };

    new PaycheckModal(
      this.app,
      async ({ paycheckAmount, checkingBalance, alreadyDeposited, nextPaydayStr }) => {
        // The period runs payday → payday, not entry-date → payday. Using the
        // day the paycheck happened to be entered orphans everything that
        // landed earlier in the period, including the paycheck itself.
        const sched = resolvePaySchedule(this.settings, txs);
        const periodStartStr = (sched && currentPeriodStart(sched, todayLocal())) || todayLocal();
        // Grab the outgoing period before it's replaced — its unspent allowance
        // is the sweep candidate, and it's unreachable once this is overwritten.
        const closingPeriod = this.lastPaycheckInputs;
        this.lastPaycheckInputs = {
          paycheckAmount,
          checkingBalance,
          alreadyDeposited,
          nextPaydayStr,
          periodStartStr
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

    const spending = classifyBufferSpending({
      transactions,
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
    (goals || []).forEach((g) => {
      const target = g.target_date || this.settings.savingsDeadline;
      if (!target) return;
      const list = paydaysBetween(schedule, fromDateStr, target);
      if (list) out[g.id] = list.length;
    });
    return out;
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
    const fundable = goals.filter((g) => goalProgress(g).remaining > 0.005);
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
  async promptAddAccount(onDone = null) {
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
      accounts.push(account);
      await writeJSON(this.app, FILES.accounts, accounts);
      new Notice(`Added account: ${account.id}`);
      await this.refreshAfterDataChange();
      if (onDone) await onDone(account);
    }).open();
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
          const reconciliation = reconcileImport(existing, newTx);
          const { merged, added, updated, skipped, unresolved } = reconciliation;
          issues.push(...(reconciliation.issues || []));

          const handled = added + updated + skipped + unresolved;
          if (handled !== newTx.length) {
            issues.push(
              `Reconciliation count mismatch: parsed ${newTx.length} row(s) but accounted for ${handled}.`
            );
          }

          applyCategorization(merged, rules);
          await writeJSON(this.app, FILES.transactions, merged);
          transactionsWritten = true;

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

    const btn = el.createEl("button", { text: "Open Budget Dashboard", cls: "budget-launcher-btn mod-cta" });
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
    const path = "Budget/Budget Dashboard.md";
    const body = [
      "# Budget Dashboard",
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
      new Notice("Created \u201cBudget/Budget Dashboard\u201d \u2014 bookmark it for quick access.", 9000);
    }
    const leaf = this.app.workspace.getLeaf(isMobileApp() ? false : "tab");
    await leaf.openFile(file);
  }

  refreshDashboard() {
    const leaves = this.app.workspace.getLeavesOfType(VIEW_TYPE);
    if (leaves.length > 0) leaves[0].view.render();
  }

  async recalculate() {
    if (!this.lastPaycheckInputs) return null;
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

    // Capture the period's spending allowance if it hasn't been captured yet, or
    // if the user deliberately changed it. Periods created before this feature
    // existed get a snapshot on their first recalculation, which is why an
    // in-flight period keeps working without a migration step.
    const bufferModeNow = this.settings.bufferMode || "auto";
    const manualBufferNow = this.settings.manualBuffer ?? 100;
    if (bufferAllocationStale(this.lastPaycheckInputs.bufferAllocation, bufferModeNow, manualBufferNow, todayStr)) {
      this.lastPaycheckInputs.bufferAllocation = captureBufferAllocation({
        transactions: allTxForSubs,
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
      rules: subRules
    });

    const accounts = await readJSON(this.app, FILES.accounts, []);
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

    await writeJSON(this.app, FILES.activePeriod, {
      inputs: this.lastPaycheckInputs,
      savedAt: todayLocal(),
      result
    });

    this.lastResult = result;
    const leaves = this.app.workspace.getLeavesOfType(VIEW_TYPE);
    if (leaves.length > 0) leaves[0].view.setResult(result);

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
        const checking = accounts.find((a) => a.type === "checking");
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
          autoRolled: true
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
      new Notice("Couldn't open the Budget Dashboard \u2014 no available pane.");
      return null;
    }

    await leaf.setViewState({ type: VIEW_TYPE, active: true });
    this.app.workspace.revealLeaf(leaf);
    return leaf;
  }

  onunload() {}
};
