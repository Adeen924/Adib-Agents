"use strict";

/**
 * google-oauth.js — Google OAuth2 + People API + Gmail metadata helper
 *
 * Env vars required:
 *   GOOGLE_CLIENT_ID      — OAuth2 client ID
 *   GOOGLE_CLIENT_SECRET  — OAuth2 client secret
 *   ENCRYPTION_KEY        — 32 hex chars (16 bytes) for AES-256-GCM token storage
 *
 * All HTTP calls use Node 22 built-in fetch.
 * All encryption uses Node built-in crypto.
 */

const crypto = require("crypto");
const admin  = require("firebase-admin");

const db = admin.firestore;  // getter — call as db() inside functions after initializeApp()

// ── Encryption helpers ────────────────────────────────────────────────────────
// AES-256-GCM: 256-bit key derived from the 32-hex-char env var (16 bytes → stretched to 32)
// We SHA-256 the raw env value so the caller can provide any length secret.

function getEncryptionKey() {
  const raw = process.env.ENCRYPTION_KEY || "";
  if (!raw) throw new Error("ENCRYPTION_KEY env var is not set");
  return crypto.createHash("sha256").update(raw).digest(); // 32 bytes
}

function encrypt(plaintext) {
  const key  = getEncryptionKey();
  const iv   = crypto.randomBytes(12); // 96-bit IV for GCM
  const cipher = crypto.createCipheriv("aes-256-gcm", key, iv);
  const enc  = Buffer.concat([cipher.update(plaintext, "utf8"), cipher.final()]);
  const tag  = cipher.getAuthTag();
  // iv:tag:ciphertext — all base64
  return `${iv.toString("base64")}:${tag.toString("base64")}:${enc.toString("base64")}`;
}

function decrypt(stored) {
  const [ivB64, tagB64, encB64] = stored.split(":");
  if (!ivB64 || !tagB64 || !encB64) throw new Error("Invalid encrypted format");
  const key    = getEncryptionKey();
  const iv     = Buffer.from(ivB64,  "base64");
  const tag    = Buffer.from(tagB64, "base64");
  const enc    = Buffer.from(encB64, "base64");
  const decipher = crypto.createDecipheriv("aes-256-gcm", key, iv);
  decipher.setAuthTag(tag);
  return Buffer.concat([decipher.update(enc), decipher.final()]).toString("utf8");
}

// ── OAuth constants ───────────────────────────────────────────────────────────
const GOOGLE_TOKEN_URL    = "https://oauth2.googleapis.com/token";
const GOOGLE_REVOKE_URL   = "https://oauth2.googleapis.com/revoke";
const GOOGLE_USERINFO_URL = "https://www.googleapis.com/oauth2/v3/userinfo";
const PEOPLE_API_BASE     = "https://people.googleapis.com/v1/people/me/connections";
const GMAIL_THREADS_URL   = "https://gmail.googleapis.com/gmail/v1/users/me/threads";

const OAUTH_SCOPES = [
  "https://www.googleapis.com/auth/contacts.readonly",
  "https://www.googleapis.com/auth/userinfo.email",
  "https://www.googleapis.com/auth/gmail.metadata",
].join(" ");

// ── Firestore helpers ─────────────────────────────────────────────────────────
function tokenRef(userId) {
  return admin.firestore().collection("users").doc(userId).collection("oauth_tokens").doc("google");
}

function importRef(userId, importId) {
  return admin.firestore().collection("users").doc(userId).collection("network_imports").doc(importId);
}

// ── generateGoogleAuthUrl ─────────────────────────────────────────────────────
/**
 * Build a Google OAuth2 authorization URL.
 * @param {string} userId      — Firebase UID (embedded in state for CSRF protection)
 * @param {string} redirectBase — Base URL for the redirect, e.g. "https://api.example.com/network/oauth/google/callback"
 * @returns {{ url: string }}
 */
function generateGoogleAuthUrl(userId, redirectBase) {
  const clientId = process.env.GOOGLE_CLIENT_ID;
  if (!clientId) throw new Error("GOOGLE_CLIENT_ID env var is not set");

  // State = base64(userId + "." + random nonce) — verified in callback
  const nonce = crypto.randomBytes(16).toString("hex");
  const state = Buffer.from(`${userId}.${nonce}`).toString("base64url");

  const params = new URLSearchParams({
    client_id:     clientId,
    redirect_uri:  redirectBase,
    response_type: "code",
    scope:         OAUTH_SCOPES,
    access_type:   "offline",
    prompt:        "consent",       // force refresh token every time
    state,
  });

  return { url: `https://accounts.google.com/o/oauth2/v2/auth?${params.toString()}` };
}

// ── handleGoogleCallback ──────────────────────────────────────────────────────
/**
 * Exchange the authorization code for tokens, store encrypted in Firestore.
 * @param {string} code        — Authorization code from Google
 * @param {string} state       — State param (base64url encoded userId.nonce)
 * @param {string} redirectUri — Must match exactly what was sent in the auth URL
 * @returns {{ userId: string, email: string }}
 */
async function handleGoogleCallback(code, state, redirectUri) {
  if (!code || !state) throw new Error("Missing code or state");

  const clientId     = process.env.GOOGLE_CLIENT_ID;
  const clientSecret = process.env.GOOGLE_CLIENT_SECRET;
  if (!clientId || !clientSecret) throw new Error("Google OAuth env vars not set");

  // Decode state to get userId
  let userId;
  try {
    const decoded = Buffer.from(state, "base64url").toString("utf8");
    userId = decoded.split(".")[0];
    if (!userId) throw new Error("empty userId");
  } catch {
    throw new Error("Invalid state parameter");
  }

  // Exchange code for tokens
  const tokenRes = await fetch(GOOGLE_TOKEN_URL, {
    method:  "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      code,
      client_id:     clientId,
      client_secret: clientSecret,
      redirect_uri:  redirectUri,
      grant_type:    "authorization_code",
    }).toString(),
    signal: AbortSignal.timeout(10000),
  });

  if (!tokenRes.ok) {
    const err = await tokenRes.text();
    throw new Error(`Token exchange failed: ${err}`);
  }

  const tokens = await tokenRes.json();
  const { access_token, refresh_token, expires_in, scope } = tokens;
  if (!access_token) throw new Error("No access_token in response");

  // Fetch user email
  const userRes = await fetch(GOOGLE_USERINFO_URL, {
    headers: { Authorization: `Bearer ${access_token}` },
    signal: AbortSignal.timeout(8000),
  });
  const userInfo = userRes.ok ? await userRes.json() : {};
  const email = userInfo.email || "";

  // Persist encrypted tokens
  const doc = {
    accessToken:   encrypt(access_token),
    refreshToken:  refresh_token ? encrypt(refresh_token) : null,
    expiresAt:     new Date(Date.now() + (expires_in || 3600) * 1000).toISOString(),
    scope:         scope || OAUTH_SCOPES,
    email,
    grantedAt:     admin.firestore.FieldValue.serverTimestamp(),
    updatedAt:     admin.firestore.FieldValue.serverTimestamp(),
  };

  await tokenRef(userId).set(doc, { merge: true });
  return { userId, email };
}

// ── refreshGoogleToken ────────────────────────────────────────────────────────
/**
 * Refresh an expired access token using the stored refresh token.
 * @param {string} userId
 * @returns {string} new access_token (plaintext)
 */
async function refreshGoogleToken(userId) {
  const snap = await tokenRef(userId).get();
  if (!snap.exists) throw new Error("No Google token found for user");

  const data = snap.data();
  if (!data.refreshToken) throw new Error("No refresh token stored");

  const clientId     = process.env.GOOGLE_CLIENT_ID;
  const clientSecret = process.env.GOOGLE_CLIENT_SECRET;

  const refreshToken = decrypt(data.refreshToken);

  const res = await fetch(GOOGLE_TOKEN_URL, {
    method:  "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      client_id:     clientId,
      client_secret: clientSecret,
      refresh_token: refreshToken,
      grant_type:    "refresh_token",
    }).toString(),
    signal: AbortSignal.timeout(10000),
  });

  if (!res.ok) {
    const err = await res.text();
    throw new Error(`Token refresh failed: ${err}`);
  }

  const tokens = await res.json();
  const { access_token, expires_in } = tokens;
  if (!access_token) throw new Error("No access_token in refresh response");

  await tokenRef(userId).update({
    accessToken: encrypt(access_token),
    expiresAt:   new Date(Date.now() + (expires_in || 3600) * 1000).toISOString(),
    updatedAt:   admin.firestore.FieldValue.serverTimestamp(),
  });

  return access_token;
}

// ── revokeGoogleAccess ────────────────────────────────────────────────────────
/**
 * Revoke the OAuth token at Google and delete from Firestore.
 * @param {string} userId
 */
async function revokeGoogleAccess(userId) {
  try {
    const snap = await tokenRef(userId).get();
    if (snap.exists) {
      const data = snap.data();
      const token = data.accessToken ? decrypt(data.accessToken) : null;
      if (token) {
        // Best-effort revocation — ignore failure
        await fetch(`${GOOGLE_REVOKE_URL}?token=${encodeURIComponent(token)}`, {
          method: "POST",
          signal: AbortSignal.timeout(8000),
        }).catch(() => {});
      }
    }
  } catch {
    // continue regardless — we always delete local tokens
  }

  await tokenRef(userId).delete();
}

// ── getOAuthStatus ────────────────────────────────────────────────────────────
/**
 * Check connection status for Google OAuth.
 * @param {string} userId
 * @returns {{ google: { connected: boolean, email: string, scopesGranted: string[] } }}
 */
async function getOAuthStatus(userId) {
  try {
    const snap = await tokenRef(userId).get();
    if (!snap.exists) {
      return { google: { connected: false, email: "", scopesGranted: [] } };
    }
    const data = snap.data();
    const scopesGranted = (data.scope || "").split(" ").filter(Boolean);
    return {
      google: {
        connected:    true,
        email:        data.email || "",
        scopesGranted,
      },
    };
  } catch {
    return { google: { connected: false, email: "", scopesGranted: [] } };
  }
}

// ── Internal: get valid access token (refresh if expired) ────────────────────
async function getValidAccessToken(userId) {
  const snap = await tokenRef(userId).get();
  if (!snap.exists) throw new Error("User has not connected Google");

  const data = snap.data();
  const expiresAt = new Date(data.expiresAt || 0);
  const bufferMs  = 60 * 1000; // refresh 1 min before expiry

  if (Date.now() + bufferMs < expiresAt.getTime()) {
    return decrypt(data.accessToken);
  }
  // Expired — refresh
  return refreshGoogleToken(userId);
}

// ── Internal: classify seniority from title ──────────────────────────────────
function inferSeniority(title) {
  if (!title) return "unknown";
  const t = title.toLowerCase();
  if (/\b(ceo|cto|coo|cfo|cpo|chief|president|founder|partner|managing director|vp |vice president)\b/.test(t)) return "executive";
  if (/\b(director|head of|principal|staff engineer|distinguished|fellow)\b/.test(t)) return "senior";
  if (/\b(senior|sr\.|lead|manager|architect)\b/.test(t)) return "senior";
  if (/\b(mid|intermediate|associate|engineer ii|developer ii)\b/.test(t)) return "mid";
  if (/\b(junior|jr\.|entry|intern|graduate|new grad|trainee|assistant)\b/.test(t)) return "entry";
  return "unknown";
}

// ── Internal: recruiter detection ────────────────────────────────────────────
const RECRUITER_KEYWORDS = [
  "recruiter", "talent acquisition", "talent partner",
  "hr ", "human resources", "sourcer", "staffing",
  "recruiting", "talent lead", "people operations",
];

function detectRecruiter(title) {
  if (!title) return { isRecruiter: false, recruiterConfidence: 0 };
  const t = title.toLowerCase();
  const matches = RECRUITER_KEYWORDS.filter(k => t.includes(k)).length;
  if (matches === 0) return { isRecruiter: false, recruiterConfidence: 0 };
  const confidence = Math.min(1, matches * 0.4 + 0.3);
  return { isRecruiter: confidence >= 0.5, recruiterConfidence: confidence };
}

// ── Internal: infer company domain from email ─────────────────────────────────
const PUBLIC_DOMAINS = new Set([
  "gmail.com", "yahoo.com", "hotmail.com", "outlook.com",
  "icloud.com", "protonmail.com", "aol.com", "msn.com",
  "live.com", "me.com", "mac.com",
]);

function inferDomainFromEmail(emails) {
  if (!Array.isArray(emails)) return "";
  for (const email of emails) {
    const parts = (email || "").split("@");
    if (parts.length !== 2) continue;
    const domain = parts[1].toLowerCase();
    if (!PUBLIC_DOMAINS.has(domain)) return domain;
  }
  return "";
}

// ── Internal: map People API resource to our Connection schema ───────────────
function mapPersonToConnection(person, source = "google_contacts") {
  const names      = person.names      || [];
  const emails     = person.emailAddresses || [];
  const phones     = person.phoneNumbers   || [];
  const orgs       = person.organizations  || [];
  const educations = person.educations     || [];

  const primaryName = names.find(n => n.metadata?.primary) || names[0] || {};
  const firstName   = primaryName.givenName  || "";
  const lastName    = primaryName.familyName || "";
  const fullName    = primaryName.displayName || `${firstName} ${lastName}`.trim();

  const emailList  = emails.map(e => (e.value || "").toLowerCase()).filter(Boolean);
  const phoneList  = phones.map(p => p.value || "").filter(Boolean);

  const primaryOrg = orgs.find(o => o.metadata?.primary) || orgs[0] || {};
  const company    = primaryOrg.name  || "";
  const title      = primaryOrg.title || "";

  const schools  = educations.map(e => e.schoolName).filter(Boolean);

  const { isRecruiter, recruiterConfidence } = detectRecruiter(title);
  const seniority  = inferSeniority(title);
  const domain     = inferDomainFromEmail(emailList);

  // People API uses resource name as stable ID: "people/c{id}"
  const resourceName = person.resourceName || "";
  const connectionId = resourceName.replace(/\//g, "_") || crypto.randomUUID();

  return {
    id:                  connectionId,
    fullName:            fullName || "Unknown",
    firstName,
    lastName,
    emails:              emailList,
    phones:              phoneList,
    company,
    title,
    linkedinUrl:         "",
    inferredDomain:      domain,
    source,
    emailFrequency:      0,
    lastContactDate:     null,
    sharedSchools:       schools,
    sharedEmployers:     [],
    sharedIndustries:    [],
    isRecruiter,
    recruiterConfidence,
    isHiringManager:     /hiring manager|hiring lead/i.test(title),
    seniority,
    relationshipScore:   0,
    relationshipTier:    "weak",
    importedAt:          admin.firestore.FieldValue.serverTimestamp(),
    updatedAt:           admin.firestore.FieldValue.serverTimestamp(),
    consentVersion:      "1.0",
  };
}

// ── importGoogleContacts ──────────────────────────────────────────────────────
/**
 * Import contacts from Google People API with full pagination.
 * Writes contacts to Firestore and updates the import status document.
 * @param {string} userId
 * @param {string} importId — ID of the network_imports document to update
 * @returns {{ contacts: object[], total: number }}
 */
async function importGoogleContacts(userId, importId) {
  const MAX_CONTACTS  = 2000;
  const PAGE_SIZE     = 100;

  const setStatus = async (patch) => {
    await importRef(userId, importId).set(patch, { merge: true });
  };

  await setStatus({ status: "fetching_contacts", progress: 5, updatedAt: admin.firestore.FieldValue.serverTimestamp() });

  let accessToken;
  try {
    accessToken = await getValidAccessToken(userId);
  } catch (err) {
    await setStatus({ status: "error", error: err.message, updatedAt: admin.firestore.FieldValue.serverTimestamp() });
    throw err;
  }

  // ── Paginate People API ───────────────────────────────────────────────────
  const rawContacts = [];
  let pageToken     = null;
  let page          = 0;

  const FIELDS = "names,emailAddresses,phoneNumbers,organizations,educations";

  while (rawContacts.length < MAX_CONTACTS) {
    const url = new URL(PEOPLE_API_BASE);
    url.searchParams.set("personFields", FIELDS);
    url.searchParams.set("pageSize",     String(PAGE_SIZE));
    url.searchParams.set("sortOrder",    "LAST_MODIFIED_DESCENDING");
    if (pageToken) url.searchParams.set("pageToken", pageToken);

    const res = await fetch(url.toString(), {
      headers: { Authorization: `Bearer ${accessToken}` },
      signal:  AbortSignal.timeout(15000),
    });

    if (res.status === 401) {
      // Try refresh once
      accessToken = await refreshGoogleToken(userId);
      continue;
    }

    if (!res.ok) {
      const errText = await res.text();
      throw new Error(`People API error ${res.status}: ${errText}`);
    }

    const data  = await res.json();
    const batch = data.connections || [];
    rawContacts.push(...batch);
    page++;

    const progress = Math.min(40, 5 + Math.floor((rawContacts.length / MAX_CONTACTS) * 35));
    await setStatus({
      status:            "fetching_contacts",
      progress,
      contactsProcessed: rawContacts.length,
      updatedAt:         admin.firestore.FieldValue.serverTimestamp(),
    });

    if (!data.nextPageToken || batch.length === 0) break;
    pageToken = data.nextPageToken;
  }

  await setStatus({ status: "analyzing_gmail", progress: 45, updatedAt: admin.firestore.FieldValue.serverTimestamp() });

  // ── Map to Connection schema ─────────────────────────────────────────────
  const connections = rawContacts.map(p => mapPersonToConnection(p, "google_contacts"));

  // ── Analyze Gmail metadata to populate emailFrequency ────────────────────
  const enriched = await analyzeGmailMetadata(userId, connections, accessToken);

  await setStatus({ status: "storing", progress: 70, updatedAt: admin.firestore.FieldValue.serverTimestamp() });

  // ── Write to Firestore in batches of 400 ─────────────────────────────────
  const firestoreDb   = admin.firestore();
  const userRef       = firestoreDb.collection("users").doc(userId);
  const connColl      = userRef.collection("connections");
  const companyColl   = userRef.collection("network_companies");

  const companyMap    = new Map(); // domain → aggregated company doc

  let writtenCount = 0;
  const BATCH_SIZE  = 400;

  for (let i = 0; i < enriched.length; i += BATCH_SIZE) {
    const chunk  = enriched.slice(i, i + BATCH_SIZE);
    const batch  = firestoreDb.batch();

    for (const conn of chunk) {
      const ref = connColl.doc(conn.id);
      batch.set(ref, conn, { merge: true });

      // Aggregate company data
      const domain = conn.inferredDomain || conn.company;
      if (domain) {
        if (!companyMap.has(domain)) {
          companyMap.set(domain, {
            name:             conn.company || domain,
            domain,
            connectionCount:  0,
            connections:      [],
            recruiters:       [],
            hiringManagers:   [],
            executives:       [],
            updatedAt:        admin.firestore.FieldValue.serverTimestamp(),
          });
        }
        const co = companyMap.get(domain);
        co.connectionCount++;
        if (co.connections.length < 20) co.connections.push(conn.id);
        if (conn.isRecruiter && co.recruiters.length < 10) co.recruiters.push(conn.id);
        if (conn.isHiringManager && co.hiringManagers.length < 10) co.hiringManagers.push(conn.id);
        if (conn.seniority === "executive" && co.executives.length < 10) co.executives.push(conn.id);
      }
    }

    await batch.commit();
    writtenCount += chunk.length;
  }

  // ── Write aggregated companies ────────────────────────────────────────────
  const companyEntries = [...companyMap.entries()];
  for (let i = 0; i < companyEntries.length; i += 400) {
    const batch = firestoreDb.batch();
    const slice = companyEntries.slice(i, i + 400);
    for (const [domain, coData] of slice) {
      // Deterministic ID from domain
      const coId = crypto.createHash("md5").update(domain).digest("hex").slice(0, 20);
      batch.set(companyColl.doc(coId), coData, { merge: true });
    }
    await batch.commit();
  }

  await setStatus({
    status:             "completed",
    progress:           100,
    contactsProcessed:  writtenCount,
    companiesDetected:  companyMap.size,
    completedAt:        admin.firestore.FieldValue.serverTimestamp(),
    updatedAt:          admin.firestore.FieldValue.serverTimestamp(),
  });

  return { contacts: enriched, total: writtenCount };
}

// ── analyzeGmailMetadata ──────────────────────────────────────────────────────
/**
 * Count outbound email threads per contact to populate emailFrequency.
 * Uses gmail.metadata scope (no message bodies read).
 * @param {string}   userId
 * @param {object[]} connections — Connection objects with emails[]
 * @param {string}   [accessTokenOverride] — Pass to avoid re-fetching from Firestore
 * @returns {object[]} Same connections array with emailFrequency populated
 */
async function analyzeGmailMetadata(userId, connections, accessTokenOverride) {
  let accessToken = accessTokenOverride;
  if (!accessToken) {
    try {
      accessToken = await getValidAccessToken(userId);
    } catch {
      return connections; // Gmail not authorized — return as-is
    }
  }

  // Build email → connection index
  const emailIndex = new Map(); // email → connection id
  for (const conn of connections) {
    for (const email of (conn.emails || [])) {
      emailIndex.set(email.toLowerCase(), conn.id);
    }
  }

  // Frequency counter
  const freq = new Map(); // connectionId → count

  // Fetch up to 200 sent threads (metadata only)
  let pageToken = null;
  let fetched   = 0;
  const MAX_THREADS = 200;

  while (fetched < MAX_THREADS) {
    const url = new URL(GMAIL_THREADS_URL);
    url.searchParams.set("labelIds",   "SENT");
    url.searchParams.set("maxResults", String(Math.min(100, MAX_THREADS - fetched)));
    if (pageToken) url.searchParams.set("pageToken", pageToken);

    const res = await fetch(url.toString(), {
      headers: { Authorization: `Bearer ${accessToken}` },
      signal:  AbortSignal.timeout(15000),
    }).catch(() => null);

    if (!res || !res.ok) break;

    const data = await res.json();
    const threads = data.threads || [];

    // Fetch each thread's metadata to extract recipients
    const threadFetches = threads.map(t =>
      fetch(`https://gmail.googleapis.com/gmail/v1/users/me/threads/${t.id}?format=metadata&metadataHeaders=To&metadataHeaders=Cc`, {
        headers: { Authorization: `Bearer ${accessToken}` },
        signal:  AbortSignal.timeout(8000),
      }).then(r => r.ok ? r.json() : null).catch(() => null)
    );

    const threadData = await Promise.all(threadFetches);
    fetched += threads.length;

    for (const td of threadData) {
      if (!td) continue;
      const messages = td.messages || [];
      for (const msg of messages) {
        const headers = msg.payload?.headers || [];
        for (const h of headers) {
          if (!["To", "Cc"].includes(h.name)) continue;
          // Parse comma-separated email addresses from header value
          const rawAddrs = (h.value || "").split(",");
          for (const raw of rawAddrs) {
            const match = raw.match(/<([^>]+)>/) || raw.match(/\S+@\S+/);
            const email = (match ? (match[1] || match[0]) : raw).trim().toLowerCase();
            const connId = emailIndex.get(email);
            if (connId) {
              freq.set(connId, (freq.get(connId) || 0) + 1);
            }
          }
        }
      }
    }

    if (!data.nextPageToken || threads.length === 0) break;
    pageToken = data.nextPageToken;
  }

  // Apply frequencies to connections
  return connections.map(conn => ({
    ...conn,
    emailFrequency: freq.get(conn.id) || 0,
  }));
}

module.exports = {
  generateGoogleAuthUrl,
  handleGoogleCallback,
  refreshGoogleToken,
  revokeGoogleAccess,
  getOAuthStatus,
  importGoogleContacts,
  analyzeGmailMetadata,
  // Export internal helpers for use by relationship-engine
  inferSeniority,
  detectRecruiter,
  inferDomainFromEmail,
  mapPersonToConnection,
};
