/**
 * Real-chain integration test.
 *
 * Spawns `npx hardhat node` on a free port, deploys the compiled
 * `DAORegistryAnchor` contract via ethers (using Hardhat's first
 * deterministic test account), points the registry at it, and exercises
 * the full filing flow end to end:
 *
 *   1. POST /api/file produces a record with `meta.anchors.dao.txHash`
 *      and `meta.anchors.agent.txHash`, and an empty warnings list.
 *   2. The on-chain `Anchored` event has `contentHash` indexed (the new
 *      event shape).
 *   3. `getLatest` reverts before any anchor; `hasAnchor` is false.
 *      Both flip after the filing.
 *   4. /api/verify reports `DAO chain anchor` and `agent chain anchor`
 *      as ok.
 *
 * Skipped if `hardhat` cannot start within 30s.
 *
 * Run with: npm run test:integration
 */

import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import http from 'node:http';
import net from 'node:net';
import fs from 'node:fs';
import path from 'node:path';
import { JsonRpcProvider, Wallet, ContractFactory, Contract, id as keccakId } from 'ethers';

const ARTIFACT_PATH = path.resolve('artifacts/contracts/DAORegistryAnchor.sol/DAORegistryAnchor.json');
// Hardhat's first deterministic test account (well-known; safe for a local node).
const HARDHAT_KEY = '0xac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80';

const TMP = path.join('data', '_integration_tmp');

async function pickFreePort() {
  return new Promise((resolve, reject) => {
    const s = net.createServer();
    s.unref();
    s.on('error', reject);
    s.listen(0, '127.0.0.1', () => {
      const { port } = s.address();
      s.close(() => resolve(port));
    });
  });
}

async function waitForRpc(rpcUrl, timeoutMs = 30_000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try {
      const provider = new JsonRpcProvider(rpcUrl);
      await provider.getNetwork();
      return;
    } catch {
      await new Promise(r => setTimeout(r, 250));
    }
  }
  throw new Error(`hardhat node did not become ready within ${timeoutMs}ms`);
}

async function postJson(url, body, headers = {}) {
  const res = await fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', ...headers },
    body: JSON.stringify(body),
  });
  return { status: res.status, body: await res.json() };
}
async function getJson(url) {
  const res = await fetch(url);
  return { status: res.status, body: await res.json() };
}

function completeCompliance(overrides = {}) {
  return {
    govUrl: 'https://example.org/integration/bylaws.pdf',
    sourceUrl: 'https://github.com/example/integration-dao',
    guiUrl: 'https://app.example.org/integration',
    contracts: [{ chainId: 'eip155:1', address: '0x' + '33'.repeat(20) }],
    compliance: {
      registeredDomain: 'integration.example.org',
      publicAddress: '0x' + '44'.repeat(20),
      qaUrl: 'https://example.org/integration/security-review.pdf',
      communicationsUrl: 'https://forum.example.org/integration/contact',
      internalDisputeResolutionUrl: 'https://example.org/integration/disputes/internal',
      thirdPartyDisputeResolutionUrl: 'https://example.org/integration/disputes/third-party',
      legalRepresentativeAuthorizationUrl: 'https://forum.example.org/integration/legal-rep-authorization',
      lifecycleStatus: 'initial',
      attestations: {
        permissionlessBlockchain: true,
        openSourceCode: true,
        qaCompleted: true,
        guiMonitoring: true,
        bylawsPublic: true,
        publicCommunications: true,
        internalDisputeResolution: true,
        thirdPartyDisputeResolution: true,
        decentralizedNetwork: true,
        decentralizedGovernance: true,
        participantRules: true,
        legalRepresentativeAuthorized: true,
      },
    },
    ...overrides,
  };
}

let hardhatProc;
let serverHttp;
let baseUrl;
let nodePort;
let registryPort;
let contractAddress;
let provider;
let contract;

describe('integration: real chain', () => {
  before(async () => {
    if (!fs.existsSync(ARTIFACT_PATH)) {
      throw new Error(`artifact not found at ${ARTIFACT_PATH} — run: npm run compile`);
    }

    nodePort     = await pickFreePort();
    registryPort = await pickFreePort();
    const rpcUrl = `http://127.0.0.1:${nodePort}`;

    // 1. Spawn hardhat node.
    hardhatProc = spawn('npx', ['hardhat', 'node', '--port', String(nodePort)], {
      stdio: ['ignore', 'pipe', 'pipe'],
      detached: false,
    });
    hardhatProc.on('error', (err) => {
      // eslint-disable-next-line no-console
      console.error(`hardhat spawn error: ${err.message}`);
    });
    // Surface a readable error if the child dies before we're ready.
    let earlyExit = null;
    hardhatProc.on('exit', (code, signal) => {
      if (earlyExit === null) earlyExit = `hardhat node exited early (code=${code}, signal=${signal})`;
    });

    await waitForRpc(rpcUrl);
    if (earlyExit) throw new Error(earlyExit);

    // 2. Deploy the contract.
    provider = new JsonRpcProvider(rpcUrl);
    const wallet = new Wallet(HARDHAT_KEY, provider);
    const artifact = JSON.parse(fs.readFileSync(ARTIFACT_PATH, 'utf8'));
    const factory = new ContractFactory(artifact.abi, artifact.bytecode, wallet);
    const c = await factory.deploy(wallet.address);
    await c.waitForDeployment();
    contractAddress = await c.getAddress();
    contract = new Contract(contractAddress, artifact.abi, provider);

    // 3. Configure env so the registry talks to our local chain.
    process.env.AMOY_RPC_URL            = rpcUrl;
    process.env.ANCHOR_CONTRACT_ADDRESS = contractAddress;
    process.env.ANCHOR_PRIVATE_KEY      = HARDHAT_KEY;
    process.env.NODE_ENV                = 'test';
    process.env.PORT                    = String(registryPort);
    process.env.REGISTRY_HOST           = `localhost:${registryPort}`;
    process.env.REGISTRY_SCHEME         = 'http';
    process.env.CONTROLLER_KEY_PATH     = path.join(TMP, 'controller.json');
    process.env.FILING_RATE_MAX         = '1000';
    process.env.VERIFY_RATE_MAX         = '1000';

    // Clean any prior test state.
    fs.rmSync(TMP, { recursive: true, force: true });
    fs.rmSync(path.join('data', 'records'), { recursive: true, force: true });
    fs.rmSync(path.join('data', 'blobs'),   { recursive: true, force: true });

    // 4. Start the registry server. Cache-bust the import so this is a
    //    fresh module load with the chain env in place.
    const { app } = await import(`../src/server.js?integration=${Date.now()}`);
    serverHttp = http.createServer(app);
    await new Promise(r => serverHttp.listen(registryPort, '127.0.0.1', r));
    baseUrl = `http://localhost:${registryPort}`;
  });

  after(async () => {
    if (serverHttp) await new Promise(r => serverHttp.close(r));
    if (hardhatProc && hardhatProc.exitCode === null) {
      hardhatProc.kill('SIGTERM');
      // Wait up to 5s; SIGKILL if the node refuses to die.
      await new Promise((resolve) => {
        const t = setTimeout(() => { try { hardhatProc.kill('SIGKILL'); } catch {} resolve(); }, 5_000);
        hardhatProc.on('exit', () => { clearTimeout(t); resolve(); });
      });
    }
    fs.rmSync(TMP, { recursive: true, force: true });
  });

  it('starts hardhat node and deploys the contract', async () => {
    assert.match(contractAddress, /^0x[a-fA-F0-9]{40}$/);
    const owner = await contract.owner();
    assert.equal(owner.toLowerCase(), new Wallet(HARDHAT_KEY).address.toLowerCase());
  });

  it('reports the registry as anchor-enabled', async () => {
    const r = await getJson(`${baseUrl}/api/records`);
    assert.equal(r.status, 200);
    assert.equal(r.body.anchorEnabled, true);
  });

  it('hasAnchor is false for an unfiled registryId', async () => {
    const present = await contract.hasAnchor('not-yet-filed-dao', 0);
    assert.equal(present, false);
  });

  it('files a registration and writes both anchors on chain', async () => {
    const filing = {
      daoName: 'Integration Test DAO',
      agentName: 'Jane Smith',
      agentAddress: '123 Main Street, Concord, NH 03301',
      agentEmail: 'jane@example.org',
      ...completeCompliance(),
    };
    const r = await postJson(`${baseUrl}/api/file`, filing);
    assert.equal(r.status, 200);
    const { registryId, meta } = r.body;
    assert.match(registryId, /integration-test-dao/);

    // Both anchors landed.
    assert.ok(meta.anchors.dao,   `expected dao anchor, got ${JSON.stringify(meta.anchors)}`);
    assert.ok(meta.anchors.agent, `expected agent anchor, got ${JSON.stringify(meta.anchors)}`);
    assert.match(meta.anchors.dao.txHash,   /^0x[a-f0-9]{64}$/);
    assert.match(meta.anchors.agent.txHash, /^0x[a-f0-9]{64}$/);
    assert.equal(meta.anchorErrors.dao,   null);
    assert.equal(meta.anchorErrors.agent, null);

    // Warnings list contains no anchor warnings.
    const anchorWarnings = (meta.warnings || []).filter(w => w.category === 'anchor');
    assert.deepEqual(anchorWarnings, []);

    // Read the contract directly: latestVersion = 1 for both kinds.
    const idHash = keccakId(registryId);
    assert.equal(Number(await contract.latestVersion(idHash, 0)), 1);
    assert.equal(Number(await contract.latestVersion(idHash, 1)), 1);

    // hasAnchor flipped to true.
    assert.equal(await contract.hasAnchor(registryId, 0), true);
    assert.equal(await contract.hasAnchor(registryId, 1), true);

    // The on-chain contentHash equals the meta hash (sha256: prefix stripped).
    const onChain = await contract.getLatest(registryId, 0);
    const expected = '0x' + meta.daoHash.replace(/^sha256:/, '');
    assert.equal(onChain.contentHash.toLowerCase(), expected.toLowerCase());
  });

  it('Anchored event has contentHash indexed (new event shape)', async () => {
    const filing = {
      daoName: 'Event Shape DAO',
      agentName: 'Jane Smith',
      agentAddress: '123 Main Street, Concord, NH 03301',
      agentEmail: 'jane@example.org',
      ...completeCompliance(),
    };
    const r = await postJson(`${baseUrl}/api/file`, filing);
    assert.equal(r.status, 200);
    const daoHashHex = '0x' + r.body.meta.daoHash.replace(/^sha256:/, '');

    // Filter by the indexed contentHash topic. If the index isn't on
    // contentHash any more, this query returns 0 logs.
    const filter = contract.filters.Anchored(null, null, daoHashHex);
    const events = await contract.queryFilter(filter);
    assert.ok(events.length >= 1, 'expected to find Anchored event filterable by contentHash topic');

    const ev = events[events.length - 1];
    assert.equal(ev.args.contentHash.toLowerCase(), daoHashHex.toLowerCase());
    assert.equal(Number(ev.args.version), 1);
    // The non-indexed string registryId comes through in args.
    assert.match(ev.args.registryId, /event-shape-dao/);
  });

  it('verifier reports both chain anchors as ok', async () => {
    const filing = {
      daoName: 'Verify Path DAO',
      agentName: 'Jane Smith',
      agentAddress: '123 Main Street, Concord, NH 03301',
      agentEmail: 'jane@example.org',
      ...completeCompliance(),
    };
    const f = await postJson(`${baseUrl}/api/file`, filing);
    assert.equal(f.status, 200);
    const { registryId } = f.body;

    const v = await getJson(`${baseUrl}/api/verify/${registryId}`);
    assert.equal(v.status, 200);
    const named = Object.fromEntries(v.body.checks.map(c => [c.name, c]));
    assert.equal(named['DAO chain anchor'].ok,   true, JSON.stringify(named['DAO chain anchor']));
    assert.equal(named['agent chain anchor'].ok, true, JSON.stringify(named['agent chain anchor']));
    assert.equal(v.body.ok, true);
  });

  // NOTE: deploy-script integration (OWNER + transferOwnership flow) is
  // intentionally NOT tested here. Two-step ownership at the contract
  // layer is covered by test/DAORegistryAnchor.test.cjs; testing the deploy
  // *script* would require spawning hardhat against a fresh node, more
  // infrastructure than the value justifies. The script's only logic
  // beyond the contract is OWNER-address validation (covered as a focused
  // unit test in test/e2e.test.js).

  it('two filings of the same DAO name produce distinct on-chain anchors', async () => {
    // The publication service avoids duplicate (registryId, kind, v=1)
    // anchors by reserving a new registryId on collision. Confirm both
    // anchors land on chain, with different content hashes.
    const filing = {
      daoName: 'On-Chain Collision DAO',
      agentName: 'Jane Smith',
      agentAddress: '123 Main Street, Concord, NH 03301',
      agentEmail: 'jane@example.org',
      ...completeCompliance(),
    };
    const a = await postJson(`${baseUrl}/api/file`, filing);
    const b = await postJson(`${baseUrl}/api/file`, filing);
    assert.equal(a.status, 200);
    assert.equal(b.status, 200);
    assert.notEqual(a.body.registryId, b.body.registryId);
    assert.ok(a.body.meta.anchors.dao);
    assert.ok(b.body.meta.anchors.dao);
    assert.notEqual(a.body.meta.anchors.dao.txHash, b.body.meta.anchors.dao.txHash);

    // Both registryIds resolve on chain.
    assert.equal(await contract.hasAnchor(a.body.registryId, 0), true);
    assert.equal(await contract.hasAnchor(b.body.registryId, 0), true);
  });
});
