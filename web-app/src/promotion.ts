// Accessible promotion picker. Replaces the old silent auto-queen so a learner
// understands a pawn can become any piece. Shows the SAME piece art as the board
// (Chessground's cburnett sprites) so the choice matches what they're looking at.

export type PromotionPiece = "q" | "r" | "b" | "n";
type Color = "white" | "black";

const CHOICES: { code: PromotionPiece; piece: string; name: string }[] = [
  { code: "q", piece: "queen", name: "Queen" },
  { code: "r", piece: "rook", name: "Rook" },
  { code: "b", piece: "bishop", name: "Bishop" },
  { code: "n", piece: "knight", name: "Knight" },
];

export function askPromotion(color: Color): Promise<PromotionPiece> {
  const overlay = document.getElementById("promotion") as HTMLDivElement;
  const choices = document.getElementById("promotion-choices") as HTMLDivElement;

  return new Promise((resolve) => {
    choices.innerHTML = "";

    const close = (code: PromotionPiece) => {
      overlay.hidden = true;
      document.removeEventListener("keydown", onKey);
      resolve(code);
    };
    const onKey = (e: KeyboardEvent) => {
      const hit = CHOICES.find((c) => c.name[0].toLowerCase() === e.key.toLowerCase());
      if (hit) close(hit.code);
    };

    for (const c of CHOICES) {
      const btn = document.createElement("button");
      btn.type = "button";
      btn.className = "promo-choice";
      btn.setAttribute("aria-label", `Promote to ${c.name}`);
      // .cg-wrap so the board's piece-sprite CSS (".cg-wrap piece.queen.white") applies.
      btn.innerHTML =
        `<span class="cg-wrap promo-piece"><piece class="${c.piece} ${color}"></piece></span>` +
        `<span class="promo-name">${c.name}</span>`;
      btn.addEventListener("click", () => close(c.code));
      choices.appendChild(btn);
    }

    overlay.hidden = false;
    document.addEventListener("keydown", onKey);
    (choices.firstElementChild as HTMLButtonElement | null)?.focus();
  });
}
