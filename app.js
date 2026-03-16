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
const exportPdfBtn = document.getElementById('exportPdf');
const imgInput     = document.getElementById('immagine');
const imgPreview   = document.getElementById('imgPreview');
const imgPreviewImg= document.getElementById('imgPreviewImg');
const removeImgBtn = document.getElementById('removeImg');
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
  // Non impostare Content-Type per FormData (il browser lo gestisce)
  const isFormData = options.body instanceof FormData;
  const headers = isFormData ? {} : { 'Content-Type': 'application/json' };
  const res = await fetch(API + path, {
    headers,
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
async function persistAdd(item, imageFile) {
  if (serverOnline) {
    const fd = new FormData();
    Object.entries(item).forEach(([k, v]) => fd.append(k, v));
    if (imageFile) fd.append('immagine', imageFile);
    const saved = await apiFetch('/items', { method: 'POST', body: fd });
    item.immagine = saved.immagine || '';
  }
  items.unshift(item);
  lsSave(items);
}

async function persistUpdate(id, patch, imageFile) {
  const idx = items.findIndex(i => i.id === id);
  if (idx === -1) return;
  if (serverOnline) {
    const fd = new FormData();
    Object.entries(patch).forEach(([k, v]) => fd.append(k, v));
    if (imageFile) fd.append('immagine', imageFile);
    const saved = await apiFetch(`/items/${id}`, { method: 'PUT', body: fd });
    patch.immagine = saved.immagine || items[idx].immagine || '';
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

  const imageFile = imgInput.files[0] || null;

  try {
    if (editingId) {
      await persistUpdate(editingId, { nome, taglia, prezzo, categoria, descrizione, disponibile }, imageFile);
      showToast('✏️ Capo aggiornato!', 'success');
      stopEditing();
    } else {
      await persistAdd({ id: genId(), nome, taglia, prezzo, categoria, descrizione, disponibile }, imageFile);
      showToast('✅ Capo aggiunto!', 'success');
    }
    renderTable();
    form.reset();
    clearImgPreview();
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
  clearImgPreview();
  document.getElementById('disponibile').checked = true;
});

function stopEditing() {
  editingId = null;
  formTitle.textContent  = '➕ Aggiungi Capo';
  submitBtn.textContent  = '➕ Aggiungi';
  cancelBtn.style.display = 'none';
  clearImgPreview();
}

// ── Preview immagine nel form ────────────────────────────────
function clearImgPreview() {
  imgPreview.style.display = 'none';
  imgPreviewImg.src = '';
  imgInput.value = '';
}

imgInput.addEventListener('change', () => {
  const file = imgInput.files[0];
  if (!file) { clearImgPreview(); return; }
  const reader = new FileReader();
  reader.onload = e => {
    imgPreviewImg.src = e.target.result;
    imgPreview.style.display = 'flex';
  };
  reader.readAsDataURL(file);
});

removeImgBtn.addEventListener('click', clearImgPreview);

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
  // Mostra immagine esistente
  if (item.immagine) {
    imgPreviewImg.src = item.immagine;
    imgPreview.style.display = 'flex';
  } else {
    clearImgPreview();
  }
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
      <td class="foto-cell">
        ${item.immagine
          ? `<img src="${escHtml(item.immagine)}" alt="${escHtml(item.nome)}" class="thumb" />`
          : '<span class="thumb-placeholder">📷</span>'}
      </td>
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

// ── ESPORTAZIONE PDF ─────────────────────────────────────────

// Carica un'immagine da URL e restituisce base64 (o null se fallisce)
function loadImageAsBase64(url) {
  return new Promise(resolve => {
    const img = new Image();
    img.crossOrigin = 'anonymous';
    img.onload = () => {
      try {
        const canvas = document.createElement('canvas');
        const size = 60; // dimensione thumbnail nel PDF
        canvas.width = size;
        canvas.height = size;
        const ctx = canvas.getContext('2d');
        // Crop centrato (object-fit: cover)
        const min = Math.min(img.width, img.height);
        const sx = (img.width - min) / 2;
        const sy = (img.height - min) / 2;
        ctx.drawImage(img, sx, sy, min, min, 0, 0, size, size);
        resolve(canvas.toDataURL('image/jpeg', 0.7));
      } catch { resolve(null); }
    };
    img.onerror = () => resolve(null);
    img.src = url;
  });
}

exportPdfBtn.addEventListener('click', async () => {
  if (items.length === 0) { showToast('Nessun capo da esportare.', 'error'); return; }
  exportPdfBtn.disabled = true;
  exportPdfBtn.textContent = '⏳ Generazione…';

  try {
    // Pre-carica tutte le immagini come base64
    const imageMap = {};
    const promises = items.map(async item => {
      if (item.immagine) {
        imageMap[item.id] = await loadImageAsBase64(item.immagine);
      }
    });
    await Promise.all(promises);

    const { jsPDF } = window.jspdf;
    const doc = new jsPDF();

    // Titolo
    doc.setFontSize(16);
    doc.text('Mercatino dell\'Usato — Gruppo Scout VI11', 14, 18);
    doc.setFontSize(9);
    doc.setTextColor(120);
    doc.text('Generato il ' + new Date().toLocaleDateString('it-IT'), 14, 24);
    doc.setTextColor(0);

    // Tabella con colonna Foto vuota (le immagini vanno inserite in didDrawCell)
    const rows = items.map((item, idx) => [
      idx + 1,
      '',  // placeholder per foto
      item.nome,
      item.taglia,
      item.categoria || '—',
      '\u20AC ' + Number(item.prezzo).toFixed(2),
      item.disponibile ? 'Disponibile' : 'Venduto',
    ]);

    const IMG_SIZE = 12; // mm nel PDF

    doc.autoTable({
      startY: 30,
      head: [['#', 'Foto', 'Capo', 'Taglia', 'Categoria', 'Prezzo', 'Stato']],
      body: rows,
      styles: { fontSize: 8, cellPadding: 3, minCellHeight: IMG_SIZE + 4 },
      headStyles: { fillColor: [13, 150, 104], textColor: 255, fontStyle: 'bold' },
      alternateRowStyles: { fillColor: [240, 249, 245] },
      columnStyles: {
        0: { cellWidth: 10, halign: 'center' },
        1: { cellWidth: IMG_SIZE + 6, halign: 'center' },
        5: { halign: 'right', fontStyle: 'bold' },
        6: { halign: 'center' },
      },
      didDrawCell: (data) => {
        // Colonna 1 = Foto, solo body (non header)
        if (data.column.index === 1 && data.section === 'body') {
          const item = items[data.row.index];
          const base64 = item ? imageMap[item.id] : null;
          if (base64) {
            const x = data.cell.x + (data.cell.width - IMG_SIZE) / 2;
            const y = data.cell.y + (data.cell.height - IMG_SIZE) / 2;
            doc.addImage(base64, 'JPEG', x, y, IMG_SIZE, IMG_SIZE);
          }
        }
      },
    });

    const date = new Date().toISOString().slice(0, 10);
    doc.save(`mercatino_${date}.pdf`);
    showToast('📄 PDF scaricato!', 'success');
  } catch (err) {
    remoteLog('Esportazione PDF fallita', { error: err.message });
    showToast('Errore durante l\'esportazione PDF.', 'error');
  } finally {
    exportPdfBtn.disabled = false;
    exportPdfBtn.textContent = '📄 Scarica PDF';
  }
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
