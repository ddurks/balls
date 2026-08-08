const express = require("express");
const path = require("path");
const app = express();
const PORT = 3000;

// Assets change during development, so DON'T cache them immutably here (that was
// the cause of "I changed the texture but the browser still shows the old one").
// max-age=0 + ETag means the browser revalidates every load: a cheap 304 when
// the file is unchanged, fresh bytes automatically when it changes — no manual
// ?v= cache-busting needed in dev. (Prod caching is set separately in deploy.sh.)
app.use(
  "/assets",
  express.static(path.join(__dirname, "assets"), {
    etag: true,
    lastModified: true,
    maxAge: 0,
  }),
);

app.use(
  "/babylon",
  express.static(path.join(__dirname, "babylon"), {
    maxAge: "1y",
    immutable: true,
  }),
);

// Serve the remaining app files from the current directory.
app.use(express.static(__dirname));

// Serve index.html for root path
app.get("/", (req, res) => {
  res.sendFile(path.join(__dirname, "index.html"));
});

app.listen(PORT, () => {
  console.log(`Golf Ball Game running at http://localhost:${PORT}`);
  console.log(`Open your browser and navigate to http://localhost:${PORT}`);
});
