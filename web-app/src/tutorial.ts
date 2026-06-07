// "Learn the pieces" — a gentle, interactive tour for someone who has never
// played. Each lesson shows one piece on a calm board with its legal-move dots and
// a short, friendly explanation. The learner moves the piece and sees it is legal.

import type { Api } from "chessground/api";
import type { Key } from "chessground/types";
import { Chess, type Square } from "chess.js";

import { playMove, playCapture } from "./sound";

interface Lesson {
  name: string;
  fen: string;
  from: Square;
  blurb: string;
}

// Each FEN has only the demonstrated piece plus the two kings (placed far apart),
// so chess.js accepts the position and the piece's real legal moves can be shown.
const LESSONS: Lesson[] = [
  {
    name: "The Pawn",
    fen: "7k/8/8/8/8/3p4/4P3/K7 w - - 0 1",
    from: "e2",
    blurb:
      "Pawns march straight forward — one square at a time, or two on their very first move. They can never move backward. They capture differently: one square diagonally forward. Try capturing the dark pawn ahead.",
  },
  {
    name: "The Knight",
    fen: "7k/8/8/8/3N4/8/8/K7 w - - 0 1",
    from: "d4",
    blurb:
      "The knight moves in an L-shape: two squares one way, then one square across. It is the only piece that can jump over others. Notice the eight squares it can reach.",
  },
  {
    name: "The Bishop",
    fen: "7k/8/8/8/3B4/8/8/K7 w - - 0 1",
    from: "d4",
    blurb:
      "Bishops glide diagonally as far as the path is clear. Each bishop stays on one colour of square for the whole game.",
  },
  {
    name: "The Rook",
    fen: "7k/8/8/8/3R4/8/8/K7 w - - 0 1",
    from: "d4",
    blurb:
      "Rooks slide in straight lines — along rows and columns — as far as they like. They are especially strong on open files.",
  },
  {
    name: "The Queen",
    fen: "7k/8/8/8/3Q4/8/8/K7 w - - 0 1",
    from: "d4",
    blurb:
      "The queen is the most powerful piece. She combines the rook and bishop: any number of squares in a straight line OR diagonally.",
  },
  {
    name: "The King",
    fen: "7k/8/8/8/3K4/8/8/8 w - - 0 1",
    from: "d4",
    blurb:
      "The king moves just one square in any direction. He is the most important piece — if he is trapped and cannot escape capture, the game is over. Keep him safe!",
  },
];

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

export class PieceTutorial {
  active = false;
  private idx = 0;
  private chess = new Chess();
  private square: Square = "d4";

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
    this.onExit();
  }

  private go(delta: number): void {
    const next = this.idx + delta;
    if (next < 0) return;
    if (next >= LESSONS.length) {
      this.exit();
      return;
    }
    this.goto(next);
  }

  private goto(i: number): void {
    this.idx = i;
    const lesson = LESSONS[i];
    this.chess.load(lesson.fen);
    this.square = lesson.from;
    this.renderBoard();

    this.dom.progress.textContent = `Piece ${i + 1} of ${LESSONS.length}`;
    this.dom.title.textContent = lesson.name;
    this.dom.text.textContent = lesson.blurb;
    this.dom.hint.textContent = "Try moving the highlighted piece to one of the dots.";
    this.dom.prevBtn.disabled = i === 0;
    this.dom.nextBtn.textContent = i === LESSONS.length - 1 ? "Finish — play a game" : "Next piece";
  }

  private dests(): Map<Key, Key[]> {
    const tos = this.chess
      .moves({ square: this.square, verbose: true })
      .map((m) => m.to as Key);
    return new Map<Key, Key[]>(tos.length ? [[this.square as Key, tos]] : []);
  }

  private renderBoard(): void {
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

  /** Called by the host when the learner moves a piece while the tutorial is active. */
  handleMove(orig: Key, dest: Key): void {
    const moved = this.chess.move({ from: orig as Square, to: dest as Square, promotion: "q" });
    if (!moved) {
      this.renderBoard();
      return;
    }
    if (moved.captured) playCapture();
    else playMove();
    this.dom.hint.textContent = `Nice — that's a legal ${LESSONS[this.idx].name.replace("The ", "")} move! Press “Next piece”, or watch it reset and try again.`;
    // Gently reset so they can keep exploring this piece.
    window.setTimeout(() => {
      if (this.active) this.goto(this.idx);
    }, 1100);
  }
}
