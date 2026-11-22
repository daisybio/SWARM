import { ChangeDetectorRef, Component, ElementRef, EventEmitter, Input, NgZone, OnChanges, OnDestroy, Output, SimpleChanges, ViewChild } from '@angular/core';
import { CommonModule } from '@angular/common';
import { FormsModule } from '@angular/forms';
import { Observable } from 'rxjs';
import * as d3 from 'd3';
import { MatButtonModule } from '@angular/material/button';
import { MatIconModule } from '@angular/material/icon';
import { MatProgressSpinnerModule } from '@angular/material/progress-spinner';
import { MatFormField, MatLabel } from '@angular/material/form-field';
import { MatOptgroup, MatOption } from '@angular/material/autocomplete';
import { MatSelect } from '@angular/material/select';
import { MatTooltipModule } from '@angular/material/tooltip';
import { DragDropModule } from '@angular/cdk/drag-drop';
import { TranslatePipe } from '../translate.pipe';
import { Dataset } from '../datasets.service';
import { CellFeature } from './cell-feature.types';
import { SpotShape, makeSpotPathGenerator, measureSpotLayout, typicalSpotDiameter } from './spot-geometry';
import { padjToNegLog10 } from '../padj-transform';

export interface HexHoverInfo {
  barcode: string;
  propertyName: string;
  value: string;
  cluster?: string | number;
}

export interface LegendCategoryItem {
  label: string;
  color: string;
}

export interface MapLegendInfo {
  title: string;
  type: 'continuous' | 'categorical' | 'bivariate';
  minText?: string;
  maxText?: string;
  gradientStops?: string;
  items?: LegendCategoryItem[];
  bivariateInfo?: {
    labelA: string;
    labelB: string;
    colorA: string;
    colorB: string;
  };
}

export interface HexagonRenderContext {
  features: CellFeature[];
  isXenium: boolean;
  fullFeatures: CellFeature[];
  selectedView: string;
  legendType: 'categorical' | 'continuous';
  /**
   * Pre-existing behavior being preserved, not introduced here: categorical/ordinal fills always
   * use the *main* view's color scale, even when rendering the compare instance — only the
   * continuous scale is correctly per-instance. Pass the main view's colorScale for both
   * instances to match current app behavior exactly; flagged to the user as a latent bug worth
   * a follow-up fix, not fixed silently as part of this structural extraction.
   */
  colorScale: d3.ScaleOrdinal<string, string>;
  continuousColorScale: (t: number) => string;
  leidenClusterAnnotations: Record<string, any> | undefined;
  leidenCentralityProps: string[];
  /**
   * Compare mode's "same scale" option: the other map's (full) features. When set, this map uses
   * the smaller of the two fitted scales, so one data unit (micron) is the same on-screen size in
   * both maps and two sections can be compared by size and shape; each map is still centered on
   * its own section. Null/absent: fit this map's own extent (the default).
   */
  sharedScaleFeatures?: CellFeature[] | null;
  /** Circles (real spot/cell size) or hexagons (tiled with a gap); see spot-geometry.ts. */
  spotShape: SpotShape;
}

/**
 * Owns one side (main or compare) of the hexagon map: the D3 SVG/rendering, cluster-outline
 * highlighting, and (main-view only) the Xenium performance downsampling + magnifier detail
 * window. Extracted from HexagonPlotComponent, which used to hand-duplicate all of this for
 * main vs. compare via `compare ? x : y` ternaries throughout.
 *
 * Render-time data (features, color scales, selected view, etc.) is passed as explicit method
 * parameters rather than read from @Input()-bound fields, because the parent calls these methods
 * imperatively via @ViewChild right after mutating its own state, in the same synchronous tick —
 * before Angular's own change-detection pass would have refreshed an @Input() binding.
 */
@Component({
  selector: 'app-hexagon-view',
  standalone: true,
  imports: [
    CommonModule, FormsModule, MatButtonModule, MatIconModule, MatProgressSpinnerModule,
    MatFormField, MatLabel, MatOptgroup, MatOption, MatSelect, MatTooltipModule, DragDropModule, TranslatePipe,
  ],
  templateUrl: './hexagon-view.component.html',
  styleUrls: ['./hexagon-view.component.scss'],
})
export class HexagonViewComponent implements OnChanges, OnDestroy {
  @Input() isCompare = false;
  /** This instance's own currently-selected cell, for the mouseLeave highlight-suppression check. */
  @Input() selectedCell: CellFeature | null = null;
  @Input() selectedView = '';
  /** Map is coloured by -log10(padj): the hover tooltip shows that transform, not the raw padj. */
  @Input() padjTransform = false;
  @Input() legendInfo: MapLegendInfo | null = null;
  public isLegendCollapsed = false;
  /**
   * True once the user has dragged the legend's native resize corner. The categorical list has a
   * default `max-height` so a 65-category legend does not cover the map on first render, but that
   * cap also clamps the scroll viewport — so resizing the panel taller used to leave the list
   * clipped at its default height with blank space below. This flag adds `.user-resized`, which
   * drops the cap.
   *
   * CSS alone cannot express this: a stylesheet `max-height` always clamps an inline `height`, and
   * the inline height is exactly what `resize: both` writes. So we detect that written height.
   */
  public isLegendUserResized = false;
  private legendResizeObserver?: ResizeObserver;

  /**
   * Setter rather than a plain @ViewChild because the legend sits behind `*ngIf="legendInfo"`, so
   * the element is created and destroyed as views change and a one-shot AfterViewInit read would
   * miss it.
   */
  @ViewChild('legendOverlay')
  set legendOverlay(ref: ElementRef<HTMLElement> | undefined) {
    this.legendResizeObserver?.disconnect();
    this.legendResizeObserver = undefined;
    const el = ref?.nativeElement;
    if (!el || typeof ResizeObserver === 'undefined') {
      return;
    }
    // Any inline height on this element can only have come from the native resize handle —
    // nothing in the template or this class sets one, and `.collapsed`'s `height: auto` is a
    // stylesheet rule, not an inline style.
    this.legendResizeObserver = new ResizeObserver(() => {
      if (!this.isLegendUserResized && el.style.height) {
        this.isLegendUserResized = true;
      }
    });
    this.legendResizeObserver.observe(el);
  }
  /** The active cluster value for whichever categorical property is currently colored-by — a
   * Leiden cluster id, or any other categorical property's raw value. */
  public activeClusterValue: string | number | null = null;
  public hoveredHexInfo: HexHoverInfo | null = null;
  public hoverTooltipPos = { x: 0, y: 0 };
  /**
   * Whether the currently-active view should drive cluster-highlight behavior (click/hover
   * outlining a whole group of same-valued cells) — true for 'leiden' and any other categorical
   * property. Kept in sync two ways: via ngOnChanges (Angular-CD-driven, both @Input()s update
   * together so it's timing-safe there) and via setCurrentView's second param (the imperative
   * @ViewChild path, called ahead of Angular's own change detection — see the class doc above
   * for why render-time state is passed explicitly rather than read from @Input() in that path).
   */
  private isActiveViewCategorical = false;

  public toggleLegendCollapse(event?: MouseEvent): void {
    if (event) {
      event.stopPropagation();
    }
    this.isLegendCollapsed = !this.isLegendCollapsed;
  }

  // ======= Toolbar (color-by / dataset selectors) =======
  @Input() isInitializing = false;
  @Input() isLoadingMap = false;
  @Input() compareMode = false;
  @Input() currentDataSetSupportsCompare = true;
  @Input() isLiveDrawerOpen = false;
  @Input() groupedProperties: { key: string; value: string[] }[] | null = null;
  @Input() selectedDataset: Dataset | null = null;
  @Input() builtinDatasets$!: Observable<Dataset[]>;
  @Input() uploadedDatasets$!: Observable<Dataset[]>;
  @Input() tangramDatasets$!: Observable<Dataset[]>;
  /** Bound once in the parent (`propertyAvailable.bind(this)`) and shared by both instances;
   * each instance supplies its own isCompare when calling it — see isPropertyAvailable below. */
  @Input() propertyAvailableFn!: (prop: string, isCompare: boolean) => boolean;

  @Output() selectedViewChange = new EventEmitter<string>();
  @Output() colorByChanged = new EventEmitter<void>();
  @Output() selectedDatasetChange = new EventEmitter<Dataset | null>();
  @Output() datasetChanged = new EventEmitter<Dataset | null>();
  @Output() tangramDatasetSelected = new EventEmitter<Dataset>();
  @Output() viewTutorialClicked = new EventEmitter<void>();
  @Output() datasetTutorialClicked = new EventEmitter<void>();
  @Output() compareModeToggled = new EventEmitter<void>();
  @Output() liveDrawerToggled = new EventEmitter<void>();

  public isPropertyAvailable(prop: string): boolean {
    return this.propertyAvailableFn(prop, this.isCompare);
  }

  @Output() cellClicked = new EventEmitter<{ event: MouseEvent; cell: CellFeature }>();
  @Output() clusterClicked = new EventEmitter<{ cell: CellFeature; clusterId: number }>();
  /** Emits the raw category value (matching the legend item's label) when a categorical legend
   * entry is clicked, so the parent can select a representative cell as if it had been clicked
   * directly on the map. */
  @Output() legendCategoryClicked = new EventEmitter<string>();

  @ViewChild('hexbinContainer', { static: true }) private hexbinContainerRef!: ElementRef<HTMLDivElement>;

  /** Behind *ngIf="legendInfo.type === 'bivariate'", so this is undefined until that becomes
   * true -- renderBivariateLegendCanvas() below is always called after a setTimeout(0) to give
   * Angular a tick to create it first. */
  @ViewChild('bivariateLegendCanvas') private bivariateLegendCanvasRef?: ElementRef<HTMLCanvasElement>;

  /** Public: read by the parent's updateHexColors/getViewVariablesToUpdate via @ViewChild until
   * those are migrated too (they're deeply tied to cross-cutting concerns staying in the parent
   * for now — see the refactor plan). */
  public svg!: d3.Selection<SVGSVGElement, any, any, any>;
  public g!: d3.Selection<SVGGElement, any, any, any>;
  public baseLayer!: d3.Selection<SVGGElement, null, any, any>;
  public detailLayer!: d3.Selection<SVGGElement, null, any, any>;
  /**
   * Magnified cells, inside detailLayer. The magnifier transform goes on this inner group, not on
   * detailLayer: a clip-path is resolved in the user space of the element it is set on, so with
   * the transform on detailLayer the clip rectangle was scaled/shifted along with the cells --
   * cells spilled outside the frame and the white backdrop covered the whole map.
   */
  private detailContent!: d3.Selection<SVGGElement, null, any, any>;
  public currentPathGenerator: ((d: CellFeature) => string) | null = null;

  private currentTransform = d3.zoomIdentity;

  /**
   * Outline widths are screen px (vector-effect: non-scaling-stroke, so zooming doesn't fatten
   * them) scaled down for small spots: a 1.4 px black outline on a 1.6 px Xenium dot painted the
   * whole overview black. 1 for spots >= 8 px at the fitted view; magnifier cells always use 1.
   */
  private strokeScale = 1;

  private strokeWidth(node: Element, px: number): string {
    const f = node.closest('g.detail-layer') ? 1 : this.strokeScale;
    return `${Math.round(px * f * 100) / 100}px`;
  }

  /**
   * Min/max zoom scale for the map.
   *
   * The floor was previously 1, which is the *initial fitted* scale — so there was nothing below
   * the starting view to reach and zoom-out was silently impossible, while zoom-in worked. 0.35
   * gives roughly a third-size overview, enough to pull back and see a whole section in context.
   *
   * Safe to go below 1 here: the only clipped layer, `.detail-layer` (`url(#detail-clip)`), is a
   * child of the <svg> rather than of the zoomed <g>, so it is a fixed inset and is unaffected by
   * this transform.
   */
  private static readonly ZOOM_SCALE_EXTENT: [number, number] = [0.35, 5];

  // ======= Xenium detail-window state =======
  /** Per instance: clip-path ids are document-global, and with two maps on the page a shared id
   * made the compare map's magnifier clip to the main map's window. */
  private get detailClipId(): string {
    return this.isCompare ? 'detail-clip-compare' : 'detail-clip';
  }
  /** Projection of the last render, for mapping the magnifier window back to data coordinates. */
  private currentProjection: d3.GeoIdentityTransform | null = null;
  /** Planar bounds per feature array (arrays are replaced, never mutated, on a new dataset). */
  private static readonly boundsCache = new WeakMap<CellFeature[], [[number, number], [number, number]]>();
  /** Magnifier window size in map (viewBox) units; 80 was ~37 px on screen, too small to use. */
  private readonly detailSize = 200;
  private detailVisible = false;
  private detailScreenPos: { x: number; y: number } | null = null;
  private keydownHandler: ((event: KeyboardEvent) => void) | null = null;
  private lastRenderCtx: HexagonRenderContext | null = null;

  /**
   * The parent's current value -> color mapping (set by its updateHexColors() on every recolor).
   * Used for cells this component draws on its own after that recolor -- the Xenium magnifier's
   * cells -- so they get the same normalized continuous scale / categorical palette as the base
   * layer rather than the render-time snapshot in lastRenderCtx.
   */
  private fillAccessor: ((d: CellFeature) => string) | null = null;

  public setFillAccessor(fn: (d: CellFeature) => string): void {
    this.fillAccessor = fn;
  }

  /** Per-cell colors of the 2D bivariate overlay (selectedView 'bivariate_overlay'). Kept here so
   * every redraw of this view (zoom/shape toggle/selection/magnifier) reuses it -- the overlay used
   * to be painted onto the existing paths once, and any redraw turned the cells grey because that
   * pseudo-view has no property to read. null = not active. */
  private bivariateFill: ((d: CellFeature) => string) | null = null;

  public setBivariateFill(fn: ((d: CellFeature) => string) | null): void {
    this.bivariateFill = fn;
  }

  /**
   * All D3 listeners (zoom, hover, click) are registered outside Angular's zone. Inside it, every
   * wheel/mousemove on the map triggered an app-wide change-detection pass, which is what made
   * panning/zooming and hovering sluggish on large datasets. Handlers that change this
   * component's own template state (the hover tooltip) call cdr.detectChanges() for a local
   * check; the click handler re-enters the zone since it drives the rest of the app.
   */
  constructor(private zone: NgZone, private cdr: ChangeDetectorRef) {}

  ngOnChanges(changes: SimpleChanges): void {
    if (changes['selectedView'] || changes['legendInfo']) {
      this.isActiveViewCategorical = this.legendInfo?.type === 'categorical';
      if (changes['selectedView'] && !this.isActiveViewCategorical) {
        this.activeClusterValue = null;
      }
    }
    if (changes['legendInfo'] && this.legendInfo?.type === 'bivariate') {
      // The <canvas> sits behind *ngIf="legendInfo.type === 'bivariate'" (see template), so on
      // the transition into this type it doesn't exist yet this tick -- give Angular one to
      // create it before rendering into it.
      setTimeout(() => this.renderBivariateLegendCanvas(), 0);
    }
    if (changes['selectedCell'] || changes['selectedView']) {
      this.updateSelectionHighlight();
    }
  }

  ngOnDestroy(): void {
    if (this.keydownHandler) {
      window.removeEventListener('keydown', this.keydownHandler);
    }
    this.legendResizeObserver?.disconnect();
  }

  /** Removes any existing SVG in this instance's container before a fresh createHexagonPlot(). */
  public clearSvg(): void {
    d3.select(this.hexbinContainerRef.nativeElement).selectAll('svg').remove();
  }

  /** Same formula as live-correlation-drawer.component.ts's/spatial-correlation-panel's own
   * bivariateColor -- kept in sync by hand since each has its own render pipeline (matching this
   * codebase's existing pattern). u/v are featureA/featureB each normalized to [0,1]; green marks
   * how close they are to each other. Corners: (0,0)=green, (1,1)=white, (0,1)=red, (1,0)=blue. */
  private bivariateColor(u: number, v: number): [number, number, number] {
    const r = Math.round(255 * v);
    const g = Math.round(255 * Math.max(0, 1 - Math.abs(u - v)));
    const b = Math.round(255 * u);
    return [r, g, b];
  }

  /** Draws the same pixel-accurate 2D blend the Live Correlation drawer and Spatial Correlation
   * panel use for their own bivariate legends (this legend previously used a hand-picked CSS
   * linear-gradient that neither matched their exact corner colors nor the real bivariateColor
   * formula -- three different-looking "bivariate legends" for the same underlying blend). */
  private renderBivariateLegendCanvas(): void {
    const canvas = this.bivariateLegendCanvasRef?.nativeElement;
    if (!canvas) return;
    const size = 64;
    canvas.width = size;
    canvas.height = size;
    const ctx = canvas.getContext('2d');
    if (!ctx) return;

    const image = ctx.createImageData(size, size);
    for (let row = 0; row < size; row++) {
      const v = 1 - row / (size - 1);
      for (let col = 0; col < size; col++) {
        const u = col / (size - 1);
        const [r, g, b] = this.bivariateColor(u, v);
        const idx = (row * size + col) * 4;
        image.data[idx] = r;
        image.data[idx + 1] = g;
        image.data[idx + 2] = b;
        image.data[idx + 3] = 255;
      }
    }
    ctx.putImageData(image, 0, 0);
  }

  public createHexagonPlot(): void {
    // Outside the zone: see the constructor doc.
    this.zone.runOutsideAngular(() => {
      const width = 1000;
      const height = 1000;

      const container = d3.select(this.hexbinContainerRef.nativeElement);
      const svgSel = container
        .selectAll('svg')
        .data([0])
        .join('svg')
        .attr('viewBox', [0, 0, 1000, 1000] as [number, number, number, number])
        .attr('preserveAspectRatio', 'xMidYMid meet')
        .style('background-color', 'white')
        .style('overflow', 'hidden')
        .on('mouseleave', () => this.clearUnselectedHoverBorders());

      const gSel = svgSel
        .selectAll<SVGGElement, number>('g.root-group')
        .data([0])
        .join('g')
        .attr('class', 'root-group');

      this.svg = svgSel as unknown as d3.Selection<SVGSVGElement, any, any, any>;
      this.g = gSel as any;

      // Xenium layers (downsampled base layer + magnifier detail layer) on both sides: the
      // compare map of a Xenium/MERFISH dataset gets the same magnifier as the main map.
      this.baseLayer = this.g.selectAll<SVGGElement, unknown>('g.base-layer')
        .data([null])
        .join('g')
        .attr('class', 'base-layer');

      this.detailLayer = this.svg.selectAll<SVGGElement, unknown>('g.detail-layer')
        .data([null])
        .join('g')
        .attr('class', 'detail-layer')
        .attr('clip-path', `url(#${this.detailClipId})`);
      this.detailContent = this.detailLayer.selectAll<SVGGElement, unknown>('g.detail-content')
        .data([null])
        .join('g')
        .attr('class', 'detail-content');

      const zoomBehavior = d3
        .zoom<SVGSVGElement, unknown>()
        .scaleExtent(HexagonViewComponent.ZOOM_SCALE_EXTENT)
        .extent([
          [0, 0],
          [width, height],
        ])
        .filter((event) => {
          // Standard D3 zoom filter: allow wheel and primary mouse button drags
          return (!event.ctrlKey || event.type === 'wheel') && !event.button;
        })
        .on('zoom', (event) => {
          this.g.attr('transform', event.transform.toString());
          this.currentTransform = event.transform;
        });

      (svgSel as any).call(zoomBehavior);
      // createHexagonPlot() reuses the existing <svg> via .join() rather than always creating a
      // fresh one (see clearSvg()'s doc comment, which this method's own comment promises but
      // doesn't itself guarantee) -- without this, any prior zoom/pan (D3's internal state lives
      // on the DOM node) silently carries over to whatever dataset/view is rendered next, so a
      // freshly-fitted projection for the new dataset gets viewed through a stale camera position.
      (svgSel as any).call(zoomBehavior.transform, d3.zoomIdentity);
      this.currentTransform = d3.zoomIdentity;
  
    });
  }

  public renderHexagons(ctx: HexagonRenderContext): void {
    this.lastRenderCtx = ctx;
    const width = 1000;
    const height = 1000;
    const padding = 20;

    const ownFeatures = ctx.isXenium ? ctx.fullFeatures : ctx.features;
    const projection = ctx.sharedScaleFeatures?.length
      ? HexagonViewComponent.sharedScaleProjection(ownFeatures, ctx.sharedScaleFeatures, width, height, padding)
      : d3.geoIdentity().fitExtent(
        [[padding, padding], [width - padding, height - padding]],
        {
          type: 'FeatureCollection',
          features: ownFeatures,
        },
      );

    this.currentProjection = projection;
    // Spot geometry is rebuilt from centers + the measured spacing of the FULL dataset (the
    // Xenium base layer is downsampled, its spacing would be meaningless).
    const layout = measureSpotLayout(ownFeatures);
    this.currentPathGenerator = makeSpotPathGenerator(
      ctx.spotShape, layout, (p) => projection(p) as [number, number] | null, projection.scale(),
    );
    const pathGenerator = this.currentPathGenerator;
    const spotPx = typicalSpotDiameter(ctx.spotShape, layout) * projection.scale();
    this.strokeScale = Math.min(1, Math.max(0.3, spotPx / 8));

    if (ctx.isXenium) {
      // Centroids in data coordinates (projection-independent, so computed once per cell even
      // when the projection changes, e.g. with the compare "same scale" toggle). The magnifier
      // maps its window back into data coordinates to pick the cells inside it.
      const planar = d3.geoPath();
      ctx.fullFeatures.forEach((f) => {
        if (!(f.properties as any).__centroidData) {
          (f.properties as any).__centroidData = planar.centroid(f as any);
        }
      });
    }

    const getFill = (d: CellFeature): string => {
      if (ctx.selectedView === 'bivariate_overlay' && this.bivariateFill) return this.bivariateFill(d);
      const value = ctx.leidenCentralityProps.includes(ctx.selectedView)
        ? ctx.leidenClusterAnnotations?.[String(d.properties.leiden)]?.centrality?.[ctx.selectedView]
        : d.properties?.[ctx.selectedView];
      if (ctx.legendType === 'categorical') {
        return ctx.colorScale(String(value));
      }
      const num = this.toNumber(value);
      return Number.isFinite(num) ? ctx.continuousColorScale(num) : '#ccc';
    };

    this.zone.runOutsideAngular(() => {
    // This <svg> is reused across datasets: drop paths the other render mode left behind (plain
    // maps draw straight into the root group, Xenium maps into the base layer), or switching
    // between a Xenium and a non-Xenium dataset leaves stale, non-interactive cells on screen.
    if (ctx.isXenium) {
      this.g.selectChildren('path').remove();
    } else {
      this.baseLayer?.selectAll('path').remove();
      this.detailLayer?.selectAll('path').remove();
      this.svg?.select('#detail-frame').style('display', 'none');
      this.detailVisible = false;
      this.detailScreenPos = null;
    }
    if (ctx.isXenium) {
      // The overview (downsampled) cells are clickable too: before, the base layer had
      // pointer-events: none, so a Xenium cell could only be selected inside the magnifier.
      this.g.style('cursor', null).style('pointer-events', null);
      this.baseLayer
        .style('cursor', 'pointer')
        .style('pointer-events', null)
        .selectAll<SVGPathElement, CellFeature>('path')
        .data(ctx.features, (d: any) => d.properties.barcode)
        .join('path')
        .attr('d', (d: CellFeature) => pathGenerator(d) || '')
        .attr('fill', getFill)
        // Styles are rewritten here, so drop updateSelectionHighlight()'s per-path state cache.
        .property('__hlState', null)
        .attr('vector-effect', 'non-scaling-stroke')
        .style('opacity', 0.8)
        .on('mouseover', (event, d) => this.mouseOver(event, d))
        .on('mousemove', (event) => this.mouseMove(event))
        .on('mouseleave', (event, d) => this.mouseLeave(event, d))
        .on('click', (event, d) => this.zone.run(() => this.cellClicked.emit({ event, cell: d })));
    } else {
      this.g
        .style('cursor', 'pointer')
        .style('pointer-events', null)
        .selectAll<SVGPathElement, CellFeature>('path')
        .data(ctx.features, (d: any) => d.properties.barcode)
        .join('path')
        .attr('d', (d: CellFeature) => pathGenerator(d) || '')
        .attr('fill', getFill)
        // Styles are rewritten here, so drop updateSelectionHighlight()'s per-path state cache.
        .property('__hlState', null)
        .attr('vector-effect', 'non-scaling-stroke')
        .style('opacity', 0.8)
        .on('mouseover', (event, d) => this.mouseOver(event, d))
        .on('mousemove', (event) => this.mouseMove(event))
        .on('mouseleave', (event, d) => this.mouseLeave(event, d))
        .on('click', (event, d) => this.zone.run(() => this.cellClicked.emit({ event, cell: d })));
    }
    });
    // Note: initDetailWindow/hideDetailWindow/bindDetailWindowInteractions are NOT called here —
    // the original calls them from loadAndRenderData, before renderHexagons, as part of Xenium
    // setup. The parent redirects that same call sequence to this instance's public methods.
  }

  /**
   * Identity projection (no reflection, like geoIdentity().fitExtent) whose scale fits whichever of
   * `own` / `other` needs the smaller scale, centered on `own`'s extent.
   */
  private static sharedScaleProjection(
    own: CellFeature[], other: CellFeature[], width: number, height: number, padding: number,
  ): d3.GeoIdentityTransform {
    const fitScale = (b: [[number, number], [number, number]]): number => {
      const dx = b[1][0] - b[0][0];
      const dy = b[1][1] - b[0][1];
      const kx = dx > 0 ? (width - 2 * padding) / dx : Infinity;
      const ky = dy > 0 ? (height - 2 * padding) / dy : Infinity;
      const k = Math.min(kx, ky);
      return Number.isFinite(k) ? k : 1;
    };
    const ownBounds = HexagonViewComponent.planarBounds(own);
    const k = Math.min(fitScale(ownBounds), fitScale(HexagonViewComponent.planarBounds(other)));
    const cx = (ownBounds[0][0] + ownBounds[1][0]) / 2;
    const cy = (ownBounds[0][1] + ownBounds[1][1]) / 2;
    return d3.geoIdentity().scale(k).translate([width / 2 - k * cx, height / 2 - k * cy]);
  }

  private static planarBounds(features: CellFeature[]): [[number, number], [number, number]] {
    let b = HexagonViewComponent.boundsCache.get(features);
    if (!b) {
      b = d3.geoPath().bounds({ type: 'FeatureCollection', features } as any) as [[number, number], [number, number]];
      HexagonViewComponent.boundsCache.set(features, b);
    }
    return b;
  }

  public extendCluster(selectedCluster: string | number, _features?: CellFeature[]): void {
    this.activeClusterValue = selectedCluster;
    this.updateSelectionHighlight();
  }

  public resetClusterExtension(_features?: CellFeature[]): void {
    this.activeClusterValue = null;
    this.updateSelectionHighlight();
  }

  /**
   * isCategorical: the parent computes this (isActiveCategorical) and passes it explicitly
   * rather than this method reading @Input() legendInfo — called imperatively via @ViewChild
   * ahead of Angular's own change detection, so legendInfo could still hold the previous view's
   * stale value at this point (see the class doc above).
   */
  public setCurrentView(view: string, isCategorical: boolean): void {
    this.selectedView = view;
    if (this.lastRenderCtx) {
      this.lastRenderCtx.selectedView = view;
    }
    this.isActiveViewCategorical = isCategorical;
    if (!isCategorical) {
      this.activeClusterValue = null;
    }
    this.updateSelectionHighlight();
  }

  private isSameCluster(a: unknown, b: unknown): boolean {
    if (a === undefined || a === null || b === undefined || b === null) return false;
    return String(a).trim() === String(b).trim() || Number(a) === Number(b);
  }

  /**
   * Reapplies highlight borders consistently:
   * - Selected cell: thick black border (3px)
   * - Cluster members (categorical view ONLY): thin black border (1.4px)
   * - Other cells: transparent border
   * Highlighting is purely border-based without dimming cell colors.
   */
  public updateSelectionHighlight(): void {
    if (!this.g) return;
    const currentView = this.selectedView || this.lastRenderCtx?.selectedView || '';
    const activeCluster = this.isActiveViewCategorical ? this.activeClusterValue : null;

    const selectedBarcode = this.selectedCell?.properties?.barcode;
    const paths = this.detailLayer
      ? d3.selectAll<SVGPathElement, CellFeature>([
        ...this.g.selectAll<SVGPathElement, CellFeature>('path').nodes(),
        ...this.detailLayer.selectAll<SVGPathElement, CellFeature>('path').nodes(),
      ])
      : this.g.selectAll<SVGPathElement, CellFeature>('path');
    paths
      .each((d: CellFeature, i, nodes) => {
        if (!d || !d.properties) return;
        const isSelectedCell = selectedBarcode !== undefined && d.properties.barcode === selectedBarcode;
        const isClusterMember = activeCluster !== null && this.isSameCluster(d.properties[currentView], activeCluster);
        const state = isSelectedCell ? 2 : (isClusterMember ? 1 : 0);
        // Only touch the DOM for paths whose highlight actually changes: this runs over every
        // path on each recolor / selection / mouse-leave, and rewriting three attributes on
        // thousands of unchanged paths each time was a measurable part of the map's lag.
        const node = nodes[i] as SVGPathElement & { __hlState?: number };
        if (node.__hlState === state) return;
        node.__hlState = state;
        const el = d3.select(node);

        if (state === 2) {
          el.interrupt()
            .attr('stroke', '#000')
            .attr('stroke-width', this.strokeWidth(node, 3))
            .style('opacity', 0.85);
        } else if (state === 1) {
          el.interrupt()
            .attr('stroke', '#000')
            .attr('stroke-width', this.strokeWidth(node, 1.4))
            .style('opacity', 0.8);
        } else {
          el.interrupt()
            .attr('stroke', 'transparent')
            .attr('stroke-width', '1px')
            .style('opacity', 0.8);
        }
      });
  }

  /** Clears any hover outlines that might linger if the mouse exited the canvas rapidly. */
  public clearUnselectedHoverBorders(): void {
    this.updateSelectionHighlight();
  }

  private toNumber(v: unknown): number {
    if (typeof v === 'number') return v;
    if (typeof v === 'string') {
      const n = parseFloat(v);
      return Number.isFinite(n) ? n : NaN;
    }
    return NaN;
  }

  private formatHoverValue(v: unknown): string {
    if (v === null || v === undefined || v === '') return 'N/A';
    if (typeof v === 'number') {
      return Number.isInteger(v) ? String(v) : v.toFixed(3);
    }
    const str = String(v).trim();
    const num = parseFloat(str);
    if (!isNaN(num) && str === String(num)) {
      return Number.isInteger(num) ? String(num) : num.toFixed(3);
    }
    return str;
  }

  private updateTooltipPos(event: MouseEvent): void {
    if (!this.hexbinContainerRef?.nativeElement) return;
    const rect = this.hexbinContainerRef.nativeElement.getBoundingClientRect();
    this.hoverTooltipPos = {
      x: event.clientX - rect.left,
      y: event.clientY - rect.top - 12,
    };
  }

  private mouseOver(event: MouseEvent, d: CellFeature): void {
    const targetEl = (event.currentTarget || event.target) as SVGElement;
    if (!targetEl) return;
    const el = d3.select(targetEl);
    el.interrupt();
    // Hover styling diverges from the cached highlight state -- force the next
    // updateSelectionHighlight() to rewrite this path.
    (targetEl as { __hlState?: number }).__hlState = -1;

    const currentView = this.selectedView || this.lastRenderCtx?.selectedView || '';
    const activeCluster = this.isActiveViewCategorical ? this.activeClusterValue : null;

    const isSelectedCell = !!this.selectedCell && d.properties?.barcode === this.selectedCell.properties?.barcode;
    const isClusterMember = activeCluster !== null && this.isSameCluster(d.properties?.[currentView], activeCluster);

    const strokeWidth = this.strokeWidth(targetEl, isSelectedCell ? 3 : (isClusterMember ? 2 : 1.2));

    el.style('opacity', 0.95)
      .attr('stroke', '#000')
      .attr('stroke-width', strokeWidth);

    let rawValue = this.lastRenderCtx?.leidenCentralityProps.includes(this.selectedView)
      ? this.lastRenderCtx.leidenClusterAnnotations?.[String(d.properties?.leiden)]?.centrality?.[this.selectedView]
      : d.properties?.[this.selectedView];
    if (this.padjTransform) rawValue = padjToNegLog10(rawValue);

    const propLabel = this.legendInfo?.title || this.selectedView || 'Value';

    this.hoveredHexInfo = {
      barcode: d.properties?.barcode || '',
      propertyName: propLabel,
      value: this.formatHoverValue(rawValue),
      cluster: this.isActiveViewCategorical ? (d.properties?.[currentView] as string | number | undefined) : undefined,
    };

    this.updateTooltipPos(event);
    this.cdr.detectChanges();
  }

  private mouseMove(event: MouseEvent): void {
    if (this.hoveredHexInfo) {
      this.updateTooltipPos(event);
      this.cdr.detectChanges();
    }
  }

  private mouseLeave(event: MouseEvent, d: CellFeature): void {
    this.hoveredHexInfo = null;
    this.cdr.detectChanges();
    const targetEl = (event.currentTarget || event.target) as SVGElement;
    if (!targetEl) return;
    const el = d3.select(targetEl);
    el.interrupt();

    const currentView = this.selectedView || this.lastRenderCtx?.selectedView || '';
    const activeCluster = this.isActiveViewCategorical ? this.activeClusterValue : null;

    const isSelectedCell = !!this.selectedCell && d.properties?.barcode === this.selectedCell.properties?.barcode;
    const isClusterMember = activeCluster !== null && this.isSameCluster(d.properties?.[currentView], activeCluster);

    (targetEl as { __hlState?: number }).__hlState = isSelectedCell ? 2 : (isClusterMember ? 1 : 0);

    if (isSelectedCell) {
      el.attr('stroke', '#000')
        .attr('stroke-width', this.strokeWidth(targetEl, 3))
        .style('opacity', 0.85);
    } else if (isClusterMember) {
      el.attr('stroke', '#000')
        .attr('stroke-width', this.strokeWidth(targetEl, 1.4))
        .style('opacity', 0.8);
    } else {
      el.attr('stroke', 'transparent')
        .attr('stroke-width', '1px')
        .style('opacity', 0.8);
    }
  }

  // ======= Xenium detail window (main view only) =======

  public initDetailWindow(): void {
    this.svg.select('#detail-frame').remove();

    const defs = this.svg.select('defs').empty()
      ? this.svg.append('defs')
      : this.svg.select('defs');

    defs.select(`#${this.detailClipId}`).remove();

    defs.append('clipPath')
      .attr('id', this.detailClipId)
      .append('rect')
      .attr('id', 'detail-window')
      .attr('x', 30)
      .attr('y', 30)
      .attr('width', this.detailSize)
      .attr('height', this.detailSize);

    this.detailLayer.selectAll('.detail-bg').remove();

    // Backdrop in screen space, below the magnified cells.
    this.detailLayer
      .insert('rect', ':first-child')
      .attr('class', 'detail-bg')
      .attr('x', -10000)
      .attr('y', -10000)
      .attr('width', 20000)
      .attr('height', 20000)
      .attr('fill', '#ffffff')
      .attr('pointer-events', 'none');

    this.svg.append('rect')
      .attr('id', 'detail-frame')
      .attr('x', 30)
      .attr('y', 30)
      .attr('width', this.detailSize)
      .attr('height', this.detailSize)
      .attr('fill', 'none')
      .attr('stroke', '#111')
      .attr('stroke-width', 1)
      .style('pointer-events', 'none');
  }

  public bindDetailWindowInteractions(): void {
    if (!this.svg) return;

    this.svg.on('click.detail', null);
    this.svg.on('dblclick.detail', null);
    this.svg.on('contextmenu.detail', null);
    // d3.zoom zooms in on dblclick; on a magnifier map that fought the magnifier's own dblclick.
    this.svg.on('dblclick.zoom', null);

    this.zone.runOutsideAngular(() => {
      this.svg.on('dblclick.detail', (event: MouseEvent) => {
        event.preventDefault();
        event.stopPropagation();
        const [mx, my] = d3.pointer(event, this.svg.node());
        this.setDetailWindow(mx, my);
      });

      this.svg.on('contextmenu.detail', (event: MouseEvent) => {
        event.preventDefault();
        event.stopPropagation();
        this.clearDetailWindow();
      });
    });

    if (this.keydownHandler) {
      window.removeEventListener('keydown', this.keydownHandler);
    }
    this.keydownHandler = (event: KeyboardEvent) => {
      if (event.key === 'Escape') {
        this.clearDetailWindow();
      }
    };
    window.addEventListener('keydown', this.keydownHandler);
  }

  private setDetailWindow(screenX: number, screenY: number): void {
    // The dblclick binding outlives a switch to a non-Xenium dataset on the same <svg>.
    if (!this.lastRenderCtx?.isXenium) return;
    this.detailVisible = true;
    this.detailScreenPos = { x: screenX, y: screenY };
    this.showDetailWindowAt(screenX, screenY);
    this.updateDetailAtScreenPos(screenX, screenY);
  }

  private clearDetailWindow(): void {
    this.detailVisible = false;
    this.detailScreenPos = null;
    this.hideDetailWindow();
    this.detailLayer.selectAll('path').remove();
  }

  /**
   * Re-shows the magnifier detail window at its last screen position, if it was visible —
   * called by the parent's updateHexColors() after a recolor, matching the original's inline
   * `if (containerName === '#hexbin' && this.isXenium && this.detailVisible && this.detailScreenPos)`
   * guard. Kept as one method (rather than exposing detailVisible/detailScreenPos publicly) so
   * this instance's detail-window state stays encapsulated.
   */
  public refreshDetailWindowIfVisible(): void {
    if (!this.lastRenderCtx?.isXenium || !this.detailVisible || !this.detailScreenPos) return;
    this.showDetailWindowAt(this.detailScreenPos.x, this.detailScreenPos.y);
    this.updateDetailAtScreenPos(this.detailScreenPos.x, this.detailScreenPos.y);
  }

  public hideDetailWindow(): void {
    this.svg.select('#detail-window').style('display', 'none');
    this.svg.select('#detail-frame').style('display', 'none');
    this.detailLayer.style('display', 'none');
  }

  private showDetailWindowAt(screenX: number, screenY: number): void {
    this.svg.select('#detail-window')
      .attr('x', screenX - this.detailSize / 2)
      .attr('y', screenY - this.detailSize / 2)
      .style('display', null);

    this.svg.select('#detail-frame')
      .attr('x', screenX - this.detailSize / 2)
      .attr('y', screenY - this.detailSize / 2)
      .style('display', null);

    this.detailLayer.style('display', null);
  }

  private updateDetailAtScreenPos(screenX: number, screenY: number): void {
    const ctx = this.lastRenderCtx;
    if (!ctx?.isXenium || !this.currentPathGenerator) return;

    const half = this.detailSize / 2;

    const x0s = screenX - half;
    const x1s = screenX + half;
    const y0s = screenY - half;
    const y1s = screenY + half;

    const [x0d, y0d] = this.currentTransform.invert([x0s, y0s]);
    const [x1d, y1d] = this.currentTransform.invert([x1s, y1s]);

    const centerX = (x0d + x1d) / 2;
    const centerY = (y0d + y1d) / 2;

    // Magnification relative to the current map zoom. The detail layer is a child of the <svg>
    // (not of the zoomed <g>), so it maps projected coordinates straight to screen: center the
    // window's projected center on the click point, scaled by zoom * localScale. (Previously the
    // translate used zoom-inverted coordinates, which only lined up at zoom 1.)
    // 2x the current view, at least 6x the fitted view (zoom * 6 showed 3 cells at zoom 5).
    const k = Math.max(6, 2 * this.currentTransform.k);
    const localScale = k / this.currentTransform.k;

    this.detailContent.attr(
      'transform',
      `translate(${screenX},${screenY}) scale(${k}) translate(${-centerX},${-centerY})`,
    );

    // The window in data coordinates (centroids are stored unprojected, see renderHexagons).
    const projection = this.currentProjection;
    if (!projection) return;
    // Visible region = the window shrunk by localScale around its center (+ a cell of margin).
    const hx = ((x1d - x0d) / 2) / localScale * 1.3;
    const hy = ((y1d - y0d) / 2) / localScale * 1.3;
    const p0 = projection.invert([centerX - hx, centerY - hy]);
    const p1 = projection.invert([centerX + hx, centerY + hy]);
    if (!p0 || !p1) return;
    const minX = Math.min(p0[0], p1[0]);
    const maxX = Math.max(p0[0], p1[0]);
    const minY = Math.min(p0[1], p1[1]);
    const maxY = Math.max(p0[1], p1[1]);

    const subset = ctx.fullFeatures.filter((f) => {
      const c = (f.properties as any).__centroidData;
      if (!c || c.length < 2) return false;
      const [x, y] = c as [number, number];
      return x >= minX && x <= maxX && y >= minY && y <= maxY;
    });

    const pathGenerator = this.currentPathGenerator;
    const fillAccessor = this.fillAccessor;
    this.zone.runOutsideAngular(() => this.detailContent
      .style('cursor', 'pointer')
      .selectAll<SVGPathElement, CellFeature>('path')
      .data(subset)
      .join('path')
      .attr('d', (d: CellFeature) => pathGenerator(d) || '')
      .attr('fill', (d: CellFeature) => {
        if (fillAccessor) return fillAccessor(d);
        const value = ctx.leidenCentralityProps.includes(ctx.selectedView)
          ? ctx.leidenClusterAnnotations?.[String(d.properties.leiden)]?.centrality?.[ctx.selectedView]
          : d.properties?.[ctx.selectedView];
        if (ctx.legendType === 'categorical') {
          return ctx.colorScale(String(value));
        }
        const num = this.toNumber(value);
        return Number.isFinite(num) ? ctx.continuousColorScale(num) : '#ccc';
      })
      .attr('stroke', 'transparent')
      .attr('stroke-width', 1)
      // Outlines stay screen-sized instead of being magnified with the cells.
      .attr('vector-effect', 'non-scaling-stroke')
      .property('__hlState', null)
      .style('opacity', 1)
      .on('mouseover', (event, d) => this.mouseOver(event, d))
      .on('mousemove', (event) => this.mouseMove(event))
      .on('mouseleave', (event, d) => this.mouseLeave(event, d))
      .on('click', (event, d) => this.zone.run(() => this.cellClicked.emit({ event, cell: d }))));
    // Selected cell / cluster outlines also inside the magnifier.
    this.updateSelectionHighlight();
  }
}
