/* Filing UI: validates client-side, posts to /api/file, renders the result. */

const $ = (id) => document.getElementById(id);

/* ---------- validation (mirrors src/validation.js) ---------- */

const NAME_RX = /(?:^|\s)(DAO|LAO)$/i;
const PO_BOX_RX = /\b(P\.?\s*O\.?\s*Box|post\s+office\s+box)\b/i;
const NH_RX = /\b(NH|N\.H\.|New\s+Hampshire)\b/i;
const CAIP2_RX = /^eip155:\d+$/i;
const EVM_ADDR_RX = /^0x[a-fA-F0-9]{40}$/;
const DOMAIN_LABEL_RX = /^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/i;
const TLD_RX = /^[a-z]{2,63}$/i;
const REQUIRED_URL_FIELDS = [
  'govUrl',
  'sourceUrl',
  'guiUrl',
  'qaUrl',
  'communicationsUrl',
  'internalDisputeResolutionUrl',
  'thirdPartyDisputeResolutionUrl',
  'legalRepresentativeAuthorizationUrl',
];
const ATTESTATION_FIELDS = [
  'permissionlessBlockchain',
  'openSourceCode',
  'qaCompleted',
  'guiMonitoring',
  'bylawsPublic',
  'publicCommunications',
  'internalDisputeResolution',
  'thirdPartyDisputeResolution',
  'decentralizedNetwork',
  'decentralizedGovernance',
  'participantRules',
  'legalRepresentativeAuthorized',
];

function setNote(id, ok, msg) {
  const el = $(id);
  el.textContent = msg;
  el.className = 'mt-1 text-xs ' + (msg ? (ok ? 'note-ok' : 'note-warn') : 'text-slate-500');
}

function checkAll() {
  const daoName = $('daoName').value.trim();
  if (!daoName) setNote('daoName-note', false, 'Required.');
  else if (!NAME_RX.test(daoName)) setNote('daoName-note', false, 'Must end in DAO or LAO.');
  else setNote('daoName-note', true, 'Naming rule satisfied.');

  const addr = $('agentAddress').value.trim();
  if (!addr) setNote('agentAddress-note', false, 'Required.');
  else if (PO_BOX_RX.test(addr)) setNote('agentAddress-note', false, 'PO boxes are not accepted.');
  else if (!NH_RX.test(addr)) setNote('agentAddress-note', false, 'Must include NH.');
  else if (!/\d/.test(addr)) setNote('agentAddress-note', false, 'Should include a street number.');
  else setNote('agentAddress-note', true, 'Physical NH street address.');

  const okName  = NAME_RX.test(daoName);
  const okAddr  = !PO_BOX_RX.test(addr) && NH_RX.test(addr) && /\d/.test(addr);
  const okBasic = !!$('agentName').value.trim() && !!$('agentEmail').value.trim();
  const contracts = collectContracts();
  const okContracts = contracts.length > 0 && contracts.every(c => CAIP2_RX.test(c.chainId) && EVM_ADDR_RX.test(c.address));
  const okUrls = REQUIRED_URL_FIELDS.every(id => isHttpUrl($(id).value));
  const okCompliance = isPublicDomain($('registeredDomain').value.trim())
    && EVM_ADDR_RX.test($('publicAddress').value.trim())
    && ATTESTATION_FIELDS.every(field => $(`att-${field}`).checked);

  const ok = okName && okAddr && okBasic && okContracts && okUrls && okCompliance;
  $('fileBtn').disabled = !ok;
  $('status').textContent = ok ? 'Ready to file.' : 'Fill required fields, evidence URLs, attestations, and contract rows.';
}

function isHttpUrl(raw) {
  try {
    const u = new URL(String(raw || '').trim());
    return (u.protocol === 'http:' || u.protocol === 'https:') && isPublicHostname(u.hostname);
  } catch {
    return false;
  }
}

function isPublicDomain(raw) {
  const host = String(raw || '').trim().toLowerCase();
  if (host.includes('://') || host.includes('/')) return false;
  const labels = host.split('.');
  return labels.length >= 2
    && labels.every(label => DOMAIN_LABEL_RX.test(label))
    && TLD_RX.test(labels[labels.length - 1]);
}

function isPublicHostname(hostname) {
  const h = hostname.replace(/^\[|\]$/g, '').toLowerCase();
  if (!h || h === 'localhost' || h.endsWith('.localhost') || h.endsWith('.local') || h === '::1') return false;
  const v4 = h.match(/^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/);
  if (!v4) return true;
  const octets = v4.slice(1).map(Number);
  if (octets.some(n => n < 0 || n > 255)) return false;
  const [a, b] = octets;
  return !(a === 10 || a === 127 || (a === 172 && b >= 16 && b <= 31) || (a === 192 && b === 168) || (a === 169 && b === 254));
}

/* ---------- contract rows ---------- */

function addContractRow(prefill) {
  const row = document.createElement('div');
  row.className = 'grid grid-cols-[1fr_2fr_auto] gap-2 items-center';
  const chainInput = document.createElement('input');
  chainInput.className = 'c-chain rounded-md border border-slate-300 px-2 py-1.5 text-sm';
  chainInput.placeholder = 'eip155:1';
  const addressInput = document.createElement('input');
  addressInput.className = 'c-addr rounded-md border border-slate-300 px-2 py-1.5 text-sm font-mono';
  addressInput.placeholder = '0x...';
  const removeButton = document.createElement('button');
  removeButton.type = 'button';
  removeButton.className = 'c-rm text-xs text-slate-500 hover:text-rose-600';
  removeButton.textContent = 'remove';
  row.append(chainInput, addressInput, removeButton);
  if (prefill) {
    row.querySelector('.c-chain').value = prefill.chainId;
    row.querySelector('.c-addr').value  = prefill.address;
  }
  row.querySelector('.c-rm').addEventListener('click', () => { row.remove(); checkAll(); });
  row.querySelectorAll('input').forEach(i => i.addEventListener('input', checkAll));
  $('contractRows').appendChild(row);
  checkAll();
}

function collectContracts() {
  return Array.from(document.querySelectorAll('#contractRows > div')).map(r => ({
    chainId: r.querySelector('.c-chain').value.trim(),
    address: r.querySelector('.c-addr').value.trim(),
  })).filter(c => c.chainId || c.address);
}

/* ---------- API key (Bearer token) ---------- */

const API_KEY_STORAGE = 'nh-dao-registry.apiKey';

function loadApiKey() {
  try { return sessionStorage.getItem(API_KEY_STORAGE) || ''; }
  catch { return ''; }
}
function saveApiKey(value) {
  try {
    if (value) sessionStorage.setItem(API_KEY_STORAGE, value);
    else sessionStorage.removeItem(API_KEY_STORAGE);
  } catch { /* sessionStorage may be disabled in some contexts; non-fatal */ }
}

function authHeaders() {
  const key = $('apiKey').value.trim();
  return key ? { 'Authorization': `Bearer ${key}` } : {};
}

function collectCompliance() {
  return {
    registeredDomain: $('registeredDomain').value.trim(),
    publicAddress: $('publicAddress').value.trim(),
    qaUrl: $('qaUrl').value.trim(),
    communicationsUrl: $('communicationsUrl').value.trim(),
    internalDisputeResolutionUrl: $('internalDisputeResolutionUrl').value.trim(),
    thirdPartyDisputeResolutionUrl: $('thirdPartyDisputeResolutionUrl').value.trim(),
    legalRepresentativeAuthorizationUrl: $('legalRepresentativeAuthorizationUrl').value.trim(),
    lifecycleStatus: 'initial',
    attestations: Object.fromEntries(
      ATTESTATION_FIELDS.map(field => [field, $(`att-${field}`).checked]),
    ),
  };
}

/* ---------- submit ---------- */

async function submit(e) {
  e.preventDefault();
  $('fileBtn').disabled = true;
  $('status').textContent = 'Filing... (signing, pinning to IPFS, anchoring on Polygon Amoy)';

  const payload = {
    daoName:      $('daoName').value.trim(),
    agentName:    $('agentName').value.trim(),
    agentAddress: $('agentAddress').value.trim(),
    agentEmail:   $('agentEmail').value.trim(),
    govUrl:       $('govUrl').value.trim() || undefined,
    sourceUrl:    $('sourceUrl').value.trim() || undefined,
    guiUrl:       $('guiUrl').value.trim() || undefined,
    contracts:    collectContracts(),
    compliance:   collectCompliance(),
  };

  let res;
  try {
    res = await fetch('/api/file', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', ...authHeaders() },
      body: JSON.stringify(payload),
    });
  } catch (err) {
    $('status').textContent = `Network error: ${err.message}`;
    $('fileBtn').disabled = false;
    return;
  }
  if (res.status === 401) {
    $('apiKeySection').open = true;
    const hasKey = !!$('apiKey').value.trim();
    $('status').textContent = hasKey
      ? 'Server rejected the API key (401). Check the Bearer token and try again.'
      : 'This server requires an API key. Set the Bearer token above and try again.';
    $('apiKey').focus();
    $('fileBtn').disabled = false;
    return;
  }
  const body = await res.json();
  if (!res.ok) {
    const detail = body.details ? ' (' + body.details.map(d => `${d.field}: ${d.error}`).join('; ') + ')' : '';
    $('status').textContent = `Error: ${body.error || res.status}${detail}`;
    $('fileBtn').disabled = false;
    return;
  }

  renderResult(body);
}

function describeWarning(w) {
  if (w.category === 'ipfs') {
    if (w.state === 'failed') return `Public Arweave persistence failed: ${w.detail}. The local CID record is still active.`;
    return w.detail || 'governance persistence warning';
  }
  if (w.category === 'anchor') {
    if (w.kind === 'config') return 'Polygon Amoy chain anchor is not configured. Documents are signed and pinned, but no on-chain anchor exists.';
    return `Chain anchor for ${w.kind} document failed: ${w.detail}`;
  }
  return JSON.stringify(w);
}

function renderWarnings(warnings) {
  const panel = $('r-warnings');
  const list = $('r-warnings-list');
  list.innerHTML = '';
  if (!Array.isArray(warnings) || warnings.length === 0) {
    panel.classList.add('hidden');
    return;
  }
  for (const w of warnings) {
    const li = document.createElement('li');
    li.textContent = `• ${describeWarning(w)}`;
    list.appendChild(li);
  }
  panel.classList.remove('hidden');
}

/** Build the anchor-TX cell as DOM nodes (no innerHTML; error text is untrusted). */
function renderAnchorCell(meta) {
  const cell = $('r-anchorTx');
  cell.replaceChildren();
  if (meta.anchors.dao) {
    const code = document.createElement('code');
    code.className = 'text-[11px] break-all';
    code.textContent = meta.anchors.dao.txHash;
    cell.append(code, ` on ${meta.anchors.dao.chainIdCaip2}`);
    return;
  }
  const span = document.createElement('span');
  if (meta.anchorErrors && meta.anchorErrors.dao) {
    span.className = 'text-rose-700';
    span.textContent = `anchor failed: ${meta.anchorErrors.dao.message}`;
  } else {
    span.className = 'text-amber-700';
    span.textContent = 'not anchored (chain config missing)';
  }
  cell.append(span);
}

function renderResult({ registryId, dao, agent, meta, warnings }) {
  $('result').classList.remove('hidden');
  renderWarnings(warnings || meta.warnings);

  $('r-daoName').textContent = meta.daoName;
  $('r-daoDid').textContent  = meta.daoDid;
  $('r-filed').textContent   = meta.filed;
  $('r-daoHash').textContent = meta.daoHash;
  const pinState = meta.governance.publicPinStatus && meta.governance.publicPinStatus.state;
  const pinLabel = meta.governance.publicPin
    ? 'public IPFS'
    : pinState === 'failed'
      ? 'local pin only — public pin failed'
      : pinState === 'cid-mismatch'
        ? 'local pin only — public CID mismatch'
        : 'local pin';
  $('r-cid').textContent     = `${meta.governance.cid} (${pinLabel})`;
  $('r-compliance').textContent = meta.compliance
    ? `${meta.compliance.status}; legal status ${meta.compliance.legalStatus} (${meta.compliance.registeredDomain})`
    : 'not recorded';
  renderAnchorCell(meta);

  $('r-agentName').textContent    = meta.agentName;
  $('r-agentDid').textContent     = meta.agentDid;
  $('r-agentHash').textContent    = meta.agentHash;
  $('r-agentAddress').textContent = (agent.registeredAgent && agent.registeredAgent.physicalAddress)
    ? Object.values(agent.registeredAgent.physicalAddress).filter(Boolean).join(', ')
    : '';
  $('r-agentEmail').textContent   = agent.registeredAgent && agent.registeredAgent.email;

  $('lnkDao').href    = `/dao/${registryId}/did.json`;
  $('lnkAgent').href  = `/agent/${registryId}/did.json`;
  $('lnkVerify').href = `/api/verify/${registryId}`;

  $('jsonDao').value   = JSON.stringify(dao, null, 2);
  $('jsonAgent').value = JSON.stringify(agent, null, 2);

  $('result').scrollIntoView({ behavior: 'smooth' });
}

/* ---------- wiring ---------- */

document.addEventListener('DOMContentLoaded', () => {
  [
    'daoName',
    'agentName',
    'agentAddress',
    'agentEmail',
    ...REQUIRED_URL_FIELDS,
    'registeredDomain',
    'publicAddress',
  ].forEach(id => $(id).addEventListener('input', checkAll));
  ATTESTATION_FIELDS.forEach(field => $(`att-${field}`).addEventListener('change', checkAll));
  $('addContract').addEventListener('click', () => addContractRow());
  $('form').addEventListener('submit', submit);

  // Restore the API key from sessionStorage; persist on edit. If a key is
  // already set, expand the section so the operator can see it's in effect.
  const stored = loadApiKey();
  if (stored) {
    $('apiKey').value = stored;
    $('apiKeySection').open = true;
  }
  $('apiKey').addEventListener('input', () => saveApiKey($('apiKey').value.trim()));

  // Seed with one example contract row.
  addContractRow({ chainId: 'eip155:1', address: '0x0000000000000000000000000000000000000000' });
});
