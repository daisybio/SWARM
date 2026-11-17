/**
 * Turns an HttpErrorResponse from the backend into a message a user can read.
 *
 * Backend contract (correlation routes, backend/spatial_correlation.py CorrelationError.to_body):
 *   { "detail": "<message>", "error": { "code", "message", side?, feature_id?, dataset_id?, gene?,
 *     candidates?, table?, column?, name?, n_observations? } }  + `X-Error-Code` response header.
 * Also accepted, defensively: `detail` as the structured object itself, a plain string `detail`,
 * or only the `X-Error-Code` header. Only `code` and `message` are relied on; every other field is
 * optional and looked up under a few plausible names.
 * Anything unrecognised -- 5xx errors and `correlation_failed` (whose text may be a raw exception),
 * FastAPI's list-shaped validation errors, network failures -- falls back to `fallback`.
 */

export interface ApiErrorDetail {
  code?: string;
  message?: string;
  [key: string]: unknown;
}

/** Codes whose message is an unfiltered exception text rather than something for users. */
const OPAQUE_CODES = new Set(['correlation_failed', 'internal_error']);

const isObject = (v: unknown): v is ApiErrorDetail => !!v && typeof v === 'object' && !Array.isArray(v);

const asString = (v: unknown): string | undefined =>
  typeof v === 'string' && v.trim() ? v.trim() : typeof v === 'number' ? String(v) : undefined;

function firstString(detail: ApiErrorDetail, keys: string[]): string | undefined {
  for (const k of keys) {
    const s = asString(detail[k]);
    if (s) return s;
  }
  return undefined;
}

function suggestionsOf(detail: ApiErrorDetail): string[] {
  const raw = detail['suggestions'] ?? detail['did_you_mean'] ?? detail['candidates'];
  if (!Array.isArray(raw)) return [];
  return raw
    .map((s) => (typeof s === 'string' ? s : asString((s as any)?.name ?? (s as any)?.symbol ?? (s as any)?.id)))
    .filter((s): s is string => !!s)
    .slice(0, 5);
}

/** Strips a `gene_expression::` style prefix from a feature id for display. */
const bareName = (s: string): string => (s.includes('::') ? s.split('::').slice(1).join('::') : s);

/** The parsed JSON body of an HTTP error (HttpClient gives a string for non-JSON responses). */
function errorBody(err: any): any {
  const body = err?.error;
  if (typeof body !== 'string') return body;
  try {
    return JSON.parse(body);
  } catch {
    return null;
  }
}

/** The structured error object (`detail` object, or the `error` object next to a string `detail`). */
export function apiErrorDetail(err: any): ApiErrorDetail | null {
  const body = errorBody(err);
  if (isObject(body?.detail)) return body.detail;
  if (isObject(body?.error)) return body.error;
  return null;
}

export function describeApiError(err: any, fallback: string): string {
  const status: number = typeof err?.status === 'number' ? err.status : 0;
  // 5xx / network errors: the detail (if any) is not meant for users.
  if (status < 400 || status >= 500) return fallback;

  let headerCode: string | undefined;
  try {
    headerCode = asString(err?.headers?.get?.('X-Error-Code'));
  } catch {
    headerCode = undefined;
  }
  const d = apiErrorDetail(err) ?? (headerCode ? { code: headerCode } : null);
  if (!d) {
    const detail = errorBody(err)?.detail;
    return typeof detail === 'string' && detail.trim() ? detail.trim() : fallback;
  }

  const code = (asString(d.code) ?? headerCode)?.toLowerCase();
  if (code && OPAQUE_CODES.has(code)) return fallback;
  const message = asString(d.message) ?? asString(errorBody(err)?.detail);
  const suggestions = suggestionsOf(d);
  const withSuggestions = (text: string, lead = 'Did you mean') =>
    suggestions.length ? `${text}. ${lead}: ${suggestions.join(', ')}?` : `${text}.`;
  const featureName = () => firstString(d, ['name', 'feature', 'feature_id', 'id', 'query', 'requested', 'given']);

  switch (code) {
    case 'gene_not_found': {
      const gene = firstString(d, ['gene', 'name', 'query', 'requested', 'given', 'symbol', 'feature', 'feature_id']);
      if (gene) return withSuggestions(`Gene '${bareName(gene)}' not found in this dataset`);
      break;
    }
    case 'gene_ambiguous': {
      const gene = firstString(d, ['gene', 'name', 'query', 'requested', 'given', 'symbol']);
      if (gene && suggestions.length) return `Gene name '${bareName(gene)}' is ambiguous in this dataset: ${suggestions.join(', ')}.`;
      break;
    }
    case 'feature_not_found': {
      const feat = featureName();
      if (feat) return withSuggestions(`'${bareName(feat)}' is not available in this dataset`);
      break;
    }
    case 'constant_feature':
    case 'feature_constant': {
      const feat = featureName();
      if (feat) return `'${bareName(feat)}' has the same value in every cell, so it cannot be correlated.`;
      return message ?? 'One of the selected features has the same value in every cell, so it cannot be correlated.';
    }
    case 'feature_all_missing': {
      const feat = featureName();
      if (feat) return `'${bareName(feat)}' has no values in this dataset.`;
      break;
    }
    case 'too_few_observations': {
      if (message) return message;
      const n = firstString(d, ['n_observations', 'n_obs', 'n', 'count', 'observed']);
      const base = 'Too few cells have values for both features to compute a correlation';
      return n ? `${base} (${n} cells).` : `${base}.`;
    }
  }
  if (!message) return fallback;
  return suggestions.length && !/did you mean/i.test(message) ? withSuggestions(message.replace(/\.$/, '')) : message;
}

/** Codes that explain why a valid request has no answer (e.g. a constant feature), as opposed to a
 * failed request -- the UI shows these as information rather than as an error. */
const EXPLANATORY_CODES = new Set([
  'feature_constant', 'constant_feature', 'feature_all_missing', 'feature_not_numeric',
  'too_few_observations', 'no_shared_cells',
]);

export function isExplanatoryApiError(err: any): boolean {
  let code = asString(apiErrorDetail(err)?.code);
  if (!code) {
    try {
      code = asString(err?.headers?.get?.('X-Error-Code'));
    } catch {
      code = undefined;
    }
  }
  return !!code && EXPLANATORY_CODES.has(code.toLowerCase());
}
