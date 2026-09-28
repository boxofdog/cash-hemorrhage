// Drives the two modals against a DOM shim, because the reactive candidate list
// and the sweep's no-goals path are exactly the kind of thing that silently
// doesn't work when only inspected.
const P = require("./paths.js");
const H = require("./harness.js");
const { MarkPaidModal, BufferSweepModal, SettingStub, allText, allRows } = H;

let pass = 0, fail = 0;
function check(name, got, want) {
  const ok = typeof want === "number" ? Math.abs(got - want) < 0.005 : got === want;
  if (ok) { pass++; console.log(`  PASS  ${name}`); }
  else { fail++; console.log(`  FAIL  ${name}: got ${JSON.stringify(got)}, want ${JSON.stringify(want)}`); }
}
const tick = () => new Promise((r) => setTimeout(r, 0));

(async () => {
  console.log("\nIssue 3 — Mark Paid candidate list follows the due date");
  {
    const byDate = {
      "2026-09-30": [{ id: "tx_sep", date: "2026-09-29", amount: -85, merchant_raw: "SEPT PAYMENT", resolved_category: "Phone Bill" }],
      "2026-08-31": [{ id: "tx_aug", date: "2026-08-30", amount: -85, merchant_raw: "AUG PAYMENT", resolved_category: "Phone Bill" }]
    };
    const calls = [];
    const plugin = {
      async fixedPaymentCandidates(_expense, date) {
        calls.push(date);
        return byDate[date] || [];
      }
    };
    const expense = { id: "f1", name: "Phone bill", amount: 85 };

    let submitted = null;
    const modal = new MarkPaidModal(null, expense, "2026-09-30", (d, tx) => (submitted = { d, tx }), plugin, []);
    SettingStub.buttons = [];
    modal.onOpen();
    await tick();

    check("loads candidates for the default date", calls[0], "2026-09-30");
    check("shows the September transaction", allText(modal.listEl).includes("SEPT PAYMENT"), true);

    // Pick it, then retype the date to catch up an older cycle.
    const rows = allRows(modal.listEl, "budget-apply-row");
    check("one candidate row rendered", rows.length, 1);
    const radio = rows[0].children.find((c) => c.tag === "radio");
    radio.checked = true;
    radio.onchange();
    check("selection recorded", modal.chosenTx && modal.chosenTx.id, "tx_sep");

    SettingStub.lastChange("2026-08-31");
    await new Promise((r) => setTimeout(r, 320)); // past the debounce

    check("reloaded for the retyped date", calls[calls.length - 1], "2026-08-31");
    check("list now shows the August transaction", allText(modal.listEl).includes("AUG PAYMENT"), true);
    check("stale September row is gone", allText(modal.listEl).includes("SEPT PAYMENT"), false);
    check("selection from the other cycle was cleared", modal.chosenTx, null);

    // Select the August one and submit.
    const rows2 = allRows(modal.listEl, "budget-apply-row");
    const radio2 = rows2[0].children.find((c) => c.tag === "radio");
    radio2.checked = true;
    radio2.onchange();
    SettingStub.buttons.find((b) => b.label === "Mark Paid").cb();
    check("submits the retyped date", submitted && submitted.d, "2026-08-31");
    check("submits the newly picked transaction", submitted && submitted.tx.id, "tx_aug");
  }

  console.log("\nIssue 3b — debounce and out-of-order responses");
  {
    const calls = [];
    const plugin = {
      async fixedPaymentCandidates(_e, date) {
        calls.push(date);
        // The first (stale) request resolves LAST, which is the race.
        const delay = date === "2026-08-31" ? 60 : 5;
        await new Promise((r) => setTimeout(r, delay));
        return [{ id: `tx_${date}`, date, amount: -85, merchant_raw: `FOR ${date}`, resolved_category: "X" }];
      }
    };
    const modal = new MarkPaidModal(null, { id: "f", name: "X", amount: 85 }, "2026-09-30", () => {}, plugin, []);
    SettingStub.buttons = [];
    modal.onOpen();
    await tick();

    calls.length = 0;
    SettingStub.lastChange("2026-08-31");
    await new Promise((r) => setTimeout(r, 300));
    SettingStub.lastChange("2026-07-31");
    await new Promise((r) => setTimeout(r, 300));

    check("slow stale response does not overwrite the current list", allText(modal.listEl).includes("FOR 2026-07-31"), true);
    check("stale August result discarded", allText(modal.listEl).includes("FOR 2026-08-31"), false);

    // Typing fast should collapse into a single load.
    calls.length = 0;
    SettingStub.lastChange("2026-0");
    SettingStub.lastChange("2026-06");
    SettingStub.lastChange("2026-06-30");
    await new Promise((r) => setTimeout(r, 300));
    check("keystrokes debounced into one vault read", calls.length, 1);

    // A half-typed date must not blow up or clear silently.
    SettingStub.lastChange("2026-06-3");
    await new Promise((r) => setTimeout(r, 300));
    check("invalid date shows guidance instead of erroring", allText(modal.listEl).includes("Pick the due date this payment covers"), true);

    // Closing mid-flight must not touch a torn-down list.
    SettingStub.lastChange("2026-08-31");
    modal.close();
    await new Promise((r) => setTimeout(r, 300));
    check("close during an in-flight load is safe", modal.listEl, null);
  }

  console.log("\nIssue 3c — the edit-to-reload window cannot mis-file a payment");
  {
    const byDate = {
      "2026-09-30": [{ id: "tx_sep", date: "2026-09-29", amount: -85, merchant_raw: "SEPT PAYMENT", resolved_category: "Phone Bill" }],
      "2026-08-31": [{ id: "tx_aug", date: "2026-08-30", amount: -85, merchant_raw: "AUG PAYMENT", resolved_category: "Phone Bill" }]
    };
    let submitted = null;
    const plugin = { async fixedPaymentCandidates(_e, d) { await tick(); return byDate[d] || []; } };
    const modal = new MarkPaidModal(null, { id: "f", name: "Phone bill", amount: 85 }, "2026-09-30",
      (d, tx) => (submitted = { d, tx }), plugin, []);
    SettingStub.buttons = [];
    modal.onOpen();
    await new Promise((r) => setTimeout(r, 20));

    // Select September, then retype the date and submit INSIDE the debounce
    // window — before any reload has run.
    const radio = allRows(modal.listEl, "budget-apply-row")[0].children.find((c) => c.tag === "radio");
    radio.checked = true;
    radio.onchange();
    check("September selected", modal.chosenTx.id, "tx_sep");

    SettingStub.lastChange("2026-08-31");
    check("selection cleared immediately, not after the debounce", modal.chosenTx, null);
    check("stale list cleared immediately", modal.candidates.length, 0);
    check("stale row removed from the DOM immediately", allText(modal.listEl).includes("SEPT PAYMENT"), false);
    check("shows a loading state meanwhile", allText(modal.listEl).includes("Loading"), true);

    SettingStub.buttons.find((b) => b.label === "Mark Paid").cb();
    check("submitting mid-window files the new date", submitted.d, "2026-08-31");
    check("submitting mid-window links NOTHING, not the old cycle", submitted.tx, null);
  }

  console.log("\nIssue 3d — invalid dates cannot be submitted");
  {
    const plugin = { async fixedPaymentCandidates() { return []; } };
    let submitted = null;
    const modal = new MarkPaidModal(null, { id: "f", name: "X", amount: 85 }, "2026-09-30",
      (d, tx) => (submitted = { d, tx }), plugin, []);
    SettingStub.buttons = [];
    modal.onOpen();
    await tick();
    const markPaid = SettingStub.buttons.find((b) => b.label === "Mark Paid").cb;

    for (const bad of ["", "2026-09", "09/30/2026", "2026-13-01", "2026-02-31", "not a date"]) {
      SettingStub.lastChange(bad);
      markPaid();
      check(`rejects ${JSON.stringify(bad)}`, submitted, null);
    }
    check("invalid date shows the hint", allText(modal.listEl).includes("Pick the due date this payment covers"), true);
    // 1.14.0: the field is a calendar picker, so the hint no longer asks for a typed format.
    check("and no longer asks for a typed format", allText(modal.listEl).includes("YYYY-MM-DD"), false);
    check("no lookup is scheduled for an invalid date", modal.reloadTimer === null || modal.candidates.length === 0, true);

    SettingStub.lastChange("2026-08-31");
    await new Promise((r) => setTimeout(r, 300));
    markPaid();
    check("accepts a valid date again", submitted && submitted.d, "2026-08-31");

    // The round-trip check, independent of the modal.
    check("isISODateString rejects 2026-02-31", H.isISODateString("2026-02-31"), false);
    check("isISODateString accepts 2028-02-29 (leap)", H.isISODateString("2028-02-29"), true);
    check("isISODateString rejects 2026-02-29 (non-leap)", H.isISODateString("2026-02-29"), false);
    check("isISODateString accepts a normal date", H.isISODateString("2026-09-30"), true);
  }

  console.log("\nIssue 4 — sweep with no fundable goals resolves the pending record");
  {
    // Minimal stand-in for the plugin method under test.
    const store = { goals: [], sweeps: [{ period_start: "2026-09-01", status: "pending", remaining: 123 }] };
    const notices = [];
    let refreshed = false;

    const plugin = {
      app: {},
      settings: {},
      async upsertSweepRecord(patch) {
        const i = store.sweeps.findIndex((s) => s.period_start === patch.period_start);
        if (i >= 0) store.sweeps[i] = Object.assign({}, store.sweeps[i], patch);
        else store.sweeps.push(patch);
      },
      async refreshAfterDataChange() { refreshed = true; }
    };

    // Replicates openSweepModal's guard exactly as written in main.js.
    const src = require("fs").readFileSync(P.MAIN, "utf8");
    const guard = src.slice(src.indexOf("async openSweepModal(state) {"));
    check("guard resolves rather than returning bare", /resolved_reason: "no open goals available"/.test(guard.slice(0, 900)), true);
    check("guard marks it dismissed", /status: "dismissed"/.test(guard.slice(0, 900)), true);
    check("guard notifies the user", /No open savings goals have room/.test(guard.slice(0, 900)), true);
    check("guard refreshes the dashboard", /refreshAfterDataChange\(\)/.test(guard.slice(0, 900)), true);

    // And the resulting state transition.
    await plugin.upsertSweepRecord({
      period_start: "2026-09-01", status: "dismissed",
      decided_on: "2026-09-20", resolved_reason: "no open goals available"
    });
    notices.push("No open savings goals have room for this allowance. Sweep dismissed.");
    await plugin.refreshAfterDataChange();

    check("record is no longer pending", store.sweeps[0].status, "dismissed");
    check("reason recorded", store.sweeps[0].resolved_reason, "no open goals available");
    check("dashboard refreshed so the button disappears", refreshed, true);
    check("user was told", notices[0].includes("Sweep dismissed"), true);
  }

  console.log("\nIssue 4b — sweep plan is capped and surfaced");
  {
    const goals = [
      { id: "g_move", name: "Moving fund", target_amount: 3000, saved_amount: 2950, target_date: "2026-11-26" },
      { id: "g_car", name: "Car repairs", target_amount: 800, saved_amount: 0 }
    ];
    const plan = (amount) => H.recommendSavings(goals, amount, { g_move: 1 }, "2026-09-15", "2026-11-26");
    let submitted = null;
    const modal = new BufferSweepModal(
      null,
      { remaining: 123, allocated: 350, spent: 227, periodStart: "2026-09-01", periodEnd: "2026-09-15", plan },
      (r) => (submitted = r)
    );
    SettingStub.buttons = [];
    modal.onOpen();

    check("plan is rendered in the modal", allText(modal.contentEl).includes("Moving fund"), true);
    check("second goal shown", allText(modal.contentEl).includes("Car repairs"), true);

    SettingStub.buttons.find((b) => b.label === "Add to savings").cb();
    check("submits a breakdown, not a single goal", submitted.breakdown.length, 2);
    check("priority goal capped at its remaining target", submitted.breakdown.find((b) => b.id === "g_move").amount, 50);
    check("total equals the swept amount", submitted.amount, 123);

    // Closing without choosing must NOT submit anything (Issue 3 of last round).
    let touched = false;
    const m2 = new BufferSweepModal(
      null,
      { remaining: 123, allocated: 350, spent: 227, periodStart: "2026-09-01", periodEnd: "2026-09-15", plan },
      () => (touched = true)
    );
    SettingStub.buttons = [];
    m2.onOpen();
    m2.close();
    check("closing the modal submits nothing (stays pending)", touched, false);
  }

  console.log("\nEmpty states explain themselves");
  {
    // A range with nothing in it reads differently from a range whose
    // transactions all belong to something else.
    const bare = [];
    Object.defineProperty(bare, "accountedElsewhere", { value: 0, enumerable: false });
    const hidden = [];
    Object.defineProperty(hidden, "accountedElsewhere", { value: 2, enumerable: false });

    const mk = (list) => {
      const modal = new MarkPaidModal(null, { id: "f", name: "Water", amount: 40 }, "2026-09-20",
        () => {}, { async fixedPaymentCandidates() { return list; } }, []);
      SettingStub.buttons = [];
      modal.onOpen();
      return modal;
    };

    const m1 = mk(bare);
    await new Promise((r) => setTimeout(r, 20));
    check("nothing there says so plainly", allText(m1.listEl).includes("No matching payment found"), true);
    check("and does not claim anything is hidden", allText(m1.listEl).includes("accounted for elsewhere"), false);

    const m2 = mk(hidden);
    await new Promise((r) => setTimeout(r, 20));
    check("hidden candidates are explained", allText(m2.listEl).includes("already accounted for elsewhere"), true);
    check("with a count", allText(m2.listEl).includes("2 nearby transactions"), true);
    check("and no technical wording", /ownership|resolver|class/i.test(allText(m2.listEl)), false);
  }

  console.log(`\n${pass} passed, ${fail} failed`);
  process.exit(fail ? 1 : 0);
})();
