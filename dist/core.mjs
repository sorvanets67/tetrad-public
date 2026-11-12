export const W = 1100,
  H = 1550;
export const uid = () => globalThis.crypto.randomUUID();
export const DEFAULT_PRESSURE = 5 / 6;

export function penWidth(size, pressure = DEFAULT_PRESSURE) {
  return size * (0.25 + 0.9 * pressure);
}

// Weight by distance rather than event count: pauses and different tablet
// sampling rates should not change the effective thickness of a figure.
export function averagePressure(points) {
  let total = 0,
    length = 0;
  for (let i = 1; i < points.length; i++) {
    const a = points[i - 1],
      b = points[i];
    const distance = Math.hypot(b.x - a.x, b.y - a.y);
    total +=
      (distance * ((a.p ?? DEFAULT_PRESSURE) + (b.p ?? DEFAULT_PRESSURE))) / 2;
    length += distance;
  }
  return Math.max(
    0.05,
    Math.min(1, length ? total / length : (points[0]?.p ?? DEFAULT_PRESSURE))
  );
}

export function recentWritingPressure(elements) {
  // Older menu figures used a constant 0.8. Don't let that old default
  // override actual handwriting after reloading a document.
  for (let i = elements.length - 1; i >= 0; i--) {
    const el = elements[i];
    if (
      el.type === 'stroke' &&
      el.tool === 'pen' &&
      (el.points.some((p) => Math.abs(p.p - el.points[0].p) > 0.005) ||
        Math.abs(el.points[0].p - 0.8) > 0.005)
    ) {
      return averagePressure(el.points);
    }
  }
  return DEFAULT_PRESSURE;
}

// Uniformly resize around the opposite corner (or opposite edge centre),
// keeping both dimensions inside the page even when the pointer crosses it.
export function aspectResizeBounds(r, handle, point, min = 8) {
  const { column, row } = handle;
  const anchorX = r.x + (column === 0 ? r.w : column === 1 ? r.w / 2 : 0);
  const anchorY = r.y + (row === 0 ? r.h : row === 1 ? r.h / 2 : 0);
  const sx = column === 0 ? (anchorX - point.x) / r.w : (point.x - anchorX) / r.w;
  const sy = row === 0 ? (anchorY - point.y) / r.h : (point.y - anchorY) / r.h;
  const requested = column === 1 ? sy : row === 1 ? sx :
    Math.abs(sx - 1) >= Math.abs(sy - 1) ? sx : sy;
  const maxX = (column === 0 ? anchorX : column === 2 ? W - anchorX : 2 * Math.min(anchorX, W - anchorX)) / r.w;
  const maxY = (row === 0 ? anchorY : row === 2 ? H - anchorY : 2 * Math.min(anchorY, H - anchorY)) / r.h;
  const scale = Math.min(maxX, maxY, Math.max(min / r.w, min / r.h, requested));
  const w = r.w * scale, h = r.h * scale;
  return {
    x: anchorX - (column === 0 ? w : column === 1 ? w / 2 : 0),
    y: anchorY - (row === 0 ? h : row === 1 ? h / 2 : 0),
    w, h
  };
}

export function newPage(title = 'Новая страница') {
  return { id: uid(), title, paper: 'dots', created: Date.now(), elements: [] };
}

export function initialState() {
  const p = newPage('Страница 1');
  return {
    version: 1,
    books: [{ id: uid(), name: 'Моя тетрадь', pages: [p] }],
    activePage: p.id
  };
}

export function segmentDistance(p, a, b) {
  const dx = b.x - a.x,
    dy = b.y - a.y;
  const t = Math.max(
    0,
    Math.min(
      1,
      ((p.x - a.x) * dx + (p.y - a.y) * dy) / (dx * dx + dy * dy || 1)
    )
  );
  return Math.hypot(p.x - a.x - t * dx, p.y - a.y - t * dy);
}

export function strokeHit(el, p, tolerance = 10) {
  if (el.type !== 'stroke') return false;
  return el.points.some(
    (q, i) =>
      segmentDistance(p, q, el.points[Math.max(0, i - 1)]) <
      tolerance + el.size / 2
  );
}

export function strokeBounds(el) {
  const padding = el.size * (el.tool === 'marker' ? 2.5 : 0.575);
  let left = Infinity,
    top = Infinity,
    right = -Infinity,
    bottom = -Infinity;
  for (const p of el.points) {
    left = Math.min(left, p.x);
    top = Math.min(top, p.y);
    right = Math.max(right, p.x);
    bottom = Math.max(bottom, p.y);
  }
  return {
    x: left - padding,
    y: top - padding,
    w: right - left + padding * 2,
    h: bottom - top + padding * 2
  };
}

// Count substantial reversals along several axes. This accepts fan-shaped
// strokes, waves and flat scribbles without depending on drawing speed or
// the number of Pointer Events emitted by a tablet.
export function scribbleArea(points, minimum = 8) {
  if (points.length < 5) return null;
  const area = strokeBounds({ points, size: 0, tool: 'pen' });
  let length = 0;
  for (let i = 1; i < points.length; i++) {
    length += Math.hypot(
      points[i].x - points[i - 1].x,
      points[i].y - points[i - 1].y
    );
  }
  if (
    Math.max(area.w, area.h) < minimum * 3 ||
    length < Math.max(minimum * 9, Math.hypot(area.w, area.h) * 2.2)
  )
    return null;
  const diagonal = Math.SQRT1_2;
  for (const [dx, dy] of [
    [1, 0],
    [0, 1],
    [diagonal, diagonal],
    [diagonal, -diagonal]
  ]) {
    const values = points.map((p) => (p.x - area.x) * dx + (p.y - area.y) * dy);
    let low = Infinity,
      high = -Infinity;
    for (const value of values) {
      low = Math.min(low, value);
      high = Math.max(high, value);
    }
    const extent = high - low;
    if (extent < minimum * 2) continue;
    const threshold = Math.max(minimum, extent * 0.18);
    let start = values[0],
      extreme = start,
      direction = 0,
      passes = 0,
      travel = 0;
    for (const value of values.slice(1)) {
      if (!direction) {
        if (Math.abs(value - start) >= threshold) {
          direction = Math.sign(value - start);
          extreme = value;
        }
      } else if ((value - extreme) * direction >= 0) {
        extreme = value;
      } else if ((extreme - value) * direction >= threshold) {
        travel += Math.abs(extreme - start);
        passes++;
        start = extreme;
        extreme = value;
        direction = -direction;
      }
    }
    if (direction) {
      passes++;
      travel += Math.abs(extreme - start);
    }
    if (passes >= 4 && travel >= extent * 2.4) return area;
  }
  return null;
}

export function scribbleHits(el, area, rectangle) {
  const r = el.type === 'stroke' ? strokeBounds(el) : rectangle;
  if (
    r.x > area.x + area.w ||
    r.x + r.w < area.x ||
    r.y > area.y + area.h ||
    r.y + r.h < area.y
  )
    return false;
  if (el.type !== 'stroke') return true;
  // Test the actual ink, so an enclosing circle is not erased just because
  // its bounding box overlaps the scribble.
  const padding = el.size * (el.tool === 'marker' ? 2.5 : 0.575);
  const left = area.x - padding,
    right = area.x + area.w + padding;
  const top = area.y - padding,
    bottom = area.y + area.h + padding;
  return el.points.some((b, i) => {
    const a = el.points[Math.max(0, i - 1)];
    let lo = 0,
      hi = 1;
    for (const [start, delta, min, max] of [
      [a.x, b.x - a.x, left, right],
      [a.y, b.y - a.y, top, bottom]
    ]) {
      if (delta === 0) {
        if (start < min || start > max) return false;
      } else {
        const t1 = (min - start) / delta,
          t2 = (max - start) / delta;
        lo = Math.max(lo, Math.min(t1, t2));
        hi = Math.min(hi, Math.max(t1, t2));
        if (lo > hi) return false;
      }
    }
    return true;
  });
}

export function translateElement(el, dx, dy) {
  const moved = structuredClone(el);
  if (moved.type === 'stroke') {
    for (const p of moved.points) {
      p.x += dx;
      p.y += dy;
    }
  } else {
    moved.x += dx;
    moved.y += dy;
  }
  return moved;
}

export function insideLasso(el, polygon, rectangle) {
  if (polygon.length < 3) return false;
  const edges = polygon.map((p, i) => [p, polygon[(i + 1) % polygon.length]]);
  const area = edges.reduce((sum, [a, b]) => sum + a.x * b.y - b.x * a.y, 0);
  if (Math.abs(area) < 1) return false;
  function contains(p) {
    let inside = false;
    for (const [a, b] of edges) {
      if (segmentDistance(p, a, b) < 1e-7) return true;
      if (
        a.y > p.y !== b.y > p.y &&
        p.x < a.x + ((b.x - a.x) * (p.y - a.y)) / (b.y - a.y)
      )
        inside = !inside;
    }
    return inside;
  }
  const r = rectangle;
  const points =
    el.type === 'stroke'
      ? el.points
      : [
          { x: r.x, y: r.y },
          { x: r.x + r.w, y: r.y },
          { x: r.x + r.w, y: r.y + r.h },
          { x: r.x, y: r.y + r.h }
        ];
  if (!points.every(contains)) return false;
  const cross = (a, b, p) =>
    (b.x - a.x) * (p.y - a.y) - (b.y - a.y) * (p.x - a.x);
  const count = el.type === 'stroke' ? points.length - 1 : points.length;
  for (let i = 0; i < count; i++) {
    const a = points[i],
      b = points[(i + 1) % points.length];
    for (const [c, d] of edges) {
      if (
        cross(a, b, c) * cross(a, b, d) < 0 &&
        cross(c, d, a) * cross(c, d, b) < 0
      )
        return false;
    }
  }
  return true;
}

export function validateState(s) {
  if (
    !s ||
    s.version !== 1 ||
    !Array.isArray(s.books) ||
    !s.books.length ||
    s.books.length > 500
  )
    throw Error('Неверный формат резервной копии');
  const ids = new Set();
  let count = 0;
  const id = (v) => {
    if (typeof v !== 'string' || !v || ids.has(v))
      throw Error('Повреждены идентификаторы');
    ids.add(v);
  };
  const str = (v, n) => {
    if (typeof v !== 'string' || v.length > n)
      throw Error('Повреждены текстовые данные');
  };
  const num = (v) => {
    if (typeof v !== 'number' || !Number.isFinite(v) || Math.abs(v) > 1e7)
      throw Error('Повреждены координаты');
  };
  const cover = (value) => {
    if (value === undefined) return;
    if (!value || typeof value !== 'object' || Array.isArray(value))
      throw Error('Повреждена обложка');
    if (value.color !== undefined && (typeof value.color !== 'string' || !/^#[0-9a-f]{6}$/i.test(value.color)))
      throw Error('Повреждён цвет обложки');
    if (value.tabColor !== undefined && (typeof value.tabColor !== 'string' || !/^#[0-9a-f]{6}$/i.test(value.tabColor)))
      throw Error('Повреждён цвет выступа');
    if (value.spineColor !== undefined && (typeof value.spineColor !== 'string' || !/^#[0-9a-f]{6}$/i.test(value.spineColor)))
      throw Error('Повреждён цвет корешка');
    if (value.image !== undefined && (typeof value.image !== 'string' || value.image.length > 4_000_000 ||
        !/^data:image\/(png|jpeg|webp);base64,[a-zA-Z0-9+/=]+$/.test(value.image)))
      throw Error('Повреждено изображение обложки');
  };
  const folders = new Map();
  if (s.folders !== undefined) {
    if (!Array.isArray(s.folders) || s.folders.length > 1000)
      throw Error('Слишком много папок или повреждена структура');
    for (const folder of s.folders) {
      if (!folder || typeof folder !== 'object') throw Error('Повреждена папка');
      id(folder.id);
      str(folder.name, 100);
      cover(folder.cover);
      folders.set(folder.id, folder);
    }
    for (const folder of s.folders) {
      let current = folder;
      const path = new Set();
      while (current) {
        if (path.has(current.id) || path.size >= 32)
          throw Error('Цикл или слишком большая вложенность папок');
        path.add(current.id);
        if (current.parentId === null) break;
        if (typeof current.parentId !== 'string' || !folders.has(current.parentId))
          throw Error('Родительская папка не найдена');
        current = folders.get(current.parentId);
      }
    }
  }
  if (folders.size + s.books.filter(book => book.folderId === undefined).length > 1000)
    throw Error('Слишком много папок после переноса старых тетрадей');
  for (const b of s.books) {
    if (b.folderId !== undefined && !folders.has(b.folderId))
      throw Error('Папка документа не найдена');
    id(b.id);
    str(b.name, 100);
    cover(b.cover);
    if (!Array.isArray(b.pages) || !b.pages.length)
      throw Error('В тетради нет страниц');
    for (const p of b.pages) {
      if (++count > 5000) throw Error('Слишком много страниц');
      id(p.id);
      str(p.title, 100);
      if (
        typeof p.created !== 'number' ||
        !Number.isFinite(p.created) ||
        Math.abs(p.created) > 8.64e15
      )
        throw Error('Повреждена дата');
      if (
        !['dots', 'grid', 'lines', 'blank'].includes(p.paper) ||
        (p.paperColor !== undefined && !['white', 'yellow', 'black'].includes(p.paperColor)) ||
        !Array.isArray(p.elements) ||
        p.elements.length > 100000
      )
        throw Error('Повреждена страница');
      for (const e of p.elements) {
        id(e.id);
        if (e.type === 'stroke') {
          str(e.color, 30);
          num(e.size);
          if (
            e.size <= 0 ||
            !['pen', 'marker'].includes(e.tool) ||
            (e.dashed !== undefined && typeof e.dashed !== 'boolean') ||
            !Array.isArray(e.points) ||
            !e.points.length ||
            e.points.length > 1000000
          )
            throw Error('Повреждён штрих');
          for (const q of e.points) {
            num(q.x);
            num(q.y);
            num(q.p);
          }
        } else if (e.type === 'image') {
          num(e.x);
          num(e.y);
          num(e.w);
          num(e.h);
          if (
            e.w <= 0 ||
            e.h <= 0 ||
            typeof e.src !== 'string' ||
            !/^data:image\/(png|jpeg|webp|gif);base64,[a-zA-Z0-9+/=]+$/.test(
              e.src
            )
          )
            throw Error('Повреждено изображение');
        } else if (e.type === 'text') {
          num(e.x);
          num(e.y);
          num(e.size);
          str(e.text, 20000);
          str(e.color, 30);
        } else throw Error('Неизвестный объект');
      }
    }
  }
  if (!s.books.some((b) => b.pages.some((p) => p.id === s.activePage)))
    s.activePage = s.books[0].pages[0].id;
  return s;
}
