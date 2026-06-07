# ♟️ Chronael — play chess against an imitation of Magnus Carlsen

Chronael trains a neural network to **play like a specific human** by imitation:
it learns to predict the move that player actually chose in each position. Train it
on Magnus Carlsen's games and it plays Carlsen-flavoured chess; point it at another
player's PGN and it imitates them instead.

Human-likeness is measured the way the [Maia Chess](https://maiachess.com) papers
measure it — **move-match accuracy**: how often the model reproduces the player's
real move on held-out games.

> **Why not a chess-playing LLM?** The first version of this project fine-tuned a
> 350M language model on `FEN -> UCI` text. It played weakly and produced *illegal*
> moves often enough to need a random fallback, and nothing actually conditioned it
> on Carlsen at play time. That approach has been removed (it lives in the git
> history). The current design never plays an illegal move and has a real, reportable metric.

## 🎓 Play now: the beginner learning app

The primary, beginner-facing experience lives in [`web-app/`](web-app/) — a
browser app that teaches chess to someone who has **never played before**: legal-move
dots, take-backs, hints, and an adaptive opponent gentle enough to beat. It runs fully
in the browser (Chessground + chess.js + Stockfish WASM), no server required.

```bash
cd web-app && npm install && npm run dev   # http://localhost:5173
```

The Carlsen imitation model described below is the **"graduate" opponent** you can
switch to once you've learned the ropes (live in the app, running in your browser via
ONNX). It is not what a beginner faces first.

## How it works

```
PGN games ──► keep only positions where the TARGET PLAYER moved
          ──► encode board to 17×8×8 planes (oriented to side-to-move)
          ──► ResNet policy net predicts a distribution over moves
          ──► train to match the player's actual move (cross-entropy)
          ──► PLAY: softmax over LEGAL moves only ⇒ always legal, human-like
```

Key design choices:

- **Side-to-move orientation** — the board is always shown from the mover's view, so
  the net learns "my pieces vs. theirs" instead of white-vs-black.
- **Legal-move masking** — at inference we score only the position's legal moves, so
  the engine *cannot* output an illegal move.
- **Game-level train/val split** — positions from one game never leak across the
  split, so the move-match number is honest.
- **Tiny & portable** — a small residual CNN that trains on CPU for experiments and
  exports to ONNX for in-browser play.

## Quick start

```bash
make setup                 # install dependencies

make download              # fetch Carlsen's ~4,300 games (PGN)
make data                  # build the move-prediction dataset (.npz)
make train EPOCHS=30 CHANNELS=128 NUM_BLOCKS=10   # train the policy net
make eval                  # report move-match accuracy on held-out games
make play                  # play a game in the terminal
```

Everything is also runnable directly:

```bash
python scripts/download_data.py --player Carlsen
python scripts/build_dataset.py --pgn data/raw/Carlsen.pgn --out data/processed/carlsen.npz \
    --min-year 2013          # optionally focus on his World-Champion era
python scripts/train.py --data data/processed/carlsen.npz --out models/chronael.pt \
    --channels 128 --num-blocks 10 --epochs 30
python scripts/play.py --model models/chronael.pt --color white --show-thinking
```

### Imitate a different player

```bash
make download PLAYER=Kasparov
make data     PLAYER=Kasparov
make train    DATA=data/processed/kasparov.npz MODEL=models/kasparov.pt
```

## Playing

```text
$ python scripts/play.py --show-thinking
Your move (White): e4
  Chronael considers: e5 41%, c5 27%, e6 12%, c6 9%, Nf6 6%
Chronael plays: c5
```

- `--temperature 0` → the single most Carlsen-likely move (strongest, most
  predictable). Higher temperatures add human-like variety; `--top-k` caps the pool.

## Serving over HTTP

```bash
make api      # uvicorn on :8000, loads models/chronael.pt

curl -X POST http://localhost:8000/predict \
  -H "Content-Type: application/json" \
  -d '{"fen":"rnbqkbnr/pppppppp/8/8/8/8/PPPPPPPP/RNBQKBNR w KQkq - 0 1","temperature":0.4,"top_k":3}'
# -> {"move":"e2e4","san":"e4","legal":true,"candidates":[...]}
```

## Evaluation — the number for your write-up

`make eval` prints top-1 / top-3 / top-5 move-match on a held-out split of the
player's games:

```text
Held-out positions=... top1=...  top3=...  top5=...
```

Top-1 is "how often the model reproduces the player's exact move." For reference,
the Maia papers report ~46–52% top-1 at their best (move prediction is intentionally
*not* the same as playing the engine-best move).

> A 6-epoch CPU smoke run on just 200 games already lifts val top-1 from 2.7%
> (≈ random) to ~14.5%; the full dataset with a larger net and GPU is where it
> reaches the human-match range above.

## Project layout

```
chronael/
  encoding.py    board <-> planes, move <-> index, orientation, legal-move masking
  data.py        PGN ─► (planes, move_index) for the target player only
  model.py       ResNet policy network (policy head only)
  engine.py      inference: legal-masked move selection, temperature / top-k
  evaluate.py    move-match accuracy
scripts/
  download_data.py  build_dataset.py  train.py  evaluate_model.py  play.py
api/server.py    FastAPI move server
tests/           encoding & engine invariants (run: make test)
web-app/         the beginner browser app (board, opponent, coach, tutorial)
```

## Training at scale

The policy net is small; the bottleneck is data volume, not GPU memory. To train a
strong model:

- Use the full PGN (`make data` with no `--max-games`) — ~160k Carlsen positions.
- Scale the net: `--channels 128 --num-blocks 10` (and more for diminishing returns).
- Train for 30–60 epochs with the game-level split; watch val top-1, not train loss.
- A single mid-range GPU is plenty; a CPU works for small experiments.

## Roadmap

- [ ] Add a value head + light search to trade human-likeness for strength on a dial.
- [x] ONNX export + a browser board UI (the `web-app/`, with the model as the Magnus bot).
- [ ] Per-era models (early vs. World-Champion Carlsen) and per-opponent conditioning.
- [ ] Blend with an engine to cap blunders while keeping the style.

## References

- McIlroy-Young et al., *Aligning Superhuman AI with Human Behavior: Chess as a Model
  System*, KDD 2020 (Maia).
- McIlroy-Young et al., *Learning Models of Individual Behavior in Chess*, KDD 2022.
- Games via the [rozim/ChessData](https://github.com/rozim/ChessData) mirror of
  [PGN Mentor](https://www.pgnmentor.com/).

## License

MIT
