"""Evaluate how human-like the model is via *move-match accuracy*.

For every held-out position where the target player moved, we check whether the
model's top move (and top-3) matches the move the player actually played. This is
the metric the Maia Chess papers use to quantify human-likeness; it is the number
that belongs in the thesis.
"""

from __future__ import annotations

from dataclasses import dataclass

import numpy as np
import torch

from .engine import ChronaelEngine
from .encoding import legal_move_indices  # noqa: F401 (kept for API symmetry)


@dataclass
class EvalResult:
    num_positions: int
    top1: float
    top3: float
    top5: float

    def __str__(self) -> str:
        return (
            f"positions={self.num_positions}  "
            f"top1={self.top1:.1%}  top3={self.top3:.1%}  top5={self.top5:.1%}"
        )


@torch.no_grad()
def move_match_accuracy(
    engine: ChronaelEngine,
    X: np.ndarray,
    y: np.ndarray,
    batch_size: int = 256,
) -> EvalResult:
    """Top-k accuracy of predicting the true (oriented) move index.

    Operates directly on encoded planes/labels for speed. Note: this scores against
    the full policy space rather than masking to legal moves, which is a slightly
    *harder* (lower-bound) measure of move-match - good enough and fast for tracking.
    """
    model = engine.model
    device = engine.device
    n = X.shape[0]
    top1 = top3 = top5 = 0

    for start in range(0, n, batch_size):
        xb = torch.from_numpy(X[start:start + batch_size].astype(np.float32)).to(device)
        yb = y[start:start + batch_size]
        logits = model(xb)
        topk = torch.topk(logits, k=5, dim=1).indices.cpu().numpy()
        for i, true_idx in enumerate(yb):
            preds = topk[i]
            if preds[0] == true_idx:
                top1 += 1
            if true_idx in preds[:3]:
                top3 += 1
            if true_idx in preds[:5]:
                top5 += 1

    return EvalResult(
        num_positions=n,
        top1=top1 / n if n else 0.0,
        top3=top3 / n if n else 0.0,
        top5=top5 / n if n else 0.0,
    )
