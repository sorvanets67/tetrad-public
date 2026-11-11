import {
  W,
  H,
  uid,
  newPage,
  initialState,
  segmentDistance,
  strokeHit,
  strokeBounds,
  scribbleArea,
  scribbleHits,
  insideLasso,
  translateElement,
  validateState,
  DEFAULT_PRESSURE,
  penWidth,
  averagePressure,
  recentWritingPressure,
  aspectResizeBounds
} from './core.mjs?v=20261111-cover-dialogs';
import {
  recognizeShape,
  shapeNames,
  createShapePoints,
  resizeElement,
  transformStroke
} from './shapes.mjs?v=20261111-cover-dialogs';
import {
  DocumentPatches,
  snapshotDocument
} from './persistence.mjs?v=20261111-cover-dialogs';
import { drawPenSamples } from './ink.mjs?v=20261111-cover-dialogs';
import { PageStack } from './page-stack.mjs?v=20261111-cover-dialogs';
import { migrateLibrary, folderPath, folderFrontBounds, extendCoverArtworkEdges } from './library.mjs?v=20261111-cover-dialogs';

const $ = (id) => document.getElementById(id),
  canvas = $('canvas'),
  ctx = canvas.getContext('2d'),
  inkCanvas = $('inkCanvas'),
  inkContext = inkCanvas.getContext('2d');

let state,
  db,
  tool = 'pen',
  shapeKind = 'rectangle',
  color = '#8d3e61',
  size = 3,
  zoom = 0.75,
  selection = [],
  gesture = null,
  space = false;

let undoStack = [],
  redoStack = [],
  saveRevision = 0,
  persistedRevision = 0,
  saveTimer = null,
  saveDue = false,
  fallbackWriting = false,
  storageWorker = null,
  workerReady = false,
  images = new Map(),
  toastTimer;
let clipboard = null;
let clipboardToken = null;
let writingStrokeId = null;
let sceneDecorated = false;
const patches = new DocumentPatches();
const dirtyPages = new Set();
let pageStack = null;
const pageHistories = new Map();
let historyDocument = null;
let pastePointer = null;
let viewMode = 'editor', browsedFolderId = null;
let storageWritable = true, loadedBackup, workerStartTimer;
let selectedFolderId = null,
  libraryState = null,
  libraryBookId = null;
const expandedFolders = new Set();

const hint = {
  shape: 'Фигуры · проведи по странице, чтобы задать размер',
  pen: 'Перо · пиши и рисуй на странице',
  marker: 'Маркер · выделяй важное',
  eraser: 'Ластик · удаляет штрих целиком',
  text: 'Текст · нажми на лист, чтобы добавить подпись',
  select: 'Лассо · обведи объекты, затем перетаскивай выделенную область',
  hand: 'Рука · перетаскивай холст'
};

function toast(t) {
  $('toast').textContent = t;
  $('toast').style.display = 'block';
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => ($('toast').style.display = 'none'), 4200);
}

function current() {
  return state.books
    .flatMap((b) => b.pages)
    .find((p) => p.id === state.activePage);
}

function book() {
  return state.books.find((b) =>
    b.pages.some((p) => p.id === state.activePage)
  );
}

function pageLabel() {
  const index = book().pages.findIndex((page) => page.id === state.activePage);
  return 'Страница ' + (index + 1);
}

function save() {
  saveRevision++;
  dirtyPages.add(state.activePage);
  $('saveStatus').textContent = 'Сохраняется…';
  if (saveDue && !gesture) flushSave();
  else if (!saveTimer) saveTimer = setTimeout(flushSave, 120);
}

function storageNotice(message) {
  $('storageMessage').textContent = message;
  $('storageNotice').hidden = false;
}

function saveFailed(error) {
  $('saveStatus').textContent = 'Не сохранено';
  const reason = error?.name === 'QuotaExceededError'
    ? 'В хранилище браузера не хватает места.'
    : 'Браузер не смог записать конспект.';
  storageNotice(reason + ' Записи остаются на экране. Скачай полную резервную копию перед закрытием и попробуй сохранить повторно.');
  toast(reason + ' Скачай резервную копию перед закрытием.');
}

function saved(revision) {
  persistedRevision = Math.max(persistedRevision, revision);
  if (revision === saveRevision && !gesture && storageWritable) {
    $('saveStatus').textContent = '✓ Сохранено';
    $('storageNotice').hidden = true;
  }
}

function flushSave() {
  clearTimeout(saveTimer);
  saveTimer = null;
  if (!state) return;
  if (!storageWritable) { saveFailed(); return; }
  if (gesture || fallbackWriting || (storageWorker && !workerReady)) {
    saveDue = true;
    return;
  }
  saveDue = false;
  const revision = saveRevision;
  if (storageWorker) {
    try {
      const patch = patches.create(state, dirtyPages);
      dirtyPages.clear();
      storageWorker.postMessage({ type: 'patch', revision, patch });
      return;
    } catch {
      useFallbackStorage();
      return;
    }
  }
  try {
    if (!db) throw Error('Хранилище недоступно');
    fallbackWriting = true;
    const tx = db.transaction('workspace', 'readwrite', { durability: 'strict' });
    tx.objectStore('workspace').put(snapshotDocument(state), 'state');
    tx.oncomplete = () => {
      fallbackWriting = false;
      saved(revision);
      if (saveRevision !== revision || saveDue) flushSave();
    };
    tx.onerror = tx.onabort = () => {
      fallbackWriting = false;
      saveFailed(tx.error);
    };
  } catch (error) {
    fallbackWriting = false;
    saveFailed(error);
  }
}

function useFallbackStorage() {
  clearTimeout(workerStartTimer);
  storageWorker?.terminate();
  storageWorker = null;
  workerReady = false;
  flushSave();
}

function startStorageWorker(stored) {
  if (typeof Worker === 'undefined') return;
  try {
    if (stored) patches.prime(state);
    storageWorker = new Worker(
      new URL('./storage-worker.mjs?v=20261111-cover-dialogs', import.meta.url),
      { type: 'module' }
    );
    storageWorker.onmessage = ({ data }) => {
      if (data.type === 'ready') {
        clearTimeout(workerStartTimer);
        workerReady = true;
        if (saveDue) flushSave();
      }
      if (data.type === 'saved') saved(data.revision);
      if (data.type === 'error') useFallbackStorage();
    };
    storageWorker.onerror = () => useFallbackStorage();
    workerStartTimer = setTimeout(useFallbackStorage, 5000);
    storageWorker.postMessage({ type: 'start' });
  } catch {
    useFallbackStorage();
  }
}

function history() {
  resetDocumentHistory();
  $('saveStatus').textContent = 'Сохраняется…';
  undoStack.push(current().elements.slice());
  if (undoStack.length > 60) undoStack.shift();
  redoStack = [];
  updateUndo();
}

function updateUndo() {
  $('undo').disabled = !undoStack.length;
  $('redo').disabled = !redoStack.length;
}

function undo() {
  if (gesture || !undoStack.length) return;
  redoStack.push(current().elements.slice());
  current().elements = undoStack.pop();
  selection = [];
  draw();
  updateUndo();
  save();
}

function redo() {
  if (gesture || !redoStack.length) return;
  undoStack.push(current().elements.slice());
  current().elements = redoStack.pop();
  selection = [];
  draw();
  updateUndo();
  save();
}

function renderNav() {
  const b = book(),
    p = current();
  if (viewMode === 'library' && !state.folders?.some(folder => folder.id === browsedFolderId)) browsedFolderId = null;
  renderLibrary();
  const path = folderPath(state, b.folderId).map(folder => folder.name);
  $('bookCrumb').textContent = path.join(' / ');
  $('bookCrumb').title = path.join(' / ');
  $('pageCrumb').textContent = b.name;
  $('pageCrumb').title = [...path, b.name].join(' / ');
  $('sheetCrumb').textContent = pageLabel();
  $('paper').value = p.paper;
  $('paperColor').value = p.paperColor || 'white';
  renderPageStack();
  renderWorkspace();
  $('pathSeparator').hidden = !$('bookCrumb').textContent;
}

function showLibrary(folderId = null) {
  if (!state || gesture || $('dialog').open) return;
  viewMode = 'library';
  browsedFolderId = state.folders.some(folder => folder.id === folderId) ? folderId : null;
  selectedFolderId = browsedFolderId;
  if (!browsedFolderId) expandedFolders.clear();
  for (const folder of folderPath(state, browsedFolderId)) expandedFolders.add(folder.id);
  closeSelectionMenu();
  closeShapeMenu();
  renderNav();
}

function openDocument(id) {
  if (!state || gesture || $('dialog').open) return;
  const item = state.books.find(item => item.id === id);
  if (!item) return;
  viewMode = 'editor';
  const pageId = item.pages.some(page => page.id === state.activePage) ? state.activePage : item.pages[0].id;
  switchPage(pageId);
  fit();
  pageStack?.scrollTo(pageId);
}

const folderArtworkCache = new Map();

function fitFolderArtwork(image, source) {
  if (!image.isConnected) return;
  try {
    let prepared = folderArtworkCache.get(source);
    if (!prepared) {
      const canvas = document.createElement('canvas');
      const scale = Math.min(1, 768 / Math.max(image.naturalWidth, image.naturalHeight));
      canvas.width = Math.max(1, Math.round(image.naturalWidth * scale));
      canvas.height = Math.max(1, Math.round(image.naturalHeight * scale));
      const context = canvas.getContext('2d', { willReadFrequently: true });
      context.drawImage(image, 0, 0, canvas.width, canvas.height);
      const pixels = context.getImageData(0, 0, canvas.width, canvas.height);
      const bounds = folderFrontBounds(pixels);
      // Crop the rectangular front; the standard rose tab is drawn separately.
      const expanded = context.createImageData(canvas.width, canvas.height);
      expanded.data.set(extendCoverArtworkEdges(pixels));
      context.putImageData(expanded, 0, 0);
      const cropped = document.createElement('canvas');
      cropped.width = Math.max(1, Math.round(canvas.width * bounds.width));
      cropped.height = Math.max(1, Math.round(canvas.height * bounds.height));
      cropped.getContext('2d').drawImage(canvas,
        bounds.x * canvas.width, bounds.y * canvas.height,
        canvas.width * bounds.width, canvas.height * bounds.height,
        0, 0, cropped.width, cropped.height);
      prepared = cropped.toDataURL('image/webp', 0.95);
      if (folderArtworkCache.size >= 32) folderArtworkCache.delete(folderArtworkCache.keys().next().value);
      folderArtworkCache.set(source, prepared);
    }
    image.onload = () => {
      image.dataset.fitted = 'true';
      image.onload = null;
    };
    image.src = prepared;
  } catch {
    image.onload = null;
    image.dataset.fitted = 'fallback';
  }
}

function createCoverCard(item, folder, cover = item.cover) {
  const card = document.createElement('button');
  card.type = 'button';
  card.title = item.name;
  card.className = 'library-card ' + (folder ? 'folder-card' : 'document-card');
  const icon = document.createElement('span');
  icon.className = folder ? 'folder-symbol' : 'book-symbol';
  icon.setAttribute('aria-hidden', 'true');
  const name = document.createElement('strong');
  name.textContent = item.name;
  card.append(icon, name);
  if (!folder) {
    const detail = document.createElement('small');
    detail.textContent = `Документ · ${item.pages.length} стр.`;
    card.append(detail);
  }
  if (!cover) return card;
  if (folder && cover.tabColor) {
    card.classList.add('custom-tab');
    card.style.setProperty('--folder-tab-color', cover.tabColor);
  }
  if (!folder && cover.spineColor) {
    card.classList.add('custom-spine');
    card.style.setProperty('--spine-color', cover.spineColor);
  }
  if (!cover.color && !cover.image) return card;
  const color = cover.color || '#dfb2c4';
  const mix = (target, amount) => '#' + [1, 3, 5].map(index => {
    const value = parseInt(color.slice(index, index + 2), 16);
    const other = parseInt(target.slice(index, index + 2), 16);
    return Math.round(value + (other - value) * amount).toString(16).padStart(2, '0');
  }).join('');
  const brightness = [1, 3, 5].map(index => parseInt(color.slice(index, index + 2), 16));
  const dark = brightness[0] * 0.2126 + brightness[1] * 0.7152 + brightness[2] * 0.0722 < 145;
  card.classList.add('custom-cover');
  card.style.setProperty('--cover-color', color);
  card.style.setProperty('--cover-light', mix('#ffffff', 0.18));
  card.style.setProperty('--cover-dark', mix('#523345', 0.28));
  card.style.setProperty('--cover-ink', dark ? '#fffafd' : '#49313d');
  if (cover.image) {
    const image = document.createElement('img');
    image.className = 'cover-image';
    image.alt = '';
    image.draggable = false;
    card.classList.add('has-cover-image');
    if (folder) {
      const artwork = document.createElement('span');
      artwork.className = 'folder-cover-art';
      artwork.setAttribute('aria-hidden', 'true');
      image.onload = () => fitFolderArtwork(image, cover.image);
      artwork.append(image);
      card.append(artwork);
    } else card.append(image);
    image.src = cover.image;
  }
  return card;
}

function editCover(item) {
  if (!state || gesture || $('dialog').open) return;
  const documentState = state;
  const folder = state.folders.includes(item);
  let draft = item.cover ? { ...item.cover } : null;
  let revision = 0;
  const body = document.createElement('div');
  body.className = 'cover-editor';
  body.innerHTML = '<div id="coverPreview" class="cover-preview"></div>' +
    '<div class="cover-options"><label>Цвет обложки <input id="coverColor" type="color"></label>' +
    '<div class="cover-palette" aria-label="Цвета обложки"></div>' +
    '<div class="cover-upload"><span>Своя картинка</span><button id="coverUpload" type="button">Выбрать картинку…</button>' +
    '<input id="coverFile" type="file" accept="image/png,image/jpeg,image/webp" hidden></div>' +
    '<button id="coverRemoveImage" type="button">Убрать картинку</button>' +
    '<button id="coverReset" type="button">Вернуть стандартную обложку</button>' +
    '<p id="coverStatus" role="status"></p></div>';
  const refresh = () => {
    const preview = createCoverCard(item, folder, draft);
    preview.tabIndex = -1;
    preview.setAttribute('aria-label', 'Предпросмотр обложки');
    $('coverPreview').replaceChildren(preview);
    $('coverColor').value = draft?.color || '#dfb2c4';
    $('coverRemoveImage').disabled = !draft?.image;
  };
  showDialog('Обложка: ' + item.name, body, () => {
    if (state !== documentState || (!state.folders.includes(item) && !state.books.includes(item))) return;
    if (draft) item.cover = { ...draft };
    else delete item.cover;
    renderNav();
    save();
  });
  $('dialogOk').textContent = 'Сохранить';
  const setColor = (color) => {
    draft = { ...draft, color };
    refresh();
  };
  $('coverColor').oninput = event => setColor(event.target.value);
  $('coverUpload').onclick = () => $('coverFile').click();
  for (const color of ['#dfb2c4', '#b96c91', '#abc4d4', '#c2b3d1', '#d5b5a4', '#d7c990']) {
    const swatch = document.createElement('button');
    swatch.type = 'button';
    swatch.className = 'cover-swatch';
    swatch.style.setProperty('--swatch', color);
    swatch.setAttribute('aria-label', 'Цвет обложки ' + color);
    swatch.onclick = () => setColor(color);
    body.querySelector('.cover-palette').append(swatch);
  }
  $('coverRemoveImage').onclick = () => {
    revision++;
    if (draft) delete draft.image;
    $('dialogOk').disabled = false;
    $('coverStatus').textContent = 'Картинка убрана. Нажми «Сохранить», чтобы применить.';
    refresh();
  };
  $('coverReset').onclick = () => {
    revision++;
    const accentKey = folder ? 'tabColor' : 'spineColor';
    draft = draft?.[accentKey] ? { [accentKey]: draft[accentKey] } : null;
    $('dialogOk').disabled = false;
    $('coverFile').value = '';
    $('coverStatus').textContent = 'Стандартная обложка. Нажми «Сохранить», чтобы применить.';
    refresh();
  };
  $('coverFile').onchange = async (event) => {
    const file = event.target.files[0];
    event.target.value = '';
    if (!file) return;
    const request = ++revision;
    const active = () => request === revision && state === documentState && body.isConnected && $('dialog').open;
    $('dialogOk').disabled = true;
    $('coverStatus').textContent = 'Подготавливаем картинку…';
    try {
      if (!['image/png', 'image/jpeg', 'image/webp'].includes(file.type) || file.size > 25 * 1024 * 1024)
        throw Error('Выбери PNG, JPEG или WebP размером до 25 МБ.');
      const bitmap = await createImageBitmap(file);
      let image;
      try {
        const scale = Math.min(1, 1000 / Math.max(bitmap.width, bitmap.height));
        const canvas = document.createElement('canvas');
        canvas.width = Math.max(1, Math.round(bitmap.width * scale));
        canvas.height = Math.max(1, Math.round(bitmap.height * scale));
        canvas.getContext('2d').drawImage(bitmap, 0, 0, canvas.width, canvas.height);
        image = canvas.toDataURL('image/webp', 0.85);
        if (image.length > 4_000_000) throw Error('Картинка слишком большая. Выбери другое изображение.');
      } finally { bitmap.close(); }
      if (!active()) return;
      draft = { ...draft, image };
      $('coverStatus').textContent = 'Картинка готова. Нажми «Сохранить», чтобы применить.';
      refresh();
    } catch (error) {
      if (active()) $('coverStatus').textContent = error.message || 'Не удалось открыть картинку.';
    } finally {
      if (active()) $('dialogOk').disabled = false;
    }
  };
  refresh();
}

function editCoverAccent(item, folder = true) {
  const collection = folder ? state?.folders : state?.books;
  const key = folder ? 'tabColor' : 'spineColor';
  const title = folder ? 'Цвет выступа' : 'Цвет корешка';
  const label = folder ? 'Цвет верхнего выступа' : 'Цвет корешка слева';
  const resetLabel = folder ? 'Вернуть розовый выступ' : 'Вернуть розовый корешок';
  if (!state || gesture || $('dialog').open || !collection.includes(item)) return;
  const documentState = state;
  let draft = item.cover ? { ...item.cover } : {};
  const body = document.createElement('div');
  body.className = 'cover-editor';
  body.innerHTML = '<div id="tabPreview" class="cover-preview"></div>' +
    '<div class="cover-options"><label>' + label + '<input id="tabColor" type="color"></label>' +
    '<div id="tabPalette" class="cover-palette" aria-label="' + title + '"></div>' +
    '<button id="tabReset" type="button">' + resetLabel + '</button>' +
    '<p id="tabStatus" role="status"></p></div>';
  const refresh = () => {
    const preview = createCoverCard(item, folder, draft);
    preview.tabIndex = -1;
    $('tabPreview').replaceChildren(preview);
    $('tabColor').value = draft[key] || (folder ? '#c58ca6' : '#cf99b0');
  };
  const choose = (color) => {
    if (!/^#[0-9a-f]{6}$/i.test(color)) return;
    draft = { ...draft, [key]: color.toLowerCase() };
    $('tabStatus').textContent = 'Цвет выбран. Нажми «Сохранить», чтобы применить.';
    refresh();
  };
  showDialog(title + ': ' + item.name, body, () => {
    if (state !== documentState || !collection.includes(item)) return;
    if (Object.keys(draft).length) item.cover = { ...draft };
    else delete item.cover;
    renderNav();
    save();
  });
  $('dialogOk').textContent = 'Сохранить';
  $('tabColor').oninput = event => choose(event.target.value);
  for (const color of ['#c58ca6', '#e3b9cb', '#a27794', '#b29ac4', '#91a5be', '#9dab93']) {
    const swatch = document.createElement('button');
    swatch.type = 'button';
    swatch.className = 'cover-swatch';
    swatch.style.setProperty('--swatch', color);
    swatch.setAttribute('aria-label', title + ' ' + color);
    swatch.onclick = () => choose(color);
    $('tabPalette').append(swatch);
  }
  $('tabReset').onclick = () => {
    delete draft[key];
    $('tabStatus').textContent = 'Стандартный розовый цвет. Нажми «Сохранить», чтобы применить.';
    refresh();
  };
  refresh();
}

function renderWorkspace() {
  const browsing = viewMode === 'library';
  $('libraryView').hidden = !browsing;
  $('editorView').hidden = browsing;
  $('export').hidden = browsing;
  $('pathBreadcrumb').hidden = browsing && !browsedFolderId;
  if (!browsing) return;
  if (!state.folders.some(folder => folder.id === browsedFolderId)) browsedFolderId = null;
  const path = folderPath(state, browsedFolderId);
  $('bookCrumb').textContent = path.slice(0, -1).map(folder => folder.name).join(' / ');
  $('bookCrumb').title = path.map(folder => folder.name).join(' / ');
  $('pageCrumb').textContent = path.at(-1)?.name || 'Мои тетради';
  $('pageCrumb').title = $('bookCrumb').title;
  $('sheetCrumb').textContent = '';
  $('libraryTitle').textContent = path.at(-1)?.name || 'Мои тетради';
  $('libraryDescription').textContent = browsedFolderId ? 'Выбери папку или документ, чтобы продолжить.' : 'Выбери тетрадь или добавь новую.';
  const controls = $('libraryControls');
  controls.replaceChildren();
  const action = (label, callback) => {
    const button = document.createElement('button');
    button.type = 'button';
    button.textContent = label;
    button.onclick = callback;
    controls.append(button);
  };
  if (browsedFolderId) {
    action('← Назад', () => showLibrary(path.at(-1).parentId));
    action('＋ Папка', () => createFolder(browsedFolderId));
    action('＋ Документ', () => createDocument(browsedFolderId));
  } else action('＋ Добавить тетрадь', () => createFolder());
  const grid = $('libraryGrid');
  grid.replaceChildren();
  const card = (item, folder) => {
    const button = createCoverCard(item, folder);
    if (folder) button.dataset.openFolder = item.id;
    else button.dataset.openDocument = item.id;
    button.onclick = () => folder ? showLibrary(item.id) : openDocument(item.id);
    button.oncontextmenu = (event) => {
      event.preventDefault();
      event.stopPropagation();
      if (folder) openFolderMenu(item.id);
      else openDocumentMenu(item.id);
    };
    grid.append(button);
  };
  for (const folder of state.folders.filter(folder => folder.parentId === browsedFolderId)) card(folder, true);
  if (browsedFolderId) for (const item of state.books.filter(item => item.folderId === browsedFolderId)) card(item, false);
  if (!grid.childNodes.length) {
    const empty = document.createElement('p');
    empty.className = 'library-empty';
    empty.textContent = 'Здесь пока пусто. Добавь папку или документ кнопками сверху.';
    grid.append(empty);
  }
}

$('libraryHome').onclick = () => showLibrary();

function renderLibrary() {
  migrateLibrary(state);
  const active = book();
  if (libraryState !== state || libraryBookId !== active.id) {
    selectedFolderId = active.folderId;
    if (libraryState !== state) expandedFolders.clear();
    if (viewMode === 'editor') {
      for (const folder of folderPath(state, active.folderId)) expandedFolders.add(folder.id);
    }
  }
  libraryState = state;
  libraryBookId = active.id;
  const folderById = new Map(state.folders.map(folder => [folder.id, folder]));
  if (!folderById.has(selectedFolderId)) selectedFolderId = active.folderId;
  if (viewMode === 'library') selectedFolderId = browsedFolderId;
  const children = new Map();
  for (const folder of state.folders) {
    if (!children.has(folder.parentId)) children.set(folder.parentId, []);
    children.get(folder.parentId).push(folder);
  }
  const documents = new Map();
  for (const item of state.books) {
    if (!documents.has(item.folderId)) documents.set(item.folderId, []);
    documents.get(item.folderId).push(item);
  }
  const buildFolder = (folder) => {
    const details = document.createElement('details');
    details.className = 'library-folder';
    details.dataset.folderId = folder.id;
    details.open = expandedFolders.has(folder.id);
    details.ontoggle = () => {
      if (!details.isConnected) return;
      if (details.open) expandedFolders.add(folder.id);
      else expandedFolders.delete(folder.id);
    };
    const summary = document.createElement('summary');
    summary.className = 'folder-row' + (viewMode === 'library' && folder.id === browsedFolderId ? ' selected' : '');
    summary.title = folder.name + ' · правая кнопка — действия; двойной щелчок — переименовать';
    const icon = document.createElement('span');
    icon.className = 'folder-symbol';
    icon.setAttribute('aria-hidden', 'true');
    const label = document.createElement('span');
    label.className = 'book-name';
    label.textContent = folder.name;
    summary.append(icon, label);
    summary.oncontextmenu = (event) => {
      event.preventDefault();
      event.stopPropagation();
      openFolderMenu(folder.id);
    };
    summary.onclick = (event) => {
      event.preventDefault();
      if (gesture || $('dialog').open) return;
      if (details.open) {
        details.open = false;
        expandedFolders.delete(folder.id);
        return;
      }
      selectedFolderId = folder.id;
      document.querySelectorAll('.folder-row').forEach(row => row.classList.remove('selected'));
      summary.classList.add('selected');
      showLibrary(folder.id);
    };
    summary.ondblclick = () => renameLibraryItem(folder, folder.parentId ? 'Название папки' : 'Название тетради');
    const contents = document.createElement('div');
    contents.className = 'folder-contents';
    for (const nested of children.get(folder.id) || []) contents.append(buildFolder(nested));
    for (const item of documents.get(folder.id) || []) {
      const button = document.createElement('button');
      button.className = 'book document-row' + (viewMode === 'editor' && item === active ? ' selected' : '');
      button.dataset.documentId = item.id;
      button.title = item.name + ' · правая кнопка — действия; двойной щелчок — переименовать';
      const symbol = document.createElement('span');
      symbol.className = 'book-symbol';
      symbol.setAttribute('aria-hidden', 'true');
      const name = document.createElement('span');
      name.className = 'book-name';
      name.textContent = item.name === folder.name ? 'Страницы' : item.name;
      const count = document.createElement('small');
      count.textContent = item.pages.length;
      button.append(symbol, name, count);
      button.onclick = () => {
        selectedFolderId = item.folderId;
        openDocument(item.id);
      };
      button.ondblclick = () => renameLibraryItem(item, 'Название документа');
      button.oncontextmenu = (event) => {
        event.preventDefault();
        event.stopPropagation();
        openDocumentMenu(item.id);
      };
      contents.append(button);
    }
    if (!contents.childNodes.length) {
      const empty = document.createElement('p');
      empty.className = 'folder-empty';
      empty.textContent = 'Папка пуста';
      contents.append(empty);
    }
    details.append(summary, contents);
    return details;
  };
  $('books').replaceChildren(...(children.get(null) || []).map(buildFolder));
}

async function renameLibraryItem(item, title) {
  if (!state || gesture || $('dialog').open) return;
  const documentState = state;
  const name = await ask(title, item.name);
  if (state !== documentState || !name?.trim()) return;
  if (!state.folders.includes(item) && !state.books.includes(item)) return;
  item.name = name.trim().slice(0, 100);
  renderNav();
  save();
}

function openFolderMenu(folderId) {
  if (!state || gesture || $('dialog').open) return;
  const folder = state.folders.find(item => item.id === folderId);
  if (!folder) return;
  const documentState = state;
  const body = document.createElement('div');
  body.className = 'folder-actions';
  body.innerHTML = '<button type="button" id="newFolder">＋ Добавить папку</button>' +
    '<button type="button" id="newDocument">＋ Добавить документ</button>' +
    '<button type="button" id="renameFolder">Переименовать…</button>' +
    '<button type="button" id="changeFolderCover">Изменить обложку…</button>' +
    '<button type="button" id="changeFolderTab">Цвет выступа…</button>' +
    '<button type="button" class="danger" id="removeFolder">Удалить папку…</button>';
  let action;
  showDialog(folder.name, body, () => {
    if (state === documentState) action?.();
  });
  $('newFolder').onclick = () => {
    action = () => createFolder(folderId);
    $('dialog').close('ok');
  };
  $('newDocument').onclick = () => {
    action = () => createDocument(folderId);
    $('dialog').close('ok');
  };
  $('renameFolder').onclick = () => {
    action = () => renameLibraryItem(folder, folder.parentId ? 'Название папки' : 'Название тетради');
    $('dialog').close('ok');
  };
  $('changeFolderCover').onclick = () => {
    action = () => editCover(folder);
    $('dialog').close('ok');
  };
  $('changeFolderTab').onclick = () => {
    action = () => editCoverAccent(folder);
    $('dialog').close('ok');
  };
  $('removeFolder').onclick = () => {
    action = () => confirmDeleteLibraryItem('folder', folderId);
    $('dialog').close('ok');
  };
}

function openDocumentMenu(documentId) {
  if (!state || gesture || $('dialog').open) return;
  const item = state.books.find(item => item.id === documentId);
  if (!item) return;
  const documentState = state;
  const body = document.createElement('div');
  body.className = 'folder-actions';
  body.innerHTML = '<button type="button" id="renameDocument">Переименовать…</button>' +
    '<button type="button" id="changeDocumentCover">Изменить обложку…</button>' +
    '<button type="button" id="changeDocumentSpine">Цвет корешка…</button>' +
    '<button type="button" class="danger" id="removeDocument">Удалить документ…</button>';
  let action;
  showDialog(item.name, body, () => {
    if (state === documentState) action?.();
  });
  $('renameDocument').onclick = () => {
    action = () => renameLibraryItem(item, 'Название документа');
    $('dialog').close('ok');
  };
  $('changeDocumentCover').onclick = () => {
    action = () => editCover(item);
    $('dialog').close('ok');
  };
  $('changeDocumentSpine').onclick = () => {
    action = () => editCoverAccent(item, false);
    $('dialog').close('ok');
  };
  $('removeDocument').onclick = () => {
    action = () => confirmDeleteLibraryItem('document', documentId);
    $('dialog').close('ok');
  };
}

function confirmDeleteLibraryItem(type, id) {
  if (!state || gesture || $('dialog').open) return;
  const isFolder = type === 'folder';
  const item = (isFolder ? state.folders : state.books).find(item => item.id === id);
  if (!item) return;
  const documentState = state;
  const folderIds = new Set();
  if (isFolder) {
    folderIds.add(id);
    // Include all descendants, regardless of whether the sidebar has them expanded.
    for (let size = -1; size !== folderIds.size;) {
      size = folderIds.size;
      for (const folder of state.folders) {
        if (folderIds.has(folder.parentId)) folderIds.add(folder.id);
      }
    }
  }
  const documents = state.books.filter(item => isFolder ? folderIds.has(item.folderId) : item.id === id);
  const pageIds = new Set(documents.flatMap(item => item.pages.map(page => page.id)));
  const body = document.createElement('p');
  body.textContent = `Удалить «${item.name}»? ` +
    (isFolder ? `Будут удалены эта папка, все вложенные папки и документы (${documents.length}). ` : '') +
    `Все страницы (${pageIds.size}), записи и фото внутри будут удалены. ` +
    'Это действие нельзя отменить; восстановление возможно из заранее скачанной резервной копии. ' +
    (documents.length === state.books.length ? 'Для продолжения работы останется новый пустой документ.' : '');
  showDialog(isFolder ? 'Удалить папку?' : 'Удалить документ?', body, () => {
    if (state !== documentState || gesture) return;
    const activeRemoved = pageIds.has(state.activePage);
    state.books = state.books.filter(item => !documents.includes(item));
    state.folders = state.folders.filter(folder => !folderIds.has(folder.id));
    for (const folderId of folderIds) expandedFolders.delete(folderId);
    if (!state.books.length) {
      let folder = state.folders.find(folder => folder.id === item.folderId) || state.folders[0];
      if (!folder) {
        folder = { id: uid(), name: 'Новая тетрадь', parentId: null };
        state.folders.push(folder);
      }
      state.books.push({ id: uid(), name: 'Новый документ', folderId: folder.id, pages: [newPage('Страница 1')] });
    }
    if (activeRemoved) switchPage(state.books[0].pages[0].id);
    else {
      renderNav();
      save();
    }
    for (const pageId of pageIds) pageHistories.delete(pageId);
  });
  $('dialogOk').textContent = 'Удалить';
}

async function createFolder(parentId = null) {
  if (!state || gesture || $('dialog').open) return;
  migrateLibrary(state);
  if (state.folders.length >= 1000) {
    toast('Достигнут предел папок');
    return;
  }
  if (parentId && folderPath(state, parentId).length >= 32) {
    toast('Достигнут предел вложенности папок');
    return;
  }
  const documentState = state;
  const name = await ask(parentId ? 'Новая папка' : 'Новая тетрадь', 'Без названия');
  if (state !== documentState || !name?.trim()) return;
  const folder = { id: uid(), name: name.trim().slice(0, 100), parentId };
  state.folders.push(folder);
  selectedFolderId = folder.id;
  for (const item of folderPath(state, folder.id)) expandedFolders.add(item.id);
  showLibrary(folder.id);
  save();
}

async function createDocument(folderId = selectedFolderId || book().folderId) {
  if (!state || gesture || $('dialog').open) return;
  migrateLibrary(state);
  if (state.books.length >= 500) {
    toast('Достигнут предел документов');
    return;
  }
  const documentState = state;
  const settings = await new Promise(resolve => {
    const body = document.createElement('div');
    body.className = 'document-setup';
    const name = document.createElement('input');
    name.id = 'documentName';
    name.value = 'Новый документ';
    name.maxLength = 100;
    name.required = true;
    const addField = (title, control) => {
      const label = document.createElement('label');
      label.textContent = title;
      label.append(control);
      body.append(label);
    };
    addField('Название документа', name);
    const choice = (id, title, options, value) => {
      const select = document.createElement('select');
      select.id = id;
      for (const [value, text] of options) {
        const option = document.createElement('option');
        option.value = value;
        option.textContent = text;
        select.append(option);
      }
      select.value = value;
      addField(title, select);
      return select;
    };
    const paper = choice('documentPaper', 'Разметка холста', [
      ['grid', 'В клетку'], ['dots', 'В точку'], ['lines', 'В линейку'], ['blank', 'Без разметки']
    ], 'dots');
    const paperColor = choice('documentPaperColor', 'Цвет холста', [
      ['white', 'Белый'], ['yellow', 'Желтоватый'], ['black', 'Чёрный']
    ], 'white');
    name.onkeydown = event => {
      if (event.key !== 'Enter' || event.isComposing) return;
      event.preventDefault();
      if (!event.repeat) $('dialogOk').click();
    };
    showDialog('Новый документ', body,
      () => resolve({ name: name.value, paper: paper.value, paperColor: paperColor.value }),
      () => resolve(null));
    $('dialogOk').textContent = 'Создать';
    setTimeout(() => {
      if (!body.isConnected || !$('dialog').open) return;
      name.focus();
      name.select();
    }, 30);
  });
  if (state !== documentState || !settings?.name.trim() || !state.folders.some(folder => folder.id === folderId)) return;
  const page = newPage('Страница 1');
  page.paper = settings.paper;
  page.paperColor = settings.paperColor;
  state.books.push({ id: uid(), name: settings.name.trim().slice(0, 100), folderId, pages: [page] });
  openDocument(state.books.at(-1).id);
}

function renderPageStack() {
  if (!pageStack) {
    pageStack = new PageStack({
      viewport: $('viewport'),
      container: $('pageStack'),
      editor: $('paperWrap'),
      canActivate: () => viewMode === 'editor' && !gesture && !$('dialog').open,
      activate: (id) => activatePage(id),
      render: (c, page) => {
        background(c, page);
        for (const element of page.elements) drawElement(c, element);
      }
    });
  }
  pageStack.setPages(book().pages);
  pageStack.setActive(state.activePage);
}

function resetDocumentHistory() {
  if (historyDocument && historyDocument !== state) {
    pageHistories.clear();
    undoStack = [];
    redoStack = [];
    selection = [];
  }
  historyDocument = state;
}

function activatePage(id) {
  if (gesture) return;
  resetDocumentHistory();
  if (id === state.activePage) return;
  const history = pageHistories.get(id);
  pageHistories.delete(id);
  pageHistories.set(state.activePage, { undo: undoStack, redo: redoStack });
  // Keep recent pages editable without accumulating history for an entire book.
  if (pageHistories.size > 10)
    pageHistories.delete(pageHistories.keys().next().value);
  const previous = state.activePage;
  state.activePage = id;
  undoStack = history?.undo || [];
  redoStack = history?.redo || [];
  selection = [];
  closeSelectionMenu();
  if (pageStack?.sheets.get(previous))
    pageStack.sheets.get(previous).dirty = true;
  renderNav();
  updateUndo();
  draw();
  save();
}

function switchPage(id) {
  if (gesture) return;
  resetDocumentHistory();
  activatePage(id);
  // Also rebuild after import, duplicate or deletion, including unchanged IDs.
  renderNav();
  pageStack?.scrollTo(id);
  draw();
  save();
}

function imageFor(src) {
  if (images.has(src)) return images.get(src);
  const img = new Image();
  images.set(src, img);
  img.onload = () => {
    draw();
    pageStack?.invalidate();
  };
  img.onerror = () => toast('Не удалось прочитать изображение');
  img.src = src;
  return img;
}

function background(c, p) {
  const darkPaper = p.paperColor === 'black';
  c.fillStyle = darkPaper ? '#181818' : p.paperColor === 'yellow' ? '#fff2cc' : '#fffefa';
  c.fillRect(0, 0, W, H);
  c.strokeStyle = darkPaper ? '#414141' : p.paperColor === 'yellow' ? '#dfd0a8' : '#eadde4';
  c.lineWidth = 0.8;
  if (p.paper === 'dots') {
    c.fillStyle = darkPaper ? '#666666' : p.paperColor === 'yellow' ? '#c6b78e' : '#dfced7';
    for (let x = 30; x < W; x += 25)
      for (let y = 30; y < H; y += 25) {
        c.beginPath();
        c.arc(x, y, 0.9, 0, Math.PI * 2);
        c.fill();
      }
  } else if (p.paper === 'grid' || p.paper === 'lines') {
    c.beginPath();
    for (let y = 30; y < H; y += 25) {
      c.moveTo(0, y);
      c.lineTo(W, y);
    }
    if (p.paper === 'grid')
      for (let x = 30; x < W; x += 25) {
        c.moveTo(x, 0);
        c.lineTo(x, H);
      }
    c.stroke();
  }
}

function drawElement(c, e) {
  c.save();
  if (e.type === 'stroke') {
    c.strokeStyle = e.color;
    c.fillStyle = e.color;
    c.lineCap = 'round';
    c.lineJoin = 'round';
    c.globalAlpha = e.tool === 'marker' ? 0.24 : 1;
    const path = new Path2D();
    if (e.tool === 'marker') {
      path.moveTo(e.points[0].x, e.points[0].y);
      for (const q of e.points) path.lineTo(q.x, q.y);
      c.lineWidth = e.size * 5;
      if (e.points.length === 1) {
        c.beginPath();
        c.arc(e.points[0].x, e.points[0].y, c.lineWidth / 2, 0, Math.PI * 2);
        c.fill();
      } else c.stroke(path);
    } else if (e.points.every((p) => p.p === e.points[0].p)) {
      c.lineWidth = penWidth(e.size, e.points[0].p);
      if (e.points.length === 1) {
        c.beginPath();
        c.arc(e.points[0].x, e.points[0].y, c.lineWidth / 2, 0, Math.PI * 2);
        c.fill();
      } else {
        path.moveTo(e.points[0].x, e.points[0].y);
        for (const p of e.points.slice(1)) path.lineTo(p.x, p.y);
        c.stroke(path);
      }
    } else {
      for (let i = 0; i < e.points.length; i++) {
        const a = e.points[Math.max(0, i - 1)],
          b = e.points[i];
        c.lineWidth = penWidth(e.size, (a.p + b.p) / 2);
        if (!i) {
          c.beginPath();
          c.arc(b.x, b.y, c.lineWidth / 2, 0, Math.PI * 2);
          c.fill();
        } else {
          c.beginPath();
          c.moveTo(a.x, a.y);
          c.lineTo(b.x, b.y);
          c.stroke();
        }
      }
    }
  } else if (e.type === 'image') {
    const img = imageFor(e.src);
    if (img.complete && img.naturalWidth) c.drawImage(img, e.x, e.y, e.w, e.h);
  } else if (e.type === 'text') {
    c.fillStyle = e.color;
    c.font = `${e.size}px system-ui,sans-serif`;
    c.textBaseline = 'top';
    e.text
      .split('\n')
      .forEach((line, i) => c.fillText(line, e.x, e.y + i * e.size * 1.4));
  }
  c.restore();
}

function selectedElements() {
  const ids = new Set(selection);
  return current().elements.filter((el) => ids.has(el.id));
}

function selectedElement() {
  const elements = selectedElements();
  return elements.length === 1 ? elements[0] : null;
}

function selectionBounds(elements = selectedElements()) {
  let x = Infinity,
    y = Infinity,
    right = -Infinity,
    bottom = -Infinity;
  for (const el of elements) {
    const r = bounds(el);
    x = Math.min(x, r.x);
    y = Math.min(y, r.y);
    right = Math.max(right, r.x + r.w);
    bottom = Math.max(bottom, r.y + r.h);
  }
  return { x, y, w: right - x, h: bottom - y };
}

function updateSelectionActions() {
  const elements = selectedElements();
  const el = elements.length === 1 ? elements[0] : null;
  for (const id of [
    'copyObject',
    'duplicateObject',
    'deleteObject',
    'bringForward',
    'sendBackward'
  ]) {
    $(id).disabled = !elements.length || !!gesture;
  }
  for (const id of [
    'rotateLeft',
    'rotateRight',
    'flipHorizontal',
    'flipVertical'
  ])
    $(id).disabled = !rotatable(elements) || !!gesture;
  $('pasteObject').disabled = !clipboard || !!gesture;
  $('editObject').disabled = el?.type !== 'text' || !!gesture;
  $('shapeTool').disabled = !!gesture;
  $('clearPage').disabled = !current().elements.length || !!gesture;
}

function deleteSelection() {
  if (gesture || !selectedElements().length) return;
  history();
  current().elements = current().elements.filter(
    (el) => !selection.includes(el.id)
  );
  selection = [];
  draw();
  save();
}

function copySelection(event = null) {
  if (gesture || !selectedElements().length) return;
  clipboard = structuredClone(selectedElements());
  clipboardToken = uid();
  if (!event && document.execCommand?.('copy')) return;
  if (event?.clipboardData) {
    event.clipboardData.setData(
      'application/x-tetrad-selection',
      clipboardToken
    );
    event.clipboardData.setData(
      'text/plain',
      selectedElements()
        .filter((el) => el.type === 'text')
        .map((el) => el.text)
        .join('\n') || 'Объекты Тетради'
    );
    event.preventDefault();
  }
  updateSelectionActions();
  toast(
    'Объект скопирован. Его можно вставить на любую страницу этой тетради.'
  );
}

function rememberPastePointer(e) {
  pastePointer = { x: e.clientX, y: e.clientY, document: state };
}

function pastePosition() {
  const pointer = pastePointer?.document === state ? pastePointer : null;
  let surface =
    pointer &&
    document.elementFromPoint?.(pointer.x, pointer.y)?.closest('.page-surface');
  const pageId = surface?.parentElement.dataset.pageId;
  if (pageId && pageStack?.sheets.has(pageId)) activatePage(pageId);
  else surface = null;
  const rect = (surface || canvas).getBoundingClientRect();
  if (
    pointer &&
    pointer.x >= rect.left &&
    pointer.x <= rect.left + rect.width &&
    pointer.y >= rect.top &&
    pointer.y <= rect.top + rect.height
  ) {
    return {
      x: ((pointer.x - rect.left) * W) / rect.width,
      y: ((pointer.y - rect.top) * H) / rect.height
    };
  }
  // Keyboard-only paste falls back to the visible part of the current sheet.
  const viewport = $('viewport').getBoundingClientRect();
  const left = Math.max(rect.left, viewport.left),
    right = Math.min(rect.left + rect.width, viewport.left + viewport.width),
    top = Math.max(rect.top, viewport.top),
    bottom = Math.min(rect.top + rect.height, viewport.top + viewport.height);
  return {
    x:
      right > left
        ? (((left + right) / 2 - rect.left) * W) / rect.width
        : W / 2,
    y:
      bottom > top ? (((top + bottom) / 2 - rect.top) * H) / rect.height : H / 2
  };
}

$('viewport').addEventListener('pointermove', rememberPastePointer);

function pasteObject(source = clipboard, atCursor = true) {
  if (gesture || !source?.length) return;
  const position = atCursor ? pastePosition() : null;
  const r = selectionBounds(source);
  const dx = Math.max(
    -r.x,
    Math.min(position ? position.x - r.x : 24, W - r.x - r.w)
  );
  const dy = Math.max(
    -r.y,
    Math.min(position ? position.y - r.y : 24, H - r.y - r.h)
  );
  const copies = source.map((original) => {
    const el = translateElement(original, dx, dy);
    el.id = uid();
    return el;
  });
  history();
  current().elements.push(...copies);
  setTool('select');
  selection = copies.map((el) => el.id);
  draw();
  save();
}

function reorderSelection(front) {
  const selected = selectedElements();
  if (gesture || !selected.length) return;
  const others = current().elements.filter((el) => !selection.includes(el.id));
  const reordered = front ? [...others, ...selected] : [...selected, ...others];
  if (reordered.every((el, i) => el === current().elements[i])) return;
  history();
  current().elements = reordered;
  draw();
  save();
}

function closeSelectionMenu() {
  $('selectionMenu').hidden = true;
}

function openSelectionMenu(x, y) {
  if (gesture || !state) return;
  updateSelectionActions();
  const menu = $('selectionMenu');
  menu.hidden = false;
  menu.style.left =
    Math.max(8, Math.min(x, window.innerWidth - menu.offsetWidth - 8)) + 'px';
  menu.style.top =
    Math.max(8, Math.min(y, window.innerHeight - menu.offsetHeight - 8)) + 'px';
  menu.querySelector('button:not(:disabled)')?.focus();
}

canvas.addEventListener('contextmenu', (e) => {
  rememberPastePointer(e);
  e.preventDefault();
  openSelectionMenu(e.clientX, e.clientY);
});
$('viewport').addEventListener('contextmenu', (e) => {
  if (e.target === canvas || gesture || $('dialog').open) return;
  const sheet = e.target.closest('.page-surface')?.parentElement;
  if (!sheet) return;
  e.preventDefault();
  activatePage(sheet.dataset.pageId);
  rememberPastePointer(e);
  openSelectionMenu(e.clientX, e.clientY);
});
document.addEventListener('pointerdown', (e) => {
  if (!$('selectionMenu').contains(e.target)) closeSelectionMenu();
});
window.addEventListener('resize', closeSelectionMenu);
$('viewport').addEventListener('scroll', closeSelectionMenu);
$('selectionMenu').addEventListener('click', (e) => {
  if (e.target.tagName === 'BUTTON') closeSelectionMenu();
});

function closeShapeMenu() {
  $('shapeMenu').hidden = true;
  $('shapeTool').setAttribute('aria-expanded', 'false');
}

function openShapeMenu() {
  if (gesture) return;
  closeSelectionMenu();
  const menu = $('shapeMenu');
  const r = $('shapeTool').getBoundingClientRect();
  menu.hidden = false;
  menu.style.left =
    Math.max(8, Math.min(r.left, window.innerWidth - menu.offsetWidth - 8)) +
    'px';
  menu.style.top =
    Math.max(
      8,
      Math.min(r.bottom, window.innerHeight - menu.offsetHeight - 8)
    ) + 'px';
  $('shapeTool').setAttribute('aria-expanded', 'true');
  menu.querySelector('button')?.focus();
}

function chooseShape(kind) {
  if (gesture || !Object.hasOwn(shapeNames, kind)) return;
  shapeKind = kind;
  setTool('shape');
  $('toolHint').textContent =
    shapeNames[kind] + ' · проведи по странице, затем растягивай за рамку';
}

$('shapeTool').onclick = () =>
  $('shapeMenu').hidden ? openShapeMenu() : closeShapeMenu();
$('shapeMenu').addEventListener('click', (e) => {
  const button = e.target.closest('[data-shape]');
  if (button) chooseShape(button.dataset.shape);
});
document.addEventListener('pointerdown', (e) => {
  if (!$('shapeMenu').contains(e.target) && !$('shapeTool').contains(e.target))
    closeShapeMenu();
});
window.addEventListener('resize', closeShapeMenu);
$('viewport').addEventListener('scroll', closeShapeMenu);

function resizeHandles(r) {
  const handles = [];
  for (let y = 0; y < 3; y++)
    for (let x = 0; x < 3; x++) {
      if (x === 1 && y === 1) continue;
      if ((r.w < 40 / zoom || r.h < 40 / zoom) && (x === 1 || y === 1))
        continue;
      handles.push({
        x: r.x + (r.w * x) / 2,
        y: r.y + (r.h * y) / 2,
        column: x,
        row: y
      });
    }
  return handles;
}

function resizable(elements) {
  return (
    elements.length &&
    elements.every((el) => ['stroke', 'image'].includes(el.type))
  );
}

function rotatable(elements) {
  return elements.length > 0 && elements.every((el) => el.type === 'stroke');
}

function rotationHandle(r) {
  const below = r.y < 40 / zoom;
  let y = below ? r.y + r.h + 30 / zoom : r.y - 30 / zoom;
  if (y > H - 8 / zoom) y = r.y + 20 / zoom;
  return { x: r.x + r.w / 2, y, edge: below ? r.y + r.h : r.y };
}

function transformSelection(angle = 0, mirror = null) {
  const elements = selectedElements();
  if (gesture || !rotatable(elements)) return;
  const r = selectionBounds(elements);
  const center = { x: r.x + r.w / 2, y: r.y + r.h / 2 };
  history();
  const transformed = new Map(
    elements.map((el) => [el.id, transformStroke(el, center, angle, mirror)])
  );
  current().elements = current().elements.map(
    (el) => transformed.get(el.id) || el
  );
  draw();
  save();
}

$('rotateLeft').onclick = () => transformSelection(-Math.PI / 2);
$('rotateRight').onclick = () => transformSelection(Math.PI / 2);
$('flipHorizontal').onclick = () => transformSelection(0, 'horizontal');
$('flipVertical').onclick = () => transformSelection(0, 'vertical');

function detachGestureElements(g) {
  const copies = new Map(g.elements.map((el) => [el.id, structuredClone(el)]));
  current().elements = current().elements.map((el) => copies.get(el.id) || el);
  g.elements = g.elements.map((el) => copies.get(el.id));
}

function rotateGesture(g, p, snap = false) {
  if (Math.hypot(p.x - g.center.x, p.y - g.center.y) < 8 / zoom) return;
  const angle = Math.atan2(p.y - g.center.y, p.x - g.center.x);
  const delta = angle - g.previousAngle;
  g.angle += Math.atan2(Math.sin(delta), Math.cos(delta));
  g.previousAngle = angle;
  const applied = snap
    ? (Math.round(g.angle / (Math.PI / 12)) * Math.PI) / 12
    : g.angle;
  if (!g.changed && Math.abs(applied) < 0.02) return;
  if (!g.changed) {
    history();
    detachGestureElements(g);
  }
  g.changed = true;
  g.appliedAngle = applied;
  g.elements.forEach((el, i) =>
    Object.assign(el, transformStroke(g.origins[i], g.center, applied))
  );
}

function pagePoint(p) {
  return { x: Math.max(0, Math.min(W, p.x)), y: Math.max(0, Math.min(H, p.y)) };
}

function updateCreatedShape(g, p) {
  const end = pagePoint(p);
  if (
    Math.abs(end.x - g.start.x) < 4 / zoom ||
    Math.abs(end.y - g.start.y) < 4 / zoom
  ) {
    g.element = null;
    return;
  }
  if (!g.element)
    g.element = { id: uid(), type: 'stroke', tool: 'pen', color, size };
  g.element.points = createShapePoints(g.kind, g.start, end, g.pressure);
}

function figurePressure() {
  if (!$('pressure').checked) return DEFAULT_PRESSURE;
  const writing = current().elements.find((el) => el.id === writingStrokeId);
  return writing?.type === 'stroke' && writing.tool === 'pen'
    ? averagePressure(writing.points)
    : recentWritingPressure(current().elements);
}

$('copyObject').onclick = () => copySelection();
$('pasteObject').onclick = () => pasteObject();
$('duplicateObject').onclick = () => pasteObject(selectedElements(), false);
$('deleteObject').onclick = deleteSelection;
$('bringForward').onclick = () => reorderSelection(true);
$('sendBackward').onclick = () => reorderSelection(false);
$('editObject').onclick = () => {
  const el = selectedElement();
  if (!gesture && el?.type === 'text') editText(el);
};
$('clearPage').onclick = () => {
  if (gesture || !current().elements.length) return;
  const pageId = state.activePage;
  const body = document.createElement('p');
  body.textContent =
    'Удалить все штрихи, фото и текст с текущей страницы? Название и бумага сохранятся. Очистку можно отменить кнопкой «↶» или Ctrl+Z до перехода на другую страницу.';
  showDialog('Очистить страницу?', body, () => {
    if (gesture || state.activePage !== pageId) return;
    history();
    current().elements = [];
    selection = [];
    draw();
    save();
  });
  $('dialogOk').textContent = 'Очистить';
};

function bounds(e) {
  if (e.type === 'stroke') return strokeBounds(e);
  if (e.type === 'image') return { x: e.x, y: e.y, w: e.w, h: e.h };
  ctx.font = `${e.size}px system-ui,sans-serif`;
  return {
    x: e.x,
    y: e.y,
    w: Math.max(30, ...e.text.split('\n').map((l) => ctx.measureText(l).width)),
    h: e.text.split('\n').length * e.size * 1.4
  };
}

function clearInk() {
  inkContext.clearRect(0, 0, W, H);
}

function paintInk(g) {
  const el = g.element;
  if (g.renderPoints !== el.points) {
    clearInk();
    g.renderedCount = 0;
    g.renderPoints = el.points;
  }
  if (el.tool === 'marker' || g.uniformPressure || g.shape) {
    clearInk();
    drawElement(inkContext, el);
    g.renderedCount = el.points.length;
  } else g.renderedCount = drawPenSamples(inkContext, el, g.renderedCount || 0);
}

function queueInk(g) {
  if (g.frame != null) return;
  g.frame = requestAnimationFrame(() => {
    g.frame = null;
    if (gesture === g) paintInk(g);
  });
}

function beginInk(g) {
  clearInk();
  if (sceneDecorated) draw();
  else paintInk(g);
  $('canvasHint').style.display = 'none';
  updateSelectionActions();
}

function draw(c = ctx, withSelection = true) {
  if (!state) return;
  const p = current();
  background(c, p);
  const live = c === ctx && gesture?.type === 'draw' ? gesture : null;
  for (const e of p.elements) if (e !== live?.element) drawElement(c, e);
  if (c === ctx) {
    sceneDecorated =
      !!selection.length || ['lasso', 'create-shape'].includes(gesture?.type);
    clearInk();
    if (live) {
      live.renderPoints = null;
      paintInk(live);
    }
  }
  if (
    withSelection &&
    c === ctx &&
    gesture?.type === 'create-shape' &&
    gesture.element
  )
    drawElement(c, gesture.element);
  if (c === ctx) {
    $('canvasHint').style.display = p.elements.length ? 'none' : 'block';
    updateSelectionActions();
  }
  if (withSelection && selection.length) {
    const elements = selectedElements();
    if (elements.length) {
      const rotating = gesture?.type === 'rotate-selection';
      const r = rotating ? gesture.rectangle : selectionBounds(elements);
      c.save();
      if (rotating) {
        c.translate(gesture.center.x, gesture.center.y);
        c.rotate(gesture.appliedAngle);
        c.translate(-gesture.center.x, -gesture.center.y);
      }
      c.strokeStyle = document.documentElement?.dataset?.accent || '#df82b1';
      c.lineWidth = 1.5 / zoom;
      c.setLineDash([5 / zoom, 4 / zoom]);
      c.strokeRect(r.x - 4, r.y - 4, r.w + 8, r.h + 8);
      if (resizable(elements)) {
        c.setLineDash([]);
        c.fillStyle = '#fff';
        for (const handle of resizeHandles(r)) {
          c.fillRect(
            handle.x - 4 / zoom,
            handle.y - 4 / zoom,
            8 / zoom,
            8 / zoom
          );
          c.strokeRect(
            handle.x - 4 / zoom,
            handle.y - 4 / zoom,
            8 / zoom,
            8 / zoom
          );
        }
      }
      if (rotatable(elements)) {
        const handle = rotationHandle(r);
        c.setLineDash([]);
        c.beginPath();
        c.moveTo(handle.x, handle.edge);
        c.lineTo(handle.x, handle.y);
        c.stroke();
        c.beginPath();
        c.arc(handle.x, handle.y, 6 / zoom, 0, Math.PI * 2);
        c.fillStyle = '#fff';
        c.fill();
        c.stroke();
      }
      c.restore();
    }
  }
  if (withSelection && gesture?.type === 'lasso') {
    c.save();
    c.beginPath();
    gesture.points.forEach((p, i) =>
      i ? c.lineTo(p.x, p.y) : c.moveTo(p.x, p.y)
    );
    c.closePath();
    c.fillStyle = (document.documentElement?.dataset?.accent || '#df82b1') + '18';
    c.fill();
    c.strokeStyle = document.documentElement?.dataset?.accent || '#df82b1';
    c.lineWidth = 1.5 / zoom;
    c.setLineDash([5 / zoom, 4 / zoom]);
    c.stroke();
    c.restore();
  }
}

function setTool(t) {
  if (gesture) return;
  closeSelectionMenu();
  closeShapeMenu();
  tool = t;
  selection = [];
  document
    .querySelectorAll('[data-tool]')
    .forEach((b) => b.classList.toggle('active', b.dataset.tool === t));
  $('shapeTool').classList.toggle('active', t === 'shape');
  $('toolHint').textContent = hint[t];
  canvas.style.cursor =
    t === 'hand'
      ? 'grab'
      : t === 'select'
        ? 'default'
        : t === 'text'
          ? 'text'
          : 'crosshair';
  draw();
}

function point(e) {
  const r = canvas.getBoundingClientRect();
  return {
    x: ((e.clientX - r.left) * W) / r.width,
    y: ((e.clientY - r.top) * H) / r.height,
    p:
      e.pointerType === 'pen' && $('pressure').checked
        ? Math.max(0.05, e.pressure)
        : DEFAULT_PRESSURE
  };
}

function erase(p) {
  const els = current().elements;
  for (let i = els.length - 1; i >= 0; i--)
    if (strokeHit(els[i], p, 10)) {
      els.splice(i, 1);
    }
}

function scheduleShape(g, p) {
  if (g.element.tool !== 'pen') return;
  if (
    g.holdTimer &&
    Math.hypot(p.x - g.holdAnchor.x, p.y - g.holdAnchor.y) <= 8 / zoom
  )
    return;
  clearTimeout(g.holdTimer);
  g.holdAnchor = { x: p.x, y: p.y };
  g.holdCount = g.element.points.length;
  g.holdTimer = setTimeout(() => {
    g.holdTimer = null;
    if (gesture !== g) return;
    const shape = recognizeShape(
      g.element.points.slice(0, g.holdCount),
      12 / zoom
    );
    if (!shape) return;
    const r = strokeBounds({ ...g.element, points: shape.points, size: 0 });
    if (r.w > W || r.h > H) return;
    const dx = r.x < 0 ? -r.x : Math.min(0, W - r.x - r.w);
    const dy = r.y < 0 ? -r.y : Math.min(0, H - r.y - r.h);
    g.originalPoints = g.element.points;
    g.element.points = shape.points.map((p) => ({
      ...p,
      x: p.x + dx,
      y: p.y + dy
    }));
    g.shape = shape.kind;
    paintInk(g);
    toast('Фигура выровнена. Подними перо, чтобы сохранить.');
  }, 450);
}

function restoreFreehand(g) {
  if (!g.shape) return;
  g.element.points = g.originalPoints;
  g.originalPoints = null;
  g.shape = null;
}

function startPointer(e) {
  rememberPastePointer(e);
  if (gesture || (e.button !== 0 && e.button !== 5 && e.button !== 1)) return;
  e.preventDefault();
  const p = point(e);
  canvas.setPointerCapture(e.pointerId);
  let t = e.button === 5 ? 'eraser' : space || e.button === 1 ? 'hand' : tool;
  closeSelectionMenu();
  closeShapeMenu();
  if (t === 'shape') {
    selection = [];
    gesture = {
      type: 'create-shape',
      id: e.pointerId,
      start: pagePoint(p),
      kind: shapeKind,
      pressure: figurePressure(),
      element: null
    };
    draw();
    return;
  }
  if (t === 'hand') {
    gesture = {
      type: 'pan',
      id: e.pointerId,
      x: e.clientX,
      y: e.clientY,
      left: $('viewport').scrollLeft,
      top: $('viewport').scrollTop
    };
    return;
  }
  if (t === 'text') {
    addText(p);
    return;
  }
  if (t === 'select') {
    const elements = selectedElements();
    const r = elements.length ? selectionBounds(elements) : null;
    const handle =
      r && resizable(elements)
        ? resizeHandles(r).find(
            (h) => Math.hypot(p.x - h.x, p.y - h.y) < 10 / zoom
          )
        : null;
    const rotation = r && rotatable(elements) ? rotationHandle(r) : null;
    if (
      rotation &&
      Math.hypot(p.x - rotation.x, p.y - rotation.y) < 12 / zoom
    ) {
      const center = { x: r.x + r.w / 2, y: r.y + r.h / 2 };
      gesture = {
        type: 'rotate-selection',
        id: e.pointerId,
        elements,
        origins: structuredClone(elements),
        rectangle: r,
        center,
        previousAngle: Math.atan2(p.y - center.y, p.x - center.x),
        angle: 0,
        appliedAngle: 0,
        changed: false,
        undoBefore: [...undoStack],
        redoBefore: [...redoStack]
      };
    } else if (handle) {
      gesture = {
        type: 'resize-selection',
        id: e.pointerId,
        elements,
        origins: structuredClone(elements),
        rectangle: r,
        handle,
        x: p.x,
        y: p.y,
        changed: false
      };
    } else if (
      r &&
      p.x >= r.x - 4 / zoom &&
      p.x <= r.x + r.w + 4 / zoom &&
      p.y >= r.y - 4 / zoom &&
      p.y <= r.y + r.h + 4 / zoom
    ) {
      gesture = {
        type: 'move',
        id: e.pointerId,
        elements,
        origins: structuredClone(elements),
        rectangle: r,
        x: p.x,
        y: p.y,
        changed: false
      };
    } else {
      selection = [];
      gesture = { type: 'lasso', id: e.pointerId, points: [p] };
    }
    draw();
    return;
  }
  selection = [];
  history();
  if (t === 'eraser') {
    gesture = { type: 'erase', id: e.pointerId, last: p };
    erase(p);
  } else {
    const el = { id: uid(), type: 'stroke', tool: t, color, size, points: [p] };
    current().elements.push(el);
    gesture = {
      type: 'draw',
      id: e.pointerId,
      element: el,
      scribbleEnabled: t === 'pen',
      pressureEnabled: t === 'pen' && $('pressure').checked,
      scribbleMinimum: 8 / zoom,
      uniformPressure: true,
      renderedCount: 0
    };
  }
  if (gesture.type === 'draw') beginInk(gesture);
  else draw();
}
canvas.addEventListener('pointerdown', startPointer);
$('viewport').addEventListener('pointerdown', (e) => {
  if (e.target === canvas || gesture || !pageStack || $('dialog').open) return;
  const sheet = e.target.closest('.page-surface')?.parentElement;
  if (!sheet || ![0, 1, 5].includes(e.button)) return;
  activatePage(sheet.dataset.pageId);
  startPointer(e);
});
canvas.addEventListener('pointermove', (e) => {
  if (!gesture || e.pointerId !== gesture.id) return;
  const g = gesture,
    p = point(e);
  if (g.type === 'pan') {
    $('viewport').scrollLeft = g.left - (e.clientX - g.x);
    $('viewport').scrollTop = g.top - (e.clientY - g.y);
    return;
  }
  if (g.type === 'rotate-selection') {
    rotateGesture(g, p, e.shiftKey);
  } else if (g.type === 'create-shape') {
    updateCreatedShape(g, p);
  } else if (g.type === 'lasso') {
    const samples = e.getCoalescedEvents?.();
    for (const sample of samples?.length ? samples : [e]) {
      const next = point(sample),
        last = g.points.at(-1);
      if (Math.hypot(next.x - last.x, next.y - last.y) >= 3 / zoom)
        g.points.push(next);
    }
  } else if (g.type === 'draw') {
    if (g.shape) {
      if (Math.hypot(p.x - g.holdAnchor.x, p.y - g.holdAnchor.y) <= 12 / zoom)
        return;
      restoreFreehand(g);
    }
    const samples = e.getCoalescedEvents?.();
    for (const event of samples?.length ? samples : [e]) {
      const next = point(event);
      if (next.p !== g.element.points[0].p) g.uniformPressure = false;
      g.element.points.push(next);
    }
    scheduleShape(g, p);
    queueInk(g);
    return;
  } else if (g.type === 'erase') {
    const steps = Math.max(
      1,
      Math.ceil(Math.hypot(p.x - g.last.x, p.y - g.last.y) / 5)
    );
    for (let i = 1; i <= steps; i++)
      erase({
        x: g.last.x + ((p.x - g.last.x) * i) / steps,
        y: g.last.y + ((p.y - g.last.y) * i) / steps
      });
    g.last = p;
  } else if (g.type === 'move') {
    if (!g.changed && Math.hypot(p.x - g.x, p.y - g.y) < 2 / zoom) return;
    if (!g.changed) {
      history();
      detachGestureElements(g);
    }
    g.changed = true;
    const r = g.rectangle;
    const dx = Math.max(
      -Math.max(0, r.x),
      Math.min(Math.max(0, W - r.x - r.w), p.x - g.x)
    );
    const dy = Math.max(
      -Math.max(0, r.y),
      Math.min(Math.max(0, H - r.y - r.h), p.y - g.y)
    );
    g.elements.forEach((el, i) =>
      Object.assign(el, translateElement(g.origins[i], dx, dy))
    );
  } else if (g.type === 'resize-selection') {
    if (!g.changed && Math.hypot(p.x - g.x, p.y - g.y) < 2 / zoom) return;
    if (!g.changed) {
      history();
      detachGestureElements(g);
    }
    g.changed = true;
    const r = g.rectangle,
      min = 8 / zoom;
    let left = r.x,
      right = r.x + r.w,
      top = r.y,
      bottom = r.y + r.h;
    if (g.handle.column === 0) left = Math.max(0, Math.min(right - min, p.x));
    if (g.handle.column === 2) right = Math.min(W, Math.max(left + min, p.x));
    if (g.handle.row === 0) top = Math.max(0, Math.min(bottom - min, p.y));
    if (g.handle.row === 2) bottom = Math.min(H, Math.max(top + min, p.y));
    const target = e.shiftKey && g.origins.every(el => el.type === 'image')
      ? aspectResizeBounds(r, g.handle, p, min)
      : { x: left, y: top, w: right - left, h: bottom - top };
    g.elements.forEach((el, i) =>
      Object.assign(el, resizeElement(g.origins[i], r, target))
    );
  }
  draw();
});

function finish(e) {
  if (!gesture || e.pointerId !== gesture.id) return;
  if (gesture.type === 'rotate-selection') {
    const g = gesture;
    if (
      e.type === 'pointerup' &&
      Number.isFinite(e.clientX) &&
      Number.isFinite(e.clientY)
    )
      rotateGesture(g, point(e), e.shiftKey);
    if (e.type !== 'pointerup') {
      g.elements.forEach((el, i) => Object.assign(el, g.origins[i]));
      undoStack = g.undoBefore;
      redoStack = g.redoBefore;
      updateUndo();
    }
    gesture = null;
    draw();
    if (g.changed && e.type === 'pointerup') save();
    else saved(persistedRevision);
    return;
  }
  if (gesture.type === 'create-shape') {
    const g = gesture;
    if (
      e.type === 'pointerup' &&
      Number.isFinite(e.clientX) &&
      Number.isFinite(e.clientY)
    )
      updateCreatedShape(g, point(e));
    const element = e.type === 'pointerup' ? g.element : null;
    gesture = null;
    if (element) {
      history();
      current().elements.push(element);
      setTool('select');
      selection = [element.id];
      save();
    } else saved(persistedRevision);
    draw();
    return;
  }
  if (gesture.type === 'draw') {
    clearTimeout(gesture.holdTimer);
    if (gesture.frame != null) cancelAnimationFrame(gesture.frame);
    if (e.type !== 'pointerup') {
      restoreFreehand(gesture);
    }
  }
  if (e.type === 'pointerup' && gesture.type === 'draw') {
    const stroke = gesture.element;
    if (
      !gesture.shape &&
      Number.isFinite(e.clientX) &&
      Number.isFinite(e.clientY)
    ) {
      const end = point(e),
        last = stroke.points.at(-1);
      if (end.x !== last.x || end.y !== last.y) stroke.points.push(end);
    }
    if (gesture.scribbleEnabled && !gesture.shape) {
      const area = scribbleArea(stroke.points, gesture.scribbleMinimum);
      if (area) {
        const elements = current().elements;
        const removed = new Set(
          elements
            .filter(
              (el) =>
                el !== stroke &&
                scribbleHits(el, area, el.type === 'stroke' ? null : bounds(el))
            )
            .map((el) => el.id)
        );
        if (removed.size) {
          const count = removed.size;
          gesture.removedInk = true;
          removed.add(stroke.id);
          current().elements = elements.filter((el) => !removed.has(el.id));
          toast(`Удалено: ${count}. Ctrl+Z — вернуть.`);
        }
      }
    }
  }
  if (
    gesture.type === 'lasso' &&
    e.type !== 'pointercancel' &&
    e.type !== 'lostpointercapture'
  ) {
    const polygon = gesture.points;
    selection = current()
      .elements.filter((el) =>
        insideLasso(el, polygon, el.type === 'stroke' ? null : bounds(el))
      )
      .map((el) => el.id);
  }
  const changed = ['move', 'resize-selection'].includes(gesture.type)
    ? gesture.changed
    : !['pan', 'lasso'].includes(gesture.type);
  if (
    e.type === 'pointerup' &&
    gesture.type === 'draw' &&
    gesture.pressureEnabled &&
    !gesture.shape &&
    current().elements.includes(gesture.element)
  )
    writingStrokeId = gesture.element.id;
  const completed = gesture;
  gesture = null;
  if (completed.type === 'draw' && !completed.removedInk) {
    clearInk();
    drawElement(ctx, completed.element);
    updateSelectionActions();
  } else draw();
  if (changed) save();
  else saved(persistedRevision);
}
canvas.addEventListener('pointerup', finish);
canvas.addEventListener('pointercancel', finish);
canvas.addEventListener('lostpointercapture', finish);
canvas.ondblclick = async (e) => {
  if (tool !== 'select') return;
  const selected = selectedElement();
  if (selected?.type === 'text') await editText(selected);
};

async function editText(el) {
  const id = state.activePage,
    value = await ask('Текст на странице', el.text, true);
  if (value === null || state.activePage !== id) return;
  history();
  if (value.trim())
    current().elements = current().elements.map((item) =>
      item.id === el.id ? { ...item, text: value } : item
    );
  else current().elements = current().elements.filter((e) => e.id !== el.id);
  draw();
  save();
}

async function addText(p) {
  const id = state.activePage,
    value = await ask('Добавить текст', '', true);
  if (!value?.trim() || id !== state.activePage) return;
  history();
  current().elements.push({
    id: uid(),
    type: 'text',
    text: value,
    x: p.x,
    y: p.y,
    size: 24,
    color
  });
  setTool('select');
  save();
}

function ask(title, value = '', multiline = false) {
  return new Promise((resolve) => {
    const input = document.createElement(multiline ? 'textarea' : 'input');
    input.value = value;
    input.maxLength = multiline ? 20000 : 100;
    if (!multiline) {
      input.onkeydown = (event) => {
        if (event.key !== 'Enter' || event.isComposing) return;
        event.preventDefault();
        if (!event.repeat) $('dialogOk').click();
      };
    }
    showDialog(
      title,
      input,
      () => resolve(input.value),
      () => resolve(null)
    );
    setTimeout(() => {
      input.focus();
      input.select();
    }, 30);
  });
}

function showDialog(title, body, ok, cancel = () => {}) {
  if ($('dialog').open) return;
  $('dialogTitle').textContent = title;
  $('dialogBody').replaceChildren(body);
  $('dialogOk').textContent = 'Готово';
  $('dialogOk').disabled = false;
  $('dialog').returnValue = 'cancel';
  const dialog = $('dialog');
  let pressedOutside = false;
  const outside = (event) => {
    const rect = dialog.getBoundingClientRect();
    return event.target === dialog &&
      (event.clientX < rect.left || event.clientX > rect.right ||
       event.clientY < rect.top || event.clientY > rect.bottom);
  };
  dialog.onpointerdown = (event) => {
    pressedOutside = event.button === 0 && outside(event);
  };
  dialog.onpointercancel = () => { pressedOutside = false; };
  dialog.onclick = (event) => {
    const dismiss = pressedOutside && outside(event);
    pressedOutside = false;
    if (dismiss) {
      event.preventDefault();
      event.stopPropagation();
      dialog.close('cancel');
    }
  };
  $('dialog').onclose = () => {
    if ($('dialog').returnValue === 'ok') ok();
    else cancel();
  };
  $('dialog').showModal();
}

function setZoom(v, anchor) {
  const viewport = $('viewport'),
    old = zoom,
    left = viewport.scrollLeft,
    top = viewport.scrollTop;
  zoom = Math.max(0.25, Math.min(2.5, v));
  $('zoomValue').textContent = Math.round(zoom * 100) + '%';
  if (pageStack) pageStack.setZoom(zoom, anchor);
  else {
    $('paperWrap').style.width = `${W * zoom}px`;
    $('paperWrap').style.height = `${H * zoom}px`;
  }
  if (!pageStack && anchor) {
    viewport.scrollLeft = ((left + anchor.x) * zoom) / old - anchor.x;
    viewport.scrollTop = ((top + anchor.y) * zoom) / old - anchor.y;
  }
  draw();
}

function fit() {
  setZoom(Math.min(1, Math.max(0.25, ($('viewport').clientWidth - 90) / W)));
}
$('zoomIn').onclick = () => setZoom(zoom + 0.1);
$('zoomOut').onclick = () => setZoom(zoom - 0.1);
$('zoomValue').onclick = fit;
$('viewport').addEventListener(
  'wheel',
  (e) => {
    if (!e.ctrlKey) return;
    e.preventDefault();
    const r = $('viewport').getBoundingClientRect();
    setZoom(zoom * Math.exp(-e.deltaY * 0.002), {
      x: e.clientX - r.left,
      y: e.clientY - r.top
    });
  },
  { passive: false }
);
document
  .querySelectorAll('[data-tool]')
  .forEach((b) => (b.onclick = () => setTool(b.dataset.tool)));
for (const hex of ['#8d3e61', '#28303b', '#5471ab', '#c66c93', '#d4b55d', '#ffffff']) {
  const btn = document.createElement('button');
  btn.className = 'swatch' + (hex === color ? ' active' : '');
  btn.style.setProperty('--swatch', hex);
  btn.ariaLabel = 'Цвет ' + hex;
  btn.onclick = () => {
    color = hex;
    $('customColor').value = hex;
    document
      .querySelectorAll('.swatch')
      .forEach((b) => b.classList.toggle('active', b === btn));
  };
  $('colors').append(btn);
}
$('customColor').oninput = (e) => {
  color = e.target.value;
  document
    .querySelectorAll('.swatch')
    .forEach((b) => b.classList.remove('active'));
};
$('sizeButton').onclick = () => {
  closeShapeMenu();
  closeSelectionMenu();
};
$('sizePopover').addEventListener('beforetoggle', event => {
  if (event.newState !== 'open') return;
  const button = $('sizeButton').getBoundingClientRect();
  const popup = $('sizePopover');
  popup.style.left = Math.max(8, Math.min(button.left, window.innerWidth - 228)) + 'px';
  popup.style.top = Math.max(8, Math.min(button.bottom + 8, window.innerHeight - 100)) + 'px';
});
$('sizePopover').addEventListener('toggle', event => {
  $('sizeButton').setAttribute('aria-expanded', event.newState === 'open' ? 'true' : 'false');
  if (event.newState === 'open') $('size').focus();
});
$('size').oninput = (e) => {
  size = +e.target.value;
  $('sizeLabel').textContent = size + ' px';
  $('sizeValue').textContent = size + ' px';
  $('sizeButton').setAttribute('aria-label', 'Толщина пера: ' + size + ' px');
};
window.addEventListener('resize', () => $('sizePopover').hidePopover());
$('viewport').addEventListener('scroll', () => $('sizePopover').hidePopover());
$('paper').onchange = (e) => {
  current().paper = e.target.value;
  draw();
  save();
};
$('paperColor').onchange = (e) => {
  if (gesture) {
    e.target.value = current().paperColor || 'white';
    return;
  }
  current().paperColor = e.target.value;
  renderPageStack();
  pageStack?.invalidate();
  draw();
  save();
};
$('undo').onclick = undo;
$('redo').onclick = redo;
$('newBook').onclick = () => createFolder();
$('addPageBottom').onclick = () => {
  const source = current();
  const p = newPage('Страница ' + (book().pages.length + 1));
  p.paper = source.paper;
  if (source.paperColor !== undefined) p.paperColor = source.paperColor;
  book().pages.push(p);
  switchPage(p.id);
};
$('pageMenu').onclick = () => {
  const body = document.createElement('div');
  body.innerHTML =
    '<p>Можно сделать копию страницы или удалить её.</p><button type="button" class="primary" id="duplicatePage">Дублировать</button> <button type="button" class="text-button" id="deletePage">Удалить страницу…</button>';
  showDialog('Действия со страницей', body, () => {});
  $('duplicatePage').onclick = () => {
    const p = structuredClone(current());
    p.id = uid();
    p.title = 'Страница ' + (book().pages.length + 1);
    p.elements.forEach((e) => (e.id = uid()));
    p.created = Date.now();
    book().pages.push(p);
    $('dialog').close();
    switchPage(p.id);
  };
  $('deletePage').onclick = () => {
    const pageId = state.activePage;
    $('dialog').close();
    setTimeout(() => confirmDeletePage(pageId), 0);
  };
};

function confirmDeletePage(pageId = state?.activePage) {
  if (!state || gesture || $('dialog').open || pageId !== state.activePage) return;
  const documentState = state,
    targetBook = book();
  const body = document.createElement('p');
  body.textContent = 'Удалить «' + pageLabel() + '» вместе со всеми записями и фото? ' +
    'Вернуть её можно будет только из резервной копии. Если это последний лист, останется новая пустая страница.';
  showDialog('Удалить страницу?', body, () => {
    if (gesture || state !== documentState || state.activePage !== pageId) return;
    const index = targetBook.pages.findIndex(page => page.id === pageId);
    if (index < 0) return;
    targetBook.pages.splice(index, 1);
    if (!targetBook.pages.length) targetBook.pages.push(newPage('Страница 1'));
    switchPage(targetBook.pages[Math.min(index, targetBook.pages.length - 1)].id);
    pageHistories.delete(pageId);
  });
  $('dialogOk').textContent = 'Удалить';
}
$('upload').onclick = () => $('photoInput').click();
async function addPhotos(files, position = null) {
  if (!state || gesture || $('dialog').open || !files.length) return;
  const documentState = state,
    page = current();
  try {
    const elements = [];
    for (const file of files) {
      if (file.size > 25 * 1024 * 1024)
        throw Error('Выбери изображение меньше 25 МБ');
      const bitmap = await createImageBitmap(file);
      let src, width, height;
      try {
        const scale = Math.min(1, 2000 / Math.max(bitmap.width, bitmap.height));
        const tmp = document.createElement('canvas');
        width = tmp.width = Math.max(1, Math.round(bitmap.width * scale));
        height = tmp.height = Math.max(1, Math.round(bitmap.height * scale));
        tmp.getContext('2d').drawImage(bitmap, 0, 0, width, height);
        src = tmp.toDataURL('image/png');
      } finally {
        bitmap.close();
      }
      const fit = Math.min(1, 800 / width, 1200 / height);
      const w = width * fit,
        h = height * fit,
        offset = elements.length * 24;
      elements.push({
        id: uid(),
        type: 'image',
        src,
        x: Math.max(0, Math.min(W - w, (position?.x ?? 80) + offset)),
        y: Math.max(0, Math.min(H - h, (position?.y ?? 100) + offset)),
        w,
        h
      });
    }
    if (
      state !== documentState ||
      current() !== page ||
      gesture ||
      $('dialog').open
    ) {
      toast('Страница или режим изменились. Добавь фото ещё раз.');
      return;
    }
    history();
    page.elements.push(...elements);
    setTool('select');
    selection = elements.map((el) => el.id);
    draw();
    save();
    toast('Фото добавлено. Перетаскивай его или растягивай за рамку.');
  } catch (error) {
    toast(
      error.message === 'Выбери изображение меньше 25 МБ'
        ? error.message
        : 'Не удалось открыть изображение. Попробуй PNG или JPEG.'
    );
  }
}

$('photoInput').onchange = async (e) => {
  const files = Array.from(e.target.files || []);
  e.target.value = '';
  await addPhotos(files.slice(0, 1));
};

function editingText() {
  const active = document.activeElement;
  return (
    active?.isContentEditable ||
    ['INPUT', 'TEXTAREA', 'SELECT'].includes(active?.tagName)
  );
}

function clipboardInTextField() {
  const active = document.activeElement;
  return (
    active?.isContentEditable ||
    active?.tagName === 'TEXTAREA' ||
    (active?.tagName === 'INPUT' &&
      ![
        'range',
        'color',
        'checkbox',
        'radio',
        'file',
        'button',
        'submit',
        'reset',
        'image',
        'hidden'
      ].includes(active.type))
  );
}

window.addEventListener('copy', (e) => {
  if (viewMode !== 'editor') return;
  if (
    !state ||
    gesture ||
    $('dialog').open ||
    clipboardInTextField() ||
    !selection.length
  )
    return;
  copySelection(e);
});

window.addEventListener('paste', async (e) => {
  if (!state || viewMode !== 'editor' || gesture || $('dialog').open || clipboardInTextField()) return;
  const data = e.clipboardData;
  if (!data) return;
  if (
    clipboard &&
    data.getData('application/x-tetrad-selection') === clipboardToken
  ) {
    e.preventDefault();
    pasteObject();
    return;
  }
  const files = Array.from(data.items || [])
    .filter((item) => item.kind === 'file' && item.type.startsWith('image/'))
    .map((item) => item.getAsFile())
    .filter(Boolean);
  if (!files.length)
    files.push(
      ...Array.from(data.files || []).filter((file) =>
        file.type.startsWith('image/')
      )
    );
  if (files.length) {
    e.preventDefault();
    const position = pastePosition();
    await addPhotos(files, position);
  } else if (clipboard) {
    e.preventDefault();
    pasteObject();
  }
});

function download(blob, name) {
  const a = document.createElement('a'),
    url = URL.createObjectURL(blob);
  a.href = url;
  a.download = name;
  document.body.append(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 30000);
}
$('backup').onclick = () => {
  const backup = state || loadedBackup;
  if (backup === undefined) return;
  download(
    new Blob([JSON.stringify(backup)], { type: 'application/json' }),
    'vibenotes-' + new Date().toISOString().slice(0, 10) + '.json'
  );
};
$('restoreInput').onchange = async (e) => {
  const file = e.target.files[0];
  e.target.value = '';
  if (!file || !state || !storageWritable) return;
  try {
    const restored = validateState(JSON.parse(await file.text()));
    const body = document.createElement('p');
    body.textContent =
      'Текущие тетради будут заменены содержимым файла. Перед восстановлением скачай резервную копию текущих записей.';
    showDialog('Восстановить тетради?', body, () => {
      state = migrateLibrary(restored);
      images.clear();
      switchPage(state.activePage);
      toast('Резервная копия восстановлена');
    });
  } catch (err) {
    toast(err.message || 'Не удалось восстановить файл');
  }
};
$('export').onclick = async () => {
  try {
    await Promise.all(
      current()
        .elements.filter((e) => e.type === 'image')
        .map((e) => {
          const img = imageFor(e.src);
          return img.decode();
        })
    );
    const tmp = document.createElement('canvas');
    tmp.width = W;
    tmp.height = H;
    draw(tmp.getContext('2d'), false);
    tmp.toBlob((blob) => {
      if (blob) download(blob, pageLabel() + '.png');
    });
  } catch {
    toast('Ошибка экспорта: проверь изображения на странице');
  }
};
function applyTheme(theme) {
  document.documentElement.dataset.theme = theme;
  window.vibenotesAppearance.updateThemeColor();
}

function syncSavedAppearance() {
  if ($('dialog').open && $('dialogBody').querySelector('.settings-panel')) return;
  const appearance = window.vibenotesAppearance;
  const { dataset } = document.documentElement;
  let theme, accent;
  try {
    theme = localStorage.getItem('vibenotes-theme') === 'dark' ? 'dark' : 'light';
    accent = localStorage.getItem('vibenotes-accent') || appearance.defaultAccent;
  } catch { return; }
  if (theme === dataset.theme && accent === dataset.accent) return;
  applyTheme(theme);
  appearance.applyAccent(accent);
  if (viewMode === 'editor') draw();
}

window.addEventListener('storage', (event) => {
  if (event.key === 'vibenotes-theme' || event.key === 'vibenotes-accent') syncSavedAppearance();
});
window.addEventListener('pageshow', (event) => {
  if (event.persisted) syncSavedAppearance();
});

$('settings').onclick = () => {
  if (gesture || $('dialog').open) return;
  const original = document.documentElement.dataset.theme || 'light';
  const appearance = window.vibenotesAppearance;
  const originalAccent = document.documentElement.dataset.accent || appearance.defaultAccent;
  const body = document.createElement('div');
  body.className = 'settings-panel';
  body.innerHTML = '<fieldset class="theme-options"><legend>Оформление</legend>' +
    '<label class="theme-option"><input type="radio" name="theme" value="light">' +
    '<span class="theme-sample light-sample" aria-hidden="true"></span>Светлая тема</label>' +
    '<label class="theme-option"><input type="radio" name="theme" value="dark">' +
    '<span class="theme-sample dark-sample" aria-hidden="true"></span>Тёмная тема</label></fieldset>' +
    '<div class="accent-settings"><label for="interfaceAccent">Основной цвет</label>' +
    '<input id="interfaceAccent" type="color" aria-label="Основной цвет интерфейса">' +
    '<button id="resetAccent" type="button">Вернуть розовый</button></div>' +
    '<div class="storage-settings">' +
    '<button id="protectStorage" type="button">Закрепить хранение в браузере</button>' +
    '<button id="restore" type="button">Восстановить из файла</button></div>';
  body.querySelector(`input[value="${original}"]`).checked = true;
  const accentInput = body.querySelector('#interfaceAccent');
  accentInput.value = originalAccent;
  accentInput.oninput = accentInput.onchange = () => {
    appearance.applyAccent(accentInput.value);
    if (viewMode === 'editor') draw();
  };
  body.querySelector('#resetAccent').onclick = () => {
    accentInput.value = appearance.defaultAccent;
    accentInput.oninput();
  };
  body.onchange = event => {
    if (event.target.name !== 'theme') return;
    applyTheme(event.target.value);
  };
  showDialog('Настройки', body, () => {
    const chosen = body.querySelector('input[name="theme"]:checked').value;
    const chosenAccent = accentInput.value;
    applyTheme(chosen);
    appearance.applyAccent(chosenAccent);
    if (viewMode === 'editor') draw();
    try {
      localStorage.setItem('vibenotes-theme', chosen);
      localStorage.setItem('vibenotes-accent', chosenAccent);
      toast('Оформление сохранено');
    } catch { toast('Оформление включено. Браузер не разрешил сохранить его для следующего запуска.'); }
  }, () => {
    applyTheme(original);
    appearance.applyAccent(originalAccent);
    if (viewMode === 'editor') draw();
    syncSavedAppearance();
  });
  $('dialogOk').textContent = 'Сохранить';
  $('restore').disabled = !state || !storageWritable;
  $('restore').onclick = () => {
    $('dialog').close('cancel');
    $('restoreInput').click();
  };
  const protect = $('protectStorage');
  const updateProtection = granted => {
    protect.title = granted ? 'Браузер предоставил постоянное хранение.' : 'Постоянное хранение пока не предоставлено. Скачивай резервные копии.';
    protect.disabled = granted;
  };
  if (!navigator.storage?.persist) {
    protect.title = 'Закрепление хранения недоступно в этом браузере. Используй резервные копии JSON.';
    protect.disabled = true;
  } else {
    navigator.storage.persisted().then(updateProtection).catch(() => updateProtection(false));
    protect.onclick = async () => {
      protect.disabled = true;
      try { updateProtection(await navigator.storage.persist()); }
      catch { updateProtection(false); }
      toast(protect.title);
    };
  }
};

$('help').onclick = () => {
  const body = document.createElement('div');
  body.innerHTML =
    '<p>Загрузи фото, вставь изображение из буфера через Ctrl+V или начни писать на листе.</p><ul><li><b>P</b> — перо, <b>M</b> — маркер, <b>E</b> — ластик целого штриха.</li><li><b>V</b> — лассо: обведи штрихи, фото и текст целиком, затем перетаскивай выделенную область. Тяни за углы и стороны рамки, чтобы растягивать фигуры, штрихи и фото. Shift при изменении размера фото сохраняет пропорции. Круглая ручка вращает фигуры и штрихи, Shift задаёт шаг 15°. В меню по правой кнопке есть повороты на 90° и зеркальные отражения.</li><li><b>T</b> — текст. Двойной щелчок по тексту в режиме выбора — редактировать.</li><li><b>Ctrl+C / Ctrl+V</b> — копировать и вставлять объект внутри приложения, <b>Ctrl+D</b> — дублировать.</li><li><b>Delete</b> — удалить выбранный объект, <b>Esc</b> — снять выделение. Действия доступны по правой кнопке на странице.</li><li><b>Фигуры</b> — нажми значок круга с квадратом, выбери фигуру и нарисуй её перетаскиванием. После создания двигай её за выделенную область и растягивай за углы или стороны рамки.</li><li><b>Ровные фигуры</b> — нарисуй пером линию, круг, овал, треугольник или прямоугольник одним штрихом и задержи перо в конце примерно на 0,45 секунды. Подними перо, чтобы сохранить, или продолжи движение для свободного рисунка.</li><li><b>Очистить страницу…</b> — удалить всё её содержимое с подтверждением. Очистку можно отменить до смены страницы.</li><li><b>Пробел + перетаскивание</b> — двигать холст.</li><li><b>Ctrl + колесо</b> — масштаб, <b>Ctrl + Z</b> — отмена.</li><li>Двойной щелчок по тетради — переименовать.</li></ul><p>Нажим работает, если браузер получает давление от планшета. Отключи «Нажим» для постоянной толщины.</p><p>Записи сохраняются только в этом браузере. Регулярно скачивай резервную копию: очистка данных сайта удалит локальные конспекты.</p>';
  showDialog('Твоё место для мыслей', body, () => {});
};
window.addEventListener('keydown', (e) => {
  if (viewMode !== 'editor' || gesture || $('dialog').open || e.isComposing || clipboardInTextField()) return;
  const k = e.key.toLowerCase();
  if (e.ctrlKey || e.metaKey) {
    // Physical keys keep shortcuts working in Russian and other layouts.
    const command = /^Key[A-Z]$/.test(e.code || '') ? e.code.slice(3).toLowerCase() : k;
    if (command === 'z') {
      e.preventDefault();
      e.shiftKey ? redo() : undo();
    } else if (command === 'y') {
      e.preventDefault();
      redo();
    } else if (command === 'd' && selection.length) {
      e.preventDefault();
      pasteObject(selectedElements(), false);
    }
    return;
  }
  if (editingText()) return;
  if (k === ' ') {
    space = true;
    e.preventDefault();
  }
  const keys = {
    p: 'pen',
    m: 'marker',
    e: 'eraser',
    t: 'text',
    v: 'select',
    h: 'hand'
  };
  if (keys[k]) setTool(keys[k]);
  if (k === 'escape') {
    closeSelectionMenu();
    closeShapeMenu();
    selection = [];
    draw();
  }
  if ((k === 'delete' || k === 'backspace') && selection.length) {
    e.preventDefault();
    deleteSelection();
  }
});
window.addEventListener('keyup', (e) => {
  if (e.key === ' ') space = false;
});
window.addEventListener('blur', () => (space = false));
document.addEventListener('visibilitychange', () => {
  if (
    document.visibilityState === 'hidden' &&
    $('saveStatus').textContent !== '✓ Сохранено'
  ) {
    flushSave();
    storageWorker?.postMessage({ type: 'flush' });
  }
});
window.addEventListener('beforeunload', (e) => {
  if (state && $('saveStatus').textContent !== '✓ Сохранено') {
    flushSave();
    storageWorker?.postMessage({ type: 'flush' });
    e.preventDefault();
    e.returnValue = '';
  }
});

function loadFailed(error) {
  storageWritable = false;
  clearTimeout(saveTimer);
  clearTimeout(workerStartTimer);
  storageWorker?.terminate();
  storageWorker = null;
  $('saveStatus').textContent = 'Не удалось загрузить';
  $('libraryView').hidden = true;
  $('editorView').hidden = true;
  $('newBook').disabled = true;
  $('backup').disabled = state === undefined && loadedBackup === undefined;
  $('export').hidden = true;
  $('retrySave').textContent = 'Повторить открытие';
  storageNotice('Не удалось открыть конспекты. ' + error.message + ' Сохранённые записи не заменялись. Адрес: ' + location.origin +
    '. Открой тот же адрес и профиль браузера, где велись записи.');
}

$('retrySave').onclick = () => {
  if (!storageWritable || !state) { location.reload(); return; }
  $('saveStatus').textContent = 'Сохраняется…';
  flushSave();
  storageWorker?.postMessage({ type: 'flush' });
};

async function loadWorkspace() {
  storageWritable = false;
  try {
    db = await new Promise((resolve, reject) => {
      const req = indexedDB.open('tetrad-studio', 1);
      let finished = false;
      const fail = error => {
        if (finished) return;
        finished = true;
        clearTimeout(timeout);
        reject(error);
      };
      const timeout = setTimeout(() => fail(Error('Браузер слишком долго открывает хранилище. Закрой другие вкладки vibenotes и повтори.')), 8000);
      req.onupgradeneeded = () => {
        if (finished) { req.transaction.abort(); return; }
        if (!req.result.objectStoreNames.contains('workspace')) req.result.createObjectStore('workspace');
      };
      req.onsuccess = () => {
        if (finished) { req.result.close(); return; }
        finished = true;
        clearTimeout(timeout);
        resolve(req.result);
      };
      req.onerror = () => fail(req.error || Error('Не удалось открыть хранилище браузера.'));
      req.onblocked = () => fail(Error('Хранилище занято другой вкладкой. Закрой её и повтори.'));
    });
    const stored = await new Promise((resolve, reject) => {
      const tx = db.transaction('workspace', 'readonly');
      const req = tx.objectStore('workspace').get('state');
      tx.oncomplete = () => resolve(req.result);
      tx.onerror = tx.onabort = () => reject(tx.error || req.error || Error('Не удалось прочитать конспекты.'));
    });
    // Only an absent key means a new workspace. Invalid or unreadable data must
    // never be replaced by the starter notebook.
    loadedBackup = stored;
    const loaded = stored === undefined ? initialState() : validateState(stored);
    state = migrateLibrary(loaded);
    storageWritable = true;
    db.onversionchange = () => {
      db.close();
      storageWritable = false;
      storageWorker?.terminate();
      storageWorker = null;
      saveFailed();
      $('books').inert = true;
      $('newBook').disabled = true;
      $('editorView').inert = true;
    };
    startStorageWorker(stored !== undefined);
  } catch (error) {
    db?.close();
    db = null;
    loadFailed(error);
    return;
  }
  $('newBook').disabled = false;
  $('backup').disabled = false;
  $('storageNotice').hidden = true;
  $('retrySave').textContent = 'Повторить сохранение';
  viewMode = 'library';
  browsedFolderId = null;
  renderNav();
  pageStack?.scrollTo(state.activePage);
  updateUndo();
  draw();
  save();
}

async function init() {
  $('newBook').disabled = true;
  $('backup').disabled = true;
  $('libraryView').hidden = true;
  $('editorView').hidden = true;
  $('export').hidden = true;
  viewMode = 'library';
  if (!navigator.locks?.request) {
    loadFailed(Error('В этом браузере недоступна защита от записи из нескольких вкладок. Используй актуальный Chrome или Firefox: опубликованный сайт открывай по HTTPS, локально — по адресу http://127.0.0.1:8000/.'));
    return;
  }
  try {
    await navigator.locks.request('vibenotes-workspace', { mode: 'exclusive', ifAvailable: true }, async lock => {
      if (!lock) {
        loadFailed(Error('Конспекты уже открыты в другой вкладке vibenotes. Продолжи там либо закрой её и нажми «Повторить открытие».'));
        return;
      }
      await loadWorkspace();
      // The browser releases this lock when the document is destroyed. Holding
      // it for the whole session prevents stale tabs from overwriting notes.
      await new Promise(() => {});
    });
  } catch (error) { loadFailed(error); }
}
init();
