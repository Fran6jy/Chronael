"""Export a trained Chronael policy net to ONNX so it can run in the browser
(onnxruntime-web) as a "play a legend" opponent alongside Stockfish.

Usage:
    python scripts/export_onnx.py --model models/chronael.pt --out web-app/public/models/chronael.onnx
"""

from __future__ import annotations

import argparse
import sys
from pathlib import Path

import torch

sys.path.insert(0, str(Path(__file__).resolve().parent.parent))

from chronael.encoding import NUM_PLANES, POLICY_SIZE  # noqa: E402
from chronael.model import load_checkpoint  # noqa: E402


def main() -> int:
    parser = argparse.ArgumentParser(description="Export Chronael policy net to ONNX.")
    parser.add_argument("--model", default="models/chronael.pt")
    parser.add_argument("--out", default="web-app/public/models/chronael.onnx")
    parser.add_argument("--opset", type=int, default=17)
    parser.add_argument("--no-int8", action="store_true", help="Skip int8 quantisation.")
    args = parser.parse_args()

    model, extra = load_checkpoint(args.model, map_location="cpu")
    model.eval()

    out_path = Path(args.out)
    out_path.parent.mkdir(parents=True, exist_ok=True)

    dummy = torch.zeros(1, NUM_PLANES, 8, 8, dtype=torch.float32)
    torch.onnx.export(
        model,
        dummy,
        str(out_path),
        input_names=["planes"],
        output_names=["logits"],
        dynamic_axes={"planes": {0: "batch"}, "logits": {0: "batch"}},
        opset_version=args.opset,
        dynamo=False,  # legacy exporter: cleaner static graph that quantization handles
    )

    size_mb = out_path.stat().st_size / 1e6
    print(f"Exported ONNX: {out_path}  ({size_mb:.1f} MB)")
    print(f"  input  : planes (batch, {NUM_PLANES}, 8, 8) float32")
    print(f"  output : logits (batch, {POLICY_SIZE})")
    if extra:
        print(f"  trained on: {extra.get('player', '?')}, val top-1 {extra.get('val_top1', '?')}")

    if not args.no_int8:
        # Dynamic int8 quantisation shrinks the model ~4x for a fast browser download.
        from onnxruntime.quantization import quantize_dynamic, QuantType

        int8_path = out_path.with_suffix(".int8.onnx")
        quantize_dynamic(str(out_path), str(int8_path), weight_type=QuantType.QInt8)
        int8_mb = int8_path.stat().st_size / 1e6
        print(f"Quantised ONNX: {int8_path}  ({int8_mb:.1f} MB)  <- ship this to the browser")

    print("\nNext: load with onnxruntime-web in the app and gather logits over legal moves.")
    return 0


if __name__ == "__main__":
    sys.exit(main())
