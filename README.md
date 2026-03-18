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

## Web UI

### Login

![Login](images/login.png)

Sign in with your username and password. Accounts are stored in a local SQLite database.

### Dashboard

![Dashboard](images/dashboard.png)

The main interface has three panels: a **session sidebar** on the left for creating and switching sessions, the **MD workspace** in the center for configuring and monitoring simulations, and an **AI assistant** on the right for asking questions and getting suggestions.

### Session Creation

![Session Creation](images/session-creation.png)

Create a new session by choosing a molecule system (Alanine Dipeptide, Chignolin, or custom), a simulation method (MD, Metadynamics, OPES, Umbrella, Steered), and a GROMACS template (vacuum or solvated). The session directory and default name are generated from the creation timestamp.

### Progress

![Progress](images/session-progress.png)

Monitor a running or completed simulation. Shows live step count, ns/day performance, elapsed time, and result plots (energy, COLVAR, Ramachandran, custom CVs). The trajectory viewer plays back the molecular trajectory with adjustable speed. Energy data loads from cache instantly; gmx extraction only runs when explicitly requested.

### Molecule

![Molecule](images/session-molecule.png)

Interactive 3D visualization of the molecular structure using NGL. Upload, download, or search for structures from RCSB PDB. Select a molecule file to load it into the viewer with atom and residue counts displayed.

### GROMACS

![GROMACS](images/session-gromacs.png)

Configure all GROMACS MDP parameters: force field, solvent, simulation length, timestep, temperature, thermostat, and advanced settings (cutoffs, electrostatics, constraints, output frequencies, pressure coupling). An AI agent can suggest settings from published papers. Changes are saved automatically and reflected in the generated MDP file.

### Method

![Method](images/session-method.png)

Select the enhanced sampling method and configure its parameters. For MetaD: height, pace, sigma, bias factor, HILLS file. For OPES: pace, sigma, barrier, temperature, kernels file, state file, store states. Define collective variables using an interactive 3D atom picker, macro generators (all CA distances, backbone torsions), or ML-based CVs with PyTorch TorchScript checkpoints. Preview the generated PLUMED input file directly from the header.

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
