import { Component, ElementRef, EventEmitter, Input, OnChanges, OnDestroy, Output, SimpleChanges, ViewChild } from '@angular/core';
import { CommonModule } from '@angular/common';
import { FormsModule } from '@angular/forms';
import { HttpClient, HttpParams } from '@angular/common/http';
import { Subscription } from 'rxjs';
import { MatButtonModule } from '@angular/material/button';
import { MatButtonToggleModule } from '@angular/material/button-toggle';
import { MatIconModule } from '@angular/material/icon';
import { MatTooltipModule } from '@angular/material/tooltip';
import { MatProgressSpinnerModule } from '@angular/material/progress-spinner';
import * as Plotly from 'plotly.js-dist-min';
import * as d3 from 'd3';
import { extendedPalette, LEIDEN_CLUSTER_PALETTE } from '../categorical-palette';
import { describeApiError } from '../api-error';

export interface SpatialFeature {
  id: string;
  name: string;
  category: string;
  symbol?: string;
}

export interface PairScatterData {
  feature_a: SpatialFeature;
  feature_b: SpatialFeature;
  stats: {
    pearson_r: number;
    pearson_p: number;
    spearman_rho: number;
    r_squared: number;
    slope: number;
    intercept: number;
    bivariate_moran_i: number;
    is_dependent: boolean;
    dependency_reason: string;
    total_cells: number;
  };
  points: { cell_id: string; x: number; y: number; cluster: string }[];
}

@Component({
  selector: 'app-spatial-correlation-panel',
  standalone: true,
  imports: [
    CommonModule,
    FormsModule,
    MatButtonModule,
    MatButtonToggleModule,
    MatIconModule,
    MatTooltipModule,
    MatProgressSpinnerModule,
  ],
  templateUrl: './spatial-correlation-panel.component.html',
  styleUrls: ['./spatial-correlation-panel.component.scss'],
})
export class SpatialCorrelationPanelComponent implements OnDestroy, OnChanges {
  @Input() isCompare = false;
  @Input() datasetId?: string;
  /** Whether the app's global split-view compare mode is currently on (not to be confused with
   * `isCompare`, which just says whether THIS panel instance is the compare-side one). Compare mode
   * already shows two real maps side by side, each with its own property, so bivariately recoloring
   * either one would throw that comparison away -- the "2D Bivariate Map Color" button is therefore
   * only offered outside compare mode, where it recolors the single real map. */
  @Input() compareModeActive = false;

  @Output() syncCompareRequested = new EventEmitter<{ featA: SpatialFeature; featB: SpatialFeature }>();
  @Output() applyBivariateColorRequested = new EventEmitter<{ featA: SpatialFeature; featB: SpatialFeature; enabled?: boolean }>();
  @Output() cellSelected = new EventEmitter<string>();

  /** Whether the real map is currently bivariately colored. Owned by the parent (it also turns off
   * when the user colors by something else), so the button label can't go stale. */
  @Input() isBivariateActive = false;

  @ViewChild('heatmapContainer', { static: false }) heatmapContainer?: ElementRef<HTMLDivElement>;
  @ViewChild('scatterplotContainer', { static: false }) scatterplotContainer?: ElementRef<HTMLDivElement>;

  metricMode: 'pearson' | 'moran' = 'pearson';
  isLoadingMatrix = false;
  matrixData: any = null;
  matrixError = '';
  features: SpatialFeature[] = [];

  // On-demand gene correlation
  geneSearchQuery = '';
  geneSuggestions: string[] = [];
  selectedGenes: string[] = [];

  isSearchingGenes = false;
  geneSearchError = '';

  private matrixSubscription?: Subscription;
  private geneSearchSubscription?: Subscription;
  private matrixRequestId = 0;
  private geneSearchRequestId = 0;

  selectedPairIndices: { i: number; j: number } | null = null;
  selectedFeatureA: SpatialFeature | null = null;
  selectedFeatureB: SpatialFeature | null = null;

  isLoadingScatter = false;
  pairScatterData: PairScatterData | null = null;
  scatterError = '';

  constructor(private http: HttpClient) { }

  searchGenes(): void {
    const query = this.geneSearchQuery.trim();

    this.geneSearchSubscription?.unsubscribe();
    const requestId = ++this.geneSearchRequestId;

    this.geneSuggestions = [];
    this.geneSearchError = '';

    if (!this.datasetId || !query) {
      this.isSearchingGenes = false;
      return;
    }

    const datasetId = this.datasetId;
    this.isSearchingGenes = true;

    const params = new HttpParams()
      .set('q', query)
      .set('limit', '20');

    this.geneSearchSubscription = this.http.get<{
      genes: string[];
      total: number;
    }>(
      `/api/datasets/${encodeURIComponent(datasetId)}/correlation_genes`,
      { params, withCredentials: true }
    ).subscribe({
      next: res => {
        if (requestId !== this.geneSearchRequestId ||
          datasetId !== this.datasetId) return;

        this.geneSuggestions = res.genes.filter(
          gene => !this.selectedGenes.includes(gene)
        );

        this.isSearchingGenes = false;
      },
      error: err => {
        if (requestId !== this.geneSearchRequestId) return;

        console.error('Gene search failed:', err);
        this.geneSearchError = 'Gene search failed.';
        this.isSearchingGenes = false;
      }
    });
  }

  addGene(gene: string): void {
    if (
      this.isLoadingMatrix ||
      this.selectedGenes.includes(gene) ||
      this.selectedGenes.length >= 30
    ) {
      return;
    }

    this.selectedGenes = [...this.selectedGenes, gene];
    this.geneSuggestions = [];
    this.geneSearchQuery = '';

    this.loadCorrelationMatrix();
  }

  removeGene(gene: string): void {
    if (this.isLoadingMatrix) return;

    this.selectedGenes = this.selectedGenes.filter(g => g !== gene);
    this.loadCorrelationMatrix();
  }

  ngOnDestroy(): void {
    this.matrixSubscription?.unsubscribe();
    this.geneSearchSubscription?.unsubscribe();
  }


  ngOnChanges(changes: SimpleChanges): void {
    if (changes['datasetId']) {
      this.selectedGenes = [];
      this.geneSearchQuery = '';
      this.geneSuggestions = [];
      this.geneSearchError = '';

      this.geneSearchSubscription?.unsubscribe();
      this.geneSearchRequestId++;
      this.isSearchingGenes = false;

      this.loadCorrelationMatrix();
    }
  }

  loadCorrelationMatrix(): void {
    this.matrixSubscription?.unsubscribe();
    const requestId = ++this.matrixRequestId;

    this.matrixData = null;
    this.features = [];
    this.selectedPairIndices = null;
    this.selectedFeatureA = null;
    this.selectedFeatureB = null;
    this.pairScatterData = null;
    this.matrixError = '';

    if (!this.datasetId) {
      this.isLoadingMatrix = false;
      return;
    }

    this.isLoadingMatrix = true;
    const datasetId = this.datasetId;

    let params = new HttpParams();

    for (const gene of this.selectedGenes) {
      params = params.append('genes', gene);
    }

    this.matrixSubscription = this.http.get<any>(
      `/api/datasets/${encodeURIComponent(datasetId)}/spatial_correlation_matrix`,
      { params, withCredentials: true }
    ).subscribe({
      next: res => {
        if (requestId !== this.matrixRequestId ||
          datasetId !== this.datasetId) return;

        this.matrixData = res;
        this.features = res.features || [];
        this.isLoadingMatrix = false;

        setTimeout(() => {
          if (requestId === this.matrixRequestId) {
            this.renderHeatmap();
          }
        }, 50);
      },
      error: err => {
        if (requestId !== this.matrixRequestId) return;

        console.error('Failed to load spatial correlation matrix:', err);

        this.matrixError = describeApiError(err, "Can't compute the correlation matrix for this dataset");

        this.isLoadingMatrix = false;
      }
    });
  }

  onMetricChange(mode: 'pearson' | 'moran'): void {
    this.metricMode = mode;
    this.renderHeatmap();
  }

  renderHeatmap(): void {
    if (!this.heatmapContainer || !this.matrixData || !this.features.length) return;
    const container = this.heatmapContainer.nativeElement;

    const n = this.features.length;
    if (n === 0) {
      Plotly.purge(container);
      return;
    }

    const xNames = this.features.map(f => f.name);
    const yNames = this.features.map(f => f.name);
    const matrix = this.metricMode === 'pearson' ? this.matrixData.pearson_matrix : this.matrixData.moran_matrix;

    const hoverText: string[][] = [];
    for (let i = 0; i < n; i++) {
      const row: string[] = [];
      for (let j = 0; j < n; j++) {
        const val = matrix[i][j];
        const circ = this.matrixData.circularity_matrix?.[i]?.[j];
        const metricName = this.metricMode === 'pearson' ? 'Pearson r' : "Bivariate Moran's I";
        row.push(
          `<b>${yNames[i]}</b> vs <b>${xNames[j]}</b><br>` +
          `${metricName}: <b>${typeof val === 'number' ? val.toFixed(3) : val}</b>` +
          // Only warn about detected dependencies; never assert independence (heuristic check).
          (circ?.is_dependent ? `<br>Warning: <i>${circ.reason || 'Direct dependency'}</i>` : '')
        );
      }
      hoverText.push(row);
    }

    const data: Partial<Plotly.PlotData>[] = [
      {
        type: 'heatmap',
        x: xNames,
        y: yNames,
        z: matrix,
        text: hoverText as any,
        hoverinfo: 'text',
        colorscale: 'RdBu',
        reversescale: true,
        zmin: -1,
        zmax: 1,
        colorbar: {
          title: { text: this.metricMode === 'pearson' ? 'Pearson r' : "Moran's I" },
          thickness: 14,
          len: 0.8
        }
      }
    ];

    const maxNameLen = Math.max(...this.features.map(f => f.name.length), 10);
    const lMargin = Math.max(120, Math.min(220, maxNameLen * 7));
    const bMargin = Math.max(100, Math.min(200, maxNameLen * 6));
    const cellSize = Math.min(32, Math.max(22, Math.floor(500 / n)));
    const matrixSide = n * cellSize;

    const layout: Partial<Plotly.Layout> = {
      width: matrixSide + lMargin + 80,
      height: matrixSide + bMargin + 50,
      margin: {
        t: 40,
        l: lMargin,
        r: 30,
        b: bMargin
      },
      xaxis: {
        tickangle: -45,
        automargin: true,
        type: 'category',
        constrain: 'domain'
      },
      yaxis: {
        automargin: true,
        autorange: 'reversed',
        type: 'category',
        scaleanchor: 'x',
        scaleratio: 1,
        constrain: 'domain'
      }
    };

    Plotly.purge(container);
    Plotly.newPlot(container, data, layout, {
      responsive: true,
      displayModeBar: false
    }).then(() => {
      (container as any).on('plotly_click', (eventData: any) => {
        if (eventData && eventData.points && eventData.points.length > 0) {
          const pt = eventData.points[0];
          const colIdx = pt.x !== undefined ? this.features.findIndex(f => f.name === pt.x) : pt.pointIndex?.[1];
          const rowIdx = pt.y !== undefined ? this.features.findIndex(f => f.name === pt.y) : pt.pointIndex?.[0];
          if (rowIdx >= 0 && colIdx >= 0) {
            this.selectCell(rowIdx, colIdx);
          }
        }
      });
    });
  }

  selectCell(i: number, j: number): void {
    this.selectedPairIndices = { i, j };
    this.selectedFeatureA = this.features[i];
    this.selectedFeatureB = this.features[j];
    this.loadScatterData(this.features[i].id, this.features[j].id);
  }

  loadScatterData(featIdA: string, featIdB: string): void {
    if (!this.datasetId) return;
    this.isLoadingScatter = true;
    this.pairScatterData = null;
    this.scatterError = '';

    const url = `/api/datasets/${encodeURIComponent(this.datasetId)}/spatial_correlation_pair?feature_id_a=${encodeURIComponent(featIdA)}&feature_id_b=${encodeURIComponent(featIdB)}`;

    this.http.get<PairScatterData>(url, { withCredentials: true }).subscribe({
      next: (res) => {
        this.pairScatterData = res;
        this.isLoadingScatter = false;
        setTimeout(() => this.renderScatterplot(), 50);
        // A new pair while bivariate coloring is on: recolor the map for the new pair.
        if (this.isBivariateActive && !this.compareModeActive && this.selectedFeatureA && this.selectedFeatureB) {
          this.applyBivariateColorRequested.emit({
            featA: this.selectedFeatureA, featB: this.selectedFeatureB, enabled: true,
          });
        }
      },
      error: (err) => {
        console.error('Failed to load scatter data:', err);
        // The backend's structured reason when it sent one; 5xx and unrecognised errors keep the
        // generic text, since their detail can be a raw exception message (see api-error.ts).
        this.scatterError = describeApiError(err, "Can't correlate the selected pair");
        this.isLoadingScatter = false;
      }
    });
  }

  renderScatterplot(): void {
    if (!this.scatterplotContainer || !this.pairScatterData) return;
    const scatterData = this.pairScatterData;
    const container = this.scatterplotContainer.nativeElement;

    const data = scatterData.points;
    if (!data || data.length === 0) {
      Plotly.purge(container);
      return;
    }

    const xVals = data.map(d => d.x);
    const yVals = data.map(d => d.y);
    const cellIds = data.map(d => d.cell_id);

    const hoverText = data.map(d =>
      `Cell: <b>${d.cell_id}</b><br>` +
      `Cluster: <b>${d.cluster}</b><br>` +
      `${scatterData.feature_a.name}: <b>${d.x.toFixed(3)}</b><br>` +
      `${scatterData.feature_b.name}: <b>${d.y.toFixed(3)}</b><br>` +
      `<i>Click to highlight on map</i>`
    );

    // Same palette as the map's Leiden view (LEIDEN_CLUSTER_PALETTE, extended without repeats), so
    // cluster N has the same color here as on the map.
    const clusterNums = data.map(d => parseInt(d.cluster, 10));
    const maxCluster = clusterNums.reduce((m, c) => (!isNaN(c) && c > m ? c : m), 0);
    const colorPalette = extendedPalette(LEIDEN_CLUSTER_PALETTE, maxCluster + 1);
    const markerColors = clusterNums.map(cNum => (!isNaN(cNum) && cNum >= 0 ? colorPalette[cNum] : '#1976d2'));

    const traces: Partial<Plotly.PlotData>[] = [
      {
        type: 'scatter',
        mode: 'markers',
        x: xVals,
        y: yVals,
        text: hoverText,
        hoverinfo: 'text',
        customdata: cellIds as any,
        marker: {
          size: 6,
          color: markerColors,
          opacity: 0.65
        },
        name: 'Cells'
      }
    ];

    // Linear Regression Trendline
    const { slope, intercept } = scatterData.stats;
    if (slope !== 0 || intercept !== 0) {
      const minX = Math.min(...xVals);
      const maxX = Math.max(...xVals);
      traces.push({
        type: 'scatter',
        mode: 'lines',
        x: [minX, maxX],
        y: [slope * minX + intercept, slope * maxX + intercept],
        line: { color: '#e53935', width: 2, dash: 'dash' },
        name: 'OLS Trend',
        hoverinfo: 'none'
      });
    }

    // Long obs names (e.g. "Obs: Histopath Overlap Infiltrating Tumor Grey Matter") as axis titles
    // pushed the plot out of its box: shorten them (full name on hover over the points) and size
    // to the container width.
    const shortTitle = (name: string): string => (name.length > 38 ? name.slice(0, 37) + '…' : name);
    const layout: Partial<Plotly.Layout> = {
      autosize: true,
      margin: { t: 20, l: 60, r: 20, b: 60 },
      height: 320,
      xaxis: {
        title: { text: shortTitle(scatterData.feature_a.name), font: { size: 11 }, standoff: 8 },
        automargin: true
      },
      yaxis: {
        title: { text: shortTitle(scatterData.feature_b.name), font: { size: 11 }, standoff: 8 },
        automargin: true
      },
      showlegend: false,
      hovermode: 'closest'
    };

    Plotly.purge(container);
    Plotly.newPlot(container, traces, layout, {
      responsive: true,
      displayModeBar: false
    }).then(() => {
      (container as any).on('plotly_click', (eventData: any) => {
        if (eventData && eventData.points && eventData.points.length > 0) {
          const pt = eventData.points[0];
          const cellId = pt.customdata;
          if (cellId) {
            this.cellSelected.emit(cellId);
          }
        }
      });
    });
  }

  onSyncCompare(): void {
    if (this.selectedFeatureA && this.selectedFeatureB) {
      this.syncCompareRequested.emit({
        featA: this.selectedFeatureA,
        featB: this.selectedFeatureB
      });
    }
  }

  /** Outside compare mode only (see compareModeActive doc) -- recolors the real map directly via
   * the parent's onApplyBivariateColor. */
  toggleBivariateMap(): void {
    if (this.selectedFeatureA && this.selectedFeatureB) {
      this.applyBivariateColorRequested.emit({
        featA: this.selectedFeatureA,
        featB: this.selectedFeatureB,
        enabled: !this.isBivariateActive,
      });
    }
  }
}
