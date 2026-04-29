const express = require('express');
const path = require('path');
const app = express();
const PORT = 3000;

// Cache bundled runtime assets aggressively so the browser does not keep revalidating them.
app.use(
    '/assets',
    express.static(path.join(__dirname, 'assets'), {
        maxAge: '1y',
        immutable: true,
    })
);

app.use(
    '/babylon',
    express.static(path.join(__dirname, 'babylon'), {
        maxAge: '1y',
        immutable: true,
    })
);

// Serve the remaining app files from the current directory.
app.use(express.static(__dirname));

// Serve index.html for root path
app.get('/', (req, res) => {
    res.sendFile(path.join(__dirname, 'index.html'));
});

app.listen(PORT, () => {
    console.log(`Golf Ball Game running at http://localhost:${PORT}`);
    console.log(`Open your browser and navigate to http://localhost:${PORT}`);
});
