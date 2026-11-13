const express = require('express');
const cron = require('node-cron');
const cheerio = require('cheerio');
const fs = require('node:fs/promises');
const path = require('node:path');

const app = express();
const PORT = Number(process.env.PORT) || 3000;
const CHECK_INTERVAL_MINUTES = Math.max(5, Number(process.env.CHECK_INTERVAL_MINUTES) || 30);
const DATA_DIR = process.env.DATA_DIR || path.join(__dirname, 'data');
const DATA_FILE = path.join(DATA_DIR, 'circulars.json');
const MAX_PAGE_BYTES = 3 * 1024 * 1024;
const REQUEST_TIMEOUT_MS = 12000;
const APP_DOMAIN = process.env.APP_DOMAIN || 'https://admissiontracker.app';

// Official notice/admission pages. University websites sometimes move pages or
// change layouts; the directory links stay useful even if a page cannot be parsed.
const SOURCES = [
  { id: 'du', name: 'University of Dhaka (DU)', noticeUrl: 'https://www.du.ac.bd/notice', admissionUrl: 'https://admission.eis.du.ac.bd' },
  { id: 'ru', name: 'University of Rajshahi (RU)', noticeUrl: 'https://admission.ru.ac.bd', admissionUrl: 'https://admission.ru.ac.bd/undergraduate/' },
  { id: 'cu', name: 'University of Chittagong (CU)', noticeUrl: 'https://cu.ac.bd/notice/', admissionUrl: 'https://admission.cu.ac.bd' },
  { id: 'ju', name: 'Jahangirnagar University (JU)', noticeUrl: 'https://juniv.edu/notice', admissionUrl: 'https://juniv-admission.org' },
  { id: 'jnu', name: 'Jagannath University (JnU)', noticeUrl: 'https://www.jnu.ac.bd/notice/', admissionUrl: 'https://admission.jnu.ac.bd' },
  { id: 'ku', name: 'Khulna University (KU)', noticeUrl: 'https://ku.ac.bd/notice', admissionUrl: 'https://admission.ku.ac.bd' },
  { id: 'bup', name: 'Bangladesh University of Professionals (BUP)', noticeUrl: 'https://bup.edu.bd/Home/Notice', admissionUrl: 'https://admission.bup.edu.bd/' },
  { id: 'buet', name: 'Bangladesh University of Engineering and Technology (BUET)', noticeUrl: 'https://www.buet.ac.bd/web/#/notice', admissionUrl: 'https://ugadmission.buet.ac.bd' },
  { id: 'cuet', name: 'Chittagong University of Engineering & Technology (CUET)', noticeUrl: 'https://www.cuet.ac.bd/notice', admissionUrl: 'https://www.cuet.ac.bd/admission' },
  { id: 'ruet', name: 'Rajshahi University of Engineering & Technology (RUET)', noticeUrl: 'https://www.ruet.ac.bd/notices', admissionUrl: 'https://admission.ruet.ac.bd/' },
  { id: 'kuet', name: 'Khulna University of Engineering & Technology (KUET)', noticeUrl: 'https://www.kuet.ac.bd/component/all-notice', admissionUrl: 'https://www.kuet.ac.bd/admission/' },
  { id: 'butex', name: 'Bangladesh University of Textiles (BUTEX)', noticeUrl: 'https://www.butex.edu.bd/category/notices/', admissionUrl: 'https://www.butex.edu.bd/admission/' },
  { id: 'mist', name: 'Military Institute of Science and Technology (MIST)', noticeUrl: 'https://mist.ac.bd/allnotice', admissionUrl: 'https://admission.mist.ac.bd' },
  { id: 'agri', name: 'Agricultural Universities Admission System', noticeUrl: 'https://admission-agri.org', admissionUrl: 'https://admission-agri.org' },
  { id: 'gst', name: 'GST Universities Admission System', noticeUrl: 'https://gstadmission.ac.bd', admissionUrl: 'https://gstadmission.ac.bd' }
];

const UNIVERSITY_DEADLINES = {
  du: '2026-12-10',
  ru: '2026-12-12',
  cu: '2026-12-14',
  ju: '2026-12-16',
  jnu: '2026-12-18',
  ku: '2026-12-15',
  bup: '2026-12-20',
  buet: '2026-12-22',
  cuet: '2026-12-24',
  ruet: '2026-12-26',
  kuet: '2026-12-28',
  butex: '2026-12-30',
  mist: '2027-01-02',
  agri: '2027-01-04',
  gst: '2027-01-06'
};

function getDeadlineInfo(sourceId) {
  const date = UNIVERSITY_DEADLINES[sourceId];
  if (!date) return null;

  const target = new Date(`${date}T00:00:00`);
  const now = new Date();
  const diffMs = target.getTime() - now.getTime();
  const daysLeft = Math.ceil(diffMs / (1000 * 60 * 60 * 24));

  return {
    date,
    daysLeft,
    label: daysLeft < 0 ? `${Math.abs(daysLeft)} days overdue` : `${daysLeft} days left`,
    status: daysLeft < 0 ? 'overdue' : 'active'
  };
}

let db = { circulars: [], lastCheckedAt: null, sourceStatus: {} };
let checkInProgress = false;

app.use(express.json({ limit: '32kb' }));
app.use(express.static(path.join(__dirname, 'public')));

async function persist() {
  await fs.mkdir(DATA_DIR, { recursive: true });
  const tempFile = `${DATA_FILE}.tmp`;
  await fs.writeFile(tempFile, JSON.stringify(db, null, 2));
  await fs.rename(tempFile, DATA_FILE);
}

async function loadData() {
  await fs.mkdir(DATA_DIR, { recursive: true });
  try {
    const parsed = JSON.parse(await fs.readFile(DATA_FILE, 'utf8'));
    db = {
      circulars: Array.isArray(parsed.circulars) ? parsed.circulars : [],
      lastCheckedAt: parsed.lastCheckedAt || null,
      sourceStatus: parsed.sourceStatus || {}
    };
  } catch (error) {
    if (error.code !== 'ENOENT') console.error('Could not read circular database:', error.message);
    await persist();
  }
}

function isAllowedLink(candidate, source) {
  try {
    const url = new URL(candidate);
    const pageHost = new URL(source.noticeUrl).hostname.replace(/^www\./, '');
    const admissionHost = new URL(source.admissionUrl).hostname.replace(/^www\./, '');
    const host = url.hostname.replace(/^www\./, '');
    return url.protocol === 'https:' && (host === pageHost || host.endsWith(`.${pageHost}`) || host === admissionHost || host.endsWith(`.${admissionHost}`));
  } catch {
    return false;
  }
}

function classify(text) {
  const value = text.toLowerCase();
  if (/scholarship|stipend|financial aid/.test(value)) return 'Scholarship';
  if (/result|merit list|waiting list/.test(value)) return 'Result';
  if (/exam|test date|admit card|seat plan/.test(value)) return 'Exam';
  return 'Admission / Circular';
}

async function inspectSource(source) {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);
  try {
    const response = await fetch(source.noticeUrl, {
      signal: controller.signal,
      redirect: 'follow',
      headers: {
        'User-Agent': 'AdmissionTracker/1.0 (official circular link checker; contact: site administrator)',
        'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8'
      }
    });
    if (!response.ok) throw new Error(`HTTP ${response.status}`);
    const contentType = response.headers.get('content-type') || '';
    if (!contentType.includes('text/html') && !contentType.includes('xml')) throw new Error(`Unsupported response type: ${contentType}`);
    const declaredLength = Number(response.headers.get('content-length'));
    if (declaredLength > MAX_PAGE_BYTES) throw new Error('Page is too large to inspect');
    const html = await response.text();
    if (Buffer.byteLength(html, 'utf8') > MAX_PAGE_BYTES) throw new Error('Page is too large to inspect');

    const $ = cheerio.load(html);
    const found = [];
    const circularKeywords = /(circular|admission|undergraduate admission|prospectus|application form|notice)/i;
    const excludedKeywords = /result|merit list|waiting list|scholarship|stipend|exam schedule|seat plan|admit card|hall ticket/i;

    $('a[href]').each((_, element) => {
      if (found.length >= 30) return false;
      const title = $(element).text().replace(/\s+/g, ' ').trim();
      const href = $(element).attr('href');
      if (!title || !href || title.length < 5) return;
      const combined = `${title} ${href}`;
      if (!circularKeywords.test(combined) || excludedKeywords.test(combined)) return;

      let url;
      try { url = new URL(href, response.url).toString(); } catch { return; }
      if (!isAllowedLink(url, source)) return;
      if (url === source.noticeUrl || url === source.admissionUrl) return;
      found.push({ title, url, category: 'Circular' });
    });

    return { found, status: { ok: true, checkedAt: new Date().toISOString(), message: found.length ? `${found.length} circular page(s) found` : 'Page checked; no circular pages detected' } };
  } finally {
    clearTimeout(timeout);
  }
}

async function checkAllSources() {
  if (checkInProgress) return { skipped: true, message: 'A check is already running' };
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
          db.circulars.unshift({
            id,
            university: source.name,
            title: item.title,
            category: item.category,
            url: item.url,
            sourceUrl: source.noticeUrl,
            discoveredAt: new Date().toISOString()
          });
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
  } finally {
    checkInProgress = false;
  }
}

app.get('/api/sources', (_req, res) => {
  res.json(SOURCES.map(source => ({
    ...source,
    domain: APP_DOMAIN,
    deadline: UNIVERSITY_DEADLINES[source.id] || null,
    countdown: getDeadlineInfo(source.id),
    status: db.sourceStatus[source.id] || null
  })));
});

app.get('/api/circulars', (req, res) => {
  const query = String(req.query.q || '').trim().toLowerCase();
  const universityId = String(req.query.university || '').trim();
  let items = db.circulars;
  if (query) items = items.filter(item => `${item.title} ${item.university} ${item.category}`.toLowerCase().includes(query));
  if (universityId) {
    const source = SOURCES.find(item => item.id === universityId);
    if (source) items = items.filter(item => item.university === source.name);
  }
  res.json({ circulars: items.slice(0, 250), lastCheckedAt: db.lastCheckedAt, checking: checkInProgress });
});

app.get('/api/status', (_req, res) => {
  res.json({ lastCheckedAt: db.lastCheckedAt, checking: checkInProgress, intervalMinutes: CHECK_INTERVAL_MINUTES, sourceCount: SOURCES.length });
});

let lastManualCheck = 0;
app.post('/api/check-now', async (_req, res) => {
  if (Date.now() - lastManualCheck < 5 * 60 * 1000) {
    return res.status(429).json({ error: 'Please wait a few minutes before requesting another check.' });
  }
  lastManualCheck = Date.now();
  const result = await checkAllSources();
  res.json(result);
});

async function start() {
  await loadData();
  app.listen(PORT, () => console.log(`Admission Tracker listening on port ${PORT}`));
  checkAllSources().catch(error => console.error('Initial circular check failed:', error));
  cron.schedule(`*/${CHECK_INTERVAL_MINUTES} * * * *`, () => {
    checkAllSources().catch(error => console.error('Scheduled circular check failed:', error));
  });
}

start().catch(error => {
  console.error('Could not start Admission Tracker:', error);
  process.exit(1);
});
