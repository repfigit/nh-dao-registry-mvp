# NH DAO Registry — Government Hardening Roadmap

**Status:** Draft roadmap
**Scope:** Future government-grade deployment after the MVP is already operating.

This document is intentionally not the MVP deployment guide. For the near-term deployment path, see `docs/MVP_DEPLOYMENT_SPEC.md`.

## Purpose

Define the major changes required to move the NH DAO Registry MVP from a single-instance reference deployment to a government-grade, auditable, highly available service.

Target posture:

- GovCloud or equivalent government-approved hosting.
- HSM/KMS-backed signing keys.
- Database-backed record store.
- Durable object storage for governance bytes.
- Shared rate limiting.
- Tamper-evident audit logging.
- Infrastructure as code.
- Formal backup, disaster recovery, incident response, and compliance evidence.

This is a roadmap, not an assertion that these controls are already met.

## Current MVP Baseline

The MVP currently uses:

- Filesystem records under `data/records`.
- Local blob storage under `data/blobs`.
- File-backed or env-backed Ed25519 controller key.
- In-memory rate limiting.
- Optional `FILING_API_KEY` bearer auth.
- Polygon Amoy anchoring through an EOA private key.
- Local verifier and reanchor scripts.

These choices are acceptable for the MVP but must be replaced or constrained for government production.

## Target Architecture

Recommended future-state components:

- WAF and public HTTPS load balancer.
- Private application service, likely ECS Fargate or equivalent.
- Postgres for record metadata and DID documents.
- S3 or equivalent object storage for governance bytes and audit objects.
- Redis or managed cache for shared rate limiting.
- KMS asymmetric Ed25519 key for DID document signatures, or CloudHSM if policy requires direct HSM custody.
- KMS HMAC key for audit event MACs, or CloudHSM-backed HMAC if required.
- Managed secp256k1 transaction signer for Polygon anchoring.
- Centralized logs, metrics, alerts, CloudTrail, and VPC flow logs.
- Terraform-managed infrastructure.

The anchor key is not Ed25519. Polygon/Ethereum transactions require secp256k1 signing. Any HSM/KMS design for anchoring needs a signer compatible with Ethereum transaction signatures.

## Key Management

### Controller DID Signing Key

The current MVP signs DID documents with Ed25519. AWS KMS supports Ed25519 asymmetric signing keys. A production implementation should:

- Create an asymmetric KMS key with key spec `ECC_NIST_EDWARDS25519`.
- Sign using the Ed25519 KMS signing algorithm, not ECDSA.
- Request `MessageType=RAW` for raw Ed25519 signing unless deliberately using the prehash variant.
- Store the KMS public key in the registry DID document in JWK-compatible form.
- Reject `CONTROLLER_PRIVATE_KEY` and `CONTROLLER_KEY_PATH` in production mode.

Implementation impact:

- Make document signing async.
- Introduce a signer interface so local/dev signing and KMS signing share one publication path.
- Keep verifier support for public JWK verification outside KMS.
- Add tests that sign through an injectable fake KMS signer and verify with the existing verifier.

### Audit MAC Key

AWS KMS HMAC keys use `GenerateMac` and `VerifyMac`, not `Sign` and `Verify`.

Production audit code should:

- Use a KMS key spec such as `HMAC_256`.
- Call `GenerateMac` for each canonical audit event.
- Call `VerifyMac` during audit verification.
- Store the MAC with the event payload.

### Anchor Transaction Key

Ethereum-compatible anchoring requires secp256k1. Options:

- Short term: keep `ANCHOR_PRIVATE_KEY` in a secret manager with strict IAM and rotation.
- Better: use a managed custody/signing service that supports Ethereum transactions.
- Advanced: implement an ethers signer backed by CloudHSM or KMS secp256k1 signing, including recovery-id handling.

This work should be designed separately from DID document signing.

## Record Store

Replace the filesystem store with a storage abstraction before introducing Postgres:

```text
src/store.ts
  FileStore       current MVP implementation
  PostgresStore   production implementation
```

The production store should provide async methods for:

- Reserving a registry ID atomically.
- Saving signed-but-not-yet-anchored records.
- Updating anchors independently.
- Listing records.
- Loading DAO, agent, and meta documents.
- Reading governance bytes by CID.

Postgres schema should include:

- `records.registry_id` primary key.
- `dao_doc` JSONB.
- `agent_doc` JSONB.
- `meta` JSONB.
- `governance_cid` text.
- `status` generated or indexed from meta.
- `created_at` and `updated_at`.
- Optional immutable `record_versions` table for future update workflows.

Governance bytes should live in object storage under a content-addressed key such as `governance/<cid>.bin`.

Important MVP field mapping:

- Current CID path is `meta.governance.cid`, not `meta.ipfsCid`.
- Verification check objects use `ok`, not `passed`.

## Audit Logging

Audit logging must be append-safe and tamper-evident.

Do not write daily NDJSON to the same S3 object with repeated `PutObject`; that overwrites rather than appends. Use one immutable object per event or a controlled batching service.

Recommended object key:

```text
audit/YYYY/MM/DD/<sequence>-<event-id>.json
```

Each event should include:

- Stable event ID.
- Monotonic sequence from Postgres sequence, DynamoDB counter, or another durable source.
- Action.
- Actor identity and source IP.
- Registry ID when available.
- Outcome.
- Redacted details.
- Timestamp.
- MAC/signature over a canonical event payload.

Required event families:

- Filing start, success, validation failure, and unexpected failure.
- DID document signature creation.
- IPFS/local/public pin outcomes.
- Chain anchor success and failure.
- Reanchor sweep start, per-record result, and completion.
- Verification start and result.
- Admin/configuration changes.
- Key lifecycle events.

Audit writes should fail closed for filing publication if the policy requires a complete audit trail. Verification endpoints may fail open or closed depending on operational policy, but the choice should be explicit.

## Authentication And Authorization

`FILING_API_KEY` is enough for MVP deployment, not government production.

Future production should define:

- Identity provider and SSO integration.
- Admin/operator roles.
- Filing submitter role.
- Read-only auditor role.
- Machine role for reanchor jobs.
- Break-glass procedure.
- Session lifetime and MFA requirements.

Keep public DID resolution endpoints unauthenticated. Protect filing and administrative endpoints.

## Rate Limiting

Move from in-memory token buckets to shared rate limiting:

- Redis-backed limiter for app-level limits.
- WAF rate rules for coarse perimeter protection.
- Separate limits for filing, verification, records API, and static/DID reads.
- Correct client IP handling through trusted proxy configuration.

The Express app should set `trust proxy` only for the deployment’s load balancer/proxy chain.

## Network And Infrastructure

Future-state infrastructure should include:

- Public WAF and HTTPS load balancer.
- Private app tasks with no public IPs.
- Private database/cache/object-storage access through security groups and VPC endpoints where available.
- Controlled NAT egress for RPC/IPFS providers.
- CloudTrail, VPC flow logs, and centralized application logs.
- Encrypted Terraform state with locking.
- Manual approval for production deploys.

Do not put database passwords or API tokens directly in ECS environment variables. Use ECS secrets from Secrets Manager or SSM Parameter Store, IAM database authentication where practical, and scoped IAM roles.

## CI/CD And Supply Chain

Deployment pipeline should add:

- Existing `npm test`.
- Existing integration test.
- Dependency audit.
- SAST.
- Secret scanning.
- Docker image build.
- Container vulnerability scanning.
- SBOM generation.
- Image signing or provenance attestation.
- Terraform formatting, validation, plan, and policy checks.
- Manual production approval.
- Post-deploy smoke tests.

The deploy workflow in this roadmap should not use `:latest` images. Pin deployments by immutable digest or commit SHA tag.

## Backup And Disaster Recovery

Production backup requirements:

- Postgres point-in-time recovery.
- Object storage versioning and retention.
- Audit object retention with Object Lock.
- Tested restore procedure.
- Documented RTO/RPO.
- Separate backup of signing-key metadata and public DID material.

CloudHSM clusters do have backup and restore mechanics; do not state “no backup” without a key-custody decision. If using KMS, document key deletion protection, rotation/replacement procedure, grants, and recovery constraints.

## Compliance Evidence

Do not mark controls as “Met” until implemented and evidenced.

Use statuses:

- `MVP`
- `Planned`
- `Implemented`
- `Verified`
- `Not applicable`

Initial roadmap status:

| Requirement | Status | Notes |
|---|---|---|
| FedRAMP Moderate posture | Planned | Requires formal control implementation and assessment. |
| Data residency | Planned | Depends on selected region/account. |
| HSM/KMS key management | Planned | MVP still supports env/file key. |
| Tamper-evident audit logging | Planned | Not present in MVP. |
| Encryption at rest | Planned | Depends on target infra. |
| Encryption in transit | MVP | Achieved through deployment HTTPS, not app alone. |
| Access control | MVP | API key only. |
| Backup/DR | Planned | MVP requires filesystem backup. |
| Incident response | Planned | Needs runbook. |
| Penetration testing | Planned | Needs third-party process. |

## Migration Phases

### Phase 0: MVP Deployment

Use `docs/MVP_DEPLOYMENT_SPEC.md`.

### Phase 1: Abstractions

- Add signer interface.
- Add store interface.
- Add audit interface with local no-op/dev implementation.
- Add production config validation.

### Phase 2: Durable Services

- Implement Postgres store.
- Implement object storage for governance bytes.
- Implement Redis-backed rate limiting.
- Add migration scripts from filesystem to Postgres/object storage.

### Phase 3: Key And Audit Hardening

- Implement KMS Ed25519 DID signing.
- Implement KMS HMAC audit MACs with `GenerateMac`/`VerifyMac`.
- Add immutable audit object writer.
- Add audit verification tooling.

### Phase 4: Infrastructure

- Write Terraform modules.
- Add secrets management.
- Add WAF, ALB, private app service, database, cache, object storage, logs, and alerts.
- Add CI/CD deployment workflow.

### Phase 5: Operational Readiness

- Restore test.
- DR test.
- Key replacement test.
- Reanchor runbook test.
- Security review.
- Compliance evidence collection.

## Open Questions

- Is the production filing endpoint public, staff-only, or integrated with an existing state identity provider?
- What is the required chain for production: still Polygon Amoy for demonstration, Polygon mainnet, or another public chain?
- What retention period applies to filings, governance bytes, audit logs, and application logs?
- Does policy require CloudHSM specifically, or is AWS KMS acceptable?
- Is public durability beyond the official registry store required, and through which provider?
- What is the required RTO/RPO for the registry?
- Who can trigger reanchor, key replacement, or emergency filing shutdown?
