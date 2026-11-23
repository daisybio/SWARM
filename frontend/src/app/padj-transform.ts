/**
 * Map-colouring helpers for adjusted p-value columns (e.g. pathway_activity_padj_mlm,
 * tf_activity_padj_ulm). Raw padj spans ~15 orders of magnitude, so the map shows -log10(padj)
 * (higher = more significant). Tables keep showing the raw padj; only map colour/legend/tooltip
 * use this.
 */

/** padj is clamped below at this value before the log, so an exact 0 maps to 300. */
export const PADJ_FLOOR = 1e-300;

/** Colour-scale upper clip for -log10(padj); larger values (e.g. 300 from exact zeros) are
 * painted with the top colour so they do not flatten the rest of the map. */
export const PADJ_NEGLOG_CLIP = 50;

export const PADJ_LEGEND_LABEL = '-log10(padj)';

/** True for obsm column names holding (adjusted) p-values: 'pathway_activity_padj_mlm' ('_padj_' or a
 * 'padj' suffix) and plain p-value columns such as 'ligand_receptor_p_value'. */
export function isPadjColumn(name: string | null | undefined): boolean {
  if (!name) return false;
  return name.includes('_padj_') || name.endsWith('padj') || name.endsWith('_p_value');
}

/** Legend suffix for the -log10 colour scale of `name`: '-log10(p)' for raw p-values, else '-log10(padj)'. */
export function pValueLegendLabel(name: string | null | undefined): string {
  return name && name.endsWith('_p_value') ? '-log10(p)' : PADJ_LEGEND_LABEL;
}

/** -log10(max(padj, 1e-300)); NaN for missing / non-numeric / negative input. */
export function padjToNegLog10(value: unknown): number {
  if (value === null || value === undefined || value === '') return NaN;
  const p = typeof value === 'number' ? value : parseFloat(String(value));
  if (!Number.isFinite(p) || p < 0) return NaN;
  return -Math.log10(Math.max(p, PADJ_FLOOR));
}
