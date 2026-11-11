import { applyDocumentPatch } from './persistence.mjs?v=20261111-cover-dialogs';

let db,
  state,
  revision = 0,
  savedRevision = 0,
  timer,
  writing = false;

async function start() {
  db = await new Promise((resolve, reject) => {
    const request = indexedDB.open('tetrad-studio', 1);
    request.onupgradeneeded = () =>
      request.result.createObjectStore('workspace');
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error);
  });
  state = await new Promise((resolve, reject) => {
    const request = db
      .transaction('workspace')
      .objectStore('workspace')
      .get('state');
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error);
  });
  postMessage({ type: 'ready' });
}

function persist() {
  clearTimeout(timer);
  timer = null;
  if (writing || savedRevision === revision) return;
  writing = true;
  const saving = revision;
  const tx = db.transaction('workspace', 'readwrite', { durability: 'strict' });
  tx.objectStore('workspace').put(state, 'state');
  tx.oncomplete = () => {
    writing = false;
    savedRevision = saving;
    postMessage({ type: 'saved', revision: saving });
    if (revision !== savedRevision) persist();
  };
  tx.onerror = tx.onabort = () => {
    writing = false;
    postMessage({ type: 'error' });
  };
}

self.onmessage = ({ data }) => {
  try {
    if (data.type === 'start') {
      start().catch(() => postMessage({ type: 'error' }));
      return;
    }
    if (data.type === 'patch') {
      state = applyDocumentPatch(state, data.patch);
      revision = data.revision;
      if (!timer)
        timer = setTimeout(() => {
          try {
            persist();
          } catch {
            postMessage({ type: 'error' });
          }
        }, 150);
    }
    if (data.type === 'flush') persist();
  } catch {
    postMessage({ type: 'error' });
  }
};
