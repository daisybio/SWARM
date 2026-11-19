#!/bin/bash
# Writes backend/resources/jaspar2024_core_hsapiens_annotation.tsv: JASPAR 2024 CORE, Homo sapiens, latest versions (the exact call of
# swarm_nextflow/bin/add_motifs.R, run inside the pipeline's multiome container so the JASPAR2024 package version matches the motifs used).
# Columns: motif_id, tf_name, jaspar_class, jaspar_family, tax_group, data_type. Run: bash make_jaspar_annotation.sh (light, login node OK)
set -euo pipefail
IMG=/nfs/scratch/apptainer_cache/ghcr.io-annikafomm-swarm_nextflow-multiome-main.img
OUT=/nfs/proj/l.strasser/SWARM/swarm/backend/resources/jaspar2024_core_hsapiens_annotation.tsv
unset LOADEDMODULES _LMFILES_
/nfs/data/cluster/software/apptainer/1.3.3/bin/apptainer exec --no-home -B /nfs "$IMG" Rscript -e '
suppressMessages({library(JASPAR2024); library(TFBSTools); library(RSQLite)})
sq24 <- RSQLite::dbConnect(RSQLite::SQLite(), db(JASPAR2024()))
pfm <- TFBSTools::getMatrixSet(sq24, list(species = "Homo sapiens", collection = "CORE", all_versions = FALSE, matrixtype = "PFM"))
j <- function(x) if (length(x) == 0) "" else paste(unlist(x), collapse = "::")
df <- data.frame(motif_id = sapply(pfm, ID), tf_name = sapply(pfm, name),
                 jaspar_class = sapply(pfm, function(m) j(matrixClass(m))), jaspar_family = sapply(pfm, function(m) j(tags(m)$family)),
                 tax_group = sapply(pfm, function(m) j(tags(m)$tax_group)), data_type = sapply(pfm, function(m) j(tags(m)$type)), stringsAsFactors = FALSE)
write.table(df, "'"$OUT"'", sep = "\t", quote = FALSE, row.names = FALSE)
cat("JASPAR2024 package", as.character(packageVersion("JASPAR2024")), "| TFBSTools", as.character(packageVersion("TFBSTools")), "| motifs:", nrow(df), "\n")'
