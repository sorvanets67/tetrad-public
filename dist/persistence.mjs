// Patches are only messages to the worker. IndexedDB still stores the complete
// version:1 document at workspace/state. Library metadata is migrated in app.js.
export class DocumentPatches {
  constructor() {
    this.pages = new Map();
    this.pageObjects = new Map();
    this.covers = new Map();
  }

  prime(state) {
    this.pages.clear();
    this.pageObjects.clear();
    this.covers.clear();
    for (const item of [...(state.folders || []), ...state.books]) {
      if (item.cover) this.covers.set(item.id, item.cover);
    }
    for (const book of state.books)
      for (const page of book.pages) {
        this.pages.set(
          page.id,
          new Map(page.elements.map((el) => [el.id, el]))
        );
        this.pageObjects.set(page.id, page);
      }
  }

  coverMetadata(item) {
    if (!item.cover) {
      this.covers.delete(item.id);
      return {};
    }
    if (this.covers.get(item.id) === item.cover) return { coverUnchanged: true };
    this.covers.set(item.id, item.cover);
    return { cover: { ...item.cover } };
  }

  create(state, dirtyPages) {
    const changes = [],
      present = new Set();
    const books = state.books.map((book) => ({
      id: book.id,
      name: book.name,
      ...this.coverMetadata(book),
      ...(book.folderId !== undefined ? { folderId: book.folderId } : {}),
      pages: book.pages.map((page) => {
        present.add(page.id);
        const previous = this.pages.get(page.id);
        if (
          !previous ||
          this.pageObjects.get(page.id) !== page ||
          dirtyPages.has(page.id)
        ) {
          const upserts = page.elements.filter(
            (el) => previous?.get(el.id) !== el
          );
          changes.push({
            id: page.id,
            order: page.elements.map((el) => el.id),
            upserts
          });
          this.pages.set(
            page.id,
            new Map(page.elements.map((el) => [el.id, el]))
          );
          this.pageObjects.set(page.id, page);
        }
        return {
          id: page.id,
          title: page.title,
          paper: page.paper,
          ...(page.paperColor !== undefined ? { paperColor: page.paperColor } : {}),
          created: page.created
        };
      })
    }));
    for (const id of this.pages.keys())
      if (!present.has(id)) {
        this.pages.delete(id);
        this.pageObjects.delete(id);
      }
    const libraryIds = new Set([...(state.folders || []), ...state.books].map(item => item.id));
    for (const id of this.covers.keys()) if (!libraryIds.has(id)) this.covers.delete(id);
    return {
      version: 1, activePage: state.activePage, books, changes,
      ...(state.folders ? { folders: state.folders.map(folder => ({
        id: folder.id, name: folder.name, parentId: folder.parentId,
        ...this.coverMetadata(folder)
      })) } : {})
    };
  }
}

export function applyDocumentPatch(previous, patch) {
  const oldFolders = new Map((previous?.folders || []).map(item => [item.id, item]));
  const oldBooks = new Map((previous?.books || []).map(item => [item.id, item]));
  const restoreCover = (item, old) => {
    const { coverUnchanged, ...metadata } = item;
    if (coverUnchanged) {
      if (!old?.cover) throw Error('Нет сохранённой обложки');
      metadata.cover = { ...old.cover };
    } else if (metadata.cover) metadata.cover = { ...metadata.cover };
    return metadata;
  };
  const pages = new Map();
  for (const book of previous?.books || [])
    for (const page of book.pages) pages.set(page.id, page);
  const changes = new Map(patch.changes.map((change) => [change.id, change]));
  return {
    version: 1,
    activePage: patch.activePage,
    ...(patch.folders ? { folders: patch.folders.map(folder => restoreCover(folder, oldFolders.get(folder.id))) } : {}),
    books: patch.books.map((book) => ({
      ...restoreCover(book, oldBooks.get(book.id)),
      pages: book.pages.map((meta) => {
        const old = pages.get(meta.id),
          change = changes.get(meta.id);
        if (!change) {
          if (!old) throw Error('Нет сохранённых объектов страницы');
          return { ...meta, elements: old.elements };
        }
        const elements = new Map(
          (old?.elements || []).map((el) => [el.id, el])
        );
        for (const el of change.upserts) elements.set(el.id, el);
        return {
          ...meta,
          elements: change.order.map((id) => {
            if (!elements.has(id)) throw Error('Нет сохранённого объекта');
            return elements.get(id);
          })
        };
      })
    }))
  };
}

// Elements are immutable after a stroke finishes. Keep stable arrays for the
// fallback writer without deep-copying every point and embedded photo twice.
export function snapshotDocument(state) {
  return {
    ...state,
    ...(state.folders ? { folders: state.folders.map(folder => ({ ...folder, ...(folder.cover ? { cover: { ...folder.cover } } : {}) })) } : {}),
    books: state.books.map((book) => ({
      ...book,
      ...(book.cover ? { cover: { ...book.cover } } : {}),
      pages: book.pages.map((page) => ({
        ...page,
        elements: page.elements.slice()
      }))
    }))
  };
}
