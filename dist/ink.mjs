import { penWidth } from './core.mjs?v=20261112-marker-shapes';

// Only the new points are painted while the pen moves. No old page objects
// are visited, and every pressure sample remains in the editable document.
export function drawPenSamples(c, stroke, from = 0) {
  c.save();
  c.strokeStyle = c.fillStyle = stroke.color;
  c.lineCap = c.lineJoin = 'round';
  c.globalAlpha = 1;
  for (let i = from; i < stroke.points.length; i++) {
    const a = stroke.points[Math.max(0, i - 1)],
      b = stroke.points[i];
    c.lineWidth = penWidth(stroke.size, (a.p + b.p) / 2);
    c.beginPath();
    if (!i) {
      c.arc(b.x, b.y, c.lineWidth / 2, 0, Math.PI * 2);
      c.fill();
    } else {
      c.moveTo(a.x, a.y);
      c.lineTo(b.x, b.y);
      c.stroke();
    }
  }
  c.restore();
  return stroke.points.length;
}
