# Budget Tracker

A per-paycheck budget dashboard for [Obsidian](https://obsidian.md). Each pay
period it works out what you owe before the next payday and what's left to
spend, so variable or irregular income doesn't break the budget.

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
  export (CSV and Markdown).

Works on desktop and mobile.

## Install

Until it appears in Obsidian's community plugin list:

1. Download `main.js`, `manifest.json` and `styles.css` from the latest
   [release](../../releases).
2. Put them in `<your vault>/.obsidian/plugins/budget-tracker/`.
3. Enable **Budget Tracker** in Settings → Community plugins.
4. Run the command **Set up data files and folders**.

## Getting started

1. Run **Set up data files and folders**, then **Enter paycheck**.
2. Add your accounts, cards, bills and loans with the commands of the same
   names (open the command palette and type "Add").
3. Import a bank CSV, or connect SimpleFIN (below).
4. Open the dashboard with **Open dashboard**.

## Network use and your data

Please read this: the plugin handles financial data.

- **Your data stays in your vault.** Everything is stored as JSON under
  `Budget/data/` and `Budget/imports/` in your vault. Nothing is sent to the
  author or to any analytics service.
- **SimpleFIN Bridge (optional).** If you connect it, the plugin makes network
  requests to the SimpleFIN Bridge server you configure, to claim your setup
  token and to fetch your accounts, balances and transactions. This is off
  until you set it up. [SimpleFIN Bridge](https://www.simplefin.org/) is a
  third-party paid service; your bank login is entered with them, never in this
  plugin. The bridge limits requests, and the plugin keeps to those limits.
- **Credential storage.** The SimpleFIN access URL is a secret. It is kept in
  Obsidian's secret storage (or, on older versions, Obsidian's local storage),
  not in your vault files, so it isn't synced or committed with your notes.
- **No other network requests.** CSV import and everything else works
  offline.
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

## License

[MIT](LICENSE)
