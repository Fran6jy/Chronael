"""Chronael API server - serves move predictions from the policy network.

POST /predict  { "fen": "...", "temperature": 0.0, "top_k": 5 }
  -> { "move": "g1f3", "san": "Nf3", "legal": true, "candidates": [...] }

Because moves are chosen by masking to the legal set, the response is ALWAYS a legal
move (or an explicit game-over), so no random fallback is ever needed.
"""

from __future__ import annotations

import logging
import sys
from pathlib import Path

import chess
from fastapi import FastAPI, HTTPException
from fastapi.middleware.cors import CORSMiddleware
from pydantic import BaseModel

sys.path.insert(0, str(Path(__file__).resolve().parent.parent))
from chronael.engine import ChronaelEngine  # noqa: E402

logging.basicConfig(level=logging.INFO)
logger = logging.getLogger("chronael.api")

MODEL_PATH = Path(__file__).resolve().parent.parent / "models" / "chronael.pt"

app = FastAPI(title="Chronael API", version="0.2.0")
app.add_middleware(
    CORSMiddleware,
    allow_origins=["*"],
    allow_credentials=True,
    allow_methods=["*"],
    allow_headers=["*"],
)

engine: ChronaelEngine | None = None


class MoveRequest(BaseModel):
    fen: str
    temperature: float = 0.0
    top_k: int = 5


class Candidate(BaseModel):
    move: str
    san: str
    probability: float


class MoveResponse(BaseModel):
    move: str
    san: str
    legal: bool
    candidates: list[Candidate]


@app.on_event("startup")
def _load() -> None:
    global engine
    if MODEL_PATH.exists():
        engine = ChronaelEngine.from_checkpoint(str(MODEL_PATH))
        logger.info("Loaded model from %s", MODEL_PATH)
    else:
        logger.warning("Model not found at %s - train one first (make train).", MODEL_PATH)


@app.get("/health")
def health() -> dict:
    return {"status": "healthy", "model_loaded": engine is not None}


@app.post("/predict", response_model=MoveResponse)
def predict(request: MoveRequest) -> MoveResponse:
    if engine is None:
        raise HTTPException(status_code=503, detail="Model not loaded")
    try:
        board = chess.Board(request.fen)
    except ValueError:
        raise HTTPException(status_code=400, detail="Invalid FEN")

    if board.is_game_over():
        raise HTTPException(status_code=400, detail=f"Game is over: {board.result()}")

    ranked = engine.rank_moves(board)[: request.top_k]
    candidates = [
        Candidate(move=s.move.uci(), san=board.san(s.move), probability=s.probability)
        for s in ranked
    ]
    chosen = engine.select_move(board, temperature=request.temperature, top_k=request.top_k)
    return MoveResponse(
        move=chosen.uci(),
        san=board.san(chosen),
        legal=True,  # guaranteed by construction
        candidates=candidates,
    )


if __name__ == "__main__":
    import uvicorn

    uvicorn.run(app, host="0.0.0.0", port=8000)
