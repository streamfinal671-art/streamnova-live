console.log("🚀 STARTING SERVER...");
require('dotenv').config();
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

let ffmpeg;
try {
    ffmpeg = require('ffmpeg-static');
    console.log("✅ FFmpeg loaded:", ffmpeg);
} catch (e) {
    console.log("❌ FFmpeg error:", e.message);
}

process.on('uncaughtException', (err) => console.error('🔥 FATAL ERROR:', err));
process.on('unhandledRejection', (reason) => console.error('🔥 REJECTION:', reason));

const app = express();
const cache = new NodeCache({ stdTTL: 600 });

app.use(helmet({ crossOriginResourcePolicy: false, contentSecurityPolicy: false }));
app.use(cors({ origin: '*' }));
app.use(express.json());
app.use('/api/', rateLimit({ windowMs: 15 * 60 * 1000, max: 300 }));

const TMDB_API = process.env.TMDB_API_KEY;

// --- ROUTES ---
app.get('/', (req, res) => res.json({ status: "online", message: "StreamNova is LIVE on Render!" }));

app.get('/api/v1/discover', async (req, res) => {
    try {
        const { type = 'movie', category = 'trending', page = 1 } = req.query;
        if (!TMDB_API) return res.status(500).json({ success: false, error: "TMDB Key missing." });
        
        let url = `https://api.themoviedb.org/3/discover/${type}?api_key=${TMDB_API}&page=${page}&sort_by=popularity.desc`;
        if (category === 'trending') url += `&sort_by=vote_count.desc`;
        else if (category === 'anime') url += `&with_genres=16&with_original_language=ja`;

        const response = await axios.get(url, { timeout: 10000 });
        res.json({ success: true, page: parseInt(page), results: response.data.results });
    } catch (error) { res.status(500).json({ success: false, error: "TMDB unavailable" }); }
});

app.get('/api/v1/anime/extract', async (req, res) => {
    const { title, episode = 1, dub = 'true' } = req.query;
    if (!title) return res.status(400).json({ error: "Title required" });
    try {
        const API = "https://hianime-api-iy4s.onrender.com/api";
        const search = await axios.get(`${API}/search`, { params: { keyword: title, page: 1 }, timeout: 15000 });
        if (!search.data?.animes?.length) return res.status(404).json({ success: false, error: "Not found" });
        
        const epList = await axios.get(`${API}/episodes/${search.data.animes[0].id}`, { timeout: 15000 });
        const targetEp = epList.data.episodes.find(e => e.number === parseInt(episode)) || epList.data.episodes[0];
        
        const servers = await axios.get(`${API}/servers`, { params: { id: targetEp.id }, timeout: 15000 });
        const serverList = (dub === 'true' && servers.data.dub?.length > 0) ? servers.data.dub : servers.data.sub;
        
        const stream = await axios.get(`${API}/stream`, { params: { id: targetEp.id, type: dub === 'true' ? 'dub' : 'sub', server: serverList[0].name }, timeout: 15000 });
        const source = stream.data.sources.find(s => s.isM3U8) || stream.data.sources[0];
        
        res.json({ success: true, provider: `HiAnime`, title: search.data.animes[0].title, streamUrl: source.url, headers: source.headers || { "Referer": "https://hianime.to/" }, type: 'hls' });
    } catch (error) { res.status(500).json({ success: false, error: "Anime failed" }); }
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
        sources.push({ provider: 'SuperEmbed', url: type === 'movie' ? `https://multiembed.mov/?video_id=${id}&tmdb=1` : `https://multiembed.mov/?video_id=${id}&tmdb=1&s=${season}&e=${episode}`, type: 'iframe' });
    }
    res.json({ success: true, sources });
});

app.get('/api/v1/downloads/request', (req, res) => {
    const { url, referer, filename } = req.query;
    if (!url || !ffmpeg) return res.status(400).send("Invalid request");
    res.setHeader('Content-Disposition', `attachment; filename="${filename || 'video'}.mp4"`);
    res.setHeader('Content-Type', 'video/mp4');
    try {
        const stream = m3u8stream(url, { requestOptions: { headers: { 'User-Agent': 'Mozilla/5.0', 'Referer': referer || 'https://vidlink.pro/' } } });
        const ff = spawn(ffmpeg, ['-i', 'pipe:0', '-c', 'copy', '-bsf:a', 'aac_adtstoasc', '-threads', '1', '-f', 'mp4', 'pipe:1']);
        stream.pipe(ff.stdin);
        ff.stdout.pipe(res);
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
