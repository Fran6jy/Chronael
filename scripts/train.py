"""Train the Chronael policy network by imitation (predict the player's move).

Works on CPU for a quick smoke test and scales to a GPU by raising --channels /
--num-blocks / --batch-size. Train/validation is split by *game* so positions from
one game never appear in both sets - otherwise move-match accuracy is inflated.
"""

from __future__ import annotations

import argparse
import sys
import time
from pathlib import Path

import numpy as np
import torch
import torch.nn as nn
from torch.utils.data import DataLoader, TensorDataset

sys.path.insert(0, str(Path(__file__).resolve().parent.parent))

from chronael.data import BuiltDataset  # noqa: E402
from chronael.engine import ChronaelEngine  # noqa: E402
from chronael.evaluate import move_match_accuracy  # noqa: E402
from chronael.model import ChronaelNet, ModelConfig, save_checkpoint  # noqa: E402


def game_level_split(game_ids: np.ndarray, val_fraction: float, seed: int = 0):
    """Return boolean (train_mask, val_mask) splitting on whole games."""
    rng = np.random.default_rng(seed)
    unique = np.unique(game_ids)
    rng.shuffle(unique)
    n_val = max(1, int(len(unique) * val_fraction))
    val_games = set(unique[:n_val].tolist())
    val_mask = np.array([g in val_games for g in game_ids])
    return ~val_mask, val_mask


def main() -> int:
    parser = argparse.ArgumentParser(description="Train the Chronael policy network.")
    parser.add_argument("--data", default="data/processed/carlsen.npz")
    parser.add_argument("--out", default="models/chronael.pt")
    parser.add_argument("--epochs", type=int, default=10)
    parser.add_argument("--batch-size", type=int, default=256)
    parser.add_argument("--lr", type=float, default=1e-3)
    parser.add_argument("--weight-decay", type=float, default=1e-4)
    parser.add_argument("--channels", type=int, default=64)
    parser.add_argument("--num-blocks", type=int, default=5)
    parser.add_argument("--val-fraction", type=float, default=0.1)
    parser.add_argument("--max-samples", type=int, default=None, help="Subsample for quick tests.")
    parser.add_argument("--device", default="cuda" if torch.cuda.is_available() else "cpu")
    parser.add_argument("--seed", type=int, default=0)
    args = parser.parse_args()

    torch.manual_seed(args.seed)
    np.random.seed(args.seed)

    print(f"Loading dataset: {args.data}")
    ds = BuiltDataset.load(args.data)
    X, y, gids = ds.X, ds.y, ds.game_ids

    if args.max_samples is not None and X.shape[0] > args.max_samples:
        idx = np.random.default_rng(args.seed).choice(X.shape[0], args.max_samples, replace=False)
        X, y, gids = X[idx], y[idx], gids[idx]

    train_mask, val_mask = game_level_split(gids, args.val_fraction, args.seed)
    print(f"Samples: {X.shape[0]:,}  train={train_mask.sum():,}  val={val_mask.sum():,}  "
          f"(games: {len(np.unique(gids))})")

    device = args.device
    Xtr = torch.from_numpy(X[train_mask].astype(np.float32))
    ytr = torch.from_numpy(y[train_mask].astype(np.int64))
    train_loader = DataLoader(
        TensorDataset(Xtr, ytr), batch_size=args.batch_size, shuffle=True,
        num_workers=0, drop_last=False,
    )

    model = ChronaelNet(ModelConfig(channels=args.channels, num_blocks=args.num_blocks))
    model.to(device)
    print(f"Model parameters: {model.num_parameters():,}  device={device}")

    optimizer = torch.optim.AdamW(model.parameters(), lr=args.lr, weight_decay=args.weight_decay)
    criterion = nn.CrossEntropyLoss()
    engine = ChronaelEngine(model, device=device)

    Xva, yva = X[val_mask], y[val_mask]
    best_top1 = -1.0

    for epoch in range(1, args.epochs + 1):
        model.train()
        t0 = time.time()
        running = 0.0
        seen = 0
        for xb, yb in train_loader:
            xb, yb = xb.to(device), yb.to(device)
            optimizer.zero_grad()
            loss = criterion(model(xb), yb)
            loss.backward()
            optimizer.step()
            running += loss.item() * xb.size(0)
            seen += xb.size(0)

        model.eval()
        result = move_match_accuracy(engine, Xva, yva, batch_size=512)
        dt = time.time() - t0
        print(f"epoch {epoch:3d}/{args.epochs}  loss={running/seen:.4f}  "
              f"val[{result}]  ({dt:.1f}s)")

        if result.top1 > best_top1:
            best_top1 = result.top1
            Path(args.out).parent.mkdir(parents=True, exist_ok=True)
            save_checkpoint(args.out, model, extra={
                "player": ds.meta.get("player", "unknown"),
                "val_top1": result.top1,
                "val_top3": result.top3,
                "epoch": epoch,
            })

    print(f"Best val top-1 move-match: {best_top1:.1%}")
    print(f"Saved best checkpoint to {args.out}")
    return 0


if __name__ == "__main__":
    sys.exit(main())
