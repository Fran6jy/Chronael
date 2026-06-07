"""Download a player's games as a single PGN file.

PGN Mentor (pgnmentor.com) is the canonical source but is not always reachable; the
rozim/ChessData GitHub mirror hosts the exact same collections and is used by default.
"""

from __future__ import annotations

import argparse
import sys
import urllib.request
from pathlib import Path

# GitHub mirror of the PGN Mentor player collections.
MIRROR = "https://raw.githubusercontent.com/rozim/ChessData/master/PgnMentor/{player}.pgn"


def download(player: str, out_dir: str = "data/raw") -> Path:
    url = MIRROR.format(player=player)
    out_path = Path(out_dir) / f"{player}.pgn"
    out_path.parent.mkdir(parents=True, exist_ok=True)

    print(f"Downloading {player} games from {url}")
    req = urllib.request.Request(url, headers={"User-Agent": "chronael/0.2"})
    with urllib.request.urlopen(req, timeout=120) as resp:
        data = resp.read()
    out_path.write_bytes(data)

    games = data.count(b"[Event ")
    print(f"Saved {len(data):,} bytes ({games:,} games) to {out_path}")
    return out_path


def main() -> int:
    parser = argparse.ArgumentParser(description="Download player PGN games.")
    parser.add_argument("--player", default="Carlsen", help="Player name (PGN Mentor file stem).")
    parser.add_argument("--out-dir", default="data/raw")
    args = parser.parse_args()
    download(args.player, args.out_dir)
    return 0


if __name__ == "__main__":
    sys.exit(main())
