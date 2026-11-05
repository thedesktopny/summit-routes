# Summit Safety Routes (v2)

Delivery routes for Summit Safety: the office plans routes and the drivers follow them on their phones.

- **Office page:** `/admin`. You sign in with a PIN, which you create the first time you open it.
- **Driver page:** `/d/<private-link>`, in Spanish. Each driver has their own link, made in the Drivers tab.

## How it runs
- Cloudflare Workers, free plan. Every push to `main` on GitHub deploys automatically.
- **DB** (Cloudflare D1): drivers, customers, routes, stops, GPS points, settings. The tables are created automatically on the first visit.
- **FILES** (Cloudflare R2): proof photos.
- Nothing secret lives in the code. The PIN, the Mapbox key and the alert keys are saved in the database from the Settings page.

## Outside services
- **Mapbox** (key entered in Settings): real drive times, best stop order, and road lines on the map. It's free up to 100k requests a month.
- **US Census, then OpenStreetMap:** address lookup. Both are free, and results are cached.
- **OpenStreetMap:** map tiles.

## Files
- `src/index.js`: page and API routing
- `src/admin.js`: office sign-in and office API
- `src/driver.js`: driver API
- `src/routes.js`: best order, ETAs, route finished
- `src/geo.js`: address lookup, drive times, ordering math
- `src/push.js`: phone/computer alerts (Web Push)
- `src/lib.js`: shared helpers and the database tables
- `public/`: the office and driver pages
