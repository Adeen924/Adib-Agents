/**
 * Feature flags for the hybrid AI pipeline.
 *
 * Two-layer flag system:
 *  1. ENV vars — fast, no Firestore read required (set at deploy time)
 *  2. Firestore admin_config/features — runtime toggle without redeployment
 *
 * ENV takes precedence for safety: if ENABLE_HYBRID_AI_PIPELINE=false the
 * hybrid path is never taken, even if Firestore says enabled.
 */

// ── ENV-level flags ───────────────────────────────────────────────────────────

const ENV_FLAGS = {
  hybridEnabled:       process.env.ENABLE_HYBRID_AI_PIPELINE     === "true",
  geminiSearchEnabled: process.env.ENABLE_GEMINI_SEARCH           === "true",
  geminiUrlEnabled:    process.env.ENABLE_GEMINI_URL_DISCOVERY    === "true",
  geminiVerifyEnabled: process.env.ENABLE_GEMINI_URL_VERIFICATION === "true",
  costTrackingEnabled: process.env.ENABLE_HYBRID_COST_TRACKING    !== "false", // on by default
};

/**
 * Resolve the full flag set for a request.
 *
 * Reads Firestore admin_config/features and merges with ENV flags.
 * ENV false always wins (safety first).
 *
 * @param {FirebaseFirestore.Firestore} db
 * @returns {Promise<HybridFlags>}
 */
async function getHybridFlags(db) {
  let firestoreFlags = {};
  try {
    const doc = await db.collection("admin_config").doc("features").get();
    if (doc.exists) firestoreFlags = doc.data() || {};
  } catch { /* non-fatal — fall back to ENV only */ }

  const flags = {
    // Master switch: both ENV and Firestore must agree
    hybridEnabled:
      ENV_FLAGS.hybridEnabled &&
      firestoreFlags.hybridPipeline !== false,

    // Sub-feature: Gemini for initial job search
    geminiSearchEnabled:
      ENV_FLAGS.geminiSearchEnabled &&
      firestoreFlags.geminiSearch !== false,

    // Sub-feature: Gemini for URL discovery
    geminiUrlDiscoveryEnabled:
      ENV_FLAGS.geminiUrlEnabled &&
      firestoreFlags.geminiUrlDiscovery !== false,

    // Sub-feature: Gemini for URL verification (replaces HTTP/ATS checks)
    geminiUrlVerificationEnabled:
      ENV_FLAGS.geminiVerifyEnabled &&
      firestoreFlags.geminiUrlVerification !== false,

    // Cost tracking for hybrid pipeline (default on)
    costTrackingEnabled:
      ENV_FLAGS.costTrackingEnabled &&
      firestoreFlags.hybridCostTracking !== false,

    // Mode selector (overrides sub-features when set)
    pipelineMode: resolvePipelineMode(firestoreFlags),

    // Pass-through: company verification profiles (existing flag)
    useCompanyProfiles: firestoreFlags.companyProfilesEnabled === true,
  };

  return flags;
}

/**
 * Determine the active pipeline mode.
 *
 * "hybrid"      — Gemini discovery + Claude reasoning (default when hybrid enabled)
 * "gemini-only" — Gemini handles everything (experimental, not recommended for prod)
 * "claude-only" — Original pipeline, Gemini disabled
 */
function resolvePipelineMode(firestoreFlags) {
  // Explicit mode override in Firestore
  if (firestoreFlags.pipelineMode === "gemini-only") return "gemini-only";
  if (firestoreFlags.pipelineMode === "claude-only")  return "claude-only";
  if (firestoreFlags.pipelineMode === "hybrid")       return "hybrid";

  // Derive from ENV
  if (!ENV_FLAGS.hybridEnabled)       return "claude-only";
  if (!ENV_FLAGS.geminiSearchEnabled) return "claude-only";
  return "hybrid";
}

/**
 * Returns true if any Gemini feature is active.
 * Used as a quick guard before initialising the Gemini client.
 */
function isGeminiEnabled() {
  return ENV_FLAGS.hybridEnabled || ENV_FLAGS.geminiSearchEnabled || ENV_FLAGS.geminiUrlEnabled;
}

/**
 * Log current flag state for debugging.
 */
function logFlags(flags, logFn) {
  if (!logFn) return;
  logFn(`[FeatureFlags] mode=${flags.pipelineMode} hybrid=${flags.hybridEnabled} geminiSearch=${flags.geminiSearchEnabled} geminiUrl=${flags.geminiUrlDiscoveryEnabled} geminiVerify=${flags.geminiUrlVerificationEnabled}`).catch(() => {});
}

module.exports = { getHybridFlags, isGeminiEnabled, logFlags };
