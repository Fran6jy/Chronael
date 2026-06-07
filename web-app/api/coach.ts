// Production serverless function for POST /api/coach (Vercel / any Node function host).
//
// It mirrors the Vite dev middleware: it holds the OpenRouter key SERVER-SIDE (read
// from the host's environment variables — never bundled into the client) and reuses
// the same requestCoach() logic. Set OPENROUTER_API_KEY (and optionally COACH_MODELS)
// in your hosting dashboard.

import { requestCoach, type CoachFacts } from "../server/coach";

export default async function handler(
  req: { method?: string; body?: unknown },
  res: {
    status: (code: number) => { json: (body: unknown) => void; end: (body?: string) => void };
  },
): Promise<void> {
  if (req.method !== "POST") {
    res.status(405).end("Method Not Allowed");
    return;
  }
  try {
    const facts = (typeof req.body === "string" ? JSON.parse(req.body) : req.body) as CoachFacts;
    const result = await requestCoach(facts, {
      OPENROUTER_API_KEY: process.env.OPENROUTER_API_KEY,
      COACH_MODELS: process.env.COACH_MODELS,
    });
    res.status(result.status).json(result.body);
  } catch (e) {
    res.status(400).json({ error: (e as Error).message });
  }
}
