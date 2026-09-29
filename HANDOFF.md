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
  ├─ WebSocket   ──► Worker /room/<id> ─► ChessRoom Durable Object (one per game)
  └─ WebSocket   ──► Worker /lobby     ─► Lobby Durable Object (Quick match, "N online")
```

- **Home page.** The first screen has the headline, **Play now** and **I've never played**, and
  an **Opponent** picker (Coach bot levels 1–8 or Magnus bot; Play now becomes "Play
  Magnus"). It also offers Play as, *Play a person: Quick match · Invite a friend*, and a
  live demo board where the coach explains moves. Returning players get a "Continue:"
  strip. A name is asked only the first time someone plays a person. About is a separate
  page (`#about`).
- **Phones.** The coach and the Take back / Hint / New game / Resign buttons are pinned to
  the bottom during games, puzzles, tutorials and drills. The board sizes itself to the
  screen height so everything fits without scrolling. e2e tests guard against sideways
  overflow and clipped pieces.

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
  - **Move timer.** Whoever is to move has 60 s, enforced by a Durable Object alarm
    that fires even if nobody is connected. Running out loses the game (`status:
    "timeout"`). The client shows a countdown that turns red in the last 20 s.
  - **Abandonment.** When a player has been away 60 s, the opponent may claim the win.
  - **Fair play.** No coach, hints, take-backs or dots in games against people.
  - **Waiting for a friend.** After 20 s, "Play the computer instead" opens the same
    explicit choice as Quick match, and the invite link keeps working.
- **Learn the pieces** (`src/tutorial.ts`). Each piece is learned first with dots, then
  tested without them: reach the circled square in N moves. A unit test proves each
  target needs exactly N moves.
- **Move dots fade out** (`src/mastery.ts`, `src/rules.ts`). The goal is that learners
  can play on a real board.
  - **Mastery.** A piece is mastered once its no-dots tutorial test is passed, after a
    clean board-vision drill, or after 15 legal moves with it. Illegal tries subtract 3.
  - **After mastery.** Picking the piece up shows no dots and allows free dragging.
    Illegal tries are explained by `explainIllegal()`: wrong shape, blocked path, your
    own piece, or king safety.
  - **Peek.** Press and hold to see the dots. Five peeks at a mastered piece bring its
    dots back for a while.
  - **Against people.** Online games never show dots.
  - **Board vision drills.** A lesson unit asks you to "tap every square the knight can
    reach".
- **Quick match** (`Lobby` Durable Object at `/lobby`, client code in `src/online.ts`).
  - **Presence.** Every open page is counted per device, which drives "N online".
  - **Pairing.** Two searchers are paired at once.
  - **Background players.** After an empty search (20 s, paused while an offer is
    pending), the player explicitly picks Coach bot (with a level) or Magnus and a colour.
    They then play a "real game" (no coach, hints, take-backs, eval bar or dots; the review
    is still available afterwards) and stay matchable. A new searcher is offered to them with a
    15 s Join/Stay banner. Stay or no answer releases the searcher back to searching,
    and the next background player is asked.
  - **Leaving.** Closing a socket leaves every queue and cancels its offers.
  - **Tests.** `node scripts/check_lobby.mjs` runs 9 behaviour checks against
    `wrangler dev`.
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
npm test                     # Vitest (73): encoding vs Python golden, coach wording, rules explainer,
                             #   dot mastery, streak and rating maths, puzzle and drill legality
npm run test:e2e             # Playwright (33) vs a production build, desktop + mobile
node scripts/check_lobby.mjs # matchmaking (9 checks), needs `wrangler dev` running
cd ..
pytest -q                    # model/encoding tests (Python)
```

The e2e build (`.env.e2e`) points `VITE_GAME_HOST` at `127.0.0.1:9`, where nothing is
listening. Online play is then "configured" but always finds nobody, which exercises
the Quick-match fallback.

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

1. Open https://chronael.vercel.app. The first screen shows **Play now**, the Opponent
   picker, *Play a person* (with "N online" when others are on) and the demo board. On
   a phone the whole demo board fits.
2. Play the computer: move, get a rating, press **Hint + why**, resign, and see the
   result modal. Then open **Review this game**.
3. Open the daily puzzle. Solving it shows "Solved!" and the streak goes to 1.
4. Invite a friend on device A and open the link on device B. Moves alternate. Refresh
   B and it keeps its colour. Try a draw offer and a rematch, which swaps colours.
5. Close B. A sees "disconnected" with a countdown and can claim the win after 60 s.
6. Don't move for 60 s: you lose on time, and the banner turns red in the last 20 s.
7. Quick match on one device with nobody around: choose a computer opponent. Quick
   match on a second device: the first gets a Join/Stay banner, and Join starts a live
   game.
8. `curl https://chronael.vercel.app/version.json` returns the deployed commit.

## Android app

The Android app is a Trusted Web Activity, package `app.vercel.chronael.twa`, version
1.0.0 (code 1). It opens https://chronael.vercel.app full screen.
- **How it was built.** PWABuilder's cloud generator produced an unsigned APK and AAB
  (options in `C:\Users\fran6\Documents\chronael-android\options.json`). They were then
  signed locally with the Temurin JDK 17 and Android build-tools in
  `C:\Users\fran6\android-tools`: `zipalign` and `apksigner` for the APK, `jarsigner`
  for the AAB.
- **Signing key.** It lives in `Documents\chronael-android`: `signing.keystore`, alias
  `chronael`, with passwords in `signing-key-info.txt`. Back it up and never commit it;
  `.gitignore` blocks `*.keystore`, `*.jks` and `*.aab`.
- **Download.** The signed APK is served from `web-app/public/downloads/chronael.apk`
  (linked in the footer). The service worker never caches it.
- **Asset links.** `web-app/public/.well-known/assetlinks.json` holds the certificate's
  SHA-256, so Android drops the URL bar. With Play App Signing, add Play's app-signing
  SHA-256 there as a second fingerprint.
- **When to rebuild.** Web changes ship without a new APK. Rebuild only to change the
  name, icon or package settings, or to bump the version for Play.

## Not done yet / known limits

- **Progress is per device.** It lives in localStorage and there are no accounts, so
  progress doesn't follow a player to another device.
- **Play Store.** The AAB is built and signed but not submitted. With Play App Signing,
  add Play's SHA-256 to `assetlinks.json`.
- **Matchmaking needs overlap.** Quick match pairs people only while both are on the site
  (searching, or playing the computer after an empty search).
- **No cheat detection** beyond server-side move validation.
- **Peek (press and hold)** isn't covered by automated tests.
