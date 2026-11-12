# backend/spatial_correlation.py

"""
On-demand spatial correlation engine for SWARM.
Extracts per-cell continuous score matrices across regulatory and multiomic layers:
- TF Activity (AUCell / Decoupler / DoRothEA)
- chromVAR Motif Deviations / z-scores
- Pathway Activity (PROGENy / PROSITY)
- Filtered continuous numeric obs attributes (excluding spatial coordinates, IDs, and constant metadata)

Calculates pairwise Pearson correlation, Spearman rank correlation, and Bivariate Moran's I
spatial co-location scores, and detects circularity / dependency relationships between features.

TODO (Performance optimization):
If dataset sizes increase significantly and on-demand calculation becomes a bottleneck,
pre-compute or cache pairwise correlation matrices during dataset ingestion / backend startup.
"""

import re
from typing import Any, Dict, List, Optional, Set, Tuple
import numpy as np
import pandas as pd
from scipy import sparse, stats
import scanpy as sc

from gene_lookup import GeneLookupError, resolve_gene

# Default k for spatial k-nearest neighbors in Bivariate Moran's I
DEFAULT_SPATIAL_KNN = 6

# Known spatial coordinates, image indices, and record identifiers to exclude from obs metadata
KNOWN_NON_ATTRIBUTE_KEYS: Set[str] = {
    "barcode",
    "centroid",
    "observation_joinid",
    "cell_id",
    "id",
    "guid",
    "array_row",
    "array_col",
    "arrayrow",
    "arraycol",
    "array_x",
    "array_y",
    "array row",
    "array col",
    "spatial_x",
    "spatial_y",
    "spatial_row",
    "spatial_col",
    "x_original",
    "y_original",
    "original_x",
    "original_y",
    "orig_x",
    "orig_y",
    "x_orig",
    "y_orig",
    "_x",
    "_y",
    "__x",
    "__y",
    "x",
    "y",
    "pxl_col_in_fullres",
    "pxl_row_in_fullres",
    "pxl_col",
    "pxl_row",
    "pixel_x",
    "pixel_y",
    "imagecol",
    "imagerow",
    "image_col",
    "image_row",
    "image_x",
    "image_y",
    "x_coord",
    "y_coord",
    "coord_x",
    "coord_y",
    "coords_x",
    "coords_y",
    "center_x",
    "center_y",
    "centroid_x",
    "centroid_y",
    "x_centroid",
    "y_centroid",
    "grid_x",
    "grid_y",
    "grid_row",
    "grid_col",
    "spot_x",
    "spot_y",
    "spot_row",
    "spot_col",
}

# Known internal/state properties mapped to other dedicated tabs
RESERVED_TAB_KEYS: Set[str] = {
    "leiden",
    "leiden_centrality",
    "leiden_co_occurrence",
    "leiden_nhood_enrichment",
    "degree_centrality",
    "average_clustering",
    "closeness_centrality",
    "co_occurrence",
    "regulatory_scores",
    "aucell_genie3",
    "aucell_sponge",
    "ligand_receptor_relationships",
    "cell_comp_tf_activity_similarity",
    "tf_activity",
    "pathway_activity",
    "gene_expression",
    "chromvar_total_sum",
    "chromvar_moranI",
    "chromvar_gearyC",
    "diff_motif_activity_top_motifs",
    "color",
}


def is_spatial_or_identifier_key(key: str) -> bool:
    """Matches the exact exclusions used across SWARM attribute selection (attribute-filters.ts)."""
    if not key:
        return True
    lower = key.lower().strip()
    if lower in KNOWN_NON_ATTRIBUTE_KEYS:
        return True
    if re.match(r"^_+[xy]$", lower) or re.match(r"^[xy]$", lower):
        return True
    if re.match(r"^(?:spatial|array|grid|pxl|pixel|image|orig(?:inal)?|center|centroid|spot|coord|pos)_(?:x|y|row|col)$", lower):
        return True
    if re.match(r"^(?:x|y)_(?:orig(?:inal)?|coord|centroid|spatial|grid|pixel|pxl|pos|index)$", lower):
        return True
    return False


def is_reserved_tab_key(key: str) -> bool:
    """Excludes keys reserved for other dedicated UI tabs or raw network scores."""
    lower = key.lower().strip()
    if lower in RESERVED_TAB_KEYS or key in RESERVED_TAB_KEYS:
        return True
    if lower.endswith("_genie3") or lower.endswith("_sponge"):
        return True
    return False


class CorrelationError(Exception):
    """A correlation request that cannot be answered. `code` is a stable machine-readable
    identifier, `message` is for people, `status` is the HTTP status the route should use.

    Codes: gene_not_found, gene_ambiguous (409), feature_table_not_found, feature_column_not_found,
    feature_not_found (all 404); feature_not_numeric, feature_constant, feature_all_missing,
    too_few_observations, no_shared_cells (all 422)."""

    def __init__(self, code: str, message: str, status: int = 422, **details: Any):
        super().__init__(message)
        self.code = code
        self.message = message
        self.status = status
        self.details = {k: v for k, v in details.items() if v is not None}

    def to_body(self) -> Dict[str, Any]:
        # "detail" (a string) keeps clients that read FastAPI's usual error shape working.
        return {"detail": self.message, "error": {"code": self.code, "message": self.message, **self.details}}


def _gene_error(err: GeneLookupError) -> CorrelationError:
    status = 409 if err.code == "gene_ambiguous" else 404
    return CorrelationError(err.code, err.message, status, gene=err.gene, candidates=err.candidates)


def _extract_raw(matrix: Any, index: int) -> np.ndarray:
    """Extract 1D float array (NaN / inf kept, so missing data can be told from zeros)."""
    if sparse.issparse(matrix):
        vec = matrix[:, index].toarray().ravel()
    else:
        vec = np.asarray(matrix[:, index]).ravel()
    # float16 / float32 matrices (X stored as float16 to save space): do all statistics in float64,
    # otherwise np.std underflows and Moran's I is wrong for low-expressed genes
    if vec.dtype.kind == "f" and vec.dtype != np.float64:
        vec = vec.astype(np.float64)
    return vec


def _is_all_missing(vec: np.ndarray) -> bool:
    return vec.dtype.kind == "f" and len(vec) > 0 and not np.isfinite(vec).any()


def _extract_vector(matrix: Any, index: int, missing: Optional[List[bool]] = None) -> np.ndarray:
    """Extract 1D dense float array from sparse matrix or numpy array at given index.
    NaN/inf become 0.0; if `missing` is a list, whether the column was entirely NaN is appended."""
    vec = _extract_raw(matrix, index)
    if missing is not None:
        missing.append(_is_all_missing(vec))
    return np.nan_to_num(vec, nan=0.0, posinf=0.0, neginf=0.0)


def extract_all_score_features(adata: sc.AnnData) -> Dict[str, Dict[str, Any]]:
    """
    Scans an AnnData object for available continuous per-cell score layers:
    1. TF Activity (AUCell / regulons)
    2. ChromVAR Motif Deviations / z-scores
    3. Pathway Activity (PROGENy / PROSITY)
    4. Filtered meaningful numeric obs metadata attributes
    """
    features: Dict[str, Dict[str, Any]] = {}

    # 1. TF Activity (AUCell / Decoupler / DoRothEA)
    for obsm_key in ['aucell_scores', 'tf_activity', 'dorothea', 'tf_auc']:
        if obsm_key in adata.obsm:
            obsm_data = adata.obsm[obsm_key]
            colnames = None
            if isinstance(obsm_data, pd.DataFrame):
                colnames = list(obsm_data.columns)
                matrix = obsm_data.values
            elif f"{obsm_key}_colnames" in adata.uns:
                colnames = list(adata.uns[f"{obsm_key}_colnames"])
                matrix = obsm_data
            elif f"{obsm_key}_names" in adata.uns:
                colnames = list(adata.uns[f"{obsm_key}_names"])
                matrix = obsm_data
            else:
                matrix = obsm_data
                colnames = [f"TF_{i}" for i in range(matrix.shape[1])]

            for idx, col in enumerate(colnames):
                fid = f"tf_activity::{col}"
                col_name = str(col)
                symbol = col_name.replace("TF_", "").strip()
                features[fid] = {
                    "id": fid,
                    "name": f"TF: {col_name}",
                    "category": "tf_activity",
                    "symbol": symbol.upper(),
                    "obsm_key": obsm_key,
                    "col_idx": idx
                }

    # 2. ChromVAR Motif Deviations / z-scores
    for obsm_key in ['chromvar_deviations', 'chromvar_zscores', 'chromvar', 'motif_deviations']:
        if obsm_key in adata.obsm:
            obsm_data = adata.obsm[obsm_key]
            colnames = None
            if isinstance(obsm_data, pd.DataFrame):
                colnames = list(obsm_data.columns)
                matrix = obsm_data.values
            elif f"{obsm_key}_colnames" in adata.uns:
                colnames = list(adata.uns[f"{obsm_key}_colnames"])
                matrix = obsm_data
            elif f"{obsm_key}_names" in adata.uns:
                colnames = list(adata.uns[f"{obsm_key}_names"])
                matrix = obsm_data
            else:
                matrix = obsm_data
                colnames = [f"Motif_{i}" for i in range(matrix.shape[1])]

            for idx, col in enumerate(colnames):
                fid = f"chromvar::{col}"
                col_name = str(col)
                symbol = col_name.replace("Motif_", "").replace("_zscore", "").strip()
                features[fid] = {
                    "id": fid,
                    "name": f"Motif: {col_name}",
                    "category": "chromvar",
                    "symbol": symbol.upper(),
                    "obsm_key": obsm_key,
                    "col_idx": idx
                }

    # 3. Pathway Activity
    for obsm_key in ['pathway_activity', 'progeny', 'pathway_scores']:
        if obsm_key in adata.obsm:
            obsm_data = adata.obsm[obsm_key]
            colnames = None
            if isinstance(obsm_data, pd.DataFrame):
                colnames = list(obsm_data.columns)
                matrix = obsm_data.values
            elif f"{obsm_key}_colnames" in adata.uns:
                colnames = list(adata.uns[f"{obsm_key}_colnames"])
                matrix = obsm_data
            else:
                matrix = obsm_data
                colnames = [f"Pathway_{i}" for i in range(matrix.shape[1])]

            for idx, col in enumerate(colnames):
                fid = f"pathway::{col}"
                col_name = str(col)
                features[fid] = {
                    "id": fid,
                    "name": f"Pathway: {col_name}",
                    "category": "pathway",
                    "symbol": col_name.upper(),
                    "obsm_key": obsm_key,
                    "col_idx": idx
                }

    # 4. Meaningful Continuous Numeric Obs Attributes (strictly filtered)
    for col in adata.obs.columns:
        if is_spatial_or_identifier_key(col) or is_reserved_tab_key(col):
            continue

        # Only select numeric columns
        if not pd.api.types.is_numeric_dtype(adata.obs[col]):
            continue

        col_series = pd.to_numeric(adata.obs[col], errors='coerce').dropna()
        if len(col_series) < 2 or col_series.nunique() <= 1:
            continue

        var_val = float(col_series.var())
        if var_val <= 1e-12:
            continue

        pretty_label = col.replace("_", " ").title()
        fid = f"obs::{col}"
        features[fid] = {
            "id": fid,
            "name": f"Obs: {pretty_label}",
            "category": "obs_metadata",
            "symbol": col.upper(),
            "obs_col": col
        }

    return features


def get_feature_vector(adata: sc.AnnData, feature_info: Dict[str, Any], missing: Optional[List[bool]] = None) -> np.ndarray:
    """Retrieves the 1D numeric vector for a given feature_info dict from AnnData."""
    if "obsm_key" in feature_info:
        obsm_data = adata.obsm[feature_info["obsm_key"]]
        if isinstance(obsm_data, pd.DataFrame):
            matrix = obsm_data.values
        else:
            matrix = obsm_data
        return _extract_vector(matrix, feature_info["col_idx"], missing)
    elif "obs_col" in feature_info:
        raw = pd.to_numeric(adata.obs[feature_info["obs_col"]], errors='coerce').values.astype(float)
        if missing is not None:
            missing.append(_is_all_missing(raw))
        return np.nan_to_num(raw, nan=0.0, posinf=0.0, neginf=0.0)
    else:
        return np.zeros(adata.n_obs, dtype=float)


def build_spatial_weight_matrix(adata_or_coords: Any, k: int = DEFAULT_SPATIAL_KNN) -> sparse.csr_matrix:
    """Builds a spatial k-nearest neighbor row-standardized weight matrix W.

    Accepts either an AnnData (uses its own obsm coordinates) or a raw coordinate array directly
    -- the latter is what cross-dataset correlation needs, since Bivariate Moran's I there must be
    computed over just the cells common to both datasets, not adata.obsm['spatial'] in full.
    """
    if isinstance(adata_or_coords, np.ndarray):
        coords = adata_or_coords
        n_obs = coords.shape[0]
    else:
        adata = adata_or_coords
        coords = None
        if 'spatial' in adata.obsm:
            coords = adata.obsm['spatial']
        elif 'spatial_grid' in adata.obsm:
            coords = adata.obsm['spatial_grid']
        elif 'X_umap' in adata.obsm:
            coords = adata.obsm['X_umap']
        n_obs = adata.n_obs
    if coords is None or n_obs < 2:
        return sparse.csr_matrix((n_obs, n_obs))

    from sklearn.neighbors import NearestNeighbors
    nbrs = NearestNeighbors(n_neighbors=min(k + 1, n_obs), algorithm='auto').fit(coords)
    distances, indices = nbrs.kneighbors(coords)

    row_ind = []
    col_ind = []
    data = []

    for i in range(n_obs):
        nn_indices = indices[i, 1:]
        nn_dists = distances[i, 1:]
        weights = 1.0 / (nn_dists + 1e-6)
        weights_norm = weights / np.sum(weights)

        for j_idx, weight in zip(nn_indices, weights_norm):
            row_ind.append(i)
            col_ind.append(j_idx)
            data.append(weight)

    W = sparse.csr_matrix((data, (row_ind, col_ind)), shape=(n_obs, n_obs))
    return W


def compute_bivariate_morans_i(x: np.ndarray, y: np.ndarray, W: sparse.csr_matrix) -> float:
    """Computes Bivariate Moran's I (I_xy) for two spatial vectors x and y."""
    std_x = np.std(x)
    std_y = np.std(y)
    if std_x == 0 or std_y == 0:
        return 0.0

    z_x = (x - np.mean(x)) / std_x
    z_y = (y - np.mean(y)) / std_y

    N = len(x)
    if N <= 1 or W.nnz == 0:
        return 0.0

    W_zy = W.dot(z_y)
    bivariate_i = float(np.dot(z_x, W_zy) / (N - 1))
    return float(np.clip(bivariate_i, -1.0, 1.0))


def check_circularity_dependency(feat_a: Dict[str, Any], feat_b: Dict[str, Any]) -> Tuple[bool, str]:
    """
    Checks whether two features have potential circularity or direct computational dependency.
    """
    if feat_a["id"] == feat_b["id"]:
        return True, "Identical feature self-comparison"

    sym_a = feat_a.get("symbol", "").upper()
    sym_b = feat_b.get("symbol", "").upper()

    cat_a = feat_a.get("category")
    cat_b = feat_b.get("category")

    if sym_a and sym_b and sym_a == sym_b:
        if (cat_a == "chromvar" and cat_b == "tf_activity") or (cat_b == "chromvar" and cat_a == "tf_activity"):
            return False, "Independent multiomic cross-layer (RNA Regulon vs ATAC Motif)"
        if cat_a == cat_b:
            return True, f"Both metrics measure the same symbol '{sym_a}' in the same layer"

    return False, "Independent cross-layer comparison"


def compute_spatial_correlation_matrix(adata: sc.AnnData, selected_genes=None) -> Dict[str, Any]:
    """
    Computes full pairwise spatial correlation summary matrices for all available features.
    Fully vectorized in NumPy / SciPy for sub-50ms performance.
    """
    features = extract_all_score_features(adata)

    # Existing obs and score features
    feat_list = list(features.values())
    vectors = [get_feature_vector(adata, f) for f in feat_list]

    # Add selected genes on demand
    for gene in dict.fromkeys(selected_genes or []):
        # resolve_feature_or_dynamic does the (case-insensitive) gene lookup and raises a
        # CorrelationError (gene_not_found / gene_ambiguous) that the route turns into a JSON error.
        feature_id = f"gene_expression::{gene}"

        gene_info, gene_vector = resolve_feature_or_dynamic(
            adata,
            feature_id,
            features
        )

        feat_list.append(gene_info)
        vectors.append(gene_vector)

    n_feats = len(feat_list)

    if n_feats == 0:
        return {
            "features": [],
            "pearson_matrix": [],
            "moran_matrix": [],
            "circularity_matrix": []
        }
    W = build_spatial_weight_matrix(adata)
    n_obs = adata.n_obs

    # Standardize all vectors
    z_vectors = []
    for v in vectors:
        std = float(np.std(v))
        if std > 0:
            z = (v - np.mean(v)) / std
        else:
            z = np.zeros_like(v)
        z_vectors.append(z)

    # 1. Pearson matrix (vectorized dot product of normalized Z)
    Z = np.array(z_vectors)  # shape (n_feats, n_obs)
    if n_obs > 1:
        pearson_mat = np.dot(Z, Z.T) / (n_obs - 1)
        pearson_mat = np.clip(np.nan_to_num(pearson_mat, nan=0.0), -1.0, 1.0)
    else:
        pearson_mat = np.zeros((n_feats, n_feats), dtype=float)

    # 2. Bivariate Moran's I matrix (precompute W.dot(z) once per feature: n_feats multiplications total)
    moran_mat = np.zeros((n_feats, n_feats), dtype=float)
    if n_obs > 1 and W.nnz > 0:
        W_z = np.array([W.dot(z) for z in z_vectors])  # shape (n_feats, n_obs)
        moran_mat = np.dot(Z, W_z.T) / (n_obs - 1)
        moran_mat = np.clip(np.nan_to_num(moran_mat, nan=0.0), -1.0, 1.0)

    # 3. Circularity matrix
    circ_mat = []
    for i in range(n_feats):
        circ_row = []
        for j in range(n_feats):
            is_circ, reason = check_circularity_dependency(feat_list[i], feat_list[j])
            circ_row.append({"is_dependent": is_circ, "reason": reason})
        circ_mat.append(circ_row)

    feature_meta = [
        {
            "id": f["id"],
            "name": f["name"],
            "category": f["category"],
            "symbol": f.get("symbol", "")
        }
        for f in feat_list
    ]

    return {
        "features": feature_meta,
        "pearson_matrix": pearson_mat.tolist(),
        "moran_matrix": moran_mat.tolist(),
        "circularity_matrix": circ_mat
    }


def extract_obsm_vector(adata: sc.AnnData, obsm_key: str, col_identifier: Any, missing: Optional[List[bool]] = None) -> Optional[np.ndarray]:
    if obsm_key not in adata.obsm:
        return None
    obsm_data = adata.obsm[obsm_key]
    colnames = None
    matrix = None
    if isinstance(obsm_data, pd.DataFrame):
        colnames = list(obsm_data.columns)
        matrix = obsm_data.values
    elif f"{obsm_key}_colnames" in adata.uns:
        colnames = list(adata.uns[f"{obsm_key}_colnames"])
        matrix = obsm_data
    elif f"{obsm_key}_names" in adata.uns:
        colnames = list(adata.uns[f"{obsm_key}_names"])
        matrix = obsm_data
    else:
        matrix = obsm_data
        if hasattr(matrix, 'shape') and len(matrix.shape) == 2:
            colnames = [str(i) for i in range(matrix.shape[1])]

    def _extract_if_numeric(idx: int) -> Optional[np.ndarray]:
        vec = _extract_vector(matrix, idx, missing)
        # A non-numeric obsm column (e.g. a categorical similarity/classification label like
        # "cell_comp_tf_activity_category") comes back here as an object/string array rather than
        # raising -- np.nan_to_num silently passes it through -- and only fails much later with a
        # confusing raw "unsupported operand type(s) for /: 'str' and 'int'" from scipy deep inside
        # the correlation math. Treat it as not-found here instead, same as the obs-column guards
        # in resolve_feature_or_dynamic, so it surfaces as a clear "feature not found" error.
        return vec if np.issubdtype(vec.dtype, np.number) else None

    if colnames is not None and matrix is not None:
        target = str(col_identifier).strip()
        str_cols = [str(c).strip() for c in colnames]
        if target in str_cols:
            idx = str_cols.index(target)
            return _extract_if_numeric(idx)
        # Try case-insensitive or stripped match
        target_lower = target.lower()
        for idx, c in enumerate(str_cols):
            if c.lower() == target_lower:
                return _extract_if_numeric(idx)
        if isinstance(col_identifier, int) and 0 <= col_identifier < matrix.shape[1]:
            return _extract_if_numeric(col_identifier)
    return None


def _find_gene(adata: sc.AnnData, gene: str) -> Optional[Tuple[str, Any, int]]:
    """Locates `gene` with the shared lookup (gene_lookup.resolve_gene: exact var_name, unique
    case-insensitive var_name, unique case-insensitive var['symbol'], Ensembl id), in adata.var_names
    and then adata.raw.var_names. Returns (canonical name, expression matrix, column index), or None
    if the gene is in neither. Raises GeneLookupError when the name is ambiguous."""
    try:
        match, source = resolve_gene(adata, gene, include_raw=True, suggest=False)
    except GeneLookupError as err:
        if err.code == "gene_not_found":
            return None
        raise
    return match.canonical, (adata.X if source == "X" else adata.raw.X), match.index


def _not_found_error(adata: sc.AnnData, feature_id: str, category: str, symbol: str, sub_col: Optional[str], gene_err: Optional[GeneLookupError]) -> CorrelationError:
    """The most specific error for a feature id that nothing resolved."""
    if gene_err is not None:
        return _gene_error(gene_err)
    if category == "obsm" or category in adata.obsm:
        table = symbol if category == "obsm" else category
        column = sub_col if category == "obsm" else symbol
        if table not in adata.obsm:
            return CorrelationError(
                "feature_table_not_found", f"Feature table '{table}' does not exist in this dataset.", 404,
                table=table, feature_id=feature_id,
            )
        return CorrelationError(
            "feature_column_not_found", f"Column '{column}' does not exist in feature table '{table}'.", 404,
            table=table, column=column, feature_id=feature_id,
        )
    if category in ("obs", "obs_metadata"):
        return CorrelationError(
            "feature_column_not_found", f"Column '{symbol}' does not exist in the cell metadata (obs).", 404,
            table="obs", column=symbol, feature_id=feature_id,
        )
    if "::" not in feature_id:
        # A bare name that is neither a metadata column nor a score column: most likely a gene
        try:
            resolve_gene(adata, symbol, include_raw=True)
        except GeneLookupError as err:
            return _gene_error(err)
    return CorrelationError("feature_not_found", f"Feature '{feature_id}' not found in dataset.", 404, feature_id=feature_id)


# Map colour-by views that are derived from an obsm table when the geojson is built
# (visium_to_geojson.py) rather than stored as columns. view -> candidate obsm tables.
DERIVED_VIEWS = {
    "chromvar_total_sum": ("chromvar_activity", "chromvar_spot_scores"),
    "pathway_activity": ("pathway_activity_score_mlm",),
    "tf_activity": ("tf_activity_score_ulm",),
}


def _resolve_derived_view(adata: sc.AnnData, view: str, feature_id: str) -> Optional[Tuple[Dict[str, Any], np.ndarray]]:
    """Reproduces what the map shows for a derived colour-by view, so the correlation drawer's
    default feature matches the map: chromvar_total_sum is the per-cell sum over all motifs;
    pathway_activity / tf_activity show the table's first column (visium_to_geojson.get_obsm
    default). Returns None when the underlying table is absent."""
    for key in DERIVED_VIEWS[view]:
        if key not in adata.obsm:
            continue
        table = adata.obsm[key]
        matrix = table.values if isinstance(table, pd.DataFrame) else np.asarray(table)
        if matrix.ndim != 2 or matrix.shape[1] == 0 or not np.issubdtype(matrix.dtype, np.number):
            continue
        matrix = matrix.astype(float)
        if view == "chromvar_total_sum":
            raw = np.nansum(matrix, axis=1)
            name = "ChromVAR: total sum over all motifs"
        else:
            raw = matrix[:, 0]
            if isinstance(table, pd.DataFrame):
                col = str(table.columns[0])
            else:
                names = adata.uns.get(f"{key}_colnames", adata.uns.get(f"{key}_names"))
                col = str(list(names)[0]) if names is not None and len(names) else "column 0"
            name = f"{view.replace('_', ' ').title()}: {col} (map default)"
        feat = {
            "id": feature_id,
            "name": name,
            "category": view,
            "symbol": view.upper(),
            "obsm_key": key,
            "all_missing": _is_all_missing(raw),
        }
        return feat, np.nan_to_num(raw, nan=0.0, posinf=0.0, neginf=0.0)
    return None


def resolve_feature_or_dynamic(adata: sc.AnnData, feature_id: str, all_features: Dict[str, Any]) -> Tuple[Dict[str, Any], np.ndarray]:
    """Resolves a feature id to (feature info, vector). Raises CorrelationError for anything that
    cannot be resolved; info["all_missing"] is True when the source column held no finite value
    (the vector is then all zeros)."""
    missing: List[bool] = []
    if feature_id in all_features:
        feat = all_features[feature_id]
        vec = get_feature_vector(adata, feat, missing)
        if np.std(vec) > 0 or len(vec) > 0:
            return {**feat, "all_missing": bool(missing and missing[-1])}, vec

    parts = feature_id.split("::")
    category = parts[0]
    symbol = parts[1] if len(parts) > 1 else feature_id
    sub_col = parts[2] if len(parts) > 2 else None

    # 1. Specified obsm key (e.g. obsm::lr_scores::COL12A1^ITGA11_ITGB1 or obsm::aucell_scores_genie3::B-cells)
    if (category == "obsm" or category in adata.obsm) and (sub_col or symbol):
        ob_key = symbol if category == "obsm" else category
        col_target = sub_col if category == "obsm" else symbol
        vec = extract_obsm_vector(adata, ob_key, col_target, missing)
        if vec is not None:
            feat = {
                "id": feature_id,
                "name": f"{ob_key.replace('_', ' ').title()}: {col_target}",
                "category": category,
                "symbol": str(col_target).upper(),
                "obsm_key": ob_key,
                "all_missing": bool(missing and missing[-1]),
            }
            return feat, vec
        missing.clear()
        # An obsm column that exists but is not numeric (a label table) is not a gene either
        if ob_key in adata.obsm and extract_obsm_vector_present(adata, ob_key, col_target):
            raise CorrelationError(
                "feature_not_numeric", f"'{col_target}' in feature table '{ob_key}' holds labels, not numeric values.", 422,
                table=ob_key, column=str(col_target), feature_id=feature_id,
            )

    # 1b. Derived map views. The map's colour-by properties `chromvar_total_sum`, `pathway_activity`
    # and `tf_activity` are computed while building the geojson and are not stored in the h5ad,
    # but the drawer's default feature (before any table row is picked) is `obs::<view>`.
    if category in ("obs", "obs_metadata") and symbol in DERIVED_VIEWS:
        derived = _resolve_derived_view(adata, symbol, feature_id)
        if derived is not None:
            return derived

    # 2. Dynamic Gene Expression
    # Gene names go through the shared lookup (gene_lookup.py): datasets differ in casing convention
    # (a mapped dataset may store `gfap` where its dissociated counterpart has `GFAP`), and the drawer
    # sends whatever casing the gene was picked with -- often from the *other* dataset in compare
    # mode -- or an Ensembl id.
    gene_err: Optional[GeneLookupError] = None
    try:
        gene_source = _find_gene(adata, symbol)
    except GeneLookupError as err:
        gene_source, gene_err = None, err
    if category == "gene_expression" and gene_source is None:
        # Never fall back to an all-zero vector here: that is indistinguishable from a real,
        # unexpressed gene and yields a plausible-looking (flat, r = 0) result.
        if gene_err is not None:
            raise _gene_error(gene_err)
        try:
            resolve_gene(adata, symbol, include_raw=True)
        except GeneLookupError as err:
            raise _gene_error(err)
    if gene_source is not None:
        gene, matrix, idx = gene_source
        vec = _extract_vector(matrix, idx, missing)

        feat = {
            "id": feature_id,
            "name": f"Gene: {gene}",
            "category": "gene_expression",
            "symbol": gene.upper(),
            "all_missing": bool(missing and missing[-1]),
        }
        return feat, vec

    # 3. Dynamic Obs Metadata
    # is_numeric_dtype guard: a categorical column (leiden, cell_type, ...) coerced through
    # pd.to_numeric(errors='coerce').fillna(0.0) doesn't fail loudly, it silently becomes an
    # all-zero vector -- indistinguishable from a real, flat feature. This matters here more than
    # it would look like it should, because the live-correlation drawer's default feature (before
    # the user has picked a real one from a table) is whatever's currently colored on the map,
    # which is leiden/cell_type on first load -- so this path used to be reached on every fresh
    # drawer open, correlating against fabricated zeros instead of surfacing "pick a feature".
    def _obs_feature() -> Tuple[Dict[str, Any], np.ndarray]:
        raw = pd.to_numeric(adata.obs[symbol], errors='coerce').values.astype(float)
        feat = {
            "id": feature_id,
            "name": f"Obs: {symbol.replace('_', ' ').title()}",
            "category": "obs_metadata",
            "symbol": symbol.upper(),
            "all_missing": _is_all_missing(raw),
        }
        return feat, np.nan_to_num(raw, nan=0.0, posinf=0.0, neginf=0.0)

    if (
        (category == "obs" or category == "obs_metadata")
        and symbol in adata.obs.columns
        and pd.api.types.is_numeric_dtype(adata.obs[symbol])
    ):
        return _obs_feature()

    # 4. Search ALL obsm matrices in adata for symbol or sub_col
    search_target = sub_col or symbol
    for ob_key in adata.obsm.keys():
        if ob_key in ['spatial', 'spatial_grid', 'X_umap', 'X_pca', 'X_tsne', 'X_diffmap']:
            continue
        missing.clear()
        vec = extract_obsm_vector(adata, ob_key, search_target, missing)
        if vec is not None and np.std(vec) > 0:
            feat = {
                "id": feature_id,
                "name": f"{ob_key.replace('_', ' ').title()}: {search_target}",
                "category": ob_key,
                "symbol": str(search_target).upper(),
                "obsm_key": ob_key,
                "all_missing": bool(missing and missing[-1]),
            }
            return feat, vec

    # 5. Search obs columns as fallback
    if symbol in adata.obs.columns and pd.api.types.is_numeric_dtype(adata.obs[symbol]):
        return _obs_feature()

    # Nothing numeric matched this id. Note this can legitimately happen for a categorical column
    # that *does* exist (leiden, cell_type, ...) -- steps 3/5 above deliberately skip those rather
    # than "resolving" them into a meaningless all-zero vector, so raise here instead of returning
    # one, so the caller gets a clear error instead of a scatterplot that looks like real (flat)
    # data.
    if symbol in adata.obs.columns:
        raise CorrelationError(
            "feature_not_numeric",
            f"'{symbol}' is a categorical label (e.g. cluster/cell type), not a numeric "
            f"score -- pick a specific gene or score to correlate instead.",
            422, table="obs", column=symbol, feature_id=feature_id,
        )
    raise _not_found_error(adata, feature_id, category, symbol, sub_col, gene_err)


def extract_obsm_vector_present(adata: sc.AnnData, obsm_key: str, col_identifier: Any) -> bool:
    """Whether obsm[obsm_key] has a column called `col_identifier` (numeric or not)."""
    obsm_data = adata.obsm[obsm_key]
    if isinstance(obsm_data, pd.DataFrame):
        cols = [str(c).strip().lower() for c in obsm_data.columns]
    elif f"{obsm_key}_colnames" in adata.uns:
        cols = [str(c).strip().lower() for c in adata.uns[f"{obsm_key}_colnames"]]
    elif f"{obsm_key}_names" in adata.uns:
        cols = [str(c).strip().lower() for c in adata.uns[f"{obsm_key}_names"]]
    else:
        return False
    return str(col_identifier).strip().lower() in cols


# Pearson needs at least 3 points; fewer is not a correlation
MIN_OBSERVATIONS = 3


def _canonical_name(feat: Dict[str, Any]) -> str:
    name = feat["name"]
    return name.split(": ", 1)[1] if feat.get("category") == "gene_expression" and ": " in name else name


def _resolve_side(adata: sc.AnnData, feature_id: str, all_features: Dict[str, Any], side: str):
    """resolve_feature_or_dynamic, tagging a CorrelationError with which side ("a"/"b") failed."""
    try:
        return resolve_feature_or_dynamic(adata, feature_id, all_features)
    except CorrelationError as err:
        err.details.setdefault("side", side)
        err.details.setdefault("feature_id", feature_id)
        raise


def get_pair_scatter_data(
    adata: sc.AnnData,
    feature_id_a: str,
    feature_id_b: str,
    adata_b: Optional[sc.AnnData] = None,
) -> Dict[str, Any]:
    """
    Computes cell-by-cell scatterplot vectors and regression stats for a selected pair of features.

    `adata_b` is the compare-view dataset when the Live Correlation drawer's two features come from
    different datasets (e.g. main map vs. compare map showing separate builtin/uploaded datasets).
    Defaults to `adata` itself when the pair is two properties of the same dataset. Cross-dataset
    pairs are only comparable where the two datasets actually share cells/spots (e.g. a Tangram
    -mapped object and its real-spatial counterpart for the same tissue, which keep the same
    obs_names) -- resolving feature_id_b against a wholly different adata_b without this would
    silently produce an all-zero vector via resolve_feature_or_dynamic's final fallback, since the
    feature would never be found there.
    """
    adata_b = adata if adata_b is None else adata_b
    same_dataset = adata_b is adata

    all_features_a = extract_all_score_features(adata)
    all_features_b = all_features_a if same_dataset else extract_all_score_features(adata_b)
    # resolve_feature_or_dynamic handles: pre-extracted features, gene_expression, obs/obs_metadata
    # and returns both the feat dict AND the already-extracted vector. Do NOT re-call
    # get_feature_vector afterwards — that only handles obsm_key/obs_col and would return zeros
    # for any dynamically-resolved feature (e.g. obs::ligand_receptor_relationships).
    feat_a, vec_a_full = _resolve_side(adata, feature_id_a, all_features_a, "a")
    feat_b, vec_b_full = _resolve_side(adata_b, feature_id_b, all_features_b, "b")

    if same_dataset:
        common_ids = list(adata.obs_names)
        idx_a = np.arange(len(common_ids))
        vec_a, vec_b = vec_a_full, vec_b_full
        spatial_coords = adata.obsm.get('spatial')
        cluster_source, cluster_idx = adata, idx_a
    else:
        names_a = pd.Index(adata.obs_names)
        names_b = pd.Index(adata_b.obs_names)
        common_ids = names_a.intersection(names_b)
        if len(common_ids) == 0:
            raise CorrelationError(
                "no_shared_cells",
                "The main and compare datasets don't share any cells/spots to correlate -- "
                "cross-dataset correlation only works between two views of the same underlying "
                "tissue (e.g. Tangram-mapped vs. real-spatial).",
                422,
            )
        idx_a = names_a.get_indexer(common_ids)
        idx_b = names_b.get_indexer(common_ids)
        vec_a, vec_b = vec_a_full[idx_a], vec_b_full[idx_b]
        spatial_coords = adata.obsm['spatial'][idx_a] if 'spatial' in adata.obsm else None
        cluster_source, cluster_idx = adata, idx_a

    if len(vec_a) < MIN_OBSERVATIONS:
        raise CorrelationError(
            "too_few_observations",
            f"Only {len(vec_a)} overlapping observation(s); at least {MIN_OBSERVATIONS} are needed to correlate.",
            422, n_observations=int(len(vec_a)), min_observations=MIN_OBSERVATIONS,
        )
    for side, feat, vec in (("a", feat_a, vec_a), ("b", feat_b, vec_b)):
        if feat.get("all_missing"):
            raise CorrelationError(
                "feature_all_missing", f"Feature '{feat['name']}' has no values (all missing) in this dataset.", 422,
                side=side, feature_id=feat["id"], name=feat["name"],
            )
        if not np.std(vec) > 0:
            raise CorrelationError(
                "feature_constant",
                f"Feature '{feat['name']}' is constant over the compared observations (no variance), so it cannot be correlated.",
                422, side=side, feature_id=feat["id"], name=feat["name"],
            )

    if np.std(vec_a) > 0 and np.std(vec_b) > 0:
        r, p_val = stats.pearsonr(vec_a, vec_b)
        rho, rho_p = stats.spearmanr(vec_a, vec_b)
        slope, intercept, r_val, p_val_ols, std_err = stats.linregress(vec_a, vec_b)
        r2 = float(r_val ** 2)
    else:
        r, p_val, rho, slope, intercept, r2 = 0.0, 1.0, 0.0, 0.0, 0.0, 0.0

    W = build_spatial_weight_matrix(spatial_coords if spatial_coords is not None else adata)
    bivariate_i = compute_bivariate_morans_i(vec_a, vec_b, W)
    is_circ, reason = check_circularity_dependency(feat_a, feat_b)

    N = len(vec_a)
    indices = np.arange(N)
    if N > 2000:
        sample_idx = np.random.choice(N, size=2000, replace=False)
        sample_idx.sort()
    else:
        sample_idx = indices

    cell_ids = [str(common_ids[i]) for i in sample_idx]

    clusters = []
    cluster_obs = cluster_source.obs.iloc[cluster_idx[sample_idx]]
    if 'leiden' in cluster_source.obs:
        clusters = list(cluster_obs['leiden'].astype(str))
    elif 'cell_type' in cluster_source.obs:
        clusters = list(cluster_obs['cell_type'].astype(str))
    else:
        clusters = ["0"] * len(sample_idx)

    points = [
        {
            "cell_id": cell_ids[i],
            "x": float(vec_a[idx]),
            "y": float(vec_b[idx]),
            "cluster": clusters[i]
        }
        for i, idx in enumerate(sample_idx)
    ]

    bivariate_coords = {
        "cell_ids": [str(c) for c in common_ids],
        "x": [float(x) for x in vec_a],
        "y": [float(y) for y in vec_b]
    }

    return {
        # canonical_name: the one casing to display (genes: var['symbol'] when the dataset has it)
        "feature_a": {"id": feat_a["id"], "name": feat_a["name"], "category": feat_a["category"], "canonical_name": _canonical_name(feat_a)},
        "feature_b": {"id": feat_b["id"], "name": feat_b["name"], "category": feat_b["category"], "canonical_name": _canonical_name(feat_b)},
        "stats": {
            "pearson_r": float(r),
            "pearson_p": float(p_val),
            "spearman_rho": float(rho),
            "r_squared": float(r2),
            "slope": float(slope),
            "intercept": float(intercept),
            "bivariate_moran_i": float(bivariate_i),
            "is_dependent": is_circ,
            "dependency_reason": reason,
            "total_cells": int(N)
        },
        "points": points,
        "bivariate_coords": bivariate_coords
    }
