// vfs.js — The app's saved files (scripts, CSV, .mat), kept in IndexedDB
// so they survive page reloads. Everything is mirrored in memory (`files`)
// for synchronous access; writes go to IndexedDB in the background. If
// IndexedDB is unavailable (some private-browsing modes), files still
// work for the session, they just aren't saved.

const DB_NAME = 'matweb';
const STORE = 'files';

function openDb() {
  return new Promise((resolve, reject) => {
    const req = indexedDB.open(DB_NAME, 1);
    req.onupgradeneeded = () => req.result.createObjectStore(STORE, { keyPath: 'name' });
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
}

function getAll(db) {
  return new Promise((resolve, reject) => {
    const req = db.transaction(STORE, 'readonly').objectStore(STORE).getAll();
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
}

// Text formats are stored as strings, everything else as bytes.
const TEXT_EXTS = new Set(['m', 'csv', 'txt', 'json', 'tsv', 'dat']);
export function kindFor(name) {
  const ext = (name.split('.').pop() || '').toLowerCase();
  if (ext === 'm') return 'm';
  if (ext === 'mat') return 'mat';
  return TEXT_EXTS.has(ext) ? 'text' : 'binary';
}
export function isTextKind(kind) { return kind === 'm' || kind === 'csv' || kind === 'text'; }

export async function openVfs() {
  let db = null;
  const files = new Map();
  try {
    db = await openDb();
    for (const rec of await getAll(db)) {
      const { name, ...entry } = rec;
      files.set(name, entry);
    }
  } catch (e) {
    db = null;
  }
  const write = (fn) => {
    if (!db) return;
    try {
      const tx = db.transaction(STORE, 'readwrite');
      fn(tx.objectStore(STORE));
    } catch (e) { /* storage full or unavailable: keep the in-memory copy */ }
  };
  return {
    files,
    persistent: !!db,
    put(name, entry) {
      const rec = { ...entry, mtime: Date.now() };
      files.set(name, rec);
      write(store => store.put({ name, ...rec }));
      return rec;
    },
    remove(name) {
      files.delete(name);
      write(store => store.delete(name));
    },
  };
}
