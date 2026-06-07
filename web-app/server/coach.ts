// Server-side coach handler. Runs in Node (Vite dev middleware or a serverless
// function) - NEVER in the browser, because it holds the OpenRouter API key.
//
// It receives pre-computed facts (from Stockfish) and asks a free model to phrase a
// short, friendly explanation. The model never analyses chess itself; it only turns
// the given facts into words. Models are tried in order until one responds, because
// free endpoints are frequently rate-limited.

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

// The model's ONLY job is to phrase pre-computed facts warmly. It must speak like a
// kind human teacher to someone who has never played — so it must NOT echo chess
// notation, square codes, or numbers. The facts arrive already translated to plain
// words (e.g. "the bishop captures the knight"); the model just makes them friendly.
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

export interface CoachResult {
  status: number;
  body: { text?: string; model?: string; error?: string };
}

export async function requestCoach(facts: CoachFacts, env: CoachEnv): Promise<CoachResult> {
  const key = env.OPENROUTER_API_KEY;
  if (!key) {
    return { status: 503, body: { error: "no_api_key" } };
  }
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
      const data = (await resp.json()) as any;
      if (!resp.ok || data.error) {
        lastError = `${model}: ${data?.error?.message || resp.status}`;
        continue; // try the next model
      }
      const text: string | undefined = data?.choices?.[0]?.message?.content?.trim();
      if (text) {
        return { status: 200, body: { text, model } };
      }
      lastError = `${model}: empty_response`;
    } catch (e) {
      lastError = `${model}: ${(e as Error).message}`;
    }
  }
  return { status: 502, body: { error: lastError } };
}
