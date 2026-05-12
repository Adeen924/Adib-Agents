const BACKEND_URL =
  window.location.hostname === "localhost" || window.location.hostname === "127.0.0.1"
    ? "http://localhost:3000"
    : "https://YOUR_RAILWAY_URL.up.railway.app"; // update this after Railway deploy

// ── Auth guard ──────────────────────────────────────────────────────────────
const email = sessionStorage.getItem("fbEmail");
const token = sessionStorage.getItem("fbToken");
if (!email || !token) {
  window.location.href = "index.html";
}

// ── DOM refs ─────────────────────────────────────────────────────────────────
const chatArea     = document.getElementById("chatArea");
const emptyState   = document.getElementById("emptyState");
const messageInput = document.getElementById("messageInput");
const sendBtn      = document.getElementById("sendBtn");
const userAvatar   = document.getElementById("userAvatar");
const userEmailEl  = document.getElementById("userEmail");
const signOutBtn   = document.getElementById("signOutBtn");
const newChatBtn   = document.getElementById("newChatBtn");
const viewTitle    = document.getElementById("viewTitle");
const viewSubtitle = document.getElementById("viewSubtitle");
const chipsEl      = document.getElementById("chips");

// ── View config ───────────────────────────────────────────────────────────────
const VIEWS = {
  search: {
    title:    "Job Search Assistant",
    subtitle: "Ask me about roles, companies, salaries, or strategy",
    chips:    ["Find me remote SWE roles", "What's the salary range for a PM?", "Help me research a company", "What roles match my background?"],
    prompt:   "You are a job search specialist. Help the user find job opportunities, research companies, and build a smart search strategy.",
  },
  resume: {
    title:    "Resume Helper",
    subtitle: "Paste your resume or a job description and I'll help you tailor it",
    chips:    ["Review my resume", "Tailor my resume for a role", "What keywords am I missing?", "Make my bullet points stronger"],
    prompt:   "You are a resume expert. Help the user improve, tailor, and strengthen their resume for specific job applications.",
  },
  cover: {
    title:    "Cover Letter Writer",
    subtitle: "I'll write a targeted cover letter for any role",
    chips:    ["Write a cover letter for me", "Make it more concise", "Make it sound more confident", "Tailor it for a startup"],
    prompt:   "You are a professional cover letter writer. Help the user craft compelling, tailored cover letters for specific roles and companies.",
  },
  interview: {
    title:    "Interview Prep",
    subtitle: "Practice questions, company research, and offer negotiation",
    chips:    ["Give me common interview questions", "Help me answer 'tell me about yourself'", "How do I negotiate salary?", "What questions should I ask them?"],
    prompt:   "You are an interview coach. Help the user prepare for job interviews with practice questions, answer frameworks, and negotiation advice.",
  },
};

let currentView    = "search";
let isLoading      = false;
let conversationHistory = [];

// ── Init ──────────────────────────────────────────────────────────────────────
function init() {
  userEmailEl.textContent  = email;
  userAvatar.textContent   = email.charAt(0).toUpperCase();
  renderChips(VIEWS[currentView].chips);

  document.querySelectorAll(".nav-item[data-view]").forEach((btn) => {
    btn.addEventListener("click", () => switchView(btn.dataset.view));
  });

  signOutBtn.addEventListener("click", signOut);
  newChatBtn.addEventListener("click", clearChat);
  sendBtn.addEventListener("click", sendMessage);

  messageInput.addEventListener("keydown", (e) => {
    if (e.key === "Enter" && !e.shiftKey) {
      e.preventDefault();
      sendMessage();
    }
  });

  messageInput.addEventListener("input", () => {
    messageInput.style.height = "auto";
    messageInput.style.height = Math.min(messageInput.scrollHeight, 160) + "px";
  });
}

// ── View switching ────────────────────────────────────────────────────────────
function switchView(view) {
  currentView = view;
  const cfg = VIEWS[view];
  viewTitle.textContent    = cfg.title;
  viewSubtitle.textContent = cfg.subtitle;

  document.querySelectorAll(".nav-item[data-view]").forEach((btn) => {
    btn.classList.toggle("active", btn.dataset.view === view);
  });

  clearChat();
}

function renderChips(chips) {
  chipsEl.innerHTML = "";
  chips.forEach((text) => {
    const chip = document.createElement("button");
    chip.className   = "chip";
    chip.textContent = text;
    chip.addEventListener("click", () => {
      messageInput.value = text;
      sendMessage();
    });
    chipsEl.appendChild(chip);
  });
}

// ── Chat ──────────────────────────────────────────────────────────────────────
function clearChat() {
  conversationHistory = [];
  chatArea.innerHTML  = "";
  const empty = document.createElement("div");
  empty.className = "chat-empty";
  empty.id        = "emptyState";
  empty.innerHTML = `
    <div class="empty-icon">✦</div>
    <h3>${VIEWS[currentView].title}</h3>
    <p>${VIEWS[currentView].subtitle}</p>
    <div class="suggestion-chips" id="chips"></div>
  `;
  chatArea.appendChild(empty);
  renderChips(VIEWS[currentView].chips);
}

function removeEmptyState() {
  const empty = document.getElementById("emptyState");
  if (empty) empty.remove();
}

function appendMessage(role, text) {
  removeEmptyState();

  const wrapper = document.createElement("div");
  wrapper.className = `message ${role}`;

  const avatar = document.createElement("div");
  avatar.className = "msg-avatar";
  avatar.textContent = role === "user" ? email.charAt(0).toUpperCase() : "✦";

  const bubble = document.createElement("div");
  bubble.className = "msg-bubble";
  bubble.innerHTML  = role === "assistant" ? formatMarkdown(text) : escapeHtml(text);

  wrapper.appendChild(avatar);
  wrapper.appendChild(bubble);
  chatArea.appendChild(wrapper);
  chatArea.scrollTop = chatArea.scrollHeight;

  return bubble;
}

function appendTypingIndicator() {
  removeEmptyState();
  const wrapper = document.createElement("div");
  wrapper.className = "message assistant typing-indicator";
  wrapper.id        = "typingIndicator";

  const avatar = document.createElement("div");
  avatar.className  = "msg-avatar";
  avatar.textContent = "✦";

  const bubble = document.createElement("div");
  bubble.className = "msg-bubble";
  bubble.innerHTML  = '<div class="typing-dot"></div><div class="typing-dot"></div><div class="typing-dot"></div>';

  wrapper.appendChild(avatar);
  wrapper.appendChild(bubble);
  chatArea.appendChild(wrapper);
  chatArea.scrollTop = chatArea.scrollHeight;
}

function removeTypingIndicator() {
  const el = document.getElementById("typingIndicator");
  if (el) el.remove();
}

async function sendMessage() {
  const text = messageInput.value.trim();
  if (!text || isLoading) return;

  isLoading              = true;
  sendBtn.disabled       = true;
  messageInput.value     = "";
  messageInput.style.height = "auto";

  appendMessage("user", text);
  conversationHistory.push({ role: "user", content: text });
  appendTypingIndicator();

  try {
    const res = await fetch(`${BACKEND_URL}/chat`, {
      method:  "POST",
      headers: { "Content-Type": "application/json" },
      body:    JSON.stringify({
        message:      text,
        systemPrompt: VIEWS[currentView].prompt,
        history:      conversationHistory.slice(-10), // last 10 messages for context
      }),
    });

    const data = await res.json();
    removeTypingIndicator();

    if (!res.ok) throw new Error(data.error || "Request failed");

    appendMessage("assistant", data.reply);
    conversationHistory.push({ role: "assistant", content: data.reply });
  } catch (err) {
    removeTypingIndicator();
    appendMessage("assistant", "Sorry, something went wrong. Please try again.");
    console.error(err);
  } finally {
    isLoading        = false;
    sendBtn.disabled = false;
    messageInput.focus();
  }
}

// ── Helpers ───────────────────────────────────────────────────────────────────
function signOut() {
  sessionStorage.clear();
  window.location.href = "index.html";
}

function escapeHtml(str) {
  return str
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/\n/g, "<br>");
}

function formatMarkdown(str) {
  return str
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/\*\*(.+?)\*\*/g, "<strong>$1</strong>")
    .replace(/`(.+?)`/g, "<code>$1</code>")
    .replace(/^### (.+)$/gm, "<strong>$1</strong>")
    .replace(/^## (.+)$/gm, "<strong>$1</strong>")
    .replace(/^- (.+)$/gm, "• $1")
    .replace(/\n/g, "<br>");
}

init();
