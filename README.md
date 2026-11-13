# Admission Tracker

A small dynamic admission-preparation website with a persistent study timer, exam countdown, official university links, and a Node.js service that periodically discovers circular/notice links.

## Run locally

Requires Node.js 20 or newer.

```bash
npm install
npm start
```

Open <http://localhost:3000>.

## Features

- Study timer and exam date are saved in the browser's local storage and survive refreshes/restarts on the same device/browser.
- The backend checks the configured university notice pages on startup and every 30 minutes (configurable with `CHECK_INTERVAL_MINUTES`, minimum 5).
- Discovered notice links are stored in `data/circulars.json`; duplicate URLs are ignored.
- `/api/sources`, `/api/circulars`, and `/api/status` provide JSON data. `POST /api/check-now` requests an immediate scan and is rate-limited.
- Browser notifications can alert while the site is open. Closed-tab push notifications require a service worker and VAPID push subscription setup, which is not included in this starter.

## Deploying

Deploy as a Node web service (for example, Render or Railway), with the start command `npm start`. Configure a persistent disk/volume and set `DATA_DIR` to its mount path so circular history survives redeploys. The timer and exam date are per-browser; browser local storage does not sync across devices.

## Notice checking limitations

The checker visits official pages and looks for same-site links whose text or URL resembles a notice, admission circular, exam, result, or scholarship. It respects a small response-size cap, timeout, and per-source sequential checking. University pages vary and may change, require JavaScript, block automated requests, or use different languages/layouts, so this generic discovery may miss notices or include irrelevant matching links. Official-page links remain available in the website for manual verification. Improve reliability by adding source-specific parsers or official RSS/API feeds where available. Do not treat this as an authoritative source; always verify the notice on the university's official site.

The configured sources include DU, RU, CU, JU, JnU, KU, BUP, BUET, CUET, RUET, KUET, BUTEX, MIST, the agricultural admission system, and the GST admission system. Admission portal addresses can change between sessions; review the source list in `server.js` if an official portal moves.
