# FX Live — Forex Viewer

A mobile-first live forex exchange rate viewer hosted on GitHub Pages. : https://brum2409.github.io/forex-viewer/

## Features

- **28 currency pairs** across Majors, Euro Crosses, Sterling Crosses, Commodity Pairs, and Emerging Markets
- **Auto-refresh every 15 minutes** with countdown timer
- **1-day change** indicator with colour-coded percentage
- **7-day sparklines** on every pair card
- **Interactive charts** with 1W / 2W / 1M / 3M / 6M / 1Y period selectors
- **Swipe right** to close detail panel on mobile
- **PWA-ready** — installable as a home-screen app on iOS and Android
- **Dark theme** optimised for AMOLED displays
- **Search** across pair symbols and currency names

## Data Sources

| Data | Provider | Key required |
|------|----------|--------------|
| Live rates (refreshed hourly) | [Open Exchange Rates API](https://open.er-api.com) | No |
| Historical / charts | [Frankfurter.app](https://www.frankfurter.app) (ECB data) | No |
| Previous close (1D change) | Frankfurter.app | No |

> The live feed updates approximately every 60 minutes at the source.
> The app polls every 15 minutes to pick up changes as soon as they publish.

## Hosting on GitHub Pages

1. Push this branch to GitHub.
2. Go to **Settings → Pages**.
3. Set source to this branch, root `/`.
4. Site will be live at `https://<user>.github.io/<repo>/`.

## PWA Icons

Open `generate-icons.html` in a browser, download the two PNG files,
save them as `icon-192.png` and `icon-512.png` in the repo root,
then delete `generate-icons.html`.

## Local Development

```bash
npx serve .
# or
python3 -m http.server 8080
```
