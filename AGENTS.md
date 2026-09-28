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
- **Design system.** Use the tokens in `web-app/src/style.css`: Playfair Display for
  headings, DM Sans for text, paper/cream/green/gold. Respect reduced motion, keep tap
  targets at least 44 px, and avoid horizontal scroll at 375 px.

## Before you push

```powershell
cd web-app
npm run build
npm test
npm run test:e2e
```
