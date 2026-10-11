# Ohio residents / Toledo work: payroll readiness

Scope confirmed October 10, 2026: all employees reside and work in Ohio; all
work is inside Toledo city limits. Address-based municipal allocation is deferred.
School district withholding still follows each employee's verified residence.

## Implemented controls

- A real planned payday is required; rule selection uses that date, not the work
  period end. Only August 1–December 31, 2026 is supported. No guessed 2027 tables.
- Weekly/biweekly ordinary cash payroll; approved earnings and documented review.
- Signed 2020+ federal W-4 transcription, 2026 federal exemption claims,
  Ohio IT-4 exemptions and additional Ohio withholding. Exempt W-4 claims do not
  disable FICA, Ohio or Toledo tax. Exempt claims require 2026 documentation.
- Toledo qualifying wages at 2.5%. Manually verified school-district code/rate;
  traditional-base exemptions and earned-income-base withholding are distinct.
- Prior SS, Medicare, FUTA and Ohio UI wages for the SAME legal employer and
  payday's calendar year, across its business units. Other employers' wages do
  not consume Pioneer's wage caps. Same-day earlier payments must be included.
- Employer FUTA ($7,000 annual base) and Ohio UI ($9,000 annual base), using entered
  documented rates. Ohio total rate includes applicable notice fees. FUTA credit
  is not assumed: reduced credit, late state deposits and year-end adjustments
  require review. Employer costs never reduce employee net pay.
- Append-only corrections to wage-history evidence. Source changes invalidate
  drafts. Business-level serialization prevents tax-source edits racing approval.
  Approved snapshots remain immutable; old approved estimates are not relabeled.
- Ordinary regular payments only: no guessed benefit tax treatment, lock-in
  letters, nonresident-alien rules, successor/common-paymaster treatment, special
  employer/employee tax exemptions or multiple regular payments per period.
  Supplemental compensation is combined with concurrent regular pay for federal
  aggregation; Ohio applies its separate supplemental rate. Nonzero wage
  corrections and high annual supplemental compensation require separate review.

## Not yet production payroll

These are tax calculation/review controls, not a certification of compliance.
Approval still cannot disburse funds, record a payroll settlement or file a return.

Before first actual payroll, complete:

1. Employer registrations/accounts and deposit schedules (IRS, Ohio withholding,
   school district withholding where applicable, Toledo, ODJFS and Ohio BWC).
   Retain Pioneer's assigned 2026 Ohio UI rate notice and FUTA credit evidence.
2. Correct gross pay: established fixed workweek, splitting overnight work across
   boundaries, all employer hours, mixed-rate weighted regular rate, allocable
   nondiscretionary bonuses, minimum wage and deduction limits. The existing
   clock-in-week overtime engine remains an estimate; a review checkbox is not a
   substitute for a correct gross-pay engine.
3. Actual payment lifecycle and paid-wage ledger: date, method, reference,
   duplicate prevention, reversals, employee/employer YTD totals and tax liabilities.
   Current manually verified opening wages do not auto-accumulate paid payroll.
4. Ohio earnings statements under ORC 4113.14: employee name/address, employer
   name, gross and net paid, each addition/deduction and purpose, payday/period,
   total hours, hourly rates and hours above forty in a workweek. Current employee
   previews are not these statements.
5. Deposit/remittance evidence and reconciliation; Forms 941/940, W-2/W-3, Ohio,
   school district, Toledo and unemployment reports/returns as applicable. The
   system must not show a filing as completed merely because it calculated tax.
6. Employee onboarding records (I-9, signed tax forms, Ohio new-hire reporting),
   secure personnel record retention and access controls. No SSNs/bank account
   numbers should be placed in free-text evidence references.

## Primary rules checked

- IRS Publication 15-T (2026), Worksheet 1A and automated tables:
  https://www.irs.gov/publications/p15t
- IRS Publication 15 (2026), FICA, FUTA, exemption and supplemental-pay rules:
  https://www.irs.gov/publications/p15
- Ohio August 2026 computer withholding formula:
  https://dam.assets.ohio.gov/image/upload/tax.ohio.gov/employer_withholding/2026%20Withholding%20Tables/WHT_OptionalComputerFormula_2026.pdf
- Ohio employer withholding and school-district base definitions:
  https://tax.ohio.gov/business/employer-withholding
- Ohio school district computer formula (weekly $12.50 / biweekly $25 per exemption):
  https://dam.assets.ohio.gov/image/upload/tax.ohio.gov/forms/employer_withholding/2017/SDIT_Instructions.pdf
  This older document is used only for arithmetic corroborated by the current
  employer-withholding guidance, not its old filing instructions/rate listing.
- Ohio 2026 contribution-rate components and $9,000 wage base:
  https://dam.assets.ohio.gov/image/upload/jfs.ohio.gov/ouio/uctax/2026RateDetails.pdf
- Toledo tax:
  https://toledo.oh.gov/pay-taxes
- Ohio earnings statements:
  https://codes.ohio.gov/ohio-revised-code/section-4113.14

## Recorded payments and statements (October 2026)

Payments & Statements records payments completed outside Pioneer; it never sends
ACH instructions, prints negotiable checks, debits a bank, posts a Books settlement,
or transmits returns. Independently check payroll before paying: recording evidence
does not repair the gross-pay engine limitations above. Actual gross and net must
agree with the approved withholding snapshot, including its payday. Differences
require a reviewed correction, not an override of an immutable approval.

Each payment has unique request, run/employee and legal-employer payment references.
Native recording and legacy provider batches are mutually exclusive for a run.
Statements freeze employee name/address, employer, payday, period, gross/net,
hourly earnings/rates, overtime, wage additions, reimbursements and deductions.
Download HTML, open it in a browser, print/save PDF and deliver on payday. A download
is not proof of delivery. The authenticated employee-only paid-statements API is
available, but its employee frontend is not wired yet; this release requires print
delivery. Existing time/gross/native/tax previews remain estimates, not statements.

Full voids/returns append reversal evidence without deleting payment history.
Later recorded wages block reversal of earlier payments on which they may depend.
Reissues, partial recoveries, corrected withholding and later-year repayments need
a separate reviewed correction workflow; the same run cannot be reissued here.
Reversals never move funds or amend Books/returns. Reconcile both separately.

Reports use actual payday/year/quarter and exclude reversed payments from totals;
CSV retains reversed rows explicitly for audit. Reports cover the selected business
only. Statement YTD gross covers the legal employer/person across its units, but
only Pioneer payment records. External payroll/openings are excluded. This is not
certified W-2/941/940 output. Withholding still requires manually reconciled four-base
prior wages: recording blocks openings below known paid wages, but does not add
recorded wages to an opening that might already include them.

External tax activity records retain agency, period, date, amount and confirmations.
These append-only records are reported evidence, not independently verified agency
acceptance, liability reconciliation, or filing status inferred from a calculation.
Record amendments separately referencing the original. Do not place SSNs, full bank
numbers or credentials in free-text evidence. Employee frontend display, automatic
paid-YTD integration, Books settlement and official return generation remain work.

Tests cover authorization, isolation, date/amount mismatches, idempotent retries,
duplicates/provider protection, frozen statements, HTML escaping, reversals/reporting,
immutable evidence and absence of automatic Books postings.
IRS recordkeeping: https://www.irs.gov/businesses/small-businesses-self-employed/employment-tax-recordkeeping
