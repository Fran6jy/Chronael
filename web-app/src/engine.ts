// Thin promise-based wrapper around the single-threaded Stockfish WASM worker.
//
// The "-single" build runs as a plain Web Worker (no SharedArrayBuffer / special
// COOP-COEP headers), communicating with UCI text lines. We turn NNUE off so the
// engine starts instantly with its classical evaluation - more than strong enough
// for a beginner opponent and it avoids downloading the 40 MB neural net.

export interface EngineLevel {
  /** Stockfish "Skill Level" (0-20). */
  skill: number;
  /** Thinking time per move, ms. */
  movetime: number;
  /** Probability of deliberately playing a random legal move (so beginners can win). */
  blunder: number;
  /** Human-facing label. */
  label: string;
}

// Eight rungs from "hangs pieces on purpose" up to "genuinely tough".
export const LEVELS: EngineLevel[] = [
  { skill: 0, movetime: 50, blunder: 0.55, label: "Beginner" },
  { skill: 1, movetime: 100, blunder: 0.4, label: "Very easy" },
  { skill: 2, movetime: 150, blunder: 0.28, label: "Easy" },
  { skill: 3, movetime: 250, blunder: 0.18, label: "Casual" },
  { skill: 5, movetime: 350, blunder: 0.1, label: "Improving" },
  { skill: 8, movetime: 500, blunder: 0.05, label: "Club" },
  { skill: 12, movetime: 800, blunder: 0.0, label: "Strong" },
  { skill: 20, movetime: 1200, blunder: 0.0, label: "Toughest" },
];

export class ChessEngine {
  private worker: Worker;
  private ready: Promise<void>;
  // The single worker can only run one search at a time, so all searches are queued.
  private chain: Promise<unknown> = Promise.resolve();

  constructor(workerUrl = "engine/stockfish-nnue-16-single.js") {
    // Resolve relative to the document so it works under any base path.
    this.worker = new Worker(new URL(workerUrl, document.baseURI));
    this.ready = this.init();
  }

  private send(cmd: string): void {
    this.worker.postMessage(cmd);
  }

  /** Run search tasks one at a time so their UCI output never interleaves. */
  private enqueue<T>(task: () => Promise<T>): Promise<T> {
    const result = this.chain.then(task, task);
    this.chain = result.catch(() => undefined);
    return result;
  }

  private init(): Promise<void> {
    return new Promise((resolve) => {
      const onMessage = (e: MessageEvent) => {
        const line = typeof e.data === "string" ? e.data : "";
        if (line === "uciok") {
          this.send("setoption name Use NNUE value false");
          this.send("isready");
        } else if (line === "readyok") {
          this.worker.removeEventListener("message", onMessage);
          resolve();
        }
      };
      this.worker.addEventListener("message", onMessage);
      this.send("uci");
    });
  }

  /**
   * Analyse a position at a fixed depth (independent of the opponent's strength).
   * Returns the evaluation from the SIDE-TO-MOVE's perspective and the best move.
   * `scoreCp` is in centipawns; `mateIn` is set instead when forced mate is seen.
   */
  async analyse(fen: string, depth = 12): Promise<{ scoreCp: number; mateIn: number | null; bestMove: string }> {
    await this.ready;
    return this.enqueue(() => new Promise((resolve) => {
      let scoreCp = 0;
      let mateIn: number | null = null;
      const onMessage = (e: MessageEvent) => {
        const line = typeof e.data === "string" ? e.data : "";
        if (line.startsWith("info") && line.includes("score")) {
          const cp = line.match(/score cp (-?\d+)/);
          const mate = line.match(/score mate (-?\d+)/);
          if (mate) {
            mateIn = parseInt(mate[1], 10);
            scoreCp = mateIn > 0 ? 100000 : -100000;
          } else if (cp) {
            scoreCp = parseInt(cp[1], 10);
            mateIn = null;
          }
        } else if (line.startsWith("bestmove")) {
          this.worker.removeEventListener("message", onMessage);
          resolve({ scoreCp, mateIn, bestMove: line.split(/\s+/)[1] });
        }
      };
      this.worker.addEventListener("message", onMessage);
      // Full strength for analysis, regardless of the chosen opponent level.
      this.send("setoption name Skill Level value 20");
      this.send(`position fen ${fen}`);
      this.send(`go depth ${depth}`);
    }));
  }

  /** Ask the engine for its best move (UCI string like "e2e4") in the given position. */
  async bestMove(fen: string, level: EngineLevel): Promise<string> {
    await this.ready;
    return this.enqueue(() => new Promise((resolve) => {
      const onMessage = (e: MessageEvent) => {
        const line = typeof e.data === "string" ? e.data : "";
        if (line.startsWith("bestmove")) {
          this.worker.removeEventListener("message", onMessage);
          resolve(line.split(/\s+/)[1]);
        }
      };
      this.worker.addEventListener("message", onMessage);
      this.send(`setoption name Skill Level value ${level.skill}`);
      this.send(`position fen ${fen}`);
      this.send(`go movetime ${level.movetime}`);
    }));
  }

  dispose(): void {
    this.worker.terminate();
  }
}
