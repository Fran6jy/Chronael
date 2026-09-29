// Why a move isn't legal, in plain English. Used when the move dots are off, so a wrong
// try becomes a small lesson instead of a silent snap-back.

import { Chess, type Square } from "chess.js";

const NAMES: Record<string, string> = { p: "pawn", n: "knight", b: "bishop", r: "rook", q: "queen", k: "king" };

export const PIECE_RULE: Record<string, string> = {
  p: "Pawns move straight forward (two squares on their first move) and capture one square diagonally forward.",
  n: "A knight moves in an L: two squares one way, then one square to the side.",
  b: "A bishop only moves diagonally.",
  r: "A rook moves in straight lines: along a row or a column.",
  q: "The queen moves in straight lines or diagonals, one direction per move.",
  k: "The king moves one square in any direction.",
};

const fileOf = (sq: string) => sq.charCodeAt(0) - 97;
const rankOf = (sq: string) => Number(sq[1]) - 1;
const sqAt = (f: number, r: number) => `${String.fromCharCode(97 + f)}${r + 1}` as Square;

/** Squares strictly between two squares on a line (empty list if not on a line). */
function between(from: string, to: string): Square[] {
  const df = Math.sign(fileOf(to) - fileOf(from));
  const dr = Math.sign(rankOf(to) - rankOf(from));
  const out: Square[] = [];
  let f = fileOf(from) + df;
  let r = rankOf(from) + dr;
  while (f !== fileOf(to) || r !== rankOf(to)) {
    out.push(sqAt(f, r));
    f += df;
    r += dr;
  }
  return out;
}

/** Does the move have the right SHAPE for this piece (ignoring blockers and checks)? */
export function rightShape(type: string, white: boolean, from: string, to: string, capture: boolean): boolean {
  const df = fileOf(to) - fileOf(from);
  const dr = rankOf(to) - rankOf(from);
  const adf = Math.abs(df);
  const adr = Math.abs(dr);
  switch (type) {
    case "n":
      return (adf === 1 && adr === 2) || (adf === 2 && adr === 1);
    case "b":
      return adf === adr && adf > 0;
    case "r":
      return (adf === 0) !== (adr === 0);
    case "q":
      return (adf === adr && adf > 0) || (adf === 0) !== (adr === 0);
    case "k":
      return Math.max(adf, adr) === 1 || (adr === 0 && adf === 2); // incl. castling
    case "p": {
      const dir = white ? 1 : -1;
      if (capture) return adf === 1 && dr === dir;
      const start = white ? 1 : 6;
      return df === 0 && (dr === dir || (dr === 2 * dir && rankOf(from) === start));
    }
    default:
      return false;
  }
}

/**
 * Explain why `from`→`to` is not a legal move in `fen`. Returns null if it IS legal.
 */
export function explainIllegal(fen: string, from: string, to: string): string | null {
  const chess = new Chess(fen);
  const piece = chess.get(from as Square);
  if (!piece || from === to) return null;
  const legal = chess.moves({ square: from as Square, verbose: true }).some((m) => m.to === to);
  if (legal) return null;

  const name = NAMES[piece.type];
  const target = chess.get(to as Square);
  if (target && target.color === piece.color) return "You can't capture your own piece.";

  const white = piece.color === "w";
  const capture = !!target || (piece.type === "p" && to === fen.split(" ")[3]);
  if (!rightShape(piece.type, white, from, to, capture)) {
    if (piece.type === "p" && !capture && fileOf(from) !== fileOf(to)) {
      return "Pawns only move diagonally when they capture something.";
    }
    if (piece.type === "p" && capture && fileOf(from) === fileOf(to)) {
      return "Pawns can't capture straight ahead. They capture one square diagonally.";
    }
    return `Not quite. ${PIECE_RULE[piece.type]}`;
  }

  if (piece.type === "k" && Math.abs(fileOf(to) - fileOf(from)) === 2) {
    return "You can only castle if the king and rook haven't moved, nothing is in between, and the king isn't in or passing through check.";
  }
  if (piece.type !== "n" && piece.type !== "k") {
    const blocked = between(from, to).some((s) => chess.get(s));
    if (blocked) return `Something is in the way. Only the knight can jump over pieces; the ${name} can't.`;
  }
  if (piece.type === "p" && Math.abs(rankOf(to) - rankOf(from)) === 2 && chess.get(between(from, to)[0])) {
    return "Something is in the way of your pawn.";
  }
  if (chess.inCheck()) return "Your king is in check. Your move must get it out of check.";
  return "That would leave your king in check, so it isn't allowed.";
}

export function pieceName(type: string): string {
  return NAMES[type] ?? "piece";
}
