"""The engine must only ever propose legal moves, untrained weights included."""

import chess
import numpy as np

from chronael.engine import ChronaelEngine
from chronael.model import ChronaelNet, ModelConfig


def _tiny_engine():
    model = ChronaelNet(ModelConfig(channels=8, num_blocks=1, policy_head_channels=4))
    return ChronaelEngine(model, device="cpu")


def test_select_move_always_legal_random_weights():
    engine = _tiny_engine()
    rng = np.random.default_rng(0)
    for _ in range(20):
        board = chess.Board()
        plies = 0
        while not board.is_game_over() and plies < 120:
            move = engine.select_move(board, temperature=0.6, top_k=5, rng=rng)
            assert move in board.legal_moves
            board.push(move)
            plies += 1


def test_ranked_probabilities_sum_to_one():
    engine = _tiny_engine()
    board = chess.Board()
    scored = engine.rank_moves(board)
    assert len(scored) == board.legal_moves.count()
    assert abs(sum(s.probability for s in scored) - 1.0) < 1e-5


def test_deterministic_at_zero_temperature():
    engine = _tiny_engine()
    board = chess.Board()
    first = engine.select_move(board, temperature=0.0)
    for _ in range(5):
        assert engine.select_move(board, temperature=0.0) == first
