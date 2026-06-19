function cors(res) {
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Methods", "POST, OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type");
}

module.exports = async (req, res) => {
  cors(res);
  if (req.method === "OPTIONS") return res.status(200).end();
  if (req.method !== "POST") return res.status(405).json({ error: "Method not allowed" });

  const token = process.env.TG_TOKEN || process.env.REACT_APP_TG_TOKEN;
  if (!token) return res.status(500).json({ error: "TG_TOKEN not configured on server" });

  const { chat_id, text, parse_mode } = req.body || {};
  if (!chat_id || !text) return res.status(400).json({ error: "chat_id and text required" });

  try {
    const upstream = await fetch(`https://api.telegram.org/bot${token}/sendMessage`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ chat_id, text, parse_mode: parse_mode || "HTML" }),
    });
    const data = await upstream.json();
    return res.status(upstream.status).json(data);
  } catch (err) {
    return res.status(502).json({ error: err.message || "Telegram proxy failed" });
  }
};
