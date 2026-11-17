import { InjectionToken } from '@angular/core';

/** Per-cell values as returned by the backend's `/X/{gene}` and `/obsm/{table}/{column}`. */
export type BarcodeValueMap = { [barcode: string]: unknown };

/**
 * Writes one fetched per-cell feature into `cells` (in place): every cell gets the value the
 * backend returned for its barcode, and every cell the backend did not return gets `undefined`,
 * i.e. "missing" (drawn in the missing-value color) -- never a leftover from the previously shown
 * feature. Pass ALL cells of a map (not only the downsampled subset a Xenium-type map draws on its
 * base layer): the drawn subset holds the same objects, so it is updated too, and the magnifier,
 * which draws from the full set, shows the new values as well.
 *
 * One pass over the cells; also returns the finite numeric range of what was written
 * (missing / non-numeric values ignored) and how many cells got a value.
 */
export function applyCellValues(
  cells: ReadonlyArray<{ properties?: { [key: string]: any } | null }>,
  property: string,
  data: BarcodeValueMap | null | undefined,
): { matched: number; min: number; max: number } {
  const values = data ?? {};
  let matched = 0;
  let min = Infinity;
  let max = -Infinity;
  for (const cell of cells) {
    const props = cell.properties;
    if (!props) continue;
    const barcode = props['barcode'];
    const raw = barcode !== undefined && barcode !== null ? values[barcode as string] : undefined;
    // `null` from the backend (NaN in the AnnData) is missing as well.
    if (raw === undefined || raw === null) {
      props[property] = undefined;
      continue;
    }
    props[property] = raw;
    matched++;
    const n = typeof raw === 'number' ? raw : typeof raw === 'string' ? parseFloat(raw) : NaN;
    if (Number.isFinite(n)) {
      if (n < min) min = n;
      if (n > max) max = n;
    }
  }
  return { matched, min, max };
}

/**
 * Whoever owns a map's cells (HexagonPlotComponent) and can therefore write a fetched feature into
 * ALL of them for one side. Provided under CELL_VALUE_SINK so a table's "Show" action deep inside
 * a panel reaches the full cell set instead of the (possibly downsampled) array bound as its
 * `[features]`.
 */
export interface CellValueSink {
  applyFetchedValues(compare: boolean, property: string, data: BarcodeValueMap | null | undefined): void;
}

export const CELL_VALUE_SINK = new InjectionToken<CellValueSink>('CELL_VALUE_SINK');
