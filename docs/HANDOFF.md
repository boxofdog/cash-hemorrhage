# Handoff: where things stand

Written at 1.27.0 (Sep 28, 2026), when work moved from a Claude chat session
into this repo. Every version before this was built in that chat, with the
same test tooling that's now in `tests/` and `tools/`.

## State at handoff

- **Version:** 1.27.0. All 2,684 checks pass, the TDZ scan is clean, and the
  snapshots are committed.
- **1.27.0 (Loans)** was the last feature. It added the Loan type (car,
  mortgage, student, personal), a future first payment date, SimpleFIN
  lender balances, closing a loan (sold, traded, refinanced, paid off, with
  equity or a shortfall), and the "Extra toward principal" toggle in Apply
  Payment.
- **Audits.** Two independent audit rounds found 16 bugs, then 5 more; all
  are fixed. Their regressions are sections 9–11 of `tests/test-loans.js`,
  and `tools/mutations/loans.py` has 38 mutations, all killed except one
  equivalent mutation.

## Setup notes

The plugin imports transactions from SimpleFIN Bridge or CSV. When a bank shows
"Auth required", the fix is signing in again at SimpleFIN Bridge, not in the
plugin. Never assume any particular bills, accounts or rent in code or fixtures;
all test data is synthetic.

## Decisions and why (so they aren't undone)

- **Transfers are confirmed, not automatic** (1.26.0). Two rows of the same
  amount, opposite signs, on different accounts within 5 days are *suggested*
  as a transfer. The user said a real vendor charge can match a transfer
  amount exactly, so a person decides. Confirmed pairs are hidden from the
  transaction list and can be undone.
- **The label window is minimal** (1.26.1). It shows the name and amount,
  Category, Name, and Just this one / Apply to all, with "It's a transfer"
  set apart. The rule pattern is folded under "Applies to: …". The user
  called the earlier version "a LOT of information just to edit a
  transaction."
- **Sync notices are one line** (1.25.2), for example "Synced — 3 new · 2
  balances updated". Problems are grouped per bank, behind "see details".
- **Balances** (1.25.1–1.25.2).
  - A SimpleFIN balance is stamped with the bank's own balance date, not the
    sync time.
  - A balance the user typed after that is kept.
  - A 1.25.1 bug stamped the sync time instead, which let a stale bank
    balance overwrite a newer typed one.
- **SimpleFIN 43-day cap.** The bridge warns when a request goes past 45
  days. That warning once held every account's import marker back, so every
  sync requested the whole window again. The cap is 43 days, and the advisory
  is excluded from errors.
- **Snapshot export** (1.23.x). It's a stacked-table CSV (Summary, Cash &
  Savings, Debts & Credit, Subscriptions & Necessities) with raw numbers, plus
  Markdown.
  - A later request added 3-month spending, explicit rent and Insights targets.
  - The user then asked for it rolled back, saying they'd edit that part
    themselves. It stays out.
- **Goals linked to a savings account** (1.24.0) are optional. When several
  goals share an account, the user assigns each transfer to a goal.
- **Loans.**
  - Nothing is reserved before the first payment's pay period.
  - Only the most recent missed installment is reserved. Older gaps are
    usually payments made from an account that isn't imported, and reserving
    all of them would swallow the budget.
  - An unflagged payment pays ahead; a flagged one is extra principal. The
    toggle suggests "extra" when this month is already paid and the amount
    isn't about one installment.
  - A mortgage paid a few days early is charged interest as of its due date,
    as lenders do.

## Open items and ideas

Nobody has asked for any of these; raise them only if relevant.

- **Apply Payment is wordy.** It opens with two explanatory paragraphs for
  every debt type. It's a candidate for the same trim the label window got
  in 1.26.1.
- **Unverified portfolio profiles.** The Vanguard, Empower and Schwab
  statement profiles were written from general knowledge, not real
  statements. They need a real pasted statement to verify; the
  light-confirm step is the safety net.
- **Loans already underway.** For a loan added part-way through, "As of"
  should be the last payment date, and the dialog's hint says so. Nothing
  infers it.
- **`loanState` ignores the as-of date for payments.** It counts every
  applied payment regardless of the date passed in. That's fine for "today",
  which is all the UI asks for.
- **Legacy undated payments.** An `applied_payments` entry with no `date` and
  no `applied_on` counts as today. Loans are new enough that none should
  exist; BNPL entries behave as they always have.

## How past sessions worked (keep doing this)

1. Read the request literally. Build the smallest thing that does it, and
   keep the UI terse.
2. Write tests alongside the code, including the negative cases (what must
   *not* happen).
3. For money logic, have a separate agent write runnable repro scripts
   against the code, then fix what they find and add each repro as a test.
4. Take preview screenshots of any UI (dark, and 390px wide), look at them,
   and trim.
5. Run the full suite, the TDZ scan, the snapshots and the mutations.
6. Write a changelog entry and bump the version. Then give the user a short
   summary: what changed, how to use it, and which files to copy.
