"""A small residual CNN policy network (AlphaZero-style, policy head only).

It is deliberately tiny so it trains on a CPU for smoke tests and exports cleanly to
ONNX for in-browser play. Scale ``channels`` / ``num_blocks`` up for GPU training.
"""

from __future__ import annotations

from dataclasses import asdict, dataclass

import torch
import torch.nn as nn

from .encoding import NUM_PLANES, POLICY_SIZE


@dataclass
class ModelConfig:
    channels: int = 64
    num_blocks: int = 5
    policy_head_channels: int = 16
    num_planes: int = NUM_PLANES
    policy_size: int = POLICY_SIZE


class ResidualBlock(nn.Module):
    def __init__(self, channels: int):
        super().__init__()
        self.conv1 = nn.Conv2d(channels, channels, 3, padding=1, bias=False)
        self.bn1 = nn.BatchNorm2d(channels)
        self.conv2 = nn.Conv2d(channels, channels, 3, padding=1, bias=False)
        self.bn2 = nn.BatchNorm2d(channels)
        self.relu = nn.ReLU(inplace=True)

    def forward(self, x: torch.Tensor) -> torch.Tensor:
        residual = x
        x = self.relu(self.bn1(self.conv1(x)))
        x = self.bn2(self.conv2(x))
        return self.relu(x + residual)


class ChronaelNet(nn.Module):
    """Board planes -> logits over the full move-index space."""

    def __init__(self, config: ModelConfig | None = None):
        super().__init__()
        self.config = config or ModelConfig()
        c = self.config

        self.stem = nn.Sequential(
            nn.Conv2d(c.num_planes, c.channels, 3, padding=1, bias=False),
            nn.BatchNorm2d(c.channels),
            nn.ReLU(inplace=True),
        )
        self.blocks = nn.Sequential(*[ResidualBlock(c.channels) for _ in range(c.num_blocks)])
        self.policy_conv = nn.Sequential(
            nn.Conv2d(c.channels, c.policy_head_channels, 1, bias=False),
            nn.BatchNorm2d(c.policy_head_channels),
            nn.ReLU(inplace=True),
        )
        self.policy_fc = nn.Linear(c.policy_head_channels * 8 * 8, c.policy_size)

    def forward(self, x: torch.Tensor) -> torch.Tensor:
        x = self.stem(x)
        x = self.blocks(x)
        x = self.policy_conv(x)
        x = torch.flatten(x, start_dim=1)
        return self.policy_fc(x)

    def num_parameters(self) -> int:
        return sum(p.numel() for p in self.parameters())


def save_checkpoint(path: str, model: ChronaelNet, extra: dict | None = None) -> None:
    torch.save(
        {
            "model_config": asdict(model.config),
            "state_dict": model.state_dict(),
            "extra": extra or {},
        },
        path,
    )


def load_checkpoint(path: str, map_location: str = "cpu") -> tuple[ChronaelNet, dict]:
    ckpt = torch.load(path, map_location=map_location, weights_only=False)
    model = ChronaelNet(ModelConfig(**ckpt["model_config"]))
    model.load_state_dict(ckpt["state_dict"])
    model.eval()
    return model, ckpt.get("extra", {})
