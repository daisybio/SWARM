#!/usr/bin/env bash
# Local dev launcher (no containers): Angular dev server + FastAPI backend, with live reload.
#
#   ./launch.sh                      # backend :3000, frontend :4200
#   SWARM_DEV_DATASETS="gbm_at10_4a_mapped heart_d8_ra_mapped" ./launch.sh
#
# Python: conda env "swarm-dev" (created once, see DEVELOPER.md / the mamba command below),
# else whatever `python` is on PATH (devcontainer).
# Data: backend/data is gitignored; datasets listed in SWARM_DEV_DATASETS are symlinked into it
# from SWARM_DEV_DATA_SRC. Machine-specific settings (SWARM_DEV_DATA_SRC, SWARM_DEV_DATASETS, ...)
# can go into an untracked file ".launch.local" next to this script (it is sourced if present).
# Frontend is bound to 127.0.0.1; from your laptop: ssh -L 4200:localhost:4200 -L 3000:localhost:3000 <user>@<host>
#
# One-time env creation:
#   CONDA_PKGS_DIRS=~/.conda/pkgs mamba create -n swarm-dev -c conda-forge --override-channels \
#     python=3.12 numpy pandas scipy scikit-learn scanpy anndata h5py pyarrow geopandas fastapi \
#     uvicorn python-multipart simplejson pydantic python-dotenv dask pip && \
#   uv pip install --python ~/.conda/envs/swarm-dev/bin/python fastapi-sessions geojson

set -euo pipefail

BASEDIR=$(cd "$(dirname "$0")" && pwd)
# shellcheck disable=SC1091
[ -f "$BASEDIR/.launch.local" ] && . "$BASEDIR/.launch.local"
BACKEND_PORT=${SWARM_PORT:-3000}
FRONTEND_PORT=${SWARM_FRONTEND_PORT:-4200}
DATA_SRC=${SWARM_DEV_DATA_SRC:-}
DATASETS=${SWARM_DEV_DATASETS:-"gbm_at10_4a_mapped gbm_at10_4a_dissociated"}

PY=python
if [ -x "$HOME/.conda/envs/swarm-dev/bin/python" ]; then
  PY="$HOME/.conda/envs/swarm-dev/bin/python"
fi

for port in "$BACKEND_PORT" "$FRONTEND_PORT"; do
  if ss -ltn 2>/dev/null | awk '{print $4}' | grep -qE "[:.]${port}\$"; then
    echo "Port $port is already in use (another dev server or a container?)." >&2
    echo "Free it, or set SWARM_PORT / SWARM_FRONTEND_PORT (the dev frontend calls http://localhost:3000," >&2
    echo "see frontend/src/environments/environment.ts)." >&2
    exit 1
  fi
done

# Link the datasets into backend/data (only when the source exists and the link/dir is absent).
mkdir -p "$BASEDIR/backend/data"
if [ -d "$DATA_SRC" ]; then
  for d in $DATASETS; do
    if [ -d "$DATA_SRC/$d" ] && [ ! -e "$BASEDIR/backend/data/$d" ]; then
      ln -s "$DATA_SRC/$d" "$BASEDIR/backend/data/$d"
      echo "linked dataset $d"
    fi
  done
fi

# One BLAS/OpenMP thread per process: this is a shared machine.
export OMP_NUM_THREADS=${OMP_NUM_THREADS:-2} OPENBLAS_NUM_THREADS=${OPENBLAS_NUM_THREADS:-2} \
       MKL_NUM_THREADS=${MKL_NUM_THREADS:-2} NUMEXPR_NUM_THREADS=${NUMEXPR_NUM_THREADS:-2}
export UVICORN_RELOAD=${UVICORN_RELOAD:-true} SWARM_PORT=$BACKEND_PORT

cd "$BASEDIR/frontend"
NG_BUILD_WATCH_ROOT=1 npx ng serve --host 127.0.0.1 --port "$FRONTEND_PORT" \
  --proxy-config proxy.conf.json &
FRONTEND_PID=$!
trap 'kill $FRONTEND_PID 2>/dev/null || true' EXIT INT TERM

cd "$BASEDIR/backend"
"$PY" main.py
