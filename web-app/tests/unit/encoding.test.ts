// The browser model only works if the TS encoder matches chronael/encoding.py exactly.
// encoding.golden.json is produced by the Python encoder via
// `python web-app/scripts/make_encoding_golden.py`; these tests pin the TypeScript port to it.
import { describe, expect, it } from "vitest";
import { Chess } from "chess.js";

import { encodePlanes, legalMoveIndices, NUM_PLANES } from "../../src/encoding";
import golden from "./encoding.golden.json";

interface Case {
  fen: string;
  nonzero: number[];
  moves: [string, number][];
}

describe("encoding matches the Python reference", () => {
  for (const c of golden as Case[]) {
    it(`planes: ${c.fen}`, () => {
      const planes = encodePlanes(c.fen);
      expect(planes.length).toBe(NUM_PLANES * 64);
      const nz: number[] = [];
      planes.forEach((v, i) => {
        if (v !== 0) nz.push(i);
      });
      expect(nz).toEqual(c.nonzero);
    });

    it(`move indices: ${c.fen}`, () => {
      const { moves, indices } = legalMoveIndices(new Chess(c.fen));
      const got = moves
        .map((m, i) => [m.from + m.to + (m.promotion ?? ""), indices[i]] as [string, number])
        .sort((a, b) => (a[0] < b[0] ? -1 : a[0] > b[0] ? 1 : 0));
      expect(got).toEqual(c.moves);
    });
  }
});
