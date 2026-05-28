/**
 * CareerCopilot Network Intelligence — Background Service Worker
 * Manifest V3 — stateless, event-driven
 */

const BACKEND_URL = "https://us-central1-adib-job-agent.cloudfunctions.net/api";

// ─── Install handler ──────────────────────────────────────────────────────────
chrome.runtime.onInstalled.addListener(({ reason }) => {
  if (reason === "install") {
    chrome.storage.local.set({
      extensionToken: null,
      expiresAt: null,
      userEmail: null,
      installDate: new Date().toISOString(),
    });
    console.log("[CareerCopilot] Extension installed. Default storage set.");
  }
});

// ─── Message handler ──────────────────────────────────────────────────────────
chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  switch (message.type) {
    case "GET_AUTH":
      handleGetAuth(sendResponse);
      return true; // keep channel open for async

    case "SAVE_TOKEN":
      handleSaveToken(message.payload, sendResponse);
      return true;

    case "CLEAR_TOKEN":
      handleClearToken(sendResponse);
      return true;

    default:
      sendResponse({ success: false, error: "Unknown message type" });
      return false;
  }
});

// ─── Auth handlers ────────────────────────────────────────────────────────────
async function handleGetAuth(sendResponse) {
  try {
    const data = await chrome.storage.local.get([
      "extensionToken",
      "expiresAt",
      "userEmail",
    ]);

    const hasToken = Boolean(data.extensionToken);
    const isExpired = data.expiresAt
      ? new Date(data.expiresAt) < new Date()
      : false;

    sendResponse({
      success: true,
      auth: {
        connected: hasToken && !isExpired,
        token: hasToken && !isExpired ? data.extensionToken : null,
        userEmail: data.userEmail || null,
        expiresAt: data.expiresAt || null,
        expired: isExpired,
      },
    });
  } catch (err) {
    console.error("[CareerCopilot] GET_AUTH error:", err);
    sendResponse({ success: false, error: err.message });
  }
}

async function handleSaveToken(payload, sendResponse) {
  try {
    if (!payload || !payload.token) {
      sendResponse({ success: false, error: "Token is required" });
      return;
    }

    const { token, expiresAt, userEmail } = payload;

    // Basic token format validation (non-empty string, reasonable length)
    if (typeof token !== "string" || token.trim().length < 10) {
      sendResponse({ success: false, error: "Invalid token format" });
      return;
    }

    await chrome.storage.local.set({
      extensionToken: token.trim(),
      expiresAt: expiresAt || null,
      userEmail: userEmail || null,
      savedAt: new Date().toISOString(),
    });

    console.log("[CareerCopilot] Token saved for:", userEmail || "unknown user");
    sendResponse({ success: true });
  } catch (err) {
    console.error("[CareerCopilot] SAVE_TOKEN error:", err);
    sendResponse({ success: false, error: err.message });
  }
}

async function handleClearToken(sendResponse) {
  try {
    await chrome.storage.local.set({
      extensionToken: null,
      expiresAt: null,
      userEmail: null,
    });
    console.log("[CareerCopilot] Token cleared.");
    sendResponse({ success: true });
  } catch (err) {
    console.error("[CareerCopilot] CLEAR_TOKEN error:", err);
    sendResponse({ success: false, error: err.message });
  }
}

// ─── Tab update handler ───────────────────────────────────────────────────────
// Update badge when user navigates to/from LinkedIn
chrome.tabs.onUpdated.addListener(async (tabId, changeInfo, tab) => {
  if (changeInfo.status !== "complete") return;
  if (!tab.url) return;

  const isLinkedIn = tab.url.startsWith("https://www.linkedin.com/");

  try {
    if (isLinkedIn) {
      const data = await chrome.storage.local.get(["extensionToken", "expiresAt"]);
      const isConnected =
        Boolean(data.extensionToken) &&
        (!data.expiresAt || new Date(data.expiresAt) > new Date());

      await chrome.action.setBadgeText({
        tabId,
        text: isConnected ? "●" : "!",
      });
      await chrome.action.setBadgeBackgroundColor({
        tabId,
        color: isConnected ? "#f0c040" : "#e53e3e",
      });
    } else {
      await chrome.action.setBadgeText({ tabId, text: "" });
    }
  } catch (_err) {
    // Tab may have been closed; ignore
  }
});
