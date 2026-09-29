// Learner progress, all in localStorage (no account needed):
//  - game history with accuracy and blunder counts (drives the dashboard + review),
//  - an adaptive puzzle rating (Elo-style, faster while provisional),
//  - "Your mistakes": the learner's own blunders, re-served with spaced repetition,
//  - lesson completion.
// Pure maths is exported separately so it can be unit tested.

// ---------- Maths ----------

/** Win chance (0-100) for the side with `cp` centipawns, Lichess's calibration. */
export function winPct(cp: number): number {
  const c = Math.max(-1000, Math.min(1000, cp));
  return 50 + 50 * (2 / (1 + Math.exp(-0.00368208 * c)) - 1);
}

/** Accuracy (0-100) of one move from the mover's eval before and after. */
export function moveAccuracy(cpBefore: number, cpAfter: number): number {
  const drop = Math.max(0, winPct(cpBefore) - winPct(cpAfter));
  const acc = 103.1668 * Math.exp(-0.04354 * drop) - 3.1669;
  return Math.max(0, Math.min(100, acc));
}

/** Game accuracy: mean of move accuracies (harmonic-leaning, so blunders hurt). */
export function gameAccuracy(moves: { before: number; after: number }[]): number | null {
  if (moves.length === 0) return null;
  const accs = moves.map((m) => moveAccuracy(m.before, m.after));
  const mean = accs.reduce((a, b) => a + b, 0) / accs.length;
  const harmonic = accs.length / accs.reduce((a, b) => a + 1 / Math.max(1, b), 0);
  return Math.round((mean + harmonic) / 2);
}

export const PROVISIONAL_GAMES = 15;

/** New rating after one result (1 win, 0 loss) against `opp`. */
export function updateRating(rating: number, opp: number, score: 0 | 1, played: number): number {
  const k = played < PROVISIONAL_GAMES ? 60 : 24;
  const expected = 1 / (1 + 10 ** ((opp - rating) / 400));
  return Math.round(Math.max(100, rating + k * (score - expected)));
}

// Spaced repetition (Leitner boxes). Box n is due again after INTERVALS[n] days.
export const INTERVALS = [0, 1, 3, 7, 14, 30, 60];
const DAY = 86_400_000;

export function nextReview(box: number, correct: boolean, now = Date.now()): { box: number; due: number } {
  const next = correct ? Math.min(box + 1, INTERVALS.length - 1) : 1;
  return { box: next, due: now + INTERVALS[next] * DAY };
}

// ---------- Storage ----------

export interface GameRecord {
  at: number;
  result: "win" | "loss" | "draw";
  opponent: "stockfish" | "magnus";
  level: number;
  color: "white" | "black";
  moves: number;
  accuracy: number | null;
  counts: Record<"great" | "good" | "inaccuracy" | "mistake" | "blunder", number>;
  phases?: Record<"opening" | "middlegame" | "endgame", number>; // mistakes+blunders by game phase
}

export interface MistakeCard {
  id: string;
  fen: string; // position before the mistake, learner to move
  best: string; // uci
  played: string; // uci
  loss: number; // centipawns lost
  box: number;
  due: number;
  added: number;
  reviews: number;
}

export interface ProgressState {
  games: GameRecord[];
  puzzleRating: number;
  puzzlesPlayed: number;
  ratingHistory: { at: number; r: number }[];
  solvedPuzzles: string[];
  deck: MistakeCard[];
  lessons: Record<string, number>; // drill id -> stars (1-3)
}

const KEY = "chronael.progress";
const MAX_GAMES = 200;
const MAX_DECK = 150;

function fresh(): ProgressState {
  return {
    games: [],
    puzzleRating: 800,
    puzzlesPlayed: 0,
    ratingHistory: [],
    solvedPuzzles: [],
    deck: [],
    lessons: {},
  };
}

let state: ProgressState | null = null;

export function progress(): ProgressState {
  if (state) return state;
  state = fresh();
  try {
    const raw = localStorage.getItem(KEY);
    if (raw) state = { ...state, ...(JSON.parse(raw) as Partial<ProgressState>) };
  } catch {
    /* private mode: keep in memory only */
  }
  return state;
}

function save(): void {
  try {
    localStorage.setItem(KEY, JSON.stringify(progress()));
  } catch {
    /* ignore */
  }
}

export function recordGame(g: GameRecord): void {
  const p = progress();
  p.games.push(g);
  if (p.games.length > MAX_GAMES) p.games.splice(0, p.games.length - MAX_GAMES);
  save();
}

/** Rate a puzzle attempt. Returns the rating change. */
export function recordPuzzle(id: string, puzzleRating: number, firstTry: boolean): number {
  const p = progress();
  const before = p.puzzleRating;
  p.puzzleRating = updateRating(before, puzzleRating, firstTry ? 1 : 0, p.puzzlesPlayed);
  p.puzzlesPlayed++;
  p.ratingHistory.push({ at: Date.now(), r: p.puzzleRating });
  if (p.ratingHistory.length > 400) p.ratingHistory.splice(0, p.ratingHistory.length - 400);
  if (!p.solvedPuzzles.includes(id)) p.solvedPuzzles.push(id);
  if (p.solvedPuzzles.length > 5000) p.solvedPuzzles.splice(0, 1000);
  save();
  return p.puzzleRating - before;
}

/** Add one of the learner's own mistakes to the review deck (deduplicated by position). */
export function addMistake(fen: string, best: string, played: string, loss: number): boolean {
  const p = progress();
  const key = fen.split(" ").slice(0, 4).join(" ");
  if (p.deck.some((c) => c.fen.split(" ").slice(0, 4).join(" ") === key)) return false;
  const now = Date.now();
  p.deck.push({ id: `${now.toString(36)}${Math.random().toString(36).slice(2, 6)}`, fen, best, played, loss, box: 0, due: now, added: now, reviews: 0 });
  if (p.deck.length > MAX_DECK) {
    // Drop the best-learned (highest box, oldest) cards first.
    p.deck.sort((a, b) => a.box - b.box || b.added - a.added);
    p.deck.length = MAX_DECK;
  }
  save();
  return true;
}

export function dueCards(now = Date.now()): MistakeCard[] {
  return progress()
    .deck.filter((c) => c.due <= now)
    .sort((a, b) => a.due - b.due);
}

export function reviewCard(id: string, correct: boolean): MistakeCard | null {
  const card = progress().deck.find((c) => c.id === id);
  if (!card) return null;
  Object.assign(card, nextReview(card.box, correct));
  card.reviews++;
  save();
  return card;
}

export function setLessonStars(id: string, stars: number): void {
  const p = progress();
  p.lessons[id] = Math.max(p.lessons[id] ?? 0, stars);
  save();
}
