const express = require('express');
const cron = require('node-cron');
const cheerio = require('cheerio');
const fs = require('node:fs/promises');
const path = require('node:path');
const helmet = require('helmet');
const { rateLimit } = require('express-rate-limit');

const app = express();
const PORT = Number(process.env.PORT) || 3000;
const CHECK_INTERVAL_MINUTES = Math.max(5, Math.min(59, Number(process.env.CHECK_INTERVAL_MINUTES) || 30));
const DATA_DIR = process.env.DATA_DIR || path.join(__dirname, 'data');
const DATA_FILE = path.join(DATA_DIR, 'circulars.json');
const MAX_PAGE_BYTES = 3 * 1024 * 1024;
const REQUEST_TIMEOUT_MS = 12000;
const SESSION_LABEL = '2026–27';

// A practical monitored set of public universities and public admission clusters.
// UGC directory links provide a discovery fallback for other institutions.
const SOURCES = [
  { id: 'du', name: 'University of Dhaka (DU)', type: 'public', noticeUrl: 'https://www.du.ac.bd/notice', admissionUrl: 'https://admission.eis.du.ac.bd' },
  { id: 'ru', name: 'University of Rajshahi (RU)', type: 'public', noticeUrl: 'https://admission.ru.ac.bd', admissionUrl: 'https://admission.ru.ac.bd/undergraduate/' },
  { id: 'cu', name: 'University of Chittagong (CU)', type: 'public', noticeUrl: 'https://cu.ac.bd/notice/', admissionUrl: 'https://admission.cu.ac.bd' },
  { id: 'ju', name: 'Jahangirnagar University (JU)', type: 'public', noticeUrl: 'https://juniv.edu/notice', admissionUrl: 'https://juniv-admission.org' },
  { id: 'jnu', name: 'Jagannath University (JnU)', type: 'public', noticeUrl: 'https://www.jnu.ac.bd/notice/', admissionUrl: 'https://admission.jnu.ac.bd' },
  { id: 'ku', name: 'Khulna University (KU)', type: 'public', noticeUrl: 'https://ku.ac.bd/notice', admissionUrl: 'https://admission.ku.ac.bd' },
  { id: 'bup', name: 'Bangladesh University of Professionals (BUP)', type: 'public', noticeUrl: 'https://bup.edu.bd/Home/Notice', admissionUrl: 'https://admission.bup.edu.bd/' },
  { id: 'buet', name: 'Bangladesh University of Engineering and Technology (BUET)', type: 'public', noticeUrl: 'https://www.buet.ac.bd/web/#/notice', admissionUrl: 'https://ugadmission.buet.ac.bd' },
  { id: 'cuet', name: 'Chittagong University of Engineering & Technology (CUET)', type: 'public', noticeUrl: 'https://www.cuet.ac.bd/notice', admissionUrl: 'https://www.cuet.ac.bd/admission' },
  { id: 'ruet', name: 'Rajshahi University of Engineering & Technology (RUET)', type: 'public', noticeUrl: 'https://www.ruet.ac.bd/notices', admissionUrl: 'https://admission.ruet.ac.bd/' },
  { id: 'kuet', name: 'Khulna University of Engineering & Technology (KUET)', type: 'public', noticeUrl: 'https://www.kuet.ac.bd/component/all-notice', admissionUrl: 'https://www.kuet.ac.bd/admission' },
  { id: 'butex', name: 'Bangladesh University of Textiles (BUTEX)', type: 'public', noticeUrl: 'https://www.butex.edu.bd/category/notices/', admissionUrl: 'https://www.butex.edu.bd/admission/' },
  { id: 'mist', name: 'Military Institute of Science and Technology (MIST)', type: 'public', noticeUrl: 'https://mist.ac.bd/allnotice', admissionUrl: 'https://admission.mist.ac.bd' },
  { id: 'agri', name: 'Agricultural Universities Admission System', type: 'public', noticeUrl: 'https://admission-agri.org', admissionUrl: 'https://admission-agri.org' },
  { id: 'gst', name: 'GST Universities Admission System', type: 'public', noticeUrl: 'https://gstadmission.ac.bd', admissionUrl: 'https://gstadmission.ac.bd' }
];
const UGC_DIRECTORIES = [
  { id: 'ugc-public', name: 'UGC Bangladesh — Public Universities', type: 'public', url: 'https://www.ugc.gov.bd/universities' },
  { id: 'ugc-private', name: 'UGC Bangladesh — Private Universities', type: 'private', url: 'https://www.ugc.gov.bd/universities' }
];
const sessionPattern = /(?:2026\s*[-–/\u2010\u2011]\s*(?:2027|27)|২০২৬\s*[-–/\u2010\u2011]\s*(?:২০২৭|২৭))/i;
const admissionPattern = /admission|circular|prospectus|application|ভর্তি|বিজ্ঞপ্তি|নির্দেশিকা/i;
const undergraduatePattern = /undergraduate|undergrad|honou?rs?|bachelor|first\s*year|1st\s*year|স্নাতক|সম্মান|অনার্স/i;
const excludedPattern = /result|merit\s*list|waiting\s*list|scholarship|stipend|seat\s*plan|admit\s*card|hall\s*ticket|job|tender|ফলাফল|মেধা\s*তালিকা|বৃত্তি|ভর্তির\s*ফলাফল/i;

let db = { circulars: [], lastCheckedAt: null, sourceStatus: {} };
let checkInProgress = false;
let lastManualCheck = 0;
app.disable('x-powered-by');
if (process.env.NODE_ENV === 'production') app.set('trust proxy', 1);
app.use(helmet({ contentSecurityPolicy: false, crossOriginEmbedderPolicy: false }));
app.use(express.json({ limit: '8kb', strict: true }));
app.use(express.static(path.join(__dirname, 'public'), { dotfiles: 'ignore', index: 'home.html', maxAge: process.env.NODE_ENV === 'production' ? '1h' : 0 }));
app.get('/', (_req, res) => res.sendFile(path.join(__dirname, 'public', 'home.html')));
app.get('/home', (_req, res) => res.redirect('/home.html'));
app.get('/home.html', (_req, res) => res.sendFile(path.join(__dirname, 'public', 'home.html')));

const manualCheckLimiter = rateLimit({ windowMs: 5 * 60 * 1000, limit: 1, standardHeaders: true, legacyHeaders: false, message: { error: 'Please wait a few minutes before requesting another check.' } });
function requireSameOrigin(req, res, next) {
  const origin = req.get('origin');
  if (!origin) return res.status(403).json({ error: 'Origin header is required.' });
  try { if (new URL(origin).origin !== `${req.protocol}://${req.get('host')}`) return res.status(403).json({ error: 'Cross-origin request rejected.' }); }
  catch { return res.status(403).json({ error: 'Invalid request origin.' }); }
  next();
}
function isAllowedLink(candidate, source) {
  try {
    const url = new URL(candidate);
    const allowed = [new URL(source.noticeUrl).hostname, new URL(source.admissionUrl).hostname].map(host => host.replace(/^www\./, ''));
    const host = url.hostname.replace(/^www\./, '');
    return url.protocol === 'https:' && allowed.some(domain => host === domain || host.endsWith(`.${domain}`));
  } catch { return false; }
}
function getLinkContext($, element) {
  let node = $(element);
  const pieces = [node.text(), node.attr('href') || ''];
  for (let depth = 0; depth < 3; depth++) { node = node.parent(); if (!node.length) break; pieces.push(node.text().slice(0, 700)); }
  return pieces.join(' ').replace(/\s+/g, ' ').trim().slice(0, 2200);
}
async function readLimitedBody(response) {
  if (!response.body) throw new Error('Empty response body');
  const reader = response.body.getReader(); const chunks = []; let total = 0;
  try {
    while (true) {
      const { done, value } = await reader.read(); if (done) break;
      total += value.byteLength;
      if (total > MAX_PAGE_BYTES) { await reader.cancel(); throw new Error('Page is too large to inspect'); }
      chunks.push(Buffer.from(value));
    }
  } finally { reader.releaseLock(); }
  return Buffer.concat(chunks).toString('utf8');
}
async function inspectPage(source, pageUrl) {
  const controller = new AbortController(); const timeout = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);
  try {
    const response = await fetch(pageUrl, { signal: controller.signal, redirect: 'follow', headers: { 'User-Agent': 'AdmissionTracker/1.0 (undergraduate circular index)', Accept: 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8' } });
    if (!response.ok) throw new Error(`HTTP ${response.status}`);
    if (!isAllowedLink(response.url, source)) throw new Error('Redirected to an unapproved host');
    const contentType = response.headers.get('content-type') || '';
    if (!contentType.includes('text/html') && !contentType.includes('xml')) throw new Error(`Unsupported response type: ${contentType}`);
    const declaredLength = Number(response.headers.get('content-length'));
    if (Number.isFinite(declaredLength) && declaredLength > MAX_PAGE_BYTES) throw new Error('Page is too large to inspect');
    const $ = cheerio.load(await readLimitedBody(response)); const found = []; const seen = new Set();
    $('a[href]').each((_, element) => {
      if (found.length >= 30) return false;
      const title = $(element).text().replace(/\s+/g, ' ').trim(); const href = $(element).attr('href'); if (!href) return;
      const context = getLinkContext($, element);
      if (!sessionPattern.test(context) || !admissionPattern.test(context) || !undergraduatePattern.test(context) || excludedPattern.test(context)) return;
      let url; try { url = new URL(href, response.url).toString(); } catch { return; }
      if (!isAllowedLink(url, source) || seen.has(url) || url === source.noticeUrl || url === source.admissionUrl) return;
      seen.add(url); found.push({ title: title || 'Undergraduate admission circular 2026–27', url, category: '2026–27 Undergraduate Admission Circular', session: '2026-27', level: 'undergraduate' });
    });
    return found;
  } finally { clearTimeout(timeout); }
}
async function inspectSource(source) {
  const pages = [...new Set([source.noticeUrl, source.admissionUrl])];
  const results = await Promise.allSettled(pages.map(url => inspectPage(source, url)));
  const found = []; const seen = new Set(); const failures = [];
  results.forEach((result, index) => {
    if (result.status === 'rejected') failures.push(`${pages[index]}: ${result.reason.name === 'AbortError' ? 'timed out' : result.reason.message}`);
    else for (const item of result.value) if (!seen.has(item.url)) { seen.add(item.url); found.push(item); }
  });
  const workingPages = results.filter(result => result.status === 'fulfilled').length;
  return { found, status: { ok: workingPages > 0, degraded: failures.length > 0, checkedAt: new Date().toISOString(), message: failures.length === pages.length ? `Both official pages could not be checked.` : `Checked ${workingPages} of ${pages.length} official pages.` } };
}
async function persist() {
  await fs.mkdir(DATA_DIR, { recursive: true }); const tempFile = `${DATA_FILE}.tmp`;
  await fs.writeFile(tempFile, JSON.stringify(db, null, 2), { mode: 0o600 }); await fs.rename(tempFile, DATA_FILE);
}
async function loadData() {
  await fs.mkdir(DATA_DIR, { recursive: true });
  try {
    const saved = JSON.parse(await fs.readFile(DATA_FILE, 'utf8'));
    db = { circulars: Array.isArray(saved.circulars) ? saved.circulars.filter(item => item.session === '2026-27' && item.level === 'undergraduate') : [], lastCheckedAt: saved.lastCheckedAt || null, sourceStatus: saved.sourceStatus || {} };
    if (!Array.isArray(db.circulars)) db.circulars = [];
  } catch (error) { if (error.code !== 'ENOENT') console.error('Could not read circular database:', error.message); await persist(); }
}
async function checkAllSources() {
  if (checkInProgress) return { skipped: true, message: 'A circular check is already running.' };
  checkInProgress = true; let added = 0;
  try {
    for (const source of SOURCES) {
      try {
        const result = await inspectSource(source); db.sourceStatus[source.id] = result.status;
        for (const item of result.found) {
          const id = `${source.id}:${item.url}`; if (db.circulars.some(existing => existing.id === id)) continue;
          db.circulars.unshift({ id, university: source.name, universityId: source.id, type: source.type, sourceUrl: source.noticeUrl, ...item, discoveredAt: new Date().toISOString() }); added++;
        }
      } catch (error) { db.sourceStatus[source.id] = { ok: false, degraded: true, checkedAt: new Date().toISOString(), message: error.name === 'AbortError' ? 'Timed out; use the official links below.' : error.message }; }
    }
    db.circulars = db.circulars.slice(0, 1000); db.lastCheckedAt = new Date().toISOString(); await persist(); return { added, checkedAt: db.lastCheckedAt };
  } finally { checkInProgress = false; }
}
app.get('/api/sources', (_req, res) => res.json({ sources: SOURCES.map(source => ({ ...source, status: db.sourceStatus[source.id] || null })), directories: UGC_DIRECTORIES }));
app.get('/api/circulars', (req, res) => {
  const query = String(req.query.q || '').trim().slice(0, 100).toLowerCase();
  const universityId = String(req.query.university || '').trim();
  const type = ['public', 'private'].includes(String(req.query.type || '').toLowerCase()) ? String(req.query.type).toLowerCase() : '';
  const session = String(req.query.session || '2026-27').trim();
  let items = db.circulars.filter(item => item.level === 'undergraduate' && (session === 'all' || item.session === session));
  if (query) items = items.filter(item => `${item.title} ${item.university}`.toLowerCase().includes(query));
  if (universityId) items = items.filter(item => item.universityId === universityId);
  if (type) items = items.filter(item => item.type === type);
  const matchedIds = new Set(items.map(item => item.universityId));
  let matchingSources = universityId ? SOURCES.filter(source => source.id === universityId) : SOURCES;
  if (type) matchingSources = matchingSources.filter(source => source.type === type);
  const fallbacks = matchingSources.filter(source => !matchedIds.has(source.id));
  res.json({ session: SESSION_LABEL, circulars: items.slice(0, 250), fallbacks, lastCheckedAt: db.lastCheckedAt, checking: checkInProgress });
});
app.get('/api/status', (_req, res) => res.json({ session: SESSION_LABEL, lastCheckedAt: db.lastCheckedAt, checking: checkInProgress, intervalMinutes: CHECK_INTERVAL_MINUTES, sourceCount: SOURCES.length }));
app.post('/api/check-now', manualCheckLimiter, requireSameOrigin, async (_req, res) => {
  if (checkInProgress) return res.status(409).json({ error: 'A circular check is already running.' });
  if (Date.now() - lastManualCheck < 5 * 60 * 1000) return res.status(429).json({ error: 'Please wait a few minutes before requesting another check.' });
  lastManualCheck = Date.now();
  try { res.json(await checkAllSources()); } catch (error) { console.error('Manual circular check failed:', error); res.status(500).json({ error: 'Circular check failed. Please try again later.' }); }
});
app.get('/profile', (_req, res) => res.redirect('/'));
app.use((error, _req, res, _next) => {
  if (error.type === 'entity.too.large') return res.status(413).json({ error: 'Request body is too large.' });
  if (error instanceof SyntaxError && 'body' in error) return res.status(400).json({ error: 'Invalid JSON body.' });
  console.error('Request failed:', error.message); res.status(500).json({ error: 'An unexpected server error occurred.' });
});
async function start() {
  await loadData(); const server = app.listen(PORT, () => console.log(`Admission Tracker listening on port ${PORT}`));
  server.requestTimeout = 15000; server.headersTimeout = 16000;
  checkAllSources().catch(error => console.error('Initial circular check failed:', error));
  cron.schedule(`*/${CHECK_INTERVAL_MINUTES} * * * *`, () => checkAllSources().catch(error => console.error('Scheduled circular check failed:', error)));
}
start().catch(error => { console.error('Could not start Admission Tracker:', error); process.exit(1); });
