# Auth Refactor Report — CareerCopilot

**Branch:** Security-Changes  
**Date:** 2026-05-26  
**Status:** Complete (pending migration of existing Firestore data)

---

## Summary of Changes

### Problem
The backend was accepting `userId` / `adminId` directly from the frontend (URL params, request body, or query string) and using those values to look up Firestore documents with **zero verification**. Any user could read or write any other user's data by supplying a different email address.

---

## 1. Changes Made

### `functions/package.json`
- Added `express-rate-limit ^7.0.0`
- Added `helmet ^8.0.0`

### `functions/index.js`

#### Security middleware added
```
helmet()             — sets 14 security-related HTTP headers (CSP, HSTS, etc.)
express-rate-limit   — 200 requests per 15 min per IP; webhook excluded
Strict CORS          — only allows https://adeen924.github.io, localhost, 127.0.0.1
```

#### Authentication middleware (`authenticate`)
- Reads `Authorization: Bearer <token>` header
- Calls `admin.auth().verifyIdToken(token)` — cryptographically verified by Firebase
- Attaches `req.user = { uid, email, ... }` on success
- Returns `401` on missing/invalid/expired token
- Applied globally via `app.use(authenticate)` (all routes after the webhook and health check)

#### Admin authorization middleware (`requireAdmin`)
- Checks `users/{req.user.uid}.role === "admin"` in Firestore
- Replaces the old `adminId` query/body param pattern on all 8 admin endpoints
- Returns `403` for non-admins

#### Routes updated — identity source changed
Every protected route now extracts identity from `req.user.uid` (verified Firebase UID):

| Section | Routes changed |
|---------|---------------|
| Stats | `GET /stats/:userId` |
| Documents | `GET /documents/:userId/:type`, `POST /documents/save`, `DELETE /documents/:userId/:docId` |
| Applications | `GET /applications/:userId`, `GET /applications/:userId/:appId`, `POST /applications/save`, `PATCH /applications/:userId/:appId/status`, `GET/POST/DELETE /applications/:userId/:appId/notes`, `DELETE /applications/:userId/:appId` |
| Interviews | `GET /interviews/:userId`, `POST /interviews/save`, `DELETE /interviews/:userId/:interviewId` |
| Knowledge | `GET /knowledge/:userId`, `POST /knowledge/save` |
| Preferences | `GET /preferences/:userId`, `POST /preferences/save` |
| Digest | `GET /digest/:userId` |
| Jobs | `GET /jobs/:userId`, `GET /jobs/:userId/detail/:jobId`, `POST /jobs/:jobId/tailored-resume`, `POST /jobs/:jobId/cover-letter`, `POST /jobs/:jobId/interview-prep`, `POST /jobs/:jobId/network` |
| Search | `POST /search/now/:userId`, `GET /search/logs/:userId` |
| User | `GET /user/:userId` |
| Admin | `GET/POST /admin/feature-flags`, `GET/PUT/DELETE /admin/company-profiles/*`, `POST /admin/company-profiles/seed-defaults`, `GET /admin/stats/:userId`, `GET /admin/user-detail/:targetUserId` |
| Stripe | `POST /create-checkout-session`, `POST /create-portal-session` |
| Tier mgmt | `POST /user/tier` (now requires `requireAdmin`) |
| Notifications | `POST /notifications/token` |
| Watchlist | `GET /watchlist-jobs/:userId`, `GET /watchlist-jobs/:userId/detail/:jobId` |
| Target companies | `GET /target-companies/:userId`, `POST /target-companies/save` |

#### `ensureUser(uid, email)` — signature updated
- Now takes `uid` (Firebase UID) and `email` separately
- Creates `users/{uid}` documents (was `users/{email}`)
- Stores `email` as a field, not the document ID

#### Stripe webhook — unchanged
- Stays unprotected (uses Stripe signature verification instead)
- `client_reference_id` is now the Firebase UID (set during checkout)

### `docs/app.js`

#### Auth identity changed
```js
// Before
const userId = email;                            // email string used as ID
// After
const userId = fbUid;                            // Firebase UID used as ID
```

#### `apiFetch()` wrapper added
All API calls now go through `apiFetch()` which:
1. Resolves the current Firebase Auth user
2. Calls `user.getIdToken()` — returns a cached token or auto-refreshes if expired
3. Attaches `Authorization: Bearer <token>` to every request
4. Falls back to `sessionStorage.fbToken` if Firebase Auth unavailable

#### `userId` removed from request bodies
Removed from all POST/PATCH body payloads:
- `applications/save`
- `interviews/save`
- `documents/save`
- `knowledge/save`
- `preferences/save` (all variants)
- `create-checkout-session` / `create-portal-session`
- `notifications/token`
- `target-companies/save`
- AI generation endpoints (`tailored-resume`, `cover-letter`, `interview-prep`, `network`)

#### `adminId` removed from admin API calls
- `POST /admin/feature-flags` — body no longer includes `adminId`
- `GET /admin/feature-flags` — query param `adminId` removed
- `GET /admin/user-detail/:id` — query param `adminId` removed

---

## 2. Migration Steps (Required Before Launch)

### CRITICAL: Firestore document ID migration

**Problem:** Existing user data lives in `users/{email}` documents. After this refactor, the backend creates/reads `users/{uid}` documents. Existing users will appear as new accounts with no data.

**Migration script (run once against production Firestore):**

```js
const admin = require("firebase-admin");
admin.initializeApp();
const db = admin.firestore();
const auth = admin.auth();

async function migrateUsers() {
  const usersSnap = await db.collection("users").get();
  for (const doc of usersSnap.docs) {
    const email = doc.id;
    // Skip docs that already look like UIDs (not emails)
    if (!email.includes("@")) continue;
    try {
      const userRecord = await auth.getUserByEmail(email);
      const uid = userRecord.uid;
      const data = doc.data();
      // Write to new UID-based doc
      await db.collection("users").doc(uid).set({
        ...data,
        uid,
        email,        // preserve email as field
      }, { merge: true });
      // Migrate subcollections: applications, documents, jobs, knowledge, preferences, interviews, usage
      // (Use firebase-admin batch or recursive copy for subcollections)
      console.log(`Migrated ${email} → ${uid}`);
    } catch (err) {
      console.warn(`Could not migrate ${email}: ${err.message}`);
    }
  }
}
migrateUsers();
```

**Subcollections to migrate for each user:**
- `applications` (and nested `timeline`, `notes`)
- `documents`
- `jobs`
- `knowledge`
- `preferences`
- `interviews`
- `usage`
- `watchlistJobs`

Also migrate:
- `targetCompanies/{email}` → `targetCompanies/{uid}`
- `fcmTokens/{email}` → `fcmTokens/{uid}`
- `digests` collection: update `userId` field from email → UID
- `platform_events` collection: update `userId` field from email → UID
- `search_logs/{email}` → `search_logs/{uid}`
- `featureUsage/{email}_*` documents

### npm install
```bash
cd functions && npm install
```

### Deploy
```bash
firebase deploy --only functions
```

---

## 3. Security Improvements

| Before | After |
|--------|-------|
| `userId` accepted from URL param / body / query string | Identity derived from verified Firebase ID token |
| `adminId` passed as query param — trivially forgeable | Admin verified via Firestore role lookup by authenticated UID |
| No token verification | `admin.auth().verifyIdToken()` on every protected request |
| CORS `origin: true` — any origin allowed | Strict allowlist: production domain + localhost only |
| No security headers | `helmet()` sets HSTS, CSP, X-Frame-Options, etc. |
| No rate limiting | 200 req/15 min per IP |
| Token stored once at login, never refreshed | `getIdToken()` called on every request — auto-refreshes before expiry |

---

## 4. Breaking Changes

1. **Frontend must send `Authorization: Bearer <token>` on every request** — done via `apiFetch()`
2. **Firestore document IDs change from email to UID** — requires data migration
3. **`adminId` query/body param no longer accepted** — admin identity from token only
4. **`userId` in POST bodies ignored** — server uses `req.user.uid`
5. **`POST /user/tier` now requires admin role** — was previously guarded by a shared secret
6. **Stripe `client_reference_id` is now UID** — webhook correctly uses it to update `users/{uid}`

---

## 5. Remaining Risks

| Risk | Severity | Notes |
|------|----------|-------|
| Firestore data migration not yet run | HIGH | Existing users will see empty dashboards after deploy until migration completes |
| Firebase App Check not yet implemented | MEDIUM | Recommended post-launch: prevents non-app clients from calling the API |
| Scheduled Cloud Functions still use email-based userId | MEDIUM | The `onSchedule` job reads preferences by userId — must be updated after migration |
| `users/{email}` docs not deleted after migration | LOW | Old docs are stale but not a security risk; clean up after verifying migration |
| Token refresh race condition on parallel `apiFetch` calls | LOW | Multiple simultaneous requests each call `getIdToken()` — Firebase SDK handles this gracefully |

---

## 6. Deployment Checklist

- [ ] `cd functions && npm install` (installs helmet, express-rate-limit)
- [ ] Run Firestore migration script on staging first, verify user data loads correctly
- [ ] Update `ALLOWED_ORIGINS` in `index.js` if production domain changes
- [ ] Run migration script on production Firestore
- [ ] `firebase deploy --only functions`
- [ ] Deploy updated `docs/app.js` to GitHub Pages
- [ ] Smoke test: login → dashboard loads → API calls return 200 (not 401)
- [ ] Smoke test: admin panel loads with token auth (no adminId param)
- [ ] Smoke test: Stripe checkout creates session with UID as `client_reference_id`
- [ ] Verify webhook still processes `checkout.session.completed` correctly
- [ ] Monitor Cloud Function logs for unexpected 401s
- [ ] (Post-launch) Implement Firebase App Check for both frontend and Cloud Functions
- [ ] (Post-launch) Delete old `users/{email}` documents after confirming migration success
