/**
 * Gemini URL discovery.
 *
 * Finds the canonical ATS/careers-page URL for a given job.
 * Used when:
 *  - Gemini's search returned a possibleJobUrl that needs confirmation
 *  - The initial URL was a generic careers page rather than a direct posting link
 *  - We need to locate the ATS-specific direct URL for a known role
 */

const BANNED_DOMAINS = /indeed\.com|linkedin\.com/i;

/**
 * Ask Gemini to locate the direct ATS URL for a job posting.
 *
 * @param {object} params
 * @param {string}   params.company        - Company name
 * @param {string}   params.title          - Job title
 * @param {string}   [params.location]     - Location hint
 * @param {string}   [params.atsType]      - Known ATS type (greenhouse/lever/ashby/...)
 * @param {string}   [params.atsSlug]      - Known ATS company slug
 * @param {string}   [params.startingUrl]  - URL to verify/refine (if any)
 * @param {object}   params.geminiClient   - GeminiClient instance
 * @param {string}   params.userId         - For cost attribution
 * @param {Function} [params.logFn]        - Optional async log function
 * @returns {Promise<{url: string|null, confidence: number, reasoning: string}>}
 */
async function findJobUrl(params) {
  const {
    company,
    title,
    location,
    atsType,
    atsSlug,
    startingUrl,
    geminiClient,
    userId,
    logFn,
  } = params;

  const log = (msg) => { if (logFn) logFn(msg).catch(() => {}); };

  // Build a targeted search prompt
  const atsHint = atsType && atsSlug
    ? `The company uses ${atsType} (slug: "${atsSlug}").`
    : atsType
      ? `The company likely uses ${atsType}.`
      : "";

  const startingHint = startingUrl
    ? `Start from this URL (verify/refine it): ${startingUrl}`
    : "";

  const prompt = `Find the EXACT direct apply URL for this job posting.

Company: ${company}
Job title: ${title}
${location ? `Location: ${location}` : ""}
${atsHint}
${startingHint}

Requirements:
- The URL must link directly to THIS specific job posting (not the careers page).
- A valid URL contains a unique job ID or slug.
- If ${atsType === "greenhouse" ? `use boards.greenhouse.io/${atsSlug || "COMPANY"}/jobs/ID format` : ""}
  ${atsType === "lever"      ? `use jobs.lever.co/${atsSlug || "COMPANY"}/UUID format`          : ""}
  ${atsType === "ashby"      ? `use jobs.ashbyhq.com/${atsSlug || "COMPANY"}/... format`        : ""}
- Do NOT return indeed.com or linkedin.com URLs.
- Do NOT return a generic careers page URL.

Use Google Search to find the posting. If you cannot find a direct URL with high confidence, say so.

Respond ONLY with a raw JSON object (no markdown, no explanation):
{
  "url": "https://...",
  "confidence": 0.9,
  "reasoning": "Found via boards.greenhouse.io/company/jobs/12345 — title matches exactly."
}

If no URL found: {"url": null, "confidence": 0, "reasoning": "..."}`;

  try {
    const result = await geminiClient.generate({
      modelId:  geminiClient.searchModel,
      prompt,
      tools:    [{ googleSearch: {} }],
      userId,
      view:     "gemini_url_discovery",
    });

    const parsed = _parseUrlResponse(result.text);
    log(`[GeminiURLDiscovery] ${company} "${title}" → ${parsed.url || "NOT FOUND"} (confidence=${parsed.confidence})`);

    // Reject banned domains even if Gemini returned them
    if (parsed.url && BANNED_DOMAINS.test(parsed.url)) {
      log(`[GeminiURLDiscovery] Rejecting banned domain URL: ${parsed.url}`);
      return { url: null, confidence: 0, reasoning: "Banned aggregator domain" };
    }

    return parsed;
  } catch (err) {
    log(`[GeminiURLDiscovery] ERROR for "${title}" @ ${company}: ${err.message}`);
    console.error("[GeminiURLDiscovery] Error:", err.message);
    return { url: null, confidence: 0, reasoning: `Error: ${err.message}` };
  }
}

/**
 * Batch-discover URLs for multiple jobs.
 * Runs serially to stay within Gemini rate limits.
 *
 * @param {object[]} jobs             - Array of job objects needing URL discovery
 * @param {object}   geminiClient     - GeminiClient instance
 * @param {string}   userId
 * @param {Function} [logFn]
 * @returns {Promise<object[]>}       - Same array with url/confidence updated
 */
async function discoverUrlsForJobs(jobs, geminiClient, userId, logFn) {
  const log = (msg) => { if (logFn) logFn(msg).catch(() => {}); };
  const results = [];

  for (const job of jobs) {
    // If Gemini already returned a high-confidence URL, skip rediscovery
    if ((job.confidence || 0) >= 0.8 && job.possibleJobUrl?.startsWith("http")) {
      results.push({ ...job });
      continue;
    }

    log(`[GeminiURLDiscovery] Discovering URL for "${job.title}" @ ${job.company}…`);
    const discovered = await findJobUrl({
      company:     job.company,
      title:       job.title,
      location:    job.location,
      atsType:     job.atsProvider,
      atsSlug:     job.atsSlug,
      startingUrl: job.possibleJobUrl || job.url,
      geminiClient,
      userId,
      logFn,
    });

    results.push({
      ...job,
      url:                  discovered.url || job.possibleJobUrl || job.url,
      possibleJobUrl:       discovered.url || job.possibleJobUrl || job.url,
      urlDiscoveryConfidence: discovered.confidence,
      urlDiscoveryReasoning:  discovered.reasoning,
    });
  }

  return results;
}

// ── Response parsing ──────────────────────────────────────────────────────────

function _parseUrlResponse(rawText) {
  try {
    const clean = rawText
      .replace(/^```(?:json)?\s*/im, "")
      .replace(/\s*```$/m, "")
      .trim();

    const start = clean.indexOf("{");
    const end   = clean.lastIndexOf("}");
    if (start === -1 || end === -1) {
      return { url: null, confidence: 0, reasoning: "No JSON object found in response" };
    }

    const parsed = JSON.parse(clean.slice(start, end + 1));
    return {
      url:        parsed.url        || null,
      confidence: typeof parsed.confidence === "number" ? parsed.confidence : 0,
      reasoning:  parsed.reasoning  || "",
    };
  } catch (err) {
    return { url: null, confidence: 0, reasoning: `Parse error: ${err.message}` };
  }
}

module.exports = { findJobUrl, discoverUrlsForJobs };
