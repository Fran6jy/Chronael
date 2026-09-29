// The home page hero shows the product instead of describing it: a small board plays a
// short scripted game while the coach explains each move in a speech bubble, including
// a mistake with the better idea. It's view-only, pauses when the home page is hidden,
// and with reduced motion it shows a single still frame.

import { Chessground } from "chessground";
import type { Api } from "chessground/api";
import type { Key } from "chessground/types";
import { Chess } from "chess.js";

interface Frame {
  history: string[]; // SAN moves before this frame
  move: string; // SAN of the move shown
  rating: "great" | "good" | "mistake";
  label: string;
  text: string;
  better?: string; // SAN of the better move, drawn as a green arrow
}

const FRAMES: Frame[] = [
  {
    history: [],
    move: "e4",
    rating: "great",
    label: "Great move",
    text: "Your pawn takes the centre and opens a path for your queen and bishop.",
  },
  {
    history: ["e4", "e5"],
    move: "Nf3",
    rating: "good",
    label: "Good move",
    text: "The knight comes out and attacks the pawn in the middle. Pieces first, queen later.",
  },
  {
    history: ["e4", "e5", "Nf3", "Nc6"],
    move: "Nxe5",
    rating: "mistake",
    label: "Mistake",
    text: "Careful: the other knight can take yours for free. Bringing out your bishop keeps everything safe.",
    better: "Bc4",
  },
  {
    history: ["e4", "e5", "Nf3", "Nc6"],
    move: "Bc4",
    rating: "great",
    label: "Much better",
    text: "Now the bishop aims at the weak pawn next to Black's king, and nothing is left hanging.",
  },
];

const HOLD_MS = 4200;

function uciOf(history: string[], san: string): { from: Key; to: Key; after: string; before: string } {
  const c = new Chess();
  for (const m of history) c.move(m);
  const before = c.fen();
  const mv = c.move(san);
  return { from: mv.from as Key, to: mv.to as Key, after: c.fen(), before };
}

export function startHeroDemo(): void {
  const boardEl = document.getElementById("hero-board");
  const bubble = document.getElementById("demo-bubble");
  const ratingEl = document.getElementById("demo-rating");
  const textEl = document.getElementById("demo-text");
  const dots = document.getElementById("demo-dots");
  if (!boardEl || !bubble || !ratingEl || !textEl || !dots) return;

  const reduced = window.matchMedia("(prefers-reduced-motion: reduce)").matches;
  const ground: Api = Chessground(boardEl, {
    viewOnly: true,
    coordinates: false,
    animation: { enabled: !reduced, duration: 450 },
    highlight: { lastMove: true, check: true },
    drawable: { enabled: false, visible: true },
  });

  dots.innerHTML = FRAMES.map((_, i) => `<button type="button" aria-label="Example ${i + 1}" data-i="${i}"></button>`).join("");

  let idx = 0;
  let timer: number | undefined;

  const show = (i: number, animate: boolean) => {
    idx = i;
    const f = FRAMES[i];
    const m = uciOf(f.history, f.move);
    ground.setShapes([]);
    ground.set({ fen: m.before, lastMove: undefined });
    bubble.classList.remove("in");
    dots.querySelectorAll("button").forEach((b, j) => b.classList.toggle("on", j === i));
    const reveal = () => {
      if (f.better) {
        // A mistake: keep the position before it, red arrow = played, green = better.
        const b = uciOf(f.history, f.better);
        ground.setShapes([
          { orig: m.from, dest: m.to, brush: "red" },
          { orig: b.from, dest: b.to, brush: "green" },
        ]);
      } else {
        ground.set({ fen: m.after, lastMove: [m.from, m.to] });
      }
      ratingEl.textContent = f.label;
      ratingEl.className = `demo-rating ${f.rating}`;
      textEl.textContent = f.text;
      bubble.classList.add("in");
    };
    if (animate) window.setTimeout(reveal, 650);
    else reveal();
  };

  const schedule = () => {
    window.clearTimeout(timer);
    if (reduced) return;
    timer = window.setTimeout(() => {
      const home = document.getElementById("home");
      if (home && !home.hidden && document.visibilityState === "visible") show((idx + 1) % FRAMES.length, true);
      schedule();
    }, HOLD_MS);
  };

  dots.addEventListener("click", (e) => {
    const i = Number((e.target as HTMLElement).dataset.i);
    if (Number.isFinite(i)) {
      show(i, !reduced);
      schedule();
    }
  });

  show(reduced ? 2 : 0, !reduced); // reduced motion: the most instructive frame, still
  schedule();
}

/** Fade sections in as they scroll into view (skipped entirely with reduced motion). */
export function revealOnScroll(): void {
  const els = document.querySelectorAll<HTMLElement>(".reveal");
  if (window.matchMedia("(prefers-reduced-motion: reduce)").matches || !("IntersectionObserver" in window)) {
    els.forEach((e) => e.classList.add("in"));
    return;
  }
  const io = new IntersectionObserver(
    (entries) => {
      for (const en of entries) {
        if (en.isIntersecting) {
          (en.target as HTMLElement).classList.add("in");
          io.unobserve(en.target);
        }
      }
    },
    { rootMargin: "0px 0px -8% 0px", threshold: 0.08 },
  );
  els.forEach((e) => io.observe(e));
}

