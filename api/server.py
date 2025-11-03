"""
Chess AI API Server
Serves the trained model via REST API
"""

from fastapi import FastAPI, HTTPException
from fastapi.middleware.cors import CORSMiddleware
from pydantic import BaseModel
import torch
from transformers import AutoTokenizer, AutoModelForCausalLM
from peft import PeftModel
import chess
import logging
from pathlib import Path

logging.basicConfig(level=logging.INFO)
logger = logging.getLogger(__name__)

app = FastAPI(title="Chess AI API", version="1.0.0")

# Enable CORS for React app
app.add_middleware(
    CORSMiddleware,
    allow_origins=["http://localhost:3000"],
    allow_credentials=True,
    allow_methods=["*"],
    allow_headers=["*"],
)

# Global model variables
model = None
tokenizer = None
device = "cuda" if torch.cuda.is_available() else "cpu"

class MoveRequest(BaseModel):
    fen: str
    move_history: list = []
    difficulty: str = "medium"

class MoveResponse(BaseModel):
    move: str
    legal: bool
    reasoning: str = ""

def load_model():
    """Load the trained chess model"""
    global model, tokenizer
    
    model_path = Path("../models/chess-ai")
    
    if not model_path.exists():
        raise RuntimeError(f"Model not found at {model_path}")
    
    logger.info(f"Loading model from {model_path}")
    logger.info(f"Using device: {device}")
    
    try:
        tokenizer = AutoTokenizer.from_pretrained(model_path)
        model = AutoModelForCausalLM.from_pretrained(
            model_path,
            torch_dtype=torch.float16 if device == "cuda" else torch.float32,
            device_map="auto" if device == "cuda" else None,
        )
        
        if device == "cpu":
            model = model.to(device)
        
        model.eval()
        logger.info("Model loaded successfully!")
        
    except Exception as e:
        logger.error(f"Error loading model: {e}")
        raise

@app.on_event("startup")
async def startup_event():
    """Load model on startup"""
    load_model()

@app.get("/")
async def root():
    """Health check endpoint"""
    return {
        "status": "online",
        "model_loaded": model is not None,
        "device": device
    }

@app.get("/health")
async def health():
    """Detailed health check"""
    return {
        "status": "healthy",
        "model": "loaded" if model is not None else "not_loaded",
        "tokenizer": "loaded" if tokenizer is not None else "not_loaded",
        "device": device,
        "torch_version": torch.__version__
    }

def create_instruction(fen: str, move_history: list) -> str:
    """Create instruction prompt for the model"""
    
    board = chess.Board(fen)
    valid_moves = [move.uci() for move in board.legal_moves]
    
    color = "white" if board.turn else "black"
    move_history_str = ", ".join(move_history[-5:]) if move_history else "Game start"
    
    instruction = f"""You are a world-class chess player.

Current position (FEN): {fen}
Color to move: {color}
Move number: {board.fullmove_number}
Recent moves: {move_history_str}

Valid moves: {", ".join(valid_moves[:50])}

What is your next move? Respond with ONLY the move in UCI format (e.g., 'e2e4')."""
    
    return instruction

def predict_move(fen: str, move_history: list, temperature: float = 0.3) -> str:
    """Generate move prediction from the model"""
    
    instruction = create_instruction(fen, move_history)
    
    # Format with chat template
    system_message = "You are a world-class chess player. You analyze positions deeply and make strong moves."
    prompt = f"""<|startoftext|><|im_start|>system
{system_message}<|im_end|>
<|im_start|>user
{instruction}<|im_end|>
<|im_start|>assistant
"""
    
    # Tokenize
    inputs = tokenizer(prompt, return_tensors="pt").to(device)
    
    # Generate
    with torch.no_grad():
        outputs = model.generate(
            **inputs,
            max_new_tokens=20,
            temperature=temperature,
            do_sample=True,
            pad_token_id=tokenizer.eos_token_id,
            num_return_sequences=1,
        )
    
    # Decode
    response = tokenizer.decode(outputs[0], skip_special_tokens=True)
    
    # Extract move (take first word after assistant)
    if "<|im_start|>assistant" in response:
        move = response.split("<|im_start|>assistant")[-1].strip()
    else:
        move = response.strip()
    
    # Get just the move (first word)
    move = move.split()[0] if move else ""
    
    return move

def is_legal_move(fen: str, move_uci: str) -> bool:
    """Check if move is legal"""
    try:
        board = chess.Board(fen)
        move = chess.Move.from_uci(move_uci)
        return move in board.legal_moves
    except:
        return False

def get_fallback_move(fen: str) -> str:
    """Get a random legal move as fallback"""
    try:
        board = chess.Board(fen)
        legal_moves = list(board.legal_moves)
        if legal_moves:
            import random
            return random.choice(legal_moves).uci()
    except:
        pass
    return "e2e4"

@app.post("/predict", response_model=MoveResponse)
async def predict(request: MoveRequest):
    """Predict the next chess move"""
    
    if model is None or tokenizer is None:
        raise HTTPException(status_code=503, detail="Model not loaded")
    
    try:
        logger.info(f"Predicting move for position: {request.fen[:20]}...")
        
        # Adjust temperature based on difficulty
        temp_map = {"easy": 0.8, "medium": 0.4, "hard": 0.2}
        temperature = temp_map.get(request.difficulty, 0.4)
        
        # Try to get model prediction
        predicted_move = predict_move(request.fen, request.move_history, temperature)
        
        # Check if legal
        is_legal = is_legal_move(request.fen, predicted_move)
        
        if not is_legal:
            logger.warning(f"Illegal move predicted: {predicted_move}, using fallback")
            predicted_move = get_fallback_move(request.fen)
            is_legal = True
            reasoning = "Fallback move (model prediction was illegal)"
        else:
            reasoning = "Model prediction"
        
        logger.info(f"Predicted move: {predicted_move} (legal: {is_legal})")
        
        return MoveResponse(
            move=predicted_move,
            legal=is_legal,
            reasoning=reasoning
        )
        
    except Exception as e:
        logger.error(f"Error predicting move: {e}")
        raise HTTPException(status_code=500, detail=str(e))

if __name__ == "__main__":
    import uvicorn
    uvicorn.run(app, host="0.0.0.0", port=8000, log_level="info")