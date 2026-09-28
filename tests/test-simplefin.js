// SimpleFIN bank sync (1.16.0), against a mocked Bridge.
//
// global.__requestUrl plays the network: every request the plugin makes lands
// there, so a test can see exactly what was sent — the URL, the header, the
// method — and answer however the case needs.
const P = require("./paths.js");
global.document = { body: { classList: { contains: () => false } } };
const H = require("./harness.js");
const { el, allText, SettingStub } = H;

let pass = 0, fail = 0;
function check(name, got, want) {
  const ok = JSON.stringify(got) === JSON.stringify(want);
  if (ok) { pass++; console.log(`  PASS  ${name}`); }
  else { fail++; console.log(`  FAIL  ${name}: got ${JSON.stringify(got)}, want ${JSON.stringify(want)}`); }
}
const tick = (ms = 5) => new Promise((r) => setTimeout(r, ms));
// A button's visible text: the sync button keeps its in a label span.
const labelOf = (b) => { const l = (b.children || []).find((c) => c.classes && c.classes.has("budget-sync-label")); return l ? l._text : b._text; };

const T = H.todayLocal();
const D = (n) => H.addDays(T, n);
const at = (dateStr, hour = 12) => Math.floor(new Date(`${dateStr}T${String(hour).padStart(2, "0")}:00:00`).getTime() / 1000);

const ACCESS = "https://demo:s3cr3t-pass@beta-bridge.simplefin.org/simplefin";
const AUTH = `Basic ${Buffer.from("demo:s3cr3t-pass").toString("base64")}`;
const DEMO_TOKEN = "aHR0cHM6Ly9iZXRhLWJyaWRnZS5zaW1wbGVmaW4ub3JnL3NpbXBsZWZpbi9jbGFpbS9ERU1PLXYyLUQwMUE2MEFDQzhEMkEwQkZCNEM5";
const CLAIM_URL = "https://beta-bridge.simplefin.org/simplefin/claim/DEMO-v2-D01A60ACC8D2A0BFB4C9";

// ---------------------------------------------------------------------------
// A vault, a device keychain and a plugin instance.
function makeApp(files = {}, { secret = true, local = true } = {}) {
  const store = {};
  Object.entries(files).forEach(([k, v]) => (store[k] = JSON.stringify(v)));
  const secrets = {};
  const localStore = {};
  const app = {
    _store: store, _secrets: secrets, _local: localStore,
    vault: {
      adapter: {
        exists: async (p) => p in store,
        read: async (p) => store[p],
        write: async (p, d) => { store[p] = d; },
        mkdir: async () => {},
        list: async () => ({ files: [], folders: [] })
      },
      getFiles: () => [],
      read: async () => ""
    }
  };
  if (secret) app.secretStorage = { getSecret: (id) => secrets[id] ?? null, setSecret: (id, v) => { secrets[id] = v; } };
  if (local) {
    app.loadLocalStorage = (k) => localStore[k] ?? null;
    app.saveLocalStorage = (k, v) => { if (v == null) delete localStore[k]; else localStore[k] = v; };
  }
  return app;
}
const readFile = (app, p) => (p in app._store ? JSON.parse(app._store[p]) : undefined);

function makePlugin(app) {
  const p = Object.create(H.__PluginClass.prototype);
  Object.assign(p, {
    app,
    manifest: { id: "budget-tracker" },
    settings: {},
    syncing: false,
    lastPaycheckInputs: { checkingBalance: 1000, alreadyDeposited: false, autoRolled: true },
    _refreshes: 0,
    _afterChange: 0,
    _openedSettings: [],
    refreshDashboard() { this._refreshes++; },
    async refreshAfterDataChange() { this._afterChange++; },
    openSettings(opts) { this._openedSettings.push(opts || {}); this.settingsFocus = opts && opts.focus; }
  });
  return p;
}

// Captures what the plugin shows instead of opening anything.
let resultModals = [];
H.ImportResultModal.prototype.open = function () { resultModals.push(this.summary); };

// ---------------------------------------------------------------------------
// The Bridge. `routes` answers by method; every request is recorded.
let sent = [];
function bridge(answer) {
  sent = [];
  global.__requestUrl = async (req) => {
    sent.push(req);
    return answer(req);
  };
}
const ok = (json) => ({ status: 200, json, text: JSON.stringify(json) });

// ---------------------------------------------------------------------------
// The fixture: a checking account and a card, both linked, and a savings
// account SimpleFIN knows about that isn't.
const F = H.FILES;
function fixture() {
  return {
    [F.accounts]: [
      { id: "checking", type: "checking", institution: "Credit Union", current_balance: 1000, simplefin_id: "ACT-chk", last_imported_through: D(-10) },
      { id: "chase", type: "credit_card", institution: "Chase", current_balance: 500, simplefin_id: "ACT-card", last_imported_through: D(-3) },
      { id: "savings", type: "savings", institution: "Credit Union Savings", current_balance: 200 }
    ],
    [F.revolvingDebts]: [
      { id: "d-chase", account_id: "chase", provider: "Chase", balance_anchor: { amount: 500, date: D(-20) }, payment_category: "Credit Card Payment", applied_payments: [] }
    ],
    [F.transactions]: [
      // Imported from CSV before linking: the same purchase SimpleFIN sends as s1.
      { id: "tx-csv-sbux", date: D(-8), merchant_raw: "POS PURCHASE STARBUCKS #1234", amount: -5.25, account_id: "checking", resolved_category: "Eating Out", override_label: "Coffee w/ Sam" },
      // A bank hold from the last CSV, which posts as bb.
      { id: "tx-hold-bb", date: D(-2), merchant_raw: "POS Hold, ZIP* BEST BUY", amount: -67.5, account_id: "checking", pending: true, resolved_category: null, override_label: null },
      // Older than the window: nothing in the batch can be it.
      { id: "tx-old-netflix", date: D(-30), merchant_raw: "NETFLIX.COM", amount: -15.49, account_id: "checking", resolved_category: "Subscriptions", override_label: null },
      // Brought in by an earlier sync.
      { id: "tx-sf-shell", date: D(-6), merchant_raw: "SHELL OIL 5744", amount: -40, account_id: "checking", resolved_category: "Gas", override_label: null, simplefin_account: "ACT-chk", simplefin_id: "t-old", simplefin_posted: D(-6) }
    ],
    [F.rules]: [{ merchant_pattern: "MTA", home_label: "Transit", display_name: "Subway" }, { merchant_pattern: "NETFLIX", home_label: "Subscriptions" }]
  };
}

function payload({ version = 2, extraErrors = [] } = {}) {
  const chk = {
    id: "ACT-chk", name: "Checking", conn_id: "C1", currency: "USD", balance: "1234.56", "available-balance": "1200.00",
    "balance-date": at(T, 9),
    transactions: [
      { id: "t-old", posted: at(D(-6)), amount: "-40.00", description: "SHELL OIL 5744" },
      { id: "s1", posted: at(D(-7)), transacted_at: at(D(-8), 8), amount: "-5.25", description: "Starbucks" },
      { id: "fare1", posted: at(D(-2)), amount: "-2.75", description: "MTA*NYCT PAYGO" },
      { id: "fare2", posted: at(D(-2)), amount: "-2.75", description: "MTA*NYCT PAYGO" },
      { id: "bb", posted: at(D(-1)), amount: "-67.50", description: "ZIP* BEST BUY 183-37823729 NY" },
      { id: "pend", posted: at(D(0)), amount: "-9.99", description: "SPOTIFY", pending: true },
      { id: "pend0", posted: 0, amount: "-3.00", description: "VENDING" },
      { id: "pay", posted: at(D(-1)), amount: "1748.95", description: "ACME FOODS PAYROLL" },
      { id: "zero", posted: at(D(-1)), amount: "0.00", description: "CARD VERIFICATION" }
    ]
  };
  const card = {
    id: "ACT-card", name: "Freedom Unlimited", conn_id: "C2", currency: "USD", balance: "-590.46",
    "balance-date": at(D(-1), 23),
    transactions: [{ id: "c1", posted: at(D(-1)), amount: "-23.10", description: "AMAZON MKTPL*2K4" }]
  };
  const sav = { id: "ACT-sav", name: "Savings", conn_id: "C1", currency: "USD", balance: "5000", "balance-date": at(T, 9), transactions: [] };
  if (version === 1) {
    [chk, card, sav].forEach((a) => { a.org = { name: a.conn_id === "C1" ? "Credit Union" : "Chase", domain: "x.com" }; delete a.conn_id; });
    return { errors: extraErrors, accounts: [chk, card, sav] };
  }
  return {
    errlist: extraErrors,
    connections: [{ conn_id: "C1", name: "Credit Union", org_id: "o1" }, { conn_id: "C2", name: "Chase", org_id: "o2" }],
    accounts: [chk, card, sav]
  };
}

(async () => {
// ===========================================================================
console.log("\n1. Access URLs and redaction");
{
  const p = H.parseSimpleFINAccessUrl(ACCESS);
  check("credentials leave the URL", p.base, "https://beta-bridge.simplefin.org/simplefin");
  check("and travel as a Basic header", p.authHeader, AUTH);
  check("a trailing slash is dropped", H.parseSimpleFINAccessUrl(ACCESS + "/").base, p.base);
  check("percent-encoded credentials are decoded first",
    H.parseSimpleFINAccessUrl("https://a%40b:p%3Aw@h.org/s").authHeader, `Basic ${Buffer.from("a@b:p:w").toString("base64")}`);
  check("plain http is refused", H.parseSimpleFINAccessUrl("http://u:p@h.org/s"), null);
  check("no credentials is refused", H.parseSimpleFINAccessUrl("https://h.org/s"), null);
  check("junk is refused", H.parseSimpleFINAccessUrl("not a url"), null);
  check("a setup token isn't an access URL", H.parseSimpleFINAccessUrl(DEMO_TOKEN), null);

  check("URL credentials are redacted", H.redactSimpleFIN(`GET ${ACCESS}/accounts failed`),
    "GET https://[redacted]@beta-bridge.simplefin.org/simplefin/accounts failed");
  check("a Basic header is redacted", H.redactSimpleFIN(`Authorization: ${AUTH}`), "Authorization: Basic [redacted]");
  check("nothing else is touched", H.redactSimpleFIN("https://example.com/path"), "https://example.com/path");
  check("null-safe", H.redactSimpleFIN(null), "");
}

// ===========================================================================
console.log("\n2. Claiming a setup token");
{
  bridge((req) => ({ status: 200, text: ACCESS + "\n" }));
  const access = await H.claimSimpleFINToken(DEMO_TOKEN);
  check("returns the access URL", access, ACCESS);
  check("one request", sent.length, 1);
  check("a POST", sent[0].method, "POST");
  check("to the decoded claim URL", sent[0].url, CLAIM_URL);
  check("errors are handled here, not thrown by requestUrl", sent[0].throw, false);

  bridge(() => ({ status: 200, text: "" }));
  const passthru = await H.claimSimpleFINToken("  " + ACCESS + " ");
  check("an access URL is taken as-is", passthru, ACCESS);
  check("without spending a request", sent.length, 0);

  const kind = async (fn) => { try { await fn(); return "no error"; } catch (e) { return `${e.kind}: ${e.message}`; } };
  bridge(() => ({ status: 403, text: "Forbidden" }));
  check("a used token says so", await kind(() => H.claimSimpleFINToken(DEMO_TOKEN)),
    "claimed: That setup token has already been used, or has expired. Create a new one in SimpleFIN Bridge.");
  bridge(() => ({ status: 500, text: "" }));
  check("a server error", await kind(() => H.claimSimpleFINToken(DEMO_TOKEN)), "http: SimpleFIN couldn’t connect (HTTP 500).");
  bridge(() => ({ status: 200, text: "<html>maintenance</html>" }));
  check("an answer that isn't an access URL", await kind(() => H.claimSimpleFINToken(DEMO_TOKEN)),
    "payload: SimpleFIN answered, but not with a connection this plugin can use.");
  bridge(() => { throw new Error("ECONNRESET"); });
  check("offline", await kind(() => H.claimSimpleFINToken(DEMO_TOKEN)), "network: Couldn’t reach SimpleFIN — check your connection and try again.");
  check("blank", await kind(() => H.claimSimpleFINToken("   ")), "input: Paste a SimpleFIN setup token first.");
  check("not base64", await kind(() => H.claimSimpleFINToken("not a token!!")), "input: That doesn’t look like a SimpleFIN setup token.");
  check("base64 of something that isn't https",
    await kind(() => H.claimSimpleFINToken(Buffer.from("http://evil.example/claim").toString("base64"))),
    "input: That doesn’t look like a SimpleFIN setup token.");
}

// ===========================================================================
console.log("\n3. fetchSimpleFINData");
{
  bridge(() => ok(payload()));
  const data = await H.fetchSimpleFINData(ACCESS, { startDate: D(-15) });
  const url = new URL(sent[0].url);
  check("a GET", sent[0].method, "GET");
  check("to /accounts", url.origin + url.pathname, "https://beta-bridge.simplefin.org/simplefin/accounts");
  check("with no credentials in the URL", url.username + url.password, "");
  check("and none anywhere in it", sent[0].url.includes("s3cr3t"), false);
  check("they're in the header", sent[0].headers.Authorization, AUTH);
  check("asks for protocol v2", url.searchParams.get("version"), "2");
  check("from local midnight of the start date", url.searchParams.get("start-date"), String(H.simplefinEpoch(D(-15))));
  const localMid = new Date(`${D(-15)}T00:00:00`).getTime() / 1000;
  const utcMid = Date.parse(`${D(-15)}T00:00:00Z`) / 1000;
  check("start-date is the earlier of local and UTC midnight", H.simplefinEpoch(D(-15)), Math.min(localMid, utcMid));
  check("so the window stays inside the Bridge's recommended 45 days, at any hour", (Date.now() / 1000 - H.simplefinEpoch(D(-H.SIMPLEFIN_MAX_DAYS))) / 86400 < 45, true);
  check("a midnight-UTC timestamp is that calendar day, in any timezone",
    H.simplefinDate(Date.parse("2026-09-18T00:00:00Z") / 1000), "2026-09-18");
  check("any other timestamp is the local day", H.simplefinDate(at("2026-09-18", 12)), "2026-09-18");
  check("a missing timestamp is no date", [H.simplefinDate(0), H.simplefinDate(null), H.simplefinDate("x")], [null, null, null]);

  // A request that never answers is given up on.
  let kindT = null;
  try { await H.fetchSimpleFINData(ACCESS, { request: () => new Promise(() => {}), timeoutMs: 20 }); } catch (e) { kindT = e.kind; }
  check("a hung request times out", kindT, "timeout");
  kindT = null;
  try { await H.claimSimpleFINToken(DEMO_TOKEN, { request: () => new Promise(() => {}), timeoutMs: 20 }); } catch (e) { kindT = e.kind; }
  check("so does a hung claim", kindT, "timeout");
  check("pending isn't asked for", url.searchParams.has("pending"), false);
  check("transactions are", url.searchParams.has("balances-only"), false);
  check("errors are handled here", sent[0].throw, false);
  check("three accounts", data.accounts.map((a) => a.id), ["ACT-chk", "ACT-card", "ACT-sav"]);

  bridge(() => ok(payload()));
  await H.fetchSimpleFINData(ACCESS, { balancesOnly: true });
  const u2 = new URL(sent[0].url);
  check("balances-only when asked", u2.searchParams.get("balances-only"), "1");
  check("no start date when none given", u2.searchParams.has("start-date"), false);

  bridge(() => ({ status: 200, text: JSON.stringify(payload()) }));
  check("falls back to parsing the text", (await H.fetchSimpleFINData(ACCESS)).accounts.length, 3);

  const kind = async (fn) => { try { await fn(); return "no error"; } catch (e) { return e.kind; } };
  bridge(() => ({ status: 403 })); check("403 is auth", await kind(() => H.fetchSimpleFINData(ACCESS)), "auth");
  bridge(() => ({ status: 402 })); check("402 is payment", await kind(() => H.fetchSimpleFINData(ACCESS)), "payment");
  bridge(() => ({ status: 502 })); check("502 is http", await kind(() => H.fetchSimpleFINData(ACCESS)), "http");
  bridge(() => { throw new Error("offline"); }); check("a throw is network", await kind(() => H.fetchSimpleFINData(ACCESS)), "network");
  bridge(() => ({ status: 200, text: "<html>" })); check("non-JSON is payload", await kind(() => H.fetchSimpleFINData(ACCESS)), "payload");
  bridge(() => ok({ hello: 1 })); check("JSON without accounts is payload", await kind(() => H.fetchSimpleFINData(ACCESS)), "payload");
  bridge(() => ok(payload()));
  check("an unreadable saved URL is auth, and sends nothing", [await kind(() => H.fetchSimpleFINData("https://nocreds.org/x")), sent.length], ["auth", 0]);
}

// ===========================================================================
console.log("\n4. Both protocol versions normalise to one shape");
{
  const v2 = H.normalizeSimpleFINPayload(Object.assign(payload(), {
    errlist: [{ code: "con.auth", msg: " Chase needs you to sign in again. ", conn_id: "C2" }, { code: "act.x", msg: "Stale", account_id: "ACT-chk" }]
  }));
  check("v2 institution comes from connections", v2.accounts.map((a) => a.org), ["Credit Union", "Chase", "Credit Union"]);
  check("and each account keeps its connection", v2.accounts.map((a) => a.connId), ["C1", "C2", "C1"]);
  check("balances are numbers", v2.accounts.map((a) => a.balance), [1234.56, -590.46, 5000]);
  check("balance dates are local dates", v2.accounts.map((a) => a.balanceDate), [T, D(-1), T]);
  check("errlist entries keep what they're about", v2.errors,
    [{ message: "Chase needs you to sign in again.", accountId: null, connId: "C2", code: "con.auth" },
     { message: "Stale", accountId: "ACT-chk", connId: null, code: "act.x" }]);
  check("nothing ambiguous", v2.ambiguous, []);

  const v1 = H.normalizeSimpleFINPayload(payload({ version: 1, extraErrors: ["Connection to Chase may need attention"] }));
  check("v1 institution comes from org", v1.accounts.map((a) => a.org), ["Credit Union", "Chase", "Credit Union"]);
  check("v1 string errors", v1.errors, [{ message: "Connection to Chase may need attention", accountId: null, connId: null, code: null }]);

  const odd = H.normalizeSimpleFINPayload({ accounts: [
    { id: 7, name: "", currency: "usd", balance: "", transactions: null },
    { id: "X", conn_id: "A", balance: "1" }, { id: "X", conn_id: "B", balance: "2" }, null, { name: "no id" }
  ] });
  check("numeric ids become strings", odd.accounts[0].id, "7");
  check("a missing name falls back to the id", odd.accounts[0].name, "7");
  check("currency is upper-cased", odd.accounts[0].currency, "USD");
  check("a blank balance is unknown, not zero", odd.accounts[0].balance, null);
  check("missing transactions are an empty list", odd.accounts[0].transactions, []);
  check("rows without an id are dropped", odd.accounts.length, 3);
  check("an id used by two connections is flagged", odd.ambiguous, ["X"]);
}

// ===========================================================================
console.log("\n5. Transactions in the plugin's own shape");
{
  const [chk] = H.normalizeSimpleFINPayload(payload()).accounts;
  const r = H.simplefinToLocalTransactions(chk, { id: "checking", invert_positive_charges: true });
  const byId = Object.fromEntries(r.transactions.map((t) => [t.simplefin_id, t]));
  check("posted rows only", Object.keys(byId).sort(), ["bb", "fare1", "fare2", "pay", "s1", "t-old"]);
  check("a flagged pending row is skipped", r.pending, 2);
  check("so is one with posted: 0 and no flag", "pend0" in byId, false);
  check("zero-amount rows are skipped", r.zero, 1);
  check("the purchase date wins over the posting date", byId.s1.date, D(-8));
  check("the posting date otherwise", byId.bb.date, D(-1));
  check("amounts are numbers", byId.pay.amount, 1748.95);
  check("SimpleFIN's sign is kept even with the CSV invert flag on", byId.fare1.amount, -2.75);
  check("the plugin's schema, plus where it came from", Object.keys(byId.bb).sort(),
    ["account_id", "amount", "date", "id", "merchant_raw", "override_label", "resolved_category", "simplefin_account", "simplefin_id", "simplefin_posted"]);
  check("the posting date is kept alongside the purchase date", [byId.s1.date, byId.s1.simplefin_posted], [D(-8), D(-7)]);
  check("equal when only the posting date was sent", [byId.bb.date, byId.bb.simplefin_posted], [D(-1), D(-1)]);

  const bad = H.simplefinToLocalTransactions({ id: "A", transactions: [
    { posted: at(D(-1)), amount: "-1.00", description: "no id" },
    { id: "x1", posted: at(D(-1)), amount: "abc", description: "bad amount" },
    { id: "x2", posted: at(D(-1)), amount: "", description: "blank amount" },
    { id: "x3", posted: at(D(-1)), amount: "-1,250.00", description: "comma" },
    "junk"
  ] }, { id: "checking" });
  check("unreadable rows are counted, not silently dropped", bad.invalid, 3);
  check("a thousands comma is read", bad.transactions.map((t) => t.amount), [-1250]);
  check("assigned to the local account", byId.bb.account_id, "checking");
  check("uncategorised until rules run", [byId.bb.resolved_category, byId.bb.override_label], [null, null]);
  check("stamped with both SimpleFIN ids", [byId.bb.simplefin_account, byId.bb.simplefin_id], ["ACT-chk", "bb"]);
  check("every row gets its own local id", new Set(r.transactions.map((t) => t.id)).size, r.transactions.length);

  check("card balance takes the size of the figure (negative)", H.simplefinLocalBalance({ type: "credit_card" }, { balance: -590.456 }), 590.46);
  check("card balance takes the size of the figure (positive)", H.simplefinLocalBalance({ type: "credit_card" }, { balance: 590.46 }), 590.46);
  check("an overdrawn checking account stays negative", H.simplefinLocalBalance({ type: "checking" }, { balance: -12.5 }), -12.5);
  check("an unknown balance isn't written", H.simplefinLocalBalance({ type: "checking" }, { balance: null }), null);
  check("dropdown label", H.simplefinAccountLabel({ id: "A", org: "Chase", name: "Freedom", balance: -1590.4 }), "Chase — Freedom · $1,590.40");
}

// ===========================================================================
console.log("\n6. Where each sync starts");
{
  check("an account imported three days ago: five days before that",
    H.simplefinStartDate([{ last_imported_through: D(-3) }], T), D(-8));
  check("the least recently imported account decides",
    H.simplefinStartDate([{ last_imported_through: D(-3) }, { last_imported_through: D(-10) }], T), D(-15));
  check("never imported: as far back as allowed", H.simplefinStartDate([{}], T), D(-43));
  check("never further back than 43 days", H.simplefinStartDate([{ last_imported_through: D(-200) }], T), D(-43));
  check("which is inside the Bridge's recommended 45", H.SIMPLEFIN_MAX_DAYS < 45, true);
}

// ===========================================================================
console.log("\n7. De-duplication");
{
  const tx = (o) => Object.assign({ id: H.round2(Math.random() * 1e9) + "", account_id: "checking", resolved_category: null, override_label: null, simplefin_account: "ACT-chk" }, o);

  // Strict: an id already in the ledger is never added again.
  const ledger = [tx({ id: "a", date: D(-3), merchant_raw: "SHELL", amount: -40, simplefin_id: "1" })];
  let r = H.mergeSimpleFINTransactions(ledger, [tx({ date: D(-3), merchant_raw: "SHELL", amount: -40, simplefin_id: "1" })]);
  check("a known id is skipped", [r.added, r.duplicates, r.merged.length], [0, 1, 1]);
  r = H.mergeSimpleFINTransactions(ledger, [tx({ date: D(-3), merchant_raw: "SHELL OIL (edited by bank)", amount: -41, simplefin_id: "1" })]);
  check("even if the bank has since changed its details", [r.added, r.duplicates], [0, 1]);
  check("and the stored row isn't touched", r.merged[0].amount, -40);

  // Ids are only unique within an account.
  r = H.mergeSimpleFINTransactions(ledger, [tx({ date: D(-3), merchant_raw: "SHELL", amount: -40, simplefin_id: "1", simplefin_account: "ACT-card", account_id: "chase" })]);
  check("the same id from another SimpleFIN account is a different transaction", r.added, 1);

  // The batch itself can repeat an id.
  r = H.mergeSimpleFINTransactions([], [tx({ date: D(-1), merchant_raw: "X", amount: -1, simplefin_id: "9" }), tx({ date: D(-1), merchant_raw: "X", amount: -1, simplefin_id: "9" })]);
  check("a repeated id in one batch counts once", [r.added, r.duplicates], [1, 1]);

  // Identical fields, different ids: two real charges.
  r = H.mergeSimpleFINTransactions([], [
    tx({ date: D(-2), merchant_raw: "MTA*NYCT PAYGO", amount: -2.75, simplefin_id: "f1" }),
    tx({ date: D(-2), merchant_raw: "MTA*NYCT PAYGO", amount: -2.75, simplefin_id: "f2" })
  ]);
  check("two identical fares on one day are both kept", [r.added, r.duplicates], [2, 0]);
  r = H.mergeSimpleFINTransactions(r.merged, [tx({ date: D(-2), merchant_raw: "MTA*NYCT PAYGO", amount: -2.75, simplefin_id: "f3" })]);
  check("and a third from a later sync too", r.added, 1);
  r = H.reconcileImport([], [
    { id: "x", date: D(-2), merchant_raw: "MTA", amount: -2.75, account_id: "checking" },
    { id: "y", date: D(-2), merchant_raw: "MTA", amount: -2.75, account_id: "checking" }
  ]);
  check("the CSV importer still treats identical rows as one (no ids to go on)", [r.added, r.skipped], [1, 1]);
}

// ===========================================================================
console.log("\n8. Rows already imported from CSV are claimed, not added again");
{
  const csv = (o) => Object.assign({ account_id: "checking", resolved_category: "Eating Out", override_label: null }, o);
  const sf = (o) => Object.assign({ id: "new-" + o.simplefin_id, account_id: "checking", resolved_category: null, override_label: null, simplefin_account: "ACT-chk" }, o);

  let r = H.mergeSimpleFINTransactions(
    [csv({ id: "c1", date: D(-8), merchant_raw: "POS PURCHASE STARBUCKS #1234", amount: -5.25, override_label: "Coffee w/ Sam" })],
    [sf({ date: D(-7), merchant_raw: "Starbucks", amount: -5.25, simplefin_id: "s1" })], D(-15));
  check("claimed", [r.claimed, r.added, r.merged.length], [1, 0, 1]);
  check("the CSV row keeps its id, date, text and labels",
    [r.merged[0].id, r.merged[0].date, r.merged[0].merchant_raw, r.merged[0].resolved_category, r.merged[0].override_label],
    ["c1", D(-8), "POS PURCHASE STARBUCKS #1234", "Eating Out", "Coffee w/ Sam"]);
  check("and gains the SimpleFIN ids", [r.merged[0].simplefin_account, r.merged[0].simplefin_id], ["ACT-chk", "s1"]);
  const again = H.mergeSimpleFINTransactions(r.merged, [sf({ date: D(-7), merchant_raw: "Starbucks", amount: -5.25, simplefin_id: "s1" })], D(-15));
  check("so the next sync knows it by id", [again.duplicates, again.claimed, again.added], [1, 0, 0]);

  // Order independence: two same-price coffees on neighbouring days.
  const ledger = [csv({ id: "mon", date: D(-5), merchant_raw: "BLUE BOTTLE", amount: -4.5 }), csv({ id: "tue", date: D(-4), merchant_raw: "BLUE BOTTLE", amount: -4.5 })];
  const inc = [sf({ date: D(-4), merchant_raw: "Blue Bottle Coffee", amount: -4.5, simplefin_id: "b-tue" }), sf({ date: D(-5), merchant_raw: "Blue Bottle Coffee", amount: -4.5, simplefin_id: "b-mon" })];
  r = H.mergeSimpleFINTransactions(ledger, inc, D(-15));
  check("each coffee pairs with its own day", r.merged.map((t) => `${t.id}:${t.simplefin_id}`), ["mon:b-mon", "tue:b-tue"]);
  r = H.mergeSimpleFINTransactions(ledger, inc.slice().reverse(), D(-15));
  check("whichever order the feed lists them", r.merged.map((t) => `${t.id}:${t.simplefin_id}`), ["mon:b-mon", "tue:b-tue"]);

  // A shared merchant word beats a closer date.
  const pairs = H.matchSimpleFINToLedger(
    [csv({ id: "gas", date: D(-3), merchant_raw: "CHEVRON 0091", amount: -20 }), csv({ id: "lunch", date: D(-2), merchant_raw: "CHIPOTLE 1123", amount: -20 })],
    [sf({ date: D(-3), merchant_raw: "Chipotle Mexican Grill", amount: -20, simplefin_id: "ch" })], D(-15));
  check("a shared merchant word beats a closer date", [...pairs.values()], [1]);
  const loose = H.matchSimpleFINToLedger(
    [csv({ id: "x", date: D(-3), merchant_raw: "SQ *FARMERS MKT", amount: -12 })],
    [sf({ date: D(-2), merchant_raw: "Square Inc", amount: -12, simplefin_id: "sq" })], D(-15));
  check("descriptions needn't share a word at all", [...loose.values()], [0]);

  const none = (ledgerRow, incRow, ws = D(-15)) => H.matchSimpleFINToLedger([csv(ledgerRow)], [sf(incRow)], ws).size;
  check("not across accounts", none({ date: D(-3), merchant_raw: "A", amount: -9 }, { date: D(-3), merchant_raw: "A", amount: -9, account_id: "chase", simplefin_id: "q" }), 0);
  check("not a cent apart", none({ date: D(-3), merchant_raw: "A", amount: -9 }, { date: D(-3), merchant_raw: "A", amount: -9.01, simplefin_id: "q" }), 0);

  // Dates. A CSV carries the purchase date or the posting date, depending on
  // the bank; SimpleFIN sends the posting date and usually the purchase date.
  const both = (bought, posted) => ({ date: bought, simplefin_posted: posted, merchant_raw: "A", amount: -9, simplefin_id: "q" });
  check("purchase date known: within three days of it pairs", none({ date: D(-6), merchant_raw: "A", amount: -9 }, both(D(-4), D(-3))), 1);
  check("purchase date known: four days from both dates doesn't", none({ date: D(-9), merchant_raw: "A", amount: -9 }, both(D(-5), D(-4))), 0);
  check("a slow-posting charge (hotel) pairs with a CSV dated by purchase", none({ date: D(-12), merchant_raw: "A", amount: -9 }, both(D(-12), D(-2))), 1);
  check("and with one dated by posting", none({ date: D(-2), merchant_raw: "A", amount: -9 }, both(D(-12), D(-2))), 1);
  const postedOnly = (posted) => ({ date: posted, simplefin_posted: posted, merchant_raw: "A", amount: -9, simplefin_id: "q" });
  check("only the posting date sent: a purchase a week before it pairs", none({ date: D(-9), merchant_raw: "A", amount: -9 }, postedOnly(D(-2))), 1);
  check("but not eight days before", none({ date: D(-10), merchant_raw: "A", amount: -9 }, postedOnly(D(-2))), 0);
  check("three days after pairs", none({ date: D(-2), merchant_raw: "A", amount: -9 }, postedOnly(D(-5))), 1);
  check("four days after doesn't", none({ date: D(-1), merchant_raw: "A", amount: -9 }, postedOnly(D(-5))), 0);
  check("rows stored without a posting date read their date as it", H.csvToSyncedGap(D(-4), { date: D(-2) }), 2);
  check("not a pending hold (that settles instead)", none({ date: D(-3), merchant_raw: "A", amount: -9, pending: true }, { date: D(-3), merchant_raw: "A", amount: -9, simplefin_id: "q" }), 0);
  check("not a row this SimpleFIN account already sent",
    none({ date: D(-3), merchant_raw: "A", amount: -9, simplefin_account: "ACT-chk", simplefin_id: "other" }, { date: D(-3), merchant_raw: "A", amount: -9, simplefin_id: "q" }), 0);
  check("but yes to one from before a relink",
    none({ date: D(-3), merchant_raw: "A", amount: -9, simplefin_account: "ACT-OLD", simplefin_id: "old-1" }, { date: D(-3), merchant_raw: "A", amount: -9, simplefin_id: "q" }), 1);

  // The window edge.
  check("a row from before the window can't be claimed by a purchase inside it",
    none({ date: D(-16), merchant_raw: "A", amount: -9 }, both(D(-14), D(-13))), 0);
  check("but can by one also bought before it and posted after",
    none({ date: D(-16), merchant_raw: "A", amount: -9 }, both(D(-16), D(-14))), 1);
  check("or by one whose purchase date wasn't sent, posted just inside",
    none({ date: D(-7), merchant_raw: "UBER TRIP", amount: -9 }, postedOnly(D(-5)), D(-6)), 1);

  // A relinked account: nothing doubles.
  const relinked = [csv({ id: "o1", date: D(-4), merchant_raw: "Target", amount: -30, simplefin_account: "ACT-OLD", simplefin_id: "1" })];
  r = H.mergeSimpleFINTransactions(relinked, [sf({ date: D(-4), merchant_raw: "Target", amount: -30, simplefin_account: "ACT-NEW", simplefin_id: "zz" })], D(-9));
  check("after a relink the old row is re-stamped, not doubled",
    [r.added, r.claimed, r.merged.length, r.merged[0].id, r.merged[0].simplefin_account, r.merged[0].simplefin_id], [0, 1, 1, "o1", "ACT-NEW", "zz"]);
}

// ===========================================================================
console.log("\n9. A hold from an earlier CSV settles into the synced charge");
{
  const hold = { id: "h", date: D(-2), merchant_raw: "POS Hold, ZIP* BEST BUY", amount: -67.5, account_id: "checking", pending: true, override_label: "Gift", resolved_category: null };
  const r = H.mergeSimpleFINTransactions([hold], [{ id: "n", date: D(-1), merchant_raw: "ZIP* BEST BUY 183-37823729 NY", amount: -67.5, account_id: "checking", resolved_category: null, override_label: null, simplefin_account: "ACT-chk", simplefin_id: "bb" }], D(-15));
  const row = r.merged[0];
  check("settled, not added", [r.settled, r.added, r.merged.length], [1, 0, 1]);
  check("keeps its id and override", [row.id, row.override_label], ["h", "Gift"]);
  check("takes the posted details", [row.date, row.merchant_raw, row.pending], [D(-1), "ZIP* BEST BUY 183-37823729 NY", undefined]);
  check("and the SimpleFIN ids", row.simplefin_id, "bb");

  const undated = H.mergeSimpleFINTransactions(
    [{ id: "u", merchant_raw: "POS Hold, ZIP* BEST BUY", amount: -67.5, account_id: "checking", pending: true }],
    [{ id: "n", date: D(-1), merchant_raw: "ZIP* BEST BUY 183", amount: -67.5, account_id: "checking", simplefin_account: "ACT-chk", simplefin_id: "bb" }], D(-15));
  check("an undated hold settles too", [undated.settled, undated.merged[0].id, undated.merged[0].date], [1, "u", D(-1)]);

  const posted = { id: "n", date: D(-1), merchant_raw: "ZIP* BEST BUY 183", amount: -67.5, account_id: "checking", simplefin_account: "ACT-chk", simplefin_id: "bb" };
  const two = H.mergeSimpleFINTransactions(
    [Object.assign({}, hold, { id: "h1", date: D(-4) }), Object.assign({}, hold, { id: "h2", date: D(-2) })], [posted], D(-15));
  check("two holds it could be: the closer one settles", two.merged.map((t) => `${t.id}:${t.pending ? "hold" : "posted"}`), ["h1:hold", "h2:posted"]);
  check("with nothing left for review, so it can't stall every sync", [two.settled, two.unresolved, two.issues.length], [1, 0, 0]);
  const csvTwo = H.reconcileImport([Object.assign({}, hold, { id: "h1" }), Object.assign({}, hold, { id: "h2" })],
    [{ id: "n", date: D(-1), merchant_raw: "ZIP* BEST BUY 183", amount: -67.5, account_id: "checking" }]);
  check("the CSV importer still asks instead of choosing", [csvTwo.settled || csvTwo.updated, csvTwo.unresolved], [0, 1]);

  const renamed = H.mergeSimpleFINTransactions([hold],
    [Object.assign({}, posted, { merchant_raw: "BEST BUY 00012345" })], D(-15));
  check("a hold settles even when the feed rewrites the description", [renamed.settled, renamed.added, renamed.unresolved, renamed.merged[0].id], [1, 0, 0, "h"]);
  const csvRenamed = H.reconcileImport([hold], [{ id: "n", date: D(-1), merchant_raw: "BEST BUY 00012345", amount: -67.5, account_id: "checking" }]);
  check("the CSV importer still holds that one for review", csvRenamed.unresolved, 1);
}

// ===========================================================================
console.log("\n10. A full sync");
{
  const app = makeApp(fixture());
  app.secretStorage.setSecret(H.SIMPLEFIN_SECRET_ID, ACCESS);
  const plugin = makePlugin(app);
  global.__notices = [];
  resultModals = [];
  bridge(() => ok(payload()));
  const before = readFile(app, F.transactions);

  const res = await plugin.syncSimpleFIN();
  const url = new URL(sent[0].url);
  check("one request", sent.length, 1);
  check("from five days before the stalest linked account", url.searchParams.get("start-date"), String(H.simplefinEpoch(D(-15))));
  check("with transactions", url.searchParams.has("balances-only"), false);
  check("totals", [res.added, res.claimed, res.settled, res.duplicates, res.unlinked], [4, 1, 1, 1, 1]);
  check("the notice", global.__notices,
    ["Synced 4 new transactions \u00b7 2 balances updated.\n1 SimpleFIN account isn't linked yet."]);
  check("nothing to review", resultModals.length, 0);

  const after = readFile(app, F.transactions);
  check("exactly the four new rows were appended", after.length, before.length + 4);
  const sfIds = after.map((t) => t.simplefin_id).filter(Boolean).sort();
  check("every synced id appears once", sfIds, ["bb", "c1", "fare1", "fare2", "pay", "s1", "t-old"]);
  const byId = Object.fromEntries(after.map((t) => [t.id, t]));
  check("the CSV Starbucks row was claimed in place",
    [byId["tx-csv-sbux"].simplefin_id, byId["tx-csv-sbux"].override_label, byId["tx-csv-sbux"].merchant_raw, byId["tx-csv-sbux"].date],
    ["s1", "Coffee w/ Sam", "POS PURCHASE STARBUCKS #1234", D(-8)]);
  check("and carries the posting date like every synced row", byId["tx-csv-sbux"].simplefin_posted, D(-7));
  check("every row with a SimpleFIN id has one", after.filter((t) => t.simplefin_id).every((t) => !!t.simplefin_posted), true);
  check("the hold settled in place", [byId["tx-hold-bb"].simplefin_id, "pending" in byId["tx-hold-bb"], byId["tx-hold-bb"].date], ["bb", false, D(-1)]);
  check("the old CSV row is untouched", byId["tx-old-netflix"], fixture()[F.transactions][2]);
  const fares = after.filter((t) => /MTA/.test(t.merchant_raw));
  check("both fares, categorised by the existing rule", fares.map((t) => t.resolved_category), ["Transit", "Transit"]);
  check("the card charge is on the card", after.find((t) => t.simplefin_id === "c1").account_id, "chase");
  check("no pending or zero rows came in", after.some((t) => ["pend", "pend0", "zero"].includes(t.simplefin_id)), false);

  const accts = Object.fromEntries(readFile(app, F.accounts).map((a) => [a.id, a]));
  check("checking takes the live balance", accts.checking.current_balance, 1234.56);
  check("the card takes what's owed", accts.chase.current_balance, 590.46);
  check("the unlinked account is left alone", [accts.savings.current_balance, accts.savings.last_imported_through], [200, undefined]);
  check("both linked accounts are imported through today", [accts.checking.last_imported_through, accts.chase.last_imported_through], [T, T]);
  const debt = readFile(app, F.revolvingDebts)[0];
  check("the card's debt is re-anchored with it, as of the card's own balance date", debt.balance_anchor, { amount: 590.46, date: D(-1) });
  check("so the Debts tab reads the same figure",
    H.cardBalanceState(debt, after).balance, 590.46);
  const later = after.concat([{ id: "new", date: T, merchant_raw: "LUNCH", amount: -80, account_id: "chase" }]);
  check("and a charge after that date still counts on top", H.cardBalanceState(debt, later).balance, 670.46);
  check("the period's cash on hand follows checking", plugin.lastPaycheckInputs.checkingBalance, 1234.56);

  const cache = readFile(app, F.simplefinAccounts);
  check("SimpleFIN's account list is cached for the link dropdown", cache.accounts.map((a) => `${a.org}|${a.name}|${a.balance}`),
    ["Credit Union|Checking|1234.56", "Chase|Freedom Unlimited|-590.46", "Credit Union|Savings|5000"]);
  check("with the last sync", [cache.last_sync.added, cache.last_sync.claimed], [4, 1]);
  check("and the request logged", cache.requests.length, 1);
  check("the cache holds no transactions", JSON.stringify(cache).includes("transactions"), false);
  check("category order was refreshed", F.categoryOrder in app._store, true);
  check("the access URL is nowhere in the vault", Object.values(app._store).some((v) => v.includes("s3cr3t") || v.includes("demo:")), false);
  check("syncing is off again", plugin.syncing, false);
  check("the dashboard re-rendered", plugin._afterChange, 1);

  // The very same sync again: nothing new, nothing doubled.
  global.__notices = [];
  bridge(() => ok(payload()));
  const res2 = await plugin.syncSimpleFIN();
  check("a repeat sync adds nothing", [res2.added, res2.claimed, res2.duplicates], [0, 0, 7]);
  check("the ledger is the same length", readFile(app, F.transactions).length, after.length);
  check("and says so", global.__notices[0] === "Synced \u2014 nothing new.\n1 SimpleFIN account isn't linked yet.", true);
  check("the next window starts from today's marker", new URL(sent[0].url).searchParams.get("start-date"), String(H.simplefinEpoch(D(-5))));
}

// ===========================================================================
console.log("\n11. Problems are reported, and hold back only what they touch");
{
  const run = async (mutate, files = fixture()) => {
    const app = makeApp(files);
    app.secretStorage.setSecret(H.SIMPLEFIN_SECRET_ID, ACCESS);
    const plugin = makePlugin(app);
    global.__notices = [];
    resultModals = [];
    const pl = payload();
    mutate(pl);
    bridge(() => ok(pl));
    const res = await plugin.syncSimpleFIN();
    return { app, plugin, res, accts: Object.fromEntries(readFile(app, F.accounts).map((a) => [a.id, a])) };
  };

  let r = await run((pl) => { pl.accounts[1].currency = "EUR"; });
  check("a non-dollar account is skipped", r.res.issues.some((x) => /Chase: SimpleFIN reports it in EUR/.test(x)), true);
  check("its balance isn't written", r.accts.chase.current_balance, 500);
  check("its marker doesn't move", r.accts.chase.last_imported_through, D(-3));
  check("the other account still syncs", [r.accts.checking.current_balance, r.accts.checking.last_imported_through], [1234.56, T]);
  check("a review window opens", resultModals.map((m) => m.title), ["Sync finished — needs a look"]);
  check("the notice points to it", /1 other issue — see details\./.test(global.__notices[0]), true);

  r = await run((pl) => { pl.accounts.splice(1, 1); });
  check("a linked account SimpleFIN didn't send", r.res.issues.some((x) => /Chase: SimpleFIN didn't include this account/.test(x)), true);
  check("keeps its balance", r.accts.chase.current_balance, 500);

  r = await run((pl) => { pl.accounts.push(Object.assign({}, pl.accounts[1], { conn_id: "C3" })); });
  check("an id two connections share isn't followed", r.res.issues.some((x) => /Chase: two SimpleFIN connections use the same account id/.test(x)), true);
  check("and nothing is imported for it", readFile(r.app, F.transactions).some((t) => t.simplefin_id === "c1"), false);

  r = await run((pl) => { pl.errlist = [{ code: "con.auth", msg: "Chase needs you to sign in again.", conn_id: "C2" }]; });
  check("a lost sign-in is one plain line in the notice", global.__notices[0].split("\n").includes("Chase needs you to sign in again at SimpleFIN Bridge."), true);
  check("…not repeated in the details", r.res.issues.some((x) => /sign in again/.test(x)), false);
  check("what did arrive for that connection still comes in", readFile(r.app, F.transactions).some((t) => t.simplefin_id === "c1"), true);
  check("but its marker holds, so the next sync reaches back", r.accts.chase.last_imported_through, D(-3));
  check("another connection's account isn't held back", r.accts.checking.last_imported_through, T);

  r = await run((pl) => { pl.errlist = [{ code: "act.x", msg: "Checking is stale", account_id: "ACT-chk" }]; });
  check("an account-level error holds only that account", [r.accts.checking.last_imported_through, r.accts.chase.last_imported_through], [D(-10), T]);
  check("any other bank error is passed on as it was said", r.res.issues.includes("From your bank via SimpleFIN: Checking is stale"), true);

  // The Bridge's advice about the request names no account; it used to hold
  // every account back, so the next sync asked for the full window again.
  r = await run((pl) => { pl.errlist = [{ code: "gen.x", msg: "Requested date range exceeds recommended range of 45 days. In the future, this may be capped." }]; });
  check("advice about the request doesn't hold any account back", [r.accts.checking.last_imported_through, r.accts.chase.last_imported_through], [T, T]);
  check("…and isn't shown", [r.res.issues.length, resultModals.length, /recommended range/.test(global.__notices[0])], [0, 0, false]);

  // The case from the field: Credit Union's sign-in lapsed, every Credit Union balance is days old.
  r = await run((pl) => {
    pl.errlist = [{ code: "con.auth", msg: "Connection to Credit Union may need attention. Auth required", conn_id: "C1" }];
    pl.accounts[0]["balance-date"] = at(D(-5), 9);
  });
  check("one line for the bank: sign in again, and how old its balances are",
    global.__notices[0].split("\n")[1], `Credit Union needs you to sign in again at SimpleFIN Bridge. Its balances are from ${H.formatChartDate(D(-5)).replace(`, ${T.slice(0, 4)}`, "")}.`);
  check("…no review window for what the notice already says", resultModals.length, 0);
  r = await run((pl) => { pl.accounts[0]["balance-date"] = at(D(-5), 9); });
  check("behind without an error: says how far", global.__notices[0].split("\n")[1], `Credit Union: SimpleFIN has nothing newer than ${H.formatChartDate(D(-5)).replace(`, ${T.slice(0, 4)}`, "")} yet.`);
  check("a named connection in a v1-style message", H.simplefinConnectionProblems([{ message: "Connection to Big Bank may need attention. Auth required" }], [], T).lines, ["Big Bank needs you to sign in again at SimpleFIN Bridge."]);

  r = await run(() => {}, Object.assign(fixture(), {}));
  const v1 = await (async () => {
    const app = makeApp(fixture());
    app.secretStorage.setSecret(H.SIMPLEFIN_SECRET_ID, ACCESS);
    const plugin = makePlugin(app);
    bridge(() => ok(payload({ version: 1, extraErrors: ["Something is wrong somewhere"] })));
    const res = await plugin.syncSimpleFIN();
    return { res, accts: Object.fromEntries(readFile(app, F.accounts).map((a) => [a.id, a])) };
  })();
  check("a v1 feed syncs the same", v1.res.added, 4);
  check("an error that names nothing holds every marker", [v1.accts.checking.last_imported_through, v1.accts.chase.last_imported_through], [D(-10), D(-3)]);

  // Two holds the posted charge could be: one settles, the other waits.
  const files = fixture();
  files[F.transactions].push(Object.assign({}, files[F.transactions][1], { id: "tx-hold-bb-2" }));
  r = await run(() => {}, files);
  check("two matching holds don't stop the sync", [r.res.issues.length, r.accts.checking.last_imported_through], [0, T]);
  check("one settles, the other stays pending", readFile(r.app, F.transactions).filter((t) => t.pending).map((t) => t.id), ["tx-hold-bb-2"]);

  r = await run((pl) => { pl.accounts[0].transactions.push({ id: "junk", posted: at(D(-1)), amount: "n/a", description: "?" }); });
  check("an unreadable transaction is reported", r.res.issues.includes("Credit Union: 1 transaction from SimpleFIN had no usable id, date or amount and wasn't imported."), true);
  check("and holds that account's marker", r.accts.checking.last_imported_through, D(-10));
}

// ===========================================================================
console.log("\n12. Failures change nothing");
{
  const run = async (answer) => {
    const app = makeApp(fixture());
    app.secretStorage.setSecret(H.SIMPLEFIN_SECRET_ID, ACCESS);
    const plugin = makePlugin(app);
    const snapshot = JSON.stringify([app._store[F.transactions], app._store[F.accounts], app._store[F.revolvingDebts]]);
    global.__notices = [];
    bridge(answer);
    const logged = [];
    const orig = console.error;
    console.error = (...a) => logged.push(a.join(" "));
    const res = await plugin.syncSimpleFIN();
    console.error = orig;
    return { res, plugin, logged, unchanged: JSON.stringify([app._store[F.transactions], app._store[F.accounts], app._store[F.revolvingDebts]]) === snapshot };
  };
  let r = await run(() => ({ status: 403 }));
  check("revoked access", global.__notices, ["SimpleFIN sync failed: SimpleFIN turned the connection down — access may have been revoked. Reconnect in Settings with a new setup token."]);
  check("leaves the ledger, accounts and debts as they were", r.unchanged, true);
  check("and the button usable again", r.plugin.syncing, false);
  r = await run(() => ({ status: 402 }));
  check("an unpaid Bridge subscription", global.__notices[0], "SimpleFIN sync failed: SimpleFIN says the Bridge subscription needs attention.");
  r = await run(() => { throw new Error("getaddrinfo ENOTFOUND"); });
  check("offline", [global.__notices[0], r.unchanged], ["SimpleFIN sync failed: Couldn’t reach SimpleFIN — check your connection and try again.", true]);
  r = await run(() => ({ status: 200, text: "<html>" }));
  check("garbage", [global.__notices[0], r.unchanged], ["SimpleFIN sync failed: SimpleFIN sent back something that isn’t account data.", true]);

  // A write that fails partway: the message says so, and a second sync mends it.
  {
    const app = makeApp(fixture());
    app.secretStorage.setSecret(H.SIMPLEFIN_SECRET_ID, ACCESS);
    const plugin = makePlugin(app);
    const write = app.vault.adapter.write;
    let broken = true;
    app.vault.adapter.write = async (p, d) => { if (broken && p === F.revolvingDebts) throw new Error("disk full"); return write(p, d); };
    global.__notices = [];
    bridge(() => ok(payload()));
    const orig = console.error; console.error = () => {};
    await plugin.syncSimpleFIN();
    console.error = orig;
    check("a failure after saving began says so", global.__notices[0], "SimpleFIN sync failed: It stopped partway through saving. Sync again to finish — nothing will be imported twice.");
    check("and doesn't claim nothing changed", /Nothing was changed/.test(global.__notices[0]), false);
    broken = false;
    global.__notices = [];
    bridge(() => ok(payload()));
    await plugin.syncSimpleFIN();
    const acct = readFile(app, F.accounts).find((a) => a.id === "chase");
    const debt = readFile(app, F.revolvingDebts)[0];
    check("syncing again brings the card and its debt back into agreement", [acct.current_balance, debt.balance_anchor.amount], [590.46, 590.46]);
    check("without importing anything twice", readFile(app, F.transactions).filter((t) => t.simplefin_id === "fare1").length, 1);
  }

  // Something unexpected, with a credential in its message: the user sees a
  // generic line, and the console gets it redacted.
  r = await run(() => ({ status: 200, json: { accounts: [{ id: "ACT-chk", get transactions() { throw new Error(`boom at ${ACCESS}/accounts`); } }] } }));
  check("an unexpected error shows a plain message", global.__notices[0], "SimpleFIN sync failed: Something unexpected went wrong. Nothing was changed.");
  check("it's logged", r.logged.length, 1);
  check("without the password", r.logged[0].includes("s3cr3t"), false);
  check("with the redaction marker", r.logged[0].includes("https://[redacted]@"), true);
  check("the notice never carries it either", global.__notices.some((n) => n.includes("s3cr3t")), false);
}

// ===========================================================================
console.log("\n13. Guards");
{
  // Not connected: the Sync action goes to Settings instead.
  const app = makeApp(fixture());
  const plugin = makePlugin(app);
  bridge(() => ok(payload()));
  check("no connection: nothing is sent", [await plugin.syncSimpleFIN(), sent.length], [null, 0]);
  check("Settings opens at the SimpleFIN box", plugin._openedSettings, [{ focus: "simplefin" }]);

  // The daily allowance.
  app.secretStorage.setSecret(H.SIMPLEFIN_SECRET_ID, ACCESS);
  const now = Date.now();
  await H.writeJSON(app, F.simplefinAccounts, { requests: Array.from({ length: 20 }, (_, i) => now - i * 60000) });
  global.__notices = [];
  bridge(() => ok(payload()));
  check("the 21st request in a day isn't sent", [await plugin.syncSimpleFIN(), sent.length], [null, 0]);
  check("and it says why", /asked 20 times in the last 24 hours/.test(global.__notices[0]), true);
  await H.writeJSON(app, F.simplefinAccounts, { requests: Array.from({ length: 20 }, (_, i) => now - 86400000 - i * 60000) });
  bridge(() => ok(payload()));
  await plugin.syncSimpleFIN();
  check("requests older than a day don't count", sent.length, 1);
  check("and are dropped from the log", readFile(app, F.simplefinAccounts).requests.length, 1);
  check("the limit stays under the Bridge's ~24", H.SIMPLEFIN_DAILY_LIMIT <= 20, true);

  // Connecting takes two requests, so it needs room for both.
  const appC = makeApp(fixture());
  const pC = makePlugin(appC);
  await H.writeJSON(appC, F.simplefinAccounts, { requests: Array.from({ length: 19 }, (_, i) => now - i * 60000) });
  bridge((req) => (req.method === "POST" ? { status: 200, text: ACCESS } : ok(payload())));
  let quota = null;
  try { await pC.connectSimpleFIN(DEMO_TOKEN); } catch (e) { quota = e.kind; }
  check("connect with one request left is refused up front", [quota, sent.length, pC.hasSimpleFINConnection()], ["quota", 0, false]);
  await H.writeJSON(appC, F.simplefinAccounts, { requests: Array.from({ length: 18 }, (_, i) => now - i * 60000) });
  await pC.connectSimpleFIN(DEMO_TOKEN);
  check("with two left it goes ahead and ends at the limit", readFile(appC, F.simplefinAccounts).requests.length, 20);
  const appG = makeApp(fixture());
  const pG = makePlugin(appG);
  bridge(() => ok(payload()));
  try { await pG.connectSimpleFIN("not a token!!"); } catch (e) { /* expected */ }
  check("pasting something that isn't a token costs no requests", [sent.length, (readFile(appG, F.simplefinAccounts) || {}).requests], [0, undefined]);

  // Two presses: one request.
  const app2 = makeApp(fixture());
  app2.secretStorage.setSecret(H.SIMPLEFIN_SECRET_ID, ACCESS);
  const p2 = makePlugin(app2);
  let release;
  const gate = new Promise((r) => (release = r));
  bridge(async () => { await gate; return ok(payload()); });
  const first = p2.syncSimpleFIN();
  await tick();
  check("syncing is flagged while it runs", p2.syncing, true);
  const second = await p2.syncSimpleFIN();
  check("a second press while syncing does nothing", second, null);
  release();
  await first;
  check("one request went out", sent.length, 1);
  check("and the rows came in once", readFile(app2, F.transactions).filter((t) => t.simplefin_id === "fare1").length, 1);

  // Nothing linked yet: balances only, nothing written to the ledger.
  const app3 = makeApp(Object.assign(fixture(), { [F.accounts]: fixture()[F.accounts].map((a) => Object.assign({}, a, { simplefin_id: undefined })) }));
  app3.secretStorage.setSecret(H.SIMPLEFIN_SECRET_ID, ACCESS);
  const p3 = makePlugin(app3);
  const ledgerBefore = app3._store[F.transactions];
  global.__notices = [];
  bridge(() => ok(payload()));
  await p3.syncSimpleFIN();
  check("with nothing linked it asks for balances only", new URL(sent[0].url).searchParams.get("balances-only"), "1");
  check("and doesn't touch the ledger", app3._store[F.transactions], ledgerBefore);
  check("it tells you what to do next", global.__notices[0],
    "Found 3 SimpleFIN accounts, none linked yet. Link them in Settings → Accounts (Edit → SimpleFIN account), then sync again.");
  check("and caches the list for the dropdown", readFile(app3, F.simplefinAccounts).accounts.length, 3);
}

// ===========================================================================
console.log("\n14. Where the connection is kept");
{
  const app = makeApp();
  const plugin = makePlugin(app);
  plugin.setSimpleFINAccess(ACCESS);
  check("in the device's secret storage", app._secrets[H.SIMPLEFIN_SECRET_ID], ACCESS);
  check("under a valid secret id", /^[a-z0-9-]+$/.test(H.SIMPLEFIN_SECRET_ID), true);
  check("not also in local storage", H.SIMPLEFIN_SECRET_ID in app._local, false);
  check("read back", plugin.getSimpleFINAccess(), ACCESS);
  check("connected", plugin.hasSimpleFINConnection(), true);
  check("not in the vault", Object.keys(app._store).length, 0);
  await plugin.disconnectSimpleFIN();
  check("disconnect forgets it", [plugin.getSimpleFINAccess(), plugin.hasSimpleFINConnection()], [null, false]);

  // A copy left in local storage from an older Obsidian is cleared once the
  // keychain has it.
  const app2 = makeApp();
  app2._local[H.SIMPLEFIN_SECRET_ID] = "https://old:copy@h.org/s";
  makePlugin(app2).setSimpleFINAccess(ACCESS);
  check("an older fallback copy is cleared", H.SIMPLEFIN_SECRET_ID in app2._local, false);

  const older = makeApp({}, { secret: false });
  const p2 = makePlugin(older);
  p2.setSimpleFINAccess(ACCESS);
  check("before Obsidian 1.11.4: local storage (still outside the vault files)", older._local[H.SIMPLEFIN_SECRET_ID], ACCESS);
  check("read back from there", p2.getSimpleFINAccess(), ACCESS);

  const none = makePlugin(makeApp({}, { secret: false, local: false }));
  let kind = null;
  try { none.setSimpleFINAccess(ACCESS); } catch (e) { kind = e.kind; }
  check("nowhere safe: it refuses rather than use the vault", kind, "storage");
  bridge((req) => ({ status: 200, text: ACCESS }));
  kind = null;
  try { await none.connectSimpleFIN(DEMO_TOKEN); } catch (e) { kind = e.kind; }
  check("and won't spend a setup token it couldn't keep", [kind, sent.length], ["storage", 0]);

  const throwing = makeApp();
  throwing.secretStorage.setSecret = () => { throw new Error("keychain locked"); };
  makePlugin(throwing).setSimpleFINAccess(ACCESS);
  check("a keychain that throws falls back", throwing._local[H.SIMPLEFIN_SECRET_ID], ACCESS);
}

// ===========================================================================
console.log("\n15. Connecting");
{
  const app = makeApp(fixture());
  const plugin = makePlugin(app);
  bridge((req) => (req.method === "POST" ? { status: 200, text: ACCESS } : ok(payload())));
  const data = await plugin.connectSimpleFIN(DEMO_TOKEN);
  check("claims, then lists accounts", sent.map((r) => r.method), ["POST", "GET"]);
  check("the list is balances only", new URL(sent[1].url).searchParams.get("balances-only"), "1");
  check("the connection is kept", plugin.getSimpleFINAccess(), ACCESS);
  check("the accounts are cached", readFile(app, F.simplefinAccounts).accounts.map((a) => a.id), ["ACT-chk", "ACT-card", "ACT-sav"]);
  check("both requests are logged", readFile(app, F.simplefinAccounts).requests.length, 2);
  check("returns what it found", data.accounts.length, 3);
  check("the ledger isn't touched", app._store[F.transactions], JSON.stringify(fixture()[F.transactions]));

  const app2 = makeApp(fixture());
  const p2 = makePlugin(app2);
  bridge((req) => (req.method === "POST" ? { status: 200, text: ACCESS } : { status: 500 }));
  const d2 = await p2.connectSimpleFIN(DEMO_TOKEN);
  check("if listing fails after the claim, it's still connected", p2.hasSimpleFINConnection(), true);
  check("and says what went wrong", d2.warning, "SimpleFIN returned an error (HTTP 500).");

  const app3 = makeApp(fixture());
  const p3 = makePlugin(app3);
  bridge(() => ({ status: 403 }));
  let err = null;
  try { await p3.connectSimpleFIN(DEMO_TOKEN); } catch (e) { err = e.kind; }
  check("a spent token doesn't connect", [err, p3.hasSimpleFINConnection()], ["claimed", false]);
}

// ===========================================================================
console.log("\n16. The Sync Transactions button");
{
  const makeBar = () => {
    const bar = el("div");
    const addAction = (label, handler, opts = {}) => {
      const btn = bar.createEl("button", { text: label, cls: "budget-action-btn" });
      if (opts.tooltip) btn.setAttr("title", opts.tooltip);
      btn.onclick = () => handler();
      return btn;
    };
    return { bar, addAction };
  };
  const view = (plugin) => { const v = Object.create(H.BudgetDashboardView.prototype); v.plugin = plugin; return v; };

  // Not connected.
  const off = makePlugin(makeApp());
  let { addAction } = makeBar();
  let btn = view(off).renderSyncButton(addAction);
  check("reads Sync Transactions", labelOf(btn), "Sync Transactions");
  const sizers = btn.children.filter((c) => c.classes.has("budget-sync-sizer"));
  check("sized by both labels, so it never changes width", sizers.map((c) => c._text), ["Sync Transactions", "Syncing…"]);
  check("which screen readers skip", sizers.map((c) => c.attrs["aria-hidden"]), ["true", "true"]);
  check("dimmed", [btn.classes.has("budget-sync-off"), btn.classes.has("budget-sync-on")], [true, false]);
  check("still clickable", btn.disabled, false);
  check("says where it goes", btn.attrs.title, "Set up bank sync with SimpleFIN — opens Settings");
  off.syncSimpleFIN = async () => { throw new Error("must not sync"); };
  await btn.onclick();
  check("a click opens Settings at the SimpleFIN box", off._openedSettings, [{ focus: "simplefin" }]);

  // Connected.
  const on = makePlugin(makeApp());
  on.setSimpleFINAccess(ACCESS);
  let release;
  let calls = 0;
  on.syncSimpleFIN = () => { calls++; return new Promise((r) => (release = r)); };
  ({ addAction } = makeBar());
  btn = view(on).renderSyncButton(addAction);
  check("active colour when connected", [btn.classes.has("budget-sync-on"), btn.classes.has("budget-sync-off")], [true, false]);
  const pending = btn.onclick();
  check("reads Syncing… while it runs", labelOf(btn), "Syncing…");
  check("and is disabled", btn.disabled, true);
  check("with the busy style", btn.classes.has("budget-sync-busy"), true);
  release();
  await pending;
  check("back to normal once the promise resolves", [labelOf(btn), btn.disabled, btn.classes.has("budget-sync-busy")], ["Sync Transactions", false, false]);
  check("one sync per click", calls, 1);

  // A re-render while a sync is running draws the busy state.
  on.syncing = true;
  ({ addAction } = makeBar());
  btn = view(on).renderSyncButton(addAction);
  check("drawn mid-sync: Syncing…, disabled", [labelOf(btn), btn.disabled, btn.classes.has("budget-sync-busy")], ["Syncing…", true, true]);

  ({ addAction } = makeBar());
  on.syncing = false;
  check("short label on a phone", labelOf(view(on).renderSyncButton(addAction, true)), "Sync");

  // A sync that throws still frees the button.
  on.syncSimpleFIN = async () => { throw new Error("x"); };
  ({ addAction } = makeBar());
  btn = view(on).renderSyncButton(addAction);
  try { await btn.onclick(); } catch (e) { /* surfaced by Obsidian */ }
  check("freed even if the sync throws", [labelOf(btn), btn.disabled], ["Sync Transactions", false]);

  // The real sync sets the flag and redraws as it starts and ends.
  const real = makePlugin(makeApp(fixture()));
  real.setSimpleFINAccess(ACCESS);
  const seen = [];
  real.refreshDashboard = function () { seen.push(this.syncing); };
  bridge(() => ok(payload()));
  await real.syncSimpleFIN();
  check("redraws busy at the start and idle at the end", [seen[0], seen[seen.length - 1]], [true, false]);

  const multi = makePlugin(makeApp(fixture()));
  multi.setSimpleFINAccess(ACCESS);
  const drawn = { a: [], b: [] };
  multi.app.workspace = { getLeavesOfType: () => [
    { view: { render: () => drawn.a.push(multi.syncing) } }, { view: { render: () => drawn.b.push(multi.syncing) } }] };
  bridge(() => ok(payload()));
  await multi.syncSimpleFIN();
  check("every open dashboard shows the sync starting and ending", [drawn.a, drawn.b], [[true, false], [true, false]]);
}

// ===========================================================================
console.log("\n17. In the action bar");
{
  const HF = require("./harness-for.js")(P.MAIN);
  const fs = require("fs");
  const RESULT = JSON.parse(fs.readFileSync(P.FIXTURES + "/fixture-result.json", "utf8"));
  const CTX = JSON.parse(fs.readFileSync(P.FIXTURES + "/fixture-ctx.json", "utf8"));
  CTX.ownership = HF.completeOwnership({ fixedExpenses: [], installmentDebts: CTX.installmentDebts, revolvingDebts: CTX.revolvingDebts, goals: CTX.savingsGoals, categoryMeta: CTX.categoryMetaList, rules: CTX.rules });
  const render = async (connected) => {
    const v = Object.create(HF.BudgetDashboardView.prototype);
    Object.assign(v, {
      sectionOpen: {}, scrollMemory: {}, activeTab: "overview", pieRange: null, expandedSpendCategory: null, expandedIncomeCategory: null,
      activePieTab: "spending", app: {}, lastResult: RESULT, contentEl: el("div"),
      plugin: {
        settings: { savingsMode: false, bufferMode: "manual", manualBuffer: 350 }, expiredPeriod: null, lastResult: null, syncing: false,
        hasSimpleFINConnection: () => connected, promptEnterPaycheck() {}, promptQuickBalance() {}, promptImportCSV() {}, promptMarkFixedPaid() {}, openSettings() {},
        recalculate: async () => {}, refreshAfterDataChange: async () => {}, fixedPaymentCandidates: async () => [], pendingSweep: async () => null, openSweepModal: async () => {}
      }
    });
    v.loadRenderContext = async () => CTX;
    await v.renderView();
    await tick(40);
    const find = (n, pred, out = []) => { if (pred(n)) out.push(n); (n.children || []).forEach((c) => find(c, pred, out)); return out; };
    const bar = find(v.contentEl, (n) => n.classes && n.classes.has("budget-action-bar"))[0];
    return bar.children.filter((c) => c.tag === "button").map((b) => `${labelOf(b)}${b.classes.has("budget-sync-on") ? " [on]" : b.classes.has("budget-sync-off") ? " [off]" : ""}`);
  };
  check("next to Import CSV, dimmed when not set up", await render(false),
    ["Enter Paycheck", "Import CSV", "Sync Transactions [off]", "Mark Bill Paid", "Export Snapshot", "Settings & Setup"]);
  check("live when connected", (await render(true))[2], "Sync Transactions [on]");
}

// ===========================================================================
console.log("\n18. Settings → Bank sync");
{
  const tabFor = (plugin) => {
    const tab = Object.create(H.BudgetSettingTab.prototype);
    tab.plugin = plugin;
    tab.app = plugin.app;
    tab._displays = 0;
    tab.display = () => { tab._displays++; };
    return tab;
  };

  // Not connected, arriving from the dimmed button.
  const plugin = makePlugin(makeApp(fixture()));
  plugin.settingsFocus = "simplefin";
  const tab = tabFor(plugin);
  SettingStub.texts = []; SettingStub.buttons = [];
  const root = el("div");
  await tab.renderBankSyncSettings(root);
  const wrap = root.children[0];
  check("a heading of its own", allText(root).includes("Bank sync (SimpleFIN)"), true);
  check("says it's optional", /Optional\. .*Accounts you don't link keep using Import CSV\./.test(allText(root)), true);
  const token = SettingStub.texts.find((t) => t.settingName === "SimpleFIN setup token");
  check("a token field", !!token, true);
  check("masked", token.inputEl.type, "password");
  check("no autocomplete", token.inputEl.attrs.autocomplete, "off");
  check("a Connect button", SettingStub.buttons.map((b) => b.label), ["Connect"]);
  check("arriving from Sync flashes the box", wrap.classes.has("budget-settings-flash"), true);
  let focused = false, scrolled = null;
  token.inputEl.focus = () => { focused = true; };
  token.inputEl.scrollIntoView = (o) => { scrolled = o; };
  await tick(10);
  check("and puts the cursor in the token field", focused, true);
  check("scrolled into view", scrolled && scrolled.block, "center");
  check("the request is used up", plugin.settingsFocus, null);

  const plain = el("div");
  SettingStub.texts = []; SettingStub.buttons = [];
  await tab.renderBankSyncSettings(plain);
  check("opening Settings normally doesn't flash", plain.children[0].classes.has("budget-settings-flash"), false);

  // Connect with nothing pasted.
  global.__notices = [];
  bridge(() => ok(payload()));
  await SettingStub.buttons[0].cb();
  check("an empty field is caught before any request", [global.__notices[0], sent.length], ["Paste a SimpleFIN setup token first.", 0]);

  // Connect for real.
  const t2 = SettingStub.texts.find((t) => t.settingName === "SimpleFIN setup token");
  t2.inputEl.value = DEMO_TOKEN; t2.inputEl.dispatchEvent({ type: "input" });
  global.__notices = [];
  bridge((req) => (req.method === "POST" ? { status: 200, text: ACCESS } : ok(payload())));
  await SettingStub.buttons[0].cb();
  check("connects", plugin.hasSimpleFINConnection(), true);
  check("says what it found and what's next", global.__notices[0], "Connected to SimpleFIN — found 3 accounts. Link them under Accounts, then press Sync.");
  check("redraws Settings", tab._displays, 1);

  // Connected view.
  const linked = el("div");
  SettingStub.texts = []; SettingStub.buttons = [];
  await tab.renderBankSyncSettings(linked);
  const txt = allText(linked);
  check("shows it's connected", /Connected/.test(txt), true);
  check("with counts", txt.includes("3 SimpleFIN accounts · 2 linked · not synced yet"), true);
  check("no token field any more", SettingStub.texts.length, 0);
  check("a Disconnect button", SettingStub.buttons.map((b) => b.label), ["Disconnect"]);
  check("lists what isn't linked", txt.includes("Credit Union — Savings · $5,000.00"), true);
  check("and not what is", txt.includes("Freedom Unlimited"), false);
  check("the password isn't on screen", txt.includes("s3cr3t"), false);

  // A spent token.
  const p4 = makePlugin(makeApp(fixture()));
  const tab4 = tabFor(p4);
  SettingStub.texts = []; SettingStub.buttons = [];
  await tab4.renderBankSyncSettings(el("div"));
  const t4 = SettingStub.texts[0];
  t4.inputEl.value = DEMO_TOKEN; t4.inputEl.dispatchEvent({ type: "input" });
  global.__notices = [];
  bridge(() => ({ status: 403 }));
  const orig = console.error; console.error = () => {};
  await SettingStub.buttons[0].cb();
  console.error = orig;
  check("a spent token says so", global.__notices[0], "Couldn't connect: That setup token has already been used, or has expired. Create a new one in SimpleFIN Bridge.");
  check("and stays disconnected", p4.hasSimpleFINConnection(), false);

  // Listing fails after a good claim.
  const p5 = makePlugin(makeApp(fixture()));
  const tab5 = tabFor(p5);
  SettingStub.texts = []; SettingStub.buttons = [];
  await tab5.renderBankSyncSettings(el("div"));
  SettingStub.texts[0].inputEl.value = DEMO_TOKEN; SettingStub.texts[0].inputEl.dispatchEvent({ type: "input" });
  global.__notices = [];
  bridge((req) => (req.method === "POST" ? { status: 200, text: ACCESS } : { status: 503 }));
  await SettingStub.buttons[0].cb();
  check("connected, with the listing problem stated",
    global.__notices[0], "Connected to SimpleFIN, but couldn't list your accounts yet: SimpleFIN returned an error (HTTP 503). Pressing Sync will try again.");

  // The accounts list says which sync.
  SettingStub.texts = []; SettingStub.buttons = [];
  tab.section = (c) => c;
  tab.countLabel = () => "";
  const acctRoot = el("div");
  await tab.renderAccountSettings(acctRoot);
  const at2 = allText(acctRoot);
  check("linked accounts say they sync", (at2.match(/syncs via SimpleFIN/g) || []).length, 2);
}

// ===========================================================================
console.log("\n19. Linking an account");
{
  const known = [
    { id: "ACT-chk", name: "Checking", org: "Credit Union", balance: 1234.56 },
    { id: "ACT-card", name: "Freedom Unlimited", org: "Chase", balance: -590.46 },
    { id: "ACT-sav", name: "Savings", org: "Credit Union", balance: 5000 }
  ];
  const open = (existing, context) => {
    let submitted = null;
    SettingStub.buttons = []; SettingStub.texts = [];
    const m = new H.AddAccountModal({}, (p) => { submitted = p; }, existing, context);
    m.open();
    const pick = SettingStub.lastChange;
    return { m, pick, save: () => SettingStub.buttons.find((b) => /Save/.test(b.label)).cb(), get submitted() { return submitted; } };
  };
  const savings = { id: "savings", type: "savings", institution: "CU Savings", current_balance: 200, last_imported_through: D(-4) };

  let f = open(savings, { simplefinAccounts: known, linkedBy: { "ACT-chk": "Credit Union", "ACT-card": "Chase" } });
  const txt = allText(f.m.contentEl);
  check("a dropdown of SimpleFIN's accounts", txt.includes("Not linked") && txt.includes("Credit Union — Savings · $5,000.00"), true);
  check("already-linked ones are marked", txt.includes("Chase — Freedom Unlimited · $590.46 (linked to Chase)"), true);
  f.pick("ACT-sav");
  f.save();
  check("saves the link", f.submitted.simplefin_id, "ACT-sav");
  check("and keeps the import marker", f.submitted.last_imported_through, D(-4));

  f = open(savings, { simplefinAccounts: known, linkedBy: { "ACT-card": "Chase" } });
  global.__notices = [];
  f.pick("ACT-card");
  f.save();
  check("linking one bank account twice is refused", [f.submitted, global.__notices[0]],
    [null, "That SimpleFIN account is already linked to Chase. Linking it twice would import every transaction twice."]);

  f = open(Object.assign({}, savings, { simplefin_id: "ACT-sav" }), { simplefinAccounts: known, linkedBy: {} });
  f.pick("");
  f.save();
  check("choosing Not linked unlinks", f.submitted.simplefin_id, null);

  f = open(Object.assign({}, savings, { simplefin_id: "ACT-gone" }), { simplefinAccounts: known, linkedBy: {} });
  check("a link SimpleFIN stopped reporting is still shown", allText(f.m.contentEl).includes("Linked to ACT-gone (not in SimpleFIN's last report)"), true);

  f = open(savings, {});
  check("before connecting: a plain field", SettingStub.texts.some((t) => t.settingName === "SimpleFIN account"), true);
  for (const [what, value] of [["a setup token", DEMO_TOKEN], ["an access URL", ACCESS]]) {
    f = open(savings, {});
    const field = SettingStub.texts.find((t) => t.settingName === "SimpleFIN account");
    field.inputEl.value = value; field.inputEl.dispatchEvent({ type: "input" });
    global.__notices = [];
    f.save();
    check(`${what} pasted there isn't saved to the vault`, [f.submitted, /not an account id/.test(global.__notices[0] || "")], [null, true]);
  }
  check("a real account id is fine", H.looksLikeSimpleFINCredential("ACT-4f1c2e0a-9b77-4d1e-8f0b-2b5d4c1a9e33"), false);
  check("that says how to get a list", allText(f.m.contentEl).includes("Connect SimpleFIN under Settings → Bank sync to pick this from a list."), true);

  // The context the modal is opened with.
  const app = makeApp(fixture());
  const plugin = makePlugin(app);
  await H.writeJSON(app, F.simplefinAccounts, { accounts: known });
  let ctx = await plugin.simplefinLinkContext("chase");
  check("without a connection the list is withheld", ctx.simplefinAccounts, []);
  plugin.setSimpleFINAccess(ACCESS);
  ctx = await plugin.simplefinLinkContext("chase");
  check("with one, it's what SimpleFIN last reported", ctx.simplefinAccounts.length, 3);
  check("and the account being edited isn't counted as linked elsewhere", ctx.linkedBy, { "ACT-chk": "Credit Union" });
}

// ===========================================================================
console.log("\n20. Import CSV and linked accounts");
{
  const importCsv = async (files, accountId, csv) => {
    const app = makeApp(files);
    app.vault.getFiles = () => [{ path: `${H.IMPORT_DIR}/export.csv`, extension: "csv" }];
    app.vault.read = async () => csv;
    app.vault.getAbstractFileByPath = () => ({});
    app.fileManager = { trashFile: async () => {} };
    const plugin = makePlugin(app);
    H.ImportSourceModal.prototype.open = function () { return this.onChoose(this.files[0]); };
    H.AccountPickerModal.prototype.open = function () { return this.onChoose(this.accounts.find((a) => a.id === accountId)); };
    resultModals = [];
    await plugin.promptImportCSV();
    await tick(20);
    return { app, result: resultModals[resultModals.length - 1] };
  };
  const csv = `Date,Description,Amount
${D(-8).slice(5, 7)}/${D(-8).slice(8)}/${D(-8).slice(0, 4)},SQ *BLUE BOTTLE COFFEE,-4.50
${D(-40).slice(5, 7)}/${D(-40).slice(8)}/${D(-40).slice(0, 4)},HISTORIC GROCERY,-60.00`;

  let r = await importCsv(fixture(), "checking", csv);
  check("a linked account's CSV isn't imported", [r.result.status, r.result.message], ["failed", "This account syncs through SimpleFIN, so the CSV wasn't imported."]);
  check("and the ledger is untouched", r.app._store[F.transactions], JSON.stringify(fixture()[F.transactions]));
  check("the file is kept", r.result.sourceRemoved, false);

  // Unlinked, with rows SimpleFIN brought in while it was linked.
  const files = fixture();
  files[F.accounts][0].simplefin_id = undefined;
  files[F.transactions].push({ id: "sf-bb", date: D(-8), merchant_raw: "Blue Bottle Coffee", amount: -4.5, account_id: "checking", simplefin_account: "ACT-chk", simplefin_id: "q1" });
  r = await importCsv(files, "checking", csv);
  const after = readFile(r.app, F.transactions);
  check("once unlinked, the CSV imports", r.result.status, "success");
  check("the row SimpleFIN already has is skipped", after.filter((t) => /BLUE BOTTLE/i.test(t.merchant_raw)).length, 1);
  check("the older row comes in", after.some((t) => t.merchant_raw === "HISTORIC GROCERY"), true);
  check("counted as skipped", [r.result.counts.added, r.result.counts.skipped], [1, 1]);
  check("with a note saying why", r.result.notes.includes("1 row was already imported by SimpleFIN sync and was skipped."), true);
  check("and naming the row", r.result.notes.includes(`Skipped as already synced: ${D(-8)} · SQ *BLUE BOTTLE COFFEE · $4.50`), true);

  // A history file ending the day before syncing began keeps all its rows.
  const mdy = (d) => `${d.slice(5, 7)}/${d.slice(8)}/${d.slice(0, 4)}`;
  const files2 = fixture();
  files2[F.accounts][0].simplefin_id = undefined;
  files2[F.transactions].push({ id: "sf-fare", date: D(-30), simplefin_posted: D(-30), merchant_raw: "MTA*NYCT PAYGO", amount: -2.9, account_id: "checking", simplefin_account: "ACT-chk", simplefin_id: "f30" });
  r = await importCsv(files2, "checking", `Date,Description,Amount\n${mdy(D(-40))},HISTORIC GROCERY,-60.00\n${mdy(D(-31))},MTA*NYCT PAYGO,-2.90`);
  const fares = readFile(r.app, F.transactions).filter((t) => /MTA/.test(t.merchant_raw)).map((t) => t.date);
  check("rows just before the synced range aren't taken for synced ones", fares.sort(), [D(-31), D(-30)]);
  check("nothing skipped", r.result.counts.skipped, 0);

  const pairs = H.matchCSVToSimpleFIN(
    [{ date: D(-3), merchant_raw: "A", amount: -9, account_id: "checking" }],
    [{ date: D(-3), merchant_raw: "A", amount: -9, account_id: "checking" }]);
  check("CSV-to-CSV is left to the usual duplicate check", pairs.size, 0);
}

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
})().catch((e) => { console.error(e); process.exit(1); });
