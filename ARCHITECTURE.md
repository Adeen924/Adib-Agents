# CareerCopilot — Network Intelligence: Architecture & Design Document

> **Scope:** This document covers the technical architecture for the Network Intelligence feature set added to CareerCopilot. It spans all 15 deliverables from the product specification and is intended as a living reference for engineering, product, and compliance stakeholders.

---

## 1. Complete System Architecture

### Component Overview

```
┌─────────────────────────────────────────────────────────────────┐
│  CLIENT LAYER                                                    │
│  ┌──────────────┐   ┌──────────────────┐   ┌────────────────┐  │
│  │  dashboard   │   │  Chrome Extension│   │  Mobile (future│  │
│  │  (SPA, HTML/ │   │  (MV3, content   │   │  PWA layer)    │  │
│  │  JS/CSS)     │   │  script + SW)    │   │                │  │
│  └──────┬───────┘   └────────┬─────────┘   └───────┬────────┘  │
└─────────┼────────────────────┼─────────────────────┼───────────┘
          │ Firebase Auth JWT  │ Extension Token      │
          ▼                    ▼                      ▼
┌─────────────────────────────────────────────────────────────────┐
│  API LAYER — Firebase Cloud Functions (Node 20, Express)         │
│  ┌────────────────┐  ┌─────────────────┐  ┌──────────────────┐ │
│  │ /network/*     │  │ /jobs/*         │  │ /documents/*     │ │
│  │ Network Intel  │  │ Job search &    │  │ Resume / cover   │ │
│  │ endpoints      │  │ recommendations │  │ letter gen       │ │
│  └───────┬────────┘  └────────┬────────┘  └──────────────────┘ │
└──────────┼──────────────────┼──────────────────────────────────┘
           │                  │
    ┌──────▼──────┐    ┌──────▼──────┐
    │  Firestore  │    │  OpenAI API │
    │  (Admin SDK)│    │  (GPT-4o /  │
    │             │    │  embeddings)│
    └──────┬──────┘    └─────────────┘
           │
    ┌──────▼──────────────┐
    │  Google People API  │
    │  (OAuth 2.0 contacts│
    │  import pipeline)   │
    └─────────────────────┘
```

### Data Flow — Contact Import

1. User clicks "Connect Google Contacts" → backend generates an OAuth URL with `contacts.readonly` scope.
2. User completes Google consent → Google redirects to `/network/:uid/oauth/google/callback` with an auth code.
3. Backend exchanges code for access + refresh tokens, encrypts the refresh token with AES-256-GCM, stores in Firestore `users/{uid}/oauth_tokens/google`.
4. Import job is created (`import_jobs/{importId}` with `status: running`).
5. A Cloud Task (or background function) reads contacts in batches of 100 via the People API, normalizes and scores each contact, writes to `users/{uid}/connections`.
6. Job status is updated to `completed` or `failed`.
7. Client polls `/network/:uid/import/:importId/status` every 3 seconds and updates the UI on completion.

### Data Flow — Warm Job Matching

1. On each job crawl cycle, a background function reads the user's connections (aggregated by company).
2. It cross-references against newly found jobs using company name normalization.
3. Matches are ranked by connection count and average relationship score, written to `users/{uid}/warm_jobs` (TTL: 48 hours).
4. The Network Overview tab surfaces these ranked opportunities with connection count badges.

---

## 2. Database Schema

All collections are subcollections under `users/{userId}` or top-level, accessed exclusively through the Admin SDK (no client-side Firestore reads).

### `users/{userId}/connections/{connectionId}`

| Field | Type | Description |
|---|---|---|
| `name` | string | Full display name |
| `email` | string | Primary email (hashed for privacy-safe dedup) |
| `title` | string | Current job title |
| `company` | string | Current employer (normalized) |
| `source` | string | `google_contacts` / `linkedin` / `manual` |
| `relationshipScore` | number (0–1) | AI-computed closeness score |
| `tier` | string | `close` / `strong` / `moderate` / `weak` |
| `isRecruiter` | boolean | Inferred from title keywords |
| `importedAt` | timestamp | When first imported |
| `updatedAt` | timestamp | Last enrichment/update |
| `metadata` | map | Raw source-specific fields (stripped on export) |

### `users/{userId}/companies/{companyId}`

| Field | Type | Description |
|---|---|---|
| `name` | string | Normalized company name |
| `connectionCount` | number | Total connections at this company |
| `recruiterCount` | number | Subset flagged as recruiters |
| `networkStrength` | number (0–1) | Weighted aggregate score |
| `topConnections` | array | IDs of highest-scored connections (max 5) |
| `updatedAt` | timestamp | Denormalization refresh timestamp |

### `users/{userId}/outreach_history/{outreachId}`

| Field | Type | Description |
|---|---|---|
| `connectionId` | string | Reference to connection document |
| `contactName` | string | Denormalized for display |
| `company` | string | Denormalized for display |
| `jobId` | string? | Optional related job listing |
| `jobTitle` | string? | Denormalized job title |
| `messageType` | string | `introduction` / `referral_ask` / `informational` / `reconnect` / `follow_up` |
| `message` | string | Full generated message text |
| `status` | string | `pending` / `sent` / `replied` / `declined` |
| `createdAt` | timestamp | Generation time |
| `sentAt` | timestamp? | When user marked as sent |

### `users/{userId}/oauth_tokens/google`

| Field | Type | Description |
|---|---|---|
| `encryptedRefreshToken` | string | AES-256-GCM encrypted, base64 |
| `iv` | string | Encryption IV, base64 |
| `authTag` | string | GCM auth tag, base64 |
| `scope` | string | Granted OAuth scopes |
| `contactCount` | number | Count from last successful sync |
| `lastSync` | timestamp | Last successful import time |
| `connected` | boolean | True when token is valid |

### `users/{userId}/extension_tokens/{tokenId}`

| Field | Type | Description |
|---|---|---|
| `token` | string | SHA-256 hashed token (raw shown to user only once) |
| `createdAt` | timestamp | Issue time |
| `expiresAt` | timestamp | 24 hours after creation |
| `used` | boolean | Consumed by extension |

### `import_jobs/{importId}`

| Field | Type | Description |
|---|---|---|
| `userId` | string | Owner |
| `source` | string | `google_contacts` / `linkedin` |
| `status` | string | `running` / `completed` / `failed` |
| `imported` | number | Contacts successfully written |
| `total` | number | Total contacts found |
| `error` | string? | Error message if failed |
| `startedAt` | timestamp | Job creation time |
| `completedAt` | timestamp? | Finish time |

### Composite Indexes

```json
[
  { "collection": "connections", "fields": ["relationshipScore DESC", "importedAt DESC"] },
  { "collection": "connections", "fields": ["company ASC", "relationshipScore DESC"] },
  { "collection": "outreach_history", "fields": ["status ASC", "createdAt DESC"] }
]
```

---

## 3. API Route Structure

All routes are prefixed `/network/:userId` and require a valid Firebase Auth JWT (verified by `apiFetch` on the client using `firebase.auth().currentUser.getIdToken()`).

### OAuth & Import

| Method | Path | Description |
|---|---|---|
| `GET` | `/network/:uid/oauth/google/url` | Returns Google OAuth redirect URL |
| `GET` | `/network/:uid/oauth/google/callback` | Handles OAuth code exchange (redirect target) |
| `DELETE` | `/network/:uid/oauth/google` | Revokes token and clears stored credentials |
| `POST` | `/network/:uid/import/google` | Enqueues a new Google Contacts import job |
| `GET` | `/network/:uid/import/:importId/status` | Returns current import job status |

### Network Data

| Method | Path | Description |
|---|---|---|
| `GET` | `/network/:uid/dashboard` | Stats, oauthStatus, lastImport, lastOutreach, networkGaps |
| `GET` | `/network/:uid/connections` | Paginated connections (query: page, limit, search, tier, source) |
| `GET` | `/network/:uid/companies` | Company list with aggregated stats |
| `GET` | `/network/:uid/warm-jobs` | Top warm job opportunities |

### Outreach

| Method | Path | Description |
|---|---|---|
| `POST` | `/network/:uid/outreach/generate` | Body: `{ connectionId, jobId?, messageType }` → returns `{ message }` |
| `POST` | `/network/:uid/outreach` | Saves outreach record. Body: `{ connectionId, jobId?, messageType, message, status }` |
| `PATCH` | `/network/:uid/outreach/:outreachId` | Updates status. Body: `{ status }` |
| `GET` | `/network/:uid/outreach` | Returns full outreach history |

### Extension & Privacy

| Method | Path | Description |
|---|---|---|
| `POST` | `/network/:uid/extension/token` | Generates a 24h extension link token |
| `DELETE` | `/network/:uid/data` | Permanently deletes all network data for the user |

### Response shapes (example)

```json
// GET /network/:uid/dashboard
{
  "dashboard": {
    "stats": { "totalConnections": 312, "totalCompanies": 87, "recruiters": 14, "warmOpportunities": 6 },
    "lastImport": "2026-05-27T10:00:00Z",
    "lastOutreach": "2026-05-26T14:32:00Z",
    "importStatus": "idle",
    "networkGaps": [
      { "industry": "Fintech", "suggestion": "You have no connections at any major fintech firm.", "severity": "High" }
    ]
  },
  "oauthStatus": {
    "connected": true,
    "lastSync": "2026-05-27T10:00:00Z",
    "contactCount": 312
  }
}
```

---

## 4. Chrome Extension Architecture

### Manifest V3 Design

```
extension/
├── manifest.json          # MV3: service_worker, permissions
├── background/
│   └── service-worker.js  # Token storage, message relay
├── content/
│   └── linkedin.js        # DOM scraper for LinkedIn profile pages
├── popup/
│   ├── popup.html
│   └── popup.js           # Settings UI + token entry
└── icons/
```

### Content Script Strategy

The LinkedIn content script activates only on `linkedin.com/in/*` profile pages. It:

1. Reads visible DOM fields: name, title, company, location, connection degree.
2. Does **not** read messages, posts, or private contact details.
3. Passes the extracted object to the service worker via `chrome.runtime.sendMessage`.
4. The service worker forwards data to the CareerCopilot API using the stored extension token (never the Firebase JWT — the backend validates the token independently).

### Local Processing Principle

All data parsing happens inside the extension process. The API receives only the structured JSON payload — no raw HTML is transmitted. This minimizes scraping surface area and keeps the extension compliant with Chrome Web Store policies.

### Token Lifecycle

- User generates a token in the dashboard Settings tab.
- Token is shown once (raw value), then stored as a SHA-256 hash server-side.
- Extension stores the raw token in `chrome.storage.local` (not `sync`).
- Token expires after 24 hours; the user generates a new one if needed.
- The API validates the token hash on every extension submission request.

---

## 5. Security Recommendations

### Token & Credential Storage

- **OAuth refresh tokens:** Encrypted at rest with AES-256-GCM. The encryption key is stored in Google Cloud Secret Manager and rotated every 90 days. Never stored in plaintext in Firestore.
- **Extension tokens:** Stored as SHA-256 hashes only. The raw token is transmitted once (HTTPS) and never persisted server-side.
- **Firebase JWTs:** Short-lived (1 hour), validated on every API request via Firebase Admin SDK `verifyIdToken`.

### OAuth Scopes

Request only the minimum necessary scope: `https://www.googleapis.com/auth/contacts.readonly`. Do not request `gmail.readonly`, `drive`, or any scope beyond read-only contacts access. Display granted scopes clearly in the Settings UI.

### Rate Limiting

Apply per-user rate limits on all network endpoints:

| Endpoint category | Limit |
|---|---|
| Import trigger | 3 per day per user |
| Outreach generation | 20 per hour per user |
| Extension token generation | 5 per day per user |
| Data deletion | 2 per 24-hour window |

Use a sliding-window counter stored in Firestore or Redis (Upstash) keyed on `userId + endpoint`.

### Audit Logging

Log all destructive and OAuth operations to a `audit_log` collection:
- `DELETE /network/:uid/data` events
- OAuth connect/disconnect events
- Extension token generation events

Retain audit logs for 90 days minimum. Do not log message content.

---

## 6. Compliance & Risk Analysis

### LinkedIn Terms of Service

LinkedIn's User Agreement (Section 8.2) prohibits scraping without explicit permission. The Chrome extension approach carries risk:

- **Low-risk path:** Only read data from pages the user is actively viewing; never crawl in the background; never automate navigation.
- **Prohibited:** Using headless browsers, running without user interaction, bulk profile harvesting.
- **Recommended disclosure:** In the extension store listing and the in-app Settings tab, clearly state "reads profile data from pages you visit on LinkedIn."
- **Alternative:** Apply for LinkedIn's [Partner Program API](https://developer.linkedin.com/) for a compliant integration. This is the preferred long-term path.

### GDPR / CCPA

| Requirement | Implementation |
|---|---|
| Right to erasure | `DELETE /network/:uid/data` permanently removes all collections and OAuth tokens |
| Data minimization | Only store fields needed for scoring; discard raw metadata fields post-processing |
| Consent | OAuth flow presents explicit consent; Privacy Policy updated to cover network data |
| Data portability | Add a future `GET /network/:uid/export` endpoint returning connections as JSON/CSV |
| Processor agreements | Ensure Google (OAuth) and OpenAI (outreach generation) have signed DPAs |

### Data Retention

Default policy: network data persists until user deletes it or closes account. Offer a configurable auto-purge option (30/90/180 days) in the Privacy settings card.

---

## 7. AI Pipeline Design

### Relationship Scoring Model

The `relationshipScore` (0–1) is computed server-side during import using a weighted heuristic model:

```
score = 0.35 * emailInteractionFrequency
      + 0.25 * connectionRecency          (how recently connected)
      + 0.20 * sharedContextSignals       (shared companies, schools)
      + 0.15 * titleSeniorityWeight       (senior contacts score higher)
      + 0.05 * mutualConnectionCount
```

For Google Contacts, `emailInteractionFrequency` is approximated from the contact's interaction rank provided by the People API (`personFields=emailAddresses,names,organizations,metadata`). Actual email interaction data is **not** requested (avoids `gmail.readonly` scope).

### Outreach Generation

Uses OpenAI `gpt-4o-mini` for outreach generation (cost-efficient for high-volume use). The system prompt includes:

- User's resume summary and target role (from existing profile)
- Connection's name, title, and company
- Message type (introduction, referral, etc.)
- Word count constraint: 150 words for LinkedIn messages, 250 words for email

Prompt is cached using OpenAI's prompt caching feature for the static system prompt portion (saves ~50% on token costs for repeated generation).

### Network Gap Analysis

A scheduled Cloud Function runs weekly per active user:

1. Fetches the user's target companies watchlist and target job roles.
2. Cross-references with the user's company coverage in `users/{uid}/companies`.
3. Computes gap score = `(target companies with 0 connections) / total target companies`.
4. Uses `gpt-4o-mini` to generate a natural-language suggestion for each gap.
5. Writes results to `dashboard.networkGaps`.

---

## 8. Background Job Architecture

### Import Pipeline

```
triggerImport() → createImportJob(importId) → enqueueCloudTask()
                                                      │
                                              runImportTask()
                                                ├── fetchContactsPage(pageToken)
                                                ├── normalizeContacts(batch)
                                                ├── scoreContacts(batch)
                                                ├── writeConnectionsBatch()  ← Firestore batch write (500 max)
                                                ├── updateCompanyAggregates()
                                                └── updateJobStatus(completed)
```

Cloud Tasks is preferred over direct async calls because it provides:
- Automatic retry with exponential backoff (max 5 retries)
- Visibility into queue depth and failure rates
- Timeout handling for large contact lists (10,000+ contacts)

### Retry Logic

| Failure type | Retry strategy |
|---|---|
| Google API rate limit (429) | Retry after `Retry-After` header value, max 3 retries |
| Firestore write failure | Retry once immediately, then fail with partial results |
| OpenAI API timeout | No retry for generation; return error to client immediately |
| Network error during import | Cloud Tasks retries automatically up to 5 times with exponential backoff |

### Status Tracking

Import jobs write progress updates every 500 contacts processed (`processed: N, total: M`). The client polls every 3 seconds and can display a progress indicator if `total` is known.

---

## 9. Scaling Recommendations

### Firestore Denormalization

Rather than joining `connections` and `companies` at query time, maintain the `companies` collection as a denormalized cache. Update it asynchronously after each import using a Firestore trigger (`onCreate` / `onUpdate` on `connections`).

For dashboard stats, maintain a `users/{uid}/stats` document updated via triggers — avoid running aggregate queries on every dashboard load.

### Caching Strategy

| Data | Cache location | TTL |
|---|---|---|
| Dashboard stats | Firestore `stats` doc | Updated on import completion |
| Warm jobs list | Firestore `warm_jobs` doc | 48 hours |
| Company aggregates | Firestore `companies` collection | Updated via trigger |
| OAuth token | Firestore (encrypted) | Until revoked |

### Batching

- Firestore writes: use `batch.commit()` with groups of 500 documents.
- OpenAI calls: for bulk gap analysis, use the Batch API (`/v1/batches`) for non-interactive processing (24-hour SLA, 50% cost reduction).
- Google People API: request `pageSize=1000` and paginate until `nextPageToken` is absent.

---

## 10. MVP Implementation Order

### Week 1–2: Foundation
- [ ] Firestore schema design and index deployment
- [ ] Google OAuth flow (connect/disconnect/callback)
- [ ] Basic contact import pipeline (no scoring)
- [ ] `/network/:uid/connections` GET endpoint with pagination

### Week 3–4: Scoring & Display
- [ ] Relationship scoring model implementation
- [ ] Company aggregation (denormalized `companies` collection)
- [ ] Dashboard stats endpoint
- [ ] Frontend: Overview tab with stats and company list

### Week 5–6: Warm Jobs & Outreach
- [ ] Warm job matching logic (cross-reference with `jobs_cache`)
- [ ] Outreach generation endpoint (GPT-4o-mini)
- [ ] Frontend: Connections tab with search/filter
- [ ] Frontend: Outreach modal and history tab

### Week 7–8: Extension & Polish
- [ ] Chrome Extension (MV3) with LinkedIn content script
- [ ] Extension token generation and validation
- [ ] Network gap analysis (weekly scheduled function)
- [ ] Frontend: Settings tab with privacy controls
- [ ] End-to-end testing and security review

---

## 11. Recommended Tech Stack Changes

| Component | Current | Recommended Addition | Reason |
|---|---|---|---|
| Background jobs | Firebase Functions (event-driven) | Google Cloud Tasks | Reliable retry, timeout control for long imports |
| Rate limiting | None | Upstash Redis | Low-latency sliding window counters |
| Secret management | Env vars | Google Cloud Secret Manager | Encrypted OAuth key rotation |
| Extension | None | Chrome Extension MV3 | LinkedIn data acquisition |
| Batch AI | Direct OpenAI calls | OpenAI Batch API | 50% cost reduction for non-interactive tasks |
| Monitoring | None | Google Cloud Monitoring + alerting | Import pipeline observability |

---

## 12. Cost Optimization Strategy

### AI Model Selection

| Use case | Model | Estimated cost per call |
|---|---|---|
| Outreach generation (interactive) | `gpt-4o-mini` | ~$0.003 |
| Gap analysis suggestions (batch) | `gpt-4o-mini` via Batch API | ~$0.0015 |
| Relationship scoring | Heuristic (no LLM) | $0 |
| Contact enrichment | Heuristic + People API | $0 (free tier) |

### Prompt Caching

Cache the static system prompt for outreach generation using OpenAI's prompt caching. The system prompt (user profile + instructions) is ~800 tokens. At 20 outreach calls/day/user, caching saves roughly 60% of input token costs.

### Batching API Calls

- Use OpenAI Batch API for weekly gap analysis runs across all active users.
- Group People API paginated calls in a single Cloud Task execution to avoid cold-start overhead.
- Defer non-urgent enrichment (e.g., company logo fetching) to off-peak hours using Cloud Scheduler.

### Firestore Cost Control

- Set TTLs on `import_jobs` documents (delete after 7 days) to avoid unbounded collection growth.
- Use Firestore's [TTL policy](https://firebase.google.com/docs/firestore/ttl) on `extension_tokens` (expire after 24 hours automatically).
- Avoid listening to real-time snapshots on the network panel — use one-time `get()` calls since data changes infrequently.

---

## 13. User Privacy Recommendations

### Consent Flows

1. **Before OAuth:** Display a clear pre-consent screen listing exactly what data will be imported (name, email, title, company — nothing else). Require an explicit checkbox acknowledgment.
2. **During import:** Show a progress indicator with contact count to make data processing visible.
3. **Post-import:** Send an in-app notification confirming how many contacts were imported and providing a one-click delete link.

### Data Deletion

- `DELETE /network/:uid/data` must delete all subcollections atomically using a recursive Firestore delete (Admin SDK `recursiveDelete`).
- Revoke the Google OAuth token via `https://oauth2.googleapis.com/revoke` before deleting the stored token.
- Respond with a confirmation payload and log the deletion to the audit trail.
- Account closure must also trigger network data deletion (hook into existing account delete flow).

### Transparency Dashboard

Add a "What we store" expandable section to the Settings Privacy card listing:
- Number of connections stored
- Date of last import
- Whether Google OAuth is connected
- Whether an extension token is active

---

## 14. Terms of Service Considerations

### Additions Required to CareerCopilot ToS

1. **Network Data clause:** Define "Network Data" as contact names, titles, companies, and relationship metadata imported by the user. State that CareerCopilot processes this data solely to provide warm job matching and outreach assistance.
2. **Third-party platform compliance:** Add a clause requiring users to comply with the terms of service of any platforms from which they import data (LinkedIn, Google). Users represent that their use of the Chrome extension is permitted under those platforms' ToS.
3. **AI-generated content:** Clarify that outreach messages are AI-generated suggestions. The user is responsible for reviewing, editing, and sending messages. CareerCopilot is not liable for communications sent to third parties.
4. **Data retention:** Specify the default retention period (until account deletion or manual data delete) and the user's right to delete at any time.
5. **OAuth revocation:** Clarify that disconnecting Google removes CareerCopilot's access to future data but does not retroactively delete already-imported contacts (unless the user also clicks "Delete Network Data").

### Platform API Compliance

- **Google People API:** Usage complies with [Google API Services User Data Policy](https://developers.google.com/terms/api-services-user-data-policy). Only `contacts.readonly` scope is requested; data is not shared with third parties or used to train models.
- **LinkedIn:** If using the extension-based approach, include clear disclosure in the Chrome Web Store listing. Monitor LinkedIn's [developer policies](https://legal.linkedin.com/api-terms-of-use) and cease any scraping method they explicitly prohibit.

---

## 15. Phased Rollout Plan

### Phase 1: Closed Beta (Weeks 1–8)
**Goal:** Validate core import + warm-job flow with 20 internal testers.

- Google Contacts import pipeline
- Basic relationship scoring
- Warm job matching (existing job cache)
- Overview and Connections tabs
- Manual data delete

**Success criteria:** 80% of beta users import >100 contacts; warm job match rate >15%.

### Phase 2: Pro Feature Launch (Weeks 9–14)
**Goal:** Roll out to all Pro-tier users with full outreach generation.

- Outreach generation (all 5 message types)
- Outreach history tab
- Companies tab with network strength
- Network gap analysis (weekly)
- Settings tab with OAuth management

**Success criteria:** 40% of Pro users connect Google Contacts within 30 days of launch; NPS delta vs. pre-launch baseline.

### Phase 3: Extension GA (Weeks 15–20)
**Goal:** Chrome Web Store submission and LinkedIn import path.

- Chrome Extension MV3 (LinkedIn content script)
- Extension token flow
- Increased import sources reflected in source filter
- Full audit logging

**Success criteria:** Extension installs >500 in first month; zero ToS enforcement actions from LinkedIn.

### Phase 4: Scale & Intelligence (Weeks 21–30)
**Goal:** Deepen AI features and build toward LinkedIn Partner API.

- LinkedIn Partner API application and integration (replaces extension scraping)
- Outreach A/B effectiveness tracking (reply rate measurement)
- Personalized network growth suggestions (AI-driven, weekly digest)
- Data export (GDPR portability)
- Mobile-responsive polish

**Success criteria:** Warm job → application conversion rate measurably higher than cold applications (target: 2× lift based on user self-report).

---

*Last updated: 2026-05-27. Maintained by the CareerCopilot engineering team.*
