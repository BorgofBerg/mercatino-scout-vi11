/* ============================================================
   Mercatino dell'Usato — app.js
   Salvataggio su file (via server Express) + log errori
   Fallback automatico su localStorage se server offline
   ============================================================ */

// ── Costanti ─────────────────────────────────────────────────
const API   = '/api';

// ── Stato applicazione ────────────────────────────────────────
let items          = [];
let editingId      = null;
let deleteTargetId = null;
let sortKey        = null;
let sortDir        = 'asc';
let serverOnline   = false;
let isAdmin        = false;

// ── Elementi DOM ──────────────────────────────────────────────
const form         = document.getElementById('itemForm');
const tableBody    = document.getElementById('tableBody');
const emptyState   = document.getElementById('emptyState');
const formTitle    = document.getElementById('formTitle');
const submitBtn    = document.getElementById('submitBtn');
const cancelBtn    = document.getElementById('cancelBtn');
const searchInput  = document.getElementById('searchInput');
const filterCat    = document.getElementById('filterCategoria');
const filterDis    = document.getElementById('filterDisponibile');
const clearFilters = document.getElementById('clearFilters');
const deleteModal  = document.getElementById('deleteModal');
const confirmDel   = document.getElementById('confirmDelete');
const cancelDel    = document.getElementById('cancelDelete');
const toast        = document.getElementById('toast');
const importExcel  = document.getElementById('importExcel');
const exportBtn    = document.getElementById('exportExcel');
const statusDot    = document.getElementById('statusDot');
const statusText   = document.getElementById('statusText');
const loginBtn     = document.getElementById('loginBtn');
const logoutBtn    = document.getElementById('logoutBtn');
const loginModal   = document.getElementById('loginModal');
const loginForm    = document.getElementById('loginForm');
const loginError   = document.getElementById('loginError');
const cancelLogin  = document.getElementById('cancelLogin');

// ── Generazione ID ────────────────────────────────────────────
function genId() {
  return Date.now().toString(36) + Math.random().toString(36).slice(2, 6);
}

// ── LocalStorage (fallback) ───────────────────────────────────
function lsLoad()       { try { return JSON.parse(localStorage.getItem('mercatino_items') || '[]'); } catch { return []; } }
function lsSave(data)   { try { localStorage.setItem('mercatino_items', JSON.stringify(data)); } catch {} }

// ── Toast ─────────────────────────────────────────────────────
let toastTimer = null;
function showToast(msg, type = 'default') {
  toast.textContent = msg;
  toast.className   = 'toast ' + type;
  toast.style.display = 'block';
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => { toast.style.display = 'none'; }, 3000);
}

// ── Indicatore stato server ───────────────────────────────────
function setStatus(online) {
  serverOnline = online;
  if (statusDot && statusText) {
    statusDot.className  = 'status-dot ' + (online ? 'online' : 'offline');
    statusText.textContent = online ? 'Server online' : 'Modalità offline';
  }
}

// ── API helpers ───────────────────────────────────────────────
async function apiFetch(path, options = {}) {
  const res = await fetch(API + path, {
    headers: { 'Content-Type': 'application/json' },
    ...options,
  });
  if (!res.ok) {
    if (res.status === 401 && path !== '/login' && path !== '/session') {
      isAdmin = false;
      applyAdminView();
      showToast('Sessione scaduta. Effettua di nuovo il login.', 'error');
    }
    const body = await res.json().catch(() => ({ error: res.statusText }));
    throw new Error(body.error || `HTTP ${res.status}`);
  }
  return res.json();
}

async function remoteLog(message, data = null, level = 'ERROR') {
  try {
    await apiFetch('/log', {
      method: 'POST',
      body: JSON.stringify({ level, message, data }),
    });
  } catch {
    console.error('[LOG]', level, message, data);
  }
}

// ── Caricamento dati ──────────────────────────────────────────
async function loadItems() {
  try {
    await apiFetch('/health');          // ping veloce
    items = await apiFetch('/items');
    setStatus(true);
    lsSave(items);                      // aggiorna cache locale
  } catch {
    setStatus(false);
    items = lsLoad();
    console.warn('⚠️  Server non raggiungibile — dati da localStorage.');
  }
  renderTable();
}

// ── Persistenza (API o localStorage) ─────────────────────────
async function persistAdd(item) {
  if (serverOnline) {
    await apiFetch('/items', { method: 'POST', body: JSON.stringify(item) });
  }
  items.unshift(item);
  lsSave(items);
}

async function persistUpdate(id, patch) {
  const idx = items.findIndex(i => i.id === id);
  if (idx === -1) return;
  if (serverOnline) {
    await apiFetch(`/items/${id}`, { method: 'PUT', body: JSON.stringify(patch) });
  }
  items[idx] = { ...items[idx], ...patch };
  lsSave(items);
}

async function persistDelete(id) {
  if (serverOnline) {
    await apiFetch(`/items/${id}`, { method: 'DELETE' });
  }
  items = items.filter(i => i.id !== id);
  lsSave(items);
}

async function persistBulk(newItems) {
  if (serverOnline) {
    await apiFetch('/items/bulk', { method: 'POST', body: JSON.stringify(newItems) });
  }
  items.unshift(...newItems);
  lsSave(items);
}

// ── Form: submit ──────────────────────────────────────────────
form.addEventListener('submit', async e => {
  e.preventDefault();
  const nome        = document.getElementById('nome').value.trim();
  const taglia      = document.getElementById('taglia').value;
  const prezzo      = parseFloat(document.getElementById('prezzo').value);
  const categoria   = document.getElementById('categoria').value;
  const descrizione = document.getElementById('descrizione').value.trim();
  const disponibile = document.getElementById('disponibile').checked;

  if (!nome || !taglia || isNaN(prezzo)) {
    showToast('Compila tutti i campi obbligatori.', 'error');
    return;
  }

  submitBtn.disabled = true;

  try {
    if (editingId) {
      await persistUpdate(editingId, { nome, taglia, prezzo, categoria, descrizione, disponibile });
      showToast('✏️ Capo aggiornato!', 'success');
      stopEditing();
    } else {
      await persistAdd({ id: genId(), nome, taglia, prezzo, categoria, descrizione, disponibile });
      showToast('✅ Capo aggiunto!', 'success');
    }
    renderTable();
    form.reset();
    document.getElementById('disponibile').checked = true;
  } catch (err) {
    await remoteLog('Salvataggio capo fallito', { error: err.message, nome });
    showToast('Errore nel salvataggio: ' + err.message, 'error');
  } finally {
    submitBtn.disabled = false;
  }
});

// ── Annulla modifica ──────────────────────────────────────────
cancelBtn.addEventListener('click', () => {
  stopEditing();
  form.reset();
  document.getElementById('disponibile').checked = true;
});

function stopEditing() {
  editingId = null;
  formTitle.textContent  = '➕ Aggiungi Capo';
  submitBtn.textContent  = '➕ Aggiungi';
  cancelBtn.style.display = 'none';
}

// ── Modifica capo ─────────────────────────────────────────────
window.editItem = function(id) {
  const item = items.find(i => i.id === id);
  if (!item) return;
  editingId = id;
  document.getElementById('nome').value         = item.nome;
  document.getElementById('taglia').value       = item.taglia;
  document.getElementById('prezzo').value       = item.prezzo;
  document.getElementById('categoria').value    = item.categoria || '';
  document.getElementById('descrizione').value  = item.descrizione || '';
  document.getElementById('disponibile').checked = item.disponibile;
  formTitle.textContent  = '✏️ Modifica Capo';
  submitBtn.textContent  = '💾 Salva modifiche';
  cancelBtn.style.display = 'inline-flex';
  document.querySelector('.form-card').scrollIntoView({ behavior: 'smooth', block: 'start' });
};

// ── Toggle disponibilità ──────────────────────────────────────
window.toggleDisponibile = async function(id) {
  const item = items.find(i => i.id === id);
  if (!item) return;
  const nuovoStato = !item.disponibile;
  try {
    await persistUpdate(id, { disponibile: nuovoStato });
    showToast(nuovoStato ? '✅ Segnato come disponibile' : '❌ Segnato come venduto');
    renderTable();
  } catch (err) {
    await remoteLog('Toggle disponibilità fallito', { id, error: err.message });
    showToast('Errore: ' + err.message, 'error');
  }
};

// ── Elimina capo ──────────────────────────────────────────────
window.askDelete = function(id) {
  deleteTargetId = id;
  deleteModal.style.display = 'flex';
};

confirmDel.addEventListener('click', async () => {
  if (!deleteTargetId) return;
  const id = deleteTargetId;
  deleteModal.style.display = 'none';
  deleteTargetId = null;
  try {
    await persistDelete(id);
    renderTable();
    showToast('🗑️ Capo eliminato.', 'error');
  } catch (err) {
    await remoteLog('Eliminazione capo fallita', { id, error: err.message });
    showToast('Errore: ' + err.message, 'error');
  }
});

cancelDel.addEventListener('click', () => {
  deleteModal.style.display = 'none';
  deleteTargetId = null;
});
deleteModal.addEventListener('click', e => {
  if (e.target === deleteModal) {
    deleteModal.style.display = 'none';
    deleteTargetId = null;
  }
});

// ── Filtri ────────────────────────────────────────────────────
function getFilteredItems() {
  const q   = searchInput.value.toLowerCase().trim();
  const cat = filterCat.value;
  const dis = filterDis.value;
  return items.filter(item => {
    const matchQ = !q ||
      item.nome.toLowerCase().includes(q) ||
      item.taglia.toLowerCase().includes(q) ||
      (item.descrizione && item.descrizione.toLowerCase().includes(q)) ||
      (item.categoria && item.categoria.toLowerCase().includes(q));
    const matchCat = !cat || item.categoria === cat;
    const matchDis = !dis ||
      (dis === 'si' && item.disponibile) ||
      (dis === 'no' && !item.disponibile);
    return matchQ && matchCat && matchDis;
  });
}
[searchInput, filterCat, filterDis].forEach(el => el.addEventListener('input', renderTable));
clearFilters.addEventListener('click', () => {
  searchInput.value = filterCat.value = filterDis.value = '';
  renderTable();
});

// ── Ordinamento colonne ───────────────────────────────────────
document.querySelectorAll('th[data-sort]').forEach(th => {
  th.addEventListener('click', () => {
    const key = th.dataset.sort;
    sortDir = (sortKey === key && sortDir === 'asc') ? 'desc' : 'asc';
    sortKey = key;
    document.querySelectorAll('th[data-sort]').forEach(t => t.classList.remove('sort-asc', 'sort-desc'));
    th.classList.add(sortDir === 'asc' ? 'sort-asc' : 'sort-desc');
    renderTable();
  });
});

function sortItems(arr) {
  if (!sortKey) return arr;
  return [...arr].sort((a, b) => {
    let va = a[sortKey], vb = b[sortKey];
    if (sortKey === 'prezzo')      { va = +va; vb = +vb; }
    else if (sortKey === 'disponibile') { va = va ? 1 : 0; vb = vb ? 1 : 0; }
    else { va = String(va || '').toLowerCase(); vb = String(vb || '').toLowerCase(); }
    return (va < vb ? -1 : va > vb ? 1 : 0) * (sortDir === 'asc' ? 1 : -1);
  });
}

// ── Statistiche ───────────────────────────────────────────────
function updateStats() {
  const disp = items.filter(i => i.disponibile);
  const vend = items.filter(i => !i.disponibile);
  document.getElementById('statTotale').textContent      = items.length;
  document.getElementById('statDisponibili').textContent = disp.length;
  document.getElementById('statVenduti').textContent     = vend.length;
}

// ── Render tabella ────────────────────────────────────────────
function renderTable() {
  const filtered = sortItems(getFilteredItems());
  updateStats();

  const countLabel = document.getElementById('countLabel');
  countLabel.textContent = filtered.length === items.length
    ? `${items.length} capi`
    : `${filtered.length} / ${items.length} capi`;

  const table = document.querySelector('.table-wrapper table');
  if (filtered.length === 0) {
    tableBody.innerHTML = '';
    emptyState.style.display = 'block';
    table.style.display = 'none';
    return;
  }
  emptyState.style.display = 'none';
  table.style.display = '';

  tableBody.innerHTML = filtered.map((item, idx) => `
    <tr class="${item.disponibile ? '' : 'venduto'}">
      <td>${idx + 1}</td>
      <td><strong>${escHtml(item.nome)}</strong></td>
      <td>${escHtml(item.taglia)}</td>
      <td>${escHtml(item.categoria || '—')}</td>
      <td class="prezzo-cell">€${Number(item.prezzo).toFixed(2)}</td>
      <td class="descrizione-cell" title="${escHtml(item.descrizione || '')}">${escHtml(item.descrizione || '—')}</td>
      <td>
        <span class="badge ${item.disponibile ? 'badge-success' : 'badge-danger'}">
          ${item.disponibile ? '✅ Disponibile' : '❌ Venduto'}
        </span>
      </td>
      <td class="actions-cell admin-only"${isAdmin ? '' : ' style="display:none"'}>
        <button class="btn-icon toggle"
          title="${item.disponibile ? 'Segna venduto' : 'Segna disponibile'}"
          onclick="toggleDisponibile('${item.id}')">
          ${item.disponibile ? '🔴' : '🟢'}
        </button>
        <button class="btn-icon edit" title="Modifica" onclick="editItem('${item.id}')">✏️</button>
        <button class="btn-icon delete" title="Elimina" onclick="askDelete('${item.id}')">🗑️</button>
      </td>
    </tr>
  `).join('');
}

function escHtml(str) {
  return String(str)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

// ── ESPORTAZIONE EXCEL ────────────────────────────────────────
exportBtn.addEventListener('click', () => {
  if (items.length === 0) { showToast('Nessun capo da esportare.', 'error'); return; }
  try {
    const data = items.map((item, idx) => ({
      '#':           idx + 1,
      'Capo':        item.nome,
      'Taglia':      item.taglia,
      'Categoria':   item.categoria || '',
      'Prezzo (€)':  Number(item.prezzo).toFixed(2),
      'Descrizione': item.descrizione || '',
      'Stato':       item.disponibile ? 'Disponibile' : 'Venduto',
    }));
    const ws = XLSX.utils.json_to_sheet(data);
    ws['!cols'] = [{ wch:5 }, { wch:22 }, { wch:14 }, { wch:14 }, { wch:12 }, { wch:38 }, { wch:14 }];
    const wb = XLSX.utils.book_new();
    XLSX.utils.book_append_sheet(wb, ws, 'Mercatino');
    const date = new Date().toISOString().slice(0, 10);
    XLSX.writeFile(wb, `mercatino_${date}.xlsx`);
    showToast('📤 File Excel esportato!', 'success');
  } catch (err) {
    remoteLog('Esportazione Excel fallita', { error: err.message });
    showToast('Errore durante l\'esportazione.', 'error');
  }
});

// ── IMPORTAZIONE EXCEL ────────────────────────────────────────
importExcel.addEventListener('change', e => {
  const file = e.target.files[0];
  if (!file) return;
  const reader = new FileReader();
  reader.onload = async evt => {
    try {
      const wb   = XLSX.read(evt.target.result, { type: 'binary' });
      const ws   = wb.Sheets[wb.SheetNames[0]];
      const rows = XLSX.utils.sheet_to_json(ws, { defval: '' });

      const parsed = [];
      rows.forEach(row => {
        const nome      = (row['Capo']        || row['capo']  || row['nome']  || '').toString().trim();
        const taglia    = (row['Taglia']      || row['taglia']                || '').toString().trim();
        const prezzo    = parseFloat(row['Prezzo (€)'] || row['prezzo']  || row['Prezzo'] || 0);
        const categoria = (row['Categoria']   || row['categoria']             || '').toString().trim();
        const descr     = (row['Descrizione'] || row['descrizione']           || '').toString().trim();
        const statoRaw  = (row['Stato']       || row['stato'] || 'disponibile').toString().toLowerCase().trim();
        const disponibile = !['venduto', 'no', 'false', '0'].includes(statoRaw);
        if (!nome || !taglia) return;
        parsed.push({ id: genId(), nome, taglia, prezzo: isNaN(prezzo) ? 0 : prezzo, categoria, descrizione: descr, disponibile });
      });

      if (parsed.length === 0) {
        showToast('Nessun capo valido trovato nel file.', 'error');
        return;
      }

      await persistBulk(parsed);
      renderTable();
      showToast(`📥 Importati ${parsed.length} capi!`, 'success');
    } catch (err) {
      await remoteLog('Importazione Excel fallita', { error: err.message, file: file.name });
      showToast('Errore nella lettura del file Excel.', 'error');
    }
    importExcel.value = '';
  };
  reader.onerror = async () => {
    await remoteLog('Lettura file Excel fallita', { file: file.name });
    showToast('Impossibile leggere il file.', 'error');
    importExcel.value = '';
  };
  reader.readAsBinaryString(file);
});

// ── AUTENTICAZIONE ───────────────────────────────────────────
async function checkSession() {
  try {
    const res = await apiFetch('/session');
    isAdmin = res.authenticated === true;
  } catch {
    isAdmin = false;
  }
  applyAdminView();
}

function applyAdminView() {
  document.querySelectorAll('.admin-only').forEach(el => {
    el.style.display = isAdmin ? '' : 'none';
  });
  loginBtn.style.display  = isAdmin ? 'none' : '';
  logoutBtn.style.display = isAdmin ? '' : 'none';
  renderTable();
}

loginBtn.addEventListener('click', () => {
  loginModal.style.display = 'flex';
  document.getElementById('loginUser').focus();
});

cancelLogin.addEventListener('click', () => {
  loginModal.style.display = 'none';
  loginForm.reset();
  loginError.style.display = 'none';
});

loginModal.addEventListener('click', e => {
  if (e.target === loginModal) {
    loginModal.style.display = 'none';
    loginForm.reset();
    loginError.style.display = 'none';
  }
});

loginForm.addEventListener('submit', async e => {
  e.preventDefault();
  loginError.style.display = 'none';
  const username = document.getElementById('loginUser').value.trim();
  const password = document.getElementById('loginPass').value;
  try {
    await apiFetch('/login', {
      method: 'POST',
      body: JSON.stringify({ username, password }),
    });
    isAdmin = true;
    loginModal.style.display = 'none';
    loginForm.reset();
    applyAdminView();
    showToast('Accesso effettuato!', 'success');
  } catch (err) {
    loginError.textContent = err.message || 'Credenziali non valide.';
    loginError.style.display = 'block';
  }
});

logoutBtn.addEventListener('click', async () => {
  try { await apiFetch('/logout', { method: 'POST' }); } catch {}
  isAdmin = false;
  applyAdminView();
  showToast('Disconnesso.', 'default');
});

// ── INIT ──────────────────────────────────────────────────────
(async () => {
  await checkSession();
  await loadItems();
})();
