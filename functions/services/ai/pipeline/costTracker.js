/**
 * Hybrid pipeline cost tracker.
 *
 * Provides side-by-side analytics comparing:
 *  - OLD pipeline (Claude-only)
 *  - NEW hybrid pipeline (Gemini discovery + Claude reasoning)
 *
 * Writes to platform_events with a pipeline_session field linking
 * all calls from a single search run. This lets you query:
 *   - Total cost per session
 *   - Gemini vs Claude split
 *   - Retry count
 *   - URL accuracy rate
 */

const admin = require("firebase-admin");

// ── Pricing ───────────────────────────────────────────────────────────────────
const PRICING = {
  // Claude
  "claude-sonnet-4-6":          { input: 3    / 1_000_000, output: 15   / 1_000_000 },
  "claude-haiku-4-5-20251001":  { input: 0.80 / 1_000_000, output: 4    / 1_000_000 },
  // Gemini
  "gemini-2.5-flash":           { input: 0.075 / 1_000_000, output: 0.30 / 1_000_000 },
  "gemini-2.5-pro":             { input: 1.25  / 1_000_000, output: 10   / 1_000_000 },
};

function priceFor(modelId) {
  for (const [key, p] of Object.entries(PRICING)) {
    if ((modelId || "").startsWith(key)) return p;
  }
  return PRICING["gemini-2.5-flash"];
}

// ── Session tracker ───────────────────────────────────────────────────────────

/**
 * Create a new cost tracking session for a single search run.
 *
 * @param {object} db               - Firestore
 * @param {string} userId
 * @param {string} pipelineMode     - "hybrid" | "claude-only"
 * @param {string} query
 * @returns {CostSession}
 */
function createSession(db, userId, pipelineMode, query) {
  const sessionId = `${userId}_${Date.now()}`;
  return new CostSession(db, userId, sessionId, pipelineMode, query);
}

class CostSession {
  constructor(db, userId, sessionId, pipelineMode, query) {
    this.db           = db;
    this.userId       = userId;
    this.sessionId    = sessionId;
    this.pipelineMode = pipelineMode;
    this.query        = query;
    this.startedAt    = Date.now();

    // Accumulators
    this.geminiCost    = 0;
    this.claudeCost    = 0;
    this.totalRetries  = 0;
    this.failedSearches = 0;
    this.candidatesFound = 0;
    this.urlsVerified  = 0;
    this.urlsRejected  = 0;
    this.finalJobs     = 0;
    this.calls         = [];
  }

  /**
   * Record a single AI call.
   *
   * @param {string} provider   - "gemini" | "claude"
   * @param {string} view       - e.g. "gemini_search_pass1", "claude_hybrid_rank"
   * @param {string} modelId
   * @param {object} usage      - { inputTokens, outputTokens } or Anthropic usage object
   * @param {object} [meta]     - Additional metadata (retries, confidence, etc.)
   */
  recordCall(provider, view, modelId, usage, meta = {}) {
    const inputTokens  = usage.inputTokens  || usage.input_tokens  || 0;
    const outputTokens = usage.outputTokens || usage.output_tokens || 0;
    const { input, output } = priceFor(modelId);
    const cost = (inputTokens * input) + (outputTokens * output);

    if (provider === "gemini")  this.geminiCost += cost;
    if (provider === "claude")  this.claudeCost += cost;
    if (meta.retries)           this.totalRetries += meta.retries;

    this.calls.push({
      provider,
      view,
      model: modelId,
      inputTokens,
      outputTokens,
      cost,
      ...meta,
      ts: Date.now(),
    });

    if (this.db && this.userId) {
      this.db.collection("platform_events").add({
        userId:         this.userId,
        view,
        provider,
        model:          modelId,
        inputTokens,
        outputTokens,
        cost,
        pipelineSession: this.sessionId,
        pipelineMode:   this.pipelineMode,
        ...meta,
        createdAt: admin.firestore.FieldValue.serverTimestamp(),
      }).catch(() => {});
    }
  }

  /**
   * Set final search outcome metrics.
   */
  setOutcome({ candidatesFound, urlsVerified, urlsRejected, finalJobs, failedSearches }) {
    this.candidatesFound  = candidatesFound  ?? this.candidatesFound;
    this.urlsVerified     = urlsVerified     ?? this.urlsVerified;
    this.urlsRejected     = urlsRejected     ?? this.urlsRejected;
    this.finalJobs        = finalJobs        ?? this.finalJobs;
    this.failedSearches   = failedSearches   ?? this.failedSearches;
  }

  /**
   * Persist the session summary to Firestore.
   * Call at the end of a search run.
   */
  async flush() {
    if (!this.db || !this.userId) return;
    const durationMs = Date.now() - this.startedAt;
    try {
      await this.db.collection("pipeline_sessions").add({
        userId:          this.userId,
        sessionId:       this.sessionId,
        pipelineMode:    this.pipelineMode,
        query:           this.query,
        durationMs,
        geminiCost:      this.geminiCost,
        claudeCost:      this.claudeCost,
        totalCost:       this.geminiCost + this.claudeCost,
        totalRetries:    this.totalRetries,
        failedSearches:  this.failedSearches,
        candidatesFound: this.candidatesFound,
        urlsVerified:    this.urlsVerified,
        urlsRejected:    this.urlsRejected,
        finalJobs:       this.finalJobs,
        urlAccuracyRate: this.urlsVerified > 0
          ? (this.urlsVerified / (this.urlsVerified + this.urlsRejected))
          : null,
        createdAt: admin.firestore.FieldValue.serverTimestamp(),
      });
    } catch (err) {
      console.error("[CostTracker] Failed to flush session:", err.message);
    }
  }

  /** Human-readable summary for logging. */
  summary() {
    return [
      `[CostSession] mode=${this.pipelineMode}`,
      `gemini=$${this.geminiCost.toFixed(5)}`,
      `claude=$${this.claudeCost.toFixed(5)}`,
      `total=$${(this.geminiCost + this.claudeCost).toFixed(5)}`,
      `candidates=${this.candidatesFound}`,
      `verified=${this.urlsVerified}`,
      `rejected=${this.urlsRejected}`,
      `final=${this.finalJobs}`,
      `retries=${this.totalRetries}`,
    ].join(" ");
  }
}

/**
 * Fetch aggregate comparison stats for the dashboard.
 *
 * @param {object} db
 * @param {string} userId
 * @param {string} [sinceDate]   - ISO date string, defaults to last 30 days
 * @returns {Promise<ComparisonStats>}
 */
async function getComparisonStats(db, userId, sinceDate) {
  const since = sinceDate ? new Date(sinceDate) : (() => {
    const d = new Date();
    d.setDate(d.getDate() - 30);
    return d;
  })();

  try {
    const snap = await db.collection("pipeline_sessions")
      .where("userId", "==", userId)
      .where("createdAt", ">=", since)
      .get();

    const sessions = snap.docs.map(d => d.data());

    const hybrid    = sessions.filter(s => s.pipelineMode === "hybrid");
    const claudeOnly = sessions.filter(s => s.pipelineMode === "claude-only");

    return {
      hybrid:    _aggregateStats(hybrid),
      claudeOnly: _aggregateStats(claudeOnly),
      estimatedSavingsPercent: _savingsPercent(hybrid, claudeOnly),
    };
  } catch (err) {
    console.error("[CostTracker] getComparisonStats error:", err.message);
    return { hybrid: null, claudeOnly: null, estimatedSavingsPercent: null };
  }
}

function _aggregateStats(sessions) {
  if (!sessions.length) return null;
  const n = sessions.length;
  return {
    count:             n,
    avgTotalCost:      avg(sessions, "totalCost"),
    avgGeminiCost:     avg(sessions, "geminiCost"),
    avgClaudeCost:     avg(sessions, "claudeCost"),
    avgDurationMs:     avg(sessions, "durationMs"),
    avgFinalJobs:      avg(sessions, "finalJobs"),
    avgUrlAccuracy:    avg(sessions.filter(s => s.urlAccuracyRate != null), "urlAccuracyRate"),
    avgRetries:        avg(sessions, "totalRetries"),
  };
}

function avg(arr, field) {
  if (!arr.length) return null;
  return arr.reduce((s, o) => s + (o[field] || 0), 0) / arr.length;
}

function _savingsPercent(hybrid, claudeOnly) {
  const hCost = avg(hybrid, "totalCost");
  const cCost = avg(claudeOnly, "totalCost");
  if (!hCost || !cCost) return null;
  return Math.round(((cCost - hCost) / cCost) * 100);
}

module.exports = { createSession, getComparisonStats };
