export default async function handler(req, res) {
  const { malId } = req.query;
  if (!malId) return res.status(400).json({ error: 'malId required' });

  try {
    const r = await fetch(`https://api.malsync.moe/mal/anime/${malId}`);
    const data = await r.json();
    res.setHeader('Access-Control-Allow-Origin', '*');
    res.status(r.status).json(data);
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
}
