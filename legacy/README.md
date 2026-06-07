# Legacy: LLM fine-tuning approach (archived)

These files are the original Chronael approach: fine-tuning a small language model
(LFM2-350M / TinyLlama) to emit a UCI move from a FEN string in the prompt.

It was archived in favour of the move-prediction policy network in `chronael/`
because:

- A 350M LLM playing FEN -> UCI is weak and frequently produces **illegal** moves
  (the old API server fell back to a *random* legal move ~1 move in 17), which does
  not feel like playing a strong human.
- Style was never actually conditioned at inference - the server prompted
  "You are a world-class chess player", so the Carlsen signal was dropped.
- There was no principled measure of "plays like Magnus".

The new approach trains directly on the moves Carlsen actually played, never
produces an illegal move (legal-move masking), and is evaluated by **move-match
accuracy** on held-out games - the metric used by the Maia Chess papers.

Kept here for reference and history.
