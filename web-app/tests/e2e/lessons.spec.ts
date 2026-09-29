import { expect, test } from "@playwright/test";

// Every lesson drill is checked with the app's own Stockfish: each accepted answer must
// be (nearly) as good as the engine's best, so the path never teaches a weak move.
test("lesson answers are engine-approved", async ({ page }, info) => {
  test.skip(info.project.name !== "desktop", "engine check runs once");
  test.setTimeout(240_000);
  await page.goto("/");
  const report = await page.evaluate(async () => {
    type Board = { move: (m: object) => unknown; fen: () => string; isCheckmate: () => boolean };
    type Drill = { id: string; fen: string; solution: string[]; accept?: string[] };
    const h = (window as unknown as {
      __chronael: {
        drills: Drill[];
        Chess: new (fen: string) => Board;
        engine: { analyse: (fen: string, depth?: number) => Promise<{ scoreCp: number }> };
      };
    }).__chronael;
    const out: string[] = [];
    for (const d of h.drills) {
      const best = (await h.engine.analyse(d.fen, 14)).scoreCp;
      for (const u of d.accept ?? [d.solution[0]]) {
        const board = new h.Chess(d.fen);
        board.move({ from: u.slice(0, 2), to: u.slice(2, 4), promotion: u[4] });
        const score = board.isCheckmate() ? 100000 : -(await h.engine.analyse(board.fen(), 14)).scoreCp;
        // Near-best, or still completely winning (both options win by miles).
        const ok = best >= 5000 ? score >= 5000 : best - score <= 80 || Math.min(best, score) >= 600;
        out.push(`${ok ? "ok " : "BAD"} ${d.id} ${u} best=${best} got=${score}`);
      }
    }
    return out;
  });
  console.log(report.join("\n"));
  expect(report.filter((l) => l.startsWith("BAD"))).toEqual([]);
});
