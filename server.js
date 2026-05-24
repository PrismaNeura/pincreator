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
  starter:   { name: 'Starter',   price: 7,  limit: 500 },
  standard:  { name: 'Standard',  price: 12, limit: 1000 },
  pro:       { name: 'Pro',       price: 19, limit: 2000 },
  unlimited: { name: 'Unlimited', price: 29, limit: Infinity }
};

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

    // Reset pins if new month
    const resetDate = new Date(user.pins_reset_date || 0);
    if (new Date() >= resetDate) {
      const nextReset = new Date();
      nextReset.setMonth(nextReset.getMonth() + 1);
      nextReset.setDate(1);
      await supabaseFetch(`/users?id=eq.${user.id}`, 'PATCH', { pins_used: 0, pins_reset_date: nextReset.toISOString() }, true);
      user.pins_used = 0;
    }

    const plan = PLANS[user.plan || 'starter'];
    const isAdmin = email.toLowerCase() === ADMIN_EMAIL;
    res.json({
      success: true, email: user.email,
      plan: user.plan || 'starter',
      planName: plan.name,
      pinsUsed: isAdmin ? 0 : (user.pins_used || 0),
      pinsLimit: isAdmin ? Infinity : plan.limit,
      isAdmin
    });
  } catch (e) { res.status(500).json({ success: false, error: e.message }); }
});

// PASSWORT SETZEN
app.post('/api/set-password', async (req, res) => {
  const { email, password, token } = req.body;
  if (!email || !password || !token) return res.status(400).json({ success: false, error: 'Fehlende Daten' });
  try {
    const users = await supabaseFetch(`/users?email=eq.${encodeURIComponent(email.toLowerCase())}&setup_token=eq.${token}&select=id`, 'GET', null, true);
    if (!users || !users.length) return res.json({ success: false, error: 'Ungültiger oder abgelaufener Link' });
    const hash = hashPassword(password);
    await supabaseFetch(`/users?id=eq.${users[0].id}`, 'PATCH', { password_hash: hash, setup_token: null, active: true }, true);
    res.json({ success: true });
  } catch (e) { res.status(500).json({ success: false, error: e.message }); }
});

// PIN COUNTER
app.post('/api/count-pins', async (req, res) => {
  const { email, count } = req.body;
  if (!email || email.toLowerCase() === ADMIN_EMAIL) return res.json({ success: true, isAdmin: true });
  try {
    const users = await supabaseFetch(`/users?email=eq.${encodeURIComponent(email.toLowerCase())}&select=id,plan,pins_used,pins_reset_date`, 'GET', null, true);
    if (!users || !users.length) return res.json({ success: false, error: 'User nicht gefunden' });
    const user = users[0];
    const plan = PLANS[user.plan || 'starter'];
    const currentUsed = user.pins_used || 0;
    const newUsed = currentUsed + (count || 1);

    if (plan.limit !== Infinity && newUsed > plan.limit) {
      return res.json({ success: false, limitReached: true, error: `Dein ${plan.name}-Plan erlaubt ${plan.limit} Pins/Monat. Bitte upgraden!`, pinsUsed: currentUsed, pinsLimit: plan.limit });
    }

    await supabaseFetch(`/users?id=eq.${user.id}`, 'PATCH', { pins_used: newUsed }, true);

    // Warning at 80%
    const warning = plan.limit !== Infinity && newUsed >= plan.limit * 0.8 && currentUsed < plan.limit * 0.8;
    if (warning) await sendEmail(email, 'PinCreator: Du hast 80% deines Limits erreicht', `Hallo!\n\nDu hast ${newUsed} von ${plan.limit} Pins in diesem Monat erstellt (80%).\n\nUpgrade auf einen höheren Plan:\nhttps://gumroad.com/l/oktubc\n\nViele Grüße,\nDas PinCreator Team`);

    res.json({ success: true, pinsUsed: newUsed, pinsLimit: plan.limit, warning });
  } catch (e) { res.status(500).json({ success: false, error: e.message }); }
});

// CHECK LIMIT
app.post('/api/check-limit', async (req, res) => {
  const { email, count } = req.body;
  if (!email || email.toLowerCase() === ADMIN_EMAIL) return res.json({ allowed: true, isAdmin: true });
  try {
    const users = await supabaseFetch(`/users?email=eq.${encodeURIComponent(email.toLowerCase())}&select=plan,pins_used`, 'GET', null, true);
    if (!users || !users.length) return res.json({ allowed: false });
    const user = users[0];
    const plan = PLANS[user.plan || 'starter'];
    const currentUsed = user.pins_used || 0;
    if (plan.limit !== Infinity && currentUsed + (count || 1) > plan.limit) {
      return res.json({ allowed: false, limitReached: true, pinsUsed: currentUsed, pinsLimit: plan.limit, planName: plan.name });
    }
    res.json({ allowed: true, pinsUsed: currentUsed, pinsLimit: plan.limit });
  } catch (e) { res.json({ allowed: true }); }
});

// GUMROAD WEBHOOK
app.post('/webhook/gumroad', (req, res) => {
  res.status(200).send('OK');
  setImmediate(async () => {
    const data = req.body;
    const email = (data.email || '').toLowerCase();
    if (!email) return;
    console.log('Webhook empfangen:', JSON.stringify(data));
    try {
      const resourceName = data.resource_name;
      if (resourceName === 'sale') {
        const setupToken = crypto.randomBytes(32).toString('hex');
        const expiresAt = new Date();
        expiresAt.setMonth(expiresAt.getMonth() + 1);

        // Determine plan from price
        const price = parseFloat(data.price || 0) / 100;
        let plan = 'starter';
        if (price >= 29) plan = 'unlimited';
        else if (price >= 19) plan = 'pro';
        else if (price >= 12) plan = 'standard';

        const existing = await supabaseFetch(`/users?email=eq.${encodeURIComponent(email)}&select=id`, 'GET', null, true);
        if (existing && existing.length) {
          await supabaseFetch(`/users?id=eq.${existing[0].id}`, 'PATCH', { active: true, gumroad_sale_id: data.sale_id, expires_at: expiresAt.toISOString(), setup_token: setupToken, plan, pins_used: 0 }, true);
        } else {
          await supabaseFetch('/users', 'POST', { email, password_hash: crypto.randomBytes(32).toString('hex'), active: false, gumroad_sale_id: data.sale_id, expires_at: expiresAt.toISOString(), setup_token: setupToken, plan, pins_used: 0 }, true);
        }
        const setupLink = `https://boostyourpins.de/setup?email=${encodeURIComponent(email)}&token=${setupToken}`;
        await sendEmail(email, 'Willkommen bei PinCreator!', `Hallo!\n\nVielen Dank für deinen Kauf des ${PLANS[plan].name}-Plans! 🎉\n\nDein Plan: ${PLANS[plan].name} (${PLANS[plan].limit === Infinity ? 'Unbegrenzt' : PLANS[plan].limit + ' Pins/Monat'})\n\nKlicke hier um dein Passwort festzulegen:\n\n${setupLink}\n\nViel Erfolg!\nDas PinCreator Team`);
      } else if (['subscription_cancelled', 'subscription_ended', 'refund'].includes(resourceName)) {
        await supabaseFetch(`/users?email=eq.${encodeURIComponent(email)}`, 'PATCH', { active: false }, true);
        await sendEmail(email, 'PinCreator Abonnement beendet', `Hallo!\n\nDein Abonnement wurde beendet.\n\nJederzeit wieder aktivieren:\nhttps://gumroad.com/l/oktubc\n\nViele Grüße,\nDas PinCreator Team`);
      }
    } catch (e) { console.error('Webhook Fehler:', e); }
  });
});

// EMAIL
async function sendEmail(to, subject, text) {
  try {
    const r = await fetch('https://api.brevo.com/v3/smtp/email', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'api-key': process.env.BREVO_SMTP_KEY },
      body: JSON.stringify({ sender: { name: 'PinCreator', email: 'hallo@boostyourpins.de' }, to: [{ email: to }], subject, textContent: text })
    });
    const d = await r.json();
    console.log('E-Mail gesendet:', JSON.stringify(d));
  } catch (e) { console.error('E-Mail Fehler:', e.message); }
}

// ANTHROPIC PROXY
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

// UNSPLASH PROXY
app.get('/api/image', async (req, res) => {
  const unsplashKey = process.env.UNSPLASH_ACCESS_KEY;
  try {
    if (unsplashKey) {
      const r = await fetch(`https://api.unsplash.com/photos/random?query=${encodeURIComponent(req.query.q || 'abstract')}&orientation=portrait&client_id=${unsplashKey}`);
      const d = await r.json();
      if (d.urls) return res.json({ url: d.urls.regular });
    }
    res.json({ url: null });
  } catch { res.json({ url: null }); }
});

// SETUP ROUTE
app.get('/setup', (req, res) => res.sendFile('index.html', { root: 'public' }));

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`PinCreator läuft auf Port ${PORT}`));
