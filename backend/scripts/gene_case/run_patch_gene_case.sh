#!/usr/bin/env bash
# Restore gene-name case in the 04_live *_mapped datasets (Tangram lower-cases var_names; var['symbol'] has the originals).
# Uses swarm_nextflow_dgea_case/bin/patch_gene_case.py. Dry run by default.
#   run_patch_gene_case.sh            # dry run, all datasets
#   run_patch_gene_case.sh --apply    # backs up h5ad+geojson to $BACKUP, then patches IN PLACE
set -euo pipefail
export OMP_NUM_THREADS=2
PY=~/.conda/envs/mybase/bin/python
PATCH=/nfs/proj/l.strasser/SWARM/swarm_nextflow_dgea_case/bin/patch_gene_case.py
LIVE=/nfs/data3/mopitas/SWARM/data/04_live/data
BACKUP=/nfs/data3/mopitas/SWARM/data/03_job_data/backup_04_live_20261120_gene_case
DATASETS="gbm_at10_2a_mapped gbm_at10_4a_mapped gbm_at11_1a_mapped gbm_at3_3c_mapped heart_d7_ra_mapped heart_d8_la_mapped heart_d8_ra_mapped mtg_h21_015_mapped mtg_h21_023_mapped mtg_h21_040_mapped"
APPLY=""; [ "${1:-}" = "--apply" ] && APPLY="--apply --overwrite-input"
for d in $DATASETS; do
  h5=$(ls $LIVE/$d/*_swarm_tool.h5ad); gj=$LIVE/$d/hexagons.geojson
  echo "=== $d"
  if [ -n "$APPLY" ]; then mkdir -p $BACKUP/$d; cp -n -p "$h5" "$gj" $BACKUP/$d/; fi
  $PY -I $PATCH --h5ad "$h5" --h5ad-out "$h5" --geojson "$gj" --geojson-out "$gj" $APPLY
done
