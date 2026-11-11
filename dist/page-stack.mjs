// Page shells keep the scroll height stable; only nearby sheets get a bitmap.
export class PageStack {
  constructor({ viewport, container, editor, render, activate, canActivate }) {
    Object.assign(this, {
      viewport,
      container,
      editor,
      render,
      activate,
      canActivate
    });
    this.sheets = new Map();
    this.orderedSheets = [];
    this.nearby = new Set();
    this.activeId = null;
    this.zoom = 1;
    this.observer = new IntersectionObserver(
      (entries) => {
        for (const entry of entries) {
          const id = entry.target.dataset.pageId;
          if (this.sheets.get(id)?.root !== entry.target) continue;
          if (entry.isIntersecting) this.nearby.add(id);
          else {
            this.nearby.delete(id);
            this.release(this.sheets.get(id));
          }
        }
        this.requestUpdate();
      },
      { root: viewport, rootMargin: '600px 0px' }
    );
    viewport.addEventListener(
      'scroll',
      () => {
        this.followScroll = true;
        this.requestUpdate();
      },
      { passive: true }
    );
    window.addEventListener('resize', () => {
      this.followScroll = true;
      this.requestUpdate();
    });
    window.addEventListener('pointerup', () => this.requestUpdate());
    window.addEventListener('pointercancel', () => this.requestUpdate());
  }

  setPages(pages) {
    const wanted = new Map(pages.map((page) => [page.id, page]));
    for (const [id, sheet] of this.sheets) {
      if (wanted.get(id) === sheet.page) continue;
      this.observer.unobserve(sheet.root);
      this.release(sheet);
      sheet.root.remove();
      this.sheets.delete(id);
      this.nearby.delete(id);
    }
    pages.forEach((page, index) => {
      let sheet = this.sheets.get(page.id);
      if (!sheet) {
        const root = document.createElement('article');
        root.className = 'page-sheet';
        root.dataset.pageId = page.id;
        const label = document.createElement('button');
        label.className = 'sheet-label';
        label.type = 'button';
        label.onclick = () => this.activate(page.id);
        const surface = document.createElement('div');
        surface.className = 'page-surface';
        root.append(label, surface);
        sheet = { root, label, surface, page, preview: null };
        this.sheets.set(page.id, sheet);
        this.observer.observe(root);
      }
      sheet.surface.dataset.paperColor = page.paperColor || 'white';
      const label = `Страница ${index + 1}`;
      if (sheet.label.textContent !== label) sheet.label.textContent = label;
      // Moving existing nodes is only necessary when pages have changed order.
      if (this.container.children[index] !== sheet.root) {
        this.container.insertBefore(
          sheet.root,
          this.container.children[index] || null
        );
      }
    });
    this.orderedSheets = pages.map((page) => this.sheets.get(page.id));
    this.setZoom(this.zoom);
  }

  setZoom(zoom, anchor) {
    let target, localX, localY;
    const bounds = anchor ? this.viewport.getBoundingClientRect() : null;
    if (anchor) {
      const x = bounds.left + anchor.x;
      const y = bounds.top + anchor.y;
      let distance = Infinity;
      for (const sheet of this.sheets.values()) {
        const rect = sheet.surface.getBoundingClientRect();
        const nextDistance = Math.max(rect.top - y, y - rect.bottom, 0);
        if (nextDistance < distance) {
          distance = nextDistance;
          target = sheet.surface;
          localX = (x - rect.left) / rect.width;
          localY = (y - rect.top) / rect.height;
        }
        if (distance === 0) break;
      }
    }
    if (zoom !== this.zoom) this.followScroll = true;
    this.zoom = zoom;
    this.container.style.width = `${1100 * zoom}px`;
    this.container.style.setProperty('--sheet-height', `${1550 * zoom}px`);
    this.editor.style.width = `${1100 * zoom}px`;
    this.editor.style.height = `${1550 * zoom}px`;
    if (target) {
      const rect = target.getBoundingClientRect();
      this.viewport.scrollLeft +=
        rect.left + localX * rect.width - bounds.left - anchor.x;
      this.viewport.scrollTop +=
        rect.top + localY * rect.height - bounds.top - anchor.y;
    }
    this.requestUpdate();
  }

  setActive(id) {
    const sheet = this.sheets.get(id);
    if (!sheet) return;
    this.sheets.get(this.activeId)?.label.setAttribute('aria-current', 'false');
    this.activeId = id;
    this.followScroll = false;
    this.release(sheet);
    sheet.surface.append(this.editor);
    sheet.label.setAttribute('aria-current', 'true');
    this.requestUpdate();
  }

  scrollTo(id) {
    const sheet = this.sheets.get(id);
    if (!sheet) return;
    const top =
      sheet.root.getBoundingClientRect().top -
      this.viewport.getBoundingClientRect().top;
    this.viewport.scrollTop += top - 20;
    this.requestUpdate();
  }

  release(sheet) {
    if (!sheet?.preview) return;
    sheet.preview.width = sheet.preview.height = 0;
    sheet.preview.remove();
    sheet.preview = null;
  }

  invalidate() {
    for (const sheet of this.sheets.values()) sheet.dirty = true;
    this.requestUpdate();
  }

  mostVisiblePage() {
    const viewport = this.viewport.getBoundingClientRect();
    // Scroll can arrive before IntersectionObserver reports the newly visible
    // sheet. Use the ordered layout for activation; the observer only loads ink.
    let low = 0,
      high = this.orderedSheets.length;
    while (low < high) {
      const middle = Math.floor((low + high) / 2);
      const rect = this.orderedSheets[middle].surface.getBoundingClientRect();
      if (rect.bottom <= viewport.top) low = middle + 1;
      else high = middle;
    }
    let best = null,
      mostVisible = 0;
    for (let index = low; index < this.orderedSheets.length; index++) {
      const sheet = this.orderedSheets[index];
      const rect = sheet.surface.getBoundingClientRect();
      if (rect.top >= viewport.bottom) break;
      const visible =
        Math.min(rect.bottom, viewport.bottom) -
        Math.max(rect.top, viewport.top);
      if (visible > mostVisible) {
        best = sheet.page.id;
        mostVisible = visible;
      }
    }
    return best;
  }

  requestUpdate() {
    if (this.frame != null) return;
    this.frame = requestAnimationFrame(() => {
      this.frame = null;
      if (!this.canActivate()) return;
      if (this.followScroll) {
        const best = this.mostVisiblePage();
        if (best) this.followScroll = false;
        if (best && best !== this.activeId) this.activate(best);
      }
      for (const id of this.nearby) {
        if (id === this.activeId) continue;
        const sheet = this.sheets.get(id);
        if (!sheet) continue;
        if (!sheet.preview) {
          sheet.preview = document.createElement('canvas');
          sheet.preview.className = 'page-preview';
          sheet.preview.setAttribute('aria-hidden', 'true');
          sheet.preview.width = 1100;
          sheet.preview.height = 1550;
          sheet.surface.append(sheet.preview);
          sheet.dirty = true;
        }
        if (sheet.dirty) {
          this.render(sheet.preview.getContext('2d'), sheet.page);
          sheet.dirty = false;
        }
      }
    });
  }
}
