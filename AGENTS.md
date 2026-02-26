# AI Practice

Educational Python project: a progressive curriculum covering Transformer attention, SFT, LoRA, DPO, and GRPO.

## Cursor Cloud specific instructions

- **Tech stack**: Python 3.12, PyTorch, transformers, peft, trl, tiktoken. No web server, database, or multi-service architecture.
- **Virtual environment**: The venv at `/workspace/venv` is created by the update script. Always activate it before running scripts: `source venv/bin/activate`.
- **Project structure**: 5 modules in order — `00_basics/`, `01_sft/`, `02_lora/`, `03_dpo/`, `04_grpo/`. Each has its own README, training script(s), and `data/` with JSONL datasets.
- **Running scripts**: All scripts are standalone. Run from the repo root, e.g. `python 01_sft/train_sft.py`. See each module's README or the root `README.md` for details.
- **Default model**: All training scripts default to `gpt2` (124M params) for universality. GPT-2 is English-only, so Chinese generation quality is limited — this is expected. Switch `CONFIG["model_name"]` to `Qwen/Qwen2.5-0.5B` for better Chinese results.
- **No lint/test framework**: The project has no formal linter or test framework. `00_basics/attention.py` has an inline assertion self-test. The training scripts serve as integration tests (they train and generate).
- **Output directories**: Each training script writes to `XX_module/output/`. These are git-ignored.
- **NumPy warning**: PyTorch may emit a harmless warning about NumPy not being installed. Does not affect functionality.
- **System dependency**: `python3.12-venv` apt package is required to create the virtual environment.
