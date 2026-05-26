# Firebase App Check — Implementation Report

**Date**: 2026-05-26  
**Branch**: Security-Changes  
**Project**: `adib-job-agent` (CareerCopilot)

---

## Summary

Firebase App Check has been wired into both the frontend (reCAPTCHA v3 token generation + automatic attachment to all API requests) and the backend (token verification middleware on every protected Express route). The system starts in **monitor mode** — invalid or missing tokens are logged but not rejected — and switches to **enforce mode** via a single environment variable (`APP_CHECK_ENFORCE=true`) after the rollout is validated.

---

## Changes Made

### 1. `docs/firebase-config.js`

- Added `RECAPTCHA_SITE_KEY` constant with instructions for obtaining the key.
- **Action required**: replace `"YOUR_RECAPTCHA_SITE_KEY_HERE"` with the real key from Google reCAPTCHA Admin after completing `APP_CHECK_SETUP.md` steps 2–4.

### 2. `docs/dashboard.html`

- Added `firebase-app-check-compat.js` SDK script (v10.12.0).
- Set `self.FIREBASE_APPCHECK_DEBUG_TOKEN = true` for localhost, which auto-generates a debug token printed to the browser console on first load.
- Calls `firebase.appCheck().activate(ReCaptchaV3Provider, true)` before any other Firebase service is used.

### 3. `docs/index.html`

- Same App Check SDK and initialization as `dashboard.html`.
- App Check is now active on the login/signup page too (tokens are generated before auth requests, protecting the Auth service).

### 4. `docs/app.js` — `apiFetch()` wrapper

- After obtaining the Firebase ID token, the function now also calls `firebase.appCheck().getToken(false)` to get the current App Check token.
- Token is attached as `X-Firebase-AppCheck: <token>` on every API request.
- If App Check is unavailable (reCAPTCHA not yet configured, token fetch fails), the request proceeds without the header and the backend logs it in monitor mode.

### 5. `functions/index.js`

#### a) CORS `allowedHeaders`
Added `"X-Firebase-AppCheck"` to the allowed headers list so browsers don't block the preflight check.

#### b) `verifyAppCheck` middleware (lines 153–182)

```js
async function verifyAppCheck(req, res, next) {
  const token = req.headers["x-firebase-appcheck"];
  if (!token) {
    console.warn(`[AppCheck] MISSING token — method=... path=... ip=...`);
    if (APP_CHECK_ENFORCE) return res.status(401).json({ error: "App Check token required" });
    return next();
  }
  try {
    await admin.appCheck().verifyToken(token);
    next();
  } catch (err) {
    console.warn(`[AppCheck] INVALID token — ...`);
    if (APP_CHECK_ENFORCE) return res.status(401).json({ error: "Invalid App Check token" });
    next();
  }
}
```

- Uses `admin.appCheck().verifyToken()` (firebase-admin v12, supported since v9.2).
- Reads `APP_CHECK_ENFORCE` env var at startup; no redeploy needed to toggle.
- Logs every rejected or suspicious request with method, path, and IP.

#### c) Middleware order

```
Stripe webhook (app.post /webhook)  ← unaffected, terminates before middleware
Health check   (app.get  /)         ← unaffected, terminates before middleware
express.json()
verifyAppCheck   ← NEW, runs for all protected routes
authenticate     ← existing, unchanged
requireAdmin     ← existing, unchanged
```

---

## Deployment Steps

### Step 1: Complete reCAPTCHA setup (see `APP_CHECK_SETUP.md`)

1. Create reCAPTCHA v3 site key at <https://www.google.com/recaptcha/admin/create>
2. Register the key in Firebase Console → App Check
3. Replace `"YOUR_RECAPTCHA_SITE_KEY_HERE"` in `docs/firebase-config.js`

### Step 2: Register a debug token for local dev

Follow `APP_CHECK_SETUP.md` § 5 to register the auto-generated localhost debug token.

### Step 3: Deploy in monitor mode

```bash
# Deploy Cloud Functions (verifyAppCheck in monitor mode by default)
firebase deploy --only functions

# Deploy frontend (GitHub Pages picks up docs/ automatically on push)
git add docs/ functions/
git commit -m "feat: implement Firebase App Check (monitor mode)"
git push
```

### Step 4: Validate (24–48 hours)

- Watch Cloud Functions logs for `[AppCheck]` lines.
- If you see frequent `MISSING` lines from legitimate users, check that the frontend deployed correctly and the reCAPTCHA key is correct.
- Expect `MISSING` lines from Stripe webhook and health check calls — these are normal (those routes terminate before the middleware).

### Step 5: Enable Firebase Console enforcement (per service)

Follow `APP_CHECK_SETUP.md` § 6. Enable Firestore first, wait, then Cloud Functions.

### Step 6: Enable backend enforcement

```bash
# Set the enforce flag
firebase functions:config:set appcheck.enforce=true
# OR add APP_CHECK_ENFORCE=true to Functions secrets/env and redeploy
firebase deploy --only functions
```

---

## Testing Instructions

### Local development

1. Start the Firebase emulator: `firebase emulators:start`
2. Open `http://localhost:5500/docs/index.html` (or your local server)
3. Open browser DevTools → Console
4. On first load with `FIREBASE_APPCHECK_DEBUG_TOKEN = true`, Firebase prints:
   ```
   App Check debug token: xxxxxxxx-xxxx-xxxx-xxxx-xxxxxxxxxxxx
   ```
5. Register this token in Firebase Console → App Check → debug tokens
6. Subsequent requests to the emulated backend will include `X-Firebase-AppCheck`

### Verify header is sent

In DevTools → Network → select any API call → Headers:
```
X-Firebase-AppCheck: <long JWT token>
```

### Verify backend monitor logs

In Cloud Functions logs:
- Requests WITH a valid token: no `[AppCheck]` log line
- Requests WITHOUT a token: `[AppCheck] MISSING token — ...`

### Verify enforce mode

Set `APP_CHECK_ENFORCE=true` in a test environment and make a direct `curl` request without the header:
```bash
curl -X GET \
  -H "Authorization: Bearer <valid-id-token>" \
  https://us-central1-adib-job-agent.cloudfunctions.net/api/jobs/testuid
# Expected: 401 {"error":"App Check token required"}
```

---

## Rollback Instructions

### Rollback frontend (App Check not blocking anything on its own)

If reCAPTCHA causes UI issues, revert `docs/firebase-config.js` RECAPTCHA_SITE_KEY to the placeholder. App Check will fail silently and the backend stays in monitor mode — no user impact.

### Rollback backend enforcement

```bash
# Unset the enforce flag
firebase functions:config:unset appcheck.enforce
firebase deploy --only functions
```

No code change required; `APP_CHECK_ENFORCE` defaults to `false`.

### Rollback Firebase Console enforcement

Firebase Console → App Check → APIs → set each service back to **Monitoring** (not Enforced). Instant, no deploy needed.

### Full rollback (remove App Check entirely)

Revert these files to their pre-App-Check state:
- `docs/firebase-config.js` — remove `RECAPTCHA_SITE_KEY`
- `docs/dashboard.html` — remove App Check SDK script and init block
- `docs/index.html` — remove App Check SDK script and init block
- `docs/app.js` — remove `appCheckToken` logic from `apiFetch()`
- `functions/index.js` — remove `verifyAppCheck` function, its `app.use()`, and `APP_CHECK_ENFORCE`; revert `allowedHeaders`

---

## Remaining Risks

| Risk | Likelihood | Mitigation |
|------|-----------|------------|
| reCAPTCHA blocked by ad blockers | Medium | Monitor error rates; consider reCAPTCHA Enterprise (harder to block) |
| Debug token leaked to production | Low | `FIREBASE_APPCHECK_DEBUG_TOKEN` only set when `hostname === "localhost"` |
| Token refresh race condition | Low | `isTokenAutoRefreshEnabled = true` handles this; `getToken(false)` uses cached token |
| Stripe webhook blocked | None | Webhook route terminates before `verifyAppCheck` middleware runs |
| Scheduled Cloud Functions blocked | None | Scheduled functions are separate exports, not routed through Express |
| firebase-admin `appCheck()` API breaking change | Very low | Using stable `verifyToken()` API available since admin v9.2, project uses v12 |

---

## Files Modified

| File | Change |
|------|--------|
| `docs/firebase-config.js` | Added `RECAPTCHA_SITE_KEY` constant |
| `docs/dashboard.html` | Added App Check SDK + debug token + `activate()` call |
| `docs/index.html` | Added App Check SDK + debug token + `activate()` call |
| `docs/app.js` | Updated `apiFetch()` to attach `X-Firebase-AppCheck` header |
| `functions/index.js` | Added `verifyAppCheck` middleware + CORS header + `app.use()` |

## Files Created

| File | Purpose |
|------|---------|
| `APP_CHECK_SETUP.md` | Step-by-step Firebase Console configuration guide |
| `APP_CHECK_IMPLEMENTATION_REPORT.md` | This document |
