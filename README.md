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

## Layout

`apps/api` (Express + Prisma), `apps/web` (React + Vite), `apps/e2e` (Playwright), `packages/shared` (Zod schemas/types).

## Billing note

Payments are simulated: choosing a plan applies it immediately and reports "payment successful". There is no payment gateway.
