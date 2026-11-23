console.log("🚀 STARTING FULL SERVER...");

// Safety Check for Modules
try {
    require('express');
    require('axios');
    require('cors');
    require('helmet');
    require('express-rate-limit');
    require('node-cache');
    require('m3u8stream');
    require('cheerio');
    require('ffmpeg-static');
    require('dotenv').config();
    console.log("✅ All modules loaded successfully.");
} catch (err) {
    console.error("❌ FATAL ERROR: Missing module. Details:", err.message);
    process.exit(1); 
}

const express = require('express');
const axios = require('axios');
const cors = require('cors');
const helmet = require('helmet');
const rateLimit = require('express-rate-limit');
const NodeCache = require('node-cache');
const m3u8stream = require('m3u8stream');
const { spawn } = require('child_process');
const fs = require('fs');
const cheerio = require('cheerio');
const ffmpeg = require('ffmpeg-static');

process.on('uncaughtException', (err) => console.error('🔥 FATAL ERROR:', err));
process.on('unhandledRejection', (reason) => console.error('🔥 REJECTION:', reason));

const app = express();
app.set('trust proxy', 1); // Fixes Render's proxy error

const cache = new NodeCache({ stdTTL: 600 });
app.use(helmet({ crossOriginResourcePolicy: false, contentSecurityPolicy: false }));
app.use(cors({ origin: '*' }));
app.use(express.json());
app.use('/api/', rateLimit({ windowMs: 15 * 60 * 1000, max: 300 }));

// ✅ YOUR WORKING TMDB KEY
const TMDB_API = '89f2639942a0749f947521e02248fb7c';

// ==========================================
// 1. INLINE VIDSRC SCRAPER & DECODER
// ==========================================
let BASEDOM = "https://whisperingauroras.com";

const decrypt = function (data, key) {
    if (!key || !data) return null;
    try {
        const c = Array.from(key).map(char => char.charCodeAt(0));
        if (c.length === 0) return null;
        const s = Buffer.from(data, 'base64').toString('binary');
        let result = '';
        for (let i = 0; i < s.length; i++) {
            result += String.fromCharCode(s.charCodeAt(i) ^ c[i % c.length]);
        }
        return Buffer.from(result, 'binary').toString('utf8');
    } catch (e) { return null; }
};

async function fetchWithTimeout(url, options = {}) {
    const { timeout = 10000 } = options;
    const controller = new AbortController();
    const id = setTimeout(() => controller.abort(), timeout);
    const response = await fetch(url, { ...options, signal: controller.signal });
    clearTimeout(id);
    return response;
}

async function serversLoad(html) {
  const $ = cheerio.load(html);
  const servers = [];
  const title = $("title").text() ?? "";
  const base = $("iframe").attr("src") ?? "";
  try { BASEDOM = new URL(base.startsWith("//") ? "https:" + base : base).origin ?? BASEDOM; } catch (e) { }
  $(".serversList .server").each((index, element) => {
    const server = $(element);
    servers.push({ name: server.text().trim(), dataHash: server.attr("data-hash") ?? null });
  });
  return { servers, title };
}

async function PRORCPhandler(prorcp) {
  try {
      const prorcpFetch = await fetchWithTimeout(`${BASEDOM}/prorcp/${prorcp}`);
      const prorcpResponse = await prorcpFetch.text();
      const scripts = prorcpResponse.match(/<script\s+src="\/([^"]*\.js)\?\_=([^"]*)"><\/script>/gm);
      if (!scripts) return null;
      const script = (scripts[scripts.length - 1].includes("cpt.js"))
        ? scripts[scripts.length - 2].replace(/.*src="\/([^"]*\.js)\?\_=([^"]*)".*/, "$1?_=$2")
        : scripts[scripts.length - 1].replace(/.*src="\/([^"]*\.js)\?\_=([^"]*)".*/, "$1?_=$2");
      const jsFileReq = await fetchWithTimeout(`${BASEDOM}/${script}`, { headers: { "accept": "*/*", "Referer": `${BASEDOM}/` } });
      const jsCode = await jsFileReq.text();
      const decryptRegex = /{}\}window\[([^"]+)\("([^"]+)"\)/;
      const decryptMatches = jsCode.match(decryptRegex);
      const $ = cheerio.load(prorcpResponse);
      if (!decryptMatches || decryptMatches?.length < 3) return null;
      const id = decrypt(decryptMatches[2].toString().trim(), decryptMatches[1].toString().trim());
      if (!id) return null;
      const data = $("#" + id);
      if (!data || data.length === 0) return null;
      return await decrypt(await data.text(), decryptMatches[2].toString().trim());
  } catch (e) { return null; }
}

async function rcpGrabber(html) {
  const regex = /src:\s*'([^']*)'/;
  const match = html.match(regex);
  if (!match) return null;
  return { data: match[1] };
}

async function tmdbScrape(tmdbId, type, season, episode) {
  try {
      const url = (type === "movie")
        ? `https://vidsrc.net/embed/${type}?tmdb=${tmdbId}`
        : `https://vidsrc.net/embed/${type}?tmdb=${tmdbId}&season=${season}&episode=${episode}`;
      const embed = await fetchWithTimeout(url, { headers: { 'User-Agent': 'Mozilla/5.0' } });
      const embedResp = await embed.text();
      const { servers, title } = await serversLoad(embedResp);
      
      const rcpResponses = await Promise.all(servers.map(el => fetchWithTimeout(`${BASEDOM}/rcp/${el.dataHash}`).then(r => r.text()).catch(() => null)));
      const prosrcrcp = await Promise.all(rcpResponses.map(res => res ? rcpGrabber(res) : null));

      const apiResponse = [];
      for (const item of prosrcrcp) {
        if (!item || !item.data) continue;
        if (item.data.substring(0, 8) === "/prorcp/") {
          const streamUrl = await PRORCPhandler(item.data.replace("/prorcp/", ""));
          if (streamUrl) apiResponse.push({ name: title || "VidSrc", stream: streamUrl, referer: BASEDOM });
        }
      }
      return apiResponse;
  } catch (error) { return []; }
}

// ==========================================
// 2. ROUTES
// ==========================================
app.get('/', (req, res) => res.json({ status: "online", message: "StreamNova Master Server is LIVE!" }));

app.get('/api/v1/discover', async (req, res) => {
    try {
        const { type = 'movie', category = 'trending', page = 1, country, genre, startYear = 1994, endYear = 2030 } = req.query;
        
        let url = `https://api.themoviedb.org/3/discover/${type}?api_key=${TMDB_API}&page=${page}`;
        if (category === 'trending') { url += `&sort_by=vote_count.desc`; } else { url += `&sort_by=popularity.desc`; }
        
        const dateField = type === 'movie' ? 'primary_release_date' : 'first_air_date';
        url += `&${dateField}.gte=${startYear}-01-01&${dateField}.lte=${endYear}-12-31`;
        
        if (category === 'anime') url += `&with_genres=16&with_original_language=ja`;
        if (country && country !== 'all') url += `&with_origin_country=${country}`;
        if (genre && genre !== 'all') url += `&with_genres=${genre}`;

        const response = await axios.get(url, { timeout: 10000 });
        res.json({ success: true, page: parseInt(page), results: response.data.results });
    } catch (error) { 
        res.status(500).json({ success: false, error: "TMDB unavailable" }); 
    }
});

app.get('/api/v1/anime/extract', async (req, res) => {
    const { title, episode = 1, dub = 'true' } = req.query;
    if (!title) return res.status(400).json({ error: "Title required" });
    
    try {
        const API = "https://hianime-api-iy4s.onrender.com/api";
        const search = await axios.get(`${API}/search`, { params: { keyword: title, page: 1 }, timeout: 30000 });
        if (!search.data?.animes?.length) return res.status(404).json({ success: false, error: "Anime not found" });
        
        const epList = await axios.get(`${API}/episodes/${search.data.animes[0].id}`, { timeout: 30000 });
        const targetEp = epList.data.episodes.find(e => e.number === parseInt(episode)) || epList.data.episodes[0];
        
        const servers = await axios.get(`${API}/servers`, { params: { id: targetEp.id }, timeout: 30000 });
        const serverList = (dub === 'true' && servers.data.dub?.length > 0) ? servers.data.dub : servers.data.sub;
        
        if (!serverList?.length) return res.status(404).json({ success: false, error: "No servers found" });

        const stream = await axios.get(`${API}/stream`, { params: { id: targetEp.id, type: dub === 'true' ? 'dub' : 'sub', server: serverList[0].name }, timeout: 30000 });
        const source = stream.data.sources.find(s => s.isM3U8) || stream.data.sources[0];
        
        if (!source) throw new Error("Stream link not found");

        res.json({ success: true, provider: `HiAnime (${serverList[0].name})`, title: search.data.animes[0].title, streamUrl: source.url, headers: source.headers || { "Referer": "https://hianime.to/" }, type: 'hls' });
    } catch (error) { 
        res.status(500).json({ success: false, error: "Anime API is waking up. Please refresh in 10 seconds." }); 
    }
});

app.get('/api/v1/player/:id/sources', async (req, res) => {
    const { id } = req.params;
    const { type = 'movie', season = 1, episode = 1 } = req.query;
    const sources = [];

    try {
        let url = type === 'movie' ? `https://vidlink.pro/api/b/movie/${id}` : `https://vidlink.pro/api/b/tv/${id}/${season}/${episode}`;
        const r = await axios.get(url, { timeout: 6000 });
        if (r.data?.stream?.playlist) sources.push({ provider: 'VidLink', url: r.data.stream.playlist, type: 'hls', referer: 'https://vidlink.pro/' });
    } catch (e) { }

    if (sources.length === 0) {
        try {
            const custom = await tmdbScrape(id, type, season, episode);
            if (custom?.length > 0) custom.forEach(s => sources.push({ provider: s.name, url: s.stream, type: 'hls', referer: s.referer }));
        } catch (e) { }
    }

    if (sources.length === 0) {
        let embed = type === 'movie' ? `https://multiembed.mov/?video_id=${id}&tmdb=1` : `https://multiembed.mov/?video_id=${id}&tmdb=1&s=${season}&e=${episode}`;
        sources.push({ provider: 'SuperEmbed', url: embed, type: 'iframe' });
    }
    res.json({ success: true, sources });
});

app.get('/api/v1/downloads/request', (req, res) => {
    const { url, referer, filename } = req.query;
    if (!url || !ffmpeg) return res.status(400).send("Invalid request");
    
    const safeFilename = filename ? filename.replace(/[^a-z0-9]/gi, '_') : 'video';
    res.setHeader('Content-Disposition', `attachment; filename="${safeFilename}.mp4"`);
    res.setHeader('Content-Type', 'video/mp4');

    try {
        const stream = m3u8stream(url, { 
            requestOptions: { headers: { 'User-Agent': 'Mozilla/5.0', 'Referer': referer || 'https://vidlink.pro/' } } 
        });
        const ff = spawn(ffmpeg, ['-i', 'pipe:0', '-c', 'copy', '-bsf:a', 'aac_adtstoasc', '-threads', '1', '-f', 'mp4', 'pipe:1']);
        stream.pipe(ff.stdin);
        ff.stdout.pipe(res);
        ff.on('error', () => { if (!res.headersSent) res.status(500).send("Download failed"); });
        req.on('close', () => { stream.destroy(); ff.kill('SIGKILL'); });
    } catch (e) { if (!res.headersSent) res.status(500).send("Download failed"); }
});

app.get('/api/v1/sports', async (req, res) => {
    try {
        const espn = await axios.get('https://site.api.espn.com/apis/site/v2/sports/soccer/all/scoreboard', { headers: { 'User-Agent': 'Mozilla/5.0' } });
        const events = (espn.data.events || []).map(e => {
            const c = e.competitions?.[0] || {};
            const status = c.status?.type?.description || 'Scheduled';
            return { id: e.id, name: e.name, date: e.date, status, isLive: status === 'In Progress', homeTeam: c.competitors?.find(x => x.homeAway === 'home')?.team?.displayName, awayTeam: c.competitors?.find(x => x.homeAway === 'away')?.team?.displayName };
        });
        res.json({ success: true, events });
    } catch (e) { res.status(500).json({ success: false, error: "Sports failed" }); }
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, '0.0.0.0', () => console.log(`✅ SERVER RUNNING ON PORT ${PORT}`));
