from train import ChessDataProcessor, DataConfig, TrainingConfig
import logging

logging.basicConfig(level=logging.INFO)

# Configure for small test
data_config = DataConfig(
    players=["Carlsen"],
    max_games_per_player=100  # Just 100 games for testing
)

training_config = TrainingConfig()

# Process
processor = ChessDataProcessor(data_config)
dataset_path = processor.process_all_players(training_config)

print(f"\n✅ Success! Dataset created at: {dataset_path}")
