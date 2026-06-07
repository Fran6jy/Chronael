"""Inference: turn the policy network into a move chooser that is *always legal*.

The network outputs logits over the whole move-index space. We gather only the
logits belonging to the current position's legal moves, softmax over those, and pick.
Because we never look outside the legal set, the engine can never play an illegal
move - eliminating the random-fallback behaviour of the old LLM server.
"""

from __future__ import annotations

from dataclasses import dataclass

import chess
import numpy as np
import torch

from .encoding import board_to_planes, move_to_index, orient, orient_move
from .model import ChronaelNet, load_checkpoint


@dataclass
class MoveScore:
    move: chess.Move
    probability: float


class ChronaelEngine:
    def __init__(self, model: ChronaelNet, device: str = "cpu"):
        self.model = model.to(device).eval()
        self.device = device

    @classmethod
    def from_checkpoint(cls, path: str, device: str = "cpu") -> "ChronaelEngine":
        model, _ = load_checkpoint(path, map_location=device)
        return cls(model, device=device)

    @torch.no_grad()
    def _legal_logits(self, board: chess.Board) -> tuple[list[chess.Move], np.ndarray]:
        """Return legal moves (real frame) and their logits from the network."""
        oriented, flipped = orient(board)
        planes = board_to_planes(oriented)
        tensor = torch.from_numpy(planes).unsqueeze(0).to(self.device)
        logits = self.model(tensor)[0].cpu().numpy()

        moves = list(board.legal_moves)
        indices = [move_to_index(orient_move(m, flipped)) for m in moves]
        return moves, logits[indices]

    def rank_moves(self, board: chess.Board) -> list[MoveScore]:
        """All legal moves with their model probabilities, best first."""
        moves, legal_logits = self._legal_logits(board)
        if not moves:
            return []
        # softmax over the legal subset
        legal_logits = legal_logits - legal_logits.max()
        probs = np.exp(legal_logits)
        probs /= probs.sum()
        ranked = sorted(zip(moves, probs), key=lambda mp: mp[1], reverse=True)
        return [MoveScore(m, float(p)) for m, p in ranked]

    def select_move(
        self,
        board: chess.Board,
        temperature: float = 0.0,
        top_k: int | None = None,
        rng: np.random.Generator | None = None,
    ) -> chess.Move | None:
        """Pick a move.

        ``temperature == 0`` is deterministic (the most Carlsen-likely move).
        Higher temperatures sample more human-like variety; ``top_k`` restricts
        sampling to the most likely moves.
        """
        scored = self.rank_moves(board)
        if not scored:
            return None
        if temperature <= 0.0:
            return scored[0].move

        if top_k is not None:
            scored = scored[:top_k]
        probs = np.array([s.probability for s in scored], dtype=np.float64)
        # re-temper the (already softmaxed) probabilities
        logits = np.log(np.clip(probs, 1e-12, None)) / temperature
        logits -= logits.max()
        probs = np.exp(logits)
        probs /= probs.sum()
        rng = rng or np.random.default_rng()
        choice = rng.choice(len(scored), p=probs)
        return scored[choice].move
