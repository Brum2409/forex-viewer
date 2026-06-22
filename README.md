# Ticker — Live Stocks & ETFs

A fast, mobile-first web app for viewing **live stock and ETF prices** with
interactive charts. Real market data, no API key required. Sign in with just a
**username** and your watchlist follows you to any device.

## Features

- **Username login** — no password, just pick a name; your watchlist syncs to
  the cloud and is restored anywhere you sign in
- **Discover** — a powerful screener over the whole market: one-tap quick picks
  (top gainers/losers, most active, large caps, best/worst 1-year performers)
  plus easy advanced filters by country, sector, company size, price,
  performance (today & 1-year), **valuation (max P/E)**, **dividend yield** and
  volume — sortable by gainers, value (lowest P/E), highest yield, and more
- **AI search helper** — describe what you want in plain English and the AI sets
  the filters for you, hand-picks from the current results for follow-ups
  ("only the ones under $100", "hide the Chinese companies", "rank these by
  value"), and can even **add picks to your watchlist** ("add the top 3").
  Powered by Google Gemini with your own free API key, a model picker, example
  prompts, and a clearable conversation
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
Most proxy [Yahoo Finance](https://finance.yahoo.com)'s public endpoints
(adding the required headers, sidestepping CORS, and failing over between
Yahoo's `query1`/`query2` hosts for reliability — no API key involved). The
account function stores each user's watchlist in **Vercel KV**.

| Endpoint | Purpose |
|----------|---------|
| `GET /api/quote?symbols=AAPL,MSFT` | Batch quotes + 5-day sparkline data |
| `GET /api/quote?symbol=AAPL&range=1y&interval=1d` | Full OHLC series for the chart |
| `GET /api/search?q=apple` | Symbol/company search |
| `POST /api/screen` | Screen all stocks/ETFs by filter spec (Discover) |
| `POST /api/ai` | AI helper: list Gemini models / generate filter & curation actions |
| `GET /api/account?user=alice` | Log in / create account, returns the watchlist |
| `PUT /api/account` | Save a user's watchlist (`{ user, watchlist }`) |

Quote/search/screen responses are cached at the edge for ~30s
(`stale-while-revalidate`) to keep things snappy and stay friendly to the
upstream source. Account responses are never cached.

### The screener (`/api/screen`)

Yahoo's screener API needs a `crumb` + cookie pair, so `/api/screen` performs
that handshake server-side (cached while the function stays warm) and translates
a friendly filter spec into a Yahoo query. The browser just POSTs something like:

```json
{
  "type": "stocks",
  "region": "us",
  "sector": "Technology",
  "marketCapMin": 10000000000,
  "yearChangeMin": 20,
  "sort": "yeargainers",
  "size": 50,
  "offset": 0
}
```

and gets back a normalized `{ quotes, total, offset, size }`. Filtering runs
across Yahoo's whole universe, so paging uses `offset` for "Load more".

### The AI helper (`/api/ai`)

The AI search box turns natural language into screener actions. `/api/ai` is a
thin proxy to the [Google Gemini API](https://ai.google.dev/):

- `POST { action: "models" }` → the Gemini models that support `generateContent`
  (used to populate the model picker in **AI settings**).
- `POST { action: "generate", model, systemInstruction, contents, responseSchema }`
  → a Gemini chat completion.

The browser builds a system prompt describing every filter (with allowed values),
the current filter state, and a compact snapshot of the stocks currently on
screen (price, today/1-year change, market cap, P/E, dividend yield, volume,
exchange, region). Gemini replies with **structured JSON** (enforced via
`responseSchema`) choosing one of:

- **filter** — a complete new filter set; the app applies it to the form and
  re-runs the screener across the whole market.
- **curate** — an ordered subset of the *currently loaded* symbols; the app
  hand-picks/hides results client-side (great for follow-ups the screener can't
  express). A "Show all" chip clears the selection.
- **none** — just a reply / clarifying question.

Any reply may also include **addToWatchlist** (a list of tickers) so the AI can
add picks to your watchlist on request. Thinking-capable Flash models are run
with a zero thinking budget for fast, reliable JSON; the request also caps
output tokens so longer curation lists aren't truncated.

**API key:** get a free one at
[aistudio.google.com/apikey](https://aistudio.google.com/apikey) and paste it
into **AI settings** (⚙︎) — it's stored only in your browser and sent with each
request. Alternatively the deployer can set a shared `GEMINI_API_KEY` environment
variable in Vercel; the user's own key always takes precedence. Without either,
`/api/ai` returns `503` and the UI prompts for a key.

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
  screen.js    # serverless: market screener / discovery (Yahoo proxy)
  ai.js        # serverless: Google Gemini proxy for the AI search helper
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
