const fetch = require("node-fetch");

// ---------------------------------------------------------------------------
// Claude-powered "Weekly OTT Releases (India)" fetcher.
//
// Replaces the previous Gemini-based fetcher. Gemini's Search-grounded output
// was hallucinating titles/platforms/dates that didn't check out. This module
// instead:
//   1. Asks Claude (web_search tool enabled) to report ONLY titles it can
//      directly cite from a search result, in strict JSON.
//   2. Cross-checks every returned title against TMDB (title + rough date
//      match) before it's allowed into the catalog. Anything Claude claims
//      that TMDB can't corroborate is dropped rather than trusted blindly.
//
// This keeps two independently-unreliable sources checking each other,
// rather than trusting either one's output verbatim.
// ---------------------------------------------------------------------------

const ANTHROPIC_KEY = process.env.ANTHROPIC_API_KEY;
const TMDB_KEY = process.env.TMDB_API_KEY;
const CLAUDE_MODEL = "claude-sonnet-4-6";
const REGION = "IN";

const PLATFORMS = [
  "Netflix", "Amazon Prime Video", "JioHotstar", "ZEE5", "Sun NXT", "SonyLIV", "Aha Video",
];

function tmdbUrl(path, params = {}) {
  const qs = new URLSearchParams({ api_key: TMDB_KEY, ...params }).toString();
  return `https://api.themoviedb.org/3/${path}?${qs}`;
}

// ---------------------------------------------------------------------------
// Step 1: Ask Claude, with web_search, for this week's releases.
// ---------------------------------------------------------------------------
async function fetchClaudeCandidates() {
  const today = new Date().toISOString().split("T")[0];
  const prompt = `Search the web for movies and TV series/shows that released on OTT streaming platforms in India (${PLATFORMS.join(
    ", "
  )}) in the last 7 days (today is ${today}).

Rules:
- Only include a title if a search result explicitly confirms it released on one of these platforms within the last 7 days.
- If you are not certain of the platform or the release date from an actual search result, OMIT the title entirely. Do not guess, estimate, or fill in plausible-sounding entries.
- It is fine to return fewer than 10 results, or zero, if that's what the evidence supports.
- Include both Tamil/regional-language titles and pan-India/Hollywood titles that released in India this week.

Respond with ONLY a JSON array, no markdown fences, no commentary, in this exact shape:
[{"title": "...", "platform": "...", "release_date": "YYYY-MM-DD", "media_type": "movie|tv", "source_url": "..."}]

If nothing can be verified, respond with exactly: []`;

  const response = await fetch("https://api.anthropic.com/v1/messages", {
    method: "POST",
    headers: {
      "x-api-key": ANTHROPIC_KEY,
      "anthropic-version": "2023-06-01",
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      model: CLAUDE_MODEL,
      max_tokens: 2000,
      messages: [{ role: "user", content: prompt }],
      tools: [{ type: "web_search_20250305", name: "web_search" }],
    }),
  });

  const data = await response.json();

  if (data.error) {
    console.error("Claude OTT fetch error:", data.error);
    return [];
  }

  const textBlocks = (data.content || [])
    .filter((b) => b.type === "text")
    .map((b) => b.text)
    .join("\n");

  const cleaned = textBlocks.replace(/```json|```/g, "").trim();

  try {
    const parsed = JSON.parse(cleaned);
    return Array.isArray(parsed) ? parsed : [];
  } catch (e) {
    console.error("Claude OTT fetch: failed to parse JSON response:", e.message, "\nRaw:", cleaned.slice(0, 500));
    return [];
  }
}

// ---------------------------------------------------------------------------
// Step 2: Verify each Claude-reported candidate against TMDB.
// A candidate only survives if TMDB has a matching title with a release/
// air date within a loose window of what Claude claimed (+/- 21 days, to
// allow for regional release-date discrepancies without accepting wildly
// wrong claims).
// ---------------------------------------------------------------------------
async function verifyAgainstTmdb(candidate) {
  const mediaType = candidate.media_type === "tv" ? "tv" : "movie";
  const searchPath = mediaType === "tv" ? "search/tv" : "search/movie";

  try {
    const res = await fetch(tmdbUrl(searchPath, { query: candidate.title, region: REGION }));
    const data = await res.json();
    const results = data.results || [];
    if (results.length === 0) return null;

    const claimedDate = new Date(candidate.release_date);
    const claimedValid = !isNaN(claimedDate.getTime());

    let best = null;
    let bestDiffDays = Infinity;

    for (const r of results) {
      const dateStr = mediaType === "tv" ? r.first_air_date : r.release_date;
      if (!dateStr) continue;
      const rDate = new Date(dateStr);
      if (isNaN(rDate.getTime())) continue;

      if (!claimedValid) {
        // No usable claimed date to compare against; accept the top TMDB match.
        best = r;
        break;
      }

      const diffDays = Math.abs((rDate - claimedDate) / (1000 * 60 * 60 * 24));
      if (diffDays < bestDiffDays) {
        bestDiffDays = diffDays;
        best = r;
      }
    }

    if (!best) return null;
    if (claimedValid && bestDiffDays > 21) {
      console.warn(
        `  ⚠️ Rejected "${candidate.title}": TMDB date too far from Claude's claimed date (${bestDiffDays.toFixed(
          0
        )} days off)`
      );
      return null;
    }

    return { tmdbItem: best, mediaType, candidate };
  } catch (e) {
    console.error(`TMDB verification failed for "${candidate.title}":`, e.message);
    return null;
  }
}

// ---------------------------------------------------------------------------
// Step 3: Convert a verified TMDB item into the addon's standard meta shape.
// Mirrors convertToPlayable() in index.js so the shape is identical.
// ---------------------------------------------------------------------------
async function toMeta({ tmdbItem, mediaType, candidate }) {
  try {
    const ids = await fetch(tmdbUrl(`${mediaType}/${tmdbItem.id}/external_ids`)).then((r) => r.json());
    const date = mediaType === "movie" ? tmdbItem.release_date : tmdbItem.first_air_date;
    const year = date ? date.slice(0, 4) : "";
    const baseName = tmdbItem.title || tmdbItem.name;

    const posterUrl = ids.imdb_id
      ? `https://btttr.cc/poster-q/imdb/poster-default/${ids.imdb_id}.jpg`
      : tmdbItem.poster_path
      ? `https://image.tmdb.org/t/p/w500${tmdbItem.poster_path}`
      : null;

    return {
      id: ids.imdb_id || `tmdb:${mediaType}:${tmdbItem.id}`,
      name: `${baseName} 🆕 [${candidate.platform || "OTT"}]`,
      type: mediaType === "movie" ? "movie" : "series",
      poster: posterUrl,
      releaseInfo: year,
      released: date ? new Date(date).toISOString() : undefined,
      imdbRating: tmdbItem.vote_average && tmdbItem.vote_average > 0 ? tmdbItem.vote_average.toFixed(1) : undefined,
      description: `📱 ${candidate.platform || "OTT"} • ${tmdbItem.overview || `Released: ${date || "N/A"}`}`,
    };
  } catch (e) {
    return null;
  }
}

// ---------------------------------------------------------------------------
// Public entry point: returns a verified, ready-to-serve meta array.
// ---------------------------------------------------------------------------
async function fetchWeeklyOttReleases() {
  if (!ANTHROPIC_KEY) {
    console.warn("⚠️ ANTHROPIC_API_KEY not set — skipping weekly OTT releases fetch.");
    return [];
  }

  console.log("🔎 Fetching weekly OTT releases via Claude + web_search...");
  const candidates = await fetchClaudeCandidates();
  console.log(`  Claude returned ${candidates.length} candidate(s) before verification.`);

  const verified = [];
  for (const candidate of candidates) {
    if (!candidate || !candidate.title) continue;
    const match = await verifyAgainstTmdb(candidate);
    if (!match) continue;
    const meta = await toMeta(match);
    if (meta) verified.push(meta);
  }

  console.log(`  ✅ ${verified.length} of ${candidates.length} candidate(s) verified against TMDB and kept.`);
  return verified;
}

module.exports = { fetchWeeklyOttReleases };
