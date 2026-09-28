# Chronael handoff

## Production

- Frontend: https://chronael.vercel.app
- Vercel project: `web-app`
- Game server: https://chronael-chess.fran6jy.workers.dev
- Cloudflare Worker: `chronael-chess`
- Durable Object binding/class: `CHESS_ROOM` / `ChessRoom`
- Vercel production variable:
  `VITE_GAME_HOST=chronael-chess.fran6jy.workers.dev`

The similarly named Vercel project `chronael` deploys to `chronael-six.vercel.app` and
is not the canonical production project.

## Online architecture

`web-app/worker/chess.ts` is the authoritative WebSocket server. Each `/room/<id>` is
one SQLite-class Durable Object. The Worker assigns white and black, validates moves
with chess.js, rejects illegal/out-of-turn moves, and broadcasts the canonical FEN.
`web-app/src/online.ts` is the browser WebSocket client.

## Latest production fix

Cloudflare Worker version `e7bb190b-bb99-478f-b748-ff03827ca2f5` fixes reconnects
that arrived before the old socket's close event. Such clients initially connect as
spectators and are now promoted automatically when the stale player seat is released.

The fix is currently deployed. Source changes should be committed and pushed after
final verification.

## Deploy

```powershell
cd C:\Users\fran6\Downloads\Chronael\web-app
npx wrangler deploy
npx vercel deploy --prod --yes
```

The local Vercel link should target `fran6jy-7215s-projects/web-app`.

## Verification

1. Open `https://chronael.vercel.app` on device A and create an online game.
2. Open its invite link on device B.
3. Confirm both colours can make alternating legal moves.
4. Disconnect and immediately rejoin one device; confirm it regains the open seat.
5. For stale pre-fix rooms, close both devices and generate a new room link.
