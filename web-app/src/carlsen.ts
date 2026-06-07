// The "Magnus bot": the trained Carlsen policy net (int8 ONNX) running in the browser
// via onnxruntime-web. Like the coach engine, it scores only the legal moves, so it
// can never play an illegal move. onnxruntime-web is dynamically imported so this
// ~big dependency and the 24 MB model only load when the player actually picks it.

import type { Chess } from "chess.js";
import { encodePlanes, legalMoveIndices, NUM_PLANES, type LegalMove } from "./encoding";

// Match the installed onnxruntime-web version so the wasm runtime is served from a CDN
// (keeps Vite config simple; the Magnus bot is an opt-in online feature anyway).
const WASM_CDN = "https://cdn.jsdelivr.net/npm/onnxruntime-web@1.26.0/dist/";
const MODEL_URL = "models/chronael.int8.onnx";

interface Scored {
  move: LegalMove;
  probability: number;
}

export class CarlsenEngine {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  private ort: any = null;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  private session: any = null;
  private loadingPromise: Promise<void> | null = null;

  get ready(): boolean {
    return this.session !== null;
  }

  load(): Promise<void> {
    if (this.session) return Promise.resolve();
    if (!this.loadingPromise) {
      this.loadingPromise = (async () => {
        const ort = await import("onnxruntime-web");
        ort.env.wasm.wasmPaths = WASM_CDN;
        const url = new URL(MODEL_URL, document.baseURI).href;
        this.session = await ort.InferenceSession.create(url, { executionProviders: ["wasm"] });
        this.ort = ort;
      })();
    }
    return this.loadingPromise;
  }

  private async legalProbabilities(chess: Chess): Promise<Scored[]> {
    await this.load();
    const planes = encodePlanes(chess.fen());
    const tensor = new this.ort.Tensor("float32", planes, [1, NUM_PLANES, 8, 8]);
    const output = await this.session.run({ planes: tensor });
    const logits = output.logits.data as Float32Array;

    const { moves, indices } = legalMoveIndices(chess);
    if (moves.length === 0) return [];

    const legal = indices.map((i) => logits[i]);
    const maxLogit = Math.max(...legal);
    let probs = legal.map((v) => Math.exp(v - maxLogit));
    const sum = probs.reduce((a, b) => a + b, 0);
    probs = probs.map((p) => p / sum);

    return moves
      .map((move, i) => ({ move, probability: probs[i] }))
      .sort((a, b) => b.probability - a.probability);
  }

  async rank(chess: Chess): Promise<Scored[]> {
    return this.legalProbabilities(chess);
  }

  /** Pick a move. temperature 0 = the most Carlsen-likely; higher adds human variety. */
  async selectMove(
    chess: Chess,
    opts: { temperature?: number; topK?: number; rng?: () => number } = {},
  ): Promise<LegalMove | null> {
    const { temperature = 0, topK = 5, rng = Math.random } = opts;
    const scored = await this.legalProbabilities(chess);
    if (scored.length === 0) return null;
    if (temperature <= 0) return scored[0].move;

    const pool = scored.slice(0, topK);
    const logits = pool.map((s) => Math.log(Math.max(s.probability, 1e-12)) / temperature);
    const maxL = Math.max(...logits);
    let pr = logits.map((v) => Math.exp(v - maxL));
    const s = pr.reduce((a, b) => a + b, 0);
    pr = pr.map((v) => v / s);

    let r = rng();
    for (let k = 0; k < pool.length; k++) {
      r -= pr[k];
      if (r <= 0) return pool[k].move;
    }
    return pool[0].move;
  }
}
