// Synthetic statement pastes for the portfolio import tests. Fidelity's two are
// shaped to exercise every branch of the original, real-statement-tuned
// parsers. The others are written from general knowledge of each provider's
// statements — they are NOT real samples, and a real paste may differ.
// All names and numbers are invented.

module.exports = {
  fidelity401k: `Fidelity NetBenefits
Retirement Savings Statement
ACME CORPORATION 401(K) PLAN
Statement Period: 07/01/2026 - 07/31/2026
Your Account Summary
Beginning Balance $52,318.20
Your Contributions $1,040.00
Employer Contributions $520.00
Change in Market Value $1,122.35
Ending Balance $55,000.55
Vested Balance $53,900.10
Your Personal Rate of Return
This Period 2.1%
Your Asset Allocation
Stocks Bonds Short-Term/Other
90% 8% 2%
Additional Fund Information
Investment Stocks Bonds Short-Term/Other
FID FREEDOM 2055 K6 90% 8% 2%
Blended investments generally hold a mix of asset classes.`,

  fidelityHsa: `Fidelity Health Savings Account
HSA Investment detail
Beginning Account Value $750.00
Change from Last Period $52.00
Change in Investment Value * $12.07
Ending Account Value $802.00
Top Holdings
Description Value Percent of Account
FIDELITY 500 INDEX FUND
$802 100%
Please note that values are approximate.`,

  // Fidelity brokerage: carries the "Account Value" wording the HSA detector
  // keys on, but nothing about an HSA.
  fidelityBrokerage: `Fidelity Investments
INDIVIDUAL - TOD
Account Number Z12-345678
Statement Period August 1, 2026 - August 31, 2026
Your Account Value: $30,123.45
Beginning Account Value $29,500.00
Ending Account Value ** $30,123.45
Change in Investment Value $623.45
Fidelity Brokerage Services LLC, Member NYSE, SIPC`,

  vanguardRoth: `Vanguard
Vanguard Brokerage Services
Your quarterly statement
April 1, 2026, through June 30, 2026
Account overview
Total account value as of June 30, 2026 $48,210.55
Roth IRA Brokerage Account
Account number: XXXX-5678
Balance summary
This quarter Year-to-date
Beginning balance $45,102.10 $41,880.00
Contributions $1,750.00 $3,500.00
Withdrawals $0.00 $0.00
Income $212.40 $401.33
Market value change $1,146.05 $2,429.22
Ending balance $48,210.55 $48,210.55
Personal performance This quarter 6.89%
Asset mix
Stocks 82.1%
Bonds 15.9%
Short-term reserves 2.0%
Holdings
Vanguard Total Stock Market ETF (VTI) $39,000.00
Questions? Visit vanguard.com`,

  empower401k: `Empower
empower.com
Retirement Plan Account Statement
ACME CORP 401(K) PLAN
Statement Period: 04/01/2026 - 06/30/2026
Account Number: XXXXX4321
Your Account Summary
Beginning Balance $61,020.44
Contributions
Employee Contributions $2,400.00
Employer Contributions $1,200.00
Total Contributions $3,600.00
Withdrawals $0.00
Fees ($12.50)
Gain/Loss $2,118.73
Ending Balance $66,726.67
Vested Balance $64,100.00
Personal Rate of Return 3.42%
Asset Allocation
Large Cap 40%
International 20%
Bond 25%
Stable Value 15%`,

  schwabOne: `Charles Schwab & Co., Inc.
Schwab One Account of A. SAMPLE
Statement Period: June 1-30, 2026
Account Number 1234-5678
Account Value as of 06/30/2026: $25,410.88
Change in Account Value This Period Year to Date
Starting Value $24,950.12 $22,100.00
Deposits 500.00 2,000.00
Withdrawals (100.00) (400.00)
Dividends and Interest 38.22 190.55
Change in Value of Investments 22.54 1,520.33
Ending Value $25,410.88 $25,410.88
Asset Composition
Cash and Cash Investments $1,270.54 5%
Equities $19,054.16 75%
Fixed Income $5,086.18 20%
Visit schwab.com`,

  // A provider the reader doesn't know by name.
  genericHsa: `HealthEquity
Health Savings Account Statement
Statement Period 07/01/2026 - 07/31/2026
Account ending in 9911
Beginning Balance $3,210.00
Contributions $300.00
Distributions ($45.10)
Investment Earnings $41.77
Ending Balance $3,506.67`,

  // Only an end date — like a copied web page.
  empowerAsOf: `Empower
empower.com
ACME CORP 401(K) PLAN
Balance as of 09/22/2026
Your Balance $70,004.12
Vested Balance $68,000.00`,

  // Two accounts on one statement.
  vanguardCombined: `Vanguard
vanguard.com
Statement Period: 07/01/2026 - 07/31/2026
Roth IRA Brokerage Account
Account number: XXXX-5678
Ending balance $48,900.00
Individual Brokerage Account
Account number: XXXX-9012
Ending balance $12,300.00
Total account value $61,200.00`,

  notAStatement: `Hey! Just checking whether you're coming to dinner on Friday.
Bring the good bread if you can. See you soon.`
};
