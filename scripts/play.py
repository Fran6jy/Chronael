"""Play a game against the trained Chronael model from the terminal.

Enter moves in UCI (e2e4) or SAN (Nf3). Type 'quit' to exit, 'undo' to take back.
"""

from __future__ import annotations

import argparse
import sys
from pathlib import Path

import chess

sys.path.insert(0, str(Path(__file__).resolve().parent.parent))

from chronael.engine import ChronaelEngine  # noqa: E402


def parse_move(board: chess.Board, text: str) -> chess.Move | None:
    text = text.strip()
    try:
        return board.parse_san(text)
    except ValueError:
        pass
    try:
        move = chess.Move.from_uci(text)
        if move in board.legal_moves:
            return move
    except ValueError:
        pass
    return None


def main() -> int:
    parser = argparse.ArgumentParser(description="Play against Chronael.")
    parser.add_argument("--model", default="models/chronael.pt")
    parser.add_argument("--color", choices=["white", "black"], default="white",
                        help="The colour YOU play.")
    parser.add_argument("--temperature", type=float, default=0.4,
                        help="0 = strongest/most predictable; higher = more variety.")
    parser.add_argument("--top-k", type=int, default=5)
    parser.add_argument("--show-thinking", action="store_true",
                        help="Print the model's top candidate moves each turn.")
    args = parser.parse_args()

    engine = ChronaelEngine.from_checkpoint(args.model)
    human = chess.WHITE if args.color == "white" else chess.BLACK
    board = chess.Board()

    print("Playing against Chronael. Enter moves as 'e2e4' or 'Nf3'. Commands: undo, quit.\n")
    print(board, "\n")

    while not board.is_game_over():
        if board.turn == human:
            text = input(f"Your move ({'White' if human else 'Black'}): ").strip()
            if text in {"quit", "exit"}:
                print("Goodbye.")
                return 0
            if text == "undo":
                if len(board.move_stack) >= 2:
                    board.pop(); board.pop()
                    print("\n" + str(board) + "\n")
                continue
            move = parse_move(board, text)
            if move is None:
                print("  Illegal or unparseable move, try again.")
                continue
        else:
            if args.show_thinking:
                top = engine.rank_moves(board)[:args.top_k]
                shown = ", ".join(f"{board.san(s.move)} {s.probability:.0%}" for s in top)
                print(f"  Chronael considers: {shown}")
            move = engine.select_move(board, temperature=args.temperature, top_k=args.top_k)
            print(f"Chronael plays: {board.san(move)}")

        board.push(move)
        print("\n" + str(board) + "\n")

    print(f"Game over: {board.result()} ({board.outcome().termination.name})")
    return 0


if __name__ == "__main__":
    sys.exit(main())
