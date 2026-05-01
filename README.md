# NH DAO Registry, reference implementation

A working reference implementation of the NH DAO Registry POC (v0.6).
Real cryptography. Real `did:web` hosting. Real IPFS CIDs with optional
Arweave persistence. Real Polygon Amoy chain anchor. No mocks in the
critical path.

## What this implements

For every filing, the registry does the following:

1. Validates the RSA 301-B MVP intake fields. The DAO name must end in
   `DAO` or `LAO`; the registered agent must have a physical NH street
   address; PO boxes are rejected. The filing must also include public
   eligibility evidence for bylaws, source code, GUI, smart-contract
   public address, registered domain, QA testing, communications,
   dispute-resolution mechanisms, legal-representative authorization, and
   decentralization/governance attestations. Accepted filings are recorded as
   evidence intake only; the registry does not certify legal status.
2. Pins the governance bytes locally under a real IPFS CIDv1, and optionally
   persists the same bytes as an Arweave transaction. Mandatory.
3. Builds DAO and registered-agent `did:web` intake-receipt documents,
   linked bidirectionally via `alsoKnownAs` and marked
   `submitted-intake` / `not-determined`.
4. Signs both documents with the registry's Ed25519 controller key
   (detached `JsonWebSignature2020` over the canonicalized JSON, per
   RFC 8785).
5. Records the SHA-256 canonical hash of each document on Polygon Amoy
   via the `DAORegistryAnchor` Solidity contract. One transaction per
   document, version-tracked.
6. Hosts both DID documents at resolvable HTTPS URLs. Anyone can run
   `did:web` resolution against `did:web:<host>:dao:<id>` and verify the
   signature, the chain anchor, the governance hash, optional Arweave
   mirror, and the bidirectional link to the agent.

## Learning walkthrough

This MVP is also meant to teach the full stack to a non-specialist reviewer:

- The browser UI in `public/` is the intake counter. It helps the user catch
  obvious input mistakes before submission.
- The Express API in `src/server.ts` is the service desk. It receives filings,
  serves DID documents, lists records, and exposes verification reports.
- `src/validation.ts` and `src/compliance.ts` are the rule checkers. They
  repeat the important checks on the server, where users cannot bypass them.
- `src/publication.ts` is the publishing line. It pins governance bytes, builds
  the DAO and registered-agent DID documents, signs them, saves them, and
  attempts chain anchoring.
- `src/store.ts` is the MVP record cabinet. In this reference deployment it is
  a filesystem under `data/`; a hardened deployment would replace this with a
  database/object store.
- `src/ipfs.ts` creates content-addressed governance bytes. Even when public
  Arweave persistence is not configured, the CID and local blob let the
  verifier prove the bytes have not changed.
- `contracts/DAORegistryAnchor.sol` is the public notary. It records a hash of
  each DID document version on Polygon Amoy.
- `src/verifier.ts` is the independent auditor. It resolves the public DID
  URLs, verifies signatures, checks DAO-agent links, recomputes hashes, and
  compares them with IPFS and the chain anchor.

In short: the UI collects evidence, the API publishes signed records, storage
keeps the artifacts, IPFS/chain provide public integrity signals, and the
verifier shows whether the pieces still agree.

```
                                Polygon Amoy
                                     ▲
                                     │ anchor(registryId, kind, version, sha256)
                                     │
   ┌─────────────┐  POST /api/file   │              ┌─────────────┐
   │  Filing UI  │ ─────────────────►│ Publication  │ ────► IPFS   │ local CID
   │ public/     │                   │ orchestrator │       (pin)  │ + Arweave
   └─────────────┘                   └──────┬───────┘              └─────────────┘
                                            │ saveRecord
                                            ▼
                                     data/records/
                                       <registryId>/
                                         dao.json
                                         agent.json
                                         meta.json
                                            ▲
                                            │ GET /dao/<id>/did.json
                                            │ GET /agent/<id>/did.json
                                            │ GET /api/verify/<id>
                                            │
                                       did:web resolver + verifier
```

## Prerequisites

- Node.js 20 or newer (for native `fetch`, `--watch`, `node:test`).
- A Polygon Amoy test account with a small amount of test MATIC. Get free
  test MATIC at https://faucet.polygon.technology.
- (Optional) An Arweave wallet with AR balance for public permanent
  persistence. Without it, the registry computes a real CIDv1 and pins to a
  local blob store.

## Quick start

```bash
git clone <this-repo>
cd nh-dao-registry-mvp
npm install
cp .env.example .env

# Fill in your .env: AMOY_RPC_URL, ANCHOR_PRIVATE_KEY at minimum.

# Compile and deploy the anchor contract to Amoy.
npm run compile
npm run deploy:amoy
# Copy the printed address into .env as ANCHOR_CONTRACT_ADDRESS.

# Run the registry.
npm start
```

Open http://localhost:3000 and file a registration. After filing:

- The DAO `did.json` is at http://localhost:3000/dao/<registryId>/did.json
- The agent `did.json` is at http://localhost:3000/agent/<registryId>/did.json
- The verification report is at http://localhost:3000/api/verify/<registryId>
- All records list at http://localhost:3000/inspect
- Health and readiness probes are at http://localhost:3000/healthz and
  http://localhost:3000/readyz

## Layout

```
contracts/   Solidity DAORegistryAnchor + Hardhat config
scripts/     deploy.cjs (Hardhat), verify-record.ts (CLI verifier)
src/         server, publication, didweb, crypto, canonicalize, ipfs,
             anchor, resolver, verifier, validation, compliance, store
public/      filing UI (index.html, app.js) and inspector (inspect.html)
test/        contract tests (Hardhat) and HTTP e2e tests (node:test)
data/        runtime: keys, records, blobs, deployment metadata
docs/        ARCHITECTURE.md
```

See `docs/ARCHITECTURE.md` for the module-by-module walkthrough.

## Tests

```
npm test                  # contract + e2e
npm run test:contract     # Hardhat tests for DAORegistryAnchor
npm run test:e2e          # HTTP e2e (does not require chain config)
```

The e2e suite exercises validation, signing, did:web hosting, alsoKnownAs,
governance hash verification, the RSA 301-B MVP evidence checklist, health/readiness
probes, and the resolver. It does not require a chain connection; chain anchor
checks are reported but not required to pass.

The contract test suite covers ownership, sequential versioning,
duplicate-version rejection, kind separation (DAO vs agent), and event
emission.

## CLI verifier

```
npm run verify -- granite-state-governance-dao
```

Resolves the DAO DID, fetches the agent, verifies both signatures, checks
bidirectional alsoKnownAs, reads the latest on-chain anchor, and confirms
the governance bytes hash to the value in the DAO document.

Each check prints with ✔ or ✘ and a one-line detail.

## Filing lifecycle and recovery

Each record's `meta.status` reports its position in the filing lifecycle:

| status            | meaning                                                                |
|-------------------|-------------------------------------------------------------------------|
| `anchored`        | both DAO and agent anchored on chain                                   |
| `partial`         | exactly one of DAO/agent anchored; the other had a permanent failure   |
| `unanchored`      | neither anchor confirmed (transient RPC failure persisted past retries) |
| `pending`         | filing is in flight or the process crashed mid-anchor                  |
| `anchor-disabled` | chain anchoring was not configured at filing time                      |

The disk record is written **before** any chain anchor is attempted, so a
crash mid-flight leaves the record discoverable (status will be `pending`)
rather than orphaning an on-chain anchor that nothing locally knows about.

To recover unanchored or partially-anchored records, run:

```
npm exec tsx scripts/reanchor.ts              # sweep all records
npm exec tsx scripts/reanchor.ts <registryId> # one specific record
npm exec tsx scripts/reanchor.ts --dry-run    # report only, no chain calls
```

The sweep is idempotent: a record whose anchor already lives on chain
(detected via the contract's `version already anchored` permanent error)
is treated as success without a duplicate write. Operationally, run the
sweep after any unclean shutdown of the registry server, or as a periodic
cron in production.

**Concurrency caveat (single-process MVP):** do not run `reanchor.ts`
concurrently with active filing requests against the same `data/records/`
directory. Both paths write `meta.json`, and there is no inter-process
lock yet. The contract's version monotonicity is the only safety net
against accidental duplicate-anchor calls — sufficient for an operator
running the sweep manually after a crash, but not for parallelized
scale-out (which is on the deferred list).

## Production posture

This is a reference. Before production, harden these:

- The controller private key lives at `data/keys/controller.json` for
  developer convenience. Production should set `CONTROLLER_PRIVATE_KEY`
  (a 64-char hex Ed25519 seed) from an HSM/KMS-backed secret rather than
  letting the key sit on disk, and rotate it via a published key-rotation
  procedure.
- The contract `owner` is the deployer's EOA. The contract supports a
  two-step `transferOwnership` / `acceptOwnership` flow; production should
  use it to hand ownership to a multisig (Gnosis Safe) plus a timelock.
- Public persistence falls back to local CID storage when Arweave is not
  configured. The publication API surfaces `publicPinStatus` and a
  top-level `warnings` array so an operator can detect a fall-back; before
  production, add at least one redundant public durability provider and a
  formal retention/export policy.
- Validation is server-side authoritative; the browser checks are UX. Do
  not soften this in any future variant.
- `POST /api/file` is open by default. Set `FILING_API_KEY` to require an
  `Authorization: Bearer <key>` header before exposing the endpoint, and
  put the registry behind your usual SSO at the network edge. The bundled
  filing UI has an "API key" section that stores the Bearer token in the
  tab's `sessionStorage` and auto-expands on a 401 — this is convenient
  for operator testing but is not a substitute for proper SSO.
- Per-IP rate limits are applied to filing and verification. The defaults
  (10 filings / 60 filings per minute) are tuned for a single-process POC;
  scale-out deployments should rely on the load balancer's limiter.
- Chain anchor calls retry on transient RPC failure with exponential
  backoff. Permanent reverts (duplicate version, wrong owner) are not
  retried. Production should also persist failed anchors to a queue so a
  later sweep can re-anchor them.

## Relationship to the spec

This MVP implements the architecture in the v0.6 POC spec. The full spec
lives at `../09-poc-spec-did-ipfs-demonstrator.md`. The matching visual
storyboard is at `../09-appendix-d-ui-storyboard.html`. When the spec
shape changes, update all three: spec, storyboard, MVP.

## License

Apache 2.0. See `LICENSE`.
