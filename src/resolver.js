/**
 * did:web resolver.
 *
 * Resolves a did:web identifier to its DID document by fetching the
 * conventional URL:
 *   did:web:host                   → https://host/.well-known/did.json
 *   did:web:host:path:to:thing     → https://host/path/to/thing/did.json
 *
 * In the POC, the registry hosts both DAO and agent documents, so resolving
 * either DID hits this server. In production, the same shape works against
 * the SoS-controlled domain (e.g. nhdaoregistry.nh.gov).
 *
 * For local development (REGISTRY_SCHEME=http on localhost) we relax the
 * https requirement; for any other host we enforce https per the did:web
 * spec.
 */

export class ResolutionError extends Error {
  constructor(message, did) {
    super(message);
    this.did = did;
  }
}

/** Convert a did:web identifier to its resolution URL. */
export function didWebToUrl(did, { scheme } = {}) {
  if (!did.startsWith('did:web:')) {
    throw new ResolutionError(`not a did:web identifier: ${did}`, did);
  }
  const rest = did.slice('did:web:'.length);
  const segs = rest.split(':');
  const host = decodeURIComponent(segs[0]);

  // Default scheme: http for localhost, https otherwise.
  const sch = scheme || (host.startsWith('localhost') || /^127\./.test(host) ? 'http' : 'https');

  if (segs.length === 1) {
    return `${sch}://${host}/.well-known/did.json`;
  }
  const pathSegs = segs.slice(1).map(decodeURIComponent);
  return `${sch}://${host}/${pathSegs.join('/')}/did.json`;
}

const ACCEPTED_DID_MEDIA_TYPES = [
  'application/did+json',
  'application/did+ld+json',
  'application/json',
];

function isAcceptedMediaType(contentType) {
  if (!contentType) return false;
  // Strip parameters (e.g. "application/did+json; charset=utf-8").
  const base = contentType.toLowerCase().split(';')[0].trim();
  return ACCEPTED_DID_MEDIA_TYPES.includes(base);
}

/** Fetch and parse a DID document. */
export async function resolve(did, opts = {}) {
  const url = didWebToUrl(did, opts);
  const res = await fetch(url, { headers: { Accept: 'application/did+json, application/json' } });
  if (!res.ok) {
    throw new ResolutionError(`HTTP ${res.status} fetching ${url}`, did);
  }
  const contentType = res.headers.get('content-type');
  if (!isAcceptedMediaType(contentType)) {
    throw new ResolutionError(
      `unexpected Content-Type ${contentType || '(none)'} from ${url}; expected one of ${ACCEPTED_DID_MEDIA_TYPES.join(', ')}`,
      did,
    );
  }
  const doc = await res.json();
  if (doc.id !== did) {
    throw new ResolutionError(`document id ${doc.id} does not match resolved did ${did}`, did);
  }
  return { did, url, document: doc };
}
