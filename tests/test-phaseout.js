// Phase-out tests (1.13.0).
//
// The feature's whole risk is a false positive: hiding a subscription that is
// still quietly billing. So most of these assert the NEGATIVE cases — the
// conditions that must block confirmation — and the differential section proves
// that every existing reader of buildSubscriptionAudit sees exactly what it saw
// before, since four of the five feed the allocator.
const P = require("./paths.js");
global.document = { body: { classList: { contains: () => false } } };
const fs = require("fs");
const H = require("./harness.js");
const OLD = require("./harness-for.js")(
  P.BASELINES + "/main.phaseout-before.js"
);
const HF = require("./harness-for.js")(P.MAIN);
const { el } = H;

let pass = 0, fail = 0;
function check(name, got, want) {
  const ok = JSON.stringify(got) === JSON.stringify(want);
  if (ok) { pass++; console.log(`  PASS  ${name}`); }
  else { fail++; console.log(`  FAIL  ${name}: got ${JSON.stringify(got)}, want ${JSON.stringify(want)}`); }
}

const TODAY = "2026-09-22";
const REVIEWS_PATH = "Budget/data/subscription_reviews.json";
// Never hardcode a merchant key — grouping is the implementation's business and
// a fixture that guesses it wrong produces a row with no review attached, which
// blocks on `status` and looks exactly like a correct refusal.
const keyFor = (m) => H.subscriptionGroupKey(m, []);

// --- fixtures -------------------------------------------------------------
let seq = 0;
function tx(date, merchant, amount, accountId = "chase", category = "Subscription") {
  return {
    id: `tx-${++seq}`,
    date,
    merchant_raw: merchant,
    amount,
    account_id: accountId,
    resolved_category: category
  };
}
function acct(id, through) {
  return { id, institution: id.toUpperCase(), last_imported_through: through };
}

// Netflix: monthly, last charged 2026-06-14, flagged to cancel, account current.
const NETFLIX = [
  tx("2026-04-14", "NETFLIX.COM", -15.49),
  tx("2026-05-14", "NETFLIX.COM", -15.49),
  tx("2026-06-14", "NETFLIX.COM", -15.49)
];
const CANCEL = [{ merchant_key: keyFor("NETFLIX.COM"), status: "cancel", cadence_override: null }];

function audit(txs, reviews, opts = {}) {
  return H.buildSubscriptionAudit(txs, reviews, [], undefined,
    Object.assign({ accounts: [acct("chase", "2026-09-20")], todayStr: TODAY }, opts));
}
const row = (rows, keyPart) => rows.find((r) => r.key.toLowerCase().includes(keyPart.toLowerCase()));

(async () => {

// ===========================================================================
console.log("\n1. Eligible and phases out");
{
  const rows = audit(NETFLIX, CANCEL);
  const r = row(rows, "netflix");
  check("the group is still visible before confirming", !!r, true);
  check("it is not phased out yet", r.phasedOut, false);
  check("the expected charge is one cadence after the last one", r.phaseOut.expectedDate, "2026-07-14");
  check("nothing blocks it", r.phaseOut.blockedBy, null);
  check("so the CTA is offered", r.phaseOut.eligible, true);

  // Confirming records BOTH the click date and the evidence behind it.
  const confirmed = [{
    merchant_key: r.key, status: "cancel",
    faded_out_at: TODAY, faded_out_after: r.latestDate
  }];
  const after = audit(NETFLIX, confirmed, { includePhasedOut: true });
  check("after confirming it is marked phased out", row(after, "netflix").phasedOut, true);

  const visible = audit(NETFLIX, confirmed);
  check("and drops out of the default list entirely", visible.length, 0);
}

// ===========================================================================
console.log("\n2. Eligible but the account is stale — the load-bearing condition");
{
  // Everything identical, except the card has only imported through July 1 —
  // BEFORE the July 14 renewal. The charge may well have happened.
  const rows = H.buildSubscriptionAudit(NETFLIX, CANCEL, [], undefined, {
    accounts: [acct("chase", "2026-07-01")], todayStr: TODAY
  });
  const r = row(rows, "netflix");
  check("blocked on import freshness", r.phaseOut.blockedBy, "stale");
  check("no CTA", r.phaseOut.eligible, false);
  check("and it names which account is behind", r.phaseOut.staleAccounts, ["chase"]);

  // An account with no import marker at all is just as unverified.
  const noMarker = H.buildSubscriptionAudit(NETFLIX, CANCEL, [], undefined, {
    accounts: [acct("chase", null)], todayStr: TODAY
  });
  check("a never-imported account also blocks", row(noMarker, "netflix").phaseOut.blockedBy, "stale");

  // Imported to exactly the renewal date counts: that day's activity is in.
  const exact = H.buildSubscriptionAudit(NETFLIX, CANCEL, [], undefined, {
    accounts: [acct("chase", "2026-07-14")], todayStr: TODAY
  });
  check("imported through the renewal date itself is enough", row(exact, "netflix").phaseOut.eligible, true);

  // A transaction with no account can't be checked either way.
  const orphan = NETFLIX.concat([Object.assign(tx("2026-06-14", "NETFLIX.COM", -15.49), { account_id: null })]);
  const orphaned = H.buildSubscriptionAudit(orphan, CANCEL, [], undefined, {
    accounts: [acct("chase", "2026-09-20")], todayStr: TODAY
  });
  check("an account-less charge blocks confirmation", row(orphaned, "netflix").phaseOut.blockedBy, "stale");
}

// ===========================================================================
console.log("\n3. Eligible but a new charge exists");
{
  const withNew = NETFLIX.concat([tx("2026-07-14", "NETFLIX.COM", -15.49)]);
  const rows = audit(withNew, CANCEL);
  const r = row(rows, "netflix");
  check("the last charge moved forward", r.latestDate, "2026-07-14");
  check("so the next expected one is in August", r.phaseOut.expectedDate, "2026-08-14");
  // Aug 14 is past and the account is current, so this one IS confirmable —
  // which is correct: it charged in July and then stopped.
  check("and it becomes eligible again on the new evidence", r.phaseOut.eligible, true);

  // The case that must block: a charge from this merchant that landed OUTSIDE
  // the group — recategorised, so it never made it into the subscription rows.
  const miscategorised = NETFLIX.concat([tx("2026-08-14", "NETFLIX.COM", -15.49, "chase", "Entertainment")]);
  const rows2 = audit(miscategorised, CANCEL);
  const r2 = row(rows2, "netflix");
  check("the group still ends in June", r2.latestDate, "2026-06-14");
  check("but the stray charge blocks confirmation", r2.phaseOut.blockedBy, "charged");
  check("no CTA", r2.phaseOut.eligible, false);

  // A refund posts positive and is filtered out of the group, but still proves
  // the merchant relationship is live.
  const refunded = NETFLIX.concat([tx("2026-08-20", "NETFLIX.COM", 15.49)]);
  check("a refund after the due date blocks too", row(audit(refunded, CANCEL), "netflix").phaseOut.blockedBy, "charged");
}

// ===========================================================================
console.log("\n4. Ineligible because it is still kept");
{
  const keep = [{ merchant_key: keyFor("NETFLIX.COM"), status: "keep", cadence_override: null }];
  check("a kept subscription is never offered", row(audit(NETFLIX, keep), "netflix").phaseOut.blockedBy, "status");
  check("nor an unreviewed one", row(audit(NETFLIX, []), "netflix").phaseOut.blockedBy, "status");

  // Flagged, but the next charge simply isn't due yet.
  const recent = [
    tx("2026-07-14", "NETFLIX.COM", -15.49),
    tx("2026-08-14", "NETFLIX.COM", -15.49),
    tx("2026-09-14", "NETFLIX.COM", -15.49)
  ];
  const r = row(audit(recent, CANCEL), "netflix");
  check("a charge due in the future blocks", r.phaseOut.blockedBy, "not-due");
  check("and it says when to come back", r.phaseOut.expectedDate, "2026-10-14");
}

// ===========================================================================
console.log("\n5. Reappearance after phase-out — no manual un-phase step");
{
  const confirmed = [{
    merchant_key: keyFor("NETFLIX.COM"), status: "cancel",
    faded_out_at: "2026-08-01", faded_out_after: "2026-06-14"
  }];
  check("while quiet it stays hidden", audit(NETFLIX, confirmed).length, 0);

  const resumed = NETFLIX.concat([tx("2026-09-14", "NETFLIX.COM", -15.49)]);
  const rows = audit(resumed, confirmed);
  const r = row(rows, "netflix");
  check("a later charge brings it straight back", !!r, true);
  check("it is no longer phased out", r.phasedOut, false);
  check("it is flagged as having resurfaced", r.resurfaced, true);
  check("and reset to unreviewed for a fresh look", r.status, "unreviewed");
  check("the confirmation date is kept so the row can explain itself", r.fadedOutAt, "2026-08-01");
  check("no CTA on a resurfaced row", r.phaseOut.eligible, false);

  // A backfilled charge EARLIER than the evidence date is history, not a
  // resumption — it must not resurrect the group.
  const backfilled = NETFLIX.concat([tx("2026-03-14", "NETFLIX.COM", -15.49)]);
  check("a backfilled older charge does not resurrect it", audit(backfilled, confirmed).length, 0);

  // A confirmation with no evidence date can't be checked for reappearance,
  // so it is not honoured at all.
  const noEvidence = [{ merchant_key: keyFor("NETFLIX.COM"), status: "cancel", faded_out_at: "2026-08-01" }];
  check("a confirmation with no evidence date is ignored", audit(NETFLIX, noEvidence).length, 1);
}

// ===========================================================================
console.log("\n6. Multi-account groups need ALL accounts caught up");
{
  // Spotify moved from Chase to Amex partway through.
  const SPOTIFY = [
    tx("2026-04-03", "SPOTIFY USA", -11.99, "chase"),
    tx("2026-05-03", "SPOTIFY USA", -11.99, "chase"),
    tx("2026-06-03", "SPOTIFY USA", -11.99, "amex")
  ];
  const rev = [{ merchant_key: keyFor("SPOTIFY USA"), status: "cancel", cadence_override: null }];

  const both = H.buildSubscriptionAudit(SPOTIFY, rev, [], undefined, {
    accounts: [acct("chase", "2026-09-20"), acct("amex", "2026-09-19")], todayStr: TODAY
  });
  const rBoth = row(both, "spotify");
  check("the group records both accounts", rBoth.accountIds.sort(), ["amex", "chase"]);
  check("both current means eligible", rBoth.phaseOut.eligible, true);

  const oneStale = H.buildSubscriptionAudit(SPOTIFY, rev, [], undefined, {
    accounts: [acct("chase", "2026-09-20"), acct("amex", "2026-06-15")], todayStr: TODAY
  });
  const rStale = row(oneStale, "spotify");
  check("one stale account blocks the whole group", rStale.phaseOut.eligible, false);
  check("and it is named", rStale.phaseOut.staleAccounts, ["amex"]);

  // The card it moved AWAY from being stale matters just as much — the service
  // could have moved back.
  const oldStale = H.buildSubscriptionAudit(SPOTIFY, rev, [], undefined, {
    accounts: [acct("chase", "2026-06-20"), acct("amex", "2026-09-19")], todayStr: TODAY
  });
  check("the old card being behind blocks it too", oldStale.find((r) => r.key.toLowerCase().includes("spotify")).phaseOut.staleAccounts, ["chase"]);

  // An account referenced by a transaction but missing from the accounts file
  // has no freshness signal at all.
  const missing = H.buildSubscriptionAudit(SPOTIFY, rev, [], undefined, {
    accounts: [acct("chase", "2026-09-20")], todayStr: TODAY
  });
  check("an unknown account blocks", missing.find((r) => r.key.toLowerCase().includes("spotify")).phaseOut.staleAccounts, ["amex"]);
}

// ===========================================================================
console.log("\n7. A single assumed-monthly charge is not evidence");
{
  const once = [tx("2026-01-10", "OBSCURE SAAS", -99.00)];
  const rev = [{ merchant_key: keyFor("OBSCURE SAAS"), status: "cancel", cadence_override: null }];
  const r = row(audit(once, rev), "obscure");
  check("cadence is a guess", r.cadenceSource, "assumed");
  check("so it is blocked on cadence, not silently confirmed", r.phaseOut.blockedBy, "cadence");

  // Declaring the cadence is the way out — the same "declared beats inferred"
  // rule the ownership resolver uses.
  const declared = [{ merchant_key: keyFor("OBSCURE SAAS"), status: "cancel", cadence_override: "yearly" }];
  const r2 = row(audit(once, declared), "obscure");
  check("a manual cadence makes it measurable", r2.cadenceSource, "manual");
  check("the expected charge follows the declared cadence", r2.phaseOut.expectedDate, "2027-01-10");
  check("which has not passed, so it waits", r2.phaseOut.blockedBy, "not-due");

  // Two charges is enough to infer from, even without an override.
  const twice = [tx("2026-01-10", "OBSCURE SAAS", -99.00), tx("2026-02-10", "OBSCURE SAAS", -99.00)];
  const r3 = row(audit(twice, rev), "obscure");
  check("two charges give an inferred cadence", r3.cadenceSource, "inferred");
  check("and that is eligible", r3.phaseOut.eligible, true);
}

// ===========================================================================
console.log("\n8. Cadence agrees with what the row displays");
{
  // A yearly plan billed once must not be treated as eleven missed months.
  const yearly = [tx("2025-11-02", "ANNUAL THING", -120.00)];
  const rev = [{ merchant_key: keyFor("ANNUAL THING"), status: "cancel", cadence_override: "yearly" }];
  const r = row(audit(yearly, rev), "annual");
  check("the row resolves one cadence key", r.cadenceKey, "yearly");
  check("phase-out uses that same key", r.phaseOut.expectedDate, "2026-11-02");
  check("so a yearly plan is not phased out mid-year", r.phaseOut.eligible, false);

  // And an inferred quarterly row agrees too.
  const quarterly = [
    tx("2025-09-05", "QUARTERLY CO", -60.00),
    tx("2025-12-05", "QUARTERLY CO", -60.00),
    tx("2026-03-05", "QUARTERLY CO", -60.00)
  ];
  const rq = row(audit(quarterly, [{ merchant_key: keyFor("QUARTERLY CO"), status: "cancel" }]), "quarterly");
  check("inferred quarterly resolves to the quarterly key", rq.cadenceKey, "quarterly");
  check("expecting the next one three months on", rq.phaseOut.expectedDate, "2026-06-05");
  check("long past, so confirmable", rq.phaseOut.eligible, true);
}

// ===========================================================================
console.log("\n9. Without accounts, nothing is ever offered");
{
  // Every caller except the subscriptions tab omits accounts. None of them can
  // check import freshness, so none of them may claim a subscription is gone.
  const rows = H.buildSubscriptionAudit(NETFLIX, CANCEL, []);
  check("phaseOut is absent", row(rows, "netflix").phaseOut, null);
  check("but the row still renders", rows.length, 1);

  // The confirmed state is NOT account-dependent, so it still applies.
  const confirmed = [{
    merchant_key: keyFor("NETFLIX.COM"), status: "cancel",
    faded_out_at: "2026-08-01", faded_out_after: "2026-06-14"
  }];
  check("a confirmed group stays hidden for every reader", H.buildSubscriptionAudit(NETFLIX, confirmed, []).length, 0);
}

// ===========================================================================
console.log("\n10. Differential — existing readers see exactly what they saw before");
{
  // A corpus spanning every shape the audit handles: single charges, inferred
  // and overridden cadences, multiple accounts, mixed categories, refunds.
  const CORPUS = [
    tx("2026-04-14", "NETFLIX.COM", -15.49, "chase"),
    tx("2026-05-14", "NETFLIX.COM", -15.49, "chase"),
    tx("2026-06-14", "NETFLIX.COM", -15.49, "chase"),
    tx("2026-06-03", "SPOTIFY USA", -11.99, "amex"),
    tx("2026-07-03", "SPOTIFY USA", -11.99, "amex"),
    tx("2026-01-10", "OBSCURE SAAS", -99.00, "chase"),
    tx("2026-08-20", "HULU 877-8244858", -17.99, "chase"),
    tx("2026-09-01", "KINDLE UNLTD*A1B2C3", -11.99, "amex"),
    tx("2026-09-10", "NETFLIX.COM", 15.49, "chase"),
    tx("2026-09-12", "WHOLEFOODS #123", -84.10, "chase", "Groceries"),
    tx("2026-02-02", "ANNUAL THING", -120.00, "amex")
  ];
  const REVIEWS = [
    { merchant_key: keyFor("NETFLIX.COM"), status: "keep", cadence_override: null },
    { merchant_key: keyFor("SPOTIFY USA"), status: "cancel", cadence_override: null },
    { merchant_key: keyFor("ANNUAL THING"), status: "cancel", cadence_override: "yearly" },
    { merchant_key: keyFor("HULU 877-8244858"), status: "unreviewed", cadence_override: "monthly" }
  ];

  // Fields that existed before the change. If any of these move, an allocator
  // reader downstream sees something different.
  const SHARED = ["key", "rawSamples", "category", "matchedRule", "hasNickname", "latestAmount",
    "latestDate", "chargeCount", "intervalDays", "cadenceLabel", "cadenceSource",
    "cadenceOverride", "monthlyEstimate", "totalSpent", "status"];
  const project = (rows) => rows.map((r) => {
    const o = {};
    SHARED.forEach((k) => (o[k] = r[k]));
    return o;
  });

  const before = OLD.buildSubscriptionAudit(CORPUS, REVIEWS, []);
  const after = H.buildSubscriptionAudit(CORPUS, REVIEWS, []);
  check("same number of rows", after.length, before.length);
  check("every pre-existing field is byte-identical", project(after), project(before));

  // The keep-filter every allocator reader applies must produce the same keys.
  const keysOf = (rows) => rows.filter((s) => s.status === "keep").map((s) => s.key).sort();
  check("the kept subscription keys are unchanged", keysOf(after), keysOf(before));

  // upcomingSubscriptions now reads cadenceKey off the row rather than
  // recomputing — it must still land on the same dates.
  const upBefore = OLD.upcomingSubscriptions(before, CORPUS, [], "2026-09-22", "2026-10-06");
  const upAfter = H.upcomingSubscriptions(after, CORPUS, [], "2026-09-22", "2026-10-06");
  check("upcoming subscriptions are unchanged", upAfter, upBefore);

  // And a hand-built row with no cadenceKey still works through the fallback.
  const handmade = [{ key: "Manual", status: "keep", latestDate: "2026-09-25", latestAmount: 9.99, intervalDays: 30, cadenceOverride: null }];
  check("a row without cadenceKey still resolves", H.upcomingSubscriptions(handmade, [], [], "2026-09-22", "2026-10-06").length, 1);

  // With accounts supplied the extra pass must not change any shared field.
  const withAccounts = H.buildSubscriptionAudit(CORPUS, REVIEWS, [], undefined, {
    accounts: [acct("chase", "2026-09-20"), acct("amex", "2026-09-19")], todayStr: TODAY
  });
  check("supplying accounts changes nothing pre-existing", project(withAccounts), project(before));
}

// ===========================================================================
console.log("\n11. Persistence goes through patchSubscriptionReview");
{
  // A fake vault so the write path can be exercised end to end.
  function fakeApp(initial) {
    const store = { [REVIEWS_PATH]: JSON.stringify(initial) };
    return {
      _store: store,
      vault: {
        adapter: {
          exists: async (p) => p in store,
          read: async (p) => store[p],
          write: async (p, d) => { store[p] = d; },
          mkdir: async () => {},
          list: async () => ({ files: [], folders: [] })
        }
      }
    };
  }
  const read = (app) => JSON.parse(app._store[Object.keys(app._store)[0]]);

  const app = fakeApp([{ merchant_key: keyFor("NETFLIX.COM"), status: "cancel", cadence_override: "monthly" }]);
  await H.confirmSubscriptionGone(app, keyFor("NETFLIX.COM"), "2026-06-14");
  const rec = read(app)[0];
  check("the evidence date is stored", rec.faded_out_after, "2026-06-14");
  check("and the confirmation date", !!rec.faded_out_at, true);
  check("status is untouched", rec.status, "cancel");
  check("cadence override is untouched", rec.cadence_override, "monthly");
  check("only one entry", read(app).length, 1);

  // Changing the flag retires the confirmation — otherwise pressing Keep on a
  // resurfaced row would leave a stale one behind to hide it again.
  await H.setSubscriptionStatus(app, keyFor("NETFLIX.COM"), "keep");
  const rec2 = read(app)[0];
  check("flipping status clears the evidence date", rec2.faded_out_after, null);
  check("and the confirmation date", rec2.faded_out_at, null);
  check("status changed", rec2.status, "keep");
  check("cadence override survives", rec2.cadence_override, "monthly");

  // Cadence changes must NOT clear it — they are independent facts.
  await H.confirmSubscriptionGone(app, keyFor("NETFLIX.COM"), "2026-06-14");
  await H.setSubscriptionCadence(app, keyFor("NETFLIX.COM"), "yearly");
  const rec3 = read(app)[0];
  check("a cadence change leaves the confirmation alone", rec3.faded_out_after, "2026-06-14");
  check("and applies", rec3.cadence_override, "yearly");
}

// ===========================================================================
console.log("\n12. The rendered tab");
{
  function makeView(app) {
    const v = Object.create(HF.BudgetDashboardView.prototype);
    Object.assign(v, {
      sectionOpen: {}, scrollMemory: {}, activeTab: "subscriptions", app,
      collapsible(parent, id, title, meta) {
        const w = parent.createDiv({ cls: "budget-collapsible" });
        w.createSpan({ text: `${title} ${meta}` });
        return w.createDiv({ cls: "budget-collapsible-body" });
      },
      render() {},
      plugin: { settings: {}, refreshAfterDataChange: async () => {} }
    });
    return v;
  }
  function fakeApp(reviews) {
    const store = { [REVIEWS_PATH]: JSON.stringify(reviews) };
    return {
      _store: store,
      vault: { adapter: {
        exists: async (p) => p in store, read: async (p) => store[p],
        write: async (p, d) => { store[p] = d; }, mkdir: async () => {}, list: async () => ({ files: [], folders: [] })
      } }
    };
  }
  const text = (n) => [n._text || ""].concat((n.children || []).map(text)).join(" ");
  function find(n, pred, out = []) {
    if (pred(n)) out.push(n);
    (n.children || []).forEach((k) => find(k, pred, out));
    return out;
  }
  const buttons = (n) => find(n, (x) => x.tag === "button").map((b) => b._text);

  async function renderTab(txs, reviews, accounts) {
    const app = fakeApp(reviews);
    const v = makeView(app);
    const c = el("div");
    await v.renderSubscriptions(c, { allTx: txs, rules: [], accounts });
    return { root: c, app, view: v };
  }

  // Eligible → the CTA is there.
  const ok = await renderTab(NETFLIX, CANCEL, [acct("chase", "2026-09-20")]);
  check("the confirm button appears when eligible", buttons(ok.root).includes("Confirm it's gone"), true);
  check("and the row says why", text(ok.root).includes("never arrived"), true);
  check("the row is marked confirmable", find(ok.root, (x) => x.classes && x.classes.has("budget-sub-confirmable")).length, 1);

  // Both of these were caught by screenshotting, not by reading the code.
  // A fourth button in the cluster made THIS row's buttons wider than every
  // other row's, which dragged its amount column 120px out of line with the
  // rest of the list. The CTA belongs to its explanation instead.
  const btnCols = find(ok.root, (x) => x.classes && x.classes.has("budget-sub-btn-col"));
  check("every row's button cluster holds the same three controls",
    [...new Set(btnCols.map((c) => c.children.filter((k) => k.tag === "button").length))], [3]);
  const readyNote = find(ok.root, (x) => x.classes && x.classes.has("budget-sub-ready"))[0];
  check("the CTA lives in the explanation", !!readyNote && readyNote.children.some((k) => k.tag === "button"), true);
  // .budget-sub-meta is declared twice, the later copy below the ready rule, so
  // a single-class selector loses the font-size reset on source order and the
  // button renders at 0.76 x 0.82 of the row instead of matching its siblings.
  const CSS = fs.readFileSync(P.STYLES, "utf8");
  check("the ready rule wins on specificity, not order",
    /\.budget-sub-meta\.budget-sub-ready\s*\{[^}]*font-size:\s*1em/.test(CSS), true);

  // Stale → no CTA, and the row says which account to import.
  const stale = await renderTab(NETFLIX, CANCEL, [acct("chase", "2026-07-01")]);
  check("no confirm button when the account is behind", buttons(stale.root).includes("Confirm it's gone"), false);
  check("it names the account to import", text(stale.root).includes("CHASE (through 2026-07-01)"), true);
  check("and the date to get past", text(stale.root).includes("past 2026-07-14"), true);

  // Merely flagged → no CTA, and it says when to come back.
  const early = await renderTab(
    [tx("2026-09-14", "NETFLIX.COM", -15.49), tx("2026-08-14", "NETFLIX.COM", -15.49)],
    CANCEL, [acct("chase", "2026-09-20")]
  );
  check("flagging alone does not produce the button", buttons(early.root).includes("Confirm it's gone"), false);
  check("the row says when the next charge is due", text(early.root).includes("Next charge expected 2026-10-14"), true);

  // Kept → nothing about phase-out at all.
  const kept = await renderTab(NETFLIX, [{ merchant_key: keyFor("NETFLIX.COM"), status: "keep" }], [acct("chase", "2026-09-20")]);
  check("a kept row shows no phase-out copy", /expected|confirm|gone/i.test(text(kept.root)), false);

  // Clicking through writes the record and the row disappears on re-render.
  const click = find(ok.root, (x) => x.tag === "button" && x._text === "Confirm it's gone")[0];
  await click.onclick();
  const stored = JSON.parse(ok.app._store[REVIEWS_PATH])[0];
  check("the click stores the evidence date", stored.faded_out_after, "2026-06-14");

  const after = await renderTab(NETFLIX, [stored], [acct("chase", "2026-09-20")]);
  check("and the row is gone from the list", find(after.root, (x) => x.classes && x.classes.has("budget-sub-row")).length, 0);
  check("with one line saying so", text(after.root).includes("confirmed gone"), true);
  check("and no buttons to press on it", buttons(after.root).length, 0);

  // Resurfaced → back, badged, and re-triaged.
  const resumed = NETFLIX.concat([tx("2026-09-14", "NETFLIX.COM", -15.49)]);
  const back = await renderTab(resumed, [stored], [acct("chase", "2026-09-20")]);
  check("a new charge brings the row back", find(back.root, (x) => x.classes && x.classes.has("budget-sub-row")).length, 1);
  check("badged as charged again", text(back.root).includes("charged again"), true);
  check("explaining itself", text(back.root).includes("Worth a second look"), true);
  check("no longer struck through as cancelled", find(back.root, (x) => x.classes && x.classes.has("budget-sub-cancel")).length, 0);
  check("and no confirm button on it", buttons(back.root).includes("Confirm it's gone"), false);

  // Totals must exclude retired groups — you already got that money back.
  const mixed = NETFLIX.concat([tx("2026-09-05", "HULU 877-8244858", -17.99)]);
  const withGone = await renderTab(mixed, [stored], [acct("chase", "2026-09-20")]);
  check("the header counts only what is left", text(withGone.root).includes("across 1 active"), true);
  check("the flagged-to-cancel savings line is gone with it", text(withGone.root).includes("flagged to cancel"), false);
}

// ===========================================================================
console.log("\n13. Scope — nothing reserved, nothing recategorised");
{
  const SRC = fs.readFileSync(P.MAIN, "utf8");
  const start = SRC.indexOf("function subscriptionPhaseOut(");
  const body = SRC.slice(start, SRC.indexOf("\nfunction buildSubscriptionAudit(", start));
  check("phase-out never touches the ownership index", /buildOwnershipIndex|completeOwnership/.test(body), false);
  check("nor the allocator", /runAllocation/.test(body), false);
  check("and writes nothing", /writeJSON/.test(body), false);

  // The transactions are never altered — only whether the group renders.
  const auditSrc = SRC.slice(SRC.indexOf("function buildSubscriptionAudit("), SRC.indexOf("function describeCadence("));
  check("the audit still writes nothing", /writeJSON/.test(auditSrc), false);
  check("and mutates no transaction", /\bt\.[a-z_]+\s*=[^=]/.test(auditSrc), false);

  // One persistence path, as specified.
  const writes = (SRC.match(/FILES\.subscriptionReviews/g) || []).length;
  const viaPatch = SRC.includes("async function patchSubscriptionReview");
  check("patchSubscriptionReview exists", viaPatch, true);
  check("faded_out_at is only ever written through it",
    /writeJSON\(app, FILES\.subscriptionReviews/.test(SRC) &&
    (SRC.match(/writeJSON\([^,]+, FILES\.subscriptionReviews/g) || []).length, 1);
  check("and the file is read in a handful of places, not written in them", writes > 1, true);

  // Plain language — no implementation vocabulary in anything the user reads.
  const renderStart = SRC.indexOf("async renderSubscriptions(");
  const renderBody = SRC.slice(renderStart, SRC.indexOf("\n  renderGoneSubscriptions(", renderStart));
  const strings = (renderBody.match(/text: [`"][^`"]*[`"]/g) || []).join(" ");
  check("no leaked jargon in user-facing copy",
    /faded_out|phaseOut|phasedOut|resolver|ownership|derived|cadenceKey|blockedBy/.test(strings), false);
}

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
})();
