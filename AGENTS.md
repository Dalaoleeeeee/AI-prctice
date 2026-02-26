# AI Practice

Educational Python project implementing Transformer attention mechanisms and tokenizer demos.

## Cursor Cloud specific instructions

- **Tech stack**: Python 3.12, PyTorch, tiktoken. No web server, database, or multi-service architecture.
- **Virtual environment**: The venv at `/workspace/venv` is created by the update script. Always activate it before running scripts: `source venv/bin/activate`.
- **Running the scripts**: See `README.md` for usage. Both scripts are standalone: `python attention.py` (runs a self-test with assertion) and `python tokenizer.py` (prints token IDs).
- **No lint/test framework**: The project has no formal linter, test framework, or build step. `attention.py` contains an inline self-test (assertion at the bottom of the file).
- **NumPy warning**: PyTorch may emit a harmless warning about NumPy not being installed. This does not affect functionality and can be ignored.
- **System dependency**: `python3.12-venv` apt package is required to create the virtual environment. It is installed during initial setup, not in the update script.
