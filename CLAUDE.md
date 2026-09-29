# Budget Tracker — Obsidian plugin

A per-paycheck budget dashboard that lives in an Obsidian vault. It imports
bank transactions (CSV, or SimpleFIN Bridge sync), tracks cards, BNPL plans,
loans, fixed bills, subscriptions and savings goals, and each pay period works
out what's owed before the next payday and what's left to spend.

Current version: see `manifest.json` (1.27.0 at handoff). History: `CHANGELOG.md`.
Where things stand and what's next: `docs/HANDOFF.md`. How the code is laid
out: `docs/ARCHITECTURE.md`.

## The plugin is three files

- `main.js` — the whole plugin: about 20k lines of plain CommonJS. It has no
  bundler, no build step and no runtime dependencies beyond `require("obsidian")`.
- `styles.css` — all styling, driven by Obsidian theme variables. It has to
  work in light and dark, and at phone width.
- `manifest.json` — the version number lives here.

The user installs by copying those three files into
`<vault>/.obsidian/plugins/budget-tracker/`. Everything else in this repo is
dev tooling. The plugin's data lives in the vault, under `Budget/data/*.json`,
never in the repo.

## Commands

```bash
npm install            # acorn (TDZ scan) and playwright (browser checks)
npm test               # every tests/test-*.js, in parallel, with totals (~15s)
npm test -- loans      # just the files whose names match
npm run tdz            # new const/let self-references (a real crash class here)
npm run snapshots      # Overview + Settings render structure vs tools/snapshots/
npm run check          # syntax + tdz + snapshots + all tests
npm run mutate:loans   # break the loan core on purpose; tests must notice
node tools/previews/preview-loans.js   # screenshots → .preview/ (look at them)
```

If Chromium can't launch, the browser checks are skipped and the runner says
so. Nothing else depends on a browser.

## How to work here

These are the user's standing expectations, learned over many versions.

1. **Pull first. The user edits files themselves.** Always work from the
   repo's current `main.js`. Never paste in an older copy from memory.
2. **Every change gets tests.** Put them in the matching `tests/test-<feature>.js`,
   or a new file for a new feature. Any new top-level function or class the
   tests need goes in the `EXPORTS` list in `tests/harness.js`. Use
   `OPTIONAL_EXPORTS` if it's missing from the old copies in
   `tests/baselines/`.
3. **Before calling anything done**, run:
   - `npm run check`: the full suite has to be green.
   - For money math (allocation, loans, balances, matching): add mutations
     under `tools/mutations/` and run them. A surviving mutation is a missing
     test.
   - For UI changes: a preview script under `tools/previews/` in dark theme at
     phone width (390px), then actually look at the screenshot. Check for
     overflow and for clutter.
   - `npm run snapshots`: if the Overview or Settings render changed on
     purpose, run `npm run snapshots:update` and let the diff go in the commit.
     If it changed and shouldn't have, you broke something.
4. **Get an independent review of risky logic.** For anything that moves
   money numbers, have a separate agent audit it with runnable repro scripts.
   Two rounds of that found 21 real loan bugs.
5. **Ship a version.**
   - Bump `manifest.json`: minor for a feature, patch for a fix. Do it **only on
     release day**, in the same step as publishing the GitHub release. Obsidian
     reads the latest version from `manifest.json` on `main` and downloads that
     version's release files, so a manifest ahead of the last release shows every
     user an Update button that fails. Until then the manifest stays at the last
     released version and the changelog heading reads `## x.y.z (unreleased)`.
   - Add a `CHANGELOG.md` entry at the top: `## x.y.z`, then `### Added` /
     `### Changed` / `### Fixed`, with bold lead-ins, written for the user. The
     user reads these, so say what they'll see and do, not how the code works.
   - Tell the user which of the three plugin files changed.

## The user's preferences (important)

- **Terse UI.** Notices are one short line. Dialogs show only what there is
  to decide: no explanatory paragraphs, no redundant labels, and details
  folded away. They pushed back hard on a cluttered label dialog and on a
  multi-paragraph sync notice. When adding UI, cut words.
- **Never invent data.** Don't fill in numbers, categories or assumptions they
  didn't give. Don't pad exports with guessed figures.
- **Don't over-ask.** They dislike LLMs asking "what about rent and food?"
  about things they didn't raise. Make the sensible call, and ask only when a
  wrong guess would be expensive.
- **Money safety over automation.** Anything that could misfile real money
  gets confirmed by the user, never done automatically. For example, a vendor
  charge can exactly match a transfer amount, so transfers are only suggested.
- **Plain language.** Use sentence case and "you". No jargon in user-facing
  text. Code comments explain *why*, in plain English.
- They use it on desktop and phone, in dark theme.

## Conventions in main.js

- Dates are local `"YYYY-MM-DD"` strings. Use `todayLocal()`, `addDays()` and
  `daysBetween()`, and never `new Date(str)` arithmetic across DST. Money goes
  through `round2()`. A transaction `amount < 0` is money out.
- Data files are read with `readJSON(app, FILES.x, fallback)` and written with
  `writeJSON`. A missing file is the fallback value. Add new files to `FILES`;
  the setup button and its test pick them up automatically.
- Transaction ownership is **derived, never stored**. `buildOwnershipIndex`
  and `completeOwnership` decide which bucket (debt, bill, goal, subscription,
  transfer, necessity or discretionary) owns each transaction. Explicit links
  (`applied_payments`, `linked_payments`, `contributions`) outrank inference.
  Don't add a parallel classifier.
- Keep logic in pure top-level functions, so the tests can call them. UI goes
  in `Modal` subclasses and `BudgetDashboardView` `render*` methods.
- SimpleFIN credentials live in `app.secretStorage`, never in a data file.
- The TDZ scan's known, safe self-references are `frame`, `outside` and
  `btn` ×4. Anything new fails the scan: check it isn't read while it's still
  being initialised.

## Things that are deliberate (don't "fix")

The reasons are in `docs/HANDOFF.md`.

- **Loan payments.**
  - An unflagged payment is a regular payment. If it's early or large, it pays
    installments ahead.
  - Only payments marked **Extra toward principal** are principal-only, and
    then next month is still due. The toggle in Apply Payment auto-suggests
    this.
- **Missed installments.** For a loan, only the most recent missed
  installment is reserved, not every one since.
- **Transfers.** Transfer pairs are suggested and the user confirms them.
  They are never auto-hidden.
- **SimpleFIN history.** Requests are capped at 43 days
  (`SIMPLEFIN_MAX_DAYS`), and the bridge's 45-day advisory is ignored on
  purpose.
- **Balances.** The newest stamp wins: the bank's own balance date versus the
  time the user typed a balance.
- **Snapshot export.** The financial snapshot export has no 3-month
  spending, rent or insights section. It was added, then rolled back at the
  user's request. Don't re-add it unless asked.
