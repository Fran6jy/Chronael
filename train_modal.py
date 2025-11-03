"""
Modal Training Script for Chess AI
Train on serverless GPUs without managing infrastructure
"""

import modal
from pathlib import Path

# Create Modal app
app = modal.App("chess-ai-training")

# Define container image with all dependencies
image = (
    modal.Image.debian_slim(python_version="3.11")
    .pip_install(
        "torch>=2.1.0",
        "transformers>=4.36.0",
        "peft>=0.7.0",
        "trl>=0.7.4",
        "bitsandbytes>=0.41.0",
        "accelerate>=0.25.0",
        "wandb>=0.16.0",
        "python-chess>=1.999",
        "numpy>=1.24.0",
        "tqdm>=4.66.0",
    )
)

# Create volumes for data persistence
data_volume = modal.Volume.from_name("chess-data", create_if_missing=True)
model_volume = modal.Volume.from_name("chess-models", create_if_missing=True)

# Training function
@app.function(
    image=image,
    gpu="A100",  # or "T4", "A10G" for cheaper options
    timeout=3600 * 4,  # 4 hours
    volumes={
        "/data": data_volume,
        "/models": model_volume,
    },
    secrets=[modal.Secret.from_name("wandb-secret")],  # Optional: for logging
)
def train_chess_ai(
    model_name: str = "LiquidAI/LFM2-350M",
    dataset_path: str = "/data/processed/combined_instructions.json",
    output_dir: str = "/models/chess-ai",
    max_steps: int = 10000,
    learning_rate: float = 2e-5,
    batch_size: int = 4,
    lora_r: int = 16,
):
    """
    Train chess AI model on Modal's serverless infrastructure
    """
    import json
    import torch
    from transformers import (
        AutoTokenizer,
        AutoModelForCausalLM,
        TrainingArguments,
        BitsAndBytesConfig,
    )
    from peft import LoraConfig, get_peft_model, prepare_model_for_kbit_training
    from trl import SFTTrainer
    
    print("="*80)
    print("CHESS AI TRAINING ON MODAL")
    print("="*80)
    print(f"GPU: {torch.cuda.get_device_name(0)}")
    print(f"Model: {model_name}")
    print(f"Dataset: {dataset_path}")
    print("="*80)
    
    # Load dataset
    with open(dataset_path) as f:
        data = json.load(f)
    
    print(f"Loaded {len(data)} training samples")
    
    # Format data
    def prepare_prompt(instruction: str, response: str) -> str:
        system_message = "You are a world-class chess player. You analyze positions deeply and make strong moves."
        return f"""<|startoftext|><|im_start|>system
{system_message}<|im_end|>
<|im_start|>user
{instruction}<|im_end|>
<|im_start|>assistant
{response}<|im_end|>"""
    
    formatted_data = [
        {"text": prepare_prompt(item["instruction"], item["response"])}
        for item in data
    ]
    
    # Split data
    split_idx = int(len(formatted_data) * 0.9)
    train_data = formatted_data[:split_idx]
    val_data = formatted_data[split_idx:]
    
    print(f"Train: {len(train_data)}, Val: {len(val_data)}")
    
    # Load tokenizer
    tokenizer = AutoTokenizer.from_pretrained(model_name)
    tokenizer.pad_token = tokenizer.eos_token
    
    # Configure quantization
    bnb_config = BitsAndBytesConfig(
        load_in_4bit=True,
        bnb_4bit_quant_type="nf4",
        bnb_4bit_compute_dtype=torch.float16,
        bnb_4bit_use_double_quant=True,
    )
    
    # Load model
    print("Loading model...")
    model = AutoModelForCausalLM.from_pretrained(
        model_name,
        quantization_config=bnb_config,
        device_map="auto",
        trust_remote_code=True,
    )
    
    model = prepare_model_for_kbit_training(model)
    
    # Configure LoRA
    lora_config = LoraConfig(
        r=lora_r,
        lora_alpha=lora_r * 2,
        target_modules=["q_proj", "k_proj", "v_proj", "o_proj"],
        lora_dropout=0.05,
        bias="none",
        task_type="CAUSAL_LM",
    )
    
    model = get_peft_model(model, lora_config)
    
    trainable_params = sum(p.numel() for p in model.parameters() if p.requires_grad)
    total_params = sum(p.numel() for p in model.parameters())
    print(f"Trainable: {trainable_params:,} / {total_params:,} ({trainable_params/total_params*100:.2f}%)")
    
    # Training arguments
    training_args = TrainingArguments(
        output_dir=output_dir,
        num_train_epochs=3,
        per_device_train_batch_size=batch_size,
        per_device_eval_batch_size=batch_size,
        gradient_accumulation_steps=4,
        learning_rate=learning_rate,
        warmup_steps=500,
        max_steps=max_steps,
        logging_steps=100,
        eval_steps=500,
        save_steps=1000,
        evaluation_strategy="steps",
        save_strategy="steps",
        load_best_model_at_end=True,
        fp16=True,
        report_to=["wandb"],
        run_name="chess-ai-modal",
    )
    
    # Initialize trainer
    trainer = SFTTrainer(
        model=model,
        args=training_args,
        train_dataset=train_data,
        eval_dataset=val_data,
        tokenizer=tokenizer,
        max_seq_length=512,
        dataset_text_field="text",
    )
    
    # Train
    print("Starting training...")
    trainer.train()
    
    # Save model
    print(f"Saving to {output_dir}")
    trainer.save_model()
    tokenizer.save_pretrained(output_dir)
    
    # Commit volumes
    data_volume.commit()
    model_volume.commit()
    
    print("Training complete!")
    return {"status": "success", "output_dir": output_dir}


# Data processing function
@app.function(
    image=image,
    timeout=3600,
    volumes={"/data": data_volume},
)
def process_data():
    """Process PGN files into training format on Modal"""
    import sys
    sys.path.append("/root")
    
    # Import main training script
    from train import ChessDataProcessor, DataConfig, TrainingConfig
    
    data_config = DataConfig()
    training_config = TrainingConfig()
    
    processor = ChessDataProcessor(data_config)
    dataset_path = processor.process_all_players(training_config)
    
    data_volume.commit()
    
    return {"status": "success", "dataset_path": str(dataset_path)}


# CLI interface
@app.local_entrypoint()
def main(
    action: str = "train",
    model_name: str = "LiquidAI/LFM2-350M",
    max_steps: int = 10000,
):
    """
    Main entry point for Modal training
    
    Usage:
        modal run train_modal.py --action=process
        modal run train_modal.py --action=train
        modal run train_modal.py --action=train --max-steps=5000
    """
    
    if action == "process":
        print("Processing data on Modal...")
        result = process_data.remote()
        print(f"Result: {result}")
        
    elif action == "train":
        print("Starting training on Modal...")
        result = train_chess_ai.remote(
            model_name=model_name,
            max_steps=max_steps,
        )
        print(f"Result: {result}")
        
    else:
        print(f"Unknown action: {action}")
        print("Available actions: process, train")


if __name__ == "__main__":
    app.run()