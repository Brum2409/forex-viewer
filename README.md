# Ticker — Live Stocks & ETFs

A fast, mobile-first web app for viewing **live stock and ETF prices** with
interactive charts. Real market data, no API key required. Sign in with just a
**username** and your watchlist follows you to any device.

## Features

- **Username login** — no password, just pick a name; your watchlist syncs to
  the cloud and is restored anywhere you sign in
- **Live prices** for stocks, ETFs, indices and mutual funds
- **Search** any ticker by symbol or company name (e.g. `AAPL`, `Tesla`, `VOO`)
- **Custom watchlist** — add/remove symbols, saved per account
- **Sparklines** on every card showing the recent trend
- **Interactive charts** with 1W / 1M / 6M / 1Y / 5Y ranges (powered by
  TradingView Lightweight Charts)
- **Auto-refresh** every 60 seconds, plus pull-to-refresh on focus
- **Dark theme**, installable as a PWA

## How it works

The app is a static front-end plus a few tiny **Vercel serverless functions**.
Two of them proxy [Yahoo Finance](https://finance.yahoo.com)'s public endpoints
(adding the required headers, sidestepping CORS, and failing over between
Yahoo's `query1`/`query2` hosts for reliability — no API key involved). A third
stores each user's watchlist in **Vercel KV**.

| Endpoint | Purpose |
|----------|---------|
| `GET /api/quote?symbols=AAPL,MSFT` | Batch quotes + 5-day sparkline data |
| `GET /api/quote?symbol=AAPL&range=1y&interval=1d` | Full OHLC series for the chart |
| `GET /api/search?q=apple` | Symbol/company search |
| `GET /api/account?user=alice` | Log in / create account, returns the watchlist |
| `PUT /api/account` | Save a user's watchlist (`{ user, watchlist }`) |

Quote/search responses are cached at the edge for ~30s
(`stale-while-revalidate`) to keep things snappy and stay friendly to the
upstream source. Account responses are never cached.

## Accounts & cloud sync

Logging in only needs a username — it's the key your watchlist is stored under,
so the same name loads the same list on any device. There's no password, so
treat it as lightweight sync rather than security.

Cloud sync is backed by **Vercel KV** (Upstash Redis). To enable it:

1. In the Vercel dashboard open **Storage → Create Database → KV** and connect
   it to this project (or add the Upstash Redis integration).
2. Vercel injects the credentials as environment variables automatically. The
   `/api/account` function looks for either pair:
   - `KV_REST_API_URL` + `KV_REST_API_TOKEN`, or
   - `UPSTASH_REDIS_REST_URL` + `UPSTASH_REDIS_REST_TOKEN`
3. Redeploy.

If no KV credentials are present, `/api/account` returns `503` and the front-end
falls back to storing each user's watchlist in `localStorage` on that device, so
the app keeps working — just without cross-device sync.

> Prices may be delayed. This is for informational purposes only and is **not
> investment advice**.

## Project structure

```
api/
  quote.js     # serverless: live quotes + chart history (Yahoo proxy)
  search.js    # serverless: symbol search (Yahoo proxy)
  account.js   # serverless: username login + watchlist sync (Vercel KV)
css/styles.css
js/app.js      # all front-end logic (auth + viewer)
index.html
vercel.json
manifest.json
```

## Deploy

This repo is wired to auto-deploy to Vercel. Vercel automatically detects the
`/api` directory as serverless functions and serves the rest as static files —
no build step required.

## Local development

```bash
npm i -g vercel
vercel dev     # runs the static site + serverless functions locally
```

A plain static server (`npx serve .`) will serve the UI but the `/api/*`
routes won't work without the Vercel dev runtime.
