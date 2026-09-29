/// <reference types="@cloudflare/workers-types" />
//
// Chronael realtime server: a Cloudflare Worker + two Durable Objects.
//
// ChessRoom (one per /room/<id>) is AUTHORITATIVE for a game between two people:
//  - Seats are bound to a secret per-device token. Only its SHA-256 hash is kept, so a
//    refresh or reconnect always gets the same colour back, and a stolen room link
//    alone can't take over someone's seat.
//  - Every move is validated with chess.js; illegal and out-of-turn moves are ignored.
//  - Resign, draw offers (with a cooldown after a decline), rematch votes (colours swap),
//    presence, and claiming the win when the opponent has been gone for a minute.
//  - A move timer: whoever is to move has 60 seconds, enforced by a Durable Object alarm
//    (so it fires even if nobody is connected); running out loses the game.
//  - State is persisted to Durable Object storage, so a game survives restarts and
//    long gaps (both players can close their tabs and come back later).
//
// RateLimiter (one per bucket+ip) is a globally-consistent sliding-window counter used
// by the Vercel coach proxy via POST /ratelimit (protected by a shared secret).

import { Chess } from "chess.js";

export interface Env {
  CHESS_ROOM: DurableObjectNamespace;
  RATE_LIMITER: DurableObjectNamespace;
  LOBBY: DurableObjectNamespace;
  RL_SECRET?: string;
}

type Seat = "white" | "black";
type Role = Seat | "spectator";
type Status =
  | "waiting"
  | "active"
  | "checkmate"
  | "stalemate"
  | "draw"
  | "resigned"
  | "agreed"
  | "abandoned"
  | "timeout";

const ABANDON_MS = 60_000; // opponent must be gone this long before you can claim the win
const MOVE_MS = 60_000; // time allowed for each move; running out loses
const DRAW_GAP_PLIES = 6; // after a declined offer, wait this many plies before offering again
const MAX_MSGS_PER_10S = 40;

async function sha256(text: string): Promise<string> {
  const buf = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(text));
  return [...new Uint8Array(buf)].map((b) => b.toString(16).padStart(2, "0")).join("");
}

function cleanName(raw: string | null): string {
  const s = (raw ?? "").replace(/[^\p{L}\p{N} ._'-]/gu, "").trim().slice(0, 20);
  return s;
}

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    const url = new URL(request.url);
    const parts = url.pathname.split("/").filter(Boolean);

    if (parts[0] === "room" && parts[1] && /^[a-z0-9-]{3,40}$/i.test(parts[1])) {
      const stub = env.CHESS_ROOM.get(env.CHESS_ROOM.idFromName(parts[1].toLowerCase()));
      return stub.fetch(request);
    }

    // Quick match: everyone looking for a game waits in one lobby until paired.
    if (parts[0] === "lobby") {
      const stub = env.LOBBY.get(env.LOBBY.idFromName("global"));
      return stub.fetch(request);
    }

    if (parts[0] === "ratelimit" && request.method === "POST") {
      if (!env.RL_SECRET || request.headers.get("x-rl-secret") !== env.RL_SECRET) {
        return new Response("forbidden", { status: 403 });
      }
      const body = (await request.json().catch(() => ({}))) as { key?: string; limit?: number; windowMs?: number };
      if (!body.key || typeof body.key !== "string" || body.key.length > 120) {
        return new Response("bad request", { status: 400 });
      }
      const stub = env.RATE_LIMITER.get(env.RATE_LIMITER.idFromName(body.key));
      return stub.fetch("https://rl/check", { method: "POST", body: JSON.stringify(body) });
    }

    return new Response("Chronael chess server is running.", {
      status: 200,
      headers: { "content-type": "text/plain" },
    });
  },
};

interface SeatInfo {
  hash: string;
  name: string;
  lastSeen: number;
}

interface Snapshot {
  moves: string[];
  seats: Partial<Record<Seat, SeatInfo>>;
  status: Status;
  winner: Seat | null;
  drawOffer: Seat | null;
  drawBlockedUntil: Partial<Record<Seat, number>>;
  rematch: Partial<Record<Seat, boolean>>;
  game: number;
  turnDeadline?: number | null; // epoch ms by which the side to move must move
}

interface Conn {
  role: Role;
  hash: string;
  msgTimes: number[];
}

export class ChessRoom {
  private chess = new Chess();
  private conns = new Map<WebSocket, Conn>();
  private snap: Snapshot = {
    moves: [],
    seats: {},
    status: "waiting",
    winner: null,
    drawOffer: null,
    drawBlockedUntil: {},
    rematch: {},
    game: 1,
  };
  private lastMove: [string, string] | null = null;

  constructor(private state: DurableObjectState, _env: Env) {
    this.state.blockConcurrencyWhile(async () => {
      const saved = await this.state.storage.get<Snapshot>("room");
      if (saved) {
        this.snap = { ...this.snap, ...saved };
        for (const san of this.snap.moves) this.chess.move(san);
        const hist = this.chess.history({ verbose: true });
        const last = hist[hist.length - 1];
        this.lastMove = last ? [last.from, last.to] : null;
      }
    });
  }

  private async save(): Promise<void> {
    await this.state.storage.put("room", this.snap);
  }

  async fetch(request: Request): Promise<Response> {
    if (request.headers.get("Upgrade") !== "websocket") {
      return new Response("Expected a WebSocket connection.", { status: 426 });
    }
    const url = new URL(request.url);
    const token = url.searchParams.get("token") || crypto.randomUUID();
    const hash = await sha256(token);
    const name = cleanName(url.searchParams.get("name"));

    const pair = new WebSocketPair();
    const client = pair[0];
    const server = pair[1];
    server.accept();

    // Reclaim an existing seat by token, else take a free seat, else spectate.
    let role: Role = "spectator";
    for (const seat of ["white", "black"] as Seat[]) {
      if (this.snap.seats[seat]?.hash === hash) role = seat;
    }
    if (role === "spectator") {
      for (const seat of ["white", "black"] as Seat[]) {
        if (!this.snap.seats[seat]) {
          this.snap.seats[seat] = { hash, name, lastSeen: Date.now() };
          role = seat;
          break;
        }
      }
    }
    if (role !== "spectator") {
      const info = this.snap.seats[role]!;
      info.lastSeen = Date.now();
      if (name) info.name = name;
      if (this.snap.status === "waiting" && this.snap.seats.white && this.snap.seats.black) {
        this.snap.status = "active";
        await this.armClock();
      }
    }

    this.conns.set(server, { role, hash, msgTimes: [] });
    await this.save();

    server.send(JSON.stringify({ type: "init", color: role, ...this.stateObj() }));
    this.broadcast();

    server.addEventListener("message", (evt) => void this.onMessage(server, evt.data as string));
    server.addEventListener("close", () => this.onClose(server));
    server.addEventListener("error", () => this.onClose(server));

    return new Response(null, { status: 101, webSocket: client });
  }

  private online(seat: Seat): boolean {
    for (const c of this.conns.values()) if (c.role === seat) return true;
    return false;
  }

  private other(seat: Seat): Seat {
    return seat === "white" ? "black" : "white";
  }

  private finishIfOver(): void {
    if (!this.chess.isGameOver()) return;
    if (this.chess.isCheckmate()) {
      this.snap.status = "checkmate";
      this.snap.winner = this.chess.turn() === "w" ? "black" : "white";
    } else if (this.chess.isStalemate()) {
      this.snap.status = "stalemate";
    } else {
      this.snap.status = "draw";
    }
    this.snap.drawOffer = null;
  }

  private isOver(): boolean {
    return !["waiting", "active"].includes(this.snap.status);
  }

  private async onMessage(ws: WebSocket, data: string): Promise<void> {
    const conn = this.conns.get(ws);
    if (!conn) return;

    // Per-socket flood guard.
    const now = Date.now();
    conn.msgTimes = conn.msgTimes.filter((t) => now - t < 10_000);
    conn.msgTimes.push(now);
    if (conn.msgTimes.length > MAX_MSGS_PER_10S) return;

    let msg: { type?: string; from?: string; to?: string; promotion?: string };
    try {
      msg = JSON.parse(data);
    } catch {
      return;
    }

    if (msg.type === "ping") {
      ws.send(JSON.stringify({ type: "pong" }));
      return;
    }
    if (conn.role === "spectator") return;
    const seat = conn.role;
    this.snap.seats[seat]!.lastSeen = now;
    let changed = false;

    switch (msg.type) {
      case "move": {
        if (this.snap.status !== "active") return;
        const turn: Seat = this.chess.turn() === "w" ? "white" : "black";
        if (seat !== turn || typeof msg.from !== "string" || typeof msg.to !== "string") return;
        const promo = ["q", "r", "b", "n"].includes(msg.promotion ?? "") ? msg.promotion : undefined;
        try {
          const m = this.chess.move({ from: msg.from, to: msg.to, promotion: promo });
          if (!m) return;
          this.snap.moves.push(m.san);
          this.lastMove = [m.from, m.to];
          if (this.snap.drawOffer && this.snap.drawOffer !== seat) this.snap.drawOffer = null; // moving declines
          this.finishIfOver();
          changed = true;
        } catch {
          return; // illegal
        }
        await this.armClock();
        break;
      }
      case "resign": {
        if (this.snap.status !== "active") return;
        this.snap.status = "resigned";
        this.snap.winner = this.other(seat);
        this.snap.drawOffer = null;
        changed = true;
        break;
      }
      case "offer_draw": {
        if (this.snap.status !== "active" || this.snap.drawOffer) return;
        if ((this.snap.drawBlockedUntil[seat] ?? 0) > this.snap.moves.length) return;
        this.snap.drawOffer = seat;
        changed = true;
        break;
      }
      case "accept_draw": {
        if (this.snap.status !== "active" || this.snap.drawOffer !== this.other(seat)) return;
        this.snap.status = "agreed";
        this.snap.winner = null;
        this.snap.drawOffer = null;
        changed = true;
        break;
      }
      case "decline_draw": {
        const offerer = this.snap.drawOffer;
        if (!offerer || offerer === seat) return;
        this.snap.drawOffer = null;
        this.snap.drawBlockedUntil[offerer] = this.snap.moves.length + DRAW_GAP_PLIES;
        changed = true;
        break;
      }
      case "claim_win": {
        if (this.snap.status !== "active") return;
        const opp = this.other(seat);
        const oppInfo = this.snap.seats[opp];
        if (!oppInfo || this.online(opp) || now - oppInfo.lastSeen < ABANDON_MS) return;
        this.snap.status = "abandoned";
        this.snap.winner = seat;
        changed = true;
        break;
      }
      case "rematch": {
        if (!this.isOver()) return;
        this.snap.rematch[seat] = true;
        if (this.snap.rematch.white && this.snap.rematch.black) {
          // New game, colours swapped.
          const { white, black } = this.snap.seats;
          this.snap.seats = { white: black, black: white };
          for (const c of this.conns.values()) {
            if (c.role !== "spectator") c.role = this.other(c.role);
          }
          this.chess.reset();
          this.lastMove = null;
          this.snap = {
            ...this.snap,
            moves: [],
            status: "active",
            winner: null,
            drawOffer: null,
            drawBlockedUntil: {},
            rematch: {},
            game: this.snap.game + 1,
          };
          await this.armClock();
          // Tell each socket its (new) colour.
          for (const [sock, c] of this.conns) {
            try {
              sock.send(JSON.stringify({ type: "init", color: c.role, ...this.stateObj() }));
            } catch {
              /* ignore */
            }
          }
        }
        changed = true;
        break;
      }
      default:
        return;
    }

    if (changed) {
      if (this.isOver() && this.snap.turnDeadline) await this.armClock();
      await this.save();
      this.broadcast();
    }
  }

  /** Start (or stop) the move clock for whoever is to move now. */
  private async armClock(): Promise<void> {
    if (this.snap.status === "active") {
      this.snap.turnDeadline = Date.now() + MOVE_MS;
      await this.state.storage.setAlarm(this.snap.turnDeadline);
    } else {
      this.snap.turnDeadline = null;
      await this.state.storage.deleteAlarm();
    }
  }

  /** The move clock ran out: the side to move loses on time. */
  async alarm(): Promise<void> {
    const deadline = this.snap.turnDeadline;
    if (this.snap.status !== "active" || !deadline) return;
    if (Date.now() < deadline - 250) {
      await this.state.storage.setAlarm(deadline); // woke early; try again
      return;
    }
    const loser: Seat = this.chess.turn() === "w" ? "white" : "black";
    this.snap.status = "timeout";
    this.snap.winner = this.other(loser);
    this.snap.drawOffer = null;
    this.snap.turnDeadline = null;
    await this.save();
    this.broadcast();
  }

  private onClose(ws: WebSocket): void {
    const conn = this.conns.get(ws);
    if (!conn) return;
    this.conns.delete(ws);
    if (conn.role !== "spectator") {
      // Seat stays reserved for this token; just note when they were last here.
      this.snap.seats[conn.role]!.lastSeen = Date.now();
      void this.save();
    }
    this.broadcast();
  }

  private result(): string | null {
    if (!this.isOver()) return null;
    if (this.snap.winner === "white") return "1-0";
    if (this.snap.winner === "black") return "0-1";
    return "1/2-1/2";
  }

  private stateObj() {
    const now = Date.now();
    const seatView = (seat: Seat) => {
      const info = this.snap.seats[seat];
      const online = this.online(seat);
      return {
        claimed: !!info,
        online,
        name: info?.name || "",
        awayMs: info && !online ? now - info.lastSeen : 0,
      };
    };
    let spectators = 0;
    for (const c of this.conns.values()) if (c.role === "spectator") spectators++;
    return {
      fen: this.chess.fen(),
      moves: this.snap.moves,
      turn: this.chess.turn() === "w" ? "white" : "black",
      lastMove: this.lastMove,
      whitePresent: !!this.snap.seats.white,
      blackPresent: !!this.snap.seats.black,
      players: { white: seatView("white"), black: seatView("black") },
      status: this.snap.status,
      winner: this.snap.winner,
      over: this.isOver(),
      result: this.result(),
      drawOffer: this.snap.drawOffer,
      drawBlockedUntil: this.snap.drawBlockedUntil,
      rematch: this.snap.rematch,
      spectators,
      game: this.snap.game,
      abandonMs: ABANDON_MS,
      turnDeadline: this.snap.turnDeadline ?? null,
      moveMs: MOVE_MS,
      serverNow: now,
    };
  }

  private broadcast(): void {
    const msg = JSON.stringify({ type: "state", ...this.stateObj() });
    for (const ws of this.conns.keys()) {
      try {
        ws.send(msg);
      } catch {
        // dead socket; cleaned up on close
      }
    }
  }
}

// A sliding-window counter. One instance per key, so the count is exact worldwide.
export class RateLimiter {
  private hits: number[] = [];

  constructor(_state: DurableObjectState, _env: Env) {}

  async fetch(request: Request): Promise<Response> {
    const body = (await request.json().catch(() => ({}))) as { limit?: number; windowMs?: number };
    const limit = Math.min(Math.max(body.limit ?? 20, 1), 1000);
    const windowMs = Math.min(Math.max(body.windowMs ?? 60_000, 1000), 3_600_000);
    const now = Date.now();
    this.hits = this.hits.filter((t) => now - t < windowMs);
    const allowed = this.hits.length < limit;
    if (allowed) this.hits.push(now);
    return Response.json({ allowed, remaining: Math.max(0, limit - this.hits.length) });
  }
}


/**
 * Quick-match lobby: one Durable Object for the whole site. Every socket says who it is
 * (`cid`, a per-device id) and why it's here (`mode`):
 *  - presence:   an open Chronael page; only counted, for the "N online" figure.
 *  - search:     actively looking for a game (the Quick match screen).
 *  - background: playing the computer after nobody was found, but still happy to be
 *                matched. They get an OFFER (Join / Stay, 15 s) when someone searches.
 * Two searchers are paired at once. A searcher and a background player are paired only
 * if the background player accepts; if they decline or don't answer, the searcher goes
 * straight back to searching and the next background player is asked. Anyone closing
 * their socket leaves every queue, so nobody is paired with a ghost.
 */
type LobbyMode = "presence" | "search" | "background";

interface LobbyConn {
  cid: string;
  mode: LobbyMode;
  offer?: string; // room id of a pending offer this socket is part of
}

interface Offer {
  room: string;
  searcher: WebSocket;
  bg: WebSocket;
  timer: ReturnType<typeof setTimeout>;
}

const OFFER_MS = 15_000;

export class Lobby {
  private conns = new Map<WebSocket, LobbyConn>();
  private offers = new Map<string, Offer>();
  private declinedBy = new Map<WebSocket, Set<WebSocket>>(); // searcher -> background players who said no

  constructor(_state: DurableObjectState, _env: Env) {}

  async fetch(request: Request): Promise<Response> {
    if (request.headers.get("Upgrade") !== "websocket") {
      return new Response("Expected a WebSocket connection.", { status: 426 });
    }
    const url = new URL(request.url);
    const modeParam = url.searchParams.get("mode");
    const mode: LobbyMode = modeParam === "presence" || modeParam === "background" ? modeParam : "search";
    const cid = (url.searchParams.get("cid") || crypto.randomUUID()).slice(0, 64);

    const pair = new WebSocketPair();
    const [client, server] = [pair[0], pair[1]];
    server.accept();
    this.conns.set(server, { cid, mode });

    server.addEventListener("message", (evt) => this.onMessage(server, evt.data as string));
    const leave = () => this.leave(server);
    server.addEventListener("close", leave);
    server.addEventListener("error", leave);

    this.send(server, { type: "hello", online: this.online() });
    this.broadcastPresence();
    if (mode === "search") {
      this.send(server, { type: "waiting" });
      this.matchSearcher(server);
    } else if (mode === "background") {
      this.offerToBackground();
    }
    return new Response(null, { status: 101, webSocket: client });
  }

  /** Distinct devices with Chronael open. */
  private online(): number {
    return new Set([...this.conns.values()].map((c) => c.cid)).size;
  }

  private send(ws: WebSocket, msg: object): void {
    try {
      ws.send(JSON.stringify(msg));
    } catch {
      /* closed */
    }
  }

  private broadcastPresence(): void {
    const msg = { type: "presence", online: this.online() };
    for (const ws of this.conns.keys()) this.send(ws, msg);
  }

  private newRoom(): string {
    return `q${crypto.randomUUID().replace(/-/g, "").slice(0, 11)}`;
  }

  private free(ws: WebSocket, mode: LobbyMode): boolean {
    const c = this.conns.get(ws);
    return !!c && c.mode === mode && !c.offer && ws.readyState === WebSocket.READY_STATE_OPEN;
  }

  /** A searcher wants a game: another searcher first, else ask a background player. */
  private matchSearcher(searcher: WebSocket): void {
    if (!this.free(searcher, "search")) return;
    const me = this.conns.get(searcher)!;
    for (const [ws, c] of this.conns) {
      if (ws !== searcher && c.cid !== me.cid && this.free(ws, "search")) {
        const room = this.newRoom();
        this.send(ws, { type: "match", room });
        this.send(searcher, { type: "match", room });
        this.conns.delete(ws);
        this.conns.delete(searcher);
        ws.close(1000, "matched");
        searcher.close(1000, "matched");
        this.broadcastPresence();
        return;
      }
    }
    const declined = this.declinedBy.get(searcher) ?? new Set<WebSocket>();
    for (const [ws, c] of this.conns) {
      if (c.cid !== me.cid && this.free(ws, "background") && !declined.has(ws)) {
        this.makeOffer(searcher, ws);
        return;
      }
    }
  }

  /** A background player became available: offer them to the longest-waiting searcher. */
  private offerToBackground(): void {
    for (const ws of this.conns.keys()) {
      if (this.free(ws, "search")) this.matchSearcher(ws);
    }
  }

  private makeOffer(searcher: WebSocket, bg: WebSocket): void {
    const room = this.newRoom();
    const timer = setTimeout(() => this.endOffer(room, false), OFFER_MS);
    this.offers.set(room, { room, searcher, bg, timer });
    this.conns.get(searcher)!.offer = room;
    this.conns.get(bg)!.offer = room;
    this.send(searcher, { type: "pending" });
    this.send(bg, { type: "offer", room, expiresInMs: OFFER_MS });
  }

  private endOffer(room: string, accepted: boolean): void {
    const offer = this.offers.get(room);
    if (!offer) return;
    clearTimeout(offer.timer);
    this.offers.delete(room);
    const s = this.conns.get(offer.searcher);
    const b = this.conns.get(offer.bg);
    if (s) s.offer = undefined;
    if (b) b.offer = undefined;
    if (accepted && s && b) {
      this.send(offer.searcher, { type: "match", room });
      this.send(offer.bg, { type: "go", room });
      this.conns.delete(offer.searcher);
      this.conns.delete(offer.bg);
      offer.searcher.close(1000, "matched");
      offer.bg.close(1000, "matched");
      this.broadcastPresence();
      return;
    }
    // Declined, timed out, or someone left: tell whoever is still here and move on.
    if (b) {
      this.send(offer.bg, { type: "offer_closed" });
      const set = this.declinedBy.get(offer.searcher) ?? new Set<WebSocket>();
      set.add(offer.bg);
      this.declinedBy.set(offer.searcher, set);
    }
    if (s) {
      this.send(offer.searcher, { type: "resume" });
      this.matchSearcher(offer.searcher);
    }
  }

  private onMessage(ws: WebSocket, data: string): void {
    let msg: { type?: string; room?: string };
    try {
      msg = JSON.parse(data);
    } catch {
      return;
    }
    const c = this.conns.get(ws);
    if (!c || c.mode !== "background" || !msg.room || c.offer !== msg.room) return;
    if (msg.type === "accept") this.endOffer(msg.room, true);
    else if (msg.type === "decline") this.endOffer(msg.room, false);
  }

  private leave(ws: WebSocket): void {
    const c = this.conns.get(ws);
    if (!c) return;
    this.conns.delete(ws); // gone first, so the offer below isn't resolved "back" to them
    if (c.offer) this.endOffer(c.offer, false);
    this.declinedBy.delete(ws);
    for (const set of this.declinedBy.values()) set.delete(ws);
    this.broadcastPresence();
  }
}
