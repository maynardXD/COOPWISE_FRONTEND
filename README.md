# CoopWise Frontend

This is the separate React/Vite frontend for CoopWise. It talks to the
LavaLust backend through its built-in API endpoints.

## Local development

1. Copy `.env.example` to `.env.local`.
2. Set `VITE_API_BASE_URL` to the backend API base. For the local WampServer
   backend, use `http://localhost/COOPWISE/LavaLust-COOPWISE/api`.
3. Run `npm install`, then `npm run dev`.

The frontend supports member registration and sign-in, then shows role-based
share-capital, savings, loan, online-payment, and daily Paluwagan screens backed
by the LavaLust API. Members submit loan documents for staff approval before
loan offers become available, then can apply and view their loan schedules.
They can make loan, Paluwagan, or share-capital payments using Xendit Hosted
Checkout or deduct the amount from their savings balance, which is shown on the
payment page. Savings-funded payments debit and apply the payment immediately
and appear in the savings ledger and payment history. Members can see their own
payment/contribution/payout history. Staff can browse the cooperative-wide
online and savings-funded payment history, manage loan products and
applications, create daily cycles, select multiple members for enrollment, and
confirm completed Paluwagan payouts, which are credited to the recipient’s demo
balance. The backend randomizes payout order for the selected members.
After loan documents are approved, members see active offers configured by
staff. If none are available, the portal explains that staff need to configure
an active product. The loan page can refresh approval status after staff review.
Xendit payments are recorded only after the backend verifies the Xendit webhook
token and confirms the status with Xendit. While a member has an unsettled
checkout open, only the payment transaction list is refreshed in the background;
the page does not repeatedly reload loan, Paluwagan, and share-capital data.
Returning from checkout triggers an immediate server-side status check.
Loan documents are stored
privately and served through authenticated API routes. Existing demo
payment-submission records are retained, but the submission and staff approval
workflow is no longer used.
Members can preview and print their own passbook-style savings ledger for all
activity, this month, last month, or a custom date range. Staff can open the
same date-filtered ledger from each member’s row in the directory. Ledgers show
opening and closing balances, period deposit/withdrawal totals, and each
transaction’s date, reference, description, credit/debit, and running balance;
the browser print dialog can also save the statement as PDF. Members can email
a generated PDF of the selected ledger period to their own registered account
email; the backend derives the recipient from the authenticated account and
does not accept an email address from the browser. Brevo delivery must be
configured. Members can also view/print their ID card, and staff can create
one from the member directory.
The card QR contains a signed member identifier, not savings or contact data;
scanning it checks the current membership status.
Members see a flat-interest estimate while applying for a loan and can print
the final approved installment schedule or save it as PDF. Approval credits
the principal into the member’s available balance. Members can immediately
simulate a withdrawal that debits their balance and appears in their ledger.
No staff approval, financial-account details, receipt, Xendit payout, or real
money transfer is involved. Loan proceeds and confirmed Paluwagan payouts are
the member balance’s sources; new Xendit savings deposits are disabled.
The withdrawal screen lets the member choose a demo e-wallet (GCash/Maya) or
bank (BDO/BPI/UnionBank). It stores the chosen destination in the transaction
description for the receipt; it does not collect destination account details
or call Xendit Payouts. QR payment is not offered as a cash-out destination.
Members may independently opt in to loan or daily Paluwagan auto-pay from
savings. The preferences default off, and automatic payments will not run
until the backend daily CLI job is configured.
Share capital is ownership investment, not withdrawable savings. Staff can
record cooperative-approved subscriptions; members see their own subscribed,
paid-up, and unpaid amounts. Staff can reverse an erroneous contribution with
an auditable correction instead of deleting the original transaction.
Xendit is configured for test mode by default. It requires a server-side
secret key and a configured webhook before incoming checkout can be used. The
provider does not disburse Paluwagan payouts; staff confirm the simulated payout
and the backend credits the recipient’s available demo balance.
Forgot-password uses a six-digit OTP delivered through Brevo. It requires a
Brevo API key and a verified sender address. Neither provider credential is
stored in the frontend.
The reset API allows up to three requests per IP per minute, and an active
code prevents duplicate sends within one minute. Rate-limit responses tell the
user how long to wait. If Brevo rejects delivery, the backend response includes
a support reference that can be matched to the Render log without exposing the
reset code or provider credentials.
Staff reports use recorded database totals and monthly activity rather than
the old screen's static sample figures. Access tokens are kept in per-tab
session storage. Other legacy pages are still available in the LavaLust
application and have not yet been moved into this separate frontend.
The Reports page also retains the recent activity audit log; meetings and
voting are no longer part of the application.
The Cooperative Learning Center explains the system and shows staff-editable
sample policies; the Guided Demo Walkthrough uses fictional, read-only sample
amounts and never inserts or resets database records. Loan applicants can
compare eligible products using a shared sample amount and term before
submitting an application. Staff reports include operational review counts,
while Savings provides balance summaries, member search, ledger shortcuts,
date/type filters, and filtered CSV export. Staff cannot silently edit balances.

After login, the dashboard opens on Savings by default. The Loans page
has separate Loan offers, Document reviews, and Applications tabs. Pending
document reviews and loan applications each show a red count badge; the page
opens the first pending-review tab automatically when staff have items waiting.
Application cards and recent loan payments stay inside the Applications tab to
keep the other loan views focused. The staff workspace uses a responsive sidebar, live cooperative overview, and
consistent page header across loans, share capital, reports, online payments,
daily Paluwagan, savings, and member management. Members use the same
responsive workspace shell with member-only navigation and service tabs.

Portal data is cached in browser memory for up to 15 seconds per signed-in
session, so returning to a recently opened tab can show its last result
immediately instead of blocking on the same API requests. Expired data refreshes
in the background; successful changes clear the cache and reload active views.
The cache is not written to local storage and is cleared when the user signs out.

Run `npm run lint` and `npm run build` to validate the frontend.

The ledger and member-card features use the backend’s `/api/savings/ledger`,
`/api/member-card`, `/api/members/{member_id}/card`, and
`/api/member-cards/verify` endpoints. Configure the frontend API URL and the
backend CORS allowed origin as described below before deploying these features.

## Vercel

Import this repository as a Vite project. Set the environment variable
`VITE_API_BASE_URL` to the deployed LavaLust API URL, including `/api`, e.g.
`https://your-backend.onrender.com/api`. Add the exact Vercel origin to the
backend's `COOPWISE_ALLOWED_ORIGINS` setting.
