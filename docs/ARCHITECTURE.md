# Architecture

`main.js` is one file of top-level pure functions, followed by the modals, the
dashboard view, the settings tab and the plugin class. Search for a section
marker (`// ---------- loans ----------`) rather than trusting line numbers.
The ones below are approximate, as of 1.27.0.

## main.js, top to bottom

| ~Line | Section marker | What's there |
|---|---|---|
| 1 | constants | `DATA_DIR` (`Budget/data`), `IMPORT_DIR`, `EXPORT_DIR`, `FILES`, `DEFAULT_SETTINGS`, `PAY_CADENCES` |
| 104 | portfolio statement parsing / universal statement engine / reminders | Paste-a-statement import for 401(k)/HSA/IRA etc. (read-only, never feeds the budget). Profiles for Fidelity, Vanguard, Empower, Schwab, and a generic one. |
| 1442 | storage helpers | `readJSON`, `writeJSON`, `ensureDataDir` |
| 1465 | where a balance came from | `stampBalance`, `adoptCashBalance`, `balanceSourceText`: typed vs SimpleFIN balances; the newest stamp wins |
| 1556 | first-time setup | `setupStatus`, `setupBudgetVault`, `STARTER_CATEGORIES`: the Settings "Set up" button |
| 1671 | CSV parsing | `ADAPTERS`, `parseGenericBank`, `parseCapitalOne`, column finders |
| 2009 | categorization | `matchCategory`, `applyCategorization` (rules → `resolved_category`; `override_label` wins), `NON_DISCRETIONARY_PATTERN` |
| 2157 | insights | Monthly spending, targets, month comparisons |
| 2681 | savings mode | Surplus to goals instead of debt; tiered pacing |
| 2896 | variable necessities | Gas, groceries: projected need for the rest of the period |
| 3025 | capped funds | Goals of `kind: "capped"`, whose balance is an account's; fund transfers |
| 3403 | transfers between your own accounts | `transferCandidates` (suggest), `confirmTransferPair`, `undoTransfer`, `isHiddenTransfer` |
| 3554 | savings goals | Progress, contributions, the pinned goal |
| 3721 | goals linked to a savings account | `goalTransferQueue`, `assignGoalTransfer`: which goal a transfer was for |
| 3891 | subscription audit | Recurring-charge detection, keep/cancel reviews, phase-out |
| 4248 | debt tracking | `debtBalance`, `advanceDueDateIfCovered`, `remainingInstallments`, card balance from card activity (`cardBalanceState`) |
| 4430 | loans | `LOAN_TYPES`, `loanSchedule`, `loanPaymentDates`, `loanState`, `loanPeriodDues`, `loanPayoff`, `loanExtraSuggested`, `loanEquity` |
| 4831 | financial snapshot (export) | `buildFinancialSnapshot`, `snapshotMarkdown`, `snapshotCSV` (stacked-table CSV) |
| 5869 | category management / ordering | Rename, delete (with repointing), flags, order |
| 6157 | pay schedule | `resolvePaySchedule`, `currentPeriodStart`, `nextPaydayFrom` |
| 6362 | transaction ownership | `buildOwnershipIndex`: the single "who owns this transaction" answer, with precedence documented in the comment |
| 6809 | pay-period buffer spend-down | `classifyBufferSpending`, dynamic buffer |
| 7026 | allocation algorithm | `runAllocation`: the per-period engine (below) |
| 7745 | pie chart | Spend by category (SVG) |
| 8094 | SimpleFIN | Claim/access URL, fetch, `simplefinConnectionProblems`, `simplefinLoanUpdates`, import merge |
| 8793 | Modals | Every dialog: `PaycheckModal`, `LoanModal`, `CloseLoanModal`, `BNPLModal`, `ApplyPaymentModal`, `LabelModal`, … |
| 12537 | Dashboard view | `BudgetDashboardView`: tabs, then `renderOverview`, `renderDebts`, `renderTransactions`, `renderSubscriptions`, `renderInsights`, `renderPortfolio` |
| 16028 | Plugin | `BudgetSettingTab`, then `BudgetTrackerPlugin` (`module.exports`): commands, `recalculate`, `syncSimpleFIN`, import, save/close flows |

## The per-period engine

`plugin.recalculate()` reads every data file and calls `runAllocation(...)`.
The pay period runs from its fixed start date to the day before the next
payday. `runAllocation`:

1. Builds the ownership index once, so every step below agrees on what each
   transaction is.
2. Collects the period's obligations. These are fixed bills, card minimums,
   BNPL installments, and loan installments (`loanPeriodDues`: the ones due in
   the period, plus the most recent missed one, capped at the payoff amount).
   It also takes upcoming subscriptions and variable necessities.
3. Marks what's already paid, from explicit links: `applied_payments`,
   `linked_payments` and contributions.
4. Holds back a discretionary buffer, `manual` or `auto`.
5. Splits the surplus. Debts go by APR (cards, and loans that take extra); in
   Savings Mode, goals come first.

The results (`periodObligations`, `requiredMinimums`, `payoffBreakdown`,
buffer figures, …) drive the Overview.

## Debts

| Kind | Stored in | Balance comes from |
|---|---|---|
| Credit card | `revolving_debts.json` | `balance_anchor` plus the card's own imported activity (`cardBalanceState`). Applying a payment credits the cycle minimum only; it doesn't subtract again. |
| BNPL plan | `installment_debts.json` | `balance_anchor` minus applied payments; the due date advances when a cycle is covered |
| Loan (`kind: "loan"`) | `installment_debts.json` | `balance_anchor` (typed, or the lender's balance via SimpleFIN) plus interest math (`loanState`). Closed loans move to `closed_loans.json`. |

The loan model:

- **Interest:** car, student and personal loans accrue daily simple interest;
  a mortgage accrues a month's interest and escrow at each due date.
- **Payments:** a payment pays escrow, then interest, then principal. Anything
  unpaid carries forward.
- **Installments:** a payment covers the installment whose window it falls in.
  Windows open `LOAN_EARLY_DAYS` (20) before each due date, and the first one
  opens at funding. A month left part-paid is finished first, then the
  payment's own month, then earlier unpaid months (most recent first), then
  months ahead.
- **Extra toward principal:** a payment flagged `extra` is principal only and
  covers no installment.
- **Dates:** `first_payment_date` pins the due-date series. Moving a started
  loan's due date records `due_history` (the old dates stay for interest) and
  `coverage_from` (payments before it belong to the old dates).

## Data files (`Budget/data/`)

| File | Holds |
|---|---|
| `transactions.json` | Every imported row: `id`, `date`, `amount` (negative is money out), `merchant_raw`, `account_id`, `resolved_category`, `override_label`, transfer fields (`transfer_pair`, `transfer_prev_label`, …) |
| `category_rules.json` | `merchant_pattern` → `home_label`, with an optional `display_name` |
| `categories.json` | Category flags: `is_transfer`, `is_variable_necessity`, `exclude_from_discretionary`, `monthly_target` |
| `accounts.json` | Checking, savings and credit cards: `current_balance`, `balance_updated_at`, `balance_source`, `simplefin_id` |
| `revolving_debts.json`, `installment_debts.json`, `closed_loans.json` | See Debts above |
| `fixed_expenses.json` | Bills: amount, due day or interval, `payment_category`, `linked_payments` |
| `savings_goals.json` | Goals (`contributions`, optional `account_id` / `track_from`) and capped funds (`kind: "capped"`) |
| `paycheck_history.json`, `active_period.json` | Pay periods and paychecks |
| `settings.json` | `DEFAULT_SETTINGS` keys (buffer mode, pay schedule, savings mode) |
| `subscription_reviews.json`, `buffer_sweeps.json`, `debt_history.json`, `category_order.json` | Supporting state |
| `portfolio_accounts.json`, `portfolio_snapshots.json` | The read-only investment tracker |
| `simplefin_accounts.json` | What SimpleFIN last reported (names, balances). Never credentials: those are in `app.secretStorage`. |

## Tests and tools

- **`tests/harness.js`.** Loads `main.js` with an Obsidian stub and a small
  DOM shim. Nodes come from `el()`, and each has `tag`, `classes`, `_text`,
  `children`, `attrs` and listeners you can dispatch.
  - `SettingStub` records every `Setting`'s texts, buttons, dropdowns and
    toggles, so a test can type, pick, flip and click.
  - `global.__notices` collects `Notice` messages.
  - `global.__requestUrl` plays the network (SimpleFIN).
  - Only names listed in `EXPORTS` or `OPTIONAL_EXPORTS` are exposed.
- **`tests/harness-for.js`.** Loads any copy of `main.js` the same way. The
  differential tests use it to compare the current code with a frozen old
  copy in `tests/baselines/` ("this refactor changed nothing for existing
  data"). Never edit the baselines.
- **Test files.** Each `tests/test-*.js` is a plain Node script: `check(name,
  got, want)` with JSON equality, numbered sections, and a final line reading
  `N passed, M failed`.
- **`tests/fixtures/`.** A real vault's transactions and a computed result,
  with names and card numbers replaced by placeholders. Used by the render
  snapshots, previews and several tests. Don't add real personal data.
- **`tools/render-snapshot.js` and `tools/settings-snapshot.js`.** Text dumps
  of the Overview and Settings renders. `tools/snapshot.js` compares them
  with the committed copies.
- **`tools/previews/*.js`.** Render a screen or dialog with the real
  stylesheet and Obsidian theme variables, then screenshot it with Playwright
  into `.preview/`. `preview-loans.js` loads all of `main.js` in the page
  against a real-DOM Obsidian stand-in, which is the easiest pattern to copy
  for a new dialog.
- **`tools/mutate.py`.** Applies each mutation in a mutations file to
  `main.js`, runs the named tests, and always restores the file.
