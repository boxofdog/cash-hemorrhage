// Renders the Settings tab against the DOM shim and prints a stable text
// snapshot, the same way render-snapshot.js does for the Overview.
const P = require("../tests/paths.js");
const mainPath = process.argv[2] || P.MAIN;
const H = require(P.TESTS + "/harness-for.js")(mainPath);
const { el, BudgetSettingTab } = H;
const fs = require("fs");

function dump(node, depth = 0, out = []) {
  const cls = [...(node.classes || [])].sort().join(".");
  const text = (node._text || "").replace(/\s+/g, " ").trim();
  out.push(`${"  ".repeat(depth)}<${node.tag}${cls ? " ." + cls : ""}>${text ? " " + text.slice(0, 120) : ""}`);
  (node.children || []).forEach((c) => dump(c, depth + 1, out));
  return out;
}

const DATA = {
  "Budget/data/categories.json": [
    { name: "Eating Out", is_transfer: false, monthly_target: 200 },
    { name: "Gas", is_transfer: false, is_variable_necessity: true, variable_min_amount: 20 },
    { name: "Phone Bill", is_transfer: false, exclude_from_discretionary: true },
    { name: "Credit Card Payment", is_transfer: true }
  ],
  "Budget/data/fixed_expenses.json": [
    { id: "f1", name: "Phone Co", amount: 33.81, due_day_of_month: 4, payment_category: "Phone Bill", linked_payments: [] },
    { id: "f2", name: "Car Insurance", amount: 216.32, due_day_of_month: 8, linked_payments: [] }
  ],
  "Budget/data/accounts.json": [
    { id: "Main Checking", type: "checking", institution: "Credit Union", current_balance: 554.51 },
    { id: "Capital One Card", type: "credit_card", institution: "Capital One", current_balance: 214.15, credit_limit: 901 }
  ],
  "Budget/data/category_rules.json": [{ merchant_pattern: "SHELL", home_label: "Gas", display_name: "Shell" }],
  "Budget/data/transactions.json": [],
  "Budget/data/savings_goals.json": [],
  "Budget/data/revolving_debts.json": [],
  "Budget/data/installment_debts.json": [],
  "Budget/data/subscription_reviews.json": []
};

(async () => {
  const tab = Object.create(BudgetSettingTab.prototype);
  tab.containerEl = el("div");
  tab.app = {
    vault: {
      adapter: {
        exists: async (p) => p in DATA,
        read: async (p) => JSON.stringify(DATA[p] ?? []),
        write: async () => {}
      }
    }
  };
  tab.plugin = {
    app: tab.app,
    settings: { bufferMode: "manual", manualBuffer: 350, savingsMode: true, savingsDeadline: "2026-11-26", savingsLabel: "Savings Mode", paySchedule: { cadence: "semimonthly", anchor_date: "2026-09-15" } },
    lastResult: null,
    refreshDashboard() {},
    hasSimpleFINConnection() { return false; },
    refreshAfterDataChange: async () => {}
  };
  // Present from 1.19.0; borrowed from the real plugin so the tab renders as it would.
  if (H.__PluginClass && H.__PluginClass.prototype.loadPortfolioAccounts) {
    tab.plugin.loadPortfolioAccounts = H.__PluginClass.prototype.loadPortfolioAccounts;
  }
  await tab.display();
  await new Promise((r) => setTimeout(r, 40));
  console.log(dump(tab.containerEl).join("\n"));
})();
