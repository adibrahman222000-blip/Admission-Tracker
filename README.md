# Admission Tracker

A university admission dashboard with official circular links, exam schedule countdowns, study timer, and individual student profiles.

## Run locally

Requires Node.js 20 or newer.

```bash
npm install
SESSION_SECRET="a-long-random-secret-at-least-32-characters" npm start
```

Open <http://localhost:3000>. Visit <http://localhost:3000/profile> to create an account or sign in. Each student's profile settings are stored in the local SQLite database under `data/` and are only accessible after signing in.

On Windows PowerShell, set the secret first:

```powershell
$env:SESSION_SECRET = "a-long-random-secret-at-least-32-characters"
npm start
```

## Production security setup

- Set `NODE_ENV=production` and a unique `SESSION_SECRET` of 32+ random characters in your host's secret/environment settings. HTTPS must be enabled in production because session cookies use the `Secure` flag.
- Provide persistent storage for `DATA_DIR`; it holds `users.sqlite` and `sessions.sqlite` (accounts, password hashes, sessions) and `circulars.json`.
- Never commit `.env`, databases, or secrets. Use a unique password; passwords are stored as bcrypt hashes.
- Registration and sign-in are rate-limited. Profile fields require a signed-in session. Session cookies are HttpOnly and SameSite=Lax; mutation requests require same-origin checks.
- Back up `DATA_DIR` securely. Do not store sensitive identity or financial data in student profiles.

Profile fields include display name, email, target university, personal exam date, and daily study goal. Public circular and university schedule APIs remain available without login.
