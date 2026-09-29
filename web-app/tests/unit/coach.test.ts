import { describe, expect, it } from "vitest";

import { classify, describeMove, flipTurn, hintFallback, tier0Message } from "../../src/coach";

const START = "rnbqkbnr/pppppppp/8/8/8/8/PPPPPPPP/RNBQKBNR w KQkq - 0 1";

describe("classify", () => {
  it.each([
    [0, "great"],
    [10, "great"],
    [11, "good"],
    [69, "good"],
    [70, "inaccuracy"],
    [150, "mistake"],
    [299, "mistake"],
    [300, "blunder"],
  ])("%i centipawns lost -> %s", (loss, rating) => {
    expect(classify(loss)).toBe(rating);
  });
});

describe("describeMove never leaks notation", () => {
  const cases: [string, string, string][] = [
    [START, "g1f3", "move the knight"],
    ["rnbqkbnr/ppp1pppp/8/3p4/4P3/8/PPPP1PPP/RNBQKBNR w KQkq - 0 2", "e4d5", "the pawn captures the pawn"],
    ["r3k2r/8/8/8/8/8/8/R3K2R w KQkq - 0 1", "e1g1", "castle the king to safety on the short side"],
    ["r3k2r/8/8/8/8/8/8/R3K2R w KQkq - 0 1", "e1c1", "castle the king to safety on the long side"],
    ["8/1P5k/8/8/8/8/8/K7 w - - 0 1", "b7b8q", "move the pawn, turning the pawn into a queen"],
    ["6k1/5ppp/8/8/8/8/8/R5K1 w - - 0 1", "a1a8", "move the rook — checkmate"],
    ["4k3/8/8/8/8/8/8/R3K3 w - - 0 1", "a1a8", "move the rook, giving check"],
  ];
  it.each(cases)("%s %s", (fen, uci, expected) => {
    const text = describeMove(fen, uci);
    expect(text).toBe(expected);
    expect(text).not.toMatch(/\b[a-h][1-8]\b|[NBRQK][a-h]?x?[a-h][1-8]|O-O/);
  });

  it("illegal input degrades gracefully", () => {
    expect(describeMove(START, "e2e5")).toBe("make that move");
  });
});

describe("tier0Message", () => {
  it("adds the better idea only for mistakes and blunders", () => {
    expect(tier0Message("blunder", "move the knight")).toContain("A stronger idea: move the knight");
    expect(tier0Message("good", "move the knight")).not.toContain("stronger");
  });
});

describe("hint explanation (offline)", () => {
  it("flipTurn swaps side to move and clears en passant", () => {
    expect(flipTurn("rnbqkbnr/pppp1ppp/8/4p3/4P3/8/PPPP1PPP/RNBQKBNR w KQkq e6 0 2")).toBe(
      "rnbqkbnr/pppp1ppp/8/4p3/4P3/8/PPPP1PPP/RNBQKBNR b KQkq - 0 2",
    );
  });
  it("explains a capture and a mate in plain words", () => {
    expect(hintFallback("rnbqkbnr/ppp1pppp/8/3p4/4P3/8/PPPP1PPP/RNBQKBNR w KQkq - 0 2", "e4d5")).toMatch(
      /^The pawn captures the pawn\. It wins material/,
    );
    expect(hintFallback("6k1/5ppp/8/8/8/8/8/R5K1 w - - 0 1", "a1a8")).toContain("ends the game");
  });
});
