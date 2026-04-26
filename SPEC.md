# Spec pointer

This is a working reference implementation of the NH DAO Registry POC
(v0.6). The full specification lives in the parent project directory:

```
../09-poc-spec-did-ipfs-demonstrator.md
```

The visual storyboard that walks a non-technical audience through the
filing flow is at:

```
../09-appendix-d-ui-storyboard.html
```

## Conformance

This MVP implements:

- §IV two-DID identity model (DAO DID + registered agent DID,
  bidirectional `alsoKnownAs`, controller signing both).
- §V DID document schema:
  - `RegisteredAgent` service endpoint (DID-typed).
  - `DAOGovernanceDocument` service endpoint with ordered array of
    resolution URLs and `contentHash`.
  - `DAOSmartContract` service endpoints with CAIP-2 `chainId` and EVM
    `address`.
  - `DAOSourceCode`, `DAOUserInterface`, `NHDAORegistryRecord`.
  - `AgentOfRecord` service endpoint on the agent document.
  - structured `registeredAgent.physicalAddress` object.
- §VI naming rule validation (DAO name ends in `DAO` or `LAO`).
- §VII NH physical street address validation (no PO boxes).
- §VIII content hashing via canonicalized SHA-256.
- §IX mandatory IPFS pinning on every filing.
- §X chain anchor on Polygon Amoy via the `DAORegistryAnchor` Solidity
  contract; one transaction per (registryId, kind, version).
- §XI `did:web` resolution: both documents are served at HTTP endpoints
  derivable from the DID identifier alone.
- §XII end-to-end verification: signature, bidirectional link, chain
  anchor, governance hash.

## Out of scope

- Update workflows beyond v=1 (the contract supports them; the UI does
  not expose them).
- Key rotation and deactivation.
- Production durability beyond the local pin and the optional
  web3.storage upload.
- Filecoin durability deal management (the spec calls for it; this MVP
  pins to IPFS but does not negotiate Filecoin storage deals).

For these, see the spec.

## MVP elaborations beyond the parent spec

The parent POC spec (`§II.3 C3b`) explicitly says no smart contract is
required for chain anchoring — calldata alone is sufficient. The MVP
goes beyond that and uses a purpose-built contract
(`DAORegistryAnchor`). This is an additive elaboration, not drift.
Documenting it here so the choices are auditable:

- **Anchor contract.** `DAORegistryAnchor.sol` records
  `(registryIdHash, kind, version, contentHash, anchoredAt)` per anchor.
  Strict version monotonicity per `(registryId, kind)`. Two-step
  `transferOwnership` / `acceptOwnership` for handover to a multisig.
  `getLatest` reverts on missing; `hasAnchor` is a presence check.
- **`Anchored` event.** Indexes `registryIdHash`, `kind`, and
  `contentHash` so off-chain indexers can subscribe by hash.
- **Operator auth.** `FILING_API_KEY` env var enables Bearer-token
  authentication on `POST /api/file`. The bundled UI surfaces a key
  field (sessionStorage). This is operator-grade convenience, not
  end-user SSO; production deployments still need SSO at the network
  edge per the parent registry spec §6.
- **Controller key sourcing.** `CONTROLLER_PRIVATE_KEY` env var lets
  the controller key live in a secrets manager / KMS. Falls back to a
  JSON keyfile if unset (dev convenience).
- **Filing response shape.** `POST /api/file` returns
  `{ registryId, dao, agent, meta, warnings }`. The `warnings` array
  surfaces non-fatal issues (chain anchor disabled, public IPFS pin
  failed, CID mismatch) for an operator to act on. `meta.governance`
  carries `publicPinStatus`, `meta.anchorErrors` carries per-leg chain
  failures.
- **Rate limiting.** Per-IP token-bucket limits on `/api/file` and
  `/api/verify/:id`. Tunable via env (`FILING_RATE_MAX`,
  `VERIFY_RATE_MAX`). Single-process only; production scale-out should
  use the load balancer's limiter.
- **Anchor retry.** Transient RPC failures are retried with exponential
  backoff. Permanent reverts (already-anchored, non-sequential,
  not-owner) are not retried.

If the parent spec is ever revised to mandate a contract shape, an
event signature, or a response envelope, update both:

- `contracts/DAORegistryAnchor.sol` and `src/anchor.js` (event +
  function ABI must match).
- `src/publication.js` (response shape).

## Keeping spec, storyboard, and MVP in sync

When the DID document shape changes, three artifacts must be updated:

1. The full spec `09-poc-spec-did-ipfs-demonstrator.md`.
2. The visual storyboard `09-appendix-d-ui-storyboard.html` (the
   inspector view in frame D.8 shows full JSON and must reflect the
   actual shape).
3. This MVP (the builders in `src/didweb.js`, the verifier in
   `src/verifier.js`, the contract in `contracts/DAORegistryAnchor.sol`).

Drift between any two of these three is a bug.
