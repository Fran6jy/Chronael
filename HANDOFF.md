# Chronael handoff

Everything needed to pick this project up cold: where it runs, how it fits together,
how to deploy, and how to check it works.

## Production

| Piece | Where |
| --- | --- |
| Web app | https://chronael.vercel.app (Vercel project `web-app`, auto-deploys from `main`) |
| Game + rate-limit server | https://chronael-chess.fran6jy.workers.dev (Cloudflare Worker `chronael-chess`) |
| Coach | `web-app/api/coach.ts`, a Vercel serverless function at `/api/coach` |

The similarly named Vercel project `chronael` (`chronael-six.vercel.app`) is **not**
production. The local Vercel link should target `fran6jy-7215s-projects/web-app`.

### Environment

| Variable | Where | Purpose |
| --- | --- | --- |
| `VITE_GAME_HOST` | Vercel (build) | Worker host for online play. Public by design. |
| `OPENROUTER_API_KEY` | Vercel (server) | Coach model key. Never `VITE_`-prefixed. |
| `COACH_MODELS` | Vercel (server) | Comma-separated free models, tried in order. |
| `RL_SECRET` | Vercel **and** Worker secret | Lets the coach use the Worker's global rate limiter. |
| `GAME_HOST` | Vercel (server, optional) | Worker host for the rate limiter; defaults to `VITE_GAME_HOST`. |

See `web-app/.env.example`. Locally, the Worker reads `web-app/.dev.vars` (gitignored).

## Architecture

```
browser (Vite + TS)
  ├─ chessground board, chess.js rules
  ├─ Stockfish 16 WASM (public/engine) → evaluations, hints, bot moves
  ├─ Magnus net, ONNX int8 (public/models, lazy-loaded) → "Magnus bot"
  ├─ /api/coach  ──► OpenRouter free model (phrasing only; facts come from Stockfish)
  │                   └─► Worker /ratelimit (global limit, 20/min per IP)
  └─ WebSocket   ──► Worker /room/<id> ─► ChessRoom Durable Object (one per game)
```

- **Coach.** Stockfish decides everything. `describeMove()` turns moves into plain English
  (no notation). The model only rephrases those facts. Every path has an offline
  fallback sentence, so the coach never breaks when OpenRouter is down or rate-limited.
- **Hints** show an arrow plus *why* (`explainHint`): the best move, and the opponent's
  threat found by analysing the same position with the other side to move.
- **Online** (`worker/chess.ts`, `src/online.ts`). The room is authoritative: it validates
  every move with chess.js and persists the game in Durable Object storage.
  - **Seats.** Each device keeps a random token per room in localStorage
    (`chronael.seat.<room>`). The server stores only its SHA-256, so a refresh or
    reconnect gets the same colour back. A third device watches as a spectator.
  - **Game actions.** Resign; offer, accept and decline a draw (a declined player can't
    re-offer for 6 plies); rematch, which swaps colours.
  - **Abandonment.** When a player has been away 60 s, the opponent may claim the win.
  - **Waiting.** After 20 s of waiting, the inviter is offered the bot while the link
    keeps working.
- **Daily puzzle** (`src/puzzle.ts`, `public/puzzles.json`). There are 400 Lichess CC0
  puzzles rated 487–1299 across 9 themes. The day's puzzle is picked by date, so
  everyone gets the same one. The streak lives in localStorage under `chronael.puzzle`.
  Any mate counts as a correct answer.
- **Learning loop** (`src/progress.ts`, `src/lessons.ts`), all stored in localStorage
  under `chronael.progress`, with no account needed.
  - **Game review.** Every move in a bot game is logged with Stockfish's eval before and
    after it. After a game you see an accuracy score, a colour-coded strip of every move,
    and the 3 biggest swings, each with red and green arrows, a coach explanation and
    "find the better move yourself".
  - **Your mistakes.** Every mistake or blunder is saved as a card and re-served with
    spaced repetition (Leitner boxes: 0, 1, 3, 7, 14, 30 and 60 days). A move within
    40 cp of best also counts as correct.
  - **Lesson path.** Learn the pieces, then 4 units and 15 hand-made drills, with 1–3
    stars each. `tests/e2e/lessons.spec.ts` checks every accepted answer against the
    app's own Stockfish.
  - **Rated puzzles.** `public/puzzles-rated.json` holds 3,058 Lichess CC0 puzzles rated
    528–2500, built by `scripts/make_rated_puzzles.py`. The learner has an Elo-style
    puzzle rating that moves faster while provisional; a wrong first move counts as a loss.
  - **Bot levels.** A win offers "Level up".
  - **Dashboard.** It shows the puzzle rating chart, accuracy per game, the blunders-per-game
    trend, the win record by opponent, and plain-English "what to work on" tips.
- **PWA** (`public/sw.js`, `public/manifest.webmanifest`, `src/pwa.ts`).
  - **Caching.** Pages are network-first so deploys show up; assets are cache-first;
    `/api` and `version.json` are never cached.
  - **Install.** An "Install app" chip appears when the browser offers it.
- **Deploy detection.** `vite.config.ts` writes `version.json` with the commit SHA and
  bakes the same id into the bundle. The page polls it every 5 minutes and when the tab
  regains focus, then shows a "Reload" banner when they differ.
- **Social image.** `public/og.png` and the icons are generated by
  `web-app/scripts/make_images.py` (Pillow).

## Develop

```powershell
cd web-app
npm ci
npx wrangler dev --port 8787 --ip 127.0.0.1   # game server (terminal 1)
npm run dev                                   # app on http://localhost:5173 (terminal 2)
```

If `wrangler dev` says ready but requests hang, a stale `workerd.exe` holds the port.
Kill every `workerd.exe` and start again.

## Test

```powershell
cd web-app
npm test            # Vitest: encoding vs Python golden, coach wording, streak maths, puzzle legality
npm run test:e2e    # Playwright vs a production build (desktop + mobile): tutorial, game, promotion, puzzle, PWA
cd ..
pytest -q           # model/encoding tests (Python)
```

CI (`.github/workflows/ci.yml`) runs the build, both web test suites, and pytest on
every push and PR.

Regenerate the encoding golden after changing `chronael/encoding.py` with
`python web-app/scripts/make_encoding_golden.py` (from the repo root). It writes
`tests/unit/encoding.golden.json` from the Python encoder.

## Deploy

```powershell
cd C:\Users\fran6\Downloads\Chronael\web-app
npx wrangler deploy              # Worker + Durable Object migrations
git push                         # Vercel auto-deploys main (or: npx vercel deploy --prod --yes)
```

First-time secret setup: generate one random value and set it in both places.

```powershell
npx wrangler secret put RL_SECRET
npx vercel env add RL_SECRET production
```

## Verify production

1. Open https://chronael.vercel.app. The home page shows the hero, the "Start playing"
   panel and four cards.
2. Play the computer: move, get a rating, press **Hint + why**, resign, and see the
   result modal.
3. Open the daily puzzle. Solving it shows "Solved!" and the streak goes to 1.
4. Invite a friend on device A and open the link on device B. Moves alternate. Refresh
   B and it keeps its colour. Try a draw offer and a rematch, which swaps colours.
5. Close B. A sees "disconnected" with a countdown and can claim the win after 60 s.
6. `curl https://chronael.vercel.app/version.json` returns the deployed commit.

## Not done yet

- **Android app (TWA/APK).** The PWA is installable today. Wrapping it with Bubblewrap
  needs a signing key and a `/.well-known/assetlinks.json`; that is left for later.
- **Clocks.** Online games are untimed. Abandonment uses the 60 s away rule instead.
