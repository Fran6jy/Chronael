# 🎮 Chess AI Training Pipeline - Enhanced Edition

An advanced machine learning pipeline for training chess-playing AI models by fine-tuning small language models on grandmaster games. This is an enhanced version with multi-player support, better data processing, and modern deployment options.

[![Python 3.11+](https://img.shields.io/badge/python-3.11+-blue.svg)](https://www.python.org/downloads/)
[![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg)](https://opensource.org/licenses/MIT)
[![Code style: black](https://img.shields.io/badge/code%20style-black-000000.svg)](https://github.com/psf/black)

## 🌟 Key Features

### Improvements Over Original
- ✅ **Multi-Player Training**: Learn from multiple grandmaster styles (Carlsen, Kasparov, Fischer, Tal, Petrosian)
- ✅ **Data Augmentation**: Horizontal mirroring doubles training data
- ✅ **Enhanced Evaluation**: Comprehensive metrics and game playing capability
- ✅ **Serverless Training**: Modal integration for easy GPU access
- ✅ **Web Deployment**: ONNX export for browser-based inference
- ✅ **Better Organization**: Modular code structure and comprehensive documentation

### Training Pipeline
1. **Data Collection**: Download PGN files from top players
2. **Data Processing**: Extract positions, moves, and game states
3. **Augmentation**: Mirror positions to increase diversity
4. **Fine-tuning**: LoRA-based efficient training
5. **Evaluation**: Multi-metric testing and game playing
6. **Deployment**: Export to ONNX or mobile bundles

## 📊 Architecture

```
┌─────────────────────────────────────────────────────────┐
│                   Chess AI Pipeline                      │
├─────────────────────────────────────────────────────────┤
│                                                           │
│  📥 Data Collection                                       │
│  │   ├── Download PGN files (Magnus, Kasparov, etc.)    │
│  │   └── Filter by ELO rating (2700+)                   │
│  │                                                        │
│  ⚙️  Data Processing                                      │
│  │   ├── Extract game states (FEN notation)             │
│  │   ├── Generate move sequences                        │
│  │   ├── Create valid move lists                        │
│  │   └── Mirror positions (augmentation)                │
│  │                                                        │
│  📝 Instruction Dataset                                   │
│  │   ├── Format prompts with game context               │
│  │   ├── Add player style descriptions                  │
│  │   └── Create training/validation split               │
│  │                                                        │
│  🎯 Model Training                                        │
│  │   ├── Load LFM2-350M base model                      │
│  │   ├── Apply LoRA (Low-Rank Adaptation)               │
│  │   ├── Fine-tune on chess positions                   │
│  │   └── Evaluate performance                           │
│  │                                                        │
│  🚀 Deployment                                            │
│      ├── ONNX export (web deployment)                    │
│      ├── Mobile bundle (iOS/Android)                     │
│      └── API server (FastAPI)                            │
│                                                           │
└─────────────────────────────────────────────────────────┘
```

## 🚀 Quick Start

### 1. Installation

```bash
# Clone repository
git clone https://github.com/yourusername/chess-ai-training
cd chess-ai-training

# Setup environment
make setup

# Activate virtual environment
source venv/bin/activate
```

### 2. Download Data

Download PGN files from [PGN Mentor](https://www.pgnmentor.com/files.html#players):

```bash
# Create data directory
mkdir -p data/raw

# Download recommended players
# - Carlsen.pgn (positional, strategic)
# - Kasparov.pgn (aggressive, tactical)
# - Fischer.pgn (precise, calculating)
# - Tal.pgn (creative, sacrificial)
# - Petrosian.pgn (defensive, prophylactic)

# Place files in data/raw/
```

### 3. Process Data

```bash
# Process all PGN files into training format
make process-data

# This creates: data/processed/combined_instructions.json
```

### 4. Train Model

**Option A: Local Training (requires GPU)**

```bash
make train
```

**Option B: Serverless Training with Modal (recommended)**

```bash
# Install Modal
pip install modal

# Setup Modal account
modal setup

# Train on Modal's GPUs
make train-modal
```

### 5. Evaluate Model

```bash
# Run evaluation on test set
python evaluate.py --model-path models/chess-ai --dataset-path data/processed/combined_instructions.json

# Play test games
python evaluate.py --model-path models/chess-ai --play-game --num-games 20
```

## 📁 Project Structure

```
chess-ai-training/
├── train.py                 # Main training pipeline
├── train_modal.py          # Modal serverless training
├── evaluate.py             # Evaluation and testing
├── export_onnx.py          # ONNX export for web
├── Makefile                # Automation commands
├── requirements.txt        # Python dependencies
├── README.md              # This file
│
├── data/
│   ├── raw/               # PGN files (download manually)
│   │   ├── Carlsen.pgn
│   │   ├── Kasparov.pgn
│   │   └── ...
│   └── processed/         # Processed training data
│       └── combined_instructions.json
│
├── models/                # Trained models
│   └── chess-ai/
│       ├── pytorch_model.bin
│       ├── config.json
│       └── tokenizer/
│
├── logs/                  # Training logs
└── notebooks/             # Jupyter notebooks for analysis
```

## ⚙️ Configuration

### Data Configuration

```python
from train import DataConfig

config = DataConfig(
    players=["Carlsen", "Kasparov", "Fischer", "Tal", "Petrosian"],
    min_elo=2700,
    max_games_per_player=5000,
    move_history_length=5
)
```

### Training Configuration

```python
from train import TrainingConfig

config = TrainingConfig(
    model_name="LiquidAI/LFM2-350M",
    learning_rate=2e-5,
    num_train_epochs=3,
    per_device_train_batch_size=4,
    lora_r=16,
    lora_alpha=32,
    max_steps=10000
)
```

## 📊 Evaluation Metrics

The evaluation script provides multiple metrics:

- **Exact Match Accuracy**: Percentage of positions where model predicts exact move
- **Legal Move Rate**: Percentage of predictions that are legal moves
- **Top-3/Top-5 Accuracy**: Percentage where correct move is in top predictions
- **Game Win Rate**: Performance in complete games against random/engine opponents

### Sample Results

```
EVALUATION RESULTS
==================================================
Total positions: 1000
Exact match accuracy: 32.5%
Legal move rate: 94.2%
Top-3 accuracy: 48.7%
Top-5 accuracy: 58.3%
==================================================

GAME RESULTS
==================================================
Total games: 20
Wins: 14 (70.0%)
Losses: 3 (15.0%)
Draws: 3 (15.0%)
==================================================
```

## 🌐 Deployment Options

### 1. Web Application (ONNX)

```bash
# Export to ONNX format
python export_onnx.py --model-path models/chess-ai --output models/chess-ai.onnx

# Use in browser with ONNX Runtime Web
# See web_app/ for React implementation
```

### 2. Mobile Application

```bash
# Bundle for iOS/Android
make bundle-model

# Creates models/chess-ai.bundle
# Use with Leap Edge SDK
```

### 3. API Server

```bash
# Start FastAPI server
python api_server.py --model-path models/chess-ai --port 8000

# Test endpoint
curl -X POST http://localhost:8000/predict \
  -H "Content-Type: application/json" \
  -d '{"fen": "rnbqkbnr/pppppppp/8/8/8/8/PPPPPPPP/RNBQKBNR w KQkq - 0 1"}'
```

## 🎯 Training Tips

### GPU Requirements
- **Minimum**: 16GB VRAM (NVIDIA T4 or better)
- **Recommended**: 40GB VRAM (A100)
- **Alternative**: Use Modal for serverless GPU access

### Training Time
- **5k steps**: ~2 hours on A100
- **10k steps**: ~4 hours on A100
- **Full training**: ~8 hours on A100

### Hyperparameter Tuning

Key parameters to experiment with:

1. **Learning Rate** (2e-5 to 5e-5)
   - Lower = more stable, slower
   - Higher = faster, may diverge

2. **LoRA Rank** (8, 16, 32)
   - Lower = fewer parameters, faster
   - Higher = more capacity, better performance

3. **Batch Size** (2, 4, 8)
   - Depends on GPU memory
   - Use gradient accumulation for larger effective batch

4. **Max Steps** (5k, 10k, 20k)
   - Monitor validation loss
   - Use early stopping

## 📈 Advanced Features

### Custom Player Styles

Add your own player styles:

```python
config = TrainingConfig(
    player_styles={
        "Carlsen": "positional and endgame specialist",
        "Kasparov": "dynamic and aggressive",
        "Custom": "your custom style description"
    }
)
```

### Data Augmentation

Beyond mirroring, implement:
- Position rotation
- Opening book integration
- Endgame tablebase knowledge

### Multi-Model Ensemble

Train multiple models with different styles and combine predictions:

```python
from ensemble import ChessEnsemble

ensemble = ChessEnsemble([
    "models/carlsen-style",
    "models/kasparov-style",
    "models/tal-style"
])

move = ensemble.predict(position, strategy="voting")
```

## 🔬 Research Extensions

Potential improvements:

1. **Reinforcement Learning**: Self-play training
2. **Value Network**: Add position evaluation head
3. **MCTS Integration**: Monte Carlo Tree Search for move selection
4. **Opening Books**: Integrate standard opening theory
5. **Endgame Tables**: Use Syzygy tablebases

## 🤝 Contributing

Contributions welcome! Areas for improvement:

- [ ] Add Stockfish evaluation for training labels
- [ ] Implement beam search for better move selection
- [ ] Add position evaluation head to model
- [ ] Create web-based training dashboard
- [ ] Support more base models (Llama, Mistral)
- [ ] Add time control support
- [ ] Implement opening book learning

## 📚 References

- [Original Repository](https://github.com/Paulescu/chess-game)
- [LiquidAI LFM2 Models](https://liquid.ai)
- [Chess Programming Wiki](https://www.chessprogramming.org/)
- [PGN Mentor Database](https://www.pgnmentor.com/)

## 📝 License

MIT License - See LICENSE file for details

## 🙏 Acknowledgments

- Pau Labarta Bajo for the original chess-game repository
- LiquidAI for the LFM2 model family
- Chess.com and Lichess for providing game databases
- Modal for serverless GPU infrastructure

## 📧 Contact

- **GitHub**: [@yourusername](https://github.com/yourusername)
- **Email**: your.email@example.com
- **Portfolio**: yourportfolio.com

---

**Built with ❤️ for the ML and Chess communities**

*Star ⭐ this repo if you find it useful!*