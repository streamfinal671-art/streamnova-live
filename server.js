const express = require('express');
const app = express();

app.get('/', (req, res) => {
    res.json({ success: true, message: "SUCCESS! The JS is running perfectly." });
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, '0.0.0.0', () => console.log(`✅ SERVER RUNNING ON PORT ${PORT}`));
