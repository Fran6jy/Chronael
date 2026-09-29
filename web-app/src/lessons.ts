// The lesson path that follows "Learn the pieces": short units, each a few hands-on
// drills. A drill is a position, a goal, and the line to play (the opponent's replies
// are scripted). `accept` lists every first move we count as right when there is more
// than one good answer (e.g. opening principles). Any checkmating move is always right.
// Every drill is checked for legality (and mates) by tests/unit/lessons.test.ts.

export interface Drill {
  id: string;
  title: string;
  goal: string;
  fen: string;
  solution: string[]; // uci; solver moves on even indexes, scripted replies on odd
  accept?: string[]; // alternative correct FIRST moves (single-move drills only)
  teach: string; // shown before: the idea in plain English
  why: string; // shown after solving
}

export interface Unit {
  id: string;
  title: string;
  blurb: string;
  drills: Drill[];
}

export const UNITS: Unit[] = [
  {
    id: "mate",
    title: "Checkmate patterns",
    blurb: "The handful of mating shapes that decide most beginner games.",
    drills: [
      {
        id: "mate-backrank",
        title: "Back-rank mate",
        goal: "Checkmate in one",
        fen: "6k1/5ppp/8/8/8/8/5PPP/R5K1 w - - 0 1",
        solution: ["a1a8"],
        teach: "Black's king is boxed in by its own pawns. A rook on the back row gives check, and there is nowhere to run.",
        why: "The pawns that protect the king also trap it. Leave your own king an escape square (move a pawn in front of it) so this never happens to you.",
      },
      {
        id: "mate-queen",
        title: "Queen and king",
        goal: "Checkmate in one",
        fen: "7k/8/6K1/8/8/8/8/1Q6 w - - 0 1",
        solution: ["b1b8"],
        teach: "Your king guards the squares next to the enemy king. Your queen just has to give check along the edge.",
        why: "King and queen together always win: push the enemy king to the edge, bring your king close, then check on the edge.",
      },
      {
        id: "mate-rook",
        title: "Rook on the edge",
        goal: "Checkmate in one",
        fen: "k7/8/1K6/8/8/8/8/7R w - - 0 1",
        solution: ["h1h8"],
        teach: "Your king covers the escape squares. The rook delivers check from far away along the top row.",
        why: "A rook alone can't mate, but with the king's help it mates on the edge of the board.",
      },
      {
        id: "mate-ladder",
        title: "The ladder",
        goal: "Checkmate in two",
        fen: "4k3/8/8/8/8/8/R7/1R4K1 w - - 0 1",
        solution: ["a2a7", "e8d8", "b1b8"],
        teach: "Two rooks work like a ladder: one cuts off a row, the other checks on the next row.",
        why: "One rook fences the king in; the other gives check on the edge. No help from your king needed.",
      },
      {
        id: "mate-scholar",
        title: "The four-move trap",
        goal: "Checkmate in one",
        fen: "r1bqkbnr/pppp1ppp/2n5/4p3/2B1P3/5Q2/PPPP1PPP/RNB1K1NR w KQkq - 4 4",
        solution: ["f3f7"],
        teach: "The pawn next to Black's king is only guarded by the king. Your queen and bishop both aim at it.",
        why: "The king can't take the queen because the bishop protects her. When you play Black, guard that weak pawn early!",
      },
    ],
  },
  {
    id: "tactics",
    title: "Win material",
    blurb: "Forks, pins and skewers: how to win pieces from your opponent.",
    drills: [
      {
        id: "tac-free",
        title: "Take what's free",
        goal: "Win a piece",
        fen: "4k3/8/8/3b4/8/8/8/3RK3 w - - 0 1",
        solution: ["d1d5"],
        teach: "Before anything fancy, look for pieces nobody is guarding.",
        why: "Nothing defended the bishop, so it was simply free. Always ask: what is undefended?",
      },
      {
        id: "tac-fork",
        title: "Knight fork",
        goal: "Attack two things at once",
        fen: "4k3/3q4/8/8/4N3/8/PP6/4K3 w - - 0 1",
        solution: ["e4f6", "e8f8", "f6d7"],
        teach: "A knight can attack two pieces at once. Find a check that also hits the queen.",
        why: "The king had to move out of check, so the queen was lost. Checks that attack something else are the strongest forks.",
      },
      {
        id: "tac-skewer",
        title: "Skewer",
        goal: "Win the queen",
        fen: "4q3/8/8/4k3/8/8/8/R6K w - - 0 1",
        solution: ["a1e1", "e5d5", "e1e8"],
        teach: "Line up your rook with the king AND the queen behind it.",
        why: "The king had to step aside and the queen behind it fell. A skewer is a pin in reverse: the valuable piece is in front.",
      },
      {
        id: "tac-pin",
        title: "Attack the pinned piece",
        goal: "Win the knight",
        fen: "4k3/8/8/4n3/8/3P4/8/4R1K1 w - - 0 1",
        solution: ["d3d4", "e8d7", "d4e5"],
        teach: "The knight can't move: your rook would give check to the king behind it. Attack it with something small.",
        why: "A pinned piece is frozen, so hitting it with a pawn wins it. Pile up on pinned pieces!",
      },
    ],
  },
  {
    id: "opening",
    title: "Opening principles",
    blurb: "No memorising: three simple rules for the first moves.",
    drills: [
      {
        id: "open-centre",
        title: "Take the centre",
        goal: "Play a strong first move",
        fen: "rnbqkbnr/pppppppp/8/8/8/8/PPPPPPPP/RNBQKBNR w KQkq - 0 1",
        solution: ["e2e4"],
        accept: ["e2e4", "d2d4", "c2c4", "g1f3"],
        teach: "The four middle squares are the most important. Put a pawn or piece where it controls them.",
        why: "Central pawns give your bishops and queen room to come out and take space from your opponent.",
      },
      {
        id: "open-develop",
        title: "Bring out a piece",
        goal: "Develop a knight or bishop",
        fen: "rnbqkbnr/pppp1ppp/8/4p3/4P3/8/PPPP1PPP/RNBQKBNR w KQkq - 0 2",
        solution: ["g1f3"],
        accept: ["g1f3", "b1c3", "f1c4", "f1b5"],
        teach: "Knights and bishops do nothing at home. Get them out before moving the queen or the same piece twice.",
        why: "Every developed piece joins the fight. Knights before bishops is a good habit, and it attacks Black's centre pawn.",
      },
      {
        id: "open-castle",
        title: "Castle early",
        goal: "Make your king safe",
        fen: "r1bqk2r/pppp1ppp/2n2n2/2b1p3/2B1P3/5N2/PPPP1PPP/RNBQK2R w KQkq - 4 4",
        solution: ["e1g1"],
        teach: "Your king is safest tucked in the corner behind pawns, and castling also brings a rook into the game.",
        why: "Castling does two jobs in one move: king safety and rook activity. Try to castle within the first ten moves.",
      },
    ],
  },
  {
    id: "endgame",
    title: "Endgames",
    blurb: "Finish the job: turning a small advantage into a win.",
    drills: [
      {
        id: "end-promote",
        title: "Make a queen",
        goal: "Promote the pawn",
        fen: "8/4P3/8/8/8/8/k7/4K3 w - - 0 1",
        solution: ["e7e8q"],
        teach: "A pawn that reaches the far side becomes any piece you like. A queen is almost always best.",
        why: "Passed pawns are gold in endgames. Push them, and promote to a queen.",
      },
      {
        id: "end-opposition",
        title: "Lead with the king",
        goal: "Help your pawn through",
        fen: "4k3/8/4K3/4P3/8/8/8/8 w - - 0 1",
        solution: ["e6d6"],
        accept: ["e6d6", "e6f6"],
        teach: "In pawn endgames the king walks in front of its pawn, shoulder to shoulder with the enemy king.",
        why: "With your king beside the path, the pawn can march safely. Pushing the pawn first often lets the defender hold a draw.",
      },
      {
        id: "end-qmate",
        title: "Finish with the queen",
        goal: "Checkmate in one",
        fen: "6k1/8/6K1/8/8/8/8/4Q3 w - - 0 1",
        solution: ["e1e8"],
        teach: "The enemy king is on the edge and yours is close. Check along the edge.",
        why: "Queen plus king against a lone king is always a win once the king reaches the edge.",
      },
    ],
  },
];

export function allDrills(): Drill[] {
  return UNITS.flatMap((u) => u.drills);
}

export function findDrill(id: string): { unit: Unit; drill: Drill; index: number } | null {
  for (const unit of UNITS) {
    const index = unit.drills.findIndex((d) => d.id === id);
    if (index >= 0) return { unit, drill: unit.drills[index], index };
  }
  return null;
}
