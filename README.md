# Admission Tracker

A focused index of official university undergraduate admission circulars for the 2026–27 session.

## Run locally

Requires Node.js 20 or newer.

```bash
npm install
npm start
```

Open <http://localhost:3000>.

## What the tracker includes

- Links detected from configured official university notice/admission pages.
- A result is shown only when its link context includes the 2026–27 session, undergraduate admission language, and circular/admission terms.
- Results, scholarships, and unrelated notices are excluded.
- If no matching circular is found, the dashboard displays direct official notice and admission-page links for the selected university (or all universities).
- The checker runs on startup and every 30 minutes. Use `CHECK_INTERVAL_MINUTES` to set an interval from 5 to 59 minutes.
- Circular history is stored under `data/circulars.json`; set `DATA_DIR` to a persistent storage path when deploying.

Automated detection is heuristic: university pages may block the crawler, change layouts, or omit session details from link text. A missing result is not proof that no circular exists. Verify dates and notices on the official university page.

## Deploy on Render

Use `npm install` as the build command and `npm start` as the start command. Attach persistent storage and set `DATA_DIR` to its mount path if you need circular history to survive restarts.
