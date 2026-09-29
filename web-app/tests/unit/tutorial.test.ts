import { describe, expect, it } from "vitest";
import { Chess, type Square } from "chess.js";

import { PIECE_LESSONS } from "../../src/tutorial";

/** Fewest moves for the test piece to reach the target (opponent never moves). */
function distance(fen: string, from: Square, target: Square, limit = 4): number {
  let frontier: [string, Square][] = [[fen, from]];
  for (let depth = 1; depth <= limit; depth++) {
    const next: [string, Square][] = [];
    for (const [f, sq] of frontier) {
      const c = new Chess(f);
      for (const m of c.moves({ square: sq, verbose: true })) {
        if (m.to === target) return depth;
        const b = new Chess(f);
        b.move(m);
        const parts = b.fen().split(" ");
        parts[1] = "w";
        parts[3] = "-";
        next.push([parts.join(" "), m.to as Square]);
      }
    }
    frontier = next;
  }
  return Infinity;
}

describe("learn-the-pieces tests", () => {
  for (const l of PIECE_LESSONS) {
    it(`${l.name}: target is reachable in exactly ${l.test.maxMoves}`, () => {
      expect(new Chess(l.test.fen).get(l.test.from)?.type).toBe(l.piece === "knight" ? "n" : l.piece[0]);
      expect(distance(l.test.fen, l.test.from, l.test.target)).toBe(l.test.maxMoves);
    });
  }
});
