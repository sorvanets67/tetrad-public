import { uid } from './core.mjs?v=20261112-marker-shapes';

// Add organization metadata to version:1 without rewriting pages or photos.
// Old flat notebooks each become one folder containing their original document.
export function migrateLibrary(state) {
  state.folders ??= [];
  for (const document of state.books) {
    if (document.folderId) continue;
    const folder = { id: uid(), name: document.name, parentId: null };
    state.folders.push(folder);
    document.folderId = folder.id;
  }
  return state;
}

export function folderPath(state, id) {
  const folders = new Map((state.folders || []).map(folder => [folder.id, folder]));
  const path = [], seen = new Set();
  while (id && folders.has(id) && !seen.has(id)) {
    seen.add(id);
    const folder = folders.get(id);
    path.unshift(folder);
    id = folder.parentId;
  }
  return path;
}

// Detect only transparent or light neutral padding, never coloured artwork borders.
function artworkBackground({ data, width, height }) {
  const corners = [0, width - 1, (height - 1) * width, width * height - 1]
    .map(index => Array.from(data.slice(index * 4, index * 4 + 4)));
  const background = corners.find(pixel => pixel[3] > 240 &&
    Math.min(...pixel.slice(0, 3)) >= 210 &&
    Math.max(...pixel.slice(0, 3)) - Math.min(...pixel.slice(0, 3)) < 25);
  const similar = pixel => background && pixel[3] > 240 &&
    [0, 1, 2].every(channel => Math.abs(pixel[channel] - background[channel]) <= 22);
  const trim = corners.filter(pixel => pixel[3] < 16 || similar(pixel)).length >= 3;
  return index => data[index + 3] < 16 || (trim && background && data[index + 3] > 240 &&
    Math.abs(data[index] - background[0]) <= 22 &&
    Math.abs(data[index + 1] - background[1]) <= 22 &&
    Math.abs(data[index + 2] - background[2]) <= 22);
}

// Trim outer padding without changing the source pixels.
export function coverArtworkBounds(pixels) {
  const { data, width, height } = pixels;
  const full = { x: 0, y: 0, width: 1, height: 1 };
  if (!width || !height) return full;
  const background = artworkBackground(pixels);
  let left = width, top = height, right = -1, bottom = -1;
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      const index = (y * width + x) * 4;
      if (background(index)) continue;
      left = Math.min(left, x); right = Math.max(right, x);
      top = Math.min(top, y); bottom = Math.max(bottom, y);
    }
  }
  if (right < left || (right - left + 1) * (bottom - top + 1) < width * height * 0.01) return full;
  return { x: left / width, y: top / height,
    width: (right - left + 1) / width, height: (bottom - top + 1) / height };
}

// Use the broad rectangular front of a folder illustration, excluding its tab.
// Full-bleed photos/textures keep their entire bounds.
export function folderFrontBounds(pixels) {
  const bounds = coverArtworkBounds(pixels);
  const { width, height } = pixels;
  const background = artworkBackground(pixels);
  const left = Math.round(bounds.x * width), top = Math.round(bounds.y * height);
  const w = Math.max(1, Math.round(bounds.width * width));
  const h = Math.max(1, Math.round(bounds.height * height));
  const span = (row) => {
    let first = left, last = Math.min(width - 1, left + w - 1);
    while (first <= last && background((row * width + first) * 4)) first++;
    while (last >= first && background((row * width + last) * 4)) last--;
    return { first, last, width: Math.max(0, last - first + 1) };
  };
  if (w < 10 || h < 10) return bounds;
  const upper = span(Math.min(height - 1, top + Math.floor(h * 0.05)));
  const middle = span(Math.min(height - 1, top + Math.floor(h * 0.55)));
  const folder = upper.width > w * 0.18 && upper.width < w * 0.72 &&
    upper.first - left < w * 0.15 && upper.last - left < w * 0.8 && middle.width > w * 0.9;
  if (!folder) return bounds;
  let consecutive = 0;
  for (let row = top + Math.floor(h * 0.08); row < top + h * 0.42; row++) {
    consecutive = span(row).width >= w * 0.975 ? consecutive + 1 : 0;
    if (consecutive < 3) continue;
    const front = row - 2;
    return { ...bounds, y: front / height, height: (top + h - front) / height };
  }
  const front = top + Math.round(h * 0.2);
  return { ...bounds, y: front / height, height: (top + h - front) / height };
}

// Extend edge colours under the standard silhouette so an uploaded folder's own
// rounded tab cannot leave white/transparent gaps in a differently shaped tab.
// This is a render-only copy; the saved cover image is kept intact.
export function extendCoverArtworkEdges(pixels) {
  const { data, width, height } = pixels;
  const output = data.slice();
  if (!width || !height) return output;
  const background = artworkBackground(pixels);
  const rows = [];
  for (let y = 0; y < height; y++) {
    let left = 0, right = width - 1;
    while (left < width && background((y * width + left) * 4)) left++;
    while (right >= left && background((y * width + right) * 4)) right--;
    if (left > right) continue;
    rows.push(y);
    // Sample slightly inside the edge, avoiding a pale antialiased outline.
    const inset = Math.min(8, Math.floor((right - left) / 10));
    const edgeSample = (start, direction) => {
      let chosen = start, best = -1;
      for (let step = 0; step <= inset; step++) {
        const x = start + direction * step;
        const index = (y * width + x) * 4;
        if (background(index)) continue;
        const score = data[index + 3] - Math.min(data[index], data[index + 1], data[index + 2]);
        if (score > best) { chosen = x; best = score; }
      }
      return chosen;
    };
    const firstX = edgeSample(left, 1), lastX = edgeSample(right, -1);
    const first = data.slice((y * width + firstX) * 4, (y * width + firstX) * 4 + 4);
    const last = data.slice((y * width + lastX) * 4, (y * width + lastX) * 4 + 4);
    for (let x = 0; x < firstX; x++) output.set(first, (y * width + x) * 4);
    for (let x = lastX + 1; x < width; x++) output.set(last, (y * width + x) * 4);
  }
  if (!rows.length) return output;
  let nearest = 0;
  for (let y = 0; y < height; y++) {
    while (nearest + 1 < rows.length && Math.abs(rows[nearest + 1] - y) < Math.abs(rows[nearest] - y)) nearest++;
    if (rows[nearest] === y) continue;
    const start = rows[nearest] * width * 4;
    output.set(output.subarray(start, start + width * 4), y * width * 4);
  }
  return output;
}
