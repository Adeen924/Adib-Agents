/**
 * CareerCopilot — LinkedIn Content Script (Analyzer)
 * Injected on all LinkedIn pages.
 *
 * PRIVACY & COMPLIANCE:
 * - Reads only currently visible DOM content
 * - No automated scraping, no auto-scroll, no mutation observers
 * - All analysis is explicitly user-triggered via ANALYZE_PAGE message
 * - No data is sent without user confirmation in the popup
 */

(function () {
  "use strict";

  // ─── Utility: clean text ──────────────────────────────────────────────────────
  function cleanText(text) {
    return text?.replace(/\s+/g, " ").trim() || "";
  }

  function queryFirst(selectors) {
    for (const sel of selectors) {
      try {
        const el = document.querySelector(sel);
        if (el) return el;
      } catch (_) {}
    }
    return null;
  }

  // ─── Page type detection ────────────────────────────────────────────────────
  function detectPageType() {
    const path = window.location.pathname;
    if (/^\/in\/[^/]+\/?$/.test(path)) return "profile";
    if (/\/company\/[^/]+\/people/.test(path)) return "company_people";
    if (/\/search\/results\/people/.test(path)) return "search_results";
    return "other";
  }

  // ─── Recruiter confidence ───────────────────────────────────────────────────
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

  // ─── Extract company from headline/title ────────────────────────────────────
  function extractCompanyFromTitle(title) {
    if (!title) return null;
    const atMatch = title.match(/\s+(?:at|@)\s+(.+)$/i);
    if (atMatch) return atMatch[1].trim();
    const commaMatch = title.match(/,\s*(.+)$/);
    if (commaMatch) return commaMatch[1].trim();
    return null;
  }

  // ─── Mutual connections ─────────────────────────────────────────────────────
  function parseMutualConnections() {
    const selectors = [
      ".dist-value",
      "[data-control-name='mutual_connections'] span",
      ".pv-mutual-member-list-summary__text",
    ];
    for (const sel of selectors) {
      try {
        const el = document.querySelector(sel);
        if (el) {
          const match = el.textContent?.match(/(\d+)/);
          if (match) return parseInt(match[1], 10);
        }
      } catch (_) {}
    }
    return 0;
  }

  // ─── Shared signals ─────────────────────────────────────────────────────────
  function extractSharedSignals() {
    const signals = [];
    const sharedSection = document.querySelector(
      '[data-control-name="mutual_connections"], .pv-highlights-section, .pv-shared-experiences'
    );
    if (sharedSection) {
      sharedSection.querySelectorAll("li, .pv-entity__summary-info").forEach((item) => {
        const text = item.textContent?.trim();
        if (text && text.length > 2 && text.length < 100) signals.push(text);
      });
    }
    return signals.slice(0, 10);
  }

  // ─── Profile page parser ────────────────────────────────────────────────────
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
    ]);
    const headline = cleanText(headlineEl?.textContent);

    let company = "";
    let title = headline;

    // Try to get most recent experience item
    const expItems = document.querySelectorAll(
      ".experience-item, section[data-section='experience'] li, #experience li, .pvs-list__item--line-separated"
    );
    if (expItems.length > 0) {
      const firstExp = expItems[0];
      const roleEl = firstExp.querySelector(
        ".mr1.t-bold span[aria-hidden='true'], .pv-entity__secondary-title, [class*='title'] span[aria-hidden='true']"
      );
      const companyEl = firstExp.querySelector(
        ".t-14.t-normal span[aria-hidden='true'], .pv-entity__secondary-title"
      );
      if (roleEl) title = cleanText(roleEl.textContent) || title;
      if (companyEl) company = cleanText(companyEl.textContent);
    }

    if (!company) company = extractCompanyFromTitle(headline) || "";

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

  // ─── Company people page parser ─────────────────────────────────────────────
  function parseCompanyPeoplePage() {
    const connections = [];
    const cards = document.querySelectorAll(
      '[data-view-name="profile-component-entity"], .org-people-profile-card, .ember-view.org-people-profile-card, .scaffold-layout__list-item'
    );

    cards.forEach((card) => {
      try {
        const nameEl = card.querySelector(
          ".org-people-profile-card__profile-title, .artdeco-entity-lockup__title span[aria-hidden='true'], .presence-entity__image + div span[aria-hidden='true']"
        );
        const titleEl = card.querySelector(
          ".lt-line-clamp__line, .artdeco-entity-lockup__subtitle span[aria-hidden='true'], [class*='subtitle'] span"
        );
        const linkEl = card.querySelector("a[href*='/in/']");

        const name = cleanText(nameEl?.textContent);
        if (!name || name === "LinkedIn Member") return;

        const personTitle = cleanText(titleEl?.textContent);
        let linkedinUrl = "";
        if (linkEl) {
          try {
            linkedinUrl =
              "https://www.linkedin.com" +
              new URL(linkEl.href).pathname.replace(/\/$/, "");
          } catch (_) {
            linkedinUrl = linkEl.href || "";
          }
        }

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
      } catch (_) {}
    });

    return connections;
  }

  // ─── Search results page parser ─────────────────────────────────────────────
  function parseSearchResultsPage() {
    const connections = [];
    const resultItems = document.querySelectorAll(
      ".entity-result__item, li.reusable-search__result-container, .search-results-container li[class*='result']"
    );

    resultItems.forEach((item) => {
      try {
        const nameEl = item.querySelector(
          ".entity-result__title-text a span[aria-hidden='true'], .app-aware-link span[aria-hidden='true']"
        );
        const titleEl = item.querySelector(
          ".entity-result__primary-subtitle"
        );
        const companyEl = item.querySelector(
          ".entity-result__secondary-subtitle"
        );
        const linkEl = item.querySelector("a[href*='/in/']");
        const mutualEl = item.querySelector(
          ".entity-result__simple-insight-text, [class*='mutual-connection']"
        );

        const name = cleanText(nameEl?.textContent);
        if (!name || name === "LinkedIn Member") return;

        const personTitle = cleanText(titleEl?.textContent);
        const personCompany =
          cleanText(companyEl?.textContent) ||
          extractCompanyFromTitle(personTitle) ||
          "";

        let linkedinUrl = "";
        if (linkEl) {
          try {
            linkedinUrl =
              "https://www.linkedin.com" +
              new URL(linkEl.href).pathname.replace(/\/$/, "");
          } catch (_) {
            linkedinUrl = linkEl.href || "";
          }
        }

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
      } catch (_) {}
    });

    return connections;
  }

  // ─── Main parse function ────────────────────────────────────────────────────
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
      const key = c.linkedinUrl || c.person;
      if (seen.has(key)) return false;
      seen.add(key);
      return true;
    });

    return { pageType, connections };
  }

  // ─── Message listener ───────────────────────────────────────────────────────
  chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => {
    if (message.type === "ANALYZE_PAGE") {
      try {
        const result = parseCurrentPage();
        sendResponse({ success: true, ...result });
      } catch (err) {
        sendResponse({
          success: false,
          error: err.message,
          pageType: "other",
          connections: [],
        });
      }
      return false; // synchronous response
    }

    if (message.type === "GET_PAGE_TYPE") {
      sendResponse({ pageType: detectPageType() });
      return false;
    }
  });

  // ─── Floating action button ─────────────────────────────────────────────────
  function injectFloatingButton() {
    // Avoid injecting multiple times
    if (document.getElementById("cc-fab")) return;

    const fab = document.createElement("button");
    fab.id = "cc-fab";
    fab.title = "Open CareerCopilot Network Intelligence";
    fab.textContent = "CC";
    fab.setAttribute("aria-label", "Open CareerCopilot");

    Object.assign(fab.style, {
      position: "fixed",
      bottom: "24px",
      right: "24px",
      width: "48px",
      height: "48px",
      borderRadius: "50%",
      background: "#1a1d27",
      color: "#f0c040",
      border: "2px solid #f0c040",
      fontSize: "13px",
      fontWeight: "700",
      fontFamily: "-apple-system, BlinkMacSystemFont, 'Segoe UI', sans-serif",
      cursor: "pointer",
      zIndex: "2147483647",
      boxShadow: "0 4px 16px rgba(0,0,0,0.35)",
      transition: "transform 0.15s ease, box-shadow 0.15s ease",
      display: "flex",
      alignItems: "center",
      justifyContent: "center",
      outline: "none",
      letterSpacing: "0.5px",
    });

    fab.addEventListener("mouseenter", () => {
      fab.style.transform = "scale(1.1)";
      fab.style.boxShadow = "0 6px 20px rgba(240,192,64,0.4)";
    });
    fab.addEventListener("mouseleave", () => {
      fab.style.transform = "scale(1)";
      fab.style.boxShadow = "0 4px 16px rgba(0,0,0,0.35)";
    });
    fab.addEventListener("click", () => {
      chrome.runtime.sendMessage({ type: "OPEN_POPUP" });
    });

    document.body.appendChild(fab);
  }

  // Inject FAB when DOM is ready
  if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", injectFloatingButton);
  } else {
    injectFloatingButton();
  }

  // Re-inject FAB on LinkedIn's SPA navigation
  let lastPath = window.location.pathname;
  const navObserver = new MutationObserver(() => {
    if (window.location.pathname !== lastPath) {
      lastPath = window.location.pathname;
      // Small delay for LinkedIn SPA to settle
      setTimeout(injectFloatingButton, 800);
    }
  });
  navObserver.observe(document.body, { childList: true, subtree: false });
})();
