# SupplyCast

Multi-tenant SaaS for supply-chain demand forecasting and what-if planning.
Stack: MySQL + Express + React + Node.js, TypeScript throughout, Gemini as the only external API.

## Quick start

```bash
cp .env.example .env        # then edit secrets; change DEV_DB_PORT/TEST_DB_PORT if 3306/3307 are taken
docker compose up -d        # dev MySQL (3306) and test MySQL (3307)
npm install
npm run dev                 # API on :4000, web on :5173
```

## Scripts

| Command                              | What it does                                         |
| ------------------------------------ | ---------------------------------------------------- |
| `npm run dev`                        | API + web in watch mode                              |
| `npm run lint` / `npm run typecheck` | ESLint + Prettier check / `tsc` in every workspace   |
| `npm test`                           | API (Jest) and web (Vitest) tests with coverage      |
| `npm run e2e`                        | Playwright tests (starts API and web if not running) |

First time only: `npx playwright install chromium`.

## Auth (Feature 1.1)

`POST /auth/signup | login | refresh | logout | change-password`, `GET /auth/me`. Access token (15 min JWT) is kept in memory by the web app; the rotating refresh token lives in an httpOnly, SameSite=strict cookie scoped to `/auth` (the Vite dev proxy rewrites it to `/api/auth`). Reusing a rotated refresh token revokes all of that user's sessions. 5 failed logins lock the account for 15 minutes.

Setup after `docker compose up -d`: `npm run db:migrate` then `npm run db:seed` (creates the Super Admin from `SUPER_ADMIN_EMAIL`/`SUPER_ADMIN_PASSWORD`). API tests run against the test database (`DATABASE_URL_TEST`) and apply migrations automatically.

## Plans, billing and the admin console (Phase 2)

- Plans and their limits are rows in the database (editable by the Super Admin). New tenants get a 14-day Starter trial; a daily job (`billing.daily`) moves expired trials to Free, applies scheduled downgrades and renews paid periods.
- **Payments are simulated.** Choosing a paid plan applies it immediately, shows "Payment successful" and records an already-paid invoice (`INV-YYYY-000001`). There is no gateway, no pending state and no "simulate payment" button. Upgrades are immediate; downgrades take effect at period end and are blocked while usage exceeds the new plan's limits.
- Limits: count-based (users, SKUs, locations, scenarios) are checked against live rows, period-based (forecast runs, AI requests) against a per-calendar-month counter. Both are enforced atomically by locking the tenant row, so concurrent requests cannot overshoot. Hitting a limit returns HTTP 402 `PLAN_LIMIT_REACHED` with `{ metric, limit, current }`. Notifications fire at 80% and 100%.
- Super Admin console at `/admin`: tenants, plans, metrics (MRR, trial conversion, AI requests/day, failed jobs), suspend/reactivate, owner reset links, and read-only impersonation (banner, every request audited, all writes refused).

## Layout

`apps/api` (Express + Prisma), `apps/web` (React + Vite), `apps/e2e` (Playwright), `packages/shared` (Zod schemas/types).

## Billing note

Payments are simulated: choosing a plan applies it immediately and reports "payment successful". There is no payment gateway.
