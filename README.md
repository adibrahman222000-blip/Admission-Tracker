# Admission Tracker

A minimal tracker for official university undergraduate admission notices in Bangladesh.

- The feed detects circulars for the 2026–27 session from configured official university pages.
- Public/private and session filters apply to the notices and official-page fallback list. Currently, only 2026–27 is scanned; “All available sessions” means all circulars currently stored.
- Each configured source checks both its official notice and admission page. If a page is blocked or fails, the other is still checked and direct official links are displayed as fallback.
- UGC directory links help locate Bangladesh institutions not yet configured for automated monitoring; this project does not claim to monitor every institution yet.
- A translucent glass quote panel rotates its motivational quote every 45 seconds. Animations honor reduced-motion preferences.

The automated checker is best-effort: university websites may block requests or change layouts. Verify dates and notices on the official university site. Circular history is stored at `data/circulars.json`; set `DATA_DIR` to persistent storage if it must survive service restarts.

## Run and deploy

Run locally with Node.js 20+: `npm install` then `npm start`. On Render, use `npm install` as the build command and `npm start` as the start command. Free service filesystems are ephemeral, so cached circular history may be lost after a restart; the official links remain accessible.
