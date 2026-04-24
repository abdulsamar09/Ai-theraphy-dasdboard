const express = require('express');
const path = require('path');
const app = express();

app.use('/dashboard', express.static(path.join(__dirname, 'frontend-dashboard')));
app.use('/site', express.static(path.join(__dirname, 'frontend-website')));

app.get('/', (req, res) => {
    res.sendFile(path.join(__dirname, 'frontend-website', 'index.html'));
});

app.get('/dashboard-app', (req, res) => {
    res.sendFile(path.join(__dirname, 'frontend-dashboard', 'index.html'));
});

const port = 8080;
app.listen(port, () => {
    console.log(`Server running at http://localhost:${port}`);
});
