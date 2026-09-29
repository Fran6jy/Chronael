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
  status: "waiting" | "active" | "checkmate" | "stalemate" | "draw" | "resigned" | "agreed" | "abandoned" | "timeout";
  winner: Seat | null;
  over: boolean;
  result: string | null;
  drawOffer: Seat | null;
  drawBlockedUntil: Partial<Record<Seat, number>>;
  rematch: Partial<Record<Seat, boolean>>;
  spectators: number;
  game: number;
  abandonMs: number;
  turnDeadline: number | null; // server epoch ms by which the side to move must move
  moveMs: number;
  serverNow: number; // server clock when this state was sent (to correct for skew)
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

/** One id per device, so the "online" count doesn't double-count open tabs. */
function deviceId(): string {
  try {
    let id = localStorage.getItem("chronael.device");
    if (!id) {
      id = crypto.randomUUID();
      localStorage.setItem("chronael.device", id);
    }
    return id;
  } catch {
    return crypto.randomUUID();
  }
}

function lobbyUrl(mode: "presence" | "search" | "background"): string {
  const proto = /^(localhost|127\.)/.test(HOST) ? "ws" : "wss";
  return `${proto}://${HOST}/lobby?mode=${mode}&cid=${encodeURIComponent(deviceId())}`;
}

type LobbyMsg = { type?: string; room?: string; online?: number; expiresInMs?: number };

function parse(e: MessageEvent): LobbyMsg | null {
  try {
    return JSON.parse(e.data as string) as LobbyMsg;
  } catch {
    return null;
  }
}

/**
 * Presence: keeps a light connection to the lobby and reports how many devices have
 * Chronael open (including this one). Reconnects quietly. Returns a stop function.
 */
export function watchPresence(onCount: (online: number) => void): () => void {
  let ws: WebSocket | null = null;
  let stopped = false;
  let retry = 0;
  const open = () => {
    if (stopped) return;
    try {
      ws = new WebSocket(lobbyUrl("presence"));
    } catch {
      return;
    }
    ws.addEventListener("open", () => (retry = 0));
    ws.addEventListener("message", (e) => {
      const m = parse(e);
      if (m && typeof m.online === "number") onCount(m.online);
    });
    ws.addEventListener("close", () => {
      if (stopped) return;
      retry++;
      window.setTimeout(open, Math.min(30_000, 2000 * 2 ** Math.min(retry, 4)));
    });
  };
  open();
  return () => {
    stopped = true;
    ws?.close();
  };
}

export interface QuickMatchHandlers {
  onPresence?: (online: number) => void;
  onPending?: () => void; // someone was found; waiting for them to accept
  onResume?: () => void; // they didn't; still searching
}

/**
 * Quick match: wait in the lobby for anyone else looking for a game, or for someone
 * playing the computer in the background to accept. Resolves with a room id when paired,
 * or null after `timeoutMs` of searching (the clock pauses while an offer is pending) or
 * if the lobby can't be reached. Call `cancel` to leave the queue early.
 */
export function quickMatch(
  timeoutMs = 20_000,
  handlers: QuickMatchHandlers = {},
): { result: Promise<string | null>; cancel: () => void } {
  let ws: WebSocket | null = null;
  let finish: (room: string | null) => void = () => {};
  const result = new Promise<string | null>((resolve) => {
    let done = false;
    let timer = 0;
    let left = timeoutMs;
    let startedAt = Date.now();
    const arm = () => {
      window.clearTimeout(timer);
      startedAt = Date.now();
      timer = window.setTimeout(() => finish(null), left);
    };
    finish = (room) => {
      if (done) return;
      done = true;
      window.clearTimeout(timer);
      if (ws && ws.readyState <= WebSocket.OPEN) ws.close();
      resolve(room);
    };
    arm();
    try {
      ws = new WebSocket(lobbyUrl("search"));
    } catch {
      finish(null);
      return;
    }
    ws.addEventListener("message", (e) => {
      const m = parse(e);
      if (!m) return;
      if (typeof m.online === "number") handlers.onPresence?.(m.online);
      if (m.type === "match" && m.room) finish(m.room);
      else if (m.type === "pending") {
        // Pause the search clock while someone decides.
        window.clearTimeout(timer);
        left = Math.max(5000, left - (Date.now() - startedAt));
        handlers.onPending?.();
      } else if (m.type === "resume") {
        arm();
        handlers.onResume?.();
      }
    });
    ws.addEventListener("error", () => finish(null));
    ws.addEventListener("close", () => window.setTimeout(() => finish(null), 0));
  });
  return { result, cancel: () => finish(null) };
}

export interface BackgroundOffer {
  expiresInMs: number;
  accept: () => void;
  decline: () => void;
}

/**
 * While playing the computer after an empty Quick match, stay matchable. `onOffer` fires
 * when someone searches; accepting resolves `onMatch` with the room. Returns a stop fn.
 */
export function backgroundSearch(
  onOffer: (offer: BackgroundOffer) => void,
  onOfferClosed: () => void,
  onMatch: (room: string) => void,
): () => void {
  let stopped = false;
  let ws: WebSocket | null = null;
  try {
    ws = new WebSocket(lobbyUrl("background"));
  } catch {
    return () => {};
  }
  const sock = ws;
  sock.addEventListener("message", (e) => {
    const m = parse(e);
    if (!m || stopped) return;
    if (m.type === "offer" && m.room) {
      const room = m.room;
      onOffer({
        expiresInMs: m.expiresInMs ?? 15_000,
        accept: () => sock.send(JSON.stringify({ type: "accept", room })),
        decline: () => sock.send(JSON.stringify({ type: "decline", room })),
      });
    } else if (m.type === "offer_closed") onOfferClosed();
    else if (m.type === "go" && m.room) onMatch(m.room);
  });
  return () => {
    stopped = true;
    sock.close();
  };
}
