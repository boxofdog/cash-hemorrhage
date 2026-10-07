# Changelog

## 1.27.6 (unreleased)

### Changed
- **The Budget folder's README now warns about imports.** A clean import deletes
  the CSV from `Budget/imports/`, so keep your own copy somewhere else.

## 1.27.5

### Added
- **A short tour for new installs.** Eight pages on how the budget thinks and
  how to get set up, with Back, Next and Skip tour. It opens by itself on a
  brand-new install; everyone else can open it any time from the command
  palette: **Budget Tracker: Show tour**.
- **Two views of the debt progress chart.** **Progress** shows just the balances
  you've actually had, scaled to fit, so a few weeks of paydown no longer
  looks flat. **Payoff** keeps the dotted line out to debt-free. Pick either
  above the chart.

### Changed
- **"Budget Dashboard" is now "Budget Tracker"** everywhere: the tab title, the
  header, the ribbon icon, the commands and the bookmarkable note. The commands
  are now **Open in sidebar** and **Create bookmarkable note**. A note you made
  earlier keeps working.
- **Tidier goal rows.** The line under the bar is now one: what's left, the
  pace, and the account it follows. Longer notes moved into a hover tip, and
  the contributions summary is just the count.
- **Tidier debt rows.** Each debt's notes are down to one or two lines, and
  dates are shorter ("Oct 6").
- **One Edit button on each debt.** Next to **Apply payment**, **Edit** opens a
  menu with everything else: Edit loan or plan, Set balance, Close loan or
  Delete.

### Fixed
- **Insights opens on the new month from the 1st.** It used to stay on last
  month until the first transaction of the new one arrived, because it only
  listed months that already had transactions. The current month is now always
  there and selected, with nothing spent yet, and you can still pick an earlier
  month.

## 1.27.4

### Changed
- **Styling cleaned up for Obsidian's plugin checks.** Nothing should look
  different. Grid gaps, hidden settings rows, the flat "link" buttons, the
  swipeable tab and action bars and the trend chart's hover dimming now use
  approaches that hold up on older Obsidian versions.

## 1.27.3

### Added
- **Necessary expense: a category type for unavoidable one-off spending.** An
  oil change is needed but isn't a bill, isn't regular like gas, and isn't a
  transfer. Mark its category a necessary expense and spending on it no longer
  draws down your spending allowance. Nothing is projected or reserved for it.
  It shows in "Where this period's money went" as **Necessary expenses**.

### Changed
- **Categories settings is shorter.** One line of explanation, and each
  category has just **Settings** and **Delete**. Settings holds its name and
  what it counts as: Spending, Variable necessity, Scheduled bill, Necessary
  expense or Transfer. It's one choice at a time, so a category can't be both a
  transfer and a necessity.
- **Bank sync says it can be unstable.** A short purple note under the
  SimpleFIN description: "(Unstable) Some transactions may not appear until you
  use Adjust on SimpleFIN Bridge's website."

## 1.27.2

### Fixed
- **Money moved to a savings goal no longer shows in "Where this period's money
  went."** Like a move between your own accounts, it's the same money in another
  place, so it's out of the list, the total and the count. Your spending
  allowance is unchanged.

## 1.27.1

### Fixed
- **Moves between your own accounts no longer show in "Where this period's
  money went."** They're the same money in a different place, so they're left
  out of the list, the total and the count.
- **Card payments are shown apart.** They're still listed and counted, since the
  cash did leave, but as their own **Card payments** line with the amount in
  purple and a short note: "Pays off spending already counted on the card."
- **A fund in the hero no longer leaves a gap under the other figures.** With a
  capped fund dragged into the hero, Spendable and Total flexibility now grow
  to match its height, with the number centered under its label. On a phone,
  where the figures stack, nothing changes.
- **The Debt Reduction / Savings Focus switch looks like a switch in Obsidian.**
  Obsidian's own button styling was drawing both halves as raised buttons, so
  the one that wasn't selected didn't look off. The unselected side is now flat
  and muted, and the selected one is the filled pill.

## 1.27.0

### Added
- **Loans: car, mortgage, student and personal.** Add one with the **Add loan**
  button on the Debts tab (also in Settings under the debts, and in the
  command palette as **Add Loan**). You give it:
  - The balance, and the date it's as of (the funding date for a new loan).
  - APR and monthly payment. Escrow is asked for only on a mortgage.
  - **First payment.** For a loan whose payments haven't started, nothing is
    set aside until the pay period that date falls in. The row shows a
    "starts Nov 9, 2026" badge until the first payment is applied. After
    that the field becomes **Next payment**.
  - Optionally, a **SimpleFIN** account for the lender's own balance. Every
    sync then takes the balance from the lender (dated by the lender). A
    balance in another currency, or an account id two connections share, is
    refused and reported.
- **Interest the way lenders charge it.** Car, student and personal loans
  accrue simple interest daily, so a first payment 42 days after funding
  carries 42 days of interest. A mortgage charges a month's interest and
  escrow at each due date, so paying a few days early doesn't count as
  principal. Interest a short payment doesn't cover is carried forward, not
  dropped.
- **Each loan row shows:**
  - Payments left, the payoff month and the interest still to come.
  - What $50 more a month would save.
  - Equity, if you give what it's worth.
  - Where the balance comes from.
  - A due date that passed without a payment applied is shown as "…payment
    not applied".
- **In the budget:**
  - A loan's payment is reserved in the pay period it's due in.
  - A missed payment stays reserved: the most recent one, not every month.
  - The last payment is reserved only for what's left.
  - A paid-off loan reserves nothing.
  - Car, student and personal loans with an APR take spare cash in the payoff
    ladder, ranked by rate alongside your cards.
  - A mortgage takes spare cash only if you turn **Put spare cash toward it**
    on.
- **Apply Payment on a loan: "Extra toward principal".** When it's on, the
  money lowers the balance and next month's payment is still due. When it's
  off, it's a regular payment, early or not; more than a month's worth pays
  the months ahead. It turns itself on when this month is already paid and
  the amount isn't a payment's worth. Split payments add up to one payment.
- **Closing a loan** (Close on its row): sold, traded in, refinanced or paid
  off.
  - For a sale, enter the price, the payoff amount and any costs. The result
    is shown as you type ($3500.00 to you, or a shortfall you covered).
  - You can pick the deposit or payment it was. Sale money is filed as an
    **Asset Sale**, a transfer rather than income. A shortfall is filed as a
    payment on the loan.
  - Refinanced opens the new loan with the payoff as its balance. Traded in
    opens a new one to fill in.
  - Closed loans are listed under the debts, each with how it ended and a
    **Reopen** button, which puts the loan and the transaction's label back.
- **Changing a started loan's due date** (your lender moves it from the 9th to
  the 15th): payments already made stay with the months they paid, and the
  next installment is due on the new date.

### Fixed
- A payment that was applied while it was a pending hold now takes the posted
  transaction's date when the hold settles. It used to count as "today".

## 1.26.1

### Changed
- **The label window is simpler.** It now shows only what there is to
  decide:
  - The name and amount on one line, with the bank's text in small print
    underneath.
  - **Category:** one list, ending in **New category…**, which opens a field
    for a new one.
  - **Name:** one field.
  - **Just this one** or **Apply to all**, with **It's a transfer** apart on
    the left.

  What "all" means is one closed line: "Applies to: “PATTERN”". Open it to
  edit the pattern and see what it would catch. Removed: the heading, the
  money-in/money-out hint, the "How should this apply?" explanation, the
  separate "Or type a new category" field, and the long descriptions. A name
  typed before **Just this one** says it only saves with Apply to all, rather
  than being dropped silently.

## 1.26.0

### Added
- **Transfers between your own accounts: suggested, then confirmed by you.**
  Money moved from one account to another shows up twice, the same amount
  out of one and into the other. The Transactions tab now finds these pairs
  (the same amount to the cent, opposite signs, different accounts, within
  5 days) and lists them under "possible transfers to review", both halves
  side by side. Nothing is filed on its own, because a real purchase can
  come to exactly what a transfer did.
  - **Transfer** files both halves as a transfer and takes them off the
    transaction list. Both halves get the same category:
    - a payment into a card is filed under that card's payment category;
    - otherwise a transfer category one half already has (e.g. Savings);
    - otherwise a new **Transfer** category that counts as a transfer.
  - **Not a transfer** means that pair is never suggested again.
  - **Confirm all N that read like transfers** appears when several pairs
    both read like transfers ("To Savings 01" / "From Savings 00"). A shop's
    charge never reads like one, so it's never included.
  - A charge on a credit card is never suggested: money leaving a card for
    your checking would be a cash advance, not a transfer.
  - A transaction waiting in this review isn't also asked for a label.
- **"It's a transfer"** in the label window (Change, or Label in the inbox)
  for a transfer whose other half isn't in the plugin, such as money moved to
  an account that doesn't sync. It's filed as a transfer and taken off the
  list. If its other half turns up later, the pair is suggested for you to
  confirm.
- **Recent transactions** leaves out confirmed transfers, with a line saying
  how many are hidden and a **Show** toggle. Shown, each has **Not a
  transfer**, which puts it back as it was labelled before and stops that
  pair being suggested again.

### Changed
- Capped-fund transfer pairing also respects **Not a transfer**.

## 1.25.2

### Fixed
- **A days-old synced balance no longer replaces a newer typed one.** 1.25.1
  stamped a synced balance with the time of the sync rather than the time of
  the bank's figure. So when a bank had stopped refreshing SimpleFIN, its
  five-day-old balance passed for newer than one typed that morning, and
  replaced it on the dashboard. A synced balance is now stamped with the
  bank's own time. A balance you typed after that stays, on the account and
  on the dashboard, until the bank sends something newer.
- **SimpleFIN's "Requested date range exceeds recommended range of 45 days"
  warning.** Syncs now ask for at most 43 days, which stays inside SimpleFIN's
  45 at any hour in any timezone. The warning also no longer keeps accounts
  from counting as imported. Because it names no account, it used to hold
  back every account, so each sync asked for the full window again and set
  off the warning again.

### Changed
- **The sync notice is short:** one line for what came in ("Synced 3 new
  transactions · 2 balances updated."), then one line per bank that needs
  something.
  - A bank connection SimpleFIN can no longer sign in to: "Example
    Credit Union needs you to sign in again at SimpleFIN Bridge.
    Its balances are from Sep 23."
  - A bank that's simply behind: "…SimpleFIN has nothing newer than Sep 23
    yet."
  - Per-account balances, matched CSV rows and filed transfers are no longer
    listed.
  - The details window only opens for problems the notice doesn't already
    explain.
- A synced balance more than 2 days old says how old it is, under the
  dashboard total and in Settings → Accounts.

## 1.25.1

### Fixed
- **Synced balances no longer lose to an older typed one.** The dashboard's
  cash on hand was a copy of the checking balance saved with the pay period,
  typed at Enter Paycheck. Syncing updated that copy in memory only, so it
  could be overruled:
  - **Another device:** a sync on one device (phone) wrote the new balance,
    but the other device (desktop) still held the period it had loaded. Its
    next recalculation wrote the old figure back over it.
  - **Two checking accounts:** cash on hand always followed the *first*
    checking account. An old CSV-only checking account listed ahead of the
    synced one kept cash on hand frozen however often you synced.

  Now every balance write is stamped with when it happened and where it came
  from (SimpleFIN, or typed), and so is the period's figure. Each
  recalculation uses whichever is newer, and cash on hand is the checking
  account that syncs, when there is one.
- **Syncing before payday no longer drops the paycheck.** A period entered
  with the paycheck "not yet deposited" had it wiped from cash on hand by the
  next sync, even when the deposit hadn't arrived. It's now added on top
  until a deposit filed as Paycheck, or one matching the amount, shows up in
  checking.
- **Every open dashboard updates.** With the dashboard open twice (a sidebar
  and a tab, say), only the first got new figures after a sync or change.

### Added
- **You can see where each balance came from:**
  - **Hero:** under "from $… on hand", the checking account's balance and its
    source, e.g. "Credit Union $1,480.12 from SimpleFIN · Sep 28, 9:14 AM". It also
    notes a paycheck still to come.
  - **Settings → Accounts:** each account says where its balance came from
    and when, and marks the one the budget uses as cash on hand.
  - **Sync notice:** what each balance did ("Credit Union $1,000.00 → $1,480.12", or
    "no change"). When SimpleFIN's newest balance for an account is more than
    2 days old, the notice says the bank hasn't sent SimpleFIN anything newer,
    so a stuck figure there is on SimpleFIN's side.

## 1.25.0

### Added
- **One-button setup.** After installing (main.js, styles.css and
  manifest.json in `.obsidian/plugins/budget-tracker/`), open Settings →
  Budget Tracker and press **Set up**. It creates:
  - the `Budget` folder, with `data`, `imports` and `exports` inside;
  - every data file the plugin uses, at its empty starting value;
  - a starter set of categories. Credit Card Payment and Savings count as
    transfers, Gas as a necessity, and Phone Bill as a bill, so they're
    handled right from the first import;
  - a short `Budget/README.md` saying what each folder is for.

  It only ever creates what's missing: existing files are never overwritten,
  and one that can't be read is named in the notice and left alone. While
  anything is missing, the button leads the settings page, reading
  **Create missing files** if some data already exists. Once everything's
  there it shrinks to a one-line **Check again**. Also available as the
  command "Set up data files and folders".
  - The active pay period and the category order aren't created up front.
    They appear when you first enter a paycheck and import.

### Changed
- The category picker when labelling a transaction also offers categories
  that don't have a rule yet, such as the starter set.

## 1.24.0

### Added
- **Savings goals can follow a savings account (optional).** New goal / Edit
  has a *Savings account* setting and a *Count transfers from* date, which
  defaults to the day you link it; set it earlier to include transfers
  already imported. Money moved into the account then counts toward the goal
  without logging it by hand, and money taken back out comes off it. Capped
  funds' accounts, checking and cards aren't offered.
  - **One goal on the account:** its transfers are added to it on each sync
    or import.
  - **Several goals sharing the account:** each transfer waits in a
    "savings transfers need a goal" inbox at the top of Savings goals. It
    has a button per goal on that account, plus *Not for a goal* for
    interest, a stray deposit, or money that was already there.
  - **Contributions you logged yourself** (Add Funds) are matched, not
    doubled. A transfer of the same amount within 7 days is linked to that
    contribution, which stops holding it back from free cash. When only one
    of the sharing goals logged that amount, the transfer goes to that goal
    automatically; when several did, their buttons are highlighted.
  - The savings side of a transfer whose checking side you already matched
    to a contribution (*Match transaction*) isn't counted again.
  - Assigned rows are filed as a savings transfer, so money arriving in
    savings isn't read as income. Rows you've already categorised keep your
    category.
  - A goal that follows an account says so under its progress. Its transfers
    show as *transfer to savings* or *taken out of savings* in Contributions,
    with **Unassign**, which takes the transfer off the goal and puts it back
    in the inbox rather than letting the next sync reassign it.
  - Deleting a goal keeps its transfers from being handed to the other goals
    on the account.

## 1.23.1

### Changed
- **The snapshot CSV is spreadsheet-ready.** It was one flat Section / Item /
  Amount / Detail list, with APRs, limits and payments left written into text.
  It is now stacked tables separated by blank rows, each block with its own
  header:
  - Summary: `Metric, Amount`.
  - Cash & savings: `Account, Type, Balance, Target Goal, Target Date`.
  - Debts & credit: `Lender, Balance, Credit Limit, Available Credit,
    APR (%), Monthly Min, Remaining Months`.
  - Subscriptions & necessities: `Item, Category, Monthly Cost,
    Billing Cadence`. Recurring bills are included, tagged `Bill`.
  - Investments: `Account, Kind, Value, Statement Date`.

  Every amount, rate and count is a bare number (`1450.00`, `29.99`, `11`),
  dates are `YYYY-MM-DD`, and a figure that doesn't apply is an empty cell.
  Outgoings are positive, so income − outgoings = surplus. A plan paid other
  than monthly shows its payments left as months (7 biweekly ≈ 3.2).
- **Credit available uses the card's live balance** from the Debts tab, when
  the card is tracked there. A card's balance, limit and available credit
  now agree in both the Markdown and the CSV.

## 1.23.0

### Added
- **Export Snapshot.** A new action-bar button (and the command "Export
  financial snapshot") copies a Markdown summary of your finances to the
  clipboard. It also saves the summary as `Budget/exports/Snapshot - YYYY-MM-DD.md`
  with a matching `.csv`. The summary has tables for cash, credit (available =
  limit − balance), savings, debts (card balances with APR and minimums,
  installment plans with payment, frequency and payments left), recurring
  bills, active subscriptions, projected necessities and investments. Totals
  are in bold. An **Income & cash flow** table sets monthly income from your
  latest paycheck and pay cadence (weekly ×4.33, biweekly ×2.166,
  semimonthly ×2) against debt minimums, bills, subscriptions and
  necessities, and shows the net surplus or deficit. If the clipboard can't
  be reached, the notice points you to the saved file instead.
  - Recurring bills such as rent count toward the surplus. A subscription
    that is also listed as a bill is counted once.
  - Projected necessities use your actual spend in each category over the
    last 90 days, converted to a monthly rate.
  - Paid-off debts are left out.

### Fixed
- **Necessity projections for same-day purchases.** Two purchases in the
  same category on the same day read as a buy-every-day rhythm, which could
  reserve hundreds of dollars against Spendable. A rhythm now needs purchases
  on at least two different days.

## 1.22.3

### Changed
- **Smaller, lighter text in the Insights trend chart and drilldown.** The
  chart scales to fill the panel and its text scaled with it, rendering about
  a third larger than intended on a desktop. Axis labels, bar totals, month
  labels, callouts and the heading are now sized for that, with callouts in a
  regular weight. Callout rows are a little tighter too, so more categories
  fit before the chart has to grow.

## 1.22.2

### Changed
- **Two more chart colours:** the dashboard's green (#42CC6C) and red
  (#F64848) join the palette, in slots 6 and 8, where their neighbours are
  easy to tell apart from them. That makes eighteen colours before any repeat,
  so a 17-category spending pie no longer repeats one.

## 1.22.1

### Changed
- **The chart palette is built from the dashboard's own colours.** It's led by
  the accent lavender (#A28AF6) and the Oopsie Fund's cyan (#4ECCCC), then
  hues at their brightness: apricot, sand, orchid, sky, amber, periwinkle,
  rose, pistachio, cerulean, olive-lime, seafoam, violet, jade and pink mist.
  That's sixteen colours before any repeat, up from ten. Spendable's green and
  the over-budget red are left out, since those colours carry meaning. On the
  dark card, neighbouring colours stay distinguishable for colour-blind and
  normal vision, and every colour clears 3:1 contrast. The palette is used by
  the spending pie, the drilldown, and the Portfolio split and allocation bars.

## 1.22.0

### Changed
- **New chart palette**, made for the dark theme. It starts with five brand
  colours: Lavender #7B6CD9, Muted Lime #C8D382, Terracotta #CB7D62, Cream
  #E8E6D4 and Deep Blue #174897. Then comes a derivative of each: the colour
  mixed 75/25 with white or black, written out as the hex `color-mix()`
  produces. That makes ten colours before any repeat. The order was checked
  with a palette validator so that neighbouring slices and wedges stay
  distinguishable for colour-blind and normal vision alike. It's used by the
  spending pie, the drilldown, and the Portfolio split and allocation bars.
- **The drilldown opens in one motion.** The month's bar stretches up to the
  top of the chart while it widens and moves to the left, and closing runs the
  same motion backwards. An older month's grey bar turns the accent colour as
  it opens.
- **The slices keep the bar's shape.** They're clipped to the expanded bar's
  rounded silhouette and cut apart by a 1px gap, so the stack reads as one
  bar in layers. Pointing at a slice or its callout dims the others.
- **Lighter callout type:** names at weight 500 and 11.5px, amounts at weight
  400 and 11px, with contrast rather than weight setting the hierarchy.

## 1.21.0

### Added
- **The Portfolio chart reads out on hover**, the same way the Debt chart
  does. A crosshair snaps to the nearest month and shows its exact value
  ("$123,876.67 · End of August 2026"). It works by touch, and with the arrow
  keys, Home, End and Escape once the chart has focus. Each point now sits at
  the end of its month, and the axis reads months.
- **Opening a month on Insights happens inside the chart (desktop).** Click a
  bar in *Discretionary spend by month*:
  - the other months fade out and the bar slides to the left;
  - it grows to the chart's full height and splits into a slice per category,
    biggest at the top;
  - a callout for each category runs down the space to its right, joined to
    its slice by a leader line: the name, then the amount and share.

  Pointing at a slice or its callout highlights both and dims the rest. With
  more categories than fit, the chart grows taller so every one keeps its
  callout. Click it again to reverse the animation. The bars can be opened
  with Enter and closed with Escape, and the animation is skipped when
  reduced motion is on.

### Changed
- On phones and panes narrower than 700px, a month still opens as the list
  below the chart.

## 1.20.0

### Changed
- **Savings Focus has a new order.** First, dated goals get the pace they need
  this period. Then capped funds take their tapered share. Then dated goals are
  topped up ahead of schedule. Undated goals come last. The Oopsie Fund used to
  come after every goal; it's a cushion against the next surprise, so it's now
  rebuilt before any goal gets ahead of its schedule.
- **Goals remember what's gone in this period.** A contribution logged since
  the period began comes off the goal's pace. Move $1,054 against a $563 pace
  and it asks for nothing more at pace this period, and the surplus goes on
  down the list. A goal's reason says how much is already in when part of its
  pace is covered. The plan is worked out from where things stood when the
  period began, so following it doesn't change it: moving what one line asks
  never changes what the others ask.
- **Only a goal's own target date makes it dated.** The Savings Focus deadline
  is now just a countdown. It no longer gives undated goals a date and turns a
  chef's knife into a five-paycheck deadline.
- **Capped fund balances glow cyan**, in the hero, on their card and in
  Savings goals, to match their cyan bar.
- **Budget targets on Insights are easier to scan.** The top line shows the
  category, Tune, and spent / target (red when over). Under the name is what
  the target asks ("Goal: 5% reduction vs August", or "Target: $50.00/mo").
  Below the bar, the change from last month sits on the left ("+$54.66 vs
  August") and room left on the right ("$42.22 left (74%)", or "+$62.32 over
  budget (143%)").

## 1.19.0

### Added
- **Portfolio import reads any company's statement.** Paste a statement from a
  retirement, HSA or brokerage account at any company. Fidelity, Vanguard,
  Empower and Charles Schwab are recognised by name; others still work, using
  the wording most statements share (beginning and ending value,
  contributions, withdrawals, dividends & interest, fees, market change,
  vested balance, rate of return, allocation). Fidelity 401(k) and HSA
  statements read exactly as before.
- **Investment accounts are yours to manage**, in Settings → Investment
  accounts or with **Add account** on the Portfolio tab: company, kind of
  account (401(k), 403(b), 457(b), IRA, Roth IRA, HSA, brokerage, 529,
  pension), name, how often statements come (monthly, quarterly, or no
  reminders) and, optionally, the last 4 of the account number to tell two
  alike apart. Deleting one deletes its statements too.
- **Saved on its own only when it's sure**: the company, the kind of account,
  exactly one of your accounts it matches, the dates and the ending value.
  Otherwise a **review** shows what was read, marked found or not found, to
  check and fix, with the account to file it under or **New account**, filled
  in from the statement. It also asks for a look when the value moved more
  than 40% since the last statement, when the paste covers more than one
  account, and when the statement shows no dates.
- **Quarterly accounts** are reminded about once a quarter, and the chart
  carries each account's last statement forward so the total doesn't dip
  between quarterly statements. Cards show the company, kind and every figure
  the statement had.

### Fixed
- A Fidelity HSA paste missing its "Ending Account Value" line saved the
  beginning balance as the ending one.
- A fresh vault was given Fidelity 401(k) and HSA accounts it never had, and
  reminded about them. Existing vaults keep the accounts they have.

## 1.18.0

### Added
- **Capped funds.** A savings goal whose balance is a linked savings account's
  live balance, with a ceiling instead of a finish line: an "Oopsie Fund".
  Create one from **New capped fund** in Savings goals or Settings → Savings
  goals. Pick the account (a SimpleFIN-linked savings account, or a SimpleFIN
  account not added yet, which is then added), a ceiling, and where it shows.
  Nothing is logged by hand.
- **Three places to show it**, each with its own look: a figure in the hero
  beside Spendable, a card of its own among the cards, or a row in Savings
  goals. **Move** switches between them. On desktop it can also be dragged by
  its handle.
- **How much it asks for.** Only surplus, never money for obligations or daily
  spending. In Savings Focus it comes after every goal; in Debt Reduction,
  after deferred-interest payoffs and before extra card and loan payoff. Its
  share shrinks as it fills: empty, it can take all the surplus; 90% full, a
  tenth of it. It stops at the ceiling. Once you've moved what it asked, it
  stops asking until the next period. A balance more than 14 days old, or
  never dated, asks for nothing until you sync.
- **Transfers with the fund's account are filed as transfers**, so neither half
  counts as spending or income. This happens on sync, on CSV import and when a
  fund is saved. A half qualifies only when it's already filed as a transfer
  or reads like one ("To Savings 00", "Transfer to SAV x1234"). Card payments,
  debt payments, Zelle and wires never qualify. The fund's half takes the other
  half's transfer category; when neither is filed, both go under "Savings",
  created as a transfer category if it doesn't exist. A paired transfer isn't offered in Mark Paid, Apply Payment or goal
  matching. Relabelling either half undoes the pairing.
- **Spending paid straight from the fund's account** doesn't come out of
  Spendable till payday. A bill paid from it still counts as paid.
- **Balances record their date**, shown on the fund as "as of Sep 22", and
  marked stale after three days.

## 1.17.0

### Added
- **Enter Paycheck lists this period's deposits.** Up to three recent deposits
  into checking that aren't already filed as something else appear as a pick
  list. Picking one fills in the amount and, when you press Calculate, files that
  deposit as Paycheck (that transaction only). Nothing is picked for you unless
  the deposit is already filed as Paycheck. Typing a different amount, or
  choosing *None of these*, clears the pick.

### Fixed
- **Next expected payday is filled in from your pay schedule.** Enter Paycheck
  left it blank even with a schedule set, though the field said it would fill
  itself in.

## 1.16.0

### Added
- **Bank sync through SimpleFIN, optional.** Paste a SimpleFIN Bridge setup token
  under Settings → Bank sync, pick each account's SimpleFIN account under
  Accounts → Edit, and **Sync Transactions** in the action bar brings in posted
  transactions and current balances. Accounts left unlinked keep using Import
  CSV. Also available as the command *Sync transactions (SimpleFIN)*.
- **Sync Transactions button.** Dimmed until a connection is set up, when
  clicking it opens Settings at the token field. While a sync runs it reads
  *Syncing…* and takes no further clicks. It keeps one width throughout, so the
  bar doesn't shift.
- **What a sync does:**
  - Every synced transaction carries its SimpleFIN id, and an id already in the
    ledger is never added again, even if the bank has since edited it.
  - A transaction already imported by CSV takes on the SimpleFIN id instead of
    being added twice, keeping its labels, overrides and payment links. It has
    to be on the same account for the same amount, dated within three days of
    the purchase or posting date, or up to a week before posting when the bank
    doesn't report the purchase date. A bank hold from a CSV settles into the
    synced charge.
  - Each linked account's balance is replaced with the bank's. A card's Debts
    balance is re-anchored with it, as of that card's balance date; checking
    also updates the current period's cash on hand.
  - Pending transactions are left out until they post.
  - Syncs reach back five days before each account's last import, 89 days at
    most, and stop at 20 requests a day, under SimpleFIN's limit.
  - A problem with one account (missing from the feed, not in dollars, an
    unreadable transaction, an error from the bank) opens a review window, and
    that account's import marker stays put so the next sync covers the gap.
  - A failed request leaves your data as it was. A sync that stops partway
    through saving says so, and running it again finishes the job without
    importing anything twice.
- The SimpleFIN connection is kept in Obsidian's secret storage on each device
  (local storage before Obsidian 1.11.4), never in the vault, and is redacted
  from error messages and the console. A setup token pasted into an account's
  SimpleFIN field is refused rather than saved.

### Changed
- Import CSV refuses a file for an account that syncs through SimpleFIN. Once an
  account is unlinked, its CSVs skip rows SimpleFIN already brought in, and the
  import result lists each one.

## 1.15.0

### Changed
- **The Transactions tab is an inbox.** Recent transactions is now a single
  full-width card and the tab's main content, in place of the old two-column
  layout.
- **Unlabelled transactions arrive as a notification.** When any transaction
  needs a category, a bar under the tabs says how many — *"3 transactions need
  labels"*, with a red dot — and opens a panel of just those, newest first, each
  with a Label button. The panel slides open in the page flow, pushing Recent
  transactions down rather than covering it, and stays open while you work
  through the queue. It shows twenty at a time and says how many are behind them.
- **When the last one is labelled, the bar and panel disappear**, leaving just
  the recent list. There's no "all clear" card taking up space when there's
  nothing to do. New unlabelled transactions from a later import arrive as a
  closed notification.

## 1.14.0

### Changed
- **Every date is picked from a calendar.** The nine fields that asked you to
  type `YYYY-MM-DD` — next payday, the BNPL, bill and card due dates, the payoff
  deadline, goal target date, savings deadline, pay-schedule anchor and Mark
  Paid's covered date — are native date pickers, and the portfolio statement
  month is a month picker. Stored dates are unchanged.
- **Money fields check themselves as you type.** A figure that isn't a dollar
  amount says why under the field while you type it, and settles into
  `1,234.50` form when you leave. Saving refuses it instead of quietly saving a
  different number — `12abc` used to be saved as $12, and a minimum payment of
  `4O` (letter O) as $4. Blank optional fields still mean $0. APR fields get the
  same checking, as percentages.
- **Category dropdowns list what you use most first**, ranked by how often each
  category appeared over the last 90 days of transactions. The ranking is taken
  when you import and holds still between imports, so the list doesn't shift
  every time you relabel something. Categories you've never used sort
  alphabetically at the bottom; renaming or deleting a category updates the
  ranking straight away.

### Added
- **Merchant patterns show what they'd catch as you type** — in Categorize
  transaction, Edit rule and Rename subscription. The line accounts for rule
  order and one-off overrides: *"Matches 5 transactions — will categorize 3.
  2 already go to the "Taco Bell" rule."* It warns when a pattern matches
  nothing, or stops matching the very transaction you're labelling.
- **Hover the Total debt progress chart for exact figures.** The readout snaps
  to the nearest date from anywhere over the chart and shows the balance to the
  cent, including the projected payoff date. It works by tap on a phone, and the
  chart takes keyboard focus: arrow keys step through the points.

### Fixed
- **Amounts typed with a thousands comma were saved as the digits before it** in
  Enter Paycheck (paycheck and checking balance), the account form (balance and
  credit limit) and credit card terms. A `1,100.00` paycheck was saved as $1.
  These fields now read commas like every other amount field already did.
- Edit Balance on a BNPL plan: changing the installment count now updates the
  balance field. It used to leave the old figure showing while Save stored the
  new one.

## 1.13.0

### Added
- **Confirming a subscription is gone.** A subscription flagged to cancel gains a
  **Confirm it's gone** button once there is evidence it stopped: its next charge
  was due and that date has passed, every account it bills on has imported data
  covering that date, and nothing from that merchant posted on or after it. Until
  then the row says what it is waiting on — the date the next charge is due, or
  which account to import and how far.
- Confirmed subscriptions drop off the subscription screen and out of the monthly
  totals. A line at the bottom of the card lists them and what they cost a year.
- A confirmed subscription reappears on its own if a later charge posts, badged
  **charged again** and reset to unreviewed.

### Changed
- A subscription with a single charge and a guessed cadence cannot be confirmed
  gone; setting its cadence by hand makes it eligible.
- Changing a subscription's keep/cancel flag clears its confirmation. Changing
  its cadence does not. A rename carries it to the new name.
- The confirm button sits with its explanation rather than in the row's control
  cluster, which was making that row's buttons wider than every other row's and
  pushing its amount out of line with the list.

### Under the hood
- Stored as `faded_out_at` and `faded_out_after` in `subscription_reviews.json`.
  Nothing is written to transactions and nothing is recategorised — this only
  affects whether the group renders.
- Audit rows resolve one cadence key shared by the displayed cadence and the
  expected-charge date.

## 1.12.1

### Fixed
- **A type column no longer overrules a negative amount.** It only settles a sign
  when the amount is positive. A row categorised "Credit Card Payment" was
  turning a real −$450 payment into a +$450 inflow.

### Added
- **Accounts can say their card bills the other way round.** New option
  **"Exports purchases as positive numbers"** (`invert_positive_charges`) for
  cards like Amex and Apple Card that write purchases positive with nothing in
  the file to say so. It normalises the amount column before any type-based
  reasoning, and deliberately does not apply to debit/credit column splits, which
  name the direction outright.

## 1.12.0

### Added
- **More column aliases in CSV import:** `post date`, `trans. date` and
  `clearing date` for dates; `name` and `title` for descriptions; `amount (usd)`,
  `billed amount` and `transaction amount (usd)` for amounts; `reference number`
  and `reference` for transaction ids. Exact matches are tried against every
  candidate before any substring fallback, so `date` can sit in the same list as
  `posting date` without swallowing it.
- **Positive-only exports get their direction from a type column.** Where such a
  column exists and names a direction — debit, purchase, withdrawal, sale, credit,
  payment, refund, deposit — it decides the sign. An unrecognised value leaves the
  file's own sign alone.

### Changed
- The CSV source picker reads "Universal / Auto-detect (Chase, Amex, BofA, etc.)".
  The stored value stays `mainbank`, so existing accounts are untouched.

## 1.11.2

### Changed
- **The dashboard title is a masthead:** centred, uppercase, weight 800, widely
  tracked, with hairline rules running out to the pane edges. The lettering
  carries a gradient built from theme variables, so it re-tints when the user
  changes their Obsidian accent or switches light/dark. Every colour has a
  fallback, since an unresolvable gradient would leave the title invisible rather
  than merely off-colour.

## 1.11.1

### Changed
- **The strategy switch moved into the action bar**, at the right-hand end. It is
  now reachable from every tab rather than the Overview alone, and renders before
  the first paycheck is entered — previously it sat after an early return, so a
  new user could not choose a strategy until they had run Enter Paycheck once. On
  a phone it takes a full-width row beneath the buttons.

### Removed
- A leftover rule styling an action-bar button for "Relocation Mode", which no
  longer exists.

## 1.11.0

### Changed
- **Savings Mode is now a strategy switch on the dashboard** — a segmented
  **Debt Reduction / Savings Focus** control above the figures it governs.
  Pressing a choice writes the setting and recalculates, since the strategy
  changes what the allocator does. Pressing the choice already running does
  nothing.
- Settings keeps the deadline and countdown but no longer carries a toggle. The
  section is called **Strategy**, and under Debt Reduction it explains where
  surplus is going instead of showing a savings deadline field that does nothing.
- The "extra debt payoff is paused" banner appears only when it carries something
  the switch doesn't — a deadline countdown, or a malformed date to fix.
- Every user-visible "Savings Mode" is now "Savings Focus" or "Debt Reduction",
  including the banner title, deadline notices, both recommendation columns, the
  command palette entry and the plugin description.
- Below 700px the switch becomes a full-width pair with 40px targets.

## 1.10.3

### Changed
- **The chart palette follows the theme.** `PIE_COLORS` holds Obsidian's own
  `--color-*` variables instead of fixed hex codes, each with a fallback to
  Obsidian's default for that colour. The palette is 9 colours rather than 12, so
  with a long category list more categories share a colour than before.

## 1.10.2

### Changed
- Hero figures align on their tops. Aligning bottoms dropped Total Flexibility to
  match the Spendable subtitle's baseline rather than the number's.
- Spendable renders green.
- The pie palette is brighter. It also drives the Portfolio allocation bar.
- Copy: the surplus card's title is gone, since its two column headers already
  name it. Paused payoff now reads *"Paused while Savings Mode is on — turn off
  to see debt paydown."* Savings total: *"$X allocated to goals."* Minimums:
  *"$X total paid in minimums this period."*

## 1.10.1

The visual half of the 1.10.0 consolidation. The Overview is another 13% shorter.

### Fixed
- **87px of dead air in the hero.** Turning it into a column stack left
  `flex-wrap: wrap` behind from when it was a row, which made its three children
  wrapped flex lines that stretched to fill.
- Projected-necessity detail was being truncated mid-sentence in a narrow pane —
  `.budget-fixed-name` is `nowrap` with an ellipsis, which is right for a bill
  name and wrong for a two-line text column. Those cells wrap now.

### Changed
- The two hero figures span the bar as a `repeat(auto-fit, minmax(190px, 1fr))`
  grid rather than sitting in the left third.
- The pie legend flows into as many 250px columns as the pane allows, which
  halves its height. The chart grew from 200px to 232px to match.
- The **Spending / Income** switch is a segmented control rather than two loose
  buttons.
- **"No goal pinned"** is a slim note rather than a full card's padding around one
  line.
- The inline layout styles 1.10.0 used to work around its no-CSS constraint are
  now real classes.

### Removed
- Five dead rules: `budget-income-card`, `budget-savings-plan`,
  `budget-necessity-card`, `budget-buffer-row`, `budget-unreconciled`.

## 1.10.0

Overview consolidation: nine top-level cards to six, DOM only — no budgeting
math, ownership logic or stylesheet was touched.

### Changed
- **The hero showed a number and its own duplicate.** "To stash this period" and
  "Recommended savings" were the same dollars. The free-cash block is gone;
  **Spendable till payday** and **Total flexibility** are the two primary numbers.
  The basis line (`from $X on hand − $Y committed …`) and the Update balance
  button moved onto the hero, as did the three buffer drill-downs, which explain
  the Spendable figure and had been sitting under a list of bills.
- **Projected necessities** shares the upcoming-charges card instead of having one
  of its own; it is the same kind of thing as a subscription.
- **Recommended savings and Recommended payoff** merged into one full-width card,
  *Where this period's surplus goes*, with two columns that wrap on a narrow
  screen. The savings column now says *"Savings Mode is off, so surplus goes to
  debt"* rather than not rendering at all.
- **The two pie charts became one card** with a Spending / Income toggle and a
  single range selector, which is what it always controlled. Switching view
  clears the open drill-down.

### Removed
- **"Cash held for daily spend"**, which was the same number as Spendable one card
  apart. The obligations card is now only what is due this pay period.

## 1.9.0

Four UI changes. No budgeting math, ownership or reconciliation logic was touched.

### Changed
- **Pinning a goal is something you press.** The dashboard was picking a goal by
  testing its name against a hidden pattern (`move`, `relocat…`, `deposit`), so
  "Moving Fund" was pinned and "New apartment" was not. Every goal now has a
  **Pin to dashboard** button; pinning one unpins the rest, and the pinned card
  carries its own **Unpin**.
- **Budget targets moved to Insights**, where the chart that shows whether they
  are met already lives. The Budget targets card gained a category picker and a
  **Set target** button. The target box and the "⚡ Reduce" dropdown are gone from
  the category rows in Settings. The picker offers only categories a target can do
  anything for, which it decides from `isDiscretionaryCategory` and the ownership
  index rather than re-deriving it.

### Added
- **Accounts can be edited.** An **Add account** button in Settings and an
  **Edit** button on every row. The ID is shown but not editable, since
  transactions, credit-card terms and import markers all refer to an account by
  it; institution is the editable display name. An edit preserves
  `last_imported_through`.

### Removed
- The "Mode label" setting and `savingsLabel`. A value stored by an older version
  is deleted on load.
- Five CSS rules for the "⚡ Reduce" dropdown.

## 1.8.5

### Fixed
- **A subscription could be offered for matching.** `MATCHABLE_OWNER_TYPES` is now
  `debt`, `fixed_expense`, `savings`. Subscription money is still reserved and
  still excluded from the spending allowance; it just never asks to be matched,
  because it settles itself when the charge posts.
- **Apply Payment built a weaker ownership index than the tab it opens from**,
  missing `rules` and subscription keys — so a kept subscription charge read as
  ordinary spending there and could be offered as a payment toward a debt. It now
  builds through `completeOwnership` with every field.

## 1.8.4

Eight reported defects.

### Fixed
- **A category a tracker claims is that tracker's money.** `ownerOf` resolved
  through a run of `if`s with `transfer` above `debt`, so `Credit Card Payment` —
  both a card's payment category and a transfer — resolved as transfer money. No
  figure was wrong, but a transfer names no obligation, so a card payment could
  never be matched or paired with the card's minimum. The tiers are now an
  explicit ordered list on the rule that **declared intent beats inferred
  intent**. Savings has no category tier, since only an explicit link can say a
  transaction is a contribution.
- **Renaming or deleting a category orphaned the bills and debts pointing at it.**
  `payment_category` is a name, and rename and delete never updated it, so a
  tracker kept pointing at a category that no longer existed and silently stopped
  recognising its own payments. Rename now moves it on every fixed expense,
  installment plan and card; delete moves it to the reassignment target or clears
  it, and the confirm dialog names what expects the category; merging carries all
  five category flags across.
- **The Subscriptions Delete button threw the moment it was pressed.** It called
  the category delete flow with variables that exist only in Settings. It is gone
  from Subscriptions, which is managed with Keep/Cancel, and category deletion is
  wired into Settings → Categories next to Rename.
- **Candidate lists could fall back to a partial ownership index.** A partial
  index under-classifies rather than failing — with no `categoryMeta`, a fuel
  purchase reads as ordinary spending, and ordinary spending is the one class
  every obligation accepts. All three finders now build a complete index through
  one helper, and the dashboard builds its index once per render.
- **Overlapping dashboard renders painted two of everything.** `render()` emptied
  the container and then awaited. It now uses the same lock the settings render
  has.
- **Month lookups ignored your timezone.** Three places used
  `new Date().toISOString().slice(0, 7)`, so west of UTC an evening on the last of
  the month reported the next one.
- **Portfolio showed `$NaN`** for a statement that doesn't break its ending value
  down per fund. It says "value unavailable".
- **The shortfall sentence named three of five things.** `committed` is fixed
  costs, minimum payments, subscriptions, earmarked savings and projected
  necessities; the last two are often the larger half.

## 1.8.3

The "Payments to match" window listed eight payments and could act on one.

### Fixed
- **A bank hold and the charge that replaced it were kept as two transactions.**
  Pending holds arrive with both date columns empty, and the import's
  reconciliation required a date on both sides. Apply Payment linked the hold, so
  the posted charge stayed unclaimed and the budget kept asking the user to match
  a payment they had already applied. Import now recognises an undated stored row
  as a hold and matches on account, amount and merchant, stripping the
  boilerplate lead-in banks rewrite on posting. Pairs already in the vault are
  merged on load, carrying every payment link across. The merge never crosses
  accounts, never runs when two settled charges could be the other half, and never
  runs when the two are applied to different things.
- **One transaction could be recorded as paying the same obligation twice** — a
  $24.37 installment counting as $48.74 and rolling its due date forward a cycle
  early. Duplicate links are collapsed, keeping the entry with a posting date.
  Balances that were inflated correct upward, and the load notice says so.
- **Payments were offered for matching that had nothing to match.** A gas fill, a
  pet-food run and a transfer to savings have no obligation to point at. The list
  is limited to debts, bills and subscriptions, and only appears when a reserve is
  actually open.
- **Match no longer dead-ends.** Six BNPL plans all take payments in the `BNPL`
  category, so the category can never decide which one a charge paid — and the
  flow only proceeded when exactly one debt matched. It now asks, listing the
  plans or bills it could be with due date and amount owed, marking any whose
  amount matches to the cent as a hint only.
- **The Debts tab used a weaker candidate list than everywhere else**, built
  without fixed expenses or savings goals, so it could offer a transaction already
  linked to a bill or a contribution.

## 1.8.2

### Fixed
- **Matching a debt payment opens Apply Payment** on the right debt, with the
  transaction already in the candidate list even when it falls outside the window
  the list would normally show. It previously sent the user to the Debts tab with
  a notice telling them to find it themselves.
- With no suggestion to go on, the debt is inferred from the transaction's
  category when exactly one tracked debt takes payments in it.
- A suggestion pointing at a deleted bill or debt falls through instead of
  throwing.

## 1.8.1

### Fixed
- **Candidate lists could offer a transaction belonging to something else.**
  `findCandidateTransactions` excluded transactions that had already settled an
  obligation but not ones already known to be a different kind of money, so the
  fixed-expense list offered fuel, subscription charges and BNPL payments as
  candidates for a phone bill. Candidates are now gated by class: eligible for an
  obligation of their own class, or still unclassified, or a transfer — because a
  card payment and a savings transfer genuinely appear as transfers.
- **`ownsCategory` was answering a wider question than it was asked.** It was
  built from `debtPaymentCategories`, which sweeps in `Uncategorized` and every
  transfer category. It is now `isScheduledCategory`, built only from what debts
  and fixed expenses have declared.

### Changed
- **Reconciliation reads as bookkeeping rather than an emergency.** The "Possibly
  already paid" card is one quiet line — **"2 payments still need matching"** —
  with a Review button and a plain explanation that these are not counted as
  spending and matching them only releases money held back. Review opens a single
  list showing date, merchant, amount and category, with the obligation it
  probably paid.
- "What's used it" stays a spending explanation, with a line noting that bills and
  debt payments are accounted for separately.
- The two reserve cards say what kind of thing they hold.
- A fixed expense's **Payment category** says *"Learned from a linked payment"*
  when the plugin filled it in. Editing it by hand clears the flag.
- Candidate lists distinguish *"No matching payment found in this date range"*
  from *"2 nearby transactions are already accounted for elsewhere"*.

## 1.8.0

Housekeeping. No behavioural change to the budgeting engine.

### Changed
- **`debtKey()` prefers the debt's own `id`**, falling back to the derived key.
  It was derived from the provider name and used as a stored reference, so
  renaming a BNPL plan orphaned its review state.
- **One candidate finder instead of three.** Debt payments, fixed-expense payments
  and savings contributions each had their own implementation and three different
  ideas of what "already claimed" meant — debt suggestions excluded only
  debt-linked transactions, so a payment already linked to a bill or a goal could
  be claimed twice. All three now share `findCandidateTransactions`, taking their
  exclusions from the ownership index and keeping their own ranking.
- **The two thousand-line render methods are gone.** `renderOverview` (1,010
  lines) is a 15-line orchestrator over eight section methods; `renderSettings`
  (655) is seven. The chart range is resolved once and handed to both charts
  rather than each deriving it.
- **Setup lives in one place.** Credit card terms, BNPL plans and savings goals
  were reachable only from the dashboard. Settings now covers all of it, with
  delete confirmations that state what is lost. The action bar keeps only what you
  do during a pay period. Six list sections in Settings are collapsed by default
  with a count in the summary.

### Removed
- `isBufferFundedCategory`, `bufferShortfall`, `expense.flexible` and
  `allLinkedTxIds`. No function in the file is now unreferenced.
- `revolving_debts[].current_balance`. A card balance had three storage locations
  and only two meant anything.
- Orphaned CSS, and the two classes emitted without any rule finally have one.

## 1.7.4

### Added
- **A fixed expense can say where its charges land.** Fixed expenses now carry
  `payment_category`, as a dropdown of existing categories on the add/edit form,
  with the mapping shown on each settings row. Previously the expense's *name* was
  matched against the category, which only works when the two happen to be named
  alike — a bill called "Phone Co" whose charges are categorized "Phone Bill" had
  no match at all. The name fallback stays for expenses that predate the field.
- **Linking a payment teaches the expense.** The first link fills in
  `payment_category` if it is empty, so from then on the bill's charges are
  recognised without being linked. It learns once, never overwrites a deliberate
  choice, and ignores `Uncategorized`.

## 1.7.3

### Fixed
- **Settings sections rendered twice with mismatched contents.** `display()`
  awaits the vault forty-seven times and empties its container only at the start,
  while twenty controls inside it call `display()` again — so a second run
  beginning mid-await emptied the container out from under the first and both
  appended into the same element. Renders are now serialised, with requests
  arriving mid-render collapsing into exactly one follow-up.
- The Categories description covers all three classifications.

## 1.7.2

### Added
- **A category can declare that it is a bill.** Categories have a **Scheduled
  bill** toggle beside Variable necessity, with a badge on the row. It writes
  `exclude_from_discretionary`, a flag the resolver had been reading since before
  the ownership layer existed and which nothing could write. Declaring a category
  keeps its spending out of the allowance without inventing an obligation for it,
  and ranks below every tracked record.

### Fixed
- **Debts created before `payment_category` existed are backfilled on load**
  (`"BNPL"` for plans, `"Credit Card Payment"` for cards). A ledger where every
  plan predated the field would have had its whole category read as ordinary
  spending.

## 1.7.1

### Changed
- **Funding class and exact settlement are separate facts.** 1.7.0 made exact
  reconciliation a prerequisite for non-discretionary, so every unlinked debt
  payment fell through to the spending allowance. The resolver now answers two
  questions: **`class`**, what kind of money this is, and **`settles`**, which
  obligation instance it discharged. The allowance asks class; releasing a reserve
  asks settlement.
- Class is established without a link by two signals from the user's own data: a
  transaction in a category some tracked debt takes payments in, and a fixed
  expense whose name matches the category. Remove the debt and the class goes with
  it — neither is a hardcoded category name.
- **An unlinked BNPL payment no longer consumes the spending allowance.** On the
  period that prompted this, the allowance charge falls from $237.91 to $137.71.
  The obligation stays reserved until a link says it was settled.
- **Reconciliation pairing is class-scoped**, so a restaurant bill can never be
  offered as the settlement for a fixed-expense obligation however neatly the
  amounts line up.
- Variable-necessity history keeps only purchases whose class is
  `variable_necessity`.

## 1.7.0

### Added
**One transaction, one owner.** Several subsystems each decided independently what
a transaction meant, each holding a partial view — so the same dollars could be
reserved as an obligation *and* charged against the spending allowance. There is
now a single derived index answering **"which financial bucket owns this
transaction?"**, and every subsystem asks it.

| # | Owner | Established by | |
|---|---|---|---|
| 1 | `debt` | `applied_payments[].tx_id` | explicit |
| 2 | `fixed_expense` | `linked_payments[].tx_id` | explicit |
| 3 | `savings` | `contributions[].linked_tx_id` | explicit |
| 4 | `subscription` | merchant matches a kept subscription | inferred |
| 5 | `transfer` | category `is_transfer` | inferred |
| 6 | `variable_necessity` | category `is_variable_necessity` | inferred |
| 7 | `fixed_expense` | category name looks scheduled (legacy) | inferred |
| 8 | `discretionary` | nothing stronger claimed it | fallback |

Money coming in is typed `income`. **Nothing is persisted** — the index is rebuilt
from the source trackers on every run, so recategorizing a transaction produces a
different answer next time with nothing to migrate or repair. Tier 7 is the
pre-existing category-name heuristic, kept for compatibility and deliberately not
extended.

Also added:

- **A "Where this period's money went" breakdown** on the Overview, attributing
  every outgoing transaction to the one bucket that absorbed it.
- **Overview names the double-reserve:** *"Possibly already paid — 3 obligations
  are still being held back while transactions that look like they already paid
  them sit unlinked."* Each row offers the transaction it suspects and a button to
  link it. It reports rather than auto-applies, since a false match would release
  a reserve for money still owed.

### Changed
- The buffer classifier asks the index rather than rebuilding the debt ledger, the
  fixed-expense ledger, savings links and subscription keys for itself.
- Variable necessities are no longer projected on top of categories a debt tracker
  already models as installments and minimums.
- **"Due this period" is an umbrella view** over fixed expenses, debt
  installments, card minimums and kept subscriptions, with each source tracker
  still authoritative — nothing is copied into `fixed_expenses.json`.

## 1.6.0

### Fixed
- **A card's balance could only ever go down.** `debtBalance()` was
  `anchor − payments` floored at zero, with no term for new charges — right for a
  BNPL plan, which only amortizes, and wrong for revolving credit. A card is now
  `anchor + charges since − payments since`, derived from its own imported rows.
  BNPL still uses the plan model. With no card activity imported it falls back to
  the previous figure rather than reporting a balance that ignores known payments.
- **The balance typed in one place now reaches the other.** Editing on the
  Overview wrote `accounts[].current_balance` while the Debts tab read
  `revolving_debts[].balance_anchor`, so the same card showed two different
  numbers indefinitely. Both entry points re-anchor the card and update the
  account together.
- **Re-anchoring a card keeps its applied-payment ledger.** For a card that ledger
  credits the billing cycle's minimum rather than the balance, and clearing it
  made a minimum you had already paid reappear as due. BNPL still clears.
- **Only payments dated after the anchor reduce it.** Without this, typing in your
  real balance immediately subtracted payments that figure already included.
- The extra-payoff allocator capped each recommendation at the stale anchor, so a
  card charged since it was last anchored was under-paid. It uses the live balance.
- Total debt and the burndown chart include card charges, so the history stops
  sloping down through periods where the balance grew.

### Changed
- **The anchor and the ledger are both shown**, since they import on different
  cadences: *"anchored $590.46 on 2026-09-11 · +$121.84 in 6 charges"*. A card
  whose import is more than a few days old says so.
- **Apply Payment on a card credits the cycle's minimum** and says so, rather than
  projecting a new balance it no longer controls. A card payment appears twice in
  the ledger — negative on checking, positive on the card — so counting both would
  subtract every payment twice. BNPL is unchanged.

## 1.5.0

### Changed
- **The buffer is now an allowance that gets spent down.** It was a wall: $350
  stayed reserved all period however much of it you spent, so ordinary spending
  hit you twice — once as a smaller bank balance, once as a reservation that never
  moved. Spending draws it down and "Spendable till payday" shows what is left.
  If cash falls $40 and the remaining allowance falls $40, genuinely uncommitted
  money doesn't move.
- Buffer use is **derived from transactions on every run**, never incremented, so
  deleting, editing, recategorizing or refunding a transaction produces a
  different answer next time instead of corrupting a counter.
- **Unrecognized spending counts.** Buffer eligibility uses its own predicate
  rather than the analytics definition of "discretionary", which excludes
  `Uncategorized` on purpose — reusing it meant a $40 dinner at an unknown
  merchant moved the bank balance and nothing else.
- Transactions settle the bucket that funded them: fixed expenses marked paid,
  subscriptions already billed, applied debt payments, variable necessities,
  transfers and linked savings contributions are each excluded from the allowance.
- Refunds credit the allowance back, netted per category and never below zero.
  Unlabeled credits never count — an unlabeled debit is ordinary spending, but an
  unlabeled credit is more likely a deposit, and treating it as a refund would hand
  back allowance that was never recovered.
- Overspending floors the displayed figure at $0 and says by how much you are
  over. Cash has already fallen by the overrun, so it needs no separate deduction.
- **The allowance is snapshotted at period start.** The Smart Buffer is derived
  partly from the current month's spend, so re-deriving it mid-period would make
  "you spent $227 of your $350" untrue. Deliberate changes re-capture it —
  switching between Smart and manual, editing the manual amount, starting a new
  period. Passive recalculation never does. Older periods get a snapshot on their
  first recalculation.

### Added
- **Fixed expenses link to their actual transaction.** Mark Paid asks which
  transaction it was, the same way Apply Payment does for debts, and stores it in
  a `linked_payments` ledger keyed by transaction id. The previous amount-match
  could let a $50 dinner stand in for a $50 insurance bill.
- The candidate list follows the due-date field as you edit it. Editing the date
  clears the list and any selection immediately — only the lookup is debounced —
  and a slow reply for a date you have moved on from is discarded.
- Overview gains a **"What's used it"** breakdown.
- **End-of-period savings sweep.** Finish a period without spending the whole
  allowance and the leftover is offered to savings at the next paycheck, or when a
  lapsed period rolls forward. It is split by the normal savings allocator — dated
  goals at the pace they need, then top-ups, each capped at its remaining target —
  and whatever won't fit stays as free cash. Three states: closing the modal leaves
  it *pending* and the Overview keeps offering it; only "Not this time" dismisses
  it. A pending sweep is recomputed from source each time it is surfaced. Nothing
  moves without confirmation. One decision per period, in `buffer_sweeps.json`.

### Fixed
- **A bill due on the 29th, 30th or 31st vanished from any shorter month.** The
  day match was exact, so "due on the 31st" never fired in September or February.
  The day is clamped to the month's last day.
- **A bill due on the last day of a pay period was dropped.** Both due-date
  helpers parsed as UTC while reading back as local, so west of UTC the window sat
  seven hours early and its final day was never tested.
- Mark Paid refuses a blank or impossible due date rather than writing it to
  `last_paid_date`. `2026-02-31` is rejected too, not just malformed text.

## 1.4.2

### Fixed
- The Portfolio header rendered as unstyled plain text — it used `budget-head`,
  `budget-stats` and `budget-stat` class names borrowed from a different plugin,
  none of which exist in this stylesheet. Replaced with a proper panel: the total
  as a hero figure, a "not spendable" badge, a split bar showing each account's
  share with a matching legend, and a styled import button. Styled deliberately
  unlike the cash hero so invested balances are never mistaken for pay-period
  money.

## 1.4.1

Fixes from parsing real Fidelity statements rather than representative samples.

### Fixed
- **Personal rate of return was never captured.** The statement splits the label
  from its value with a column header. Labelled lookups now tolerate
  `This Period`, `Year-to-Date`, `Period to date` and footnote markers between a
  label and its number.
- **Holdings were wrong, not merely missing.** The generic scraper matched any
  name followed by a number, so it recorded `Employer Contributions $175.66` as a
  fund. Holdings are read only from the section that lists them — Additional Fund
  Information for the 401(k), Top Holdings for the HSA — with contribution and
  summary rows excluded. A market value is attached only when there is exactly one
  fund and the account total is known.
- **HSA change fields were unreadable.** Added `Change in Account Value` and bare
  `Account Value`, and handled `Change in Investment Value * 1.07 2.10`, which
  carries a footnote marker and two columns — the current period is taken.
- **Fidelity's HSA statement detail carries no statement period.** The import
  modal has a Statement month field, defaulting to the previous month and
  consulted only when the pasted text has no period of its own. The snapshot
  records a warning noting where the period came from.
- Column header rows inside a holdings table reset the name buffer instead of
  being prepended to the first holding's name.

## 1.4.0

### Added
- **Portfolio tab** for long-term invested assets, tracked from pasted Fidelity
  statement text. Entirely separate from the pay-period engine: portfolio values
  never touch cash on hand, committed, free cash, the buffer, Savings Mode, debt
  recommendations or deficit math.
- Supports Fidelity NetBenefits 401(k) and Fidelity HSA statements. The type is
  detected first, then parsed by a dedicated parser.
- **Allowlist parser:** only balances, dates, holdings, allocation and rate of
  return are read. Name, address, employee number, division and linked bank
  details are never extracted, and the pasted text is held in memory only — never
  written to disk, never logged.
- Fidelity's own wording is preserved. "Change in Investment Value" is not
  relabelled as market gain, because it can include distributions and income.
- One snapshot per account per statement month. Re-importing an identical
  statement reports it and does nothing; different values require confirmation.
- Validation requires provider, account mapping, both statement dates and an
  ending value. A failed parse saves nothing, keeps the pasted text for retry, and
  names exactly which fields were not found.
- Missing prior-month statements are flagged from day 7 onward, derived from
  stored snapshot coverage rather than import attempts or acknowledgement.

## 1.3.0

### Added
- **Projected necessities.** Categories can be marked as variable necessities with
  an optional minimum qualifying purchase amount, so partial gas fills do not
  distort the estimate. Uses up to eight qualifying purchases from the last 60
  days to learn the median amount and gap, then projects only the purchases still
  likely before the next payday. The reserve joins committed and is excluded from
  the Smart buffer, so the same spending is never held back twice.
- **Debt payment review.** Apply Payment has an "Already applied" action for real
  payments already reflected in the balance: it records the fact and hides the
  transaction from future suggestions without reducing the balance again. "Not a
  payment" stays semantically separate.

### Changed
- **Safer imports.** Every CSV import ends with an explicit success, review-needed
  or failure dialog, including added / pending→settled / duplicate / unresolved
  counts. A clean import trashes its source CSV; any warning, ambiguous
  reconciliation, count mismatch or cleanup failure keeps the file for review.
  Pending→settled reconciliation preserves the existing transaction id and user
  metadata, and ambiguous nearby matches are left unresolved rather than guessed.
  `last_imported_through` advances only after a completely clean import.
- Payment candidates are recomputed when the modal opens, so reviewed or dismissed
  transactions cannot reappear from stale dashboard state.

## 1.2.1

### Fixed
- Savings Mode's global deadline paces goals that do not have their own target
  date, instead of treating them as undated overflow.
- The Smart buffer keeps the pay-period start fixed for spend history but projects
  from the current date, so reopening a period later does not reserve money for
  days that have passed.
- The `safetyBuffer` → `manualBuffer` migration is idempotent. A manually saved
  buffer could be overwritten on every load by the legacy value.
- The deficit banner means hard obligations actually exceed cash, not merely that
  the discretionary buffer cannot also be covered.
- Day-based payday calculations use calendar arithmetic rather than elapsed
  24-hour milliseconds, so DST boundaries cannot shift the derived date.

## 1.2.0

### Added
- **Savings Mode**, replacing and generalising Relocation Mode. The deadline is
  optional, the banner label is editable, and old `relocationMode` settings
  migrate on load. Surplus that would go to debt principal is distributed across
  savings goals by a mirror of the debt ladder: dated goals funded to the pace
  they need (soonest first), then topped up, then undated goals by least-funded.
  Minimums are still paid — only extra money is redirected. Warns when a
  deferred-interest BNPL plan's 0% window expires during the savings period.
- **Smart discretionary buffer**, replacing the flat safety buffer. Derives a
  holdback from each discretionary category's daily burn rate and the days left in
  the period, plus 15% margin; a category already over its target budgets from
  actual spend rather than the target it has blown. Switchable between auto and a
  manual flat amount, with a per-category breakdown on the dashboard.
- **Deleting things.** Nothing but category rules could be deleted. Fixed
  expenses, categories, savings goals, debts and accounts all can now, each behind
  a confirmation stating the actual consequence. Deleting a category asks where
  its rules and transactions should go.
- Fixed expenses have a full manager with edit — one entered with a wrong due date
  was previously invisible and permanent.
- Quick balance editor, so a stale account balance can be corrected without a full
  Enter Paycheck cycle.
- Savings goal contributions are held back from free cash until matched to a real
  transfer transaction.

### Fixed
- **Pay periods started on the day the paycheck was entered**, not on payday. A
  check entered on the 9th produced a 09-09 → 09-15 period, orphaning the paycheck
  itself and every earlier transaction, so every period-scoped figure was computed
  over a truncated window.
- **Debt minimums ignored payments already applied**, charging the full installment
  again as an upcoming obligation. Credit is now scoped to the billing cycle rather
  than the pay period, so paying early still counts.
- **Pending bank transactions imported with no date**, so applied payments carried
  `date: ""` and were silently skipped. Import recovers the date from the Effective
  Date or the Transaction ID and flags the row pending.
- **`paydaysBetween` could return 400 duplicate dates**, because `nextPaydayFrom`
  recomputes from the anchor and could return a date at or before the cursor.
- The hero's cash-on-hand line omitted the buffer and recommended savings.
- "Free after saving" was structurally always $0.00 and is replaced with
  "Spendable till payday". Total flexibility excluded the buffer, so it was
  reporting available credit alone.

## 1.0.1

### Fixed
- The extra-payoff allocator read stored debt fields instead of `debtBalance()`,
  so after applied payments it could recommend paying more than was owed — in
  testing, $2,162.50 against a real balance of $212.50.
- Pay-schedule detection classified 12–16 day gaps as biweekly before the
  semimonthly branch could run. The two are now separated by shape: biweekly is
  always exactly 14 days and drifts across the month, semimonthly alternates and
  keeps landing on the same two days.
- Dates were derived from `toISOString()`, which is UTC — west of UTC that reports
  tomorrow's date after late afternoon. All date handling goes through
  `todayLocal()` and `toLocalISO()`.

## 1.0.0

Mobile support and the fixes that came out of real use.

### Added
- **Responsive layout:** single-column cards, stacked hero, scrollable tabs and
  action bar, larger chart labels, full-width controls.
- **Touch handling:** hover lift disabled (it sticks after a tap), 16px inputs so
  iOS doesn't zoom on focus, larger tap targets.
- Entry points that work on a phone: a command to dock the dashboard in the left
  sidebar, a ```budget``` code block that turns any note into a launcher, and a
  command to create a bookmarkable dashboard note.
- **Pay schedule** (weekly / biweekly / semimonthly / monthly + anchor), so payday
  dates are derived rather than typed, and lapsed periods roll forward.
- **Smart Target Tuner:** quick reduction presets in Settings and a slider-based
  tuner on Insights, both baselined on prior-month spend.
- Interactive income pie chart with its own drill-down.

### Fixed
- **Transaction ids collided during bulk import** (`Date.now` plus a small random
  suffix, hundreds of records per millisecond), so "Move" could recategorize a
  different transaction than the one clicked and payment links could be
  misdirected. Ids come from a monotonic counter, existing duplicates are repaired
  on load, and lookups verify the record matches before trusting an id.
- Savings goal pacing divided by the current pay period's length, often a partial
  window. It counts the actual paydays before the target date, falling back to a
  cadence inferred from paycheck history.
- Savings contributions didn't reduce free cash. Unlinked contributions are held
  back as earmarked; matching one clears the earmark.
- Subscription rows declared four grid columns for three children, so controls
  overflowed across the amount column.
- The deficit banner rendered red text on a red background, and fired on the
  safety-buffer shortfall while claiming obligations exceeded income.
- Move and Override failed silently when nothing was selected.

## 0.9.0

Everything below accumulated across roughly 30 build rounds without a version
bump, so this entry covers the whole distance from the original scaffold.

### Core budgeting
- Per-paycheck rolling budget for variable hourly income (not monthly).
- Pay schedule setting (weekly / biweekly / semimonthly / monthly + anchor date) —
  next payday is derived, not typed. Auto-detects from Paycheck transactions.
  Lapsed periods roll forward automatically.
- Free cash (real money) shown separately from total flexibility (includes
  credit), so available credit is never mistaken for cash.
- Active pay period persists across reloads; results recompute on load rather than
  replaying a stale snapshot.
- Paycheck "already deposited?" toggle prevents double-counting.

### Debt
- Balances are derived, never mutated: `balance_anchor` minus an
  `applied_payments` ledger keyed by transaction id, so re-importing a CSV can't
  double-count a payment.
- Credit cards modeled as revolving (APR, statement vs current balance, minimum
  payment); BNPL modeled as installments with no fake APR field.
- Deferred-interest BNPL plans tracked separately with their payoff deadline, and
  prioritized first in payoff recommendations.
- Apply Payment scoped to debt/transfer/uncategorized categories, with
  per-transaction "not a payment" dismissal.
- Debt burndown chart with dotted projection to $0 at the current paydown rate.

### Transactions
- Quote-aware CSV parser; Capital One and generic bank adapters handling signed
  Amount, Debit/Credit pairs and Transaction Type sign conventions. Refuses to
  import silently when no amount column is found.
- Idempotent import: exact duplicates skipped, pending→settled charges reconciled
  within ±3 days.
- Merchant rules with optional display nicknames; raw text kept as tooltip.
- Merchant name cleaning strips POS prefixes, phone numbers, billing URLs,
  reference codes and known city/state suffixes.
- Per-transaction overrides that don't disturb the merchant's rule.

### Subscriptions
- Audit built from real transactions, grouped by rule or cleaned merchant name.
- Cadence inferred from charge history, with a manual override independent of
  Keep/Cancel status.
- Monthly run-rate normalization (a $96/year plan reads as $8.01/mo).
- Subscriptions marked Keep are folded into the pay period's obligations using
  real calendar renewal dates, with a guard against counting an already-posted
  charge twice.

### Planning
- Savings goals (sinking funds) with progress bars, contribution log, and required
  per-paycheck pace when a target date is set.
- Per-category monthly budget targets with target-vs-actual bars.
- Insights tab: month selector, budget target bars, 6-month discretionary spend
  trend.
- Fixed expenses support both a fixed day of month and rolling intervals (e.g.
  every 35 days), with rolling dates advancing automatically on payment.

### Interface
- Five tabs (Overview, Debts, Transactions, Subscriptions, Insights) with
  preserved scroll position across re-renders.
- Action bar so nothing requires the command palette.
- Settings tab for merchant rules, categories, targets and pay schedule.
- Interactive spend and income pie charts with independent drill-downs.

## 0.1.0

Initial scaffold: data model, allocation algorithm, CSV import, dashboard view.

---

## Vault data files

All under `Budget/data/` in the vault. Back these up together — the debt ledger
references transaction ids, so a partial copy breaks referential integrity.

| File | Holds |
|---|---|
| `accounts.json` | checking / savings / credit card accounts, SimpleFIN links |
| `revolving_debts.json` | credit card terms, anchors, applied payments |
| `installment_debts.json` | BNPL plans, anchors, applied payments |
| `fixed_expenses.json` | recurring bills (monthly and rolling) |
| `category_rules.json` | merchant → category rules, nicknames |
| `categories.json` | transfer / variable-necessity flags, thresholds, monthly targets |
| `transactions.json` | imported and synced transactions, overrides, review flags, SimpleFIN ids |
| `subscription_reviews.json` | keep/cancel status, cadence overrides, phase-out confirmations |
| `savings_goals.json` | sinking funds and contributions |
| `debt_history.json` | total debt snapshots for the burndown chart |
| `paycheck_history.json` | logged paychecks |
| `active_period.json` | current pay period state |
| `settings.json` | safety buffer, pay schedule |
| `buffer_sweeps.json` | one end-of-period sweep decision per pay period |
| `portfolio_accounts.json` | portfolio account definitions (401k, HSA) |
| `portfolio_snapshots.json` | one statement snapshot per account per month |
| `category_order.json` | category ranking for dropdowns, taken at each import |
| `simplefin_accounts.json` | SimpleFIN's last-reported account list (for linking), last sync, request times — never the connection itself |
