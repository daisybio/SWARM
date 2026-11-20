import { Injectable } from '@angular/core';
import { HttpClient } from '@angular/common/http';
import { Observable, Subject, of } from 'rxjs';
import { catchError, map, shareReplay, tap } from 'rxjs/operators';
import { environment } from '../environments/environment';

/**
 * Ensembl gene ids: ENSG00000141510 (human), ENSMUSG00000059552 (mouse), optionally with a
 * version suffix. Kept in sync with `_ENSEMBL_ID_RE` in backend/main.py.
 */
const ENSEMBL_ID_PATTERN = /^ENS[A-Z]{0,4}G\d{6,}(?:\.\d+)?$/i;

/**
 * The `X-Gene-Canonical` response header (percent-encoded by the backend) of a gene lookup
 * (`/X/{gene}`, `/obsm/{table}/{column}`), or null when absent/unreadable.
 */
export function readCanonicalHeader(headers: { get(name: string): string | null } | null | undefined): string | null {
  try {
    const raw = headers?.get('X-Gene-Canonical');
    return raw ? decodeURIComponent(raw) : null;
  } catch {
    return null;
  }
}

/**
 * The entry of `candidates` that `query` refers to: an exact match first (so nothing changes when
 * the casing already matches), otherwise the single case-insensitive match. Null when there is no
 * match or the case-insensitive match is ambiguous (e.g. both `Sox2` and `SOX2` present) -- the
 * caller then keeps what the user typed. For gene names, which some datasets store lower-case
 * (`lamp5`) and others not.
 */
export function matchGeneName(query: string | null | undefined, candidates: Iterable<string> | null | undefined): string | null {
  if (query == null || !candidates) return null;
  const q = String(query).trim();
  if (!q) return null;
  const lower = q.toLowerCase();
  let found: string | null = null;
  for (const c of candidates) {
    if (c === q) return c;
    if (typeof c === 'string' && c.toLowerCase() === lower) {
      if (found !== null && found !== c) return null;
      found = c;
    }
  }
  return found;
}

/**
 * Translates Ensembl gene ids into the gene symbols a biologist actually reads.
 *
 * SPONGE is what makes this necessary. Its ceRNA modules, its interaction network and every
 * score derived from them are keyed by Ensembl id, so without translation the SPONGE half of
 * the UI shows `ENSG00000141510` in exactly the places the GENIE3 half shows `TP53` — module
 * dropdowns, network nodes, global and per-spot score tables alike.
 *
 * Rather than patching each of those call sites, everything that renders a gene identifier
 * goes through `label()` (or the `geneSymbol` pipe that wraps it). Identifiers that aren't
 * Ensembl ids — GENIE3's symbols, motif names, ligand-receptor pairs — pass through untouched,
 * so the helper is safe to apply to any gene-ish column without knowing where it came from.
 *
 * The map is deliberately **shared across datasets** rather than kept per dataset: a label is
 * a display concern with no dataset in scope at most call sites (a table cell, a d3 node), and
 * an Ensembl id means the same gene everywhere, so merging costs nothing and keeps `label()`
 * callable from anywhere. Where two datasets disagree — different Ensembl releases can rename
 * a gene — the first dataset loaded wins, and the raw id is still available via `idFor()`.
 */
@Injectable({ providedIn: 'root' })
export class GeneSymbolService {
  /** ENSG (upper-cased, both versioned and unversioned) -> symbol. */
  private readonly symbols = new Map<string, string>();

  /** lower-cased symbol -> symbol, from the symbol maps; null marks a casing conflict. */
  private readonly symbolsByLower = new Map<string, string | null>();

  /** Organism of the current dataset ("human" | "mouse"); null = unspecified, no casing fallback. */
  private organism: 'human' | 'mouse' | null = null;

  /** Name as looked up -> the name the backend resolved it to (X-Gene-Canonical). */
  private readonly lookedUp = new Map<string, string>();

  /** In-flight / completed requests per dataset, so repeated selections don't refetch. */
  private readonly requests = new Map<string, Observable<Record<string, string>>>();

  private readonly changed = new Subject<void>();
  /**
   * Emits whenever newly loaded symbols became available. Template bindings pick the new
   * labels up on their own; imperative renderers (the d3 network graphs) subscribe to this to
   * redraw, since they'd otherwise keep whatever labels were current when they last ran.
   */
  public readonly changed$ = this.changed.asObservable();

  /**
   * Reads `environment.apiBaseUrl` directly rather than going through SessionService, which
   * exposes the same value. SessionService depends on DatasetService, and DatasetService is
   * what primes this service — taking the dependency would put this service inside that
   * import cycle for no gain, and a display-only helper has no business being entangled with
   * session bootstrapping.
   */
  private readonly apiUrl = environment.apiBaseUrl;

  constructor(private http: HttpClient) { }

  /**
   * Fetch and merge the symbol map for one dataset. Safe to call repeatedly — each dataset is
   * fetched at most once. A dataset with no Ensembl ids in its `var` yields an empty map, and
   * every id then simply keeps displaying as itself.
   */
  public load(datasetId?: string | null): Observable<Record<string, string>> {
    const cacheKey = datasetId || '__session__';
    const cached = this.requests.get(cacheKey);
    if (cached) {
      return cached;
    }

    const query = datasetId ? `?dataset_id=${encodeURIComponent(datasetId)}` : '';
    const request = this.http
      .get<{ symbols: Record<string, string> }>(
        `${this.apiUrl}/api/gene_symbols${query}`,
        { withCredentials: true },
      )
      .pipe(
        map((response) => response?.symbols ?? {}),
        tap((symbols) => this.merge(symbols)),
        catchError((err) => {
          // Not fatal: without a map the UI shows raw Ensembl ids, which is the old behaviour.
          console.warn(`[GeneSymbols] no symbol map for dataset "${cacheKey}"`, err);
          return of({} as Record<string, string>);
        }),
        shareReplay(1),
      );

    this.requests.set(cacheKey, request);
    // Kick the request off now rather than waiting for a subscriber: callers generally want the
    // map to be there by the time something renders, not to consume it directly.
    request.subscribe();
    return request;
  }

  private merge(symbols: Record<string, string>): void {
    let added = 0;
    for (const [id, symbol] of Object.entries(symbols || {})) {
      const key = String(id).trim().toUpperCase();
      if (!key || !symbol || this.symbols.has(key)) continue;
      this.symbols.set(key, String(symbol));
      this.addCasing(String(symbol));
      added++;
    }
    if (added > 0) {
      this.changed.next();
    }
  }

  private addCasing(symbol: string): void {
    const lower = symbol.toLowerCase();
    const existing = this.symbolsByLower.get(lower);
    if (existing === undefined) this.symbolsByLower.set(lower, symbol);
    else if (existing !== null && existing !== symbol) this.symbolsByLower.set(lower, null);
  }

  /** Sets the current dataset's organism (anything but human/mouse clears it). */
  public setOrganism(organism: string | null | undefined): void {
    const o = String(organism ?? '').trim().toLowerCase();
    this.organism = o === 'human' || o === 'mouse' ? o : null;
  }

  /**
   * Records which gene a lookup actually resolved to (the backend's `X-Gene-Canonical` header or
   * `canonical_gene` field), so `label()` shows that casing for the name the user typed/clicked.
   * Display only: the looked-up name itself is still what gets sent to the backend.
   */
  public noteCanonical(requested: string | null | undefined, canonical: string | null | undefined): void {
    const req = String(requested ?? '').trim();
    const can = String(canonical ?? '').trim();
    if (!req || !can || req === can || this.isEnsemblId(can)) return;
    if (req.toLowerCase() !== can.toLowerCase() && !this.isEnsemblId(req)) return; // not a re-casing
    if (this.lookedUp.get(req) === can) return;
    this.lookedUp.set(req, can);
    this.addCasing(can);
    // No changed$ emission: template bindings (the impure pipe) pick this up on their own, and
    // changed$ makes the regulatory graphs redraw, which a single re-cased name doesn't warrant.
  }

  /**
   * The canonical casing of a gene name that is not an Ensembl id, when one is known: what the
   * backend resolved this exact name to, or -- for all-lower-case names like `lamp5` from the
   * "mapped" datasets' tables -- the one symbol from the symbol maps with that spelling. Names
   * already in mixed/upper case are left alone (motif and TF names live in the same columns).
   */
  public canonicalCase(value: unknown): string | null {
    if (typeof value !== 'string') return null;
    const v = value.trim();
    const noted = this.lookedUp.get(v);
    if (noted) return noted;
    if (!v || v !== v.toLowerCase() || !/[a-z]/.test(v)) return null;
    const symbol = this.symbolsByLower.get(v);
    if (symbol && symbol !== v) return symbol;
    return this.organismCase(v);
  }

  /**
   * Fallback when no symbol map knows a lower-case gene name: the organism's convention
   * (human LAMP5, mouse Lamp5). Only for plain gene-like tokens, and only when the dataset
   * specifies its organism -- otherwise nothing is invented.
   */
  private organismCase(v: string): string | null {
    if (!this.organism || !/^[a-z][a-z0-9.-]{0,24}$/.test(v) || /^(hsa|mmu)-/.test(v)) return null; // miRNA ids keep their own casing
    return this.organism === 'human' ? v.toUpperCase() : v.charAt(0).toUpperCase() + v.slice(1);
  }

  /** Whether `value` is an Ensembl gene id (and therefore worth translating). */
  public isEnsemblId(value: unknown): boolean {
    return typeof value === 'string' && ENSEMBL_ID_PATTERN.test(value.trim());
  }

  /**
   * The symbol for an Ensembl id, or null when the id is unknown — genes filtered out of the
   * dataset before it was written simply have no symbol to offer.
   */
  public symbolFor(value: unknown): string | null {
    if (!this.isEnsemblId(value)) return null;
    const key = String(value).trim().toUpperCase();
    return this.symbols.get(key) ?? this.symbols.get(key.split('.')[0]) ?? null;
  }

  /**
   * Display label for any gene identifier: the symbol when one is known, otherwise the value
   * unchanged. Non-Ensembl input is returned as-is, which is what makes this safe to apply
   * globally.
   */
  public label(value: unknown): string {
    if (typeof value !== 'string') return String(value ?? '');
    return this.symbolFor(value) ?? this.canonicalCase(value) ?? value;
  }

  /** `TP53 (ENSG00000141510)` — for the few places with room to show both. */
  public labelWithId(value: unknown): string {
    const symbol = this.symbolFor(value);
    return symbol ? `${symbol} (${String(value).trim()})` : this.label(value);
  }

  /**
   * The raw identifier behind a label, for tooltips and `title` attributes — so translating a
   * label never hides the id the underlying data is actually keyed by. Null when nothing was
   * substituted and the label already *is* the id.
   */
  public idFor(value: unknown): string | null {
    return this.symbolFor(value) ? String(value).trim() : null;
  }

  /** Whether `value` matches `query` by either its symbol or its raw id — for table filters. */
  public matches(value: unknown, query: string): boolean {
    const needle = query.trim().toLowerCase();
    if (!needle) return true;
    const raw = typeof value === 'string' ? value : String(value ?? '');
    if (raw.toLowerCase().includes(needle)) return true;
    const symbol = this.symbolFor(raw) ?? this.canonicalCase(raw);
    return !!symbol && symbol.toLowerCase().includes(needle);
  }
}
