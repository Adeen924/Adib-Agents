/**
 * Hybrid AI pipeline orchestrator.
 *
 * Coordinates:
 *   Phase 1 — Gemini grounded search (job discovery)
 *   Phase 2 — Gemini URL discovery/verification
 *   Phase 3 — Claude reasoning (ranking, deduplication, quality scoring)
 *
 * Fully isolated from the existing Claude-only pipeline.
 * Called only when ENABLE_HYBRID_AI_PIPELINE=true (via feature flags).
 *
 * If any Gemini phase fails, the pipeline falls back gracefully to the
 * Claude-only path in index.js (caller is responsible for the fallback).
 */

const { GeminiClient }           = require("../providers/gemini/client");
const { discoverJobs, discoverJobsPass2 } = require("../providers/gemini/search");
const { discoverUrlsForJobs }    = require("../providers/gemini/urlDiscovery");
const { batchVerifyUrls }        = require("../providers/gemini/verifyJobUrl");
const { rankCandidates, deduplicateCandidates } = require("../providers/claude/reasoner");
const { createSession }          = require("./costTracker");
const { getHybridFlags, logFlags } = require("./featureFlags");

// Min verified jobs before we accept the result (matches MIN_RESULT_TARGET in index.js)
const MIN_RESULT_TARGET = 3;

// Max candidates from Gemini before ranking
const MAX_HYBRID_CANDIDATES = parseInt(process.env.HYBRID_SEARCH_MAX_RESULTS || "10", 10);

// Final jobs to return
const FINAL_RESULTS = parseInt(process.env.HYBRID_FINAL_RESULTS || "3", 10);

// Confidence threshold below which a Gemini candidate is filtered pre-ranking
const MIN_CANDIDATE_CONFIDENCE = 0.4;

/**
 * Run the hybrid Gemini+Claude job search pipeline.
 *
 * @param {object} params
 * @param {string}   params.userId
 * @param {object}   params.prefs             - User search preferences
 * @param {string}   params.tier              - "free" | "pro"
 * @param {string}   params.query             - Built search query string
 * @param {string}   params.candidateProfile  - Full profile text for Claude ranking
 * @param {string}   params.criteria          - Criteria string (role, location, salary…)
 * @param {Set}      params.seenFingerprints  - Already-seen job fingerprints
 * @param {object[]} params.recentJobs        - Jobs found this week (hint for Gemini)
 * @param {string[]} params.staleUrls         - Known dead URLs
 * @param {object}   params.db                - Firestore
 * @param {object}   params.anthropic         - Anthropic SDK instance
 * @param {number}   params.jobCount          - Tier-based max final jobs
 * @param {Function} [params.logFn]           - Optional async log function
 *
 * @returns {Promise<{jobs: object[], session: CostSession}>}
 *   jobs: verified, ranked jobs in the same schema as the Claude-only pipeline
 *   session: cost tracking session (caller calls session.flush() after saving)
 * @throws {Error} if Gemini is not configured (GEMINI_API_KEY missing)
 */
async function runHybridSearch(params) {
  const {
    userId,
    prefs,
    tier,
    query,
    candidateProfile,
    criteria,
    seenFingerprints,
    recentJobs,
    staleUrls,
    db,
    anthropic,
    jobCount,
    logFn,
  } = params;

  const log = (msg) => { if (logFn) logFn(msg).catch(() => {}); };

  // ── Resolve feature flags ─────────────────────────────────────────────────
  const flags = await getHybridFlags(db);
  logFlags(flags, logFn);

  if (!flags.hybridEnabled) {
    throw new Error("[HybridPipeline] Hybrid pipeline disabled by feature flags");
  }

  const session = createSession(db, userId, "hybrid", query);

  // ── Initialise Gemini client ──────────────────────────────────────────────
  let geminiClient;
  try {
    geminiClient = new GeminiClient({ db, userId });
  } catch (err) {
    throw new Error(`[HybridPipeline] Cannot initialise Gemini client: ${err.message}`);
  }

  const finalJobCount = Math.min(jobCount, FINAL_RESULTS);
  let allCandidates   = [];

  // ── Phase 1: Gemini job discovery ─────────────────────────────────────────
  log(`[HybridPipeline] Phase 1: Gemini discovery for "${query}"…`);
  try {
    const discovered = await discoverJobs({
      query,
      prefs,
      tier,
      geminiClient,
      userId,
      staleUrls: [...(staleUrls || [])].slice(0, 40),
      recentJobs,
      logFn,
    });
    log(`[HybridPipeline] Phase 1: ${discovered.length} candidates from Gemini`);
    allCandidates = discovered;
  } catch (err) {
    log(`[HybridPipeline] Phase 1 FAILED: ${err.message}`);
    console.error("[HybridPipeline] Phase 1 error:", err.message);
    session.failedSearches++;
    throw new Error(`Gemini discovery failed: ${err.message}`);
  }

  // ── Pass 2: if < MIN_RESULT_TARGET valid candidates ───────────────────────
  const highConfidenceCandidates = allCandidates.filter(j => (j.confidence || 0) >= MIN_CANDIDATE_CONFIDENCE);
  if (highConfidenceCandidates.length < MIN_RESULT_TARGET) {
    log(`[HybridPipeline] Only ${highConfidenceCandidates.length} high-confidence candidates — running Pass 2…`);
    try {
      const pass2 = await discoverJobsPass2({
        query,
        prefs,
        tier,
        geminiClient,
        userId,
        alreadyFound: allCandidates,
        recentJobs,
        logFn,
      });
      allCandidates = [...allCandidates, ...pass2];
      log(`[HybridPipeline] Pass 2: +${pass2.length} candidates (${allCandidates.length} total)`);
    } catch (err) {
      log(`[HybridPipeline] Pass 2 failed (non-fatal): ${err.message}`);
    }
  }

  // ── Deduplicate & filter low-confidence candidates ────────────────────────
  allCandidates = deduplicateCandidates(allCandidates);
  allCandidates = allCandidates.filter(j => {
    // Must have URL and basic info
    if (!j.url && !j.possibleJobUrl) return false;
    if (!j.title || !j.company)      return false;
    // Drop already-seen jobs
    const fp = _makeFingerprint(j);
    if (seenFingerprints.has(fp)) return false;
    seenFingerprints.add(fp);
    return true;
  });



  session.setOutcome({ candidatesFound: allCandidates.length });
  log(`[HybridPipeline] ${allCandidates.length} unique candidates after dedup/filter`);

  if (allCandidates.length === 0) {
    log("[HybridPipeline] No valid candidates found — pipeline returning empty");
    await session.flush();
    return { jobs: [], session };
  }

  // ── Phase 2: Gemini URL verification ─────────────────────────────────────
  let verifiedCandidates = allCandidates;
  if (flags.geminiUrlVerificationEnabled) {
    log(`[HybridPipeline] Phase 2: Verifying ${allCandidates.length} URLs with Gemini…`);
    try {
      verifiedCandidates = await batchVerifyUrls(allCandidates, geminiClient, userId, logFn);
      const goodCount = verifiedCandidates.filter(j => j.urlVerified).length;
      log(`[HybridPipeline] Phase 2: ${goodCount}/${allCandidates.length} URLs verified`);
      session.setOutcome({
        urlsVerified: goodCount,
        urlsRejected: allCandidates.length - goodCount,
      });
    } catch (err) {
      log(`[HybridPipeline] Phase 2 URL verification failed (non-fatal): ${err.message}`);
      // Non-fatal — pass all candidates to ranking even without verification
      verifiedCandidates = allCandidates.map(j => ({
        ...j,
        urlVerified:        true,
        applyUrlConfidence: j.confidence || 0.5,
      }));
    }
  } else {
    // URL verification disabled — trust Gemini's confidence scores
    log("[HybridPipeline] Phase 2: URL verification disabled — using Gemini confidence");
    verifiedCandidates = allCandidates.map(j => ({
      ...j,
      urlVerified:        (j.confidence || 0) >= 0.5,
      applyUrlConfidence: j.confidence || 0.5,
    }));
  }

  // URL discovery for low-confidence items and aggregator-domain jobs
  if (flags.geminiUrlDiscoveryEnabled) {
    const needsDiscovery = verifiedCandidates.filter(j => !j.urlVerified || j.needsDiscovery || (j.applyUrlConfidence || 0) < 0.6);
    if (needsDiscovery.length > 0) {
      log(`[HybridPipeline] URL discovery: refining ${needsDiscovery.length} uncertain URLs…`);
      try {
        const refined = await discoverUrlsForJobs(needsDiscovery, geminiClient, userId, logFn);
        // Merge refined URLs back — if discovery found a confident URL, treat the job as verified
        const refinedMap = new Map(refined.map(j => [_makeFingerprint(j), j]));
        verifiedCandidates = verifiedCandidates.map(j => {
          const fp = _makeFingerprint(j);
          if (!refinedMap.has(fp)) return j;
          const r = refinedMap.get(fp);
          const discoveryConf = r.urlDiscoveryConfidence || 0;
          return {
            ...j,
            ...r,
            // Upgrade verification status if discovery found a good URL
            urlVerified:        j.urlVerified || discoveryConf >= 0.7,
            applyUrlConfidence: Math.max(j.applyUrlConfidence || 0, discoveryConf),
          };
        });
      } catch (err) {
        log(`[HybridPipeline] URL discovery failed (non-fatal): ${err.message}`);
      }
    }
  }

  // Only pass verified (or reasonably confident) candidates to Claude
  const rankingPool = verifiedCandidates.filter(j => j.urlVerified || (j.applyUrlConfidence || 0) >= 0.5);
  log(`[HybridPipeline] ${rankingPool.length} candidates entering Claude ranking…`);

  // ── Phase 3: Claude ranking & quality scoring ─────────────────────────────
  let finalJobs;
  try {
    finalJobs = await rankCandidates({
      candidates:       rankingPool.slice(0, MAX_HYBRID_CANDIDATES),
      candidateProfile,
      criteria,
      jobCount:         finalJobCount,
      anthropic,
      db,
      userId,
      logFn,
    });
    log(`[HybridPipeline] Phase 3: Claude ranked ${finalJobs.length} final jobs`);
  } catch (err) {
    log(`[HybridPipeline] Phase 3 ranking failed (graceful fallback): ${err.message}`);
    // Fall back: order by applyUrlConfidence, keep top N
    finalJobs = rankingPool
      .sort((a, b) => (b.applyUrlConfidence || 0) - (a.applyUrlConfidence || 0))
      .slice(0, finalJobCount)
      .map(j => ({
        ...j,
        fitScore:     Math.round((j.applyUrlConfidence || 0.5) * 100),
        matchReasons: ["Ranked by search confidence"],
      }));
  }

  finalJobs = _enrichJobs(finalJobs);

  session.setOutcome({ finalJobs: finalJobs.length });
  log(`[HybridPipeline] Complete — ${finalJobs.length} jobs | ${session.summary()}`);

  return { jobs: finalJobs, session };
}

// ── Helpers ───────────────────────────────────────────────────────────────────

function _makeFingerprint(job) {
  const title   = (job.title   || "").toLowerCase().replace(/\s+/g, " ").trim();
  const company = (job.company || "").toLowerCase().replace(/[^a-z0-9]/g, "");
  return `${title}__${company}`;
}

/**
 * Infer experience level from job title when the field is missing or empty.
 * Returns the existing value if non-empty, otherwise guesses from title keywords.
 */
function _inferExperienceLevel(title, existingExperience) {
  if (existingExperience && existingExperience.trim()) return existingExperience.trim();
  const t = (title || "").toLowerCase();
  if (/\b(engineer i{1,2}|level i{1,2}|\bi\b|\bii\b|entry[\s-]?level|junior|jr\.?|new\s*grad|associate(?! director| principal))\b/.test(t)) return "Entry Level";
  if (/\b(engineer\s*iii|level\s*iii|\biii\b|mid[\s-]?level|intermediate)\b/.test(t)) return "Mid Level";
  if (/\b(senior|sr\.?|lead|principal|staff|distinguished|fellow)\b/.test(t)) return "Senior";
  if (/\b(director|vp|vice\s*president|head\s*of|manager)\b/.test(t)) return "Manager / Director";
  return "";
}

/**
 * Enrich final jobs with inferred fields that Gemini may have omitted.
 */
function _enrichJobs(jobs) {
  return jobs.map(j => ({
    ...j,
    experience: _inferExperienceLevel(j.title, j.experience),
  }));
}

module.exports = { runHybridSearch };
