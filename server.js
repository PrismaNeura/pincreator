const express = require('express');
const fetch = (...args) => import('node-fetch').then(({ default: f }) => f(...args));
const crypto = require('crypto');
const nodemailer = require('nodemailer');

const app = express();
app.use(express.json());
app.use(express.urlencoded({ extended: true }));
app.use(express.static('public'));

const SUPABASE_URL = 'https://hinhbgfvgffjrdguetgv.supabase.co';

function hashPassword(password) {
  return crypto.createHash('sha256').update(password + 'pincreator_salt_2026').digest('hex');
}

async function supabaseFetch(path, method, body, useServiceRole = false) {
  const key = useServiceRole ? process.env.SUPABASE_SERVICE_KEY : process.env.SUPABASE_ANON_KEY;
  const r = await fetch(`${SUPABASE_URL}/rest/v1${path}`, {
    method,
    headers: {
      'Content-Type': 'application/json',
      'apikey': key,
      'Authorization': `Bearer ${key}`,
      'Prefer': 'return=representation'
    },
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
    const users = await supabaseFetch(
      `/users?email=eq.${encodeURIComponent(email.toLowerCase())}&password_hash=eq.${hash}&select=id,email,active,expires_at`,
      'GET', null, true
    );
    if (!users || !users.length) return res.json({ success: false, error: 'E-Mail oder Passwort falsch' });
    const user = users[0];
    if (!user.active) return res.json({ success: false, error: 'Dein Account ist nicht aktiv. Bitte kaufe ein Abonnement auf Gumroad.' });
    if (user.expires_at && new Date(user.expires_at) < new Date()) return res.json({ success: false, error: 'Dein Abonnement ist abgelaufen.' });
    res.json({ success: true, email: user.email });
  } catch (e) { res.status(500).json({ success: false, error: e.message }); }
});

// PASSWORT SETZEN
app.post('/api/set-password', async (req, res) => {
  const { email, password, token } = req.body;
  if (!email || !password || !token) return res.status(400).json({ success: false, error: 'Fehlende Daten' });
  try {
    const users = await supabaseFetch(
      `/users?email=eq.${encodeURIComponent(email.toLowerCase())}&setup_token=eq.${token}&select=id`,
      'GET', null, true
    );
    if (!users || !users.length) return res.json({ success: false, error: 'Ungültiger oder abgelaufener Link' });
    const hash = hashPassword(password);
    await supabaseFetch(`/users?id=eq.${users[0].id}`, 'PATCH', { password_hash: hash, setup_token: null, active: true }, true);
    res.json({ success: true });
  } catch (e) { res.status(500).json({ success: false, error: e.message }); }
});

// GUMROAD WEBHOOK
app.post('/webhook/gumroad', (req, res) => {
  res.status(200).send('OK');
  console.log('Webhook empfangen:', JSON.stringify(req.body));
  // Im Hintergrund weiterlaufen
  setImmediate(async () => {
    const data = req.body;
    const email = (data.email || '').toLowerCase();
    if (!email) return;
    try {
      const resourceName = data.resource_name;
      if (resourceName === 'sale') {
        const setupToken = crypto.randomBytes(32).toString('hex');
        const expiresAt = new Date();
        expiresAt.setMonth(expiresAt.getMonth() + 1);
        const existing = await supabaseFetch(`/users?email=eq.${encodeURIComponent(email)}&select=id`, 'GET', null, true);
        if (existing && existing.length) {
          await supabaseFetch(`/users?id=eq.${existing[0].id}`, 'PATCH', { active: true, gumroad_sale_id: data.sale_id, expires_at: expiresAt.toISOString(), setup_token: setupToken }, true);
        } else {
          await supabaseFetch('/users', 'POST', { email, password_hash: crypto.randomBytes(32).toString('hex'), active: false, gumroad_sale_id: data.sale_id, expires_at: expiresAt.toISOString(), setup_token: setupToken }, true);
        }
        const setupLink = `https://pincreator.onrender.com/setup?email=${encodeURIComponent(email)}&token=${setupToken}`;
        await sendEmail(email, 'Willkommen bei PinCreator!', `Hallo!\n\nVielen Dank für deinen Kauf! 🎉\n\nKlicke hier um dein Passwort festzulegen:\n\n${setupLink}\n\nViel Erfolg!\nAnne Claus`);
      } else if (['subscription_cancelled', 'subscription_ended', 'refund'].includes(resourceName)) {
        await supabaseFetch(`/users?email=eq.${encodeURIComponent(email)}`, 'PATCH', { active: false }, true);
        await sendEmail(email, 'PinCreator Abonnement beendet', `Hallo!\n\nDein Abonnement wurde beendet.\n\nJederzeit wieder aktivieren:\nhttps://gumroad.com/l/oktubc\n\nViele Grüße,\nAnne Claus`);
      }
    } catch(e) { console.error('Webhook Hintergrund-Fehler:', e); }
  });
});
async function sendEmail(to, subject, text) {
  try {
    const transporter = nodemailer.createTransport({
      host: 'smtp-relay.brevo.com',
      port: 587,
      secure: false,
      auth: {
        user: 'boostupyourpins@gmx.de',
        pass: process.env.BREVO_SMTP_KEY
      }
    });
    await transporter.sendMail({
      from: 'PinCreator <boostupyourpins@gmx.de>',
      to,
      subject,
      text
    });
    console.log('E-Mail gesendet an:', to);
  } catch(e) {
    console.error('E-Mail Fehler:', e.message);
  }
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

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`PinCreator läuft auf Port ${PORT}`));
