.PHONY: help setup download data train play eval api test clean

PLAYER ?= Carlsen
PGN    ?= data/raw/$(PLAYER).pgn
DATA   ?= data/processed/$(shell echo $(PLAYER) | tr A-Z a-z).npz
MODEL  ?= models/chronael.pt

help:
	@echo "Chronael - play chess against an imitation of a specific grandmaster"
	@echo ""
	@echo "  make setup       Install Python dependencies"
	@echo "  make download    Download $(PLAYER)'s games (PGN)"
	@echo "  make data        Build the move-prediction dataset (.npz)"
	@echo "  make train       Train the policy network"
	@echo "  make eval        Report move-match accuracy of the trained model"
	@echo "  make play        Play a game against the model in the terminal"
	@echo "  make api         Serve the model over HTTP (FastAPI)"
	@echo "  make test        Run the test suite"
	@echo ""
	@echo "Override defaults, e.g.:  make data PLAYER=Kasparov MIN_YEAR=2010"

setup:
	pip install -r requirements.txt

download:
	python scripts/download_data.py --player $(PLAYER)

data:
	python scripts/build_dataset.py --pgn $(PGN) --player $(PLAYER) --out $(DATA) \
		$(if $(MIN_YEAR),--min-year $(MIN_YEAR),) $(if $(MIN_ELO),--min-elo $(MIN_ELO),) \
		$(if $(MAX_GAMES),--max-games $(MAX_GAMES),)

train:
	python scripts/train.py --data $(DATA) --out $(MODEL) \
		$(if $(EPOCHS),--epochs $(EPOCHS),) $(if $(CHANNELS),--channels $(CHANNELS),) \
		$(if $(NUM_BLOCKS),--num-blocks $(NUM_BLOCKS),)

eval:
	python scripts/evaluate_model.py --data $(DATA) --model $(MODEL)

play:
	python scripts/play.py --model $(MODEL) $(if $(COLOR),--color $(COLOR),)

api:
	cd api && uvicorn server:app --host 0.0.0.0 --port 8000

test:
	pytest -q

clean:
	rm -rf data/processed models __pycache__ chronael/__pycache__ scripts/__pycache__
