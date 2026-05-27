/**
 * Gemini provider base client.
 *
 * Wraps @google/generative-ai with:
 *  - retry / back-off
 *  - per-call timeout
 *  - token/cost logging to platform_events
 *  - structured console logging
 *
 * All config comes from environment variables — nothing is hard-coded.
 */

const { GoogleGenerativeAI } = require("@google/generative-ai");

// ── Pricing (per 1M tokens) ───────────────────────────────────────────────────
// Gemini 2.5 Flash (non-thinking): $0.075 input / $0.30 output
// Gemini 2.5 Pro  (non-thinking): $1.25 input  / $10 output
const GEMINI_PRICING = {
  "gemini-2.5-flash": { input: 0.075 / 1_000_000, output: 0.30  / 1_000_000 },
  "gemini-2.5-pro":   { input: 1.25  / 1_000_000, output: 10.00 / 1_000_000 },
};

// Fallback for unknown model IDs — use Flash pricing to avoid surprises
const FALLBACK_PRICING = GEMINI_PRICING["gemini-2.5-flash"];

/**
 * Resolve the price entry for a given model ID string.
 * Uses startsWith matching so e.g. "gemini-2.5-flash-preview-..." still matches.
 */
function pricingFor(modelId) {
  for (const [key, price] of Object.entries(GEMINI_PRICING)) {
    if ((modelId || "").startsWith(key)) return price;
  }
  return FALLBACK_PRICING;
}

// ── Retry helpers ─────────────────────────────────────────────────────────────
const DEFAULT_RETRIES  = 3;
const DEFAULT_TIMEOUT  = 30_000; // ms
const RETRY_BASE_DELAY = 800;   // ms, doubles each attempt

function sleep(ms) {
  return new Promise(r => setTimeout(r, ms));
}

/** True for transient errors worth retrying (rate-limit, server error, timeout). */
function isRetryable(err) {
  const msg = (err?.message || "").toLowerCase();
  const status = err?.status || err?.code;
  return (
    status === 429 ||
    status === 503 ||
    status === 502 ||
    msg.includes("rate limit") ||
    msg.includes("quota") ||
    msg.includes("timeout") ||
    msg.includes("econnreset") ||
    msg.includes("socket hang up")
  );
}

// ── GeminiClient class ────────────────────────────────────────────────────────

class GeminiClient {
  /**
   * @param {object} opts
   * @param {FirebaseFirestore.Firestore} opts.db         - Firestore instance for cost logging
   * @param {string}  [opts.searchModel]                  - Model for search/discovery calls
   * @param {string}  [opts.reasoningModel]               - Model for deeper reasoning calls
   * @param {number}  [opts.maxRetries]
   * @param {number}  [opts.timeoutMs]
   */
  constructor(opts = {}) {
    const apiKey = process.env.GEMINI_API_KEY;
    if (!apiKey) throw new Error("[GeminiClient] GEMINI_API_KEY is not set");

    this.genAI          = new GoogleGenerativeAI(apiKey);
    this.db             = opts.db || null;
    this.searchModel    = opts.searchModel    || process.env.GEMINI_SEARCH_MODEL    || "gemini-2.5-flash";
    this.reasoningModel = opts.reasoningModel || process.env.GEMINI_REASONING_MODEL || "gemini-2.5-pro";
    this.maxRetries     = opts.maxRetries ?? DEFAULT_RETRIES;
    this.timeoutMs      = opts.timeoutMs  ?? DEFAULT_TIMEOUT;
  }

  // ── Core generate call ──────────────────────────────────────────────────────

  /**
   * Generate content with automatic retries and timeout.
   *
   * @param {object} params
   * @param {string}   params.modelId        - Gemini model string
   * @param {string}   params.prompt         - User prompt text
   * @param {string}   [params.systemPrompt] - Optional system instruction
   * @param {object[]} [params.tools]        - Gemini tool declarations (e.g. [{googleSearch:{}}])
   * @param {object}   [params.generationConfig]
   * @param {string}   [params.userId]       - For cost attribution
   * @param {string}   [params.view]         - Cost view label (e.g. "gemini_search")
   * @returns {Promise<{text: string, usage: object, raw: object}>}
   */
  async generate(params) {
    const {
      modelId       = this.searchModel,
      prompt,
      systemPrompt,
      tools,
      generationConfig,
      userId,
      view = "gemini_generate",
    } = params;

    const modelConfig = {
      model: modelId,
      ...(tools            ? { tools }            : {}),
      ...(systemPrompt     ? { systemInstruction: systemPrompt } : {}),
      ...(generationConfig ? { generationConfig } : {}),
    };

    const model = this.genAI.getGenerativeModel(modelConfig);

    let lastErr;
    for (let attempt = 0; attempt <= this.maxRetries; attempt++) {
      if (attempt > 0) {
        const delay = RETRY_BASE_DELAY * Math.pow(2, attempt - 1);
        console.log(`[GeminiClient] Retry ${attempt}/${this.maxRetries} after ${delay}ms — ${lastErr?.message}`);
        await sleep(delay);
      }

      try {
        const controller = new AbortController();
        const timeoutId  = setTimeout(() => controller.abort(), this.timeoutMs);

        let result;
        try {
          result = await model.generateContent({
            contents: [{ role: "user", parts: [{ text: prompt }] }],
          });
        } finally {
          clearTimeout(timeoutId);
        }

        const response  = result.response;
        const text      = response.text?.() ?? "";
        const usageMeta = response.usageMetadata || {};

        const usage = {
          inputTokens:  usageMeta.promptTokenCount     || 0,
          outputTokens: usageMeta.candidatesTokenCount || 0,
          totalTokens:  usageMeta.totalTokenCount      || 0,
          groundingChunks: (response.candidates?.[0]?.groundingMetadata?.groundingChunks?.length) || 0,
        };

        this._trackCost(userId, view, modelId, usage);

        console.log(`[GeminiClient] ${view} — model=${modelId} in=${usage.inputTokens} out=${usage.outputTokens} grounding=${usage.groundingChunks}`);

        return { text, usage, raw: response };
      } catch (err) {
        lastErr = err;
        if (!isRetryable(err) || attempt === this.maxRetries) break;
      }
    }

    console.error(`[GeminiClient] All ${this.maxRetries + 1} attempts failed for view=${view}: ${lastErr?.message}`);
    throw lastErr;
  }

  // ── Cost tracking ───────────────────────────────────────────────────────────

  _trackCost(userId, view, modelId, usage) {
    if (!this.db || !userId) return;
    const { input, output } = pricingFor(modelId);
    const cost = (usage.inputTokens * input) + (usage.outputTokens * output);
    this.db.collection("platform_events").add({
      userId,
      view,
      provider: "gemini",
      model: modelId,
      inputTokens:  usage.inputTokens,
      outputTokens: usage.outputTokens,
      cost,
      groundingChunks: usage.groundingChunks || 0,
      createdAt: require("firebase-admin").firestore.FieldValue.serverTimestamp(),
    }).catch(() => {});
  }

  // ── Convenience accessors ───────────────────────────────────────────────────

  /** Return a model instance configured for search/grounding use. */
  getSearchModel() {
    return this.genAI.getGenerativeModel({
      model: this.searchModel,
      tools: [{ googleSearch: {} }],
    });
  }

  /** Return a model instance configured for structured reasoning (no grounding). */
  getReasoningModel() {
    return this.genAI.getGenerativeModel({ model: this.reasoningModel });
  }
}

module.exports = { GeminiClient, pricingFor };
