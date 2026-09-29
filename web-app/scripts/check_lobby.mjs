// Lobby behaviour checks against a running Worker: npx wrangler dev --port 8787, then node scripts/check_lobby.mjs
// Scripted checks for the lobby: presence, offers, accept, decline hand-off, leaving mid-offer.
const H = "ws://127.0.0.1:8787/lobby";
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
function conn(mode, cid) {
  const ws = new WebSocket(`${H}?mode=${mode}&cid=${cid}`);
  const msgs = [];
  ws.onmessage = (e) => msgs.push(JSON.parse(e.data));
  const opened = new Promise((r) => (ws.onopen = r));
  const next = async (type, ms = 4000) => {
    const t0 = Date.now();
    while (Date.now() - t0 < ms) {
      const i = msgs.findIndex((m) => m.type === type);
      if (i >= 0) return msgs.splice(i, 1)[0];
      await sleep(30);
    }
    return null;
  };
  return { ws, msgs, opened, next };
}
let ok = true;
const check = (name, cond) => { console.log(`${cond ? "PASS" : "FAIL"} ${name}`); if (!cond) ok = false; };

// 1. Presence counts distinct devices.
const p1 = conn("presence", "devA"); await p1.opened;
const p2 = conn("presence", "devB"); await p2.opened;
await sleep(200);
const last = [...p1.msgs].reverse().find((m) => m.type === "presence");
check("presence counts 2 devices", last?.online === 2);

// 2. Background player gets an offer when someone searches; accept -> same room.
const bg = conn("background", "devA"); await bg.opened;
const s = conn("search", "devB"); await s.opened;
const pending = await s.next("pending");
const offer = await bg.next("offer");
check("searcher told a player was found", !!pending);
check("background player gets an offer", !!offer?.room);
bg.ws.send(JSON.stringify({ type: "accept", room: offer.room }));
const go = await bg.next("go");
const match = await s.next("match");
check("accept puts both in the same room", go?.room && go.room === match?.room);

// 3. Decline hands the searcher to the next background player.
const bg1 = conn("background", "devC"); await bg1.opened;
const bg2 = conn("background", "devD"); await bg2.opened;
const s2 = conn("search", "devE"); await s2.opened;
const o1 = (await bg1.next("offer")) ?? (await bg2.next("offer"));
const first = o1 && bg1.msgs !== null ? o1 : null;
const who = (await bg1.next("offer", 10)) ? bg1 : null; // (drained above)
const offered = o1 ? (o1.room ? o1 : null) : null;
// Find which one got the offer.
const decliner = [bg1, bg2].find((c) => c.msgs.length >= 0 && o1);
bg1.ws.send(JSON.stringify({ type: "decline", room: o1?.room }));
bg2.ws.send(JSON.stringify({ type: "decline", room: o1?.room }));
const resume = await s2.next("resume");
check("searcher resumes after a decline", !!resume);
const o2 = (await bg2.next("offer")) ?? (await bg1.next("offer"));
check("next background player is asked", !!o2?.room && o2.room !== o1?.room);

// 4. Background player leaves mid-offer -> searcher resumes.
if (o2) {
  (bg2.msgs && o2 ? bg2 : bg1).ws.close();
  bg1.ws.close();
  bg2.ws.close();
}
const resume2 = await s2.next("resume");
check("searcher resumes when the other player leaves", !!resume2);

// Clear everyone from earlier scenarios.
for (const c of [p1, p2, bg, s, bg1, bg2, s2]) c.ws.close();
await sleep(300);

// 5. Two searchers still pair instantly.
const a = conn("search", "devF"); await a.opened;
const b = conn("search", "devG"); await b.opened;
const ma = await a.next("match");
const mb = await b.next("match");
check("two searchers pair instantly", ma?.room && ma.room === mb?.room);

// 6. The same device is never paired with itself.
const self1 = conn("background", "devZ"); await self1.opened;
const self2 = conn("search", "devZ"); await self2.opened;
const selfOffer = await self1.next("offer", 800);
check("a device isn't offered to itself", !selfOffer);

console.log(ok ? "ALL OK" : "SOME FAILED");
process.exit(ok ? 0 : 1);
