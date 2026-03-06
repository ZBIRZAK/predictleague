# PredictLeague (React + Vite + Node Proxy + Firebase + Supabase)

A football web app inspired by 365scores style, powered by [football-data.org](https://www.football-data.org/).

## Architecture

- Frontend: React + Vite (`src/`)
- Backend proxy: Express (`server/index.ts`)
- All app API calls go to `/api/v4/...` on the backend
- The backend injects `X-Auth-Token` from server env (`FOOTBALL_DATA_API_KEY`)
- Authentication: Firebase Email/Password
- Data storage (groups, invites, predictions): Supabase Postgres

This keeps the API key server-side in production and avoids exposing it in browser code.

## Requirements

- Node.js `20.19.0+` (see `.nvmrc`)

## Features

- Matches list by date
- User registration/login (Firebase)
- Group creation by competition
- Invite friends by email
- Auto-join on login when invited email matches
- Exact prediction input per match:
  - Half-time score (home/away)
  - Full-time score (home/away)

## Environment

Copy `.env.example` to `.env` and set:

```bash
FOOTBALL_DATA_API_KEY=your_key
PORT=8787
VITE_API_PROXY_TARGET=http://localhost:8787
VITE_FIREBASE_API_KEY=
VITE_FIREBASE_AUTH_DOMAIN=
VITE_FIREBASE_PROJECT_ID=
VITE_FIREBASE_STORAGE_BUCKET=
VITE_FIREBASE_MESSAGING_SENDER_ID=
VITE_FIREBASE_APP_ID=
VITE_SUPABASE_URL=
VITE_SUPABASE_ANON_KEY=
SMTP_HOST=smtp.mail.ovh.ca
SMTP_PORT=587
SMTP_SECURE=false
SMTP_USER=z.zbir@box-com.com
SMTP_PASS=
SMTP_FROM=z.zbir@box-com.com
```

The API server reads this `.env` file when started via `npm run dev` or `npm run start`.
Invite emails are sent by the backend route `/internal/invite-email` using the SMTP config above.

Debug endpoint:
- `GET /internal/smtp-health` returns SMTP config/verify status from the backend.

## Supabase Setup

1. Create a Supabase project.
2. In SQL editor, run [schema.sql](/Users/mac/Documents/apps/predictleague/supabase/schema.sql).
3. Put project URL and anon key in `.env`.

Security note:
- Current schema uses MVP RLS policies compatible with Firebase-auth-only clients.
- For production, move Supabase writes/reads behind your Node backend (service role key) and validate Firebase ID tokens server-side.

## Firebase Setup

1. Create a Firebase project.
2. Enable Authentication -> Email/Password.
3. Copy web app config values into `.env` (`VITE_FIREBASE_*`).

## Development

```bash
npm install
npm run dev
```

- Web app: `http://localhost:5173`
- API/server: `http://localhost:8787`

## Build And Start (Production)

```bash
npm run build
npm run start
```

The server serves both:

- API proxy routes (`/api/...`)
- static frontend assets from `dist/`

## Quality Commands

```bash
npm run typecheck
npm run lint
npm run test
```
