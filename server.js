const express = require('express');
const fetch = (...args) => import('node-fetch').then(({ default: f }) => f(...args));

const app = express();
app.use(express.json());
app.use(express.static('public'));

// ── Passwort Login ──────────────────────────────────────────────────────────
app.post('/api/verify-license', (req, res) => {
  const { licenseKey } = req.body;
  const PASSWORD = process.env.ACCESS_PASSWORD || 'PinBoost2026';
  if (licenseKey === PASSWORD) {
    res.json({ valid: true, email: 'user' });
  } else {
    res.json({ valid: false, error: 'Falsches Passwort – bitte auf Gumroad kaufen.' });
  }
});

// ── Anthropic API Proxy ─────────────────────────────────────────────────────
app.post('/api/generate', async (req, res) => {
  const apiKey = process.env.ANTHROPIC_API_KEY;
  if (!apiKey) return res.status(500).json({ error: 'ANTHROPIC_API_KEY fehlt' });
  try {
    const r = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'x-api-key': apiKey, 'anthropic-version': '2023-06-01' },
      body: JSON.stringify(req.body)
    });
    res.json(await r.json());
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// ── Unsplash Proxy ──────────────────────────────────────────────────────────
app.get('/api/image', async (req, res) => {
  const unsplashKey = process.env.UNSPLASH_ACCESS_KEY;
  try {
    if (unsplashKey) {
      const r = await fetch(`https://api.unsplash.com/photos/random?query=${encodeURIComponent(req.query.q||'abstract')}&orientation=portrait&client_id=${unsplashKey}`);
      const d = await r.json();
      if (d.urls) return res.json({ url: d.urls.regular });
    }
    res.json({ url: null });
  } catch { res.json({ url: null }); }
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`PinCreator läuft auf Port ${PORT}`));
