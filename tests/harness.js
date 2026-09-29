// Loads main.js with a stubbed Obsidian API and exposes the internal functions
// so the budget math can be exercised against real data.
const fs = require("fs");
const Module = require("module");
const path = require("path");

const P = require("./paths.js");
const src = fs.readFileSync(process.env.BT_HARNESS_MAIN || P.MAIN, "utf8");

const EXPORTS = [
  "round2", "daysBetween", "addDays", "toLocalISO", "todayLocal",
  "isDiscretionaryCategory", "subscriptionGroupKey",
  "classifyBufferSpending", "captureBufferAllocation", "bufferAllocationStale",
  "calculateDynamicBuffer", "calculateVariableNecessities", "runAllocation",
  "debtBalance", "earmarkedSavings", "findPriorityGoal", "goalProgress",
  "buildSubscriptionAudit", "upcomingSubscriptions", "recommendSavings",
  "currentPeriodStart", "nextPaydayFrom", "resolvePaySchedule", "paydaysBetween",
  "isDiscretionaryCategory", "fixedExpenseCandidates",
  "recordFixedPayment", "clearFixedPayment",
  "findCandidateTransactions", "candidatePayments", "contributionCandidates",
  "getDueDateInRange", "nextDueDateOnOrAfter", "dueDayInMonth", "fixedExpenseDueInRange",
  "MarkPaidModal", "ApplyPaymentModal", "MatchPaymentsModal", "BufferSweepModal", "displayMerchant", "isISODateString",
  "cardBalanceState", "cardActivitySince", "isRevolvingDebt", "totalDebt", "debtKey",
  "buildOwnershipIndex", "buildPeriodObligations", "findUnreconciledObligations", "summarizeOwnership",
  "OWNER_TYPES", "RESERVED_OWNER_TYPES", "debtPaymentCategories", "BudgetSettingTab", "parseGenericBank", "parseCapitalOne", "findCol", "reconcileImport",
  "DATE_COLS", "DESC_COLS", "AMOUNT_COLS", "TYPE_COLS", "STATUS_COLS", "TXID_COLS", "ADAPTERS", "renameCategory", "deleteCategory", "repointPaymentCategories", "completeOwnership", "DeleteCategoryModal", "collectCategories", "setPinnedGoal", "AddAccountModal", "DEFAULT_SETTINGS", "TargetTunerModal", "setCategoryTarget", "getPriorMonthCategorySpend", "priorMonthKey", "mergeSettledHolds", "applyTransactionRelinks", "reconcileImport", "MATCHABLE_OWNER_TYPES", "PickObligationModal", "KIND_LABELS"
];

// Names that may legitimately be absent — this same harness loads OLDER copies
// of main.js for differential tests, and a hard reference to something added
// later would make the old module fail to compile rather than simply lack it.
const OPTIONAL_EXPORTS = [
  "setCategoryKind", "categoryKindOf", "CategorySettingsModal",
  "setSvgContent",
  "subscriptionPhaseOut", "nextRenewalDate", "inferCadenceKey", "patchSubscriptionReview", "setSubscriptionStatus",
  "confirmSubscriptionGone", "setSubscriptionCadence", "CADENCE_LABELS", "CADENCE_PRESETS", "SUBSCRIPTION_CATEGORIES", "describeCadence",
  // 1.14.0
  "parseMoneyInput", "formatMoneyInput", "requireMoney", "bindMoneyInput", "bindDateInput", "fieldNote", "fieldNoteHost",
  "patternReach", "describePatternReach", "ruleIndexOf", "bindPatternReach",
  "computeCategoryUsageOrder", "sortCategoriesByUse", "setCategoryUsageOrder", "refreshCategoryUsageOrder",
  "loadCategoryUsageOrder", "carryCategoryOrder", "CATEGORY_USAGE_WINDOW_DAYS", "FILES",
  "buildDebtChart", "enableChartHover", "nearestIndexByX", "formatChartMoney", "formatChartDate", "projectPayoff",
  "validateNextPayday", "isISODateString", "normalizeDate",
  "LabelModal", "EditRuleModal", "RenameSubscriptionModal", "OverrideModal", "AddFixedExpenseModal", "PaycheckModal",
  "SavingsGoalModal", "EditBalanceModal", "DeleteCategoryModal", "AddAccountModal", "BNPLModal", "AddRevolvingDebtModal",
  "QuickBalanceModal", "AddFundsModal", "BufferSweepModal", "renameCategory", "deleteCategory",
  "applyCategorization", "findMatchingRule", "toLocalISO", "MarkPaidModal", "bindInboxToggle",
  // 1.16.0
  "SimpleFINError", "redactSimpleFIN", "parseSimpleFINAccessUrl", "claimSimpleFINToken", "fetchSimpleFINData",
  "normalizeSimpleFINPayload", "simplefinDate", "simplefinEpoch", "simplefinStartDate", "simplefinToLocalTransactions",
  "matchSimpleFINToLedger", "mergeSimpleFINTransactions", "simplefinLocalBalance", "simplefinAccountLabel",
  "merchantWords", "SIMPLEFIN_SECRET_ID", "SIMPLEFIN_MAX_DAYS", "SIMPLEFIN_DAILY_LIMIT", "reanchorCardBalance",
  "cardBalanceState", "ImportResultModal", "pairAcrossSources", "matchCSVToSimpleFIN", "SIMPLEFIN_OVERLAP_DAYS",
  "readJSON", "writeJSON", "ImportSourceModal", "AccountPickerModal", "ConfirmModal", "IMPORT_DIR", "BudgetDashboardView", "csvToSyncedGap", "simplefinRowDates", "looksLikeSimpleFINCredential", "withSimpleFINTimeout", "SIMPLEFIN_POSTING_LAG_DAYS", "paycheckDepositCandidates", "findLatestPaycheck", "PAY_CADENCES",
  // 1.18.0
  "isCappedFund", "regularGoals", "cappedFunds", "fundPlacement", "fundProgress", "fundShare", "fundReason",
  "allocateToFunds", "fundTransferCategory", "pairFundTransfers", "applyFundTransferPairs", "accountLabel",
  "FUND_PLACEMENTS", "FUND_PLACEMENT_LABELS", "FUND_MIN_SUGGESTION", "FUND_TRANSFER_WINDOW_DAYS", "FUND_STALE_DAYS",
  "CappedFundModal", "setCategoryTransfer", "genId", "formatChartDate",
  "fundMovesThisPeriod", "withoutFundAccountRows", "fundBalanceFresh", "fundBalanceAge", "TRANSFER_WORDS", "P2P_WORDS",
  "FUND_ASK_MAX_AGE_DAYS", "dedupeTransactionIds", "livePairPartner", "fundAccountIds", "PAY_WORDS",
  // 1.19.0 — universal portfolio import
  "parsePortfolioStatement", "detectPortfolioStatementType", "parseFidelityNetBenefitsStatement", "parseFidelityHsaStatement",
  "validatePortfolioSnapshot", "portfolioReminders", "PORTFOLIO_ACCOUNTS", "PF_LEGACY_ACCOUNTS", "PF_PROVIDERS", "PF_TYPES",
  "PF_CADENCES", "PF_FIELDS", "PF_BASE_LABELS", "PF_PROFILES", "detectPortfolioStatement", "pfDetectType", "pfProviderScores",
  "pfFindLabeled", "pfFindPeriodWide", "pfFindPeriod", "pfFindAsOf", "pfPeriodEndingOn", "pfPeriodFromMonth", "pfFindAllocation",
  "pfAccountTails", "pfParseGeneric", "resolvePortfolioAccount", "pfSuggestedAccount", "pfSameSnapshot", "pfJumpNote",
  "pfCadence", "lastQuarterEndKey", "pfPeriodName", "portfolioReminderText", "normalizePortfolioAccounts",
  "seedPortfolioAccounts", "portfolioHistory", "PortfolioImportModal", "PortfolioAccountModal", "pfNormalizeText",
  "PF_JUMP_SHARE", "PF_JUMP_MIN", "previousMonthKey", "portfolioMonthKey", "monthNameFromKey", "daysBetween",
  "pfAccountFromForm", "pfDefaultLabel", "pfFormatField", "pfSnapshotFromForm", "pfPlaceSnapshot", "PF_OUTFLOWS", "pfSameProvider", "pfParseMoneyToken", "pfNilDashes",
  // 1.20.0
  "goalMovesThisPeriod", "targetMonthName",
  // 1.21.0
  "buildPortfolioChart", "buildDebtChart", "enableChartHover", "buildTrendChart", "trendSandwichLayout", "enableTrendSandwich",
  "PIE_COLORS", "TREND_W", "TREND_H",
  // 1.23.0
  "buildFinancialSnapshot", "snapshotMarkdown", "snapshotCSV", "generateFinancialSnapshot", "snapshotMoney", "snapshotTable", "PER_MONTH", "EXPORT_DIR", "findLatestPaycheck", "resolvePaySchedule", "calculateVariableNecessities", "completeOwnership", "buildSubscriptionAudit", "debtBalance", "remainingInstallments", "isRollingExpense", "withoutFundAccountRows", "MONTH_DAYS", "TREND_PAD", "TREND_SANDWICH", "escapeAttr", "formatChartMoney", "formatChartDate", "nearestIndexByX", "discretionaryBreakdown", "monthLabel", "toLocalISO", "formatMoneyInput",
  // 1.24.0
  "goalTransferQueue", "assignGoalTransfer", "fileGoalTransferRow", "goalAccountChoices", "accountGoals", "pendingContributionFor", "deleteContribution", "GOAL_CONTRIBUTION_MATCH_DAYS",
  // 1.25.0
  "setupStatus", "setupBudgetVault", "STARTER_CATEGORIES", "SETUP_FOLDERS", "SETUP_README", "SETUP_SKIP", "DEFAULT_SETTINGS", "DATA_DIR", "IMPORT_DIR",
  // 1.25.1
  "cashAccount", "stampBalance", "adoptCashBalance", "paycheckLanded", "balanceSourceText", "formatStampShort", "simplefinConnectionProblems", "SIMPLEFIN_ADVISORY", "reanchorCardBalance", "PaycheckModal",
  // 1.26.0
  "transferCandidates", "transferCategoryFor", "accountTransferCategory", "confirmTransferPair", "undoTransfer", "isHiddenTransfer", "readsLikeTransfer", "pairFundTransfers", "categorySpendTotals", "categoryIncomeTotals", "applyCategorization", "LabelModal", "TRANSFER_REVIEW_DAYS",
  // 1.27.0
  "LOAN_TYPES", "isLoan", "loanType", "loanMethod", "loanTakesExtra", "loanEscrow", "loanPrincipalAndInterest", "loanInterest", "addLoanMonths", "loanState", "loanPayoff", "loanExtraSavings", "loanEquity", "loanMatchFrom", "runAllocation", "candidatePayments", "advanceDueDateIfCovered", "totalDebt", "simplefinLoanUpdates", "closedLoanSummary", "assetSaleCategory", "LoanModal", "CloseLoanModal", "remainingInstallments", "debtBalance", "loanSchedule", "loanPeriodDues", "loanAccrualStart", "loanDueDatesBetween", "loanExtraSuggested", "LOAN_EARLY_DAYS", "applyTransactionRelinks", "ApplyPaymentModal", "ensureDebtAnchors", "mergeSettledHolds"
];

const patched =
  src.replace(/^module\.exports\s*=/m, "const __PluginClass =") +
  `\nconst __out = { __PluginClass, ${EXPORTS.join(", ")} };` +
  `\n${JSON.stringify(OPTIONAL_EXPORTS)}.forEach((n) => { try { __out[n] = eval(n); } catch (e) {} });` +
  `\nmodule.exports = __out;\n`;

// Browser globals the plugin legitimately uses. renderView() restores the scroll
// offset through requestAnimationFrame, so a harness without it can't drive the
// view end to end.
if (typeof global.requestAnimationFrame !== "function") {
  global.requestAnimationFrame = (fn) => setTimeout(fn, 0);
}
if (typeof global.document === "undefined") {
  global.document = { body: { classList: { contains: () => false } } };
}
// The chart helper parses SVG with DOMParser; this stand-in keeps the markup
// so tests can read it back. Real parsing is checked in test-charts-browser.js.
if (typeof global.DOMParser === "undefined") {
  global.DOMParser = class { parseFromString(str) { return { getElementsByTagName: () => [], documentElement: { outerHTML: str, children: [], text: "" } }; } };
}
if (typeof global.document.importNode !== "function") global.document.importNode = (n) => n;

// --- richer DOM ---
function el(tag) {
  const node = {
    style: {},
    value: "",
    open: false,
    disabled: false,
    // Listeners are kept and dispatchable, so a test can type into a field and
    // see what the page would do. Nothing fires unless a test dispatches it.
    _listeners: {},
    addEventListener(type, fn) { (node._listeners[type] = node._listeners[type] || []).push(fn); },
    removeEventListener(type, fn) { node._listeners[type] = (node._listeners[type] || []).filter((f) => f !== fn); },
    dispatchEvent(evt) { (node._listeners[evt.type] || []).slice().forEach((f) => f(evt)); return true; },
    get parentElement() { return node.parent || null; },
    contains(other) { for (let n = other; n; n = n.parent) if (n === node) return true; return false; },
    remove() {
      if (node.parent) node.parent.children = node.parent.children.filter((c) => c !== node);
    },
    getAttr(k) { return node.attrs[k]; },
    removeAttr(k) { delete node.attrs[k]; },
    setAttrs(o) { Object.assign(node.attrs, o); },
    querySelector() { return null; },
    querySelectorAll() { return []; },
    scrollTop: 0,
    tag, children: [], attrs: {}, classes: new Set(), _text: "", checked: false, name: "",
    createDiv(o = {}) { return node.append(el("div"), o); },
    createEl(t, o = {}) { return node.append(el(t), o); },
    createSpan(o = {}) { return node.append(el("span"), o); },
    createSvg(t, o = {}) { return node.append(el(t), o); },
    append(child, o) {
      if (o && o.text) child._text = o.text;
      if (o && o.cls) String(o.cls).split(/\s+/).forEach((c) => c && child.classes.add(c));
      if (o && o.type) child.tag = o.type === "radio" || o.type === "checkbox" ? o.type : child.tag;
      if (o && o.attr) Object.assign(child.attrs, o.attr);
      node.children.push(child); child.parent = node; return child;
    },
    appendChild(child) { node.children.push(child); child.parent = node; return child; },
    empty() { node.children.length = 0; },
    addClass(c) { node.classes.add(c); },
    toggleClass(c, on) { on ? node.classes.add(c) : node.classes.delete(c); },
    setText(t) { node._text = t; },
    setAttr(k, v) { node.attrs[k] = v; },
    get isConnected() { return true; }
  };
  return node;
}
function allText(node) {
  return [node._text || ""].concat(node.children.map(allText)).join(" ");
}
function allRows(node, cls) {
  const out = node.classes && node.classes.has(cls) ? [node] : [];
  node.children.forEach((c) => out.push(...allRows(c, cls)));
  return out;
}

class SettingStub {
  // Appends a marker node so a settings render can be snapshotted structurally.
  constructor(container) {
    this.container = container;
    this.node = container && container.createDiv ? container.createDiv({ cls: "setting-item" }) : el("div");
  }
  setName(v) { this._name = String(v); if (this.node) this.node.createSpan({ cls: "setting-name", text: String(v) }); return this; }
  setDesc(v) { if (this.node) this.node.createSpan({ cls: "setting-desc", text: String(v) }); return this; }
  setHeading() { if (this.node) this.node.addClass("setting-heading"); return this; }
  // Obsidian's Setting exposes these; created lazily so a render that never
  // touches them snapshots exactly as before.
  get settingEl() { return this.node; }
  get descEl() {
    if (!this._descEl && this.node) this._descEl = this.node.createDiv({ cls: "setting-item-description" });
    return this._descEl;
  }
  addText(fn) {
    const n = this.node;
    const inputEl = el("input");
    // Behaves like Obsidian's TextComponent: setValue writes the input, onChange
    // fires on the input event with the input's current value.
    const t = {
      inputEl,
      setPlaceholder() { return t; },
      getValue() { return inputEl.value; },
      setValue(v) { inputEl.value = v == null ? "" : String(v); if (n) n.createSpan({ cls: "setting-value", text: String(v) }); return t; },
      onChange(cb) { SettingStub.lastChange = cb; inputEl.addEventListener("input", () => cb(inputEl.value)); return t; }
    };
    t.settingName = this._name;
    t.setting = this;
    SettingStub.texts.push(t);
    fn(t); return this;
  }
  addTextArea(fn) { return this.addText(fn); }
  addToggle(fn) {
    const n = this.node;
    const t = { setValue(v) { t.value = v; if (n) n.createSpan({ cls: "setting-toggle", text: String(v) }); return t; }, onChange(cb) { SettingStub.lastChange = cb; t._onChange = cb; return t; }, flip(v) { t.value = v; if (t._onChange) t._onChange(v); return t; } };
    t.settingName = this._name;
    (SettingStub.toggles = SettingStub.toggles || []).push(t);
    fn(t); return this;
  }
  addButton(fn) {
    const n = this.node;
    const b = { setButtonText(x) { b._t = x; if (n) n.createSpan({ cls: "setting-btn", text: String(x) }); return b; }, setCta() { return b; }, setWarning() { return b; }, setTooltip() { return b; }, setIcon() { return b; }, onClick(cb) { SettingStub.buttons.push({ label: b._t, cb }); return b; } };
    fn(b); return this;
  }
  addExtraButton(fn) { return this.addButton(fn); }
  addDropdown(fn) {
    const n = this.node;
    const d = { options: [], addOption(v, label) { d.options.push({ value: v, label: String(label) }); if (n) n.createSpan({ cls: "setting-option", text: String(label) }); return d; }, setValue(v) { d.value = v; if (n) n.createSpan({ cls: "setting-value", text: String(v) }); return d; }, setDisabled(v) { d.disabled = !!v; return d; }, onChange(cb) { SettingStub.lastChange = cb; d._onChange = cb; return d; }, choose(v) { d.value = v; if (d._onChange) d._onChange(v); return d; } };
    d.settingName = this._name;
    SettingStub.dropdowns.push(d);
    fn(d); return this;
  }
  addSlider(fn) { const sl = { setLimits() { return sl; }, setValue() { return sl; }, setDynamicTooltip() { return sl; }, onChange(cb) { SettingStub.lastChange = cb; return sl; } }; fn(sl); return this; }
}
SettingStub.buttons = [];
SettingStub.texts = [];
SettingStub.dropdowns = [];

class Stub {
  constructor() { this.contentEl = el("div"); this.containerEl = el("div"); }
  close() { if (this.onClose) this.onClose(); }
  open() { if (this.onOpen) this.onOpen(); }
  registerMarkdownCodeBlockProcessor() {}
  addCommand() {}
  addRibbonIcon() {}
  addSettingTab() {}
  registerView() {}
}
const obsidianStub = {
  Plugin: Stub, ItemView: Stub, Modal: Stub, Notice: function (msg) { (global.__notices = global.__notices || []).push(String(msg)); }, Setting: SettingStub,
  PluginSettingTab: Stub, FuzzySuggestModal: Stub,
  // Records what a menu offered and where it was shown, so a test can pick an item.
  Menu: class {
    constructor() { this.items = []; global.__menus = global.__menus || []; global.__menus.push(this); }
    addItem(fn) {
      const item = { title: "", checked: null, setTitle(t) { item.title = String(t); return item; }, setChecked(c) { item.checked = c; return item; }, setIcon() { return item; }, onClick(cb) { item.cb = cb; return item; } };
      fn(item); this.items.push(item); return this;
    }
    addSeparator() { return this; }
    showAtPosition(pos) { this.shownAt = pos; return this; }
    showAtMouseEvent(evt) { this.shownAt = { mouse: true }; return this; }
  },
  Platform: { isMobileApp: false },
  // Tests set global.__requestUrl to play the part of the network.
  requestUrl: async (req) => (typeof global.__requestUrl === "function" ? global.__requestUrl(req) : {}),
  TFile: Stub, normalizePath: (p) => p
};

const m = new Module("budget-main", null);
m.filename = process.env.BT_HARNESS_MAIN || P.MAIN;
m.paths = Module._nodeModulePaths(path.dirname(m.filename));
const origResolve = Module._load;
Module._load = function (request, parent, isMain) {
  if (request === "obsidian") return obsidianStub;
  return origResolve.apply(this, arguments);
};
m._compile(patched, m.filename);
Module._load = origResolve;

module.exports = Object.assign(m.exports, { el, allText, allRows, SettingStub });
