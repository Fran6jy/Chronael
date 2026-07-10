// Client side of "Play a friend": a thin wrapper over a PartySocket connection to the
// authoritative room server (party/chess.ts). The server is the source of truth; we
// send our moves and render whatever position it broadcasts back.

import PartySocket from "partysocket";

export type OnlineColor = "white" | "black" | "spectator";

export interface OnlineState {
  fen: string;
  turn: "white" | "black";
  lastMove: [string, string] | null;
  whitePresent: boolean;
  blackPresent: boolean;
  over: boolean;
  result: string | null;
}

// In dev, `partykit dev` serves on 127.0.0.1:1999. In production set
// VITE_PARTYKIT_HOST to your deployed host (e.g. chronael-chess.<user>.partykit.dev).
const HOST = (import.meta.env.VITE_PARTYKIT_HOST as string | undefined) || "127.0.0.1:1999";

export function partykitConfigured(): boolean {
  return Boolean(import.meta.env.VITE_PARTYKIT_HOST) || import.meta.env.DEV;
}

export class OnlineGame {
  private socket: PartySocket | null = null;
  color: OnlineColor = "spectator";

  onInit?: (color: OnlineColor, state: OnlineState) => void;
  onState?: (state: OnlineState) => void;

  connect(room: string): void {
    this.socket = new PartySocket({ host: HOST, room });
    this.socket.addEventListener("message", (e: MessageEvent) => {
      let msg: { type?: string; color?: OnlineColor } & Partial<OnlineState>;
      try {
        msg = JSON.parse(e.data as string);
      } catch {
        return;
      }
      if (msg.type === "init") {
        this.color = (msg.color as OnlineColor) ?? "spectator";
        this.onInit?.(this.color, msg as OnlineState);
      } else if (msg.type === "state") {
        this.onState?.(msg as OnlineState);
      }
    });
  }

  move(from: string, to: string, promotion?: string): void {
    this.socket?.send(JSON.stringify({ type: "move", from, to, promotion }));
  }

  reset(): void {
    this.socket?.send(JSON.stringify({ type: "reset" }));
  }

  close(): void {
    this.socket?.close();
    this.socket = null;
  }
}
