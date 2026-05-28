/**
 * Gemini provider base client.
 *
 * Uses @google/genai (the new unified Google AI SDK) which properly supports
 * Google Search grounding for Gemini 2.5 Flash/Pro.
 */

const { GoogleGenAI } = require("@google/genai");
const { FieldValue }  = require("firebase-admin/firestore");

// ── Pricing (per 1M tokens) ───────────────────────────────────────────────────
const GEMINI_PRICING = {
  "gemini-2.5-flash": { input: 0.075 / 1_000_000, output: 0.30  / 1_000_000 },
  "gemini-2.5-pro":   { input: 1.25  / 1_000_000, output: 10.00 / 1_000_000 },
};

function pricingFor(modelId) {
  for (const [key, price] of Object.entries(GEMINI_PRICING)) {
    if ((modelId || "").startsWith(key)) return price;
  }
  return GEMINI_PRICING["gemini-2.5-flash"];
}

// ── Retry helpers ─────────────────────────────────────────────────────────────
const DEFAULT_RETRIES  = 3;
const RETRY_BASE_DELAY = 800;

function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }

function isRetryable(err) {
  const msg    = (err?.message || "").toLowerCase();
  const status = err?.status || err?.code;
  return (
    status === 429 || status === 503 || status === 502 ||
    msg.includes("rate limit") || msg.includes("quota") ||
    msg.includes("timeout")    || msg.includes("econnreset")
  );
}

// ── GeminiClient ──────────────────────────────────────────────────────────────

class GeminiClient {
  /**
   * @param {object} opts
   * @param {FirebaseFirestore.Firestore} opts.db
   * @param {string}  [opts.searchModel]
   * @param {string}  [opts.reasoningModel]
   * @param {number}  [opts.maxRetries]
   */
  constructor(opts = {}) {
    const apiKey = process.env.GEMINI_API_KEY;
    if (!apiKey) throw new Error("[GeminiClient] GEMINI_API_KEY is not set");

    this.ai             = new GoogleGenAI({ apiKey });
    this.db             = opts.db             || null;
    // gemini-2.5-flash: use { googleSearch: {} } tool to force grounding
    this.searchModel    = opts.searchModel    || process.env.GEMINI_SEARCH_MODEL    || "gemini-2.5-flash";
    this.reasoningModel = opts.reasoningModel || process.env.GEMINI_REASONING_MODEL || "gemini-2.5-flash";
    this.maxRetries     = opts.maxRetries     ?? DEFAULT_RETRIES;
  }

  /**
   * Generate content with automatic retries.
   *
   * @param {object} params
   * @param {string}   params.modelId
   * @param {string}   params.prompt
   * @param {string}   [params.systemPrompt]
   * @param {object[]} [params.tools]          - e.g. [{ googleSearch: {} }]
   * @param {string}   [params.userId]
   * @param {string}   [params.view]
   * @returns {Promise<{text: string, usage: object, raw: object}>}
   */
  async generate(params) {
    const {
      modelId       = this.searchModel,
      prompt,
      systemPrompt,
      tools,
      userId,
      view = "gemini_generate",
    } = params;

    // Build config for the new SDK
    const config = {};
    if (systemPrompt) config.systemInstruction = systemPrompt;
    if (tools)        config.tools             = tools;

    let lastErr;
    for (let attempt = 0; attempt <= this.maxRetries; attempt++) {
      if (attempt > 0) {
        const delay = RETRY_BASE_DELAY * Math.pow(2, attempt - 1);
        console.log(`[GeminiClient] Retry ${attempt}/${this.maxRetries} after ${delay}ms — ${lastErr?.message}`);
        await sleep(delay);
      }

      try {
        const response = await this.ai.models.generateContent({
          model:    modelId,
          contents: prompt,
          config,
        });

        const text      = response.text || "";
        const candidate = response.candidates?.[0];

        // Debug: log candidate keys so we can see where grounding metadata lives
        if (candidate) {
          const keys = Object.keys(candidate);
          const hasMeta = keys.includes("groundingMetadata");
          if (!hasMeta) {
            console.log(`[GeminiClient] DEBUG candidate keys: ${keys.join(", ")}`);
          }
        }

        const groundingMeta   = candidate?.groundingMetadata;
        const groundingChunks = groundingMeta?.groundingChunks?.length
          || groundingMeta?.webSearchQueries?.length
          || 0;

        const usage = {
          inputTokens:    response.usageMetadata?.promptTokenCount     || 0,
          outputTokens:   response.usageMetadata?.candidatesTokenCount || 0,
          totalTokens:    response.usageMetadata?.totalTokenCount      || 0,
          groundingChunks,
        };

        this._trackCost(userId, view, modelId, usage);
        console.log(`[GeminiClient] ${view} model=${modelId} in=${usage.inputTokens} out=${usage.outputTokens} grounding=${groundingChunks} webQueries=${groundingMeta?.webSearchQueries?.length || 0}`);

        return { text, usage, raw: response };
      } catch (err) {
        lastErr = err;
        if (!isRetryable(err) || attempt === this.maxRetries) break;
      }
    }

    console.error(`[GeminiClient] All ${this.maxRetries + 1} attempts failed for ${view}: ${lastErr?.message}`);
    throw lastErr;
  }

  // ── Cost tracking ─────────────────────────────────────────────────────────

  _trackCost(userId, view, modelId, usage) {
    if (!this.db || !userId) return;
    const { input, output } = pricingFor(modelId);
    const cost = (usage.inputTokens * input) + (usage.outputTokens * output);
    this.db.collection("platform_events").add({
      userId,
      view,
      provider:       "gemini",
      model:          modelId,
      inputTokens:    usage.inputTokens,
      outputTokens:   usage.outputTokens,
      cost,
      groundingChunks: usage.groundingChunks || 0,
      createdAt:      FieldValue.serverTimestamp(),
    }).catch(() => {});
  }
}

module.exports = { GeminiClient, pricingFor };
