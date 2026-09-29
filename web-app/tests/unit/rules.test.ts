import { beforeEach, describe, expect, it } from "vitest";

import { explainIllegal } from "../../src/rules";
import { CLEAN_TO_MASTER, PEEKS_TO_RELAPSE, isMastered, markTested, recordIllegal, recordLegal, recordPeek, resetMasteryCache } from "../../src/mastery";

const START = "rnbqkbnr/pppppppp/8/8/8/8/PPPPPPPP/RNBQKBNR w KQkq - 0 1";

describe("explainIllegal", () => {
  it("returns null for legal moves", () => {
    expect(explainIllegal(START, "g1", "f3")).toBeNull();
    expect(explainIllegal(START, "e2", "e4")).toBeNull();
  });
  it("names the piece's rule for a wrong shape", () => {
    expect(explainIllegal(START, "g1", "g3")).toContain("L");
    expect(explainIllegal("4k3/8/8/8/3B4/8/8/4K3 w - - 0 1", "d4", "d6")).toContain("diagonally");
  });
  it("spots blockers, own pieces, and pawn captures", () => {
    expect(explainIllegal(START, "f1", "c4")).toContain("in the way");
    expect(explainIllegal(START, "d1", "d2")).toContain("own piece");
    expect(explainIllegal(START, "e2", "d3")).toContain("diagonally when they capture");
  });
  it("explains king safety", () => {
    // White king e1 in check from the rook on e8: moving the knight doesn't help.
    expect(explainIllegal("4r1k1/8/8/8/8/8/8/1N2K3 w - - 0 1", "b1", "c3")).toContain("in check");
    // Pinned knight: moving it would expose the king.
    expect(explainIllegal("4r1k1/8/8/8/8/8/4N3/4K3 w - - 0 1", "e2", "c3")).toContain("leave your king in check");
  });
});

describe("dots mastery", () => {
  beforeEach(() => {
    try {
      localStorage.clear();
    } catch {
      /* node without localStorage: mastery falls back to memory */
    }
    resetMasteryCache();
  });
  it("switches off after enough clean moves, and illegal tries set it back", () => {
    for (let i = 0; i < CLEAN_TO_MASTER - 1; i++) recordLegal("n");
    expect(isMastered("n")).toBe(false);
    recordIllegal("n");
    recordLegal("n");
    expect(isMastered("n")).toBe(false);
    for (let i = 0; i < 3; i++) recordLegal("n");
    expect(isMastered("n")).toBe(true);
  });
  it("a passed test masters it; too many peeks bring the dots back", () => {
    markTested("b");
    expect(isMastered("b")).toBe(true);
    for (let i = 0; i < PEEKS_TO_RELAPSE - 1; i++) expect(recordPeek("b")).toBe(false);
    expect(recordPeek("b")).toBe(true);
    expect(isMastered("b")).toBe(false);
  });
});
