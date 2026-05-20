/* =============================================================
   CareerCopilot — Onboarding Engine  v1.0
   Vanilla JS, no dependencies beyond Firebase (already loaded).
   ============================================================= */

const OnboardingEngine = (() => {
  'use strict';

  // ── Config ───────────────────────────────────────────────────────
  const FS_COL  = 'onboarding';
  const LS_KEY  = 'cc_ob_v1';

  // ── State ────────────────────────────────────────────────────────
  let _userId  = null;
  let _tier    = 'free';
  let _state   = null;   // populated by init(); never null after that
  let _tourIdx = 0;
  let _spotRAF = null;
  let _inited  = false;  // guard against double-init

  function defaultState() {
    return {
      wizardStarted:   false,
      wizardCompleted: false,
      wizardSkipped:   false,
      wizardStep:      0,
      completedSteps:  [],
      skippedSteps:    [],
      tourCompleted:   false,
      firstWinShown:   false,
      checklist:       {},
      startedAt:       null,
      completedAt:     null,
    };
  }

  // ── Wizard step definitions ──────────────────────────────────────
  const STEPS = [
    {
      id:       'resume',
      icon:     '📄',
      title:    'Upload Your Resume',
      body:     'Your resume is the engine behind everything. Upload it once — our AI parses it instantly and uses it to tailor every application it generates for you.',
      hint:     'PDF, DOCX, and TXT all supported.',
      panel:    'profile',
      spotlight:'#resumeUploadZone',
      cta:      'Resume Uploaded ✓',
      skip:     'Skip for now',
    },
    {
      id:       'profile',
      icon:     '👤',
      title:    'Complete Your Profile',
      body:     'Review your current position, skills, and the role you\'re targeting. The more accurate this is, the better your AI job matches will be.',
      hint:     'You can always update this later.',
      panel:    'profile',
      spotlight:'#kbForm',
      cta:      'Profile Looks Good ✓',
      skip:     'Skip for now',
    },
    {
      id:       'notifications',
      icon:     '🔔',
      title:    'Set Up Notifications',
      body:     'The best jobs get filled fast. Add your email or phone number so we can reach you the moment we find a strong match — even when you\'re not logged in.',
      hint:     'We never share your contact info.',
      panel:    'profile',
      spotlight:'#settingNotifEmail',
      scrollTo: '#settingNotifEmail',
      cta:      'Notifications Saved ✓',
      skip:     'Skip for now',
    },
    {
      id:       'criteria',
      icon:     '🎯',
      title:    'Set Your Job Criteria',
      body:     'Tell us exactly what you\'re looking for: role, location, salary, experience level, and more. This drives your automated search — be as specific as possible.',
      hint:     'You can change this anytime in Preferences.',
      panel:    'preferences',
      spotlight:'#prefsForm',
      cta:      'Criteria Saved ✓',
      skip:     'Skip for now',
    },
    {
      id:       'companies',
      icon:     '🏢',
      title:    'Add Target Companies',
      body:     'Add companies you\'d love to work for. We\'ll monitor their career pages daily and surface new openings in your dashboard automatically.',
      hint:     'Start with 2-3 — you can add more any time.',
      panel:    'preferences',
      spotlight:'#addTargetCompanyBtn',
      scrollTo: '#addTargetCompanyBtn',
      cta:      'Companies Saved ✓',
      skip:     'Skip for now',
    },
    {
      id:       'schedule',
      icon:     '⚡',
      title:    'Activate Your AI Search',
      body:     'Choose how often your AI searches for matching jobs. We recommend 2× daily so you catch new postings within hours of them going live.',
      hint:     'Searches run on your local timezone.',
      panel:    'preferences',
      spotlight:'#settingSearchEnabled',
      scrollTo: '#settingSearchEnabled',
      cta:      'Search Activated ✓',
      skip:     'Skip for now',
    },
    {
      id:       'tour',
      icon:     '📊',
      title:    'Your Dashboard Tour',
      body:     'You\'re almost set! Take a quick 60-second tour of your dashboard — we\'ll show you where to find everything and how to track your search activity.',
      hint:     'Takes less than 1 minute.',
      panel:    'dashboard',
      spotlight: null,
      cta:      'Start Tour →',
      skip:     'Skip Tour',
      isTour:   true,
    },
  ];

  // ── Dashboard tour stop definitions ─────────────────────────────
  const TOUR = [
    {
      target:   '.stats-grid',
      title:    'Agent Activity',
      body:     'Your AI agent\'s 24-hour summary lives here — how many searches ran, tokens used, and estimated cost.',
      position: 'bottom',
    },
    {
      target:   '#dashboardJobs',
      title:    'Recent Job Matches',
      body:     'New jobs matching your criteria appear here automatically. Click any card to generate a tailored resume, cover letter, or interview prep.',
      position: 'top',
    },
    {
      target:   '#applicationsTable',
      title:    'Application Tracker',
      body:     'Log every job you apply to and track its status — Applied, Screening, Interview, Offer. All in one place.',
      position: 'top',
    },
    {
      target:   '#nav-jobs',
      title:    'Jobs Found',
      body:     'Browse every job our AI has discovered. Search, filter, and save the ones you love.',
      position: 'right',
    },
    {
      target:   '#nav-preferences',
      title:    'Preferences',
      body:     'Adjust your job criteria, target companies, and search schedule here anytime. The more tuned it is, the sharper your matches get.',
      position: 'right',
    },
  ];

  // ── Checklist items ──────────────────────────────────────────────
  const CHECKLIST = [
    { id: 'resume',        label: 'Upload your resume',         step: 'resume',        panel: 'profile' },
    { id: 'profile',       label: 'Complete your profile',      step: 'profile',       panel: 'profile' },
    { id: 'notifications', label: 'Set up notifications',       step: 'notifications', panel: 'profile' },
    { id: 'criteria',      label: 'Set job search criteria',    step: 'criteria',      panel: 'preferences' },
    { id: 'companies',     label: 'Add target companies',       step: 'companies',     panel: 'preferences' },
    { id: 'schedule',      label: 'Activate AI search',         step: 'schedule',      panel: 'preferences' },
    { id: 'tour',          label: 'Complete dashboard tour',    step: 'tour',          panel: null },
    { id: 'first-job',     label: 'View your first job match',  step: null,            panel: 'jobs' },
  ];

  // ── DOM refs (set in init) ───────────────────────────────────────
  let $welcome, $wizard, $wizardStep, $wizardProgress, $wizardTitle,
      $wizardIcon, $wizardBody, $wizardHint, $wizardCta, $wizardSkip,
      $wizardBack, $wizardClose, $wizardStepLabel,
      $backdrop, $hole, $tooltip,
      $checklist, $checklistItems, $checklistCount, $checklistPill,
      $firstWin;

  // ════════════════════════════════════════════════════════════════
  //  PUBLIC: init
  // ════════════════════════════════════════════════════════════════
  async function init(userId, tier) {
    if (_inited) return;   // only run once
    _inited = true;

    _userId = userId;
    _tier   = tier || 'free';

    // Give _state a safe default immediately so any early click
    // on the restart button doesn't throw before _loadState resolves
    _state = defaultState();

    _cacheDom();
    _bindEvents();

    _state = await _loadState();

    if (!_state.wizardStarted) {
      // Brand-new user — show welcome modal after short delay
      setTimeout(showWelcomeModal, 800);
    } else if (!_state.wizardCompleted && !_state.wizardSkipped) {
      // Returning mid-wizard user — offer to resume
      setTimeout(_showResumePrompt, 1000);
    } else {
      // Fully onboarded — just render checklist
      _renderChecklist();
    }

    _checkReEngagement();
  }

  // ════════════════════════════════════════════════════════════════
  //  WELCOME MODAL
  // ════════════════════════════════════════════════════════════════
  function showWelcomeModal() {
    if (!$welcome) { console.warn('[Onboarding] #obWelcome not found'); return; }
    $welcome.classList.add('ob-visible');
    document.body.style.overflow = 'hidden';
  }

  function _hideWelcomeModal() {
    $welcome.classList.remove('ob-visible');
    document.body.style.overflow = '';
  }

  function _startFromWelcome() {
    _state.wizardStarted = true;
    _state.startedAt     = new Date().toISOString();
    _saveState();
    _hideWelcomeModal();
    setTimeout(showWizard, 300);
  }

  function _skipFromWelcome() {
    _state.wizardSkipped = true;
    _saveState();
    _hideWelcomeModal();
    _renderChecklist();
  }

  // ════════════════════════════════════════════════════════════════
  //  WIZARD
  // ════════════════════════════════════════════════════════════════
  function showWizard() {
    _goToStep(_state.wizardStep || 0);
    $wizard.classList.add('ob-visible');
    $wizard.setAttribute('aria-hidden', 'false');
  }

  function _closeWizard() {
    $wizard.classList.remove('ob-visible');
    $wizard.setAttribute('aria-hidden', 'true');
    _clearSpotlight();
    _renderChecklist();
  }

  function _goToStep(idx) {
    if (idx >= STEPS.length) { _finishWizard(); return; }
    _state.wizardStep = idx;
    _saveState();

    const step = STEPS[idx];

    // Navigate the main app to the relevant panel
    if (typeof showPanel === 'function') showPanel(step.panel);

    // Populate wizard panel
    $wizardIcon.textContent       = step.icon;
    $wizardTitle.textContent      = step.title;
    $wizardBody.textContent       = step.body;
    $wizardHint.textContent       = step.hint || '';
    $wizardHint.style.display     = step.hint ? '' : 'none';
    $wizardCta.textContent        = step.cta;
    $wizardSkip.textContent       = step.skip;
    $wizardStepLabel.textContent  = `Step ${idx + 1} of ${STEPS.length}`;

    // Progress bar
    const pct = Math.round(((idx) / STEPS.length) * 100);
    $wizardProgress.style.width = pct + '%';

    // Back button visibility
    $wizardBack.style.visibility = idx === 0 ? 'hidden' : 'visible';

    // Spotlight after panel paints
    requestAnimationFrame(() => {
      setTimeout(() => {
        if (step.scrollTo) {
          const el = document.querySelector(step.scrollTo);
          if (el) el.scrollIntoView({ behavior: 'smooth', block: 'center' });
        }
        if (step.spotlight) {
          setTimeout(() => _showSpotlight(step.spotlight), step.scrollTo ? 500 : 50);
        } else {
          _clearSpotlight();
        }
      }, 250);
    });
  }

  function _nextStep() {
    const step = STEPS[_state.wizardStep];
    if (step.isTour) {
      // CTA on tour step starts the spotlight tour
      _closeWizard();
      setTimeout(_startTour, 400);
      return;
    }
    if (!_state.completedSteps.includes(step.id)) {
      _state.completedSteps.push(step.id);
    }
    _markChecklistItem(step.id, true);
    _goToStep((_state.wizardStep || 0) + 1);
  }

  function _skipStep() {
    const step = STEPS[_state.wizardStep];
    if (!_state.skippedSteps.includes(step.id)) {
      _state.skippedSteps.push(step.id);
    }
    if (step.isTour) {
      _state.tourCompleted = true;
      _markChecklistItem('tour', true);
      _saveState();
      _finishWizard();
      return;
    }
    _goToStep((_state.wizardStep || 0) + 1);
  }

  function _finishWizard() {
    _state.wizardCompleted = true;
    _state.completedAt     = new Date().toISOString();
    _saveState();
    _closeWizard();
    if (!_state.firstWinShown) {
      _state.firstWinShown = true;
      _saveState();
      setTimeout(_showFirstWin, 500);
    } else {
      _renderChecklist();
    }
  }

  // Public reopener — called from "Restart tour" in sidebar footer
  function reopenWizard() {
    _state.wizardStep = 0;
    _saveState();
    showWizard();
  }

  // ════════════════════════════════════════════════════════════════
  //  SPOTLIGHT OVERLAY
  // ════════════════════════════════════════════════════════════════
  function _showSpotlight(selector) {
    const target = document.querySelector(selector);
    if (!target) return;

    _positionSpotlight(target);
    $backdrop.classList.add('ob-visible');
    $hole.classList.add('ob-visible');

    // Reposition on resize/scroll
    if (_spotRAF) cancelAnimationFrame(_spotRAF);
    const track = () => {
      _positionSpotlight(target);
      _spotRAF = requestAnimationFrame(track);
    };
    _spotRAF = requestAnimationFrame(track);
  }

  function _positionSpotlight(target) {
    const r   = target.getBoundingClientRect();
    const pad = 8;
    $hole.style.top    = (r.top    - pad) + 'px';
    $hole.style.left   = (r.left   - pad) + 'px';
    $hole.style.width  = (r.width  + pad * 2) + 'px';
    $hole.style.height = (r.height + pad * 2) + 'px';
  }

  function _clearSpotlight() {
    if (_spotRAF) { cancelAnimationFrame(_spotRAF); _spotRAF = null; }
    $backdrop.classList.remove('ob-visible');
    $hole.classList.remove('ob-visible');
  }

  // ════════════════════════════════════════════════════════════════
  //  DASHBOARD TOUR (spotlight series)
  // ════════════════════════════════════════════════════════════════
  function _startTour() {
    if (typeof showPanel === 'function') showPanel('dashboard');
    _tourIdx = 0;
    setTimeout(_showTourStop, 400);
  }

  function _showTourStop() {
    if (_tourIdx >= TOUR.length) { _endTour(); return; }
    const stop   = TOUR[_tourIdx];
    const target = document.querySelector(stop.target);

    // Position hole
    if (target) {
      const r   = target.getBoundingClientRect();
      const pad = 10;
      $hole.style.top    = (r.top    - pad) + 'px';
      $hole.style.left   = (r.left   - pad) + 'px';
      $hole.style.width  = (r.width  + pad * 2) + 'px';
      $hole.style.height = (r.height + pad * 2) + 'px';
    }

    // Build tooltip
    $tooltip.innerHTML = `
      <div class="ob-tour-header">
        <strong>${_esc(stop.title)}</strong>
        <span class="ob-tour-counter">${_tourIdx + 1}/${TOUR.length}</span>
      </div>
      <p>${_esc(stop.body)}</p>
      <div class="ob-tour-actions">
        ${_tourIdx < TOUR.length - 1
          ? `<button class="ob-btn ob-btn-primary" id="obTourNext">Next →</button>`
          : `<button class="ob-btn ob-btn-primary" id="obTourNext">Finish Tour ✓</button>`
        }
        <button class="ob-btn ob-btn-ghost" id="obTourSkip">Skip tour</button>
      </div>`;

    _positionTooltip(target, stop.position);

    $backdrop.classList.add('ob-visible');
    $hole.classList.add('ob-visible');
    $tooltip.classList.add('ob-visible');

    document.getElementById('obTourNext').onclick  = _tourNext;
    document.getElementById('obTourSkip').onclick  = _endTour;
  }

  function _positionTooltip(target, position) {
    if (!target) {
      $tooltip.style.top  = '50%';
      $tooltip.style.left = '50%';
      $tooltip.style.transform = 'translate(-50%, -50%)';
      return;
    }
    const r    = target.getBoundingClientRect();
    const tw   = 300;
    const pad  = 20;
    $tooltip.style.transform = '';

    if (position === 'bottom') {
      $tooltip.style.top  = (r.bottom + pad) + 'px';
      $tooltip.style.left = Math.max(pad, Math.min(window.innerWidth - tw - pad, r.left + r.width / 2 - tw / 2)) + 'px';
    } else if (position === 'top') {
      $tooltip.style.top  = (r.top - pad - 150) + 'px'; // approx height
      $tooltip.style.left = Math.max(pad, Math.min(window.innerWidth - tw - pad, r.left + r.width / 2 - tw / 2)) + 'px';
    } else if (position === 'right') {
      $tooltip.style.top  = Math.max(pad, r.top + r.height / 2 - 80) + 'px';
      $tooltip.style.left = (r.right + pad) + 'px';
    } else {
      $tooltip.style.top  = Math.max(pad, r.top + r.height / 2 - 80) + 'px';
      $tooltip.style.left = (r.left - tw - pad) + 'px';
    }
  }

  function _tourNext() {
    _tourIdx++;
    _showTourStop();
  }

  function _endTour() {
    _clearSpotlight();
    $tooltip.classList.remove('ob-visible');
    _state.tourCompleted = true;
    _markChecklistItem('tour', true);
    _state.wizardCompleted = true;
    _state.completedAt     = _state.completedAt || new Date().toISOString();
    _saveState();
    if (!_state.firstWinShown) {
      _state.firstWinShown = true;
      _saveState();
      setTimeout(_showFirstWin, 400);
    } else {
      _renderChecklist();
    }
  }

  // ════════════════════════════════════════════════════════════════
  //  FIRST WIN MODAL
  // ════════════════════════════════════════════════════════════════
  function _showFirstWin() {
    const done  = _state.completedSteps.length;
    const total = STEPS.length;
    document.getElementById('obFirstWinSteps').textContent = done;
    document.getElementById('obFirstWinTotal').textContent = total;
    _renderFirstWinChecklist();
    $firstWin.classList.add('ob-visible');
    document.body.style.overflow = 'hidden';
    _burst();
  }

  function _hideFirstWin() {
    $firstWin.classList.remove('ob-visible');
    document.body.style.overflow = '';
    _renderChecklist();
  }

  function _renderFirstWinChecklist() {
    const el = document.getElementById('obFirstWinList');
    if (!el) return;
    el.innerHTML = CHECKLIST.slice(0, 6).map(item => {
      const done = (_state.completedSteps || []).includes(item.step) ||
                   (_state.checklist || {})[item.id];
      return `<div class="ob-fw-item ${done ? 'done' : 'pending'}">
        <span class="ob-fw-icon">${done ? '✓' : '○'}</span>
        <span>${item.label}</span>
      </div>`;
    }).join('');
  }

  // Confetti burst (CSS-only, no lib needed)
  function _burst() {
    const container = document.getElementById('obConfetti');
    if (!container) return;
    container.innerHTML = '';
    const colours = ['#d4af37','#f5d060','#ffffff','#a8891f','#ffe066'];
    for (let i = 0; i < 60; i++) {
      const p = document.createElement('div');
      p.className = 'ob-confetti-piece';
      p.style.cssText = `
        left:${Math.random() * 100}%;
        background:${colours[Math.floor(Math.random() * colours.length)]};
        width:${6 + Math.random() * 6}px;
        height:${6 + Math.random() * 6}px;
        animation-delay:${Math.random() * 0.6}s;
        animation-duration:${1.2 + Math.random() * 0.8}s;
        border-radius:${Math.random() > 0.5 ? '50%' : '2px'};
      `;
      container.appendChild(p);
    }
    setTimeout(() => { container.innerHTML = ''; }, 3000);
  }

  // ════════════════════════════════════════════════════════════════
  //  PROGRESS CHECKLIST WIDGET
  // ════════════════════════════════════════════════════════════════
  function _renderChecklist() {
    if (!$checklist) return;
    const done  = CHECKLIST.filter(i =>
      (_state.completedSteps || []).includes(i.step) ||
      (_state.checklist || {})[i.id]
    ).length;
    const total = CHECKLIST.length;
    const pct   = Math.round((done / total) * 100);

    // Update pill
    if ($checklistPill) $checklistPill.textContent = `Setup ${pct}% complete`;

    // Count
    if ($checklistCount) $checklistCount.textContent = `${done} / ${total} complete`;

    // Progress ring
    const ring = $checklist.querySelector('.ob-cl-ring-fill');
    if (ring) {
      const circ = 2 * Math.PI * 20; // r=20
      ring.style.strokeDashoffset = circ - (circ * pct / 100);
    }

    // Items
    if ($checklistItems) {
      $checklistItems.innerHTML = CHECKLIST.map(item => {
        const isDone = (_state.completedSteps || []).includes(item.step) ||
                       (_state.checklist || {})[item.id];
        const isPro  = item.proOnly && _tier === 'free';
        return `
          <div class="ob-cl-item ${isDone ? 'done' : ''} ${isPro ? 'locked' : ''}"
               data-item="${item.id}"
               role="button" tabindex="0"
               aria-label="${item.label}${isDone ? ' — completed' : ''}${isPro ? ' — Pro required' : ''}">
            <span class="ob-cl-check">${isDone ? '✓' : (isPro ? '🔒' : '○')}</span>
            <span class="ob-cl-label">${item.label}</span>
            ${!isDone && !isPro ? '<span class="ob-cl-arrow">→</span>' : ''}
          </div>`;
      }).join('');

      $checklistItems.querySelectorAll('.ob-cl-item:not(.done):not(.locked)').forEach(el => {
        el.addEventListener('click', () => {
          const item = CHECKLIST.find(i => i.id === el.dataset.item);
          if (!item) return;
          if (item.panel && typeof showPanel === 'function') showPanel(item.panel);
          // Scroll to the relevant step in wizard if not completed
          const stepIdx = STEPS.findIndex(s => s.id === item.step);
          if (stepIdx >= 0 && item.step) {
            _state.wizardStep = stepIdx;
            showWizard();
          }
        });
        el.addEventListener('keydown', e => { if (e.key === 'Enter' || e.key === ' ') el.click(); });
      });
    }

    // Show or hide the widget
    if (done === total) {
      $checklist.classList.add('ob-cl-complete');
    } else {
      $checklist.style.display = '';
    }

    // Auto-collapse after 7 days of full onboarding
    const shouldCollapse = _state.wizardCompleted && done >= 4;
    if (shouldCollapse) {
      $checklist.classList.add('ob-cl-collapsed');
    }
  }

  function _markChecklistItem(itemId, done) {
    if (!_state.checklist) _state.checklist = {};
    _state.checklist[itemId] = done;
    _saveState();
    _renderChecklist();
  }

  // Call this from app.js when the user views their first job
  function markJobViewed() {
    _markChecklistItem('first-job', true);
  }

  // ════════════════════════════════════════════════════════════════
  //  RE-ENGAGEMENT CHECK
  // ════════════════════════════════════════════════════════════════
  function _checkReEngagement() {
    if (_state.wizardCompleted) return;
    const started = _state.startedAt ? new Date(_state.startedAt) : null;
    if (!started) return;
    const daysSince = (Date.now() - started.getTime()) / 86400000;
    if (daysSince >= 3 && !_state.wizardCompleted && !_state.wizardSkipped) {
      setTimeout(_showReEngagementBanner, 2000);
    }
  }

  function _showResumePrompt() {
    // Toast-style nudge to resume setup
    _showNudgeToast(
      'Continue your setup',
      `You\'re ${STEPS.length - (_state.wizardStep || 0)} steps away from activating your AI job search.`,
      'Resume Setup',
      showWizard
    );
  }

  function _showReEngagementBanner() {
    _showNudgeToast(
      'Your setup isn\'t finished yet',
      'Complete your profile to get the most accurate job matches.',
      'Finish Setup',
      showWizard
    );
  }

  function _showNudgeToast(title, body, ctaText, ctaFn) {
    const existing = document.getElementById('obNudgeToast');
    if (existing) existing.remove();

    const el = document.createElement('div');
    el.id = 'obNudgeToast';
    el.className = 'ob-nudge-toast';
    el.setAttribute('role', 'alert');
    el.innerHTML = `
      <div class="ob-nudge-icon">✦</div>
      <div class="ob-nudge-content">
        <div class="ob-nudge-title">${_esc(title)}</div>
        <div class="ob-nudge-body">${_esc(body)}</div>
      </div>
      <button class="ob-btn ob-btn-gold ob-nudge-cta" id="obNudgeCta">${_esc(ctaText)}</button>
      <button class="ob-nudge-close" id="obNudgeClose" aria-label="Dismiss">×</button>`;
    document.body.appendChild(el);

    // Animate in
    requestAnimationFrame(() => el.classList.add('ob-visible'));

    document.getElementById('obNudgeCta').onclick   = () => { el.remove(); ctaFn(); };
    document.getElementById('obNudgeClose').onclick = () => {
      el.classList.remove('ob-visible');
      setTimeout(() => el.remove(), 400);
    };
    setTimeout(() => {
      if (document.body.contains(el)) {
        el.classList.remove('ob-visible');
        setTimeout(() => el.remove(), 400);
      }
    }, 10000);
  }

  // ════════════════════════════════════════════════════════════════
  //  STATE PERSISTENCE  (Firestore + localStorage fallback)
  // ════════════════════════════════════════════════════════════════
  async function _loadState() {
    // Try Firestore first
    try {
      if (typeof firebase !== 'undefined' && firebase.firestore) {
        const db  = firebase.firestore();
        const doc = await db.collection(FS_COL).doc(_userId).get();
        if (doc.exists) return { ...defaultState(), ...doc.data() };
      }
    } catch (e) { /* fall through */ }

    // localStorage fallback
    try {
      const raw = localStorage.getItem(LS_KEY + '_' + _userId);
      if (raw) return { ...defaultState(), ...JSON.parse(raw) };
    } catch (e) { /* ignore */ }

    return defaultState();
  }

  async function _saveState() {
    const email = sessionStorage.getItem('fbEmail') || null;
    const data  = { ..._state, updatedAt: new Date().toISOString(), ...(email ? { email } : {}) };

    // Firestore (non-blocking)
    try {
      if (typeof firebase !== 'undefined' && firebase.firestore) {
        firebase.firestore().collection(FS_COL).doc(_userId).set(data, { merge: true });
      }
    } catch (e) { /* non-fatal */ }

    // localStorage mirror
    try {
      localStorage.setItem(LS_KEY + '_' + _userId, JSON.stringify(data));
    } catch (e) { /* non-fatal */ }
  }

  // ════════════════════════════════════════════════════════════════
  //  DOM CACHE + EVENTS
  // ════════════════════════════════════════════════════════════════
  function _cacheDom() {
    $welcome         = document.getElementById('obWelcome');
    $wizard          = document.getElementById('obWizard');
    $wizardIcon      = document.getElementById('obWizardIcon');
    $wizardTitle     = document.getElementById('obWizardTitle');
    $wizardBody      = document.getElementById('obWizardBody');
    $wizardHint      = document.getElementById('obWizardHint');
    $wizardCta       = document.getElementById('obWizardCta');
    $wizardSkip      = document.getElementById('obWizardSkip');
    $wizardBack      = document.getElementById('obWizardBack');
    $wizardClose     = document.getElementById('obWizardClose');
    $wizardProgress  = document.getElementById('obWizardProgress');
    $wizardStepLabel = document.getElementById('obWizardStepLabel');
    $backdrop        = document.getElementById('obBackdrop');
    $hole            = document.getElementById('obHole');
    $tooltip         = document.getElementById('obTourTooltip');
    $checklist       = document.getElementById('obChecklist');
    $checklistItems  = document.getElementById('obChecklistItems');
    $checklistCount  = document.getElementById('obChecklistCount');
    $checklistPill   = document.getElementById('obChecklistPill');
    $firstWin        = document.getElementById('obFirstWin');
  }

  function _bindEvents() {
    // Welcome
    document.getElementById('obWelcomeStart')?.addEventListener('click', _startFromWelcome);
    document.getElementById('obWelcomeSkip')?.addEventListener('click',  _skipFromWelcome);

    // Wizard
    $wizardCta?.addEventListener('click',   _nextStep);
    $wizardSkip?.addEventListener('click',  _skipStep);
    $wizardBack?.addEventListener('click',  () => {
      const prev = Math.max(0, (_state.wizardStep || 0) - 1);
      _goToStep(prev);
    });
    $wizardClose?.addEventListener('click', () => {
      _state.wizardSkipped = true;
      _saveState();
      _closeWizard();
    });

    // ESC closes wizard
    document.addEventListener('keydown', e => {
      if (e.key === 'Escape') {
        if ($wizard?.classList.contains('ob-visible')) {
          _state.wizardSkipped = true;
          _saveState();
          _closeWizard();
        }
        if ($firstWin?.classList.contains('ob-visible')) _hideFirstWin();
        if ($welcome?.classList.contains('ob-visible'))  _skipFromWelcome();
      }
    });

    // First win close
    document.getElementById('obFirstWinClose')?.addEventListener('click', _hideFirstWin);
    document.getElementById('obFirstWinDash')?.addEventListener('click',  () => {
      _hideFirstWin();
      if (typeof showPanel === 'function') showPanel('dashboard');
    });

    // Checklist toggle
    $checklistPill?.addEventListener('click', _toggleChecklist);
    document.getElementById('obChecklistToggle')?.addEventListener('click', _toggleChecklist);

    // Sidebar "Setup guide" link + checklist reopen button
    // Use event delegation so both buttons work regardless of DOM order/duplicates
    document.addEventListener('click', e => {
      if (e.target.closest('#obRestartTour, #obChecklistReopen')) reopenWizard();
    });
  }

  function _toggleChecklist() {
    $checklist?.classList.toggle('ob-cl-collapsed');
  }

  // ── Tiny escape helper ───────────────────────────────────────────
  function _esc(str) {
    return String(str)
      .replace(/&/g,'&amp;')
      .replace(/</g,'&lt;')
      .replace(/>/g,'&gt;')
      .replace(/"/g,'&quot;');
  }

  // ════════════════════════════════════════════════════════════════
  //  PUBLIC API
  // ════════════════════════════════════════════════════════════════
  return {
    init,
    showWelcomeModal,
    reopenWizard,
    markJobViewed,
    markStepComplete: _markChecklistItem,
    setTier: (t) => { _tier = t || 'free'; },
  };

})();

/* ── Self-initialize ────────────────────────────────────────────────
   app.js runs before this file and sets `userId` / `userTier` as
   globals synchronously from sessionStorage at its very top.
   We can therefore read them directly here — no async needed.
   If loadUserTier() later resolves a Pro tier, app.js calls setTier.
─────────────────────────────────────────────────────────────────── */
(function () {
  const uid  = (typeof fbUid    !== 'undefined') ? fbUid    : (sessionStorage.getItem('fbUid') || sessionStorage.getItem('fbEmail'));
  const tier = (typeof userTier !== 'undefined') ? userTier : 'free';
  if (uid) {
    OnboardingEngine.init(uid, tier);
  }
}());
