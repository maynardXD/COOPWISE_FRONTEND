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
by the LavaLust API.
Members submit loan documents for staff approval before loan offers become
available, then can apply and view their loan schedules. They can submit
demo payment records for staff review, see their cycle participation, and view their own
payment/contribution/payout history. Staff can search members, loans, and
payment submissions; browse and search the member directory; filter payment
submissions by loan, Paluwagan, or cooperative payment and inspect the amount,
reference, related cycle, and screenshot; approve loan documents and review
demo payment records; manage loan products and applications; record loan payments;
create daily cycles; enroll members in payout order; record contributions; and
confirm completed payouts.
After loan documents are approved, members see active offers configured by
staff. If none are available, the portal explains that staff need to configure
an active product. The loan page can refresh approval status after staff review.
Approved demo records do not transfer money or update a financial balance.
Loan documents and
payment screenshots are stored privately and served through authenticated API
routes.
Members can preview and print their own passbook-style savings ledger for all
activity, this month, last month, or a custom date range. Staff can open the
same date-filtered ledger from each member’s row in the directory. Ledgers show
opening and closing balances, period deposit/withdrawal totals, and each
transaction’s date, reference, description, credit/debit, and running balance;
the browser print dialog can also save the statement as PDF. Members can also
view/print their ID card, and staff can create one from the member directory.
The card QR contains a signed member identifier, not savings or contact data;
scanning it checks the current membership status.
Members see a flat-interest estimate while applying for a loan and can print
the final approved installment schedule or save it as PDF. Approval credits
the principal into savings; members can request a simulated withdrawal without
providing financial-account details and track their own request history. Staff
search, filter, sort, and page through requests, then complete or reject/refund
each simulation. No money is transferred and no receipt is required.
Members may independently opt in to loan or daily Paluwagan auto-pay from
savings. The preferences default off, and automatic payments will not run
until the backend daily CLI job is configured.
Share capital is ownership investment, not withdrawable savings. Staff can
record cooperative-approved subscriptions and simulated demo contributions;
members see their own subscribed, paid-up, and unpaid amounts. Staff can reverse
an erroneous contribution with an auditable correction instead of deleting the
original transaction. Demo contributions are database records only and do not
transfer money. Payment submissions and loan/share-capital demo transactions
also do not transfer money; PayMongo is not integrated.
Staff reports use recorded database totals and monthly activity rather than
the old screen's static sample figures. Access tokens are kept in per-tab
session storage. Other legacy pages are still available in the LavaLust
application and have not yet been moved into this separate frontend.

The staff workspace uses a responsive sidebar, live cooperative overview, and
consistent page header across loans, share capital, reports, payment
submissions, daily Paluwagan, savings, and member management. Members use the same responsive
workspace shell with member-only navigation and service tabs.

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
