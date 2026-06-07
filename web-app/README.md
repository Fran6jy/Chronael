# Chronael — Learn Chess (web app)

A browser app for **complete beginners** to learn chess by playing. No login, no
server, runs entirely in the browser.

**Design:** a calming "wellness" aesthetic (Soft UI Evolution, light mode) — warm
cream + sage-green board, soft-lavender highlights, Lora + Raleway typography, gentle
shadows, SVG icons, WCAG-AA contrast and `prefers-reduced-motion` respected.

## What it does (beginner-first)

- **Teaches the rules as you play** — click any piece and the squares it can legally
  move to light up. Illegal moves simply can't be made.
- **An opponent you can actually beat** — an adaptive [Stockfish](https://stockfishchess.org)
  (compiled to WebAssembly, runs locally). Level 1 deliberately makes blunders so a
  first-timer can win; the levels climb up to genuinely tough.
- **Gentle first-run welcome** — newcomers are greeted with a calm choice:
  "Learn the pieces" or "Play a game" (shown once, remembered per browser).
- **"Learn the pieces" tutorial** — a gentle, interactive tour for absolute
  first-timers: each piece appears on a calm board, pre-selected with its legal-move
  dots and a one-paragraph explanation. Move it, see it's legal, move on.
- **Promotion picker** — when a pawn reaches the last rank you choose Queen / Rook /
  Bishop / Knight (no silent auto-queen), so beginners learn the rule.
- **Promotion picker** with the real board piece art — choose Queen / Rook /
  Bishop / Knight (no silent auto-queen).
- **Captured-pieces tray + plain material summary** ("You're ahead by 3 points").
- **"Tell me more"** after a mistake — one extra plain-English rule-of-thumb from the coach.
- **Soft move/capture sounds** (synthesised, no files) with a mute toggle.
- **Square-label toggle** (a–h, 1–8) — off by default for calm, on for learning notation.
- **Take back** any move to experiment without fear.
- **Hint** — a green arrow shows a strong move when you're stuck.
- **A coach that rates and explains your moves.** Stockfish judges every move you make
  (great / good / inaccuracy / mistake / blunder) and an **eval bar** shows who's ahead.
  On a real mistake, a free LLM explains *why* in one friendly sentence — e.g.
  *"That was a brave try, but your opponent can now take your queen with cxd5. Next
  time, try Qd6 instead!"*
- **Move list, check/checkmate detection, last-move highlights**, and beginner tips.

### How the coach stays accurate

LLMs are bad at chess, so the model never analyses the board. **Stockfish computes all
the facts** (the eval swing, the best move, the refutation); the LLM only phrases those
facts kindly. That's why even a small free model gives correct coaching.

Crucially for a beginner, **moves are translated to plain English before they ever reach
the model**: `describeMove()` (in `src/coach.ts`) turns a move into words like "the
bishop captures the knight" using chess.js, and the backend system prompt (in
`server/coach.ts`) forbids any chess notation or numbers. So the learner reads "your
opponent's pawn can take your queen" — never "cxd5". It runs in two
tiers: an instant offline rating + tip (Tier 0), and — only for mistakes/blunders — a
natural-language explanation from OpenRouter (Tier 1), with a fallback chain across
several free models since free endpoints get rate-limited.

### Setup for the coach (optional)

The board, opponent, hints and move ratings work with **no key**. To enable the
natural-language explanations:

```bash
cp .env.example .env      # then paste your free OpenRouter key into OPENROUTER_API_KEY
```

The key is read only by the dev server's `/api/coach` proxy (and a serverless function
in production) — it is **never** bundled into the browser. Get a free key at
<https://openrouter.ai/keys>.

## Tech

| Concern | Library |
|---|---|
| Board UI (legal-move dots, drag, highlights) | [Chessground](https://github.com/lichess-org/chessground) (Lichess's board) |
| Rules / legality / SAN | [chess.js](https://github.com/jhlywa/chess.js) |
| Opponent + future analysis | [stockfish.js](https://github.com/nmrugg/stockfish.js) 16, single-threaded WASM |

The single-threaded Stockfish build needs no special COOP/COEP headers and runs with
its classical evaluation (NNUE disabled), so the app loads fast and works as plain
static files — no 40 MB neural-net download.

## Run it

```bash
cd web-app
npm install
npm run dev      # http://localhost:5173 (with the coach proxy)
npm run build    # static bundle in dist/
npm run preview  # serve the production build locally (static only)
```

## Deploy (production)

The board, adaptive opponent, tutorial, sounds, move ratings, eval bar and captured
tray are **100% static** — `dist/` deploys to any static host. The only piece that
needs a server is the coach's natural-language explanations (`POST /api/coach`), which
must hold the OpenRouter key. If that endpoint is absent, the app **degrades
gracefully**: you still get the instant offline move ratings/tips, just not the LLM
sentences.

### Vercel (recommended — full coach support)

The repo includes `api/coach.ts` (serverless function) and `vercel.json`.

```bash
cd web-app
vercel            # or: connect the repo in the Vercel dashboard, root = web-app
```

Then set environment variables in the Vercel dashboard (Project → Settings → Env):

- `OPENROUTER_API_KEY` — your key (server-side only; never exposed to the browser)
- `COACH_MODELS` — optional, e.g. `google/gemma-4-31b-it:free,openai/gpt-oss-120b:free`

### Netlify

Publish `dist/`, add a function for the coach, and redirect `/api/coach` to it:

```toml
# netlify.toml
[build]
  command = "npm run build"
  publish = "dist"
  functions = "netlify/functions"
[[redirects]]
  from = "/api/coach"
  to = "/.netlify/functions/coach"
  status = 200
```

A function at `netlify/functions/coach.ts` can simply call `requestCoach()` from
`server/coach.ts`. Set the same env vars in the Netlify dashboard.

### Static-only (GitHub Pages, S3, …)

`npm run build` and upload `dist/`. Everything works except the LLM coach sentences
(the offline ratings/tips still show). `base: "./"` in `vite.config.ts` means it works
from any sub-path.

## How the difficulty works

`src/engine.ts` maps each UI level to a Stockfish **Skill Level**, a per-move
**thinking time**, and a **blunder probability**. At low levels the app sometimes
substitutes a random legal move for the engine's choice — that randomness, not just a
weak engine, is what makes a beginner able to win and stay motivated.

## Roadmap (this app)

- [ ] LLM coach: plain-English "why was that a mistake?" explanations from the engine
      evaluation, and move ratings (good / inaccuracy / blunder).
- [ ] "Learn the pieces" interactive tutorial before the first full game.
- [ ] Promotion picker (currently auto-queens) and sound/animation polish.
- [ ] "Graduate" mode: play the Carlsen-style imitation model (see the repo root).
