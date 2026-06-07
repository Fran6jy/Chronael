"""Correctness invariants for board/move encoding.

These are the guarantees the whole engine relies on: the move<->index map is a
bijection on its range, orientation always yields a White-to-move board, and every
real legal move maps to a legal move in the oriented frame.
"""

import random

import chess
import pytest

from chronael import encoding as E


def test_move_index_round_trip():
    rng = random.Random(0)
    for _ in range(5000):
        f, t = rng.randint(0, 63), rng.randint(0, 63)
        promo = rng.choice([None, chess.KNIGHT, chess.BISHOP, chess.ROOK, chess.QUEEN])
        move = chess.Move(f, t, promotion=promo)
        assert E.index_to_move(E.move_to_index(move)) == move


def _random_positions(num_games=80, max_plies=60, seed=0):
    rng = random.Random(seed)
    for _ in range(num_games):
        board = chess.Board()
        for _ in range(max_plies):
            if board.is_game_over():
                break
            yield board
            board.push(rng.choice(list(board.legal_moves)))


@pytest.mark.parametrize("board", list(_random_positions()))
def test_orientation_and_legality(board):
    oriented, flipped = E.orient(board)
    assert oriented.turn == chess.WHITE

    moves, indices, fl = E.legal_move_indices(board)
    assert fl == flipped
    # indices are unique over the legal set (injective)
    assert len(set(indices)) == len(indices)
    # every real legal move, oriented, is legal on the oriented board
    for mv in moves:
        assert E.orient_move(mv, flipped) in oriented.legal_moves


def test_plane_shape_and_piece_count():
    board = chess.Board()
    planes, flipped = E.encode_position(board)
    assert planes.shape == (E.NUM_PLANES, 8, 8)
    assert not flipped
    # 32 pieces in the starting position across the 12 piece planes
    assert planes[:12].sum() == 32
