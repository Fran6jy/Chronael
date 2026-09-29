// Client side of "Play a friend": a WebSocket to the authoritative Cloudflare Worker /
// Durable Object room server (worker/chess.ts). The server is the source of truth; we
// send intentions (move, resign, draw, rematch) and render whatever it broadcasts back.
//
// Each device keeps a secret token per room in localStorage. The server stores only its
// hash and binds it to a seat, so a refresh or dropped connection gets the same colour
// back. The socket reconnects automatically with backoff.

export type OnlineColor = "white" | "black" | "spectator";
export type Seat = "white" | "black";

export interface PlayerView {
  claimed: boolean;
  online: boolean;
  name: string;
  awayMs: number;
}

export interface OnlineState {
  fen: string;
  moves: string[];
  turn: Seat;
  lastMove: [string, string] | null;
  whitePresent: boolean;
  blackPresent: boolean;
  players: Record<Seat, PlayerView>;
  status: "waiting" | "active" | "checkmate" | "stalemate" | "draw" | "resigned" | "agreed" | "abandoned";
  winner: Seat | null;
  over: boolean;
  result: string | null;
  drawOffer: Seat | null;
  drawBlockedUntil: Partial<Record<Seat, number>>;
  rematch: Partial<Record<Seat, boolean>>;
  spectators: number;
  game: number;
  abandonMs: number;
}

// In dev, `wrangler dev` serves the Worker on 127.0.0.1:8787. In production set
// VITE_GAME_HOST to your deployed Worker host (e.g. chronael-chess.<you>.workers.dev).
const HOST = (import.meta.env.VITE_GAME_HOST as string | undefined) || "127.0.0.1:8787";

export function gameConfigured(): boolean {
  return Boolean(import.meta.env.VITE_GAME_HOST) || import.meta.env.DEV;
}

function roomToken(room: string): string {
  const key = `chronael.seat.${room}`;
  try {
    const existing = localStorage.getItem(key);
    if (existing) return existing;
    const fresh = crypto.randomUUID();
    localStorage.setItem(key, fresh);
    return fresh;
  } catch {
    return crypto.randomUUID();
  }
}

export function savedName(): string {
  try {
    return localStorage.getItem("chronael.name") ?? "";
  } catch {
    return "";
  }
}

export function saveName(name: string): void {
  try {
    localStorage.setItem("chronael.name", name.trim().slice(0, 20));
  } catch {
    /* ignore */
  }
}

function wsUrl(room: string, token: string, name: string): string {
  const proto = /^(localhost|127\.)/.test(HOST) ? "ws" : "wss";
  const q = new URLSearchParams({ token });
  if (name) q.set("name", name);
  return `${proto}://${HOST}/room/${encodeURIComponent(room)}?${q}`;
}

export type ConnectionState = "connecting" | "open" | "reconnecting";

export class OnlineGame {
  private ws: WebSocket | null = null;
  private room = "";
  private closedByUser = false;
  private retry = 0;
  private pingTimer: number | undefined;
  color: OnlineColor = "spectator";

  onInit?: (color: OnlineColor, state: OnlineState) => void;
  onState?: (state: OnlineState) => void;
  onConnection?: (state: ConnectionState) => void;

  connect(room: string): void {
    this.room = room;
    this.closedByUser = false;
    this.open();
  }

  private open(): void {
    this.onConnection?.(this.retry === 0 ? "connecting" : "reconnecting");
    const ws = new WebSocket(wsUrl(this.room, roomToken(this.room), savedName()));
    this.ws = ws;

    ws.addEventListener("open", () => {
      this.retry = 0;
      this.onConnection?.("open");
      window.clearInterval(this.pingTimer);
      this.pingTimer = window.setInterval(() => this.send({ type: "ping" }), 25_000);
    });
    ws.addEventListener("message", (e: MessageEvent) => {
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
    ws.addEventListener("close", () => {
      window.clearInterval(this.pingTimer);
      if (this.closedByUser || this.ws !== ws) return;
      this.retry++;
      this.onConnection?.("reconnecting");
      const delay = Math.min(10_000, 500 * 2 ** Math.min(this.retry, 5));
      window.setTimeout(() => {
        if (!this.closedByUser) this.open();
      }, delay);
    });
  }

  private send(msg: object): void {
    if (this.ws?.readyState === WebSocket.OPEN) this.ws.send(JSON.stringify(msg));
  }

  move(from: string, to: string, promotion?: string): void {
    this.send({ type: "move", from, to, promotion });
  }
  resign(): void {
    this.send({ type: "resign" });
  }
  offerDraw(): void {
    this.send({ type: "offer_draw" });
  }
  acceptDraw(): void {
    this.send({ type: "accept_draw" });
  }
  declineDraw(): void {
    this.send({ type: "decline_draw" });
  }
  rematch(): void {
    this.send({ type: "rematch" });
  }
  claimWin(): void {
    this.send({ type: "claim_win" });
  }

  close(): void {
    this.closedByUser = true;
    window.clearInterval(this.pingTimer);
    this.ws?.close();
    this.ws = null;
  }
}

/**
 * Quick match: wait in the lobby for anyone else looking for a game. Resolves with a room
 * id when paired, or null after `timeoutMs` (or if the lobby can't be reached). Call the
 * returned `cancel` to leave the queue early.
 */
export function quickMatch(timeoutMs = 20_000): { result: Promise<string | null>; cancel: () => void } {
  const proto = /^(localhost|127\.)/.test(HOST) ? "ws" : "wss";
  let ws: WebSocket | null = null;
  let finish: (room: string | null) => void = () => {};
  const result = new Promise<string | null>((resolve) => {
    let done = false;
    finish = (room) => {
      if (done) return;
      done = true;
      window.clearTimeout(timer);
      if (ws && ws.readyState <= WebSocket.OPEN) ws.close();
      resolve(room);
    };
    const timer = window.setTimeout(() => finish(null), timeoutMs);
    try {
      ws = new WebSocket(`${proto}://${HOST}/lobby`);
    } catch {
      finish(null);
      return;
    }
    ws.addEventListener("message", (e: MessageEvent) => {
      try {
        const msg = JSON.parse(e.data as string) as { type?: string; room?: string };
        if (msg.type === "match" && msg.room) finish(msg.room);
      } catch {
        /* ignore */
      }
    });
    ws.addEventListener("error", () => finish(null));
    ws.addEventListener("close", () => window.setTimeout(() => finish(null), 0));
  });
  return { result, cancel: () => finish(null) };
}
