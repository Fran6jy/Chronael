# Chronael: learn chess, calmly (web app)

A chess app for people who have never played. A patient coach explains every move in plain
English, with no notation. Live at **https://chronael.vercel.app**, also installable as an
app and as an Android APK.

For how it runs in production (hosting, secrets, deploys, the Android build), see
[`../HANDOFF.md`](../HANDOFF.md).

## What's in it

**Learning**
- **Learn the pieces.** For each piece you first learn it with the move dots shown. Then you
  test yourself without dots, reaching a circled square in a set number of moves. Wrong
  moves are explained, not just blocked.
- **Lessons path.** Checkmate patterns, winning material, opening principles and endgames,
  with 15 drills and 1–3 stars each. Every answer is checked by Stockfish.
- **Board vision drills.** "Tap every square the knight can reach", with no dots.
- **Move dots fade out piece by piece.** Once you've shown you know a piece, its dots switch
  off and you drag freely, as on a real board. Illegal tries are explained. Press and hold
  a piece to peek at its dots, but peek too often and they come back.

**Playing the computer**
- **Coach bot** at levels 1–8 (level 1 makes mistakes on purpose), or the **Magnus bot**, a
  neural net trained on Magnus Carlsen's games that runs in the browser.
- **Coach.** Every move is rated, from great to blunder. Mistakes are explained in plain
  words, and "Tell me more" adds a rule of thumb. **Hint + why** shows a good move and the
  reason for it. You can take moves back.
- **Game review** after each game: an accuracy score, every move colour-coded, and the three
  moments that decided it, with the better move for you to find.
- **Your mistakes.** Your own blunders come back as puzzles, spaced out over days.

**Puzzles**
- **Daily puzzle** with a streak.
- **Rated puzzles.** 3,058 Lichess puzzles (CC0), rated 528–2500. Your puzzle rating adapts
  as you solve them.

**Playing people**
- **Invite a friend** with a link, or **Quick match** with anyone looking right now. The
  button shows how many people are online.
- **Fallback.** If nobody's around after 20 s, you choose the computer explicitly and stay
  matchable: a Join/Stay banner appears if someone searches.
- **Fair play.** No coach, hints, take-backs or dots against a person, and one minute per
  move. Resign, draw offers, rematch (colours swap), and your seat survives a refresh.

**Everything else**
- **Progress dashboard.** Puzzle rating, accuracy, blunders per game, record by opponent,
  pieces played without dots, and what to work on next.
- **No account.** Progress is saved on your device.
- **Works offline** once loaded, and shows a "new version" banner after each deploy.

## Run it

```bash
npm ci
npx wrangler dev --port 8787 --ip 127.0.0.1   # online-play server (optional)
npm run dev                                   # http://localhost:5173
```

Without `wrangler dev`, everything works except playing people. The coach explanations need
an OpenRouter key in `.env` (see `.env.example`); without one, the coach falls back to
built-in sentences.

## Test

```bash
npm test               # Vitest unit tests
npm run test:e2e       # Playwright against a production build, desktop + mobile
node scripts/check_lobby.mjs   # matchmaking checks (needs wrangler dev running)
```

## Code map

| Path | What |
| --- | --- |
| `index.html`, `src/style.css` | Markup and the design system: Playfair Display + DM Sans, paper/cream/green/gold |
| `src/main.ts` | App shell: views, games, puzzles, review, lessons, dashboard, online UI |
| `src/coach.ts` | Move ratings, plain-English move descriptions, hint explanations |
| `src/engine.ts` | Stockfish (WASM) wrapper |
| `src/carlsen.ts`, `src/encoding.ts` | Magnus bot (ONNX) and its board encoding, which must match `chronael/encoding.py` |
| `src/tutorial.ts` | Learn the pieces (learn, then test) |
| `src/lessons.ts` | Lesson drills |
| `src/progress.ts` | Stats, accuracy, puzzle rating, mistakes deck |
| `src/mastery.ts`, `src/rules.ts` | Per-piece dot fading, and why-is-this-illegal explanations |
| `src/puzzle.ts` | Daily puzzle and streak |
| `src/online.ts` | Online rooms, Quick match, presence |
| `src/heroDemo.ts` | Home page demo board |
| `src/pwa.ts` | Service worker, install prompt, update banner |
| `worker/chess.ts` | Cloudflare Worker: game rooms, matchmaking lobby, rate limiter |
| `api/coach.ts` | Vercel function that phrases coach facts with a free LLM |
| `scripts/` | Data and asset generators (rated puzzles, icons, encoding golden), lobby checks |
