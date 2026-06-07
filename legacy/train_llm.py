# ============================================================================
# Enhanced Chess AI Training Pipeline
# Improvements over original: multi-player support, better data processing,
# enhanced training configuration, and evaluation metrics
# ============================================================================

import os
import json
import chess
import chess.pgn
from pathlib import Path
from dataclasses import dataclass, asdict
from typing import List, Dict, Optional, Tuple
import logging
from tqdm import tqdm
import random
from collections import defaultdict

# Configure logging
logging.basicConfig(
    level=logging.INFO,
    format='%(asctime)s - %(name)s - %(levelname)s - %(message)s'
)
logger = logging.getLogger(__name__)


# ============================================================================
# Configuration
# ============================================================================

@dataclass
class DataConfig:
    """Configuration for data processing"""
    raw_data_dir: str = "data/raw"
    processed_data_dir: str = "data/processed"
    players: List[str] = None  # List of player names to download
    min_elo: int = 2700  # Minimum ELO rating for games
    max_games_per_player: int = 5000
    move_history_length: int = 5  # Number of previous moves to include
    
    def __post_init__(self):
        if self.players is None:
            self.players = ["Carlsen", "Kasparov", "Fischer", "Tal", "Petrosian"]


@dataclass
class TrainingConfig:
    """Configuration for model training"""
    model_name: str = "LiquidAI/LFM2-350M"
    output_dir: str = "models/chess-ai"
    
    # Training hyperparameters
    learning_rate: float = 2e-5
    num_train_epochs: int = 3
    per_device_train_batch_size: int = 4
    per_device_eval_batch_size: int = 4
    gradient_accumulation_steps: int = 4
    warmup_steps: int = 500
    max_steps: int = 10000
    logging_steps: int = 100
    eval_steps: int = 500
    save_steps: int = 1000
    
    # LoRA configuration
    lora_r: int = 16
    lora_alpha: int = 32
    lora_dropout: float = 0.05
    target_modules: List[str] = None
    
    # Data configuration
    max_seq_length: int = 512
    validation_split: float = 0.1
    
    # Style configuration
    player_styles: Dict[str, str] = None
    
    def __post_init__(self):
        if self.target_modules is None:
            self.target_modules = ["q_proj", "k_proj", "v_proj", "o_proj"]
        
        if self.player_styles is None:
            self.player_styles = {
                "Carlsen": "positional and strategic",
                "Kasparov": "aggressive and tactical",
                "Fischer": "precise and calculating",
                "Tal": "creative and sacrificial",
                "Petrosian": "defensive and prophylactic"
            }


# ============================================================================
# Data Processing
# ============================================================================

class ChessDataProcessor:
    """Process chess games into training data"""
    
    def __init__(self, config: DataConfig):
        self.config = config
        self.raw_dir = Path(config.raw_data_dir)
        self.processed_dir = Path(config.processed_data_dir)
        self.processed_dir.mkdir(parents=True, exist_ok=True)
    
    def download_games(self, player: str) -> Path:
        """
        Download games for a specific player
        Note: In production, implement actual download from pgnmentor.com
        """
        logger.info(f"Downloading games for {player}...")
        
        # Placeholder - in real implementation, download from:
        # https://www.pgnmentor.com/files.html#players
        pgn_file = self.raw_dir / f"{player}.pgn"
        
        if not pgn_file.exists():
            logger.warning(f"PGN file not found: {pgn_file}")
            logger.info("Please manually download from https://www.pgnmentor.com/files.html#players")
            return None
        
        return pgn_file
    
    def extract_game_features(self, game: chess.pgn.Game) -> Optional[List[Dict]]:
        """Extract features from a single game"""
        
        # Get game metadata
        headers = game.headers
        try:
            white_elo = int(headers.get("WhiteElo", 0))
            black_elo = int(headers.get("BlackElo", 0))
        except (ValueError, TypeError):
            return None
        
        # Filter by ELO
        if white_elo < self.config.min_elo and black_elo < self.config.min_elo:
            return None
        
        # Extract positions
        board = game.board()
        positions = []
        move_history = []
        
        for move_num, move in enumerate(game.mainline_moves()):
            # Get current position
            fen = board.fen()
            
            # Get valid moves
            valid_moves = [m.uci() for m in board.legal_moves]
            
            # Get player color
            color = "white" if board.turn else "black"
            
            # Store position data
            position_data = {
                "fen": fen,
                "move_number": move_num + 1,
                "color": color,
                "valid_moves": valid_moves,
                "move_history": move_history[-self.config.move_history_length:].copy(),
                "next_move": move.uci(),
                "white_elo": white_elo,
                "black_elo": black_elo,
            }
            
            positions.append(position_data)
            
            # Update move history and board
            move_history.append(move.uci())
            board.push(move)
        
        return positions
    
    def process_pgn_file(self, pgn_file: Path, player: str) -> List[Dict]:
        """Process a PGN file and extract all positions"""
        
        logger.info(f"Processing {pgn_file}...")
        
        all_positions = []
        game_count = 0
        
        with open(pgn_file) as f:
            while game_count < self.config.max_games_per_player:
                game = chess.pgn.read_game(f)
                if game is None:
                    break
                
                positions = self.extract_game_features(game)
                if positions:
                    all_positions.extend(positions)
                    game_count += 1
                
                if game_count % 100 == 0:
                    logger.info(f"Processed {game_count} games, {len(all_positions)} positions")
        
        logger.info(f"Total positions extracted: {len(all_positions)}")
        return all_positions
    
    def augment_position(self, position: Dict) -> List[Dict]:
        """
        Augment a position by mirroring horizontally
        This doubles the training data
        """
        original = position.copy()
        
        # Create mirrored version
        board = chess.Board(position["fen"])
        mirrored_board = board.mirror()
        
        def mirror_move(move_uci: str) -> str:
            """Mirror a move horizontally"""
            files = "abcdefgh"
            return (
                files[7 - files.index(move_uci[0])] + 
                move_uci[1] + 
                files[7 - files.index(move_uci[2])] + 
                move_uci[3]
            )
        
        mirrored = {
            "fen": mirrored_board.fen(),
            "move_number": position["move_number"],
            "color": position["color"],
            "valid_moves": [mirror_move(m) for m in position["valid_moves"]],
            "move_history": [mirror_move(m) for m in position["move_history"]],
            "next_move": mirror_move(position["next_move"]),
            "white_elo": position["white_elo"],
            "black_elo": position["black_elo"],
            "augmented": True
        }
        
        return [original, mirrored]
    
    def create_instruction_dataset(
        self, 
        player: str, 
        style_description: str,
        augment: bool = True
    ) -> Path:
        """Create instruction dataset for a player"""
        
        # Process PGN file
        pgn_file = self.download_games(player)
        if not pgn_file:
            return None
        
        positions = self.process_pgn_file(pgn_file, player)
        
        # Augment data if requested
        if augment:
            logger.info("Augmenting dataset...")
            augmented_positions = []
            for pos in tqdm(positions, desc="Augmenting"):
                augmented_positions.extend(self.augment_position(pos))
            positions = augmented_positions
            logger.info(f"Dataset size after augmentation: {len(positions)}")
        
        # Create instruction format
        instruction_data = []
        
        for pos in tqdm(positions, desc="Creating instructions"):
            instruction = self._create_instruction(pos, player, style_description)
            instruction_data.append(instruction)
        
        # Save to file
        output_file = self.processed_dir / f"{player}_instructions.json"
        with open(output_file, 'w') as f:
            json.dump(instruction_data, f, indent=2)
        
        logger.info(f"Saved {len(instruction_data)} instructions to {output_file}")
        return output_file
    
    def _create_instruction(
        self, 
        position: Dict, 
        player: str, 
        style: str
    ) -> Dict:
        """Create instruction format for training"""
        
        # Format move history
        move_history_str = ", ".join(position["move_history"]) if position["move_history"] else "Game start"
        
        # Create instruction
        instruction = f"""You are {player}, known for your {style} playing style.

Current position (FEN): {position["fen"]}
Color to move: {position["color"]}
Move number: {position["move_number"]}
Recent moves: {move_history_str}

Valid moves: {", ".join(position["valid_moves"])}

What is your next move? Respond with ONLY the move in UCI format (e.g., 'e2e4')."""
        
        response = position["next_move"]
        
        return {
            "instruction": instruction,
            "response": response,
            "metadata": {
                "player": player,
                "elo": max(position["white_elo"], position["black_elo"]),
                "move_number": position["move_number"],
                "augmented": position.get("augmented", False)
            }
        }
    
    def process_all_players(self, training_config: TrainingConfig) -> Path:
        """Process all players and combine datasets"""
        
        all_data = []
        
        for player in self.config.players:
            style = training_config.player_styles.get(player, "tactical and strategic")
            
            logger.info(f"\n{'='*60}")
            logger.info(f"Processing {player} ({style})")
            logger.info(f"{'='*60}\n")
            
            output_file = self.create_instruction_dataset(player, style, augment=True)
            
            if output_file and output_file.exists():
                with open(output_file) as f:
                    player_data = json.load(f)
                    all_data.extend(player_data)
        
        # Shuffle combined data
        random.shuffle(all_data)
        
        # Save combined dataset
        combined_file = self.processed_dir / "combined_instructions.json"
        with open(combined_file, 'w') as f:
            json.dump(all_data, f, indent=2)
        
        logger.info(f"\nCombined dataset: {len(all_data)} total instructions")
        logger.info(f"Saved to {combined_file}")
        
        # Print statistics
        self._print_dataset_stats(all_data)
        
        return combined_file
    
    def _print_dataset_stats(self, data: List[Dict]):
        """Print dataset statistics"""
        
        player_counts = defaultdict(int)
        elo_distribution = []
        
        for item in data:
            player_counts[item["metadata"]["player"]] += 1
            elo_distribution.append(item["metadata"]["elo"])
        
        logger.info("\nDataset Statistics:")
        logger.info(f"Total samples: {len(data)}")
        logger.info("\nSamples per player:")
        for player, count in sorted(player_counts.items()):
            logger.info(f"  {player}: {count} ({count/len(data)*100:.1f}%)")
        
        logger.info(f"\nELO distribution:")
        logger.info(f"  Min: {min(elo_distribution)}")
        logger.info(f"  Max: {max(elo_distribution)}")
        logger.info(f"  Avg: {sum(elo_distribution)/len(elo_distribution):.0f}")


# ============================================================================
# Training Script
# ============================================================================

class ChessAITrainer:
    """Train the chess AI model"""
    
    def __init__(self, config: TrainingConfig):
        self.config = config
    
    def prepare_prompt(self, instruction: str, response: str = None) -> str:
        """Format prompt with chat template"""
        
        system_message = "You are a world-class chess player trained by Liquid AI. You analyze positions deeply and make strong moves."
        
        prompt = f"""<|startoftext|><|im_start|>system
{system_message}<|im_end|>
<|im_start|>user
{instruction}<|im_end|>
<|im_start|>assistant
"""
        
        if response:
            prompt += f"{response}<|im_end|>"
        
        return prompt
    
    def train(self, dataset_path: Path):
        """
        Main training function
        
        Note: This requires the following libraries:
        - transformers
        - peft
        - trl
        - unsloth (optional, for faster training)
        - torch
        - wandb (optional, for logging)
        """
        
        logger.info("Starting training...")
        logger.info(f"Model: {self.config.model_name}")
        logger.info(f"Dataset: {dataset_path}")
        logger.info(f"Output: {self.config.output_dir}")
        
        try:
            from transformers import (
                AutoTokenizer, 
                AutoModelForCausalLM,
                TrainingArguments,
                BitsAndBytesConfig
            )
            from peft import LoraConfig, get_peft_model, prepare_model_for_kbit_training
            from trl import SFTTrainer
            import torch
            
        except ImportError as e:
            logger.error(f"Missing required library: {e}")
            logger.error("Install with: pip install transformers peft trl torch")
            return
        
        # Load dataset
        with open(dataset_path) as f:
            data = json.load(f)
        
        # Format for training
        formatted_data = []
        for item in data:
            formatted_data.append({
                "text": self.prepare_prompt(item["instruction"], item["response"])
            })
        
        # Split into train/val
        split_idx = int(len(formatted_data) * (1 - self.config.validation_split))
        train_data = formatted_data[:split_idx]
        val_data = formatted_data[split_idx:]
        
        logger.info(f"Train samples: {len(train_data)}")
        logger.info(f"Validation samples: {len(val_data)}")
        
        # Load model and tokenizer
        logger.info("Loading model and tokenizer...")
        
        tokenizer = AutoTokenizer.from_pretrained(self.config.model_name)
        tokenizer.pad_token = tokenizer.eos_token
        
        # Configure quantization for efficient training
        bnb_config = BitsAndBytesConfig(
            load_in_4bit=True,
            bnb_4bit_quant_type="nf4",
            bnb_4bit_compute_dtype=torch.float16,
            bnb_4bit_use_double_quant=True,
        )
        
        model = AutoModelForCausalLM.from_pretrained(
            self.config.model_name,
            quantization_config=bnb_config,
            device_map="auto",
            trust_remote_code=True
        )
        
        model = prepare_model_for_kbit_training(model)
        
        # Configure LoRA
        lora_config = LoraConfig(
            r=self.config.lora_r,
            lora_alpha=self.config.lora_alpha,
            target_modules=self.config.target_modules,
            lora_dropout=self.config.lora_dropout,
            bias="none",
            task_type="CAUSAL_LM"
        )
        
        model = get_peft_model(model, lora_config)
        
        # Print trainable parameters
        trainable_params = sum(p.numel() for p in model.parameters() if p.requires_grad)
        total_params = sum(p.numel() for p in model.parameters())
        logger.info(f"Trainable params: {trainable_params:,} ({trainable_params/total_params*100:.2f}%)")
        
        # Training arguments
        training_args = TrainingArguments(
            output_dir=self.config.output_dir,
            num_train_epochs=self.config.num_train_epochs,
            per_device_train_batch_size=self.config.per_device_train_batch_size,
            per_device_eval_batch_size=self.config.per_device_eval_batch_size,
            gradient_accumulation_steps=self.config.gradient_accumulation_steps,
            learning_rate=self.config.learning_rate,
            warmup_steps=self.config.warmup_steps,
            max_steps=self.config.max_steps,
            logging_steps=self.config.logging_steps,
            eval_steps=self.config.eval_steps,
            save_steps=self.config.save_steps,
            evaluation_strategy="steps",
            save_strategy="steps",
            load_best_model_at_end=True,
            fp16=True,
            report_to=["wandb"] if self._check_wandb() else [],
            run_name="chess-ai-training",
        )
        
        # Initialize trainer
        trainer = SFTTrainer(
            model=model,
            args=training_args,
            train_dataset=train_data,
            eval_dataset=val_data,
            tokenizer=tokenizer,
            max_seq_length=self.config.max_seq_length,
            dataset_text_field="text",
        )
        
        # Train
        logger.info("Starting training loop...")
        trainer.train()
        
        # Save final model
        logger.info(f"Saving model to {self.config.output_dir}")
        trainer.save_model()
        tokenizer.save_pretrained(self.config.output_dir)
        
        logger.info("Training complete!")
    
    def _check_wandb(self) -> bool:
        """Check if wandb is available"""
        try:
            import wandb
            return wandb.api.api_key is not None
        except:
            return False


# ============================================================================
# Main Execution
# ============================================================================

def main():
    """Main execution function"""
    
    # Initialize configurations
    data_config = DataConfig()
    training_config = TrainingConfig()
    
    # Create data processor
    processor = ChessDataProcessor(data_config)
    
    # Process all players and create combined dataset
    logger.info("="*80)
    logger.info("CHESS AI TRAINING PIPELINE")
    logger.info("="*80)
    
    dataset_path = processor.process_all_players(training_config)
    
    # Train model
    if dataset_path and dataset_path.exists():
        trainer = ChessAITrainer(training_config)
        
        user_input = input("\nStart training? (y/n): ")
        if user_input.lower() == 'y':
            trainer.train(dataset_path)
        else:
            logger.info("Training skipped. Dataset ready for training.")
    else:
        logger.error("Dataset creation failed!")


if __name__ == "__main__":
    main()