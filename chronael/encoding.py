"""Board and move encoding for the Chronael policy network.

Design goals
------------
* **Side-to-move orientation.** The board is always presented to the network with
  the side to move at the bottom (as if it were White). When it is Black's turn we
  mirror the board (vertical flip + colour swap). This lets the network learn "my
  pieces vs. their pieces" instead of "white vs. black", which roughly halves the
  amount it has to learn and makes data augmentation unnecessary.

* **Injective move <-> index mapping.** Every legal chess move maps to a unique
  index in ``[0, POLICY_SIZE)`` via ``(from*64 + to)*5 + promo_code``. This is a
  superset of all legal moves, so decoding is never needed: at inference we simply
  gather the logits of the *legal* moves and pick among them. The model therefore
  can never output an illegal move.
"""

from __future__ import annotations

import chess
import numpy as np

# 6 piece types x 2 colours = 12 piece planes, + 4 castling, + 1 en-passant.
NUM_PLANES = 17
BOARD_SIZE = 8

# Move index space: 64 from-squares * 64 to-squares * 5 promotion codes.
_PROMO_TO_CODE = {None: 0, chess.KNIGHT: 1, chess.BISHOP: 2, chess.ROOK: 3, chess.QUEEN: 4}
_CODE_TO_PROMO = {v: k for k, v in _PROMO_TO_CODE.items()}
POLICY_SIZE = 64 * 64 * 5  # 20480


def orient(board: chess.Board) -> tuple[chess.Board, bool]:
    """Return ``(oriented_board, flipped)`` where the side to move is always White.

    ``flipped`` is True when the original side to move was Black, in which case the
    board has been mirrored vertically with colours swapped.
    """
    if board.turn == chess.WHITE:
        return board, False
    return board.mirror(), True


def orient_move(move: chess.Move, flipped: bool) -> chess.Move:
    """Map a move into / out of the oriented frame.

    ``chess.square_mirror`` is its own inverse, so the same call orients a move for
    encoding and un-orients a model-chosen move back to the real board.
    """
    if not flipped:
        return move
    return chess.Move(
        chess.square_mirror(move.from_square),
        chess.square_mirror(move.to_square),
        promotion=move.promotion,
    )


def move_to_index(move: chess.Move) -> int:
    """Map an (already oriented) move to its unique policy index."""
    return (move.from_square * 64 + move.to_square) * 5 + _PROMO_TO_CODE[move.promotion]


def index_to_move(index: int) -> chess.Move:
    """Inverse of :func:`move_to_index` (used for tests / debugging only)."""
    promo_code = index % 5
    squares = index // 5
    to_sq = squares % 64
    from_sq = squares // 64
    return chess.Move(from_sq, to_sq, promotion=_CODE_TO_PROMO[promo_code])


def board_to_planes(oriented_board: chess.Board) -> np.ndarray:
    """Encode an *oriented* board (side to move == White) into ``(17, 8, 8)`` floats."""
    planes = np.zeros((NUM_PLANES, BOARD_SIZE, BOARD_SIZE), dtype=np.float32)

    for square, piece in oriented_board.piece_map().items():
        rank = chess.square_rank(square)
        file = chess.square_file(square)
        plane = (piece.piece_type - 1) + (0 if piece.color == chess.WHITE else 6)
        planes[plane, rank, file] = 1.0

    # Castling rights (side to move == White after orientation).
    if oriented_board.has_kingside_castling_rights(chess.WHITE):
        planes[12, :, :] = 1.0
    if oriented_board.has_queenside_castling_rights(chess.WHITE):
        planes[13, :, :] = 1.0
    if oriented_board.has_kingside_castling_rights(chess.BLACK):
        planes[14, :, :] = 1.0
    if oriented_board.has_queenside_castling_rights(chess.BLACK):
        planes[15, :, :] = 1.0

    # En-passant target square.
    if oriented_board.ep_square is not None:
        rank = chess.square_rank(oriented_board.ep_square)
        file = chess.square_file(oriented_board.ep_square)
        planes[16, rank, file] = 1.0

    return planes


def encode_position(board: chess.Board) -> tuple[np.ndarray, bool]:
    """Encode any board for the network. Returns ``(planes, flipped)``."""
    oriented, flipped = orient(board)
    return board_to_planes(oriented), flipped


def legal_move_indices(board: chess.Board) -> tuple[list[chess.Move], list[int], bool]:
    """For a position, return its legal moves, their policy indices, and ``flipped``.

    The returned moves are in the *original* board frame (ready to push), while the
    indices are in the oriented frame (matching the network's output).
    """
    oriented, flipped = orient(board)
    moves: list[chess.Move] = []
    indices: list[int] = []
    for move in board.legal_moves:
        moves.append(move)
        indices.append(move_to_index(orient_move(move, flipped)))
    return moves, indices, flipped
