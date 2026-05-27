/**
 * Gemini job search/discovery.
 *
 * Uses Gemini with Google Search grounding to find real, current job postings.
 * Returns structured candidates in a format compatible with the existing pipeline.
 *
 * Gemini is optimised for retrieval/extraction here — NOT deep reasoning.
 * Claude handles ranking, deduplication, and quality analysis downstream.
 */

const { GeminiClient } = require("./client");

// Max candidates Gemini will attempt to return per pass
const DEFAULT_MAX_CANDIDATES = parseInt(process.env.HYBRID_SEARCH_MAX_RESULTS || "10", 10);

/**
 * Structured job candidate schema (Gemini output, Claude input).
 *
 * {
 *   title:          string,
 *   company:        string,
 *   location:       string,
 *   salary:         string,
 *   experience:     string,
 *   description:    string,
 *   possibleJobUrl: string,   // best URL Gemini found
 *   atsType:        string,   // "greenhouse" | "lever" | "ashby" | "workday" | ...
 *   atsSlug:        string,
 *   posted:         string,
 *   confidence:     number,   // 0.0–1.0 Gemini's own confidence
 *   source:         string,   // which search pass / board
 * }
 */

const EXTRACTION_SCHEMA = `[{
  "title": "",
  "company": "",
  "location": "",
  "salary": "",
  "experience": "",
  "description": "",
  "possibleJobUrl": "",
  "atsType": "",
  "atsSlug": "",
  "posted": "",
  "confidence": 0.8,
  "source": ""
}]`;

function buildSearchPrompt(query, prefs, candidateCount, seenSection, staleUrlList) {
  const criteria = [
    prefs.jobTitle        ? `Role: ${prefs.jobTitle}`                    : "",
    prefs.remoteOnly      ? `Location: Remote only`
      : prefs.locationCity ? `Location: Within ${prefs.locationRadius || "any distance"} of ${prefs.locationCity}`
      : prefs.location     ? `Location: ${prefs.location}`               : "",
    prefs.experienceLevel ? `Experience level: ${prefs.experienceLevel}` : "",
    prefs.salaryMin       ? `Minimum salary: ${prefs.salaryMin}`         : "",
    prefs.industries      ? `Industries: ${prefs.industries}`            : "",
  ].filter(Boolean).join("\n");

  const staleSection = staleUrlList && staleUrlList.length > 0
    ? `\nKNOWN EXPIRED URLS — never return any of these:\n${staleUrlList.slice(0, 40).join("\n")}\n`
    : "";

  return `You are a job board search specialist. Find up to ${candidateCount} REAL, CURRENT job postings that match the criteria below.

Use Google Search to locate actual job listings. Prioritise direct ATS links over aggregators.

REQUIRED CRITERIA (hard filters — every job must match ALL):
${criteria || "No specific criteria."}

SEARCH SOURCES (in order):
1. site:hiring.cafe ${query}
2. site:boards.greenhouse.io ${query}
3. site:jobs.lever.co ${query}
4. site:jobs.ashbyhq.com ${query}
5. site:builtin.com ${query}
6. site:wellfound.com ${query}
${seenSection}${staleSection}
URL RULES (non-negotiable):
- Every URL must link directly to a specific job posting, NOT a company careers page or search results page.
- A valid URL contains a unique job ID or slug.
- If you cannot find a verified direct URL, omit the job entirely.
- Prefer postings from the last 14 days.
- NEVER return indeed.com or linkedin.com URLs.

ATS DETECTION:
- boards.greenhouse.io/COMPANY/jobs/ID → atsType="greenhouse", atsSlug="COMPANY"
- jobs.lever.co/COMPANY/UUID           → atsType="lever",      atsSlug="COMPANY"
- jobs.ashbyhq.com/COMPANY/...         → atsType="ashby",      atsSlug="COMPANY"
- COMPANY.workday.com/...              → atsType="workday"

Return ONLY a raw JSON array. No markdown, no code fences, no explanation.
Return up to ${candidateCount} objects using this exact schema:
${EXTRACTION_SCHEMA}

Confidence: 1.0 = URL definitely links to this exact posting. 0.5 = URL might be correct. Below 0.4 = skip it.`;
}

function buildPass2Prompt(query, prefs, candidateCount, alreadyFound, seenSection) {
  const criteria = [
    prefs.jobTitle        ? `Role: ${prefs.jobTitle}`                    : "",
    prefs.remoteOnly      ? `Location: Remote only`
      : prefs.locationCity ? `Location: ${prefs.locationCity}`            : "",
    prefs.experienceLevel ? `Experience level: ${prefs.experienceLevel}` : "",
  ].filter(Boolean).join("\n");

  const foundSection = alreadyFound.length > 0
    ? `\nAlready found — skip these companies/titles:\n${alreadyFound.map(j => `- ${j.company}: ${j.title}`).join("\n")}\n`
    : "";

  return `You are a job board search specialist. This is a SECOND PASS to find additional job postings.
Use DIFFERENT sources from pass 1. Do NOT search hiring.cafe, greenhouse.io, or lever.co again.

REQUIRED CRITERIA:
${criteria || "No specific criteria."}
${foundSection}${seenSection}
SEARCH SOURCES (second pass only):
1. site:linkedin.com/jobs ${query}
2. site:indeed.com ${query}
3. company careers pages for ${prefs.jobTitle || query}

Return ONLY a raw JSON array with up to ${candidateCount} items. Same schema as before:
${EXTRACTION_SCHEMA}`;
}

/**
 * Discover job candidates using Gemini's grounded search.
 *
 * @param {object} params
 * @param {string}   params.query           - Search query string
 * @param {object}   params.prefs           - User search preferences
 * @param {string}   params.tier            - "free" | "pro"
 * @param {object}   params.geminiClient    - GeminiClient instance
 * @param {string}   params.userId          - For cost attribution
 * @param {string[]} [params.staleUrls]     - Known dead URLs to exclude
 * @param {object[]} [params.recentJobs]    - Jobs found this week (for dedup hint)
 * @param {Function} [params.logFn]         - Optional async log function
 * @returns {Promise<object[]>} Array of structured job candidates
 */
async function discoverJobs(params) {
  const {
    query,
    prefs,
    tier = "free",
    geminiClient,
    userId,
    staleUrls = [],
    recentJobs = [],
    logFn,
  } = params;

  const log = (msg) => { if (logFn) logFn(msg).catch(() => {}); };

  const maxCandidates = DEFAULT_MAX_CANDIDATES;
  const seenSection   = recentJobs.length > 0
    ? `\nAlready found this week — skip:\n${recentJobs.slice(0, 20).map(j => `- ${j.company}: ${j.title}`).join("\n")}\n`
    : "";

  const prompt = buildSearchPrompt(query, prefs, maxCandidates, seenSection, staleUrls);

  log(`[GeminiSearch] Pass 1: Searching with Gemini Flash + Google Search for "${query}"…`);

  let candidates = [];
  try {
    const result = await geminiClient.generate({
      modelId:  geminiClient.searchModel,
      prompt,
      tools:    [{ googleSearch: {} }],
      userId,
      view:     "gemini_search_pass1",
    });

    log(`[GeminiSearch] Pass 1 raw response length: ${result.text.length} chars, grounding chunks: ${result.usage.groundingChunks}`);
    candidates = _parseJobCandidates(result.text, "gemini_pass1");
    log(`[GeminiSearch] Pass 1: ${candidates.length} candidates parsed`);
  } catch (err) {
    log(`[GeminiSearch] Pass 1 FAILED: ${err.message}`);
    console.error("[GeminiSearch] Pass 1 error:", err.message);
    return [];
  }

  return candidates;
}

/**
 * Second discovery pass using different sources (LinkedIn, Indeed, careers pages).
 * Called when pass 1 returns fewer than the minimum result threshold.
 */
async function discoverJobsPass2(params) {
  const {
    query,
    prefs,
    tier = "free",
    geminiClient,
    userId,
    alreadyFound = [],
    recentJobs = [],
    logFn,
  } = params;

  const log = (msg) => { if (logFn) logFn(msg).catch(() => {}); };

  const maxCandidates = DEFAULT_MAX_CANDIDATES;
  const seenSection   = recentJobs.length > 0
    ? `\nAlready found this week — skip:\n${recentJobs.slice(0, 20).map(j => `- ${j.company}: ${j.title}`).join("\n")}\n`
    : "";

  const prompt = buildPass2Prompt(query, prefs, maxCandidates, alreadyFound, seenSection);

  log(`[GeminiSearch] Pass 2: Searching alternative sources…`);

  try {
    const result = await geminiClient.generate({
      modelId:  geminiClient.searchModel,
      prompt,
      tools:    [{ googleSearch: {} }],
      userId,
      view:     "gemini_search_pass2",
    });

    const candidates = _parseJobCandidates(result.text, "gemini_pass2");
    log(`[GeminiSearch] Pass 2: ${candidates.length} additional candidates`);
    return candidates;
  } catch (err) {
    log(`[GeminiSearch] Pass 2 FAILED: ${err.message}`);
    console.error("[GeminiSearch] Pass 2 error:", err.message);
    return [];
  }
}

// ── JSON parsing helpers ──────────────────────────────────────────────────────

function _parseJobCandidates(rawText, source) {
  try {
    const clean = rawText
      .replace(/^```(?:json)?\s*/im, "")
      .replace(/\s*```$/m, "")
      .trim();

    const start = clean.indexOf("[");
    const end   = clean.lastIndexOf("]");
    if (start === -1 || end === -1) return [];

    const jsonStr = clean.slice(start, end + 1);
    const parsed  = JSON.parse(jsonStr);

    if (!Array.isArray(parsed)) return [];

    return parsed
      .filter(j => j && typeof j === "object" && j.company && j.title)
      .map(j => ({
        title:          (j.title          || "").trim(),
        company:        (j.company        || "").trim(),
        location:       (j.location       || "").trim(),
        salary:         (j.salary         || "").trim(),
        experience:     (j.experience     || "").trim(),
        description:    (j.description    || "").trim(),
        possibleJobUrl: (j.possibleJobUrl || j.url || "").trim(),
        url:            (j.possibleJobUrl || j.url || "").trim(),
        atsProvider:    (j.atsType        || j.atsProvider || "").trim().toLowerCase(),
        atsSlug:        (j.atsSlug        || "").trim(),
        posted:         (j.posted         || "").trim(),
        confidence:     typeof j.confidence === "number" ? j.confidence : 0.5,
        source:         source || "gemini",
        // Mark all Gemini candidates as needing URL verification
        geminiDiscovered: true,
        urlVerified:    false,
      }));
  } catch (err) {
    console.error(`[GeminiSearch] JSON parse failed (source=${source}): ${err.message}`);
    return [];
  }
}

module.exports = { discoverJobs, discoverJobsPass2 };
