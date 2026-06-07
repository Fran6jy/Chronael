"""Report move-match accuracy of a trained Chronael model on a held-out split."""

from __future__ import annotations

import argparse
import sys
from pathlib import Path

import numpy as np

sys.path.insert(0, str(Path(__file__).resolve().parent.parent))

from chronael.data import BuiltDataset  # noqa: E402
from chronael.engine import ChronaelEngine  # noqa: E402
from chronael.evaluate import move_match_accuracy  # noqa: E402
from scripts.train import game_level_split  # noqa: E402


def main() -> int:
    parser = argparse.ArgumentParser(description="Evaluate Chronael move-match accuracy.")
    parser.add_argument("--data", default="data/processed/carlsen.npz")
    parser.add_argument("--model", default="models/chronael.pt")
    parser.add_argument("--val-fraction", type=float, default=0.1)
    parser.add_argument("--seed", type=int, default=0)
    args = parser.parse_args()

    ds = BuiltDataset.load(args.data)
    _, val_mask = game_level_split(ds.game_ids, args.val_fraction, args.seed)
    engine = ChronaelEngine.from_checkpoint(args.model)

    result = move_match_accuracy(engine, ds.X[val_mask], ds.y[val_mask])
    print(f"Player: {ds.meta.get('player', 'unknown')}")
    print(f"Held-out {result}")
    print("\nInterpretation: top-1 is how often the model reproduces the player's exact move.")
    print("For reference, the Maia papers report ~46-52% top-1 human move-match at their best.")
    return 0


if __name__ == "__main__":
    sys.exit(main())
