const BACKEND_URL =
  window.location.hostname === "localhost" || window.location.hostname === "127.0.0.1"
    ? "http://127.0.0.1:5001/adib-job-agent/us-central1/api"
    : "https://us-central1-adib-job-agent.cloudfunctions.net/api";

// ── Auth guard ────────────────────────────────────────────────────────────────
const email = sessionStorage.getItem("fbEmail");
const token = sessionStorage.getItem("fbToken");
const fbUid = sessionStorage.getItem("fbUid") || email;
if (!email || !token) window.location.href = "index.html";
const userId = email;

// ── Panel registry ────────────────────────────────────────────────────────────
const PANELS = {
  dashboard:    document.getElementById("dashboardView"),
  applications: document.getElementById("applicationsView"),
  jobs:         document.getElementById("jobsView"),
  jobDetail:    document.getElementById("jobDetailView"),
  documents:    document.getElementById("documentsView"),
  digest:       document.getElementById("digestView"),
  profile:      document.getElementById("profileView"),
  account:      document.getElementById("accountView"),
  preferences:  document.getElementById("preferencesView"),
  admin:        document.getElementById("adminView"),
};

let isLoading      = false;
let currentDocType = "resume";
let currentJob     = null;
let userTier       = "free";  // loaded on init, used for feature gating
let userRole       = "customer"; // loaded on init; "admin" shows Admin Panel
let allJobsList        = [];
let allWatchlistJobs   = [];
let allDocumentsList   = [];

// ── Init ──────────────────────────────────────────────────────────────────────
function init() {
  document.getElementById("userEmail").textContent  = email;
  document.getElementById("userAvatar").textContent = email.charAt(0).toUpperCase();

  // Sidebar navigation
  document.getElementById("nav-dashboard").addEventListener("click", () => showPanel("dashboard"));
  document.getElementById("nav-jobs").addEventListener("click",      () => showPanel("jobs"));
  document.getElementById("nav-documents").addEventListener("click",   () => showPanel("documents"));
  document.getElementById("nav-digest").addEventListener("click",      () => showPanel("digest"));
  document.getElementById("nav-profile").addEventListener("click",     () => showPanel("profile"));
  document.getElementById("nav-account").addEventListener("click",     () => showPanel("account"));
  document.getElementById("nav-preferences").addEventListener("click", () => showPanel("preferences"));
  document.getElementById("nav-admin")?.addEventListener("click",       () => showPanel("admin"));
  document.getElementById("signOutBtn").addEventListener("click",    signOut);

  // Applications panel
  document.getElementById("nav-applications").addEventListener("click", () => showPanel("applications"));
  document.getElementById("quickAddBtn").addEventListener("click", showQuickAdd);

  // Close detail panel on Escape key
  document.addEventListener("keydown", e => { if (e.key === "Escape") closeAppDetail(); });

  // Document tabs
  document.querySelectorAll(".doc-tab").forEach((tab) => {
    tab.addEventListener("click", () => {
      document.querySelectorAll(".doc-tab").forEach(t => t.classList.remove("active"));
      tab.classList.add("active");
      currentDocType = tab.dataset.doctype;
      loadDocuments(currentDocType);
    });
  });

  // Forms
  document.getElementById("prefsForm").addEventListener("submit",   savePreferences);
  document.getElementById("kbForm").addEventListener("submit",      saveKnowledge);

  // Preferences panel buttons
  document.getElementById("saveScheduleBtn").addEventListener("click",    saveScheduleSettings);
  document.getElementById("saveNotifBtn").addEventListener("click",       saveNotificationSettings);
  document.getElementById("saveCustomSitesBtn").addEventListener("click", saveCustomSites);

  // Target company watchlist
  document.getElementById("addTargetCompanyBtn").addEventListener("click", () => addTargetCompanyRow("", ""));
  document.getElementById("saveWatchlistBtn").addEventListener("click", saveWatchlistCompanies);

  // Push notifications: request permission + register token after page settles
  setTimeout(initNotifications, 1500);

  // Mobile navigation: hamburger opens sidebar, backdrop or any nav item closes it
  const appLayout   = document.querySelector(".app-layout");
  const navBackdrop = document.getElementById("navBackdrop");
  document.getElementById("menuToggle").addEventListener("click",  () => appLayout.classList.add("nav-open"));
  navBackdrop.addEventListener("click", () => appLayout.classList.remove("nav-open"));
  document.querySelectorAll(".nav-item, #signOutBtn").forEach(btn =>
    btn.addEventListener("click", () => appLayout.classList.remove("nav-open"))
  );

  // Search Now button
  document.getElementById("searchNowBtn").addEventListener("click", searchNow);

  // Job detail back button
  document.getElementById("backToJobsBtn").addEventListener("click", () => showPanel("jobs"));

  // Resume file upload
  initResumeUpload();
  // Phone number formatter
  initPhoneFormatter();

  // Check for post-Stripe-checkout redirect params
  const urlParams = new URLSearchParams(window.location.search);
  const subStatus = urlParams.get("subscription");
  if (subStatus === "success") {
    showToast("CareerCopilot", "You're now on Pro! Enjoy your 7-day free trial.");
    // Clean the URL so a refresh doesn't re-show the toast
    history.replaceState({}, "", window.location.pathname);
  } else if (subStatus === "canceled") {
    showToast("CareerCopilot", "Checkout canceled — your plan was not changed.");
    history.replaceState({}, "", window.location.pathname);
  }

  // Load dashboard on start
  showPanel("dashboard");
  loadUserTier().then(() => {
    // Let the onboarding engine know the real tier once the fetch resolves
    if (typeof OnboardingEngine !== 'undefined') OnboardingEngine.setTier(userTier);
  });
}

// ── Panel switching ───────────────────────────────────────────────────────────
function showPanel(name) {
  Object.values(PANELS).forEach(p => { p.style.display = "none"; });
  PANELS[name].style.display = "flex";

  document.querySelectorAll(".nav-item").forEach(b => b.classList.remove("active"));
  const navIds = {
    dashboard:    "nav-dashboard",
    applications: "nav-applications",
    jobs:         "nav-jobs",
    documents:    "nav-documents",
    digest:       "nav-digest",
    profile:      "nav-profile",
    account:      "nav-account",
    preferences:  "nav-preferences",
    admin:        "nav-admin",
  };
  if (navIds[name]) document.getElementById(navIds[name])?.classList.add("active");

  if (name === "dashboard")    { loadStats(); loadRecentJobs(); loadApplications(); }
  if (name === "applications") loadApplications();
  if (name === "admin")        loadAdminPanel();
  if (name === "jobs")         loadJobs();
  if (name === "documents")    loadDocuments(currentDocType);
  if (name === "digest")       loadDigest();
  if (name === "profile")      loadProfilePanel();
  if (name === "account")      loadAccountPanel();
  if (name === "preferences")  loadPreferencesPanel();
}

// ── Dashboard recent jobs ─────────────────────────────────────────────────────
async function loadRecentJobs() {
  const el = document.getElementById("dashboardJobs");
  try {
    const res  = await fetch(`${BACKEND_URL}/jobs/${encodeURIComponent(userId)}`);
    const data = await res.json();
    if (!data.jobs || data.jobs.length === 0) {
      el.innerHTML = `<div class="empty-table">No jobs found yet — your daily search will run automatically, or upgrade to Pro to search on demand.</div>`;
      return;
    }
    const recent = data.jobs.slice(0, 6);
    el.innerHTML = `<div class="dashboard-jobs-grid">${recent.map(j => jobCard(j)).join("")}</div>`;
  } catch {
    el.innerHTML = `<div class="panel-loading">Could not load recent jobs.</div>`;
  }
}

// ── Dashboard stats ───────────────────────────────────────────────────────────
async function loadStats() {
  try {
    const res  = await fetch(`${BACKEND_URL}/stats/${encodeURIComponent(userId)}`);
    const data = await res.json();
    document.getElementById("stat-new-jobs").textContent    = data.newJobs24h        ?? 0;
    document.getElementById("stat-total-jobs").textContent  = data.totalJobs         ?? 0;
    document.getElementById("stat-applications").textContent = data.applicationsCount ?? 0;
    document.getElementById("stat-documents").textContent   = data.documentsCount    ?? 0;
  } catch (err) {
    console.error("Stats error:", err);
  }
}

// ── Applications ──────────────────────────────────────────────────────────────
let allApplicationsList = [];
let currentAppView      = "kanban";
let currentDetailAppId  = null;
let currentDetailTab    = "notes";

const ALL_STATUSES_FE = ["Saved","Preparing","Applied","Assessment","Phone Screen",
  "Interview","Final Interview","Offer","Rejected","Ghosted","Withdrawn","Accepted"];

const KANBAN_COLS = [
  { id: "saved",        label: "Saved",        statuses: ["Saved","Preparing"] },
  { id: "applied",      label: "Applied",      statuses: ["Applied","Assessment"] },
  { id: "screening",    label: "Screening",    statuses: ["Phone Screen"] },
  { id: "interviewing", label: "Interviewing", statuses: ["Interview","Final Interview"] },
  { id: "decision",     label: "Decision",     statuses: ["Offer"] },
  { id: "closed",       label: "Closed",       statuses: ["Rejected","Ghosted","Withdrawn","Accepted"] },
];

function statusClass(status) {
  const map = {
    "Saved":"saved","Preparing":"preparing","Applied":"applied",
    "Assessment":"assessment","Phone Screen":"phone-screen",
    "Interview":"interview","Final Interview":"final-interview",
    "Offer":"offer","Rejected":"rejected","Ghosted":"ghosted",
    "Withdrawn":"withdrawn","Accepted":"accepted",
  };
  return map[status] || "applied";
}

function daysInStatus(app) {
  const since = app.statusChangedAt || app.appliedAt;
  if (!since) return 0;
  const d = new Date(since);
  if (isNaN(d)) return 0;
  return Math.floor((Date.now() - d.getTime()) / 86400000);
}

function filteredApps() {
  const statusFilter = document.getElementById("filterStatus")?.value || "";
  const sourceFilter = document.getElementById("filterSource")?.value || "";
  const searchQ      = (document.getElementById("appSearch")?.value || "").toLowerCase().trim();
  return allApplicationsList.filter(a => {
    if (statusFilter && a.status !== statusFilter) return false;
    if (sourceFilter && a.source !== sourceFilter) return false;
    if (searchQ && !`${a.company} ${a.role} ${(a.tags||[]).join(" ")}`.toLowerCase().includes(searchQ)) return false;
    return true;
  });
}

async function loadApplications() {
  try {
    const res  = await fetch(`${BACKEND_URL}/applications/${encodeURIComponent(userId)}`);
    const data = await res.json();
    allApplicationsList = data.applications || [];
    renderPipelineBar();
    renderCurrentView();
    renderDashboardPipeline();
  } catch {
    const b = document.getElementById("kanbanCols");
    if (b) b.innerHTML = '<div class="panel-loading" style="padding:32px">Failed to load applications.</div>';
  }
}

function renderDashboardPipeline() {
  const el = document.getElementById("dashboardPipeline");
  if (!el) return;
  if (!allApplicationsList.length) {
    el.innerHTML = `<div class="empty-table">No applications yet.
      <button class="btn btn-gold" onclick="showPanel('applications')" style="padding:6px 14px;font-size:0.8rem;margin-left:8px">Start Tracking →</button></div>`;
    return;
  }
  const active     = allApplicationsList.filter(a => ["Applied","Assessment","Phone Screen","Interview","Final Interview"].includes(a.status)).length;
  const interviews = allApplicationsList.filter(a => ["Interview","Final Interview"].includes(a.status)).length;
  const offers     = allApplicationsList.filter(a => a.status === "Offer").length;
  el.innerHTML = `<div class="pipeline-bar" style="margin-bottom:0">
    <div class="pipeline-pill" onclick="showPanel('applications')">
      <span class="pill-count">${allApplicationsList.length}</span><span class="pill-label">Total</span>
    </div>
    <div class="pipeline-pill" onclick="showPanel('applications')">
      <span class="pill-count" style="color:#6495ed">${active}</span><span class="pill-label">Active</span>
    </div>
    <div class="pipeline-pill" onclick="showPanel('applications')">
      <span class="pill-count" style="color:#9370db">${interviews}</span><span class="pill-label">Interviewing</span>
    </div>
    ${offers ? `<div class="pipeline-pill" onclick="showPanel('applications')">
      <span class="pill-count" style="color:#4caf7d">${offers}</span><span class="pill-label">Offer${offers>1?"s":""}</span>
    </div>` : ""}
  </div>`;
}

function renderPipelineBar() {
  const el = document.getElementById("pipelineBar");
  if (!el) return;
  const groups = [
    { label:"All",          statuses:null },
    { label:"Active",       statuses:["Applied","Assessment","Phone Screen"],        color:"#d4af37" },
    { label:"Interviewing", statuses:["Interview","Final Interview"],                color:"#9370db" },
    { label:"Offer",        statuses:["Offer"],                                      color:"#4caf7d" },
    { label:"Rejected",     statuses:["Rejected","Ghosted"],                         color:"#e05c5c" },
    { label:"Closed",       statuses:["Withdrawn","Accepted"],                       color:"#888" },
  ];
  el.innerHTML = groups.map(g => {
    const count = g.statuses
      ? allApplicationsList.filter(a => g.statuses.includes(a.status)).length
      : allApplicationsList.length;
    return `<div class="pipeline-pill" onclick="filterByGroup(${JSON.stringify(g.statuses||null)})">
      <span class="pill-count" ${g.color?`style="color:${g.color}"`:""} >${count}</span>
      <span class="pill-label">${g.label}</span>
    </div>`;
  }).join("");
}

function filterByGroup(statuses) {
  const sel = document.getElementById("filterStatus");
  if (!sel) return;
  sel.value = (!statuses || statuses.length > 1) ? "" : (statuses[0] || "");
  renderCurrentView();
}

function switchAppView(view) {
  currentAppView = view;
  document.getElementById("kanbanBoard").style.display = view === "kanban" ? "" : "none";
  document.getElementById("tableBoard").style.display  = view === "table"  ? "" : "none";
  document.getElementById("viewKanbanBtn").classList.toggle("active", view === "kanban");
  document.getElementById("viewTableBtn").classList.toggle("active",  view === "table");
  renderCurrentView();
}

function renderCurrentView() {
  if (currentAppView === "kanban") renderKanban();
  else renderAppTable();
}

// ── Kanban ────────────────────────────────────────────────────────────────────
function renderKanban() {
  const apps  = filteredApps();
  const board = document.getElementById("kanbanCols");
  if (!board) return;
  if (!allApplicationsList.length) {
    board.innerHTML = `<div class="empty-state">
      <div class="empty-state-icon">📋</div>
      <div class="empty-state-title">No applications yet</div>
      <div class="empty-state-sub">Click "+ Add Application" to start tracking your pipeline.</div>
    </div>`;
    return;
  }
  board.innerHTML = KANBAN_COLS.map(col => {
    const colApps = apps.filter(a => col.statuses.includes(a.status));
    return `<div class="kanban-col">
      <div class="kanban-col-header">
        <span class="kanban-col-title">${col.label}</span>
        <span class="kanban-col-count">${colApps.length}</span>
      </div>
      <div class="kanban-cards">
        ${colApps.length ? colApps.map(kanbanCard).join("") :
          '<div style="font-size:0.75rem;color:var(--text-muted);padding:4px 2px;text-align:center">—</div>'}
      </div>
    </div>`;
  }).join("");
}

function kanbanCard(a) {
  const days    = daysInStatus(a);
  const isStale = days > 14 && ["Applied","Assessment"].includes(a.status);
  const isGhost = days > 21 && ["Applied","Phone Screen","Interview"].includes(a.status);
  const daysCls = isGhost ? "ghost" : isStale ? "stale" : "";
  return `<div class="kanban-card" onclick="openAppDetail('${a.id}')">
    <div class="kanban-card-company">${escapeHtml(a.company)}</div>
    <div class="kanban-card-role">${escapeHtml(a.role)}</div>
    <div class="kanban-card-meta">
      <span class="status-badge status-${statusClass(a.status)}">${escapeHtml(a.status)}</span>
      <div style="display:flex;align-items:center;gap:6px">
        <span class="kanban-card-days ${daysCls}">${days === 0 ? "Today" : days + "d"}</span>
        ${a.url ? `<a class="kanban-card-url" href="${escapeHtml(a.url)}" target="_blank" rel="noopener" onclick="event.stopPropagation()">↗</a>` : ""}
      </div>
    </div>
  </div>`;
}

// ── Table view ────────────────────────────────────────────────────────────────
function renderAppTable() {
  const apps  = filteredApps();
  const tbody = document.getElementById("appTableBody");
  if (!tbody) return;
  if (!allApplicationsList.length) {
    tbody.innerHTML = `<tr><td colspan="7"><div class="empty-state">
      <div class="empty-state-icon">📋</div>
      <div class="empty-state-title">No applications yet</div>
      <div class="empty-state-sub">Click "+ Add Application" to start tracking.</div>
    </div></td></tr>`;
    return;
  }
  if (!apps.length) {
    tbody.innerHTML = `<tr><td colspan="7" style="padding:32px;text-align:center;color:var(--text-muted)">No applications match these filters.</td></tr>`;
    return;
  }
  tbody.innerHTML = apps.map(a => {
    const days    = daysInStatus(a);
    const isStale = days > 14 && ["Applied","Assessment"].includes(a.status);
    const isGhost = days > 21 && ["Applied","Phone Screen","Interview"].includes(a.status);
    const daysStyle = isGhost ? "color:#e05c5c" : isStale ? "color:#ffaa44" : "color:var(--text-muted)";
    const opts = ALL_STATUSES_FE.map(s =>
      `<option value="${s}" ${s === a.status ? "selected" : ""}>${s}</option>`).join("");
    return `<tr>
      <td><strong>${escapeHtml(a.company)}</strong>${a.url ? ` <a href="${escapeHtml(a.url)}" target="_blank" rel="noopener" class="table-link">↗</a>` : ""}</td>
      <td style="cursor:pointer;max-width:180px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap"
          onclick="openAppDetail('${a.id}')" title="Open details">${escapeHtml(a.role)}</td>
      <td><select class="inline-status-select status-badge status-${statusClass(a.status)}"
            onchange="quickStatusUpdate('${a.id}',this.value,this)">${opts}</select></td>
      <td style="color:var(--text-muted);font-size:0.82rem">${escapeHtml(a.source || "—")}</td>
      <td style="color:var(--text-muted);font-size:0.82rem;white-space:nowrap">${a.appliedAt ? new Date(a.appliedAt).toLocaleDateString() : "—"}</td>
      <td style="font-size:0.82rem;white-space:nowrap;${daysStyle}">${days}d</td>
      <td class="table-actions">
        <button class="action-btn" onclick="openAppDetail('${a.id}')">Details</button>
        <button class="action-btn danger" onclick="deleteApplication('${a.id}')">Delete</button>
      </td>
    </tr>`;
  }).join("");
}

// ── Quick status update (table inline select) ─────────────────────────────────
async function quickStatusUpdate(appId, newStatus, selectEl) {
  try {
    await fetch(`${BACKEND_URL}/applications/${encodeURIComponent(userId)}/${appId}/status`, {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ status: newStatus }),
    });
    const app = allApplicationsList.find(a => a.id === appId);
    if (app) { app.status = newStatus; app.statusChangedAt = new Date().toISOString(); }
    selectEl.className = `inline-status-select status-badge status-${statusClass(newStatus)}`;
    renderPipelineBar();
    renderDashboardPipeline();
  } catch {
    showToast("Error", "Could not update status. Please try again.");
  }
}

// ── Detail side panel ─────────────────────────────────────────────────────────
async function openAppDetail(appId) {
  currentDetailAppId = appId;
  const app = allApplicationsList.find(a => a.id === appId);
  if (!app) return;

  document.getElementById("detailCompany").textContent = app.company;
  document.getElementById("detailRole").textContent    = app.role;

  const sel = document.getElementById("detailStatusSelect");
  sel.innerHTML = ALL_STATUSES_FE.map(s =>
    `<option value="${s}" ${s === app.status ? "selected" : ""}>${s}</option>`).join("");
  sel.className = `detail-status-select status-badge status-${statusClass(app.status)}`;

  const srcEl = document.getElementById("detailSource");
  srcEl.textContent = app.source || "manual";

  const d = daysInStatus(app);
  document.getElementById("detailDays").textContent = d === 0 ? "Today" : `${d}d in status`;

  const urlEl = document.getElementById("detailUrl");
  if (app.url) { urlEl.href = app.url; urlEl.style.display = ""; }
  else { urlEl.style.display = "none"; }

  document.getElementById("detailOverlay").classList.add("open");
  document.getElementById("detailPanel").classList.add("open");
  document.body.style.overflow = "hidden";

  switchDetailTab("notes");
}

function closeAppDetail() {
  document.getElementById("detailOverlay").classList.remove("open");
  document.getElementById("detailPanel").classList.remove("open");
  document.body.style.overflow = "";
  currentDetailAppId = null;
}

function switchDetailTab(tab) {
  currentDetailTab = tab;
  const tabs = ["notes","timeline","interviews"];
  document.querySelectorAll(".detail-tab").forEach((btn, i) =>
    btn.classList.toggle("active", tabs[i] === tab));
  document.querySelectorAll(".detail-tab-content").forEach(el => el.classList.remove("active"));
  if (tab === "notes")      { document.getElementById("detailTabNotes").classList.add("active");      loadNotes(currentDetailAppId); }
  if (tab === "timeline")   { document.getElementById("detailTabTimeline").classList.add("active");   loadTimeline(currentDetailAppId); }
  if (tab === "interviews") { document.getElementById("detailTabInterviews").classList.add("active"); loadInterviews(currentDetailAppId); }
}

async function detailStatusChange() {
  if (!currentDetailAppId) return;
  const sel = document.getElementById("detailStatusSelect");
  const newStatus = sel.value;
  sel.className = `detail-status-select status-badge status-${statusClass(newStatus)}`;
  try {
    await fetch(`${BACKEND_URL}/applications/${encodeURIComponent(userId)}/${currentDetailAppId}/status`, {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ status: newStatus }),
    });
    const app = allApplicationsList.find(a => a.id === currentDetailAppId);
    if (app) { app.status = newStatus; app.statusChangedAt = new Date().toISOString(); }
    renderPipelineBar();
    renderCurrentView();
    renderDashboardPipeline();
    if (currentDetailTab === "timeline") loadTimeline(currentDetailAppId);
  } catch {
    showToast("Error", "Could not update status.");
  }
}

// ── Notes ─────────────────────────────────────────────────────────────────────
async function loadNotes(appId) {
  const el = document.getElementById("notesList");
  if (!el || !appId) return;
  el.innerHTML = '<div style="font-size:0.8rem;color:var(--text-muted);padding:4px 0">Loading…</div>';
  try {
    const res  = await fetch(`${BACKEND_URL}/applications/${encodeURIComponent(userId)}/${appId}/notes`);
    const data = await res.json();
    if (!data.notes?.length) {
      el.innerHTML = '<div style="font-size:0.82rem;color:var(--text-muted);padding:4px 0">No notes yet.</div>';
      return;
    }
    el.innerHTML = data.notes.map(n => `<div class="note-item">
      ${escapeHtml(n.content)}
      <div class="note-item-meta">
        <span class="note-item-date">${n.createdAt?.seconds ? new Date(n.createdAt.seconds*1000).toLocaleString() : ""}</span>
        <button class="note-item-del" onclick="deleteNote('${appId}','${n.id}')">✕ Delete</button>
      </div>
    </div>`).join("");
  } catch {
    el.innerHTML = '<div style="font-size:0.82rem;color:var(--danger)">Failed to load notes.</div>';
  }
}

async function submitNote() {
  const input   = document.getElementById("noteInput");
  const content = input?.value.trim();
  if (!content || !currentDetailAppId) return;
  const btn = document.querySelector("#detailTabNotes .btn");
  if (btn) { btn.disabled = true; btn.textContent = "Saving…"; }
  try {
    await fetch(`${BACKEND_URL}/applications/${encodeURIComponent(userId)}/${currentDetailAppId}/notes`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ content }),
    });
    input.value = "";
    loadNotes(currentDetailAppId);
  } catch {
    showToast("Error", "Could not save note.");
  } finally {
    if (btn) { btn.disabled = false; btn.textContent = "Save"; }
  }
}

async function deleteNote(appId, noteId) {
  try {
    await fetch(`${BACKEND_URL}/applications/${encodeURIComponent(userId)}/${appId}/notes/${noteId}`, { method: "DELETE" });
    loadNotes(appId);
  } catch {
    showToast("Error", "Could not delete note.");
  }
}

// ── Timeline ──────────────────────────────────────────────────────────────────
async function loadTimeline(appId) {
  const el = document.getElementById("timelineList");
  if (!el || !appId) return;
  el.innerHTML = '<div style="font-size:0.8rem;color:var(--text-muted);padding:4px 0">Loading…</div>';
  try {
    const res  = await fetch(`${BACKEND_URL}/applications/${encodeURIComponent(userId)}/${appId}`);
    const data = await res.json();
    const events = data.timeline || [];
    if (!events.length) {
      el.innerHTML = '<div style="font-size:0.82rem;color:var(--text-muted);padding:4px 0">No events yet.</div>';
      return;
    }
    el.innerHTML = events.map(timelineItem).join("");
  } catch {
    el.innerHTML = '<div style="font-size:0.82rem;color:var(--danger)">Failed to load timeline.</div>';
  }
}

function timelineItem(e) {
  const dotClass = { status_change:"status", note_added:"note", created:"created", interview_scheduled:"interview" }[e.type] || "status";
  const icons    = { status_change:"↕", note_added:"📝", created:"✓", interview_scheduled:"📅" };
  let title = "";
  if (e.type === "status_change")       title = e.previousStatus ? `${e.previousStatus} → ${e.newStatus}` : `Status: ${e.newStatus}`;
  else if (e.type === "note_added")     title = "Note added";
  else if (e.type === "created")        title = `Application created (${e.newStatus})`;
  else if (e.type === "interview_scheduled") title = "Interview scheduled";
  else title = e.type.replace(/_/g," ");
  const date = e.createdAt?.seconds
    ? new Date(e.createdAt.seconds*1000).toLocaleString()
    : (e.createdAt ? new Date(e.createdAt).toLocaleString() : "");
  return `<div class="timeline-item">
    <div class="timeline-dot ${dotClass}">${icons[e.type] || "•"}</div>
    <div class="timeline-body">
      <div class="timeline-title">${escapeHtml(title)}</div>
      ${e.note ? `<div class="timeline-sub">${escapeHtml(e.note)}</div>` : ""}
      <div class="timeline-date">${escapeHtml(date)}</div>
    </div>
  </div>`;
}

// ── Interviews ────────────────────────────────────────────────────────────────
async function loadInterviews(appId) {
  const el = document.getElementById("interviewsList");
  if (!el || !appId) return;
  el.innerHTML = '<div style="font-size:0.8rem;color:var(--text-muted);padding:4px 0">Loading…</div>';
  try {
    const res  = await fetch(`${BACKEND_URL}/interviews/${encodeURIComponent(userId)}`);
    const data = await res.json();
    const list = (data.interviews || []).filter(i => i.applicationId === appId);
    if (!list.length) {
      el.innerHTML = '<div style="font-size:0.82rem;color:var(--text-muted);margin-bottom:8px">No interviews scheduled.</div>';
      return;
    }
    el.innerHTML = list.map(i => {
      const d = i.scheduledAt ? new Date(i.scheduledAt) : null;
      return `<div class="interview-card">
        <div class="interview-card-header">
          <span class="interview-card-title">${escapeHtml(i.type||"General")} · ${escapeHtml(i.format||"Video")}</span>
          <button class="interview-card-del" onclick="deleteInterview('${i.id}','${appId}')">✕</button>
        </div>
        <div class="interview-card-meta">${d ? d.toLocaleString() : "—"} · ${i.duration||60} min</div>
        ${i.notes ? `<div style="font-size:0.8rem;margin-top:6px;color:var(--text-muted)">${escapeHtml(i.notes)}</div>` : ""}
      </div>`;
    }).join("");
  } catch {
    el.innerHTML = '<div style="font-size:0.82rem;color:var(--danger)">Failed to load interviews.</div>';
  }
}

async function saveInterview() {
  if (!currentDetailAppId) return;
  const dt = document.getElementById("intDatetime")?.value;
  if (!dt) { showToast("Missing info", "Please pick a date and time."); return; }
  const app = allApplicationsList.find(a => a.id === currentDetailAppId);
  const btn = document.querySelector("#detailTabInterviews .btn-gold");
  if (btn) { btn.disabled = true; btn.textContent = "Saving…"; }
  try {
    await fetch(`${BACKEND_URL}/interviews/save`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        userId, applicationId: currentDetailAppId,
        company: app?.company || "", role: app?.role || "",
        type:     document.getElementById("intType")?.value    || "general",
        format:   document.getElementById("intFormat")?.value  || "video",
        scheduledAt: new Date(dt).toISOString(),
        duration: parseInt(document.getElementById("intDuration")?.value) || 60,
      }),
    });
    document.getElementById("intDatetime").value = "";
    loadInterviews(currentDetailAppId);
    if (currentDetailTab === "timeline") loadTimeline(currentDetailAppId);
    showToast("Interview added", `${document.getElementById("intType")?.value||"General"} interview scheduled.`);
  } catch {
    showToast("Error", "Could not save interview.");
  } finally {
    if (btn) { btn.disabled = false; btn.textContent = "Add Interview"; }
  }
}

async function deleteInterview(id, appId) {
  if (!confirm("Delete this interview?")) return;
  try {
    await fetch(`${BACKEND_URL}/interviews/${encodeURIComponent(userId)}/${id}`, { method: "DELETE" });
    loadInterviews(appId);
  } catch {
    showToast("Error", "Could not delete interview.");
  }
}

// ── Quick-add modal ───────────────────────────────────────────────────────────
function showQuickAdd() {
  ["qaCompany","qaRole","qaUrl"].forEach(id => document.getElementById(id).value = "");
  document.getElementById("qaStatus").value   = "Applied";
  document.getElementById("qaSource").value   = "manual";
  document.getElementById("qaPriority").value = "normal";
  document.getElementById("qaDate").value     = new Date().toISOString().split("T")[0];
  document.getElementById("qaDupeWarning").style.display = "none";
  document.getElementById("qaSubmitBtn").textContent = "Save Application";
  document.getElementById("qaSubmitBtn").onclick = submitQuickAdd;
  document.getElementById("quickAddModal").classList.add("open");
  setTimeout(() => document.getElementById("qaCompany").focus(), 80);
}

function hideQuickAdd() {
  document.getElementById("quickAddModal").classList.remove("open");
}

async function submitQuickAdd() {
  const company = document.getElementById("qaCompany").value.trim();
  const role    = document.getElementById("qaRole").value.trim();
  if (!company || !role) { showToast("Required fields", "Company and role are required."); return; }
  const btn = document.getElementById("qaSubmitBtn");
  btn.disabled = true; btn.textContent = "Saving…";
  try {
    const res  = await fetch(`${BACKEND_URL}/applications/save`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        userId, company, role,
        status:    document.getElementById("qaStatus").value,
        source:    document.getElementById("qaSource").value,
        url:       document.getElementById("qaUrl").value,
        appliedAt: document.getElementById("qaDate").value,
        priority:  document.getElementById("qaPriority").value,
      }),
    });
    const data = await res.json();
    if (data.duplicateWarning) {
      document.getElementById("qaDupeWarning").style.display = "block";
      btn.disabled = false; btn.textContent = "Save Anyway";
      btn.onclick = async () => { hideQuickAdd(); showToast("Already exists", `An application to ${escapeHtml(company)} already exists.`); btn.onclick = submitQuickAdd; };
      return;
    }
    hideQuickAdd();
    await loadApplications();
    showToast("Application added", `${company} — ${role}`);
  } catch {
    showToast("Error", "Could not save application. Please try again.");
  } finally {
    btn.disabled = false;
    if (btn.textContent === "Saving…") btn.textContent = "Save Application";
  }
}

// ── Delete application ────────────────────────────────────────────────────────
async function deleteApplication(id) {
  if (!confirm("Delete this application and all its notes and history?")) return;
  try {
    await fetch(`${BACKEND_URL}/applications/${encodeURIComponent(userId)}/${id}`, { method: "DELETE" });
    allApplicationsList = allApplicationsList.filter(a => a.id !== id);
    if (currentDetailAppId === id) closeAppDetail();
    renderPipelineBar();
    renderCurrentView();
    renderDashboardPipeline();
  } catch {
    showToast("Error", "Could not delete application.");
  }
}

// ── Search Now ────────────────────────────────────────────────────────────────
async function searchNow() {
  const btn = document.getElementById("searchNowBtn");
  btn.disabled = true;
  btn.textContent = "⏳ Searching…";
  const body = document.getElementById("digestBody");
  body.innerHTML = '<div class="panel-loading">Searching for jobs — this takes about 30 seconds…</div>';

  try {
    const res  = await fetch(`${BACKEND_URL}/search/now/${encodeURIComponent(userId)}`, { method: "POST" });
    const data = await res.json();
    if (!res.ok) throw new Error(data.error || "Search failed");
    await loadDigest();
  } catch (err) {
    body.innerHTML = `<div class="panel-loading">Search failed: ${escapeHtml(err.message)}</div>`;
  } finally {
    btn.disabled = false;
    btn.textContent = "🔍 Search Now";
  }
}

// ── Jobs Found ────────────────────────────────────────────────────────────────
async function loadJobs() {
  const body = document.getElementById("jobsBody");
  body.innerHTML = '<div class="panel-loading" style="padding:28px">Loading jobs…</div>';
  try {
    const [jobsRes, watchlistRes] = await Promise.all([
      fetch(`${BACKEND_URL}/jobs/${encodeURIComponent(userId)}`),
      fetch(`${BACKEND_URL}/watchlist-jobs/${encodeURIComponent(userId)}`),
    ]);
    const jobsData      = await jobsRes.json();
    const watchlistData = await watchlistRes.json();

    allJobsList      = jobsData.jobs      || [];
    allWatchlistJobs = watchlistData.jobs || [];

    renderJobsList();
  } catch {
    body.innerHTML = '<div class="panel-loading" style="padding:28px">Failed to load jobs.</div>';
  }
}

function renderJobsList(query = "") {
  const body = document.getElementById("jobsBody");
  const q = query.trim().toLowerCase();

  const filterJob = (j) => !q || [j.title, j.company, j.location, j.description, j.salary]
    .some(f => f && f.toLowerCase().includes(q));

  const jobs          = allJobsList.filter(filterJob);
  const watchlistJobs = allWatchlistJobs.filter(filterJob);

  if (jobs.length === 0 && watchlistJobs.length === 0) {
    const msg = q
      ? `<div class="digest-empty"><div class="empty-icon">🔍</div><h3>No results for "${escapeHtml(q)}"</h3><p>Try a different search term.</p></div>`
      : `<div class="digest-empty"><div class="empty-icon">💼</div>
          <h3>No jobs found yet</h3>
          <p>Set your preferences in Settings — your daily search will run automatically, or upgrade to Pro to search on demand.</p></div>`;
    body.innerHTML = msg;
    return;
  }

  let html = "";
  if (watchlistJobs.length > 0) {
    html += `<div style="padding:20px 28px 8px">
      <div class="prefs-section-label" style="margin:0 0 12px">Target Company Watchlist</div>
      <div class="jobs-grid">${watchlistJobs.map(j => jobCard(j, "watchlist")).join("")}</div>
    </div>`;
  }
  if (jobs.length > 0) {
    const sectionLabel = watchlistJobs.length > 0
      ? `<div style="padding:20px 28px 8px"><div class="prefs-section-label" style="margin:0 0 12px">Daily Search Results</div></div>`
      : "";
    html += sectionLabel + `<div class="jobs-grid" style="padding:0 28px 28px">${jobs.map(j => jobCard(j)).join("")}</div>`;
  }
  body.innerHTML = html;
}

function filterJobs() {
  const q = document.getElementById("jobsSearch")?.value || "";
  renderJobsList(q);
}

function fitScoreBadge(score) {
  if (score === null || score === undefined) return "";
  const n = Math.round(score);
  const cls = n >= 75 ? "fit-score-high" : n >= 50 ? "fit-score-mid" : "fit-score-low";
  return `<span class="fit-score ${cls}">${n}% fit</span>`;
}

function jobFoundLabel(createdAt) {
  const secs = createdAt?._seconds ?? createdAt?.seconds;
  if (!secs) return "";
  const d     = new Date(secs * 1000);
  const now   = new Date();
  const isToday = d.toDateString() === now.toDateString();
  const time  = d.toLocaleTimeString("en-US", { hour: "numeric", minute: "2-digit" });
  const label = isToday
    ? `Today, ${time}`
    : d.toLocaleDateString("en-US", { month: "short", day: "numeric" }) + `, ${time}`;
  return `<div style="font-size:11px;color:var(--text-muted,#888);margin-bottom:6px;letter-spacing:0.02em">Found ${label}</div>`;
}

function jobCard(j, source) {
  const safeId     = escapeAttr(j.id);
  const safeSource = source === "watchlist" ? "watchlist" : "";
  const watchBadge = source === "watchlist"
    ? `<span class="job-tag" style="background:rgba(212,175,55,0.15);color:var(--gold)">Target Company</span>`
    : "";
  return `
  <div class="job-card" onclick="openJobDetail('${safeId}', '${safeSource}')">
    ${jobFoundLabel(j.createdAt)}
    <div class="job-card-top">
      <div style="display:flex;align-items:flex-start;justify-content:space-between;gap:8px">
        <div>
          <div class="job-title">${escapeHtml(j.title || "Untitled Role")}</div>
          <div class="job-company">${escapeHtml(j.company || "")}</div>
        </div>
        ${fitScoreBadge(j.fitScore)}
      </div>
    </div>
    <div class="job-tags">
      ${watchBadge}
      ${j.location   ? `<span class="job-tag">📍 ${escapeHtml(j.location)}</span>`   : ""}
      ${j.salary     ? `<span class="job-tag">💰 ${escapeHtml(j.salary)}</span>`     : ""}
      ${j.experience ? `<span class="job-tag">📋 ${escapeHtml(j.experience)}</span>` : ""}
      ${j.posted     ? `<span class="job-tag">🕐 ${escapeHtml(j.posted)}</span>`     : ""}
    </div>
    <div class="job-desc">${escapeHtml(j.description || "")}</div>
    <div class="job-card-footer">View details →</div>
  </div>`;
}

async function openJobDetail(jobId, source) {
  showPanel("jobDetail");
  if (typeof OnboardingEngine !== 'undefined') OnboardingEngine.markJobViewed();
  const body = document.getElementById("jobDetailBody");
  body.innerHTML = '<div class="panel-loading">Loading…</div>';

  try {
    const endpoint = source === "watchlist"
      ? `${BACKEND_URL}/watchlist-jobs/${encodeURIComponent(userId)}/detail/${encodeURIComponent(jobId)}`
      : `${BACKEND_URL}/jobs/${encodeURIComponent(userId)}/detail/${encodeURIComponent(jobId)}`;
    const res = await fetch(endpoint);
    const j   = await res.json();
    if (!res.ok) throw new Error(j.error || "Not found");

    document.getElementById("jobDetailTitle").textContent   = j.title   || "Job Details";
    document.getElementById("jobDetailCompany").textContent = [j.company, j.location].filter(Boolean).join(" · ");

    const urlEl = document.getElementById("jobDetailUrl");
    if (j.url && j.url.startsWith("http")) {
      urlEl.href = j.url; urlEl.style.display = "";
    } else {
      urlEl.style.display = "none";
    }

    currentJob = j;

    const fields = [
      j.salary     && ["Salary",               j.salary],
      j.experience && ["Experience Required",   j.experience],
      j.posted     && ["Posted",                j.posted],
      j.location   && ["Location",              j.location],
    ].filter(Boolean);

    const googleQuery = encodeURIComponent(`${j.title || ""} ${j.company || ""} job posting`);

    const fitScore = typeof j.fitScore === "number" ? Math.round(j.fitScore) : null;
    const fitScoreClass = fitScore !== null
      ? (fitScore >= 75 ? "fit-score-high" : fitScore >= 50 ? "fit-score-mid" : "fit-score-low")
      : "";
    const matchReasons = Array.isArray(j.matchReasons) && j.matchReasons.length > 0
      ? j.matchReasons
      : null;

    body.innerHTML = `
      ${fields.length ? `<div class="jd-meta-grid">${fields.map(([l,v]) =>
        `<div class="jd-meta-card"><div class="jd-meta-label">${l}</div><div class="jd-meta-value">${escapeHtml(v)}</div></div>`
      ).join("")}</div>` : ""}

      ${fitScore !== null || matchReasons ? `
      <div class="jd-section">
        <div class="jd-section-label">Why This Match</div>
        ${fitScore !== null ? `
        <div class="jd-fit-score-row">
          <div class="jd-fit-score-bar-wrap">
            <div class="jd-fit-score-bar ${fitScoreClass}" style="width:${fitScore}%"></div>
          </div>
          <span class="fit-score ${fitScoreClass}" style="flex-shrink:0">${fitScore}% Fit Score</span>
        </div>` : ""}
        ${matchReasons ? `
        <ul class="match-reasons-list">
          ${matchReasons.map(r => `<li>${escapeHtml(r)}</li>`).join("")}
        </ul>` : ""}
      </div>` : ""}

      <div class="jd-section">
        <div class="jd-section-label">About the Role</div>
        <div class="jd-description">${formatMarkdown(j.description || "No description available.")}</div>
      </div>

      <div class="jd-section">
        <div class="jd-section-label">Job Posting Links</div>
        <div style="display:flex;flex-direction:column;gap:10px">
          ${j.directUrl && j.directUrl.startsWith("http") ? `
          <div>
            <a href="${escapeHtml(j.directUrl)}" target="_blank" rel="noopener" class="btn btn-gold" style="display:inline-flex">
              Apply Directly ↗
            </a>
            <div class="jd-url-preview">${escapeHtml(j.directUrl)}</div>
          </div>
          ${j.url && j.url.startsWith("http") ? `
          <div>
            <a href="${escapeHtml(j.url)}" target="_blank" rel="noopener" class="btn btn-ghost" style="display:inline-flex;font-size:0.82rem">
              Also on ${/indeed\.com/i.test(j.url) ? "Indeed" : /linkedin\.com/i.test(j.url) ? "LinkedIn" : "aggregator"} ↗
            </a>
          </div>` : ""}` : j.url && j.url.startsWith("http") ? `
          <div>
            <a href="${escapeHtml(j.url)}" target="_blank" rel="noopener" class="btn btn-gold" style="display:inline-flex">
              View Posting ↗
            </a>
            <div class="jd-url-preview">${escapeHtml(j.url)}</div>
          </div>` : `<div style="font-size:0.85rem;color:var(--text-muted)">No direct link was found for this posting.</div>`}
          <a href="https://www.google.com/search?q=${googleQuery}" target="_blank" rel="noopener" class="btn btn-ghost" style="display:inline-flex;width:fit-content">
            🔍 Search Google for this job
          </a>
        </div>
      </div>

      <div class="jd-section">
        <div class="jd-section-label">AI Tools</div>
        <div style="display:flex;gap:10px;flex-wrap:wrap">
          <button class="btn btn-gold"  onclick="generateJobDoc('resume')">📄 Tailor Resume</button>
          <button class="btn btn-gold"  onclick="generateJobDoc('cover-letter')">✉️ Cover Letter</button>
          <button class="btn btn-ghost" onclick="networkForRole()">🔗 Find Connections</button>
          ${(j.directUrl && j.directUrl.startsWith("http")) || (j.url && j.url.startsWith("http")) ? `<a href="${escapeHtml((j.directUrl && j.directUrl.startsWith("http")) ? j.directUrl : j.url)}" target="_blank" rel="noopener" class="btn btn-ghost">Apply ↗</a>` : ""}
          <button class="btn btn-ghost" onclick="generateJobDoc('interview')">🎯 Prep for Interview</button>
        </div>
      </div>

      ${renderAiSections(j)}`;
  } catch (err) {
    body.innerHTML = `<div class="panel-loading">Failed to load job: ${escapeHtml(err.message)}</div>`;
  }
}

function renderJobDocSection(type, label, savedText, savedAt) {
  const ts = savedAt?._seconds
    ? new Date(savedAt._seconds * 1000).toLocaleString("en-US", { month: "short", day: "numeric", hour: "2-digit", minute: "2-digit" })
    : null;
  const downloadBtn = (type === "resume" || type === "cover-letter")
    ? `<button class="btn btn-ghost" style="padding:5px 12px;font-size:0.8rem" onclick="downloadJobDocPDF('${type}')">📄 Download PDF</button>`
    : "";
  if (!savedText) return `<div class="jd-doc-section" id="jd-doc-${type}" style="display:none"></div>`;
  return `
    <div class="jd-doc-section" id="jd-doc-${type}">
      <div class="jd-doc-header">
        <span class="jd-section-label" style="margin:0">${label}</span>
        <div style="display:flex;gap:8px;align-items:center">
          ${ts ? `<span style="font-size:0.75rem;color:var(--text-muted)">Generated ${ts}</span>` : ""}
          ${downloadBtn}
          <button class="btn btn-ghost" style="padding:5px 12px;font-size:0.8rem" onclick="copyJobDoc('${type}')">Copy</button>
          <button class="btn btn-ghost" style="padding:5px 12px;font-size:0.8rem" onclick="generateJobDoc('${type}')">↻ Regenerate</button>
        </div>
      </div>
      <pre class="jd-doc-text" id="jd-doc-text-${type}">${escapePre(savedText)}</pre>
    </div>`;
}

async function generateJobDoc(type) {
  if (!currentJob?.id) return;

  // Disable all AI tool buttons while generating to prevent double-clicks
  const toolBtns = document.querySelectorAll('.jd-section .btn');
  toolBtns.forEach(b => { b.disabled = true; b._wasDisabled = b.disabled; });

  const section = document.getElementById(`jd-doc-${type}`);
  section.style.display = "";
  section.innerHTML = `<div class="panel-loading" style="padding:20px">Generating — this takes about 15 seconds…</div>`;
  // Move the section to the top immediately so the loading state is visible
  document.getElementById("jd-ai-sections")?.prepend(section);
  section.scrollIntoView({ behavior: "smooth", block: "start" });

  const endpointMap = { "resume": "tailored-resume", "cover-letter": "cover-letter", "interview": "interview-prep" };
  const labelMap    = { "resume": "Tailored Resume", "cover-letter": "Cover Letter", "interview": "Interview Prep" };

  try {
    const res  = await fetch(`${BACKEND_URL}/jobs/${currentJob.id}/${endpointMap[type]}`, {
      method:  "POST",
      headers: { "Content-Type": "application/json" },
      body:    JSON.stringify({ userId }),
    });
    const data = await res.json();
    if (!res.ok) throw new Error(data.error || "Generation failed");

    // Update currentJob so regenerate/download works without re-fetching
    if (type === "resume")       currentJob.tailoredResume = data.text;
    if (type === "cover-letter") currentJob.coverLetter    = data.text;
    if (type === "interview")    currentJob.interviewPrep  = data.text;

    // Auto-save resume and cover letter to Documents tab
    if (type === "resume" || type === "cover-letter") {
      const docType   = type === "resume" ? "resume" : "cover_letter";
      const dateStr   = new Date().toLocaleDateString("en-US", { month: "short", day: "numeric", year: "numeric" });
      const jobTitle  = currentJob.title   || "Untitled Role";
      const company   = currentJob.company || "";
      const docTitle  = company ? `${jobTitle} at ${company} — ${dateStr}` : `${jobTitle} — ${dateStr}`;
      fetch(`${BACKEND_URL}/documents/save`, {
        method:  "POST",
        headers: { "Content-Type": "application/json" },
        body:    JSON.stringify({ userId, type: docType, content: data.text, title: docTitle, company }),
      }).catch(() => {});
    }

    const downloadBtn = (type === "resume" || type === "cover-letter")
      ? `<button class="btn btn-ghost" style="padding:5px 12px;font-size:0.8rem" onclick="downloadJobDocPDF('${type}')">📄 Download PDF</button>`
      : "";
    section.innerHTML = `
      <div class="jd-doc-header">
        <span class="jd-section-label" style="margin:0">${labelMap[type]}</span>
        <div style="display:flex;gap:8px;align-items:center">
          ${downloadBtn}
          <button class="btn btn-ghost" style="padding:5px 12px;font-size:0.8rem" onclick="copyJobDoc('${type}')">Copy</button>
          <button class="btn btn-ghost" style="padding:5px 12px;font-size:0.8rem" onclick="generateJobDoc('${type}')">↻ Regenerate</button>
        </div>
      </div>
      <pre class="jd-doc-text" id="jd-doc-text-${type}">${escapePre(data.text)}</pre>`;
  } catch (err) {
    section.innerHTML = `<div style="padding:16px;color:var(--danger)">${escapeHtml(err.message)}</div>`;
  } finally {
    toolBtns.forEach(b => { b.disabled = false; });
  }
}

function renderAiSections(j) {
  const defs = [
    {
      at: j.tailoredResumeAt,
      html: renderJobDocSection("resume",       "Tailored Resume",  j.tailoredResume,  j.tailoredResumeAt),
      hasContent: !!j.tailoredResume,
    },
    {
      at: j.coverLetterAt,
      html: renderJobDocSection("cover-letter", "Cover Letter",     j.coverLetter,     j.coverLetterAt),
      hasContent: !!j.coverLetter,
    },
    {
      at: j.interviewPrepAt,
      html: renderJobDocSection("interview",    "Interview Prep",   j.interviewPrep,   j.interviewPrepAt),
      hasContent: !!j.interviewPrep,
    },
    {
      at: j.networkingAt,
      html: renderNetworkingSection(j.networkingContacts, j.networkingStrategy, j.networkingAt),
      hasContent: !!(j.networkingContacts?.length),
    },
  ];

  const withContent    = defs.filter(d => d.hasContent).sort((a, b) => (b.at?._seconds || 0) - (a.at?._seconds || 0));
  const withoutContent = defs.filter(d => !d.hasContent);

  return `<div id="jd-ai-sections">${[...withContent, ...withoutContent].map(d => d.html).join("")}</div>`;
}

function renderNetworkingSection(contacts, strategy, networkingAt) {
  if (!contacts || contacts.length === 0) {
    return `<div id="jd-networking-section" style="display:none"></div>`;
  }
  const ts = networkingAt?._seconds
    ? new Date(networkingAt._seconds * 1000).toLocaleString("en-US", { month: "short", day: "numeric", hour: "2-digit", minute: "2-digit" })
    : null;

  const typeLabels = { recruiter: "Recruiter", hiring_manager: "Hiring Manager", team_member: "Team Member", alumni: "Alumni", peer: "Peer" };
  const scoreClass = s => s >= 75 ? "fit-score-high" : s >= 50 ? "fit-score-mid" : "fit-score-low";

  const cards = contacts.map((c, i) => `
    <div class="nc-card">
      <div class="nc-card-header">
        <div>
          <div class="nc-name">${escapeHtml(c.name || "Unknown")}</div>
          <div class="nc-title">${escapeHtml(c.title || "")}${c.type ? ` · <span class="nc-type-badge">${typeLabels[c.type] || c.type}</span>` : ""}</div>
        </div>
        ${typeof c.score === "number" ? `<span class="fit-score ${scoreClass(c.score)}" style="flex-shrink:0">${c.score}</span>` : ""}
      </div>
      ${c.why ? `<div class="nc-why">${escapeHtml(c.why)}</div>` : ""}
      ${Array.isArray(c.sharedSignals) && c.sharedSignals.length ? `
      <div class="nc-signals">
        ${c.sharedSignals.map(s => `<span class="nc-signal-tag">${escapeHtml(s)}</span>`).join("")}
      </div>` : ""}
      ${c.messageDraft ? `
      <div class="nc-message-section">
        <div class="nc-message-label">Outreach Draft</div>
        <textarea class="nc-message-textarea" id="nc-msg-${i}" rows="5">${escapePre(c.messageDraft)}</textarea>
        <div style="display:flex;gap:8px;margin-top:8px;flex-wrap:wrap">
          <button class="btn btn-ghost" style="padding:5px 12px;font-size:0.8rem" onclick="copyNetworkMsg(${i})">Copy Message</button>
          ${c.name ? `<a href="https://www.linkedin.com/search/results/people/?keywords=${encodeURIComponent(c.name)}" target="_blank" rel="noopener" class="btn btn-ghost" style="padding:5px 12px;font-size:0.8rem">Find on LinkedIn ↗</a>` : ""}
        </div>
      </div>` : ""}
    </div>`).join("");

  return `
    <div class="jd-doc-section" id="jd-networking-section">
      <div class="jd-doc-header">
        <span class="jd-section-label" style="margin:0">Networking Copilot</span>
        <div style="display:flex;gap:8px;align-items:center">
          ${ts ? `<span style="font-size:0.75rem;color:var(--text-muted)">Generated ${ts}</span>` : ""}
          <button class="btn btn-ghost" style="padding:5px 12px;font-size:0.8rem" onclick="networkForRole()">↻ Refresh</button>
        </div>
      </div>
      <div style="padding:20px">
        ${strategy ? `<div class="nc-strategy">${escapeHtml(strategy)}</div>` : ""}
        <div class="nc-cards-list">${cards}</div>
      </div>
    </div>`;
}

async function networkForRole() {
  if (!currentJob?.id) return;
  const section = document.getElementById("jd-networking-section");
  if (section) {
    section.style.display = "";
    section.innerHTML = `
      <div class="jd-doc-header">
        <span class="jd-section-label" style="margin:0">Networking Copilot</span>
      </div>
      <div style="padding:28px;text-align:center">
        <div class="nc-loading-steps" id="nc-loading-steps">
          <div class="nc-step nc-step-active">Analyzing the role and company…</div>
          <div class="nc-step">Searching for recruiters and team members…</div>
          <div class="nc-step">Ranking strategic contacts…</div>
          <div class="nc-step">Drafting personalized messages…</div>
        </div>
      </div>`;

    let stepIdx = 0;
    const stepTimer = setInterval(() => {
      stepIdx++;
      const steps = document.querySelectorAll(".nc-step");
      steps.forEach((s, i) => {
        s.classList.toggle("nc-step-active", i === stepIdx);
        s.classList.toggle("nc-step-done", i < stepIdx);
      });
      if (stepIdx >= steps.length - 1) clearInterval(stepTimer);
    }, 5000);

    try {
      const res  = await fetch(`${BACKEND_URL}/jobs/${currentJob.id}/network`, {
        method:  "POST",
        headers: { "Content-Type": "application/json" },
        body:    JSON.stringify({ userId }),
      });
      clearInterval(stepTimer);
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || "Analysis failed");

      currentJob.networkingContacts = data.contacts || [];
      currentJob.networkingStrategy = data.strategy || "";
      const wrapper = document.createElement("div");
      wrapper.innerHTML = renderNetworkingSection(data.contacts, data.strategy, null);
      const newEl = wrapper.firstElementChild;
      section.replaceWith(newEl);
      document.getElementById("jd-ai-sections")?.prepend(newEl);
    } catch (err) {
      clearInterval(stepTimer);
      section.innerHTML = `<div style="padding:16px;color:var(--danger)">${escapeHtml(err.message)}</div>`;
    }
  }
}

function copyNetworkMsg(idx) {
  const el = document.getElementById(`nc-msg-${idx}`);
  if (!el) return;
  navigator.clipboard.writeText(el.value).then(() => showToast("CareerCopilot", "Message copied to clipboard."));
}

function copyJobDoc(type) {
  const el = document.getElementById(`jd-doc-text-${type}`);
  if (!el) return;
  navigator.clipboard.writeText(el.textContent).then(() => showToast("CareerCopilot", "Copied to clipboard."));
}

function downloadJobDocPDF(type) {
  const el = document.getElementById(`jd-doc-text-${type}`);
  if (!el) return;
  const text     = el.textContent;
  const filename = type === "resume" ? "tailored-resume.pdf" : "cover-letter.pdf";
  generatePDF(text, filename);
}

// ── Daily Openings ────────────────────────────────────────────────────────────
async function loadDigest() {
  const body = document.getElementById("digestBody");
  body.innerHTML = '<div class="panel-loading" style="padding:28px">Loading…</div>';
  try {
    const [jobsRes, digestRes] = await Promise.all([
      fetch(`${BACKEND_URL}/jobs/${encodeURIComponent(userId)}`),
      fetch(`${BACKEND_URL}/digest/${encodeURIComponent(userId)}`),
    ]);
    const jobsData   = await jobsRes.json();
    const digestData = await digestRes.json();

    const jobs    = jobsData.jobs    || [];
    const digests = digestData.digests || [];

    if (jobs.length === 0) {
      body.innerHTML = `<div class="digest-empty">
        <div class="empty-icon">📬</div>
        <h3>No jobs found yet</h3>
        <p>Save your preferences in Settings — your daily search runs automatically, or upgrade to Pro to search on demand.</p>
      </div>`;
      return;
    }

    let banner = "";
    if (digests.length > 0) {
      const last = digests[0];
      const lastDate = last.createdAt?._seconds
        ? new Date(last.createdAt._seconds * 1000).toLocaleString("en-US", { month:"short", day:"numeric", hour:"2-digit", minute:"2-digit" })
        : "recently";
      banner = `<div class="digest-banner">
        Last searched ${lastDate} · ${jobs.length} job${jobs.length === 1 ? "" : "s"} found total
      </div>`;
    }

    body.innerHTML = banner + `<div class="jobs-grid">${jobs.map(j => jobCard(j)).join("")}</div>`;
  } catch {
    body.innerHTML = '<div class="panel-loading" style="padding:28px">Failed to load. Please try again.</div>';
  }
}

// ── Documents ─────────────────────────────────────────────────────────────────
async function loadDocuments(type) {
  const body = document.getElementById("documentsBody");
  body.innerHTML = '<div class="panel-loading" style="padding:24px">Loading…</div>';
  const searchEl = document.getElementById("docsSearch");
  if (searchEl) searchEl.value = "";
  try {
    const res  = await fetch(`${BACKEND_URL}/documents/${encodeURIComponent(userId)}/${type}`);
    const data = await res.json();
    allDocumentsList = data.documents || [];
    renderDocumentsList(type);
  } catch {
    body.innerHTML = '<div class="panel-loading" style="padding:24px">Failed to load documents.</div>';
  }
}

function renderDocumentsList(type, query = "") {
  const body  = document.getElementById("documentsBody");
  const label = type === "resume" ? "resumes" : "cover letters";
  const q     = query.trim().toLowerCase();

  const docs = allDocumentsList.filter(d => {
    if (!q) return true;
    return [d.title, d.company, d.content]
      .some(f => f && f.toLowerCase().includes(q));
  });

  if (docs.length === 0) {
    const msg = q
      ? `<div class="digest-empty"><div class="empty-icon">🔍</div><h3>No results for "${escapeHtml(q)}"</h3><p>Try a different search term.</p></div>`
      : `<div class="digest-empty"><div class="empty-icon">📁</div>
          <h3>No ${label} yet</h3>
          <p>Documents generated by the agent will appear here.</p></div>`;
    body.innerHTML = msg;
    return;
  }

  body.innerHTML = `<div style="padding:0 28px 28px;display:flex;flex-direction:column;gap:16px">` +
    docs.map((d) => {
      const date = d.createdAt?._seconds ? new Date(d.createdAt._seconds * 1000).toLocaleDateString() : "";
      return `<div class="doc-card">
        <div class="doc-card-header">
          <div>
            <div class="doc-title">${escapeHtml(d.title || "Untitled")}</div>
            <div class="doc-meta">${date}${d.company ? ` · ${escapeHtml(d.company)}` : ""}</div>
          </div>
          <button class="action-btn danger" onclick="deleteDocument('${d.id}', '${currentDocType}')">Delete</button>
        </div>
        <div class="doc-content">${formatMarkdown(d.content || "")}</div>
      </div>`;
    }).join("") + "</div>";
}

function filterDocuments() {
  const q = document.getElementById("docsSearch")?.value || "";
  renderDocumentsList(currentDocType, q);
}

async function deleteDocument(id, type) {
  if (!confirm("Delete this document?")) return;
  await fetch(`${BACKEND_URL}/documents/${encodeURIComponent(userId)}/${id}`, { method: "DELETE" });
  loadDocuments(type);
}

// ── Panel loaders ─────────────────────────────────────────────────────────────
async function loadProfilePanel() {
  await Promise.all([loadKnowledge(), loadNotificationSettings()]);
}

async function loadAccountPanel() {
  await loadUserTier();
  document.getElementById("upgradeBtn")?.addEventListener("click", handleUpgradeClick);
  document.getElementById("manageSubBtn")?.addEventListener("click", openBillingPortal);
}

async function loadPreferencesPanel() {
  await Promise.all([loadPreferences(), loadTargetCompanies(), loadScheduleSettings(), loadCustomSites()]);
}

async function loadNotificationSettings() {
  try {
    const res  = await fetch(`${BACKEND_URL}/preferences/${encodeURIComponent(userId)}`);
    const data = await res.json();
    const p    = data.preferences || {};
    if (p.notifEmail) document.getElementById("settingNotifEmail").value = p.notifEmail;
    if (p.notifPhone) document.getElementById("settingNotifPhone").value = formatPhoneDisplay(p.notifPhone);
  } catch { /* non-fatal */ }
}

async function loadScheduleSettings() {
  try {
    const res  = await fetch(`${BACKEND_URL}/preferences/${encodeURIComponent(userId)}`);
    const data = await res.json();
    const p    = data.preferences || {};
    if (p.searchEnabled !== undefined) document.getElementById("settingSearchEnabled").checked = p.searchEnabled;
    if (p.timesPerDay)  document.getElementById("settingTimesPerDay").value = p.timesPerDay;
    if (p.startHour !== undefined) document.getElementById("settingStartHour").value = p.startHour;
    if (p.timezone)     document.getElementById("settingTimezone").value = p.timezone;
  } catch { /* non-fatal */ }
}

async function loadCustomSites() {
  try {
    const res  = await fetch(`${BACKEND_URL}/preferences/${encodeURIComponent(userId)}`);
    const data = await res.json();
    const sites = data.preferences?.customSites || "";
    // Stored as comma-separated; display one per line for the textarea
    document.getElementById("prefCustomSites").value = sites
      ? sites.split(",").map(s => s.trim()).filter(Boolean).join("\n")
      : "";
  } catch { /* non-fatal */ }
}

// Update these to match your Stripe prices exactly
const PLAN_PRICES = {
  monthly: { display: "$25 / month", period: "monthly" },
  annual:  { display: "$240 / year", period: "annual"  },
};

let selectedBillingPeriod = "monthly";

function selectBilling(period) {
  selectedBillingPeriod = period;
  document.getElementById("billingMonthly")?.classList.toggle("billing-opt-active", period === "monthly");
  document.getElementById("billingAnnual")?.classList.toggle("billing-opt-active", period === "annual");
  const priceEl = document.getElementById("planPrice");
  if (priceEl) priceEl.textContent = PLAN_PRICES[period]?.display ?? "";
}

async function handleUpgradeClick() {
  const btn = document.getElementById("upgradeBtn");
  if (btn) { btn.disabled = true; btn.textContent = "Redirecting…"; }
  try {
    const res  = await fetch(`${BACKEND_URL}/create-checkout-session`, {
      method:  "POST",
      headers: { "Content-Type": "application/json" },
      body:    JSON.stringify({ userId, userEmail: userId, billingPeriod: selectedBillingPeriod }),
    });
    const data = await res.json();
    if (data.url) {
      window.location.href = data.url;
    } else {
      showToast("CareerCopilot", data.error || "Could not start checkout. Try again.");
      if (btn) { btn.disabled = false; btn.textContent = "Upgrade to Pro →"; }
    }
  } catch {
    showToast("CareerCopilot", "Network error. Please try again.");
    if (btn) { btn.disabled = false; btn.textContent = "Upgrade to Pro →"; }
  }
}

async function openBillingPortal() {
  const btn = document.getElementById("manageSubBtn");
  if (btn) { btn.disabled = true; btn.textContent = "Opening…"; }
  try {
    const res  = await fetch(`${BACKEND_URL}/create-portal-session`, {
      method:  "POST",
      headers: { "Content-Type": "application/json" },
      body:    JSON.stringify({ userId }),
    });
    const data = await res.json();
    if (data.url) {
      window.location.href = data.url;
    } else {
      showToast("CareerCopilot", data.error || "Could not open billing portal.");
      if (btn) { btn.disabled = false; btn.textContent = "Manage Subscription"; }
    }
  } catch {
    showToast("CareerCopilot", "Network error. Please try again.");
    if (btn) { btn.disabled = false; btn.textContent = "Manage Subscription"; }
  }
}

async function loadUserTier() {
  try {
    const res  = await fetch(`${BACKEND_URL}/user/${encodeURIComponent(userId)}`);
    const data = await res.json();
    userTier   = data.tier || "free";
    userRole   = data.role || "customer";
    applyTierGates();
    // Show admin nav if user is an admin
    const isAdmin = userRole === "admin";
    document.getElementById("nav-admin-label")?.style.setProperty("display", isAdmin ? "" : "none");
    document.getElementById("nav-admin")?.style.setProperty("display",       isAdmin ? "" : "none");
    // Sidebar badge
    const badge = document.getElementById("tierBadge");
    if (badge) {
      badge.textContent = userTier === "pro" ? "PRO" : "FREE";
      badge.classList.toggle("pro", userTier === "pro");
    }
    // Subscription section
    document.getElementById("planBadgeFree").style.display = userTier === "free" ? "" : "none";
    document.getElementById("planBadgePro").style.display  = userTier === "pro"  ? "" : "none";
    document.getElementById("upgradeBtn").style.display    = userTier === "pro"  ? "none" : "";
    document.getElementById("upgradeNote").style.display   = userTier === "pro"  ? "" : "none";
    document.getElementById("billingToggle")?.style.setProperty("display", userTier === "pro" ? "none" : "");
    const manageBtn = document.getElementById("manageSubBtn");
    if (manageBtn) manageBtn.style.display = userTier === "pro" ? "" : "none";
    // Initialise price display to the currently selected billing period
    selectBilling(selectedBillingPeriod);
    document.getElementById("planCardFree").classList.toggle("plan-card-current", userTier === "free");
    document.getElementById("planCardPro").classList.toggle("plan-card-current",  userTier === "pro");
  } catch { /* non-fatal */ }
}

function applyTierGates() {
  const isPro = userTier === "pro";

  // Search Now button is pro-only (admins always get access)
  const searchBtn = document.getElementById("searchNowBtn");
  if (searchBtn) {
    const canSearch = isPro || userRole === "admin";
    searchBtn.style.display = canSearch ? "" : "none";
    if (!canSearch) {
      let proNote = document.getElementById("searchNowProNote");
      if (!proNote) {
        proNote = document.createElement("p");
        proNote.id        = "searchNowProNote";
        proNote.className = "pro-feature-tag";
        proNote.textContent = "Manual search is a Pro feature — your daily search runs automatically.";
        searchBtn.parentNode.insertBefore(proNote, searchBtn.nextSibling);
      }
    } else {
      document.getElementById("searchNowProNote")?.remove();
    }
  }

  // "Times per day" > 1 is pro-only
  const timesSelect = document.getElementById("settingTimesPerDay");
  Array.from(timesSelect.options).forEach(opt => {
    const val = parseInt(opt.value, 10);
    if (val > 1) {
      opt.disabled = !isPro;
      opt.text = val > 1 && !isPro ? opt.text.replace(" 🔒", "") + " 🔒" : opt.text.replace(" 🔒", "");
    }
  });
  if (!isPro && parseInt(timesSelect.value, 10) > 1) timesSelect.value = "1";

  // Custom job sites is pro-only
  const customSitesInput = document.getElementById("prefCustomSites");
  const customSitesGroup = customSitesInput?.closest(".input-group");
  if (customSitesGroup) {
    customSitesInput.disabled = !isPro;
    let proTag = customSitesGroup.querySelector(".pro-feature-tag");
    if (!isPro && !proTag) {
      proTag = document.createElement("span");
      proTag.className = "pro-feature-tag";
      proTag.textContent = "Pro only — upgrade to add custom sites";
      customSitesGroup.appendChild(proTag);
    } else if (isPro && proTag) {
      proTag.remove();
    }
  }
}

async function changePassword() {
  const msgEl   = document.getElementById("pwMsg");
  const current = document.getElementById("pwCurrent").value;
  const next    = document.getElementById("pwNew").value;
  const confirm = document.getElementById("pwConfirm").value;

  msgEl.style.color = "var(--danger)";
  if (!current || !next || !confirm) { msgEl.textContent = "Please fill in all fields."; return; }
  if (next.length < 6)               { msgEl.textContent = "New password must be at least 6 characters."; return; }
  if (next !== confirm)              { msgEl.textContent = "New passwords do not match."; return; }

  // Wait for Firebase Auth to restore the session (currentUser is null until it loads)
  const user = await new Promise(resolve => {
    const unsub = firebase.auth().onAuthStateChanged(u => { unsub(); resolve(u); });
  });
  if (!user) { msgEl.textContent = "Not signed in. Please refresh and try again."; return; }

  const isEmailUser = user.providerData.some(p => p.providerId === "password");
  if (!isEmailUser) {
    msgEl.textContent = "Password changes are not available for Google sign-in accounts.";
    return;
  }

  try {
    const credential = firebase.auth.EmailAuthProvider.credential(user.email, current);
    await user.reauthenticateWithCredential(credential);
    await user.updatePassword(next);
    document.getElementById("pwCurrent").value = "";
    document.getElementById("pwNew").value     = "";
    document.getElementById("pwConfirm").value = "";
    msgEl.style.color = "var(--success, #4caf50)";
    msgEl.textContent = "Password updated successfully.";
    setTimeout(() => { msgEl.textContent = ""; }, 4000);
  } catch (err) {
    const map = {
      "auth/wrong-password":       "Current password is incorrect.",
      "auth/too-many-requests":    "Too many attempts. Try again later.",
      "auth/requires-recent-login":"Session expired. Please sign out and back in, then try again.",
      "auth/weak-password":        "New password is too weak. Use at least 6 characters.",
    };
    msgEl.textContent = map[err.code] ?? `Update failed (${err.code}).`;
  }
}

// ── Preferences ───────────────────────────────────────────────────────────────
async function loadPreferences() {
  try {
    const res  = await fetch(`${BACKEND_URL}/preferences/${encodeURIComponent(userId)}`);
    const data = await res.json();
    if (data.jobTitle)        document.getElementById("prefJobTitle").value        = data.jobTitle;
    if (data.locationCity)    document.getElementById("prefLocationCity").value    = data.locationCity;
    if (data.locationRadius)  document.getElementById("prefLocationRadius").value  = data.locationRadius;
    if (data.jobType)         document.getElementById("prefJobType").value         = data.jobType;
    if (data.salaryMin)       document.getElementById("prefSalaryMin").value       = data.salaryMin;
    if (data.experienceLevel) document.getElementById("prefExpLevel").value        = data.experienceLevel;
    if (data.companySize)     document.getElementById("prefCompanySize").value     = data.companySize;
    if (data.industries)      document.getElementById("prefIndustries").value      = data.industries;
    if (data.postedWithin !== undefined) document.getElementById("prefPostedWithin").value = data.postedWithin;
    if (data.remoteOnly)      document.getElementById("prefRemoteOnly").checked    = data.remoteOnly;
  } catch { /* non-fatal */ }
}

async function savePreferences(e) {
  e.preventDefault();
  const status = document.getElementById("prefsStatus");
  const btn    = e.submitter;
  btn.disabled = true; btn.textContent = "Saving…";
  try {
    await fetch(`${BACKEND_URL}/preferences/save`, {
      method: "POST", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        userId,
        jobTitle:        document.getElementById("prefJobTitle").value,
        locationCity:    document.getElementById("prefLocationCity").value,
        locationRadius:  document.getElementById("prefLocationRadius").value,
        jobType:         document.getElementById("prefJobType").value,
        salaryMin:       document.getElementById("prefSalaryMin").value,
        experienceLevel: document.getElementById("prefExpLevel").value,
        companySize:     document.getElementById("prefCompanySize").value,
        industries:      document.getElementById("prefIndustries").value,
        postedWithin:    document.getElementById("prefPostedWithin").value,
        remoteOnly:      document.getElementById("prefRemoteOnly").checked,
      }),
    });
    status.textContent = "✓ Saved! The agent will use these for your next job search.";
  } catch {
    status.textContent = "Failed to save. Please try again.";
  } finally { btn.disabled = false; btn.textContent = "Save Job Criteria"; }
}

async function saveScheduleSettings() {
  const btn    = document.getElementById("saveScheduleBtn");
  const status = document.getElementById("scheduleStatus");
  btn.disabled = true; btn.textContent = "Saving…";
  try {
    await fetch(`${BACKEND_URL}/preferences/save`, {
      method: "POST", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        userId,
        searchEnabled:     document.getElementById("settingSearchEnabled").checked,
        searchTimesPerDay: parseInt(document.getElementById("settingTimesPerDay").value, 10),
        searchStartHour:   parseInt(document.getElementById("settingStartHour").value, 10),
        notifTimezone:     document.getElementById("settingTimezone").value,
      }),
    });
    const enabled = document.getElementById("settingSearchEnabled").checked;
    status.textContent = enabled
      ? "✓ Schedule saved. The agent will search automatically on your schedule."
      : "✓ Automated search disabled. You can still search manually from Daily Openings.";
  } catch {
    status.textContent = "Failed to save. Please try again.";
  } finally { btn.disabled = false; btn.textContent = "Save Schedule"; }
}

async function saveNotificationSettings() {
  const btn    = document.getElementById("saveNotifBtn");
  const status = document.getElementById("notifStatus");

  const rawPhone = document.getElementById("settingNotifPhone").value;
  const digits   = rawPhone.replace(/\D/g, "");
  if (rawPhone && digits.length !== 10) {
    document.getElementById("notifStatus").textContent = "Please enter a valid 10-digit phone number.";
    return;
  }

  btn.disabled = true; btn.textContent = "Saving…";
  try {
    await fetch(`${BACKEND_URL}/preferences/save`, {
      method: "POST", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        userId,
        notifEmail: document.getElementById("settingNotifEmail").value.trim(),
        notifPhone: cleanPhone(document.getElementById("settingNotifPhone").value),
      }),
    });
    status.textContent = "✓ Contact info saved.";
  } catch {
    status.textContent = "Failed to save. Please try again.";
  } finally { btn.disabled = false; btn.textContent = "Save Contact Info"; }
}

async function saveCustomSites() {
  const btn    = document.getElementById("saveCustomSitesBtn");
  const status = document.getElementById("customSitesStatus");
  btn.disabled = true; btn.textContent = "Saving…";
  try {
    const raw = document.getElementById("prefCustomSites").value;
    const customSites = raw.split(/[\n,]/).map(s => s.trim()).filter(Boolean).join(",");
    await fetch(`${BACKEND_URL}/preferences/save`, {
      method: "POST", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ userId, customSites }),
    });
    status.textContent = "✓ Pages saved.";
  } catch {
    status.textContent = "Failed to save. Please try again.";
  } finally { btn.disabled = false; btn.textContent = "Save Pages"; }
}

// ── Knowledge Base ────────────────────────────────────────────────────────────
async function loadKnowledge() {
  try {
    const res  = await fetch(`${BACKEND_URL}/knowledge/${encodeURIComponent(userId)}`);
    const data = await res.json();
    if (data.resume) {
      document.getElementById("kbResumeText").value = data.resume;
      showUploadDone("resume_on_file.txt", data.resume);
    }
    if (data.currentPosition)   document.getElementById("kbCurrentPos").value  = data.currentPosition;
    if (data.previousPositions) document.getElementById("kbPrevPos").value     = data.previousPositions;
    if (data.targetRole)        document.getElementById("kbTargetRole").value  = data.targetRole;
    if (data.skills)            document.getElementById("kbSkills").value      = data.skills;
    if (data.education)         document.getElementById("kbEducation").value   = data.education;
    if (data.additionalContext) document.getElementById("kbContext").value     = data.additionalContext;
  } catch { /* non-fatal */ }
}
async function saveKnowledge(e) {
  e.preventDefault();
  const status = document.getElementById("kbStatus");
  const btn    = e.submitter;
  btn.disabled = true; btn.textContent = "Saving…";
  try {
    await fetch(`${BACKEND_URL}/knowledge/save`, {
      method: "POST", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        userId,
        resume:            document.getElementById("kbResumeText").value,
        currentPosition:   document.getElementById("kbCurrentPos").value,
        previousPositions: document.getElementById("kbPrevPos").value,
        targetRole:        document.getElementById("kbTargetRole").value,
        skills:            document.getElementById("kbSkills").value,
        education:         document.getElementById("kbEducation").value,
        additionalContext: document.getElementById("kbContext").value,
      }),
    });
    status.textContent = "✓ Saved! Your resume and background will be used in every search.";
  } catch {
    status.textContent = "Failed to save. Please try again.";
  } finally { btn.disabled = false; btn.textContent = "Save Profile"; }
}

// ── Phone number formatting ───────────────────────────────────────────────────
function initPhoneFormatter() {
  const input = document.getElementById("settingNotifPhone");
  if (!input) return;
  input.addEventListener("input", () => {
    const digits = input.value.replace(/\D/g, "").slice(0, 10);
    if (digits.length === 0) { input.value = ""; return; }
    if (digits.length <= 3)  { input.value = `(${digits}`; return; }
    if (digits.length <= 6)  { input.value = `(${digits.slice(0,3)}) ${digits.slice(3)}`; return; }
    input.value = `(${digits.slice(0,3)}) ${digits.slice(3,6)}-${digits.slice(6)}`;
  });
  // Allow backspace to feel natural by stripping formatting before delete
  input.addEventListener("keydown", e => {
    if (e.key === "Backspace" && /\D$/.test(input.value)) {
      e.preventDefault();
      input.value = input.value.replace(/\D+$/, "").slice(0, -1);
      input.dispatchEvent(new Event("input"));
    }
  });
}

function formatPhoneDisplay(raw) {
  if (!raw) return "";
  const digits = String(raw).replace(/\D/g, "").slice(0, 10);
  if (digits.length === 10)
    return `(${digits.slice(0,3)}) ${digits.slice(3,6)}-${digits.slice(6)}`;
  return raw;
}

function cleanPhone(raw) {
  // Store as digits only; backend can format as needed
  return String(raw || "").replace(/\D/g, "").slice(0, 10);
}

// ── Resume file upload ────────────────────────────────────────────────────────
function initResumeUpload() {
  const zone      = document.getElementById("resumeUploadZone");
  const fileInput = document.getElementById("resumeFileInput");
  const removeBtn = document.getElementById("uploadRemove");

  fileInput.addEventListener("change", () => {
    if (fileInput.files[0]) handleResumeFile(fileInput.files[0]);
  });

  zone.addEventListener("dragover", (e) => { e.preventDefault(); zone.classList.add("drag-over"); });
  zone.addEventListener("dragleave", () => zone.classList.remove("drag-over"));
  zone.addEventListener("drop", (e) => {
    e.preventDefault();
    zone.classList.remove("drag-over");
    const file = e.dataTransfer.files[0];
    if (file) handleResumeFile(file);
  });

  removeBtn?.addEventListener("click", (e) => {
    e.preventDefault();
    e.stopPropagation();
    document.getElementById("kbResumeText").value = "";
    fileInput.value = "";
    showUploadIdle();
  });
}

function showUploadIdle() {
  document.getElementById("uploadIdle").style.display    = "";
  document.getElementById("uploadLoading").style.display = "none";
  document.getElementById("uploadDone").style.display    = "none";
}
function showUploadLoading() {
  document.getElementById("uploadIdle").style.display    = "none";
  document.getElementById("uploadLoading").style.display = "";
  document.getElementById("uploadDone").style.display    = "none";
}
function showUploadDone(filename, text) {
  document.getElementById("uploadIdle").style.display    = "none";
  document.getElementById("uploadLoading").style.display = "none";
  document.getElementById("uploadDone").style.display    = "";
  document.getElementById("uploadFileName").textContent  = filename;
  const words = text.trim().split(/\s+/).length;
  document.getElementById("uploadWordCount").textContent = `${words.toLocaleString()} words extracted`;
}

async function handleResumeFile(file) {
  const allowed = ["application/pdf",
    "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
    "text/plain"];
  const ext = file.name.split(".").pop().toLowerCase();
  if (!allowed.includes(file.type) && !["pdf","docx","txt"].includes(ext)) {
    alert("Please upload a PDF, DOCX, or TXT file.");
    return;
  }

  showUploadLoading();
  try {
    let text = "";
    if (file.type === "application/pdf" || ext === "pdf") {
      text = await extractPdfText(file);
    } else if (
      file.type === "application/vnd.openxmlformats-officedocument.wordprocessingml.document" ||
      ext === "docx"
    ) {
      text = await extractDocxText(file);
    } else {
      text = await file.text();
    }

    if (!text.trim()) throw new Error("No text could be extracted from this file.");
    document.getElementById("kbResumeText").value = text;

    showUploadDone(file.name, text);
    document.getElementById("uploadWordCount").textContent = "Reading with AI — filling in your details…";
    setKbStatus("⏳ Parsing your resume…", "muted");

    try {
      const res  = await fetch(`${BACKEND_URL}/knowledge/parse-resume`, {
        method:  "POST",
        headers: { "Content-Type": "application/json" },
        body:    JSON.stringify({ resumeText: text }),
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || "Parse failed");

      if (data.currentPosition)   document.getElementById("kbCurrentPos").value  = data.currentPosition;
      if (data.previousPositions) document.getElementById("kbPrevPos").value     = data.previousPositions;
      if (data.targetRole)        document.getElementById("kbTargetRole").value  = data.targetRole;
      if (data.skills)            document.getElementById("kbSkills").value      = data.skills;
      if (data.education)         document.getElementById("kbEducation").value   = data.education;
      if (data.additionalContext) document.getElementById("kbContext").value     = data.additionalContext;

      const words = text.trim().split(/\s+/).length;
      document.getElementById("uploadWordCount").textContent = `${words.toLocaleString()} words extracted`;
      setKbStatus("✓ Fields filled from your resume — review and save when ready.", "gold");
    } catch {
      const words = text.trim().split(/\s+/).length;
      document.getElementById("uploadWordCount").textContent = `${words.toLocaleString()} words extracted`;
      setKbStatus("Resume uploaded but auto-fill failed. Fill in fields manually and save.", "muted");
    }

  } catch (err) {
    showUploadIdle();
    alert("Could not read file: " + err.message);
  }
}

function setKbStatus(msg, style) {
  const el = document.getElementById("kbStatus");
  if (!el) return;
  el.textContent = msg;
  el.style.color = style === "gold" ? "var(--gold)" : "var(--text-muted)";
}

async function extractPdfText(file) {
  const arrayBuffer = await file.arrayBuffer();
  const pdf         = await pdfjsLib.getDocument({ data: arrayBuffer }).promise;
  const parts       = [];
  for (let i = 1; i <= pdf.numPages; i++) {
    const page    = await pdf.getPage(i);
    const content = await page.getTextContent();
    parts.push(content.items.map(item => item.str).join(" "));
  }
  return parts.join("\n");
}

async function extractDocxText(file) {
  const arrayBuffer = await file.arrayBuffer();
  const result      = await mammoth.extractRawText({ arrayBuffer });
  return result.value;
}


function generatePDF(text, filename) {
  const { jsPDF } = window.jspdf;
  const doc = new jsPDF({ orientation: "portrait", unit: "pt", format: "letter" });

  const margin   = 54;
  const pageW    = doc.internal.pageSize.getWidth();
  const pageH    = doc.internal.pageSize.getHeight();
  const contentW = pageW - margin * 2;
  const leading  = 14;
  let y          = margin;

  function addPage() { doc.addPage(); y = margin; }
  function checkPage(linesCount) { if (y + linesCount * leading > pageH - margin) addPage(); }

  // Strip markdown formatting, normalise line endings
  const clean = text
    .replace(/\*\*(.+?)\*\*/g, "$1")
    .replace(/\*(.+?)\*/g, "$1")
    .replace(/^#{1,4}\s+/gm, "")
    .replace(/`(.+?)`/g, "$1")
    .replace(/\r\n/g, "\n").replace(/\r/g, "\n");

  const lines = clean.split("\n");
  let isFirstContentLine = true;

  for (let i = 0; i < lines.length; i++) {
    const t = lines[i].trimEnd();

    if (t.trim() === "") {
      y += leading * 0.5;
      continue;
    }

    const trimmed = t.trim();

    // First non-blank line = candidate name (14pt bold, centred)
    if (isFirstContentLine) {
      isFirstContentLine = false;
      doc.setFont("helvetica", "bold");
      doc.setFontSize(14);
      const wrapped = doc.splitTextToSize(trimmed, contentW);
      checkPage(wrapped.length);
      doc.text(wrapped, pageW / 2, y, { align: "center" });
      y += wrapped.length * 18;
      continue;
    }

    // Second line: contact info (email | phone | location) — 9pt normal centred
    if (i <= 3 && trimmed.includes("|") && trimmed.includes("@")) {
      doc.setFont("helvetica", "normal");
      doc.setFontSize(9);
      const wrapped = doc.splitTextToSize(trimmed, contentW);
      checkPage(wrapped.length);
      doc.text(wrapped, pageW / 2, y, { align: "center" });
      y += wrapped.length * leading + 6;
      continue;
    }

    // Section header: all-caps, 3+ letters, no bullet
    const isHeader = !trimmed.startsWith("-") && !trimmed.startsWith("•") &&
                     trimmed === trimmed.toUpperCase() &&
                     trimmed.replace(/[^A-Z]/g, "").length >= 3;
    if (isHeader) {
      y += 8;
      doc.setFont("helvetica", "bold");
      doc.setFontSize(10.5);
      checkPage(1);
      doc.text(trimmed, margin, y);
      doc.setDrawColor(160);
      doc.setLineWidth(0.4);
      doc.line(margin, y + 2, pageW - margin, y + 2);
      y += leading + 6;
      continue;
    }

    // Job title line: contains | but no @
    if (trimmed.includes("|") && !trimmed.includes("@")) {
      doc.setFont("helvetica", "bold");
      doc.setFontSize(10);
      const wrapped = doc.splitTextToSize(trimmed, contentW);
      checkPage(wrapped.length);
      doc.text(wrapped, margin, y);
      y += wrapped.length * leading;
      continue;
    }

    // Bullet point
    if (/^[-•]/.test(trimmed)) {
      doc.setFont("helvetica", "normal");
      doc.setFontSize(10);
      const bullet = "•  " + trimmed.replace(/^[-•]\s*/, "");
      const wrapped = doc.splitTextToSize(bullet, contentW - 16);
      checkPage(wrapped.length);
      doc.text(wrapped, margin + 14, y);
      y += wrapped.length * leading;
      continue;
    }

    // Regular paragraph text
    doc.setFont("helvetica", "normal");
    doc.setFontSize(10);
    const wrapped = doc.splitTextToSize(trimmed, contentW);
    checkPage(wrapped.length);
    doc.text(wrapped, margin, y);
    y += wrapped.length * leading;
  }

  doc.save(filename || "document.pdf");
}

// ── Push Notifications ────────────────────────────────────────────────────────
async function initNotifications() {
  try {
    if (typeof firebase === "undefined" || !firebase.messaging) return;
    if (!("Notification" in window) || !("serviceWorker" in navigator)) return;
    if (firebaseConfig.vapidKey === "YOUR_VAPID_KEY_HERE") return;

    const messaging = firebase.messaging();
    const swReg = await navigator.serviceWorker.register("./firebase-messaging-sw.js");
    const permission = await Notification.requestPermission();
    if (permission !== "granted") return;

    const token = await messaging.getToken({ vapidKey: firebaseConfig.vapidKey, serviceWorkerRegistration: swReg });
    if (!token) return;

    await fetch(`${BACKEND_URL}/notifications/token`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ userId, token }),
    });

    messaging.onMessage(payload => {
      const title = payload.notification?.title || "CareerCopilot";
      const body  = payload.notification?.body  || "";
      showToast(title, body);
    });

  } catch (err) {
    console.log("Push notifications unavailable:", err.message);
  }
}

function showToast(title, body) {
  document.querySelector(".notif-toast")?.remove();

  const toast = document.createElement("div");
  toast.className = "notif-toast";
  toast.innerHTML = `
    <span class="notif-toast-icon">🔔</span>
    <div class="notif-toast-body">
      <div class="notif-toast-title">${escapeHtml(title)}</div>
      ${body ? `<div class="notif-toast-msg">${escapeHtml(body)}</div>` : ""}
    </div>
    <button class="notif-toast-close" aria-label="Dismiss">✕</button>`;

  document.body.appendChild(toast);

  const dismiss = () => {
    toast.classList.add("hiding");
    toast.addEventListener("animationend", () => toast.remove(), { once: true });
  };

  toast.querySelector(".notif-toast-close").addEventListener("click", dismiss);
  setTimeout(dismiss, 6000);
}

// ── Target Company Watchlist ──────────────────────────────────────────────────
async function loadTargetCompanies() {
  try {
    const res  = await fetch(`${BACKEND_URL}/target-companies/${encodeURIComponent(userId)}`);
    const data = await res.json();
    renderTargetCompanies(data.companies || []);
  } catch { /* non-fatal */ }
}

function renderTargetCompanies(companies) {
  const list = document.getElementById("targetCompaniesList");
  if (!list) return;
  list.innerHTML = "";
  if (companies.length === 0) {
    addTargetCompanyRow("");
    return;
  }
  companies.forEach(c => addTargetCompanyRow(c.name || ""));
}

function addTargetCompanyRow(name) {
  const list = document.getElementById("targetCompaniesList");
  if (!list) return;
  const row = document.createElement("div");
  row.className = "target-company-row";
  row.style.cssText = "display:flex;gap:10px;align-items:center";
  const inputStyle = "flex:1;min-width:0;padding:9px 12px;background:var(--input-bg,#111);border:1px solid var(--border);border-radius:8px;color:inherit;font-size:0.88rem;font-family:inherit";
  row.innerHTML = `
    <input type="text" class="tc-name" placeholder="Company name" value="${escapeAttr(name || "")}"
      style="${inputStyle}" />
    <button type="button" class="btn btn-ghost tc-remove"
      style="padding:8px 12px;flex-shrink:0;font-size:1.1rem;line-height:1">×</button>`;
  row.querySelector(".tc-remove").addEventListener("click", () => row.remove());
  list.appendChild(row);
}

async function saveWatchlistCompanies() {
  const btn    = document.getElementById("saveWatchlistBtn");
  const status = document.getElementById("watchlistStatus");
  btn.disabled = true; btn.textContent = "Saving…";
  try {
    const rows     = document.querySelectorAll(".target-company-row");
    const companies = Array.from(rows)
      .map(row => ({ name: row.querySelector(".tc-name").value.trim() }))
      .filter(c => c.name);

    const res = await fetch(`${BACKEND_URL}/target-companies/save`, {
      method: "POST", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ userId, companies }),
    });
    if (!res.ok) throw new Error("Save failed");
    status.textContent = "Saved! The agent will check these companies on your search schedule.";
  } catch {
    status.textContent = "Failed to save. Please try again.";
  } finally { btn.disabled = false; btn.textContent = "Save Watchlist"; }
}

// ── Admin Panel ───────────────────────────────────────────────────────────────
async function loadAdminPanel() {
  const body = document.getElementById("adminBody");
  body.innerHTML = '<div class="panel-loading" style="padding:28px">Loading admin stats…</div>';
  try {
    const res  = await fetch(`${BACKEND_URL}/admin/stats/${encodeURIComponent(userId)}`);
    const data = await res.json();
    if (!res.ok) throw new Error(data.error || "Failed to load");

    const fmt = (n) => `$${(n || 0).toFixed(4)}`;

    const mostActiveRows = (data.mostActiveUsers || []).map(u => `
      <tr>
        <td style="max-width:220px;overflow:hidden;text-overflow:ellipsis">${escapeHtml(u.userId)}</td>
        <td><span class="tier-badge${u.tier === "pro" ? " pro" : ""}">${u.tier.toUpperCase()}</span></td>
        <td>${u.count}</td>
        <td>${fmt(u.spending30d)}</td>
      </tr>`).join("") || `<tr><td colspan="4" class="empty-table">No activity recorded yet.</td></tr>`;

    const inactivePaidRows = (data.inactivePaidUsers || []).map(u => `
      <tr>
        <td style="max-width:300px;overflow:hidden;text-overflow:ellipsis">${escapeHtml(u.userId)}</td>
        <td><span class="tier-badge pro">PRO</span></td>
      </tr>`).join("") || `<tr><td colspan="2" class="empty-table">All paid users are active!</td></tr>`;

    const inactiveFreeRows = (data.inactiveFreeUsers || []).map(u => `
      <tr><td style="max-width:300px;overflow:hidden;text-overflow:ellipsis">${escapeHtml(u.userId)}</td></tr>`
    ).join("") || `<tr><td class="empty-table">All free users are active!</td></tr>`;

    body.innerHTML = `
      <div class="settings-section">
        <div class="settings-section-title">Platform Spending</div>
        <div class="stats-grid" style="max-width:640px">
          <div class="stat-card">
            <div class="stat-value" style="font-size:1.2rem">${fmt(data.spending?.["24h"])}</div>
            <div class="stat-label">Last 24 Hours</div>
          </div>
          <div class="stat-card">
            <div class="stat-value" style="font-size:1.2rem">${fmt(data.spending?.week)}</div>
            <div class="stat-label">Last 7 Days</div>
          </div>
          <div class="stat-card">
            <div class="stat-value" style="font-size:1.2rem">${fmt(data.spending?.month)}</div>
            <div class="stat-label">Last 30 Days</div>
          </div>
        </div>
      </div>

      <div class="settings-section">
        <div class="settings-section-title">User Overview</div>
        <div class="stats-grid" style="max-width:640px">
          <div class="stat-card">
            <div class="stat-value">${data.totalUsers || 0}</div>
            <div class="stat-label">Total Users</div>
          </div>
          <div class="stat-card">
            <div class="stat-value">${data.proTierCount || 0}</div>
            <div class="stat-label">Pro Users</div>
          </div>
          <div class="stat-card">
            <div class="stat-value">${data.freeTierCount || 0}</div>
            <div class="stat-label">Free Users</div>
          </div>
          <div class="stat-card">
            <div class="stat-value">${data.activeUsersWeek || 0}</div>
            <div class="stat-label">Active This Week</div>
          </div>
        </div>
      </div>

      <div class="settings-section">
        <div class="settings-section-title">Most Active Users (30 days)</div>
        <div style="overflow-x:auto">
          <table class="app-table">
            <thead><tr><th>User</th><th>Tier</th><th>Runs</th><th>Spending (30d)</th></tr></thead>
            <tbody>${mostActiveRows}</tbody>
          </table>
        </div>
      </div>

      <div class="settings-section">
        <div class="settings-section-title">Inactive Pro Users (7+ days no activity)</div>
        <div style="overflow-x:auto">
          <table class="app-table">
            <thead><tr><th>User</th><th>Tier</th></tr></thead>
            <tbody>${inactivePaidRows}</tbody>
          </table>
        </div>
      </div>

      <div class="settings-section">
        <div class="settings-section-title">Inactive Free Users (7+ days no activity)</div>
        <div style="overflow-x:auto">
          <table class="app-table">
            <thead><tr><th>User</th></tr></thead>
            <tbody>${inactiveFreeRows}</tbody>
          </table>
        </div>
      </div>`;
  } catch (err) {
    body.innerHTML = `<div class="panel-loading" style="padding:28px">Failed to load admin stats: ${escapeHtml(err.message)}</div>`;
  }
}

// ── Helpers ───────────────────────────────────────────────────────────────────
function signOut() { sessionStorage.clear(); window.location.href = "index.html"; }

async function deleteAccount() {
  const confirmed = confirm(
    "Delete your account?\n\n" +
    "This will permanently erase ALL your data — resumes, jobs found, search history, " +
    "preferences, and everything else.\n\n" +
    "This cannot be undone."
  );
  if (!confirmed) return;

  const user = firebase.auth().currentUser;
  if (!user) { signOut(); return; }

  try {
    // Firebase deletes the Auth account; this triggers the onUserDeleted
    // Cloud Function which wipes every Firestore collection automatically.
    await user.delete();
    sessionStorage.clear();
    window.location.href = "index.html";
  } catch (err) {
    if (err.code === "auth/requires-recent-login") {
      showToast(
        "Sign in again first",
        "For security, please sign out and sign back in before deleting your account."
      );
    } else {
      showToast("Error", err.message || "Could not delete account. Please try again.");
    }
  }
}

function escapeHtml(str) {
  return String(str)
    .replace(/&/g,"&amp;").replace(/</g,"&lt;").replace(/>/g,"&gt;")
    .replace(/"/g,"&quot;").replace(/\n/g,"<br>");
}
// Use for <pre> elements — preserves real newlines so textContent stays intact
function escapePre(str) {
  return String(str)
    .replace(/&/g,"&amp;").replace(/</g,"&lt;").replace(/>/g,"&gt;");
}
function escapeAttr(str) {
  return String(str).replace(/'/g,"\\'").replace(/"/g,"&quot;");
}
function formatMarkdown(str) {
  return String(str)
    .replace(/&/g,"&amp;").replace(/</g,"&lt;").replace(/>/g,"&gt;")
    .replace(/\*\*(.+?)\*\*/g,"<strong>$1</strong>")
    .replace(/`(.+?)`/g,"<code>$1</code>")
    .replace(/^### (.+)$/gm,"<strong>$1</strong>")
    .replace(/^## (.+)$/gm,"<strong>$1</strong>")
    .replace(/^- (.+)$/gm,"• $1")
    .replace(/\n/g,"<br>");
}

init();
