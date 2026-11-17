"""
Shared gene / feature name resolution.

One place decides how a gene name sent by the client is matched against a dataset, so that
`/X/{gene}`, `/X_stats/{gene}` and the spatial-correlation routes agree:

  1. exact match against var_names
  2. a unique case-insensitive match against var_names
  3. a unique case-insensitive match against var["symbol"] (when that column exists)
  4. an Ensembl gene id, translated to a symbol through the dataset's own var (see
     build_gene_symbol_map), version suffix tolerated

A name that matches several genes only through casing (e.g. `Gm1` and `GM1` in a mouse dataset)
is an error (GeneLookupError, code "gene_ambiguous"), never a silent pick. The AnnData is never
modified, and stored names are never re-cased.
"""

import re
from typing import Any, Callable, Dict, List, NamedTuple, Optional, Sequence, Union

import numpy as np
import pandas as pd

# Ensembl gene ids: ENSG00000141510 (human), ENSMUSG00000059552 (mouse), optionally carrying
# a version suffix (ENSG00000141510.17).
_ENSEMBL_ID_RE = re.compile(r"^ENS[A-Z]{0,4}G\d{6,}(?:\.\d+)?$", re.IGNORECASE)

# `var` columns that conventionally hold the Ensembl id, most specific first. `ensemble_id`
# is a misspelling that CELLxGENE-derived h5ads ship with (the builtin BRCA dataset is one),
# so it has to be listed literally rather than normalised away.
_ENSEMBL_VAR_COLUMNS = (
    "ensembl_id",
    "ensemble_id",
    "ensembl_gene_id",
    "ensembl",
    "gene_ids",
    "gene_id",
)

# ...and the ones that hold the symbol. `feature_name` is last because CELLxGENE writes
# `SYMBOL_ENSG...` into it whenever a symbol is ambiguous — usable, but only after cleanup.
_SYMBOL_VAR_COLUMNS = (
    "gene_symbol",
    "gene_symbols",
    "symbol",
    "gene_name",
    "gene_names",
    "feature_name",
)

_MISSING_SYMBOL_VALUES = {"", "nan", "none", "na", "n/a", "null", "<na>"}



def _strip_ensembl_version(gene_id: str) -> str:
    """ENSG00000141510.17 -> ENSG00000141510."""
    return gene_id.split(".", 1)[0]


def _looks_like_ensembl(values) -> bool:
    """Whether a column/index is a column of Ensembl ids, judged from a sample of it."""
    sample = [str(v) for v in list(values)[:500]]
    sample = [v for v in sample if v.strip().lower() not in _MISSING_SYMBOL_VALUES]
    if not sample:
        return False
    hits = sum(1 for v in sample if _ENSEMBL_ID_RE.match(v.strip()))
    return hits >= 0.5 * len(sample)


def _find_var_column(var: pd.DataFrame, candidates) -> Optional[str]:
    """First of `candidates` present in `var`, matched case-insensitively."""
    lowered = {str(c).lower(): str(c) for c in var.columns}
    for candidate in candidates:
        if candidate in lowered:
            return lowered[candidate]
    return None


def _clean_symbol(symbol: Any, gene_id: str) -> str:
    """Normalise one symbol, returning "" when there isn't a usable one.

    Drops the `_ENSG...` disambiguation suffix CELLxGENE appends, and rejects values that are
    themselves Ensembl ids — labelling `ENSG00000141510` as `ENSG00000141510` is just noise.
    """
    text = str(symbol).strip()
    if text.lower() in _MISSING_SYMBOL_VALUES:
        return ""
    bare_id = _strip_ensembl_version(gene_id)
    if bare_id and text.endswith(f"_{bare_id}"):
        text = text[: -(len(bare_id) + 1)]
    if not text or text.lower() in _MISSING_SYMBOL_VALUES or _ENSEMBL_ID_RE.match(text):
        return ""
    return text


def build_gene_symbol_map(adata: Any) -> Dict[str, str]:
    """Build {ensembl_id: symbol} from `adata.var`, or {} when the dataset can't support it.

    Handles both var layouts seen in practice: symbols in the index with the ids in a column
    (the builtin BRCA and Heart datasets), and ids in the index with the symbols in a column.
    Both the versioned and unversioned form of each id are emitted as keys, because networks
    and score tables are inconsistent about which they carry.
    """
    var = adata.var
    if var is None or len(var) == 0:
        return {}

    index_values = [str(v) for v in var.index]
    index_is_ensembl = _looks_like_ensembl(index_values)

    if index_is_ensembl:
        ids = index_values
        symbol_col = _find_var_column(var, _SYMBOL_VAR_COLUMNS)
        if symbol_col is None:
            return {}
        symbols = [str(v) for v in var[symbol_col].astype(str)]
    else:
        id_col = _find_var_column(var, _ENSEMBL_VAR_COLUMNS)
        if id_col is None:
            # No conventionally-named column: accept any column that is Ensembl ids.
            id_col = next(
                (str(c) for c in var.columns if _looks_like_ensembl(var[c].astype(str))),
                None,
            )
        if id_col is None:
            return {}
        ids = [str(v) for v in var[id_col].astype(str)]
        symbols = index_values

    mapping: Dict[str, str] = {}
    for gene_id, symbol in zip(ids, symbols):
        gene_id = gene_id.strip()
        if not _ENSEMBL_ID_RE.match(gene_id):
            continue
        clean = _clean_symbol(symbol, gene_id)
        if not clean:
            continue
        # setdefault, not assignment: where several rows share an id the first wins, matching
        # how the rest of the pipeline de-duplicates.
        mapping.setdefault(gene_id, clean)
        mapping.setdefault(_strip_ensembl_version(gene_id), clean)
    return mapping


class GeneLookupError(Exception):
    """A gene name that could not be resolved. `code` is stable and machine-readable."""

    def __init__(self, code: str, message: str, gene: str, candidates: Optional[List[str]] = None):
        super().__init__(message)
        self.code = code
        self.message = message
        self.gene = gene
        self.candidates = candidates or []

    def to_detail(self) -> Dict[str, Any]:
        detail: Dict[str, Any] = {"code": self.code, "message": self.message, "gene": self.gene}
        if self.candidates:
            detail["candidates"] = self.candidates
        return detail


class GeneMatch(NamedTuple):
    index: int          # position in `var_names` (column of X)
    var_name: str       # entry of var_names as stored -- use this to index the AnnData
    canonical: str      # name to display: var["symbol"] when it exists, else var_name
    matched_by: str     # "var_name" | "var_name_ci" | "symbol" | "symbol_ci" | "ensembl"


SymbolMap = Union[None, Dict[str, str], Callable[[], Dict[str, str]]]


def _canonical_symbols(var: Optional[pd.DataFrame]) -> Optional[pd.Series]:
    """var["symbol"] as strings (matched on the column name case-insensitively), or None."""
    if var is None:
        return None
    col = _find_var_column(var, ("symbol",))
    if col is None:
        return None
    return var[col].astype(str)


def _first_position(var_names: pd.Index, name: str) -> int:
    return int(np.flatnonzero(np.asarray(var_names == name))[0])


def _positions(values, target_lower: str) -> List[int]:
    lowered = pd.Index(values).astype(str).str.lower()
    return [int(i) for i in np.flatnonzero(np.asarray(lowered == target_lower))]


def resolve_gene_in(
    var_names: pd.Index,
    var: Optional[pd.DataFrame],
    gene: str,
    ensembl_map: SymbolMap = None,
) -> Optional[GeneMatch]:
    """Resolve `gene` against one var_names/var pair. None when nothing matches; raises
    GeneLookupError("gene_ambiguous") when casing alone leaves several candidates."""
    target = str(gene).strip()
    if not target:
        return None
    symbols = _canonical_symbols(var)

    def canonical(i: int) -> str:
        if symbols is not None:
            s = symbols.iloc[i].strip()
            if s.lower() not in _MISSING_SYMBOL_VALUES:
                return s
        return str(var_names[i])

    def ambiguous(positions: List[int], source: str) -> GeneLookupError:
        names = [str(var_names[i]) for i in positions[:5]]
        return GeneLookupError(
            "gene_ambiguous",
            f"Gene '{gene}' matches several {source} that differ only in case: {', '.join(names)}",
            gene,
            names,
        )

    # 1. exact var_name (first occurrence, as `adata[:, name]` would for duplicates)
    if target in var_names:
        i = _first_position(var_names, target)
        return GeneMatch(i, str(var_names[i]), canonical(i), "var_name")

    lowered = target.lower()
    # 2. unique case-insensitive var_name
    hits = _positions(var_names, lowered)
    if len(hits) == 1:
        return GeneMatch(hits[0], str(var_names[hits[0]]), canonical(hits[0]), "var_name_ci")
    if len(hits) > 1:
        raise ambiguous(hits, "genes")

    # 3. var["symbol"]: exact, then unique case-insensitive
    if symbols is not None:
        exact = [int(i) for i in np.flatnonzero((symbols == target).to_numpy())]
        if len(exact) >= 1:
            return GeneMatch(exact[0], str(var_names[exact[0]]), canonical(exact[0]), "symbol")
        hits = _positions(symbols, lowered)
        if len(hits) == 1:
            return GeneMatch(hits[0], str(var_names[hits[0]]), canonical(hits[0]), "symbol_ci")
        if len(hits) > 1:
            raise ambiguous(hits, "symbols")

    # 4. Ensembl id -> symbol (the dataset's own mapping), version suffix tolerated
    if _ENSEMBL_ID_RE.match(target):
        mapping = ensembl_map() if callable(ensembl_map) else ensembl_map
        if mapping:
            key = target.upper()
            symbol = mapping.get(key) or mapping.get(_strip_ensembl_version(key))
            if symbol is not None and symbol in var_names:
                i = _first_position(var_names, symbol)
                return GeneMatch(i, str(var_names[i]), canonical(i), "ensembl")
    return None


def _close_matches(var_names: pd.Index, var: Optional[pd.DataFrame], gene: str, limit: int = 5) -> List[str]:
    """Cheap suggestions for a gene that was not found: names that contain / are contained in it,
    case-insensitively. Prefix scan only -- no fuzzy matching over 30k names."""
    target = str(gene).strip().lower()
    if len(target) < 2:
        return []
    pools = [pd.Index(var_names).astype(str)]
    symbols = _canonical_symbols(var)
    if symbols is not None:
        pools.append(pd.Index(symbols))
    out: List[str] = []
    for pool in pools:
        low = pool.str.lower()
        mask = low.str.startswith(target) | (low == target)
        for name in pool[mask][:limit]:
            if name not in out:
                out.append(str(name))
    return out[:limit]


def resolve_gene(adata, gene: str, ensembl_map: SymbolMap = None, include_raw: bool = False, suggest: bool = True):
    """Resolve `gene` in `adata` (and, with include_raw, in adata.raw when absent from var).

    Returns (GeneMatch, source) where source is "X" or "raw" -- the matrix `match.index` indexes.
    Raises GeneLookupError: code "gene_not_found" (with up to a few `candidates`) or
    "gene_ambiguous".
    """
    if ensembl_map is None:
        ensembl_map = lambda: build_gene_symbol_map(adata)  # noqa: E731  (built lazily, only on a miss)
    match = resolve_gene_in(adata.var_names, adata.var, gene, ensembl_map)
    if match is not None:
        return match, "X"
    raw = getattr(adata, "raw", None) if include_raw else None
    if raw is not None:
        match = resolve_gene_in(raw.var_names, raw.var, gene, ensembl_map)
        if match is not None:
            return match, "raw"
    candidates = _close_matches(adata.var_names, adata.var, gene) if suggest else []
    hint = f" Did you mean: {', '.join(candidates)}?" if candidates else ""
    raise GeneLookupError("gene_not_found", f"Gene '{gene}' not found in this dataset.{hint}", str(gene), candidates)


def resolve_column(columns: Sequence[Any], name: str) -> Optional[Any]:
    """The column called `name`: exact, else a unique case-insensitive match (returned as stored).
    None if absent; GeneLookupError("column_ambiguous") when casing leaves several."""
    cols = list(columns)
    for c in cols:
        if str(c) == name:
            return c
    wanted = str(name).strip().lower()
    hits = [c for c in cols if str(c).lower() == wanted]
    if len(hits) == 1:
        return hits[0]
    if len(hits) > 1:
        names = [str(c) for c in hits[:5]]
        raise GeneLookupError(
            "column_ambiguous",
            f"Column '{name}' matches several columns that differ only in case: {', '.join(names)}",
            name,
            names,
        )
    return None
