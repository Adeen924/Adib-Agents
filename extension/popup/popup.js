/**
 * CareerCopilot — Popup Logic
 * Manages UI state and communicates with background service worker + content scripts.
 */

const BACKEND_URL = "https://us-central1-adib-job-agent.cloudfunctions.net/api";
const CAREEERCOPILOT_URL = "https://adib-job-agent.web.app";

// ─── State ────────────────────────────────────────────────────────────────────
let state = {
  auth: null,           // { connected, token, userEmail, expiresAt, expired }
  pageType: "other",    // profile | company_people | search_results | other
  isLinkedIn: false,
  connections: null,    // ExtractedConnection[] after analysis
  synced: false,
  loading: false,
};

// ─── DOM refs ─────────────────────────────────────────────────────────────────
const $ = (id) => document.getElementById(id);

const els = {
  // Header
  headerStatus: $("headerStatus"),
  headerStatusText: $("headerStatusText"),

  // Sections
  setupSection: $("setupSection"),
  connectedSection: $("connectedSection"),
  analysisSection: $("analysisSection"),
  statusArea: $("statusArea"),
  viewLinkArea: $("viewLinkArea"),

  // Setup
  tokenInput: $("tokenInput"),
  connectBtn: $("connectBtn"),

  // Connected
  userAvatar: $("userAvatar"),
  userEmail: $("userEmail"),

  // Analysis
  pageTypeBadge: $("pageTypeBadge"),
  pageTypeIcon: $("pageTypeIcon"),
  pageTypeText: $("pageTypeText"),
  notLinkedInMsg: $("notLinkedInMsg"),
  analysisControls: $("analysisControls"),
  analyzeBtn: $("analyzeBtn"),
  analyzeBtnText: $("analyzeBtnText"),

  // Results
  resultsArea: $("resultsArea"),
  resultsCount: $("resultsCount"),
  resultsTitle: $("resultsTitle"),
  resultsSubtitle: $("resultsSubtitle"),
  recruiterCount: $("recruiterCount"),
  mutualCount: $("mutualCount"),
  syncBtn: $("syncBtn"),

  // Footer
  disconnectBtn: $("disconnectBtn"),
  viewLink: $("viewLink"),
};

// ─── Utility helpers ──────────────────────────────────────────────────────────
function show(el) { el?.classList.remove("hidden"); }
function hide(el) { el?.classList.add("hidden"); }
function toggle(el, visible) { visible ? show(el) : hide(el); }

function setStatus(message, type = "loading", details = "") {
  const area = els.statusArea;
  show(area);
  area.className = `status-area ${type}`;

  if (type === "loading") {
    area.innerHTML = `<div class="spinner"></div><span>${message}${details ? `<br/><small style="opacity:0.7">${details}</small>` : ""}</span>`;
  } else if (type === "success") {
    area.innerHTML = `<span style="font-size:14px">✓</span><span>${message}${details ? `<br/><small style="opacity:0.8">${details}</small>` : ""}</span>`;
  } else if (type === "error") {
    area.innerHTML = `<span style="font-size:14px">✕</span><span>${message}${details ? `<br/><small style="opacity:0.8">${details}</small>` : ""}</span>`;
  }
}

function clearStatus() {
  hide(els.statusArea);
  els.statusArea.innerHTML = "";
  els.statusArea.className = "status-area hidden";
}

function getInitial(email) {
  if (!email) return "?";
  return email.charAt(0).toUpperCase();
}

function pageTypeLabel(pt) {
  switch (pt) {
    case "profile": return { icon: "👤", text: "Profile Page" };
    case "company_people": return { icon: "🏢", text: "Company People" };
    case "search_results": return { icon: "🔍", text: "Search Results" };
    default: return { icon: "⚪", text: "Unsupported Page" };
  }
}

// ─── Auth: check ─────────────────────────────────────────────────────────────
async function checkAuthStatus() {
  return new Promise((resolve) => {
    chrome.runtime.sendMessage({ type: "GET_AUTH" }, (response) => {
      if (chrome.runtime.lastError || !response?.success) {
        state.auth = { connected: false };
      } else {
        state.auth = response.auth;
      }
      resolve(state.auth);
    });
  });
}

// ─── Auth: save token ─────────────────────────────────────────────────────────
async function saveToken(token) {
  return new Promise((resolve, reject) => {
    chrome.runtime.sendMessage(
      { type: "SAVE_TOKEN", payload: { token } },
      (response) => {
        if (chrome.runtime.lastError) {
          reject(new Error(chrome.runtime.lastError.message));
        } else if (!response?.success) {
          reject(new Error(response?.error || "Failed to save token"));
        } else {
          resolve();
        }
      }
    );
  });
}

// ─── Auth: clear token ────────────────────────────────────────────────────────
async function clearToken() {
  return new Promise((resolve, reject) => {
    chrome.runtime.sendMessage({ type: "CLEAR_TOKEN" }, (response) => {
      if (chrome.runtime.lastError) {
        reject(new Error(chrome.runtime.lastError.message));
      } else if (!response?.success) {
        reject(new Error(response?.error || "Failed to clear token"));
      } else {
        resolve();
      }
    });
  });
}

// ─── Detect page type from active tab ────────────────────────────────────────
async function detectPageType() {
  return new Promise((resolve) => {
    chrome.tabs.query({ active: true, currentWindow: true }, (tabs) => {
      const tab = tabs?.[0];
      if (!tab?.url) {
        state.isLinkedIn = false;
        state.pageType = "other";
        resolve({ isLinkedIn: false, pageType: "other" });
        return;
      }

      const url = tab.url;
      const isLinkedIn = url.startsWith("https://www.linkedin.com/");
      let pageType = "other";

      if (isLinkedIn) {
        const path = new URL(url).pathname;
        if (/^\/in\/[^/]+\/?$/.test(path)) pageType = "profile";
        else if (/\/company\/[^/]+\/people/.test(path)) pageType = "company_people";
        else if (/\/search\/results\/people/.test(path)) pageType = "search_results";
      }

      state.isLinkedIn = isLinkedIn;
      state.pageType = pageType;
      resolve({ isLinkedIn, pageType });
    });
  });
}

// ─── Analyze page (send message to content script) ───────────────────────────
async function analyzePage() {
  return new Promise((resolve, reject) => {
    chrome.tabs.query({ active: true, currentWindow: true }, (tabs) => {
      const tab = tabs?.[0];
      if (!tab?.id) {
        reject(new Error("No active tab found."));
        return;
      }

      chrome.tabs.sendMessage(tab.id, { type: "ANALYZE_PAGE" }, (response) => {
        if (chrome.runtime.lastError) {
          reject(
            new Error(
              "Could not reach content script. Try refreshing the LinkedIn page."
            )
          );
          return;
        }
        if (!response?.success) {
          reject(new Error(response?.error || "Analysis failed."));
          return;
        }
        resolve(response);
      });
    });
  });
}

// ─── Sync to CareerCopilot backend ───────────────────────────────────────────
async function syncToCareerCopilot(connections) {
  if (!state.auth?.token) {
    throw new Error("Not authenticated. Please reconnect.");
  }

  const response = await fetch(`${BACKEND_URL}/network/extension/sync`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "X-Extension-Token": state.auth.token,
    },
    body: JSON.stringify({ connections }),
  });

  if (response.status === 401) {
    throw new Error(
      "Token expired or invalid. Please disconnect and reconnect."
    );
  }
  if (response.status === 429) {
    throw new Error("Rate limit reached. Please wait a moment and try again.");
  }
  if (!response.ok) {
    let errorMsg = `Server error (${response.status})`;
    try {
      const errBody = await response.json();
      if (errBody.error || errBody.message) {
        errorMsg = errBody.error || errBody.message;
      }
    } catch (_) {}
    throw new Error(errorMsg);
  }

  const data = await response.json();
  return {
    synced: data.synced ?? connections.length,
    newConnections: data.newConnections ?? 0,
    message: data.message ?? "Connections synced successfully.",
  };
}

// ─── UI rendering ─────────────────────────────────────────────────────────────
function renderUI() {
  const { auth, isLinkedIn, pageType, connections, synced, loading } = state;
  const connected = auth?.connected;

  // Header status
  els.headerStatus.className = `status-indicator ${connected ? "connected" : "disconnected"}`;
  els.headerStatusText.textContent = connected ? "Connected" : "Not Connected";

  // Setup vs connected section
  toggle(els.setupSection, !connected);
  toggle(els.connectedSection, connected);
  toggle(els.disconnectBtn, connected);

  // Connected user info
  if (connected && auth?.userEmail) {
    els.userEmail.textContent = auth.userEmail;
    els.userAvatar.textContent = getInitial(auth.userEmail);
  }

  // Analysis section: only show when connected
  toggle(els.analysisSection, connected);

  if (connected) {
    // Page type badge
    const { icon, text } = pageTypeLabel(pageType);
    els.pageTypeIcon.textContent = icon;
    els.pageTypeText.textContent = text;

    const isSupported = ["profile", "company_people", "search_results"].includes(pageType);

    if (!isLinkedIn) {
      els.pageTypeBadge.className = "page-type-badge unsupported";
      els.pageTypeText.textContent = "Not on LinkedIn";
      show(els.notLinkedInMsg);
      els.analyzeBtn.disabled = true;
    } else if (!isSupported) {
      els.pageTypeBadge.className = "page-type-badge unsupported";
      show(els.notLinkedInMsg);
      els.notLinkedInMsg.innerHTML = `Navigate to a <strong>profile</strong>, <strong>company people</strong>, or <strong>search results</strong> page.`;
      els.analyzeBtn.disabled = true;
    } else {
      els.pageTypeBadge.className = "page-type-badge";
      hide(els.notLinkedInMsg);
      els.analyzeBtn.disabled = loading;
    }

    // Analyze button text
    if (loading) {
      els.analyzeBtnText.textContent = "Analyzing...";
    } else if (connections !== null) {
      els.analyzeBtnText.textContent = "Re-analyze Page";
    } else {
      els.analyzeBtnText.textContent = "Analyze This Page";
    }

    // Results area
    if (connections !== null) {
      show(els.resultsArea);
      els.resultsCount.textContent = connections.length;
      els.resultsTitle.textContent =
        connections.length === 1 ? "Connection Found" : "Connections Found";

      const recruiterCount = connections.filter((c) => c.recruiterConfidence >= 0.5).length;
      const mutualCount = connections.filter((c) => c.mutualConnections > 0).length;

      els.recruiterCount.textContent = recruiterCount;
      els.mutualCount.textContent = mutualCount;

      els.syncBtn.disabled = loading || connections.length === 0 || synced;
      els.syncBtn.textContent = synced ? "✓ Synced!" : "Sync to CareerCopilot";
    } else {
      hide(els.resultsArea);
    }
  }

  // View link
  toggle(els.viewLinkArea, synced);
}

// ─── Event handlers ───────────────────────────────────────────────────────────

// Connect button
els.connectBtn.addEventListener("click", async () => {
  const token = els.tokenInput.value.trim();
  if (!token) {
    setStatus("Please paste your extension token.", "error");
    return;
  }
  if (token.length < 10) {
    setStatus("Token looks too short. Copy the full token from CareerCopilot.", "error");
    return;
  }

  state.loading = true;
  els.connectBtn.disabled = true;
  setStatus("Connecting...", "loading");

  try {
    await saveToken(token);

    // Re-fetch auth to get email if available
    await checkAuthStatus();

    // Also try to get user info from the token itself
    // (Token may be a JWT or opaque; we just store it and let backend validate)
    state.synced = false;
    state.connections = null;
    clearStatus();
    els.tokenInput.value = "";

    setStatus("Connected successfully!", "success", "You can now analyze LinkedIn pages.");
    setTimeout(clearStatus, 3000);
    renderUI();
  } catch (err) {
    setStatus("Connection failed.", "error", err.message);
  } finally {
    state.loading = false;
    els.connectBtn.disabled = false;
    renderUI();
  }
});

// Allow pressing Enter in token input
els.tokenInput.addEventListener("keydown", (e) => {
  if (e.key === "Enter") els.connectBtn.click();
});

// Disconnect button
els.disconnectBtn.addEventListener("click", async () => {
  if (!confirm("Disconnect CareerCopilot extension?")) return;

  try {
    await clearToken();
    state.auth = { connected: false };
    state.connections = null;
    state.synced = false;
    clearStatus();
    renderUI();
  } catch (err) {
    setStatus("Failed to disconnect.", "error", err.message);
  }
});

// Analyze button
els.analyzeBtn.addEventListener("click", async () => {
  if (state.loading) return;

  state.loading = true;
  state.connections = null;
  state.synced = false;
  clearStatus();
  hide(els.viewLinkArea);
  setStatus("Reading visible page content...", "loading", "No auto-scrolling — only what's on screen.");
  renderUI();

  try {
    const result = await analyzePage();
    state.connections = result.connections || [];
    clearStatus();

    if (state.connections.length === 0) {
      setStatus(
        "No connections found on this page.",
        "error",
        "Try scrolling the page first, then re-analyze."
      );
    } else {
      setStatus(
        `Found ${state.connections.length} connection${state.connections.length !== 1 ? "s" : ""}.`,
        "success",
        "Click \"Sync\" to add them to your network."
      );
      setTimeout(clearStatus, 4000);
    }
  } catch (err) {
    state.connections = null;
    setStatus("Analysis failed.", "error", err.message);
  } finally {
    state.loading = false;
    renderUI();
  }
});

// Sync button
els.syncBtn.addEventListener("click", async () => {
  if (!state.connections || state.connections.length === 0) return;
  if (state.loading) return;

  state.loading = true;
  els.syncBtn.disabled = true;
  setStatus(
    `Syncing ${state.connections.length} connection${state.connections.length !== 1 ? "s" : ""}...`,
    "loading"
  );
  renderUI();

  try {
    const result = await syncToCareerCopilot(state.connections);
    state.synced = true;

    const newMsg = result.newConnections > 0
      ? ` (${result.newConnections} new)`
      : "";

    clearStatus();
    setStatus(
      `${result.synced} connection${result.synced !== 1 ? "s" : ""} synced${newMsg}`,
      "success",
      "Your network has been updated in CareerCopilot."
    );
    show(els.viewLinkArea);
  } catch (err) {
    // If token expired, prompt reconnect
    if (err.message.includes("expired") || err.message.includes("invalid")) {
      state.auth = { connected: false };
    }
    setStatus("Sync failed.", "error", err.message);
  } finally {
    state.loading = false;
    renderUI();
  }
});

// ─── Initialization ───────────────────────────────────────────────────────────
async function init() {
  // Show a brief loading state
  setStatus("Loading...", "loading");

  try {
    await checkAuthStatus();
    await detectPageType();
    clearStatus();
    renderUI();
  } catch (err) {
    clearStatus();
    setStatus("Failed to initialize extension.", "error", err.message);
    renderUI();
  }
}

// Boot
init();
