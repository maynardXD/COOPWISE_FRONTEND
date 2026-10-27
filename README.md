# CoopWise Frontend

This is the separate React/Vite frontend for CoopWise. It talks to the
LavaLust backend through its built-in API endpoints.

## Local development

1. Copy `.env.example` to `.env.local`.
2. Set `VITE_API_BASE_URL` to the backend API base. For the local WampServer
   backend, use `http://localhost/LavaLust-COOPWISE/api`.
3. Run `npm install`, then `npm run dev`.

The frontend supports member registration and sign-in, then shows role-based
loan and daily Paluwagan screens backed by the LavaLust API. Members can submit
loan applications, view their loan schedules, see their cycle participation,
and view their own payment/contribution/payout history. Staff can manage loan
products and applications, record loan payments, create daily cycles, enroll
members in payout order, record contributions, and confirm completed payouts.
Access tokens are kept in per-tab session storage. The existing savings ledger
and other legacy pages are still available in the LavaLust application; they
have not yet been moved into this separate frontend.

Run `npm run lint` and `npm run build` to validate the frontend.

## Vercel

Import this repository as a Vite project. Set the environment variable
`VITE_API_BASE_URL` to the deployed LavaLust API URL, including `/api`, e.g.
`https://your-backend.onrender.com/api`. Add the exact Vercel origin to the
backend's `COOPWISE_ALLOWED_ORIGINS` setting.
