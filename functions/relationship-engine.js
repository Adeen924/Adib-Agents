"use strict";

/**
 * relationship-engine.js — Relationship Intelligence Engine
 *
 * Exports:
 *   computeRelationshipScore(connection, userProfile)
 *   processImportedContacts(userId, importId, rawContacts)
 *   getNetworkDashboard(userId)
 *   getWarmJobPaths(userId)
 *   generateOutreachMessage(params, anthropic)
 *   analyzeNetworkGaps(userId, userProfile)
 *   syncExtensionContacts(userId, contacts)
 *   generateExtensionToken(userId)
 *   verifyExtensionToken(token)
 *   deleteAllNetworkData(userId)
 */

const crypto = require("crypto");
const admin  = require("firebase-admin");

// ── Firestore shortcuts ───────────────────────────────────────────────────────
function fdb() { return admin.firestore(); }
function userColl(userId, sub) {
  return fdb().collection("users").doc(userId).collection(sub);
}

// ── computeRelationshipScore ──────────────────────────────────────────────────
/**
 * Compute a 0-100 relationship score and tier for a connection.
 *
 * Scoring breakdown (max 100):
 *   Email Frequency   0-25
 *   Shared School     0-15
 *   Shared Employer   0-15
 *   Recruiter bonus   0-15
 *   Seniority         0-10
 *   Company Relevance 0-10
 *   Job Match         0-10
 *
 * @param {object} connection  — Connection document
 * @param {object} userProfile — { targetCompanies: string[], targetIndustry: string, jobs: object[] }
 * @returns {{ score: number, tier: string, breakdown: object }}
 */
function computeRelationshipScore(connection, userProfile = {}) {
  let score = 0;
  const breakdown = {};

  // ── Email Frequency (0-25) ────────────────────────────────────────────────
  const ef = connection.emailFrequency || 0;
  let emailPts;
  if      (ef === 0)       emailPts = 0;
  else if (ef <= 5)        emailPts = 5;
  else if (ef <= 20)       emailPts = 12;
  else if (ef <= 50)       emailPts = 18;
  else                     emailPts = 25;
  breakdown.emailFrequency = emailPts;
  score += emailPts;

  // ── Shared School (0-15) ──────────────────────────────────────────────────
  const sharedSchools = (connection.sharedSchools || []).length;
  const schoolPts     = sharedSchools >= 1 ? 15 : 0;
  breakdown.sharedSchool = schoolPts;
  score += schoolPts;

  // ── Shared Employer (0-15) ────────────────────────────────────────────────
  const sharedEmployers = (connection.sharedEmployers || []).length;
  const employerPts     = sharedEmployers >= 1 ? 12 : 0;
  breakdown.sharedEmployer = employerPts;
  score += employerPts;

  // ── Recruiter bonus (0-15) ────────────────────────────────────────────────
  let recruiterPts = 0;
  if (connection.isRecruiter) {
    recruiterPts = 15;
  } else if ((connection.recruiterConfidence || 0) > 0.5) {
    recruiterPts = 8;
  }
  breakdown.recruiter = recruiterPts;
  score += recruiterPts;

  // ── Seniority (0-10) ─────────────────────────────────────────────────────
  const seniorityMap = { executive: 10, senior: 7, mid: 4, entry: 1, unknown: 0 };
  const seniorityPts = seniorityMap[connection.seniority] ?? 0;
  breakdown.seniority = seniorityPts;
  score += seniorityPts;

  // ── Company Relevance (0-10) ──────────────────────────────────────────────
  const targetCompanies = (userProfile.targetCompanies || []).map(c => c.toLowerCase());
  const connCompany     = (connection.company || "").toLowerCase();
  const connDomain      = (connection.inferredDomain || "").toLowerCase();
  let relevancePts = 0;
  if (
    connCompany &&
    targetCompanies.some(tc => connCompany.includes(tc) || tc.includes(connCompany))
  ) {
    relevancePts = 10;
  } else if (
    connDomain &&
    targetCompanies.some(tc => connDomain.includes(tc.replace(/\s+/g, "")))
  ) {
    relevancePts = 8;
  }
  breakdown.companyRelevance = relevancePts;
  score += relevancePts;

  // ── Job Match (0-10) ──────────────────────────────────────────────────────
  const userJobs  = userProfile.jobs || [];
  let jobMatchPts = 0;
  for (const job of userJobs) {
    const jobCompany  = (job.company || "").toLowerCase();
    const jobIndustry = (job.industry || "").toLowerCase();
    if (connCompany && jobCompany && connCompany.includes(jobCompany)) {
      jobMatchPts = 10;
      break;
    }
    if (jobIndustry && (connection.sharedIndustries || []).some(i => i.toLowerCase().includes(jobIndustry))) {
      jobMatchPts = Math.max(jobMatchPts, 5);
    }
  }
  breakdown.jobMatch = jobMatchPts;
  score += jobMatchPts;

  // ── Cap at 100 ────────────────────────────────────────────────────────────
  score = Math.min(100, Math.max(0, score));

  // ── Tier ─────────────────────────────────────────────────────────────────
  let tier;
  if      (score >= 75) tier = "close";
  else if (score >= 50) tier = "strong";
  else if (score >= 25) tier = "moderate";
  else                  tier = "weak";

  return { score, tier, breakdown };
}

// ── processImportedContacts ───────────────────────────────────────────────────
/**
 * Score and write contacts to Firestore after import.
 * Called with already-mapped Connection objects (from google-oauth mapPersonToConnection).
 * @param {string}   userId
 * @param {string}   importId
 * @param {object[]} rawContacts — Connection-schema objects
 * @returns {{ processed: number }}
 */
async function processImportedContacts(userId, importId, rawContacts) {
  if (!rawContacts || rawContacts.length === 0) return { processed: 0 };

  // Fetch user profile for scoring context
  const userSnap = await fdb().collection("users").doc(userId).get();
  const userProfile = userSnap.exists ? {
    targetCompanies: (userSnap.data().targetCompanies || []).map(c => c.name || c),
    targetIndustry:  userSnap.data().targetIndustry || "",
    jobs:            [],
  } : { targetCompanies: [], targetIndustry: "", jobs: [] };

  // Fetch active job pipeline for job-match scoring
  try {
    const jobsSnap = await fdb().collection("users").doc(userId)
      .collection("jobs").limit(50).get();
    userProfile.jobs = jobsSnap.docs.map(d => d.data());
  } catch { /* non-critical */ }

  const connColl  = userColl(userId, "connections");
  const BATCH_SIZE = 400;
  let processed    = 0;

  for (let i = 0; i < rawContacts.length; i += BATCH_SIZE) {
    const chunk = rawContacts.slice(i, i + BATCH_SIZE);
    const batch = fdb().batch();

    for (const conn of chunk) {
      const { score, tier, breakdown } = computeRelationshipScore(conn, userProfile);
      const ref = connColl.doc(conn.id);
      batch.set(ref, {
        ...conn,
        relationshipScore: score,
        relationshipTier:  tier,
        scoreBreakdown:    breakdown,
        updatedAt:         admin.firestore.FieldValue.serverTimestamp(),
      }, { merge: true });
    }

    await batch.commit();
    processed += chunk.length;
  }

  // Update import record
  await fdb().collection("users").doc(userId)
    .collection("network_imports").doc(importId)
    .set({ status: "completed", contactsProcessed: processed, progress: 100 }, { merge: true });

  return { processed };
}

// ── getNetworkDashboard ───────────────────────────────────────────────────────
/**
 * Aggregate network statistics for the dashboard widget.
 * @param {string} userId
 * @returns {{ stats: DashboardStats }}
 */
async function getNetworkDashboard(userId) {
  const connSnap    = await userColl(userId, "connections").get();
  const connections = connSnap.docs.map(d => d.data());

  const total        = connections.length;
  const recruiters   = connections.filter(c => c.isRecruiter).length;
  const executives   = connections.filter(c => c.seniority === "executive").length;
  const strong       = connections.filter(c => ["strong", "close"].includes(c.relationshipTier)).length;

  // Company count
  const companySnap  = await userColl(userId, "network_companies").get();
  const companies    = companySnap.size;

  // Outreach sent this month
  const monthAgo     = new Date(Date.now() - 30 * 24 * 60 * 60 * 1000);
  const outSnap      = await userColl(userId, "outreach_history")
    .where("createdAt", ">=", monthAgo).get();

  // Tier distribution
  const tierDist = { weak: 0, moderate: 0, strong: 0, close: 0 };
  for (const c of connections) {
    const t = c.relationshipTier || "weak";
    tierDist[t] = (tierDist[t] || 0) + 1;
  }

  // Top companies by connection count
  const topCompanies = companySnap.docs
    .map(d => ({ name: d.data().name, count: d.data().connectionCount || 0 }))
    .sort((a, b) => b.count - a.count)
    .slice(0, 5);

  return {
    stats: {
      totalConnections: total,
      recruiterCount:   recruiters,
      executiveCount:   executives,
      strongTieCount:   strong,
      companiesCount:   companies,
      outreachThisMonth: outSnap.size,
      tierDistribution: tierDist,
      topCompanies,
    },
  };
}

// ── getWarmJobPaths ───────────────────────────────────────────────────────────
/**
 * Cross-reference user's job pipeline with their network connections.
 * @param {string} userId
 * @returns {{ jobs: WarmJob[] }}
 */
async function getWarmJobPaths(userId) {
  // Fetch active jobs
  let jobDocs = [];
  try {
    const snap = await fdb().collection("users").doc(userId)
      .collection("jobs").limit(100).get();
    jobDocs = snap.docs.map(d => ({ id: d.id, ...d.data() }));
  } catch { return { jobs: [] }; }

  if (jobDocs.length === 0) return { jobs: [] };

  // Fetch connections
  const connSnap    = await userColl(userId, "connections").get();
  const connections = connSnap.docs.map(d => d.data());

  const warmJobs = [];

  for (const job of jobDocs) {
    const jobCompany  = (job.company  || "").toLowerCase().trim();
    const jobDomain   = (job.domain   || "").toLowerCase().trim();
    const jobIndustry = (job.industry || "").toLowerCase().trim();

    const insiders = [];  // connections at the exact company
    const industry = [];  // connections in same industry

    for (const conn of connections) {
      const connCompany = (conn.company        || "").toLowerCase();
      const connDomain  = (conn.inferredDomain || "").toLowerCase();

      const sameCompany =
        (jobCompany && connCompany && (
          connCompany.includes(jobCompany) || jobCompany.includes(connCompany)
        )) ||
        (jobDomain && connDomain && connDomain === jobDomain);

      if (sameCompany) {
        insiders.push({
          id:               conn.id,
          fullName:         conn.fullName,
          title:            conn.title,
          isRecruiter:      conn.isRecruiter,
          seniority:        conn.seniority,
          relationshipTier: conn.relationshipTier,
          emails:           (conn.emails || []).slice(0, 1), // only first for privacy
        });
      } else if (jobIndustry && (conn.sharedIndustries || []).some(i => i.toLowerCase().includes(jobIndustry))) {
        industry.push({
          id:       conn.id,
          fullName: conn.fullName,
          title:    conn.title,
          company:  conn.company,
        });
      }
    }

    if (insiders.length > 0 || industry.length > 0) {
      warmJobs.push({
        jobId:           job.id,
        jobTitle:        job.title  || "",
        company:         job.company || "",
        jobStatus:       job.status || "",
        insiderCount:    insiders.length,
        industryCount:   industry.length,
        insiders:        insiders.slice(0, 10),
        industryContacts: industry.slice(0, 5),
        warmScore:       insiders.length * 10 + industry.length * 3,
      });
    }
  }

  warmJobs.sort((a, b) => b.warmScore - a.warmScore);

  return { jobs: warmJobs };
}

// ── generateOutreachMessage ───────────────────────────────────────────────────
/**
 * Generate a personalized outreach message using Claude.
 * @param {object} params
 *   - connection     {object}  Connection document
 *   - messageType    {string}  linkedin_outreach | recruiter_intro | alumni_message | referral_request | follow_up
 *   - jobTitle       {string}  Target role (optional)
 *   - company        {string}  Target company (optional)
 *   - userBackground {string}  Brief user background
 *   - tone           {string}  professional | casual | warm
 *   - premium        {boolean} Use Sonnet instead of Haiku
 * @param {object} anthropic — Anthropic SDK client instance
 * @returns {{ message: string, tone: string, keySignals: string[] }}
 */
async function generateOutreachMessage(params, anthropic) {
  const {
    connection,
    messageType    = "linkedin_outreach",
    jobTitle       = "",
    company        = "",
    userBackground = "",
    tone           = "professional",
    premium        = false,
  } = params;

  const model = premium ? "claude-sonnet-4-6" : "claude-haiku-4-5-20251001";

  // Compute shared signals for personalization
  const signals = [];
  if ((connection.sharedSchools || []).length > 0) {
    signals.push(`shared school: ${connection.sharedSchools[0]}`);
  }
  if ((connection.sharedEmployers || []).length > 0) {
    signals.push(`former colleague at ${connection.sharedEmployers[0]}`);
  }
  if (connection.isRecruiter) {
    signals.push("works in talent/recruiting");
  }
  if (connection.emailFrequency > 5) {
    signals.push("have corresponded before");
  }
  if (connection.seniority === "executive") {
    signals.push("executive-level contact");
  }

  const signalText = signals.length > 0
    ? `Shared signals to reference: ${signals.join(", ")}.`
    : "No direct shared signals — keep generic but still specific to their role.";

  const typeInstructions = {
    linkedin_outreach: "Write a LinkedIn connection request note (MAX 300 characters). Be direct about why you're connecting.",
    recruiter_intro:   "Write a brief recruiter introduction (under 120 words). Express interest in opportunities at their company.",
    alumni_message:    "Write an alumni outreach message (under 120 words). Lead with the shared school connection.",
    referral_request:  "Write a referral request message (under 150 words). Be specific about the role and why you'd be a fit.",
    follow_up:         "Write a brief follow-up message (under 80 words). Reference a previous interaction.",
  };

  const systemPrompt = `You are an expert career coach who writes highly personalized professional outreach messages.

Rules you MUST follow:
1. NEVER start with "I came across your profile" or any generic opener
2. Lead with the most compelling shared signal or a specific observation about their work
3. Keep LinkedIn messages under 120 words (300 chars for connection requests)
4. Match the requested tone: ${tone}
5. Be specific — reference their actual company/title/background
6. End with a clear, low-friction call to action
7. No emojis unless tone is casual
8. Sound human, not templated`;

  const userPrompt = `Write a ${messageType.replace(/_/g, " ")} message.

Recipient:
- Name: ${connection.fullName}
- Title: ${connection.title || "Unknown"}
- Company: ${connection.company || "Unknown"}
- Seniority: ${connection.seniority}

${signalText}

${jobTitle ? `Target role: ${jobTitle}` : ""}
${company  ? `Target company: ${company}` : ""}
${userBackground ? `My background: ${userBackground}` : ""}

Instructions: ${typeInstructions[messageType] || typeInstructions.linkedin_outreach}

Return ONLY the message text — no subject lines, no preamble, no explanation.`;

  const response = await anthropic.messages.create({
    model,
    max_tokens: 400,
    messages: [{ role: "user", content: userPrompt }],
    system: systemPrompt,
  });

  const message = response.content[0]?.text?.trim() || "";

  return {
    message,
    tone,
    model,
    keySignals: signals,
    messageType,
    inputTokens:  response.usage?.input_tokens  || 0,
    outputTokens: response.usage?.output_tokens || 0,
  };
}

// ── analyzeNetworkGaps ────────────────────────────────────────────────────────
/**
 * Identify missing network areas and provide actionable recommendations.
 * @param {string} userId
 * @param {object} userProfile — { targetCompanies, targetIndustry, targetRoles }
 * @returns {{ gaps: Gap[], stats: NetworkStats }}
 */
async function analyzeNetworkGaps(userId, userProfile = {}) {
  const connSnap    = await userColl(userId, "connections").get();
  const connections = connSnap.docs.map(d => d.data());

  const gaps = [];

  // ── Gap 1: Missing recruiter connections ──────────────────────────────────
  const recruiterCount = connections.filter(c => c.isRecruiter).length;
  if (recruiterCount < 3) {
    gaps.push({
      type:        "low_recruiter_count",
      severity:    recruiterCount === 0 ? "high" : "medium",
      title:       "Few recruiter connections",
      description: `You have ${recruiterCount} recruiter connection${recruiterCount === 1 ? "" : "s"}. Aim for at least 3 active recruiters in your target industry.`,
      recommendation: "Search LinkedIn for 'Technical Recruiter' or 'Talent Acquisition' at your target companies and send connection requests.",
      metric: { current: recruiterCount, target: 3 },
    });
  }

  // ── Gap 2: No connections at target companies ─────────────────────────────
  const targetCompanies = (userProfile.targetCompanies || []).map(c =>
    (typeof c === "string" ? c : c.name || "").toLowerCase()
  ).filter(Boolean);

  const missingCompanies = [];
  for (const tc of targetCompanies) {
    const hasConn = connections.some(c =>
      (c.company || "").toLowerCase().includes(tc) ||
      (c.inferredDomain || "").toLowerCase().includes(tc.replace(/\s+/g, ""))
    );
    if (!hasConn) missingCompanies.push(tc);
  }

  if (missingCompanies.length > 0) {
    gaps.push({
      type:        "no_target_company_connections",
      severity:    "high",
      title:       `No connections at ${missingCompanies.length} target company${missingCompanies.length > 1 ? "ies" : ""}`,
      description: `You have no network contacts at: ${missingCompanies.slice(0, 3).join(", ")}${missingCompanies.length > 3 ? ` and ${missingCompanies.length - 3} more` : ""}.`,
      recommendation: "Use LinkedIn to find employees at these companies. Alumni connections are the easiest first step.",
      metric: { missing: missingCompanies, count: missingCompanies.length },
    });
  }

  // ── Gap 3: Weak network in target industry ────────────────────────────────
  const targetIndustry = (userProfile.targetIndustry || "").toLowerCase();
  if (targetIndustry) {
    const industryConns = connections.filter(c =>
      (c.sharedIndustries || []).some(i => i.toLowerCase().includes(targetIndustry)) ||
      (c.company || "").toLowerCase().includes(targetIndustry)
    );
    if (industryConns.length < 5) {
      gaps.push({
        type:        "weak_industry_network",
        severity:    "medium",
        title:       `Limited ${targetIndustry} industry connections`,
        description: `Only ${industryConns.length} of your connections are in the ${targetIndustry} industry.`,
        recommendation: `Join industry-specific LinkedIn groups and attend virtual events to expand your ${targetIndustry} network.`,
        metric: { current: industryConns.length, target: 10 },
      });
    }
  }

  // ── Gap 4: No executive-level connections ─────────────────────────────────
  const execCount = connections.filter(c => c.seniority === "executive").length;
  if (execCount === 0) {
    gaps.push({
      type:        "no_executive_connections",
      severity:    "medium",
      title:       "No executive-level connections",
      description: "You have no VP, Director, or C-suite connections. Senior sponsors can accelerate job referrals.",
      recommendation: "Identify 2-3 leaders at your target companies and send thoughtful, personalized connection requests.",
      metric: { current: 0, target: 2 },
    });
  }

  // ── Gap 5: No alumni connections ──────────────────────────────────────────
  const alumniCount = connections.filter(c => (c.sharedSchools || []).length > 0).length;
  if (alumniCount === 0) {
    gaps.push({
      type:        "no_alumni_connections",
      severity:    "low",
      title:       "No alumni connections leveraged",
      description: "Alumni are statistically the easiest warm introductions. None of your connections share a school with you.",
      recommendation: "Use your university's alumni directory or LinkedIn alumni tool to find graduates at your target companies.",
      metric: { current: 0, target: 3 },
    });
  }

  // ── Network stats ─────────────────────────────────────────────────────────
  const tierDist = { weak: 0, moderate: 0, strong: 0, close: 0 };
  for (const c of connections) {
    const t = c.relationshipTier || "weak";
    tierDist[t] = (tierDist[t] || 0) + 1;
  }

  return {
    gaps,
    stats: {
      totalConnections: connections.length,
      recruiterCount,
      execCount,
      alumniCount,
      tierDistribution: tierDist,
    },
  };
}

// ── syncExtensionContacts ─────────────────────────────────────────────────────
/**
 * Process contacts synced from the Chrome extension (LinkedIn scraping).
 * Deduplicates against existing connections by LinkedIn URL or email.
 * @param {string}   userId
 * @param {object[]} contacts — Raw contacts from extension (partial Connection schema)
 * @returns {{ synced: number, deduplicated: number }}
 */
async function syncExtensionContacts(userId, contacts) {
  if (!contacts || contacts.length === 0) return { synced: 0, deduplicated: 0 };

  const { inferSeniority, detectRecruiter, inferDomainFromEmail } = require("./google-oauth");

  // Load existing connections for deduplication
  const existingSnap = await userColl(userId, "connections").get();
  const existingUrls = new Set();
  const existingEmails = new Set();

  for (const doc of existingSnap.docs) {
    const d = doc.data();
    if (d.linkedinUrl) existingUrls.add(d.linkedinUrl.toLowerCase());
    for (const e of (d.emails || [])) existingEmails.add(e.toLowerCase());
  }

  // Fetch user profile for scoring
  const userSnap = await fdb().collection("users").doc(userId).get();
  const userProfile = userSnap.exists ? {
    targetCompanies: (userSnap.data().targetCompanies || []).map(c => c.name || c),
    jobs: [],
  } : { targetCompanies: [], jobs: [] };

  const connColl  = userColl(userId, "connections");
  let synced      = 0;
  let deduplicated = 0;

  const BATCH_SIZE = 400;
  const toWrite    = [];

  for (const raw of contacts) {
    // Normalize
    const linkedinUrl = (raw.linkedinUrl || raw.linkedin_url || "").toLowerCase().trim();
    const emails      = Array.isArray(raw.emails) ? raw.emails.map(e => e.toLowerCase()) :
                        raw.email ? [raw.email.toLowerCase()] : [];

    // Deduplication check
    const isDuplicate =
      (linkedinUrl && existingUrls.has(linkedinUrl)) ||
      emails.some(e => existingEmails.has(e));

    if (isDuplicate) {
      deduplicated++;
      continue;
    }

    const title    = raw.title || raw.headline || "";
    const company  = raw.company || raw.currentCompany || "";
    const { isRecruiter, recruiterConfidence } = detectRecruiter(title);
    const seniority = inferSeniority(title);
    const inferredDomain = inferDomainFromEmail(emails) ||
      (company ? company.toLowerCase().replace(/[^a-z0-9]/g, "") + ".com" : "");

    const id = linkedinUrl
      ? crypto.createHash("md5").update(linkedinUrl).digest("hex").slice(0, 20)
      : crypto.randomUUID();

    const conn = {
      id,
      fullName:          raw.fullName || raw.name || `${raw.firstName || ""} ${raw.lastName || ""}`.trim() || "Unknown",
      firstName:         raw.firstName || "",
      lastName:          raw.lastName  || "",
      emails,
      phones:            raw.phones || [],
      company,
      title,
      linkedinUrl,
      inferredDomain,
      source:            "linkedin_extension",
      emailFrequency:    0,
      lastContactDate:   null,
      sharedSchools:     raw.sharedSchools    || [],
      sharedEmployers:   raw.sharedEmployers  || [],
      sharedIndustries:  raw.sharedIndustries || [],
      isRecruiter,
      recruiterConfidence,
      isHiringManager:   /hiring manager|hiring lead/i.test(title),
      seniority,
      relationshipScore: 0,
      relationshipTier:  "weak",
      importedAt:        admin.firestore.FieldValue.serverTimestamp(),
      updatedAt:         admin.firestore.FieldValue.serverTimestamp(),
      consentVersion:    "1.0",
    };

    // Score it
    const { score, tier } = computeRelationshipScore(conn, userProfile);
    conn.relationshipScore = score;
    conn.relationshipTier  = tier;

    toWrite.push({ id, conn });

    // Track for dedup within this batch
    if (linkedinUrl) existingUrls.add(linkedinUrl);
    for (const e of emails) existingEmails.add(e);
  }

  // Batch write
  for (let i = 0; i < toWrite.length; i += BATCH_SIZE) {
    const chunk = toWrite.slice(i, i + BATCH_SIZE);
    const batch = fdb().batch();
    for (const { id, conn } of chunk) {
      batch.set(connColl.doc(id), conn, { merge: true });
    }
    await batch.commit();
    synced += chunk.length;
  }

  return { synced, deduplicated };
}

// ── generateExtensionToken ────────────────────────────────────────────────────
/**
 * Create a 30-day extension access token for the Chrome extension.
 * Stored in users/{userId}/extension_tokens/{tokenId}.
 * @param {string} userId
 * @returns {{ token: string, expiresAt: string }}
 */
async function generateExtensionToken(userId) {
  const tokenId   = crypto.randomUUID();
  const rawToken  = crypto.randomBytes(32).toString("hex");
  // Hash the raw token for storage (only the hash is stored)
  const tokenHash = crypto.createHash("sha256").update(rawToken).digest("hex");

  const expiresAt = new Date(Date.now() + 30 * 24 * 60 * 60 * 1000);

  await userColl(userId, "extension_tokens").doc(tokenId).set({
    tokenHash,
    tokenId,
    userId,
    createdAt:  admin.firestore.FieldValue.serverTimestamp(),
    expiresAt:  expiresAt.toISOString(),
    revoked:    false,
  });

  // The token sent to client: tokenId.rawToken (tokenId used to look up the hash)
  const token = `${tokenId}.${rawToken}`;
  return { token, expiresAt: expiresAt.toISOString() };
}

// ── verifyExtensionToken ──────────────────────────────────────────────────────
/**
 * Verify an extension token and return the associated userId.
 * @param {string} token — "tokenId.rawToken" format
 * @returns {{ userId: string, tokenId: string }}
 */
async function verifyExtensionToken(token) {
  if (!token || !token.includes(".")) throw new Error("Invalid token format");

  const dotIdx   = token.indexOf(".");
  const tokenId  = token.slice(0, dotIdx);
  const rawToken = token.slice(dotIdx + 1);

  if (!tokenId || !rawToken) throw new Error("Malformed token");

  // Query all users' extension_tokens subcollections is impractical —
  // we embed userId in token docs via a collectionGroup query.
  const snap = await fdb().collectionGroup("extension_tokens")
    .where("tokenId", "==", tokenId)
    .limit(1)
    .get();

  if (snap.empty) throw new Error("Token not found");

  const data = snap.docs[0].data();

  if (data.revoked) throw new Error("Token has been revoked");
  if (new Date(data.expiresAt) < new Date()) throw new Error("Token has expired");

  const expectedHash = crypto.createHash("sha256").update(rawToken).digest("hex");
  if (data.tokenHash !== expectedHash) throw new Error("Invalid token");

  return { userId: data.userId, tokenId };
}

// ── deleteAllNetworkData ──────────────────────────────────────────────────────
/**
 * Privacy deletion — remove all network-related data for a user.
 * @param {string} userId
 * @returns {{ deleted: number }}
 */
async function deleteAllNetworkData(userId) {
  const firestoreDb = fdb();
  const userRef     = firestoreDb.collection("users").doc(userId);

  const subcollections = [
    "connections",
    "network_companies",
    "network_imports",
    "oauth_tokens",
    "outreach_history",
    "extension_tokens",
  ];

  let deleted = 0;

  for (const sub of subcollections) {
    const snap = await userRef.collection(sub).limit(500).get();
    if (snap.empty) continue;

    let batch = firestoreDb.batch();
    let count = 0;

    for (const doc of snap.docs) {
      batch.delete(doc.ref);
      deleted++;
      if (++count === 400) {
        await batch.commit();
        batch = firestoreDb.batch();
        count = 0;
      }
    }
    if (count > 0) await batch.commit();
  }

  return { deleted };
}

module.exports = {
  computeRelationshipScore,
  processImportedContacts,
  getNetworkDashboard,
  getWarmJobPaths,
  generateOutreachMessage,
  analyzeNetworkGaps,
  syncExtensionContacts,
  generateExtensionToken,
  verifyExtensionToken,
  deleteAllNetworkData,
};
