import { CellFeature } from './cell-feature.types';

/**
 * Spot shape drawn on the map. The backend's GeoJSON carries either hexagon polygons with an
 * arbitrary baked-in radius (Visium) or bare points (Xenium cells, which d3.geoPath drew as a
 * fixed 4.5 px circle regardless of the real cell size). Both are re-derived here from each
 * spot's center and the dataset's measured spacing, so every technology gets a sensible size.
 *
 * Geometry per layout (pitch p = median nearest-neighbour distance, data units):
 *  - Hexagonal lattice (Visium / ST-like; detected by d6/d1 ~ 1): Visium spots are 55 um
 *    circles on a 100 um center-to-center lattice, so circle radius = 0.275 p (real size).
 *    Hexagons tile the lattice at circumradius p/sqrt(3); drawn at HEX_FILL of that so a gap
 *    shows, rotated to the lattice orientation.
 *  - Square lattice (binned grids, e.g. Visium HD bins / Xenium grid; d6/d1 ~ sqrt(2)): bins
 *    touch, circle radius = 0.45 p; hexagon inradius 0.42 p.
 *  - Irregular single cells (Xenium / MERFISH): circle radius from obs cell_area (area-equivalent
 *    disc, i.e. the real cell size), else 0.5 d1. Hexagons use the local-density rule of the
 *    pipeline (7 cells inside the 6th-neighbour distance d6), drawn at HEX_FILL.
 */
export type SpotShape = 'circle' | 'hexagon';
export type SpotLayoutKind = 'hex-lattice' | 'square-lattice' | 'cells';

export interface SpotLayout {
  kind: SpotLayoutKind;
  /** Median nearest-neighbour distance (data units). */
  pitch: number;
  /** Median distance to the 6th neighbour (data units). */
  d6: number;
  /** Lattice orientation: angle (rad) of the nearest-neighbour direction, modulo 60 deg. */
  latticeAngle: number;
  /** Median area-equivalent cell radius from `cell_area`, if usable (cells only). */
  medianCellRadius: number | null;
}

/** Fraction of the touching size hexagons are drawn at (1 = no gap). */
const HEX_FILL = 0.86;
/** Smallest drawn radius at the fitted (unzoomed) view, in screen px, so tiny cells stay visible. */
export const MIN_SCREEN_RADIUS = 0.8;

const layoutCache = new WeakMap<CellFeature[], SpotLayout>();

/** Spot center in data coordinates (properties.centroid, else the geometry). Cached per feature. */
export function spotCenter(f: CellFeature): [number, number] | null {
  const p = f.properties as any;
  if (p.__center !== undefined) return p.__center;
  let c: [number, number] | null = null;
  const pc = p.centroid;
  if (Array.isArray(pc) && pc.length >= 2 && Number.isFinite(+pc[0]) && Number.isFinite(+pc[1])) {
    c = [+pc[0], +pc[1]];
  } else {
    const g = f.geometry as any;
    if (g?.type === 'Point' && Array.isArray(g.coordinates)) {
      c = [+g.coordinates[0], +g.coordinates[1]];
    } else if (g?.type === 'Polygon' && Array.isArray(g.coordinates?.[0])) {
      const ring: number[][] = g.coordinates[0];
      const n = ring.length > 1 && ring[0][0] === ring[ring.length - 1][0] && ring[0][1] === ring[ring.length - 1][1]
        ? ring.length - 1 : ring.length;
      if (n > 0) {
        let sx = 0, sy = 0;
        for (let i = 0; i < n; i++) { sx += ring[i][0]; sy += ring[i][1]; }
        c = [sx / n, sy / n];
      }
    }
  }
  Object.defineProperty(p, '__center', { value: c, enumerable: false, writable: true, configurable: true });
  return c;
}

function median(a: number[]): number {
  if (!a.length) return NaN;
  const s = [...a].sort((x, y) => x - y);
  const m = s.length >> 1;
  return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2;
}

/**
 * Measures the layout of a dataset from (a sample of) its spot centers with a uniform bucket
 * grid -- O(n) to build, a few thousand k-NN queries -- and caches it per features array.
 */
export function measureSpotLayout(features: CellFeature[]): SpotLayout {
  const cached = layoutCache.get(features);
  if (cached) return cached;

  const pts: [number, number][] = [];
  for (const f of features) {
    const c = spotCenter(f);
    if (c && Number.isFinite(c[0]) && Number.isFinite(c[1])) pts.push(c);
  }
  const fallback: SpotLayout = { kind: 'cells', pitch: 1, d6: 2, latticeAngle: 0, medianCellRadius: null };
  if (pts.length < 8) {
    layoutCache.set(features, fallback);
    return fallback;
  }

  let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
  for (const [x, y] of pts) {
    if (x < minX) minX = x; if (x > maxX) maxX = x;
    if (y < minY) minY = y; if (y > maxY) maxY = y;
  }
  const w = Math.max(maxX - minX, 1e-9);
  const h = Math.max(maxY - minY, 1e-9);
  // ~2 points per bucket on average.
  const bucket = Math.max(Math.sqrt((w * h) / pts.length) * 1.4, 1e-9);
  const nx = Math.max(1, Math.ceil(w / bucket) + 1);
  const ny = Math.max(1, Math.ceil(h / bucket) + 1);
  const grid = new Map<number, number[]>();
  pts.forEach(([x, y], i) => {
    const key = Math.floor((y - minY) / bucket) * nx + Math.floor((x - minX) / bucket);
    let arr = grid.get(key);
    if (!arr) grid.set(key, (arr = []));
    arr.push(i);
  });

  const sampleN = Math.min(2000, pts.length);
  const step = pts.length / sampleN;
  const d1s: number[] = [];
  const d6s: number[] = [];
  const ratios: number[] = [];
  let sumCos = 0, sumSin = 0;
  for (let s = 0; s < sampleN; s++) {
    const i = Math.floor(s * step);
    const [x, y] = pts[i];
    const bx = Math.floor((x - minX) / bucket);
    const by = Math.floor((y - minY) / bucket);
    // Grow the search ring until 6 neighbours are found inside a radius that is certainly covered.
    for (let r = 2; r <= 8; r++) {
      const cand: { d: number; dx: number; dy: number }[] = [];
      for (let yy = Math.max(0, by - r); yy <= Math.min(ny - 1, by + r); yy++) {
        for (let xx = Math.max(0, bx - r); xx <= Math.min(nx - 1, bx + r); xx++) {
          const arr = grid.get(yy * nx + xx);
          if (!arr) continue;
          for (const j of arr) {
            if (j === i) continue;
            const dx = pts[j][0] - x, dy = pts[j][1] - y;
            const d = Math.hypot(dx, dy);
            if (d > 0) cand.push({ d, dx, dy });
          }
        }
      }
      cand.sort((a, b) => a.d - b.d);
      if (cand.length >= 6 && cand[5].d <= r * bucket) {
        d1s.push(cand[0].d);
        d6s.push(cand[5].d);
        ratios.push(cand[5].d / cand[0].d);
        // Lattice direction: average 6*theta so the six neighbour directions agree.
        const th = Math.atan2(cand[0].dy, cand[0].dx);
        sumCos += Math.cos(6 * th);
        sumSin += Math.sin(6 * th);
        break;
      }
    }
  }

  const pitch = median(d1s);
  const d6 = median(d6s);
  const ratio = median(ratios);
  if (!Number.isFinite(pitch) || pitch <= 0) {
    layoutCache.set(features, fallback);
    return fallback;
  }
  const kind: SpotLayoutKind = ratio < 1.08 ? 'hex-lattice' : ratio < 1.5 ? 'square-lattice' : 'cells';
  const latticeAngle = Math.atan2(sumSin, sumCos) / 6;

  let medianCellRadius: number | null = null;
  if (kind === 'cells') {
    const radii: number[] = [];
    const cstep = Math.max(1, Math.floor(features.length / 5000));
    for (let i = 0; i < features.length; i += cstep) {
      const a = +(features[i].properties as any)?.cell_area;
      if (Number.isFinite(a) && a > 0) radii.push(Math.sqrt(a / Math.PI));
    }
    const r = median(radii);
    // Only trust cell_area when it is in the same units as the coordinates (cells shouldn't be
    // much larger than the spacing between their centers).
    if (Number.isFinite(r) && r > 0.1 * pitch && r < 3 * pitch) medianCellRadius = r;
  }

  const layout: SpotLayout = { kind, pitch, d6: Number.isFinite(d6) ? d6 : 2 * pitch, latticeAngle, medianCellRadius };
  layoutCache.set(features, layout);
  return layout;
}

/** Circle radius (data units) for one spot. */
function circleRadius(f: CellFeature, layout: SpotLayout): number {
  switch (layout.kind) {
    case 'hex-lattice': return 0.275 * layout.pitch;
    case 'square-lattice': return 0.45 * layout.pitch;
    default: {
      if (layout.medianCellRadius !== null) {
        const a = +(f.properties as any)?.cell_area;
        if (Number.isFinite(a) && a > 0) return Math.sqrt(a / Math.PI);
        return layout.medianCellRadius;
      }
      return 0.5 * layout.pitch;
    }
  }
}

/** Hexagon circumradius (data units) and vertex angle offset (rad). */
function hexagonGeometry(layout: SpotLayout): { R: number; angle: number } {
  switch (layout.kind) {
    case 'hex-lattice':
      // Tiling hexagons have a vertex 30 deg off the nearest-neighbour direction.
      return { R: (HEX_FILL * layout.pitch) / Math.sqrt(3), angle: layout.latticeAngle + Math.PI / 6 };
    case 'square-lattice':
      return { R: (0.42 * layout.pitch) / Math.cos(Math.PI / 6), angle: Math.PI / 2 };
    default: {
      // Area per cell = pi*d6^2/7; hexagon area = 1.5*sqrt(3)*R^2.
      const R = Math.sqrt((Math.PI * layout.d6 * layout.d6) / 7 / (1.5 * Math.sqrt(3)));
      return { R: HEX_FILL * R, angle: Math.PI / 2 };
    }
  }
}

/**
 * Returns an SVG path generator for spots of the given shape, in projected (screen-at-fit)
 * coordinates. `project` maps data -> projected coordinates and `k` is its scale (projected
 * units per data unit).
 */
export function makeSpotPathGenerator(
  shape: SpotShape,
  layout: SpotLayout,
  project: (p: [number, number]) => [number, number] | null,
  k: number,
): (d: CellFeature) => string {
  const minR = MIN_SCREEN_RADIUS;
  const f2 = (v: number) => Math.round(v * 100) / 100;
  if (shape === 'circle') {
    return (d: CellFeature) => {
      const c = spotCenter(d);
      if (!c) return '';
      const p = project(c);
      if (!p) return '';
      const r = Math.max(circleRadius(d, layout) * k, minR);
      const x = f2(p[0] - r), y = f2(p[1]), rr = f2(r), dd = f2(2 * r);
      return `M${x},${y}a${rr},${rr} 0 1,0 ${dd},0a${rr},${rr} 0 1,0 ${-dd},0Z`;
    };
  }
  const { R, angle } = hexagonGeometry(layout);
  const Rs = Math.max(R * k, minR);
  // Precomputed vertex offsets (projection is a uniform scale + translate, no reflection).
  const offs: [number, number][] = [];
  for (let i = 0; i < 6; i++) {
    offs.push([Rs * Math.cos(angle + (Math.PI / 3) * i), Rs * Math.sin(angle + (Math.PI / 3) * i)]);
  }
  return (d: CellFeature) => {
    const c = spotCenter(d);
    if (!c) return '';
    const p = project(c);
    if (!p) return '';
    let s = `M${f2(p[0] + offs[0][0])},${f2(p[1] + offs[0][1])}`;
    for (let i = 1; i < 6; i++) s += `L${f2(p[0] + offs[i][0])},${f2(p[1] + offs[i][1])}`;
    return s + 'Z';
  };
}

/** Typical spot diameter (data units) for the given shape -- used to scale outline widths. */
export function typicalSpotDiameter(shape: SpotShape, layout: SpotLayout): number {
  if (shape === 'hexagon') return 2 * hexagonGeometry(layout).R;
  switch (layout.kind) {
    case 'hex-lattice': return 0.55 * layout.pitch;
    case 'square-lattice': return 0.9 * layout.pitch;
    default: return 2 * (layout.medianCellRadius ?? 0.5 * layout.pitch);
  }
}
