import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { Chess } from "chess.js";

import { gameAccuracy, moveAccuracy, nextReview, updateRating, winPct, INTERVALS } from "../../src/progress";
import { UNITS } from "../../src/lessons";

describe("accuracy", () => {
  it("win% is 50 at equality and symmetric", () => {
    expect(winPct(0)).toBeCloseTo(50);
    expect(winPct(300) + winPct(-300)).toBeCloseTo(100);
  });
  it("a perfect move is ~100, a blunder is low", () => {
    expect(moveAccuracy(50, 50)).toBeGreaterThan(99);
    expect(moveAccuracy(200, -400)).toBeLessThan(20);
  });
  it("one blunder drags a game's accuracy down", () => {
    const clean = Array.from({ length: 20 }, () => ({ before: 30, after: 25 }));
    const withBlunder = [...clean, { before: 30, after: -600 }];
    expect(gameAccuracy(clean)!).toBeGreaterThan(95);
    expect(gameAccuracy(withBlunder)!).toBeLessThan(gameAccuracy(clean)! - 3);
    expect(gameAccuracy([])).toBeNull();
  });
});

describe("adaptive rating", () => {
  it("solving a harder puzzle gains more than an easier one", () => {
    const hard = updateRating(800, 1200, 1, 30) - 800;
    const easy = updateRating(800, 500, 1, 30) - 800;
    expect(hard).toBeGreaterThan(easy);
    expect(easy).toBeGreaterThanOrEqual(0);
  });
  it("moves faster while provisional", () => {
    expect(updateRating(800, 800, 1, 0) - 800).toBeGreaterThan(updateRating(800, 800, 1, 50) - 800);
  });
  it("never drops below 100", () => {
    expect(updateRating(110, 2500, 0, 0)).toBeGreaterThanOrEqual(100);
  });
});

describe("spaced repetition", () => {
  it("climbs boxes when right and falls back when wrong", () => {
    const now = 0;
    const r1 = nextReview(0, true, now);
    expect(r1.box).toBe(1);
    expect(r1.due).toBe(INTERVALS[1] * 86_400_000);
    expect(nextReview(4, false, now).box).toBe(1);
    expect(nextReview(INTERVALS.length - 1, true, now).box).toBe(INTERVALS.length - 1);
  });
});

describe("lesson drills", () => {
  for (const unit of UNITS) {
    for (const d of unit.drills) {
      it(`${d.id} is legal and self-consistent`, () => {
        const board = new Chess(d.fen);
        for (const uci of d.solution) {
          expect(board.move({ from: uci.slice(0, 2), to: uci.slice(2, 4), promotion: uci[4] || undefined }), uci).toBeTruthy();
        }
        if (/checkmate/i.test(d.goal)) expect(board.isCheckmate()).toBe(true);
        for (const alt of d.accept ?? []) {
          const b = new Chess(d.fen);
          expect(b.move({ from: alt.slice(0, 2), to: alt.slice(2, 4) }), alt).toBeTruthy();
        }
        if (d.accept) expect(d.accept).toContain(d.solution[0]);
      });
    }
  }
});

describe("puzzles-rated.json", () => {
  const data = JSON.parse(readFileSync(new URL("../../public/puzzles-rated.json", import.meta.url), "utf8")) as {
    rows: [string, string, string, string, number, string][];
  };
  it("spans beginner to expert and every line is legal", () => {
    const ratings = data.rows.map((r) => r[4]);
    expect(data.rows.length).toBeGreaterThan(2500);
    expect(Math.min(...ratings)).toBeLessThan(600);
    expect(Math.max(...ratings)).toBeGreaterThan(2300);
    for (const [id, fen, , sol] of data.rows) {
      const b = new Chess(fen);
      const moves = sol.split(" ");
      expect(moves.length % 2, id).toBe(1);
      for (const u of moves) expect(b.move({ from: u.slice(0, 2), to: u.slice(2, 4), promotion: u[4] || undefined }), `${id} ${u}`).toBeTruthy();
    }
  });
});
