import { Component, Input, OnChanges, SimpleChanges } from '@angular/core';
import { CommonModule } from '@angular/common';
import { MatFormFieldModule } from '@angular/material/form-field';
import { MatSelectModule } from '@angular/material/select';
import { FilterableTableComponent } from '../filterable-table/filterable-table.component';
import { GROUPING_LABELS, groupingLabel } from '../grouping-labels';

type TableData = { [col: string]: { [index: string]: string | number } } | string[];

/** One selectable grouping: the spot column the comparisons were computed on and its tables. */
interface DmaGrouping {
  col: string;
  label: string;
  comparisons: { key: string; title: string; table: TableData }[];
}

/** Columns that may prefix a comparison key (`<column>_<group>_vs_rest`); `annotation_coarse` is the
 * pipeline's default grouping (the Tangram mapping label stored under that column name). */
const KNOWN_GROUPING_COLS = [...Object.keys(GROUPING_LABELS), 'annotation_coarse', 'cell_type'];
/** Shown first / selected by default when present: the grouping the tool offered before this selector. */
const DEFAULT_GROUPING_ORDER = ['annotation_coarse', 'tangram_ct', 'cell_type'];

/**
 * Renders the "Differential Motif Activity" sidebar tab for one side (main or compare) — one
 * heading + read-only `<app-table>` per comparison group. Extracted from HexagonPlotComponent,
 * which used to hand-duplicate this markup verbatim for main vs. compare.
 *
 * Kept as its own component rather than folded into ChromvarCorrelationPanelComponent: despite
 * both tabs living under the ChromVar/motif umbrella, their shapes share nothing — this one has
 * no toggle state and iterates a dynamic, unbounded set of comparisons (`| keyvalue`) instead of
 * two fixed named tables, and its `<app-table>` doesn't bind `features`/`updateColumn`/
 * `datasetId`/`isCompare` or any output at all (no `actionColumns`, so nothing on these tables is
 * ever actionable) — identically on both main and compare, so this is a pre-existing read-only
 * display, not a copy-paste omission. Preserved verbatim.
 *
 * The original's `asTableData()` cast helper on HexagonPlotComponent (needed only because
 * `meta`/`metaCompare` are untyped `{ [key: string]: any }` blobs) is unnecessary here since
 * `topMotifs` is typed directly.
 */
@Component({
  selector: 'app-differential-motif-activity-panel',
  standalone: true,
  imports: [CommonModule, MatFormFieldModule, MatSelectModule, FilterableTableComponent],
  templateUrl: './differential-motif-activity-panel.component.html',
  styleUrls: ['./differential-motif-activity-panel.component.scss'],
})
export class DifferentialMotifActivityPanelComponent implements OnChanges {
  /** `meta['diff_motif_activity_top_motifs']` / `metaCompare['diff_motif_activity_top_motifs']`.
   * Keys are `<grouping column>_<group>_vs_rest`; the grouping is derived from the key prefix, so no
   * extra API field is needed. Keys without a known column prefix are listed under their own entry. */
  @Input() topMotifs: { [comparisonKey: string]: TableData } | null | undefined = null;

  groupings: DmaGrouping[] = [];
  selectedGrouping = '';

  ngOnChanges(changes: SimpleChanges): void {
    if (!changes['topMotifs']) return;
    const byCol = new Map<string, DmaGrouping>();
    for (const [key, table] of Object.entries(this.topMotifs ?? {})) {
      // longest matching column wins (leiden_niche_3_vs_rest -> leiden_niche, not leiden)
      const col = KNOWN_GROUPING_COLS
        .filter(c => key.startsWith(c + '_'))
        .sort((a, b) => b.length - a.length)[0] ?? '';
      let g = byCol.get(col);
      if (!g) {
        g = { col, label: col ? groupingLabel(col) : 'Comparisons', comparisons: [] };
        byCol.set(col, g);
      }
      const group = col ? key.slice(col.length + 1) : key;
      g.comparisons.push({ key, title: col ? group.replace(/_vs_rest$/, ' vs rest') : key, table });
    }
    const rank = (c: string) => {
      const i = DEFAULT_GROUPING_ORDER.indexOf(c);
      return i < 0 ? DEFAULT_GROUPING_ORDER.length : i;
    };
    // stable sort: default grouping first, the others keep the order of the data
    this.groupings = [...byCol.values()].sort((a, b) => rank(a.col) - rank(b.col));
    if (!this.groupings.some(g => g.col === this.selectedGrouping)) {
      this.selectedGrouping = this.groupings[0]?.col ?? '';
    }
  }

  get currentGrouping(): DmaGrouping | undefined {
    return this.groupings.find(g => g.col === this.selectedGrouping);
  }
}
