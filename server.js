import 'dotenv/config';
import express from 'express';
import cors from 'cors';
import bcrypt from 'bcryptjs';
import jwt from 'jsonwebtoken';
import { neon } from '@neondatabase/serverless';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const app = express();
const PORT = Number(process.env.PORT || 3000);
const JWT_SECRET = process.env.JWT_SECRET;
const DATABASE_URL = process.env.DATABASE_URL;
const __dirname = path.dirname(fileURLToPath(import.meta.url));
if (!DATABASE_URL || !JWT_SECRET) {
  console.error('Missing DATABASE_URL or JWT_SECRET. Copy .env.example to .env and fill them in.');
  process.exit(1);
}
const sql = neon(DATABASE_URL);
app.disable('x-powered-by');
app.use(express.json({ limit: '100kb' }));
const allowedOrigin = process.env.FRONTEND_ORIGIN;
app.use(cors({ origin(origin, cb) {
  // For a quick local setup, an unset FRONTEND_ORIGIN allows browser requests.
  // Set FRONTEND_ORIGIN in production to restrict cross-origin access to your deployed UI.
  if (!origin || !allowedOrigin || origin === allowedOrigin) return cb(null, true);
  return cb(new Error('Origin not allowed by CORS'));
} }));

await sql`CREATE TABLE IF NOT EXISTS users (
  id BIGSERIAL PRIMARY KEY,
  email TEXT UNIQUE NOT NULL,
  password_hash TEXT NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
)`;
await sql`CREATE TABLE IF NOT EXISTS saved_jobs (
  id BIGSERIAL PRIMARY KEY,
  user_id BIGINT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  job_key TEXT NOT NULL,
  job JSONB NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE(user_id, job_key)
)`;
await sql`CREATE TABLE IF NOT EXISTS shared_cache (
  cache_key TEXT PRIMARY KEY,
  payload JSONB NOT NULL,
  expires_at TIMESTAMPTZ NOT NULL,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
)`;

const CACHE_TTLS = { jobs: 12 * 60 * 60, news: 5 * 60, currency: 12 * 60 * 60, holidays: 24 * 60 * 60, paid: 5 * 60 };
async function cached(key, ttlSeconds, loader) {
  const rows = await sql`SELECT payload FROM shared_cache WHERE cache_key=${key} AND expires_at > NOW() LIMIT 1`;
  if (rows.length) return { data: rows[0].payload, cached: true };
  const payload = await loader();
  await sql`INSERT INTO shared_cache(cache_key,payload,expires_at,updated_at)
    VALUES(${key},${JSON.stringify(payload)}::jsonb,NOW() + (${ttlSeconds} * INTERVAL '1 second'),NOW())
    ON CONFLICT(cache_key) DO UPDATE SET payload=EXCLUDED.payload, expires_at=EXCLUDED.expires_at, updated_at=NOW()`;
  return { data: payload, cached: false };
}
async function fetchJson(url, options = {}) {
  const response = await fetch(url, { ...options, headers: { 'Accept': 'application/json', ...(options.headers || {}) }, signal: AbortSignal.timeout(12000) });
  const body = await response.text();
  if (!response.ok) throw new Error(`Upstream service returned HTTP ${response.status}`);
  if (!body.trim()) throw new Error('Upstream service returned an empty response');
  try { return JSON.parse(body); } catch { throw new Error('Upstream service returned invalid JSON'); }
}
function apiError(res, err) {
  console.error(err);
  res.status(502).json({ error: 'A data provider is temporarily unavailable. Please try again shortly.' });
}
function auth(req, res, next) {
  const value = req.headers.authorization || '';
  const token = value.startsWith('Bearer ') ? value.slice(7) : '';
  try {
    if (!token) throw new Error('Missing token');
    req.user = jwt.verify(token, JWT_SECRET);
    next();
  } catch { res.status(401).json({ error: 'Please sign in to use saved jobs.' }); }
}

app.get('/api/health', (_req, res) => res.json({ ok: true, service: 'Career Compass backend' }));

app.post('/api/auth/register', async (req, res) => {
  try {
    const email = String(req.body?.email || '').trim().toLowerCase();
    const password = String(req.body?.password || '');
    if (!/^\S+@\S+\.\S+$/.test(email)) return res.status(400).json({ error: 'Enter a valid email address.' });
    if (password.length < 10) return res.status(400).json({ error: 'Password must be at least 10 characters.' });
    if (password.length > 200) return res.status(400).json({ error: 'Password is too long.' });
    const hash = await bcrypt.hash(password, 12);
    const rows = await sql`INSERT INTO users(email,password_hash) VALUES(${email},${hash}) ON CONFLICT(email) DO NOTHING RETURNING id,email`;
    if (!rows.length) return res.status(409).json({ error: 'An account with this email already exists.' });
    const token = jwt.sign({ sub: String(rows[0].id), email: rows[0].email }, JWT_SECRET, { expiresIn: '7d' });
    res.status(201).json({ token, user: rows[0] });
  } catch (e) { apiError(res, e); }
});
app.post('/api/auth/login', async (req, res) => {
  try {
    const email = String(req.body?.email || '').trim().toLowerCase();
    const password = String(req.body?.password || '');
    const rows = await sql`SELECT id,email,password_hash FROM users WHERE email=${email} LIMIT 1`;
    if (!rows.length || !(await bcrypt.compare(password, rows[0].password_hash))) return res.status(401).json({ error: 'Email or password is incorrect.' });
    const token = jwt.sign({ sub: String(rows[0].id), email: rows[0].email }, JWT_SECRET, { expiresIn: '7d' });
    res.json({ token, user: { id: rows[0].id, email: rows[0].email } });
  } catch (e) { apiError(res, e); }
});
app.get('/api/auth/me', auth, (req, res) => res.json({ user: { id: req.user.sub, email: req.user.email } }));

app.get('/api/jobs', async (_req, res) => {
  try {
    const result = await cached('jobs:v1', CACHE_TTLS.jobs, async () => {
      const [remotive, arbeitnow] = await Promise.allSettled([
        fetchJson('https://remotive.com/api/remote-jobs?limit=20'),
        fetchJson('https://www.arbeitnow.com/api/job-board-api')
      ]);
      const jobs = [];
      if (remotive.status === 'fulfilled') for (const j of (remotive.value.jobs || [])) jobs.push({ title:j.title, company:j.company_name, location:j.candidate_required_location, type:j.job_type, url:j.url, source:'Remotive', date:j.publication_date, description:j.description });
      if (arbeitnow.status === 'fulfilled') for (const j of (arbeitnow.value.data || []).slice(0,60)) jobs.push({ title:j.title, company:j.company_name, location:j.location, type:(j.job_types || []).join(', ') || (j.remote ? 'Remote' : 'Not specified'), url:j.url, source:'Arbeitnow', date:j.created_at, description:j.description });
      if (!jobs.length) throw new Error('Both job sources failed');
      return jobs;
    });
    res.set('X-Shared-Cache', result.cached ? 'HIT' : 'MISS').json(result.data);
  } catch (e) { apiError(res, e); }
});
app.get('/api/news', async (_req, res) => {
  try {
    const result = await cached('news:top:v1', CACHE_TTLS.news, async () => {
      const ids = await fetchJson('https://hacker-news.firebaseio.com/v0/topstories.json');
      const stories = await Promise.allSettled(ids.slice(0, 8).map(id => fetchJson(`https://hacker-news.firebaseio.com/v0/item/${id}.json`)));
      const data = stories.filter(x => x.status === 'fulfilled' && x.value).map(x => x.value);
      if (!data.length) throw new Error('No stories returned');
      return data;
    });
    res.set('X-Shared-Cache', result.cached ? 'HIT' : 'MISS').json(result.data);
  } catch (e) { apiError(res, e); }
});
app.get('/api/currency', async (req, res) => {
  const base = String(req.query.base || 'USD').toUpperCase();
  const symbols = String(req.query.symbols || 'INR').toUpperCase();
  if (!/^[A-Z]{3}$/.test(base) || !/^[A-Z]{3}(,[A-Z]{3})*$/.test(symbols)) return res.status(400).json({ error: 'Invalid currency code.' });
  try {
    const key = `currency:v1:${base}:${symbols}`;
    const result = await cached(key, CACHE_TTLS.currency, () => fetchJson(`https://api.frankfurter.dev/v1/latest?base=${encodeURIComponent(base)}&symbols=${encodeURIComponent(symbols)}`));
    res.set('X-Shared-Cache', result.cached ? 'HIT' : 'MISS').json(result.data);
  } catch (e) { apiError(res, e); }
});
app.get('/api/holidays', async (req, res) => {
  const country = String(req.query.country || 'IN').toUpperCase();
  const year = Number(req.query.year || new Date().getFullYear());
  if (!/^[A-Z]{2}$/.test(country) || !Number.isInteger(year) || year < 2000 || year > 2100) return res.status(400).json({ error: 'Invalid country or year.' });
  try {
    const key = `holidays:v1:${country}:${year}`;
    const result = await cached(key, CACHE_TTLS.holidays, async () => {
      try { return await fetchJson(`https://nagerholidays.com/api/v4/Holidays/${country}/${year}`); }
      catch { return await fetchJson(`https://date.nager.at/api/v3/PublicHolidays/${year}/${country}`); }
    });
    res.set('X-Shared-Cache', result.cached ? 'HIT' : 'MISS').json(result.data);
  } catch (e) { apiError(res, e); }
});

app.get('/api/saved-jobs', auth, async (req, res) => {
  try {
    const rows = await sql`SELECT job_key,job,created_at FROM saved_jobs WHERE user_id=${Number(req.user.sub)} ORDER BY created_at DESC`;
    res.json(rows.map(r => ({ key:r.job_key, job:r.job, savedAt:r.created_at })));
  } catch (e) { apiError(res, e); }
});
app.post('/api/saved-jobs', auth, async (req, res) => {
  try {
    const job = req.body?.job;
    const key = String(req.body?.key || '').slice(0, 1500);
    if (!job || typeof job !== 'object' || !key) return res.status(400).json({ error: 'A job and key are required.' });
    await sql`INSERT INTO saved_jobs(user_id,job_key,job) VALUES(${Number(req.user.sub)},${key},${JSON.stringify(job)}::jsonb) ON CONFLICT(user_id,job_key) DO UPDATE SET job=EXCLUDED.job`;
    res.status(201).json({ ok: true });
  } catch (e) { apiError(res, e); }
});
app.delete('/api/saved-jobs/:key', auth, async (req, res) => {
  try {
    await sql`DELETE FROM saved_jobs WHERE user_id=${Number(req.user.sub)} AND job_key=${req.params.key}`;
    res.json({ ok: true });
  } catch (e) { apiError(res, e); }
});

// Optional paid provider proxy. Keep the provider key on the server only.
// Configure PAID_API_URL + PAID_API_KEY after choosing/provisioning a paid API.
app.get('/api/paid', async (req, res) => {
  if (!process.env.PAID_API_URL || !process.env.PAID_API_KEY) return res.status(503).json({ error: 'Paid provider is not configured yet. Set PAID_API_URL and PAID_API_KEY on the server.' });
  try {
    const base = new URL(process.env.PAID_API_URL);
    // Only pass harmless query parameters; never allow the browser to choose the upstream host.
    for (const [k, v] of Object.entries(req.query)) if (/^[a-zA-Z0-9_-]{1,40}$/.test(k) && typeof v === 'string' && v.length < 200) base.searchParams.set(k, v);
    const cacheKey = `paid:v1:${base.pathname}:${base.searchParams.toString()}`;
    const result = await cached(cacheKey, CACHE_TTLS.paid, () => fetchJson(base, { headers: { Authorization: `Bearer ${process.env.PAID_API_KEY}` } }));
    res.set('X-Shared-Cache', result.cached ? 'HIT' : 'MISS').json(result.data);
  } catch (e) { apiError(res, e); }
});

// Serve frontend and API from the same origin to avoid browser CORS issues.
app.use(express.static(path.join(__dirname, 'public')));
app.get('*path', (_req, res) => res.sendFile(path.join(__dirname, 'public', 'index.html')));
app.listen(PORT, () => console.log(`Career Compass backend running at http://localhost:${PORT}`));
