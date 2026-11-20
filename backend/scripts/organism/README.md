# organism config key

Adds `"organism": "human" | "mouse"` to dataset configs so the frontend can case lower-case gene
names (`GeneSymbolService.organismCase`: human `LAMP5`, mouse `Lamp5`). Backend reads it in
`DatasetRegistry.dataset_from_config` (`normalize_organism`) and serves it as `metadata.organism`.
Built-in datasets also get it from `DEFAULT_DATASETS` in `main.py`.

Why: `gbm_at10_4a_mapped` (and other mapped sets) have an all-lower-case gene index
(33033/33033, e.g. `mir1302-2hg`), shown as-is in Gene & Pathway Activity > Gene Expression.

## Run log

2026-11-20, `python set_organism.py /nfs/data3/mopitas/SWARM/data/04_live/data`
(`~/.conda/envs/mybase/bin/python -I`); 28 config files changed, originals kept as
`<name>.bak-preorganism`. gbm_/mtg_/heart/breast_tnbc_pdx -> human, visual_cortex -> mouse.
Output:

```
set human  breast_tnbc_pdx_xenium/job_breast_tnbc_pdx_xenium_config.json
set human  breast_tnbc_pdx_xenium_mapped/job_breast_tnbc_pdx_xenium_mapped_config.json
set human  gbm_at10_2a_dissociated/job_at10_2a_dissociated_config.json
set human  gbm_at10_2a_mapped/job_at10_2a_mapped_config.json
set human  gbm_at10_4a_dissociated/job_at10_4a_dissociated_config.json
set human  gbm_at10_4a_mapped/job_at10_4a_mapped_config.json
set human  gbm_at11_1a_dissociated/job_at11_1a_dissociated_config.json
set human  gbm_at11_1a_mapped/job_at11_1a_mapped_config.json
set human  gbm_at3_3c_dissociated/job_at3_3c_dissociated_config.json
set human  gbm_at3_3c_mapped/job_at3_3c_mapped_config.json
set human  heart/config.json
set human  heart/job_1775659284480_config_converted.json
set human  heart/job_1775659284480_config_old.json
set human  heart/job_1776009725832_config.json
set human  heart_d7_ra_dissociated/job_heart_d7_ra_dissociated_config.json
set human  heart_d7_ra_mapped/job_heart_d7_ra_mapped_config.json
set human  heart_d8_la_dissociated/job_heart_d8_la_dissociated_config.json
set human  heart_d8_la_mapped/job_heart_d8_la_mapped_config.json
set human  heart_d8_ra_dissociated/job_heart_d8_ra_dissociated_config.json
set human  heart_d8_ra_mapped/job_heart_d8_ra_mapped_config.json
set human  mtg_h21_015_dissociated/job_mtg_h21_015_dissociated_config.json
set human  mtg_h21_015_mapped/job_mtg_h21_015_mapped_config.json
set human  mtg_h21_023_dissociated/job_mtg_h21_023_dissociated_config.json
set human  mtg_h21_023_mapped/job_mtg_h21_023_mapped_config.json
set human  mtg_h21_040_dissociated/job_mtg_h21_040_dissociated_config.json
set human  mtg_h21_040_mapped/job_mtg_h21_040_mapped_config.json
set mouse  visual_cortex/config.json
set mouse  visual_cortex/job_1786215419637_config.json
```
