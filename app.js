const DB_NAME = 'us-local-first-v0';
const DB_VERSION = 1;
const stores = ['entries', 'memoryItems', 'intimacyNotes', 'calendarItems', 'patternItems', 'ideas'];

const state = { db: null, section: 'journal', entries: [], derived: {}, query: '' };
const app = document.querySelector('#app');
const dbStatus = document.querySelector('#dbStatus');

function uid(prefix) {
  return `${prefix}_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
}

function openDb() {
  return new Promise((resolve, reject) => {
    const request = indexedDB.open(DB_NAME, DB_VERSION);
    request.onupgradeneeded = () => {
      const db = request.result;
      stores.forEach((name) => {
        if (!db.objectStoreNames.contains(name)) db.createObjectStore(name, { keyPath: 'id' });
      });
    };
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error);
  });
}

function txStore(name, mode = 'readonly') {
  return state.db.transaction(name, mode).objectStore(name);
}

function getAll(name) {
  return new Promise((resolve, reject) => {
    const request = txStore(name).getAll();
    request.onsuccess = () => resolve(request.result || []);
    request.onerror = () => reject(request.error);
  });
}

function put(name, value) {
  return new Promise((resolve, reject) => {
    const request = txStore(name, 'readwrite').put(value);
    request.onsuccess = () => resolve(value);
    request.onerror = () => reject(request.error);
  });
}

function remove(name, id) {
  return new Promise((resolve, reject) => {
    const request = txStore(name, 'readwrite').delete(id);
    request.onsuccess = () => resolve();
    request.onerror = () => reject(request.error);
  });
}

async function refresh() {
  state.entries = (await getAll('entries')).sort((a, b) => new Date(a.createdAt) - new Date(b.createdAt));
  state.derived = {};
  for (const name of stores.slice(1)) state.derived[name] = await getAll(name);
  render();
}

async function saveEntry(text) {
  const entry = {
    id: uid('entry'),
    text: text.trim(),
    createdAt: new Date().toISOString(),
    tags: [],
    summary: '',
    sentiment: '',
    keywords: [],
    processingStatus: 'saved locally; not processed',
    aiJson: null
  };
  await put('entries', entry);
  await refresh();
}

function normalizeArray(value) {
  return Array.isArray(value) ? value : [];
}

async function applyAiJson(entryId, jsonText) {
  const parsed = JSON.parse(jsonText);
  const entry = state.entries.find((item) => item.id === entryId);
  if (!entry) throw new Error('Entry not found.');

  const updated = {
    ...entry,
    summary: parsed.summary || entry.summary || '',
    sentiment: parsed.sentiment || '',
    tags: normalizeArray(parsed.tags),
    keywords: normalizeArray(parsed.keywords),
    processingStatus: 'manual AI JSON applied',
    aiJson: parsed,
    processedAt: new Date().toISOString()
  };
  await put('entries', updated);

  // Derived records keep sourceEntryId so they can be deleted independently while the journal remains the source of truth.
  for (const item of normalizeArray(parsed.memory)) await put('memoryItems', { id: uid('memory'), sourceEntryId: entryId, createdAt: new Date().toISOString(), ...item });
  for (const item of normalizeArray(parsed.intimacy)) await put('intimacyNotes', { id: uid('intimacy'), sourceEntryId: entryId, createdAt: new Date().toISOString(), ...item });
  for (const item of normalizeArray(parsed.calendar)) await put('calendarItems', { id: uid('calendar'), sourceEntryId: entryId, createdAt: new Date().toISOString(), ...item });
  for (const item of normalizeArray(parsed.patterns)) await put('patternItems', { id: uid('pattern'), sourceEntryId: entryId, createdAt: new Date().toISOString(), ...item });
  for (const item of normalizeArray(parsed.ideas)) await put('ideas', { id: uid('idea'), sourceEntryId: entryId, createdAt: new Date().toISOString(), ...item });
  await refresh();
}

function entryTitle(id) {
  const entry = state.entries.find((item) => item.id === id);
  return entry ? new Date(entry.createdAt).toLocaleString() : 'Unknown entry';
}

function renderJournal() {
  const filtered = state.entries.filter((entry) => `${entry.text} ${entry.summary} ${entry.tags?.join(' ')}`.toLowerCase().includes(state.query.toLowerCase()));
  app.innerHTML = `
    <section class="panel stack">
      <h2>Journal</h2>
      <p class="muted">Write messy notes. Entries save locally first, even when AI processing is unavailable.</p>
      <textarea id="entryText" rows="6" placeholder="he said this... we talked about trying this..."></textarea>
      <button id="saveEntryButton">Save local entry</button>
    </section>
    <section class="panel stack">
      <label>Search entries<input id="searchInput" value="${escapeHtml(state.query)}" placeholder="Search raw text, tags, or summary"></label>
    </section>
    <section>${filtered.length ? filtered.map(renderEntry).join('') : '<div class="empty">No entries yet.</div>'}</section>`;
  document.querySelector('#saveEntryButton').addEventListener('click', () => {
    const text = document.querySelector('#entryText').value;
    if (text.trim()) saveEntry(text);
  });
  document.querySelector('#searchInput').addEventListener('input', (event) => { state.query = event.target.value; renderJournal(); });
  document.querySelectorAll('[data-paste-json]').forEach((button) => button.addEventListener('click', () => openPasteDialog(button.dataset.pasteJson)));
}

function renderEntry(entry) {
  return `<article class="card">
    <div class="button-row"><h3>${new Date(entry.createdAt).toLocaleString()}</h3><span class="chip">${escapeHtml(entry.processingStatus)}</span></div>
    <p class="entry-text">${escapeHtml(entry.text)}</p>
    <p><strong>Summary:</strong> ${escapeHtml(entry.summary || 'None yet')}</p>
    <div class="grid-meta">${(entry.tags || []).map((tag) => `<span class="chip">${escapeHtml(tag)}</span>`).join('') || '<span class="chip">No tags</span>'}</div>
    <button class="ghost" data-paste-json="${entry.id}">Paste AI JSON</button>
  </article>`;
}

function renderListSection(title, storeName, fields) {
  const items = [...(state.derived[storeName] || [])].sort((a, b) => new Date(b.createdAt) - new Date(a.createdAt));
  app.innerHTML = `<section class="panel"><h2>${title}</h2><p class="muted">Derived from journal entries. Delete these without deleting source entries.</p></section>
  ${items.length ? items.map((item) => `<article class="card stack">${fields.map((field) => `<p><strong>${field}:</strong> ${escapeHtml(item[field] ?? '')}</p>`).join('')}<p class="muted">Source: ${escapeHtml(entryTitle(item.sourceEntryId))}</p><button class="danger" data-delete-store="${storeName}" data-delete-id="${item.id}">Delete derived item</button></article>`).join('') : '<div class="empty">Nothing filed here yet.</div>'}`;
  document.querySelectorAll('[data-delete-store]').forEach((button) => button.addEventListener('click', async () => { await remove(button.dataset.deleteStore, button.dataset.deleteId); await refresh(); }));
}

function renderSettings() {
  const provider = localStorage.getItem('us.provider') || 'DeepSeek';
  const apiKey = localStorage.getItem('us.apiKey') || '';
  const model = localStorage.getItem('us.model') || '';
  app.innerHTML = `<section class="panel stack"><h2>Settings</h2>
    <label>Provider<select id="provider"><option>DeepSeek</option><option>Groq</option></select></label>
    <label>API key<input id="apiKey" type="password" value="${escapeHtml(apiKey)}" placeholder="Stored in localStorage"></label>
    <label>Model name<input id="model" value="${escapeHtml(model)}" placeholder="Provider model name"></label>
    <p class="muted">Privacy: journal data is stored in IndexedDB on this device. API settings are stored in localStorage. Future AI processing will send only selected journal text to the configured provider; do not process text you do not want sent.</p>
    <div class="button-row"><button id="exportButton">Export JSON backup</button><button class="ghost" id="importButton">Import JSON backup</button></div>
    <textarea id="backupBox" rows="10" placeholder="Export appears here. Paste backup JSON here before importing."></textarea>
  </section>`;
  document.querySelector('#provider').value = provider;
  ['provider', 'apiKey', 'model'].forEach((id) => document.querySelector(`#${id}`).addEventListener('input', (event) => localStorage.setItem(`us.${id}`, event.target.value)));
  document.querySelector('#exportButton').addEventListener('click', async () => { document.querySelector('#backupBox').value = JSON.stringify(Object.fromEntries(await Promise.all(stores.map(async (s) => [s, await getAll(s)]))), null, 2); });
  document.querySelector('#importButton').addEventListener('click', async () => { const data = JSON.parse(document.querySelector('#backupBox').value); for (const store of stores) for (const item of normalizeArray(data[store])) await put(store, item); await refresh(); });
}

function openPasteDialog(entryId) {
  const dialog = document.querySelector('#pasteDialogTemplate').content.firstElementChild.cloneNode(true);
  document.body.append(dialog);
  dialog.querySelector('#applyJsonButton').addEventListener('click', async () => {
    try { await applyAiJson(entryId, dialog.querySelector('#jsonInput').value); dialog.close(); dialog.remove(); }
    catch (error) { const el = dialog.querySelector('#jsonError'); el.textContent = error.message; el.hidden = false; }
  });
  dialog.addEventListener('close', () => dialog.remove());
  dialog.showModal();
}

function escapeHtml(value) {
  return String(value).replace(/[&<>"]/g, (char) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[char]));
}

function render() {
  document.querySelectorAll('.nav-item').forEach((button) => button.classList.toggle('is-active', button.dataset.section === state.section));
  if (state.section === 'journal') return renderJournal();
  if (state.section === 'memory') return renderListSection('Memory', 'memoryItems', ['type', 'detail', 'importance']);
  if (state.section === 'intimacy') return renderListSection('Intimacy', 'intimacyNotes', ['type', 'detail', 'intensity', 'date']);
  if (state.section === 'calendar') return renderListSection('Calendar', 'calendarItems', ['type', 'title', 'date', 'detail']);
  if (state.section === 'patterns') return renderListSection('Patterns', 'patternItems', ['type', 'detail', 'confidence']);
  if (state.section === 'ideas') return renderListSection('Ideas', 'ideas', ['type', 'idea', 'status']);
  renderSettings();
}

document.querySelectorAll('.nav-item').forEach((button) => button.addEventListener('click', () => { state.section = button.dataset.section; render(); }));

openDb().then(async (db) => { state.db = db; dbStatus.textContent = 'Local'; await refresh(); }).catch((error) => { dbStatus.textContent = 'DB error'; app.innerHTML = `<p class="error">${escapeHtml(error.message)}</p>`; });
