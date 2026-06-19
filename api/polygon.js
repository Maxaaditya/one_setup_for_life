function cors(res) {
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Methods", "GET, OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type");
}

module.exports = async (req, res) => {
  cors(res);
  if (req.method === "OPTIONS") return res.status(200).end();
  if (req.method !== "GET") return res.status(405).json({ error: "Method not allowed" });

  const key = process.env.POLYGON_API_KEY || process.env.REACT_APP_POLYGON_KEY;
  if (!key) return res.status(500).json({ error: "POLYGON_API_KEY not configured on server" });

  const { path: polygonPath } = req.query;
  if (!polygonPath) return res.status(400).json({ error: "Missing path query parameter" });

  const url = `https://api.polygon.io${polygonPath}${polygonPath.includes("?") ? "&" : "?"}apiKey=${key}`;

  try {
    const upstream = await fetch(url);
    const data = await upstream.json();
    return res.status(upstream.status).json(data);
  } catch (err) {
    return res.status(502).json({ error: err.message || "Polygon proxy failed" });
  }
};
