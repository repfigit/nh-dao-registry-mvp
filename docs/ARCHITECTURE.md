# Architecture

A walkthrough of the modules in `src/` and how a filing flows through them.

## Modules

`src/canonicalize.js`
RFC 8785 JSON Canonicalization Scheme. Sorts object keys by Unicode code
unit order, serializes values with JSON.stringify, returns a deterministic
UTF-8 string. The hash that goes on chain is computed over the output of
this function. Without canonicalization, two semantically identical
documents could hash to different values.

`src/crypto.js`
Ed25519 keypair generation, persistence, and detached
`JsonWebSignature2020`. The signing input is `<protected_header_b64url>.`
followed by the canonicalized payload bytes. The signature is base64url
encoded, and the JWS is reassembled as `<header>..<sig>` (the empty
middle segment marks it as detached). Verification recomputes the
signing input and uses Ed25519 verify against the JWK in the document's
`verificationMethod`.

`src/validation.js`
Registry-enforced filing invariants:

- DAO name MUST end in `DAO` or `LAO`. RSA 301-B:2, III.
- Registered agent MUST have a physical NH street address; PO boxes
  rejected.
- RSA 301-B MVP compliance evidence MUST be complete before publication:
  governance/bylaws URL, source URL, GUI URL, at least one smart-contract
  address, registered domain, public address, QA evidence, communications
  URL, dispute-resolution URLs, legal-representative authorization URL,
  lifecycle status, and required attestations.

Plus shape checks for CAIP-2 chain IDs and EVM addresses on smart
contract entries. The browser duplicates these checks; the server-side
checks here are authoritative.

`src/compliance.js`
Normalizes the RSA 301-B MVP evidence checklist into a stable
`evidence-submitted` record with `legalStatus: "not-determined"`. It
validates public URL evidence, registered domain shape, EVM public address
shape, lifecycle status, and required boolean attestations. This is
evidence-backed intake validation, not legal certification.

`src/didweb.js`
Builders for the two DID documents. Each document carries a single
`verificationMethod` (the registry's controller key, with the registry
`did:web:<host>` DID as the controller). Service endpoints for the DAO document include
`RegisteredAgent` (DID-typed), `DAOGovernanceDocument` (ordered array
with the CID first, optional Arweave endpoints, and optional user-supplied URL),
`DAOSourceCode`, `DAOUserInterface`,
one or more `DAOSmartContract`, `NHDAOComplianceChecklist`, and
`NHDAORegistryRecord`. The agent
document carries `registeredAgent.physicalAddress` (structured),
`AgentOfRecord` (DID-typed array pointing back at the DAO), and
`NHDAORegistryRecord`.

`canonicalContentHash(document)` strips `proof` and `anchors` before
hashing. This is what allows us to add anchors after signing without
invalidating the signature.

`src/ipfs.js`
Two-mode IPFS pinning. Always computes a real CIDv1 (sha2-256 multihash,
raw codec) from the bytes and saves them locally to `data/blobs/`. If
`ARWEAVE_JWK` is set, it also signs and posts the same bytes as an Arweave
transaction and records the Arweave receipt in metadata. The local pin is
what the verifier reads in CI; Arweave is the public durability mirror and is
independently hash-checked by the verifier when an Arweave endpoint is present. The
mandatory-pin rule is enforced here: there is no "skip pinning" path.

`src/anchor.js`
Polygon Amoy chain anchor via ethers v6. Calls
`DAORegistryAnchor.anchor(registryId, kind, version, contentHash)` and
returns the transaction details. `KIND.DAO = 0`, `KIND.AGENT = 1`. A
`readLatest(registryId, kind)` helper powers the verifier and uses the
contract's `hasAnchor` view to disambiguate "no anchor recorded" from
"all-zero anchor." The contract enforces strict version monotonicity
(v=1, then v=2, etc.) per (registryId, kind), so duplicate or
out-of-order anchors revert. Transient RPC failures retry with
exponential backoff (`ANCHOR_MAX_RETRIES`, `ANCHOR_BASE_DELAY_MS`);
permanent contract reverts are surfaced immediately.

`src/resolver.js`
`did:web` resolver. `did:web:host` resolves to
`https://host/.well-known/did.json`; `did:web:host:dao:<id>` resolves to
`https://host/dao/<id>/did.json`. Validates the resolved document's `id`
matches the DID that was requested. Falls through to `http://` for
localhost (the documented exception).

`src/verifier.js`
End-to-end verification. Resolves the DAO DID, resolves the agent DID
from the DAO's `alsoKnownAs`, verifies both detached JWS signatures
against the public keys in their `verificationMethod` blocks, checks
bidirectional `alsoKnownAs`, reads the latest on-chain anchor for each
(registryId, kind) and confirms the canonical hash matches, and reads
the IPFS-pinned governance bytes to confirm they hash to the
`contentHash` in the DAO document's `DAOGovernanceDocument` service
entry. Returns a structured report with one entry per check.

`src/store.js`
Filesystem-backed record store. Each filing produces
`data/records/<registryId>/{dao.json,agent.json,meta.json,governance.bin}`.
The Express server reads these to serve `did:web` URLs and the inspector
view. Replace with a real database for production.

`src/publication.js`
The orchestrator. Validates the input, atomically reserves a unique
registry directory (so two concurrent filings cannot collide), pins the
governance bytes (with a configurable size cap), builds both DID
documents, signs them, computes canonical hashes, anchors them on chain
(one transaction per document, retried on transient failure), attaches
the anchor metadata to each document, and persists everything to the
store. Returns `{ registryId, dao, agent, meta, warnings }` to the
caller. `meta.compliance` carries the normalized RSA 301-B MVP evidence.
Non-fatal issues (chain anchor disabled, public IPFS pin
failed, CID mismatch) appear in the `warnings` array rather than as
exceptions. v0.6 hardcodes the initial version to 1; the contract
already supports update workflows but `publication.js` does not yet
expose a re-filing path.

`src/server.js`
Express server. Routes:

- `GET /` filing UI
- `GET /healthz` liveness probe
- `GET /readyz` readiness probe
- `GET /inspect` records list and inspector
- `GET /api/records` list of filings
- `GET /api/records/:id` full record
- `POST /api/file` submit a filing
- `GET /api/verify/:id` run verification
- `GET /dao/:id/did.json` DID document
- `GET /agent/:id/did.json` DID document
- `GET /.well-known/did.json` registry's own DID
- `GET /ipfs/:cid` local blob fallback

## Data flow for a filing

```
Filer fills form
       │
       ▼
POST /api/file ────► validateFiling()        ──► error → 400 with details
       │
       ▼
publication.file(input, ctx)
       │
       ├─► pin(governanceBytes)              ──► CID + local pin (+ optional Arweave)
       │
       ├─► buildDaoDocument(...)             ──► unsigned DAO doc
       ├─► buildAgentDocument(...)           ──► unsigned agent doc
       │
       ├─► signDocument(dao,   ed25519 priv) ──► detached JWS attached
       ├─► signDocument(agent, ed25519 priv) ──► detached JWS attached
       │
       ├─► canonicalContentHash(dao)         ──► sha256 over canonical(no proof, no anchors)
       ├─► canonicalContentHash(agent)
       │
       ├─► recordAnchor(id, KIND.DAO,   1, daoHash)  ──► tx → Polygon Amoy
       ├─► recordAnchor(id, KIND.AGENT, 1, agentHash) ──► tx → Polygon Amoy
       │
       ├─► attachAnchor(dao,   {chainId, txHash, ...})
       ├─► attachAnchor(agent, {chainId, txHash, ...})
       │
       └─► saveRecord(registryId, {dao, agent, meta, governanceBytes})
```

## Data flow for a verification

```
GET /api/verify/<registryId>
       │
       ▼
verifier.verifyDao(registryId)
       │
       ├─► resolver.resolve("did:web:host:dao:<id>")    via fetch /dao/<id>/did.json
       ├─► extract agent DID from dao.alsoKnownAs[0]
       ├─► resolver.resolve("did:web:host:agent:<id>")  via fetch /agent/<id>/did.json
       │
       ├─► verifyDocumentSignature(daoDoc)
       │     - canonicalize(dao - proof - anchors)
       │     - reconstruct signing input
       │     - ed25519 verify
       ├─► verifyDocumentSignature(agentDoc)
       │
       ├─► verifyBidirectionalLink(daoDoc, agentDoc)
       │
       ├─► verifyChainAnchor(daoDoc,   id, KIND.DAO)
       │     - readLatest(id, KIND.DAO) on Polygon Amoy
       │     - compare on-chain contentHash to canonical hash of doc
       ├─► verifyChainAnchor(agentDoc, id, KIND.AGENT)
       │
       └─► verifyGovernanceIpfs(daoDoc)
             - read bytes from /ipfs/<cid> (local) or public gateway
             - sha256(bytes) == declared contentHash
```

The verifier does not trust any single source. Each check has its own
ground truth: the JWS signature checks the registry's controller key, the
chain anchor checks Polygon, the IPFS hash checks the document bytes
themselves. A document that passes all six checks has a complete chain of
custody from filing through publication to anchoring.

## What's not here

The POC scope deliberately omits:

- Update workflows. Re-issuing a DID document at version 2 works through
  the same path (publication produces v=2, anchor takes v=2 with the
  contract's strict-monotonic check); the UI doesn't expose it.
- Key rotation. The controller key is fixed for the lifetime of the
  process. Rotation is a publication-service concern; the schema
  supports multiple `verificationMethod` entries.
- Deactivation. A `deactivated: true` on a DID document plus a final
  "tombstone" anchor is the standard shape.
- Resolver fall-through. The verifier reads the local pin; in production
  the resolver chain should try IPFS gateway first, then registered URL,
  then local cache.
- Authentication. Anyone can post to `/api/file`. Production requires SSO
  or admin authentication and rate limiting.

The shape of all of these is described in the v0.6 POC spec.
