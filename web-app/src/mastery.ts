// Move dots fade out per piece as the learner proves they know it, so beginners end up
// playing like they would on a real board.
//
// A piece is MASTERED when its "learn the pieces" test is passed, or after enough clean
// moves with it in games. Illegal tries knock the count back. Peeking (press and hold)
// is fine now and then; peeking a lot at a mastered piece brings its dots back for a while.

export type PieceType = "p" | "n" | "b" | "r" | "q" | "k";

interface PieceStat {
  clean: number; // legal moves made with the dots off (or ever, before mastery)
  tested: boolean; // passed the tutorial test or a perfect board-vision drill
  peeks: number; // peeks since becoming mastered
}

export const CLEAN_TO_MASTER = 15;
export const PEEKS_TO_RELAPSE = 5;
const KEY = "chronael.mastery";
const TYPES: PieceType[] = ["p", "n", "b", "r", "q", "k"];

type Store = Record<PieceType, PieceStat>;

function blank(): Store {
  return Object.fromEntries(TYPES.map((t) => [t, { clean: 0, tested: false, peeks: 0 }])) as Store;
}

let store: Store | null = null;

function load(): Store {
  if (store) return store;
  store = blank();
  try {
    const raw = localStorage.getItem(KEY);
    if (raw) {
      const saved = JSON.parse(raw) as Partial<Store>;
      for (const t of TYPES) if (saved[t]) store[t] = { ...store[t], ...saved[t] };
    }
  } catch {
    /* private mode: in memory only */
  }
  return store;
}

function save(): void {
  try {
    localStorage.setItem(KEY, JSON.stringify(load()));
  } catch {
    /* ignore */
  }
}

export function isMastered(type: string): boolean {
  const s = load()[type as PieceType];
  return !!s && (s.tested || s.clean >= CLEAN_TO_MASTER);
}

/** A legal move made with this piece. Returns true if it just became mastered. */
export function recordLegal(type: string): boolean {
  const s = load()[type as PieceType];
  if (!s) return false;
  const before = isMastered(type);
  s.clean++;
  save();
  return !before && isMastered(type);
}

/** An illegal try (dots were off): knocks progress back a little. */
export function recordIllegal(type: string): void {
  const s = load()[type as PieceType];
  if (!s) return;
  s.clean = Math.max(0, s.clean - 3);
  save();
}

/** Passed a no-dots test for this piece. */
export function markTested(type: string): void {
  const s = load()[type as PieceType];
  if (!s) return;
  s.tested = true;
  s.clean = Math.max(s.clean, CLEAN_TO_MASTER);
  s.peeks = 0;
  save();
}

/** Peeked at a mastered piece. Returns true if that brought its dots back. */
export function recordPeek(type: string): boolean {
  const s = load()[type as PieceType];
  if (!s || !isMastered(type)) return false;
  s.peeks++;
  if (s.peeks >= PEEKS_TO_RELAPSE) {
    s.tested = false;
    s.clean = Math.floor(CLEAN_TO_MASTER / 2);
    s.peeks = 0;
    save();
    return true;
  }
  save();
  return false;
}

export function masterySummary(): { mastered: PieceType[]; progress: Record<PieceType, number> } {
  const s = load();
  const progress = Object.fromEntries(
    TYPES.map((t) => [t, isMastered(t) ? 1 : Math.min(1, s[t].clean / CLEAN_TO_MASTER)]),
  ) as Record<PieceType, number>;
  return { mastered: TYPES.filter(isMastered), progress };
}

/** For tests. */
export function resetMasteryCache(): void {
  store = null;
}
