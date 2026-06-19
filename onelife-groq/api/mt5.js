function cors(res) {
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Methods", "GET, POST, OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type");
}

module.exports = async (req, res) => {
  cors(res);
  if (req.method === "OPTIONS") return res.status(200).end();

  const bridgeUrl = process.env.MT5_BRIDGE_URL || process.env.REACT_APP_MT5_BRIDGE_URL;
  if (!bridgeUrl) {
    return res.status(503).json({
      error: "MT5 bridge not configured",
      hint: "Set MT5_BRIDGE_URL in Vercel env vars to your bridge URL (e.g. ngrok tunnel to localhost:5000)",
    });
  }

  const base = bridgeUrl.replace(/\/$/, "");
  const path = (req.query.path || "ping").replace(/^\//, "");
  const target = `${base}/${path}`;

  try {
    const opts = { method: req.method, headers: { "Content-Type": "application/json" } };
    if (req.method === "POST" && req.body) opts.body = JSON.stringify(req.body);
    const upstream = await fetch(target, opts);
    const data = await upstream.json();
    return res.status(upstream.status).json(data);
  } catch (err) {
    return res.status(502).json({ error: err.message || "MT5 bridge unreachable" });
  }
};
