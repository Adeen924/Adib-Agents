/**
 * Gemini URL verification.
 *
 * This is the critical URL accuracy layer. Current pain point:
 *  - Wrong URL (adjacent job, similar position, stale page)
 *  - Generic careers page instead of direct posting
 *  - Stale/expired postings with 200 OK
 *
 * Gemini evaluates each URL by:
 *  1. Comparing search query vs page title
 *  2. Comparing expected vs actual structured job metadata
 *  3. Scoring staleness signals
 *  4. Returning a confidence score + rejection reason if weak
 */

// Confidence threshold below which a URL is considered unverified
const URL_CONFIDENCE_THRESHOLD = parseFloat(process.env.GEMINI_URL_CONFIDENCE_MIN || "0.6");

// Max concurrent verifications (to respect rate limits)
const VERIFY_CONCURRENCY = 3;

/**
 * Verify a single job URL using Gemini.
 *
 * @param {object} params
 * @param {string}   params.url              - URL to verify
 * @param {string}   params.expectedTitle    - What we expect the job to be titled
 * @param {string}   params.expectedCompany  - Company we expect
 * @param {string}   [params.expectedLocation]
 * @param {string}   [params.atsType]        - Known ATS (helps Gemini focus)
 * @param {object}   params.geminiClient     - GeminiClient instance
 * @param {string}   params.userId           - For cost attribution
 * @param {Function} [params.logFn]
 * @returns {Promise<{
 *   isValid: boolean,
 *   confidence: number,
 *   actualTitle: string,
 *   actualCompany: string,
 *   titleSimilarity: number,
 *   isExpired: boolean,
 *   rejectionReason: string,
 *   verifiedUrl: string|null
 * }>}
 */
async function verifyJobUrl(params) {
  const {
    url,
    expectedTitle,
    expectedCompany,
    expectedLocation,
    atsType,
    geminiClient,
    userId,
    logFn,
  } = params;

  const log = (msg) => { if (logFn) logFn(msg).catch(() => {}); };

  if (!url || !url.startsWith("http")) {
    return _failResult("No valid URL provided");
  }

  const prompt = `Verify this job posting URL and assess its accuracy.

Expected job:
- Title:    ${expectedTitle}
- Company:  ${expectedCompany}
${expectedLocation ? `- Location: ${expectedLocation}` : ""}
${atsType          ? `- ATS:      ${atsType}`           : ""}

URL to verify: ${url}

Fetch or search for this URL and answer:
1. Does the page actually show a job posting for "${expectedTitle}" at "${expectedCompany}"?
2. Is the title an exact match, partial match, or mismatch?
3. Is the posting still active (not expired/closed/filled)?
4. Is this a direct posting URL or a generic careers page?

Confidence scoring guide:
- 1.0: Exact title + company match, posting is active, direct URL with job ID
- 0.8: Title slightly different but same role, same company, active
- 0.6: Related role, same company, might be active
- 0.4: Wrong title or different seniority level
- 0.2: Wrong company or department
- 0.0: Page not found, expired, or completely wrong

Return ONLY a raw JSON object:
{
  "isValid": true,
  "confidence": 0.9,
  "actualTitle": "...",
  "actualCompany": "...",
  "titleSimilarity": 0.95,
  "isExpired": false,
  "rejectionReason": "",
  "verifiedUrl": "${url}"
}`;

  try {
    const result = await geminiClient.generate({
      modelId:  geminiClient.searchModel,
      prompt,
      tools:    [{ googleSearch: {} }],
      userId,
      view:     "gemini_verify_url",
    });

    const parsed = _parseVerificationResult(result.text, url);

    // Apply threshold
    parsed.isValid = parsed.confidence >= URL_CONFIDENCE_THRESHOLD && !parsed.isExpired;

    log(`[GeminiVerify] ${url.slice(0, 80)} → valid=${parsed.isValid} confidence=${parsed.confidence} expired=${parsed.isExpired}`);
    return parsed;
  } catch (err) {
    log(`[GeminiVerify] ERROR: ${err.message}`);
    console.error("[GeminiVerify] Error:", err.message);
    return _failResult(`Verification error: ${err.message}`);
  }
}

/**
 * Batch verify multiple job URLs. Runs in limited concurrency.
 *
 * @param {object[]} jobs         - Array of job objects to verify
 * @param {object}   geminiClient
 * @param {string}   userId
 * @param {Function} [logFn]
 * @returns {Promise<object[]>}   - Same array with urlVerified/applyUrlConfidence updated
 */
async function batchVerifyUrls(jobs, geminiClient, userId, logFn) {
  const log = (msg) => { if (logFn) logFn(msg).catch(() => {}); };
  log(`[GeminiVerify] Batch verifying ${jobs.length} URLs (concurrency=${VERIFY_CONCURRENCY})…`);

  const results = new Array(jobs.length);

  // Process in batches of VERIFY_CONCURRENCY
  for (let i = 0; i < jobs.length; i += VERIFY_CONCURRENCY) {
    const batch = jobs.slice(i, i + VERIFY_CONCURRENCY);
    const batchResults = await Promise.all(
      batch.map(job => verifyJobUrl({
        url:             job.url || job.possibleJobUrl,
        expectedTitle:   job.title,
        expectedCompany: job.company,
        expectedLocation: job.location,
        atsType:         job.atsProvider,
        geminiClient,
        userId,
        logFn,
      }))
    );

    batchResults.forEach((verification, batchIdx) => {
      const globalIdx = i + batchIdx;
      results[globalIdx] = {
        ...jobs[globalIdx],
        urlVerified:         verification.isValid,
        applyUrlConfidence:  verification.confidence,
        urlVerificationData: {
          actualTitle:     verification.actualTitle,
          titleSimilarity: verification.titleSimilarity,
          isExpired:       verification.isExpired,
          rejectionReason: verification.rejectionReason,
        },
        // Use verified URL if Gemini returned a corrected one
        ...(verification.verifiedUrl && verification.verifiedUrl !== jobs[globalIdx].url
          ? { directUrl: verification.verifiedUrl }
          : {}),
      };
    });
  }

  const verified = results.filter(j => j.urlVerified).length;
  log(`[GeminiVerify] Batch complete: ${verified}/${jobs.length} URLs verified`);

  return results;
}

// ── Helpers ───────────────────────────────────────────────────────────────────

function _failResult(reason) {
  return {
    isValid:         false,
    confidence:      0,
    actualTitle:     "",
    actualCompany:   "",
    titleSimilarity: 0,
    isExpired:       false,
    rejectionReason: reason,
    verifiedUrl:     null,
  };
}

function _parseVerificationResult(rawText, fallbackUrl) {
  try {
    const clean = rawText
      .replace(/^```(?:json)?\s*/im, "")
      .replace(/\s*```$/m, "")
      .trim();

    const start = clean.indexOf("{");
    const end   = clean.lastIndexOf("}");
    if (start === -1) return _failResult("No JSON in verification response");

    const parsed = JSON.parse(clean.slice(start, end + 1));
    return {
      isValid:         Boolean(parsed.isValid),
      confidence:      typeof parsed.confidence      === "number" ? parsed.confidence      : 0,
      actualTitle:     parsed.actualTitle     || "",
      actualCompany:   parsed.actualCompany   || "",
      titleSimilarity: typeof parsed.titleSimilarity === "number" ? parsed.titleSimilarity : 0,
      isExpired:       Boolean(parsed.isExpired),
      rejectionReason: parsed.rejectionReason || "",
      verifiedUrl:     parsed.verifiedUrl     || fallbackUrl,
    };
  } catch (err) {
    return _failResult(`Parse error: ${err.message}`);
  }
}

module.exports = { verifyJobUrl, batchVerifyUrls, URL_CONFIDENCE_THRESHOLD };
