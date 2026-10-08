# Budget Tracker

A per-paycheck budget dashboard for [Obsidian](https://obsidian.md). It answers
one question: **what do I actually have available right now, after everything
I'm committed to paying?**

Your bank balance isn't that number. Bills, debt payments and loan installments
are coming before your next payday, and this plugin sets them aside first. What
remains for the current pay period is the money you can really spend. It works
the same whether your income is steady, irregular or a mix.

- **Know what's coming.** Upcoming bills, minimums and loan payments are
  reserved ahead of time, so you can see them before they hit.
- **Give yourself an allowance.** Because the leftover figure is real, a weekly
  allowance out of it actually means something.
- **See what you had to spend versus what you chose to.** Spending on things you
  were committed to (bills, debt payments, loan installments) is kept apart from spending you
  didn't need to make.

## Two postures toward your money

Once your obligations and spending allowance are covered, whatever is left is
your surplus. Two strategies decide where it goes. Neither is the default: pick
the one that matches where you are, and switch whenever that changes. The
whole dashboard updates instantly.

- **Debt Reduction.** Surplus goes to principal beyond the minimums, highest
  interest rate first across your cards and loans. Capped funds, like an
  emergency cushion, refill before extra principal.
- **Savings Focus.** Extra debt payoff pauses and surplus goes to your savings
  goals instead. Goals with a target date get the pace they need first. Then
  capped funds refill, then dated goals get ahead of schedule, and undated goals
  come last. You can also set a deadline that counts down on the dashboard.

Minimum payments are treated as obligations in both. Savings Focus pauses
extra payments and never skips anything you owe. Switch with the control at the
top of the dashboard, or the command **Toggle strategy: debt reduction or
savings focus**.

## What it does

- **Pay-period dashboard.** Bills, debt minimums, savings and what's safe to
  spend, recalculated as transactions come in.
- **Debts.** Credit cards (with APR and live balance), buy-now-pay-later plans,
  and loans (car, mortgage, student, personal), including extra-principal
  payments and closing out a loan.
- **Bills and subscriptions.** Fixed bills, subscription audit, and matching of
  bank transactions to the bills they pay.
- **Savings goals.** Goals can be linked to a savings account.
- **Transactions.** Import a bank CSV, or sync automatically with SimpleFIN
  Bridge. Rules and labels categorize transactions; transfers between your own
  accounts are suggested and you confirm them.
- **Portfolio.** Import investment statements to track balances over time.
- **Charts and export.** Spending and debt charts, plus a financial snapshot
  export (CSV and Markdown). **Export transactions to notes** writes your
  transaction history into `Budget/exports/Transactions/` as one Markdown note
  per month, plus an index, so you can search and link it in Obsidian. The notes
  are a read-only copy: editing them changes nothing in the plugin, and the next
  export rewrites them.

Works on desktop and mobile.

## Install

Until it appears in Obsidian's community plugin list:

1. Download `main.js`, `manifest.json` and `styles.css` from the latest
   [release](../../releases).
2. Put them in `<your vault>/.obsidian/plugins/budget-tracker/`.
3. Enable **Budget Tracker** in Settings → Community plugins.
4. Run the command **Set up data files and folders**.

## You sort your own transactions, on purpose

Budget Tracker doesn't guess your categories. Every merchant is labeled by you,
so you always know where your money went, and you never have to go back through
an algorithm's mistakes and shift spending between buckets.

You sort each merchant **once**: pick a category, and choose **Apply to all** so
matching transactions follow. Setup takes some effort up front,
because it's the number of *different merchants* that matters, not the number of
transactions. After that, very little is left to do.

## Getting started

1. Run **Set up data files and folders**, then **Enter paycheck**.
2. Add your accounts, cards, bills and loans with the commands of the same
   names (open the command palette and type "Add").
3. Import a bank CSV, or connect SimpleFIN (below).
4. Open Budget Tracker from the ribbon icon, or with **Open in sidebar**.

**Keep your own copy of your CSVs.** After a clean import, the plugin deletes
the CSV from `Budget/imports/`. If you want to keep the files, store them in
another folder.

## Network use and your data

Please read this: the plugin handles financial data.

- **Your data stays in your vault.** Everything is stored as JSON under
  `Budget/data/` and `Budget/imports/` in your vault. Nothing is sent to the
  author or to any analytics service.
- **Using Obsidian Sync?** Your data is stored as JSON files, which Sync skips
  by default. Turn on **Sync all other types** under Settings → Sync, or your
  data won't reach your other devices. To see the files in Obsidian, turn on
  **Show all file types** under Settings → Files and links → Links.
- **SimpleFIN Bridge (optional).** If you connect it, the plugin makes network
  requests to the SimpleFIN Bridge server you configure, to claim your setup
  token and to fetch your accounts, balances and transactions. This is off
  until you set it up. [SimpleFIN Bridge](https://www.simplefin.org/) is a
  third-party paid service; your bank login is entered with them, never in this
  plugin. The bridge limits requests, and the plugin keeps to those limits.
- **Credential storage.** The SimpleFIN access URL is a secret. It is kept in
  Obsidian's secret storage (or, on older versions, Obsidian's local storage),
  not in your vault files, so it isn't synced or committed with your notes.
- **Exactly three network calls, all to SimpleFIN.** Claiming your one-time setup
  token, then two requests to fetch your accounts and transactions, sent through
  Obsidian's own request function. Nothing else in the plugin reaches the
  network, and CSV import works fully offline.
- **Why the code uses base64.** SimpleFIN's setup token is a web address encoded
  in base64, which the plugin decodes to know where to claim your access. The
  access address carries a username and password, sent in the standard HTTP
  "Basic" login header, which is also base64 by definition. It isn't used to
  hide anything.
- **Not financial advice.** Figures are estimates from the data you provide.

## Development

The plugin is three files (`main.js`, `styles.css`, `manifest.json`) with no
build step. Dev tooling lives in `tests/` and `tools/`.

```bash
npm install
npm run check   # syntax, TDZ scan, render snapshots, all tests
```

See `docs/ARCHITECTURE.md` and `CLAUDE.md` for how the code is laid out. All
test data is synthetic.

## Contributing

Bug reports and ideas are welcome. See [CONTRIBUTING.md](CONTRIBUTING.md).

## License

[MIT](LICENSE)
