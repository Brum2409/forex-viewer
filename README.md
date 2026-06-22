# Ticker — Live Stocks & ETFs

A fast, mobile-first web app for viewing **live stock and ETF prices** with
interactive charts. Real market data, no signup, no API key required.

## Features

- **Live prices** for stocks, ETFs, indices and mutual funds
- **Search** any ticker by symbol or company name (e.g. `AAPL`, `Tesla`, `VOO`)
- **Custom watchlist** — add/remove symbols, saved in your browser
- **Sparklines** on every card showing the recent trend
- **Interactive charts** with 1W / 1M / 6M / 1Y / 5Y ranges (powered by
  TradingView Lightweight Charts)
- **Auto-refresh** every 60 seconds, plus pull-to-refresh on focus
- **Dark theme**, installable as a PWA

## How it works

The app is a static front-end plus two tiny **Vercel serverless functions**
that proxy [Yahoo Finance](https://finance.yahoo.com)'s public endpoints. The
proxy is what makes this work in the browser: it adds the required headers and
sidesteps CORS, and no API key is involved.

| Endpoint | Purpose |
|----------|---------|
| `GET /api/quote?symbols=AAPL,MSFT` | Batch quotes + 5-day sparkline data |
| `GET /api/quote?symbol=AAPL&range=1y&interval=1d` | Full OHLC series for the chart |
| `GET /api/search?q=apple` | Symbol/company search |

Responses are cached at the edge for ~30s (`stale-while-revalidate`) to keep
things snappy and stay friendly to the upstream source.

> Prices may be delayed. This is for informational purposes only and is **not
> investment advice**.

## Project structure

```
api/
  quote.js     # serverless: live quotes + chart history
  search.js    # serverless: symbol search
css/styles.css
js/app.js      # all front-end logic
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
