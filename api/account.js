// Vercel serverless function — username-only accounts + cloud watchlist sync.
//
//   GET  /api/account?user=alice   -> log in / create, returns the watchlist
//   PUT  /api/account  { user, watchlist:[...] }  -> save the watchlist
//
// There is no password: a username is simply a key under which your watchlist
// is stored, so you can pick up the same list on any device. Data lives in
// Vercel KV (Upstash Redis), reached over its REST API with no extra npm deps.
//
// Add the Vercel KV / Upstash integration to the project to enable sync; it
// injects one of these credential pairs as environment variables:
//   KV_REST_API_URL        + KV_REST_API_TOKEN          (Vercel KV)
//   UPSTASH_REDIS_REST_URL + UPSTASH_REDIS_REST_TOKEN   (Upstash direct)
//
// Without credentials the endpoint reports storage_unavailable (503) and the
// browser keeps the watchlist locally instead, so the app still works.

const REST_URL =
  process.env.KV_REST_API_URL || process.env.UPSTASH_REDIS_REST_URL || "";
const REST_TOKEN =
  process.env.KV_REST_API_TOKEN || process.env.UPSTASH_REDIS_REST_TOKEN || "";
const HAS_KV = Boolean(REST_URL && REST_TOKEN);

const DEFAULT_WATCHLIST = [
  "AAPL", "MSFT", "NVDA", "AMZN", "GOOGL", "TSLA", "META",
  "SPY", "QQQ", "VOO", "VTI",
];

const USERS_KEY = "ticker:users";
const userKey = (name) => `ticker:user:${name}`;

// Run a single Redis command via the Upstash REST API (JSON-array form).
async function redis(args) {
  const res = await fetch(REST_URL, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${REST_TOKEN}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify(args),
  });
  if (!res.ok) throw new Error(`KV request failed (${res.status})`);
  const json = await res.json();
  if (json.error) throw new Error(json.error);
  return json.result;
}

async function getRecord(name) {
  const raw = await redis(["GET", userKey(name)]);
  if (raw == null) return null;
  try {
    return typeof raw === "string" ? JSON.parse(raw) : raw;
  } catch {
    return null;
  }
}

async function putRecord(name, record) {
  await redis(["SET", userKey(name), JSON.stringify(record)]);
  await redis(["SADD", USERS_KEY, name]);
}

// Usernames: 2–24 chars, lowercase letters / digits / _ . - ; normalized lower.
function normalizeUser(raw) {
  const name = String(raw || "").trim().toLowerCase();
  return /^[a-z0-9_.-]{2,24}$/.test(name) ? name : null;
}

function cleanWatchlist(list) {
  if (!Array.isArray(list)) return null;
  const out = [];
  for (const s of list) {
    const sym = String(s || "").trim().toUpperCase();
    if (sym && /^[A-Z0-9.^=-]{1,15}$/.test(sym) && !out.includes(sym)) out.push(sym);
    if (out.length >= 100) break;
  }
  return out;
}

function safeParse(s) {
  try { return JSON.parse(s); } catch { return {}; }
}

export default async function handler(req, res) {
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Methods", "GET, PUT, OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type");
  res.setHeader("Cache-Control", "no-store");
  if (req.method === "OPTIONS") return res.status(204).end();

  if (!HAS_KV) {
    return res.status(503).json({
      error: "storage_unavailable",
      message: "Cloud sync is not configured; using this device only.",
    });
  }

  try {
    if (req.method === "GET") {
      const user = normalizeUser(req.query.user);
      if (!user) return res.status(400).json({ error: "invalid_username" });

      let record = await getRecord(user);
      const isNew = !record;
      if (isNew) {
        record = {
          user,
          watchlist: [...DEFAULT_WATCHLIST],
          createdAt: Date.now(),
          updatedAt: Date.now(),
        };
        await putRecord(user, record);
      }
      return res.status(200).json({
        user,
        watchlist: record.watchlist || [],
        isNew,
        updatedAt: record.updatedAt || null,
      });
    }

    if (req.method === "PUT") {
      const body =
        typeof req.body === "string" ? safeParse(req.body) : req.body || {};
      const user = normalizeUser(body.user);
      if (!user) return res.status(400).json({ error: "invalid_username" });

      const watchlist = cleanWatchlist(body.watchlist);
      if (watchlist == null)
        return res.status(400).json({ error: "invalid_watchlist" });

      const existing = await getRecord(user);
      const record = {
        user,
        watchlist,
        createdAt: existing?.createdAt || Date.now(),
        updatedAt: Date.now(),
      };
      await putRecord(user, record);
      return res.status(200).json({ user, watchlist, updatedAt: record.updatedAt });
    }

    return res.status(405).json({ error: "method_not_allowed" });
  } catch (err) {
    return res.status(502).json({ error: err.message || "storage_error" });
  }
}
