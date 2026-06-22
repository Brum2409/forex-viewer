// Vercel serverless function — thin proxy to the Google Gemini API.
//
//   POST /api/ai  { action: "models", apiKey? }
//       -> { models: [{ id, displayName, description }] } that support chat
//   POST /api/ai  { action: "generate", model, systemInstruction, contents,
//                   responseSchema?, temperature?, apiKey? }
//       -> { text, usage }   (text is the model's reply, JSON when a schema is set)
//
// The key is taken from the request (the user's own AI Studio key, kept in their
// browser) or falls back to the GEMINI_API_KEY env var if the deployer set one.
// Get a free key at https://aistudio.google.com/apikey.

const GEMINI_BASE = "https://generativelanguage.googleapis.com/v1beta";

function resolveKey(body) {
  const fromUser = typeof body.apiKey === "string" ? body.apiKey.trim() : "";
  return fromUser || process.env.GEMINI_API_KEY || "";
}

async function listModels(key) {
  const r = await fetch(`${GEMINI_BASE}/models?key=${encodeURIComponent(key)}&pageSize=200`);
  const json = await r.json();
  if (!r.ok) throw new Error(json?.error?.message || `models ${r.status}`);

  const models = (json.models || [])
    .filter((m) => (m.supportedGenerationMethods || []).includes("generateContent"))
    .filter((m) => /gemini/i.test(m.name) && !/embedding|aqa|imagen|veo/i.test(m.name))
    .map((m) => ({
      id: m.name.replace(/^models\//, ""),
      displayName: m.displayName || m.name,
      description: m.description || "",
    }));
  return models;
}

async function generate(key, body) {
  const model = String(body.model || "gemini-2.5-flash").replace(/^models\//, "");
  const payload = {
    contents: body.contents || [],
  };
  if (body.systemInstruction) {
    payload.systemInstruction =
      typeof body.systemInstruction === "string"
        ? { parts: [{ text: body.systemInstruction }] }
        : body.systemInstruction;
  }
  const gc = {};
  if (body.responseSchema) {
    gc.responseMimeType = "application/json";
    gc.responseSchema = body.responseSchema;
  }
  if (typeof body.temperature === "number") gc.temperature = body.temperature;
  if (typeof body.maxOutputTokens === "number") gc.maxOutputTokens = body.maxOutputTokens;
  // Only sent for thinking-capable models (2.5/3); avoids tokens being spent on
  // reasoning instead of the JSON answer. Caller decides when to include it.
  if (typeof body.thinkingBudget === "number") gc.thinkingConfig = { thinkingBudget: body.thinkingBudget };
  if (Object.keys(gc).length) payload.generationConfig = gc;

  const r = await fetch(
    `${GEMINI_BASE}/models/${encodeURIComponent(model)}:generateContent?key=${encodeURIComponent(key)}`,
    {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(payload),
    }
  );
  const json = await r.json();
  if (!r.ok) throw new Error(json?.error?.message || `gemini ${r.status}`);

  const cand = json?.candidates?.[0];
  const text = (cand?.content?.parts || [])
    .map((p) => p.text || "")
    .join("")
    .trim();
  if (!text) {
    const reason = cand?.finishReason || json?.promptFeedback?.blockReason || "no_output";
    throw new Error(`empty_response (${reason})`);
  }
  return { text, usage: json.usageMetadata || null };
}

export default async function handler(req, res) {
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Methods", "POST, OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type");
  res.setHeader("Cache-Control", "no-store");
  if (req.method === "OPTIONS") return res.status(204).end();
  if (req.method !== "POST") return res.status(405).json({ error: "method_not_allowed" });

  const body = typeof req.body === "string" ? safeParse(req.body) : req.body || {};
  const key = resolveKey(body);
  if (!key) {
    return res.status(503).json({
      error: "no_api_key",
      message: "Add your Gemini API key in AI settings (free at aistudio.google.com/apikey).",
    });
  }

  try {
    if (body.action === "models") {
      const models = await listModels(key);
      return res.status(200).json({ models });
    }
    if (body.action === "generate") {
      const out = await generate(key, body);
      return res.status(200).json(out);
    }
    return res.status(400).json({ error: "unknown_action" });
  } catch (err) {
    const msg = err.message || "ai_error";
    // Surface auth/key problems distinctly so the UI can prompt for a new key.
    const isAuth = /api[_ ]?key|permission|unauthor|forbidden|401|403/i.test(msg);
    return res.status(isAuth ? 401 : 502).json({ error: msg });
  }
}

function safeParse(s) {
  try { return JSON.parse(s); } catch { return {}; }
}
