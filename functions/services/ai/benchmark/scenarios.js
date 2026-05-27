/**
 * Benchmark test scenarios.
 *
 * Covers realistic job search configurations that stress-test:
 *  - URL accuracy (niche roles, common roles)
 *  - ATS detection (Greenhouse, Lever, Ashby, Workday)
 *  - Location handling (remote-only, city-based, hybrid)
 *  - Duplicate detection
 *  - Salary filtering
 */

const SCENARIOS = [
  {
    id:   "swe-remote-senior",
    name: "Senior SWE — Remote (high competition)",
    prefs: {
      jobTitle:       "Senior Software Engineer",
      remoteOnly:     true,
      experienceLevel: "Senior",
      salaryMin:       "150000",
      industries:     "Technology",
    },
    expectedMinResults: 2,
    expectedMaxDuplicates: 0,
    notes: "High-competition query; common ATS boards. Tests dedup and URL precision.",
  },
  {
    id:   "pm-sf-mid",
    name: "Product Manager — San Francisco",
    prefs: {
      jobTitle:       "Product Manager",
      locationCity:   "San Francisco",
      locationRadius: "25 miles",
      experienceLevel: "Mid",
    },
    expectedMinResults: 2,
    expectedMaxDuplicates: 0,
    notes: "City-based search; high Greenhouse/Lever density. Tests ATS slug detection.",
  },
  {
    id:   "ds-nyc-entry",
    name: "Data Scientist — New York City (Entry Level)",
    prefs: {
      jobTitle:       "Data Scientist",
      locationCity:   "New York",
      locationRadius: "20 miles",
      experienceLevel: "Entry",
    },
    expectedMinResults: 1,
    expectedMaxDuplicates: 1,
    notes: "Entry-level niche; tests seniority filtering so Senior DS are rejected.",
  },
  {
    id:   "ml-engineer-remote-niche",
    name: "ML Engineer — Remote (niche)",
    prefs: {
      jobTitle:       "Machine Learning Engineer",
      remoteOnly:     true,
      experienceLevel: "Mid",
      salaryMin:       "140000",
    },
    expectedMinResults: 2,
    expectedMaxDuplicates: 0,
    notes: "Niche role; tests URL accuracy on Ashby/Wellfound heavy boards.",
  },
  {
    id:   "frontend-seattle-senior",
    name: "Senior Frontend Engineer — Seattle",
    prefs: {
      jobTitle:       "Senior Frontend Engineer",
      locationCity:   "Seattle",
      locationRadius: "30 miles",
      experienceLevel: "Senior",
    },
    expectedMinResults: 2,
    expectedMaxDuplicates: 0,
    notes: "Mixed ATS landscape; tests title matching (should NOT return backend engineer).",
  },
  {
    id:   "devops-remote",
    name: "DevOps Engineer — Remote",
    prefs: {
      jobTitle:       "DevOps Engineer",
      remoteOnly:     true,
      experienceLevel: "Mid",
    },
    expectedMinResults: 2,
    expectedMaxDuplicates: 1,
    notes: "Tests SRE/Platform disambiguation — should only return DevOps, not SRE.",
  },
];

module.exports = { SCENARIOS };
