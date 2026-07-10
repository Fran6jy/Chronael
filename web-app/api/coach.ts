// Coach endpoint — runs SERVER-SIDE only (Vercel function in prod, Vite middleware in
// dev), so it can hold the OpenRouter key without ever exposing it to the browser.
//
// It receives facts that are ALREADY translated to plain English (from Stockfish +
// chess.js on the client) and asks a free model to phrase them warmly. The model never
// analyses chess itself. This file is self-contained (no relative imports) so it bundles
// cleanly as a serverless function; the dev middleware imports `requestCoach` from here.

// Minimal Node global typing (runs in Node; avoids a full @types/node dependency).
declare const process: { env: Record<string, string | undefined> };

export interface CoachFacts {
  movedPlain: string; // plain-English description of the move the player made
  classification: string; // blunder | mistake | inaccuracy | good | great
  bestPlain?: string; // plain-English description of a stronger move
  threatPlain?: string; // plain-English description of the opponent's strong reply
  followup?: boolean; // learner tapped "Tell me more" — give one extra lesson sentence
}

export interface CoachEnv {
  OPENROUTER_API_KEY?: string;
  COACH_MODELS?: string;
}

export interface CoachResult {
  status: number;
  body: { text?: string; model?: string; error?: string };
}

const SYSTEM = [
  "You are a warm, gentle chess coach talking to someone who has JUST learned how the pieces move.",
  "They do NOT understand chess notation, square codes, or numbers — so you must never use them.",
  "NEVER write things like 'Nf3', 'cxd5', 'Bxe5+', 'e4', 'O-O', 'Qd6', or any evaluation numbers.",
  "Speak only in everyday words: pawn, knight, bishop, rook, queen, king, and plain verbs like 'move', 'capture', 'take', 'give check', 'castle'.",
  "You are given facts that are ALREADY written in plain English. Rephrase them into 1-2 short, encouraging sentences.",
  "Use ONLY those facts — never invent a move, square, or detail that was not given.",
  "If the move was good, give brief warm praise. If it was a mistake, be kind and clearly say, in plain words, what to do instead.",
].join(" ");

function buildUserMessage(f: CoachFacts): string {
  const lines = [
    `What I just did: ${f.movedPlain}.`,
    `Overall that move was a: ${f.classification}.`,
  ];
  if (f.threatPlain) lines.push(`What my opponent can now do: ${f.threatPlain}.`);
  if (f.bestPlain) lines.push(`A better idea would have been to: ${f.bestPlain}.`);
  if (f.followup) {
    lines.push(
      "I just asked 'why?'. Do NOT repeat or restate what happened. Reply with ONLY one short, " +
        "NEW plain-English sentence: a simple general rule-of-thumb I can remember for next time. " +
        "No recap, no chess notation, no numbers.",
    );
  } else {
    lines.push("Now coach me warmly in 1-2 plain-English sentences — no chess notation, no numbers.");
  }
  return lines.join("\n");
}

/** Try each free model in turn (they rate-limit often) and return the first reply. */
export async function requestCoach(facts: CoachFacts, env: CoachEnv): Promise<CoachResult> {
  const key = env.OPENROUTER_API_KEY;
  if (!key) return { status: 503, body: { error: "no_api_key" } };

  const models = (env.COACH_MODELS || "google/gemma-4-31b-it:free")
    .split(",")
    .map((m) => m.trim())
    .filter(Boolean);

  const payloadBase = {
    messages: [
      { role: "system", content: SYSTEM },
      { role: "user", content: buildUserMessage(facts) },
    ],
    max_tokens: 120,
    temperature: 0.5,
  };

  let lastError = "all_models_failed";
  for (const model of models) {
    try {
      const resp = await fetch("https://openrouter.ai/api/v1/chat/completions", {
        method: "POST",
        headers: {
          Authorization: `Bearer ${key}`,
          "Content-Type": "application/json",
          "HTTP-Referer": "https://github.com/Fran6jy/Chronael",
          "X-Title": "Chronael Chess Coach",
        },
        body: JSON.stringify({ ...payloadBase, model }),
      });
      const data = (await resp.json()) as {
        error?: { message?: string };
        choices?: { message?: { content?: string } }[];
      };
      if (!resp.ok || data.error) {
        lastError = `${model}: ${data?.error?.message || resp.status}`;
        continue;
      }
      const text = data?.choices?.[0]?.message?.content?.trim();
      if (text) return { status: 200, body: { text, model } };
      lastError = `${model}: empty_response`;
    } catch (e) {
      lastError = `${model}: ${(e as Error).message}`;
    }
  }
  return { status: 502, body: { error: lastError } };
}

// Best-effort per-IP rate limit. This endpoint is an unauthenticated proxy to the
// OpenRouter key, so a bare minimum is worth having to protect the free-tier quota.
// It is in-memory per warm instance (not a shared store), so it caps a single client
// hammering one instance; for hard guarantees use Vercel KV / Upstash instead.
const WINDOW_MS = 60_000;
const MAX_PER_WINDOW = 20;
const hits = new Map<string, number[]>();

function rateLimited(ip: string): boolean {
  const now = Date.now();
  const recent = (hits.get(ip) ?? []).filter((t) => now - t < WINDOW_MS);
  recent.push(now);
  hits.set(ip, recent);
  if (hits.size > 5000) {
    for (const [k, v] of hits) if (v.every((t) => now - t >= WINDOW_MS)) hits.delete(k);
  }
  return recent.length > MAX_PER_WINDOW;
}

const RATINGS = new Set(["blunder", "mistake", "inaccuracy", "good", "great"]);

function isValidFacts(f: unknown): f is CoachFacts {
  if (!f || typeof f !== "object") return false;
  const o = f as Record<string, unknown>;
  const strOk = (v: unknown, max: number) => v === undefined || (typeof v === "string" && v.length <= max);
  if (typeof o.movedPlain !== "string" || o.movedPlain.length > 300) return false;
  if (typeof o.classification !== "string" || !RATINGS.has(o.classification)) return false;
  if (!strOk(o.bestPlain, 300) || !strOk(o.threatPlain, 300)) return false;
  if (o.followup !== undefined && typeof o.followup !== "boolean") return false;
  return true;
}

/** Vercel serverless handler for POST /api/coach. */
export default async function handler(
  req: {
    method?: string;
    body?: unknown;
    headers?: Record<string, string | string[] | undefined>;
  },
  res: {
    status: (code: number) => { json: (body: unknown) => void; end: (body?: string) => void };
  },
): Promise<void> {
  if (req.method !== "POST") {
    res.status(405).end("Method Not Allowed");
    return;
  }

  const fwd = req.headers?.["x-forwarded-for"];
  const ip = (Array.isArray(fwd) ? fwd[0] : fwd ?? "unknown").toString().split(",")[0].trim();
  if (rateLimited(ip)) {
    res.status(429).json({ error: "rate_limited" });
    return;
  }

  try {
    const facts = typeof req.body === "string" ? JSON.parse(req.body) : req.body;
    if (!isValidFacts(facts)) {
      res.status(400).json({ error: "bad_request" });
      return;
    }
    const result = await requestCoach(facts, {
      OPENROUTER_API_KEY: process.env.OPENROUTER_API_KEY,
      COACH_MODELS: process.env.COACH_MODELS,
    });
    res.status(result.status).json(result.body);
  } catch (e) {
    res.status(400).json({ error: (e as Error).message });
  }
}
