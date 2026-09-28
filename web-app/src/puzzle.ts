// Daily puzzle: one Lichess puzzle (CC0) per calendar day, the same for everyone, plus
// a solve streak kept in localStorage. Pure helpers here; the board flow lives in main.ts.

export interface Puzzle {
  id: string;
  fen: string; // solver to move (the setup move is already on the board)
  lastMove: string; // the opponent's setup move, uci — highlighted on the board
  solution: string[]; // uci; even indexes are the solver's moves, odd are the replies
  rating: number;
  theme: string;
  goal: string;
}

export interface StreakState {
  last: string | null; // YYYY-MM-DD of the last solved daily puzzle
  streak: number;
  best: number;
}

const STREAK_KEY = "chronael.puzzle";

/** Local calendar date as YYYY-MM-DD. */
export function dayKey(d = new Date()): string {
  const m = String(d.getMonth() + 1).padStart(2, "0");
  const day = String(d.getDate()).padStart(2, "0");
  return `${d.getFullYear()}-${m}-${day}`;
}

/** Whole days since 1970-01-01 for a YYYY-MM-DD key (timezone-independent). */
export function dayNumber(key: string): number {
  const [y, m, d] = key.split("-").map(Number);
  return Math.floor(Date.UTC(y, m - 1, d) / 86_400_000);
}

export function dailyIndex(key: string, count: number): number {
  if (count <= 0) return 0;
  return ((dayNumber(key) % count) + count) % count;
}

/** Streak after solving on `today`. Solving twice on one day changes nothing. */
export function nextStreak(prev: StreakState, today: string): StreakState {
  if (prev.last === today) return prev;
  const continued = prev.last !== null && dayNumber(today) - dayNumber(prev.last) === 1;
  const streak = continued ? prev.streak + 1 : 1;
  return { last: today, streak, best: Math.max(prev.best, streak) };
}

/** The streak to display today: it lapses if yesterday was missed. */
export function visibleStreak(s: StreakState, today: string): number {
  if (!s.last) return 0;
  return dayNumber(today) - dayNumber(s.last) <= 1 ? s.streak : 0;
}

export function loadStreak(): StreakState {
  try {
    const raw = localStorage.getItem(STREAK_KEY);
    if (raw) {
      const s = JSON.parse(raw) as Partial<StreakState>;
      return { last: s.last ?? null, streak: s.streak ?? 0, best: s.best ?? 0 };
    }
  } catch {
    /* ignore */
  }
  return { last: null, streak: 0, best: 0 };
}

export function saveStreak(s: StreakState): void {
  try {
    localStorage.setItem(STREAK_KEY, JSON.stringify(s));
  } catch {
    /* ignore */
  }
}

let cache: Puzzle[] | null = null;

export async function loadPuzzles(): Promise<Puzzle[]> {
  if (cache) return cache;
  const resp = await fetch(`${import.meta.env.BASE_URL}puzzles.json`);
  if (!resp.ok) throw new Error(`puzzles ${resp.status}`);
  const data = (await resp.json()) as { puzzles: Puzzle[] };
  cache = data.puzzles;
  return cache;
}

export const THEME_NAMES: Record<string, string> = {
  mateIn1: "Mate in one",
  mateIn2: "Mate in two",
  fork: "Fork",
  hangingPiece: "Free piece",
  pin: "Pin",
  skewer: "Skewer",
  backRankMate: "Back-rank mate",
  discoveredAttack: "Discovered attack",
  capturingDefender: "Remove the defender",
};
