#!/usr/bin/env python
"""Add JASPAR_family and JASPAR_class columns (after TF) to the ChromVar Moran's I / Geary's C tables in the metadata of existing
hexagons.geojson files in 04_live (Lena, 2026-11-19: "add jaspar annotations to the chromVar table"). New GeoJSONs get the columns from
visium_to_geojson.py (add_jaspar_columns); this patches the files built before that change. Annotation: backend/resources/
jaspar2024_core_hsapiens_annotation.tsv (make_jaspar_annotation.sh). Only the GeoJSON metadata is changed; h5ad files are not touched.
Backups go to 03_job_data/backup_04_live_20261119_jaspar/<dataset>/hexagons.geojson. Idempotent (existing columns are replaced).
Run: python patch_chromvar_tables_jaspar.py [--apply]   (dry run without --apply; log: patch_chromvar_tables_jaspar.log via tee)"""
import sys, os, json, shutil, pandas as pd

APPLY = "--apply" in sys.argv
L = "/nfs/data3/mopitas/SWARM/data/04_live/data"; BK = "/nfs/data3/mopitas/SWARM/data/03_job_data/backup_04_live_20261119_jaspar"
ANN = os.path.join(os.path.dirname(os.path.abspath(__file__)), "..", "..", "resources", "jaspar2024_core_hsapiens_annotation.tsv")
ann = pd.read_csv(ANN, sep="\t", dtype=str).set_index("motif_id"); fam, cls = ann.jaspar_family.to_dict(), ann.jaspar_class.to_dict()
KEYS = ["chromvar_moranI", "chromvar_gearyC"]

for ds in sorted(os.listdir(L)):
    gj = f"{L}/{ds}/hexagons.geojson"
    if not os.path.isdir(f"{L}/{ds}/multiome") or not os.path.exists(gj): continue
    g = json.load(open(gj)); meta = g.get("meta", {}); done = []
    for key in KEYS:
        t = meta.get(key)
        if not isinstance(t, dict) or "motif_id" not in t: continue
        rows = list(t["motif_id"].keys()); ids = {r: str(t["motif_id"][r]) for r in rows}
        f = {r: fam.get(ids[r], "") for r in rows}; c = {r: cls.get(ids[r], "") for r in rows}
        new = {}
        for col, vals in t.items():
            if col in ("JASPAR_family", "JASPAR_class"): continue
            new[col] = vals
            if col == "TF": new["JASPAR_family"] = f; new["JASPAR_class"] = c
        if "JASPAR_family" not in new: new["JASPAR_family"] = f; new["JASPAR_class"] = c
        meta[key] = new; done.append(f"{key}: {len(rows)} motifs, annotated {sum(1 for r in rows if f[r])}")
    if not done: print(f"{ds}: no chromVAR tables in the metadata"); continue
    if not APPLY: print(f"{ds}: would patch {'; '.join(done)}"); continue
    os.makedirs(f"{BK}/{ds}", exist_ok=True)
    if not os.path.exists(f"{BK}/{ds}/hexagons.geojson"): shutil.copy2(gj, f"{BK}/{ds}/hexagons.geojson")
    tmp = gj + ".tmp"; json.dump(g, open(tmp, "w"), separators=(",", ":")); os.replace(tmp, gj)
    chk = json.load(open(gj))["meta"]
    ok = all("JASPAR_family" in chk[k] and list(chk[k]).index("JASPAR_family") == list(chk[k]).index("TF") + 1 for k in KEYS if k in chk and "TF" in chk[k])
    print(f"{ds}: patched {'; '.join(done)} | re-read ok: {ok} | backup {BK}/{ds}")
print("APPLIED" if APPLY else "DRY RUN (nothing written)")
