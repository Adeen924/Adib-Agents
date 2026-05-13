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
  documents: document.getElementById("documentsView"),
  digest:    document.getElementById("digestView"),
  prefs:     document.getElementById("prefsView"),
  knowledge: document.getElementById("knowledgeView"),
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

let isLoading           = false;
let conversationHistory = [];
let currentDocType      = "resume";

// ── Init ──────────────────────────────────────────────────────────────────────
function init() {
  document.getElementById("userEmail").textContent  = email;
  document.getElementById("userAvatar").textContent = email.charAt(0).toUpperCase();

  // Sidebar navigation
  document.getElementById("nav-dashboard").addEventListener("click", () => showPanel("dashboard"));
  document.getElementById("nav-jobs").addEventListener("click",      () => showPanel("jobs"));
  document.getElementById("nav-documents").addEventListener("click", () => showPanel("documents"));
  document.getElementById("nav-digest").addEventListener("click",    () => showPanel("digest"));
  document.getElementById("nav-prefs").addEventListener("click",     () => showPanel("prefs"));
  document.getElementById("nav-knowledge").addEventListener("click", () => showPanel("knowledge"));
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

  // Search Now button
  document.getElementById("searchNowBtn").addEventListener("click", searchNow);

  // Load dashboard on start
  showPanel("dashboard");
  renderChips(INTERVIEW_VIEW.chips);
  loadHistory();
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
    prefs:     "nav-prefs",
    knowledge: "nav-knowledge",
  };
  if (navIds[name]) document.getElementById(navIds[name])?.classList.add("active");
  if (name === "chat") document.querySelector("[data-view='interview']")?.classList.add("active");

  if (name === "dashboard")  { loadStats(); loadApplications(); }
  if (name === "jobs")       loadJobs();
  if (name === "documents")  loadDocuments(currentDocType);
  if (name === "digest")     loadDigest();
  if (name === "prefs")      loadPreferences();
  if (name === "knowledge")  loadKnowledge();
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
    await loadDigest(); // reload the list
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
  body.innerHTML = '<div class="panel-loading">Loading jobs…</div>';
  try {
    const res  = await fetch(`${BACKEND_URL}/jobs/${encodeURIComponent(userId)}`);
    const data = await res.json();
    if (!data.jobs || data.jobs.length === 0) {
      body.innerHTML = `<div class="digest-empty"><div class="empty-icon">💼</div>
        <h3>No jobs found yet</h3>
        <p>Set your preferences and hit "Search Now" or wait for the daily 8am search.</p></div>`;
      return;
    }
    body.innerHTML = data.jobs.map((j) => digestCard(j)).join("");
  } catch {
    body.innerHTML = '<div class="panel-loading">Failed to load jobs.</div>';
  }
}

// ── Daily Digest ──────────────────────────────────────────────────────────────
async function loadDigest() {
  const body = document.getElementById("digestBody");
  try {
    const res  = await fetch(`${BACKEND_URL}/digest/${encodeURIComponent(userId)}`);
    const data = await res.json();
    if (!data.digests || data.digests.length === 0) {
      body.innerHTML = `<div class="digest-empty"><div class="empty-icon">📬</div>
        <h3>No digests yet</h3>
        <p>Save your preferences and hit "Search Now" to get your first results, or wait for the 8am daily search.</p></div>`;
      return;
    }
    body.innerHTML = data.digests.map((d) => digestCard(d)).join("");
  } catch {
    body.innerHTML = '<div class="panel-loading">Failed to load digests.</div>';
  }
}

function digestCard(d) {
  const date = d.createdAt?._seconds
    ? new Date(d.createdAt._seconds * 1000).toLocaleDateString("en-US", { weekday:"long", month:"short", day:"numeric", hour:"2-digit", minute:"2-digit" })
    : "Recent";
  return `<div class="digest-card">
    <div class="digest-card-header">
      <span class="digest-date">${date}</span>
      <span class="digest-query">${escapeHtml(d.query || "")}</span>
    </div>
    <div class="digest-results">${formatMarkdown(d.results || "")}</div>
  </div>`;
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

// ── Preferences ───────────────────────────────────────────────────────────────
async function loadPreferences() {
  try {
    const res  = await fetch(`${BACKEND_URL}/preferences/${encodeURIComponent(userId)}`);
    const data = await res.json();
    if (data.jobTitle)        document.getElementById("prefJobTitle").value     = data.jobTitle;
    if (data.location)        document.getElementById("prefLocation").value     = data.location;
    if (data.jobType)         document.getElementById("prefJobType").value      = data.jobType;
    if (data.salaryMin)       document.getElementById("prefSalaryMin").value    = data.salaryMin;
    if (data.experienceLevel) document.getElementById("prefExpLevel").value     = data.experienceLevel;
    if (data.companySize)     document.getElementById("prefCompanySize").value  = data.companySize;
    if (data.industries)      document.getElementById("prefIndustries").value   = data.industries;
    if (data.resume)          document.getElementById("prefResume").value       = data.resume;
    if (data.remoteOnly)      document.getElementById("prefRemoteOnly").checked = data.remoteOnly;
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
        location:        document.getElementById("prefLocation").value,
        jobType:         document.getElementById("prefJobType").value,
        salaryMin:       document.getElementById("prefSalaryMin").value,
        experienceLevel: document.getElementById("prefExpLevel").value,
        companySize:     document.getElementById("prefCompanySize").value,
        industries:      document.getElementById("prefIndustries").value,
        resume:          document.getElementById("prefResume").value,
        remoteOnly:      document.getElementById("prefRemoteOnly").checked,
      }),
    });
    status.textContent = "✓ Saved! The agent will use these for your next job search.";
  } catch {
    status.textContent = "Failed to save. Please try again.";
  } finally { btn.disabled = false; btn.textContent = "Save Preferences"; }
}

// ── Knowledge Base ────────────────────────────────────────────────────────────
async function loadKnowledge() {
  try {
    const res  = await fetch(`${BACKEND_URL}/knowledge/${encodeURIComponent(userId)}`);
    const data = await res.json();
    if (data.currentResume)     document.getElementById("kbResume").value      = data.currentResume;
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
        currentResume:     document.getElementById("kbResume").value,
        currentPosition:   document.getElementById("kbCurrentPos").value,
        previousPositions: document.getElementById("kbPrevPos").value,
        targetRole:        document.getElementById("kbTargetRole").value,
        skills:            document.getElementById("kbSkills").value,
        education:         document.getElementById("kbEducation").value,
        additionalContext: document.getElementById("kbContext").value,
      }),
    });
    status.textContent = "✓ Saved! All future chats will be personalised with this context.";
  } catch {
    status.textContent = "Failed to save. Please try again.";
  } finally { btn.disabled = false; btn.textContent = "Save Knowledge Base"; }
}

// ── Helpers ───────────────────────────────────────────────────────────────────
function signOut() { sessionStorage.clear(); window.location.href = "index.html"; }

function escapeHtml(str) {
  return String(str)
    .replace(/&/g,"&amp;").replace(/</g,"&lt;").replace(/>/g,"&gt;")
    .replace(/"/g,"&quot;").replace(/\n/g,"<br>");
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
