const BACKEND_URL =
  window.location.hostname === "localhost" || window.location.hostname === "127.0.0.1"
    ? "http://127.0.0.1:5001/adib-job-agent/us-central1/api"
    : "https://us-central1-adib-job-agent.cloudfunctions.net/api";

// ── Auth guard ────────────────────────────────────────────────────────────────
const email = sessionStorage.getItem("fbEmail");
const token = sessionStorage.getItem("fbToken");
if (!email || !token) window.location.href = "index.html";
const userId = email;

// ── Panel registry ────────────────────────────────────────────────────────────
const PANELS = {
  dashboard: document.getElementById("dashboardView"),
  chat:      document.getElementById("chatView"),
  jobs:      document.getElementById("jobsView"),
  jobDetail: document.getElementById("jobDetailView"),
  documents: document.getElementById("documentsView"),
  digest:    document.getElementById("digestView"),
  settings:  document.getElementById("settingsView"),
};

// ── Interview Prep chat config ────────────────────────────────────────────────
const INTERVIEW_VIEW = {
  title:    "Interview Prep",
  subtitle: "Practice questions, company research, and offer negotiation",
  chips:    [
    "Give me common interview questions for my role",
    "Help me answer 'tell me about yourself'",
    "How do I negotiate salary?",
    "What questions should I ask the interviewer?",
  ],
  prompt: "You are an expert interview coach. Help the user prepare for job interviews with practice questions, STAR-method answer frameworks, salary negotiation tactics, and company research. Be encouraging and specific.",
};

let isLoading              = false;
let conversationHistory    = [];
let currentDocType         = "resume";
let currentJob             = null;
let pendingResumeDownload  = false;
let latestResumeText       = "";
let userTier               = "free";  // loaded on init, used for feature gating

// ── Init ──────────────────────────────────────────────────────────────────────
function init() {
  document.getElementById("userEmail").textContent  = email;
  document.getElementById("userAvatar").textContent = email.charAt(0).toUpperCase();

  // Sidebar navigation
  document.getElementById("nav-dashboard").addEventListener("click", () => showPanel("dashboard"));
  document.getElementById("nav-jobs").addEventListener("click",      () => showPanel("jobs"));
  document.getElementById("nav-documents").addEventListener("click", () => showPanel("documents"));
  document.getElementById("nav-digest").addEventListener("click",    () => showPanel("digest"));
  document.getElementById("nav-settings").addEventListener("click",  () => showPanel("settings"));
  document.getElementById("newChatBtn").addEventListener("click",    () => showPanel("chat"));
  document.getElementById("signOutBtn").addEventListener("click",    signOut);

  // Interview Prep nav
  document.querySelector("[data-view='interview']").addEventListener("click", () => showPanel("chat"));

  // Chat
  document.getElementById("sendBtn").addEventListener("click", sendMessage);
  document.getElementById("messageInput").addEventListener("keydown", (e) => {
    if (e.key === "Enter" && !e.shiftKey) { e.preventDefault(); sendMessage(); }
  });
  document.getElementById("messageInput").addEventListener("input", autoResize);

  // Applications
  document.getElementById("addAppBtn").addEventListener("click",    showAppForm);
  document.getElementById("saveAppBtn").addEventListener("click",   saveApplication);
  document.getElementById("cancelAppBtn").addEventListener("click", hideAppForm);

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

  // Settings new sections
  document.getElementById("saveScheduleBtn").addEventListener("click", saveScheduleSettings);
  document.getElementById("saveNotifBtn").addEventListener("click",    saveNotificationSettings);

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
  document.querySelectorAll(".nav-item, [data-view], #newChatBtn, #signOutBtn").forEach(btn =>
    btn.addEventListener("click", () => appLayout.classList.remove("nav-open"))
  );

  // Search Now button
  document.getElementById("searchNowBtn").addEventListener("click", searchNow);

  // Job detail back button
  document.getElementById("backToJobsBtn").addEventListener("click", () => showPanel("jobs"));

  // Resume file upload
  initResumeUpload();

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
  renderChips(INTERVIEW_VIEW.chips);
  loadHistory();
  loadUserTier();  // fetch tier early so gates are ready before Settings opens
}

// ── Panel switching ───────────────────────────────────────────────────────────
function showPanel(name) {
  Object.values(PANELS).forEach(p => { p.style.display = "none"; });
  PANELS[name].style.display = "flex";

  document.querySelectorAll(".nav-item").forEach(b => b.classList.remove("active"));
  const navIds = {
    dashboard: "nav-dashboard",
    jobs:      "nav-jobs",
    documents: "nav-documents",
    digest:    "nav-digest",
    settings:  "nav-settings",
  };
  if (navIds[name]) document.getElementById(navIds[name])?.classList.add("active");
  if (name === "chat") document.querySelector("[data-view='interview']")?.classList.add("active");

  if (name === "dashboard")  { loadStats(); loadRecentJobs(); loadApplications(); }
  if (name === "jobs")       loadJobs();
  if (name === "documents")  loadDocuments(currentDocType);
  if (name === "digest")     loadDigest();
  if (name === "settings")   loadSettings();
}

// ── Chat ──────────────────────────────────────────────────────────────────────
function renderChips(chips) {
  const el = document.getElementById("chips");
  if (!el) return;
  el.innerHTML = "";
  chips.forEach((text) => {
    const chip = document.createElement("button");
    chip.className   = "chip";
    chip.textContent = text;
    chip.addEventListener("click", () => {
      document.getElementById("messageInput").value = text;
      sendMessage();
    });
    el.appendChild(chip);
  });
}

function removeEmptyState() {
  document.getElementById("emptyState")?.remove();
}

function appendMessage(role, text) {
  removeEmptyState();
  const chatArea = document.getElementById("chatArea");

  const wrapper = document.createElement("div");
  wrapper.className = `message ${role}`;

  const avatar       = document.createElement("div");
  avatar.className   = "msg-avatar";
  avatar.textContent = role === "user" ? email.charAt(0).toUpperCase() : "✦";

  const bubble      = document.createElement("div");
  bubble.className  = "msg-bubble";
  bubble.innerHTML  = role === "assistant" ? formatMarkdown(text) : escapeHtml(text);

  wrapper.appendChild(avatar);
  wrapper.appendChild(bubble);
  chatArea.appendChild(wrapper);
  chatArea.scrollTop = chatArea.scrollHeight;
}

function appendTypingIndicator() {
  removeEmptyState();
  const chatArea = document.getElementById("chatArea");
  const wrapper  = document.createElement("div");
  wrapper.className = "message assistant typing-indicator";
  wrapper.id        = "typingIndicator";
  const avatar = document.createElement("div");
  avatar.className = "msg-avatar"; avatar.textContent = "✦";
  const bubble = document.createElement("div");
  bubble.className = "msg-bubble";
  bubble.innerHTML = '<div class="typing-dot"></div><div class="typing-dot"></div><div class="typing-dot"></div>';
  wrapper.appendChild(avatar);
  wrapper.appendChild(bubble);
  chatArea.appendChild(wrapper);
  chatArea.scrollTop = chatArea.scrollHeight;
}

async function sendMessage() {
  const input = document.getElementById("messageInput");
  const text  = input.value.trim();
  if (!text || isLoading) return;

  isLoading = true;
  document.getElementById("sendBtn").disabled = true;
  input.value = "";
  input.style.height = "auto";

  appendMessage("user", text);
  conversationHistory.push({ role: "user", content: text });
  appendTypingIndicator();

  try {
    const res = await fetch(`${BACKEND_URL}/chat`, {
      method:  "POST",
      headers: { "Content-Type": "application/json" },
      body:    JSON.stringify({
        message:      text,
        systemPrompt: INTERVIEW_VIEW.prompt,
        history:      conversationHistory.slice(-10),
        userId,
        view:         "interview",
      }),
    });
    const data = await res.json();
    document.getElementById("typingIndicator")?.remove();
    if (!res.ok) throw new Error(data.error || "Request failed");

    appendMessage("assistant", data.reply);
    conversationHistory.push({ role: "assistant", content: data.reply });

    if (pendingResumeDownload) {
      pendingResumeDownload = false;
      latestResumeText = data.reply;
      appendResumeDownloadButton();
    }

    fetch(`${BACKEND_URL}/history/save`, {
      method:  "POST",
      headers: { "Content-Type": "application/json" },
      body:    JSON.stringify({ userId, view: "interview", userMessage: text, assistantReply: data.reply }),
    }).catch(() => {});
  } catch (err) {
    document.getElementById("typingIndicator")?.remove();
    appendMessage("assistant", "Sorry, something went wrong. Please try again.");
    console.error(err);
  } finally {
    isLoading = false;
    document.getElementById("sendBtn").disabled = false;
    input.focus();
  }
}

function autoResize() {
  const el = document.getElementById("messageInput");
  el.style.height = "auto";
  el.style.height = Math.min(el.scrollHeight, 160) + "px";
}

async function loadHistory() {
  try {
    const res  = await fetch(`${BACKEND_URL}/history/${encodeURIComponent(userId)}/interview`);
    const data = await res.json();
    if (!data.messages || data.messages.length === 0) return;
    conversationHistory = data.messages;
    data.messages.forEach((m) => appendMessage(m.role, m.content));
  } catch { /* non-fatal */ }
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
    document.getElementById("stat-runs").textContent   = data.runs          ?? 0;
    document.getElementById("stat-tokens").textContent = (data.totalTokens  ?? 0).toLocaleString();
    document.getElementById("stat-cost").textContent   = data.costFormatted ?? "$0.0000";
    document.getElementById("stat-items").textContent  = data.runs          ?? 0;
  } catch (err) {
    console.error("Stats error:", err);
  }
}

// ── Applications ──────────────────────────────────────────────────────────────
async function loadApplications() {
  const el = document.getElementById("applicationsTable");
  try {
    const res  = await fetch(`${BACKEND_URL}/applications/${encodeURIComponent(userId)}`);
    const data = await res.json();

    if (!data.applications || data.applications.length === 0) {
      el.innerHTML = `<div class="empty-table">No applications yet. Click "+ Add Application" to start tracking.</div>`;
      return;
    }

    el.innerHTML = `
      <table class="app-table">
        <thead><tr>
          <th>Company</th><th>Role</th><th>Status</th><th>Applied</th><th>Actions</th>
        </tr></thead>
        <tbody>
          ${data.applications.map((a) => `
            <tr>
              <td><strong>${escapeHtml(a.company)}</strong>${a.url ? ` <a href="${escapeHtml(a.url)}" target="_blank" class="table-link">↗</a>` : ""}</td>
              <td>${escapeHtml(a.role)}</td>
              <td><span class="status-badge status-${a.status.toLowerCase().replace(" ","-")}">${escapeHtml(a.status)}</span></td>
              <td>${a.appliedAt ? new Date(a.appliedAt).toLocaleDateString() : "—"}</td>
              <td class="table-actions">
                <button class="action-btn" onclick="editApplication('${a.id}','${escapeHtml(a.company)}','${escapeHtml(a.role)}','${escapeHtml(a.status)}','${escapeHtml(a.url||"")}','${escapeHtml(a.notes||"")}','${escapeHtml(a.appliedAt||"")}')">Edit</button>
                <button class="action-btn danger" onclick="deleteApplication('${a.id}')">Delete</button>
              </td>
            </tr>`).join("")}
        </tbody>
      </table>`;
  } catch {
    el.innerHTML = '<div class="panel-loading">Failed to load applications.</div>';
  }
}

function showAppForm() {
  document.getElementById("appForm").style.display = "block";
  document.getElementById("appDate").value = new Date().toISOString().split("T")[0];
  document.getElementById("appEditId").value = "";
}
function hideAppForm() {
  document.getElementById("appForm").style.display = "none";
  ["appCompany","appRole","appUrl","appNotes","appEditId"].forEach(id => document.getElementById(id).value = "");
  document.getElementById("appStatus").value = "Applied";
}
function editApplication(id, company, role, status, url, notes, appliedAt) {
  document.getElementById("appForm").style.display = "block";
  document.getElementById("appCompany").value = company;
  document.getElementById("appRole").value    = role;
  document.getElementById("appStatus").value  = status;
  document.getElementById("appUrl").value     = url;
  document.getElementById("appNotes").value   = notes;
  document.getElementById("appDate").value    = appliedAt ? appliedAt.split("T")[0] : "";
  document.getElementById("appEditId").value  = id;
  document.getElementById("appForm").scrollIntoView({ behavior: "smooth" });
}
async function saveApplication() {
  const company = document.getElementById("appCompany").value.trim();
  const role    = document.getElementById("appRole").value.trim();
  if (!company || !role) { alert("Company and role are required."); return; }
  const btn = document.getElementById("saveAppBtn");
  btn.disabled = true; btn.textContent = "Saving…";
  await fetch(`${BACKEND_URL}/applications/save`, {
    method: "POST", headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      userId,
      id:        document.getElementById("appEditId").value || undefined,
      company, role,
      status:    document.getElementById("appStatus").value,
      url:       document.getElementById("appUrl").value,
      notes:     document.getElementById("appNotes").value,
      appliedAt: document.getElementById("appDate").value,
    }),
  });
  btn.disabled = false; btn.textContent = "Save";
  hideAppForm();
  loadApplications();
}
async function deleteApplication(id) {
  if (!confirm("Delete this application?")) return;
  await fetch(`${BACKEND_URL}/applications/${id}`, { method: "DELETE" });
  loadApplications();
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
    const jobsData     = await jobsRes.json();
    const watchlistData = await watchlistRes.json();

    const jobs          = jobsData.jobs      || [];
    const watchlistJobs = watchlistData.jobs || [];

    if (jobs.length === 0 && watchlistJobs.length === 0) {
      body.innerHTML = `<div class="digest-empty"><div class="empty-icon">💼</div>
        <h3>No jobs found yet</h3>
        <p>Set your preferences in Settings — your daily search will run automatically, or upgrade to Pro to search on demand.</p></div>`;
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
  } catch {
    body.innerHTML = '<div class="panel-loading" style="padding:28px">Failed to load jobs.</div>';
  }
}

function fitScoreBadge(score) {
  if (score === null || score === undefined) return "";
  const n = Math.round(score);
  const cls = n >= 75 ? "fit-score-high" : n >= 50 ? "fit-score-mid" : "fit-score-low";
  return `<span class="fit-score ${cls}">${n}% fit</span>`;
}

function jobCard(j, source) {
  const safeId     = escapeAttr(j.id);
  const safeSource = source === "watchlist" ? "watchlist" : "";
  const watchBadge = source === "watchlist"
    ? `<span class="job-tag" style="background:rgba(212,175,55,0.15);color:var(--gold)">Target Company</span>`
    : "";
  return `
  <div class="job-card" onclick="openJobDetail('${safeId}', '${safeSource}')">
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
  const body = document.getElementById("jobDetailBody");
  body.innerHTML = '<div class="panel-loading">Loading…</div>';

  try {
    const endpoint = source === "watchlist"
      ? `${BACKEND_URL}/watchlist-jobs/detail/${encodeURIComponent(jobId)}`
      : `${BACKEND_URL}/jobs/detail/${encodeURIComponent(jobId)}`;
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
          ${j.url && j.url.startsWith("http") ? `
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
          ${j.url && j.url.startsWith("http") ? `<a href="${escapeHtml(j.url)}" target="_blank" rel="noopener" class="btn btn-ghost">Apply ↗</a>` : ""}
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
  const section = document.getElementById(`jd-doc-${type}`);
  section.style.display = "";
  section.innerHTML = `<div class="panel-loading" style="padding:20px">Generating — this takes about 15 seconds…</div>`;

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
    document.getElementById("jd-ai-sections")?.prepend(section);
  } catch (err) {
    section.innerHTML = `<div style="padding:16px;color:var(--danger)">${escapeHtml(err.message)}</div>`;
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
          ${c.linkedinSearch ? `<a href="https://www.linkedin.com/search/results/people/?keywords=${encodeURIComponent(c.linkedinSearch)}" target="_blank" rel="noopener" class="btn btn-ghost" style="padding:5px 12px;font-size:0.8rem">Find on LinkedIn ↗</a>` : ""}
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
  try {
    const res  = await fetch(`${BACKEND_URL}/documents/${encodeURIComponent(userId)}/${type}`);
    const data = await res.json();
    const label = type === "resume" ? "resumes" : "cover letters";
    if (!data.documents || data.documents.length === 0) {
      body.innerHTML = `<div class="digest-empty"><div class="empty-icon">📁</div>
        <h3>No ${label} yet</h3>
        <p>Documents generated by the agent will appear here.</p></div>`;
      return;
    }
    body.innerHTML = `<div style="padding:0 28px 28px;display:flex;flex-direction:column;gap:16px">` +
      data.documents.map((d) => {
        const date = d.createdAt?._seconds ? new Date(d.createdAt._seconds * 1000).toLocaleDateString() : "";
        return `<div class="doc-card">
          <div class="doc-card-header">
            <div>
              <div class="doc-title">${escapeHtml(d.title || "Untitled")}</div>
              <div class="doc-meta">${date}${d.company ? ` · ${escapeHtml(d.company)}` : ""}</div>
            </div>
            <button class="action-btn danger" onclick="deleteDocument('${d.id}', '${type}')">Delete</button>
          </div>
          <div class="doc-content">${formatMarkdown(d.content || "")}</div>
        </div>`;
      }).join("") + "</div>";
  } catch {
    body.innerHTML = '<div class="panel-loading" style="padding:24px">Failed to load documents.</div>';
  }
}
async function deleteDocument(id, type) {
  if (!confirm("Delete this document?")) return;
  await fetch(`${BACKEND_URL}/documents/${id}`, { method: "DELETE" });
  loadDocuments(type);
}

// ── Settings ──────────────────────────────────────────────────────────────────
async function loadSettings() {
  await Promise.all([
    loadKnowledge(),
    loadPreferences(),
    loadTargetCompanies(),
    loadSettingsStats(),
    loadUserTier(),
  ]);
  // Wire upgrade/manage buttons each time the panel opens (safe to call multiple times)
  document.getElementById("upgradeBtn")?.addEventListener("click", handleUpgradeClick);
  document.getElementById("manageSubBtn")?.addEventListener("click", openBillingPortal);
}

// Update these to match your Stripe prices exactly
const PLAN_PRICES = {
  monthly: { display: "$29 / month",  period: "monthly" },
  annual:  { display: "$290 / year",  period: "annual"  },
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
    applyTierGates();
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

  // Search Now button is pro-only
  const searchBtn = document.getElementById("searchNowBtn");
  if (searchBtn) {
    searchBtn.style.display = isPro ? "" : "none";
    if (!isPro) {
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

async function loadSettingsStats() {
  try {
    const res  = await fetch(`${BACKEND_URL}/stats/${encodeURIComponent(userId)}`);
    const data = await res.json();
    document.getElementById("settings-stat-runs").textContent   = data.runs          ?? 0;
    document.getElementById("settings-stat-tokens").textContent = (data.totalTokens  ?? 0).toLocaleString();
    document.getElementById("settings-stat-cost").textContent   = data.costFormatted ?? "$0.0000";
    document.getElementById("settings-stat-items").textContent  = data.runs          ?? 0;
  } catch { /* non-fatal */ }
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
    if (data.customSites)     document.getElementById("prefCustomSites").value     = data.customSites;
    if (data.postedWithin !== undefined) document.getElementById("prefPostedWithin").value = data.postedWithin;
    if (data.remoteOnly)      document.getElementById("prefRemoteOnly").checked    = data.remoteOnly;
    // Schedule settings
    document.getElementById("settingSearchEnabled").checked = data.searchEnabled !== false;
    if (data.searchTimesPerDay !== undefined) document.getElementById("settingTimesPerDay").value = data.searchTimesPerDay;
    if (data.searchStartHour  !== undefined) document.getElementById("settingStartHour").value   = data.searchStartHour;
    if (data.notifTimezone)   document.getElementById("settingTimezone").value    = data.notifTimezone;
    // Notification contact
    if (data.notifEmail)      document.getElementById("settingNotifEmail").value  = data.notifEmail;
    if (data.notifPhone)      document.getElementById("settingNotifPhone").value  = data.notifPhone;
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
        customSites:     document.getElementById("prefCustomSites").value,
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
  btn.disabled = true; btn.textContent = "Saving…";
  try {
    await fetch(`${BACKEND_URL}/preferences/save`, {
      method: "POST", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        userId,
        notifEmail: document.getElementById("settingNotifEmail").value.trim(),
        notifPhone: document.getElementById("settingNotifPhone").value.trim(),
      }),
    });
    status.textContent = "✓ Contact info saved.";
  } catch {
    status.textContent = "Failed to save. Please try again.";
  } finally { btn.disabled = false; btn.textContent = "Save Contact Info"; }
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
    status.textContent = "✓ Saved! Your resume and background will be used in every search and chat.";
  } catch {
    status.textContent = "Failed to save. Please try again.";
  } finally { btn.disabled = false; btn.textContent = "Save Profile"; }
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

// ── Resume PDF export ─────────────────────────────────────────────────────────
function appendResumeDownloadButton() {
  const chatArea = document.getElementById("chatArea");
  const wrap = document.createElement("div");
  wrap.className = "resume-dl-bar";
  wrap.innerHTML = `
    <span style="font-size:0.8rem;color:var(--text-muted)">Resume generated ·</span>
    <button class="btn btn-gold" style="padding:7px 16px;font-size:0.82rem" onclick="downloadResumeAsPDF()">
      📄 Download as PDF
    </button>`;
  chatArea.appendChild(wrap);
  chatArea.scrollTop = chatArea.scrollHeight;
}

function downloadResumeAsPDF() {
  if (!latestResumeText) return;
  generatePDF(latestResumeText, "tailored-resume.pdf");
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
    addTargetCompanyRow("", "");
    return;
  }
  companies.forEach(c => addTargetCompanyRow(c.name || "", c.url || ""));
}

function addTargetCompanyRow(name, url) {
  const list = document.getElementById("targetCompaniesList");
  if (!list) return;
  const row = document.createElement("div");
  row.className = "target-company-row";
  row.style.cssText = "display:flex;gap:10px;align-items:center";
  const inputStyle = "flex:1;min-width:0;padding:9px 12px;background:var(--input-bg,#111);border:1px solid var(--border);border-radius:8px;color:inherit;font-size:0.88rem;font-family:inherit";
  row.innerHTML = `
    <input type="text" class="tc-name" placeholder="Company name" value="${escapeAttr(name || "")}"
      style="${inputStyle}" />
    <input type="text" class="tc-url" placeholder="Career page URL" value="${escapeAttr(url || "")}"
      style="${inputStyle};flex:2" />
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
      .map(row => ({
        name: row.querySelector(".tc-name").value.trim(),
        url:  row.querySelector(".tc-url").value.trim(),
      }))
      .filter(c => c.name && c.url);

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

// ── Helpers ───────────────────────────────────────────────────────────────────
function signOut() { sessionStorage.clear(); window.location.href = "index.html"; }

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
