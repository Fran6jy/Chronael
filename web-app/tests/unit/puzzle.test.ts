import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { Chess } from "chess.js";

import { dailyIndex, dayNumber, nextStreak, visibleStreak, type Puzzle } from "../../src/puzzle";

describe("daily puzzle streak", () => {
  const empty = { last: null, streak: 0, best: 0 };

  it("starts, continues, and resets", () => {
    const d1 = nextStreak(empty, "2026-09-27");
    expect(d1).toEqual({ last: "2026-09-27", streak: 1, best: 1 });
    const d2 = nextStreak(d1, "2026-09-28");
    expect(d2.streak).toBe(2);
    expect(nextStreak(d2, "2026-09-28")).toBe(d2); // same day: no change
    const gap = nextStreak(d2, "2026-10-01");
    expect(gap).toEqual({ last: "2026-10-01", streak: 1, best: 2 });
  });

  it("crosses month and year boundaries", () => {
    expect(nextStreak({ last: "2026-12-31", streak: 4, best: 4 }, "2027-01-01").streak).toBe(5);
  });

  it("lapses in the display when a day is missed", () => {
    const s = { last: "2026-09-26", streak: 3, best: 3 };
    expect(visibleStreak(s, "2026-09-27")).toBe(3);
    expect(visibleStreak(s, "2026-09-28")).toBe(0);
  });

  it("picks one puzzle per day, cycling through the set", () => {
    expect(dayNumber("1970-01-02")).toBe(1);
    expect(dailyIndex("2026-09-28", 400)).toBe(dailyIndex("2026-09-28", 400));
    expect(dailyIndex("2026-09-29", 400)).toBe((dailyIndex("2026-09-28", 400) + 1) % 400);
  });
});

describe("puzzles.json", () => {
  const data = JSON.parse(readFileSync(new URL("../../public/puzzles.json", import.meta.url), "utf8")) as {
    puzzles: Puzzle[];
  };

  it("every solution line is legal from its position", () => {
    expect(data.puzzles.length).toBeGreaterThan(300);
    for (const p of data.puzzles) {
      const board = new Chess(p.fen);
      for (const uci of p.solution) {
        const mv = board.move({ from: uci.slice(0, 2), to: uci.slice(2, 4), promotion: uci[4] || undefined });
        expect(mv, `${p.id} ${uci}`).toBeTruthy();
      }
      expect(p.solution.length % 2, p.id).toBe(1); // ends on the solver's move
    }
  });
});
