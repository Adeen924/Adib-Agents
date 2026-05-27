/**
 * Gemini structured job extraction.
 *
 * Takes raw text (from a search result, webpage, or Gemini grounded response)
 * and extracts a clean array of structured job candidates.
 *
 * This is a lighter-weight extraction step that runs AFTER initial discovery
 * when raw text needs to be normalised into the pipeline's canonical format.
 */

/**
 * Extract structured job candidates from raw search result text.
 *
 * @param {object} params
 * @param {string}   params.rawText        - Raw text containing job information
 * @param {string}   params.query          - Original search query (for context)
 * @param {object}   params.prefs          - User preferences (for filtering)
 * @param {object}   params.geminiClient   - GeminiClient instance
 * @param {string}   params.userId         - For cost attribution
 * @param {Function} [params.logFn]        - Optional async log function
 * @returns {Promise<object[]>}
 */
async function extractStructuredJobs(params) {
  const {
    rawText,
    query,
    prefs,
    geminiClient,
    userId,
    logFn,
  } = params;

  const log = (msg) => { if (logFn) logFn(msg).catch(() => {}); };

  if (!rawText || rawText.trim().length < 50) {
    log("[GeminiExtract] Raw text too short — skipping extraction");
    return [];
  }

  const prompt = `Extract all distinct job listings from the text below. Each listing must have a direct apply URL.

Search context: "${query}"
${prefs?.jobTitle     ? `Target role: ${prefs.jobTitle}`     : ""}
${prefs?.locationCity ? `Target location: ${prefs.locationCity}` : ""}

TEXT TO EXTRACT FROM:
---
${rawText.slice(0, 8000)}
---

Return ONLY a raw JSON array. No markdown, no code fences, no explanation.
Each object must have:
{
  "title": "",
  "company": "",
  "location": "",
  "salary": "",
  "description": "",
  "possibleJobUrl": "",
  "atsType": "",
  "atsSlug": "",
  "posted": "",
  "confidence": 0.8
}

Rules:
- Only include jobs with a direct URL (job ID in URL, not just /careers).
- Skip duplicates (same company + title).
- confidence: how sure you are the URL links to this exact posting (0.0–1.0).
- Return [] if no valid listings found.`;

  try {
    const result = await geminiClient.generate({
      modelId:  geminiClient.searchModel,
      prompt,
      userId,
      view:     "gemini_extract_jobs",
    });

    const jobs = _parseExtractedJobs(result.text);
    log(`[GeminiExtract] Extracted ${jobs.length} structured jobs from ${rawText.length} chars`);
    return jobs;
  } catch (err) {
    log(`[GeminiExtract] Extraction failed: ${err.message}`);
    console.error("[GeminiExtract] Error:", err.message);
    return [];
  }
}

/**
 * Extract company career page URL for ATS detection.
 *
 * @param {object} params
 * @param {string}   params.company       - Company name
 * @param {object}   params.geminiClient
 * @param {string}   params.userId
 * @param {Function} [params.logFn]
 * @returns {Promise<{careerPageUrl: string|null, atsType: string, atsSlug: string}>}
 */
async function detectCompanyATS(params) {
  const { company, geminiClient, userId, logFn } = params;
  const log = (msg) => { if (logFn) logFn(msg).catch(() => {}); };

  const prompt = `What ATS (Applicant Tracking System) does ${company} use for job applications?

Search for ${company} careers page and identify:
1. The direct careers page URL
2. The ATS provider (greenhouse, lever, ashby, workday, smartrecruiters, icims, bamboohr, or custom)
3. The company slug in that ATS (if applicable)

Return ONLY a raw JSON object:
{
  "careerPageUrl": "https://...",
  "atsType": "greenhouse",
  "atsSlug": "company-slug",
  "confidence": 0.9
}`;

  try {
    const result = await geminiClient.generate({
      modelId:  geminiClient.searchModel,
      prompt,
      tools:    [{ googleSearch: {} }],
      userId,
      view:     "gemini_detect_ats",
    });

    const clean = result.text
      .replace(/^```(?:json)?\s*/im, "")
      .replace(/\s*```$/m, "")
      .trim();
    const start = clean.indexOf("{");
    const end   = clean.lastIndexOf("}");
    if (start === -1) return { careerPageUrl: null, atsType: "", atsSlug: "" };

    const parsed = JSON.parse(clean.slice(start, end + 1));
    log(`[GeminiExtract] ${company} → ATS=${parsed.atsType} slug=${parsed.atsSlug}`);
    return {
      careerPageUrl: parsed.careerPageUrl || null,
      atsType:       parsed.atsType       || "",
      atsSlug:       parsed.atsSlug       || "",
      confidence:    parsed.confidence    || 0,
    };
  } catch (err) {
    log(`[GeminiExtract] ATS detection failed for ${company}: ${err.message}`);
    return { careerPageUrl: null, atsType: "", atsSlug: "" };
  }
}

// ── Helpers ───────────────────────────────────────────────────────────────────

function _parseExtractedJobs(rawText) {
  try {
    const clean = rawText
      .replace(/^```(?:json)?\s*/im, "")
      .replace(/\s*```$/m, "")
      .trim();

    const start = clean.indexOf("[");
    const end   = clean.lastIndexOf("]");
    if (start === -1 || end === -1) return [];

    const parsed = JSON.parse(clean.slice(start, end + 1));
    if (!Array.isArray(parsed)) return [];

    return parsed
      .filter(j => j?.company && j?.title)
      .map(j => ({
        title:          (j.title          || "").trim(),
        company:        (j.company        || "").trim(),
        location:       (j.location       || "").trim(),
        salary:         (j.salary         || "").trim(),
        description:    (j.description    || "").trim(),
        possibleJobUrl: (j.possibleJobUrl || j.url || "").trim(),
        url:            (j.possibleJobUrl || j.url || "").trim(),
        atsProvider:    (j.atsType        || j.atsProvider || "").trim().toLowerCase(),
        atsSlug:        (j.atsSlug        || "").trim(),
        posted:         (j.posted         || "").trim(),
        confidence:     typeof j.confidence === "number" ? j.confidence : 0.5,
        source:         "gemini_extract",
        geminiDiscovered: true,
        urlVerified:    false,
      }));
  } catch {
    return [];
  }
}

module.exports = { extractStructuredJobs, detectCompanyATS };
