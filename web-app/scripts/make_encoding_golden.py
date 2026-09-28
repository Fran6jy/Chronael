"""Write web-app/tests/unit/encoding.golden.json from the Python encoder.

Run from the repo root after changing chronael/encoding.py:
    python web-app/scripts/make_encoding_golden.py
"""
import json
import sys
from pathlib import Path

import chess

sys.path.insert(0, str(Path(__file__).resolve().parents[2]))  # repo root, for `chronael`

from chronael.encoding import encode_position, legal_move_indices  # noqa: E402

FENS = [
    chess.STARTING_FEN,
    "r1bqkbnr/pppp1ppp/2n5/4p3/4P3/5N2/PPPP1PPP/RNBQKB1R w KQkq - 2 3",
    "rnbqkbnr/ppp1p1pp/8/3pPp2/8/8/PPPP1PPP/RNBQKBNR w KQkq f6 0 3",
    "rnbqkbnr/pppp1ppp/8/8/3Pp3/8/PPP1PPPP/RNBQKBNR b Kq d3 0 3",
    "8/1P6/8/8/8/8/5kp1/K7 b - - 0 1",
    "8/1P5k/8/8/8/8/8/K7 w - - 0 1",
    "r3k2r/8/8/8/8/8/8/R3K2R b Qk - 0 1",
]

out = []
for fen in FENS:
    board = chess.Board(fen)
    planes, _ = encode_position(board)
    moves, idx, _ = legal_move_indices(board)
    out.append({
        "fen": fen,
        "nonzero": [int(i) for i in planes.reshape(-1).nonzero()[0]],
        "moves": sorted([[m.uci(), i] for m, i in zip(moves, idx)]),
    })
target = Path(__file__).resolve().parent.parent / "tests" / "unit" / "encoding.golden.json"
target.write_text(json.dumps(out))
print(f"wrote {len(out)} positions to {target}")
