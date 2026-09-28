// 1.15.0 — the Transactions tab as an inbox.
//
// The shim half checks structure and state. The evaporation test goes through
// the real path end to end: the panel's Label button, the real LabelModal, the
// real handleLabelSubmit writing the vault, and the re-render that follows. The
// browser half measures the real CSS: that the panel slides to its content's
// height, that it pushes the card below rather than covering it, and that a
// closed panel is out of the tab order.
const P = require("./paths.js");
global.document = { body: { classList: { contains: () => false } } };
global.requestAnimationFrame = (fn) => setTimeout(fn, 0);
const fs = require("fs");
const H = require("./harness.js");
const HF = require("./harness-for.js")(P.MAIN);
const { el, SettingStub } = H;

let pass = 0, fail = 0;
function check(name, got, want) {
  const ok = JSON.stringify(got) === JSON.stringify(want);
  if (ok) { pass++; console.log(`  PASS  ${name}`); }
  else { fail++; console.log(`  FAIL  ${name}: got ${JSON.stringify(got)}, want ${JSON.stringify(want)}`); }
}
const text = (n) => [n._text || ""].concat((n.children || []).map(text)).join(" ");
function find(n, pred, out = []) {
  if (pred(n)) out.push(n);
  (n.children || []).forEach((k) => find(k, pred, out));
  return out;
}
const byClass = (n, c) => find(n, (x) => x.classes && x.classes.has(c));
const kids = (n) => (n.children || []);

let seq = 0;
const tx = (date, merchant, amount, cat = "Uncategorized") =>
  ({ id: `tx-${++seq}`, date, merchant_raw: merchant, amount, account_id: "chk", resolved_category: cat });

const RULES = [{ merchant_pattern: "SHELL", home_label: "Gas" }, { merchant_pattern: "SAFEWAY", home_label: "Groceries" }];
const LABELLED = [
  tx("2026-09-20", "SHELL OIL 123", -41.2, "Gas"), tx("2026-09-19", "SAFEWAY #2231", -88.14, "Groceries"),
  tx("2026-09-18", "SHELL OIL 456", -38.9, "Gas")
];

function makeView(state = {}) {
  const v = Object.create(HF.BudgetDashboardView.prototype);
  Object.assign(v, {
    sectionOpen: {}, scrollMemory: {}, activeTab: "transactions", app: {},
    plugin: { settings: {}, refreshAfterDataChange: async () => {}, refreshDashboard() {} }
  }, state);
  return v;
}
function ctxFor(allTx, rules = RULES) {
  return { allTx, rules, existingLabels: [...new Set(rules.map((r) => r.home_label))].sort() };
}
async function renderTab(v, allTx, rules = RULES) {
  const c = el("div");
  await v.renderTransactions(c, ctxFor(allTx, rules));
  return c;
}

(async () => {

// ===========================================================================
console.log("\n1. Nothing to label, nothing drawn");
{
  const v = makeView();
  const c = await renderTab(v, LABELLED);
  check("no inbox", byClass(c, "budget-inbox").length, 0);
  check("no 'all clear' card either", /all clear|everything's categorized|need label/i.test(text(c)), false);
  check("the old two-column grid is gone", byClass(c, "budget-grid").length, 0);
  check("recent transactions is the only thing on the tab", kids(c).map((k) => [...k.classes].join(" ")), ["budget-card budget-recent-card"]);
  check("and it lists them", byClass(c, "budget-recent-row").length, 3);
}

console.log("\n2. Something to label: the notification");
{
  const v = makeView();
  const c = await renderTab(v, LABELLED.concat([tx("2026-09-21", "RIGOBERTOS TACO 44", -12.5), tx("2026-09-17", "ZELLE FROM J DOE", 60)]));
  const inbox = byClass(c, "budget-inbox");
  check("one inbox", inbox.length, 1);
  check("directly under the tabs — first thing in the tab body", kids(c)[0] === inbox[0], true);
  check("recent transactions follows it", [...kids(c)[1].classes].includes("budget-recent-card"), true);
  const badge = byClass(c, "budget-inbox-badge")[0];
  check("the badge is a real button", [badge.tag, badge.attrs.type], ["button", "button"]);
  check("with the count", byClass(badge, "budget-inbox-text")[0]._text, "2 transactions need labels");
  check("a red dot with an exclamation point", byClass(badge, "budget-inbox-dot")[0]._text, "!");
  check("which screen readers skip (the text says it)", byClass(badge, "budget-inbox-dot")[0].attrs["aria-hidden"], "true");
  check("closed to start", [inbox[0].classes.has("budget-inbox-open"), badge.attrs["aria-expanded"]], [false, "false"]);
  const panel = byClass(c, "budget-inbox-panel")[0];
  check("the badge names the panel it controls", badge.attrs["aria-controls"], panel.attrs.id);
  check("the panel is a labelled region", [panel.attrs.role, panel.attrs["aria-label"]], ["region", "Transactions that need labels"]);
  check("the action reads Review while closed", byClass(badge, "budget-inbox-action")[0]._text, "Review");

  const rows = byClass(panel, "budget-inbox-row");
  check("the panel holds only the unlabelled ones", rows.length, 2);
  check("newest first", rows.map((r) => byClass(r, "budget-recent-name")[0]._text), ["RIGOBERTOS TACO 44", "ZELLE FROM J DOE"].map((m) => H.displayMerchant(m, RULES)));
  check("each with a Label button", rows.map((r) => byClass(r, "budget-inbox-label-btn")[0]._text), ["Label", "Label"]);
  check("income shows as income", byClass(rows[1], "budget-positive").map((x) => x._text), ["+$60.00"]);

  const one = await renderTab(makeView(), LABELLED.concat([tx("2026-09-21", "X", -1)]));
  check("singular", byClass(one, "budget-inbox-text")[0]._text, "1 transaction needs a label");
}

console.log("\n3. Opening and closing");
{
  const v = makeView();
  const c = await renderTab(v, LABELLED.concat([tx("2026-09-21", "A", -1), tx("2026-09-20", "B", -2)]));
  const inbox = byClass(c, "budget-inbox")[0];
  const badge = byClass(c, "budget-inbox-badge")[0];
  badge.dispatchEvent({ type: "click" });
  check("a click opens it", [inbox.classes.has("budget-inbox-open"), badge.attrs["aria-expanded"]], [true, "true"]);
  check("the action reads Hide", byClass(badge, "budget-inbox-action")[0]._text, "Hide");
  check("the view remembers", v.inboxOpen, true);
  badge.dispatchEvent({ type: "click" });
  check("a second click closes it", [inbox.classes.has("budget-inbox-open"), v.inboxOpen], [false, false]);
  check("opening doesn't re-render the tab (so nothing flickers or loses scroll)", kids(c).length, 2);
}

console.log("\n4. Open survives the re-render that follows each label");
{
  const v = makeView({ inboxOpen: true });
  const c = await renderTab(v, LABELLED.concat([tx("2026-09-21", "A", -1), tx("2026-09-20", "B", -2)]));
  check("drawn already open", byClass(c, "budget-inbox")[0].classes.has("budget-inbox-open"), true);
  check("and says so", byClass(c, "budget-inbox-badge")[0].attrs["aria-expanded"], "true");
  // The id is stable across renders so aria-controls keeps pointing at it.
  const c2 = await renderTab(v, LABELLED.concat([tx("2026-09-21", "A", -1)]));
  check("the panel keeps one id across renders", byClass(c, "budget-inbox-panel")[0].attrs.id, byClass(c2, "budget-inbox-panel")[0].attrs.id);
  const other = makeView();
  const c3 = await renderTab(other, [tx("2026-09-21", "A", -1)]);
  check("a second dashboard pane gets its own id", byClass(c3, "budget-inbox-panel")[0].attrs.id !== byClass(c, "budget-inbox-panel")[0].attrs.id, true);
}

console.log("\n5. A long queue");
{
  const many = Array.from({ length: 27 }, (_, i) => tx(`2026-08-${String(1 + i).padStart(2, "0")}`, `MERCHANT ${i}`, -(i + 1)));
  const c = await renderTab(makeView(), many);
  check("twenty at a time", byClass(c, "budget-inbox-row").length, 20);
  check("and says how many are behind them", byClass(c, "budget-inbox-more")[0]._text, "7 more after these — they move up as you label.");
  check("the badge counts all of them", byClass(c, "budget-inbox-text")[0]._text, "27 transactions need labels");
  const exact = await renderTab(makeView(), many.slice(0, 20));
  check("no 'more' line when they all fit", byClass(exact, "budget-inbox-more").length, 0);
  const undated = await renderTab(makeView(), [Object.assign(tx("", "POS HOLD SHELL", -20), { date: "" })]);
  check("an undated bank hold reads as pending", byClass(undated, "budget-recent-date")[0]._text, "pending");
}

console.log("\n6. The evaporation — end to end through the real label path");
{
  const F = H.FILES;
  const store = {
    [F.transactions]: JSON.stringify(LABELLED.concat([tx("2026-09-21", "RIGOBERTOS TACO 44", -12.5)])),
    [F.rules]: JSON.stringify(RULES)
  };
  const app = { vault: { adapter: {
    exists: async (p) => p in store, read: async (p) => store[p],
    write: async (p, d) => { store[p] = d; }, mkdir: async () => {}, list: async () => ({ files: [], folders: [] })
  } } };
  const v = makeView({ app });
  const container = el("div");
  let renders = 0;
  // The real render re-reads the vault and redraws; this does the same for the tab.
  v.render = async () => {
    renders++;
    const txs = JSON.parse(store[F.transactions]);
    const rules = JSON.parse(store[F.rules]);
    H.applyCategorization(txs, rules);
    container.empty();
    await v.renderTransactions(container, ctxFor(txs, rules));
  };
  await v.render();

  check("one left to label", byClass(container, "budget-inbox-text")[0]._text, "1 transaction needs a label");
  byClass(container, "budget-inbox-badge")[0].dispatchEvent({ type: "click" });
  check("panel open", v.inboxOpen, true);

  // Press the row's Label button and fill in the real modal.
  let modal = null;
  const realOpen = HF.LabelModal.prototype.open;
  // The view comes from the second harness instance, so its modals register
  // their fields with that instance's SettingStub.
  HF.LabelModal.prototype.open = function () { modal = this; HF.SettingStub.texts = []; HF.SettingStub.dropdowns = []; return realOpen.call(this); };
  byClass(container, "budget-inbox-label-btn")[0].onclick();
  HF.LabelModal.prototype.open = realOpen;
  check("the Label button opens the categorize dialog", !!modal, true);
  // A new category: the last choice in the list, which opens a field for it.
  const catList = HF.SettingStub.dropdowns.find((d) => d.settingName === "Category");
  if (catList) catList.choose("__new");
  const typedField = HF.SettingStub.texts.find((t) => t.settingName === "New category" || t.settingName === "Category");
  typedField.inputEl.value = "Eating Out";
  typedField.inputEl.dispatchEvent({ type: "input" });
  const once = find(modal.contentEl, (x) => x.tag === "button" && x._text === "Just this one")[0];
  once.onclick();
  await new Promise((r) => setTimeout(r, 20));

  const saved = JSON.parse(store[F.transactions]).find((t) => t.merchant_raw === "RIGOBERTOS TACO 44");
  check("the label was written to the vault", saved.override_label, "Eating Out");
  check("and the view re-rendered", renders, 2);
  check("the badge is gone", byClass(container, "budget-inbox-badge").length, 0);
  check("the panel is gone", byClass(container, "budget-inbox-panel").length, 0);
  check("leaving just the recent list", kids(container).map((k) => [...k.classes].join(" ")), ["budget-card budget-recent-card"]);
  check("which shows the new label", text(container).includes("Eating Out"), true);
  check("and the open state is cleared for next time", v.inboxOpen, false);

  // A later import brings new ones in: they arrive as a closed notification.
  const txs = JSON.parse(store[F.transactions]).concat([tx("2026-09-22", "NEW MERCHANT", -9)]);
  store[F.transactions] = JSON.stringify(txs);
  await v.render();
  check("new ones after an import arrive closed", [byClass(container, "budget-inbox").length, byClass(container, "budget-inbox")[0].classes.has("budget-inbox-open")], [1, false]);
}

// ===========================================================================
console.log("\n7. In a real browser: the slide, the push, the tab order");
if (P.noBrowser()) console.log("  SKIP  no Playwright/Chromium here");
else {
  const { chromium } = require("playwright");
  const css = fs.readFileSync(P.STYLES, "utf8");
  const PREVIEW = fs.readFileSync(P.PREVIEWS + "/preview.js", "utf8");
  const THEME = PREVIEW.slice(PREVIEW.indexOf("const THEME = `") + 15, PREVIEW.indexOf("`;\n\nfunction makeView"));
  const VOID = new Set(["input", "br", "hr", "img"]);
  const esc = (s) => String(s).replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
  const html = (n) => {
    const cls = [...(n.classes || [])].join(" ");
    const attrs = Object.entries(n.attrs || {}).map(([k, v]) => ` ${k}="${esc(v)}"`).join("");
    const open = `<${n.tag}${cls ? ` class="${esc(cls)}"` : ""}${attrs}${n.tag === "details" && n.open ? " open" : ""}>`;
    if (VOID.has(n.tag)) return open;
    return open + esc(n._text || "") + (n.children || []).map(html).join("") + `</${n.tag}>`;
  };
  const v = makeView();
  v.collapsible = function (parent, id, title, meta) {
    const d = parent.createEl("details", { cls: "budget-collapsible" });
    d.open = true;
    const s = d.createEl("summary", { cls: "budget-collapsible-summary" });
    s.createSpan({ text: title, cls: "budget-collapsible-title" });
    s.createSpan({ text: meta, cls: "budget-collapsible-sub" });
    return d.createDiv({ cls: "budget-collapsible-body" });
  };
  const queue = [tx("2026-09-21", "RIGOBERTOS TACO SHOP 44", -12.5), tx("2026-09-20", "ZELLE FROM J DOE", 60),
    tx("2026-09-19", "AMZN MKTP US*2K3", -23.99), tx("2026-09-18", "SQ *BLUE BOTTLE", -6.25)];
  const root = el("div");
  root.classes.add("budget-dashboard");
  await v.renderTransactions(root, ctxFor(LABELLED.concat(queue)));
  // The plugin creates the tab's elements and sets their open/closed state in
  // one synchronous task, so the browser never styles them in between. The page
  // does the same: markup inserted and state applied in a single script run.
  const page0 = `<!doctype html><html><head><meta charset="utf-8"><style>${THEME}\n${css}</style></head>
    <body class="theme-dark"><div id="host" class="budget-tab-body" style="width:760px"></div>
    <script>
      HTMLElement.prototype.setAttr = function (k, v) { this.setAttribute(k, v); };
      HTMLElement.prototype.toggleClass = function (c, on) { this.classList.toggle(c, !!on); };
      HTMLElement.prototype.setText = function (t) { this.textContent = t; };
      ${H.bindInboxToggle.toString()}
      window.draw = (open) => {
        const host = document.getElementById("host");
        host.innerHTML = ${JSON.stringify(html(root))};
        const inbox = host.querySelector(".budget-inbox");
        window.toggle = bindInboxToggle({ inbox, badge: inbox.querySelector(".budget-inbox-badge"), action: inbox.querySelector(".budget-inbox-action") }, { open });
      };
      draw(false);
    </script></body></html>`;

  const browser = await chromium.launch();
  const measure = (page) => page.evaluate(() => {
    const panel = document.querySelector(".budget-inbox-panel");
    const list = document.querySelector(".budget-inbox-list");
    const recent = document.querySelector(".budget-recent-card");
    return {
      panelH: Math.round(panel.getBoundingClientRect().height),
      listH: Math.round(list.getBoundingClientRect().height),
      recentTop: Math.round(recent.getBoundingClientRect().top),
      visibility: getComputedStyle(document.querySelector(".budget-inbox-panel-inner")).visibility,
      position: getComputedStyle(panel).position
    };
  });

  const page = await browser.newPage({ viewport: { width: 800, height: 900 } });
  await page.setContent(page0);
  const closed = await measure(page);
  check("closed: the panel takes no space", closed.panelH, 0);
  check("closed: its contents are hidden, not just clipped", closed.visibility, "hidden");
  // Tab from the badge: focus must go past the hidden Label buttons.
  await page.focus(".budget-inbox-badge");
  await page.keyboard.press("Tab");
  check("closed: Tab skips the hidden Label buttons", await page.evaluate(() => document.activeElement.classList.contains("budget-inbox-label-btn")), false);

  await page.click(".budget-inbox-badge");
  await page.waitForTimeout(90);
  const mid = await measure(page);
  check("mid-slide: partway open, not jumped", mid.panelH > 0 && mid.panelH < mid.listH, true);
  await page.waitForTimeout(450);
  const open = await measure(page);
  check("open: grows to exactly its content", open.panelH, open.listH);
  check("open: in the page flow, not floating", open.position, "static");
  check("open: pushes Recent down by exactly its height", open.recentTop - closed.recentTop, open.panelH);
  check("open: visible", open.visibility, "visible");
  await page.focus(".budget-inbox-badge");
  await page.keyboard.press("Tab");
  check("open: Tab goes into the first Label button", await page.evaluate(() => document.activeElement.classList.contains("budget-inbox-label-btn")), true);
  check("open: aria-expanded follows", await page.getAttribute(".budget-inbox-badge", "aria-expanded"), "true");

  await page.click(".budget-inbox-badge");
  await page.waitForTimeout(90);
  const closing = await measure(page);
  check("closing: stays visible while it slides shut", [closing.visibility, closing.panelH > 0], ["visible", true]);
  await page.waitForTimeout(450);
  const shut = await measure(page);
  check("closed again: no space, hidden", [shut.panelH, shut.visibility], [0, "hidden"]);
  check("closed again: Recent back where it was", shut.recentTop, closed.recentTop);

  // Drawn already open — the re-render after each label — paints open at once.
  await page.evaluate(() => draw(true));
  const immediate = await measure(page);
  check("drawn open: full height on first paint, no replayed slide", immediate.panelH, immediate.listH);
  // Control: the measurement can see a replayed slide when there is one. Styling
  // the closed state first and opening in a later task does animate.
  await page.evaluate(() => { draw(false); document.body.offsetHeight; });
  await page.evaluate(() => window.toggle && document.querySelector(".budget-inbox-badge").click());
  const replay = await measure(page);
  check("control: opening after a paint does slide (so the check above is real)", replay.panelH < replay.listH, true);

  // Reduced motion: no slide at all.
  const rm = await browser.newPage({ viewport: { width: 800, height: 900 }, reducedMotion: "reduce" });
  await rm.setContent(page0);
  await rm.click(".budget-inbox-badge");
  await rm.waitForTimeout(20);
  const rmm = await measure(rm);
  check("reduced motion: opens instantly", rmm.panelH, rmm.listH);

  // Phone width: nothing overflows, amounts stay on screen.
  const phone = await browser.newPage({ viewport: { width: 390, height: 900 } });
  await phone.setContent(page0.replace('style="width:760px"', 'style="width:100%"'));
  await phone.click(".budget-inbox-badge");
  await phone.waitForTimeout(450);
  const ph = await phone.evaluate(() => ({
    overflow: document.documentElement.scrollWidth > window.innerWidth,
    badgeH: Math.round(document.querySelector(".budget-inbox-badge").getBoundingClientRect().height),
    amountsOnScreen: [...document.querySelectorAll(".budget-inbox-row .budget-tx-amount")].every((a) => a.getBoundingClientRect().right <= window.innerWidth)
  }));
  check("phone: no horizontal overflow", ph.overflow, false);
  check("phone: the badge is a comfortable tap target", ph.badgeH >= 44, true);
  check("phone: amounts stay on screen", ph.amountsOnScreen, true);

  await browser.close();
}

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
})().catch((e) => { console.error(e); process.exit(1); });
