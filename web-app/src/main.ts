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
  describeMove,
  type CoachFacts,
} from "./coach";
import { askPromotion } from "./promotion";
import { PieceTutorial } from "./tutorial";
import { playMove, playCapture, isMuted, setMuted } from "./sound";
import { CarlsenEngine } from "./carlsen";

import type { Move } from "chess.js";

import "chessground/assets/chessground.base.css";
import "chessground/assets/chessground.brown.css";
import "chessground/assets/chessground.cburnett.css";
import "./style.css";

type Color = "white" | "black";

const chess = new Chess();
const engine = new ChessEngine();
const carlsen = new CarlsenEngine();

type Opponent = "stockfish" | "magnus";
let opponent: Opponent = "stockfish";

let playerColor: Color = "white";
let levelIndex = 2;
let lastMove: [Key, Key] | undefined;
let thinking = false;

// Coaching state.
let beforeEval: { fen: string; scoreCp: number; bestUci: string } | null = null;
let feedbackActive = false; // a move-rating message is showing; don't clobber with tips
let coachSeq = 0; // guards against stale async coach updates after take-back / new game

const el = <T extends HTMLElement>(id: string) => document.getElementById(id) as T;
const statusEl = el<HTMLDivElement>("status");
const coachEl = el<HTMLDivElement>("coach");
const movesEl = el<HTMLOListElement>("moves");
const evalFillEl = el<HTMLDivElement>("eval-fill");
const ratingEl = el<HTMLDivElement>("rating");
const capYoursEl = el<HTMLSpanElement>("cap-yours");
const capTheirsEl = el<HTMLSpanElement>("cap-theirs");
const capSummaryEl = el<HTMLDivElement>("cap-summary");
const coachMoreEl = el<HTMLButtonElement>("coach-more");

let lastCoachFacts: CoachFacts | null = null;

const TIPS = [
  "Control the centre — pawns on e4/d4 (or e5/d5) give your pieces room.",
  "Develop knights and bishops early; don't move the same piece twice for no reason.",
  "Castle soon to tuck your king safely behind its pawns.",
  "Before you move, ask: is anything of mine under attack?",
  "A piece you can capture for free is usually worth taking.",
];

function colorToMove(): Color {
  return chess.turn() === "w" ? "white" : "black";
}

function playerTurn(): boolean {
  return colorToMove() === playerColor && !chess.isGameOver();
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

function sideToMove(fen: string): Color {
  return fen.split(" ")[1] === "w" ? "white" : "black";
}

/** Convert a side-to-move centipawn score into White's perspective (for the bar). */
function whiteCp(fen: string, scoreCp: number): number {
  return sideToMove(fen) === "white" ? scoreCp : -scoreCp;
}

/** White's share of the eval bar, 0-100%, via a gentle sigmoid of the centipawns. */
function updateEvalBar(whiteCpVal: number): void {
  const pct = 50 + 50 * Math.tanh(whiteCpVal / 400);
  evalFillEl.style.width = `${pct.toFixed(1)}%`;
}

const INITIAL_COUNT: Record<string, number> = { p: 8, n: 2, b: 2, r: 2, q: 1 };
const PIECE_VALUE: Record<string, number> = { p: 1, n: 3, b: 3, r: 5, q: 9 };
const PIECE_GLYPH: Record<string, string> = { p: "♟", n: "♞", b: "♝", r: "♜", q: "♛" };

/** Show each side's captured pieces and a plain-English material summary. */
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
  const mine = playerColor === "white" ? capByWhite : capByBlack;
  const theirs = playerColor === "white" ? capByBlack : capByWhite;
  const diff = playerColor === "white" ? matW - matB : matB - matW;
  capYoursEl.textContent = mine || "—";
  capTheirsEl.textContent = theirs || "—";
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

function render(): void {
  const turn = colorToMove();
  const inCheck = chess.isCheck();
  const myMove = playerTurn();

  ground.set({
    fen: chess.fen(),
    turnColor: turn,
    lastMove,
    check: inCheck ? turn : undefined,
    movable: {
      color: myMove ? playerColor : undefined,
      dests: myMove ? legalDests() : new Map(),
    },
  });

  updateStatus(inCheck);
  updateMoves();
  updateCaptured();
}

function updateStatus(inCheck: boolean): void {
  if (chess.isCheckmate()) {
    const winner = colorToMove() === playerColor ? "Chronael" : "You";
    statusEl.textContent = `Checkmate — ${winner} won!`;
    coachEl.textContent =
      winner === "You" ? "Well played! Try a harder level?" : "Good effort — take a move back and try again.";
    return;
  }
  if (chess.isStalemate()) {
    statusEl.textContent = "Stalemate — it's a draw.";
    coachEl.textContent = "No legal moves, but no check. That's a draw.";
    return;
  }
  if (chess.isDraw()) {
    statusEl.textContent = "Draw.";
    coachEl.textContent = "Neither side can force a win here.";
    return;
  }

  if (thinking) {
    statusEl.textContent = "Chronael is thinking…";
  } else if (playerTurn()) {
    statusEl.textContent = `Your move — you are ${playerColor}.`;
  }

  if (inCheck && playerTurn()) {
    coachEl.textContent = "You're in check! Move your king, block the attack, or capture the attacker.";
  } else if (!thinking && playerTurn() && !feedbackActive) {
    coachEl.textContent = "Tip: " + TIPS[chess.history().length % TIPS.length];
  }
}

function updateMoves(): void {
  const history = chess.history();
  movesEl.innerHTML = "";
  for (let i = 0; i < history.length; i += 2) {
    const li = document.createElement("li");
    const white = history[i] ?? "";
    const black = history[i + 1] ?? "";
    li.textContent = `${white}   ${black}`.trim();
    movesEl.appendChild(li);
  }
  movesEl.scrollTop = movesEl.scrollHeight;
}

function isPromotion(from: Square, to: Square): boolean {
  const piece = chess.get(from);
  if (!piece || piece.type !== "p") return false;
  return to[1] === "8" || to[1] === "1";
}

function onUserMove(orig: Key, dest: Key): void {
  if (tutorial.active) {
    tutorial.handleMove(orig, dest);
    return;
  }

  const from = orig as Square;
  const to = dest as Square;
  const fenBefore = chess.fen();
  const snapshot = beforeEval && beforeEval.fen === fenBefore ? beforeEval : null;

  if (isPromotion(from, to)) {
    // Ask which piece to promote to instead of silently making a queen.
    void askPromotion(playerColor).then((piece) => applyUserMove(orig, dest, snapshot, piece));
  } else {
    applyUserMove(orig, dest, snapshot, undefined);
  }
}

function applyUserMove(
  orig: Key,
  dest: Key,
  snapshot: { fen: string; scoreCp: number; bestUci: string } | null,
  promotion: "q" | "r" | "b" | "n" | undefined,
): void {
  const fenBefore = chess.fen(); // capture before the move mutates the board
  const move = chess.move({ from: orig as Square, to: dest as Square, promotion });
  if (!move) {
    render(); // resync board if the move was somehow rejected
    return;
  }
  const movedUci = (orig as string) + (dest as string) + (promotion ?? "");
  soundForMove(move);
  lastMove = [orig, dest];
  ground.setShapes([]); // clear any hint arrow
  render();
  void afterUserMove(snapshot, movedUci, fenBefore, chess.fen());
}

async function afterUserMove(
  snapshot: { fen: string; scoreCp: number; bestUci: string } | null,
  movedUci: string,
  fenBefore: string,
  fenAfter: string,
): Promise<void> {
  await coachOnMove(snapshot, movedUci, fenBefore, fenAfter);
  if (!chess.isGameOver()) {
    await engineMove();
  }
  await prepareCoach();
}

/** Rate the player's move (Stockfish-driven) and explain it; LLM only for mistakes.
 *  All chess notation is translated to plain English before it reaches the UI. */
async function coachOnMove(
  snapshot: { fen: string; scoreCp: number; bestUci: string } | null,
  movedUci: string,
  fenBefore: string,
  fenAfter: string,
): Promise<void> {
  const seq = ++coachSeq;
  const after = await engine.analyse(fenAfter);
  if (seq !== coachSeq) return; // a take-back / new game happened meanwhile

  const playerEvalAfter = -after.scoreCp; // after.scoreCp is the opponent's view
  const scoreBefore = snapshot ? snapshot.scoreCp : playerEvalAfter;
  const cpLoss = Math.max(0, scoreBefore - playerEvalAfter);
  const rating = classify(cpLoss);

  // Plain-English descriptions (no notation) for the UI and the LLM coach.
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
    // Offer a "why?" follow-up.
    lastCoachFacts = facts;
    coachMoreEl.textContent = "Tell me more →";
    coachMoreEl.disabled = false;
    coachMoreEl.hidden = false;
  }
}

/** Pre-analyse the position it's now the player's turn in (drives the eval bar + hints). */
async function prepareCoach(): Promise<void> {
  if (!playerTurn() || tutorial.active) return;
  const fen = chess.fen();
  const { scoreCp, bestMove } = await engine.analyse(fen);
  if (chess.fen() !== fen) return; // position already changed
  beforeEval = { fen, scoreCp, bestUci: bestMove };
  updateEvalBar(whiteCp(fen, scoreCp));
}

async function engineMove(): Promise<void> {
  if (chess.isGameOver() || tutorial.active) return;
  const level = LEVELS[levelIndex];
  thinking = true;
  updateStatus(chess.isCheck());

  let move: Move | null = null;
  if (opponent === "magnus") {
    // The trained Carlsen net picks. A little temperature keeps games varied.
    const mv = await carlsen.selectMove(chess, { temperature: 0.3, topK: 5 });
    if (mv) {
      move = chess.move({
        from: mv.from as Square,
        to: mv.to as Square,
        promotion: (mv.promotion as "q" | "r" | "b" | "n") || undefined,
      });
      if (move) lastMove = [mv.from as Key, mv.to as Key];
    }
  } else {
    let uci: string;
    if (Math.random() < level.blunder) {
      // Deliberate beginner-friendly mistake: a random legal move.
      const moves = chess.moves({ verbose: true });
      const pick = moves[Math.floor(Math.random() * moves.length)];
      uci = pick.from + pick.to + (pick.promotion ?? "");
    } else {
      uci = await engine.bestMove(chess.fen(), level);
    }
    const from = uci.slice(0, 2) as Square;
    const to = uci.slice(2, 4) as Square;
    const promotion = uci.length > 4 ? (uci[4] as "q" | "r" | "b" | "n") : undefined;
    move = chess.move({ from, to, promotion });
    lastMove = [from as Key, to as Key];
  }

  soundForMove(move);
  thinking = false;
  render();
}

async function showHint(): Promise<void> {
  if (!playerTurn()) return;
  coachEl.textContent = "Thinking of a good move for you…";
  // Use a strong setting for the hint so it points at a genuinely good move.
  const uci = await engine.bestMove(chess.fen(), LEVELS[6]);
  const from = uci.slice(0, 2) as Key;
  const to = uci.slice(2, 4) as Key;
  ground.setShapes([{ orig: from, dest: to, brush: "green" }]);
  coachEl.textContent = "Hint: try the move shown by the green arrow.";
}

function takeBack(): void {
  if (chess.history().length === 0) return;
  coachSeq++; // cancel any in-flight coaching for the position we're leaving
  chess.undo();
  // Undo again so it ends on the player's turn (we just undid the engine's reply).
  if (colorToMove() !== playerColor && chess.history().length > 0) {
    chess.undo();
  }
  const hist = chess.history({ verbose: true });
  const last = hist[hist.length - 1];
  lastMove = last ? [last.from as Key, last.to as Key] : undefined;
  feedbackActive = false;
  ratingEl.textContent = "";
  ratingEl.className = "rating";
  coachMoreEl.hidden = true;
  lastCoachFacts = null;
  beforeEval = null;
  ground.setShapes([]);
  render();
  void prepareCoach();
}

function newGame(): void {
  coachSeq++;
  chess.reset();
  lastMove = undefined;
  thinking = false;
  beforeEval = null;
  feedbackActive = false;
  ratingEl.textContent = "";
  ratingEl.className = "rating";
  coachMoreEl.hidden = true;
  lastCoachFacts = null;
  updateEvalBar(0);
  ground.set({ orientation: playerColor });
  ground.setShapes([]);
  render();
  void beginTurns();
}

async function beginTurns(): Promise<void> {
  if (playerColor === "black" && !chess.isGameOver()) {
    await engineMove();
  }
  await prepareCoach();
}

function init(): void {
  const config: Config = {
    fen: chess.fen(),
    orientation: playerColor,
    turnColor: colorToMove(),
    movable: {
      free: false,
      color: playerColor,
      dests: legalDests(),
      showDests: true,
      events: { after: onUserMove },
    },
    animation: { enabled: true, duration: 200 },
    highlight: { lastMove: true, check: true },
    draggable: { enabled: true, showGhost: true },
    drawable: { enabled: true },
    coordinates: true, // built once at init; shown/hidden via the .coords-on CSS class
  };
  ground = Chessground(el<HTMLDivElement>("board"), config);

  el<HTMLSelectElement>("level").addEventListener("change", (e) => {
    levelIndex = parseInt((e.target as HTMLSelectElement).value, 10);
  });
  el<HTMLSelectElement>("side").addEventListener("change", (e) => {
    playerColor = (e.target as HTMLSelectElement).value as Color;
    newGame();
  });
  el<HTMLSelectElement>("opponent").addEventListener("change", (e) => {
    opponent = (e.target as HTMLSelectElement).value as Opponent;
    if (opponent === "magnus" && !carlsen.ready) {
      feedbackActive = true;
      coachEl.textContent = "Waking up the Magnus bot (a one-time ~24 MB download)…";
      carlsen
        .load()
        .then(() => {
          coachEl.textContent = "Magnus bot is ready. Good luck out there.";
        })
        .catch(() => {
          coachEl.textContent = "Could not load the Magnus bot, staying with the gentle engine.";
          opponent = "stockfish";
          el<HTMLSelectElement>("opponent").value = "stockfish";
        });
    }
  });
  el<HTMLButtonElement>("undo").addEventListener("click", takeBack);
  el<HTMLButtonElement>("hint").addEventListener("click", () => void showHint());
  el<HTMLButtonElement>("newgame").addEventListener("click", newGame);

  // "Learn the pieces" tutorial.
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
    () => newGame(), // on exit: return to a fresh, playable game
  );
  el<HTMLButtonElement>("learn").addEventListener("click", () => {
    coachSeq++; // cancel any in-flight coaching
    tutorial.start();
  });
  el<HTMLButtonElement>("tut-exit").addEventListener("click", () => tutorial.exit());

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

  // Board coordinate labels (off by default; toggled via a CSS class on the board).
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
      if (seq !== coachSeq) return; // position changed; drop it
      if (extra) coachEl.textContent = `${coachEl.textContent} ${extra}`;
      coachMoreEl.hidden = true;
    });
  });

  // First-run welcome screen (shown once per browser).
  const welcome = el<HTMLDivElement>("welcome");
  const seenKey = "chronael.seenWelcome";
  const dismissWelcome = () => {
    welcome.hidden = true;
    try {
      localStorage.setItem(seenKey, "1");
    } catch {
      /* private mode: just proceed */
    }
  };
  el<HTMLButtonElement>("welcome-learn").addEventListener("click", () => {
    dismissWelcome();
    coachSeq++;
    tutorial.start();
  });
  el<HTMLButtonElement>("welcome-play").addEventListener("click", dismissWelcome);

  let seen = false;
  try {
    seen = localStorage.getItem(seenKey) === "1";
  } catch {
    /* ignore */
  }
  if (!seen) {
    welcome.hidden = false;
    el<HTMLButtonElement>("welcome-learn").focus();
  }

  render();
  void beginTurns();

  // Dev-only test hook for verifying the play loop from the console.
  if (import.meta.env.DEV) {
    (window as Window & { __chronael?: unknown }).__chronael = {
      chess,
      engine,
      engineMove,
      carlsen,
      onUserMove, // drive the full coached move path
      magnusTop: async (fen: string) => {
        const tmp = new Chess(fen);
        const ranked = await carlsen.rank(tmp);
        return ranked
          .slice(0, 5)
          .map((s) => `${s.move.from}${s.move.to}${s.move.promotion ?? ""}:${s.probability.toFixed(3)}`);
      },
      loadFen: (fen: string) => {
        coachSeq++;
        chess.load(fen);
        lastMove = undefined;
        feedbackActive = false;
        beforeEval = null;
        render();
        void prepareCoach();
      },
    };
  }
}

init();
