# prj-amd

AI-powered enhanced sampling molecular dynamics with GROMACS + PLUMED, featuring a web UI.

## Setup

### 1. Python

```bash
conda create -n amd python=3.11 -y
conda activate amd
pip install -e '.[web,dev]'
```

### 2. Node.js (for the frontend)

```bash
# Install nvm if you don't have it
curl -o- https://raw.githubusercontent.com/nvm-sh/nvm/v0.40.1/install.sh | bash
source ~/.bashrc

nvm install 20
nvm use 20

# Install frontend dependencies
cd web/frontend && npm install && cd ../..
```

### 3. Docker (GROMACS + PLUMED)

GROMACS and PLUMED run inside a Docker container. Make sure the Docker daemon is running.

```bash
# Pull or build the image
docker pull gromacs-plumed:latest
# Or build from a local Dockerfile if provided:
# docker build -t gromacs-plumed:latest .
```

### 4. Environment variables

```bash
cp .env.example .env   # if .env.example exists, otherwise create .env manually
```

Edit `.env`:

```
ANTHROPIC_API_KEY=sk-ant-...
GMX_DOCKER_IMAGE=gromacs-plumed:latest
```

API keys can also be set per-user in the web UI under **Settings > API Keys**.

## Running

```bash
./start.sh              # Build frontend (if needed) + serve on :8000
./start.sh --dev        # Watch mode: auto-rebuild frontend on source changes
./start.sh --build      # Force-rebuild the frontend
```

Open http://localhost:8000 in your browser.

## Running the agent (CLI)

```bash
python main.py                                        # Default metadynamics mode
python main.py method=umbrella gromacs.temperature=320 # Override config
python main.py mode=interactive                        # REPL mode
```

## Tests

```bash
pytest tests/ -v
```

## License

MIT
