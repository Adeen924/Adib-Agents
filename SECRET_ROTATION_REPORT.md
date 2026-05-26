# Secret Rotation Report — CareerCopilot

**Date:** 2026-05-26  
**Branch:** Security-Changes  
**Repository:** adeen924/Adib-Agents  
**Severity:** CRITICAL — all credentials below must be rotated before next deployment

---

## Executive Summary

A security audit of the CareerCopilot repository found **three live credential sets** stored in plaintext files in the working directory (`backend/.env`, `functions/.env`, `backend/firebase-key.json`).

**Critical clarification:** A prior audit document (`CAREERCOPILOT_PRODUCTION_AUDIT.md`) incorrectly stated these files were "committed to git history." Git forensics (`git log -S`, `git ls-files`) confirmed they were **never tracked by git** — `.gitignore` was in place before any of these files were created. However, the secrets still require rotation because they exist in plaintext on a developer machine and may have been shared through other channels.

**Git history status: CLEAN. No rewrite required.**

---

## 1. Credentials Requiring Rotation

### 1.1 Anthropic API Key — CRITICAL

| Field | Value |
|---|---|
| File | `backend/.env` and `functions/.env` |
| Key prefix | `sk-ant-api03-1eW1wVUuPQWe3T…` (full key in file) |
| In git history | NO — never committed |
| In production | YES — deployed to Cloud Functions via Firebase Secrets |
| Risk if compromised | Unlimited API billing charges; model abuse |

**Rotation steps:**
1. Go to [https://console.anthropic.com/settings/keys](https://console.anthropic.com/settings/keys)
2. Delete the key beginning with `sk-ant-api03-1eW1…`
3. Create a new API key — copy the value immediately (shown only once)
4. Update Firebase Secret Manager: `firebase functions:secrets:set ANTHROPIC_API_KEY`
5. Re-deploy Cloud Functions: `firebase deploy --only functions`
6. Update `backend/.env` and `functions/.env` with the new key value

---

### 1.2 Firebase Service Account Private Key — CRITICAL

| Field | Value |
|---|---|
| File | `backend/firebase-key.json` |
| Service account | `firebase-adminsdk-fbsvc@adib-job-agent.iam.gserviceaccount.com` |
| Key ID | `8df58f89f6c9d8530cb929c62993e78e9709f94a` |
| In git history | NO — never committed |
| In production | NOT USED — Cloud Functions use Application Default Credentials |
| Risk if compromised | Full Firebase Admin SDK access; read/write/delete entire Firestore database |

**Rotation steps:**
1. Go to [Firebase Console → Project Settings → Service Accounts](https://console.firebase.google.com/project/adib-job-agent/settings/serviceaccounts/adminsdk)
2. Find the key with ID `8df58f89f6c9...` and **delete it** (click the trash icon)
3. If you need local development access: generate a new key from the same page
4. Store the new key file ONLY in `backend/firebase-key.json` (already in `.gitignore`)
5. Set `GOOGLE_APPLICATION_CREDENTIALS=../backend/firebase-key.json` in your shell for local dev
6. **Delete** `backend/firebase-key.json` from disk after confirming Cloud Functions work without it (they should — they use Application Default Credentials automatically)

**Production impact:** NONE. `functions/index.js` uses `admin.initializeApp()` with no arguments, which uses Application Default Credentials in the Cloud Functions runtime. The key file is only needed for local `node backend/server.js` execution, which appears to be unused.

---

### 1.3 Stripe Secret Key — MEDIUM

| Field | Value |
|---|---|
| File | NOT in any local file — already in Firebase Secret Manager only |
| Variable | `STRIPE_SECRET_KEY` |
| In git history | NO |
| Risk | Full payment processing access; could create fraudulent charges |

**Why rotate anyway:** If the key was ever set in a `.env` file that existed before `.gitignore` was configured, it may have been in an earlier working tree state. Out of caution:

1. Go to [Stripe Dashboard → Developers → API Keys](https://dashboard.stripe.com/apikeys)
2. Roll the Secret Key (Stripe rolls in-place, old key remains valid for a grace period)
3. Update Firebase Secret Manager: `firebase functions:secrets:set STRIPE_SECRET_KEY`
4. Re-deploy: `firebase deploy --only functions`

---

### 1.4 Stripe Webhook Secret — MEDIUM

| Field | Value |
|---|---|
| File | NOT in any local file — already in Firebase Secret Manager only |
| Variable | `STRIPE_WEBHOOK_SECRET` |
| In git history | NO |
| Risk | Webhook signature bypass; attacker could fake subscription events |

**Rotation steps:**
1. Go to [Stripe Dashboard → Developers → Webhooks](https://dashboard.stripe.com/webhooks)
2. Select your webhook endpoint, click "Roll secret"
3. Update Firebase Secret Manager: `firebase functions:secrets:set STRIPE_WEBHOOK_SECRET`
4. Re-deploy: `firebase deploy --only functions`

---

### 1.5 Stripe Price IDs — LOW

| Field | Value |
|---|---|
| File | `functions/.env` |
| Monthly Price ID | `price_1TYraoJI2qbyaR7I5sCKeMsJ` |
| Annual Price ID | `price_1TYraoJI2qbyaR7I6UDI0HJk` |
| In git history | NO |
| Risk | Low — price IDs are not secret credentials; they identify pricing tiers |

Price IDs are non-sensitive configuration (they cannot authorise charges on their own) but should be managed via Firebase Secrets alongside other Stripe config:

```bash
firebase functions:secrets:set STRIPE_PRO_PRICE_ID
firebase functions:secrets:set STRIPE_PRO_ANNUAL_PRICE_ID
```

---

## 2. Git History Cleanup

### Status: NOT REQUIRED

A thorough forensic analysis confirmed no secret values exist in any git commit:

```
git log -p --all -S "sk-ant-"           → 0 commits
git log -p --all -S "private_key"        → 0 commits
git log -p --all -S "firebase-adminsdk"  → 1 commit (audit doc, redacted values only)
git log -p --all -S "STRIPE_SECRET"      → 1 commit (audit doc, variable name reference only)
git ls-files backend/.env               → error: not tracked
git ls-files functions/.env             → error: not tracked
git ls-files backend/firebase-key.json  → error: not tracked
```

The `CAREERCOPILOT_PRODUCTION_AUDIT.md` document (commit `6c145db`) references these files but uses `[REDACTED]` placeholders — no live credential values are present in any commit.

**No `git filter-repo`, `BFG`, or force-push is needed.**

---

## 3. Working Directory Cleanup

The following files contain live credentials and must be handled:

| File | Action |
|---|---|
| `backend/firebase-key.json` | Delete after rotating the key in Firebase Console |
| `backend/.env` | Replace `ANTHROPIC_API_KEY` value with new rotated key |
| `functions/.env` | Replace `ANTHROPIC_API_KEY` value with new rotated key |

**Delete firebase-key.json from disk:**
```powershell
Remove-Item "backend\firebase-key.json"
```

**Verify no code depends on it:**
```powershell
Select-String -Path "**\*.js" -Pattern "firebase-key" -Recurse
# Expected: 0 matches (confirmed — functions/index.js uses admin.initializeApp() with no args)
```

---

## 4. `.gitignore` Hardening — COMPLETED

The `.gitignore` at the repository root has been updated (this session) to add:

- `.env.*` pattern (catches `.env.production`, `.env.local`, etc.)
- `*-service-account*.json` and `*serviceAccount*.json`
- `service-account*.json`
- `*.pem`, `*.key`
- `credentials.json`, `google-credentials.json`
- `application_default_credentials.json`
- `dist/`, `build/`, `.firebase/`

---

## 5. Firebase Secret Manager — Current State

Cloud Functions declare secrets via `runWith.secrets`:

```javascript
exports.api = functions.runWith({
  timeoutSeconds: 540,
  secrets: [
    "ANTHROPIC_API_KEY",
    "STRIPE_SECRET_KEY",
    "STRIPE_WEBHOOK_SECRET",
    "STRIPE_PRO_PRICE_ID",
    "STRIPE_PRO_ANNUAL_PRICE_ID",
  ],
}).https.onRequest(app);
```

This is the correct pattern — secrets are injected at runtime from Firebase Secret Manager and are never present in deployed source code.

**After rotation**, set all five secrets via CLI:

```bash
firebase functions:secrets:set ANTHROPIC_API_KEY
firebase functions:secrets:set STRIPE_SECRET_KEY
firebase functions:secrets:set STRIPE_WEBHOOK_SECRET
firebase functions:secrets:set STRIPE_PRO_PRICE_ID
firebase functions:secrets:set STRIPE_PRO_ANNUAL_PRICE_ID
```

Then redeploy:

```bash
firebase deploy --only functions
```

---

## 6. Local Development — Remove firebase-key.json Dependency

The `backend/` directory contains only `firebase-key.json` and `node_modules/` — there is no `server.js` or equivalent that uses it. The service account key file appears to be a leftover from an earlier development pattern.

**For any future local Cloud Functions testing**, use the Firebase Emulator Suite instead:

```bash
firebase emulators:start --only functions,firestore
```

The emulator uses Application Default Credentials automatically and does **not** require a service account key file. This eliminates the need to ever have a `firebase-key.json` on disk.

---

## 7. Remaining Risks

| Risk | Severity | Mitigation |
|---|---|---|
| Old Anthropic key still valid until rotated | CRITICAL | Rotate immediately |
| Old Firebase service account key still valid until deleted | CRITICAL | Delete in Firebase Console immediately |
| `.env` files on local disk contain live keys | HIGH | Rotate keys, update files |
| `backend/firebase-key.json` on local disk | HIGH | Delete after key rotation |
| Stripe keys not in local `.env` but may be on disk elsewhere | MEDIUM | Roll keys in Stripe dashboard |
| Audit doc `CAREERCOPILOT_PRODUCTION_AUDIT.md` claims secrets were in git (misleads future reviewers) | LOW | Document is factually incorrect; add correction notice or remove |
| No CI/CD secret scanning (e.g. GitHub secret scanning, trufflehog) | MEDIUM | Enable GitHub secret scanning on the repo |

---

## 8. Verification Checklist

### Credential Rotation
- [ ] Anthropic key `sk-ant-api03-1eW1…` deleted in Anthropic console
- [ ] New Anthropic API key created and copied
- [ ] Firebase service account key `8df58f89f6c9…` deleted in Firebase Console
- [ ] Stripe Secret Key rolled
- [ ] Stripe Webhook Secret rolled
- [ ] All 5 secrets updated in Firebase Secret Manager via `firebase functions:secrets:set`

### Working Directory
- [ ] `backend/firebase-key.json` deleted from disk
- [ ] `backend/.env` updated with new Anthropic API key
- [ ] `functions/.env` updated with new Anthropic API key

### Deployment
- [ ] `firebase deploy --only functions` completes without error
- [ ] Cloud Function health check: `GET /stats/<your-email>` returns 200 (not 500)
- [ ] Stripe webhook test event processed correctly (Stripe Dashboard → Webhooks → Send test event)
- [ ] Job search endpoint responds (manual search trigger in dashboard)
- [ ] AI generation works (generate one tailored resume)

### Git / Repository
- [ ] `.gitignore` updated (DONE — this session)
- [ ] `git status` shows no untracked secret files
- [ ] Confirm `git ls-files backend/.env` returns empty (no tracking)
- [ ] Enable GitHub secret scanning: Repository Settings → Security → Secret scanning

### Post-Rotation Monitoring (48 hours)
- [ ] Check Anthropic console for unexpected API usage on old key (should be zero after deletion)
- [ ] Check Firebase Console → Service Accounts for any unexpected key usage
- [ ] Check Stripe Dashboard → Events for any unexpected activity
- [ ] Monitor Cloud Functions logs for authentication errors

---

## 9. Deployment Checklist

Before next production deployment:

1. **Rotate all credentials** (Section 1 above) — do this FIRST
2. **Set all secrets in Firebase Secret Manager** (Section 5)
3. **Delete `backend/firebase-key.json`** from local disk
4. **Deploy functions**: `firebase deploy --only functions`
5. **Smoke test** all API endpoints per verification checklist (Section 8)
6. **Enable GitHub secret scanning** on the repository
7. **Consider**: adding a pre-commit hook (e.g. `detect-secrets` or `git-secrets`) to prevent future credential exposure

---

## 10. False Alarm Correction

The `CAREERCOPILOT_PRODUCTION_AUDIT.md` document in the repository states:

> `backend/.env`, `backend/firebase-key.json`, and `functions/.env` were found committed to the repository's git history.

**This is incorrect.** These files were never committed. All three are properly excluded by `.gitignore` and `git ls-files` confirms zero tracking. The credentials only exist in the local working directory.

This correction is documented here. The audit doc does not need to be removed from git (it contains no live credentials), but its claim about git exposure should not be relied upon.

---

*Report generated by security audit session — 2026-05-26*  
*No secret values are included in this document.*
