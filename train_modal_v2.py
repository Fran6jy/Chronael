"""
Modal Training Script - Pass data directly
"""

import modal
import json
from pathlib import Path

app = modal.App("chess-ai-training-v2")

# Define image
image = (
    modal.Image.debian_slim(python_version="3.11")
    .pip_install(
        "torch>=2.1.0",
        "transformers>=4.36.0",
        "peft>=0.7.0",
        "trl>=0.7.4",
        "bitsandbytes>=0.41.0",
        "accelerate>=0.25.0",
        "python-chess>=1.999",
        "numpy>=1.24.0",
        "tqdm>=4.66.0",
    )
)

# Volume for saving models
model_volume = modal.Volume.from_name("chess-models", create_if_missing=True)

@app.function(
    image=image,
    gpu="A100",
    timeout=3600 * 4,
    volumes={"/models": model_volume},
)
def train_chess_ai(
    train_data: list,
    val_data: list,
    max_steps: int = 2000,
):
    import torch
    from transformers import (
        AutoTokenizer,
        AutoModelForCausalLM,
        TrainingArguments,
        BitsAndBytesConfig,
        Trainer,  # Use regular Trainer instead
    )
    from peft import LoraConfig, get_peft_model, prepare_model_for_kbit_training
    from datasets import Dataset
    
    print("="*80)
    print("CHESS AI TRAINING ON MODAL")
    print("="*80)
    print(f"Train samples: {len(train_data)}")
    print(f"Val samples: {len(val_data)}")
    print("="*80)
    
    # Use TinyLlama for faster testing
    model_name = "TinyLlama/TinyLlama-1.1B-Chat-v1.0"
    
    print("Loading tokenizer...")
    tokenizer = AutoTokenizer.from_pretrained(model_name)
    tokenizer.pad_token = tokenizer.eos_token
    tokenizer.padding_side = "right"
    
    bnb_config = BitsAndBytesConfig(
        load_in_4bit=True,
        bnb_4bit_quant_type="nf4",
        bnb_4bit_compute_dtype=torch.float16,
        bnb_4bit_use_double_quant=True,
    )
    
    print("Loading model...")
    model = AutoModelForCausalLM.from_pretrained(
        model_name,
        quantization_config=bnb_config,
        device_map="auto",
    )
    
    model = prepare_model_for_kbit_training(model)
    
    lora_config = LoraConfig(
        r=16,
        lora_alpha=32,
        target_modules=["q_proj", "k_proj", "v_proj", "o_proj"],
        lora_dropout=0.05,
        bias="none",
        task_type="CAUSAL_LM",
    )
    
    model = get_peft_model(model, lora_config)
    
    trainable_params = sum(p.numel() for p in model.parameters() if p.requires_grad)
    total_params = sum(p.numel() for p in model.parameters())
    print(f"Trainable: {trainable_params:,} / {total_params:,} ({trainable_params/total_params*100:.2f}%)")
    
    # Convert to HuggingFace Dataset format
    print("Preparing datasets...")
    train_dataset = Dataset.from_list(train_data)
    val_dataset = Dataset.from_list(val_data)
    
    # Tokenization function
    def tokenize_function(examples):
        outputs = tokenizer(
            examples["text"],
            truncation=True,
            max_length=512,
            padding="max_length",
            return_tensors="pt",
        )
        outputs["labels"] = outputs["input_ids"].clone()
        return outputs
    
    # Tokenize datasets
    print("Tokenizing...")
    tokenized_train = train_dataset.map(
        tokenize_function,
        batched=True,
        remove_columns=train_dataset.column_names,
    )
    tokenized_val = val_dataset.map(
        tokenize_function,
        batched=True,
        remove_columns=val_dataset.column_names,
    )
    
    output_dir = "/models/chess-ai"
    
    training_args = TrainingArguments(
        output_dir=output_dir,
        num_train_epochs=3,
        per_device_train_batch_size=4,
        per_device_eval_batch_size=4,
        gradient_accumulation_steps=4,
        learning_rate=2e-5,
        warmup_steps=100,
        max_steps=max_steps,
        logging_steps=50,
        eval_steps=250,
        save_steps=500,
        eval_strategy="steps",
        save_strategy="steps",
        load_best_model_at_end=True,
        fp16=True,
        report_to=[],
        remove_unused_columns=False,
    )
    
    # Use standard Trainer (more stable than SFTTrainer)
    trainer = Trainer(
        model=model,
        args=training_args,
        train_dataset=tokenized_train,
        eval_dataset=tokenized_val,
    )
    
    print("Starting training...")
    trainer.train()
    
    print(f"Saving to {output_dir}")
    trainer.save_model()
    tokenizer.save_pretrained(output_dir)
    
    model_volume.commit()
    
    print("✅ Training complete!")
    return {"status": "success", "train_samples": len(train_data)}

@app.local_entrypoint()
def main(
    dataset_path: str = "data/processed/combined_instructions.json",
    max_steps: int = 2000,
    sample_size: int = 10000,  # Use only 10k samples for faster testing
):
    """Train chess AI on Modal with data passed directly"""
    
    print(f"📊 Loading dataset from: {dataset_path}")
    
    # Check if file exists
    if not Path(dataset_path).exists():
        print(f"❌ Error: Dataset not found!")
        print(f"   Expected: {dataset_path}")
        print("\n💡 Run this first: python train.py")
        return
    
    # Load data locally
    with open(dataset_path) as f:
        data = json.load(f)
    
    print(f"✅ Loaded {len(data)} total samples")
    
    # Sample for faster training
    if len(data) > sample_size:
        import random
        data = random.sample(data, sample_size)
        print(f"📉 Sampled down to {len(data)} samples for faster training")
    
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
    
    # Split
    split_idx = int(len(formatted_data) * 0.9)
    train_data = formatted_data[:split_idx]
    val_data = formatted_data[split_idx:]
    
    print(f"📊 Train: {len(train_data)}, Val: {len(val_data)}")
    print(f"🚀 Starting training on Modal...")
    print(f"⏱️  This will take approximately {max_steps / 100} minutes")
    
    # Train!
    result = train_chess_ai.remote(train_data, val_data, max_steps)
    
    print(f"\n✅ {result}")
    print("\n📥 Download your trained model with:")
    print("   modal volume get chess-models /chess-ai models/chess-ai")