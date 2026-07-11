// Client side of "Play a friend": a WebSocket to the authoritative Cloudflare Worker /
// Durable Object room server (worker/chess.ts). The server is the source of truth; we
// send our moves and render whatever position it broadcasts back, so two browsers stay
// in sync wherever they are.

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

// In dev, `wrangler dev` serves the Worker on 127.0.0.1:8787. In production set
// VITE_GAME_HOST to your deployed Worker host (e.g. chronael-chess.<you>.workers.dev).
const HOST = (import.meta.env.VITE_GAME_HOST as string | undefined) || "127.0.0.1:8787";

export function gameConfigured(): boolean {
  return Boolean(import.meta.env.VITE_GAME_HOST) || import.meta.env.DEV;
}

function wsUrl(room: string): string {
  const proto = /^(localhost|127\.)/.test(HOST) ? "ws" : "wss";
  return `${proto}://${HOST}/room/${encodeURIComponent(room)}`;
}

export class OnlineGame {
  private ws: WebSocket | null = null;
  color: OnlineColor = "spectator";

  onInit?: (color: OnlineColor, state: OnlineState) => void;
  onState?: (state: OnlineState) => void;

  connect(room: string): void {
    this.ws = new WebSocket(wsUrl(room));
    this.ws.addEventListener("message", (e: MessageEvent) => {
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
    if (this.ws?.readyState === WebSocket.OPEN) {
      this.ws.send(JSON.stringify({ type: "move", from, to, promotion }));
    }
  }

  reset(): void {
    if (this.ws?.readyState === WebSocket.OPEN) this.ws.send(JSON.stringify({ type: "reset" }));
  }

  close(): void {
    this.ws?.close();
    this.ws = null;
  }
}
