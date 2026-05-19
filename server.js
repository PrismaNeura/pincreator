const express = require('express');
const fetch = (...args) => import('node-fetch').then(({ default: f }) => f(...args));
const path = require('path');

const app = express();
app.use(express.json());
app.use(express.static('public'));

// ── Gumroad License prüfen ──────────────────────────────────────────────────
app.post('/api/verify-license', async (req, res) => {
  const { licenseKey } = req.body;
  if (!licenseKey) return res.status(400).json({ valid: false, error: 'Kein Key angegeben' });

  try {
    const PRODUCT_ID = process.env.GUMROAD_PRODUCT_ID;
    if (!PRODUCT_ID) return res.status(500).json({ valid: false, error: 'GUMROAD_PRODUCT_ID fehlt in den Secrets' });

    const r = await fetch('https://api.gumroad.com/v2/licenses/verify', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ product_id: PRODUCT_ID, license_key: licenseKey })
    });
    const data = await r.json();

    if (!data.success) return res.json({ valid: false, error: 'Ungültiger Key' });

    const purchase = data.purchase;
    const cancelled = purchase.subscription_cancelled_at || purchase.subscription_ended_at;
    if (cancelled) return res.json({ valid: false, error: 'Abo wurde gekündigt' });

    return res.json({ valid: true, email: purchase.email });
  } catch (e) {
    return res.status(500).json({ valid: false, error: e.message });
  }
});

// ── Anthropic API Proxy ─────────────────────────────────────────────────────
app.post('/api/generate', async (req, res) => {
  const apiKey = process.env.ANTHROPIC_API_KEY;
  if (!apiKey) return res.status(500).json({ error: 'ANTHROPIC_API_KEY fehlt in den Secrets' });

  try {
    const r = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-api-key': apiKey,
        'anthropic-version': '2023-06-01'
      },
      body: JSON.stringify(req.body)
    });
    const data = await r.json();
    res.json(data);
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// ── Unsplash Proxy ──────────────────────────────────────────────────────────
app.get('/api/image', async (req, res) => {
  const query = req.query.q || 'abstract';
  const unsplashKey = process.env.UNSPLASH_ACCESS_KEY;
  const pexelsKey = process.env.PEXELS_API_KEY;

  try {
    if (unsplashKey) {
      const r = await fetch(`https://api.unsplash.com/photos/random?query=${encodeURIComponent(query)}&orientation=portrait&client_id=${unsplashKey}`);
      const data = await r.json();
      if (data.urls) return res.json({ url: data.urls.regular });
    }
    if (pexelsKey) {
      const r = await fetch(`https://api.pexels.com/v1/search?query=${encodeURIComponent(query)}&orientation=portrait&per_page=5`, {
        headers: { Authorization: pexelsKey }
      });
      const data = await r.json();
      if (data.photos?.length) return res.json({ url: data.photos[Math.floor(Math.random()*data.photos.length)].src.large });
    }
    res.json({ url: null });
  } catch (e) {
    res.json({ url: null });
  }
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`PinCreator läuft auf Port ${PORT}`));
