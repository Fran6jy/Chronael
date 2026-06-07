"""Chronael: a chess AI that learns to play like a specific human (Magnus Carlsen).

The approach is imitation learning / move prediction: a policy network is trained
to predict the move the target player actually made in a given position. Human-
likeness is measured by *move-match accuracy* on held-out games (the metric used
by the Maia Chess papers, McIlroy-Young et al., KDD 2020/2022).

Unlike a language model fine-tuned on FEN strings, this model:
  * never produces an illegal move (illegal logits are masked at inference), and
  * is tiny and fast (a small residual CNN, exportable to ONNX for the browser).
"""

__version__ = "0.2.0"
