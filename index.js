const express = require("express");
const fetch = require("node-fetch");
const app = express();

const TMDB_KEY = process.env.TMDB_API_KEY;
const PORT = process.env.PORT || 10000;
const REGION = "IN";
const LANGUAGE_FILTER = "ta"; // Tamil

// Comprehensive target array including new premium digital channels
const TARGET_PROVIDERS = [
  { key: "jiohotstar", matchNames: ["jiohotstar", "disney+ hotstar", "hotstar"], searchUrl: (q) => `https://www.hotstar.com/in/search?q=${encodeURIComponent(q)}` },
  { key: "zee5", matchNames: ["zee5"], searchUrl: (q) => `https://www.zee5.com/search?q=${encodeURIComponent(q)}` },
  { key: "sunnxt", matchNames: ["sun nxt", "sunnxt"], searchUrl: (q) => `https://www.sunnxt.com/search/${encodeURIComponent(q)}` },
  { key: "netflix", matchNames: ["netflix"], searchUrl: (q) => `https://www.netflix.com/search?q=${encodeURIComponent(q)}` },
  { key: "primevideo", matchNames: ["amazon prime video", "amazon prime", "prime video"], searchUrl: (q) => `https://www.primevideo.com/search/ref=atv_sr_sug?phrase=${encodeURIComponent(q)}` },
  { key: "sonyliv", matchNames: ["sony liv", "sonyliv"], searchUrl: (q) => `https://www.sonyliv.com/search?q=${encodeURIComponent(q)}` },
  { key: "aha", matchNames: ["aha", "aha video"], searchUrl: (q) => `https://www.aha.video/search?q=${encodeURIComponent(q)}` }
];

let providerIdCache = null; 
let masterList = { 
    cinema: [],
    tMovies: [], tSeries: [], 
    dMovies: [], dSeries: [], 
    eMovies: [], eSeries: [],
    jiohotstarOTT: [],
    zee5OTT: [],
    sunnxtOTT: [],
    netflixOTT: [],
    primevideoOTT: [],
    sonylivOTT: [],
    ahaOTT: []
};

const delay = ms => new Promise(res => setTimeout(res, ms));

async function fetchAllPages(url, pages = 2) {
    let results = [];
    for (let p = 1; p <= pages; p++) {
        try {
            const res = await fetch(`${url}&page=${p}`);
            const data = await res.json();
            if (data.results) results = results.concat(data.results);
        } catch (e) { console.error("Fetch error", e); }
    }
    return results;
}

async function fetchMultiLang(baseUrl, langs, pages = 2) {
    const promises = langs.map(lang => fetchAllPages(`${baseUrl}&with_original_language=${lang}`, pages));
    const resultsArrays = await Promise.all(promises);
    const combined = resultsArrays.flat();
    return Array.from(new Map(combined.map(item => [item.id, item])).values());
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
      const data = await fetchAllPages(`https://api.themoviedb.org/3/watch/providers/${mediaType}?api_key=${TMDB_KEY}&watch_region=${REGION}`, 1);
      for (const target of TARGET_PROVIDERS) {
        const found = (data || []).find((p) => matchProvider(p.provider_name, target));
        if (found) result[mediaType][target.key] = found.provider_id;
      }
    } catch (err) {
      console.error(`Failed resolving providers for ${mediaType}:`, err.message);
    }
  }
  providerIdCache = result;
  return result;
}

async function updateDailyList() {
    const today = new Date().toISOString().split('T')[0];
    const startDate = "2025-01-01";
    const sixtyDaysAgo = new Date(Date.now() - 60 * 24 * 60 * 60 * 1000).toISOString().split('T')[0];

    const regionalLangs = ["hi", "te", "ml", "kn"];
    const cinemaLangs = ["ta", "hi", "te", "ml", "kn"];

    console.log(`🔄 Sync Started: ${today}`);

    try {
        const ids = await resolveProviderIds();

        const tMovieBase   = `https://api.themoviedb.org/3/discover/movie?api_key=${TMDB_KEY}&region=IN&primary_release_date.gte=${startDate}&primary_release_date.lte=${today}&sort_by=primary_release_date.desc`;
        const tSeriesBase  = `https://api.themoviedb.org/3/discover/tv?api_key=${TMDB_KEY}&first_air_date.gte=${startDate}&first_air_date.lte=${today}&sort_by=first_air_date.desc`;
        const indMovieBase = `https://api.themoviedb.org/3/discover/movie?api_key=${TMDB_KEY}&region=IN&with_release_type=4&primary_release_date.gte=${startDate}&primary_release_date.lte=${today}`;
        const indSeriesBase= `https://api.themoviedb.org/3/discover/tv?api_key=${TMDB_KEY}&with_origin_country=IN&first_air_date.gte=${startDate}&first_air_date.lte=${today}`;
        const engMovieBase = `https://api.themoviedb.org/3/discover/movie?api_key=${TMDB_KEY}&region=IN&primary_release_date.gte=${startDate}&primary_release_date.lte=${today}&sort_by=popularity.desc`;
        const engSeriesBase= `https://api.themoviedb.org/3/discover/tv?api_key=${TMDB_KEY}&first_air_date.gte=${startDate}&first_air_date.lte=${today}&sort_by=popularity.desc`;
        const cinemaBase   = `https://api.themoviedb.org/3/discover/movie?api_key=${TMDB_KEY}&region=IN&with_release_type=3&primary_release_date.gte=${sixtyDaysAgo}&primary_release_date.lte=${today}`;

        const rawTM = await fetchAllPages(`${tMovieBase}&with_original_language=ta`, 2);
        const rawTS = await fetchAllPages(`${tSeriesBase}&with_original_language=ta`, 2);
        const rawEngM = await fetchAllPages(`${engMovieBase}&with_original_language=en`, 3);
        const rawEngS = await fetchAllPages(`${engSeriesBase}&with_original_language=en`, 3);
        const rawIndM = await fetchMultiLang(indMovieBase, regionalLangs, 2);
        const rawIndS = await fetchMultiLang(indSeriesBase, regionalLangs, 2);
        const rawCinema = await fetchMultiLang(cinemaBase, cinemaLangs, 2);

        rawIndM.sort((a, b) => new Date(b.release_date || 0) - new Date(a.release_date || 0));
        rawIndS.sort((a, b) => new Date(b.first_air_date || 0) - new Date(a.first_air_date || 0));

        masterList.tMovies = await processItems(rawTM.slice(0, 50), 'movie');
        masterList.tSeries = await processItems(rawTS.slice(0, 50), 'tv');
        masterList.dMovies = await processItems(rawIndM.slice(0, 50), 'movie');
        masterList.dSeries = await processItems(rawIndS.slice(0, 50), 'tv');
        masterList.eMovies = await processItems(rawEngM.slice(0, 50), 'movie');
        masterList.eSeries = await processItems(rawEngS.slice(0, 50), 'tv');

        const cinemaItems = rawCinema.filter(m => m.poster_path).sort((a, b) => new Date(b.release_date || 0) - new Date(a.release_date || 0));
        masterList.cinema = await processItems(cinemaItems.slice(0, 40), 'movie', true);

        // Batch generation block loop for all 7 premium local OTT platforms
        for (const provider of TARGET_PROVIDERS) {
            const pMovId = ids.movie[provider.key];
            const pTvId = ids.tv[provider.key];
            let combinedOtt = [];

            if (pMovId) {
                const ottMovies = await fetchAllPages(`https://api.themoviedb.org/3/discover/movie?api_key=${TMDB_KEY}&watch_region=${REGION}&with_watch_providers=${pMovId}&with_original_language=${LANGUAGE_FILTER}&sort_by=popularity.desc`, 2);
                combinedOtt = combinedOtt.concat(ottMovies.map(item => ({...item, media_type: 'movie'})));
            }
            if (pTvId) {
                const ottSeries = await fetchAllPages(`https://api.themoviedb.org/3/discover/tv?api_key=${TMDB_KEY}&watch_region=${REGION}&with_watch_providers=${pTvId}&with_original_language=${LANGUAGE_FILTER}&sort_by=popularity.desc`, 2);
                combinedOtt = combinedOtt.concat(ottSeries.map(item => ({...item, media_type: 'tv'})));
            }
            
            combinedOtt.sort((a, b) => (b.popularity || 0) - (a.popularity || 0));
            masterList[`${provider.key}OTT`] = await processItems(combinedOtt.slice(0, 45), 'mixed');
        }

        console.log(`✅ Update Successful! ${new Date().toLocaleTimeString()}`);
    } catch (e) { console.error("Sync failed", e); }
}

async function processItems(items, type, isCinema = false) {
    const list = [];
    for (const item of items) {
        const activeType = type === 'mixed' ? item.media_type : type;
        const p = await convertToPlayable(item, activeType, isCinema);
        if (p) list.push(p);
        await delay(15);
    }
    return list;
}

async function convertToPlayable(item, type, isCinema = false) {
    try {
        const idUrl = `https://api.themoviedb.org/3/${type}/${item.id}/external_ids?api_key=${TMDB_KEY}`;
        const res = await fetch(idUrl);
        const ids = await res.json();
        
        const date = type === 'movie' ? item.release_date : item.first_air_date;
        const year = date ? date.slice(0, 4) : '';
        const baseName = item.title || item.name;

        let posterUrl = item.poster_path ? `https://image.tmdb.org/t/p/w500${item.poster_path}` : null;
        if (ids.imdb_id) {
            posterUrl = `https://btttr.cc/poster-q/imdb/poster-default/${ids.imdb_id}.jpg`;
        }

        const metaObj = {
            id:          ids.imdb_id || `tmdb:${type}:${item.id}`,
            name:        isCinema ? `${baseName} 🎬 [IN CINEMA]` : baseName,
            type:        type === 'movie' ? 'movie' : 'series',
            poster:      posterUrl,
            releaseInfo: year,
            released:    date ? new Date(date).toISOString() : undefined,
            imdbRating:  item.vote_average && item.vote_average > 0 ? item.vote_average.toFixed(1) : undefined,
            description: item.overview || `📅 Release Date: ${date || 'N/A'}`,
        };

        if (isCinema) metaObj.inTheaters = true; 

        return metaObj;
    } catch (e) { return null; }
}

updateDailyList();
setInterval(updateDailyList, 12 * 60 * 60 * 1000);

app.get("/manifest.json", (req, res) => {
    res.setHeader("Access-Control-Allow-Origin", "*");
    res.setHeader("Cache-Control", "max-age=0, no-cache, no-store, must-revalidate");
    res.json({
        id: "com.anandh.tamil.v8.cinema", 
        version: "8.8.0", 
        name: "Tamil Pro Max Ultra (v8)", 
        description: "14 Rows - Ultimate Combined Cinema, Streaming Platforms & Television Index",
        resources: ["catalog", "stream"],
        types: ["movie", "series"],
        catalogs: [
            { id: "tamil_cinema",  type: "movie",  name: "🎬 Now In Cinemas",           extra: [{ name: "skip", isRequired: false }] },
            { id: "pure_tamil_m",  type: "movie",  name: "New Tamil Movies (Pure)",      extra: [{ name: "skip", isRequired: false }] },
            { id: "pure_tamil_s",  type: "series", name: "New Tamil Series (Pure)",      extra: [{ name: "skip", isRequired: false }] },
            
            { id: "ott_jiohotstar", type: "movie",  name: "📱 JioHotstar Tamil",  extra: [{ name: "skip", isRequired: false }] },
            { id: "ott_zee5",       type: "movie",  name: "📱 ZEE5 Tamil",        extra: [{ name: "skip", isRequired: false }] },
            { id: "ott_sunnxt",     type: "movie",  name: "📱 Sun NXT Tamil",     extra: [{ name: "skip", isRequired: false }] },
            { id: "ott_netflix",    type: "movie",  name: "📱 Netflix India Tamil", extra: [{ name: "skip", isRequired: false }] },
            { id: "ott_primevideo", type: "movie",  name: "📱 Prime Video India Tamil", extra: [{ name: "skip", isRequired: false }] },
            { id: "ott_sonyliv",    type: "movie",  name: "📱 SonyLIV Tamil",     extra: [{ name: "skip", isRequired: false }] },
            { id: "ott_aha",        type: "movie",  name: "📱 Aha Video Tamil",   extra: [{ name: "skip", isRequired: false }] },

            { id: "ind_dub_m",     type: "movie",  name: "New Indian Dubbed Movies",     extra: [{ name: "skip", isRequired: false }] },
            { id: "ind_dub_s",     type: "series", name: "New Indian Dubbed Series",     extra: [{ name: "skip", isRequired: false }] },
            { id: "eng_dub_m",     type: "movie",  name: "Hollywood Hits (Tamil Dub)",   extra: [{ name: "skip", isRequired: false }] },
            { id: "eng_dub_s",     type: "series", name: "Hollywood Series (Tamil Dub)", extra: [{ name: "skip", isRequired: false }] },
        ],
        idPrefixes: ["tt", "tmdb:"]
    });
});

app.get("/catalog/:type/:id.json", (req, res) => {
    res.setHeader("Access-Control-Allow-Origin", "*");
    res.setHeader("Cache-Control", "max-age=0, no-cache, no-store, must-revalidate");

    const cid  = req.params.id;
    const skip = parseInt(req.query.skip || 0);
    let list = [];

    if (cid === "tamil_cinema")  list = masterList.cinema;
    if (cid === "pure_tamil_m")  list = masterList.tMovies;
    if (cid === "pure_tamil_s")  list = masterList.tSeries;
    
    if (cid === "ott_jiohotstar") list = masterList.jiohotstarOTT;
    if (cid === "ott_zee5")       list = masterList.zee5OTT;
    if (cid === "ott_sunnxt")     list = masterList.sunnxtOTT;
    if (cid === "ott_netflix")    list = masterList.netflixOTT;
    if (cid === "ott_primevideo") list = masterList.primevideoOTT;
    if (cid === "ott_sonyliv")    list = masterList.sonylivOTT;
    if (cid === "ott_aha")        list = masterList.ahaOTT;

    if (cid === "ind_dub_m")     list = masterList.dMovies;
    if (cid === "ind_dub_s")     list = masterList.dSeries;
    if (cid === "eng_dub_m")     list = masterList.eMovies;
    if (cid === "eng_dub_s")     list = masterList.eSeries;

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
            const findUrl = `https://api.themoviedb.org/3/find/${rawId}?api_key=${TMDB_KEY}&external_source=imdb_id`;
            const findRes = await fetch(findUrl);
            const findData = await findRes.json();
            
            const match = (findData.movie_results && findData.movie_results[0]) || 
                          (findData.tv_results && findData.tv_results[0]);
            if (match) {
                tmdbId = match.id;
                if (findData.tv_results && findData.tv_results.length > 0) mediaType = "tv";
            }
        }

        if (!tmdbId) return res.json({ streams: [] });

        const [detail, providersResp] = await Promise.all([
          fetch(`https://api.themoviedb.org/3/${mediaType}/${tmdbId}?api_key=${TMDB_KEY}`).then(r => r.json()),
          fetch(`https://api.themoviedb.org/3/${mediaType}/${tmdbId}/watch/providers?api_key=${TMDB_KEY}`).then(r => r.json()),
        ]);

        const title = mediaType === "movie" ? detail.title : detail.name;
        const regionProviders = (providersResp.results && providersResp.results[REGION]) || {};
        const available = [
          ...(regionProviders.flatrate || []),
          ...(regionProviders.ads || []),
          ...(regionProviders.free || []),
        ];

        const streams = [];
        for (const target of TARGET_PROVIDERS) {
          const onThisProvider = available.some((p) => matchProvider(p.provider_name, target));
          if (onThisProvider) {
            let label = target.key.toUpperCase();
            if (target.key === "primevideo") label = "Prime Video";
            if (target.key === "jiohotstar") label = "JioHotstar";
            if (target.key === "sonyliv") label = "SonyLIV";
            
            streams.push({
              name: label,
              title: `🔍 Launch Search: "${title}"`,
              externalUrl: target.searchUrl(title),
            });
          }
        }

        res.json({ streams });
    } catch (err) {
        console.error(err);
        res.json({ streams: [] });
    }
});

app.get("/health", (req, res) => res.json({
    status: "ok", version: "8.8.0",
    cinema:  masterList.cinema.length,
    tMovies: masterList.tMovies.length,
    netflix: masterList.netflixOTT.length,
    prime:   masterList.primevideoOTT.length,
    sonyLiv: masterList.sonylivOTT.length,
    aha:     masterList.ahaOTT.length
}));

app.listen(PORT, () => console.log(`🚀 Tamil Pro Max Ultra 8.8.0 Live on port ${PORT}`));
