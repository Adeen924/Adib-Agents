/**
 * CareerCopilot — LinkedIn Parser Utility
 * Parses visible DOM content only. No mutations, no auto-scroll.
 */

// ─── Page type detection ──────────────────────────────────────────────────────
function detectPageType() {
  const url = window.location.pathname;
  if (/^\/in\/[^/]+\/?$/.test(url)) return "profile";
  if (/\/company\/[^/]+\/people/.test(url)) return "company_people";
  if (/\/search\/results\/people/.test(url)) return "search_results";
  return "other";
}

// ─── Recruiter confidence ─────────────────────────────────────────────────────
function detectRecruiterConfidence(title) {
  if (!title) return 0;
  const t = title.toLowerCase();

  const highSignals = [
    "recruiter",
    "talent acquisition",
    "talent partner",
    " hr ",
    "human resources",
    "sourcer",
    "staffing",
  ];
  const midSignals = ["hiring", "head of people"];

  if (highSignals.some((s) => t.includes(s))) return 0.85;
  if (midSignals.some((s) => t.includes(s))) return 0.6;
  return 0;
}

// ─── Seniority detection ──────────────────────────────────────────────────────
function detectSeniority(title) {
  if (!title) return "unknown";
  const t = title.toLowerCase();

  const execKeywords = [
    "vp",
    "vice president",
    "ceo",
    "cto",
    "coo",
    "cmo",
    "cpo",
    "chief",
    "president",
    "founder",
    "partner",
  ];
  const seniorKeywords = [
    "director",
    "principal",
    "staff",
    "lead",
    "head of",
    "manager",
  ];
  const midKeywords = ["senior"];
  const entryKeywords = [
    "engineer",
    "analyst",
    "coordinator",
    "associate",
    "intern",
  ];

  if (execKeywords.some((k) => t.includes(k))) return "executive";
  if (seniorKeywords.some((k) => t.includes(k))) return "senior";
  if (midKeywords.some((k) => t.includes(k))) return "mid";
  if (entryKeywords.some((k) => t.includes(k))) return "entry";
  return "unknown";
}

// ─── Extract company from title string ───────────────────────────────────────
function extractCompanyFromTitle(title) {
  if (!title) return null;
  // Common patterns: "Engineer at Acme", "PM @ Google", "Director, Meta"
  const atPattern = /\s+(?:at|@)\s+(.+)$/i;
  const commaPattern = /,\s*(.+)$/;

  const atMatch = title.match(atPattern);
  if (atMatch) return atMatch[1].trim();

  const commaMatch = title.match(commaPattern);
  if (commaMatch) return commaMatch[1].trim();

  return null;
}

// ─── Extract shared signals ───────────────────────────────────────────────────
function extractSharedSignals() {
  const signals = [];

  // LinkedIn "You both know..." or "X mutual connections" cards
  const sharedSection = document.querySelector(
    '[data-control-name="mutual_connections"], .pv-highlights-section, .pv-shared-experiences'
  );

  if (sharedSection) {
    const items = sharedSection.querySelectorAll("li, .pv-entity__summary-info");
    items.forEach((item) => {
      const text = item.textContent?.trim();
      if (text && text.length > 2 && text.length < 100) {
        signals.push(text);
      }
    });
  }

  // Also check for "Shared" section text blocks
  document
    .querySelectorAll(
      ".pv-shared-experiences__section-title, [aria-label*='shared'], [aria-label*='mutual']"
    )
    .forEach((el) => {
      const text = el.textContent?.trim();
      if (text && !signals.includes(text)) signals.push(text);
    });

  return signals.slice(0, 10); // cap at 10
}

// ─── Parse mutual connections count ──────────────────────────────────────────
function parseMutualConnections() {
  const selectors = [
    ".dist-value",
    "[data-control-name='mutual_connections'] span",
    ".pv-mutual-member-list-summary__text",
  ];

  for (const sel of selectors) {
    const el = document.querySelector(sel);
    if (el) {
      const match = el.textContent?.match(/(\d+)/);
      if (match) return parseInt(match[1], 10);
    }
  }
  return 0;
}

// ─── Clean text helper ─────────────────────────────────────────────────────────
function cleanText(text) {
  return text?.replace(/\s+/g, " ").trim() || "";
}

// ─── Try multiple selectors ───────────────────────────────────────────────────
function queryFirst(selectors) {
  for (const sel of selectors) {
    const el = document.querySelector(sel);
    if (el) return el;
  }
  return null;
}

// ─── Profile page parser ──────────────────────────────────────────────────────
function parseProfilePage() {
  const nameEl = queryFirst([
    ".text-heading-xlarge",
    "h1.inline",
    "h1[class*='text-heading']",
    ".pv-text-details__left-panel h1",
  ]);
  const name = cleanText(nameEl?.textContent);
  if (!name) return null;

  const headlineEl = queryFirst([
    ".text-body-medium.break-words",
    ".ph5 .text-body-medium",
    ".pv-text-details__left-panel .text-body-medium",
    "[data-generated-suggestion-target='urn:li:fsd_profileHeadline']",
  ]);
  const headline = cleanText(headlineEl?.textContent);

  // Current position from experience section
  let company = "";
  let title = headline;

  const expItems = document.querySelectorAll(
    ".experience-item, section[data-section='experience'] li, #experience li"
  );

  if (expItems.length > 0) {
    // First item is typically the most recent role
    const firstExp = expItems[0];
    const roleEl = firstExp.querySelector(
      ".mr1.t-bold span, .pv-entity__secondary-title, [class*='title'] span[aria-hidden='true']"
    );
    const companyEl = firstExp.querySelector(
      ".pv-entity__secondary-title, .t-14.t-normal span[aria-hidden='true'], [class*='company'] span"
    );

    if (roleEl) title = cleanText(roleEl.textContent) || title;
    if (companyEl) company = cleanText(companyEl.textContent);
  }

  // Fallback: extract company from headline
  if (!company) {
    company = extractCompanyFromTitle(headline) || "";
  }

  // LinkedIn URL
  const linkedinUrl =
    "https://www.linkedin.com" +
    window.location.pathname.replace(/\/$/, "");

  const mutualConnections = parseMutualConnections();
  const sharedSignals = extractSharedSignals();
  const recruiterConfidence = detectRecruiterConfidence(title || headline);

  return {
    person: name,
    title: title || headline || "",
    company,
    linkedinUrl,
    recruiterConfidence,
    sharedSignals,
    mutualConnections,
    source: "linkedin_extension",
    pageType: "profile",
  };
}

// ─── Company people page parser ───────────────────────────────────────────────
function parseCompanyPeoplePage() {
  const connections = [];

  const cards = document.querySelectorAll(
    '[data-view-name="profile-component-entity"], .org-people-profile-card, .ember-view.org-people-profile-card'
  );

  cards.forEach((card) => {
    const nameEl = card.querySelector(
      ".org-people-profile-card__profile-title, .artdeco-entity-lockup__title, span[aria-hidden='true']"
    );
    const titleEl = card.querySelector(
      ".lt-line-clamp__line, .artdeco-entity-lockup__subtitle, [class*='subtitle']"
    );
    const linkEl = card.querySelector("a[href*='/in/']");

    const name = cleanText(nameEl?.textContent);
    if (!name || name === "LinkedIn Member") return;

    const personTitle = cleanText(titleEl?.textContent);
    const linkedinUrl = linkEl
      ? "https://www.linkedin.com" +
        new URL(linkEl.href).pathname.replace(/\/$/, "")
      : "";

    const company = extractCompanyFromTitle(personTitle) || "";
    const recruiterConfidence = detectRecruiterConfidence(personTitle);

    connections.push({
      person: name,
      title: personTitle || "",
      company,
      linkedinUrl,
      recruiterConfidence,
      sharedSignals: [],
      mutualConnections: 0,
      source: "linkedin_extension",
      pageType: "company_people",
    });
  });

  return connections;
}

// ─── Search results page parser ───────────────────────────────────────────────
function parseSearchResultsPage() {
  const connections = [];

  const resultItems = document.querySelectorAll(
    ".entity-result__item, li.reusable-search__result-container, .search-results-container li"
  );

  resultItems.forEach((item) => {
    const nameEl = item.querySelector(
      ".entity-result__title-text a span[aria-hidden='true'], .app-aware-link span[aria-hidden='true'], .entity-result__title-line a span"
    );
    const titleEl = item.querySelector(
      ".entity-result__primary-subtitle, .entity-result__secondary-subtitle"
    );
    const companyEl = item.querySelector(
      ".entity-result__secondary-subtitle"
    );
    const linkEl = item.querySelector("a[href*='/in/']");
    const mutualEl = item.querySelector(
      ".entity-result__simple-insight-text, [class*='mutual']"
    );

    const name = cleanText(nameEl?.textContent);
    if (!name || name === "LinkedIn Member") return;

    const personTitle = cleanText(titleEl?.textContent);
    const personCompany = cleanText(companyEl?.textContent) || extractCompanyFromTitle(personTitle) || "";

    const linkedinUrl = linkEl
      ? (() => {
          try {
            return (
              "https://www.linkedin.com" +
              new URL(linkEl.href).pathname.replace(/\/$/, "")
            );
          } catch (_) {
            return linkEl.href || "";
          }
        })()
      : "";

    let mutualConnections = 0;
    if (mutualEl) {
      const match = mutualEl.textContent?.match(/(\d+)/);
      if (match) mutualConnections = parseInt(match[1], 10);
    }

    const recruiterConfidence = detectRecruiterConfidence(personTitle);

    connections.push({
      person: name,
      title: personTitle || "",
      company: personCompany,
      linkedinUrl,
      recruiterConfidence,
      sharedSignals: [],
      mutualConnections,
      source: "linkedin_extension",
      pageType: "search_results",
    });
  });

  return connections;
}

// ─── Main entry point ─────────────────────────────────────────────────────────
function parseCurrentPage() {
  const pageType = detectPageType();

  let connections = [];

  switch (pageType) {
    case "profile": {
      const conn = parseProfilePage();
      if (conn) connections = [conn];
      break;
    }
    case "company_people":
      connections = parseCompanyPeoplePage();
      break;
    case "search_results":
      connections = parseSearchResultsPage();
      break;
    default:
      connections = [];
  }

  // Deduplicate by linkedinUrl
  const seen = new Set();
  connections = connections.filter((c) => {
    if (!c.linkedinUrl) return true;
    if (seen.has(c.linkedinUrl)) return false;
    seen.add(c.linkedinUrl);
    return true;
  });

  return { pageType, connections };
}

// Export for both module and global usage
if (typeof module !== "undefined" && module.exports) {
  module.exports = {
    parseCurrentPage,
    parseProfilePage,
    parseCompanyPeoplePage,
    parseSearchResultsPage,
    detectRecruiterConfidence,
    detectSeniority,
    extractCompanyFromTitle,
    extractSharedSignals,
    detectPageType,
  };
} else {
  // Make available as global in content script context
  window.LinkedInParser = {
    parseCurrentPage,
    parseProfilePage,
    parseCompanyPeoplePage,
    parseSearchResultsPage,
    detectRecruiterConfidence,
    detectSeniority,
    extractCompanyFromTitle,
    extractSharedSignals,
    detectPageType,
  };
}
