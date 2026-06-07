"""Turn a player's PGN games into a move-prediction dataset.

The key idea that the original pipeline missed: to learn to play *like Carlsen* we
must train only on the moves **Carlsen actually chose**. So for each game we detect
which colour Carlsen played and emit a training sample only for the positions where
it is his turn. Each sample is ``(board_planes, move_index)``.
"""

from __future__ import annotations

import re
from dataclasses import dataclass, field
from pathlib import Path
from typing import Iterator

import chess
import chess.pgn
import numpy as np

from .encoding import board_to_planes, move_to_index, orient, orient_move


@dataclass
class DatasetConfig:
    """Filters controlling which games / positions become training samples."""

    player: str = "Carlsen"          # substring matched against the White/Black headers
    min_year: int | None = None      # e.g. 2013 to focus on his World-Champion era
    min_player_elo: int | None = None
    max_games: int | None = None     # cap for quick experiments
    skip_opening_plies: int = 0      # optionally drop the first N plies (book moves)


def _header_year(game: chess.pgn.Game) -> int | None:
    date = game.headers.get("Date", "")
    m = re.match(r"(\d{4})", date)
    return int(m.group(1)) if m else None


def _player_color(game: chess.pgn.Game, player: str) -> chess.Color | None:
    """Return which colour the target player had in this game, or None."""
    player = player.lower()
    if player in game.headers.get("White", "").lower():
        return chess.WHITE
    if player in game.headers.get("Black", "").lower():
        return chess.BLACK
    return None


def _player_elo(game: chess.pgn.Game, color: chess.Color) -> int | None:
    key = "WhiteElo" if color == chess.WHITE else "BlackElo"
    try:
        return int(game.headers.get(key, ""))
    except (ValueError, TypeError):
        return None


def iter_player_positions(
    pgn_path: str | Path, config: DatasetConfig
) -> Iterator[tuple[np.ndarray, int, int]]:
    """Yield ``(planes, move_index, game_id)`` for every position the player moved in."""
    pgn_path = Path(pgn_path)
    game_id = 0
    kept_games = 0

    with open(pgn_path, encoding="utf-8", errors="replace") as handle:
        while True:
            if config.max_games is not None and kept_games >= config.max_games:
                break
            game = chess.pgn.read_game(handle)
            if game is None:
                break

            color = _player_color(game, config.player)
            if color is None:
                continue

            if config.min_year is not None:
                year = _header_year(game)
                if year is None or year < config.min_year:
                    continue

            if config.min_player_elo is not None:
                elo = _player_elo(game, color)
                if elo is None or elo < config.min_player_elo:
                    continue

            this_id = game_id
            game_id += 1
            emitted = False

            board = game.board()
            for ply, move in enumerate(game.mainline_moves()):
                player_to_move = board.turn == color
                if player_to_move and ply >= config.skip_opening_plies:
                    oriented, flipped = orient(board)
                    planes = board_to_planes(oriented)
                    index = move_to_index(orient_move(move, flipped))
                    yield planes, index, this_id
                    emitted = True
                board.push(move)

            if emitted:
                kept_games += 1


@dataclass
class BuiltDataset:
    X: np.ndarray            # (N, 17, 8, 8) uint8
    y: np.ndarray            # (N,) int32 policy indices
    game_ids: np.ndarray     # (N,) int32, for leakage-free train/val splitting
    meta: dict = field(default_factory=dict)

    def save(self, path: str | Path) -> None:
        path = Path(path)
        path.parent.mkdir(parents=True, exist_ok=True)
        np.savez_compressed(
            path, X=self.X, y=self.y, game_ids=self.game_ids,
            meta=np.array(repr(self.meta)),
        )

    @classmethod
    def load(cls, path: str | Path) -> "BuiltDataset":
        data = np.load(path, allow_pickle=True)
        meta = {}
        if "meta" in data:
            try:
                meta = eval(str(data["meta"]))  # trusted: written by save()
            except Exception:
                meta = {}
        return cls(X=data["X"], y=data["y"], game_ids=data["game_ids"], meta=meta)


def build_dataset(pgn_path: str | Path, config: DatasetConfig) -> BuiltDataset:
    """Materialise an in-memory dataset from a PGN file."""
    planes_list: list[np.ndarray] = []
    y_list: list[int] = []
    gid_list: list[int] = []

    for planes, index, gid in iter_player_positions(pgn_path, config):
        planes_list.append(planes.astype(np.uint8))
        y_list.append(index)
        gid_list.append(gid)

    if not planes_list:
        raise ValueError(
            f"No positions extracted for player '{config.player}' from {pgn_path}. "
            "Check the player name and filters."
        )

    X = np.stack(planes_list).astype(np.uint8)
    y = np.asarray(y_list, dtype=np.int32)
    game_ids = np.asarray(gid_list, dtype=np.int32)
    meta = {
        "player": config.player,
        "num_samples": int(X.shape[0]),
        "num_games": int(len(set(gid_list))),
        "min_year": config.min_year,
        "min_player_elo": config.min_player_elo,
    }
    return BuiltDataset(X=X, y=y, game_ids=game_ids, meta=meta)
