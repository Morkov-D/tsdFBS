/* StockFlow TSD IndexedDB — v2.0.3.
 * IMPORTANT: Keep JS keywords and store names in English. Do not translate this file.
 * DB name and version remain unchanged to preserve unfinished assemblies.
 */
'use strict';
window.DB = (() => {
  const DB_NAME = 'stockflow-tsd-v1';
  const DB_VERSION = 1;
  const STORES = ['meta', 'catalog', 'queue', 'draft'];
  let connectionPromise = null;

  function open() {
    if (connectionPromise) return connectionPromise;
    connectionPromise = new Promise((resolve, reject) => {
      if (!('indexedDB' in window)) {
        reject(new Error('Браузер ТСД не поддерживает IndexedDB'));
        return;
      }
      const request = indexedDB.open(DB_NAME, DB_VERSION);
      request.onupgradeneeded = () => {
        const db = request.result;
        for (const name of STORES) {
          if (!db.objectStoreNames.contains(name)) {
            db.createObjectStore(name, { keyPath: 'id' });
          }
        }
      };
      request.onsuccess = () => {
        const db = request.result;
        db.onversionchange = () => {
          db.close();
          connectionPromise = null;
        };
        resolve(db);
      };
      request.onerror = () => reject(request.error || new Error('Ошибка открытия IndexedDB'));
      request.onblocked = () => reject(new Error('База данных занята другой вкладкой. Закройте лишние вкладки ТСД.'));
    }).catch(err => {
      // Allow the operator to retry after a temporary IndexedDB failure.
      connectionPromise = null;
      throw err;
    });
    return connectionPromise;
  }

  function transaction(db, storeNames, mode, operation) {
    return new Promise((resolve, reject) => {
      let tx;
      let result;
      try {
        tx = db.transaction(storeNames, mode);
        result = operation(tx);
      } catch (error) {
        if (tx) { try { tx.abort(); } catch (_) {} }
        reject(error);
        return;
      }
      // Resolve only once the transaction has actually committed.
      tx.oncomplete = () => resolve(result);
      tx.onerror = () => reject(tx.error || new Error('Ошибка записи IndexedDB'));
      tx.onabort = () => reject(tx.error || new Error('Транзакция IndexedDB отменена'));
    });
  }

  async function put(store, id, value) {
    const db = await open();
    return transaction(db, store, 'readwrite', tx => {
      tx.objectStore(store).put({ id, value });
    });
  }

  async function del(store, id) {
    const db = await open();
    return transaction(db, store, 'readwrite', tx => {
      tx.objectStore(store).delete(id);
    });
  }

  async function get(store, id) {
    const db = await open();
    return new Promise((resolve, reject) => {
      const tx = db.transaction(store, 'readonly');
      const request = tx.objectStore(store).get(id);
      request.onsuccess = () => resolve(request.result ? request.result.value : undefined);
      request.onerror = () => reject(request.error || new Error('Не удалось прочитать запись'));
    });
  }

  async function all(store) {
    const db = await open();
    return new Promise((resolve, reject) => {
      const tx = db.transaction(store, 'readonly');
      const request = tx.objectStore(store).getAll();
      request.onsuccess = () => resolve(request.result.map(row => row.value));
      request.onerror = () => reject(request.error || new Error('Не удалось прочитать список'));
    });
  }

  async function replaceCatalog(data) {
    const db = await open();
    return transaction(db, 'catalog', 'readwrite', tx => {
      const store = tx.objectStore('catalog');
      store.clear();
      store.put({ id: 'snapshot', value: data });
    });
  }

  // One IndexedDB transaction: either both actions succeed, or neither does.
  async function commitAssembly(job) {
    if (!job || !job.jobId) throw new Error('У сборки отсутствует jobId');
    const db = await open();
    return transaction(db, ['queue', 'draft'], 'readwrite', tx => {
      tx.objectStore('queue').put({ id: job.jobId, value: job });
      tx.objectStore('draft').delete('current');
    });
  }

  return { open, get, all, put, del, replaceCatalog, commitAssembly };
})();
