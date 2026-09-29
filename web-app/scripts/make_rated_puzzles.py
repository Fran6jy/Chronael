"""Build public/puzzles-rated.json from the Lichess puzzle database (CC0).

    curl -L -o lichess_db_puzzle.csv.zst https://database.lichess.org/lichess_db_puzzle.csv.zst
    python scripts/make_rated_puzzles.py lichess_db_puzzle.csv.zst

Keeps well-established, popular puzzles with short solutions, spread evenly over
ratings 400-2500 so the adaptive rating always has something at the learner's level.
Output rows: [id, fen (solver to move), setupMove, "solution uci ...", rating, theme].
"""
import csv
import io
import json
import random
import sys
from pathlib import Path

import chess
import zstandard

PER_BUCKET = 160
LO, HI, STEP = 400, 2500, 100
THEMES = [  # priority order: the first one a puzzle has is its label
    "mateIn1", "mateIn2", "mateIn3", "backRankMate", "smotheredMate", "fork", "pin", "skewer",
    "discoveredAttack", "doubleCheck", "hangingPiece", "trappedPiece", "capturingDefender",
    "deflection", "attraction", "sacrifice", "promotion", "advancedPawn", "endgame", "defensiveMove",
    "quietMove", "middlegame", "opening",
]


def main(path: str) -> None:
    random.seed(7)
    buckets: dict[int, list] = {b: [] for b in range(LO, HI, STEP)}
    seen = 0
    with open(path, "rb") as fh:
        reader = csv.reader(io.TextIOWrapper(zstandard.ZstdDecompressor().stream_reader(fh), encoding="utf-8"))
        header = next(reader)
        col = {name: i for i, name in enumerate(header)}
        for row in reader:
            seen += 1
            rating = int(row[col["Rating"]])
            b = (rating // STEP) * STEP
            if b not in buckets:
                continue
            if int(row[col["RatingDeviation"]]) > 80 or int(row[col["Popularity"]]) < 88:
                continue
            if int(row[col["NbPlays"]]) < 800:
                continue
            moves = row[col["Moves"]].split()
            if len(moves) > 7:
                continue
            themes = row[col["Themes"]].split()
            theme = next((t for t in THEMES if t in themes), None)
            if theme is None:
                continue
            bucket = buckets[b]
            # Keep a random subset as we go so the whole file is represented, not just its start.
            bucket.append((row[col["PuzzleId"]], row[col["FEN"]], moves, rating, theme))
            if len(bucket) > PER_BUCKET * 6:
                random.shuffle(bucket)
                del bucket[PER_BUCKET * 3 :]
    out = []
    for b, items in buckets.items():
        random.shuffle(items)
        for pid, fen, moves, rating, theme in items[:PER_BUCKET]:
            board = chess.Board(fen)
            board.push_uci(moves[0])
            start_fen = board.fen()
            for u in moves[1:]:
                assert chess.Move.from_uci(u) in board.legal_moves, (pid, u)
                board.push_uci(u)
            out.append([pid, start_fen, moves[0], " ".join(moves[1:]), rating, theme])
    out.sort(key=lambda r: r[4])
    target = Path(__file__).resolve().parent.parent / "public" / "puzzles-rated.json"
    target.write_text(json.dumps({"source": "Lichess puzzle database (CC0) https://database.lichess.org/#puzzles", "rows": out}, separators=(",", ":")))
    print(f"scanned {seen}, wrote {len(out)} puzzles ({target.stat().st_size // 1024} KB)")


if __name__ == "__main__":
    main(sys.argv[1])
