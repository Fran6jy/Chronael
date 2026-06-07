// Client-side coaching logic.
//
// Stockfish provides the judgment (evaluations, best moves); this module turns a
// centipawn swing into a move rating, gives an instant offline tip (Tier 0), and -
// only for genuine mistakes - asks the server proxy for a friendly natural-language
// explanation (Tier 1). If the proxy is unavailable, Tier 0 still works.

import { Chess, type Square } from "chess.js";

export type MoveRating = "great" | "good" | "inaccuracy" | "mistake" | "blunder";

// Facts are pre-translated to plain English so the model (and the offline tier)
// never has to print chess notation.
export interface CoachFacts {
  movedPlain: string; // what the player did, in words
  classification: MoveRating;
  bestPlain?: string; // a better move, in words
  threatPlain?: string; // what the opponent can do now, in words
  followup?: boolean; // true = learner asked "why?"; reply with one extra lesson sentence
}

const PIECE_NAMES: Record<string, string> = {
  p: "pawn",
  n: "knight",
  b: "bishop",
  r: "rook",
  q: "queen",
  k: "king",
};

/**
 * Translate a move (UCI like "g1f3") into a warm, plain-English phrase with NO
 * notation or square codes — e.g. "the bishop captures the knight", "castle the
 * king to safety", "move the knight, giving check". chess.js gives us the exact
 * facts (piece, capture, castle, promotion, check), so this is reliable, not guessed.
 */
export function describeMove(fenBefore: string, uci: string): string {
  try {
    const board = new Chess(fenBefore);
    const mv = board.move({
      from: uci.slice(0, 2) as Square,
      to: uci.slice(2, 4) as Square,
      promotion: (uci[4] as "q" | "r" | "b" | "n") || undefined,
    });
    if (!mv) return "make that move";

    if (mv.flags.includes("k")) return "castle the king to safety on the short side";
    if (mv.flags.includes("q")) return "castle the king to safety on the long side";

    const piece = PIECE_NAMES[mv.piece] ?? "piece";
    let phrase = mv.captured
      ? `the ${piece} captures the ${PIECE_NAMES[mv.captured] ?? "piece"}`
      : `move the ${piece}`;

    if (mv.promotion) phrase += `, turning the pawn into a ${PIECE_NAMES[mv.promotion]}`;
    if (mv.san.includes("#")) phrase += " — checkmate";
    else if (mv.san.includes("+")) phrase += ", giving check";
    return phrase;
  } catch {
    return "make that move";
  }
}

/** Classify by centipawns lost relative to the best move, from the mover's view. */
export function classify(centipawnLoss: number): MoveRating {
  if (centipawnLoss >= 300) return "blunder";
  if (centipawnLoss >= 150) return "mistake";
  if (centipawnLoss >= 70) return "inaccuracy";
  if (centipawnLoss <= 10) return "great";
  return "good";
}

const TIER0: Record<MoveRating, string> = {
  great: "Great move! That's the kind of move the engine likes best.",
  good: "Good move — solid and safe.",
  inaccuracy: "Slight inaccuracy. There was a touch better, but you're fine.",
  mistake: "That's a mistake — it gives your opponent an edge. Take a look at a better idea.",
  blunder: "Careful — that's a blunder and loses material or the game. Try taking it back.",
};

export function tier0Message(rating: MoveRating, bestPlain?: string): string {
  const base = TIER0[rating];
  if ((rating === "mistake" || rating === "blunder") && bestPlain) {
    return `${base} A stronger idea was to ${bestPlain}.`;
  }
  return base;
}

export function ratingLabel(rating: MoveRating): string {
  // The coloured dot (CSS ::before) is the visual indicator — no emoji icon.
  return `${rating[0].toUpperCase()}${rating.slice(1)}`;
}

/** Ask the server proxy for a friendly explanation. Returns null on any failure. */
export async function explain(facts: CoachFacts): Promise<string | null> {
  try {
    const resp = await fetch("/api/coach", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(facts),
    });
    if (!resp.ok) return null;
    const data = (await resp.json()) as { text?: string };
    return data.text ?? null;
  } catch {
    return null;
  }
}

/** Follow-up when the learner taps "Tell me more": one extra plain-English lesson. */
export function explainMore(facts: CoachFacts): Promise<string | null> {
  return explain({ ...facts, followup: true });
}
