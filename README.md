# CoopWise Frontend

This is the separate React/Vite frontend for CoopWise. It talks to the
LavaLust backend through its built-in API endpoints.

## Local development

1. Copy `.env.example` to `.env.local`.
2. Set `VITE_API_BASE_URL` to the backend API base. For the local WampServer
   backend, use `http://localhost/LavaLust-COOPWISE/api`.
3. Run `npm install`, then `npm run dev`.

The current frontend supports member registration, sign-in, and loading the
signed-in account profile. Access tokens are kept in per-tab session storage.
Loan, savings, payment, and daily cooperative screens will need dedicated API
endpoints and frontend pages before those workflows can be moved here.

## Vercel

Import this repository as a Vite project. Set the environment variable
`VITE_API_BASE_URL` to the deployed LavaLust API URL, including `/api`, e.g.
`https://your-backend.onrender.com/api`. Add the exact Vercel origin to the
backend's `COOPWISE_ALLOWED_ORIGINS` setting.
