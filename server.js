const express = require('express');
const fetch = (...args) => import('node-fetch').then(({ default: f }) => f(...args));
const crypto = require('crypto');
const nodemailer = require('nodemailer');

const app = express();
app.use(express.json());
app.use(express.static('public'));

const SUPABASE_URL = 'https://hinhbgfvgffjrdguetgv.supabase.co';
const ADMIN_EMAIL = 'claus.anne@gmx.de';

const PLANS = {
  starter:   { name: 'Starter',   price: 9,  limit: 500,  features: ['pinterest'] },
  creator:   { name: 'Creator',   price: 19, limit: 1000, features: ['pinterest','instagram','stories'] },
  pro:       { name: 'Pro',       price: 29, limit: 3000, features: ['pinterest','instagram','stories','carousel','reels'] },
  unlimited: { name: 'Unlimited', price: 39, limit: Infinity, features: ['pinterest','instagram','stories','carousel','reels'] }
};

function getPlanByPrice(price) {
  if (price >= 39) return 'unlimited';
  if (price >= 29) return 'pro';
  if (price >= 19) return 'creator';
  return 'starter';
}

function hashPassword(password) {
  return crypto.createHash('sha256').update(password + 'pincreator_salt_2026').digest('hex');
}

async function supabaseFetch(path, method, body, useServiceRole = false) {
  const key = useServiceRole ? process.env.SUPABASE_SERVICE_KEY : process.env.SUPABASE_ANON_KEY;
  const r = await fetch(`${SUPABASE_URL}/rest/v1${path}`, {
    method,
    headers: { 'Content-Type': 'application/json', 'apikey': key, 'Authorization': `Bearer ${key}`, 'Prefer': 'return=representation' },
    body: body ? JSON.stringify(body) : undefined
  });
  const text = await r.text();
  return text ? JSON.parse(text) : [];
}

// LOGIN
app.post('/api/login', async (req, res) => {
  const { email, password } = req.body;
  if (!email || !password) return res.status(400).json({ success: false, error: 'E-Mail und Passwort erforderlich' });
  try {
    const hash = hashPassword(password);
    const users = await supabaseFetch(`/users?email=eq.${encodeURIComponent(email.toLowerCase())}&password_hash=eq.${hash}&select=id,email,active,expires_at,plan,pins_used,pins_reset_date`, 'GET', null, true);
    if (!users || !users.length) return res.json({ success: false, error: 'E-Mail oder Passwort falsch' });
    const user = users[0];
    if (!user.active) return res.json({ success: false, error: 'Dein Account ist nicht aktiv.' });
    if (user.expires_at && new Date(user.expires_at) < new Date()) return res.json({ success: false, error: 'Dein Abonnement ist abgelaufen.' });
    const resetDate = new Date(user.pins_reset_date || 0);
    if (new Date() >= resetDate) {
      const nextReset = new Date(); nextReset.setMonth(nextReset.getMonth() + 1); nextReset.setDate(1);
      await supabaseFetch(`/users?id=eq.${user.id}`, 'PATCH', { pins_used: 0, pins_reset_date: nextReset.toISOString() }, true);
      user.pins_used = 0;
    }
    const plan = PLANS[user.plan || 'starter'];
    const isAdmin = email.toLowerCase() === ADMIN_EMAIL;
    res.json({ success: true, email: user.email, plan: user.plan || 'starter', planName: plan.name, pinsUsed: isAdmin ? 0 : (user.pins_used || 0), pinsLimit: isAdmin ? Infinity : plan.limit, features: isAdmin ? ['pinterest','instagram','stories','carousel','reels'] : plan.features, isAdmin });
  } catch (e) { res.status(500).json({ success: false, error: e.message }); }
});

// PASSWORT SETZEN
app.post('/api/set-password', async (req, res) => {
  const { email, password, token } = req.body;
  if (!email || !password || !token) return res.status(400).json({ success: false, error: 'Fehlende Daten' });
  try {
    const users = await supabaseFetch(`/users?email=eq.${encodeURIComponent(email.toLowerCase())}&setup_token=eq.${token}&select=id`, 'GET', null, true);
    if (!users || !users.length) return res.json({ success: false, error: 'Ungültiger Link' });
    const hash = hashPassword(password);
    await supabaseFetch(`/users?id=eq.${users[0].id}`, 'PATCH', { password_hash: hash, setup_token: null, active: true }, true);
    res.json({ success: true });
  } catch (e) { res.status(500).json({ success: false, error: e.message }); }
});

// CHECK LIMIT
app.post('/api/check-limit', async (req, res) => {
  const { email, count } = req.body;
  if (!email || email.toLowerCase() === ADMIN_EMAIL) return res.json({ allowed: true, isAdmin: true });
  try {
    const users = await supabaseFetch(`/users?email=eq.${encodeURIComponent(email.toLowerCase())}&select=plan,pins_used`, 'GET', null, true);
    if (!users || !users.length) return res.json({ allowed: false });
    const user = users[0]; const plan = PLANS[user.plan || 'starter'];
    const currentUsed = user.pins_used || 0;
    if (plan.limit !== Infinity && currentUsed + (count || 1) > plan.limit) return res.json({ allowed: false, limitReached: true, pinsUsed: currentUsed, pinsLimit: plan.limit, planName: plan.name });
    res.json({ allowed: true, pinsUsed: currentUsed, pinsLimit: plan.limit });
  } catch { res.json({ allowed: true }); }
});

// COUNT PINS
app.post('/api/count-pins', async (req, res) => {
  const { email, count } = req.body;
  if (!email || email.toLowerCase() === ADMIN_EMAIL) return res.json({ success: true, isAdmin: true });
  try {
    const users = await supabaseFetch(`/users?email=eq.${encodeURIComponent(email.toLowerCase())}&select=id,plan,pins_used`, 'GET', null, true);
    if (!users || !users.length) return res.json({ success: false });
    const user = users[0]; const plan = PLANS[user.plan || 'starter'];
    const newUsed = (user.pins_used || 0) + (count || 1);
    if (plan.limit !== Infinity && newUsed > plan.limit) return res.json({ success: false, limitReached: true });
    await supabaseFetch(`/users?id=eq.${user.id}`, 'PATCH', { pins_used: newUsed }, true);
    const warning = plan.limit !== Infinity && newUsed >= plan.limit * 0.8 && (user.pins_used || 0) < plan.limit * 0.8;
    if (warning) await sendEmail(email, 'PinCreator: 80% deines Limits erreicht', `Du hast ${newUsed} von ${plan.limit} Posts diesen Monat erstellt.\n\nJetzt upgraden: https://gumroad.com/l/oktubc`);
    res.json({ success: true, pinsUsed: newUsed, pinsLimit: plan.limit, warning });
  } catch (e) { res.status(500).json({ success: false, error: e.message }); }
});

// GUMROAD WEBHOOK
app.post('/webhook/gumroad', (req, res) => {
  res.status(200).send('OK');
  setImmediate(async () => {
    const data = req.body;
    const email = (data.email || '').toLowerCase();
    if (!email) return;
    console.log('Webhook:', JSON.stringify(data));
    try {
      if (data.resource_name === 'sale') {
        const setupToken = crypto.randomBytes(32).toString('hex');
        const expiresAt = new Date(); expiresAt.setMonth(expiresAt.getMonth() + 1);
        const price = parseFloat(data.price || 0) / 100;
        const plan = getPlanByPrice(price);
        const existing = await supabaseFetch(`/users?email=eq.${encodeURIComponent(email)}&select=id`, 'GET', null, true);
        if (existing && existing.length) {
          await supabaseFetch(`/users?id=eq.${existing[0].id}`, 'PATCH', { active: true, gumroad_sale_id: data.sale_id, expires_at: expiresAt.toISOString(), setup_token: setupToken, plan, pins_used: 0 }, true);
        } else {
          await supabaseFetch('/users', 'POST', { email, password_hash: crypto.randomBytes(32).toString('hex'), active: false, gumroad_sale_id: data.sale_id, expires_at: expiresAt.toISOString(), setup_token: setupToken, plan, pins_used: 0 }, true);
        }
        const planInfo = PLANS[plan];
        const setupLink = `https://boostyourpins.de/setup?email=${encodeURIComponent(email)}&token=${setupToken}`;
        await sendEmail(email, `Willkommen bei PinCreator ${planInfo.name}!`,
          `Hallo!\n\nVielen Dank für deinen Kauf! 🎉\n\nDein Plan: ${planInfo.name}\nMonatliches Limit: ${planInfo.limit === Infinity ? 'Unbegrenzt' : planInfo.limit + ' Posts'}\n\nPasswort festlegen:\n${setupLink}\n\nViel Erfolg!\nDas PinCreator Team`);
      } else if (['subscription_cancelled','subscription_ended','refund'].includes(data.resource_name)) {
        await supabaseFetch(`/users?email=eq.${encodeURIComponent(email)}`, 'PATCH', { active: false }, true);
        await sendEmail(email, 'PinCreator Abonnement beendet', `Dein Abonnement wurde beendet.\n\nWieder aktivieren: https://gumroad.com/l/oktubc`);
      }
    } catch (e) { console.error('Webhook Fehler:', e); }
  });
});

async function sendEmail(to, subject, text) {
  try {
    const r = await fetch('https://api.brevo.com/v3/smtp/email', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'api-key': process.env.BREVO_SMTP_KEY },
      body: JSON.stringify({ sender: { name: 'PinCreator', email: 'hallo@boostyourpins.de' }, to: [{ email: to }], subject, textContent: text })
    });
    const d = await r.json(); console.log('E-Mail:', JSON.stringify(d));
  } catch (e) { console.error('E-Mail Fehler:', e.message); }
}

// IP-based demo rate limiting
const demoUsage = new Map();
const DEMO_LIMIT = 3;
const DEMO_WINDOW = 24 * 60 * 60 * 1000; // 24 hours

// Cleanup old entries every hour
setInterval(() => {
  const now = Date.now();
  for (const [ip, data] of demoUsage.entries()) {
    if (now - data.firstUsed > DEMO_WINDOW) demoUsage.delete(ip);
  }
}, 60 * 60 * 1000);

app.post('/api/demo', async (req, res) => {
  const ip = req.headers['x-forwarded-for']?.split(',')[0]?.trim() || req.socket.remoteAddress || 'unknown';
  const now = Date.now();
  const usage = demoUsage.get(ip);

  if (usage) {
    if (now - usage.firstUsed > DEMO_WINDOW) {
      // Reset after 24 hours
      demoUsage.set(ip, { count: 1, firstUsed: now });
    } else if (usage.count >= DEMO_LIMIT) {
      return res.status(429).json({ error: 'limit', message: 'Demo-Limit erreicht. Bitte Abonnement starten.' });
    } else {
      usage.count++;
    }
  } else {
    demoUsage.set(ip, { count: 1, firstUsed: now });
  }

  const remaining = DEMO_LIMIT - (demoUsage.get(ip)?.count || 0);
  const apiKey = process.env.ANTHROPIC_API_KEY;
  if (!apiKey) return res.status(500).json({ error: 'ANTHROPIC_API_KEY fehlt' });
  try {
    const r = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'x-api-key': apiKey, 'anthropic-version': '2023-06-01' },
      body: JSON.stringify(req.body)
    });
    const data = await r.json();
    data.demoRemaining = remaining;
    res.json(data);
  } catch (e) { res.status(500).json({ error: e.message }); }
});

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

app.get('/api/image', async (req, res) => {
  const unsplashKey = process.env.UNSPLASH_ACCESS_KEY;
  try {
    if (unsplashKey) {
      const orientation = req.query.orientation || 'portrait';
      const r = await fetch(`https://api.unsplash.com/photos/random?query=${encodeURIComponent(req.query.q || 'abstract')}&orientation=${orientation}&client_id=${unsplashKey}`);
      const d = await r.json();
      if (d.urls) {
        // Return full size for HD rendering
        const url = d.urls.full || d.urls.regular;
        // Add CORS headers to allow canvas use
        res.setHeader('Access-Control-Allow-Origin', '*');
        return res.json({ url, credit: d.user?.name || '' });
      }
    }
    res.json({ url: null });
  } catch { res.json({ url: null }); }
});

app.get('/', (req, res) => res.sendFile('landingpage.html', { root: 'public' }));
app.get('/app', (req, res) => res.sendFile('index.html', { root: 'public' }));
app.get('/setup', (req, res) => res.sendFile('index.html', { root: 'public' }));

// Image proxy to avoid CORS issues with canvas
app.get('/api/image-proxy', async (req, res) => {
  try {
    const url = req.query.url;
    if (!url) return res.status(400).send('No URL');
    const r = await fetch(url);
    const buf = await r.buffer();
    res.setHeader('Content-Type', r.headers.get('content-type') || 'image/jpeg');
    res.setHeader('Access-Control-Allow-Origin', '*');
    res.setHeader('Cache-Control', 'public, max-age=86400');
    res.send(buf);
  } catch (e) { res.status(500).send('Error'); }
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`PinCreator läuft auf Port ${PORT}`));
