/// <reference types="@cloudflare/workers-types" />
//
// Cloudflare Worker + Durable Object realtime chess server (replaces PartyKit, whose
// shared free hosting is at capacity). One Durable Object instance = one game room,
// keyed by the room id in the URL (/room/<id>). The DO is AUTHORITATIVE: the first two
// players to connect get White and Black, and every move is validated server-side with
// chess.js, so illegal or out-of-turn moves are impossible. State is broadcast to both
// browsers after each change, so they stay in sync wherever they are.

import { Chess } from "chess.js";

export interface Env {
  CHESS_ROOM: DurableObjectNamespace;
}

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    const url = new URL(request.url);
    const parts = url.pathname.split("/").filter(Boolean);
    if (parts[0] === "room" && parts[1]) {
      const stub = env.CHESS_ROOM.get(env.CHESS_ROOM.idFromName(parts[1]));
      return stub.fetch(request);
    }
    return new Response("Chronael chess server is running.", {
      status: 200,
      headers: { "content-type": "text/plain" },
    });
  },
};

export class ChessRoom {
  private chess = new Chess();
  private sessions = new Map<WebSocket, string>();
  private white?: string;
  private black?: string;
  private counter = 0;

  constructor(_state: DurableObjectState, _env: Env) {}

  async fetch(request: Request): Promise<Response> {
    if (request.headers.get("Upgrade") !== "websocket") {
      return new Response("Expected a WebSocket connection.", { status: 426 });
    }

    const pair = new WebSocketPair();
    const client = pair[0];
    const server = pair[1];
    server.accept();

    const connId = "c" + ++this.counter;
    this.sessions.set(server, connId);

    let color: "white" | "black" | "spectator" = "spectator";
    if (!this.white) {
      this.white = connId;
      color = "white";
    } else if (!this.black) {
      this.black = connId;
      color = "black";
    }

    server.send(JSON.stringify({ type: "init", color, ...this.stateObj() }));
    this.broadcast();

    server.addEventListener("message", (evt) => this.onMessage(connId, evt.data as string));
    server.addEventListener("close", () => this.onClose(server, connId));
    server.addEventListener("error", () => this.onClose(server, connId));

    return new Response(null, { status: 101, webSocket: client });
  }

  private onMessage(connId: string, data: string): void {
    let msg: { type?: string; from?: string; to?: string; promotion?: string };
    try {
      msg = JSON.parse(data);
    } catch {
      return;
    }

    if (msg.type === "move" && msg.from && msg.to) {
      const color = connId === this.white ? "white" : connId === this.black ? "black" : "spectator";
      const turn = this.chess.turn() === "w" ? "white" : "black";
      if (color !== turn) return; // spectators and out-of-turn moves ignored
      try {
        const m = this.chess.move({ from: msg.from, to: msg.to, promotion: msg.promotion || undefined });
        if (m) this.broadcast([m.from, m.to]);
      } catch {
        // illegal move: ignore
      }
    } else if (msg.type === "reset") {
      if (connId === this.white || connId === this.black) {
        this.chess.reset();
        this.broadcast();
      }
    }
  }

  private onClose(ws: WebSocket, connId: string): void {
    this.sessions.delete(ws);
    if (connId === this.white) this.white = undefined;
    else if (connId === this.black) this.black = undefined;
    this.broadcast();
  }

  private result(): string {
    if (this.chess.isCheckmate()) return this.chess.turn() === "w" ? "0-1" : "1-0";
    if (this.chess.isStalemate() || this.chess.isDraw()) return "1/2-1/2";
    return "*";
  }

  private stateObj(lastMove?: [string, string]) {
    return {
      fen: this.chess.fen(),
      turn: this.chess.turn() === "w" ? "white" : "black",
      lastMove: lastMove ?? null,
      whitePresent: !!this.white,
      blackPresent: !!this.black,
      over: this.chess.isGameOver(),
      result: this.chess.isGameOver() ? this.result() : null,
    };
  }

  private broadcast(lastMove?: [string, string]): void {
    const msg = JSON.stringify({ type: "state", ...this.stateObj(lastMove) });
    for (const ws of this.sessions.keys()) {
      try {
        ws.send(msg);
      } catch {
        // dead socket; will be cleaned up on close
      }
    }
  }
}
