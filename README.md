# PEERLOOP Academy — PostgreSQL + Express

This project packages the supplied `PEERLOOP Academy.html` interface and adds a same-origin Node.js API with PostgreSQL persistence, secure cookie sessions, account registration/login, learner profiles, and role-protected administration endpoints.

## Stack
- Node.js 20+
- Express 4
- PostgreSQL (`pg`)
- `bcryptjs` password hashing (12 rounds)
- `express-session` + `connect-pg-simple` sessions stored in PostgreSQL
- Helmet security headers and rate limiting

## Quick start

1. Install Node.js 20+ and PostgreSQL.
2. Create a database, for example:
   ```sql
   CREATE DATABASE peerloop;
   ```
3. In this directory, copy `.env.example` to `.env` and set `DATABASE_URL` and a strong `SESSION_SECRET` (at least 32 characters). For example:
   ```bash
   cp .env.example .env
   # generate a session secret with: openssl rand -base64 48
   ```
4. Install and start:
   ```bash
   npm install
   npm start
   ```
5. Visit http://localhost:3000. The API health check is http://localhost:3000/api/health.

The server creates the `users`, `profiles`, `app_state`, and `user_sessions` tables automatically at startup. It does not create the PostgreSQL database itself.

### Run locally without installing PostgreSQL

For local development on a supported platform, install the npm dependencies and run:

```bash
npm install
npm run start:local
```

This starts a private PostgreSQL instance bound to `127.0.0.1:54320`, creates the `peerloop` database, and launches the app at http://localhost:3000. Local database files are stored in `.local/postgres` and persist between runs. Stop both services with Ctrl+C. This embedded database is for local development only; use a managed PostgreSQL database for deployment.

If an existing local data directory cannot be initialized, leave it untouched and start with a separate directory, for example `LOCAL_PG_DATA_DIR=.local/postgres-dev npm run start:local`.

## Deploy to Render

The included `render.yaml` Blueprint creates the Node.js web service and references the existing Render PostgreSQL service named `peerloop-db` in the same workspace. This deployment shares account and learning data with that database. Connect this repository in the Render Dashboard and choose **New + → Blueprint** to deploy it. To use an isolated database, add a separate PostgreSQL instance and update the Blueprint; Render's free PostgreSQL databases expire after 30 days, so use a paid plan for persistent production data.

## Accounts and roles
- Registration creates a `student` account by default.
- Passwords are hashed; plaintext passwords are never stored.
- The session cookie is HttpOnly and SameSite=Lax; it is Secure in production.
- Sessions are stored in PostgreSQL and survive server restarts.
- Admin-only requests re-check the user's current database role, so a role change takes effect for existing sessions.
- API responses are marked `Cache-Control: no-store`. The Content Security Policy restricts resources to this origin (plus embedded data images) and allows inline scripts/styles because the supplied interface is a single HTML document.
- To bootstrap the first administrator, set `ADMIN_EMAIL` in `.env` to the exact email address that will register. This bootstrap is not email verification: only enable it while registering the intended account, then remove or unset it. Do not expose this setting to untrusted users.
- Roles are `student`, `mentor`, and `admin`. Users cannot set their own role during registration.
- Admin-only role management is available through the API below.

## API routes

| Method | Route | Auth | Purpose |
|---|---|---|---|
| GET | `/api/health` | Public | API and database health |
| POST | `/api/auth/register` | Public, rate-limited | Create student account (or configured bootstrap admin) |
| POST | `/api/auth/login` | Public, rate-limited | Sign in and establish session |
| POST | `/api/auth/logout` | Session | Sign out and invalidate session |
| GET | `/api/auth/me` | Public | Current session user, or `null` |
| GET | `/api/profile` | Signed in | Read own profile |
| PATCH | `/api/profile` | Signed in | Update own profile |
| GET | `/api/state` | Signed in | Load the signed-in user's learning state |
| PUT | `/api/state` | Signed in | Save the signed-in user's learning state (max 900 KB) |
| GET | `/api/chat/:communityId/messages` | Signed in | Load the latest 60 messages for a community |
| POST | `/api/chat/:communityId/messages` | Signed in | Send a community message (1–300 characters) |
| GET | `/api/admin/users` | Admin | List up to 200 users |
| PATCH | `/api/admin/users/:id/role` | Admin | Set a user's role to `student`, `mentor`, or `admin` |

The learning state is scoped by authenticated user ID. One learner cannot read or overwrite another learner's state using the public API. Profile fields are separately validated and stored in the `profiles` table.

## Deployment notes

- Use a managed PostgreSQL database and set `DATABASE_URL` in the hosting provider's environment settings.
- Set `NODE_ENV=production`, `SESSION_SECRET`, and `PGSSL=true` if your database provider requires TLS with certificate verification.
- Deploy behind HTTPS. Secure cookies require HTTPS in production.
- Use persistent managed PostgreSQL backups and restrict database/network access.
- The included UI preserves the supplied demo's visual design. Guests can explore the interface, but only signed-in users sync learning state to PostgreSQL.

## Current boundaries

This is a functional account/profile/state backend, authenticated community chat, and role-protected admin API. Community chat uses short polling rather than a persistent real-time connection. Community membership and the community directory are browser-local/demo data; chat access is authenticated but membership is not managed server-side. DoubtBridge, peer sessions, challenges, roadmaps, and Skill Passport are currently client-side features whose signed-in state is backed up as opaque per-user JSON, not collaborative server-managed resources. The UI does not include a student/community leaderboard or an admin dashboard. Before a public launch, add automated tests, email verification, password reset, account deletion/export flows, and operational monitoring.
