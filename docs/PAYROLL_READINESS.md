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
