# Firebase App Check — Console Setup Guide

This guide walks through every console step needed to activate App Check for CareerCopilot (project `adib-job-agent`).

---

## 1. Enable Required Google Cloud APIs

In [Google Cloud Console](https://console.cloud.google.com/apis/library?project=adib-job-agent), enable:

- **reCAPTCHA Enterprise API** (if using Enterprise — recommended for production)
- **Firebase App Check API** (usually auto-enabled by Firebase Console)

---

## 2. Register a reCAPTCHA v3 Site Key

> Use reCAPTCHA v3 (simplest) or reCAPTCHA Enterprise (stronger, free tier available).

### Option A: reCAPTCHA v3 (current implementation)

1. Go to <https://www.google.com/recaptcha/admin/create>
2. **Label**: `CareerCopilot Production`
3. **reCAPTCHA type**: `reCAPTCHA v3`
4. **Domains**: add both:
   - `adeen924.github.io`
   - `localhost` (for dev debug tokens)
5. Accept terms → **Submit**
6. Copy the **Site Key** (public) and **Secret Key** (keep secret)

### Option B: reCAPTCHA Enterprise

1. Go to Google Cloud Console → reCAPTCHA Enterprise → **Create Key**
2. **Display name**: `CareerCopilot`
3. **Platform type**: Website
4. **Domains**: `adeen924.github.io`, `localhost`
5. Copy the **Site Key**

---

## 3. Register Your Web App in Firebase App Check

1. Open [Firebase Console](https://console.firebase.google.com/) → Project `adib-job-agent`
2. Navigate to **Build → App Check**
3. Click **Get started** (first time) or **Apps** tab
4. Find your Web App (`1:983490320341:web:c5cec62a3c827b56f18f5c`) → click **Register**
5. Select **reCAPTCHA v3** (or Enterprise)
6. Paste the **Site Key** from step 2
7. Click **Save**

---

## 4. Update `docs/firebase-config.js`

Replace the placeholder with the real site key:

```js
const RECAPTCHA_SITE_KEY = "6Lc...your-real-key...";
```

---

## 5. Generate a Debug Token for Local Development

1. In Firebase Console → App Check → Apps → your web app → **Manage debug tokens**
2. Click **Add debug token** → give it a name (e.g. `localhost-dev`)
3. Copy the generated token UUID
4. **Option A** (hardcode): replace `true` in `dashboard.html` / `index.html`:
   ```js
   self.FIREBASE_APPCHECK_DEBUG_TOKEN = "your-debug-token-uuid";
   ```
5. **Option B** (auto-generate): keep `self.FIREBASE_APPCHECK_DEBUG_TOKEN = true` as-is.
   On first local load, open browser DevTools console — Firebase will print the auto-generated token.
   Register that printed token in the Firebase Console step above.

---

## 6. Enable Enforcement per Firebase Service

App Check enforcement is independent for each Firebase service.

### Phase 1 — Monitor Mode (deploy this first)

Do NOT enable enforcement yet. Firebase will log App Check metrics without blocking any requests.

- In Firebase Console → App Check → **APIs** tab
- Leave all services in **Unmonitored** or **Monitoring** (not Enforced)
- Monitor the **Metrics** tab for 24–48 hours to establish a baseline

### Phase 2 — Enable Enforcement (after baseline is stable)

Enable enforcement service by service:

| Service | Console Path | Action |
|---------|-------------|--------|
| Firestore | App Check → APIs → Firestore | **Enforce** |
| Cloud Functions | App Check → APIs → Cloud Functions | **Enforce** |
| Cloud Storage | App Check → APIs → Storage | **Enforce** |
| Authentication | App Check → APIs → Auth | **Enforce** (optional) |

> **Important**: Enable one service at a time. Wait 30 minutes and check error rates before proceeding.

---

## 7. Enable Backend Enforcement

Once Firebase Console enforcement is on and metrics confirm no legitimate traffic is rejected:

```bash
# Set in Firebase Functions environment
firebase functions:secrets:set APP_CHECK_ENFORCE
# Enter: true

# Or add to functions/.env (never commit real secrets)
APP_CHECK_ENFORCE=true
```

Then redeploy functions:
```bash
firebase deploy --only functions
```

---

## 8. Rollout Strategy

```
Day 0  → Deploy code (monitor mode, no enforcement)
Day 1  → Watch Cloud Functions logs for [AppCheck] MISSING/INVALID lines
Day 2  → Enable Firestore enforcement in Firebase Console
Day 3  → Confirm no support tickets / error rate increase
Day 4  → Enable Cloud Functions enforcement in Firebase Console
Day 5  → Confirm stable
Day 6  → Set APP_CHECK_ENFORCE=true in backend (enforce mode)
Day 7  → Monitor for 24h then mark rollout complete
```

---

## 9. Monitoring

After enforcement is live, watch:

- **Firebase Console → App Check → Metrics**: legitimate vs. rejected request ratio
- **Google Cloud Console → Logging**: filter `[AppCheck]` prefix for custom backend logs
- **Firebase Console → Functions → Logs**: look for `MISSING token` or `INVALID token` lines

A healthy system shows ~0% rejected requests from legitimate clients.
