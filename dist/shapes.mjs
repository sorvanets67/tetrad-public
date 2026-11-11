import {
  segmentDistance,
  scribbleArea,
  strokeBounds,
  DEFAULT_PRESSURE,
  averagePressure
} from './core.mjs?v=20261111-pages-ready';

export const shapeNames = {
  circle: 'Круг',
  ellipse: 'Овал',
  square: 'Квадрат',
  rectangle: 'Прямоугольник',
  trapezoid: 'Трапеция',
  'right-trapezoid': 'Прямоугольная трапеция',
  parallelogram: 'Параллелограмм',
  diamond: 'Ромб'
};

export function createShapePoints(
  kind,
  start,
  end,
  pressure = DEFAULT_PRESSURE
) {
  if (!Object.hasOwn(shapeNames, kind)) throw Error('Неизвестная фигура');
  let w = Math.abs(end.x - start.x),
    h = Math.abs(end.y - start.y);
  if (kind === 'circle' || kind === 'square') w = h = Math.min(w, h);
  const x = end.x < start.x ? start.x - w : start.x;
  const y = end.y < start.y ? start.y - h : start.y;
  let vertices;
  if (kind === 'circle' || kind === 'ellipse') {
    vertices = Array.from({ length: 96 }, (_, i) => {
      const angle = (i * Math.PI * 2) / 96;
      return { x: 0.5 + Math.cos(angle) / 2, y: 0.5 + Math.sin(angle) / 2 };
    });
  } else {
    const corners =
      kind === 'trapezoid'
        ? [
            [0.25, 0],
            [0.75, 0],
            [1, 1],
            [0, 1]
          ]
        : kind === 'right-trapezoid'
          ? [
              [0, 0],
              [0.7, 0],
              [1, 1],
              [0, 1]
            ]
          : kind === 'parallelogram'
            ? [
                [0.25, 0],
                [1, 0],
                [0.75, 1],
                [0, 1]
              ]
            : kind === 'diamond'
              ? [
                  [0.5, 0],
                  [1, 0.5],
                  [0.5, 1],
                  [0, 0.5]
                ]
              : [
                  [0, 0],
                  [1, 0],
                  [1, 1],
                  [0, 1]
                ];
    vertices = corners.map(([x, y]) => ({ x, y }));
  }
  const points = vertices.map((p) => ({
    x: x + p.x * w,
    y: y + p.y * h,
    p: pressure
  }));
  points.push({ ...points[0] });
  return points;
}

export function resizeElement(el, from, to) {
  const resized = structuredClone(el);
  const sx = to.w / (from.w || 1),
    sy = to.h / (from.h || 1);
  const position = (p) => ({
    x: to.x + (p.x - from.x) * sx,
    y: to.y + (p.y - from.y) * sy
  });
  if (resized.type === 'stroke') {
    resized.points = resized.points.map((p) => ({ ...p, ...position(p) }));
  } else if (resized.type === 'image') {
    Object.assign(resized, position(resized), {
      w: resized.w * sx,
      h: resized.h * sy
    });
  } else throw Error('Этот объект нельзя растянуть');
  return resized;
}

export function transformStroke(el, center, angle = 0, mirror = null) {
  if (el.type !== 'stroke') throw Error('Выдели фигуру или штрихи');
  const result = structuredClone(el);
  const cos = Math.cos(angle),
    sin = Math.sin(angle);
  result.points = el.points.map((p) => {
    const x = (p.x - center.x) * (mirror === 'horizontal' ? -1 : 1);
    const y = (p.y - center.y) * (mirror === 'vertical' ? -1 : 1);
    return {
      ...p,
      x: center.x + x * cos - y * sin,
      y: center.y + x * sin + y * cos
    };
  });
  return result;
}

function simplify(points, tolerance) {
  const keep = new Set([0, points.length - 1]);
  const pending = [[0, points.length - 1]];
  while (pending.length) {
    const [start, end] = pending.pop();
    let furthest = -1,
      distance = tolerance;
    for (let i = start + 1; i < end; i++) {
      const d = segmentDistance(points[i], points[start], points[end]);
      if (d > distance) {
        distance = d;
        furthest = i;
      }
    }
    if (furthest !== -1) {
      keep.add(furthest);
      pending.push([start, furthest], [furthest, end]);
    }
  }
  return [...keep].sort((a, b) => a - b).map((i) => points[i]);
}

// Equal arc-length samples keep recognition independent of tablet event density.
function resample(points, count = 96) {
  const distances = [0];
  for (let i = 1; i < points.length; i++) {
    distances.push(
      distances.at(-1) +
        Math.hypot(points[i].x - points[i - 1].x, points[i].y - points[i - 1].y)
    );
  }
  if (!distances.at(-1)) return [];
  let index = 1;
  return Array.from({ length: count }, (_, i) => {
    const distance = (distances.at(-1) * i) / (count - 1);
    while (index < points.length - 1 && distances[index] < distance) index++;
    const t =
      (distance - distances[index - 1]) /
      (distances[index] - distances[index - 1] || 1);
    const a = points[index - 1],
      b = points[index];
    return { x: a.x + (b.x - a.x) * t, y: a.y + (b.y - a.y) * t };
  });
}

function closedCorners(points, tolerance) {
  const corners = simplify([...points, points[0]], tolerance).slice(0, -1);
  // The start of a closed stroke may be in the middle of an edge.
  let changed = true;
  while (changed && corners.length > 3) {
    changed = false;
    for (let i = 0; i < corners.length; i++) {
      if (
        segmentDistance(
          corners[i],
          corners[(i + corners.length - 1) % corners.length],
          corners[(i + 1) % corners.length]
        ) < tolerance
      ) {
        corners.splice(i, 1);
        changed = true;
        break;
      }
    }
  }
  return corners;
}

function contourFits(
  vertices,
  points,
  diagonal,
  meanLimit = 0.032,
  maxLimit = 0.09
) {
  let total = 0,
    maximum = 0;
  for (const p of points) {
    let distance = Infinity;
    for (let i = 0; i < vertices.length; i++) {
      distance = Math.min(
        distance,
        segmentDistance(p, vertices[i], vertices[(i + 1) % vertices.length])
      );
    }
    total += distance;
    maximum = Math.max(maximum, distance);
  }
  return (
    total / points.length <= diagonal * meanLimit &&
    maximum <= diagonal * maxLimit
  );
}

function trimClosureTails(points) {
  const box = strokeBounds({ points, size: 0, tool: 'pen' });
  const diagonal = Math.hypot(box.w, box.h);
  const limit = Math.floor(points.length * 0.2);
  let best = null,
    score = Infinity;
  for (let start = 0; start <= limit; start++) {
    for (let end = points.length - 1; end >= points.length - 1 - limit; end--) {
      if (end - start < points.length * 0.72) continue;
      const gap = Math.hypot(
        points[start].x - points[end].x,
        points[start].y - points[end].y
      );
      if (gap > diagonal * 0.055) continue;
      const candidateScore =
        gap / diagonal +
        ((start + points.length - 1 - end) / points.length) * 0.25;
      if (candidateScore < score) {
        best = [start, end];
        score = candidateScore;
      }
    }
  }
  return best ? points.slice(best[0], best[1] + 1) : points;
}

function rectangle(corners, points) {
  if (corners.length !== 4) return null;
  const edges = corners.map((p, i) => {
    const next = corners[(i + 1) % 4];
    const length = Math.hypot(next.x - p.x, next.y - p.y);
    return { x: (next.x - p.x) / length, y: (next.y - p.y) / length };
  });
  if (
    edges.some((a, i) => {
      const b = edges[(i + 1) % 4];
      return !Number.isFinite(a.x) || Math.abs(a.x * b.x + a.y * b.y) > 0.65;
    })
  )
    return null;
  // Fit the sides to the whole contour, rather than trusting a single
  // rounded or shaky corner to determine the rectangle's orientation.
  let angle = 0,
    bestScore = Infinity;
  for (let step = 0; step < 90; step++) {
    const candidate = (step * Math.PI) / 180;
    const cos = Math.cos(candidate),
      sin = Math.sin(candidate);
    const local = points.map((p) => ({
      x: p.x * cos + p.y * sin,
      y: -p.x * sin + p.y * cos
    }));
    const left = Math.min(...local.map((p) => p.x)),
      right = Math.max(...local.map((p) => p.x));
    const top = Math.min(...local.map((p) => p.y)),
      bottom = Math.max(...local.map((p) => p.y));
    const score = local.reduce(
      (sum, p) =>
        sum + Math.min(p.x - left, right - p.x, p.y - top, bottom - p.y) ** 2,
      0
    );
    if (score < bestScore) {
      bestScore = score;
      angle = candidate;
    }
  }
  const rightAngle = (Math.round(angle / (Math.PI / 2)) * Math.PI) / 2;
  if (Math.abs(angle - rightAngle) < Math.PI / 24) angle = rightAngle;
  const cos = Math.cos(angle),
    sin = Math.sin(angle);
  const local = points.map((p) => ({
    x: p.x * cos + p.y * sin,
    y: -p.x * sin + p.y * cos
  }));
  let left = Math.min(...local.map((p) => p.x)),
    right = Math.max(...local.map((p) => p.x));
  let top = Math.min(...local.map((p) => p.y)),
    bottom = Math.max(...local.map((p) => p.y));
  if (Math.abs((right - left) / (bottom - top) - 1) < 0.12) {
    const size = (right - left + (bottom - top)) / 2;
    const x = (left + right) / 2,
      y = (top + bottom) / 2;
    left = x - size / 2;
    right = x + size / 2;
    top = y - size / 2;
    bottom = y + size / 2;
  }
  return [
    { x: left, y: top },
    { x: right, y: top },
    { x: right, y: bottom },
    { x: left, y: bottom }
  ].map((p) => ({ x: p.x * cos - p.y * sin, y: p.x * sin + p.y * cos }));
}

export function recognizeShape(rawPoints, minimum = 12) {
  if (rawPoints.length < 2 || scribbleArea(rawPoints, (minimum * 2) / 3))
    return null;
  let points = resample(rawPoints);
  if (!points.length) return null;
  const pressure = averagePressure(rawPoints);
  const result = (kind, vertices) => ({
    kind,
    points: vertices.map((p) => ({
      ...p,
      p: Math.max(0.05, Math.min(1, pressure))
    }))
  });
  const a = points[0],
    b = points.at(-1);
  const chord = Math.hypot(b.x - a.x, b.y - a.y);
  let length = 0;
  for (let i = 1; i < points.length; i++)
    length += Math.hypot(
      points[i].x - points[i - 1].x,
      points[i].y - points[i - 1].y
    );
  if (
    chord >= minimum * 2 &&
    length <= chord * 1.15 &&
    points.every(
      (p) => segmentDistance(p, a, b) <= Math.max(minimum / 2, chord * 0.035)
    )
  ) {
    return result('line', [a, b]);
  }
  points = trimClosureTails(points);
  const box = strokeBounds({ points, size: 0, tool: 'pen' });
  const diagonal = Math.hypot(box.w, box.h);
  const gap = Math.hypot(
    points[0].x - points.at(-1).x,
    points[0].y - points.at(-1).y
  );
  if (
    Math.min(box.w, box.h) < minimum * 1.5 ||
    gap > Math.max(minimum, diagonal * 0.25)
  )
    return null;
  const closed = resample([...points, points[0]]).slice(0, -1);
  for (const tolerance of [0.035, 0.05, 0.065, 0.08, 0.1]) {
    const corners = closedCorners(closed, diagonal * tolerance);
    if (corners.length === 3) {
      const area =
        Math.abs(
          corners.reduce((sum, p, i) => {
            const q = corners[(i + 1) % 3];
            return sum + p.x * q.y - q.x * p.y;
          }, 0)
        ) / 2;
      if (area > box.w * box.h * 0.2 && contourFits(corners, closed, diagonal))
        return result('triangle', [...corners, corners[0]]);
    }
    const rect = rectangle(corners, closed);
    if (
      rect &&
      contourFits(corners, closed, diagonal, 0.045, 0.13) &&
      contourFits(rect, closed, diagonal, 0.07, 0.19)
    )
      return result('rectangle', [...rect, rect[0]]);
  }
  const center = closed.reduce(
    (sum, p) => ({
      x: sum.x + p.x / closed.length,
      y: sum.y + p.y / closed.length
    }),
    { x: 0, y: 0 }
  );
  let xx = 0,
    yy = 0,
    xy = 0;
  for (const p of closed) {
    const x = p.x - center.x,
      y = p.y - center.y;
    xx += x * x;
    yy += y * y;
    xy += x * y;
  }
  const angle = Math.atan2(2 * xy, xx - yy) / 2;
  const cos = Math.cos(angle),
    sin = Math.sin(angle);
  const local = closed.map((p) => ({
    x: (p.x - center.x) * cos + (p.y - center.y) * sin,
    y: -(p.x - center.x) * sin + (p.y - center.y) * cos
  }));
  const left = Math.min(...local.map((p) => p.x)),
    right = Math.max(...local.map((p) => p.x));
  const top = Math.min(...local.map((p) => p.y)),
    bottom = Math.max(...local.map((p) => p.y));
  let rx = (right - left) / 2,
    ry = (bottom - top) / 2;
  const cx = (right + left) / 2,
    cy = (bottom + top) / 2;
  const errors = local.map((p) =>
    Math.abs(Math.hypot((p.x - cx) / rx, (p.y - cy) / ry) - 1)
  );
  if (
    errors.some((e) => !Number.isFinite(e) || e > 0.32) ||
    errors.reduce((a, b) => a + b, 0) / errors.length > 0.12
  )
    return null;
  let turning = 0;
  for (let i = 1; i <= local.length; i++) {
    const p = local[i - 1],
      q = local[i % local.length];
    const d = Math.atan2(q.y - cy, q.x - cx) - Math.atan2(p.y - cy, p.x - cx);
    turning += Math.atan2(Math.sin(d), Math.cos(d));
  }
  if (Math.abs(Math.abs(turning) - Math.PI * 2) > 0.3) return null;
  const circle = Math.abs(rx / ry - 1) < 0.18;
  if (circle) rx = ry = (rx + ry) / 2;
  const ellipse = Array.from({ length: 97 }, (_, i) => {
    const t = (i * Math.PI * 2) / 96;
    const x = cx + rx * Math.cos(t),
      y = cy + ry * Math.sin(t);
    return { x: center.x + x * cos - y * sin, y: center.y + x * sin + y * cos };
  });
  ellipse[96] = { ...ellipse[0] };
  return result(circle ? 'circle' : 'ellipse', ellipse);
}
