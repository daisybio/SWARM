#!/usr/bin/env python
"""Add a top-level "organism" key ("human" / "mouse") to the dataset configs of 04_live.

The SWARM frontend uses it to case lower-case gene names (human LAMP5, mouse Lamp5), see
GeneSymbolService.organismCase. Idempotent: configs that already have the key are skipped.
Each changed file is backed up next to itself as <name>.bak-preorganism first.

Usage: python set_organism.py <04_live/data dir> [--dry-run]
"""
import json, shutil, sys
from pathlib import Path

# folder prefix -> organism. Every folder in 04_live/data must match one (else the run aborts).
RULES = [
    ("visual_cortex", "mouse"),   # Tasic et al. mouse VISp
    ("gbm_", "human"), ("mtg_", "human"), ("heart", "human"),
    ("breast_tnbc_pdx", "human"),  # xenograft: gene names are HGNC (human) in both files
    ("brca_visium", "human"),
]

def organism_for(folder: str):
    return next((o for p, o in RULES if folder.startswith(p)), None)

def main(root: Path, dry: bool):
    for d in sorted(p for p in root.iterdir() if p.is_dir()):
        org = organism_for(d.name)
        if org is None:
            sys.exit(f"no organism rule for folder {d.name}")
        for cfg in sorted(d.glob("*config*.json")):
            text = cfg.read_text()
            data = json.loads(text)
            if not isinstance(data, dict) or "organism" in data:
                print(f"skip   {cfg.relative_to(root)}")
                continue
            assert text.lstrip().startswith("{"), cfg
            i = text.index("{") + 1
            new = text[:i] + f'\n  "organism": "{org}",' + text[i:]
            assert json.loads(new)["organism"] == org
            print(f"{'would set' if dry else 'set'} {org:6} {cfg.relative_to(root)}")
            if not dry:
                shutil.copy2(cfg, str(cfg) + ".bak-preorganism")
                cfg.write_text(new)

if __name__ == "__main__":
    main(Path(sys.argv[1]), "--dry-run" in sys.argv)
