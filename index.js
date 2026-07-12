const express = require("express");
const fetch = require("node-fetch");
const { fetchWeeklyOttReleases } = require("./claudeOttFetcher");
const app = express();

// ---------------------------------------------------------------------------
// Configuration
// ---------------------------------------------------------------------------
const TMDB_KEY = process.env.TMDB_API_KEY;
const PORT = process.env.PORT || 10000;
const REGION = "IN";
const LANGUAGE_FILTER = "ta"; // Tamil
const SYNC_INTERVAL_MS = 12 * 60 * 60 * 1000;
const WEEKLY_SYNC_INTERVAL_MS = 24 * 60 * 60 * 1000; // Claude+search calls cost money — sync once/day

// Comprehensive target array including new premium digital channels.
// `label` is the display name used on stream buttons; `catalogName` is the
// display name used in the manifest catalog list — they differ slightly
// (e.g. "NETFLIX" vs "Netflix India Tamil") so both are kept explicit.
const TARGET_PROVIDERS = [
  { key: "jiohotstar", label: "JioHotstar", catalogName: "JioHotstar Tamil", matchNames: ["jiohotstar", "disney+ hotstar", "hotstar"], searchUrl: (q) => `https://www.hotstar.com/in/search?q=${encodeURIComponent(q)}` },
  { key: "zee5",       label: "ZEE5",       catalogName: "ZEE5 Tamil",       matchNames: ["zee5"], searchUrl: (q) => `https://www.zee5.com/search?q=${encodeURIComponent(q)}` },
  { key: "sunnxt",     label: "SUNNXT",     catalogName: "Sun NXT Tamil",    matchNames: ["sun nxt", "sunnxt"], searchUrl: (q) => `https://www.sunnxt.com/search/${encodeURIComponent(q)}` },
  { key: "netflix",    label: "NETFLIX",    catalogName: "Netflix India Tamil", matchNames: ["netflix"], searchUrl: (q) => `https://www.netflix.com/search?q=${encodeURIComponent(q)}` },
  { key: "primevideo", label: "Prime Video", catalogName: "Prime Video India Tamil", matchNames: ["amazon prime video", "amazon prime", "prime video"], searchUrl: (q) => `https://www.primevideo.com/search/ref=atv_sr_sug?phrase=${encodeURIComponent(q)}` },
  { key: "sonyliv",    label: "SonyLIV",    catalogName: "SonyLIV Tamil",    matchNames: ["sony liv", "sonyliv"], searchUrl: (q) => `https://www.sonyliv.com/search?q=${encodeURIComponent(q)}` },
  { key: "aha",        label: "AHA",        catalogName: "Aha Video Tamil",  matchNames: ["aha", "aha video"], searchUrl: (q) => `https://www.aha.video/search?q=${encodeURIComponent(q)}` },
];

// Single source of truth for every catalog row. The manifest, the in-memory
// store, and the /catalog route's lookup table are all derived from this one
// array instead of being three separately-maintained if-chains.
const CATALOGS = [
  { id: "tamil_cinema", type: "movie",  name: "🎬 Now In Cinemas",        listKey: "cinema" },
  { id: "weekly_ott",   type: "movie",  name: "🆕 This Week's OTT Releases (India)", listKey: "weeklyOtt" },
  { id: "pure_tamil_m", type: "movie",  name: "New Tamil Movies (Pure)",  listKey: "tMovies" },
  { id: "pure_tamil_s", type: "series", name: "New Tamil Series (Pure)",  listKey: "tSeries" },
  ...TARGET_PROVIDERS.map((p) => ({
    id: `ott_${p.key}`,
    type: "movie",
    name: `📱 ${p.catalogName}`,
    listKey: `${p.key}OTT`,
  })),
  { id: "ind_dub_m", type: "movie",  name: "New Indian Dubbed Movies",     listKey: "dMovies" },
  { id: "ind_dub_s", type: "series", name: "New Indian Dubbed Series",     listKey: "dSeries" },
  { id: "eng_dub_m", type: "movie",  name: "Hollywood Hits (Tamil Dub)",   listKey: "eMovies" },
  { id: "eng_dub_s", type: "series", name: "Hollywood Series (Tamil Dub)", listKey: "eSeries" },
];
const CATALOG_LOOKUP = new Map(CATALOGS.map((c) => [c.id, c.listKey]));

let providerIdCache = null;
// masterList keys are generated from CATALOGS so there's no risk of the
// store, the manifest, and the route lookup drifting out of sync.
let masterList = Object.fromEntries(CATALOGS.map((c) => [c.listKey, []]));

const delay = (ms) => new Promise((res) => setTimeout(res, ms));

// ---------------------------------------------------------------------------
// TMDB helpers
// ---------------------------------------------------------------------------
function tmdbUrl(path, params = {}) {
  const qs = new URLSearchParams({ api_key: TMDB_KEY, ...params }).toString();
  return `https://api.themoviedb.org/3/${path}?${qs}`;
}

async function fetchAllPages(baseUrl, pages = 2) {
  let results = [];
  for (let p = 1; p <= pages; p++) {
    try {
      const res = await fetch(`${baseUrl}&page=${p}`);
      const data = await res.json();
      if (data.results) results = results.concat(data.results);
    } catch (e) {
      console.error("Fetch error", e);
    }
  }
  return results;
}

async function fetchMultiLang(baseUrl, langs, pages = 2) {
  const resultsArrays = await Promise.all(
    langs.map((lang) => fetchAllPages(`${baseUrl}&with_original_language=${lang}`, pages))
  );
  const combined = resultsArrays.flat();
  return Array.from(new Map(combined.map((item) => [item.id, item])).values());
}

function matchProvider(providerName, target) {
  const n = providerName.toLowerCase();
  return target.matchNames.some((m) => n.includes(m));
}

async function resolveProviderIds() {
  if (providerIdCache) return providerIdCache;
  const result = { movie: {}, tv: {} };
  for (const mediaType of ["movie", "tv"]) {
    try {
      const data = await fetchAllPages(tmdbUrl(`watch/providers/${mediaType}`, { watch_region: REGION }), 1);
      for (const target of TARGET_PROVIDERS) {
        const found = (data || []).find((p) => matchProvider(p.provider_name, target));
        if (found) result[mediaType][target.key] = found.provider_id;
      }
    } catch (err) {
      console.error(`Failed resolving providers for ${mediaType}:`, err.message);
    }
  }
  providerIdCache = result;

  // Diagnostic: flag any provider we couldn't resolve a TMDB id for, so a
  // "missing" platform in a catalog can be traced back to provider-id
  // resolution (vs. just having sparse Tamil-tagged content on TMDB).
  for (const target of TARGET_PROVIDERS) {
    if (!result.movie[target.key] && !result.tv[target.key]) {
      console.warn(`⚠️ No TMDB provider id found for "${target.key}" (movie or tv) — check provider_name match.`);
    }
  }

  return result;
}

// ---------------------------------------------------------------------------
// Item conversion
// ---------------------------------------------------------------------------
async function convertToPlayable(item, type, isCinema = false) {
  try {
    const ids = await fetch(tmdbUrl(`${type}/${item.id}/external_ids`)).then((r) => r.json());

    const date = type === "movie" ? item.release_date : item.first_air_date;
    const year = date ? date.slice(0, 4) : "";
    const baseName = item.title || item.name;

    const posterUrl = ids.imdb_id
      ? `https://btttr.cc/poster-q/imdb/poster-default/${ids.imdb_id}.jpg`
      : item.poster_path
      ? `https://image.tmdb.org/t/p/w500${item.poster_path}`
      : null;

    const metaObj = {
      id: ids.imdb_id || `tmdb:${type}:${item.id}`,
      name: isCinema ? `${baseName} 🎬 [IN CINEMA]` : baseName,
      type: type === "movie" ? "movie" : "series",
      poster: posterUrl,
      releaseInfo: year,
      released: date ? new Date(date).toISOString() : undefined,
      imdbRating: item.vote_average && item.vote_average > 0 ? item.vote_average.toFixed(1) : undefined,
      description: item.overview || `📅 Release Date: ${date || "N/A"}`,
    };

    if (isCinema) metaObj.inTheaters = true;
    return metaObj;
  } catch (e) {
    return null;
  }
}

async function processItems(items, type, isCinema = false) {
  const list = [];
  for (const item of items) {
    const activeType = type === "mixed" ? item.media_type : type;
    const p = await convertToPlayable(item, activeType, isCinema);
    if (p) list.push(p);
    await delay(15);
  }
  return list;
}

// ---------------------------------------------------------------------------
// Sync
// ---------------------------------------------------------------------------
async function updateDailyList() {
  const today = new Date().toISOString().split("T")[0];
  const startDate = "2025-01-01";
  const sixtyDaysAgo = new Date(Date.now() - 60 * 24 * 60 * 60 * 1000).toISOString().split("T")[0];

  const regionalLangs = ["hi", "te", "ml", "kn"];
  const cinemaLangs = ["ta", "hi", "te", "ml", "kn"];

  console.log(`🔄 Sync Started: ${today}`);

  try {
    const ids = await resolveProviderIds();

    // ----- Single-language categories (pure Tamil + Hollywood dub) -----
    const singleLangCategories = [
      { listKey: "tMovies", mediaType: "movie", lang: "ta", dateField: "primary_release_date", sortBy: "primary_release_date.desc", pages: 2 },
      { listKey: "tSeries", mediaType: "tv", lang: "ta", dateField: "first_air_date", sortBy: "first_air_date.desc", pages: 2 },
      { listKey: "eMovies", mediaType: "movie", lang: "en", dateField: "primary_release_date", sortBy: "popularity.desc", pages: 3 },
      { listKey: "eSeries", mediaType: "tv", lang: "en", dateField: "first_air_date", sortBy: "popularity.desc", pages: 3 },
    ];

    for (const cat of singleLangCategories) {
      const params = {
        sort_by: cat.sortBy,
        with_original_language: cat.lang,
        [`${cat.dateField}.gte`]: startDate,
        [`${cat.dateField}.lte`]: today,
      };
      if (cat.mediaType === "movie") params.region = REGION;

      const raw = await fetchAllPages(tmdbUrl(`discover/${cat.mediaType}`, params), cat.pages);
      masterList[cat.listKey] = await processItems(raw.slice(0, 50), cat.mediaType);
    }

    // ----- Multi-language regional dub categories + in-cinema -----
    const indMovieRaw = await fetchMultiLang(
      tmdbUrl("discover/movie", { region: REGION, with_release_type: 4, "primary_release_date.gte": startDate, "primary_release_date.lte": today }),
      regionalLangs,
      2
    );
    indMovieRaw.sort((a, b) => new Date(b.release_date || 0) - new Date(a.release_date || 0));
    masterList.dMovies = await processItems(indMovieRaw.slice(0, 50), "movie");

    const indSeriesRaw = await fetchMultiLang(
      tmdbUrl("discover/tv", { with_origin_country: "IN", "first_air_date.gte": startDate, "first_air_date.lte": today }),
      regionalLangs,
      2
    );
    indSeriesRaw.sort((a, b) => new Date(b.first_air_date || 0) - new Date(a.first_air_date || 0));
    masterList.dSeries = await processItems(indSeriesRaw.slice(0, 50), "tv");

    const cinemaRaw = await fetchMultiLang(
      tmdbUrl("discover/movie", { region: REGION, with_release_type: 3, "primary_release_date.gte": sixtyDaysAgo, "primary_release_date.lte": today }),
      cinemaLangs,
      2
    );
    const cinemaItems = cinemaRaw.filter((m) => m.poster_path).sort((a, b) => new Date(b.release_date || 0) - new Date(a.release_date || 0));
    masterList.cinema = await processItems(cinemaItems.slice(0, 40), "movie", true);

    // ----- OTT platforms: batch generation loop for all 7 premium local OTT platforms -----
    for (const provider of TARGET_PROVIDERS) {
      const pMovId = ids.movie[provider.key];
      const pTvId = ids.tv[provider.key];
      let combinedOtt = [];

      if (pMovId) {
        const ottMovies = await fetchAllPages(
          tmdbUrl("discover/movie", { watch_region: REGION, with_watch_providers: pMovId, with_original_language: LANGUAGE_FILTER, sort_by: "popularity.desc" }),
          2
        );
        combinedOtt = combinedOtt.concat(ottMovies.map((item) => ({ ...item, media_type: "movie" })));
      }
      if (pTvId) {
        const ottSeries = await fetchAllPages(
          tmdbUrl("discover/tv", { watch_region: REGION, with_watch_providers: pTvId, with_original_language: LANGUAGE_FILTER, sort_by: "popularity.desc" }),
          2
        );
        combinedOtt = combinedOtt.concat(ottSeries.map((item) => ({ ...item, media_type: "tv" })));
      }

      combinedOtt.sort((a, b) => (b.popularity || 0) - (a.popularity || 0));
      console.log(`  ${provider.key}: movieId=${pMovId || "none"} tvId=${pTvId || "none"} rawCount=${combinedOtt.length}`);
      masterList[`${provider.key}OTT`] = await processItems(combinedOtt.slice(0, 30), "mixed");
    }

    console.log(`✅ Update Successful! ${new Date().toLocaleTimeString()}`);
  } catch (e) {
    console.error("Sync failed", e);
  }
}

// Separate, slower-cadence sync for the Claude+web_search-backed weekly
// releases row. Kept independent from updateDailyList() so a failure here
// (e.g. missing ANTHROPIC_API_KEY, rate limit) never blocks the TMDB-only
// catalogs from updating.
async function updateWeeklyOttList() {
  try {
    masterList.weeklyOtt = await fetchWeeklyOttReleases();
  } catch (e) {
    console.error("Weekly OTT release sync failed:", e);
  }
}

updateDailyList();
updateWeeklyOttList();
setInterval(updateDailyList, SYNC_INTERVAL_MS);
setInterval(updateWeeklyOttList, WEEKLY_SYNC_INTERVAL_MS);

// ---------------------------------------------------------------------------
// Routes
// ---------------------------------------------------------------------------
app.get("/manifest.json", (req, res) => {
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Cache-Control", "max-age=0, no-cache, no-store, must-revalidate");
  res.json({
    id: "com.anandh.tamil.v8.cinema",
    version: "8.9.0",
    name: "Tamil Pro Max Ultra (v8)",
    description: "15 Rows - Ultimate Combined Cinema, Streaming Platforms, Weekly Releases & Television Index",
    resources: ["catalog", "stream"],
    types: ["movie", "series"],
    catalogs: CATALOGS.map((c) => ({
      id: c.id,
      type: c.type,
      name: c.name,
      extra: [{ name: "skip", isRequired: false }],
    })),
    idPrefixes: ["tt", "tmdb:"],
  });
});

app.get("/catalog/:type/:id.json", (req, res) => {
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Cache-Control", "max-age=0, no-cache, no-store, must-revalidate");

  const skip = parseInt(req.query.skip || 0);
  const listKey = CATALOG_LOOKUP.get(req.params.id);
  const list = listKey ? masterList[listKey] : [];

  res.json({ metas: (list || []).slice(skip, skip + 20) });
});

app.get("/stream/:type/:id.json", async (req, res) => {
  res.setHeader("Access-Control-Allow-Origin", "*");
  try {
    const rawId = req.params.id;
    let tmdbId = null;
    let mediaType = req.params.type === "series" ? "tv" : "movie";

    if (rawId.startsWith("tmdb:")) {
      const parts = rawId.split(":");
      mediaType = parts[1] === "series" ? "tv" : parts[1];
      tmdbId = parts[2];
    } else if (rawId.startsWith("tt")) {
      const findData = await fetch(tmdbUrl(`find/${rawId}`, { external_source: "imdb_id" })).then((r) => r.json());
      const match = (findData.movie_results && findData.movie_results[0]) || (findData.tv_results && findData.tv_results[0]);
      if (match) {
        tmdbId = match.id;
        if (findData.tv_results && findData.tv_results.length > 0) mediaType = "tv";
      }
    }

    if (!tmdbId) return res.json({ streams: [] });

    const [detail, providersResp] = await Promise.all([
      fetch(tmdbUrl(`${mediaType}/${tmdbId}`)).then((r) => r.json()),
      fetch(tmdbUrl(`${mediaType}/${tmdbId}/watch/providers`)).then((r) => r.json()),
    ]);

    const title = mediaType === "movie" ? detail.title : detail.name;
    const regionProviders = (providersResp.results && providersResp.results[REGION]) || {};
    const available = [
      ...(regionProviders.flatrate || []),
      ...(regionProviders.ads || []),
      ...(regionProviders.free || []),
    ];

    const streams = TARGET_PROVIDERS.filter((target) => available.some((p) => matchProvider(p.provider_name, target))).map((target) => ({
      name: target.label,
      title: `🔍 Launch Search: "${title}"`,
      externalUrl: target.searchUrl(title),
    }));

    res.json({ streams });
  } catch (err) {
    console.error(err);
    res.json({ streams: [] });
  }
});

app.get("/health", (req, res) =>
  res.json({
    status: "ok",
    version: "8.9.0",
    cinema: masterList.cinema.length,
    weeklyOtt: masterList.weeklyOtt.length,
    tMovies: masterList.tMovies.length,
    netflix: masterList.netflixOTT.length,
    prime: masterList.primevideoOTT.length,
    sonyLiv: masterList.sonylivOTT.length,
    aha: masterList.ahaOTT.length,
  })
);

app.listen(PORT, () => console.log(`🚀 Tamil Pro Max Ultra 8.9.0 Live on port ${PORT}`));
