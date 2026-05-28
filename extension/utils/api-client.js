/**
 * CareerCopilot — API Client Utility
 * Handles all communication with the CareerCopilot backend.
 */

const BACKEND_URL =
  "https://us-central1-adib-job-agent.cloudfunctions.net/api";

class ApiClient {
  /**
   * @param {string} token - The extension token for authentication
   */
  constructor(token) {
    this.token = token;
    this.baseUrl = BACKEND_URL;
  }

  /**
   * Build common request headers
   * @returns {Record<string, string>}
   */
  _headers() {
    return {
      "Content-Type": "application/json",
      "X-Extension-Token": this.token,
    };
  }

  /**
   * Sync extracted connections to CareerCopilot backend
   * @param {ExtractedConnection[]} connections
   * @returns {Promise<{ synced: number, message: string }>}
   */
  async syncConnections(connections) {
    if (!this.token) {
      throw new Error("No authentication token. Please connect the extension first.");
    }
    if (!Array.isArray(connections) || connections.length === 0) {
      throw new Error("No connections to sync.");
    }

    const url = `${this.baseUrl}/network/extension/sync`;

    let response;
    try {
      response = await fetch(url, {
        method: "POST",
        headers: this._headers(),
        body: JSON.stringify({ connections }),
      });
    } catch (networkErr) {
      throw new Error(
        `Network error: ${networkErr.message}. Check your internet connection.`
      );
    }

    if (response.status === 401) {
      throw new Error(
        "Token expired or invalid. Please reconnect the extension in CareerCopilot Settings."
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
      } catch (_) {
        // ignore JSON parse errors on error body
      }
      throw new Error(errorMsg);
    }

    const data = await response.json();
    return {
      synced: data.synced ?? connections.length,
      message: data.message ?? "Connections synced successfully.",
      newConnections: data.newConnections ?? 0,
    };
  }

  /**
   * Load the current token from chrome.storage
   * @returns {Promise<string|null>}
   */
  async getToken() {
    return new Promise((resolve) => {
      chrome.storage.local.get(["extensionToken", "expiresAt"], (data) => {
        if (chrome.runtime.lastError) {
          resolve(null);
          return;
        }
        if (!data.extensionToken) {
          resolve(null);
          return;
        }
        // Check expiry
        if (data.expiresAt && new Date(data.expiresAt) < new Date()) {
          resolve(null);
          return;
        }
        resolve(data.extensionToken);
      });
    });
  }

  /**
   * Factory method — creates an ApiClient with token loaded from storage
   * @returns {Promise<ApiClient>}
   */
  static async create() {
    const tempClient = new ApiClient(null);
    const token = await tempClient.getToken();
    return new ApiClient(token);
  }
}

// Export for both module and global usage
if (typeof module !== "undefined" && module.exports) {
  module.exports = { ApiClient, BACKEND_URL };
} else {
  window.ApiClient = ApiClient;
  window.BACKEND_URL = BACKEND_URL;
}
