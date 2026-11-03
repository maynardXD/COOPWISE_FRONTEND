# CoopWise Frontend

This is the separate React/Vite frontend for CoopWise. It talks to the
LavaLust backend through its built-in API endpoints.

## Local development

1. Copy `.env.example` to `.env.local`.
2. Set `VITE_API_BASE_URL` to the backend API base. For the local WampServer
   backend, use `http://localhost/COOPWISE/LavaLust-COOPWISE/api`.
3. Run `npm install`, then `npm run dev`.

The frontend supports member registration and sign-in, then shows role-based
loan, online-payment, and daily Paluwagan screens backed by the LavaLust API.
Members submit loan documents for staff approval before loan offers become
available, then can apply and view their loan schedules. They can submit
payment screenshots or transaction reference
numbers for manual review, see their cycle participation, and view their own
payment/contribution/payout history. Staff can search members, loans, and
payment submissions; browse and search the member directory; filter payment
submissions by loan, Paluwagan, or cooperative payment and inspect the amount,
reference, related cycle, and screenshot; approve loan documents and review
payment evidence; manage loan products and applications; record loan payments;
create daily cycles; enroll members in payout order; record contributions; and
confirm completed payouts.
After loan documents are approved, members see active offers configured by
staff. If none are available, the portal explains that staff need to configure
an active product. The loan page can refresh approval status after staff review.
Evidence marked approved is manually verified only; it is not automatically
posted to a financial balance or settled through GCash. Loan documents and
payment screenshots are stored privately and served through authenticated API
routes.
Staff reports use recorded database totals and monthly activity rather than
the old screen's static sample figures. Access tokens are kept in per-tab
session storage. Other legacy pages are still available in the LavaLust
application and have not yet been moved into this separate frontend.

The staff workspace uses a responsive sidebar, live cooperative overview, and
consistent page header across loans, reports, payment submissions, daily
Paluwagan, savings, and member management. The member portal keeps its focused
tab navigation.

Run `npm run lint` and `npm run build` to validate the frontend.

## Vercel

Import this repository as a Vite project. Set the environment variable
`VITE_API_BASE_URL` to the deployed LavaLust API URL, including `/api`, e.g.
`https://your-backend.onrender.com/api`. Add the exact Vercel origin to the
backend's `COOPWISE_ALLOWED_ORIGINS` setting.
