import * as d3 from 'd3';

/**
 * Categorical palettes that never repeat and stay perceptually distinct.
 *
 * A plain `d3.scaleOrdinal(palette)` wraps around once there are more categories than colors, so
 * e.g. 136 supertypes on the 8-color Set2 palette gave 17 unrelated categories the same color.
 * `extendedPalette(base, n)` returns n colors built like this:
 *
 *  1. The base colors keep their positions. A base color whose OKLab distance to an *earlier*
 *     color (or to the white map background / grey "missing value" fill) is below
 *     `BASE_MIN_DELTA_E` is replaced in place (same index) by a generated color, so the other,
 *     well-separated base colors keep their index -> color mapping (old screenshots stay
 *     comparable) while near-duplicates such as #ff9800 / #ffa726 disappear.
 *  2. Further colors are farthest-point picks from a fixed grid of sRGB colors in OKLCh whose
 *     lightness/chroma window is derived from the base palette (so pastel Set2 gets pastel
 *     extensions, not dark ones), clamped to a range that stays readable on the white map:
 *     each pick is the candidate with the largest minimum OKLab distance to every color already
 *     assigned (plus background and missing-value grey).
 *  3. When the window is exhausted, the same procedure continues on a wider lightness/chroma grid,
 *     so distances shrink smoothly instead of jumping to duplicates. Past that (thousands of
 *     categories) colors repeat cyclically -- deterministic, never crashes.
 *
 * Everything is deterministic and depends only on `base`: the same category index gets the same
 * color across renders and datasets, and a longer palette is a prefix-extension of a shorter one.
 *
 * Distances are OKLab Euclidean distances scaled by 100 ("ΔE_ok"); ~2 is a just-noticeable
 * difference, below ~7 two small map patches are easily confused.
 */

type Lab = [number, number, number];

/** Colors the generated ones must stay away from but that are never emitted themselves. */
const RESERVED_COLORS = ['#ffffff', '#cccccc'];

/** Base colors closer than this to an earlier color are replaced (see header). */
export const BASE_MIN_DELTA_E = 7;

/** Readable band on the white map background (OKLab lightness 0..1). */
const L_MIN_READABLE = 0.45;
const L_MAX_READABLE = 0.85;

// ---- color math (pure, no d3, so it can be unit-tested with plain node) --------------------

function parseHex(color: string): [number, number, number] | null {
  let h = color.trim().toLowerCase();
  if (h.startsWith('#')) h = h.slice(1);
  if (h.length === 3) h = h.split('').map((c) => c + c).join('');
  if (!/^[0-9a-f]{6}$/.test(h)) return null;
  return [parseInt(h.slice(0, 2), 16), parseInt(h.slice(2, 4), 16), parseInt(h.slice(4, 6), 16)];
}

const srgbToLinear = (v: number): number => {
  const x = v / 255;
  return x <= 0.04045 ? x / 12.92 : Math.pow((x + 0.055) / 1.055, 2.4);
};

const linearToSrgb = (x: number): number =>
  255 * (x <= 0.0031308 ? 12.92 * x : 1.055 * Math.pow(x, 1 / 2.4) - 0.055);

function linearRgbToOklab(r: number, g: number, b: number): Lab {
  const l = Math.cbrt(0.4122214708 * r + 0.5363325363 * g + 0.0514459929 * b);
  const m = Math.cbrt(0.2119034982 * r + 0.6806995451 * g + 0.1073969566 * b);
  const s = Math.cbrt(0.0883024619 * r + 0.2817188376 * g + 0.6299787005 * b);
  return [
    0.2104542553 * l + 0.793617785 * m - 0.0040720468 * s,
    1.9779984951 * l - 2.428592205 * m + 0.4505937099 * s,
    0.0259040371 * l + 0.7827717662 * m - 0.808675766 * s,
  ];
}

function oklabToLinearRgb([L, a, b]: Lab): [number, number, number] {
  const l = Math.pow(L + 0.3963377774 * a + 0.2158037573 * b, 3);
  const m = Math.pow(L - 0.1055613458 * a - 0.0638541728 * b, 3);
  const s = Math.pow(L - 0.0894841775 * a - 1.291485548 * b, 3);
  return [
    4.0767416621 * l - 3.3077115913 * m + 0.2309699292 * s,
    -1.2684380046 * l + 2.6097574011 * m - 0.3413193965 * s,
    -0.0041960863 * l - 0.7034186147 * m + 1.707614701 * s,
  ];
}

/** OKLab coordinates of a hex color (`#rgb` / `#rrggbb`); unparsable colors map to mid grey. */
export function hexToOklab(color: string): Lab {
  const rgb = parseHex(color) ?? [128, 128, 128];
  return linearRgbToOklab(srgbToLinear(rgb[0]), srgbToLinear(rgb[1]), srgbToLinear(rgb[2]));
}

const toHex2 = (v: number): string =>
  Math.max(0, Math.min(255, Math.round(v))).toString(16).padStart(2, '0');

/** `#rrggbb` for an OKLCh color, or null if it is outside the sRGB gamut. */
function oklchToHex(L: number, C: number, hDeg: number): string | null {
  const h = (hDeg * Math.PI) / 180;
  const lin = oklabToLinearRgb([L, C * Math.cos(h), C * Math.sin(h)]);
  if (lin.some((v) => v < -1e-4 || v > 1 + 1e-4)) return null;
  return '#' + lin.map((v) => toHex2(linearToSrgb(Math.max(0, Math.min(1, v))))).join('');
}

const labDistance = (a: Lab, b: Lab): number =>
  100 * Math.hypot(a[0] - b[0], a[1] - b[1], a[2] - b[2]);

/** Perceptual distance (OKLab Euclidean x 100) between two hex colors. */
export function deltaE(a: string, b: string): number {
  return labDistance(hexToOklab(a), hexToOklab(b));
}

/**
 * Smallest pairwise ΔE_ok among the first `n` colors of `colors` (Infinity for fewer than two),
 * with the indices of the closest pair. Use it to check a palette, e.g.
 * `minPairwiseDeltaE(extendedPalette(LEIDEN_CLUSTER_PALETTE, 40), 40)`.
 */
export function minPairwiseDeltaE(
  colors: readonly string[],
  n: number = colors.length,
): { deltaE: number; i: number; j: number } {
  const labs = colors.slice(0, n).map(hexToOklab);
  let best = { deltaE: Infinity, i: -1, j: -1 };
  for (let i = 0; i < labs.length; i++) {
    for (let j = i + 1; j < labs.length; j++) {
      const d = labDistance(labs[i], labs[j]);
      if (d < best.deltaE) best = { deltaE: d, i, j };
    }
  }
  return best;
}

// ---- palette generation ---------------------------------------------------------------------

interface Candidate {
  hex: string;
  lab: Lab;
}

/** sRGB colors on an OKLCh grid inside the given lightness/chroma window (deterministic order). */
function candidateGrid(lMin: number, lMax: number, cMin: number, cMax: number): Candidate[] {
  const out: Candidate[] = [];
  const seen = new Set<string>();
  const lSteps = Math.max(1, Math.round((lMax - lMin) / 0.03));
  const cSteps = Math.max(1, Math.round((cMax - cMin) / 0.025));
  for (let li = 0; li <= lSteps; li++) {
    const L = lMin + ((lMax - lMin) * li) / lSteps;
    for (let ci = 0; ci <= cSteps; ci++) {
      const C = cMin + ((cMax - cMin) * ci) / cSteps;
      for (let h = 0; h < 360; h += 6) {
        const hex = oklchToHex(L, C, h);
        if (!hex || seen.has(hex)) continue;
        seen.add(hex);
        out.push({ hex, lab: hexToOklab(hex) });
      }
    }
  }
  return out;
}

const chroma = (lab: Lab): number => Math.hypot(lab[1], lab[2]);

interface PaletteState {
  colors: string[];
  labs: Lab[];
  /** Candidate pools, tried in order: the base-matched window first, then a wider one. Built
   * lazily (the wider one is often never needed). */
  pools: (() => Candidate[])[];
  builtPools: Candidate[][];
  poolIndex: number;
  /** For each candidate of the current pool: distance to the nearest assigned/reserved color. */
  minDist: number[];
  used: Set<string>;
  /** Base colors still to be placed (index -> color); null = replaced by a generated color. */
  base: (string | null)[];
}

const paletteCache = new Map<string, PaletteState>();

function normalizeHex(color: string): string {
  const rgb = parseHex(color);
  return rgb ? '#' + rgb.map(toHex2).join('') : color;
}

function initState(base: readonly string[]): PaletteState {
  const reservedLabs = RESERVED_COLORS.map(hexToOklab);
  const kept: (string | null)[] = [];
  const keptLabs: Lab[] = [];
  for (const raw of base) {
    const hex = normalizeHex(raw);
    const lab = hexToOklab(hex);
    const tooClose = [...keptLabs, ...reservedLabs].some((o) => labDistance(o, lab) < BASE_MIN_DELTA_E);
    if (tooClose || !parseHex(raw)) {
      kept.push(null);
    } else {
      kept.push(hex);
      keptLabs.push(lab);
    }
  }

  // Lightness/chroma window of the kept base colors (ignoring near-greys for chroma), padded a
  // little and clamped to the readable band.
  let lMin = 0.6, lMax = 0.8, cMin = 0.08, cMax = 0.16;
  if (keptLabs.length > 0) {
    const ls = keptLabs.map((l) => l[0]);
    const cs = keptLabs.map(chroma).filter((c) => c > 0.03);
    lMin = Math.min(...ls) - 0.03;
    lMax = Math.max(...ls) + 0.03;
    if (cs.length > 0) {
      cMin = Math.min(...cs);
      cMax = Math.max(...cs);
    }
  }
  lMin = Math.max(L_MIN_READABLE, Math.min(lMin, L_MAX_READABLE - 0.1));
  lMax = Math.min(L_MAX_READABLE, Math.max(lMax, lMin + 0.1));
  cMin = Math.max(0.05, Math.min(cMin, 0.12));
  cMax = Math.max(cMin + 0.04, Math.min(cMax, 0.25));

  const pools = [
    () => candidateGrid(lMin, lMax, cMin, cMax),
    () => candidateGrid(0.4, 0.88, 0.04, 0.3),
  ];
  return {
    colors: [],
    labs: [],
    pools,
    builtPools: [],
    poolIndex: -1,
    minDist: [],
    used: new Set<string>(),
    base: kept,
  };
}

/** Switch to pool `index` and recompute every candidate's distance to the assigned colors. */
function enterPool(state: PaletteState, index: number): void {
  state.poolIndex = index;
  const anchors = [...state.labs, ...RESERVED_COLORS.map(hexToOklab)];
  // Distances to colors that are still to come from the base (later indices) also count: the
  // generated color for a replaced base slot must not collide with a later base color.
  for (const b of state.base.slice(state.colors.length)) if (b) anchors.push(hexToOklab(b));
  if (index < state.pools.length && !state.builtPools[index]) state.builtPools[index] = state.pools[index]();
  state.minDist = (state.builtPools[index] ?? []).map((cand) =>
    state.used.has(cand.hex) ? -1 : Math.min(...anchors.map((a) => labDistance(cand.lab, a))),
  );
}

function pushColor(state: PaletteState, hex: string): void {
  const lab = hexToOklab(hex);
  state.colors.push(hex);
  state.labs.push(lab);
  state.used.add(hex);
  const pool = state.builtPools[state.poolIndex] ?? [];
  for (let i = 0; i < pool.length; i++) {
    if (state.minDist[i] < 0) continue;
    if (pool[i].hex === hex) {
      state.minDist[i] = -1;
      continue;
    }
    const d = labDistance(pool[i].lab, lab);
    if (d < state.minDist[i]) state.minDist[i] = d;
  }
}

/** Below this, the base-matched window is considered used up and the wider grid takes over. */
const WINDOW_EXHAUSTED_DELTA_E = 6;

function nextGenerated(state: PaletteState): string {
  if (state.poolIndex < 0) enterPool(state, 0);
  for (;;) {
    const pool = state.builtPools[state.poolIndex];
    if (!pool) break;
    let best = -1;
    let bestDist = -1;
    for (let i = 0; i < pool.length; i++) {
      if (state.minDist[i] > bestDist) {
        bestDist = state.minDist[i];
        best = i;
      }
    }
    const lastPool = state.poolIndex === state.pools.length - 1;
    if (best >= 0 && (bestDist >= WINDOW_EXHAUSTED_DELTA_E || (lastPool && bestDist >= 0))) {
      return pool[best].hex;
    }
    enterPool(state, state.poolIndex + 1);
  }
  // Every candidate is used (thousands of categories): repeat deterministically.
  // (colors.length >= used.size, so this cycles through the unique colors in order.)
  return state.colors[state.colors.length % Math.max(1, state.used.size)] ?? '#888888';
}

/**
 * Returns at least `count` colors (and at least `base.length`): the well-separated `base` colors
 * at their original indices, generated colors elsewhere. The returned array is a fresh copy and
 * safe to hand to `scale.range()`.
 */
export function extendedPalette(base: readonly string[], count: number): string[] {
  const key = base.join('|');
  let state = paletteCache.get(key);
  if (!state) {
    state = initState(base);
    paletteCache.set(key, state);
  }
  const target = Math.max(count, base.length);
  while (state.colors.length < target) {
    const idx = state.colors.length;
    const fromBase = idx < state.base.length ? state.base[idx] : null;
    if (fromBase) {
      pushColor(state, fromBase);
    } else {
      pushColor(state, nextGenerated(state));
    }
  }
  return state.colors.slice(0, target);
}

/** Enough for any realistic category count without ever touching the scale again. */
const DEFAULT_PALETTE_SIZE = 256;

/** An ordinal scale on `base` whose range is pre-extended so it does not wrap around. */
export function categoricalScale(base: readonly string[]): d3.ScaleOrdinal<string, string> {
  return d3.scaleOrdinal<string>(extendedPalette(base, DEFAULT_PALETTE_SIZE));
}

/**
 * Grows `scale`'s range (keeping its existing colors as the prefix) if it has fewer colors than
 * `categoryCount`. Call before assigning a domain that might be larger than the current range.
 */
export function ensurePaletteCovers(
  scale: d3.ScaleOrdinal<string, string>,
  base: readonly string[],
  categoryCount: number,
): void {
  if (scale.range().length < categoryCount) {
    scale.range(extendedPalette(base, categoryCount));
  }
}
