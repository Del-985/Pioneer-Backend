# Payroll practice environment

The `codex/payroll-sandbox` branches in Pioneer-Backend and Pioneer-admin contain this isolated setup. The production main branches are unchanged. `render.yaml` creates one new web service and one dedicated PostgreSQL database. The web service serves both the admin UI and API on the same origin, so login does not depend on third-party cookies.

Deploy: https://render.com/deploy?repo=https://github.com/Del-985/Pioneer-Backend/tree/codex/payroll-sandbox

Choose the My Workspace account. Supply a new, unique `BOOTSTRAP_ADMIN_PASSWORD` of at least 12 characters. Sign in at the generated service URL as `sandbox-admin@example.invalid` using that password. This is a separate account; production credentials are not copied. The current connector cannot apply Blueprints, so final provisioning uses Render's dashboard.

The default free database expires after 30 days, and the free web service sleeps after inactivity. Use this as a disposable practice environment. Choose a paid database only if you want longer-lived test records. Never connect it to the production database, SMTP, SMS, or object storage credentials. Startup refuses common misconfiguration, and no production records are copied. Deploys are manual; new test commits do not change production.

## Practice workflow

1. Select the TEST Payroll business. The first example has fictional Alex Worker, $20/hour, 40 approved hours, zero opening wages, illustrative tax elections and employer rates, and a simulated September 18 payment. No actual funds moved. September 7–14 is the pay period; Q3 is closed for practicing Form 941. The employee count for the reference pay period is 1.
2. Open Tax Filing, choose Q3, and enter fictional employer details (for example EIN 12-3456789, 101 Test Street, Toledo OH 43604). Prior-quarter tax is zero. No deposits or credits are included in this scenario. Confirm only the fictional scenario facts. Prepare, review, and download the watermarked TEST ONLY return. Do not submit test output to any agency.
3. For payroll practice, process the approved October 5–12 hours with an October payday. Use the September wages as prior employer-wide wage evidence. Run the normal earnings, tax review and simulated payment steps. Q4 filing stays a draft until it closes.
4. Use Create Fresh Practice Scenario to add a new fictional employer with the same starting data. Earlier experiments remain available; the action never clears audit history. A failed scenario may leave a partial test employer for diagnosis. Retry by creating a fresh scenario.

Exports include TEST labels on filing PDFs, filing worksheets and pay statements. No email or SMS is sent. File storage is disabled. The sandbox uses the real payroll calculation code and does not certify its legal correctness. Dates and tax rules remain limited to the supported 2026 payroll period; there is no simulated clock.

Validation: configuration guard unit tests, normal project builds, and a PostgreSQL CI workflow that creates a separate database, applies all migrations, creates fictional payroll through normal service calls, prepares/reviews/downloads a filing, verifies statement labels, and checks suppressed notification delivery.
