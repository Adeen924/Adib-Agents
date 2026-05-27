/**
 * Benchmark runner.
 *
 * Compares the hybrid pipeline against the Claude-only pipeline on identical
 * search scenarios. Outputs a structured report to Firestore and console.
 *
 * Usage:
 *   const { runBenchmark } = require("./services/ai/benchmark/runner");
 *   await runBenchmark({ db, anthropic, userId: "benchmark-user" });
 *
 * This is NOT called from production code. It's a dev/admin utility.
 * Trigger via the /admin/benchmark route (admin-only, authenticated).
 */

const { SCENARIOS } = require("./scenarios");
const { runHybridSearch } = require("../pipeline/hybridPipeline");
const admin = require("firebase-admin");
const { FieldValue } = require("firebase-admin/firestore");

// Minimal stub for the Claude-only pipeline timing/cost extraction
// (the real pipeline lives in index.js; this just measures platform_events)

/**
 * Run a full benchmark suite.
 *
 * @param {object} params
 * @param {object}   params.db               - Firestore instance
 * @param {object}   params.anthropic         - Anthropic SDK instance
 * @param {string}   params.userId           - User ID for cost attribution (use a test user)
 * @param {string[]} [params.scenarioIds]    - Subset of scenario IDs to run (default: all)
 * @param {boolean}  [params.dryRun]         - If true, only checks flags/config, no API calls
 * @param {Function} [params.logFn]          - Optional log function
 * @returns {Promise<BenchmarkReport>}
 */
async function runBenchmark(params) {
  const {
    db,
    anthropic,
    userId,
    scenarioIds,
    dryRun = false,
    logFn,
  } = params;

  const log = (msg) => {
    console.log(`[Benchmark] ${msg}`);
    if (logFn) logFn(`[Benchmark] ${msg}`).catch(() => {});
  };

  const scenarios = scenarioIds
    ? SCENARIOS.filter(s => scenarioIds.includes(s.id))
    : SCENARIOS;

  log(`Starting benchmark — ${scenarios.length} scenario(s), dryRun=${dryRun}`);

  const results = [];

  for (const scenario of scenarios) {
    log(`\n── Scenario: ${scenario.name} ──`);

    if (dryRun) {
      log(`[dryRun] Skipping API calls`);
      results.push({ scenario: scenario.id, status: "dry_run" });
      continue;
    }

    const runResult = await _runScenario({
      scenario,
      db,
      anthropic,
      userId,
      logFn,
    });

    results.push(runResult);
    log(`Result: ${JSON.stringify(runResult.metrics, null, 2)}`);
  }

  const report = {
    runId:       `benchmark_${Date.now()}`,
    scenarioCount: scenarios.length,
    results,
    summary:     _summarise(results),
    createdAt:   new Date().toISOString(),
  };

  // Persist report to Firestore
  try {
    await db.collection("benchmark_reports").add({
      ...report,
      createdAt: FieldValue.serverTimestamp(),
    });
    log(`Report saved — runId=${report.runId}`);
  } catch (err) {
    log(`WARNING: could not save report: ${err.message}`);
  }

  return report;
}

async function _runScenario({ scenario, db, anthropic, userId, logFn }) {
  const log = (msg) => { console.log(`[Benchmark:${scenario.id}] ${msg}`); };

  const prefs = scenario.prefs;
  const query = [
    prefs.jobTitle,
    prefs.experienceLevel,
    prefs.remoteOnly ? "remote" : (prefs.locationCity || ""),
  ].filter(Boolean).join(" ");

  const startHybrid = Date.now();
  let hybridJobs     = [];
  let hybridSession  = null;
  let hybridError    = null;

  try {
    const result = await runHybridSearch({
      userId,
      prefs,
      tier:             "pro",
      query,
      candidateProfile: "[Benchmark user — no real profile]",
      criteria:         Object.entries(prefs).map(([k, v]) => `${k}: ${v}`).join("\n"),
      seenFingerprints: new Set(),
      recentJobs:       [],
      staleUrls:        [],
      db,
      anthropic,
      jobCount:         3,
      logFn: (msg) => { log(msg); },
    });
    hybridJobs    = result.jobs;
    hybridSession = result.session;
    await hybridSession.flush();
  } catch (err) {
    hybridError = err.message;
    log(`Hybrid pipeline error: ${err.message}`);
  }

  const hybridDuration = Date.now() - startHybrid;

  // Analyse results
  const metrics = {
    hybridJobsFound:      hybridJobs.length,
    hybridDurationMs:     hybridDuration,
    hybridTotalCost:      hybridSession ? (hybridSession.geminiCost + hybridSession.claudeCost) : null,
    hybridGeminiCost:     hybridSession?.geminiCost  || null,
    hybridClaudeCost:     hybridSession?.claudeCost  || null,
    hybridError,

    // Quality checks
    meetsMinResults:      hybridJobs.length >= (scenario.expectedMinResults || 1),
    duplicatesDetected:   _countDuplicates(hybridJobs),
    avgFitScore:          hybridJobs.length > 0
      ? hybridJobs.reduce((s, j) => s + (j.fitScore || 0), 0) / hybridJobs.length
      : null,
    urlsWithDirectLink:   hybridJobs.filter(j => _hasDirectUrl(j.url || j.possibleJobUrl)).length,

    // Expectation checks
    expectationsMet: {
      minResults: hybridJobs.length >= (scenario.expectedMinResults || 0),
      maxDuplicates: _countDuplicates(hybridJobs) <= (scenario.expectedMaxDuplicates ?? 99),
    },
  };

  return {
    scenario: scenario.id,
    name:     scenario.name,
    status:   hybridError ? "error" : "ok",
    metrics,
    jobs:     hybridJobs.map(j => ({
      title:      j.title,
      company:    j.company,
      url:        j.url,
      fitScore:   j.fitScore,
      urlVerified: j.urlVerified,
      confidence: j.applyUrlConfidence,
    })),
  };
}

function _countDuplicates(jobs) {
  const seen = new Set();
  let dupes = 0;
  for (const j of jobs) {
    const key = `${(j.title || "").toLowerCase()}__${(j.company || "").toLowerCase()}`;
    if (seen.has(key)) dupes++;
    seen.add(key);
  }
  return dupes;
}

function _hasDirectUrl(url) {
  if (!url) return false;
  // A direct URL contains a job ID segment (numeric or UUID-like)
  return /\/jobs?\/[\w-]{4,}|\/\d{4,}|\/[0-9a-f-]{20,}/i.test(url);
}

function _summarise(results) {
  const ok     = results.filter(r => r.status === "ok");
  const errors = results.filter(r => r.status === "error");
  if (!ok.length) return { successRate: 0, avgCost: null, avgDuration: null };

  return {
    successRate:   ok.length / results.length,
    avgHybridCost: _meanOf(ok, r => r.metrics.hybridTotalCost),
    avgDurationMs: _meanOf(ok, r => r.metrics.hybridDurationMs),
    avgFitScore:   _meanOf(ok, r => r.metrics.avgFitScore),
    errorCount:    errors.length,
    scenariosPassed: ok.filter(r =>
      r.metrics.expectationsMet?.minResults && r.metrics.expectationsMet?.maxDuplicates
    ).length,
  };
}

function _meanOf(arr, fn) {
  const vals = arr.map(fn).filter(v => v != null);
  return vals.length ? vals.reduce((s, v) => s + v, 0) / vals.length : null;
}

module.exports = { runBenchmark };
