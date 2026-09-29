# Working on Chronael

Read `HANDOFF.md` first: production URLs, architecture, deploy and verification.

## Rules

- **Commits.** The repository owner is the sole contributor. Never add co-author
  trailers, "Generated with" lines, or any AI attribution to commits, PRs or files.
- **Secrets.** Secrets stay server-side. Only `VITE_GAME_HOST` may carry the `VITE_`
  prefix. Never commit `.env`, `.dev.vars` or keys.
- **Coach wording.** The coach speaks plain English to beginners. No chess notation,
  square names or numbers may reach coach text. Facts come from Stockfish and chess.js
  via `describeMove()`, and the model only rephrases them. Keep the offline fallback
  working.
- **Encoding.** `web-app/src/encoding.ts` must match `chronael/encoding.py` bit for bit.
  The Vitest golden test enforces this.
- **Online server.** `web-app/worker/chess.ts` is authoritative. Validate on the
  server; the client only sends intentions.
- **Fair play.** Games against people (friend or Quick match, and the Quick-match
  computer fallback) have no coach, hints, take-backs or move dots. Keep it that way.
- **Learning to play without dots.** Dots fade per piece (`src/mastery.ts`). Never add a
  global "always show dots" switch; illegal tries must be explained (`src/rules.ts`).
- **Phones.** Nothing may scroll sideways at 360 px, pieces must stay inside the board,
  and game controls must be reachable without scrolling. e2e tests check all of this.
- **Design system.** Use the tokens in `web-app/src/style.css`: Playfair Display for
  headings, DM Sans for text, paper/cream/green/gold. Respect reduced motion, keep tap
  targets at least 44 px, and avoid horizontal scroll at 375 px.

## Before you push

```powershell
cd web-app
npm run build
npm test
npm run test:e2e
# if you touched the lobby or rooms: npx wrangler dev, then node scripts/check_lobby.mjs
```
