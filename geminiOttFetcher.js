const fetch = require("node-fetch");

// ---------------------------------------------------------------------------
// Gemini-powered "Weekly OTT Releases (India)" fetcher.
//
// Uses Google's free-tier Gemini API (with Search grounding) instead of
// Claude, since Claude API credits were burning fast — largely because this
// module was firing on every Render redeploy/restart, not just once a day.
//
// Two safeguards keep this reliable and cheap:
//   1. TMDB verification: every title Gemini reports is cross-checked
//      against TMDB (title + rough date match) before it's allowed into the
//      catalog. Anything Gemini claims that TMDB can't corroborate is
//      dropped rather than trusted blindly. This is what fixes hallucination
//      regardless of which LLM is used.
//   2. Once-per-day gating: a timestamp is kept in memory so redeploys/
//      restarts within the same day do NOT trigger a fresh Gemini call.
//      Render free tier spins down on inactivity, so without this, every
//      wake-up was burning a call.
// ---------------------------------------------------------------------------

const GEMINI_KEY = process.env.GEMINI_API_KEY;
const TMDB_KEY = process.env.TMDB_API_KEY;
const GEMINI_MODEL = "gemini-flash-latest"; // alias auto-points to current Flash model, avoiding version-pinned 404s
const REGION = "IN";

const PLATFORMS = [
  "Netflix", "Amazon Prime Video", "JioHotstar", "ZEE5", "Sun NXT", "SonyLIV", "Aha Video",
];

let lastFetchDateStr = null; // e.g. "2026-07-13" — guards against redeploy-triggered re-fetches

function tmdbUrl(path, params = {}) {
  const qs = new URLSearchParams({ api_key: TMDB_KEY, ...params }).toString();
  return `https://api.themoviedb.org/3/${path}?${qs}`;
}

// ---------------------------------------------------------------------------
// Step 1: Ask Gemini, with Google Search grounding, for this week's releases.
// ---------------------------------------------------------------------------
async function fetchGeminiCandidates() {
  const today = new Date().toISOString().split("T")[0];
  const prompt = `Search the web for movies and TV series/shows that released on OTT streaming platforms in India (${PLATFORMS.join(
    ", "
  )}) in the last 7 days (today is ${today}).

Rules:
- Only include a title if a search result explicitly confirms it released on one of these platforms within the last 7 days.
- If you are not certain of the platform or the release date from an actual search result, OMIT the title entirely. Do not guess, estimate, or fill in plausible-sounding entries.
- It is fine to return fewer than 10 results, or zero, if that's what the evidence supports.
- Include both Tamil/regional-language titles and pan-India/Hollywood titles that released in India this week.

Your entire response must be a single JSON array and nothing else. Do not write any sentence before or after it — no "here is the list", no explanation, no notes. The first character of your response must be [ and the last character must be ]. Shape:
[{"title": "...", "platform": "...", "release_date": "YYYY-MM-DD", "media_type": "movie|tv", "source_url": "..."}]

If nothing can be verified, respond with exactly: []`;

  const url = `https://generativelanguage.googleapis.com/v1beta/models/${GEMINI_MODEL}:generateContent?key=${GEMINI_KEY}`;

  const response = await fetch(url, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      contents: [{ parts: [{ text: prompt }] }],
      tools: [{ google_search: {} }],
      generationConfig: { temperature: 0.1 },
    }),
  });

  const data = await response.json();

  if (data.error) {
    console.error("Gemini OTT fetch error:", data.error);
    return [];
  }

  const candidate = data.candidates && data.candidates[0];
  const textBlocks = candidate && candidate.content && candidate.content.parts
    ? candidate.content.parts.map((p) => p.text || "").join("\n")
    : "";

  const cleaned = textBlocks.replace(/```json|```/g, "").trim();

  // Gemini, like Claude, sometimes prefaces the array with a sentence
  // despite instructions. Extract the first top-level [...] array rather
  // than assuming the whole response body is clean JSON.
  const arrayMatch = cleaned.match(/\[[\s\S]*\]/);
  const jsonSlice = arrayMatch ? arrayMatch[0] : cleaned;

  try {
    const parsed = JSON.parse(jsonSlice);
    return Array.isArray(parsed) ? parsed : [];
  } catch (e) {
    console.error("Gemini OTT fetch: failed to parse JSON response:", e.message, "\nRaw:", cleaned.slice(0, 500));
    return [];
  }
}

// ---------------------------------------------------------------------------
// Step 2: Verify each Gemini-reported candidate against TMDB.
// A candidate only survives if TMDB has a matching title with a release/
// air date within a loose window of what Gemini claimed (+/- 21 days, to
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
        `  ⚠️ Rejected "${candidate.title}": TMDB date too far from Gemini's claimed date (${bestDiffDays.toFixed(
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
// Gated to run at most once per calendar day, regardless of how many times
// the process restarts/redeploys within that day.
// ---------------------------------------------------------------------------
async function fetchWeeklyOttReleases(previousList = []) {
  const todayStr = new Date().toISOString().split("T")[0];

  if (lastFetchDateStr === todayStr) {
    console.log(`  ⏭️  Weekly OTT releases already fetched today (${todayStr}) — skipping Gemini call, keeping existing list.`);
    return previousList;
  }

  if (!GEMINI_KEY) {
    console.warn("⚠️ GEMINI_API_KEY not set — skipping weekly OTT releases fetch.");
    return previousList;
  }

  console.log("🔎 Fetching weekly OTT releases via Gemini + Google Search...");
  const candidates = await fetchGeminiCandidates();
  console.log(`  Gemini returned ${candidates.length} candidate(s) before verification.`);

  const verified = [];
  for (const candidate of candidates) {
    if (!candidate || !candidate.title) continue;
    const match = await verifyAgainstTmdb(candidate);
    if (!match) continue;
    const meta = await toMeta(match);
    if (meta) verified.push(meta);
  }

  console.log(`  ✅ ${verified.length} of ${candidates.length} candidate(s) verified against TMDB and kept.`);

  // Only mark today as "done" once the call actually completed — this
  // prevents redeploy-spam while still allowing tomorrow's fetch normally.
  lastFetchDateStr = todayStr;

  return verified;
}

module.exports = { fetchWeeklyOttReleases };
