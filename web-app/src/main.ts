import { Chessground } from "chessground";
import type { Api } from "chessground/api";
import type { Config } from "chessground/config";
import type { Key } from "chessground/types";
import { Chess, type Square } from "chess.js";

import { ChessEngine, LEVELS } from "./engine";
import {
  classify,
  tier0Message,
  ratingLabel,
  explain,
  explainMore,
  explainHint,
  hintFallback,
  flipTurn,
  describeMove,
  type CoachFacts,
  type MoveRating,
} from "./coach";
import { askPromotion, type PromotionPiece } from "./promotion";
import { PieceTutorial } from "./tutorial";
import { playMove, playCapture, isMuted, setMuted } from "./sound";
import { CarlsenEngine } from "./carlsen";
import {
  OnlineGame,
  gameConfigured,
  savedName,
  saveName,
  quickMatch,
  watchPresence,
  backgroundSearch,
  type BackgroundOffer,
  type ConnectionState,
  type OnlineColor,
  type OnlineState,
  type Seat,
} from "./online";
import {
  dayKey,
  dailyIndex,
  loadPuzzles,
  loadStreak,
  nextStreak,
  saveStreak,
  visibleStreak,
  THEME_NAMES,
  type Puzzle,
} from "./puzzle";
import { setupPwa } from "./pwa";
import { isMastered, recordLegal, recordIllegal, recordPeek, markTested, masterySummary } from "./mastery";
import { explainIllegal, rightShape, pieceName } from "./rules";
import { startHeroDemo, revealOnScroll } from "./heroDemo";
import {
  progress,
  recordGame,
  recordPuzzle,
  addMistake,
  dueCards,
  reviewCard,
  setLessonStars,
  gameAccuracy,
  type MistakeCard,
} from "./progress";
import { UNITS, allDrills, findDrill, type Unit } from "./lessons";

import type { Move } from "chess.js";

import "chessground/assets/chessground.base.css";
import "chessground/assets/chessground.brown.css";
import "chessground/assets/chessground.cburnett.css";
import "./style.css";

type Color = "white" | "black";
type Mode = "bot" | "puzzle" | "online" | "vision";
type Opponent = "stockfish" | "magnus";

const chess = new Chess();
const engine = new ChessEngine();
const carlsen = new CarlsenEngine();

let mode: Mode = "bot";
let opponent: Opponent = "stockfish";
let playerColor: Color = "white";
let levelIndex = 2;
let lastMove: [Key, Key] | undefined;
let thinking = false;
let botResigned = false;
// A "real game" against the computer (Quick match fallback): no coach, hints,
// take-backs or dots during play; the review is still there afterwards.
let realGame = false;
let gameNo = 0; // bumps on every new bot game, so the result moment shows once per game
let resultShownFor = "";

// Coaching state.
let beforeEval: { fen: string; scoreCp: number; bestUci: string } | null = null;
let feedbackActive = false; // a move-rating message is showing; don't clobber with tips
let coachSeq = 0; // guards against stale async coach updates after take-back / new game
let lastCoachFacts: CoachFacts | null = null;

// Every player move in the current bot game, with engine evals (drives review + stats).
interface MoveEntry {
  ply: number;
  fenBefore: string;
  played: string;
  best: string;
  reply?: string; // the opponent's best answer to what was played
  before: number; // mover's eval before (cp)
  after: number; // mover's eval after (cp)
  rating: MoveRating;
}
let moveLog: MoveEntry[] = [];
let pendingCoach: Promise<void> | null = null;

// Online state.
let online: OnlineGame | null = null;
let onlineColor: OnlineColor = "spectator";
let onlineState: OnlineState | null = null;
let onlineStateAt = 0;
let waitingSince = 0;
let onlineTimer: number | undefined;

const el = <T extends HTMLElement>(id: string) => document.getElementById(id) as T;
const statusEl = el<HTMLSpanElement>("status");
const bannerEl = el<HTMLDivElement>("turn-banner");
const coachEl = el<HTMLDivElement>("coach");
const movesEl = el<HTMLOListElement>("moves");
const onlineMovesEl = el<HTMLOListElement>("online-moves");
const evalFillEl = el<HTMLDivElement>("eval-fill");
const ratingEl = el<HTMLDivElement>("rating");
const capYoursEl = el<HTMLSpanElement>("cap-yours");
const capTheirsEl = el<HTMLSpanElement>("cap-theirs");
const capSummaryEl = el<HTMLDivElement>("cap-summary");
const coachMoreEl = el<HTMLButtonElement>("coach-more");
const onlineCoachEl = el<HTMLDivElement>("online-coach");
const onlineLinkEl = el<HTMLInputElement>("online-link");
const puzzleTextEl = el<HTMLParagraphElement>("puzzle-text");

const PANELS = ["play-panel", "tutorial-panel", "puzzle-panel", "online-panel", "review-panel", "vision-panel"] as const;

const TIPS = [
  "Control the centre: pawns in the middle give your pieces room.",
  "Bring out knights and bishops early; don't move the same piece twice for no reason.",
  "Castle soon to tuck your king safely behind its pawns.",
  "Before you move, ask: is anything of mine under attack?",
  "A piece you can capture for free is usually worth taking.",
];

const cap = (s: string) => s[0].toUpperCase() + s.slice(1);

function colorToMove(): Color {
  return chess.turn() === "w" ? "white" : "black";
}

function sideToMove(fen: string): Color {
  return fen.split(" ")[1] === "w" ? "white" : "black";
}

function playerTurn(): boolean {
  return mode === "bot" && !botResigned && colorToMove() === playerColor && !chess.isGameOver();
}

function canUserMove(): boolean {
  if (mode === "bot") return playerTurn() && !thinking;
  if (mode === "puzzle") return !!ex && !exDone && !exChecking && colorToMove() === playerColor;
  return (
    onlineColor !== "spectator" &&
    onlineState?.status === "active" &&
    colorToMove() === onlineColor &&
    !chess.isGameOver()
  );
}

/** Map of from-square -> reachable squares, for the legal-move dots. */
function legalDests(): Map<Key, Key[]> {
  const dests = new Map<Key, Key[]>();
  for (const m of chess.moves({ verbose: true })) {
    const arr = dests.get(m.from as Key) ?? [];
    arr.push(m.to as Key);
    dests.set(m.from as Key, arr);
  }
  return dests;
}

/** Convert a side-to-move centipawn score into White's perspective (for the bar). */
function whiteCp(fen: string, scoreCp: number): number {
  return sideToMove(fen) === "white" ? scoreCp : -scoreCp;
}

function updateEvalBar(whiteCpVal: number): void {
  const pct = 50 + 50 * Math.tanh(whiteCpVal / 400);
  evalFillEl.style.width = `${pct.toFixed(1)}%`;
}

const INITIAL_COUNT: Record<string, number> = { p: 8, n: 2, b: 2, r: 2, q: 1 };
const PIECE_VALUE: Record<string, number> = { p: 1, n: 3, b: 3, r: 5, q: 9 };
const PIECE_GLYPH: Record<string, string> = { p: "♟", n: "♞", b: "♝", r: "♜", q: "♛" };

/** Captured pieces beside each player, plus a plain-English material summary. */
function updateCaptured(): void {
  const cur: Record<"w" | "b", Record<string, number>> = {
    w: { p: 0, n: 0, b: 0, r: 0, q: 0 },
    b: { p: 0, n: 0, b: 0, r: 0, q: 0 },
  };
  for (const row of chess.board()) {
    for (const sq of row) {
      if (sq && sq.type !== "k") cur[sq.color][sq.type]++;
    }
  }
  let capByWhite = "";
  let capByBlack = "";
  let matW = 0;
  let matB = 0;
  for (const t of ["q", "r", "b", "n", "p"]) {
    capByWhite += PIECE_GLYPH[t].repeat(Math.max(0, INITIAL_COUNT[t] - cur.b[t]));
    capByBlack += PIECE_GLYPH[t].repeat(Math.max(0, INITIAL_COUNT[t] - cur.w[t]));
    matW += cur.w[t] * PIECE_VALUE[t];
    matB += cur.b[t] * PIECE_VALUE[t];
  }
  const diff = playerColor === "white" ? matW - matB : matB - matW;
  capYoursEl.textContent = (playerColor === "white" ? capByWhite : capByBlack) + (diff > 0 ? ` +${diff}` : "");
  capTheirsEl.textContent = (playerColor === "white" ? capByBlack : capByWhite) + (diff < 0 ? ` +${-diff}` : "");
  capSummaryEl.textContent =
    diff > 0
      ? `You’re ahead by ${diff} ${diff === 1 ? "point" : "points"}`
      : diff < 0
        ? `Behind by ${-diff} ${-diff === 1 ? "point" : "points"}`
        : "Even material";
}

function soundForMove(move: Move | null): void {
  if (move && (move.captured || move.flags.includes("e"))) {
    playCapture();
    haptic(18);
  } else playMove();
}

/** A tiny buzz on phones that support it (Android; iOS doesn't let websites vibrate). Off when muted. */
function haptic(ms: number): void {
  if (!isMuted()) navigator.vibrate?.(ms);
}

/** Lift the selected piece (see .lifted in style.css); drop any other lifted piece. */
function liftSelected(): void {
  const sel = ground?.state.selected;
  for (const p of document.querySelectorAll<HTMLElement & { cgKey?: string }>("#board piece")) {
    p.classList.toggle("lifted", !!sel && p.cgKey === sel && !p.classList.contains("ghost"));
  }
}

let ground: Api;
let tutorial: PieceTutorial;

// ---------- Views, panels, players ----------

function showView(view: "home" | "game" | "lessons" | "progress" | "about"): void {
  for (const v of ["home", "game", "lessons", "progress", "about"]) el(v).hidden = v !== view;
  el("nav-about").classList.toggle("active", view === "about");
  const hash = view === "about" ? "#about" : "";
  if (window.location.hash !== hash) window.history.replaceState({}, "", `${window.location.pathname}${window.location.search}${hash}`);
  el("nav-lessons").classList.toggle("active", view === "lessons");
  el("nav-progress").classList.toggle("active", view === "progress");
  window.scrollTo({ top: 0 });
  if (view === "home") refreshHomeCards();
  // The board was measured while hidden; size it now that the game view is visible.
  if (view === "game" && ground) ground.redrawAll();
}

function showPanel(id: (typeof PANELS)[number]): void {
  for (const p of PANELS) el(p).hidden = p !== id;
}

function setPlayer(pos: "top" | "bottom", name: string, sub: string, presence?: boolean): void {
  el(`name-${pos}`).textContent = name;
  el(`sub-${pos}`).textContent = sub;
  const av = el(`avatar-${pos}`);
  av.textContent = (name.trim()[0] ?? "?").toUpperCase();
  av.classList.toggle("online", presence === true);
  av.classList.toggle("offline", presence === false);
}

function renderPlayers(): void {
  const other: Color = playerColor === "white" ? "black" : "white";
  const me = savedName() || "You";
  if (mode === "bot") {
    setPlayer("bottom", me, cap(playerColor));
    setPlayer(
      "top",
      opponent === "magnus" ? "Magnus bot" : "Chronael",
      opponent === "magnus" ? `${cap(other)} · neural net` : `${cap(other)} · level ${levelIndex + 1}`,
    );
  } else if (mode === "puzzle") {
    setPlayer("bottom", me, `${cap(playerColor)} · solving`);
    setPlayer("top", ex?.kind === "lesson" ? "Lesson" : ex?.kind === "mistake" ? "Your game" : "Puzzle", ex?.rating ? `Rated ${ex.rating}` : "");
  } else {
    const s = onlineState;
    const bottomSeat: Seat = playerColor;
    const topSeat: Seat = bottomSeat === "white" ? "black" : "white";
    const view = (seat: Seat) => s?.players[seat];
    const label = (seat: Seat) => {
      const v = view(seat);
      if (!v?.claimed) return "Waiting…";
      const n = v.name || cap(seat);
      return seat === onlineColor ? `${n} (you)` : n;
    };
    const sub = (seat: Seat) => {
      const v = view(seat);
      if (!v?.claimed) return cap(seat);
      return `${cap(seat)} · ${v.online ? "online" : "away"}`;
    };
    setPlayer("bottom", label(bottomSeat), sub(bottomSeat), view(bottomSeat)?.claimed ? view(bottomSeat)!.online : undefined);
    setPlayer("top", label(topSeat), sub(topSeat), view(topSeat)?.claimed ? view(topSeat)!.online : undefined);
  }
  const turn = colorToMove();
  const over = isOver();
  el("row-bottom").classList.toggle("active", !over && turn === playerColor);
  el("row-top").classList.toggle("active", !over && turn !== playerColor);
}

function isOver(): boolean {
  if (mode === "online") return !!onlineState?.over;
  if (mode === "puzzle") return exDone;
  if (mode === "vision") return false;
  return botResigned || chess.isGameOver();
}

function setBanner(text: string): void {
  statusEl.textContent = text;
  const over = isOver();
  bannerEl.classList.toggle("is-over", over);
  bannerEl.classList.toggle("is-you", !over && canUserMove());
  bannerEl.classList.toggle("turn-white", colorToMove() === "white");
  bannerEl.classList.toggle("turn-black", colorToMove() === "black");
}

// ---------- Render ----------

function render(): void {
  const turn = colorToMove();
  const inCheck = chess.isCheck();
  const movable = canUserMove();
  ground.set({
    fen: chess.fen(),
    turnColor: turn,
    lastMove,
    check: inCheck ? turn : undefined,
    // Dots are decided per piece when one is picked up (onSelect). Games against people
    // never show them. free/showDests are reset explicitly: the tutorial test changes both.
    movable: {
      free: mode === "online" || (mode === "bot" && realGame),
      showDests: !(mode === "online" || (mode === "bot" && realGame)),
      color: movable ? playerColor : undefined,
      dests: movable ? legalDests() : new Map(),
    },
  });

  liftSelected(); // a move or a new position clears the selection
  if (mode === "online") updateOnlineUI();
  else if (mode === "puzzle") updatePuzzleStatus();
  else if (mode === "vision") setBanner("Board vision");
  else updateStatus(inCheck);
  updateMoves();
  updateCaptured();
  renderPlayers();
  if (mode === "bot") checkBotOver();
}

function updateStatus(inCheck: boolean): void {
  if (botResigned) return setBanner("You resigned.");
  if (chess.isCheckmate()) {
    const youWon = colorToMove() !== playerColor;
    setBanner(youWon ? "Checkmate — you won!" : "Checkmate.");
    coachEl.textContent = youWon
      ? "Well played! Try a harder level?"
      : realGame
        ? "Good effort. Open the review to see where it turned."
        : "Good effort. Take a move back and try again.";
    return;
  }
  if (chess.isStalemate()) {
    setBanner("Stalemate — it's a draw.");
    coachEl.textContent = "No legal moves, but no check. That's a draw.";
    return;
  }
  if (chess.isDraw()) {
    setBanner("Draw.");
    coachEl.textContent = "Neither side can force a win here.";
    return;
  }

  if (thinking) setBanner(`${opponent === "magnus" ? "Magnus bot" : "Chronael"} is thinking…`);
  else if (playerTurn()) setBanner(inCheck ? "Your move — you're in check!" : "Your move.");

  if (realGame) return; // no coaching during a real game
  if (inCheck && playerTurn()) {
    coachEl.textContent = "You're in check! Move your king, block the attack, or capture the attacker.";
  } else if (!thinking && playerTurn() && !feedbackActive) {
    coachEl.textContent = "Tip: " + TIPS[chess.history().length % TIPS.length];
  }
}

function updateMoves(): void {
  const target = mode === "online" ? onlineMovesEl : movesEl;
  const history = chess.history();
  target.innerHTML = "";
  for (let i = 0; i < history.length; i += 2) {
    const li = document.createElement("li");
    li.textContent = `${history[i] ?? ""}   ${history[i + 1] ?? ""}`.trim();
    target.appendChild(li);
  }
  target.scrollTop = target.scrollHeight;
}

function isPromotion(from: Square, to: Square): boolean {
  const piece = chess.get(from);
  if (!piece || piece.type !== "p") return false;
  return to[1] === "8" || to[1] === "1";
}

// ---------- Result moment ----------

type ResultKind = "win" | "loss" | "draw";

interface ResultOptions {
  kind: ResultKind;
  kicker: string;
  title: string;
  sub: string;
  primary: string;
  onPrimary: () => void;
  share: string;
  review?: boolean; // offer "Review this game"
  alt?: boolean; // offer a plain "Play again" next to the primary action
}

let resultPrimary: (() => void) | null = null;
let resultShare = "";

function reducedMotion(): boolean {
  return window.matchMedia("(prefers-reduced-motion: reduce)").matches;
}

function showResult(o: ResultOptions): void {
  const modal = el("result");
  modal.className = `modal ${o.kind}`;
  el("result-kicker").textContent = o.kicker;
  el("result-title").textContent = o.title;
  el("result-sub").textContent = o.sub;
  const primary = el<HTMLButtonElement>("result-primary");
  primary.textContent = o.primary;
  primary.disabled = false;
  resultPrimary = o.onPrimary;
  el("result-review").hidden = !o.review;
  el("result-alt").hidden = !o.alt;
  resultShare = o.share;
  const confetti = el("confetti");
  confetti.innerHTML = "";
  if (o.kind === "win" && !reducedMotion()) {
    const colours = ["#bf8f4d", "#233e31", "#31533e", "#e9d3ae", "#a4493d"];
    for (let i = 0; i < 44; i++) {
      const bit = document.createElement("i");
      bit.style.left = `${Math.random() * 100}%`;
      bit.style.background = colours[i % colours.length];
      bit.style.animationDelay = `${Math.random() * 0.6}s`;
      bit.style.transform = `rotate(${Math.random() * 180}deg)`;
      confetti.appendChild(bit);
    }
  }
  modal.hidden = false;
  primary.focus();
}

function hideResult(): void {
  el("result").hidden = true;
}

function toast(text: string): void {
  const t = el("toast");
  t.textContent = text;
  t.hidden = false;
  window.clearTimeout((toast as unknown as { timer?: number }).timer);
  (toast as unknown as { timer?: number }).timer = window.setTimeout(() => (t.hidden = true), 2400);
}

async function shareText(text: string): Promise<void> {
  const url = `${window.location.origin}/`;
  if (navigator.share) {
    try {
      await navigator.share({ title: "Chronael", text, url });
      return;
    } catch {
      /* cancelled; fall back to copying */
    }
  }
  try {
    await navigator.clipboard.writeText(`${text} ${url}`);
    toast("Copied to your clipboard");
  } catch {
    toast("Couldn't share from this browser");
  }
}

function checkBotOver(): void {
  if (!isOver()) return;
  const key = `bot-${gameNo}`;
  if (resultShownFor === key) return;
  resultShownFor = key;
  const who = opponent === "magnus" ? "the Magnus bot" : `Chronael (level ${levelIndex + 1})`;
  let kind: ResultKind = "draw";
  let title = "It's a draw";
  let sub = "Neither side could force a win.";
  if (botResigned) {
    kind = "loss";
    title = "You resigned";
    sub = "No shame in it. Every game teaches something.";
  } else if (chess.isCheckmate()) {
    const youWon = colorToMove() !== playerColor;
    kind = youWon ? "win" : "loss";
    title = youWon ? "Checkmate. You won!" : "Checkmate";
    sub = youWon ? `You beat ${who} in ${Math.ceil(chess.history().length / 2)} moves.` : "Take a move back and see what you could do differently.";
  } else if (chess.isStalemate()) {
    sub = "Stalemate: no legal moves, but no check.";
  }
  const levelWas = levelIndex;
  const opp = opponent;
  const color = playerColor;
  const plies = chess.history().length;
  const wait = pendingCoach ?? Promise.resolve();
  void wait.then(() => {
    if (resultShownFor !== key) return;
    const log = [...moveLog];
    if (log.length > 0) {
      const counts = { great: 0, good: 0, inaccuracy: 0, mistake: 0, blunder: 0 };
      const phases = { opening: 0, middlegame: 0, endgame: 0 };
      for (const m of log) {
        counts[m.rating]++;
        if (m.rating === "mistake" || m.rating === "blunder") {
          phases[m.ply < 20 ? "opening" : m.ply < 60 ? "middlegame" : "endgame"]++;
        }
      }
      recordGame({
        at: Date.now(),
        result: kind,
        opponent: opp,
        level: levelWas,
        color,
        moves: Math.ceil(plies / 2),
        accuracy: gameAccuracy(log),
        counts,
        phases,
      });
    }
    const acc = gameAccuracy(log);
    const canLevelUp = kind === "win" && opp === "stockfish" && levelWas < LEVELS.length - 1;
    window.setTimeout(() => {
      if (resultShownFor !== key) return;
      showResult({
        kind,
        kicker: "Game over",
        title,
        sub: acc !== null ? `${sub} Accuracy ${acc}%.` : sub,
        primary: canLevelUp ? `Level up: try level ${levelWas + 2}` : "Play again",
        onPrimary: () => {
          hideResult();
          if (canLevelUp) {
            levelIndex = levelWas + 1;
            el<HTMLSelectElement>("level").value = String(levelIndex);
          }
          newGame();
        },
        share:
          kind === "win"
            ? `I just beat ${who} on Chronael ♟️`
            : "I'm learning chess with a friendly coach on Chronael ♟️",
        review: log.length > 0,
        alt: canLevelUp,
      });
    }, 400);
  });
}

// ---------- Bot games ----------

function onUserMove(orig: Key, dest: Key): void {
  if (tutorial.active) {
    tutorial.handleMove(orig, dest);
    return;
  }
  if (mode === "online") {
    handleOnlineUserMove(orig, dest);
    return;
  }
  if (mode === "puzzle") {
    handlePuzzleMove(orig, dest);
    return;
  }
  if (reviewState) {
    void reviewAttempt(orig, dest);
    return;
  }

  if (rejectIllegal(orig, dest)) return;
  const fenBefore = chess.fen();
  const snapshot = beforeEval && beforeEval.fen === fenBefore ? beforeEval : null;
  if (isPromotion(orig as Square, dest as Square)) {
    void askPromotion(playerColor).then((piece) => applyUserMove(orig, dest, snapshot, piece));
  } else {
    applyUserMove(orig, dest, snapshot, undefined);
  }
}

function applyUserMove(
  orig: Key,
  dest: Key,
  snapshot: { fen: string; scoreCp: number; bestUci: string } | null,
  promotion: PromotionPiece | undefined,
): void {
  const fenBefore = chess.fen();
  let move: Move | null = null;
  try {
    move = chess.move({ from: orig as Square, to: dest as Square, promotion });
  } catch {
    move = null;
  }
  if (!move) {
    render();
    return;
  }
  const movedUci = (orig as string) + (dest as string) + (promotion ?? "");
  noteLegal(move.piece);
  soundForMove(move);
  lastMove = [orig, dest];
  ground.setShapes([]);
  render();
  void afterUserMove(snapshot, movedUci, fenBefore, chess.fen());
}

async function afterUserMove(
  snapshot: { fen: string; scoreCp: number; bestUci: string } | null,
  movedUci: string,
  fenBefore: string,
  fenAfter: string,
): Promise<void> {
  const game = gameNo;
  pendingCoach = coachOnMove(snapshot, movedUci, fenBefore, fenAfter);
  await pendingCoach;
  if (game !== gameNo || mode !== "bot") return;
  if (!chess.isGameOver()) await engineMove();
  await prepareCoach();
}

/** Rate the player's move (Stockfish-driven) and explain it in plain English. */
async function coachOnMove(
  snapshot: { fen: string; scoreCp: number; bestUci: string } | null,
  movedUci: string,
  fenBefore: string,
  fenAfter: string,
): Promise<void> {
  const seq = ++coachSeq;
  const after = await engine.analyse(fenAfter);
  if (seq !== coachSeq) return;

  const playerEvalAfter = -after.scoreCp;
  const scoreBefore = snapshot ? snapshot.scoreCp : playerEvalAfter;
  const loss = Math.max(0, scoreBefore - playerEvalAfter);
  const rating = classify(loss);
  const bestPlain = snapshot ? describeMove(snapshot.fen, snapshot.bestUci) : undefined;

  moveLog.push({
    ply: (Number(fenBefore.split(" ")[5]) - 1) * 2 + (sideToMove(fenBefore) === "black" ? 1 : 0),
    fenBefore,
    played: movedUci,
    best: snapshot?.bestUci ?? movedUci,
    reply: after.bestMove,
    before: scoreBefore,
    after: playerEvalAfter,
    rating,
  });
  if (snapshot && (rating === "mistake" || rating === "blunder") && snapshot.bestUci !== movedUci) {
    addMistake(snapshot.fen, snapshot.bestUci, movedUci, loss);
  }

  if (realGame) return; // logged for the review; nothing shown during a real game
  updateEvalBar(whiteCp(fenAfter, after.scoreCp));
  ratingEl.textContent = ratingLabel(rating);
  ratingEl.className = `rating ${rating}`;
  feedbackActive = true;
  coachEl.textContent = tier0Message(rating, bestPlain);
  coachMoreEl.hidden = true;
  lastCoachFacts = null;

  if (rating === "mistake" || rating === "blunder") {
    const facts: CoachFacts = {
      movedPlain: describeMove(fenBefore, movedUci),
      classification: rating,
      bestPlain,
      threatPlain: describeMove(fenAfter, after.bestMove),
    };
    const text = await explain(facts);
    if (seq !== coachSeq) return;
    if (text) coachEl.textContent = text;
    lastCoachFacts = facts;
    coachMoreEl.textContent = "Tell me more →";
    coachMoreEl.disabled = false;
    coachMoreEl.hidden = false;
  }
}

/** Pre-analyse the position it's now the player's turn in (drives the eval bar + ratings). */
async function prepareCoach(): Promise<void> {
  if (!playerTurn() || tutorial.active) return;
  const fen = chess.fen();
  const { scoreCp, bestMove } = await engine.analyse(fen);
  if (chess.fen() !== fen) return;
  beforeEval = { fen, scoreCp, bestUci: bestMove };
  if (!realGame) updateEvalBar(whiteCp(fen, scoreCp));
}

async function engineMove(): Promise<void> {
  if (chess.isGameOver() || tutorial.active || mode !== "bot" || botResigned) return;
  const game = gameNo;
  const level = LEVELS[levelIndex];
  thinking = true;
  render();

  let uci: string | null = null;
  if (opponent === "magnus") {
    try {
      const mv = await carlsen.selectMove(chess, { temperature: 0.3, topK: 5 });
      if (mv) uci = mv.from + mv.to + (mv.promotion ?? "");
    } catch {
      uci = await engine.bestMove(chess.fen(), level); // model failed to load
    }
  } else if (Math.random() < level.blunder) {
    const moves = chess.moves({ verbose: true });
    const pick = moves[Math.floor(Math.random() * moves.length)];
    uci = pick.from + pick.to + (pick.promotion ?? "");
  } else {
    uci = await engine.bestMove(chess.fen(), level);
  }
  if (game !== gameNo || mode !== "bot") return; // abandoned meanwhile

  let move: Move | null = null;
  if (uci) {
    try {
      move = chess.move({
        from: uci.slice(0, 2) as Square,
        to: uci.slice(2, 4) as Square,
        promotion: (uci[4] as PromotionPiece) || undefined,
      });
    } catch {
      move = null;
    }
    if (move) lastMove = [move.from as Key, move.to as Key];
  }
  soundForMove(move);
  thinking = false;
  render();
}

/** Hint: a green arrow for a strong move AND a plain-English reason why it's good. */
async function showHint(): Promise<void> {
  if (realGame) return;
  if (!playerTurn() || thinking) return;
  const fen = chess.fen();
  const hintBtn = el<HTMLButtonElement>("hint");
  hintBtn.disabled = true;
  feedbackActive = true;
  coachMoreEl.hidden = true;
  coachEl.textContent = "Looking for a good move for you…";
  try {
    const uci = await engine.bestMove(fen, LEVELS[6]);
    if (chess.fen() !== fen || !uci || uci.length < 4) return;
    ground.setShapes([{ orig: uci.slice(0, 2) as Key, dest: uci.slice(2, 4) as Key, brush: "green" }]);

    // What would the opponent do if we "passed"? Only mention it if it's a real threat.
    let threat: string | undefined;
    if (!chess.isCheck()) {
      const t = await engine.analyse(flipTurn(fen), 10);
      const plain = t.bestMove ? describeMove(flipTurn(fen), t.bestMove) : "";
      if (/captures|check/.test(plain)) threat = t.bestMove;
    }
    if (chess.fen() !== fen) return;
    coachEl.textContent = `Hint (green arrow): ${hintFallback(fen, uci, threat)}`;
    const why = await explainHint(fen, uci, threat);
    if (chess.fen() === fen) coachEl.textContent = `Hint (green arrow): ${why}`;
  } finally {
    hintBtn.disabled = false;
  }
}

function resetCoachUi(): void {
  feedbackActive = false;
  ratingEl.textContent = "";
  ratingEl.className = "rating";
  coachMoreEl.hidden = true;
  lastCoachFacts = null;
  beforeEval = null;
  ground.setShapes([]);
}

function takeBack(): void {
  if (realGame) return;
  if (chess.history().length === 0 || thinking) return;
  coachSeq++;
  if (botResigned || chess.isGameOver()) resultShownFor = "";
  botResigned = false;
  chess.undo();
  if (colorToMove() !== playerColor && chess.history().length > 0) chess.undo();
  const keep = chess.fen();
  const cut = moveLog.findIndex((m) => m.fenBefore === keep);
  if (cut >= 0) moveLog = moveLog.slice(0, cut);
  const hist = chess.history({ verbose: true });
  const last = hist[hist.length - 1];
  lastMove = last ? [last.from as Key, last.to as Key] : undefined;
  resetCoachUi();
  render();
  void prepareCoach();
}

function newGame(): void {
  coachSeq++;
  gameNo++;
  mode = "bot";
  reviewState = null;
  moveLog = [];
  chess.reset();
  lastMove = undefined;
  thinking = false;
  botResigned = false;
  resetCoachUi();
  updateEvalBar(0);
  ground.set({ orientation: playerColor });
  render();
  void beginTurns();
}

async function beginTurns(): Promise<void> {
  if (playerColor === "black" && !chess.isGameOver()) await engineMove();
  await prepareCoach();
}

function pickSide(): Color {
  const v = (document.querySelector('input[name="side"]:checked') as HTMLInputElement | null)?.value;
  if (v === "black") return "black";
  if (v === "random") return Math.random() < 0.5 ? "white" : "black";
  return "white";
}

function setOpponent(next: Opponent): void {
  opponent = next;
  el<HTMLSelectElement>("opponent").value = next;
  if (next === "magnus" && !carlsen.ready) {
    feedbackActive = true;
    coachEl.textContent = "Waking up the Magnus bot (a one-time ~24 MB download)…";
    carlsen
      .load()
      .then(() => {
        coachEl.textContent = "Magnus bot is ready. Good luck out there.";
      })
      .catch(() => {
        coachEl.textContent = "Could not load the Magnus bot, so you're playing the gentle engine.";
        opponent = "stockfish";
        el<HTMLSelectElement>("opponent").value = "stockfish";
        renderPlayers();
      });
  }
}

function startBot(
  opp: Opponent = "stockfish",
  opts: { level?: number; side?: Color; real?: boolean } = {},
): void {
  leaveOnline();
  if (tutorial.active) tutorial.active = false;
  hideResult();
  playerColor = opts.side ?? pickSide();
  const lv = opts.level ?? parseInt(el<HTMLSelectElement>("level").value, 10);
  if (Number.isFinite(lv)) levelIndex = lv; // "magnus" keeps the last coach level
  if (!opts.real) stopBackgroundSearch();
  realGame = !!opts.real;
  el("play-panel").classList.toggle("real", realGame);
  showView("game");
  showPanel("play-panel");
  opponent = opp;
  newGame();
  if (realGame) {
    feedbackActive = true;
    coachEl.textContent = "Real game: no hints, take-backs or move dots. You'll get a full review at the end.";
  } else {
    setOpponent(opp); // after newGame so its "loading" message isn't replaced by a tip
  }
  if (realGame && opp === "magnus" && !carlsen.ready) void carlsen.load().catch(() => undefined);
}

function startTutorial(): void {
  realGame = false;
  el("play-panel").classList.remove("real");
  leaveOnline();
  hideResult();
  mode = "bot";
  coachSeq++;
  gameNo++;
  showView("game");
  showPanel("tutorial-panel");
  setPlayer("bottom", savedName() || "You", "Learning");
  setPlayer("top", "Lesson", "Move the highlighted piece");
  setBanner("Learn the pieces");
  capYoursEl.textContent = "";
  capTheirsEl.textContent = "";
  tutorial.start();
}

function goHome(show = true): void {
  coachSeq++;
  gameNo++;
  thinking = false;
  hideResult();
  leaveOnline();
  if (tutorial.active) tutorial.active = false;
  mode = "bot";
  ex = null;
  reviewState = null;
  vision = null;
  realGame = false;
  stopBackgroundSearch();
  el("play-panel").classList.remove("real");
  window.clearInterval(visionTick);
  if (show) showView("home");
}

// ---------- Exercises: daily puzzle, rated puzzles, lesson drills, mistake cards ----------
//
// One runner for anything of the shape "position + goal + line to find". The kind only
// changes the framing and what happens when it's solved.

type ExerciseKind = "daily" | "rated" | "lesson" | "mistake";

interface Exercise {
  kind: ExerciseKind;
  id: string;
  fen: string;
  lastMove?: string;
  solution: string[];
  accept?: string[];
  rating?: number;
  theme?: string;
  kicker: string;
  title: string;
  intro: string;
  engineAccept?: boolean; // mistake cards: any move within a small margin of best counts
}

let ex: Exercise | null = null;
let exStep = 0;
let exDone = false;
let exRevealed = false;
let exWrong = 0;
let exHints = 0;
let exRatedSettled = false;
let exChecking = false;

function setExerciseChrome(): void {
  const e = ex!;
  el("puzzle-streak-row").hidden = e.kind !== "daily";
  el("ex-rating-row").hidden = e.kind !== "rated";
  el("ex-stars").hidden = true;
  el("puzzle-next").hidden = true;
  el("puzzle-meta").textContent = e.kicker;
  el("puzzle-goal").textContent = e.title;
  puzzleTextEl.textContent = e.intro;
  el<HTMLButtonElement>("puzzle-hint").disabled = false;
  el<HTMLButtonElement>("puzzle-reveal").disabled = false;
  el("puzzle-exit").textContent = e.kind === "lesson" ? "Back to lessons" : "Back home";
  if (e.kind === "rated") {
    el("ex-rating").textContent = String(progress().puzzleRating);
    el("ex-delta").textContent = "";
  }
  if (e.kind === "daily") refreshStreakText();
}

function startExercise(e: Exercise): void {
  leaveOnline();
  hideResult();
  tutorial.active = false;
  reviewState = null;
  coachSeq++;
  gameNo++;
  mode = "puzzle";
  ex = e;
  exStep = 0;
  exDone = false;
  exRevealed = false;
  exWrong = 0;
  exHints = 0;
  exRatedSettled = false;
  exChecking = false;
  showView("game");
  showPanel("puzzle-panel");
  chess.load(e.fen);
  playerColor = sideToMove(e.fen);
  lastMove = e.lastMove ? [e.lastMove.slice(0, 2) as Key, e.lastMove.slice(2, 4) as Key] : undefined;
  ground.set({ orientation: playerColor });
  ground.setShapes([]);
  setExerciseChrome();
  render();
}

async function startDaily(): Promise<void> {
  let list: Puzzle[];
  try {
    list = await loadPuzzles();
  } catch {
    toast("Couldn't load today's puzzle. Are you offline?");
    return;
  }
  const p = list[dailyIndex(dayKey(), list.length)];
  startExercise({
    kind: "daily",
    id: p.id,
    fen: p.fen,
    lastMove: p.lastMove,
    solution: p.solution,
    rating: p.rating,
    theme: p.theme,
    kicker: `Daily puzzle · ${THEME_NAMES[p.theme] ?? "Tactic"} · rated ${p.rating}`,
    title: p.goal,
    intro: `Your opponent just moved (highlighted). You play ${sideToMove(p.fen)}. Find the best move.`,
  });
}

type RatedRow = [string, string, string, string, number, string];
let ratedRows: RatedRow[] | null = null;

async function startRated(): Promise<void> {
  if (!ratedRows) {
    try {
      const resp = await fetch(`${import.meta.env.BASE_URL}puzzles-rated.json`);
      ratedRows = ((await resp.json()) as { rows: RatedRow[] }).rows;
    } catch {
      toast("Couldn't load puzzles. Are you offline?");
      return;
    }
  }
  const p = progress();
  const solved = new Set(p.solvedPuzzles);
  const target = p.puzzleRating + Math.round((Math.random() - 0.4) * 160);
  const pool = ratedRows.filter((r) => !solved.has(r[0]) && Math.abs(r[4] - target) <= 120);
  const pick =
    pool[Math.floor(Math.random() * pool.length)] ??
    [...ratedRows].sort((a, b) => Math.abs(a[4] - target) - Math.abs(b[4] - target))[0];
  const [id, fen, last, sol, rating, theme] = pick;
  const goal = GOALS[theme] ?? "Find the best move";
  startExercise({
    kind: "rated",
    id,
    fen,
    lastMove: last,
    solution: sol.split(" "),
    rating,
    theme,
    kicker: `Rated puzzle · ${rating}`,
    title: goal,
    intro: `You play ${sideToMove(fen)}. Your opponent just moved (highlighted).`,
  });
}

const GOALS: Record<string, string> = {
  mateIn1: "Checkmate in one",
  mateIn2: "Checkmate in two",
  mateIn3: "Checkmate in three",
  backRankMate: "Find the back-rank mate",
  smotheredMate: "Find the smothered mate",
};

let lessonRef: { unit: Unit; index: number } | null = null;

function startDrill(id: string): void {
  const found = findDrill(id);
  if (!found) return;
  const { unit, drill, index } = found;
  lessonRef = { unit, index };
  startExercise({
    kind: "lesson",
    id: drill.id,
    fen: drill.fen,
    solution: drill.solution,
    accept: drill.accept,
    kicker: `${unit.title} · ${index + 1} of ${unit.drills.length}`,
    title: `${drill.title}: ${drill.goal.toLowerCase()}`,
    intro: drill.teach,
  });
}

let mistakeQueue: MistakeCard[] = [];

function startMistakes(): void {
  mistakeQueue = dueCards();
  if (mistakeQueue.length === 0) {
    const total = progress().deck.length;
    toast(total ? "Nothing due right now. Cards come back over the next days." : "No mistakes saved yet. Play a game first!");
    return;
  }
  nextMistake();
}

function nextMistake(): void {
  const card = mistakeQueue.shift();
  if (!card) {
    toast("All caught up. Nice work!");
    goHome();
    return;
  }
  startExercise({
    kind: "mistake",
    id: card.id,
    fen: card.fen,
    solution: [card.best],
    engineAccept: true,
    kicker: `Your mistakes · ${mistakeQueue.length + 1} to go`,
    title: "Find a better move",
    intro: `In one of your games you played: ${describeMove(card.fen, card.played)}. That cost you. What's stronger?`,
  });
  ground.setShapes([{ orig: card.played.slice(0, 2) as Key, dest: card.played.slice(2, 4) as Key, brush: "red" }]);
}

function refreshStreakText(): void {
  const s = loadStreak();
  const n = visibleStreak(s, dayKey());
  el("puzzle-streak").textContent =
    n > 0 ? `${n}-day streak${s.last === dayKey() ? " · solved today" : ""}` : "Solve today to start a streak";
}

function updatePuzzleStatus(): void {
  if (!ex) return;
  if (exDone) setBanner(exRevealed ? "Here's the solution." : "Solved!");
  else if (exChecking) setBanner("Checking your move…");
  else if (colorToMove() === playerColor) setBanner(`Your move: ${ex.title.toLowerCase()}`);
  else setBanner("Opponent replies…");
}

function handlePuzzleMove(orig: Key, dest: Key): void {
  if (rejectIllegal(orig, dest)) return;
  if (isPromotion(orig as Square, dest as Square)) {
    void askPromotion(playerColor).then((p) => void exerciseTry(orig, dest, p));
  } else {
    void exerciseTry(orig, dest, undefined);
  }
}

function playUci(uci: string): Move | null {
  try {
    const mv = chess.move({
      from: uci.slice(0, 2) as Square,
      to: uci.slice(2, 4) as Square,
      promotion: (uci[4] as PromotionPiece) || undefined,
    });
    if (mv) lastMove = [mv.from as Key, mv.to as Key];
    return mv;
  } catch {
    return null;
  }
}

function shakeBoard(): void {
  const wrap = document.querySelector(".board-wrap") as HTMLElement;
  wrap.classList.remove("puzzle-wrong");
  void wrap.offsetWidth;
  wrap.classList.add("puzzle-wrong");
}

/** Centipawns the move gives away compared with the engine's best (mover's view). */
async function moveLoss(fen: string, uci: string): Promise<number> {
  const before = await engine.analyse(fen);
  const b = new Chess(fen);
  b.move({ from: uci.slice(0, 2) as Square, to: uci.slice(2, 4) as Square, promotion: (uci[4] as PromotionPiece) || undefined });
  if (b.isCheckmate()) return 0;
  const after = await engine.analyse(b.fen());
  return Math.max(0, before.scoreCp + after.scoreCp);
}

async function exerciseTry(orig: Key, dest: Key, promo: PromotionPiece | undefined): Promise<void> {
  if (!ex || exDone || exChecking) return;
  const e = ex;
  const uci = `${orig}${dest}${promo ?? ""}`;
  const expected = e.solution[exStep];
  const probe = new Chess(chess.fen());
  let mate = false;
  try {
    probe.move({ from: orig as Square, to: dest as Square, promotion: promo });
    mate = probe.isCheckmate(); // any mate is a correct answer
  } catch {
    render();
    return;
  }
  let ok = uci === expected || mate || (exStep === 0 && !!e.accept?.includes(uci));
  if (!ok && e.engineAccept) {
    exChecking = true;
    puzzleTextEl.textContent = "Checking your move…";
    render();
    const loss = await moveLoss(chess.fen(), uci);
    exChecking = false;
    if (ex !== e) return;
    ok = loss <= 40;
  }
  if (!ok) {
    exWrong++;
    shakeBoard();
    if (e.kind === "rated" && !exRatedSettled) settleRated(false);
    puzzleTextEl.textContent =
      e.kind === "mistake"
        ? "Still not the best. Look for checks, captures and threats first."
        : "Not quite. That lets your opponent off the hook. Look again!";
    render();
    return;
  }
  ground.setShapes([]);
  soundForMove(playUci(uci));
  exStep++;
  if (exStep >= e.solution.length || chess.isCheckmate() || e.engineAccept) {
    render();
    void exerciseSolved();
    return;
  }
  puzzleTextEl.textContent = "Good! Your opponent replies… keep going.";
  render();
  const step = exStep;
  window.setTimeout(() => {
    if (ex !== e || exDone || exStep !== step || mode !== "puzzle") return;
    soundForMove(playUci(e.solution[exStep]));
    exStep++;
    puzzleTextEl.textContent = "Your move again. Finish it off.";
    render();
  }, 550);
}

function settleRated(win: boolean): void {
  if (!ex || ex.kind !== "rated" || exRatedSettled) return;
  exRatedSettled = true;
  const delta = recordPuzzle(ex.id, ex.rating ?? 1200, win);
  el("ex-rating").textContent = String(progress().puzzleRating);
  const d = el("ex-delta");
  d.textContent = delta >= 0 ? `+${delta}` : `${delta}`;
  d.className = `delta ${delta >= 0 ? "up" : "down"}`;
}

function showStars(n: number): void {
  const s = el("ex-stars");
  s.innerHTML = [1, 2, 3].map((i) => `<span class="${i <= n ? "" : "off"}">★</span>`).join("");
  s.hidden = false;
}

async function exerciseSolved(): Promise<void> {
  if (!ex) return;
  const e = ex;
  exDone = true;
  const clean = exWrong === 0 && exHints === 0;
  render();
  const firstPlain = describeMove(e.fen, e.solution[0]);
  const next = el<HTMLButtonElement>("puzzle-next");

  if (e.kind === "daily") {
    const s = nextStreak(loadStreak(), dayKey());
    saveStreak(s);
    refreshStreakText();
    const keyMove = `Key move: ${firstPlain}.`;
    puzzleTextEl.textContent = keyMove;
    showResult({
      kind: "win",
      kicker: `Daily puzzle · ${THEME_NAMES[e.theme ?? ""] ?? "Tactic"}`,
      title: "Solved!",
      sub: `${s.streak}-day streak${s.best > s.streak ? ` (best ${s.best})` : ""}. A new puzzle arrives tomorrow.`,
      primary: "Try rated puzzles",
      onPrimary: () => void startRated(),
      share: `I solved today's Chronael chess puzzle 🔥 ${s.streak}-day streak`,
    });
    const why = await explain({ movedPlain: firstPlain, classification: "great" });
    if (why && ex === e) puzzleTextEl.textContent = `${keyMove} ${why}`;
    return;
  }

  if (e.kind === "rated") {
    settleRated(clean);
    puzzleTextEl.textContent = clean ? `Solved! Key move: ${firstPlain}.` : `Solved, with help. Key move: ${firstPlain}.`;
    next.textContent = "Next puzzle →";
    next.hidden = false;
    next.focus();
    return;
  }

  if (e.kind === "lesson") {
    const stars = Math.max(1, 3 - exWrong - exHints);
    setLessonStars(e.id, stars);
    showStars(stars);
    const found = findDrill(e.id)!;
    puzzleTextEl.textContent = found.drill.why;
    const last = found.index === found.unit.drills.length - 1;
    next.textContent = last ? "Unit complete! Back to lessons" : "Next drill →";
    next.hidden = false;
    next.focus();
    return;
  }

  // mistake card
  reviewCard(e.id, clean);
  puzzleTextEl.textContent = clean
    ? `Exactly. ${cap(firstPlain)} was the move. This card comes back later to lock it in.`
    : `You got there. ${cap(firstPlain)} was best. We'll show you this one again soon.`;
  next.textContent = mistakeQueue.length ? `Next card (${mistakeQueue.length} left) →` : "Done →";
  next.hidden = false;
  next.focus();
}

function exerciseNext(): void {
  if (!ex) return;
  if (ex.kind === "rated") void startRated();
  else if (ex.kind === "mistake") nextMistake();
  else if (ex.kind === "lesson" && lessonRef) {
    const nextDrill = lessonRef.unit.drills[lessonRef.index + 1];
    if (nextDrill) startDrill(nextDrill.id);
    else openLessons();
  } else goHome();
}

function puzzleHint(): void {
  if (!ex || exDone) return;
  exHints++;
  const next = ex.solution[exStep];
  ground.setShapes([{ orig: next.slice(0, 2) as Key, brush: "green" }]);
  const theme = ex.theme ? THEME_NAMES[ex.theme] : undefined;
  puzzleTextEl.textContent = `Look at the circled piece.${theme ? ` Hint: ${theme.toLowerCase()}.` : ""}`;
}

function puzzleReveal(): void {
  if (!ex || exDone) return;
  const e = ex;
  exDone = true;
  exRevealed = true;
  if (e.kind === "rated") settleRated(false);
  if (e.kind === "mistake") reviewCard(e.id, false);
  el<HTMLButtonElement>("puzzle-hint").disabled = true;
  el<HTMLButtonElement>("puzzle-reveal").disabled = true;
  ground.setShapes([]);
  puzzleTextEl.textContent = `Key move: ${describeMove(chess.fen(), e.solution[exStep])}.${
    e.kind === "daily" ? " Come back tomorrow to build your streak." : ""
  }`;
  if (e.kind !== "daily") {
    const next = el<HTMLButtonElement>("puzzle-next");
    next.textContent = e.kind === "lesson" ? "Try it again" : "Next →";
    next.hidden = false;
    if (e.kind === "lesson") next.onclick = () => {
      next.onclick = null;
      startDrill(e.id);
    };
  }
  const stepOnce = () => {
    if (ex !== e || exStep >= e.solution.length || mode !== "puzzle") return;
    soundForMove(playUci(e.solution[exStep]));
    exStep++;
    render();
    window.setTimeout(stepOnce, 800);
  };
  render();
  window.setTimeout(stepOnce, 300);
}

// ---------- Game review ----------

interface ReviewState {
  log: MoveEntry[];
  moments: number[]; // indexes into log, the biggest swings
  momentIdx: number;
  cur: number; // index into log being shown
  trying: boolean;
}

let reviewState: ReviewState | null = null;

function openReview(): void {
  if (moveLog.length === 0) return;
  hideResult();
  const log = [...moveLog];
  const moments = log
    .map((m, i) => ({ i, loss: m.before - m.after }))
    .filter((x) => x.loss >= 70)
    .sort((a, b) => b.loss - a.loss)
    .slice(0, 3)
    .map((x) => x.i)
    .sort((a, b) => a - b);
  reviewState = { log, moments, momentIdx: 0, cur: moments[0] ?? log.length - 1, trying: false };
  showPanel("review-panel");

  const acc = gameAccuracy(log) ?? 0;
  el("acc-num").textContent = String(acc);
  el("acc-ring").style.setProperty("--p", String(acc));
  const counts = countRatings(log);
  el("count-chips").innerHTML = (
    [
      ["great", "great", "great"],
      ["good", "good", "good"],
      ["inaccuracy", "inaccuracy", "inaccuracies"],
      ["mistake", "mistake", "mistakes"],
      ["blunder", "blunder", "blunders"],
    ] as const
  )
    .filter(([k]) => counts[k] > 0)
    .map(
      ([k, one, many]) =>
        `<li><span class="lg q-${k}" style="width:8px;height:8px;border-radius:50%"></span> ${counts[k]} ${counts[k] === 1 ? one : many}</li>`,
    )
    .join("");

  const strip = el("review-strip");
  strip.innerHTML = "";
  log.forEach((m, i) => {
    const b = document.createElement("button");
    b.type = "button";
    b.className = `q-${m.rating}`;
    b.setAttribute("role", "listitem");
    b.setAttribute("aria-label", `Move ${Math.floor(m.ply / 2) + 1}: ${m.rating}`);
    b.title = `Move ${Math.floor(m.ply / 2) + 1}: ${m.rating}`;
    b.addEventListener("click", () => showReviewEntry(i));
    strip.appendChild(b);
  });
  showReviewEntry(reviewState.cur);
}

function countRatings(log: MoveEntry[]): Record<MoveRating, number> {
  const c: Record<MoveRating, number> = { great: 0, good: 0, inaccuracy: 0, mistake: 0, blunder: 0 };
  for (const m of log) c[m.rating]++;
  return c;
}

function showReviewEntry(i: number): void {
  const r = reviewState;
  if (!r) return;
  r.cur = i;
  r.trying = false;
  const m = r.log[i];
  const mIdx = r.moments.indexOf(i);
  if (mIdx >= 0) r.momentIdx = mIdx;
  el("review-strip")
    .querySelectorAll("button")
    .forEach((b, j) => b.classList.toggle("on", j === i));
  el("moment-label").textContent =
    mIdx >= 0 ? `Key moment ${mIdx + 1} of ${r.moments.length}` : `Move ${Math.floor(m.ply / 2) + 1}`;
  const board = new Chess(m.fenBefore);
  ground.set({
    fen: m.fenBefore,
    orientation: playerColor,
    turnColor: sideToMove(m.fenBefore),
    lastMove: undefined,
    check: board.isCheck() ? sideToMove(m.fenBefore) : undefined,
    movable: { color: undefined, dests: new Map() },
  });
  const shapes: { orig: Key; dest: Key; brush: string }[] = [
    { orig: m.played.slice(0, 2) as Key, dest: m.played.slice(2, 4) as Key, brush: "red" },
  ];
  const loss = m.before - m.after;
  const worse = loss >= 70 && m.best && m.best !== m.played;
  if (worse) shapes.push({ orig: m.best.slice(0, 2) as Key, dest: m.best.slice(2, 4) as Key, brush: "green" });
  ground.setShapes(shapes);
  el<HTMLButtonElement>("review-try").hidden = !worse;
  el<HTMLButtonElement>("moment-prev").disabled = r.moments.length === 0;
  el<HTMLButtonElement>("moment-next").disabled = r.moments.length === 0;

  const played = describeMove(m.fenBefore, m.played);
  const textEl = el("review-text");
  if (r.moments.length === 0 && i === r.log.length - 1) {
    textEl.textContent = "No big mistakes this game. That's how you improve! Tap any move to look back at it.";
    return;
  }
  if (!worse) {
    textEl.textContent = `You chose to ${played.replace(/^the /, "let the ")}. ${ratingLabel(m.rating)}: nothing lost here.`;
    return;
  }
  const bestPlain = describeMove(m.fenBefore, m.best);
  const base = `You played: ${played}. ${ratingLabel(m.rating)}. Better was: ${bestPlain}.`;
  textEl.textContent = base;
  const seq = ++coachSeq;
  const after = new Chess(m.fenBefore);
  try {
    after.move({ from: m.played.slice(0, 2), to: m.played.slice(2, 4), promotion: m.played[4] || undefined });
  } catch {
    /* ignore */
  }
  void explain({
    movedPlain: played,
    classification: m.rating,
    bestPlain,
    threatPlain: m.reply ? describeMove(after.fen(), m.reply) : undefined,
  }).then((why) => {
    if (why && seq === coachSeq && reviewState?.cur === i) textEl.textContent = `${base} ${why}`;
  });
}

function stepMoment(delta: number): void {
  const r = reviewState;
  if (!r || r.moments.length === 0) return;
  r.momentIdx = (r.momentIdx + delta + r.moments.length) % r.moments.length;
  showReviewEntry(r.moments[r.momentIdx]);
}

function reviewTry(): void {
  const r = reviewState;
  if (!r) return;
  const m = r.log[r.cur];
  r.trying = true;
  const board = new Chess(m.fenBefore);
  const dests = new Map<Key, Key[]>();
  for (const mv of board.moves({ verbose: true })) {
    const arr = dests.get(mv.from as Key) ?? [];
    arr.push(mv.to as Key);
    dests.set(mv.from as Key, arr);
  }
  ground.setShapes([]);
  ground.set({ fen: m.fenBefore, movable: { color: playerColor, dests } });
  el("review-text").textContent = "Your turn: find the stronger move. (The arrows are hidden.)";
}

async function reviewAttempt(orig: Key, dest: Key): Promise<void> {
  const r = reviewState;
  if (!r || !r.trying) return;
  const m = r.log[r.cur];
  let uci = `${orig}${dest}`;
  const board = new Chess(m.fenBefore);
  const piece = board.get(orig as Square);
  if (piece?.type === "p" && (dest[1] === "8" || dest[1] === "1")) uci += await askPromotion(playerColor);
  let good = uci === m.best;
  if (!good) {
    el("review-text").textContent = "Checking…";
    good = (await moveLoss(m.fenBefore, uci)) <= 40;
  }
  if (reviewState !== r) return;
  if (good) {
    playMove();
    r.trying = false;
    ground.set({ movable: { color: undefined, dests: new Map() } });
    el("review-text").textContent = `Yes! ${cap(describeMove(m.fenBefore, uci))}. That's the idea. It's saved to "Your mistakes" so it comes back later.`;
  } else {
    shakeBoard();
    ground.set({ fen: m.fenBefore });
    reviewTry();
    el("review-text").textContent = "Not that one. Look for checks, captures and threats. Try again.";
  }
}

// ---------- Lessons path ----------

function openLessons(): void {
  goHome(false);
  showView("lessons");
  renderPath();
}

function renderPath(): void {
  const p = progress();
  const path = el("path");
  path.innerHTML = "";
  const piecesDone = localStorageFlag("chronael.piecesDone");
  let nextMarked = false;
  const unitEl = (title: string, blurb: string, stars: string) => {
    const u = document.createElement("div");
    u.className = "unit";
    u.innerHTML = `<div class="unit-head"><h2></h2><span class="unit-stars"></span></div><p></p><div class="nodes"></div>`;
    u.querySelector("h2")!.textContent = title;
    u.querySelector("p")!.textContent = blurb;
    u.querySelector(".unit-stars")!.textContent = stars;
    path.appendChild(u);
    return u.querySelector(".nodes") as HTMLElement;
  };
  const node = (container: HTMLElement, label: string, n: number, stars: number, onClick: () => void) => {
    const b = document.createElement("button");
    b.type = "button";
    const done = stars > 0;
    const isNext = !done && !nextMarked;
    if (isNext) nextMarked = true;
    b.className = `node${done ? " done" : ""}${isNext ? " next" : ""}`;
    b.innerHTML = `<span class="dot"></span><span class="nm"></span><span class="st"></span>`;
    b.querySelector(".dot")!.textContent = done ? "✓" : String(n);
    b.querySelector(".nm")!.textContent = label;
    b.querySelector(".st")!.textContent = done ? "★".repeat(stars) + "☆".repeat(3 - stars) : "";
    b.setAttribute("aria-label", `${label}${done ? `, ${stars} stars` : ""}`);
    b.addEventListener("click", onClick);
    container.appendChild(b);
  };

  const basics = unitEl("The pieces", "How every piece moves, one at a time.", piecesDone ? "Complete" : "");
  node(basics, "Learn the pieces", 1, piecesDone ? 3 : 0, startTutorial);

  const visionStars = VISION_ORDER.reduce((a, t) => a + (p.lessons[`vision-${t}`] ?? 0), 0);
  const visionNodes = unitEl(
    "Board vision",
    "No dots: tap every square a piece can reach. This is what lets you play on a real board.",
    `${visionStars} / ${VISION_ORDER.length * 3} ★`,
  );
  VISION_ORDER.forEach((t, i) =>
    node(visionNodes, cap(pieceName(t)), i + 1, p.lessons[`vision-${t}`] ?? 0, () => startVision(t)),
  );

  for (const unit of UNITS) {
    const earned = unit.drills.reduce((a, d) => a + (p.lessons[d.id] ?? 0), 0);
    const nodes = unitEl(unit.title, unit.blurb, `${earned} / ${unit.drills.length * 3} ★`);
    unit.drills.forEach((d, i) => node(nodes, d.title, i + 1, p.lessons[d.id] ?? 0, () => startDrill(d.id)));
  }
}

function localStorageFlag(key: string): boolean {
  try {
    return localStorage.getItem(key) === "1";
  } catch {
    return false;
  }
}

function lessonsSummary(): { done: number; total: number } {
  const p = progress();
  const total = allDrills().length + 1;
  const done = allDrills().filter((d) => (p.lessons[d.id] ?? 0) > 0).length + (localStorageFlag("chronael.piecesDone") ? 1 : 0);
  return { done, total };
}

// ---------- Progress dashboard ----------

function openProgress(): void {
  goHome(false);
  showView("progress");
  renderDashboard();
}

function sparkline(values: number[], opts: { min?: number; max?: number; h?: number; bars?: boolean; colors?: string[] }): string {
  const w = 320;
  const h = opts.h ?? 120;
  if (values.length === 0) return "";
  const min = opts.min ?? Math.min(...values) - 20;
  const max = opts.max ?? Math.max(...values) + 20;
  const y = (v: number) => h - 14 - ((v - min) / Math.max(1, max - min)) * (h - 24);
  if (opts.bars) {
    const bw = w / Math.max(values.length, 10);
    return `<svg class="chart" viewBox="0 0 ${w} ${h}" preserveAspectRatio="none" role="img">${values
      .map(
        (v, i) =>
          `<rect x="${i * bw + 2}" y="${y(v)}" width="${bw - 4}" height="${h - 14 - y(v)}" rx="3" fill="${opts.colors?.[i] ?? "#31533e"}"><title>${v}</title></rect>`,
      )
      .join("")}<text x="0" y="${h - 2}">older</text><text x="${w - 30}" y="${h - 2}">latest</text></svg>`;
  }
  const step = values.length > 1 ? w / (values.length - 1) : 0;
  const pts = values.map((v, i) => `${(i * step).toFixed(1)},${y(v).toFixed(1)}`).join(" ");
  return `<svg class="chart" viewBox="0 0 ${w} ${h}" preserveAspectRatio="none" role="img"><polyline points="${pts}" fill="none" stroke="#bf8f4d" stroke-width="3" stroke-linejoin="round" stroke-linecap="round"/><text x="0" y="${h - 2}">${Math.round(min + 20)}</text><text x="${w - 30}" y="10">${Math.round(max - 20)}</text></svg>`;
}

function renderDashboard(): void {
  const p = progress();
  const dash = el("dash");
  const games = p.games;
  const last10 = games.slice(-10);
  const prev10 = games.slice(-20, -10);
  const avg = (xs: number[]) => (xs.length ? xs.reduce((a, b) => a + b, 0) / xs.length : null);
  const accLast = avg(last10.map((g) => g.accuracy).filter((x): x is number => x !== null));
  const accPrev = avg(prev10.map((g) => g.accuracy).filter((x): x is number => x !== null));
  const blLast = avg(last10.map((g) => g.counts.blunder));
  const blPrev = avg(prev10.map((g) => g.counts.blunder));
  const wins = games.filter((g) => g.result === "win").length;
  const streak = visibleStreak(loadStreak(), dayKey());
  const due = dueCards().length;
  const learned = p.deck.filter((c) => c.box >= 4).length;
  const lessons = lessonsSummary();
  const trend = (now: number | null, before: number | null, higherIsBetter: boolean, unit = "") => {
    if (now === null || before === null) return "";
    const d = now - before;
    if (Math.abs(d) < 0.05) return `<span class="note">same as the 10 games before</span>`;
    const good = higherIsBetter ? d > 0 : d < 0;
    return `<span class="${good ? "trend-up" : "trend-down"}">${d > 0 ? "▲" : "▼"} ${Math.abs(d).toFixed(unit ? 1 : 0)}${unit}</span> <span class="note">vs the 10 before</span>`;
  };

  const tiles: string[] = [];
  tiles.push(`<div class="tile"><h3>Puzzle rating</h3><div class="big">${p.puzzleRating}</div><div class="note">${p.puzzlesPlayed} rated puzzles${p.puzzlesPlayed < 15 ? " · still settling" : ""}</div></div>`);
  tiles.push(`<div class="tile"><h3>Accuracy</h3><div class="big">${accLast === null ? "–" : Math.round(accLast) + "%"}</div><div class="note">last 10 games ${trend(accLast, accPrev, true)}</div></div>`);
  tiles.push(`<div class="tile"><h3>Blunders per game</h3><div class="big">${blLast === null ? "–" : blLast.toFixed(1)}</div><div class="note">${trend(blLast, blPrev, false, " ")}</div></div>`);
  tiles.push(`<div class="tile"><h3>Games</h3><div class="big">${games.length}</div><div class="note">${wins} won${games.length ? ` · ${Math.round((wins / games.length) * 100)}%` : ""}</div></div>`);
  tiles.push(`<div class="tile"><h3>Daily streak</h3><div class="big">🔥 ${streak}</div><div class="note">best ${loadStreak().best}</div></div>`);
  tiles.push(`<div class="tile"><h3>Lessons</h3><div class="big">${lessons.done}/${lessons.total}</div><div class="note">drills completed</div></div>`);
  const ms = masterySummary();
  const dotNames = ms.mastered.map((t) => pieceName(t));
  tiles.push(
    `<div class="tile span2"><h3>Playing without dots</h3><div class="big">${ms.mastered.length} / 6</div><div class="note">${
      dotNames.length ? `No dots for your ${dotNames.join(", ")}.` : "Dots switch off piece by piece as you learn each one."
    }</div></div>`,
  );
  tiles.push(`<div class="tile span2"><h3>Your mistakes deck</h3><div class="big">${p.deck.length}</div><div class="note">${due} due now · ${learned} learned for good</div></div>`);

  if (games.length === 0 && p.puzzlesPlayed === 0) {
    dash.innerHTML = `${tiles.join("")}<div class="tile span4 empty"><p>Your charts appear here after your first game or rated puzzle.</p><button class="btn btn-primary" id="dash-play" type="button">Play a game</button></div>`;
    el("dash-play").addEventListener("click", () => startBot());
    return;
  }

  const recent = games.slice(-20);
  const accVals = recent.map((g) => g.accuracy ?? 0);
  const accColors = recent.map((g) => (g.result === "win" ? "#3f7d52" : g.result === "loss" ? "#c7584a" : "#bf8f4d"));
  tiles.push(`<div class="tile span2"><h3>Accuracy, last ${recent.length} games</h3>${recent.length ? sparkline(accVals, { min: 0, max: 100, bars: true, colors: accColors }) : '<p class="note">No games yet.</p>'}<p class="note">Green = won, red = lost, gold = draw.</p></div>`);
  const hist = p.ratingHistory.slice(-60).map((x) => x.r);
  tiles.push(`<div class="tile span2"><h3>Puzzle rating over time</h3>${hist.length > 1 ? sparkline(hist, {}) : '<p class="note">Solve a few rated puzzles to draw this.</p>'}</div>`);

  // Insights: plain-English observations from the data.
  const insights: string[] = [];
  const phase = { opening: 0, middlegame: 0, endgame: 0 };
  for (const g of games.slice(-20)) for (const k of Object.keys(phase) as (keyof typeof phase)[]) phase[k] += g.phases?.[k] ?? 0;
  const worst = (Object.entries(phase) as [keyof typeof phase, number][]).sort((a, b) => b[1] - a[1])[0];
  if (worst && worst[1] > 0) {
    const tip = {
      opening: "Try the Opening principles lessons: centre, develop, castle.",
      middlegame: "Before every move, check: is anything of mine attacked or undefended?",
      endgame: "The Endgames lessons will help you finish games off.",
    }[worst[0]];
    insights.push(`Most of your mistakes happen in the <strong>${worst[0]}</strong>. ${tip}`);
  }
  if (blLast !== null && blLast >= 1.5) insights.push("You often leave pieces hanging. The rated puzzles train exactly this: spotting what's undefended.");
  if (due > 0) insights.push(`${due} of your own mistakes are ready to review. Reviewing them is the fastest way to stop repeating them.`);
  const levelWins = games.filter((g) => g.opponent === "stockfish" && g.result === "win");
  if (levelWins.length) {
    const top = Math.max(...levelWins.map((g) => g.level));
    insights.push(`Your best win is against level ${top + 1}.${top < 7 ? ` Ready to try level ${top + 2}?` : ""}`);
  }
  if (insights.length) tiles.push(`<div class="tile span4"><h3>What to work on</h3><ul class="insights">${insights.map((s) => `<li>${s}</li>`).join("")}</ul></div>`);

  // Record by level.
  const rows: string[] = [];
  for (let lv = 0; lv < 8; lv++) {
    const gs = games.filter((g) => g.opponent === "stockfish" && g.level === lv);
    if (!gs.length) continue;
    const w = gs.filter((g) => g.result === "win").length;
    const l = gs.filter((g) => g.result === "loss").length;
    rows.push(`<tr><td>Level ${lv + 1}</td><td>${w}</td><td>${l}</td><td>${gs.length - w - l}</td></tr>`);
  }
  const mg = games.filter((g) => g.opponent === "magnus");
  if (mg.length) {
    const w = mg.filter((g) => g.result === "win").length;
    const l = mg.filter((g) => g.result === "loss").length;
    rows.push(`<tr><td>Magnus bot</td><td>${w}</td><td>${l}</td><td>${mg.length - w - l}</td></tr>`);
  }
  if (rows.length) tiles.push(`<div class="tile span4"><h3>Record by opponent</h3><table class="level-table"><thead><tr><th>Opponent</th><th>Won</th><th>Lost</th><th>Drawn</th></tr></thead><tbody>${rows.join("")}</tbody></table></div>`);

  dash.innerHTML = tiles.join("");
}

/** Returning players get one-tap shortcuts to what's waiting for them. */
function renderContinue(streak: number, due: number, games: number): void {
  const box = el("continue");
  const today = dayKey();
  const items: [string, () => void][] = [];
  if (loadStreak().last !== today) {
    items.push([streak > 0 ? `🔥 <strong>${streak}-day streak</strong> · today's puzzle` : "Today's puzzle", () => void startDaily()]);
  }
  if (due > 0) items.push([`↺ <strong>${due}</strong> ${due === 1 ? "mistake" : "mistakes"} to review`, startMistakes]);
  const ls = lessonsSummary();
  if (ls.done > 0 && ls.done < ls.total) items.push([`📘 Lessons <strong>${ls.done}/${ls.total}</strong>`, openLessons]);
  box.innerHTML = '<span class="continue-label">Continue:</span>';
  const returning = games > 0 || streak > 0 || ls.done > 0;
  box.hidden = !returning || items.length === 0;
  for (const [html, go] of items) {
    const b = document.createElement("button");
    b.type = "button";
    b.innerHTML = html;
    b.addEventListener("click", go);
    box.appendChild(b);
  }
}

function refreshHomeCards(): void {
  const today = dayKey();
  const s = loadStreak();
  const n = visibleStreak(s, today);
  const badge = el("streak-badge");
  badge.hidden = n === 0;
  badge.textContent = `🔥 ${n}`;
  el("puzzle-card-title").textContent = s.last === today ? "Solved today ✓" : "Today’s puzzle";
  el("puzzle-card-sub").textContent =
    s.last === today
      ? "Come back tomorrow for a new one and keep your streak alive."
      : n > 0
        ? `Keep your ${n}-day streak going. One puzzle, a few minutes.`
        : "One new puzzle every day. Keep your streak going.";

  const p = progress();
  el("rated-card-sub").textContent =
    p.puzzlesPlayed === 0
      ? "They adapt as you go: get one right and the next is a little harder. From first steps to master level."
      : `Your puzzle rating is ${p.puzzleRating}. Keep solving and watch it climb.`;
  const due = dueCards().length;
  const dueBadge = el("due-badge");
  dueBadge.hidden = due === 0;
  dueBadge.textContent = `${due} due`;
  el("mistakes-card-sub").textContent =
    p.deck.length === 0
      ? "Positions where you slip in games come back here as puzzles, spaced out so they stick."
      : due > 0
        ? `${due} of your own mistakes are ready. Fix them now and they come back less often.`
        : `${p.deck.length} saved. Nothing due right now; they return over the coming days.`;
  renderContinue(n, due, p.games.length);
  const ls = lessonsSummary();
  el("path-card-title").textContent = ls.done === 0 ? "Start the lessons" : `Lessons · ${ls.done}/${ls.total}`;
  (el("path-meter") as HTMLElement).style.width = `${Math.round((ls.done / ls.total) * 100)}%`;
  const acc = p.games
    .slice(-10)
    .map((g) => g.accuracy)
    .filter((x): x is number => x !== null);
  el("progress-card-sub").textContent = p.games.length
    ? `${p.games.length} games played${acc.length ? ` · recent accuracy ${Math.round(acc.reduce((a, b) => a + b, 0) / acc.length)}%` : ""} · puzzle rating ${p.puzzleRating}`
    : "Accuracy, blunders per game, puzzle rating and more, all in one place.";
}

// ---------- Online: play a friend ----------

function shareUrl(roomId: string): string {
  const url = new URL(window.location.href);
  url.search = "";
  url.hash = "";
  url.searchParams.set("room", roomId);
  return url.toString();
}

function applyOnlineState(state: OnlineState): void {
  const prev = onlineState;
  const prevLen = chess.history().length;
  const newGameStarted = !!prev && prev.game !== state.game;
  onlineState = state;
  onlineStateAt = Date.now();

  // Rebuild from the move list so history, captures and repetition are all correct.
  const same = !newGameStarted && chess.history().join(" ") === state.moves.join(" ");
  let lastVerbose: Move | null = null;
  if (!same) {
    chess.reset();
    try {
      for (const san of state.moves) lastVerbose = chess.move(san);
    } catch {
      chess.load(state.fen);
    }
  }
  lastMove = state.lastMove ? [state.lastMove[0] as Key, state.lastMove[1] as Key] : undefined;
  if (!newGameStarted && state.moves.length > prevLen) soundForMove(lastVerbose);
  if (newGameStarted) {
    hideResult();
    resultShownFor = "";
    toast("Rematch! Colours swapped.");
  }
  if (state.status !== "waiting") waitingSince = 0;
  render();

  const key = `online-${state.game}`;
  if (state.over && resultShownFor !== key) {
    resultShownFor = key;
    window.setTimeout(() => showOnlineResult(state), 500);
  } else if (!el("result").hidden && state.over) {
    updateRematchPrompt(state);
  }
}

function oppSeat(): Seat | null {
  return onlineColor === "white" ? "black" : onlineColor === "black" ? "white" : null;
}

function seatName(seat: Seat): string {
  return onlineState?.players[seat].name || (seat === onlineColor ? "You" : "Your friend");
}

function showOnlineResult(s: OnlineState): void {
  const me = onlineColor;
  const opp = oppSeat();
  let kind: ResultKind = "draw";
  if (s.winner && me !== "spectator") kind = s.winner === me ? "win" : "loss";
  const winnerName = s.winner ? seatName(s.winner) : "";
  let title = "It's a draw";
  let sub = "";
  switch (s.status) {
    case "checkmate":
      title = me === "spectator" ? `${winnerName} wins` : kind === "win" ? "Checkmate. You won!" : "Checkmate";
      sub = `${s.result ?? ""} after ${Math.ceil(s.moves.length / 2)} moves.`;
      break;
    case "resigned":
      title = me === "spectator" ? `${winnerName} wins` : kind === "win" ? "You won!" : "You resigned";
      sub = kind === "win" ? `${opp ? seatName(opp) : "Your opponent"} resigned.` : "Good game.";
      break;
    case "timeout":
      title = me === "spectator" ? `${winnerName} wins on time` : kind === "win" ? "You won on time" : "Out of time";
      sub =
        kind === "win"
          ? `${opp ? seatName(opp) : "Your opponent"} didn't move within a minute.`
          : "Each move has a one-minute limit in games against people.";
      break;
    case "abandoned":
      title = kind === "win" ? "You won!" : "Game abandoned";
      sub = "Your opponent left the game.";
      break;
    case "agreed":
      sub = "Draw agreed.";
      break;
    case "stalemate":
      sub = "Stalemate: no legal moves, but no check.";
      break;
    default:
      sub = "Repetition, the fifty-move rule, or not enough pieces to mate.";
  }
  showResult({
    kind,
    kicker: "Online game",
    title,
    sub,
    primary: me === "spectator" ? "Back home" : "Rematch",
    onPrimary: () => {
      if (onlineColor === "spectator") {
        goHome();
        return;
      }
      online?.rematch();
      const btn = el<HTMLButtonElement>("result-primary");
      btn.textContent = "Waiting for your friend…";
      btn.disabled = true;
    },
    share: kind === "win" ? "I just won a game of chess on Chronael ♟️" : "Playing chess with friends on Chronael ♟️",
  });
  updateRematchPrompt(s);
}

function updateRematchPrompt(s: OnlineState): void {
  const opp = oppSeat();
  if (!opp) return;
  if (s.rematch[opp] && !s.rematch[onlineColor as Seat]) {
    el("result-sub").textContent = `${seatName(opp)} wants a rematch!`;
  }
  if (!s.players[opp].online) {
    el("result-sub").textContent = `${seatName(opp)} has left.`;
  }
}

function updateOnlineUI(): void {
  const s = onlineState;
  if (!s) {
    setBanner("Connecting to the game…");
    return;
  }
  const me = onlineColor;
  const opp = oppSeat();
  const oppView = opp ? s.players[opp] : null;
  const waiting = s.status === "waiting";

  el("invite-box").hidden = !waiting || me === "spectator";
  el("fallback").hidden = !(waiting && waitingSince && Date.now() - waitingSince > 20_000);
  el("online-actions").hidden = me === "spectator";

  const offerBtn = el<HTMLButtonElement>("offer-draw");
  const blocked = (s.drawBlockedUntil[me as Seat] ?? 0) > s.moves.length;
  offerBtn.disabled = s.status !== "active" || s.drawOffer !== null || blocked;
  offerBtn.textContent = s.drawOffer === me ? "Draw offered…" : blocked ? "Draw declined" : "Offer draw";
  el<HTMLButtonElement>("resign").disabled = s.status !== "active";
  el("draw-offer").hidden = !(opp && s.drawOffer === opp && !s.over);

  // Opponent disconnected: count down to "claim the win".
  const away = el("away");
  if (opp && oppView?.claimed && !oppView.online && !s.over) {
    const awayMs = oppView.awayMs + (Date.now() - onlineStateAt);
    const remain = s.abandonMs - awayMs;
    away.hidden = false;
    el("away-text").textContent =
      remain > 0
        ? `${seatName(opp)} disconnected. If they don't return, you can claim the win in ${Math.ceil(remain / 1000)}s.`
        : `${seatName(opp)} has been away for a while.`;
    el("claim-win").hidden = remain > 0 || s.status !== "active";
  } else {
    away.hidden = true;
  }

  const spec = el("spectators");
  spec.hidden = s.spectators === 0;
  spec.textContent = `${s.spectators} watching`;

  const inCheck = chess.isCheck();
  // Move clock: the server's deadline, corrected for the gap between server and device clocks.
  const left =
    s.status === "active" && s.turnDeadline
      ? Math.max(0, Math.ceil((s.turnDeadline - (s.serverNow + (Date.now() - onlineStateAt))) / 1000))
      : null;
  const clock = left === null ? "" : ` · ${Math.floor(left / 60)}:${String(left % 60).padStart(2, "0")}`;
  if (s.over) setBanner(s.result ? `Game over · ${s.result}` : "Game over");
  else if (waiting) setBanner("Waiting for your friend to join…");
  else if (me === "spectator") setBanner(`Watching · ${colorToMove()} to move${clock}`);
  else if (colorToMove() === me) setBanner(`${inCheck ? "Your move — you're in check!" : "Your move"}${clock}`);
  else setBanner(`${opp ? seatName(opp) : "Your friend"} is thinking${clock}`);
  bannerEl.classList.toggle("hurry", left !== null && left <= 20 && colorToMove() === me);

  onlineCoachEl.textContent = waiting
    ? "Share the link with a friend. The game starts the moment they open it."
    : me === "spectator"
      ? "Both seats are taken, so you're watching this game live."
      : `You're playing ${me}. Your seat is saved on this device, so a refresh won't lose it.`;
}

function setConnection(state: ConnectionState): void {
  const c = el("conn");
  c.className = `conn ${state}`;
  el("conn-text").textContent =
    state === "open" ? "Connected" : state === "connecting" ? "Connecting…" : "Reconnecting…";
}

function applyOnlineMove(orig: Key, dest: Key, promotion: PromotionPiece | undefined): void {
  let move: Move | null = null;
  try {
    move = chess.move({ from: orig as Square, to: dest as Square, promotion });
  } catch {
    move = null;
  }
  if (!move) {
    render();
    return;
  }
  noteLegal(move.piece);
  soundForMove(move);
  lastMove = [orig, dest];
  render();
  online?.move(orig as string, dest as string, promotion);
}

function handleOnlineUserMove(orig: Key, dest: Key): void {
  if (rejectIllegal(orig, dest)) return;
  if (isPromotion(orig as Square, dest as Square)) {
    void askPromotion(onlineColor === "black" ? "black" : "white").then((p) => applyOnlineMove(orig, dest, p));
  } else {
    applyOnlineMove(orig, dest, undefined);
  }
}

function enterOnline(roomId: string): void {
  stopBackgroundSearch();
  leaveOnline();
  hideResult();
  tutorial.active = false;
  coachSeq++;
  gameNo++;
  mode = "online";
  onlineState = null;
  onlineColor = "spectator";
  waitingSince = Date.now();
  chess.reset();
  lastMove = undefined;
  ground.setShapes([]);
  showView("game");
  showPanel("online-panel");
  onlineLinkEl.value = shareUrl(roomId);

  online = new OnlineGame();
  online.onInit = (color, state) => {
    onlineColor = color;
    playerColor = color === "black" ? "black" : "white";
    ground.set({ orientation: playerColor });
    applyOnlineState(state);
  };
  online.onState = (state) => applyOnlineState(state);
  online.onConnection = setConnection;
  online.connect(roomId);
  onlineTimer = window.setInterval(() => {
    if (mode === "online") updateOnlineUI();
  }, 1000);
  render();
}

/**
 * Playing a person: ask for a display name the first time only (remembered after), then go.
 * Skipping is fine; the opponent just sees "White" or "Black".
 */
function withName(go: () => void): void {
  if (savedName() || localStorageFlag("chronael.nameAsked")) {
    go();
    return;
  }
  const modal = el("name-modal");
  const form = el<HTMLFormElement>("name-form");
  const input = el<HTMLInputElement>("name");
  input.value = "";
  modal.hidden = false;
  input.focus();
  const close = () => {
    modal.hidden = true;
    form.onsubmit = null;
    el("name-cancel").onclick = null;
  };
  form.onsubmit = (e) => {
    e.preventDefault();
    saveName(input.value);
    try {
      localStorage.setItem("chronael.nameAsked", "1");
    } catch {
      /* ignore */
    }
    close();
    go();
  };
  el("name-cancel").onclick = close;
}

/** Quick match: pair with anyone looking right now, or fall back to the computer. */
function startQuickMatch(): void {
  if (!gameConfigured()) {
    toast("Online play isn't available right now.");
    return;
  }
  const modal = el("matching");
  const count = el("match-count");
  let left = 20;
  count.textContent = String(left);
  modal.hidden = false;
  el<HTMLButtonElement>("match-bot").focus();
  const tick = window.setInterval(() => {
    if (paused) return; // the search clock is paused while someone decides
    left = Math.max(0, left - 1);
    count.textContent = String(left);
  }, 1000);
  el("match-searching").hidden = false;
  el("match-choose").hidden = true;
  let outcome: "wait" | "cancel" | "bot" = "wait";
  const title = el("match-title");
  const sub = el("match-sub");
  title.textContent = "Finding an opponent…";
  sub.textContent = presenceText();
  let paused = false;
  const q = quickMatch(20_000, {
    onPresence: (n) => {
      onlineNow = n;
      if (!paused) sub.textContent = presenceText();
    },
    onPending: () => {
      paused = true;
      title.textContent = "Found a player!";
      sub.textContent = "They're finishing a game against the computer. Asking if they'd like to play you…";
    },
    onResume: () => {
      paused = false;
      title.textContent = "Finding an opponent…";
      sub.textContent = "They stayed in their game. Still looking…";
    },
  });
  const stop = (why: "cancel" | "bot") => {
    outcome = why;
    q.cancel();
  };
  el("match-cancel").onclick = () => stop("cancel");
  el("match-bot").onclick = () => stop("bot");
  void q.result.then((room) => {
    window.clearInterval(tick);
    if (room && outcome === "wait") {
      modal.hidden = true;
      window.history.replaceState({}, "", shareUrl(room));
      enterOnline(room);
      toast("Matched with another player. Good luck!");
    } else if (outcome === "cancel") {
      modal.hidden = true;
    } else {
      chooseComputer(outcome === "wait");
    }
  });
}

// ---------- Staying matchable while playing the computer ----------

let onlineNow = 0; // devices with Chronael open, including this one
let stopBg: (() => void) | null = null;
let offerTimer = 0;

function presenceText(): string {
  const others = Math.max(0, onlineNow - 1);
  return others === 0
    ? "Nobody else is online right now. We'll keep looking while you wait."
    : `${others} other ${others === 1 ? "person is" : "people are"} online now.`;
}

function hideOffer(): void {
  window.clearInterval(offerTimer);
  el("offer-banner").hidden = true;
}

function stopBackgroundSearch(): void {
  hideOffer();
  stopBg?.();
  stopBg = null;
}

/** After an empty Quick match, keep the player matchable during their computer game. */
function startBackgroundSearch(): void {
  stopBackgroundSearch();
  if (!gameConfigured()) return;
  stopBg = backgroundSearch(showOffer, hideOffer, (room) => {
    stopBackgroundSearch();
    window.history.replaceState({}, "", shareUrl(room));
    enterOnline(room);
    toast("Live game! Good luck.");
  });
}

function showOffer(offer: BackgroundOffer): void {
  const banner = el("offer-banner");
  const count = el("offer-count");
  let left = Math.round(offer.expiresInMs / 1000);
  count.textContent = `${left}s`;
  el("offer-text").textContent = "A player is ready for a live game.";
  banner.hidden = false;
  playMove();
  window.clearInterval(offerTimer);
  offerTimer = window.setInterval(() => {
    left = Math.max(0, left - 1);
    count.textContent = `${left}s`;
    if (left === 0) hideOffer();
  }, 1000);
  el("offer-join").onclick = () => {
    window.clearInterval(offerTimer);
    el("offer-text").textContent = "Joining…";
    count.textContent = "";
    offer.accept();
  };
  el("offer-stay").onclick = () => {
    offer.decline();
    stopBackgroundSearch(); // they chose the computer; don't keep asking
  };
}

/** Nobody to play: let the player pick the computer opponent explicitly (real-game rules). */
function chooseComputer(timedOut: boolean): void {
  const modal = el("matching");
  modal.hidden = false;
  el("match-searching").hidden = true;
  el("match-choose").hidden = false;
  el("choose-title").textContent = timedOut ? "Nobody’s around right now" : "Play the computer";
  const side = (): Color => {
    const v = (document.querySelector('input[name="fb-side"]:checked') as HTMLInputElement | null)?.value;
    if (v === "white" || v === "black") return v;
    return Math.random() < 0.5 ? "white" : "black";
  };
  const go = (opp: Opponent) => {
    modal.hidden = true;
    const level = parseInt(el<HTMLSelectElement>("fb-level").value, 10);
    startBot(opp, { level: opp === "stockfish" ? level : undefined, side: side(), real: true });
    startBackgroundSearch();
  };
  el("fb-coach").onclick = () => go("stockfish");
  el("fb-magnus").onclick = () => go("magnus");
  el("match-retry").onclick = () => {
    modal.hidden = true;
    startQuickMatch();
  };
  el("match-close").onclick = () => {
    modal.hidden = true;
  };
  el<HTMLButtonElement>("fb-coach").focus();
}

function createOnlineGame(): void {
  const roomId = crypto.randomUUID().replace(/-/g, "").slice(0, 10);
  window.history.replaceState({}, "", shareUrl(roomId));
  enterOnline(roomId);
}

/** Disconnect from any online game and drop ?room= from the URL. Safe to call anytime. */
function leaveOnline(): void {
  if (!online && mode !== "online") return;
  online?.close();
  online = null;
  window.clearInterval(onlineTimer);
  onlineState = null;
  onlineColor = "spectator";
  mode = "bot";
  const url = new URL(window.location.href);
  if (url.searchParams.has("room")) {
    url.searchParams.delete("room");
    window.history.replaceState({}, "", url.toString());
  }
}

// ---------- Init ----------

// ---------- Move dots that fade as each piece is learned ----------

/** An illegal try (possible when a piece's dots are off): explain it and snap back. */
function rejectIllegal(orig: Key, dest: Key): boolean {
  const why = explainIllegal(chess.fen(), orig, dest);
  if (!why) return false;
  const p = chess.get(orig as Square);
  if (p) recordIllegal(p.type);
  shakeBoard();
  if (mode === "puzzle") puzzleTextEl.textContent = why;
  else if (mode === "online") toast(why);
  else {
    feedbackActive = true;
    coachEl.textContent = why;
  }
  render();
  return true;
}

let peekTipShown = localStorageFlag("chronael.peekTip");

/** A legal move: counts toward that piece's dots switching off. */
function noteLegal(type: string): void {
  if (!recordLegal(type)) return;
  toast(`You know the ${pieceName(type)} now, so its move dots are off.`);
  if (!peekTipShown) {
    peekTipShown = true;
    try {
      localStorage.setItem("chronael.peekTip", "1");
    } catch {
      /* ignore */
    }
    window.setTimeout(() => toast("Stuck? Press and hold a piece to peek at its moves."), 2600);
  }
}

/** Picking up a piece: dots only for pieces not yet learned (never against people). */
function onSelect(key: Key): void {
  if (mode === "vision") {
    visionTap(key);
    return;
  }
  liftSelected();
  if (ground.state.selected === key && ground.state.pieces.get(key)?.color === ground.state.movable.color) haptic(8);
  if (tutorial.active) return;
  if (mode === "online" || realGame) return; // render() already set free movement, no dots
  const p = chess.get(key as Square);
  if (!p || (p.color === "w") !== (playerColor === "white")) return;
  const learned = isMastered(p.type);
  ground.set({ movable: { free: learned, showDests: !learned } });
}

/** Press and hold a learned piece to peek at its dots (not in games against people). */
function setupPeek(boardEl: HTMLElement): void {
  let timer = 0;
  const cancel = () => window.clearTimeout(timer);
  boardEl.addEventListener("pointerdown", () => {
    cancel();
    timer = window.setTimeout(() => {
      if (mode === "online" || mode === "vision" || realGame || tutorial.active) return;
      const sel = ground.state.selected;
      const p = sel ? chess.get(sel as Square) : null;
      if (!p || !isMastered(p.type)) return;
      ground.set({ movable: { free: false, showDests: true } });
      ground.redrawAll();
      if (recordPeek(p.type)) toast(`Dots are back for the ${pieceName(p.type)} for a while. Keep practising!`);
    }, 450);
  });
  for (const ev of ["pointerup", "pointercancel", "pointerleave"]) boardEl.addEventListener(ev, cancel);
}

// ---------- Board vision drills: "tap every square the knight can reach" ----------

const VISION_ORDER = ["n", "b", "r", "q", "k"] as const;

interface Vision {
  type: string;
  from: string;
  targets: Set<string>;
  found: Set<string>;
  wrong: number;
  start: number;
  done: boolean;
}

let vision: Vision | null = null;
let visionTick = 0;

function visionTargets(type: string, from: string): Set<string> {
  const out = new Set<string>();
  for (let f = 0; f < 8; f++) {
    for (let r = 0; r < 8; r++) {
      const sq = `${String.fromCharCode(97 + f)}${r + 1}`;
      if (sq !== from && rightShape(type, true, from, sq, false)) {
        // Castling-shaped king moves aren't real moves on an empty board.
        if (type === "k" && Math.abs(sq.charCodeAt(0) - from.charCodeAt(0)) === 2) continue;
        out.add(sq);
      }
    }
  }
  return out;
}

function startVision(type: string): void {
  leaveOnline();
  hideResult();
  tutorial.active = false;
  coachSeq++;
  gameNo++;
  mode = "vision";
  showView("game");
  showPanel("vision-panel");
  // Pieces on the edge are too easy; pick a square away from it.
  const f = 1 + Math.floor(Math.random() * 6);
  const r = 1 + Math.floor(Math.random() * 6);
  const from = `${String.fromCharCode(97 + f)}${r + 1}`;
  vision = { type, from, targets: visionTargets(type, from), found: new Set(), wrong: 0, start: Date.now(), done: false };
  const letter = type.toUpperCase();
  const rows: string[] = [];
  for (let rank = 7; rank >= 0; rank--) {
    let row = "";
    let empty = 0;
    for (let file = 0; file < 8; file++) {
      if (file === f && rank === r) {
        if (empty) row += empty;
        empty = 0;
        row += letter;
      } else empty++;
    }
    if (empty) row += empty;
    rows.push(row);
  }
  playerColor = "white";
  lastMove = undefined;
  ground.set({
    fen: rows.join("/"),
    orientation: "white",
    lastMove: undefined,
    check: undefined,
    movable: { free: false, color: undefined, dests: new Map() },
  });
  ground.setShapes([]);
  const name = pieceName(type);
  el("vision-meta").textContent = `Board vision · ${VISION_ORDER.indexOf(type as never) + 1} of ${VISION_ORDER.length}`;
  el("vision-title").textContent = `Where can the ${name} go?`;
  const text = el("vision-text");
  text.classList.remove("bad");
  text.textContent = `Tap every square the ${name} can reach in one move. No dots, just your eyes.`;
  setPlayer("bottom", savedName() || "You", "Board vision");
  setPlayer("top", "Drill", `${vision.targets.size} squares to find`);
  capYoursEl.textContent = "";
  capTheirsEl.textContent = "";
  setBanner("Board vision");
  el<HTMLButtonElement>("vision-next").textContent =
    type === VISION_ORDER[VISION_ORDER.length - 1] ? "Back to lessons" : "Next piece";
  updateVisionScore();
  window.clearInterval(visionTick);
  visionTick = window.setInterval(updateVisionScore, 1000);
}

function updateVisionScore(): void {
  if (!vision) return;
  el("vision-found").textContent = `${vision.found.size} / ${vision.targets.size} found`;
  if (!vision.done) el("vision-time").textContent = `${Math.round((Date.now() - vision.start) / 1000)}s`;
}

function drawVision(extra: { orig: Key; brush: string }[] = []): void {
  if (!vision) return;
  ground.setShapes([...[...vision.found].map((sq) => ({ orig: sq as Key, brush: "green" })), ...extra]);
}

function visionTap(key: Key): void {
  const v = vision;
  if (!v || v.done || key === v.from) return;
  window.setTimeout(() => ground.selectSquare(null), 0); // after Chessground finishes this click
  const text = el("vision-text");
  if (v.targets.has(key)) {
    if (v.found.has(key)) return;
    v.found.add(key);
    playMove();
    text.classList.remove("bad");
    drawVision();
  } else {
    v.wrong++;
    text.classList.add("bad");
    text.textContent = `Not that one. ${
      {
        n: "A knight moves in an L: two squares one way, then one to the side.",
        b: "A bishop only moves diagonally.",
        r: "A rook moves along its row or its column.",
        q: "The queen moves along rows, columns and diagonals.",
        k: "The king moves just one square in any direction.",
      }[v.type as "n"] ?? ""
    }`;
    drawVision([{ orig: key, brush: "red" }]);
    window.setTimeout(() => {
      if (vision === v && !v.done) drawVision();
    }, 700);
  }
  updateVisionScore();
  if (v.found.size === v.targets.size) finishVision();
}

function finishVision(): void {
  const v = vision;
  if (!v) return;
  v.done = true;
  window.clearInterval(visionTick);
  const secs = Math.round((Date.now() - v.start) / 1000);
  const stars = v.wrong === 0 ? (secs <= 20 ? 3 : 2) : v.wrong <= 2 ? 2 : 1;
  setLessonStars(`vision-${v.type}`, stars);
  if (v.wrong <= 1) markTested(v.type); // clear board vision = this piece's dots can go
  const text = el("vision-text");
  text.classList.remove("bad");
  text.textContent = `All ${v.targets.size} found in ${secs}s${v.wrong ? ` with ${v.wrong} wrong tap${v.wrong === 1 ? "" : "s"}` : ", no mistakes"}. ${"★".repeat(stars)}${"☆".repeat(3 - stars)}`;
  updateVisionScore();
}

function visionNext(): void {
  if (!vision) return;
  const i = VISION_ORDER.indexOf(vision.type as never);
  const next = VISION_ORDER[i + 1];
  if (next) startVision(next);
  else openLessons();
}

function init(): void {
  // Views are swapped in place, so the browser restoring an old scroll offset lands mid-page.
  if ("scrollRestoration" in window.history) window.history.scrollRestoration = "manual";
  const config: Config = {
    fen: chess.fen(),
    orientation: playerColor,
    turnColor: colorToMove(),
    movable: { free: false, color: undefined, dests: new Map(), showDests: true, events: { after: onUserMove } },
    events: { select: onSelect },
    animation: { enabled: !reducedMotion(), duration: 200 },
    highlight: { lastMove: true, check: true },
    draggable: { enabled: true, showGhost: true },
    blockTouchScroll: true, // touches on the board are moves, never page scrolls (iOS)
    drawable: { enabled: true },
    coordinates: true, // built once; shown/hidden via the .coords-on CSS class
  };
  ground = Chessground(el<HTMLDivElement>("board"), config);
  setupPeek(el("board"));
  // The board's size follows the screen on phones; re-measure on rotate or resize.
  let resizeRaf = 0;
  window.addEventListener("resize", () => {
    cancelAnimationFrame(resizeRaf);
    resizeRaf = requestAnimationFrame(() => document.body.dispatchEvent(new Event("chessground.resize")));
  });

  tutorial = new PieceTutorial(
    ground,
    {
      playPanel: el<HTMLElement>("play-panel"),
      tutorialPanel: el<HTMLElement>("tutorial-panel"),
      progress: el<HTMLElement>("tut-progress"),
      title: el<HTMLElement>("tut-title"),
      text: el<HTMLElement>("tut-text"),
      hint: el<HTMLElement>("tut-hint"),
      prevBtn: el<HTMLButtonElement>("tut-prev"),
      nextBtn: el<HTMLButtonElement>("tut-next"),
    },
    () => {
      if (!el("game").hidden) startBot();
    },
  );

  // Home.
  el("brand").addEventListener("click", () => goHome());
  // One dropdown picks the opponent: the coach bot at a level, or the Magnus bot.
  const levelSel = el<HTMLSelectElement>("level");
  const reflectOpponent = () => {
    el("hero-play").textContent = levelSel.value === "magnus" ? "Play Magnus" : "Play now";
  };
  levelSel.addEventListener("change", reflectOpponent);
  reflectOpponent();
  el("hero-play").addEventListener("click", () =>
    startBot(levelSel.value === "magnus" ? "magnus" : "stockfish", { real: false }),
  );
  el("hero-learn").addEventListener("click", startTutorial);
  el("hero-quick").addEventListener("click", () => withName(startQuickMatch));
  el("hero-friend").addEventListener("click", () => withName(createOnlineGame));
  if (gameConfigured()) {
    watchPresence((n) => {
      onlineNow = n;
      const badge = el("online-count");
      const others = Math.max(0, n - 1);
      badge.hidden = others === 0;
      badge.textContent = `${others} online`;
    });
  } else {
    for (const id of ["hero-quick", "hero-friend"]) {
      const b = el<HTMLButtonElement>(id);
      b.disabled = true;
      b.title = "Online play is being set up.";
    }
  }
  el("card-bot").addEventListener("click", () => startBot());
  el("card-magnus").addEventListener("click", () => startBot("magnus"));
  el("card-learn").addEventListener("click", openLessons);
  el("card-puzzle").addEventListener("click", () => void startDaily());
  el("card-rated").addEventListener("click", () => void startRated());
  el("card-mistakes").addEventListener("click", startMistakes);
  el("card-progress").addEventListener("click", openProgress);
  el("nav-progress").addEventListener("click", openProgress);
  el("nav-lessons").addEventListener("click", openLessons);
  el("nav-about").addEventListener("click", () => {
    goHome(false);
    showView("about");
  });
  el("about-play").addEventListener("click", () => goHome());
  el("about-lessons").addEventListener("click", openLessons);

  // Bot game controls.
  el<HTMLSelectElement>("opponent").addEventListener("change", (e) => {
    setOpponent((e.target as HTMLSelectElement).value as Opponent);
    renderPlayers();
  });
  el("undo").addEventListener("click", takeBack);
  el("hint").addEventListener("click", () => void showHint());
  el("newgame").addEventListener("click", newGame);
  el("resign-bot").addEventListener("click", () => {
    if (isOver() || chess.history().length === 0) return;
    coachSeq++;
    botResigned = true;
    render();
  });

  // Tutorial.
  el("tut-exit").addEventListener("click", () => tutorial.exit());
  el("vision-again").addEventListener("click", () => vision && startVision(vision.type));
  el("vision-next").addEventListener("click", visionNext);
  el("vision-exit").addEventListener("click", openLessons);

  // Puzzle.
  el("puzzle-hint").addEventListener("click", puzzleHint);
  el("puzzle-reveal").addEventListener("click", puzzleReveal);
  el("puzzle-exit").addEventListener("click", () => (ex?.kind === "lesson" ? openLessons() : goHome()));
  el("puzzle-next").addEventListener("click", () => {
    if (!el<HTMLButtonElement>("puzzle-next").onclick) exerciseNext();
  });

  // Review.
  el("moment-prev").addEventListener("click", () => stepMoment(-1));
  el("moment-next").addEventListener("click", () => stepMoment(1));
  el("review-try").addEventListener("click", reviewTry);
  el("review-again").addEventListener("click", () => {
    reviewState = null;
    showPanel("play-panel");
    newGame();
  });
  el("review-exit").addEventListener("click", () => goHome());
  el("result-review").addEventListener("click", openReview);
  el("result-alt").addEventListener("click", () => {
    hideResult();
    newGame();
  });

  // Online.
  el("online-leave").addEventListener("click", () => goHome());
  el("fallback-bot").addEventListener("click", () => chooseComputer(false));
  el("resign").addEventListener("click", () => {
    if (window.confirm("Resign this game?")) online?.resign();
  });
  el("offer-draw").addEventListener("click", () => online?.offerDraw());
  el("draw-accept").addEventListener("click", () => online?.acceptDraw());
  el("draw-decline").addEventListener("click", () => online?.declineDraw());
  el("claim-win").addEventListener("click", () => online?.claimWin());
  el("online-copy").addEventListener("click", () => {
    onlineLinkEl.select();
    const btn = el<HTMLButtonElement>("online-copy");
    const done = () => {
      btn.textContent = "Copied!";
      window.setTimeout(() => (btn.textContent = "Copy"), 1200);
    };
    if (navigator.clipboard) navigator.clipboard.writeText(onlineLinkEl.value).then(done).catch(done);
    else done();
  });

  // Result moment.
  el("result-primary").addEventListener("click", () => resultPrimary?.());
  el("result-share").addEventListener("click", () => void shareText(resultShare));
  el("result-home").addEventListener("click", () => goHome());
  document.addEventListener("keydown", (e) => {
    if (e.key === "Escape" && !el("result").hidden) hideResult();
  });

  // Sound mute toggle.
  const muteBtn = el<HTMLButtonElement>("mute");
  const reflectMute = () => {
    const m = isMuted();
    muteBtn.classList.toggle("is-muted", m);
    muteBtn.setAttribute("aria-pressed", String(m));
    muteBtn.setAttribute("aria-label", m ? "Unmute sounds" : "Mute sounds");
    (muteBtn.querySelector(".mute-on") as HTMLElement).hidden = m;
    (muteBtn.querySelector(".mute-off") as HTMLElement).hidden = !m;
  };
  muteBtn.addEventListener("click", () => {
    setMuted(!isMuted());
    reflectMute();
  });
  reflectMute();

  // Board coordinate labels.
  const coordsBox = el<HTMLInputElement>("coords");
  const boardEl = el<HTMLDivElement>("board");
  let coordsOn = false;
  try {
    coordsOn = localStorage.getItem("chronael.coords") === "1";
  } catch {
    /* ignore */
  }
  coordsBox.checked = coordsOn;
  boardEl.classList.toggle("coords-on", coordsOn);
  coordsBox.addEventListener("change", () => {
    boardEl.classList.toggle("coords-on", coordsBox.checked);
    try {
      localStorage.setItem("chronael.coords", coordsBox.checked ? "1" : "0");
    } catch {
      /* ignore */
    }
  });

  // "Tell me more" coach follow-up.
  coachMoreEl.addEventListener("click", () => {
    if (!lastCoachFacts) return;
    const facts = lastCoachFacts;
    const seq = coachSeq;
    coachMoreEl.disabled = true;
    coachMoreEl.textContent = "Thinking…";
    void explainMore(facts).then((extra) => {
      if (seq !== coachSeq) return;
      if (extra) coachEl.textContent = `${coachEl.textContent} ${extra}`;
      coachMoreEl.hidden = true;
    });
  });

  setupPwa();
  startHeroDemo();
  revealOnScroll();

  // Deep links: ?room= joins a friend's game; ?play=puzzle opens today's puzzle.
  const params = new URL(window.location.href).searchParams;
  const roomParam = params.get("room");
  if (roomParam && /^[a-z0-9-]{3,40}$/i.test(roomParam)) enterOnline(roomParam.toLowerCase());
  else if (params.get("play") === "puzzle") void startDaily();
  else if (window.location.hash === "#about") showView("about");
  else showView("home");
  window.addEventListener("hashchange", () => {
    if (window.location.hash === "#about") {
      goHome(false);
      showView("about");
    } else if (!el("about").hidden) showView("home");
  });

  // Test hook: dev server, or an e2e build (VITE_E2E=1).
  if (import.meta.env.DEV || import.meta.env.VITE_E2E) {
    (window as Window & { __chronael?: unknown }).__chronael = {
      chess,
      engine,
      drills: allDrills(),
      Chess,
      progress,
      engineMove,
      carlsen,
      onUserMove,
      magnusTop: async (fen: string) => {
        const tmp = new Chess(fen);
        const ranked = await carlsen.rank(tmp);
        return ranked
          .slice(0, 5)
          .map((s) => `${s.move.from}${s.move.to}${s.move.promotion ?? ""}:${s.probability.toFixed(3)}`);
      },
      loadFen: (fen: string) => {
        coachSeq++;
        moveLog = [];
        gameNo++;
        chess.load(fen);
        lastMove = undefined;
        botResigned = false;
        resetCoachUi();
        render();
        void prepareCoach();
      },
    };
  }
}

init();
