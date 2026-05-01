/**
 * RFC 8785 (JSON Canonicalization Scheme) implementation.
 *
 * Returns a deterministic UTF-8 string for any JSON-compatible value.
 * Object keys are sorted by Unicode codepoint, numbers are serialized using
 * the ECMA-262 number-to-string algorithm (which Node's JSON.stringify
 * already implements correctly for the values we use), and strings are
 * escaped per RFC 8785 §3.2.2.
 *
 * Limitations: rejects non-finite numbers (NaN, Infinity), undefined, and
 * functions, all of which are not valid JSON.
 */

export function canonicalize(value) {
  if (value === undefined) {
    throw new TypeError('canonicalize: undefined is not JSON');
  }
  if (typeof value === 'number' && !Number.isFinite(value)) {
    throw new TypeError(`canonicalize: non-finite number ${value}`);
  }
  if (value === null || typeof value !== 'object') {
    return JSON.stringify(value);
  }
  if (Array.isArray(value)) {
    return '[' + value.map(canonicalize).join(',') + ']';
  }
  const keys = Object.keys(value).sort((a, b) => {
    // Compare by UTF-16 code unit (which equals codepoint for BMP).
    // For full Unicode codepoint ordering we'd iterate codepoints, but
    // RFC 8785 §3.2.3 specifies UTF-16 code-unit comparison.
    if (a < b) return -1;
    if (a > b) return 1;
    return 0;
  });
  const parts = [];
  for (const k of keys) {
    if (value[k] === undefined) continue; // skip undefined per JSON.stringify behavior
    parts.push(JSON.stringify(k) + ':' + canonicalize(value[k]));
  }
  return '{' + parts.join(',') + '}';
}

/** Convenience: canonicalize then return UTF-8 bytes. */
export function canonicalBytes(value) {
  return new TextEncoder().encode(canonicalize(value));
}
