# Admission Tracker

A focused index of official university undergraduate admission circulars for Bangladesh, for the 2026–27 session.

## Run locally

Requires Node.js 20 or newer.

```bash
npm install
npm start
```

Open <http://localhost:3000>.

## Features

- Scans configured official university notice pages for undergraduate 2026–27 admission circulars.
- Excludes results, scholarships, and unrelated notices.
- Shows official university notice/admission links when a matching circular is not detected.
- Links to UGC university directories for other Bangladeshi institutions.
- Rotates an encouragement quote every 45 seconds; includes lightweight animations and respects reduced-motion accessibility preferences.
- The checker runs on startup and every 30 minutes. Use `CHECK_INTERVAL_MINUTES` to choose an interval from 5 to 59 minutes.
- Circular history is stored under `data/circulars.json`; set `DATA_DIR` to persistent storage if history must survive service restarts.

Automated detection is heuristic. University sites may block automated requests, change page layouts, or omit session details from links. A missing result is not proof that no circular has been published. Verify notices on the official university website. The configured list does not yet include every institution in the UGC directory.

## Deploy on Render

Use `npm install` as the build command and `npm start` as the start command. Render can redeploy this branch from GitHub. On a free service the filesystem is ephemeral, so cached circular history may be lost after a restart; the official university links remain available.
