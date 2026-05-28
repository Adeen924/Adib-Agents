// ── Network Intelligence ─────────────────────────────────────────────────────
// Depends on: BACKEND_URL, apiFetch, userId, showToast (all defined in app.js)

// ── State ────────────────────────────────────────────────────────────────────
let networkState = {
  connections:   [],
  companies:     [],
  warmJobs:      [],
  outreach:      [],
  dashboard:     null,
  oauthStatus:   null,
  importStatus:  null,
  currentView:   'overview',
  isLoading:     false,
  connectionPage: 1,
  connectionSearch: '',
  connectionTierFilter: '',
  connectionSourceFilter: '',
  pollTimer:     null,
};

// ── Main entry point ──────────────────────────────────────────────────────────
async function loadNetworkDashboard() {
  if (networkState.isLoading) return;
  networkState.isLoading = true;

  const body = document.getElementById('networkContent');
  if (!body) return;
  body.innerHTML = '<div class="panel-loading">Loading network data…</div>';

  try {
    await Promise.all([
      loadNetworkStats(),
      loadWarmJobs(),
    ]);
    renderCurrentNetworkView();
  } catch (err) {
    console.error('[Network] loadNetworkDashboard error:', err);
    body.innerHTML = `<div class="empty-table" style="color:var(--danger)">Failed to load network data. ${err.message}</div>`;
  } finally {
    networkState.isLoading = false;
  }
}

// ── Data loaders ──────────────────────────────────────────────────────────────
async function loadNetworkStats() {
  try {
    const res  = await apiFetch(`${BACKEND_URL}/network/dashboard`);
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const data = await res.json();
    networkState.dashboard   = data.dashboard   || data;
    networkState.oauthStatus = data.oauthStatus || null;
  } catch (err) {
    console.warn('[Network] loadNetworkStats failed:', err.message);
    networkState.dashboard = null;
  }
}

async function loadConnections(page = 1, search = '') {
  const params = new URLSearchParams({ page, limit: 24 });
  if (search)                                 params.set('search', search);
  if (networkState.connectionTierFilter)      params.set('tier', networkState.connectionTierFilter);
  if (networkState.connectionSourceFilter)    params.set('source', networkState.connectionSourceFilter);

  const res  = await apiFetch(`${BACKEND_URL}/network/connections?${params}`);
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  const data = await res.json();
  networkState.connections    = data.connections || [];
  networkState.connectionPage = page;
  return data;
}

async function loadCompanies() {
  const res  = await apiFetch(`${BACKEND_URL}/network/companies`);
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  const data = await res.json();
  networkState.companies = data.companies || [];
  return data;
}

async function loadWarmJobs() {
  try {
    const res  = await apiFetch(`${BACKEND_URL}/network/jobs/warm`);
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const data = await res.json();
    networkState.warmJobs = data.jobs || [];
  } catch (err) {
    console.warn('[Network] loadWarmJobs failed:', err.message);
    networkState.warmJobs = [];
  }
}

async function loadOutreachHistory() {
  const res  = await apiFetch(`${BACKEND_URL}/network/outreach`);
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  const data = await res.json();
  networkState.outreach = data.outreach || [];
  return data;
}

// ── Sub-view router ───────────────────────────────────────────────────────────
function renderCurrentNetworkView() {
  switch (networkState.currentView) {
    case 'overview':     renderNetworkOverview();     break;
    case 'connections':  renderNetworkConnections();   break;
    case 'companies':    renderNetworkCompanies();     break;
    case 'outreach':     renderNetworkOutreach();      break;
    case 'settings':     renderNetworkSettings();      break;
    default:             renderNetworkOverview();
  }
}

function switchNetworkView(view) {
  networkState.currentView = view;

  // Update active toggle button
  document.querySelectorAll('#networkViewToggle .view-toggle-btn').forEach(btn => {
    btn.classList.remove('active');
  });
  const btns = document.querySelectorAll('#networkViewToggle .view-toggle-btn');
  const viewOrder = ['overview', 'connections', 'companies', 'outreach', 'settings'];
  const idx = viewOrder.indexOf(view);
  if (idx >= 0 && btns[idx]) btns[idx].classList.add('active');

  const body = document.getElementById('networkContent');
  if (body) body.innerHTML = '<div class="panel-loading">Loading…</div>';

  // Load data then render
  switch (view) {
    case 'overview':
      loadNetworkDashboard();
      break;
    case 'connections':
      loadConnections(1, networkState.connectionSearch)
        .then(renderNetworkConnections)
        .catch(err => showNetworkError(err));
      break;
    case 'companies':
      loadCompanies()
        .then(renderNetworkCompanies)
        .catch(err => showNetworkError(err));
      break;
    case 'outreach':
      loadOutreachHistory()
        .then(renderNetworkOutreach)
        .catch(err => showNetworkError(err));
      break;
    case 'settings':
      loadNetworkStats()
        .then(renderNetworkSettings)
        .catch(err => showNetworkError(err));
      break;
  }
}

function showNetworkError(err) {
  const body = document.getElementById('networkContent');
  if (body) body.innerHTML = `<div class="empty-table" style="color:var(--danger)">Error: ${err.message}</div>`;
}

// ── Overview tab ──────────────────────────────────────────────────────────────
function renderNetworkOverview() {
  const body = document.getElementById('networkContent');
  if (!body) return;

  const d = networkState.dashboard || {};
  const stats = d.stats || {};

  const totalConnections = stats.totalConnections ?? '—';
  const totalCompanies   = stats.totalCompanies   ?? '—';
  const recruiters       = stats.recruiters       ?? '—';
  const warmOpps         = networkState.warmJobs.length || (stats.warmOpportunities ?? '—');

  const lastImport  = d.lastImport  ? new Date(d.lastImport._seconds  ? d.lastImport._seconds * 1000  : d.lastImport).toLocaleString()  : 'Never';
  const lastOutreach = d.lastOutreach ? new Date(d.lastOutreach._seconds ? d.lastOutreach._seconds * 1000 : d.lastOutreach).toLocaleString() : 'Never';

  const warmJobsHtml = networkState.warmJobs.length
    ? networkState.warmJobs.slice(0, 6).map(renderWarmJobCard).join('')
    : '<div class="empty-table">No warm job opportunities found yet. Import your contacts to get started.</div>';

  const gaps = d.networkGaps || [];
  const gapsHtml = gaps.length ? renderNetworkGaps(gaps) : '<div class="empty-table" style="color:var(--text-muted);font-size:0.85rem">Gap analysis will appear after contacts are imported.</div>';

  body.innerHTML = `
    <!-- Stats row -->
    <div class="network-stats-row">
      ${renderStatCard('Total Connections', totalConnections, '🤝')}
      ${renderStatCard('Companies in Network', totalCompanies, '🏢')}
      ${renderStatCard('Recruiters', recruiters, '🎯')}
      ${renderStatCard('Warm Opportunities', warmOpps, '🔥')}
    </div>

    <!-- Warm jobs -->
    <div class="network-section">
      <div class="network-section-header">
        <h3>Warm Job Opportunities</h3>
        <span class="text-muted" style="font-size:0.82rem">Jobs at companies where you have connections</span>
      </div>
      <div class="network-warm-grid">${warmJobsHtml}</div>
    </div>

    <!-- Gap analysis -->
    <div class="network-section">
      <div class="network-section-header">
        <h3>Network Gap Analysis</h3>
        <span class="text-muted" style="font-size:0.82rem">Industries and companies with weak coverage</span>
      </div>
      ${gapsHtml}
    </div>

    <!-- Recent activity -->
    <div class="network-section">
      <div class="network-section-header">
        <h3>Recent Activity</h3>
      </div>
      <div class="card" style="display:flex;gap:32px;flex-wrap:wrap;padding:18px 22px">
        <div>
          <div style="font-size:0.75rem;color:var(--text-muted);text-transform:uppercase;letter-spacing:0.05em;margin-bottom:4px">Last Import</div>
          <div style="font-size:0.95rem">${lastImport}</div>
        </div>
        <div>
          <div style="font-size:0.75rem;color:var(--text-muted);text-transform:uppercase;letter-spacing:0.05em;margin-bottom:4px">Last Outreach Sent</div>
          <div style="font-size:0.95rem">${lastOutreach}</div>
        </div>
        <div>
          <div style="font-size:0.75rem;color:var(--text-muted);text-transform:uppercase;letter-spacing:0.05em;margin-bottom:4px">Import Status</div>
          <div style="font-size:0.95rem">${d.importStatus || 'Idle'}</div>
        </div>
      </div>
    </div>
  `;
}

function renderStatCard(label, value, icon) {
  return `
    <div class="card network-stat-card">
      <div class="network-stat-icon">${icon}</div>
      <div class="network-stat-value">${value}</div>
      <div class="network-stat-label">${label}</div>
    </div>
  `;
}

// ── Connections tab ───────────────────────────────────────────────────────────
function renderNetworkConnections() {
  const body = document.getElementById('networkContent');
  if (!body) return;

  const connections = networkState.connections;

  const cardsHtml = connections.length
    ? connections.map(renderConnectionCard).join('')
    : '<div class="empty-table" style="grid-column:1/-1">No connections found. Try adjusting your filters or import your contacts.</div>';

  body.innerHTML = `
    <!-- Search + filters toolbar -->
    <div class="network-toolbar">
      <input
        type="text"
        class="network-search-input"
        id="connectionSearchInput"
        placeholder="Search by name, company, or title…"
        value="${escapeHtml(networkState.connectionSearch)}"
        oninput="debouncedConnectionSearch(this.value)"
      />
      <select class="network-filter-select" id="connectionTierFilter" onchange="applyConnectionFilters()">
        <option value="">All Tiers</option>
        <option value="close" ${networkState.connectionTierFilter === 'close' ? 'selected' : ''}>Close</option>
        <option value="strong" ${networkState.connectionTierFilter === 'strong' ? 'selected' : ''}>Strong</option>
        <option value="moderate" ${networkState.connectionTierFilter === 'moderate' ? 'selected' : ''}>Moderate</option>
        <option value="weak" ${networkState.connectionTierFilter === 'weak' ? 'selected' : ''}>Weak</option>
      </select>
      <select class="network-filter-select" id="connectionSourceFilter" onchange="applyConnectionFilters()">
        <option value="">All Sources</option>
        <option value="google_contacts" ${networkState.connectionSourceFilter === 'google_contacts' ? 'selected' : ''}>Google Contacts</option>
        <option value="linkedin" ${networkState.connectionSourceFilter === 'linkedin' ? 'selected' : ''}>LinkedIn</option>
        <option value="manual" ${networkState.connectionSourceFilter === 'manual' ? 'selected' : ''}>Manual</option>
      </select>
    </div>

    <!-- Connection grid -->
    <div class="network-connections-grid">
      ${cardsHtml}
    </div>

    <!-- Pagination -->
    ${connections.length >= 24 ? `
      <div style="display:flex;justify-content:center;margin-top:20px;gap:10px">
        <button class="btn btn-ghost" onclick="networkPrevPage()" ${networkState.connectionPage <= 1 ? 'disabled' : ''}>← Previous</button>
        <span style="display:flex;align-items:center;color:var(--text-muted);font-size:0.85rem">Page ${networkState.connectionPage}</span>
        <button class="btn btn-ghost" onclick="networkNextPage()">Next →</button>
      </div>
    ` : ''}
  `;
}

let _connectionSearchTimer = null;
function debouncedConnectionSearch(value) {
  clearTimeout(_connectionSearchTimer);
  _connectionSearchTimer = setTimeout(() => {
    networkState.connectionSearch = value;
    loadConnections(1, value).then(renderNetworkConnections).catch(showNetworkError);
  }, 350);
}

function applyConnectionFilters() {
  networkState.connectionTierFilter   = document.getElementById('connectionTierFilter')?.value   || '';
  networkState.connectionSourceFilter = document.getElementById('connectionSourceFilter')?.value || '';
  loadConnections(1, networkState.connectionSearch).then(renderNetworkConnections).catch(showNetworkError);
}

function networkPrevPage() {
  const prev = Math.max(1, networkState.connectionPage - 1);
  loadConnections(prev, networkState.connectionSearch).then(renderNetworkConnections).catch(showNetworkError);
}

function networkNextPage() {
  loadConnections(networkState.connectionPage + 1, networkState.connectionSearch).then(renderNetworkConnections).catch(showNetworkError);
}

// ── Companies tab ─────────────────────────────────────────────────────────────
function renderNetworkCompanies() {
  const body = document.getElementById('networkContent');
  if (!body) return;

  const companies = networkState.companies;

  const listHtml = companies.length
    ? companies.map(renderCompanyCard).join('')
    : '<div class="empty-table">No companies found. Import contacts to populate this view.</div>';

  body.innerHTML = `
    <div class="network-section">
      <div class="network-section-header">
        <h3>Companies in Your Network</h3>
        <span class="text-muted" style="font-size:0.82rem">${companies.length} companies</span>
      </div>
      <div class="network-companies-list">${listHtml}</div>
    </div>
  `;
}

// ── Outreach tab ──────────────────────────────────────────────────────────────
function renderNetworkOutreach() {
  const body = document.getElementById('networkContent');
  if (!body) return;

  const outreach = networkState.outreach;

  const rowsHtml = outreach.length
    ? outreach.map(o => `
      <tr class="outreach-row" onclick="showOutreachDetail('${escapeHtml(o.id || '')}')" style="cursor:pointer">
        <td>${escapeHtml(o.contactName || '—')}</td>
        <td>${escapeHtml(o.company || '—')}</td>
        <td>${escapeHtml(o.jobTitle || '—')}</td>
        <td><span class="badge badge-outline">${escapeHtml(o.messageType || '—')}</span></td>
        <td><span class="status-chip status-${(o.status || 'pending').toLowerCase()}">${escapeHtml(o.status || 'Pending')}</span></td>
        <td>${o.createdAt ? new Date(o.createdAt._seconds ? o.createdAt._seconds * 1000 : o.createdAt).toLocaleDateString() : '—'}</td>
      </tr>
    `).join('')
    : `<tr><td colspan="6" class="empty-table">No outreach history yet. Browse connections and generate messages to get started.</td></tr>`;

  body.innerHTML = `
    <div class="network-section">
      <div class="network-section-header">
        <h3>Outreach History</h3>
        <span class="text-muted" style="font-size:0.82rem">${outreach.length} messages</span>
      </div>
      <div class="table-wrap">
        <table class="app-table">
          <thead>
            <tr>
              <th>Contact</th>
              <th>Company</th>
              <th>Job</th>
              <th>Type</th>
              <th>Status</th>
              <th>Date</th>
            </tr>
          </thead>
          <tbody>${rowsHtml}</tbody>
        </table>
      </div>
    </div>
  `;
}

function showOutreachDetail(outreachId) {
  const o = networkState.outreach.find(x => x.id === outreachId);
  if (!o) return;

  const modal = document.createElement('div');
  modal.className = 'network-modal-overlay';
  modal.innerHTML = `
    <div class="network-modal">
      <div class="network-modal-header">
        <h3>Outreach Message</h3>
        <button class="network-modal-close" onclick="this.closest('.network-modal-overlay').remove()">×</button>
      </div>
      <div class="network-modal-meta">
        <span><strong>To:</strong> ${escapeHtml(o.contactName || '—')}</span>
        <span><strong>Company:</strong> ${escapeHtml(o.company || '—')}</span>
        <span><strong>Type:</strong> ${escapeHtml(o.messageType || '—')}</span>
        <span><strong>Status:</strong> ${escapeHtml(o.status || '—')}</span>
      </div>
      <div class="network-modal-body">
        <pre class="network-message-pre">${escapeHtml(o.message || '')}</pre>
      </div>
      <div class="network-modal-footer">
        <select class="network-filter-select" id="outreachStatusSelect" style="width:auto">
          <option value="pending"  ${o.status === 'pending'  ? 'selected' : ''}>Pending</option>
          <option value="sent"     ${o.status === 'sent'     ? 'selected' : ''}>Sent</option>
          <option value="replied"  ${o.status === 'replied'  ? 'selected' : ''}>Replied</option>
          <option value="declined" ${o.status === 'declined' ? 'selected' : ''}>Declined</option>
        </select>
        <button class="btn btn-gold" onclick="updateOutreachStatusFromModal('${escapeHtml(outreachId)}')">Update Status</button>
        <button class="btn btn-ghost" onclick="this.closest('.network-modal-overlay').remove()">Close</button>
      </div>
    </div>
  `;
  document.body.appendChild(modal);
  modal.addEventListener('click', e => { if (e.target === modal) modal.remove(); });
}

async function updateOutreachStatusFromModal(outreachId) {
  const select = document.getElementById('outreachStatusSelect');
  if (!select) return;
  const status = select.value;
  try {
    await updateOutreachStatus(outreachId, status);
    showToast('Network', 'Outreach status updated.');
    document.querySelector('.network-modal-overlay')?.remove();
    loadOutreachHistory().then(renderNetworkOutreach).catch(console.error);
  } catch (err) {
    showToast('Network', `Error: ${err.message}`);
  }
}

// ── Settings tab ──────────────────────────────────────────────────────────────
function renderNetworkSettings() {
  const body = document.getElementById('networkContent');
  if (!body) return;

  const oauth   = networkState.oauthStatus || {};
  const isConn  = oauth.connected === true;
  const lastSync = oauth.lastSync ? new Date(oauth.lastSync._seconds ? oauth.lastSync._seconds * 1000 : oauth.lastSync).toLocaleString() : 'Never';
  const contactCount = oauth.contactCount ?? '—';

  body.innerHTML = `
    <!-- Google Integration -->
    <div class="network-section">
      <div class="network-section-header"><h3>Integrations</h3></div>

      <div class="card network-settings-card">
        <div class="network-settings-card-header">
          <div class="network-settings-card-icon">📧</div>
          <div>
            <div class="network-settings-card-title">Google Contacts</div>
            <div class="network-settings-card-desc">Import your contacts to find warm introductions</div>
          </div>
          <div class="network-settings-card-status">
            ${isConn
              ? `<span class="status-dot"></span> <span style="color:#4caf7d;font-size:0.85rem">Connected</span>`
              : `<span style="color:var(--text-muted);font-size:0.85rem">Not connected</span>`
            }
          </div>
        </div>
        ${isConn ? `
          <div class="network-settings-meta">
            <span>Last synced: ${lastSync}</span>
            <span>${contactCount} contacts imported</span>
          </div>
          <div class="network-settings-actions">
            <button class="btn btn-gold" onclick="triggerGoogleImport()" id="importContactsBtn">
              ↺ Sync Now
            </button>
            <button class="btn btn-ghost" style="border-color:var(--danger);color:var(--danger)" onclick="disconnectGoogle()">
              Disconnect
            </button>
          </div>
        ` : `
          <div class="network-settings-actions">
            <button class="btn btn-gold" onclick="connectGoogle()">
              Connect Google Contacts
            </button>
          </div>
        `}
      </div>

      <!-- Chrome Extension -->
      <div class="card network-settings-card" style="margin-top:16px">
        <div class="network-settings-card-header">
          <div class="network-settings-card-icon">🔌</div>
          <div>
            <div class="network-settings-card-title">Chrome Extension</div>
            <div class="network-settings-card-desc">Link the CareerCopilot extension to import from LinkedIn</div>
          </div>
        </div>
        <div class="network-settings-actions">
          <button class="btn btn-ghost" onclick="generateAndShowExtensionToken()">Generate Token</button>
        </div>
        <div id="extensionTokenDisplay" style="margin-top:12px;display:none">
          <div style="display:flex;align-items:center;gap:8px;margin-top:8px">
            <input type="text" id="extensionTokenInput" readonly style="flex:1;font-family:monospace;font-size:0.82rem;letter-spacing:0.05em;background:var(--surface-2);border:1px solid var(--border);border-radius:6px;padding:8px 12px;color:var(--text)" />
            <button class="btn btn-ghost" onclick="copyExtensionToken()" style="padding:8px 14px;white-space:nowrap">Copy</button>
          </div>
          <p style="font-size:0.78rem;color:var(--text-muted);margin-top:6px">Paste this token in the extension settings. It expires after 24 hours.</p>
        </div>
      </div>
    </div>

    <!-- Privacy -->
    <div class="network-section" style="margin-top:24px">
      <div class="network-section-header"><h3>Privacy &amp; Data</h3></div>
      <div class="card network-settings-card" style="border-color:rgba(224,92,92,0.3)">
        <div class="network-settings-card-header">
          <div class="network-settings-card-icon">🗑️</div>
          <div>
            <div class="network-settings-card-title">Delete All Network Data</div>
            <div class="network-settings-card-desc">Permanently remove all connections, companies, and outreach history from your account</div>
          </div>
        </div>
        <div class="network-settings-actions">
          <button class="btn" style="background:var(--danger);color:#fff;padding:8px 18px;font-size:0.85rem" onclick="confirmDeleteNetworkData()">
            Delete Network Data
          </button>
        </div>
      </div>
    </div>
  `;
}

async function generateAndShowExtensionToken() {
  const display = document.getElementById('extensionTokenDisplay');
  const input   = document.getElementById('extensionTokenInput');
  if (!display || !input) return;

  try {
    const token = await generateExtensionToken();
    // Mask: show first 8 + ellipsis + last 4
    const masked = token.substring(0, 8) + '…' + token.slice(-4);
    input.value         = masked;
    input.dataset.full  = token;
    display.style.display = 'block';
  } catch (err) {
    showToast('Network', `Error generating token: ${err.message}`);
  }
}

function copyExtensionToken() {
  const input = document.getElementById('extensionTokenInput');
  if (!input) return;
  const full = input.dataset.full || input.value;
  navigator.clipboard.writeText(full).then(() => {
    showToast('Network', 'Token copied to clipboard.');
  }).catch(() => {
    // Fallback
    input.value = full;
    input.select();
    document.execCommand('copy');
    showToast('Network', 'Token copied.');
  });
}

function confirmDeleteNetworkData() {
  const modal = document.createElement('div');
  modal.className = 'network-modal-overlay';
  modal.innerHTML = `
    <div class="network-modal" style="max-width:420px">
      <div class="network-modal-header">
        <h3 style="color:var(--danger)">Delete Network Data</h3>
        <button class="network-modal-close" onclick="this.closest('.network-modal-overlay').remove()">×</button>
      </div>
      <div class="network-modal-body" style="padding:16px 0">
        <p style="margin-bottom:12px">This will permanently delete:</p>
        <ul style="color:var(--text-muted);font-size:0.88rem;padding-left:18px;line-height:2">
          <li>All imported connections</li>
          <li>All company network data</li>
          <li>All outreach history and generated messages</li>
          <li>Your Google OAuth token</li>
        </ul>
        <p style="margin-top:12px;color:var(--danger);font-size:0.88rem;font-weight:600">This action cannot be undone.</p>
      </div>
      <div class="network-modal-footer">
        <button class="btn" style="background:var(--danger);color:#fff" onclick="executeDeleteNetworkData(this)">Yes, Delete Everything</button>
        <button class="btn btn-ghost" onclick="this.closest('.network-modal-overlay').remove()">Cancel</button>
      </div>
    </div>
  `;
  document.body.appendChild(modal);
  modal.addEventListener('click', e => { if (e.target === modal) modal.remove(); });
}

async function executeDeleteNetworkData(btn) {
  btn.disabled   = true;
  btn.textContent = 'Deleting…';
  try {
    await deleteNetworkData();
    document.querySelector('.network-modal-overlay')?.remove();
    showToast('Network', 'All network data has been deleted.');
    networkState.connections = [];
    networkState.companies   = [];
    networkState.warmJobs    = [];
    networkState.outreach    = [];
    networkState.dashboard   = null;
    networkState.oauthStatus = null;
    renderNetworkSettings();
  } catch (err) {
    btn.disabled    = false;
    btn.textContent = 'Yes, Delete Everything';
    showToast('Network', `Error: ${err.message}`);
  }
}

// ── OAuth / Import ────────────────────────────────────────────────────────────
async function connectGoogle() {
  try {
    const res  = await apiFetch(`${BACKEND_URL}/network/oauth/google/url`);
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const data = await res.json();
    if (data.url) {
      window.location.href = data.url;
    } else {
      throw new Error('No OAuth URL returned');
    }
  } catch (err) {
    showToast('Network', `Could not initiate Google sign-in: ${err.message}`);
  }
}

async function disconnectGoogle() {
  try {
    const res = await apiFetch(`${BACKEND_URL}/network/oauth/google`, { method: 'DELETE' });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    showToast('Network', 'Google account disconnected.');
    networkState.oauthStatus = null;
    renderNetworkSettings();
  } catch (err) {
    showToast('Network', `Error: ${err.message}`);
  }
}

async function triggerGoogleImport() {
  const btn = document.getElementById('importContactsBtn') || document.getElementById('networkImportBtn');
  if (btn) { btn.disabled = true; btn.textContent = 'Importing…'; }

  try {
    const res  = await apiFetch(`${BACKEND_URL}/network/import/google`, { method: 'POST' });
    if (!res.ok) {
      const err = await res.json().catch(() => ({}));
      // 401 = not connected yet
      if (res.status === 401) {
        showToast('Network', 'Connect your Google account first (Settings tab).');
        switchNetworkView('settings');
        return;
      }
      throw new Error(err.error || `HTTP ${res.status}`);
    }
    const data = await res.json();
    showToast('Network', 'Import started! This may take a minute…');

    if (data.importId) {
      pollImportStatus(data.importId);
    }
  } catch (err) {
    showToast('Network', `Import error: ${err.message}`);
  } finally {
    if (btn) { btn.disabled = false; btn.textContent = btn.id === 'networkImportBtn' ? '+ Import Contacts' : '↺ Sync Now'; }
  }
}

async function pollImportStatus(importId) {
  if (networkState.pollTimer) clearInterval(networkState.pollTimer);

  networkState.pollTimer = setInterval(async () => {
    try {
      const res  = await apiFetch(`${BACKEND_URL}/network/import/${encodeURIComponent(importId)}/status`);
      if (!res.ok) return;
      const data = await res.json();
      networkState.importStatus = data;

      const status = data.status;
      if (status === 'completed') {
        clearInterval(networkState.pollTimer);
        networkState.pollTimer = null;
        showToast('Network', `Import complete! ${data.imported ?? ''} contacts processed.`);
        // Refresh overview data
        await loadNetworkStats();
        await loadWarmJobs();
        if (networkState.currentView === 'overview') renderNetworkOverview();
      } else if (status === 'failed') {
        clearInterval(networkState.pollTimer);
        networkState.pollTimer = null;
        showToast('Network', `Import failed: ${data.error || 'Unknown error'}`);
      }
      // status === 'running' → keep polling
    } catch (err) {
      console.warn('[Network] poll error:', err.message);
    }
  }, 3000);

  // Stop polling after 10 minutes no matter what
  setTimeout(() => {
    if (networkState.pollTimer) {
      clearInterval(networkState.pollTimer);
      networkState.pollTimer = null;
    }
  }, 600000);
}

// ── Outreach actions ──────────────────────────────────────────────────────────
async function generateOutreach(connectionId, jobId, messageType) {
  const res = await apiFetch(`${BACKEND_URL}/network/outreach/generate`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ connectionId, jobId, messageType }),
  });
  if (!res.ok) {
    const err = await res.json().catch(() => ({}));
    throw new Error(err.error || `HTTP ${res.status}`);
  }
  return res.json();
}

async function saveOutreach(outreachData) {
  const res = await apiFetch(`${BACKEND_URL}/network/outreach`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(outreachData),
  });
  if (!res.ok) {
    const err = await res.json().catch(() => ({}));
    throw new Error(err.error || `HTTP ${res.status}`);
  }
  return res.json();
}

async function updateOutreachStatus(outreachId, status) {
  const res = await apiFetch(`${BACKEND_URL}/network/outreach/${encodeURIComponent(outreachId)}/status`, {
    method: 'PATCH',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ status }),
  });
  if (!res.ok) {
    const err = await res.json().catch(() => ({}));
    throw new Error(err.error || `HTTP ${res.status}`);
  }
  // Update local state
  const idx = networkState.outreach.findIndex(o => o.id === outreachId);
  if (idx >= 0) networkState.outreach[idx].status = status;
  return res.json();
}

// ── Extension token ───────────────────────────────────────────────────────────
async function generateExtensionToken() {
  const res = await apiFetch(`${BACKEND_URL}/network/extension/token`, {
    method: 'POST',
  });
  if (!res.ok) {
    const err = await res.json().catch(() => ({}));
    throw new Error(err.error || `HTTP ${res.status}`);
  }
  const data = await res.json();
  return data.token;
}

// ── Privacy ───────────────────────────────────────────────────────────────────
async function deleteNetworkData() {
  const res = await apiFetch(`${BACKEND_URL}/network/data`, {
    method: 'DELETE',
  });
  if (!res.ok) {
    const err = await res.json().catch(() => ({}));
    throw new Error(err.error || `HTTP ${res.status}`);
  }
  return res.json();
}

// ── Card renderers ────────────────────────────────────────────────────────────
function renderConnectionCard(connection) {
  const score    = connection.relationshipScore ?? 0;
  const tier     = connection.tier || scoreTier(score);
  const tierColor = { close: '#4caf7d', strong: '#d4af37', moderate: '#888', weak: '#555' }[tier] || '#555';
  const initials = getInitials(connection.name || '?');

  return `
    <div class="card network-connection-card" onclick="openOutreachModal('${escapeHtml(connection.id || '')}')">
      <div class="network-connection-avatar" style="background:var(--surface-2);border:1.5px solid var(--border)">
        ${initials}
      </div>
      <div class="network-connection-info">
        <div class="network-connection-name">
          ${escapeHtml(connection.name || 'Unknown')}
          ${connection.isRecruiter ? '<span class="badge badge-gold">Recruiter</span>' : ''}
        </div>
        <div class="network-connection-title">${escapeHtml(connection.title || '')}</div>
        <div class="network-connection-company">${escapeHtml(connection.company || '')}</div>
      </div>
      <div class="network-connection-meta">
        <span class="score-badge" style="background:${tierColor}22;color:${tierColor};border:1px solid ${tierColor}44">
          ${tier.charAt(0).toUpperCase() + tier.slice(1)}
        </span>
        <span style="font-size:0.75rem;color:var(--text-muted)">${escapeHtml(connection.source || '')}</span>
      </div>
    </div>
  `;
}

function renderCompanyCard(company) {
  const strength  = company.networkStrength || 0;
  const strengthBar = Math.min(100, Math.round(strength * 100));
  return `
    <div class="card network-company-card" onclick="showCompanyConnections('${escapeHtml(company.name || '')}')">
      <div class="network-company-name">${escapeHtml(company.name || 'Unknown')}</div>
      <div class="network-company-stats">
        <span>👥 ${company.connectionCount ?? 0} connections</span>
        <span>🎯 ${company.recruiterCount ?? 0} recruiters</span>
      </div>
      <div class="network-strength-bar-wrap" title="Network strength: ${strengthBar}%">
        <div class="network-strength-bar" style="width:${strengthBar}%"></div>
      </div>
      <div style="font-size:0.72rem;color:var(--text-muted);margin-top:4px">Network strength: ${strengthBar}%</div>
    </div>
  `;
}

function renderWarmJobCard(job) {
  const connectionCount = job.connectionCount ?? job.connections?.length ?? 0;
  return `
    <div class="card network-warm-card">
      <div class="network-warm-job-title">${escapeHtml(job.title || job.jobTitle || 'Unknown Role')}</div>
      <div class="network-warm-company">${escapeHtml(job.company || '—')}</div>
      <div class="network-warm-meta">
        <span class="badge badge-gold">🤝 ${connectionCount} connection${connectionCount !== 1 ? 's' : ''}</span>
        ${job.location ? `<span style="font-size:0.78rem;color:var(--text-muted)">${escapeHtml(job.location)}</span>` : ''}
      </div>
      ${job.salary ? `<div style="font-size:0.8rem;color:var(--text-muted);margin-top:4px">${escapeHtml(job.salary)}</div>` : ''}
    </div>
  `;
}

function renderNetworkGaps(gaps) {
  if (!gaps.length) return '<div class="empty-table" style="color:var(--text-muted)">No gap data available.</div>';
  return `
    <div class="network-gaps-list">
      ${gaps.map(gap => `
        <div class="card network-gap-card">
          <div class="network-gap-label">${escapeHtml(gap.industry || gap.category || 'Unknown')}</div>
          <div class="network-gap-desc">${escapeHtml(gap.suggestion || gap.description || '')}</div>
          ${gap.severity ? `<span class="score-badge" style="background:var(--surface-2);color:var(--text-muted);border:1px solid var(--border);font-size:0.72rem">${escapeHtml(gap.severity)}</span>` : ''}
        </div>
      `).join('')}
    </div>
  `;
}

// ── Outreach modal ────────────────────────────────────────────────────────────
function openOutreachModal(connectionId) {
  const connection = networkState.connections.find(c => c.id === connectionId);
  if (!connection) { showToast('Network', 'Connection not found.'); return; }

  const modal = document.createElement('div');
  modal.className = 'network-modal-overlay';
  modal.innerHTML = `
    <div class="network-modal" style="max-width:560px">
      <div class="network-modal-header">
        <h3>Generate Outreach Message</h3>
        <button class="network-modal-close" onclick="this.closest('.network-modal-overlay').remove()">×</button>
      </div>
      <div class="network-modal-body">
        <p style="color:var(--text-muted);font-size:0.88rem;margin-bottom:16px">
          Generate a personalized message to <strong>${escapeHtml(connection.name || 'this contact')}</strong>
          ${connection.company ? ` at <strong>${escapeHtml(connection.company)}</strong>` : ''}.
        </p>
        <div class="input-group" style="margin-bottom:14px">
          <label>Message Type</label>
          <select class="network-filter-select" id="outreachTypeSelect" style="width:100%">
            <option value="introduction">Introduction / Cold Outreach</option>
            <option value="referral_ask">Referral Request</option>
            <option value="informational">Informational Interview Request</option>
            <option value="reconnect">Reconnect</option>
            <option value="follow_up">Follow-up</option>
          </select>
        </div>
        <div class="input-group" style="margin-bottom:14px">
          <label>Related Job (optional)</label>
          <input type="text" id="outreachJobInput" placeholder="Job title or ID…" style="width:100%" />
        </div>
        <div id="outreachGeneratedArea" style="display:none;margin-top:14px">
          <label style="font-size:0.8rem;font-weight:600;color:var(--text-muted);text-transform:uppercase;letter-spacing:0.05em">Generated Message</label>
          <textarea id="outreachGeneratedText" rows="8" style="width:100%;margin-top:6px;resize:vertical"></textarea>
        </div>
      </div>
      <div class="network-modal-footer">
        <button class="btn btn-gold" id="outreachGenerateBtn" onclick="doGenerateOutreach('${escapeHtml(connectionId)}')">Generate Message</button>
        <button class="btn btn-ghost" id="outreachSaveBtn" style="display:none" onclick="doSaveOutreach('${escapeHtml(connectionId)}')">Save to History</button>
        <button class="btn btn-ghost" onclick="this.closest('.network-modal-overlay').remove()">Cancel</button>
      </div>
    </div>
  `;
  document.body.appendChild(modal);
  modal.addEventListener('click', e => { if (e.target === modal) modal.remove(); });
}

async function doGenerateOutreach(connectionId) {
  const btn         = document.getElementById('outreachGenerateBtn');
  const typeSelect  = document.getElementById('outreachTypeSelect');
  const jobInput    = document.getElementById('outreachJobInput');
  const area        = document.getElementById('outreachGeneratedArea');
  const textarea    = document.getElementById('outreachGeneratedText');

  if (!btn || !typeSelect || !area || !textarea) return;

  btn.disabled   = true;
  btn.textContent = 'Generating…';

  try {
    const data = await generateOutreach(connectionId, jobInput?.value?.trim() || null, typeSelect.value);
    textarea.value     = data.message || '';
    area.style.display = 'block';
    const saveBtn      = document.getElementById('outreachSaveBtn');
    if (saveBtn) saveBtn.style.display = 'inline-flex';
    btn.textContent = 'Regenerate';
  } catch (err) {
    showToast('Network', `Generation failed: ${err.message}`);
    btn.textContent = 'Generate Message';
  } finally {
    btn.disabled = false;
  }
}

async function doSaveOutreach(connectionId) {
  const typeSelect = document.getElementById('outreachTypeSelect');
  const textarea   = document.getElementById('outreachGeneratedText');
  const jobInput   = document.getElementById('outreachJobInput');
  const saveBtn    = document.getElementById('outreachSaveBtn');

  if (!textarea?.value) { showToast('Network', 'Nothing to save.'); return; }

  if (saveBtn) { saveBtn.disabled = true; saveBtn.textContent = 'Saving…'; }

  try {
    await saveOutreach({
      connectionId,
      jobId:       jobInput?.value?.trim() || null,
      messageType: typeSelect?.value || 'introduction',
      message:     textarea.value,
      status:      'pending',
    });
    showToast('Network', 'Outreach saved to history.');
    document.querySelector('.network-modal-overlay')?.remove();
  } catch (err) {
    showToast('Network', `Save failed: ${err.message}`);
    if (saveBtn) { saveBtn.disabled = false; saveBtn.textContent = 'Save to History'; }
  }
}

function showCompanyConnections(companyName) {
  const conns = networkState.connections.filter(c => c.company === companyName);
  if (!conns.length) {
    // Load from API
    loadConnections(1, companyName).then(() => {
      _showCompanyConnectionsModal(companyName);
    }).catch(console.error);
  } else {
    _showCompanyConnectionsModal(companyName);
  }
}

function _showCompanyConnectionsModal(companyName) {
  const conns = networkState.connections.filter(c => c.company === companyName);
  const modal = document.createElement('div');
  modal.className = 'network-modal-overlay';
  modal.innerHTML = `
    <div class="network-modal" style="max-width:520px">
      <div class="network-modal-header">
        <h3>Connections at ${escapeHtml(companyName)}</h3>
        <button class="network-modal-close" onclick="this.closest('.network-modal-overlay').remove()">×</button>
      </div>
      <div class="network-modal-body">
        ${conns.length
          ? conns.map(c => `
            <div style="display:flex;align-items:center;gap:12px;padding:10px 0;border-bottom:1px solid var(--border)">
              <div style="width:36px;height:36px;border-radius:50%;background:var(--surface-2);display:flex;align-items:center;justify-content:center;font-weight:700;font-size:0.85rem;flex-shrink:0">
                ${getInitials(c.name || '?')}
              </div>
              <div style="flex:1;min-width:0">
                <div style="font-weight:600;font-size:0.9rem">${escapeHtml(c.name || '—')}</div>
                <div style="font-size:0.8rem;color:var(--text-muted)">${escapeHtml(c.title || '')}</div>
              </div>
              <button class="btn btn-gold" style="padding:6px 12px;font-size:0.78rem;white-space:nowrap" onclick="this.closest('.network-modal-overlay').remove();openOutreachModal('${escapeHtml(c.id || '')}')">
                Message
              </button>
            </div>
          `).join('')
          : '<div class="empty-table">No connections found at this company.</div>'
        }
      </div>
      <div class="network-modal-footer">
        <button class="btn btn-ghost" onclick="this.closest('.network-modal-overlay').remove()">Close</button>
      </div>
    </div>
  `;
  document.body.appendChild(modal);
  modal.addEventListener('click', e => { if (e.target === modal) modal.remove(); });
}

// ── Utilities ─────────────────────────────────────────────────────────────────
function escapeHtml(str) {
  if (str === null || str === undefined) return '';
  return String(str)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

function getInitials(name) {
  const parts = String(name).trim().split(/\s+/);
  if (parts.length === 0) return '?';
  if (parts.length === 1) return parts[0].charAt(0).toUpperCase();
  return (parts[0].charAt(0) + parts[parts.length - 1].charAt(0)).toUpperCase();
}

function scoreTier(score) {
  if (score >= 0.75) return 'close';
  if (score >= 0.5)  return 'strong';
  if (score >= 0.25) return 'moderate';
  return 'weak';
}

// ── Inline CSS injection (scoped to network panel) ────────────────────────────
(function injectNetworkStyles() {
  if (document.getElementById('network-styles')) return;
  const style = document.createElement('style');
  style.id = 'network-styles';
  style.textContent = `
    /* Stats row */
    .network-stats-row {
      display: grid;
      grid-template-columns: repeat(auto-fit, minmax(160px, 1fr));
      gap: 16px;
      margin-bottom: 24px;
    }
    .network-stat-card {
      display: flex;
      flex-direction: column;
      align-items: center;
      text-align: center;
      padding: 20px 16px;
      gap: 6px;
    }
    .network-stat-icon { font-size: 1.6rem; }
    .network-stat-value { font-size: 2rem; font-weight: 700; color: var(--gold); line-height: 1.1; }
    .network-stat-label { font-size: 0.78rem; color: var(--text-muted); text-transform: uppercase; letter-spacing: 0.04em; }

    /* Sections */
    .network-section { margin-bottom: 28px; }
    .network-section-header {
      display: flex;
      align-items: baseline;
      gap: 12px;
      margin-bottom: 14px;
    }
    .network-section-header h3 {
      font-size: 1rem;
      font-weight: 700;
      color: var(--text);
    }

    /* Warm jobs */
    .network-warm-grid {
      display: grid;
      grid-template-columns: repeat(auto-fill, minmax(240px, 1fr));
      gap: 14px;
    }
    .network-warm-card { padding: 16px 18px; cursor: default; }
    .network-warm-job-title { font-weight: 700; font-size: 0.95rem; margin-bottom: 4px; }
    .network-warm-company { font-size: 0.83rem; color: var(--text-muted); margin-bottom: 10px; }
    .network-warm-meta { display: flex; align-items: center; gap: 10px; flex-wrap: wrap; }

    /* Connections */
    .network-toolbar {
      display: flex;
      gap: 10px;
      flex-wrap: wrap;
      margin-bottom: 18px;
      align-items: center;
    }
    .network-search-input {
      flex: 1;
      min-width: 200px;
      background: var(--surface-2);
      border: 1px solid var(--border);
      border-radius: var(--radius);
      color: var(--text);
      font-size: 0.9rem;
      padding: 9px 14px;
      outline: none;
      font-family: inherit;
      transition: border-color 0.2s;
    }
    .network-search-input:focus { border-color: var(--gold); box-shadow: 0 0 0 3px var(--gold-glow); }
    .network-filter-select {
      background: var(--surface-2);
      border: 1px solid var(--border);
      border-radius: var(--radius);
      color: var(--text);
      font-size: 0.85rem;
      padding: 9px 12px;
      outline: none;
      cursor: pointer;
      font-family: inherit;
      transition: border-color 0.2s;
    }
    .network-filter-select:focus { border-color: var(--gold); }

    .network-connections-grid {
      display: grid;
      grid-template-columns: repeat(auto-fill, minmax(260px, 1fr));
      gap: 14px;
    }
    .network-connection-card {
      display: flex;
      flex-direction: column;
      gap: 8px;
      padding: 14px 16px;
      cursor: pointer;
      transition: border-color 0.2s, transform 0.15s;
    }
    .network-connection-card:hover { border-color: var(--gold); transform: translateY(-2px); }
    .network-connection-avatar {
      width: 40px;
      height: 40px;
      border-radius: 50%;
      display: flex;
      align-items: center;
      justify-content: center;
      font-weight: 700;
      font-size: 0.9rem;
      flex-shrink: 0;
    }
    .network-connection-name { font-weight: 700; font-size: 0.92rem; display: flex; align-items: center; gap: 6px; flex-wrap: wrap; }
    .network-connection-title { font-size: 0.8rem; color: var(--text-muted); }
    .network-connection-company { font-size: 0.8rem; color: var(--text-muted); }
    .network-connection-meta { display: flex; align-items: center; justify-content: space-between; margin-top: 4px; flex-wrap: wrap; gap: 6px; }

    /* Companies */
    .network-companies-list { display: flex; flex-direction: column; gap: 10px; }
    .network-company-card {
      display: flex;
      align-items: center;
      gap: 16px;
      padding: 14px 18px;
      cursor: pointer;
      transition: border-color 0.2s;
      flex-wrap: wrap;
    }
    .network-company-card:hover { border-color: var(--gold); }
    .network-company-name { font-weight: 700; font-size: 0.95rem; flex: 1; min-width: 140px; }
    .network-company-stats { display: flex; gap: 16px; font-size: 0.82rem; color: var(--text-muted); }
    .network-strength-bar-wrap { width: 100px; height: 4px; background: var(--surface-2); border-radius: 2px; overflow: hidden; }
    .network-strength-bar { height: 100%; background: var(--gold); border-radius: 2px; transition: width 0.4s ease; }

    /* Gaps */
    .network-gaps-list { display: flex; flex-direction: column; gap: 10px; }
    .network-gap-card { padding: 12px 16px; display: flex; flex-direction: column; gap: 4px; }
    .network-gap-label { font-weight: 700; font-size: 0.88rem; }
    .network-gap-desc { font-size: 0.82rem; color: var(--text-muted); }

    /* Badges */
    .badge {
      display: inline-block;
      padding: 2px 8px;
      border-radius: 20px;
      font-size: 0.72rem;
      font-weight: 700;
      line-height: 1.6;
    }
    .badge-gold { background: var(--gold-glow); color: var(--gold); border: 1px solid rgba(212,175,55,0.3); }
    .badge-outline { background: transparent; color: var(--text-muted); border: 1px solid var(--border); }

    .score-badge {
      display: inline-block;
      padding: 2px 10px;
      border-radius: 20px;
      font-size: 0.72rem;
      font-weight: 700;
    }

    /* Status chips */
    .status-chip {
      display: inline-block;
      padding: 2px 8px;
      border-radius: 20px;
      font-size: 0.72rem;
      font-weight: 700;
    }
    .status-pending  { background: rgba(136,136,136,0.15); color: #888; }
    .status-sent     { background: rgba(212,175,55,0.15); color: var(--gold); }
    .status-replied  { background: rgba(76,175,125,0.15); color: #4caf7d; }
    .status-declined { background: rgba(224,92,92,0.15); color: var(--danger); }

    /* Settings */
    .network-settings-card { padding: 20px 22px; }
    .network-settings-card-header {
      display: flex;
      align-items: flex-start;
      gap: 14px;
      margin-bottom: 14px;
    }
    .network-settings-card-icon { font-size: 1.6rem; flex-shrink: 0; margin-top: 2px; }
    .network-settings-card-title { font-weight: 700; font-size: 0.95rem; margin-bottom: 3px; }
    .network-settings-card-desc { font-size: 0.82rem; color: var(--text-muted); }
    .network-settings-card-status { margin-left: auto; display: flex; align-items: center; gap: 6px; white-space: nowrap; }
    .network-settings-meta {
      display: flex;
      gap: 20px;
      flex-wrap: wrap;
      font-size: 0.82rem;
      color: var(--text-muted);
      margin-bottom: 14px;
    }
    .network-settings-actions { display: flex; gap: 10px; flex-wrap: wrap; }

    /* Outreach table */
    .outreach-row:hover { background: var(--surface-2); }

    /* Modals */
    .network-modal-overlay {
      position: fixed;
      inset: 0;
      background: rgba(0,0,0,0.7);
      display: flex;
      align-items: center;
      justify-content: center;
      z-index: 1100;
      padding: 16px;
    }
    .network-modal {
      background: var(--surface);
      border: 1px solid var(--border);
      border-radius: 14px;
      width: 100%;
      max-width: 600px;
      max-height: 90vh;
      display: flex;
      flex-direction: column;
      overflow: hidden;
      box-shadow: 0 24px 64px rgba(0,0,0,0.6);
    }
    .network-modal-header {
      display: flex;
      align-items: center;
      justify-content: space-between;
      padding: 18px 22px 14px;
      border-bottom: 1px solid var(--border);
    }
    .network-modal-header h3 { font-size: 1rem; font-weight: 700; }
    .network-modal-close {
      background: none;
      border: none;
      color: var(--text-muted);
      font-size: 1.4rem;
      cursor: pointer;
      line-height: 1;
      padding: 0;
    }
    .network-modal-close:hover { color: var(--text); }
    .network-modal-meta {
      display: flex;
      gap: 18px;
      flex-wrap: wrap;
      padding: 12px 22px;
      background: var(--surface-2);
      font-size: 0.83rem;
      border-bottom: 1px solid var(--border);
    }
    .network-modal-body {
      flex: 1;
      overflow-y: auto;
      padding: 18px 22px;
    }
    .network-modal-footer {
      display: flex;
      gap: 10px;
      padding: 14px 22px;
      border-top: 1px solid var(--border);
      flex-wrap: wrap;
    }
    .network-message-pre {
      white-space: pre-wrap;
      word-break: break-word;
      font-family: inherit;
      font-size: 0.88rem;
      line-height: 1.7;
      color: var(--text);
      background: var(--surface-2);
      border: 1px solid var(--border);
      border-radius: 8px;
      padding: 14px 16px;
      margin: 0;
    }

    /* Loading state */
    .panel-loading {
      text-align: center;
      color: var(--text-muted);
      padding: 60px 20px;
      font-size: 0.9rem;
    }

    /* Empty table */
    .empty-table {
      text-align: center;
      color: var(--text-muted);
      padding: 40px 20px;
      font-size: 0.88rem;
    }

    /* Table */
    .table-wrap { overflow-x: auto; }
    .app-table {
      width: 100%;
      border-collapse: collapse;
      font-size: 0.88rem;
    }
    .app-table th {
      text-align: left;
      padding: 10px 14px;
      font-size: 0.75rem;
      font-weight: 700;
      color: var(--text-muted);
      text-transform: uppercase;
      letter-spacing: 0.05em;
      border-bottom: 1px solid var(--border);
    }
    .app-table td {
      padding: 12px 14px;
      border-bottom: 1px solid var(--border);
      vertical-align: middle;
    }

    /* Mobile */
    @media (max-width: 640px) {
      .network-stats-row { grid-template-columns: repeat(2, 1fr); }
      .network-connections-grid { grid-template-columns: 1fr; }
      .network-warm-grid { grid-template-columns: 1fr; }
      .network-company-card { flex-direction: column; align-items: flex-start; }
    }
  `;
  document.head.appendChild(style);
})();
