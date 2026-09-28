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

import type { Move } from "chess.js";

import "chessground/assets/chessground.base.css";
import "chessground/assets/chessground.brown.css";
import "chessground/assets/chessground.cburnett.css";
import "./style.css";

type Color = "white" | "black";
type Mode = "bot" | "puzzle" | "online";
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
let gameNo = 0; // bumps on every new bot game, so the result moment shows once per game
let resultShownFor = "";

// Coaching state.
let beforeEval: { fen: string; scoreCp: number; bestUci: string } | null = null;
let feedbackActive = false; // a move-rating message is showing; don't clobber with tips
let coachSeq = 0; // guards against stale async coach updates after take-back / new game
let lastCoachFacts: CoachFacts | null = null;

// Daily puzzle state.
let puzzle: Puzzle | null = null;
let puzzleStep = 0;
let puzzleDone = false;
let puzzleRevealed = false;

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

const PANELS = ["play-panel", "tutorial-panel", "puzzle-panel", "online-panel"] as const;

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
  if (mode === "puzzle") return !!puzzle && !puzzleDone && colorToMove() === playerColor;
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
  if (move && (move.captured || move.flags.includes("e"))) playCapture();
  else playMove();
}

let ground: Api;
let tutorial: PieceTutorial;

// ---------- Views, panels, players ----------

function showView(view: "home" | "game"): void {
  el("home").hidden = view !== "home";
  el("game").hidden = view !== "game";
  window.scrollTo({ top: 0 });
  if (view === "home") refreshHomeCards();
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
    setPlayer("top", "Puzzle", puzzle ? `Rated ${puzzle.rating}` : "");
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
  if (mode === "puzzle") return puzzleDone;
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
    movable: { color: movable ? playerColor : undefined, dests: movable ? legalDests() : new Map() },
  });

  if (mode === "online") updateOnlineUI();
  else if (mode === "puzzle") updatePuzzleStatus();
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
    coachEl.textContent = youWon ? "Well played! Try a harder level?" : "Good effort. Take a move back and try again.";
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
  window.setTimeout(
    () =>
      showResult({
        kind,
        kicker: "Game over",
        title,
        sub,
        primary: "Play again",
        onPrimary: () => {
          hideResult();
          newGame();
        },
        share:
          kind === "win"
            ? `I just beat ${who} on Chronael ♟️`
            : "I'm learning chess with a friendly coach on Chronael ♟️",
      }),
    600,
  );
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
  await coachOnMove(snapshot, movedUci, fenBefore, fenAfter);
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
  const rating = classify(Math.max(0, scoreBefore - playerEvalAfter));
  const bestPlain = snapshot ? describeMove(snapshot.fen, snapshot.bestUci) : undefined;

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
  updateEvalBar(whiteCp(fen, scoreCp));
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
  if (chess.history().length === 0 || thinking) return;
  coachSeq++;
  if (botResigned || chess.isGameOver()) resultShownFor = "";
  botResigned = false;
  chess.undo();
  if (colorToMove() !== playerColor && chess.history().length > 0) chess.undo();
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

function startBot(opp: Opponent = "stockfish"): void {
  leaveOnline();
  if (tutorial.active) tutorial.active = false;
  hideResult();
  playerColor = pickSide();
  levelIndex = parseInt(el<HTMLSelectElement>("level").value, 10);
  showView("game");
  showPanel("play-panel");
  opponent = opp;
  newGame();
  setOpponent(opp); // after newGame so its "loading" message isn't replaced by a tip
}

function startTutorial(): void {
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

function goHome(): void {
  coachSeq++;
  gameNo++;
  thinking = false;
  hideResult();
  leaveOnline();
  if (tutorial.active) tutorial.active = false;
  mode = "bot";
  puzzle = null;
  showView("home");
}

// ---------- Daily puzzle ----------

async function startPuzzle(): Promise<void> {
  leaveOnline();
  hideResult();
  tutorial.active = false;
  coachSeq++;
  gameNo++;
  mode = "puzzle";
  showView("game");
  showPanel("puzzle-panel");
  let list: Puzzle[];
  try {
    list = await loadPuzzles();
  } catch {
    toast("Couldn't load today's puzzle. Are you offline?");
    goHome();
    return;
  }
  const today = dayKey();
  puzzle = list[dailyIndex(today, list.length)];
  puzzleStep = 0;
  puzzleDone = false;
  puzzleRevealed = false;
  chess.load(puzzle.fen);
  playerColor = sideToMove(puzzle.fen);
  lastMove = [puzzle.lastMove.slice(0, 2) as Key, puzzle.lastMove.slice(2, 4) as Key];
  ground.set({ orientation: playerColor });
  ground.setShapes([]);
  el("puzzle-meta").textContent = `Daily puzzle · ${THEME_NAMES[puzzle.theme] ?? "Tactic"} · rated ${puzzle.rating}`;
  el("puzzle-goal").textContent = puzzle.goal;
  puzzleTextEl.textContent = `Your opponent just moved (highlighted). You play ${playerColor}. Find the best move.`;
  el<HTMLButtonElement>("puzzle-hint").disabled = false;
  el<HTMLButtonElement>("puzzle-reveal").disabled = false;
  refreshStreakText();
  render();
}

function refreshStreakText(): void {
  const s = loadStreak();
  const n = visibleStreak(s, dayKey());
  el("puzzle-streak").textContent =
    n > 0 ? `${n}-day streak${s.last === dayKey() ? " · solved today" : ""}` : "Solve today to start a streak";
}

function updatePuzzleStatus(): void {
  if (!puzzle) return;
  if (puzzleDone) setBanner(puzzleRevealed ? "Here's the solution." : "Solved!");
  else if (colorToMove() === playerColor) setBanner(`Your move: ${puzzle.goal.toLowerCase()}`);
  else setBanner("Opponent replies…");
}

function handlePuzzleMove(orig: Key, dest: Key): void {
  if (isPromotion(orig as Square, dest as Square)) {
    void askPromotion(playerColor).then((p) => puzzleTry(orig, dest, p));
  } else {
    puzzleTry(orig, dest, undefined);
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

function puzzleTry(orig: Key, dest: Key, promo: PromotionPiece | undefined): void {
  if (!puzzle || puzzleDone) return;
  const uci = `${orig}${dest}${promo ?? ""}`;
  const expected = puzzle.solution[puzzleStep];
  const probe = new Chess(chess.fen());
  let mateAlt = false;
  try {
    probe.move({ from: orig as Square, to: dest as Square, promotion: promo });
    mateAlt = probe.isCheckmate(); // any mate is a correct answer
  } catch {
    /* illegal */
  }
  if (uci !== expected && !mateAlt) {
    const wrap = document.querySelector(".board-wrap") as HTMLElement;
    wrap.classList.remove("puzzle-wrong");
    void wrap.offsetWidth;
    wrap.classList.add("puzzle-wrong");
    puzzleTextEl.textContent = "Not quite. That lets your opponent off the hook. Look again!";
    render();
    return;
  }
  ground.setShapes([]);
  soundForMove(playUci(uci));
  puzzleStep++;
  if (puzzleStep >= puzzle.solution.length || chess.isCheckmate()) {
    render();
    void puzzleSolved();
    return;
  }
  puzzleTextEl.textContent = "Good! Your opponent replies… keep going.";
  render();
  const step = puzzleStep;
  window.setTimeout(() => {
    if (!puzzle || puzzleDone || puzzleStep !== step || mode !== "puzzle") return;
    soundForMove(playUci(puzzle.solution[puzzleStep]));
    puzzleStep++;
    puzzleTextEl.textContent = "Your move again. Finish it off.";
    render();
  }, 550);
}

async function puzzleSolved(): Promise<void> {
  if (!puzzle) return;
  puzzleDone = true;
  const p = puzzle;
  const today = dayKey();
  const s = nextStreak(loadStreak(), today);
  saveStreak(s);
  refreshStreakText();
  render();
  const firstPlain = describeMove(p.fen, p.solution[0]);
  const keyMove = `Key move: ${firstPlain}.`;
  puzzleTextEl.textContent = keyMove;
  showResult({
    kind: "win",
    kicker: `Daily puzzle · ${THEME_NAMES[p.theme] ?? "Tactic"}`,
    title: "Solved!",
    sub: `${s.streak}-day streak${s.best > s.streak ? ` (best ${s.best})` : ""}. A new puzzle arrives tomorrow.`,
    primary: "Play a game",
    onPrimary: () => startBot(),
    share: `I solved today's Chronael chess puzzle 🔥 ${s.streak}-day streak`,
  });
  const why = await explain({ movedPlain: firstPlain, classification: "great" });
  if (why && puzzle === p) puzzleTextEl.textContent = `${keyMove} ${why}`;
}

function puzzleHint(): void {
  if (!puzzle || puzzleDone) return;
  const next = puzzle.solution[puzzleStep];
  ground.setShapes([{ orig: next.slice(0, 2) as Key, brush: "green" }]);
  puzzleTextEl.textContent = `Look at the circled piece. Hint: ${THEME_NAMES[puzzle.theme] ?? "tactic"}.`;
}

function puzzleReveal(): void {
  if (!puzzle || puzzleDone) return;
  puzzleDone = true;
  puzzleRevealed = true;
  el<HTMLButtonElement>("puzzle-hint").disabled = true;
  el<HTMLButtonElement>("puzzle-reveal").disabled = true;
  ground.setShapes([]);
  const p = puzzle;
  puzzleTextEl.textContent = `Key move: ${describeMove(chess.fen(), p.solution[puzzleStep])}. Come back tomorrow to build your streak.`;
  const stepOnce = () => {
    if (puzzle !== p || puzzleStep >= p.solution.length || mode !== "puzzle") return;
    soundForMove(playUci(p.solution[puzzleStep]));
    puzzleStep++;
    render();
    window.setTimeout(stepOnce, 800);
  };
  render();
  window.setTimeout(stepOnce, 300);
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
  if (s.over) setBanner(s.result ? `Game over · ${s.result}` : "Game over");
  else if (waiting) setBanner("Waiting for your friend to join…");
  else if (me === "spectator") setBanner(`Watching · ${colorToMove()} to move`);
  else if (colorToMove() === me) setBanner(inCheck ? "Your move — you're in check!" : "Your move.");
  else setBanner(`${opp ? seatName(opp) : "Your friend"} is thinking…`);

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
  soundForMove(move);
  lastMove = [orig, dest];
  render();
  online?.move(orig as string, dest as string, promotion);
}

function handleOnlineUserMove(orig: Key, dest: Key): void {
  if (isPromotion(orig as Square, dest as Square)) {
    void askPromotion(onlineColor === "black" ? "black" : "white").then((p) => applyOnlineMove(orig, dest, p));
  } else {
    applyOnlineMove(orig, dest, undefined);
  }
}

function enterOnline(roomId: string): void {
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

function init(): void {
  const config: Config = {
    fen: chess.fen(),
    orientation: playerColor,
    turnColor: colorToMove(),
    movable: { free: false, color: undefined, dests: new Map(), showDests: true, events: { after: onUserMove } },
    animation: { enabled: !reducedMotion(), duration: 200 },
    highlight: { lastMove: true, check: true },
    draggable: { enabled: true, showGhost: true },
    drawable: { enabled: true },
    coordinates: true, // built once; shown/hidden via the .coords-on CSS class
  };
  ground = Chessground(el<HTMLDivElement>("board"), config);

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
  const nameInput = el<HTMLInputElement>("name");
  nameInput.value = savedName();
  nameInput.addEventListener("change", () => saveName(nameInput.value));
  el("brand").addEventListener("click", goHome);
  el("start-bot").addEventListener("click", () => startBot());
  el("card-bot").addEventListener("click", () => startBot());
  el("card-magnus").addEventListener("click", () => startBot("magnus"));
  el("card-learn").addEventListener("click", startTutorial);
  el("card-puzzle").addEventListener("click", () => void startPuzzle());
  const playFriendBtn = el<HTMLButtonElement>("play-friend");
  if (!gameConfigured()) {
    playFriendBtn.disabled = true;
    playFriendBtn.title = "Online play is being set up (needs VITE_GAME_HOST).";
  }
  playFriendBtn.addEventListener("click", () => {
    saveName(nameInput.value);
    createOnlineGame();
  });

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

  // Puzzle.
  el("puzzle-hint").addEventListener("click", puzzleHint);
  el("puzzle-reveal").addEventListener("click", puzzleReveal);
  el("puzzle-exit").addEventListener("click", goHome);

  // Online.
  el("online-leave").addEventListener("click", goHome);
  el("fallback-bot").addEventListener("click", () => startBot());
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
  el("result-home").addEventListener("click", goHome);
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

  // Deep links: ?room= joins a friend's game; ?play=puzzle opens today's puzzle.
  const params = new URL(window.location.href).searchParams;
  const roomParam = params.get("room");
  if (roomParam && /^[a-z0-9-]{3,40}$/i.test(roomParam)) enterOnline(roomParam.toLowerCase());
  else if (params.get("play") === "puzzle") void startPuzzle();
  else showView("home");

  // Test hook: dev server, or an e2e build (VITE_E2E=1).
  if (import.meta.env.DEV || import.meta.env.VITE_E2E) {
    (window as Window & { __chronael?: unknown }).__chronael = {
      chess,
      engine,
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
