// Lokale opslag in IndexedDB: motoren en opnames (de WAV als Blob bij de opname).

const DB_NAME = 'racesounds-opname';
const DB_VERSION = 1;
let dbPromise = null;

function open() {
  if (!dbPromise) {
    dbPromise = new Promise((resolve, reject) => {
      const req = indexedDB.open(DB_NAME, DB_VERSION);
      req.onupgradeneeded = () => {
        const db = req.result;
        if (!db.objectStoreNames.contains('motors')) db.createObjectStore('motors', { keyPath: 'id' });
        if (!db.objectStoreNames.contains('takes')) {
          const s = db.createObjectStore('takes', { keyPath: 'id' });
          s.createIndex('motorId', 'motorId');
        }
      };
      req.onsuccess = () => resolve(req.result);
      req.onerror = () => reject(req.error);
    });
  }
  return dbPromise;
}

async function run(store, mode, fn) {
  const db = await open();
  return new Promise((resolve, reject) => {
    const tx = db.transaction(store, mode);
    const req = fn(tx.objectStore(store));
    tx.oncomplete = () => resolve(req.result);
    tx.onerror = () => reject(tx.error);
    tx.onabort = () => reject(tx.error || new Error('Opslag afgebroken (vol?)'));
  });
}

export const listMotors = () => run('motors', 'readonly', (s) => s.getAll());
export const getMotor = (id) => run('motors', 'readonly', (s) => s.get(id));
export const putMotor = (m) => run('motors', 'readwrite', (s) => s.put(m));
export const putTake = (t) => run('takes', 'readwrite', (s) => s.put(t));
export const getTake = (id) => run('takes', 'readonly', (s) => s.get(id));
export const deleteTake = (id) => run('takes', 'readwrite', (s) => s.delete(id));
export const listTakes = (motorId) => run('takes', 'readonly', (s) => s.index('motorId').getAll(motorId));

/** Opnamegegevens zonder de audio (voor lijsten). */
export async function listTakeMeta(motorId) {
  return (await listTakes(motorId)).map(({ wav, ...rest }) => rest);
}

export async function deleteMotor(id) {
  const takes = await listTakes(id);
  const db = await open();
  await new Promise((resolve, reject) => {
    const tx = db.transaction(['motors', 'takes'], 'readwrite');
    tx.objectStore('motors').delete(id);
    for (const t of takes) tx.objectStore('takes').delete(t.id);
    tx.oncomplete = resolve;
    tx.onerror = () => reject(tx.error);
  });
}

/** Vraag de browser de opslag niet op te ruimen bij ruimtegebrek. */
export async function requestPersistence() {
  try {
    if (navigator.storage?.persisted && !(await navigator.storage.persisted())) await navigator.storage.persist();
  } catch { /* niet ondersteund */ }
}

export async function storageEstimate() {
  try {
    return await navigator.storage?.estimate?.();
  } catch {
    return null;
  }
}
