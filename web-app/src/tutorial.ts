// "Learn the pieces": for each piece, first LEARN (the piece's legal-move dots are shown
// and the learner tries a move), then TEST YOURSELF (no dots, reach a target square in a few moves).
// In the test any move can be attempted; an illegal one snaps back with a plain-English
// reason, so the learner has to actually know how the piece moves.

import type { Api } from "chessground/api";
import type { Key } from "chessground/types";
import { Chess, type Square } from "chess.js";

import { playMove, playCapture } from "./sound";
import { markTested } from "./mastery";
import { explainIllegal } from "./rules";

interface Test {
  fen: string;
  from: Square;
  target: Square;
  maxMoves: number;
  prompt: string;
}

interface Lesson {
  name: string;
  piece: string; // plain name, e.g. "knight"
  fen: string;
  from: Square;
  blurb: string;
  rule: string; // shown when a test move is illegal
  test: Test;
}

// Each FEN has the lesson piece plus the two kings far apart, so chess.js accepts it.
const LESSONS: Lesson[] = [
  {
    name: "The Pawn",
    piece: "pawn",
    fen: "7k/8/8/8/8/3p4/4P3/K7 w - - 0 1",
    from: "e2",
    blurb:
      "Pawns march straight forward — one square at a time, or two on their very first move. They can never move backward. They capture differently: one square diagonally forward. Try capturing the dark pawn ahead.",
    rule: "Pawns only move straight forward, and they can't move into a piece. They capture one square diagonally forward.",
    test: {
      fen: "7k/8/8/3pp3/4P3/8/8/K7 w - - 0 1",
      from: "e4",
      target: "d5",
      maxMoves: 1,
      prompt: "Your pawn is blocked. Capture the pawn in the green circle.",
    },
  },
  {
    name: "The Knight",
    piece: "knight",
    fen: "7k/8/8/8/3N4/8/8/K7 w - - 0 1",
    from: "d4",
    blurb:
      "The knight moves in an L-shape: two squares one way, then one square across. It is the only piece that can jump over others. Notice the eight squares it can reach.",
    rule: "A knight moves in an L: two squares in one direction, then one square to the side.",
    test: {
      fen: "7k/8/8/8/3N4/8/8/K7 w - - 0 1",
      from: "d4",
      target: "d6",
      maxMoves: 2,
      prompt: "Get the knight to the green circle in 2 moves.",
    },
  },
  {
    name: "The Bishop",
    piece: "bishop",
    fen: "7k/8/8/8/3B4/8/8/K7 w - - 0 1",
    from: "d4",
    blurb:
      "Bishops glide diagonally as far as the path is clear. Each bishop stays on one colour of square for the whole game.",
    rule: "Bishops only move diagonally, so they always stay on the same colour of square.",
    test: {
      fen: "7k/8/8/8/3B4/8/8/K7 w - - 0 1",
      from: "d4",
      target: "h4",
      maxMoves: 2,
      prompt: "Get the bishop to the green circle in 2 moves.",
    },
  },
  {
    name: "The Rook",
    piece: "rook",
    fen: "7k/8/8/8/3R4/8/8/K7 w - - 0 1",
    from: "d4",
    blurb:
      "Rooks slide in straight lines — along rows and columns — as far as they like. They are especially strong on open files.",
    rule: "Rooks move in straight lines only: along a row or up and down a column.",
    test: {
      fen: "7k/8/8/8/3R4/8/8/K7 w - - 0 1",
      from: "d4",
      target: "a8",
      maxMoves: 2,
      prompt: "Get the rook to the green circle in the corner in 2 moves.",
    },
  },
  {
    name: "The Queen",
    piece: "queen",
    fen: "7k/8/8/8/3Q4/8/8/K7 w - - 0 1",
    from: "d4",
    blurb:
      "The queen is the most powerful piece. She combines the rook and bishop: any number of squares in a straight line OR diagonally.",
    rule: "The queen moves in a straight line or a diagonal — but only one direction per move.",
    test: {
      fen: "7k/8/8/8/3Q4/8/8/K7 w - - 0 1",
      from: "d4",
      target: "c8",
      maxMoves: 2,
      prompt: "Get the queen to the green circle in 2 moves.",
    },
  },
  {
    name: "The King",
    piece: "king",
    fen: "7k/8/8/8/3K4/8/8/8 w - - 0 1",
    from: "d4",
    blurb:
      "The king moves just one square in any direction. He is the most important piece — if he is trapped and cannot escape capture, the game is over. Keep him safe!",
    rule: "The king moves one square at a time, in any direction — and never onto a square that's attacked.",
    test: {
      fen: "7k/8/8/8/3K4/8/8/8 w - - 0 1",
      from: "d4",
      target: "f6",
      maxMoves: 2,
      prompt: "Walk the king to the green circle in 2 moves.",
    },
  },
];

/** Exported for tests. */
export const PIECE_LESSONS = LESSONS;

export interface TutorialDom {
  playPanel: HTMLElement;
  tutorialPanel: HTMLElement;
  progress: HTMLElement;
  title: HTMLElement;
  text: HTMLElement;
  hint: HTMLElement;
  prevBtn: HTMLButtonElement;
  nextBtn: HTMLButtonElement;
}

type Phase = "learn" | "test" | "passed";

export class PieceTutorial {
  active = false;
  private idx = 0;
  private phase: Phase = "learn";
  private chess = new Chess();
  private square: Square = "d4";
  private testMoves = 0;
  private busy = false;
  private passed = new Set<number>();

  constructor(
    private ground: Api,
    private dom: TutorialDom,
    private onExit: () => void,
  ) {
    this.dom.prevBtn.addEventListener("click", () => this.go(-1));
    this.dom.nextBtn.addEventListener("click", () => this.go(1));
  }

  start(): void {
    this.active = true;
    this.dom.playPanel.hidden = true;
    this.dom.tutorialPanel.hidden = false;
    this.goto(0);
  }

  exit(): void {
    this.active = false;
    this.dom.tutorialPanel.hidden = true;
    this.dom.playPanel.hidden = false;
    this.ground.set({ movable: { free: false } });
    this.onExit();
  }

  private go(delta: number): void {
    const next = this.idx + delta;
    if (next < 0) return;
    if (next >= LESSONS.length) {
      try {
        localStorage.setItem("chronael.piecesDone", "1"); // ticks the first node of the lesson path
      } catch {
        /* ignore */
      }
      this.exit();
      return;
    }
    this.goto(next);
  }

  private goto(i: number): void {
    this.idx = i;
    const lesson = LESSONS[i];
    this.dom.title.textContent = lesson.name;
    this.dom.text.textContent = lesson.blurb;
    this.dom.prevBtn.disabled = i === 0;
    this.dom.nextBtn.textContent = i === LESSONS.length - 1 ? "Finish — play a game" : "Next piece";
    this.startLearn();
  }

  private label(extra: string): void {
    this.dom.progress.textContent = `Piece ${this.idx + 1} of ${LESSONS.length} · ${extra}`;
  }

  // ---------- Phase 1: learn, with dots ----------

  private startLearn(): void {
    const lesson = LESSONS[this.idx];
    this.phase = "learn";
    this.busy = false;
    this.chess.load(lesson.fen);
    this.square = lesson.from;
    this.label("Learn");
    this.dom.hint.textContent = "Move the highlighted piece to one of the dots.";
    this.ground.set({
      fen: this.chess.fen(),
      orientation: "white",
      turnColor: "white",
      lastMove: undefined,
      check: false,
      movable: { free: false, color: "white", dests: this.dests(), showDests: true },
      drawable: { enabled: false },
    });
    this.ground.setShapes([]);
    this.ground.selectSquare(this.square); // show the piece's move dots immediately
  }

  private dests(): Map<Key, Key[]> {
    const tos = this.chess.moves({ square: this.square, verbose: true }).map((m) => m.to as Key);
    return new Map<Key, Key[]>(tos.length ? [[this.square as Key, tos]] : []);
  }

  // ---------- Phase 2: test, no dots ----------

  private startTest(): void {
    const lesson = LESSONS[this.idx];
    this.phase = "test";
    this.busy = false;
    this.testMoves = 0;
    this.chess.load(lesson.test.fen);
    this.square = lesson.test.from;
    this.label(`Test yourself (${lesson.test.maxMoves === 1 ? "1 move" : `${lesson.test.maxMoves} moves`})`);
    this.dom.hint.textContent = `${lesson.test.prompt} No dots this time.`;
    this.renderTest();
  }

  private renderTest(): void {
    const t = LESSONS[this.idx].test;
    this.ground.set({
      fen: this.chess.fen(),
      orientation: "white",
      turnColor: "white",
      lastMove: undefined,
      check: false,
      selected: undefined,
      // Free movement: any drop is allowed, then checked here, so wrong ideas get explained.
      movable: { free: true, color: "white", dests: new Map(), showDests: false },
      drawable: { enabled: false, visible: true },
    });
    this.ground.setShapes([{ orig: t.target as Key, brush: "green" }]);
  }

  /** White to move again (the opponent never moves in these drills). */
  private whiteToMove(): void {
    const parts = this.chess.fen().split(" ");
    parts[1] = "w";
    parts[3] = "-";
    this.chess.load(parts.join(" "));
  }

  /** Called by the host when the learner moves a piece while the tutorial is active. */
  handleMove(orig: Key, dest: Key): void {
    if (this.busy) return;
    const lesson = LESSONS[this.idx];

    if (this.phase === "passed") {
      this.renderTest();
      return;
    }

    if (this.phase === "learn") {
      const moved = this.chess.move({ from: orig as Square, to: dest as Square, promotion: "q" });
      if (!moved) {
        this.startLearn();
        return;
      }
      if (moved.captured) playCapture();
      else playMove();
      this.busy = true;
      this.dom.hint.textContent = `Nice — that's how the ${lesson.piece} moves. Now test yourself…`;
      window.setTimeout(() => {
        if (this.active && this.phase === "learn") this.startTest();
      }, 1300);
      return;
    }

    // Test phase.
    if (orig !== this.square) {
      this.dom.hint.textContent = `Move the ${lesson.piece} — that's the piece we're practising.`;
      this.renderTest();
      return;
    }
    let moved = null;
    try {
      moved = this.chess.move({ from: orig as Square, to: dest as Square, promotion: "q" });
    } catch {
      moved = null;
    }
    if (!moved) {
      this.dom.hint.textContent = explainIllegal(this.chess.fen(), orig, dest) ?? `Not quite. ${lesson.rule}`;
      this.renderTest();
      return;
    }
    if (moved.captured) playCapture();
    else playMove();
    this.testMoves++;
    this.square = moved.to as Square;
    if (this.square === lesson.test.target) {
      this.phase = "passed";
      this.passed.add(this.idx);
      markTested(lesson.piece === "knight" ? "n" : lesson.piece[0]); // its move dots switch off in games
      this.label("Test passed ✓");
      this.dom.hint.textContent =
        this.idx === LESSONS.length - 1
          ? "You know how every piece moves. Time to play a real game!"
          : `You've got the ${lesson.piece}. On to the next piece!`;
      this.ground.set({ fen: this.chess.fen(), lastMove: [orig, dest], movable: { free: false, color: undefined, dests: new Map() } });
      this.ground.setShapes([]);
      return;
    }
    if (this.testMoves >= lesson.test.maxMoves) {
      this.busy = true;
      this.dom.hint.textContent = `That was a legal move, but you're out of moves. The circle can be reached in ${lesson.test.maxMoves}. Try again!`;
      this.ground.set({ fen: this.chess.fen(), lastMove: [orig, dest] });
      window.setTimeout(() => {
        if (this.active && this.phase === "test") this.startTest();
      }, 1600);
      return;
    }
    this.whiteToMove();
    this.dom.hint.textContent = `Good, legal move. ${lesson.test.maxMoves - this.testMoves} more to reach the circle.`;
    this.renderTest();
    this.ground.set({ lastMove: [orig, dest] });
  }
}
