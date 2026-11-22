# gene_case

Tangram lower-cases `var_names`; `var['symbol']` keeps the originals. `run_patch_gene_case.sh` restores them
(h5ad var index, uns gene lists/tables, geojson meta keys) in the 10 `*_mapped` gbm/heart/mtg datasets of
04_live using `swarm_nextflow_dgea_case/bin/patch_gene_case.py`. Dry run by default, `--apply` backs up to
`03_job_data/backup_04_live_20261120_gene_case/` and patches in place.

Run 2026-11-20: dry run (`dry_run_20261120.log`, all 10 clean: 1:1 mapping, 0 unmapped), then `--apply`
(`apply_20261120.log`). Check afterwards: 0 lower-case names left in every var index, names unique,
`default_gene_expression_gene` still in var.
