# NH DAO Registry — MVP Deployment Specification

**Status:** Draft
**Scope:** Deploy the current MVP safely, without the future GovCloud hardening work.

## Goal

Deploy the committed MVP as a working public reference service with:

- HTTPS `did:web` hosting.
- Persistent record and blob storage.
- Polygon Amoy anchor configuration.
- Optional Arweave Turbo public persistence for governance bytes.
- Filing API authentication.
- CI checks before deploy.
- Basic backup and recovery.

This document intentionally does not require Postgres, Redis, KMS/HSM, FedRAMP controls, or multi-AZ government infrastructure. Those belong in `docs/GOVERNMENT_DEPLOYMENT_SPEC.md`.

## Current Application Shape

The MVP is a Node 20 Express app. Runtime state is filesystem-backed:

- `data/records/<registryId>/dao.json`
- `data/records/<registryId>/agent.json`
- `data/records/<registryId>/meta.json`
- `data/records/<registryId>/governance.bin`
- `data/blobs/<cid>.bin`
- `data/keys/controller.json`, unless `CONTROLLER_PRIVATE_KEY` is set

The service exposes:

- `/` filing UI
- `/inspect` record inspector
- `/healthz` liveness
- `/readyz` local readiness
- `/api/file` filing endpoint
- `/api/records` record list
- `/api/verify/:id` verifier
- `/dao/:id/did.json` DAO DID document
- `/agent/:id/did.json` registered-agent DID document
- `/.well-known/did.json` registry controller DID
- `/ipfs/:cid` local blob fallback

## Required Environment

Use Node.js 20 or newer.

Minimum production-like variables:

```bash
NODE_ENV=production
PORT=3000
REGISTRY_HOST=registry.example.gov
REGISTRY_SCHEME=https
REQUEST_BODY_LIMIT=5mb
MAX_GOVERNANCE_BYTES=5242880

FILING_API_KEY=<strong-random-token>

AMOY_RPC_URL=https://...
ANCHOR_CONTRACT_ADDRESS=0x...
ANCHOR_PRIVATE_KEY=0x...

ANCHOR_MAX_RETRIES=3
ANCHOR_BASE_DELAY_MS=500

# Strongly preferred for deployed MVP:
CONTROLLER_PRIVATE_KEY=<64-hex-char-ed25519-seed>

# Optional public persistence:
ARWEAVE_JWK=<full-arweave-wallet-json>
ARWEAVE_TURBO_TOKEN=arweave
```

For MVP deployment, `CONTROLLER_PRIVATE_KEY` should come from the hosting platform's secret store. If it is omitted, the app creates `data/keys/controller.json`; that is acceptable only when the `data/` volume is encrypted, persistent, backed up, and access-restricted.

## Deployment Target

The simplest supported MVP target is:

- One Node process or container.
- One persistent encrypted volume mounted at `./data`.
- Reverse proxy or platform-managed HTTPS in front of port `3000`.
- Outbound HTTPS access to the configured Polygon Amoy RPC provider.
- Optional outbound HTTPS access to Arweave Turbo.

Suitable first targets include a small VM, a single ECS service with EFS, Fly.io/Render/Railway-like persistent disk hosting, or a container on a managed PaaS that supports durable mounted storage.

Do not run more than one active app instance against the same filesystem store. The MVP has atomic per-record directory reservation, but it does not have cross-process locking for reanchor and metadata writes.

## Pre-Deploy Checklist

- [ ] `npm ci` succeeds.
- [ ] `npm test` passes.
- [ ] `npm run test:integration` passes locally.
- [ ] Anchor contract is deployed to Polygon Amoy.
- [ ] `ANCHOR_CONTRACT_ADDRESS` is set to that deployment.
- [ ] Anchor signer has test MATIC.
- [ ] `FILING_API_KEY` is set.
- [ ] `REGISTRY_HOST` is the final public host.
- [ ] `REGISTRY_SCHEME=https`.
- [ ] `CONTROLLER_PRIVATE_KEY` is set from a secret store, or `data/keys/controller.json` is on a durable encrypted volume.
- [ ] Persistent `data/` backups are configured.
- [ ] Public URL serves `/.well-known/did.json`.
- [ ] Public URL serves `/healthz` and `/readyz`.

## Build And Run

```bash
npm ci
npm run compile
npm test
npm run test:integration
npm start
```

For a container deployment, use a minimal Node 20 image, install with `npm ci --omit=dev` after contract artifacts are available, expose port `3000`, and mount persistent storage at `/app/data`.

The repository does not currently include a Dockerfile. Add one before container deployment.

## Smoke Test

After deploy:

```bash
curl --fail https://$REGISTRY_HOST/healthz
curl --fail https://$REGISTRY_HOST/readyz
curl --fail https://$REGISTRY_HOST/.well-known/did.json
curl --fail https://$REGISTRY_HOST/api/records
```

Then submit one known-good filing through the UI or `POST /api/file` with:

```bash
Authorization: Bearer $FILING_API_KEY
Content-Type: application/json
```

Confirm:

- The response includes `registryId`, DAO DID, agent DID, governance CID, and no anchor warnings.
- `/dao/<registryId>/did.json` resolves.
- `/agent/<registryId>/did.json` resolves.
- `/api/verify/<registryId>` reports signatures, controller key, bidirectional link, chain anchors, and governance IPFS hash as passing.

## Operations

### Reanchor

Run after unclean shutdowns or anchor RPC incidents:

```bash
node scripts/reanchor.js --dry-run
node scripts/reanchor.js
```

Do not run `scripts/reanchor.js` concurrently with active filing traffic in the MVP deployment.

### Backup

Back up the entire `data/` directory. At minimum:

- `data/records`
- `data/blobs`
- `data/keys`, unless using `CONTROLLER_PRIVATE_KEY`
- `data/deployment-*.json`

Recommended cadence for MVP:

- Snapshot before every deploy.
- Daily encrypted backup retained for at least 30 days.
- Manual restore test before public launch.

### Restore

1. Stop the app.
2. Restore `data/` from backup.
3. Start the app.
4. Run `/readyz`.
5. Run `/api/verify/<registryId>` for a representative record.
6. Run `node scripts/reanchor.js --dry-run` to identify unfinished anchors.

## Known MVP Limitations

- Single active app process recommended.
- Filesystem store, not Postgres.
- In-memory rate limiter, not shared across replicas.
- API key auth, not SSO.
- Controller key can be file-backed.
- No update/re-filing workflow.
- No key rotation workflow.
- No deactivation workflow.
- No production audit log.
- Optional public IPFS pinning; local pin fallback remains authoritative for MVP verification.

## Deployment Decision

The MVP is deployable when the tests pass, the public host is stable, the anchor contract is configured, `FILING_API_KEY` is set, and `data/` persistence/backups are proven.
