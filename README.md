# Admission Tracker

A focused tracker for official **2026–27 undergraduate admission circulars** in Bangladesh.

## Run locally

Requires Node.js 20 or newer.

```bash
npm install
npm start
```

Open <http://localhost:3000>.

## What the tracker does

- Scans configured official university and admission-cluster pages.
- Lists a link only when nearby page text identifies the 2026–27 session, undergraduate admission, and circular/admission context.
- Filters results, scholarship announcements, and unrelated notices.
- Displays each configured university's official notice/admission links when no matching circular is detected, even if other universities have results.
- Links to the UGC Bangladesh public university and university directories for finding recognized institutions not yet configured in the tracker.
- Checks on startup and every 30 minutes. `CHECK_INTERVAL_MINUTES` accepts values from 5 to 59.
- Stores circular history in `data/circulars.json`; set `DATA_DIR` to persistent storage when deploying.

## Coverage and verification

The current automatic scanner covers the configured universities and admission clusters in `server.js`; it does **not yet automatically scan every university in the UGC directories**. The official UGC directory links are provided for broader coverage. Automated detection may miss an announcement when a university blocks the checker, changes its page layout, or does not mention the session/undergraduate status near the link. Verify notices on the official source page.

## Render

Use `npm install` as the build command and `npm start` as the start command. Attach a persistent disk and set `DATA_DIR` to the disk's mount path to retain discovered circulars across restarts.
