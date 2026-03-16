/**
 * Mercatino dell'Usato — server.js
 *
 * Avvio:  npm install   (solo la prima volta)
 *         npm start     (oppure: node server.js)
 *
 * Dati:   data/items.json
 * Log:    logs/app.log
 */

'use strict';

const express = require('express');
const fs      = require('fs').promises;
const path    = require('path');
const crypto  = require('crypto');

const app  = express();
const PORT = process.env.PORT || 3000;

const DATA_DIR  = path.join(__dirname, 'data');
const LOGS_DIR  = path.join(__dirname, 'logs');
const DATA_FILE = path.join(DATA_DIR,  'items.json');
const LOG_FILE  = path.join(LOGS_DIR,  'app.log');

// ── Autenticazione ──────────────────────────────────────────
const ADMIN_USER = process.env.ADMIN_USER || 'admin';
const ADMIN_PASS = process.env.ADMIN_PASS || 'admin';
const SESSION_TTL = 8 * 60 * 60 * 1000; // 8 ore
const sessions = new Map();

// ── Middleware ────────────────────────────────────────────────
app.use(express.json());
app.use(express.static(__dirname));   // serve index.html, styles.css, app.js

// cookie parser inline (senza dipendenze npm)
app.use((req, _res, next) => {
  req.cookies = {};
  const header = req.headers.cookie || '';
  header.split(';').forEach(pair => {
    const [k, ...v] = pair.trim().split('=');
    if (k) req.cookies[k.trim()] = v.join('=').trim();
  });
  next();
});

// log ogni richiesta in console
app.use((req, _res, next) => {
  console.log(`[${new Date().toISOString()}] ${req.method} ${req.url}`);
  next();
});

// ── Auth helpers ─────────────────────────────────────────────
function isAuthenticated(req) {
  const token = req.cookies.session_token;
  if (!token || !sessions.has(token)) return false;
  const session = sessions.get(token);
  if (Date.now() - session.created > SESSION_TTL) {
    sessions.delete(token);
    return false;
  }
  return true;
}

function requireAdmin(req, res, next) {
  if (!isAuthenticated(req)) {
    return res.status(401).json({ error: 'Non autorizzato.' });
  }
  next();
}

// ── Utility: cartelle ─────────────────────────────────────────
async function ensureDirs() {
  await fs.mkdir(DATA_DIR, { recursive: true });
  await fs.mkdir(LOGS_DIR, { recursive: true });
}

// ── Utility: log su file ──────────────────────────────────────
async function log(level, message, data = null) {
  const entry = {
    timestamp: new Date().toISOString(),
    level,
    message,
    ...(data !== null && { data }),
  };
  const line = JSON.stringify(entry) + '\n';
  try {
    await fs.appendFile(LOG_FILE, line, 'utf8');
  } catch (err) {
    console.error('[LOG WRITE FAILED]', err.message);
  }
  // stampa anche in console
  const prefix = level === 'ERROR' ? '❌' : level === 'WARN' ? '⚠️ ' : 'ℹ️ ';
  console.log(`${prefix} [${level}] ${message}${data ? ' — ' + JSON.stringify(data) : ''}`);
}

// ── Utility: lettura / scrittura dati ────────────────────────
async function readItems() {
  try {
    const raw = await fs.readFile(DATA_FILE, 'utf8');
    return JSON.parse(raw);
  } catch (err) {
    if (err.code === 'ENOENT') return [];   // file non ancora creato
    throw err;
  }
}

async function writeItems(items) {
  await fs.writeFile(DATA_FILE, JSON.stringify(items, null, 2), 'utf8');
}

// ── Routes ────────────────────────────────────────────────────

// Health-check (usato dal client per sapere se il server è online)
app.get('/api/health', (_req, res) => res.json({ ok: true }));

// ── Auth routes ──────────────────────────────────────────────
app.post('/api/login', async (req, res) => {
  const { username, password } = req.body || {};
  if (username === ADMIN_USER && password === ADMIN_PASS) {
    const token = crypto.randomBytes(32).toString('hex');
    sessions.set(token, { created: Date.now() });
    res.setHeader('Set-Cookie',
      `session_token=${token}; HttpOnly; Path=/; Max-Age=${SESSION_TTL / 1000 | 0}; SameSite=Strict`);
    await log('INFO', 'Admin login riuscito');
    return res.json({ ok: true });
  }
  await log('WARN', 'Tentativo login fallito', { username });
  res.status(401).json({ error: 'Credenziali non valide.' });
});

app.post('/api/logout', async (req, res) => {
  const token = req.cookies.session_token;
  if (token) sessions.delete(token);
  res.setHeader('Set-Cookie', 'session_token=; HttpOnly; Path=/; Max-Age=0; SameSite=Strict');
  await log('INFO', 'Admin logout');
  res.json({ ok: true });
});

app.get('/api/session', (req, res) => {
  res.json({ authenticated: isAuthenticated(req) });
});

// GET /api/items — tutti i capi
app.get('/api/items', async (_req, res) => {
  try {
    const items = await readItems();
    res.json(items);
  } catch (err) {
    await log('ERROR', 'Lettura items fallita', { error: err.message });
    res.status(500).json({ error: 'Errore nella lettura dei dati.' });
  }
});

// POST /api/items — aggiunge un capo
app.post('/api/items', requireAdmin, async (req, res) => {
  try {
    const item = req.body;
    if (!item || !item.nome || !item.taglia) {
      return res.status(400).json({ error: 'Campi obbligatori mancanti (nome, taglia).' });
    }
    const items = await readItems();
    items.unshift(item);
    await writeItems(items);
    await log('INFO', 'Capo aggiunto', { id: item.id, nome: item.nome });
    res.status(201).json(item);
  } catch (err) {
    await log('ERROR', 'Aggiunta capo fallita', { error: err.message });
    res.status(500).json({ error: 'Errore nel salvataggio.' });
  }
});

// POST /api/items/bulk — importazione multipla (da Excel)
app.post('/api/items/bulk', requireAdmin, async (req, res) => {
  try {
    const newItems = req.body;
    if (!Array.isArray(newItems) || newItems.length === 0) {
      return res.status(400).json({ error: 'Array di capi atteso.' });
    }
    const items = await readItems();
    items.unshift(...newItems);
    await writeItems(items);
    await log('INFO', `Importazione bulk: ${newItems.length} capi aggiunti`);
    res.status(201).json({ added: newItems.length });
  } catch (err) {
    await log('ERROR', 'Importazione bulk fallita', { error: err.message });
    res.status(500).json({ error: "Errore nell'importazione." });
  }
});

// PUT /api/items/:id — modifica un capo
app.put('/api/items/:id', requireAdmin, async (req, res) => {
  try {
    const items = await readItems();
    const idx   = items.findIndex(i => i.id === req.params.id);
    if (idx === -1) return res.status(404).json({ error: 'Capo non trovato.' });
    items[idx] = { ...items[idx], ...req.body };
    await writeItems(items);
    await log('INFO', 'Capo modificato', { id: req.params.id, nome: items[idx].nome });
    res.json(items[idx]);
  } catch (err) {
    await log('ERROR', 'Modifica capo fallita', { id: req.params.id, error: err.message });
    res.status(500).json({ error: 'Errore nella modifica.' });
  }
});

// DELETE /api/items/:id — elimina un capo
app.delete('/api/items/:id', requireAdmin, async (req, res) => {
  try {
    let items = await readItems();
    const target = items.find(i => i.id === req.params.id);
    if (!target) return res.status(404).json({ error: 'Capo non trovato.' });
    items = items.filter(i => i.id !== req.params.id);
    await writeItems(items);
    await log('INFO', 'Capo eliminato', { id: req.params.id, nome: target.nome });
    res.json({ ok: true });
  } catch (err) {
    await log('ERROR', 'Eliminazione capo fallita', { id: req.params.id, error: err.message });
    res.status(500).json({ error: "Errore nell'eliminazione." });
  }
});

// POST /api/log — log di errori lato client
app.post('/api/log', async (req, res) => {
  try {
    const { level = 'ERROR', message = 'Errore client', data = null } = req.body;
    await log(level, `[CLIENT] ${message}`, data);
    res.json({ ok: true });
  } catch (err) {
    console.error('[LOG ENDPOINT FAILED]', err.message);
    res.status(500).json({ error: 'Log fallito.' });
  }
});

// ── 404 per rotte API non trovate ─────────────────────────────
app.use('/api', (req, res) => {
  res.status(404).json({ error: `Rotta non trovata: ${req.method} ${req.url}` });
});

// ── Gestione errori globale ───────────────────────────────────
app.use(async (err, _req, res, _next) => {
  await log('ERROR', 'Errore non gestito', { message: err.message, stack: err.stack });
  res.status(500).json({ error: 'Errore interno del server.' });
});

// ── Avvio server ──────────────────────────────────────────────
(async () => {
  await ensureDirs();
  app.listen(PORT, async () => {
    await log('INFO', `Server avviato su http://localhost:${PORT}`);
    console.log(`
╔════════════════════════════════════════╗
║  🏷️   Mercatino dell'Usato             ║
║  📡  http://localhost:${PORT}              ║
║  📁  Dati  →  data/items.json         ║
║  📋  Log   →  logs/app.log            ║
╚════════════════════════════════════════╝
`);
  });
})();
