"""Move per-cell properties that are identical for every cell out of the features.

A dataset's `obs` usually carries a lot of sample-level metadata (donor, sex, section id, ...)
that has the same value in every cell. Written into each feature's `properties` it is repeated
once per cell -- for the MTG sections roughly 40 of 73 properties and most of the file size.

`move_constant_properties()` stores each such property once under
`meta["constant_properties"]` and removes it from the features. The frontend shows them in the
cell information panel exactly as before; they no longer appear as (uniform, useless) coloring
options.

Used by `visium_to_geojson.py` for new files, and runnable on an existing file:

    python backend/geojson_compaction.py <in.geojson> <out.geojson>
"""

import sys
from typing import Any, Dict

import simplejson as json  # same as visium_to_geojson.py: needed for ignore_nan

META_KEY = "constant_properties"

# Never moved, even when constant: per-cell identity/geometry, the columns the frontend expects on
# every feature to decide what can be colored/clustered, and the placeholders it overwrites in
# place with freshly fetched per-cell values.
PROTECTED_KEYS = frozenset(
    {
        "barcode",
        "centroid",
        "leiden",
        "cell_type",
        "regulatory_scores",
        "gene_expression",
        "ligand_receptor_relationships",
        "cell_comp_tf_activity_similarity",
        "tf_activity",
        "pathway_activity",
        "chromvar_total_sum",
    }
)
PROTECTED_PREFIXES = ("motif_",)


def _is_protected(key: str) -> bool:
    return key in PROTECTED_KEYS or key.startswith(PROTECTED_PREFIXES)


def _same(a: Any, b: Any) -> bool:
    # Type-strict so 1 / 1.0 / True are not merged; NaN counts as equal to NaN.
    if type(a) is not type(b):
        return False
    if isinstance(a, float) and a != a and b != b:
        return True
    return a == b


def move_constant_properties(geojson: Dict[str, Any]) -> Dict[str, Any]:
    """Moves properties with one identical value across all features into
    `geojson["meta"]["constant_properties"]` (in place). Returns the moved {key: value} dict.

    A property is moved only if it is present on every feature with the same value. Files with
    fewer than two features are left untouched (everything would be "constant").
    """
    features = geojson.get("features") or []
    if len(features) < 2:
        return {}

    first = features[0].get("properties") or {}
    candidates = {k: v for k, v in first.items() if not _is_protected(k)}

    for feature in features[1:]:
        if not candidates:
            break
        props = feature.get("properties") or {}
        for key in [k for k, v in candidates.items() if k not in props or not _same(props[k], v)]:
            del candidates[key]

    if not candidates:
        return {}

    for feature in features:
        props = feature.get("properties") or {}
        for key in candidates:
            props.pop(key, None)

    meta = geojson.setdefault("meta", {})
    meta.setdefault(META_KEY, {}).update(candidates)
    return candidates


def main() -> None:
    if len(sys.argv) != 3:
        sys.exit(__doc__)
    src, dst = sys.argv[1], sys.argv[2]
    with open(src) as f:
        data = json.load(f)
    moved = move_constant_properties(data)
    with open(dst, "w") as f:
        json.dump(data, f, separators=(",", ":"), ignore_nan=True)
    print(f"Moved {len(moved)} constant properties to meta['{META_KEY}']: {sorted(moved)}")


if __name__ == "__main__":
    main()
