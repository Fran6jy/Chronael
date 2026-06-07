// TypeScript port of chronael/encoding.py. MUST match it bit-for-bit, or the model
// receives garbage. Verified against the Python encoding (same planes, same move
// indices, same chosen moves) before shipping.
//
// Board is oriented so the side to move is always "White": when Black is to move we
// mirror vertically and swap colours (python-chess board.mirror()). Square indices
// follow python-chess: index = rank*8 + file, with rank 0 = rank 1, file 0 = file a.
// square_mirror(sq) = sq ^ 56 flips the rank.

import type { Chess } from "chess.js";

export const NUM_PLANES = 17;
export const POLICY_SIZE = 64 * 64 * 5; // 20480

const PIECE_TYPE: Record<string, number> = { p: 1, n: 2, b: 3, r: 4, q: 5, k: 6 };
const PROMO_CODE: Record<string, number> = { n: 1, b: 2, r: 3, q: 4 };

function squareIndex(sq: string): number {
  const file = sq.charCodeAt(0) - 97; // 'a' -> 0
  const rank = sq.charCodeAt(1) - 49; // '1' -> 0
  return rank * 8 + file;
}

/** Encode a FEN into the (17,8,8) planes, flattened as plane*64 + rank*8 + file. */
export function encodePlanes(fen: string): Float32Array {
  const [placement, turn, castling, ep] = fen.split(" ");
  const flipped = turn === "b";
  const planes = new Float32Array(NUM_PLANES * 64);

  // Piece placement: FEN lists rank 8 first (row 0) down to rank 1 (row 7).
  const rows = placement.split("/");
  for (let row = 0; row < 8; row++) {
    let file = 0;
    for (const ch of rows[row]) {
      if (ch >= "1" && ch <= "8") {
        file += ch.charCodeAt(0) - 48;
        continue;
      }
      const isWhite = ch === ch.toUpperCase();
      const t = PIECE_TYPE[ch.toLowerCase()];
      let rank = 7 - row; // python-chess rank (0 = rank 1)
      let colorWhite = isWhite;
      if (flipped) {
        rank = 7 - rank;
        colorWhite = !isWhite;
      }
      const plane = t - 1 + (colorWhite ? 0 : 6);
      planes[plane * 64 + rank * 8 + file] = 1;
      file++;
    }
  }

  // Castling rights, read as the side-to-move (White) after orientation.
  const wk = castling.includes("K");
  const wq = castling.includes("Q");
  const bk = castling.includes("k");
  const bq = castling.includes("q");
  const rights = flipped ? [bk, bq, wk, wq] : [wk, wq, bk, bq];
  rights.forEach((has, i) => {
    if (has) {
      const base = (12 + i) * 64;
      for (let s = 0; s < 64; s++) planes[base + s] = 1;
    }
  });

  // En-passant target square.
  if (ep && ep !== "-") {
    const file = ep.charCodeAt(0) - 97;
    let rank = ep.charCodeAt(1) - 49;
    if (flipped) rank = 7 - rank;
    planes[16 * 64 + rank * 8 + file] = 1;
  }

  return planes;
}

export interface LegalMove {
  from: string;
  to: string;
  promotion?: string;
}

/** Legal moves and their oriented-frame policy indices (to gather model logits). */
export function legalMoveIndices(chess: Chess): { moves: LegalMove[]; indices: number[] } {
  const flipped = chess.turn() === "b";
  const moves = chess.moves({ verbose: true }) as unknown as LegalMove[];
  const indices = moves.map((m) => {
    let from = squareIndex(m.from);
    let to = squareIndex(m.to);
    if (flipped) {
      from ^= 56; // square_mirror
      to ^= 56;
    }
    const code = m.promotion ? PROMO_CODE[m.promotion] ?? 0 : 0;
    return (from * 64 + to) * 5 + code;
  });
  return { moves, indices };
}
