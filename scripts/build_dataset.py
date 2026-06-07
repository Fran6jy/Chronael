"""Build a move-prediction dataset (.npz) from a player's PGN file."""

from __future__ import annotations

import argparse
import sys
import time
from pathlib import Path

# Allow running as a plain script: python scripts/build_dataset.py
sys.path.insert(0, str(Path(__file__).resolve().parent.parent))

from chronael.data import DatasetConfig, build_dataset  # noqa: E402


def main() -> int:
    parser = argparse.ArgumentParser(description="Build a Chronael move-prediction dataset.")
    parser.add_argument("--pgn", default="data/raw/Carlsen.pgn")
    parser.add_argument("--player", default="Carlsen")
    parser.add_argument("--out", default="data/processed/carlsen.npz")
    parser.add_argument("--min-year", type=int, default=None, help="Drop games before this year.")
    parser.add_argument("--min-elo", type=int, default=None, help="Drop games where the player was below this Elo.")
    parser.add_argument("--max-games", type=int, default=None, help="Cap number of games (quick tests).")
    parser.add_argument("--skip-opening-plies", type=int, default=0)
    args = parser.parse_args()

    config = DatasetConfig(
        player=args.player,
        min_year=args.min_year,
        min_player_elo=args.min_elo,
        max_games=args.max_games,
        skip_opening_plies=args.skip_opening_plies,
    )

    t0 = time.time()
    dataset = build_dataset(args.pgn, config)
    dataset.save(args.out)
    dt = time.time() - t0

    print(f"Built dataset in {dt:.1f}s")
    print(f"  samples : {dataset.meta['num_samples']:,}")
    print(f"  games   : {dataset.meta['num_games']:,}")
    print(f"  X shape : {dataset.X.shape}  dtype={dataset.X.dtype}")
    print(f"  saved   : {args.out}")
    return 0


if __name__ == "__main__":
    sys.exit(main())
