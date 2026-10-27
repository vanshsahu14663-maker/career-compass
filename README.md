# Career Compass — Frontend + Backend

This project adds a Node/Express backend to the existing single-file Career Compass frontend.

## What it provides

- Server-side proxy endpoints for the five project data sources: Remotive, Arbeitnow, Hacker News, Frankfurter, and Nager.Date.
- Shared cache in Neon Postgres so all visitors reuse the same cached results.
- Persistent saved jobs tied to accounts stored in Neon.
- Email/password register and login endpoints. Passwords are bcrypt-hashed; API tokens are signed server-side.
- Server-side CORS policy and same-origin frontend serving, so browser requests go to `/api/...` instead of calling third-party APIs directly.
- Optional paid API proxy using a server-side Bearer key. **A paid provider was not specified, so this stays disabled until you choose a provider and put its endpoint/key in server environment variables.** Do not put secret keys in `public/index.html`.

## Requirements

- Node.js 20+
- A Neon Postgres database
- A long random JWT secret
- Optional: an account/key for whichever paid API you choose

## Run locally

1. Install Node.js 20 or newer.
2. In this folder, run `npm install`.
3. Copy `.env.example` to `.env`.
4. In Neon Console, create a project, click **Connect**, and copy the pooled connection string into `DATABASE_URL`.
5. Set `JWT_SECRET` to a long random secret. Keep `.env` private; it is ignored by git.
6. Run `npm start`.
7. Open `http://localhost:3000` (not the HTML file directly via `file://`).

The tables are created automatically on first startup.

## API routes

- `GET /api/health`
- `POST /api/auth/register` body `{ "email": "you@example.com", "password": "at-least-10-characters" }`
- `POST /api/auth/login` same body; returns a bearer token
- `GET /api/auth/me` with `Authorization: Bearer <token>`
- `GET /api/jobs`
- `GET /api/news`
- `GET /api/currency?base=USD&symbols=INR`
- `GET /api/holidays?country=IN&year=2027`
- `GET /api/saved-jobs` (auth required)
- `POST /api/saved-jobs` body `{ "key": "source|url", "job": { ...job fields } }` (auth required)
- `DELETE /api/saved-jobs/<url-encoded-key>` (auth required)
- `GET /api/paid?...` (requires `PAID_API_URL` and `PAID_API_KEY`)

## Paid API configuration

No paid provider or key was supplied in the request, and the five original project APIs do not supply a generic paid API key. Choose the provider and endpoint first, then set `PAID_API_URL` and `PAID_API_KEY` on the server/deployment platform. The backend sends the key in the Authorization Bearer header. Do not commit credentials or send them to the browser.

## Deployment

Deploy this folder to a Node-capable host (for example Render, Railway, or a Node deployment on a platform you use). Configure `DATABASE_URL`, `JWT_SECRET`, `PORT` if needed, and `FRONTEND_ORIGIN` only if you intentionally host the frontend on a separate origin. Prefer serving the frontend from this same Express server to avoid CORS issues. Add paid API environment variables only after choosing a provider.

## Notes

- The shared cache is stored in Neon and shared across visitors/instances. TTLs are conservative, particularly for Remotive due to its public API guidance.
- Public API data can change or be temporarily unavailable; the backend returns a clean `502` response rather than exposing upstream details.
- Before production, add rate limiting, email verification, account recovery, CSRF strategy if switching to cookies, and a formal privacy policy. JWT bearer tokens should be stored carefully by the frontend.
