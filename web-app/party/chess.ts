// PartyKit room server: one room = one chess game between two people.
//
// It is AUTHORITATIVE. The first two players to join are assigned White and Black;
// everyone else is a spectator. Moves are validated server-side with chess.js, so a
// client cannot make an illegal or out-of-turn move even if it tries. The server
// broadcasts the full position after every change, so the two browsers stay in sync
// regardless of where they are.

import type * as Party from "partykit/server";
import { Chess } from "chess.js";

type ClientMsg =
  | { type: "move"; from: string; to: string; promotion?: string }
  | { type: "reset" };

export default class ChessRoom implements Party.Server {
  chess = new Chess();
  white?: string;
  black?: string;

  constructor(readonly room: Party.Room) {}

  private colorOf(id: string): "white" | "black" | "spectator" {
    if (id === this.white) return "white";
    if (id === this.black) return "black";
    return "spectator";
  }

  private result(): string {
    if (this.chess.isCheckmate()) return this.chess.turn() === "w" ? "0-1" : "1-0";
    if (this.chess.isStalemate() || this.chess.isDraw()) return "1/2-1/2";
    return "*";
  }

  private state(lastMove?: [string, string]) {
    return {
      fen: this.chess.fen(),
      turn: this.chess.turn() === "w" ? "white" : ("black" as "white" | "black"),
      lastMove: lastMove ?? null,
      whitePresent: !!this.white,
      blackPresent: !!this.black,
      over: this.chess.isGameOver(),
      result: this.chess.isGameOver() ? this.result() : null,
    };
  }

  onConnect(conn: Party.Connection) {
    let color: "white" | "black" | "spectator" = "spectator";
    if (!this.white) {
      this.white = conn.id;
      color = "white";
    } else if (!this.black) {
      this.black = conn.id;
      color = "black";
    }
    conn.send(JSON.stringify({ type: "init", color, ...this.state() }));
    this.room.broadcast(JSON.stringify({ type: "state", ...this.state() }));
  }

  onMessage(message: string, sender: Party.Connection) {
    let msg: ClientMsg;
    try {
      msg = JSON.parse(message) as ClientMsg;
    } catch {
      return;
    }

    if (msg.type === "move") {
      const color = this.colorOf(sender.id);
      const turn = this.chess.turn() === "w" ? "white" : "black";
      if (color !== turn) return; // spectators and out-of-turn moves are ignored
      try {
        const m = this.chess.move({
          from: msg.from,
          to: msg.to,
          promotion: (msg.promotion as "q" | "r" | "b" | "n" | undefined) || undefined,
        });
        if (m) this.room.broadcast(JSON.stringify({ type: "state", ...this.state([m.from, m.to]) }));
      } catch {
        // illegal move: ignore
      }
    } else if (msg.type === "reset") {
      if (this.colorOf(sender.id) !== "spectator") {
        this.chess.reset();
        this.room.broadcast(JSON.stringify({ type: "state", ...this.state() }));
      }
    }
  }

  onClose(conn: Party.Connection) {
    if (conn.id === this.white) this.white = undefined;
    else if (conn.id === this.black) this.black = undefined;
    this.room.broadcast(JSON.stringify({ type: "state", ...this.state() }));
  }
}
