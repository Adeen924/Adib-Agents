const BACKEND_URL =
  window.location.hostname === "localhost" || window.location.hostname === "127.0.0.1"
    ? "http://127.0.0.1:5001/adib-job-agent/us-central1/api"
    : "https://us-central1-adib-job-agent.cloudfunctions.net/api";

// ── Auth guard ────────────────────────────────────────────────────────────────
const email = sessionStorage.getItem("fbEmail");
const token = sessionStorage.getItem("fbToken");
if (!email || !token) window.location.href = "index.html";
const userId = email;

// ── All views ─────────────────────────────────────────────────────────────────
const PANELS = {
  chat:      document.getElementById("chatView"),
  dashboard: document.getElementById("dashboardView"),
  jobs:      document.getElementById("jobsView"),
  documents: document.getElementById("documentsView"),
  digest:    document.getElementById("digestView"),
  prefs:     document.getElementById("prefsView"),
  knowledge: document.getElementById("knowledgeView"),
};

// ── Chat view config ──────────────────────────────────────────────────────────
const VIEWS = {
  search: {
    title:    "Job Search Assistant",
    subtitle: "Ask me about roles, companies, salaries, or strategy",
    chips:    ["Find me remote SWE roles", "What's the salary range for a PM?", "Help me research a company", "What roles match my background?"],
    prompt:   "You are a job search specialist. Help the user find job opportunities, research companies, and build a smart search strategy. Use web search to find real, current job listings when asked.",
  },
  resume: {
    title:    "Resume Helper",
    subtitle: "Paste your resume or a job description and I'll help you tailor it",
    chips:    ["Review my resume", "Tailor my resume for a role", "What keywords am I missing?", "Make my bullet points stronger"],
    prompt:   "You are a resume expert. Help the user improve, tailor, and strengthen their resume for specific job applications. When you produce a complete resume or major revision, end your message with the tag [SAVE_RESUME].",
    saveTag:  "[SAVE_RESUME]",
    docType:  "resume",
  },
  cover: {
    title:    "Cover Letter Writer",
    subtitle: "I'll write a targeted cover letter for any role",
    chips:    ["Write a cover letter for me", "Make it more concise", "Make it sound more confident", "Tailor it for a startup"],
    prompt:   "You are a professional cover letter writer. Help the user craft compelling cover letters. When you produce a complete cover letter, end your message with the tag [SAVE_COVER_LETTER].",
    saveTag:  "[SAVE_COVER_LETTER]",
    docType:  "cover_letter",
  },
  interview: {
    title:    "Interview Prep",
    subtitle: "Practice questions, company research, and offer negotiation",
    chips:    ["Give me common interview questions", "Help me answer 'tell me about yourself'", "How do I negotiate salary?", "What questions should I ask them?"],
    prompt:   "You are an interview coach. Help the user prepare for job interviews with practice questions, answer frameworks, and negotiation advice.",
  },
};

let currentChatView     = "search";
let isLoading           = false;
let conversationHistory = [];
let currentDocType      = "resume";
let editingAppId        = null;

// ── Init ──────────────────────────────────────────────────────────────────────
function init() {
  document.getElementById("userEmail").textContent  = email;
  document.getElementById("userAvatar").textContent = email.charAt(0).toUpperCase();

  // Sidebar nav
  document.querySelectorAll(".nav-item[data-view]").forEach((btn) => {
    btn.addEventListener("click", () => switchChatView(btn.dataset.view));
  });
  document.getElementById("nav-dashboard").addEventListener("click", () => showPanel("dashboard"));
  document.getElementById("nav-jobs").addEventListener("click",      () => showPanel("jobs"));
  document.getElementById("nav-documents").addEventListener("click", () => showPanel("documents"));
  document.getElementById("nav-digest").addEventListener("click",    () => showPanel("digest"));
  document.getElementById("nav-prefs").addEventListener("click",     () => showPanel("prefs"));
  document.getElementById("nav-knowledge").addEventListener("click", () => showPanel("knowledge"));
  document.getElementById("newChatBtn").addEventListener("click",    () => { showPanel("chat"); clearChat(); });
  document.getElementById("signOutBtn").addEventListener("click",    signOut);

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
  document.getElementById("prefsForm").addEventListener("submit", savePreferences);
  document.getElementById("kbForm").addEventListener("submit",    saveKnowledge);

  // Load initial chat
  renderChips(VIEWS[currentChatView].chips);
  loadHistory(currentChatView);
}

// ── Panel switching ───────────────────────────────────────────────────────────
function showPanel(name) {
  Object.values(PANELS).forEach(p => p.style.display = "none");
  PANELS[name].style.display = "flex";

  // Clear active states
  document.querySelectorAll(".nav-item").forEach(b => b.classList.remove("active"));

  // Set active nav item
  const navMap = {
    chat:      null,
    dashboard: "nav-dashboard",
    jobs:      "nav-jobs",
    documents: "nav-documents",
    digest:    "nav-digest",
    prefs:     "nav-prefs",
    knowledge: "nav-knowledge",
  };
  if (navMap[name]) document.getElementById(navMap[name])?.classList.add("active");

  // Load data for the panel
  if (name === "dashboard")  { loadStats(); loadApplications(); }
  if (name === "jobs")       loadJobs();
  if (name === "documents")  loadDocuments(currentDocType);
  if (name === "digest")     loadDigest();
  if (name === "prefs")      loadPreferences();
  if (name === "knowledge")  loadKnowledge();
}

function switchChatView(view) {
  currentChatView = view;
  const cfg = VIEWS[view];
  document.getElementById("viewTitle").textContent    = cfg.title;
  document.getElementById("viewSubtitle").textContent = cfg.subtitle;
  document.querySelectorAll(".nav-item[data-view]").forEach(b => {
    b.classList.toggle("active", b.dataset.view === view);
  });
  showPanel("chat");
  clearChat();
  loadHistory(view);
}

// ── Chat ──────────────────────────────────────────────────────────────────────
function clearChat() {
  conversationHistory = [];
  const chatArea = document.getElementById("chatArea");
  chatArea.innerHTML = "";
  const empty = document.createElement("div");
  empty.className = "chat-empty";
  empty.id = "emptyState";
  empty.innerHTML = `
    <div class="empty-icon">✦</div>
    <h3>${VIEWS[currentChatView].title}</h3>
    <p>${VIEWS[currentChatView].subtitle}</p>
    <div class="suggestion-chips" id="chips"></div>`;
  chatArea.appendChild(empty);
  renderChips(VIEWS[currentChatView].chips);
}

function renderChips(chips) {
  const el = document.getElementById("chips");
  if (!el) return;
  el.innerHTML = "";
  chips.forEach((text) => {
    const chip = document.createElement("button");
    chip.className = "chip";
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

function appendMessage(role, rawText) {
  removeEmptyState();
  const chatArea = document.getElementById("chatArea");

  // Strip save tags from display
  const cfg  = VIEWS[currentChatView];
  let text   = rawText;
  let saveDoc = false;
  if (cfg.saveTag && text.includes(cfg.saveTag)) {
    text    = text.replace(cfg.saveTag, "").trim();
    saveDoc = true;
  }

  const wrapper = document.createElement("div");
  wrapper.className = `message ${role}`;

  const avatar = document.createElement("div");
  avatar.className   = "msg-avatar";
  avatar.textContent = role === "user" ? email.charAt(0).toUpperCase() : "✦";

  const bubble = document.createElement("div");
  bubble.className = "msg-bubble";
  bubble.innerHTML = role === "assistant" ? formatMarkdown(text) : escapeHtml(text);

  // Save button for resume/cover letter responses
  if (role === "assistant" && saveDoc && cfg.docType) {
    const saveBtn = document.createElement("button");
    saveBtn.className   = "msg-save-btn";
    saveBtn.textContent = `💾 Save ${cfg.docType === "resume" ? "Resume" : "Cover Letter"}`;
    saveBtn.addEventListener("click", () => saveDocument(cfg.docType, text));
    bubble.appendChild(document.createElement("br"));
    bubble.appendChild(saveBtn);
  }

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
  wrapper.id = "typingIndicator";
  const avatar = document.createElement("div");
  avatar.className = "msg-avatar"; avatar.textContent = "✦";
  const bubble = document.createElement("div");
  bubble.className = "msg-bubble";
  bubble.innerHTML = '<div class="typing-dot"></div><div class="typing-dot"></div><div class="typing-dot"></div>';
  wrapper.appendChild(avatar); wrapper.appendChild(bubble);
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
        systemPrompt: VIEWS[currentChatView].prompt,
        history:      conversationHistory.slice(-10),
        userId,
        view:         currentChatView,
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
      body:    JSON.stringify({ userId, view: currentChatView, userMessage: text, assistantReply: data.reply }),
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

// ── Dashboard stats ───────────────────────────────────────────────────────────
async function loadStats() {
  try {
    const res  = await fetch(`${BACKEND_URL}/stats/${encodeURIComponent(userId)}`);
    const data = await res.json();
    document.getElementById("stat-runs").textContent   = data.runs         ?? 0;
    document.getElementById("stat-tokens").textContent = (data.totalTokens ?? 0).toLocaleString();
    document.getElementById("stat-cost").textContent   = data.costFormatted ?? "$0.0000";
    document.getElementById("stat-items").textContent  = data.runs         ?? 0;
  } catch { /* non-fatal */ }
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
              <td><span class="status-badge status-${a.status.toLowerCase().replace(" ", "-")}">${escapeHtml(a.status)}</span></td>
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
  editingAppId = null;
}

function hideAppForm() {
  document.getElementById("appForm").style.display = "none";
  ["appCompany","appRole","appUrl","appNotes","appEditId"].forEach(id => {
    document.getElementById(id).value = "";
  });
  document.getElementById("appStatus").value = "Applied";
  editingAppId = null;
}

function editApplication(id, company, role, status, url, notes, appliedAt) {
  document.getElementById("appForm").style.display = "block";
  document.getElementById("appCompany").value  = company;
  document.getElementById("appRole").value     = role;
  document.getElementById("appStatus").value   = status;
  document.getElementById("appUrl").value      = url;
  document.getElementById("appNotes").value    = notes;
  document.getElementById("appDate").value     = appliedAt ? appliedAt.split("T")[0] : "";
  document.getElementById("appEditId").value   = id;
  editingAppId = id;
  document.getElementById("appForm").scrollIntoView({ behavior: "smooth" });
}

async function saveApplication() {
  const company = document.getElementById("appCompany").value.trim();
  const role    = document.getElementById("appRole").value.trim();
  if (!company || !role) { alert("Company and role are required."); return; }

  const btn = document.getElementById("saveAppBtn");
  btn.disabled = true; btn.textContent = "Saving…";

  await fetch(`${BACKEND_URL}/applications/save`, {
    method:  "POST",
    headers: { "Content-Type": "application/json" },
    body:    JSON.stringify({
      userId,
      id:        document.getElementById("appEditId").value || undefined,
      company,
      role,
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
        <p>Set up your preferences and the daily agent will populate this every morning.</p></div>`;
      return;
    }

    body.innerHTML = data.jobs.map((j) => {
      const date = j.createdAt?._seconds
        ? new Date(j.createdAt._seconds * 1000).toLocaleDateString("en-US", { weekday:"long", month:"short", day:"numeric" })
        : "";
      return `<div class="digest-card">
        <div class="digest-card-header">
          <span class="digest-date">${date}</span>
          <span class="digest-query">${escapeHtml(j.query || "")}</span>
        </div>
        <div class="digest-results">${formatMarkdown(j.results || "")}</div>
      </div>`;
    }).join("");
  } catch {
    body.innerHTML = '<div class="panel-loading">Failed to load jobs.</div>';
  }
}

// ── Documents ─────────────────────────────────────────────────────────────────
async function loadDocuments(type) {
  const body = document.getElementById("documentsBody");
  body.innerHTML = '<div class="panel-loading">Loading…</div>';
  try {
    const res  = await fetch(`${BACKEND_URL}/documents/${encodeURIComponent(userId)}/${type}`);
    const data = await res.json();

    if (!data.documents || data.documents.length === 0) {
      const label = type === "resume" ? "resumes" : "cover letters";
      body.innerHTML = `<div class="digest-empty"><div class="empty-icon">📁</div>
        <h3>No ${label} yet</h3>
        <p>Use the ${type === "resume" ? "Resume Helper" : "Cover Letter"} tool and the agent will automatically save completed documents here.</p></div>`;
      return;
    }

    body.innerHTML = data.documents.map((d) => {
      const date = d.createdAt?._seconds
        ? new Date(d.createdAt._seconds * 1000).toLocaleDateString()
        : "";
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
    }).join("");
  } catch {
    body.innerHTML = '<div class="panel-loading">Failed to load documents.</div>';
  }
}

async function saveDocument(type, content) {
  const title = prompt(`Name this ${type === "resume" ? "resume" : "cover letter"}:`,
    type === "resume" ? "My Resume" : "Cover Letter");
  if (!title) return;

  await fetch(`${BACKEND_URL}/documents/save`, {
    method:  "POST",
    headers: { "Content-Type": "application/json" },
    body:    JSON.stringify({ userId, type, content, title }),
  });
  alert("Saved to Documents!");
}

async function deleteDocument(id, type) {
  if (!confirm("Delete this document?")) return;
  await fetch(`${BACKEND_URL}/documents/${id}`, { method: "DELETE" });
  loadDocuments(type);
}

// ── Daily Digest ──────────────────────────────────────────────────────────────
async function loadDigest() {
  const body = document.getElementById("digestBody");
  body.innerHTML = '<div class="panel-loading">Loading…</div>';
  try {
    const res  = await fetch(`${BACKEND_URL}/digest/${encodeURIComponent(userId)}`);
    const data = await res.json();

    if (!data.digests || data.digests.length === 0) {
      body.innerHTML = `<div class="digest-empty"><div class="empty-icon">📬</div>
        <h3>No digests yet</h3>
        <p>Save your job preferences and the agent will search every morning at 8am.</p></div>`;
      return;
    }

    body.innerHTML = data.digests.map((d) => {
      const date = d.createdAt?._seconds
        ? new Date(d.createdAt._seconds * 1000).toLocaleDateString("en-US", { weekday:"long", month:"short", day:"numeric" })
        : "Recent";
      return `<div class="digest-card">
        <div class="digest-card-header">
          <span class="digest-date">${date}</span>
          <span class="digest-query">${escapeHtml(d.query || "")}</span>
        </div>
        <div class="digest-results">${formatMarkdown(d.results || "")}</div>
      </div>`;
    }).join("");
  } catch {
    body.innerHTML = '<div class="panel-loading">Failed to load digests.</div>';
  }
}

// ── Preferences ───────────────────────────────────────────────────────────────
async function loadPreferences() {
  try {
    const res  = await fetch(`${BACKEND_URL}/preferences/${encodeURIComponent(userId)}`);
    const data = await res.json();
    if (data.jobTitle)  document.getElementById("prefJobTitle").value  = data.jobTitle;
    if (data.location)  document.getElementById("prefLocation").value  = data.location;
    if (data.jobType)   document.getElementById("prefJobType").value   = data.jobType;
    if (data.salaryMin) document.getElementById("prefSalaryMin").value = data.salaryMin;
  } catch { /* non-fatal */ }
}

async function savePreferences(e) {
  e.preventDefault();
  const status = document.getElementById("prefsStatus");
  const btn    = e.submitter;
  btn.disabled = true; btn.textContent = "Saving…";
  try {
    await fetch(`${BACKEND_URL}/preferences/save`, {
      method:  "POST",
      headers: { "Content-Type": "application/json" },
      body:    JSON.stringify({
        userId,
        jobTitle:  document.getElementById("prefJobTitle").value,
        location:  document.getElementById("prefLocation").value,
        jobType:   document.getElementById("prefJobType").value,
        salaryMin: document.getElementById("prefSalaryMin").value,
      }),
    });
    status.textContent = "✓ Saved! The agent will use these tomorrow morning.";
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
      method:  "POST",
      headers: { "Content-Type": "application/json" },
      body:    JSON.stringify({
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

// ── History ───────────────────────────────────────────────────────────────────
async function loadHistory(view) {
  try {
    const res  = await fetch(`${BACKEND_URL}/history/${encodeURIComponent(userId)}/${view}`);
    const data = await res.json();
    if (!data.messages || data.messages.length === 0) return;
    conversationHistory = data.messages;
    data.messages.forEach((m) => appendMessage(m.role, m.content));
  } catch { /* non-fatal */ }
}

// ── Helpers ───────────────────────────────────────────────────────────────────
function signOut() { sessionStorage.clear(); window.location.href = "index.html"; }

function escapeHtml(str) {
  return String(str)
    .replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;").replace(/\n/g, "<br>");
}

function formatMarkdown(str) {
  return String(str)
    .replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;")
    .replace(/\*\*(.+?)\*\*/g, "<strong>$1</strong>")
    .replace(/`(.+?)`/g,       "<code>$1</code>")
    .replace(/^### (.+)$/gm,   "<strong>$1</strong>")
    .replace(/^## (.+)$/gm,    "<strong>$1</strong>")
    .replace(/^- (.+)$/gm,     "• $1")
    .replace(/\n/g, "<br>");
}

init();
