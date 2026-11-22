/** Friendly names of the spot groupings (obs columns) offered in the "Group by" selectors of the
 * DGEA and Differential Motif Activity panels. Unknown columns fall back to the raw column name. */
export const GROUPING_LABELS: { [col: string]: string } = {
  tangram_ct: 'Cell type (Tangram mapping)',
  c2l_top_coarse: 'Cell type (cell2location, authors)',
  top_niche: 'Tissue microenvironment (authors)',
  leiden: 'Cluster (Leiden)',
  leiden_niche: 'Cluster (Leiden, niche)',
  louvain_niche: 'Cluster (Louvain, niche)',
};

export function groupingLabel(col: string): string {
  return GROUPING_LABELS[col] ?? col;
}
