/**
 * Claude reasoning provider.
 *
 * Thin abstraction over the Anthropic SDK for the reasoning/ranking phase
 * of the hybrid pipeline. Claude receives pre-filtered Gemini candidates
 * and applies:
 *  - deduplication
 *  - relevance ranking
 *  - quality scoring
 *  - final filtering
 *
 * This keeps Claude's token usage focused on intelligence tasks,
 * not brute-force discovery.
 */

const MODEL_HAIKU  = "claude-haiku-4-5-20251001";
const MODEL_SONNET = "claude-sonnet-4-6";

// Cost constants (matching index.js)
const INPUT_COST_SONNET  = 3    / 1_000_000;
const OUTPUT_COST_SONNET = 15   / 1_000_000;
const INPUT_COST_HAIKU   = 0.80 / 1_000_000;
const OUTPUT_COST_HAIKU  = 4    / 1_000_000;

/**
 * Rank and score Gemini-discovered job candidates using Claude.
 *
 * Claude receives only the structured candidates (no raw web content),
 * so token usage is dramatically lower than Claude-only search.
 *
 * @param {object} params
 * @param {object[]}   params.candidates      - Structured job candidates from Gemini
 * @param {string}     params.candidateProfile - User profile text
 * @param {string}     params.criteria         - Hard filter criteria string
 * @param {number}     params.jobCount         - Final number of jobs to return
 * @param {object}     params.anthropic         - Anthropic SDK instance
 * @param {object}     params.db               - Firestore for cost tracking
 * @param {string}     params.userId
 * @param {Function}   [params.logFn]
 * @returns {Promise<object[]>} Top-ranked, deduplicated candidates
 */
async function rankCandidates(params) {
  const {
    candidates,
    candidateProfile,
    criteria,
    jobCount,
    anthropic,
    db,
    userId,
    logFn,
  } = params;

  const log = (msg) => { if (logFn) logFn(msg).catch(() => {}); };

  if (!candidates || candidates.length === 0) {
    log("[ClaudeReasoner] No candidates to rank");
    return [];
  }

  log(`[ClaudeReasoner] Ranking ${candidates.length} Gemini candidates with Claude…`);

  const jobList = candidates.map((j, i) =>
    `JOB ${i}:\nTitle: ${j.title}\nCompany: ${j.company}\nLocation: ${j.location}\n${j.salary ? `Salary: ${j.salary}\n` : ""}${j.experience ? `Experience: ${j.experience}\n` : ""}Description: ${(j.description || "").slice(0, 600)}\nURL: ${j.url || j.possibleJobUrl}\nGemini confidence: ${j.applyUrlConfidence ?? j.confidence ?? "?"}`
  ).join("\n\n");

  const prompt = `You are a job matching expert. Score and rank these pre-filtered job candidates for this specific candidate.

CANDIDATE PROFILE:
${candidateProfile || "No profile provided."}

REQUIRED CRITERIA (hard filters):
${criteria || "No specific criteria."}

JOB CANDIDATES (${candidates.length} total):
${jobList}

Tasks:
1. DEDUPLICATE — if multiple jobs are the same role at the same company, keep only the best URL.
2. SCORE — assign a fitScore (0-100) based on:
   - Experience depth match
   - Skill transferability
   - Location/remote compatibility
   - Company stage fit
   - Compensation alignment
3. RANK — order by composite quality (fitScore + URL confidence).
4. FILTER — drop jobs with fitScore < 40 or that clearly don't match criteria.

Return ONLY a raw JSON array (no markdown, no explanation) with the TOP ${jobCount} jobs:
[{
  "jobIndex": 0,
  "fitScore": 85,
  "matchReasons": [
    "Experience Depth: ...",
    "Transferable Skills: ...",
    "Project Similarity: ..."
  ],
  "rankingReason": "Selected because..."
}]

jobIndex: the original JOB N index from above.
matchReasons: 3-5 strings referencing this candidate's SPECIFIC background.
rankingReason: why this job made the final cut vs. others.`;

  try {
    const response = await anthropic.messages.create({
      model:      MODEL_HAIKU,
      max_tokens: 2048,
      messages:   [{ role: "user", content: prompt }],
    });

    _trackCost(db, userId, "claude_hybrid_rank", response.usage, true);
    log(`[ClaudeReasoner] Ranking complete — tokens: in=${response.usage?.input_tokens} out=${response.usage?.output_tokens}`);

    const rankings = _parseRankings(response.content[0]?.text || "");
    if (rankings.length === 0) {
      log("[ClaudeReasoner] WARNING: Claude returned 0 rankings — returning candidates as-is");
      return candidates.slice(0, jobCount);
    }

    // Merge rankings back into candidate objects
    const ranked = rankings
      .filter(r => typeof r.jobIndex === "number" && candidates[r.jobIndex])
      .map(r => ({
        ...candidates[r.jobIndex],
        fitScore:      r.fitScore,
        matchReasons:  Array.isArray(r.matchReasons) ? r.matchReasons : [],
        rankingReason: r.rankingReason || "",
        rankedByHybrid: true,
      }));

    log(`[ClaudeReasoner] ${ranked.length} jobs after ranking/dedup`);
    return ranked.slice(0, jobCount);
  } catch (err) {
    log(`[ClaudeReasoner] ERROR: ${err.message} — falling back to Gemini confidence ordering`);
    console.error("[ClaudeReasoner] Ranking error:", err.message);

    // Graceful fallback: order by Gemini confidence, assign placeholder fitScore
    return candidates
      .sort((a, b) => (b.applyUrlConfidence || b.confidence || 0) - (a.applyUrlConfidence || a.confidence || 0))
      .slice(0, jobCount)
      .map(j => ({
        ...j,
        fitScore:     Math.round((j.applyUrlConfidence || j.confidence || 0.5) * 100),
        matchReasons: ["Ranked by search confidence (Claude ranking unavailable)"],
      }));
  }
}

/**
 * Deduplicate candidates by fingerprint.
 * Keeps the entry with the highest confidence URL.
 *
 * @param {object[]} candidates
 * @returns {object[]}
 */
function deduplicateCandidates(candidates) {
  const seen = new Map();
  for (const job of candidates) {
    const key = `${(job.title || "").toLowerCase().trim()}__${(job.company || "").toLowerCase().trim()}`;
    const existing = seen.get(key);
    if (!existing || (job.applyUrlConfidence || 0) > (existing.applyUrlConfidence || 0)) {
      seen.set(key, job);
    }
  }
  return Array.from(seen.values());
}

// ── Helpers ───────────────────────────────────────────────────────────────────

function _parseRankings(rawText) {
  try {
    const clean = rawText
      .replace(/^```(?:json)?\s*/im, "")
      .replace(/\s*```$/m, "")
      .trim();
    const start = clean.indexOf("[");
    const end   = clean.lastIndexOf("]");
    if (start === -1 || end === -1) return [];
    return JSON.parse(clean.slice(start, end + 1));
  } catch {
    return [];
  }
}

function _trackCost(db, userId, view, usage, isHaiku = false) {
  if (!db || !userId || !usage) return;
  const ic = isHaiku ? INPUT_COST_HAIKU  : INPUT_COST_SONNET;
  const oc = isHaiku ? OUTPUT_COST_HAIKU : OUTPUT_COST_SONNET;
  const { FieldValue } = require("firebase-admin/firestore");
  db.collection("platform_events").add({
    userId, view,
    provider: "claude",
    model:    isHaiku ? MODEL_HAIKU : MODEL_SONNET,
    inputTokens:  usage.input_tokens  || 0,
    outputTokens: usage.output_tokens || 0,
    cost: ((usage.input_tokens || 0) * ic) + ((usage.output_tokens || 0) * oc),
    createdAt: FieldValue.serverTimestamp(),
  }).catch(() => {});
}

module.exports = { rankCandidates, deduplicateCandidates };
