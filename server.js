const express = require('express');
const axios = require('axios');

const app = express();

app.get('/', (req, res) => {
    res.json({ success: true, message: "Minimal Server is LIVE!" });
});

app.get('/api/v1/discover', async (req, res) => {
    try {
        const response = await axios.get('https://api.themoviedb.org/3/trending/movie/day?api_key=89f2639942a0749f947521e02248fb7c');
        res.json({ success: true, results: response.data.results });
    } catch (error) {
        console.error(error.message);
        res.status(500).json({ success: false, error: "TMDB failed" });
    }
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, '0.0.0.0', () => console.log(`✅ MINIMAL SERVER RUNNING ON PORT ${PORT}`));
