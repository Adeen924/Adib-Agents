#!/usr/bin/env python3
# apply_later_changes.py  -- "Later" priority migrations
# Run with:  python apply_later_changes.py
import re

# ─── functions/index.js ───────────────────────────────────────────────────────

with open("functions/index.js", "r", encoding="utf-8") as f:
    content = f.read()

original = content  # keep for diff / safety

# ── Pre-pass: fix encoding issues before making changes ──────────────────────
# 1. Replace mojibake em-dash (U+00E2 + U+20AC + U+201D) with proper em-dash
#    This sequence appears in comments and strings where the original — was
#    double-encoded.  It must be handled BEFORE replacing curly quotes so that
#    U+201D is not mistakenly treated as a closing string delimiter.
LDQUO = '“'  # U+201C left  double quotation mark "
RDQUO = '”'  # U+201D right double quotation mark "
MDASH = '—'  # U+2014 em dash —
# Mojibake for em-dash: U+00E2 + U+20AC + U+201D  (â + euro + right-curly-quote)
mojibake_em = 'â€”'
mojibake_count = content.count(mojibake_em)
if mojibake_count:
    content = content.replace(mojibake_em, MDASH)
    print(f"Pre-pass: replaced {mojibake_count} mojibake em-dashes with U+2014")

# 2. Replace remaining curly/smart quotes with ASCII straight quotes.
curly_replaced = content.count(LDQUO) + content.count(RDQUO)
content = content.replace(LDQUO, '"').replace(RDQUO, '"')
if curly_replaced:
    print(f"Pre-pass: replaced {curly_replaced} curly quotes with ASCII double-quotes")

# ── 1. Add crypto require at top (after the last require line near the top) ──
OLD_REQUIRE = 'const Stripe    = require("stripe");'
NEW_REQUIRE = ('const Stripe    = require("stripe");\n'
               'const crypto    = require("crypto");')
assert content.count(OLD_REQUIRE) == 1, "crypto require anchor not found"
content = content.replace(OLD_REQUIRE, NEW_REQUIRE, 1)

# ── 2. jobUrlHash helper -- insert right before runJobSearch ──────────────────
OLD_RUNSEARCH_COMMENT = 'async function runJobSearch(userId, prefs, tier = "free") {\n  const tierConfig = TIERS[tier] || TIERS.free;'
NEW_HASH_HELPER = (
    '// ── jobs_cache helpers ─────────────────────────────────────────────────────────\n'
    'function jobUrlHash(url) {\n'
    '  if (!url) return null;\n'
    '  return crypto.createHash("sha256").update(url).digest("hex").slice(0, 20);\n'
    '}\n\n'
    'async function runJobSearch(userId, prefs, tier = "free") {\n'
    '  const tierConfig = TIERS[tier] || TIERS.free;'
)
assert content.count(OLD_RUNSEARCH_COMMENT) == 1, "runJobSearch comment anchor not found"
content = content.replace(OLD_RUNSEARCH_COMMENT, NEW_HASH_HELPER, 1)

# ── 3. runJobSearch: dedup fetch -- subcollection ─────────────────────────────
OLD_DEDUP = '    const recentSnap = await db.collection("jobs").where("userId", "==", userId).get();'
NEW_DEDUP = '    const recentSnap = await db.collection("users").doc(userId).collection("jobs").get();'
assert content.count(OLD_DEDUP) == 1, "dedup fetch anchor not found"
content = content.replace(OLD_DEDUP, NEW_DEDUP, 1)

# ── 4. runJobSearch: save each job -- subcollection ───────────────────────────
OLD_SAVE = '    db.collection("jobs").add({'
NEW_SAVE = '    db.collection("users").doc(userId).collection("jobs").add({'
assert content.count(OLD_SAVE) == 1, "jobs save anchor not found"
content = content.replace(OLD_SAVE, NEW_SAVE, 1)

# ── 5. runJobSearch: activity write -> platform_events ───────────────────────
OLD_ACTIVITY = '    await db.collection("activity").add({'
NEW_ACTIVITY = '    await db.collection("platform_events").add({'
assert content.count(OLD_ACTIVITY) == 1, "activity write anchor not found"
content = content.replace(OLD_ACTIVITY, NEW_ACTIVITY, 1)

# ── 6. runJobSearch: cache writes after savePromises ─────────────────────────
OLD_SAVE_AWAIT = '  await Promise.all(savePromises);'
NEW_SAVE_AWAIT = (
    '  // Write new jobs to global jobs_cache (dedup index by URL, 30-day TTL)\n'
    '  const cacheWrites = uniqueJobs.filter(j => j.url).map(j => {\n'
    '    const hash = jobUrlHash(j.url);\n'
    '    if (!hash) return null;\n'
    '    return db.collection("jobs_cache").doc(hash).set({\n'
    '      title:       j.title       || "",\n'
    '      company:     j.company     || "",\n'
    '      location:    j.location    || "",\n'
    '      salary:      j.salary      || "",\n'
    '      description: j.description || "",\n'
    '      url:         j.url,\n'
    '      posted:      j.posted      || "",\n'
    '      cachedAt:    admin.firestore.FieldValue.serverTimestamp(),\n'
    '      expiresAt:   new Date(Date.now() + 30 * 24 * 60 * 60 * 1000),\n'
    '    }, { merge: true });\n'
    '  }).filter(Boolean);\n'
    '  await Promise.all([...savePromises, ...cacheWrites]);\n'
)
assert content.count(OLD_SAVE_AWAIT) == 1, "await savePromises anchor not found"
content = content.replace(OLD_SAVE_AWAIT, NEW_SAVE_AWAIT, 1)

# ── 7. stats endpoint: jobs query -> subcollection ───────────────────────────
OLD_STATS_JOBS = (
    '      db.collection("jobs").where("userId", "==", userId)\n'
    '        .where("createdAt", ">", new Date(Date.now() - 24 * 60 * 60 * 1000)).get(),'
)
NEW_STATS_JOBS = (
    '      db.collection("users").doc(userId).collection("jobs")\n'
    '        .where("createdAt", ">", new Date(Date.now() - 24 * 60 * 60 * 1000)).get(),'
)
assert content.count(OLD_STATS_JOBS) == 1, "stats jobs query anchor not found"
content = content.replace(OLD_STATS_JOBS, NEW_STATS_JOBS, 1)

# ── 8. GET /documents/:userId/:type -> subcollection ─────────────────────────
OLD_DOCS_LIST = '    const snap = await db.collection("documents").where("userId", "==", userId).get();'
NEW_DOCS_LIST = '    const snap = await db.collection("users").doc(userId).collection("documents").get();'
assert content.count(OLD_DOCS_LIST) == 1, "docs list anchor not found"
content = content.replace(OLD_DOCS_LIST, NEW_DOCS_LIST, 1)

# ── 9. POST /documents/save -> subcollection ─────────────────────────────────
OLD_DOCS_SAVE = '    const ref = await db.collection("documents").add({'
NEW_DOCS_SAVE = '    const ref = await db.collection("users").doc(userId).collection("documents").add({'
assert content.count(OLD_DOCS_SAVE) == 1, "docs save anchor not found"
content = content.replace(OLD_DOCS_SAVE, NEW_DOCS_SAVE, 1)

# ── 10. DELETE /documents/:docId -> /documents/:userId/:docId ────────────────
OLD_DOCS_DEL = (
    'app.delete("/documents/:docId", async (req, res) => {\n'
    '  try {\n'
    '    await db.collection("documents").doc(req.params.docId).delete();'
)
NEW_DOCS_DEL = (
    'app.delete("/documents/:userId/:docId", async (req, res) => {\n'
    '  try {\n'
    '    await db.collection("users").doc(req.params.userId).collection("documents").doc(req.params.docId).delete();'
)
assert content.count(OLD_DOCS_DEL) == 1, "docs delete anchor not found"
content = content.replace(OLD_DOCS_DEL, NEW_DOCS_DEL, 1)

# ── 11. GET /applications/:userId -> subcollection ───────────────────────────
OLD_APPS_LIST = '    const snap = await db.collection("applications").where("userId", "==", req.params.userId).get();'
NEW_APPS_LIST = '    const snap = await db.collection("users").doc(req.params.userId).collection("applications").get();'
assert content.count(OLD_APPS_LIST) == 1, "apps list anchor not found"
content = content.replace(OLD_APPS_LIST, NEW_APPS_LIST, 1)

# ── 12. POST /applications/save -> subcollection (update existing) ────────────
OLD_APPS_UPDATE = '      await db.collection("applications").doc(id).set(data, { merge: true });'
NEW_APPS_UPDATE = '      await db.collection("users").doc(userId).collection("applications").doc(id).set(data, { merge: true });'
assert content.count(OLD_APPS_UPDATE) == 1, "apps update anchor not found"
content = content.replace(OLD_APPS_UPDATE, NEW_APPS_UPDATE, 1)

# ── 13. POST /applications/save -> subcollection (new) ───────────────────────
OLD_APPS_ADD = '      const ref = await db.collection("applications").add(data);'
NEW_APPS_ADD = '      const ref = await db.collection("users").doc(userId).collection("applications").add(data);'
assert content.count(OLD_APPS_ADD) == 1, "apps add anchor not found"
content = content.replace(OLD_APPS_ADD, NEW_APPS_ADD, 1)

# ── 14. DELETE /applications/:appId -> /applications/:userId/:appId ──────────
OLD_APPS_DEL = (
    'app.delete("/applications/:appId", async (req, res) => {\n'
    '  try {\n'
    '    await db.collection("applications").doc(req.params.appId).delete();'
)
NEW_APPS_DEL = (
    'app.delete("/applications/:userId/:appId", async (req, res) => {\n'
    '  try {\n'
    '    await db.collection("users").doc(req.params.userId).collection("applications").doc(req.params.appId).delete();'
)
assert content.count(OLD_APPS_DEL) == 1, "apps delete anchor not found"
content = content.replace(OLD_APPS_DEL, NEW_APPS_DEL, 1)

# ── 15. getJobAndResume: subcollection lookup ─────────────────────────────────
OLD_GET_JOB = '    db.collection("jobs").doc(jobId).get(),'
NEW_GET_JOB = '    db.collection("users").doc(userId).collection("jobs").doc(jobId).get(),'
assert content.count(OLD_GET_JOB) == 1, "getJobAndResume anchor not found"
content = content.replace(OLD_GET_JOB, NEW_GET_JOB, 1)

# ── 16. /network endpoint direct job query -> subcollection ──────────────────
OLD_NET_JOB = (
    '      db.collection("jobs").doc(req.params.jobId).get(),\n'
    '      db.collection("users").doc(userId).collection("knowledge").doc("profile").get(),'
)
NEW_NET_JOB = (
    '      db.collection("users").doc(userId).collection("jobs").doc(req.params.jobId).get(),\n'
    '      db.collection("users").doc(userId).collection("knowledge").doc("profile").get(),'
)
assert content.count(OLD_NET_JOB) == 1, "network job query anchor not found"
content = content.replace(OLD_NET_JOB, NEW_NET_JOB, 1)

# ── 17. GET /jobs/detail/:jobId -> /jobs/:userId/detail/:jobId ───────────────
OLD_JOBS_DETAIL = (
    '// IMPORTANT: /jobs/detail/:jobId must come before /jobs/:userId\n'
    'app.get("/jobs/detail/:jobId", async (req, res) => {\n'
    '  try {\n'
    '    const doc = await db.collection("jobs").doc(req.params.jobId).get();\n'
    '    if (!doc.exists) return res.status(404).json({ error: "Job not found" });\n'
    '    res.json({ id: doc.id, ...doc.data() });\n'
    '  } catch (err) {\n'
    '    res.status(500).json({ error: "Failed to load job" });\n'
    '  }\n'
    '});'
)
NEW_JOBS_DETAIL = (
    'app.get("/jobs/:userId/detail/:jobId", async (req, res) => {\n'
    '  try {\n'
    '    const doc = await db.collection("users").doc(req.params.userId).collection("jobs").doc(req.params.jobId).get();\n'
    '    if (!doc.exists) return res.status(404).json({ error: "Job not found" });\n'
    '    res.json({ id: doc.id, ...doc.data() });\n'
    '  } catch (err) {\n'
    '    res.status(500).json({ error: "Failed to load job" });\n'
    '  }\n'
    '});'
)
assert content.count(OLD_JOBS_DETAIL) == 1, "jobs detail route anchor not found"
content = content.replace(OLD_JOBS_DETAIL, NEW_JOBS_DETAIL, 1)

# ── 18. GET /jobs/:userId -> subcollection ────────────────────────────────────
OLD_JOBS_LIST = '    const snap = await db.collection("jobs").where("userId", "==", req.params.userId).get();'
NEW_JOBS_LIST = '    const snap = await db.collection("users").doc(req.params.userId).collection("jobs").get();'
assert content.count(OLD_JOBS_LIST) == 1, "jobs list anchor not found"
content = content.replace(OLD_JOBS_LIST, NEW_JOBS_LIST, 1)

# ── 19. Admin stats: activity -> platform_events ─────────────────────────────
OLD_ADMIN_ACTIVITY = '      db.collection("activity").get(),'
NEW_ADMIN_ACTIVITY = '      db.collection("platform_events").get(),'
assert content.count(OLD_ADMIN_ACTIVITY) == 1, "admin activity anchor not found"
content = content.replace(OLD_ADMIN_ACTIVITY, NEW_ADMIN_ACTIVITY, 1)

# ── 20. watchlist-jobs/detail route -> userId-scoped ─────────────────────────
OLD_WL_DETAIL = (
    '// IMPORTANT: /watchlist-jobs/detail/:jobId must come before /watchlist-jobs/:userId\n'
    'app.get("/watchlist-jobs/detail/:jobId", async (req, res) => {\n'
    '  try {\n'
    '    const doc = await db.collection("watchlistJobs").doc(req.params.jobId).get();\n'
    '    if (!doc.exists) return res.status(404).json({ error: "Job not found" });\n'
    '    res.json({ id: doc.id, ...doc.data() });\n'
    '  } catch (err) {\n'
    '    res.status(500).json({ error: "Failed to load watchlist job" });\n'
    '  }\n'
    '});'
)
NEW_WL_DETAIL = (
    'app.get("/watchlist-jobs/:userId/detail/:jobId", async (req, res) => {\n'
    '  try {\n'
    '    const doc = await db.collection("users").doc(req.params.userId).collection("watchlistJobs").doc(req.params.jobId).get();\n'
    '    if (!doc.exists) return res.status(404).json({ error: "Job not found" });\n'
    '    res.json({ id: doc.id, ...doc.data() });\n'
    '  } catch (err) {\n'
    '    res.status(500).json({ error: "Failed to load watchlist job" });\n'
    '  }\n'
    '});'
)
assert content.count(OLD_WL_DETAIL) == 1, "watchlist detail anchor not found"
content = content.replace(OLD_WL_DETAIL, NEW_WL_DETAIL, 1)

# ── 21. GET /watchlist-jobs/:userId -> subcollection ─────────────────────────
OLD_WL_LIST = '    const snap = await db.collection("watchlistJobs").where("userId", "==", req.params.userId).get();'
NEW_WL_LIST = '    const snap = await db.collection("users").doc(req.params.userId).collection("watchlistJobs").get();'
assert content.count(OLD_WL_LIST) == 1, "watchlist list anchor not found"
content = content.replace(OLD_WL_LIST, NEW_WL_LIST, 1)

# ── 22. checkTargetCompany: seenSnap -> subcollection ────────────────────────
OLD_WL_SEEN = (
    '  const seenSnap = await db.collection("watchlistJobs")\n'
    '    .where("userId", "==", userId)\n'
    '    .where("company", "==", company.name)\n'
    '    .get();'
)
NEW_WL_SEEN = (
    '  const seenSnap = await db.collection("users").doc(userId).collection("watchlistJobs")\n'
    '    .where("company", "==", company.name)\n'
    '    .get();'
)
assert content.count(OLD_WL_SEEN) == 1, "watchlist seenSnap anchor not found"
content = content.replace(OLD_WL_SEEN, NEW_WL_SEEN, 1)

# ── 23. checkTargetCompany: save new jobs -> subcollection ────────────────────
OLD_WL_ADD = '      return db.collection("watchlistJobs").add({'
NEW_WL_ADD = '      return db.collection("users").doc(userId).collection("watchlistJobs").add({'
assert content.count(OLD_WL_ADD) == 1, "watchlist add anchor not found"
content = content.replace(OLD_WL_ADD, NEW_WL_ADD, 1)

# ── 24. onUserDeleted: simplify -- remove now-redundant field-query deletes ───
OLD_ON_DELETE = (
    '  await Promise.all([\n'
    '    // 1. Recursively delete the entire uid-keyed user subtree.\n'
    '    //    Covers /users/{uid}/onboarding/state now, and every subcollection\n'
    '    //    added in future migrations automatically -- no edits needed here.\n'
    '    admin.firestore().recursiveDelete(db.collection("users").doc(uid)),\n'
    '\n'
    '    // 2. Email-keyed user doc + all subcollections (preferences, knowledge, usage).\n'
    '    //    recursiveDelete handles the full subtree in one call.\n'
    '    admin.firestore().recursiveDelete(db.collection("users").doc(email)),\n'
    '\n'
    '    // 3. Remaining flat top-level collections not yet migrated.\n'
    '    db.collection("fcmTokens")      .doc(email).delete(),\n'
    '    db.collection("targetCompanies").doc(email).delete(),\n'
    '\n'
    '    // 4. Collections that store userId as a field -- query + batch-delete.\n'
    '    deleteQuery(db.collection("jobs")          .where("userId", "==", email)),\n'
    '    deleteQuery(db.collection("applications")  .where("userId", "==", email)),\n'
    '    deleteQuery(db.collection("documents")     .where("userId", "==", email)),\n'
    '    deleteQuery(db.collection("digests")       .where("userId", "==", email)),\n'
    '    deleteQuery(db.collection("activity")      .where("userId", "==", email)),\n'
    '    deleteQuery(db.collection("watchlistJobs") .where("userId", "==", email)),\n'
    '    // chats: cover both doc-keyed-by-email and userId-field patterns\n'
    '    db.collection("chats").doc(email).delete(),\n'
    '    deleteQuery(db.collection("chats").where("userId", "==", email)),\n'
    '  ]);'
)
NEW_ON_DELETE = (
    '  await Promise.all([\n'
    '    // 1. UID-keyed subtree (onboarding/state, and any future UID-keyed data).\n'
    '    admin.firestore().recursiveDelete(db.collection("users").doc(uid)),\n'
    '\n'
    '    // 2. Email-keyed user subtree: preferences, knowledge, usage, jobs,\n'
    '    //    documents, applications, watchlistJobs -- all now subcollections.\n'
    '    //    recursiveDelete handles the entire tree in one call.\n'
    '    admin.firestore().recursiveDelete(db.collection("users").doc(email)),\n'
    '\n'
    '    // 3. Flat top-level docs keyed by email.\n'
    '    db.collection("fcmTokens")      .doc(email).delete(),\n'
    '    db.collection("targetCompanies").doc(email).delete(),\n'
    '    db.collection("chats")          .doc(email).delete(),\n'
    '\n'
    '    // 4. Field-keyed collections not yet migrated to subcollections.\n'
    '    deleteQuery(db.collection("digests")        .where("userId", "==", email)),\n'
    '    deleteQuery(db.collection("platform_events").where("userId", "==", email)),\n'
    '    deleteQuery(db.collection("chats")          .where("userId", "==", email)),\n'
    '  ]);'
)
assert content.count(OLD_ON_DELETE) == 1, "onUserDeleted body anchor not found"
content = content.replace(OLD_ON_DELETE, NEW_ON_DELETE, 1)

# ── 25. Add weeklyJobCacheCleanup before dailyWatchlistCheck ─────────────────
OLD_WATCHLIST_SCHED = 'exports.dailyWatchlistCheck = onSchedule('
NEW_CACHE_CLEANUP = (
    '// ── Weekly jobs_cache cleanup ─────────────────────────────────────────────────────\n'
    'exports.weeklyJobCacheCleanup = onSchedule(\n'
    '  { schedule: "0 2 * * 0", timeZone: "UTC",\n'
    '    secrets: ["ANTHROPIC_API_KEY"] },\n'
    '  async () => {\n'
    '    try {\n'
    '      const staleSnap = await db.collection("jobs_cache")\n'
    '        .where("expiresAt", "<", new Date())\n'
    '        .limit(500)\n'
    '        .get();\n'
    '      if (staleSnap.empty) {\n'
    '        console.log("[weeklyJobCacheCleanup] No stale entries found");\n'
    '        return;\n'
    '      }\n'
    '      let batch = db.batch();\n'
    '      let count = 0;\n'
    '      for (const doc of staleSnap.docs) {\n'
    '        batch.delete(doc.ref);\n'
    '        if (++count === 400) { await batch.commit(); batch = db.batch(); count = 0; }\n'
    '      }\n'
    '      if (count > 0) await batch.commit();\n'
    '      console.log("[weeklyJobCacheCleanup] Deleted " + staleSnap.size + " stale cache entries");\n'
    '    } catch (err) {\n'
    '      console.error("[weeklyJobCacheCleanup] Error:", err.message);\n'
    '    }\n'
    '  }\n'
    ');\n\n'
    'exports.dailyWatchlistCheck = onSchedule('
)
assert content.count(OLD_WATCHLIST_SCHED) == 1, "dailyWatchlistCheck anchor not found"
content = content.replace(OLD_WATCHLIST_SCHED, NEW_CACHE_CLEANUP, 1)

# ─── Write functions/index.js ────────────────────────────────────────────────
with open("functions/index.js", "w", encoding="utf-8") as f:
    f.write(content)
print("functions/index.js updated successfully")

# ─── docs/app.js ─────────────────────────────────────────────────────────────

with open("docs/app.js", "r", encoding="utf-8") as f:
    app_content = f.read()

# ── A. job detail URLs -> userId-scoped ──────────────────────────────────────
OLD_DETAIL_URLS = (
    '    const endpoint = source === "watchlist"\n'
    '      ? `${BACKEND_URL}/watchlist-jobs/detail/${encodeURIComponent(jobId)}`\n'
    '      : `${BACKEND_URL}/jobs/detail/${encodeURIComponent(jobId)}`;'
)
NEW_DETAIL_URLS = (
    '    const endpoint = source === "watchlist"\n'
    '      ? `${BACKEND_URL}/watchlist-jobs/${encodeURIComponent(userId)}/detail/${encodeURIComponent(jobId)}`\n'
    '      : `${BACKEND_URL}/jobs/${encodeURIComponent(userId)}/detail/${encodeURIComponent(jobId)}`;'
)
assert app_content.count(OLD_DETAIL_URLS) == 1, "detail URL anchor not found in app.js"
app_content = app_content.replace(OLD_DETAIL_URLS, NEW_DETAIL_URLS, 1)

# ── B. DELETE document URL -> userId-scoped ───────────────────────────────────
OLD_DEL_DOC = '  await fetch(`${BACKEND_URL}/documents/${id}`, { method: "DELETE" });'
NEW_DEL_DOC = '  await fetch(`${BACKEND_URL}/documents/${encodeURIComponent(userId)}/${id}`, { method: "DELETE" });'
assert app_content.count(OLD_DEL_DOC) == 1, "delete document URL anchor not found in app.js"
app_content = app_content.replace(OLD_DEL_DOC, NEW_DEL_DOC, 1)

# ── C. DELETE application URL -> userId-scoped ────────────────────────────────
OLD_DEL_APP = '  await fetch(`${BACKEND_URL}/applications/${id}`, { method: "DELETE" });'
NEW_DEL_APP = '  await fetch(`${BACKEND_URL}/applications/${encodeURIComponent(userId)}/${id}`, { method: "DELETE" });'
assert app_content.count(OLD_DEL_APP) == 1, "delete application URL anchor not found in app.js"
app_content = app_content.replace(OLD_DEL_APP, NEW_DEL_APP, 1)

# ─── Write docs/app.js ───────────────────────────────────────────────────────
with open("docs/app.js", "w", encoding="utf-8") as f:
    f.write(app_content)
print("docs/app.js updated successfully")

print("\nAll changes applied. Run `node --check functions/index.js` to verify syntax.")
