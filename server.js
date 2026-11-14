const express = require('express');
const cron = require('node-cron');
const cheerio = require('cheerio');
const fs = require('node:fs/promises');
const fsSync = require('node:fs');
const path = require('node:path');
const bcrypt = require('bcryptjs');
const session = require('express-session');
const SQLiteStore = require('connect-sqlite3')(session);
const Database = require('better-sqlite3');
const helmet = require('helmet');
const { rateLimit } = require('express-rate-limit');

const app = express();
const PORT = Number(process.env.PORT) || 3000;
const CHECK_INTERVAL_MINUTES = Math.max(5, Math.min(59, Number(process.env.CHECK_INTERVAL_MINUTES) || 30));
const DATA_DIR = process.env.DATA_DIR || path.join(__dirname, 'data');
const DATA_FILE = path.join(DATA_DIR, 'circulars.json');
const MAX_PAGE_BYTES = 3 * 1024 * 1024;
const REQUEST_TIMEOUT_MS = 12000;
const IS_PRODUCTION = process.env.NODE_ENV === 'production';
const SESSION_SECRET = process.env.SESSION_SECRET;

if (IS_PRODUCTION && (!SESSION_SECRET || SESSION_SECRET.length < 32)) {
  throw new Error('Set SESSION_SECRET to a random secret of at least 32 characters in production.');
}
if (!SESSION_SECRET) console.warn('Using a development-only session secret. Set SESSION_SECRET before deployment.');

// Ensure the persistent session store can be constructed before middleware registration.
fsSync.mkdirSync(DATA_DIR, { recursive: true });
const sessionStore = new SQLiteStore({ db: 'sessions.sqlite', dir: DATA_DIR, table: 'sessions', concurrentDB: true });
const database = new Database(path.join(DATA_DIR, 'users.sqlite'));
database.pragma('journal_mode = WAL');
database.pragma('foreign_keys = ON');
database.exec(`CREATE TABLE IF NOT EXISTS users (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  email TEXT NOT NULL UNIQUE COLLATE NOCASE,
  password_hash TEXT NOT NULL,
  display_name TEXT NOT NULL,
  target_university TEXT,
  personal_exam_date TEXT,
  study_goal_minutes INTEGER NOT NULL DEFAULT 120,
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
)`);

const SOURCES = [
  { id: 'du', name: 'University of Dhaka (DU)', noticeUrl: 'https://www.du.ac.bd/notice', admissionUrl: 'https://admission.eis.du.ac.bd', exams: [{ date: '2026-12-05', label: 'IBA' }, { date: '2026-12-12', label: 'Science (A)' }, { date: '2026-12-19', label: 'Arts, Law & Social Science (B)' }, { date: '2026-12-22', label: 'Fine Arts' }, { date: '2026-12-26', label: 'Business Studies (C)' }], scheduleStatus: 'reported' },
  { id: 'ru', name: 'University of Rajshahi (RU)', noticeUrl: 'https://admission.ru.ac.bd', admissionUrl: 'https://admission.ru.ac.bd/undergraduate/', exams: [{ date: '2027-01-08', label: 'B Unit' }, { date: '2027-01-09', label: 'C Unit' }, { date: '2027-01-16', label: 'A Unit' }], scheduleStatus: 'reported' },
  { id: 'cu', name: 'University of Chittagong (CU)', noticeUrl: 'https://cu.ac.bd/notice/', admissionUrl: 'https://admission.cu.ac.bd', exams: [{ date: '2027-01-29', label: 'C Unit' }, { date: '2027-01-30', label: 'A Unit' }, { date: '2027-02-03', label: 'B1 Sub-unit' }, { date: '2027-02-04', label: 'B2 Sub-unit' }, { date: '2027-02-05', label: 'B Unit' }, { date: '2027-02-06', label: 'D Unit' }, { date: '2027-02-08', label: 'D1 Sub-unit' }], scheduleStatus: 'reported' },
  { id: 'ju', name: 'Jahangirnagar University (JU)', noticeUrl: 'https://juniv.edu/notice', admissionUrl: 'https://juniv-admission.org', exams: [], scheduleStatus: 'unannounced' },
  { id: 'jnu', name: 'Jagannath University (JnU)', noticeUrl: 'https://www.jnu.ac.bd/notice/', admissionUrl: 'https://admission.jnu.ac.bd', exams: [{ date: '2027-01-01', label: 'A Unit' }, { date: '2027-01-08', label: 'E Unit' }, { date: '2027-01-15', label: 'B Unit' }, { date: '2027-01-22', label: 'C Unit' }, { date: '2027-01-23', label: 'D Unit' }], scheduleStatus: 'reported' },
  { id: 'ku', name: 'Khulna University (KU)', noticeUrl: 'https://ku.ac.bd/notice', admissionUrl: 'https://admission.ku.ac.bd', exams: [{ date: '2026-12-17', label: 'C & D Units' }, { date: '2026-12-18', label: 'Other units' }], scheduleStatus: 'reported' },
  { id: 'bup', name: 'Bangladesh University of Professionals (BUP)', noticeUrl: 'https://bup.edu.bd/Home/Notice', admissionUrl: 'https://admission.bup.edu.bd/', exams: [], scheduleStatus: 'unannounced' },
  { id: 'buet', name: 'Bangladesh University of Engineering and Technology (BUET)', noticeUrl: 'https://www.buet.ac.bd/web/#/notice', admissionUrl: 'https://ugadmission.buet.ac.bd', exams: [{ date: '2027-01-16', label: 'Tentative date' }], scheduleStatus: 'tentative' },
  { id: 'cuet', name: 'Chittagong University of Engineering & Technology (CUET)', noticeUrl: 'https://www.cuet.ac.bd/notice', admissionUrl: 'https://www.cuet.ac.bd/admission', exams: [], scheduleStatus: 'unannounced' },
  { id: 'ruet', name: 'Rajshahi University of Engineering & Technology (RUET)', noticeUrl: 'https://www.ruet.ac.bd/notices', admissionUrl: 'https://admission.ruet.ac.bd/', exams: [], scheduleStatus: 'unannounced' },
  { id: 'kuet', name: 'Khulna University of Engineering & Technology (KUET)', noticeUrl: 'https://www.kuet.ac.bd/component/all-notice', admissionUrl: 'https://www.kuet.ac.bd/admission/', exams: [{ date: '2027-01-08', label: 'Admission test' }], scheduleStatus: 'reported' },
  { id: 'butex', name: 'Bangladesh University of Textiles (BUTEX)', noticeUrl: 'https://www.butex.edu.bd/category/notices/', admissionUrl: 'https://www.butex.edu.bd/admission/', exams: [], scheduleStatus: 'unannounced' },
  { id: 'mist', name: 'Military Institute of Science and Technology (MIST)', noticeUrl: 'https://mist.ac.bd/allnotice', admissionUrl: 'https://admission.mist.ac.bd', exams: [{ date: '2026-12-18', label: 'C/A/B Units' }, { date: '2026-12-19', label: 'C/A/B Units' }], scheduleStatus: 'reported' },
  { id: 'agri', name: 'Agricultural Universities Admission System', noticeUrl: 'https://admission-agri.org', admissionUrl: 'https://admission-agri.org', exams: [], scheduleStatus: 'unannounced' },
  { id: 'gst', name: 'GST Universities Admission System', noticeUrl: 'https://gstadmission.ac.bd', admissionUrl: 'https://gstadmission.ac.bd', exams: [{ date: '2027-03-19', label: 'Tentative window start' }, { date: '2027-03-27', label: 'Tentative window end' }], scheduleStatus: 'tentative' }
];

function dateKeyInDhaka(date = new Date()) {
  return new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Dhaka', year: 'numeric', month: '2-digit', day: '2-digit' }).format(date);
}
function addCountdown(source) {
  const nextExam = source.exams.find(exam => exam.date >= dateKeyInDhaka()) || null;
  const target = nextExam ? Date.parse(`${nextExam.date}T00:00:00+06:00`) : null;
  return { ...source, nextExam: nextExam ? { ...nextExam, daysLeft: Math.max(0, Math.ceil((target - Date.now()) / 86400000)) } : null };
}

let db = { circulars: [], lastCheckedAt: null, sourceStatus: {} };
let checkInProgress = false;
app.disable('x-powered-by');
if (IS_PRODUCTION) app.set('trust proxy', 1);
app.use(helmet({ contentSecurityPolicy: false, crossOriginEmbedderPolicy: false }));
app.use(express.json({ limit: '16kb', strict: true }));
app.use(session({
  name: 'admission.sid',
  secret: SESSION_SECRET || 'local-development-secret-change-before-deploy-000000000000',
  store: sessionStore,
  resave: false,
  saveUninitialized: false,
  cookie: { httpOnly: true, secure: IS_PRODUCTION, sameSite: 'lax', maxAge: 7 * 24 * 60 * 60 * 1000, path: '/' }
}));

const authLimiter = rateLimit({ windowMs: 15 * 60 * 1000, limit: 10, standardHeaders: true, legacyHeaders: false, message: { error: 'Too many sign-in attempts. Try again later.' } });
const manualCheckLimiter = rateLimit({ windowMs: 5 * 60 * 1000, limit: 1, standardHeaders: true, legacyHeaders: false, message: { error: 'Please wait a few minutes before requesting another check.' } });
function requireSameOrigin(req, res, next) {
  const origin = req.get('origin');
  if (!origin) return res.status(403).json({ error: 'Origin header is required.' });
  try {
    if (new URL(origin).origin !== `${req.protocol}://${req.get('host')}`) return res.status(403).json({ error: 'Cross-origin request rejected.' });
  } catch { return res.status(403).json({ error: 'Invalid request origin.' }); }
  next();
}
function requireAuth(req, res, next) {
  if (!req.session.userId) return res.status(401).json({ error: 'Please sign in first.' });
  next();
}
function publicUser(row) {
  return { id: row.id, email: row.email, displayName: row.display_name, targetUniversity: row.target_university, personalExamDate: row.personal_exam_date, studyGoalMinutes: row.study_goal_minutes };
}
function validDateOrNull(value) {
  if (value === null || value === '') return null;
  if (typeof value !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(value)) return undefined;
  const date = new Date(`${value}T00:00:00Z`);
  return Number.isNaN(date.getTime()) || date.toISOString().slice(0, 10) !== value ? undefined : value;
}

app.post('/api/auth/register', authLimiter, requireSameOrigin, async (req, res, next) => {
  try {
    const email = String(req.body.email || '').trim().toLowerCase();
    const displayName = String(req.body.displayName || '').trim();
    const password = req.body.password;
    if (displayName.length < 2 || displayName.length > 60) return res.status(400).json({ error: 'Name must be 2–60 characters.' });
    if (email.length > 254 || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) return res.status(400).json({ error: 'Enter a valid email address.' });
    if (typeof password !== 'string' || password.length < 12 || password.length > 128) return res.status(400).json({ error: 'Password must be 12–128 characters.' });
    const hash = await bcrypt.hash(password, 12);
    let result;
    try { result = database.prepare('INSERT INTO users (email, password_hash, display_name) VALUES (?, ?, ?)').run(email, hash, displayName); }
    catch (error) {
      if (error.code === 'SQLITE_CONSTRAINT_UNIQUE') return res.status(409).json({ error: 'An account with that email already exists.' });
      throw error;
    }
    req.session.regenerate(err => {
      if (err) return next(err);
      req.session.userId = Number(result.lastInsertRowid);
      req.session.save(saveError => {
        if (saveError) return next(saveError);
        res.status(201).json({ user: publicUser(database.prepare('SELECT * FROM users WHERE id = ?').get(req.session.userId)) });
      });
    });
  } catch (error) { next(error); }
});

const DUMMY_PASSWORD_HASH = bcrypt.hashSync('dummy-account-password-never-valid', 12);
app.post('/api/auth/login', authLimiter, requireSameOrigin, async (req, res, next) => {
  try {
    const email = String(req.body.email || '').trim().toLowerCase();
    const password = req.body.password;
    if (email.length > 254 || typeof password !== 'string' || password.length > 128) return res.status(400).json({ error: 'Invalid email or password.' });
    const user = database.prepare('SELECT * FROM users WHERE email = ?').get(email);
    const validPassword = await bcrypt.compare(password, user ? user.password_hash : DUMMY_PASSWORD_HASH);
    if (!user || !validPassword) return res.status(401).json({ error: 'Invalid email or password.' });
    req.session.regenerate(err => {
      if (err) return next(err);
      req.session.userId = user.id;
      req.session.save(saveError => {
        if (saveError) return next(saveError);
        res.json({ user: publicUser(user) });
      });
    });
  } catch (error) { next(error); }
});
app.post('/api/auth/logout', requireSameOrigin, (req, res, next) => {
  req.session.destroy(error => {
    if (error) return next(error);
    res.clearCookie('admission.sid', { httpOnly: true, secure: IS_PRODUCTION, sameSite: 'lax', path: '/' });
    res.status(204).end();
  });
});
app.get('/api/auth/me', (req, res) => {
  if (!req.session.userId) return res.json({ user: null });
  const user = database.prepare('SELECT * FROM users WHERE id = ?').get(req.session.userId);
  if (!user) return req.session.destroy(() => res.json({ user: null }));
  res.json({ user: publicUser(user) });
});
app.get('/api/profile', requireAuth, (req, res) => {
  const user = database.prepare('SELECT * FROM users WHERE id = ?').get(req.session.userId);
  if (!user) return res.status(401).json({ error: 'Account not found.' });
  res.json({ user: publicUser(user) });
});
app.put('/api/profile', requireSameOrigin, requireAuth, (req, res) => {
  const displayName = String(req.body.displayName || '').trim();
  const targetUniversity = String(req.body.targetUniversity || '').trim();
  const personalExamDate = validDateOrNull(req.body.personalExamDate);
  const studyGoalMinutes = Number(req.body.studyGoalMinutes);
  if (displayName.length < 2 || displayName.length > 60) return res.status(400).json({ error: 'Name must be 2–60 characters.' });
  if (targetUniversity && !SOURCES.some(source => source.id === targetUniversity)) return res.status(400).json({ error: 'Choose a listed university.' });
  if (personalExamDate === undefined) return res.status(400).json({ error: 'Exam date must be a valid YYYY-MM-DD date.' });
  if (!Number.isInteger(studyGoalMinutes) || studyGoalMinutes < 0 || studyGoalMinutes > 1440) return res.status(400).json({ error: 'Study goal must be between 0 and 1440 minutes.' });
  database.prepare('UPDATE users SET display_name = ?, target_university = ?, personal_exam_date = ?, study_goal_minutes = ? WHERE id = ?')
    .run(displayName, targetUniversity || null, personalExamDate, studyGoalMinutes, req.session.userId);
  res.json({ user: publicUser(database.prepare('SELECT * FROM users WHERE id = ?').get(req.session.userId)) });
});
app.get('/profile', (_req, res) => res.sendFile(path.join(__dirname, 'public', 'profile.html')));
app.use(express.static(path.join(__dirname, 'public'), { dotfiles: 'ignore', index: 'index.html', maxAge: IS_PRODUCTION ? '1h' : 0 }));

async function persist() {
  await fs.mkdir(DATA_DIR, { recursive: true });
  const tempFile = `${DATA_FILE}.tmp`;
  await fs.writeFile(tempFile, JSON.stringify(db, null, 2), { mode: 0o600 });
  await fs.rename(tempFile, DATA_FILE);
}
async function loadData() {
  await fs.mkdir(DATA_DIR, { recursive: true });
  try {
    const parsed = JSON.parse(await fs.readFile(DATA_FILE, 'utf8'));
    db = { circulars: Array.isArray(parsed.circulars) ? parsed.circulars : [], lastCheckedAt: parsed.lastCheckedAt || null, sourceStatus: parsed.sourceStatus && typeof parsed.sourceStatus === 'object' ? parsed.sourceStatus : {} };
  } catch (error) {
    if (error.code !== 'ENOENT') console.error('Could not read circular database:', error.message);
    await persist();
  }
}
function isAllowedLink(candidate, source) {
  try {
    const url = new URL(candidate);
    const hosts = [new URL(source.noticeUrl).hostname, new URL(source.admissionUrl).hostname].map(host => host.replace(/^www\./, ''));
    const host = url.hostname.replace(/^www\./, '');
    return url.protocol === 'https:' && hosts.some(allowed => host === allowed || host.endsWith(`.${allowed}`));
  } catch { return false; }
}
async function inspectSource(source) {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);
  try {
    const response = await fetch(source.noticeUrl, { signal: controller.signal, redirect: 'follow', headers: { 'User-Agent': 'AdmissionTracker/1.0 (official admission circular link checker)', Accept: 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8' } });
    if (!response.ok) throw new Error(`HTTP ${response.status}`);
    if (!isAllowedLink(response.url, source)) throw new Error('Redirected to an unapproved host');
    const contentType = response.headers.get('content-type') || '';
    if (!contentType.includes('text/html') && !contentType.includes('xml')) throw new Error(`Unsupported response type: ${contentType}`);
    const declaredLength = Number(response.headers.get('content-length'));
    if (declaredLength > MAX_PAGE_BYTES) throw new Error('Page is too large to inspect');
    const html = await response.text();
    if (Buffer.byteLength(html, 'utf8') > MAX_PAGE_BYTES) throw new Error('Page is too large to inspect');
    const $ = cheerio.load(html);
    const found = [];
    const circularKeywords = /(admission.{0,20}(circular|prospectus|notice)|(?:circular|prospectus).{0,20}admission|ভর্তি.{0,20}(বিজ্ঞপ্তি|নির্দেশিকা)|ভর্তি বিজ্ঞপ্তি)/i;
    const excludedKeywords = /result|merit list|waiting list|scholarship|stipend|seat plan|admit card|hall ticket|ফলাফল|মেধা তালিকা/i;
    $('a[href]').each((_, element) => {
      if (found.length >= 30) return false;
      const title = $(element).text().replace(/\s+/g, ' ').trim();
      const href = $(element).attr('href');
      if (!title || !href || title.length < 5) return;
      const combined = `${title} ${href}`;
      if (!circularKeywords.test(combined) || excludedKeywords.test(combined)) return;
      let url;
      try { url = new URL(href, response.url).toString(); } catch { return; }
      if (!isAllowedLink(url, source) || url === source.noticeUrl || url === source.admissionUrl) return;
      found.push({ title, url, category: 'Admission Circular' });
    });
    return { found, status: { ok: true, checkedAt: new Date().toISOString(), message: found.length ? `${found.length} admission circular page(s) found` : 'No admission circular pages detected' } };
  } finally { clearTimeout(timeout); }
}
async function checkAllSources() {
  if (checkInProgress) return { skipped: true, message: 'A circular check is already running.' };
  checkInProgress = true;
  let added = 0;
  try {
    for (const source of SOURCES) {
      try {
        const result = await inspectSource(source);
        db.sourceStatus[source.id] = result.status;
        for (const item of result.found) {
          const id = `${source.id}:${item.url}`;
          if (db.circulars.some(existing => existing.id === id)) continue;
          db.circulars.unshift({ id, university: source.name, universityId: source.id, title: item.title, category: item.category, url: item.url, sourceUrl: source.noticeUrl, discoveredAt: new Date().toISOString() });
          added++;
        }
      } catch (error) {
        db.sourceStatus[source.id] = { ok: false, checkedAt: new Date().toISOString(), message: error.name === 'AbortError' ? 'Timed out' : error.message };
        console.warn(`Circular check failed for ${source.name}: ${error.message}`);
      }
    }
    db.circulars = db.circulars.slice(0, 1000);
    db.lastCheckedAt = new Date().toISOString();
    await persist();
    return { added, checkedAt: db.lastCheckedAt };
  } finally { checkInProgress = false; }
}

app.get('/api/sources', (_req, res) => res.json(SOURCES.map(source => ({ ...addCountdown(source), status: db.sourceStatus[source.id] || null }))));
app.get('/api/circulars', (req, res) => {
  const query = String(req.query.q || '').trim().slice(0, 100).toLowerCase();
  const universityId = String(req.query.university || '').trim();
  let items = db.circulars;
  if (query) items = items.filter(item => `${item.title} ${item.university} ${item.category}`.toLowerCase().includes(query));
  if (universityId) items = items.filter(item => item.universityId === universityId || SOURCES.some(source => source.id === universityId && source.name === item.university));
  res.json({ circulars: items.slice(0, 250), lastCheckedAt: db.lastCheckedAt, checking: checkInProgress });
});
app.get('/api/status', (_req, res) => res.json({ lastCheckedAt: db.lastCheckedAt, checking: checkInProgress, intervalMinutes: CHECK_INTERVAL_MINUTES, sourceCount: SOURCES.length }));
app.post('/api/check-now', manualCheckLimiter, requireSameOrigin, async (_req, res) => {
  if (checkInProgress) return res.status(409).json({ error: 'A circular check is already running.' });
  try { res.json(await checkAllSources()); }
  catch (error) { console.error('Manual circular check failed:', error); res.status(500).json({ error: 'The circular check failed. Please try again later.' }); }
});

app.use((error, _req, res, _next) => {
  if (error.type === 'entity.too.large') return res.status(413).json({ error: 'Request body is too large.' });
  if (error instanceof SyntaxError && 'body' in error) return res.status(400).json({ error: 'Invalid JSON body.' });
  console.error('Request failed:', error.message);
  res.status(500).json({ error: 'An unexpected server error occurred.' });
});

async function start() {
  await loadData();
  const server = app.listen(PORT, () => console.log(`Admission Tracker listening on port ${PORT}`));
  server.requestTimeout = 15000;
  server.headersTimeout = 16000;
  checkAllSources().catch(error => console.error('Initial circular check failed:', error));
  cron.schedule(`*/${CHECK_INTERVAL_MINUTES} * * * *`, () => checkAllSources().catch(error => console.error('Scheduled circular check failed:', error)));
}
start().catch(error => { console.error('Could not start Admission Tracker:', error); process.exit(1); });
