import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';
import * as core from '../dist/core.mjs';
import {
  DocumentPatches,
  applyDocumentPatch,
  snapshotDocument
} from '../dist/persistence.mjs';
import { drawPenSamples } from '../dist/ink.mjs';
import { migrateLibrary, folderPath, coverArtworkBounds, folderFrontBounds, extendCoverArtworkEdges } from '../dist/library.mjs';
import {
  recognizeShape,
  shapeNames,
  createShapePoints,
  resizeElement,
  transformStroke
} from '../dist/shapes.mjs';
import { screenContours } from './fixtures/shape-contours.mjs';
import {
  initialState,
  validateState,
  segmentDistance,
  strokeHit,
  strokeBounds,
  translateElement,
  uid
} from '../dist/core.mjs';

test('fresh workspace and exported document survive JSON round trip', () => {
  const s = initialState();
  s.books[0].pages[0].elements = [
    {
      id: uid(),
      type: 'stroke',
      tool: 'pen',
      color: '#284f42',
      size: 3,
      points: [
        { x: 1, y: 2, p: 0.2 },
        { x: 50, y: 60, p: 0.9 }
      ]
    },
    {
      id: uid(),
      type: 'image',
      src: 'data:image/png;base64,aGVsbG8=',
      x: 20,
      y: 30,
      w: 400,
      h: 300
    },
    {
      id: uid(),
      type: 'text',
      text: 'Конспект\nНовая строка',
      size: 24,
      color: '#284f42',
      x: 20,
      y: 50
    }
  ];
  assert.deepEqual(validateState(JSON.parse(JSON.stringify(s))), s);
});

test('eraser hits middle of long segments, including stationary dots', () => {
  assert.equal(
    segmentDistance({ x: 50, y: 3 }, { x: 0, y: 0 }, { x: 100, y: 0 }),
    3
  );
  const e = {
    type: 'stroke',
    size: 3,
    points: [
      { x: 0, y: 0 },
      { x: 100, y: 0 }
    ]
  };
  assert.equal(strokeHit(e, { x: 50, y: 5 }), true);
  assert.equal(strokeHit(e, { x: 50, y: 30 }), false);
  assert.equal(
    strokeHit(
      { type: 'stroke', size: 3, points: [{ x: 5, y: 5 }] },
      { x: 6, y: 6 }
    ),
    true
  );
  assert.equal(strokeHit({ type: 'image' }, { x: 0, y: 0 }), false);
});

test('invalid backups are rejected without accepting unknown objects or URLs', () => {
  let s = initialState();
  s.books[0].pages[0].elements.push({
    id: uid(),
    type: 'image',
    src: 'https://example.com/x.png',
    x: 0,
    y: 0,
    w: 20,
    h: 20
  });
  assert.throws(() => validateState(s));
  s = initialState();
  s.books.push(structuredClone(s.books[0]));
  assert.throws(() => validateState(s));
  s = initialState();
  s.books[0].pages[0].elements.push({
    id: uid(),
    type: 'stroke',
    tool: 'pen',
    color: '#000',
    size: 2,
    points: [{ x: NaN, y: 0, p: 1 }]
  });
  assert.throws(() => validateState(s));
});

test('missing active page is repaired using a valid saved page', () => {
  const s = initialState();
  s.activePage = 'missing';
  validateState(s);
  assert.equal(s.activePage, s.books[0].pages[0].id);
});

test('stroke bounds include marker width and movement preserves pressure and originals', () => {
  const stroke = {
    type: 'stroke',
    tool: 'marker',
    size: 4,
    points: [
      { x: 10, y: 20, p: 0.2 },
      { x: 50, y: 60, p: 0.9 }
    ]
  };
  assert.deepEqual(strokeBounds(stroke), { x: 0, y: 10, w: 60, h: 60 });
  const moved = translateElement(stroke, 15, -10);
  assert.deepEqual(moved.points, [
    { x: 25, y: 10, p: 0.2 },
    { x: 65, y: 50, p: 0.9 }
  ]);
  moved.points[0].p = 1;
  assert.equal(stroke.points[0].p, 0.2);
  const image = {
    type: 'image',
    x: 30,
    y: 40,
    w: 100,
    h: 200,
    src: 'data:image/png;base64,aGVsbG8='
  };
  assert.deepEqual(translateElement(image, 10, 20), { ...image, x: 40, y: 60 });
});

test('lasso requires enclosure and rejects lines, partial photos and segments crossing a concavity', () => {
  const polygon = [
    { x: 0, y: 0 },
    { x: 100, y: 0 },
    { x: 100, y: 100 },
    { x: 0, y: 100 }
  ];
  const stroke = {
    type: 'stroke',
    points: [
      { x: 0, y: 20 },
      { x: 80, y: 80 }
    ]
  };
  assert.equal(core.insideLasso(stroke, polygon), true);
  assert.equal(
    core.insideLasso(
      {
        ...stroke,
        points: [
          { x: 20, y: 20 },
          { x: 120, y: 80 }
        ]
      },
      polygon
    ),
    false
  );
  assert.equal(
    core.insideLasso(stroke, [
      { x: 0, y: 20 },
      { x: 40, y: 20 },
      { x: 80, y: 20 }
    ]),
    false
  );
  assert.equal(
    core.insideLasso({ type: 'image' }, polygon, {
      x: 10,
      y: 10,
      w: 100,
      h: 50
    }),
    false
  );
  assert.equal(
    core.insideLasso({ type: 'image' }, polygon, {
      x: 10,
      y: 10,
      w: 50,
      h: 50
    }),
    true
  );
  const concave = [
    { x: 0, y: 0 },
    { x: 100, y: 0 },
    { x: 100, y: 100 },
    { x: 60, y: 100 },
    { x: 60, y: 30 },
    { x: 40, y: 30 },
    { x: 40, y: 100 },
    { x: 0, y: 100 }
  ];
  assert.equal(
    core.insideLasso(
      {
        type: 'stroke',
        points: [
          { x: 20, y: 80 },
          { x: 80, y: 80 }
        ]
      },
      concave
    ),
    false
  );
});

const scribbleFlat = [
  { x: 20, y: 20 },
  { x: 140, y: 35 },
  { x: 20, y: 50 },
  { x: 140, y: 65 },
  { x: 20, y: 80 },
  { x: 140, y: 100 }
];
const scribbleFan = [
  [130, 20],
  [20, 80],
  [140, 30],
  [22, 80],
  [150, 50],
  [25, 85],
  [145, 65],
  [60, 85],
  [150, 80],
  [130, 100]
].map(([x, y]) => ({ x, y }));
const scribbleWave = [
  [20, 20],
  [23, 50],
  [30, 75],
  [40, 95],
  [45, 25],
  [48, 55],
  [60, 78],
  [65, 90],
  [70, 30],
  [73, 55],
  [85, 80],
  [90, 93],
  [95, 35],
  [98, 55],
  [110, 80],
  [115, 95],
  [120, 45],
  [125, 100],
  [130, 75],
  [135, 100]
].map(([x, y]) => ({ x, y }));

test('scribble recognises all three reference shapes, reversed, rotated and scaled', () => {
  for (const points of [scribbleFlat, scribbleFan, scribbleWave]) {
    assert.ok(core.scribbleArea(points));
    assert.ok(core.scribbleArea([...points].reverse()));
    assert.ok(core.scribbleArea(points.map((p) => ({ x: p.y, y: -p.x }))));
    assert.ok(
      core.scribbleArea(
        points.map((p) => ({
          x: (p.x - p.y) * Math.SQRT1_2,
          y: (p.x + p.y) * Math.SQRT1_2
        }))
      )
    );
    assert.ok(
      core.scribbleArea(
        points.map((p) => ({ x: p.x * 4, y: p.y * 4 })),
        32
      )
    );
  }
  const dense = [];
  for (let i = 1; i < scribbleFlat.length; i++) {
    const a = scribbleFlat[i - 1],
      b = scribbleFlat[i];
    for (let j = 0; j < 40; j++)
      dense.push({
        x: a.x + ((b.x - a.x) * j) / 40,
        y: a.y + ((b.y - a.y) * j) / 40
      });
  }
  dense.push(scribbleFlat.at(-1));
  assert.deepEqual(core.scribbleArea(dense), core.scribbleArea(scribbleFlat));
});

test('scribble rejects simple lines, crosses, tiny jitter, short zigzags and a single loop', () => {
  const straight = Array.from({ length: 200 }, (_, i) => ({ x: i, y: i % 2 }));
  assert.equal(core.scribbleArea(straight), null);
  assert.equal(core.scribbleArea(scribbleFlat.slice(0, 4)), null);
  assert.equal(
    core.scribbleArea(scribbleFlat.map((p) => ({ x: p.x / 20, y: p.y / 20 }))),
    null
  );
  assert.equal(
    core.scribbleArea([
      { x: 20, y: 20 },
      { x: 140, y: 100 }
    ]),
    null
  );
  const circle = Array.from({ length: 81 }, (_, i) => ({
    x: 80 + Math.cos((i * Math.PI) / 40) * 60,
    y: 60 + Math.sin((i * Math.PI) / 40) * 40
  }));
  assert.equal(core.scribbleArea(circle), null);
});

test('scribble area hits handwritten letters, marker, photos and text while leaving surrounding ink', () => {
  const area = core.scribbleArea(scribbleFlat);
  for (const x of [40, 65, 90, 115]) {
    assert.equal(
      core.scribbleHits(
        {
          type: 'stroke',
          size: 3,
          tool: 'pen',
          points: [
            { x, y: 45 },
            { x, y: 75 }
          ]
        },
        area
      ),
      true
    );
  }
  assert.equal(
    core.scribbleHits(
      {
        type: 'stroke',
        tool: 'marker',
        size: 3,
        points: [
          { x: 0, y: 60 },
          { x: 200, y: 60 }
        ]
      },
      area
    ),
    true
  );
  assert.equal(
    core.scribbleHits(
      {
        type: 'stroke',
        tool: 'pen',
        size: 3,
        points: [
          { x: 0, y: 0 },
          { x: 180, y: 0 },
          { x: 180, y: 120 },
          { x: 0, y: 120 },
          { x: 0, y: 0 }
        ]
      },
      area
    ),
    false
  );
  assert.equal(
    core.scribbleHits({ type: 'image' }, area, { x: 60, y: 40, w: 40, h: 40 }),
    true
  );
  assert.equal(
    core.scribbleHits({ type: 'text' }, area, { x: 60, y: 40, w: 40, h: 40 }),
    true
  );
  assert.equal(
    core.scribbleHits({ type: 'text' }, area, { x: 300, y: 300, w: 40, h: 40 }),
    false
  );
});

// Exercise the application handlers with an isolated document, without IndexedDB.
// This checks editing and undo; physical pen input still needs a real tablet.
function editingWorkspace() {
  const nodes = new Map();
  const rendering = { mainStrokes: 0, inkStrokes: 0, clears: 0 };
  const windowListeners = {};
  const timers = new Map();
  let clock = 0,
    timerId = 0;
  function advanceTimers(duration) {
    const end = clock + duration;
    while (true) {
      const next = [...timers]
        .filter(([, timer]) => timer.time <= end)
        .sort((a, b) => a[1].time - b[1].time)[0];
      if (!next) break;
      timers.delete(next[0]);
      clock = next[1].time;
      next[1].callback();
    }
    clock = end;
  }
  function node(id) {
    if (!nodes.has(id))
      nodes.set(id, {
        listeners: {},
        children: [],
        get childNodes() { return this.children; },
        style: { setProperty() {} },
        dataset: {},
        classList: { toggle() {}, remove() {}, add() {} },
        tagName: 'BUTTON',
        hidden: true,
        setAttribute(name, value) {
          this[name] = value;
        },
        addEventListener(name, handler) {
          this.listeners[name] = handler;
        },
        getContext() {
          return (this.context ||= {
            measureText: () => ({ width: 100 }),
            drawImage() {},
            save() {},
            restore() {},
            beginPath() {},
            moveTo() {},
            lineTo() {},
            arc() {},
            fill() {},
            stroke() {
              if (id === 'canvas') rendering.mainStrokes++;
              if (id === 'inkCanvas') rendering.inkStrokes++;
            },
            clearRect() {
              rendering.clears++;
            },
            fillRect() {},
            strokeRect() {},
            setLineDash() {},
            translate() {},
            rotate() {},
            fillText() {}
          });
        },
        getBoundingClientRect() {
          return { left: 0, top: 0, width: 1100, height: 1550 };
        },
        toDataURL() {
          return 'data:image/png;base64,aGVsbG8=';
        },
        setPointerCapture() {},
        append(...children) { this.children.push(...children); },
        querySelector() {
          return null;
        },
        offsetWidth: 220,
        offsetHeight: 280,
        replaceChildren(...children) { this.children = children; },
        showModal() {
          this.open = true;
        }
      });
    return nodes.get(id);
  }
  const context = vm.createContext({
    ...core,
    recognizeShape,
    shapeNames,
    createShapePoints,
    resizeElement,
    transformStroke,
    DocumentPatches,
    snapshotDocument,
    drawPenSamples,
    migrateLibrary,
    folderPath,
    coverArtworkBounds,
    folderFrontBounds,
    extendCoverArtworkEdges,
    URL,
    Path2D: class {
      moveTo() {}
      lineTo() {}
    },
    structuredClone,
    console,
    setTimeout(callback, delay) {
      timers.set(++timerId, { callback, time: clock + delay });
      return timerId;
    },
    requestAnimationFrame(callback) {
      timers.set(++timerId, { callback, time: clock + 16 });
      return timerId;
    },
    cancelAnimationFrame(id) {
      timers.delete(id);
    },
    clearTimeout(id) {
      timers.delete(id);
    },
    document: {
      addEventListener() {},
      getElementById: node,
      querySelectorAll: () => [],
      createElement: () => node(Symbol()),
      activeElement: { tagName: 'BODY' }
    },
    window: {
      innerWidth: 1200,
      innerHeight: 800,
      addEventListener(name, handler) {
        windowListeners[name] = handler;
      }
    }
  });
  const source = readFileSync(
    new URL('../dist/app.js', import.meta.url),
    'utf8'
  )
    .replace(/^import\s*\{[\s\S]*?\}\s*from '\.\/core\.mjs(?:\?[^']*)?';/, '')
    .replace(/import \{[^}]*\} from '\.\/shapes\.mjs(?:\?[^']*)?';/, '')
    .replace(
      /import \{[^}]*\} from '\.\/(persistence|ink|page-stack|library)\.mjs(?:\?[^']*)?';/g,
      ''
    )
    .replace(
      /import\.meta\.url/g,
      JSON.stringify(new URL('../dist/app.js', import.meta.url).href)
    )
    .replace(/init\(\);\s*$/, '');
  vm.runInContext(source, context);
  vm.runInContext(
    `state = initialState();
    globalThis.realDraw = draw; globalThis.realSave = save; globalThis.realRenderNav = renderNav;
    draw = () => {}; save = () => {}; renderNav = () => {};`,
    context
  );
  return {
    node,
    windowListeners,
    advanceTimers,
    rendering,
    run: (code) => vm.runInContext(code, context)
  };
}

test('context menu and keyboard retain actions without a persistent selection bar', () => {
  const { node, run, windowListeners } = editingWorkspace();
  run(`current().elements.push({ id: uid(), type: 'text', x: 10, y: 10,
    size: 24, color: '#000', text: 'Текст' });
    selection = [current().elements[0].id];`);
  node('canvas').listeners.contextmenu({
    clientX: 1150,
    clientY: 750,
    preventDefault() {}
  });
  assert.equal(node('selectionMenu').hidden, false);
  assert.equal(node('selectionMenu').style.left, '972px');
  assert.equal(node('editObject').disabled, false);
  node('duplicateObject').onclick();
  assert.equal(run('current().elements.length'), 2);
  const key = (key) =>
    windowListeners.keydown({ key, ctrlKey: true, preventDefault() {} });
  const copied = clipboardEvent();
  windowListeners.copy(copied);
  windowListeners.paste(copied);
  assert.equal(run('current().elements.length'), 3);
  windowListeners.keydown({ key: 'Delete', preventDefault() {} });
  assert.equal(run('current().elements.length'), 2);
  key('z');
  assert.equal(run('current().elements.length'), 3);
  windowListeners.keydown({ key: 'Escape', preventDefault() {} });
  assert.equal(node('selectionMenu').hidden, true);
  assert.equal(run('selection.length'), 0);
});

test('lasso selects strokes without history, moves them, copies photos, deletes and restores objects', () => {
  const { node, run } = editingWorkspace();
  run(`current().elements.push({ id: uid(), type: 'stroke', tool: 'pen', size: 3,
    color: '#000', points: [{ x: 50, y: 50, p: 0.4 }, { x: 100, y: 50, p: 0.8 }] });
    setTool('select');`);
  const down = node('canvas').listeners.pointerdown;
  const move = node('canvas').listeners.pointermove;
  const up = node('canvas').listeners.pointerup;
  const event = {
    button: 0,
    pointerId: 1,
    clientX: 75,
    clientY: 50,
    preventDefault() {}
  };
  down(event);
  up(event);
  assert.equal(run('undoStack.length'), 0);
  assert.equal(run('selection.length'), 0);
  const outline = [
    [30, 30],
    [120, 30],
    [120, 80],
    [30, 80],
    [30, 30]
  ];
  down({ ...event, clientX: 30, clientY: 30 });
  for (const [clientX, clientY] of outline.slice(1))
    move({ ...event, clientX, clientY });
  up({ ...event, clientX: 30, clientY: 30 });
  assert.equal(run('selection[0] === current().elements[0].id'), true);
  assert.equal(run('undoStack.length'), 0);
  down(event);
  move({ ...event, clientX: 95, clientY: 70 });
  up(event);
  assert.equal(run('current().elements[0].points[0].x'), 70);
  run('undo()');
  assert.equal(run('current().elements[0].points[0].x'), 50);
  run(`current().elements.push({ id: uid(), type: 'image', x: 20, y: 30, w: 100, h: 100,
    src: 'data:image/png;base64,aGVsbG8=' });
    selection = [current().elements[1].id]; copySelection(); pasteObject();`);
  assert.equal(run('current().elements.length'), 3);
  assert.equal(
    run('current().elements[1].id !== current().elements[2].id'),
    true
  );
  assert.equal(
    run('current().elements[1].src === current().elements[2].src'),
    true
  );
  run('deleteSelection()');
  assert.equal(run('current().elements.length'), 2);
  run('undo()');
  assert.equal(run('current().elements.length'), 3);
  run('validateState(JSON.parse(JSON.stringify(state)))');
});

test('copy can be pasted onto another page and layer changes can be undone', () => {
  const { run } = editingWorkspace();
  run(`current().elements.push({ id: uid(), type: 'text', x: 20, y: 20,
    size: 24, color: '#000', text: 'Исходный текст' });
    selection = [current().elements[0].id];
    copySelection();
    const next = newPage();
    state.books[0].pages.push(next);
    switchPage(next.id);
    pasteObject(); pasteObject();`);
  assert.equal(run('current().elements.length'), 2);
  assert.equal(
    run(
      'new Set(state.books[0].pages.flatMap(p => p.elements.map(e => e.id))).size'
    ),
    3
  );
  run(`current().elements[1].text = 'Изменённая копия';
    selection = [current().elements[0].id];
    reorderSelection(true);`);
  assert.equal(run('current().elements[1].text'), 'Исходный текст');
  run('undo()');
  assert.equal(run('current().elements[1].text'), 'Изменённая копия');
  assert.equal(
    run('state.books[0].pages[0].elements[0].text'),
    'Исходный текст'
  );
  run('validateState(JSON.parse(JSON.stringify(state)))');
});

test('freehand selection moves and duplicates a group with one undo and cancels without data changes', () => {
  const { node, run } = editingWorkspace();
  run(`current().elements = [
    { id: uid(), type: 'stroke', tool: 'pen', size: 3, color: '#000', points: [{ x: 50, y: 50, p: 0.5 }] },
    { id: uid(), type: 'image', x: 80, y: 80, w: 40, h: 40, src: 'data:image/png;base64,aGVsbG8=' },
    { id: uid(), type: 'text', x: 300, y: 300, size: 24, color: '#000', text: 'Снаружи' }
  ]; setTool('select');`);
  const event = { button: 0, pointerId: 1, preventDefault() {} };
  function trace(points, ending = 'pointerup') {
    const [first, ...rest] = points;
    node('canvas').listeners.pointerdown({
      ...event,
      clientX: first[0],
      clientY: first[1]
    });
    for (const [x, y] of rest)
      node('canvas').listeners.pointermove({
        ...event,
        clientX: x,
        clientY: y
      });
    node('canvas').listeners[ending]({ ...event, type: ending });
  }
  const outline = [
    [20, 20],
    [160, 20],
    [160, 160],
    [20, 160],
    [20, 20]
  ];
  trace(outline, 'pointercancel');
  assert.equal(run('selection.length'), 0);
  assert.equal(run('undoStack.length'), 0);
  trace(outline);
  assert.equal(run('selection.length'), 2);
  trace([
    [80, 70],
    [100, 100]
  ]);
  assert.equal(run('current().elements[0].points[0].x'), 70);
  assert.equal(run('current().elements[1].x'), 100);
  assert.equal(run('current().elements[2].x'), 300);
  assert.equal(run('undoStack.length'), 1);
  run('undo()');
  assert.equal(run('current().elements[0].points[0].x'), 50);
  assert.equal(run('current().elements[1].x'), 80);
  trace(outline);
  run('copySelection(); pasteObject();');
  assert.equal(run('current().elements.length'), 5);
  assert.equal(run('selection.length'), 2);
  assert.equal(
    run('current().elements[4].x - current().elements[3].points[0].x'),
    30
  );
  run('deleteSelection()');
  assert.equal(run('current().elements.length'), 3);
  run('undo()');
  assert.equal(run('current().elements.length'), 5);
  run('validateState(JSON.parse(JSON.stringify(state)))');
});

test('clear requires confirmation, affects only the current page and supports undo and redo', () => {
  const { node, run } = editingWorkspace();
  run(`current().elements.push({ id: uid(), type: 'text', x: 10, y: 20, size: 24,
    color: '#000', text: 'Заметка' });
    const other = newPage('Другая');
    other.elements = structuredClone(current().elements);
    other.elements[0].id = uid();
    state.books[0].pages.push(other);`);
  node('clearPage').onclick();
  assert.equal(run('current().elements.length'), 1);
  node('dialog').returnValue = 'cancel';
  node('dialog').onclose();
  node('dialog').open = false;
  assert.equal(run('current().elements.length'), 1);
  node('clearPage').onclick();
  node('dialog').returnValue = 'ok';
  node('dialog').onclose();
  assert.equal(run('current().elements.length'), 0);
  assert.equal(run('state.books[0].pages[1].elements.length'), 1);
  run('undo()');
  assert.equal(run('current().elements[0].text'), 'Заметка');
  run('redo()');
  assert.equal(run('current().elements.length'), 0);
  run('validateState(JSON.parse(JSON.stringify(state)))');
});

function drawLine(node, points, ending = 'pointerup') {
  const event = { button: 0, pointerId: 1, preventDefault() {} };
  const first = points[0],
    last = points.at(-1);
  node('canvas').listeners.pointerdown({
    ...event,
    clientX: first.x,
    clientY: first.y
  });
  for (const p of points.slice(1))
    node('canvas').listeners.pointermove({
      ...event,
      clientX: p.x,
      clientY: p.y
    });
  node('canvas').listeners[ending]({
    ...event,
    type: ending,
    clientX: last.x,
    clientY: last.y
  });
}

function scribbleWorkspace() {
  const workspace = editingWorkspace();
  workspace.run(`current().elements = [
    { id: uid(), type: 'stroke', tool: 'pen', size: 3, color: '#000', points: [{ x: 40, y: 45, p: 0.4 }, { x: 40, y: 75, p: 0.8 }] },
    { id: uid(), type: 'stroke', tool: 'pen', size: 3, color: '#000', points: [{ x: 65, y: 45, p: 0.4 }, { x: 65, y: 75, p: 0.8 }] },
    { id: uid(), type: 'stroke', tool: 'marker', size: 3, color: '#000', points: [{ x: 90, y: 45, p: 0.4 }, { x: 90, y: 75, p: 0.8 }] },
    { id: uid(), type: 'image', x: 60, y: 40, w: 40, h: 40, src: 'data:image/png;base64,aGVsbG8=' },
    { id: uid(), type: 'text', x: 60, y: 40, size: 24, color: '#000', text: 'Удалить' },
    { id: uid(), type: 'text', x: 300, y: 300, size: 24, color: '#000', text: 'Оставить' }
  ];`);
  return workspace;
}

test('each reference scribble removes handwritten letters and objects with a single undo and redo', () => {
  for (const points of [scribbleFlat, scribbleFan, scribbleWave]) {
    const { node, run } = scribbleWorkspace();
    drawLine(node, points);
    assert.equal(run('current().elements.length'), 1);
    assert.equal(run('current().elements[0].text'), 'Оставить');
    assert.equal(run('undoStack.length'), 1);
    run('undo()');
    assert.equal(run('current().elements.length'), 6);
    assert.equal(
      run('current().elements[3].src'),
      'data:image/png;base64,aGVsbG8='
    );
    assert.equal(run('current().elements[0].points[0].p'), 0.4);
    run('redo()');
    assert.equal(run('current().elements.length'), 1);
    run('validateState(JSON.parse(JSON.stringify(state)))');
  }
});

test('cancelled scribbles and marker gestures stay ink; ordinary two-line crosses no longer delete', () => {
  for (const ending of ['pointercancel', 'lostpointercapture']) {
    const { node, run } = scribbleWorkspace();
    drawLine(node, scribbleWave, ending);
    assert.equal(run('current().elements.length'), 7);
  }
  const { node, run } = scribbleWorkspace();
  run('setTool("marker")');
  drawLine(node, scribbleFlat);
  assert.equal(run('current().elements.length'), 7);
  run('undo(); setTool("pen")');
  drawLine(node, [
    { x: 20, y: 20 },
    { x: 140, y: 100 }
  ]);
  drawLine(node, [
    { x: 20, y: 100 },
    { x: 140, y: 20 }
  ]);
  assert.equal(run('current().elements.length'), 8);
});

test('scribbles on empty paper stay ink and never affect a different page', () => {
  const { node, run } = scribbleWorkspace();
  run(
    `const next = newPage(); state.books[0].pages.push(next); switchPage(next.id);`
  );
  drawLine(node, scribbleFlat);
  assert.equal(run('current().elements.length'), 1);
  assert.equal(run('state.books[0].pages[0].elements.length'), 6);
  run('undo()');
  assert.equal(run('current().elements.length'), 0);
  run('validateState(JSON.parse(JSON.stringify(state)))');
});

test('scribble consumes coalesced tablet samples and the final pointerup endpoint', () => {
  const { node, run } = scribbleWorkspace();
  const event = { button: 0, pointerId: 1, preventDefault() {} };
  node('canvas').listeners.pointerdown({ ...event, clientX: 20, clientY: 20 });
  const samples = scribbleFlat
    .slice(1, -1)
    .map((p) => ({ ...event, clientX: p.x, clientY: p.y }));
  const last = samples.at(-1);
  node('canvas').listeners.pointermove({
    ...last,
    getCoalescedEvents: () => samples
  });
  node('canvas').listeners.pointerup({
    ...event,
    type: 'pointerup',
    clientX: 140,
    clientY: 100
  });
  assert.equal(run('current().elements.length'), 1);
});

function roughEllipse(rx, ry, angle = 0) {
  return Array.from({ length: 81 }, (_, i) => {
    const t = (i * Math.PI) / 40;
    const x = rx * Math.cos(t) * (1 + 0.02 * Math.sin(7 * t));
    const y = ry * Math.sin(t) * (1 + 0.02 * Math.cos(5 * t));
    return {
      x: 300 + x * Math.cos(angle) - y * Math.sin(angle),
      y: 300 + x * Math.sin(angle) + y * Math.cos(angle),
      p: 0.7
    };
  });
}

const roughRectangle = [
  { x: 100, y: 100 },
  { x: 200, y: 102 },
  { x: 201, y: 170 },
  { x: 102, y: 168 },
  { x: 100, y: 100 }
];
const roughTriangle = [
  { x: 100, y: 180 },
  { x: 160, y: 70 },
  { x: 220, y: 180 },
  { x: 100, y: 180 }
];
const roughLine = [
  { x: 100, y: 100 },
  { x: 150, y: 104 },
  { x: 200, y: 100 }
];

test('shape recognition fits lines, circles, rotated ellipses, triangles and rectangles', () => {
  for (const [kind, input] of [
    ['line', roughLine],
    ['circle', roughEllipse(90, 90)],
    ['ellipse', roughEllipse(120, 70, 0.5)],
    ['triangle', roughTriangle],
    ['rectangle', roughRectangle]
  ]) {
    for (const points of [input, [...input].reverse()]) {
      const shape = recognizeShape(points);
      assert.equal(shape?.kind, kind);
      assert.ok(
        shape.points.every(
          (p) =>
            Number.isFinite(p.x) && Number.isFinite(p.y) && p.p > 0 && p.p <= 1
        )
      );
      if (kind !== 'line')
        assert.deepEqual(shape.points[0], shape.points.at(-1));
      const state = initialState();
      state.books[0].pages[0].elements.push({
        id: uid(),
        type: 'stroke',
        tool: 'pen',
        color: '#000',
        size: 3,
        points: shape.points
      });
      assert.deepEqual(validateState(JSON.parse(JSON.stringify(state))), state);
    }
  }
  const circle = recognizeShape(roughEllipse(90, 90)).points;
  const box = strokeBounds({ points: circle, size: 0, tool: 'pen' });
  assert.ok(Math.abs(box.w - box.h) < 0.2);
  const rectangle = recognizeShape(roughRectangle).points;
  for (let i = 0; i < 4; i++) {
    const a = rectangle[i],
      b = rectangle[(i + 1) % 4],
      c = rectangle[(i + 2) % 4];
    assert.ok(
      Math.abs((b.x - a.x) * (c.x - b.x) + (b.y - a.y) * (c.y - b.y)) < 1e-6
    );
  }
});

test('shape recognition accepts different starting points and rotations and rejects scribbles and open curves', () => {
  const rotated = roughRectangle.map((p) => ({
    x: 300 + p.x * Math.cos(0.4) - p.y * Math.sin(0.4),
    y: 200 + p.x * Math.sin(0.4) + p.y * Math.cos(0.4)
  }));
  assert.equal(recognizeShape(rotated)?.kind, 'rectangle');
  const middle = [
    { x: 150, y: 101 },
    ...roughRectangle.slice(1),
    { x: 150, y: 101 }
  ];
  assert.equal(recognizeShape(middle)?.kind, 'rectangle');
  for (const points of [
    [],
    [{ x: 10, y: 10 }],
    [
      { x: 10, y: 10 },
      { x: 12, y: 12 }
    ],
    scribbleFlat,
    scribbleWave,
    scribbleFan,
    roughEllipse(100, 70).slice(0, 55)
  ]) {
    assert.equal(recognizeShape(points), null);
  }
});

function beginHeldStroke(node, points) {
  const event = { button: 0, pointerId: 1, preventDefault() {} };
  node('canvas').listeners.pointerdown({
    ...event,
    clientX: points[0].x,
    clientY: points[0].y
  });
  for (const p of points.slice(1))
    node('canvas').listeners.pointermove({
      ...event,
      clientX: p.x,
      clientY: p.y
    });
  return event;
}

test('holding fits a shape without changing document format and supports editing, undo and redo', () => {
  const { node, run, advanceTimers } = editingWorkspace();
  const event = beginHeldStroke(node, roughLine);
  advanceTimers(449);
  assert.equal(run('gesture.shape'), undefined);
  advanceTimers(1);
  assert.equal(run('gesture.shape'), 'line');
  assert.equal(run('current().elements[0].points.length'), 2);
  node('canvas').listeners.pointerup({
    ...event,
    type: 'pointerup',
    clientX: 200,
    clientY: 100
  });
  assert.equal(run('current().elements[0].points.length'), 2);
  run('validateState(JSON.parse(JSON.stringify(state))); undo()');
  assert.equal(run('current().elements.length'), 0);
  run(
    'redo(); selection = [current().elements[0].id]; copySelection(); pasteObject()'
  );
  assert.equal(run('current().elements.length'), 2);
  assert.equal(
    run('current().elements[0].id !== current().elements[1].id'),
    true
  );
  run('validateState(JSON.parse(JSON.stringify(state)))');
});

test('continued drawing restores freehand; release, cancellation and marker cannot leave a delayed shape', () => {
  const { node, run, advanceTimers } = editingWorkspace();
  const event = beginHeldStroke(node, roughLine);
  advanceTimers(650);
  node('canvas').listeners.pointermove({
    ...event,
    clientX: 220,
    clientY: 140
  });
  assert.equal(run('gesture.shape'), null);
  assert.equal(run('current().elements[0].points.length'), 4);
  node('canvas').listeners.pointerup({
    ...event,
    type: 'pointerup',
    clientX: 220,
    clientY: 140
  });
  const original = run('JSON.stringify(current().elements)');
  advanceTimers(1000);
  assert.equal(run('JSON.stringify(current().elements)'), original);
  run('undo()');
  beginHeldStroke(node, roughLine);
  advanceTimers(650);
  node('canvas').listeners.pointercancel({ ...event, type: 'pointercancel' });
  assert.equal(run('current().elements[0].points.length'), 3);
  run('undo(); setTool("marker")');
  drawLine(node, roughLine);
  advanceTimers(1000);
  assert.equal(run('current().elements[0].points.length'), 3);
});

test('holding a scribble still deletes only on release and never converts it to a shape', () => {
  const { node, run, advanceTimers } = scribbleWorkspace();
  const event = beginHeldStroke(node, scribbleWave);
  advanceTimers(1000);
  assert.equal(run('gesture.shape'), undefined);
  assert.equal(run('current().elements.length'), 7);
  node('canvas').listeners.pointerup({
    ...event,
    type: 'pointerup',
    clientX: scribbleWave.at(-1).x,
    clientY: scribbleWave.at(-1).y
  });
  assert.equal(run('current().elements.length'), 1);
});

test('stationary pen jitter does not postpone or distort shape recognition', () => {
  const { node, run, advanceTimers } = editingWorkspace();
  const event = beginHeldStroke(node, roughLine);
  for (let i = 0; i < 60; i++) {
    node('canvas').listeners.pointermove({
      ...event,
      clientX: 200 + (i % 2 ? 8 : -8),
      clientY: 100
    });
    advanceTimers(10);
  }
  advanceTimers(50);
  assert.equal(run('gesture.shape'), 'line');
  node('canvas').listeners.pointerup({
    ...event,
    type: 'pointerup',
    clientX: 201,
    clientY: 100
  });
  assert.equal(run('current().elements[0].points.length'), 2);
});

function roundedRectangle(square = false) {
  const points = [];
  const bottom = square ? 410 : 330;
  for (const [cx, cy, start] of [
    [380, 250, -Math.PI / 2],
    [380, bottom, 0],
    [220, bottom, Math.PI / 2],
    [220, 250, Math.PI]
  ]) {
    for (let i = 0; i <= 12; i++) {
      const t = start + (i * Math.PI) / 24;
      points.push({ x: cx + 25 * Math.cos(t), y: cy + 25 * Math.sin(t) });
    }
  }
  return [...points, points[0]];
}

test('rough circles and ovals tolerate radial wobble and a small closure gap', () => {
  for (const [rx, ry, kind] of [
    [90, 90, 'circle'],
    [110, 70, 'ellipse']
  ]) {
    for (const phase of [0, 1, 2]) {
      const points = Array.from({ length: 100 }, (_, i) => {
        const t = (i / 99) * Math.PI * 1.85;
        const radius =
          1 + 0.1 * Math.sin(5 * t + phase) + 0.035 * Math.sin(13 * t);
        return {
          x: 300 + rx * radius * Math.cos(t),
          y: 300 + ry * radius * Math.sin(t)
        };
      });
      assert.equal(recognizeShape(points)?.kind, kind);
    }
  }
});

test('rounded squares and rectangles fit at different rotations without turning circles into polygons', () => {
  for (const square of [false, true]) {
    for (const angle of [0, 0.3, 0.8, 1.4]) {
      const points = roundedRectangle(square).map((p) => ({
        x: p.x * Math.cos(angle) - p.y * Math.sin(angle),
        y: p.x * Math.sin(angle) + p.y * Math.cos(angle)
      }));
      const shape = recognizeShape(points);
      assert.equal(shape?.kind, 'rectangle');
      const sides = shape.points
        .slice(1)
        .map((p, i) =>
          Math.hypot(p.x - shape.points[i].x, p.y - shape.points[i].y)
        );
      assert.ok(Math.abs(sides[0] - sides[2]) < 1e-6);
      if (square) assert.ok(Math.abs(sides[0] - sides[1]) < 1e-6);
    }
  }
  assert.equal(recognizeShape(roughEllipse(90, 90))?.kind, 'circle');
  assert.equal(recognizeShape(roughEllipse(110, 70))?.kind, 'ellipse');
});

test('lifting the pen with shifted coordinates keeps the already displayed shape', () => {
  const { node, run, advanceTimers } = editingWorkspace();
  const event = beginHeldStroke(node, roughRectangle);
  advanceTimers(450);
  assert.equal(run('gesture.shape'), 'rectangle');
  const displayed = run('JSON.stringify(current().elements[0].points)');
  node('canvas').listeners.pointerup({
    ...event,
    type: 'pointerup',
    clientX: 130,
    clientY: 125
  });
  assert.equal(run('JSON.stringify(current().elements[0].points)'), displayed);
  run('undo(); redo(); validateState(JSON.parse(JSON.stringify(state)))');
  assert.equal(run('JSON.stringify(current().elements[0].points)'), displayed);
});

test('screenshot-like bowed rectangles and overlapping oval closures recognise in either direction and at different angles', () => {
  for (const [index, contour] of screenContours.entries()) {
    for (const angle of [0, 0.4, 1.2]) {
      for (const source of [contour.points, [...contour.points].reverse()]) {
        const points = source.map((p) => ({
          x:
            500 + (p.x - 500) * Math.cos(angle) - (p.y - 300) * Math.sin(angle),
          y: 700 + (p.x - 500) * Math.sin(angle) + (p.y - 300) * Math.cos(angle)
        }));
        assert.equal(
          recognizeShape(points, 16)?.kind,
          contour.kind,
          `contour ${index}, angle ${angle}`
        );
      }
    }
  }
});

test('screenshot-like contours straighten during a hold and survive undo, redo and backup validation', () => {
  for (const contour of screenContours) {
    const { node, run, advanceTimers } = editingWorkspace();
    const event = beginHeldStroke(node, contour.points);
    advanceTimers(450);
    assert.equal(run('gesture.shape'), contour.kind);
    const last = contour.points.at(-1);
    node('canvas').listeners.pointerup({
      ...event,
      type: 'pointerup',
      clientX: last.x,
      clientY: last.y
    });
    const saved = run('JSON.stringify(current().elements)');
    run('undo()');
    assert.equal(run('current().elements.length'), 0);
    run('redo(); validateState(JSON.parse(JSON.stringify(state)))');
    assert.equal(run('JSON.stringify(current().elements)'), saved);
  }
});

test('closure tail recognition is independent of pointer sample density', () => {
  for (const contour of screenContours) {
    const dense = [];
    for (let i = 1; i < contour.points.length; i++) {
      const a = contour.points[i - 1],
        b = contour.points[i];
      for (let j = 0; j < 10; j++)
        dense.push({
          x: a.x + ((b.x - a.x) * j) / 10,
          y: a.y + ((b.y - a.y) * j) / 10
        });
    }
    dense.push(contour.points.at(-1));
    assert.equal(recognizeShape(dense)?.kind, contour.kind);
  }
});

test('all eight menu shapes are closed strokes with valid backups, including reverse drawing', () => {
  assert.equal(Object.keys(shapeNames).length, 8);
  for (const kind of Object.keys(shapeNames)) {
    for (const end of [
      { x: 340, y: 260 },
      { x: 60, y: 80 }
    ]) {
      const points = createShapePoints(kind, { x: 200, y: 180 }, end);
      assert.deepEqual(points[0], points.at(-1));
      const box = strokeBounds({ points, tool: 'pen', size: 0 });
      assert.ok(box.w > 0 && box.h > 0);
      if (kind === 'right-trapezoid') {
        assert.equal(points[0].x, points[3].x);
        assert.equal(points[0].y, points[1].y);
        assert.equal(points[2].y, points[3].y);
        assert.ok(points[1].x < points[2].x);
      }
      if (['circle', 'square'].includes(kind))
        assert.ok(Math.abs(box.w - box.h) < 1e-6);
      const state = initialState();
      state.books[0].pages[0].elements.push({
        id: uid(),
        type: 'stroke',
        tool: 'pen',
        size: 4,
        color: '#000',
        points
      });
      assert.deepEqual(validateState(JSON.parse(JSON.stringify(state))), state);
    }
  }
});

test('shape stretching changes width and height independently, preserving pressure, photos and originals', () => {
  const stroke = {
    id: uid(),
    type: 'stroke',
    tool: 'pen',
    size: 4,
    color: '#000',
    points: createShapePoints('circle', { x: 100, y: 100 }, { x: 200, y: 200 })
  };
  const resized = resizeElement(
    stroke,
    { x: 100, y: 100, w: 100, h: 100 },
    { x: 50, y: 80, w: 300, h: 40 }
  );
  const box = strokeBounds({ ...resized, size: 0 });
  assert.deepEqual(box, { x: 50, y: 80, w: 300, h: 40 });
  assert.equal(resized.size, 4);
  assert.equal(resized.points[0].p, stroke.points[0].p);
  assert.equal(stroke.points[0].x, 200);
  const photo = {
    type: 'image',
    x: 100,
    y: 100,
    w: 100,
    h: 100,
    src: 'data:image/png;base64,aGVsbG8='
  };
  assert.deepEqual(
    resizeElement(
      photo,
      { x: 100, y: 100, w: 100, h: 100 },
      { x: 50, y: 80, w: 300, h: 40 }
    ),
    { ...photo, x: 50, y: 80, w: 300, h: 40 }
  );
});

test('shape icon opens a menu and each chosen shape is created by dragging, selected, undoable and copyable', () => {
  for (const kind of Object.keys(shapeNames)) {
    const { node, run } = editingWorkspace();
    node('shapeTool').onclick();
    assert.equal(node('shapeMenu').hidden, false);
    node('shapeMenu').listeners.click({
      target: { closest: () => ({ dataset: { shape: kind } }) }
    });
    assert.equal(run('tool'), 'shape');
    assert.equal(node('shapeMenu').hidden, true);
    drawLine(node, [
      { x: 100, y: 100 },
      { x: 240, y: 200 }
    ]);
    assert.equal(run('tool'), 'select');
    assert.equal(run('selection[0] === current().elements[0].id'), true);
    assert.equal(run('undoStack.length'), 1);
    assert.equal(
      run('current().elements[0].points.length'),
      ['circle', 'ellipse'].includes(kind) ? 97 : 5
    );
    run('undo()');
    assert.equal(run('current().elements.length'), 0);
    run(
      'redo(); selection = [current().elements[0].id]; copySelection(); pasteObject(); validateState(JSON.parse(JSON.stringify(state)))'
    );
    assert.equal(run('current().elements.length'), 2);
  }
});

test('side and corner handles stretch selected figures, preserve thickness and support undo', () => {
  const { node, run } = editingWorkspace();
  run('chooseShape("circle")');
  drawLine(node, [
    { x: 100, y: 100 },
    { x: 240, y: 240 }
  ]);
  const before = run('JSON.stringify(current().elements[0])');
  const r = run('selectionBounds()');
  const event = { button: 0, pointerId: 1, preventDefault() {} };
  node('canvas').listeners.pointerdown({
    ...event,
    clientX: r.x + r.w,
    clientY: r.y + r.h / 2
  });
  assert.equal(run('gesture.type'), 'resize-selection');
  node('canvas').listeners.pointermove({
    ...event,
    clientX: r.x + r.w + 140,
    clientY: r.y + r.h / 2
  });
  node('canvas').listeners.pointerup({ ...event, type: 'pointerup' });
  assert.ok(run('selectionBounds().w') > r.w * 1.9);
  assert.equal(run('selectionBounds().h'), r.h);
  assert.equal(run('current().elements[0].size'), 3);
  run('undo()');
  assert.equal(run('JSON.stringify(current().elements[0])'), before);
  run('redo(); selection = [current().elements[0].id]');
  const resized = run('selectionBounds()');
  node('canvas').listeners.pointerdown({
    ...event,
    clientX: resized.x,
    clientY: resized.y
  });
  node('canvas').listeners.pointermove({
    ...event,
    clientX: resized.x - 50,
    clientY: resized.y - 50
  });
  node('canvas').listeners.pointerup({ ...event, type: 'pointerup' });
  assert.ok(run('selectionBounds().w') > resized.w);
  assert.ok(run('selectionBounds().h') > resized.h);
  run('validateState(JSON.parse(JSON.stringify(state)))');
});

test('cancelled shape creation and clicks add neither objects nor undo entries', () => {
  for (const ending of ['pointercancel', 'lostpointercapture']) {
    const { node, run } = editingWorkspace();
    run('chooseShape("diamond")');
    drawLine(
      node,
      [
        { x: 100, y: 100 },
        { x: 240, y: 200 }
      ],
      ending
    );
    assert.equal(run('current().elements.length'), 0);
    assert.equal(run('undoStack.length'), 0);
  }
  const { node, run } = editingWorkspace();
  run('chooseShape("trapezoid")');
  drawLine(node, [{ x: 100, y: 100 }]);
  assert.equal(run('current().elements.length'), 0);
  assert.equal(run('undoStack.length'), 0);
});

test('figure pressure matches distance-weighted writing independently of event density and legacy figures', () => {
  const points = [
    { x: 0, y: 0, p: 0.2 },
    { x: 100, y: 0, p: 0.4 }
  ];
  const dense = Array.from({ length: 101 }, (_, i) => ({
    x: i,
    y: 0,
    p: 0.2 + i * 0.002
  }));
  dense.push(...Array.from({ length: 100 }, () => ({ x: 100, y: 0, p: 0.4 })));
  assert.ok(
    Math.abs(core.averagePressure(points) - core.averagePressure(dense)) < 1e-10
  );
  const handwriting = { type: 'stroke', tool: 'pen', size: 3, points };
  const legacy = {
    type: 'stroke',
    tool: 'pen',
    size: 3,
    points: createShapePoints('circle', { x: 0, y: 0 }, { x: 100, y: 100 }, 0.8)
  };
  assert.ok(
    Math.abs(core.recentWritingPressure([handwriting, legacy]) - 0.3) < 1e-10
  );
  assert.equal(core.penWidth(3), 3);
  assert.equal(core.penWidth(12), 12);
  assert.ok(core.penWidth(3, 0.2) < core.penWidth(3, 0.7));
});

test('new menu figures use the same rendered width as recent handwriting and preserve old notes', () => {
  const { node, run } = editingWorkspace();
  node('pressure').checked = true;
  const event = {
    button: 0,
    pointerId: 1,
    pointerType: 'pen',
    pressure: 0.3,
    preventDefault() {}
  };
  node('canvas').listeners.pointerdown({
    ...event,
    clientX: 100,
    clientY: 100
  });
  node('canvas').listeners.pointermove({
    ...event,
    clientX: 160,
    clientY: 100
  });
  node('canvas').listeners.pointerup({
    ...event,
    type: 'pointerup',
    clientX: 160,
    clientY: 100
  });
  const writing = run('JSON.stringify(current().elements[0])');
  run('chooseShape("circle")');
  drawLine(node, [
    { x: 200, y: 200 },
    { x: 300, y: 300 }
  ]);
  assert.ok(Math.abs(run('current().elements[1].points[0].p') - 0.3) < 1e-10);
  assert.equal(run('JSON.stringify(current().elements[0])'), writing);
  run(`globalThis.Path2D = class { moveTo() {} lineTo() {} };
    globalThis.widths = [];
    const recorder = { save() {}, restore() {}, beginPath() {}, arc() {}, fill() {},
      stroke() { widths.push(this.lineWidth); } };
    drawElement(recorder, current().elements[0]);
    drawElement(recorder, current().elements[1]);`);
  assert.equal(run('widths.length'), 2);
  assert.equal(run('widths[0]'), run('widths[1]'));
  run('validateState(JSON.parse(JSON.stringify(state)))');
});

test('pressure off gives both handwriting and menu figures exactly the selected pixel width', () => {
  const { node, run } = editingWorkspace();
  node('pressure').checked = false;
  drawLine(node, roughLine);
  run('chooseShape("rectangle")');
  drawLine(node, [
    { x: 300, y: 300 },
    { x: 400, y: 400 }
  ]);
  assert.equal(
    run(
      'penWidth(current().elements[0].size, current().elements[0].points[0].p)'
    ),
    3
  );
  assert.equal(
    run(
      'penWidth(current().elements[1].size, current().elements[1].points[0].p)'
    ),
    3
  );
  const shape = run('JSON.stringify(current().elements[1])');
  run('undo(); redo()');
  assert.equal(run('JSON.stringify(current().elements[1])'), shape);
});

test('reloaded handwriting and aligned shapes keep their effective average width', () => {
  const { node, run } = editingWorkspace();
  node('pressure').checked = true;
  run(`current().elements.push({ id: uid(), type: 'stroke', tool: 'pen', size: 3,
    color: '#000', points: [{ x: 10, y: 10, p: 0.2 }, { x: 110, y: 10, p: 0.4 }] });
    chooseShape('diamond');`);
  drawLine(node, [
    { x: 300, y: 300 },
    { x: 400, y: 400 }
  ]);
  assert.ok(Math.abs(run('current().elements[1].points[0].p') - 0.3) < 1e-10);
  const input = [
    { x: 10, y: 10, p: 0.2 },
    { x: 60, y: 11, p: 0.4 },
    { x: 110, y: 10, p: 0.3 }
  ];
  const shape = recognizeShape(input);
  assert.ok(Math.abs(shape.points[0].p - core.averagePressure(input)) < 1e-10);
});

function assertPointsNear(actual, expected) {
  assert.equal(actual.length, expected.length);
  for (let i = 0; i < actual.length; i++) {
    assert.ok(Math.abs(actual[i].x - expected[i].x) < 1e-8);
    assert.ok(Math.abs(actual[i].y - expected[i].y) < 1e-8);
    assert.equal(actual[i].p, expected[i].p);
  }
}

test('rotation and mirroring preserve shape geometry, pressure, thickness and backup compatibility', () => {
  for (const kind of Object.keys(shapeNames)) {
    const source = {
      id: uid(),
      type: 'stroke',
      tool: 'pen',
      color: '#123456',
      size: 3,
      points: createShapePoints(
        kind,
        { x: 200, y: 300 },
        { x: 400, y: 450 },
        0.3
      )
    };
    const center = { x: 300, y: 375 };
    const fullTurn = transformStroke(source, center, Math.PI * 2);
    assertPointsNear(fullTurn.points, source.points);
    const rotated = transformStroke(source, center, Math.PI / 3);
    for (let i = 1; i < source.points.length; i++) {
      const a = source.points[i - 1],
        b = source.points[i];
      const c = rotated.points[i - 1],
        d = rotated.points[i];
      assert.ok(
        Math.abs(
          Math.hypot(b.x - a.x, b.y - a.y) - Math.hypot(d.x - c.x, d.y - c.y)
        ) < 1e-8
      );
    }
    for (const axis of ['horizontal', 'vertical']) {
      const mirrored = transformStroke(source, center, 0, axis);
      assertPointsNear(
        transformStroke(mirrored, center, 0, axis).points,
        source.points
      );
    }
    assert.equal(rotated.id, source.id);
    assert.equal(rotated.size, source.size);
    assert.equal(rotated.color, source.color);
    const state = initialState();
    state.books[0].pages[0].elements.push(rotated);
    assert.deepEqual(validateState(JSON.parse(JSON.stringify(state))), state);
  }
});

function beginRotation(workspace) {
  const r = workspace.run('selectionBounds()');
  const handle = workspace.run('rotationHandle(selectionBounds())');
  const event = { button: 0, pointerId: 1, preventDefault() {} };
  workspace
    .node('canvas')
    .listeners.pointerdown({ ...event, clientX: handle.x, clientY: handle.y });
  assert.equal(workspace.run('gesture.type'), 'rotate-selection');
  return { event, center: { x: r.x + r.w / 2, y: r.y + r.h / 2 }, handle };
}

test('dragging rotation handle beyond 360 degrees creates one undo step and keeps exact geometry', () => {
  const workspace = editingWorkspace();
  const { node, run } = workspace;
  run('chooseShape("right-trapezoid")');
  drawLine(node, [
    { x: 250, y: 250 },
    { x: 450, y: 400 }
  ]);
  const original = JSON.parse(run('JSON.stringify(current().elements[0])'));
  const { event, center, handle } = beginRotation(workspace);
  let end;
  for (let step = 1; step <= 9; step++) {
    const angle = (step * Math.PI) / 4;
    const x = handle.x - center.x,
      y = handle.y - center.y;
    end = {
      clientX: center.x + x * Math.cos(angle) - y * Math.sin(angle),
      clientY: center.y + x * Math.sin(angle) + y * Math.cos(angle)
    };
    node('canvas').listeners.pointermove({ ...event, ...end });
  }
  assert.ok(Math.abs(run('gesture.angle') - (Math.PI * 9) / 4) < 1e-8);
  node('canvas').listeners.pointerup({ ...event, ...end, type: 'pointerup' });
  assert.equal(run('undoStack.length'), 2);
  const rotated = JSON.parse(run('JSON.stringify(current().elements[0])'));
  assertPointsNear(
    rotated.points,
    transformStroke(original, center, (Math.PI * 9) / 4).points
  );
  run('undo()');
  assert.equal(
    run('JSON.stringify(current().elements[0])'),
    JSON.stringify(original)
  );
  run('redo(); validateState(JSON.parse(JSON.stringify(state)))');
  assertPointsNear(
    JSON.parse(run('JSON.stringify(current().elements[0].points)')),
    rotated.points
  );
});

test('mirror and quarter-turn menu actions work on whole groups and are undoable', () => {
  const { node, run } = editingWorkspace();
  run(`current().elements = [
    { id: uid(), type: 'stroke', tool: 'pen', size: 3, color: '#000', points: [{x:100,y:100,p:0.2},{x:150,y:130,p:0.8}] },
    { id: uid(), type: 'stroke', tool: 'pen', size: 3, color: '#000', points: [{x:200,y:200,p:0.4},{x:240,y:230,p:0.6}] }
  ]; selection = current().elements.map(el => el.id);`);
  const original = run('JSON.stringify(current().elements)');
  node('flipHorizontal').onclick();
  assert.ok(
    run('current().elements[0].points[0].x > current().elements[1].points[0].x')
  );
  node('flipHorizontal').onclick();
  assertPointsNear(
    JSON.parse(run('JSON.stringify(current().elements[0].points)')),
    JSON.parse(original)[0].points
  );
  node('flipVertical').onclick();
  assert.ok(
    run('current().elements[0].points[0].y > current().elements[1].points[0].y')
  );
  run('undo(); selection = current().elements.map(el => el.id)');
  node('rotateRight').onclick();
  node('rotateLeft').onclick();
  assertPointsNear(
    JSON.parse(run('JSON.stringify(current().elements[0].points)')),
    JSON.parse(original)[0].points
  );
  run('validateState(JSON.parse(JSON.stringify(state)))');
});

test('cancelled rotation restores the selection and the previous undo and redo stacks', () => {
  const workspace = editingWorkspace();
  const { node, run } = workspace;
  run('chooseShape("rectangle")');
  drawLine(node, [
    { x: 200, y: 200 },
    { x: 400, y: 300 }
  ]);
  run(
    'copySelection(); pasteObject(); undo(); selection = [current().elements[0].id]'
  );
  const before = run(
    'JSON.stringify({elements:current().elements,undo:undoStack,redo:redoStack})'
  );
  const { event, center, handle } = beginRotation(workspace);
  node('canvas').listeners.pointermove({
    ...event,
    clientX: center.x + (center.y - handle.y),
    clientY: center.y
  });
  node('canvas').listeners.pointercancel({ ...event, type: 'pointercancel' });
  assert.equal(
    run(
      'JSON.stringify({elements:current().elements,undo:undoStack,redo:redoStack})'
    ),
    before
  );
});

test('rotation handle clicks add no history and Shift snaps the angle to 15 degrees', () => {
  const workspace = editingWorkspace();
  const { node, run } = workspace;
  run('chooseShape("diamond")');
  drawLine(node, [
    { x: 250, y: 250 },
    { x: 450, y: 400 }
  ]);
  const first = beginRotation(workspace);
  node('canvas').listeners.pointerup({ ...first.event, type: 'pointerup' });
  assert.equal(run('undoStack.length'), 1);
  const { event, center, handle } = beginRotation(workspace);
  const x = handle.x - center.x,
    y = handle.y - center.y,
    angle = (22 * Math.PI) / 180;
  node('canvas').listeners.pointermove({
    ...event,
    shiftKey: true,
    clientX: center.x + x * Math.cos(angle) - y * Math.sin(angle),
    clientY: center.y + x * Math.sin(angle) + y * Math.cos(angle)
  });
  assert.ok(Math.abs(run('gesture.appliedAngle') - Math.PI / 12) < 1e-8);
  node('canvas').listeners.pointerup({
    ...event,
    type: 'pointerup',
    shiftKey: true
  });
  assert.equal(run('undoStack.length'), 2);
});

function clipboardEvent(files = []) {
  const formats = new Map();
  return {
    prevented: false,
    preventDefault() {
      this.prevented = true;
    },
    clipboardData: {
      items: files.map((file) => ({
        kind: 'file',
        type: file.type,
        getAsFile: () => file
      })),
      files,
      getData(type) {
        return formats.get(type) || '';
      },
      setData(type, value) {
        formats.set(type, value);
      }
    }
  };
}

function enableImageDecoding(workspace) {
  workspace.run(`globalThis.closedBitmaps = 0;
    globalThis.createImageBitmap = async file => ({ width: file.width || 4000, height: file.height || 1000,
      close() { closedBitmaps++; } });`);
}

test('pasting clipboard images embeds editable photos with one undo step and valid backups', async () => {
  const workspace = editingWorkspace();
  const { run, windowListeners } = workspace;
  enableImageDecoding(workspace);
  run(
    `current().elements.push({id:uid(),type:'text',x:10,y:10,size:24,color:'#000',text:'Сохранить'});`
  );
  const event = clipboardEvent([
    { type: 'image/png', size: 1000 },
    { type: 'image/jpeg', size: 2000 }
  ]);
  await windowListeners.paste(event);
  assert.equal(event.prevented, true);
  assert.equal(run('current().elements.length'), 3);
  assert.equal(run('current().elements[0].text'), 'Сохранить');
  assert.equal(run('current().elements[1].type'), 'image');
  assert.equal(run('current().elements[1].w'), 800);
  assert.equal(run('current().elements[1].h'), 200);
  assert.equal(run('selection.length'), 2);
  assert.equal(run('tool'), 'select');
  assert.equal(run('closedBitmaps'), 2);
  assert.equal(run('undoStack.length'), 1);
  run('validateState(JSON.parse(JSON.stringify(state))); undo()');
  assert.equal(run('current().elements.length'), 1);
  run('redo()');
  assert.equal(run('current().elements.length'), 3);
});

test('external clipboard images take priority over old internal copies and native copying retains object paste', async () => {
  const workspace = editingWorkspace();
  const { run, windowListeners } = workspace;
  enableImageDecoding(workspace);
  run(`current().elements.push({id:uid(),type:'text',x:10,y:10,size:24,color:'#000',text:'Текст'});
    selection=[current().elements[0].id];`);
  const copied = clipboardEvent();
  windowListeners.copy(copied);
  assert.equal(copied.prevented, true);
  await windowListeners.paste(
    clipboardEvent([{ type: 'image/png', size: 1000 }])
  );
  assert.equal(run('current().elements[1].type'), 'image');
  await windowListeners.paste(copied);
  assert.equal(run('current().elements[2].type'), 'text');
  assert.equal(run('current().elements[2].text'), 'Текст');
  assert.equal(run('closedBitmaps'), 1);
});

test('clipboard paste leaves text fields, editable content, dialogs and active pen gestures alone', async () => {
  for (const setup of [
    'document.activeElement={tagName:"INPUT"}',
    'document.activeElement={tagName:"TEXTAREA"}',
    'document.activeElement={tagName:"DIV",isContentEditable:true}',
    'document.getElementById("dialog").open=true',
    'gesture={type:"draw"}'
  ]) {
    const workspace = editingWorkspace();
    enableImageDecoding(workspace);
    workspace.run(setup);
    const event = clipboardEvent([{ type: 'image/png', size: 1000 }]);
    await workspace.windowListeners.paste(event);
    assert.equal(event.prevented, false);
    assert.equal(workspace.run('current().elements.length'), 0);
    assert.equal(workspace.run('closedBitmaps'), 0);
  }
});

test('clipboard image errors and oversized files preserve page contents and undo history', async () => {
  const workspace = editingWorkspace();
  const { run, windowListeners } = workspace;
  enableImageDecoding(workspace);
  await windowListeners.paste(
    clipboardEvent([{ type: 'image/png', size: 26 * 1024 * 1024 }])
  );
  assert.equal(run('current().elements.length'), 0);
  assert.equal(run('undoStack.length'), 0);
  run(
    'globalThis.createImageBitmap = async () => {throw Error("Повреждённое фото") }'
  );
  await windowListeners.paste(
    clipboardEvent([{ type: 'image/png', size: 1000 }])
  );
  assert.equal(run('current().elements.length'), 0);
  assert.equal(run('undoStack.length'), 0);
});

test('image decoding never inserts into a different page or replaced document', async () => {
  for (const change of [
    'const next=newPage();state.books[0].pages.push(next);switchPage(next.id)',
    'state=structuredClone(state)'
  ]) {
    const { run, windowListeners } = editingWorkspace();
    run(
      'globalThis.finishDecode=null; globalThis.closedBitmaps=0; globalThis.createImageBitmap=() => new Promise(resolve => {finishDecode=resolve})'
    );
    const pending = windowListeners.paste(
      clipboardEvent([{ type: 'image/png', size: 1000 }])
    );
    run(change);
    run('finishDecode({width:400,height:300,close(){closedBitmaps++}})');
    await pending;
    assert.equal(
      run('state.books[0].pages.every(p=>p.elements.length===0)'),
      true
    );
    assert.equal(run('undoStack.length'), 0);
    assert.equal(run('closedBitmaps'), 1);
  }
});

test('photo file upload and clipboard files fallback use the same image import', async () => {
  const workspace = editingWorkspace();
  const { node, run, windowListeners } = workspace;
  enableImageDecoding(workspace);
  const file = { type: 'image/png', size: 1000, width: 600, height: 400 };
  const target = { files: [file], value: 'photo.png' };
  await node('photoInput').onchange({ target });
  assert.equal(target.value, '');
  assert.equal(run('current().elements[0].w'), 600);
  assert.equal(run('current().elements[0].h'), 400);
  run('undo()');
  const event = clipboardEvent([file]);
  event.clipboardData.items = [];
  await windowListeners.paste(event);
  assert.equal(run('current().elements.length'), 1);
  assert.equal(run('current().elements[0].w'), 600);
  assert.equal(run('closedBitmaps'), 2);
});

test('copy and paste shortcuts allow native clipboard events even with an internal object copy', () => {
  const { run, windowListeners } = editingWorkspace();
  run(`current().elements.push({id:uid(),type:'text',x:10,y:10,size:24,color:'#000',text:'Текст'});
    selection=[current().elements[0].id];copySelection();`);
  for (const key of ['c', 'v']) {
    const event = {
      key,
      ctrlKey: true,
      prevented: false,
      preventDefault() {
        this.prevented = true;
      }
    };
    windowListeners.keydown(event);
    assert.equal(event.prevented, false);
  }
  assert.equal(run('current().elements.length'), 1);
});

test('large-page writing paints only new ink and shares unchanged strokes in undo history', () => {
  const workspace = editingWorkspace();
  const { run, node, rendering, advanceTimers } = workspace;
  run(`for (let i=0;i<5000;i++) current().elements.push({id:uid(),type:'stroke',tool:'pen',size:2,color:'#000',
    points:Array.from({length:40},(_,j)=>({x:i%100+j/10,y:Math.floor(i/100),p:0.3+j/100}))});
    globalThis.firstOldStroke=current().elements[0];
    globalThis.copyCount=0; const originalClone=structuredClone;
    globalThis.structuredClone=value=>{copyCount++;return originalClone(value)};`);
  node('pressure').checked = true;
  const event = {
    button: 0,
    pointerId: 1,
    pointerType: 'pen',
    preventDefault() {}
  };
  node('canvas').listeners.pointerdown({
    ...event,
    pressure: 0.2,
    clientX: 200,
    clientY: 300
  });
  for (let i = 1; i <= 50; i++)
    node('canvas').listeners.pointermove({
      ...event,
      pressure: 0.2 + i / 100,
      clientX: 200 + i,
      clientY: 300 + i / 10
    });
  assert.equal(rendering.mainStrokes, 0);
  advanceTimers(16);
  assert.equal(rendering.inkStrokes, 50);
  node('canvas').listeners.pointerup({
    ...event,
    type: 'pointerup',
    pressure: 0.7,
    clientX: 250,
    clientY: 305
  });
  assert.equal(rendering.mainStrokes, 50);
  assert.equal(run('copyCount'), 0);
  assert.equal(run('current().elements.length'), 5001);
  assert.equal(run('undoStack[0][0] === firstOldStroke'), true);
  run('undo()');
  assert.equal(run('current().elements.length'), 5000);
  assert.equal(run('current().elements[0] === firstOldStroke'), true);
  run('redo()');
  assert.equal(run('current().elements[5000].points.length'), 51);
});

test('copy-on-write editing preserves old snapshots for movement, stretching, rotation and text edits', async () => {
  const workspace = editingWorkspace();
  const { run, node } = workspace;
  run('chooseShape("right-trapezoid")');
  drawLine(node, [
    { x: 200, y: 200 },
    { x: 400, y: 350 }
  ]);
  run(
    'globalThis.unchanged=current().elements[0]; globalThis.original=JSON.stringify(unchanged)'
  );
  node('flipHorizontal').onclick();
  assert.equal(run('JSON.stringify(unchanged) === original'), true);
  run('undo()');
  assert.equal(run('current().elements[0] === unchanged'), true);
  run('selection=[unchanged.id]');
  const event = { button: 0, pointerId: 1, preventDefault() {} };
  node('canvas').listeners.pointerdown({
    ...event,
    clientX: 300,
    clientY: 280
  });
  node('canvas').listeners.pointermove({
    ...event,
    clientX: 330,
    clientY: 310
  });
  node('canvas').listeners.pointerup({ ...event, type: 'pointerup' });
  assert.equal(run('JSON.stringify(unchanged) === original'), true);
  run('undo(); selection=[unchanged.id]');
  const r = run('selectionBounds()');
  node('canvas').listeners.pointerdown({
    ...event,
    clientX: r.x + r.w,
    clientY: r.y + r.h
  });
  node('canvas').listeners.pointermove({
    ...event,
    clientX: r.x + r.w + 50,
    clientY: r.y + r.h + 50
  });
  node('canvas').listeners.pointerup({ ...event, type: 'pointerup' });
  assert.equal(run('JSON.stringify(unchanged) === original'), true);
  run(
    'undo(); current().elements.push({id:uid(),type:"text",text:"До",x:10,y:10,size:24,color:"#000"}); ask=async()=>"После"'
  );
  await run('editText(current().elements[1])');
  assert.equal(run('undoStack.at(-1)[1].text'), 'До');
  assert.equal(run('current().elements[1].text'), 'После');
  run('undo()');
  assert.equal(run('current().elements[1].text'), 'До');
});

test('worker patches retain all version:1 pages and photos through edits, undo, deletion and legacy backup import', () => {
  let state = initialState();
  const first = state.books[0].pages[0];
  first.elements.push({
    id: uid(),
    type: 'image',
    src: 'data:image/png;base64,aGVsbG8=',
    x: 10,
    y: 10,
    w: 100,
    h: 100
  });
  const second = core.newPage('Вторая');
  second.elements.push({
    id: uid(),
    type: 'text',
    text: 'Вторая запись',
    x: 10,
    y: 10,
    size: 24,
    color: '#000'
  });
  state.books[0].pages.push(second);
  const builder = new DocumentPatches();
  builder.prime(state);
  let workerState = structuredClone(state);
  const old = first.elements.slice();
  first.elements.push({
    id: uid(),
    type: 'stroke',
    tool: 'pen',
    size: 3,
    color: '#000',
    points: [{ x: 10, y: 10, p: 0.5 }]
  });
  let patch = builder.create(state, new Set([first.id]));
  assert.equal(patch.changes[0].upserts.length, 1);
  workerState = applyDocumentPatch(workerState, structuredClone(patch));
  assert.deepEqual(workerState, state);
  first.elements = old;
  workerState = applyDocumentPatch(
    workerState,
    builder.create(state, new Set([first.id]))
  );
  assert.deepEqual(workerState, state);
  // A restored backup may keep the same IDs while replacing every page object.
  state = validateState(JSON.parse(JSON.stringify(state)));
  state.books[0].pages[1].elements[0].text = 'Импортированная запись';
  patch = builder.create(state, new Set([state.activePage]));
  assert.equal(patch.changes.length, 2);
  workerState = applyDocumentPatch(workerState, structuredClone(patch));
  assert.deepEqual(workerState, state);
  state.books[0].pages.pop();
  workerState = applyDocumentPatch(
    workerState,
    builder.create(state, new Set())
  );
  assert.deepEqual(
    validateState(JSON.parse(JSON.stringify(workerState))),
    state
  );
});

test('save batches coalesce updates, wait for an active stroke and acknowledge only the newest revision', () => {
  const { run, node, advanceTimers } = editingWorkspace();
  run(`globalThis.sent=[]; storageWorker={postMessage(message){sent.push(structuredClone(message))}};
    workerReady=true; save=realSave; save(); save(); save();`);
  advanceTimers(120);
  assert.equal(run('sent.length'), 1);
  assert.equal(run('sent[0].revision'), 3);
  run('saved(2)');
  assert.equal(node('saveStatus').textContent, 'Сохраняется…');
  run('saved(3)');
  assert.equal(node('saveStatus').textContent, '✓ Сохранено');
  run('save()');
  const event = beginHeldStroke(node, roughLine);
  advanceTimers(120);
  assert.equal(run('sent.length'), 1);
  node('canvas').listeners.pointerup({
    ...event,
    type: 'pointerup',
    clientX: 200,
    clientY: 100
  });
  assert.equal(run('sent.length'), 2);
  assert.equal(run('sent[1].patch.changes[0].upserts[0].points.length'), 3);
});

test('fallback saving keeps at most one transaction in flight and writes the latest complete document', () => {
  const { run, advanceTimers, node } = editingWorkspace();
  run(`globalThis.writes=[]; globalThis.transactions=[];
    db={transaction(){const tx={objectStore(){return {put(snapshot){writes.push(structuredClone(snapshot))}}}};transactions.push(tx);return tx}};
    save=realSave;save();`);
  advanceTimers(120);
  assert.equal(run('writes.length'), 1);
  run(
    'current().elements.push({id:uid(),type:"text",text:"Новое",x:10,y:10,size:24,color:"#000"});save();save()'
  );
  advanceTimers(120);
  assert.equal(run('writes.length'), 1);
  run('transactions[0].oncomplete()');
  assert.equal(run('writes.length'), 2);
  assert.equal(run('writes[0].books[0].pages[0].elements.length'), 0);
  assert.equal(run('writes[1].books[0].pages[0].elements[0].text'), 'Новое');
  run('transactions[1].oncomplete()');
  assert.equal(node('saveStatus').textContent, '✓ Сохранено');
  run('db={transaction(){throw Error("Запись запрещена")}};save()');
  advanceTimers(120);
  assert.equal(node('saveStatus').textContent, 'Не сохранено');
  assert.equal(run('current().elements[0].text'), 'Новое');
});

test('an older save acknowledgement cannot mark an unfinished pen stroke as saved', () => {
  const { run, node, advanceTimers } = editingWorkspace();
  run('storageWorker={postMessage(){}};workerReady=true;save=realSave;save()');
  advanceTimers(120);
  const event = beginHeldStroke(node, roughLine);
  run('saved(1)');
  assert.equal(node('saveStatus').textContent, 'Сохраняется…');
  node('canvas').listeners.pointerup({
    ...event,
    type: 'pointerup',
    clientX: 200,
    clientY: 100
  });
  advanceTimers(120);
  run('saved(1)');
  assert.equal(node('saveStatus').textContent, 'Сохраняется…');
  run('saved(2)');
  assert.equal(node('saveStatus').textContent, '✓ Сохранено');
});

test('continuous-page activation preserves independent undo and redo without changing other sheets', () => {
  const { node, run } = editingWorkspace();
  drawLine(node, [
    { x: 30, y: 30 },
    { x: 90, y: 60 }
  ]);
  run(`globalThis.firstPage = state.activePage;
    const next = newPage('Следующий лист');
    book().pages.push(next); switchPage(next.id);`);
  drawLine(node, [
    { x: 130, y: 130 },
    { x: 190, y: 160 }
  ]);
  run('undo()');
  assert.equal(run('current().elements.length'), 0);
  run('activatePage(firstPage)');
  assert.equal(run('current().elements.length'), 1);
  assert.equal(run('undoStack.length'), 1);
  run('undo()');
  assert.equal(run('current().elements.length'), 0);
  run('activatePage(book().pages[1].id); redo()');
  assert.equal(run('current().elements.length'), 1);
  assert.equal(run('book().pages[0].elements.length'), 0);
  run(
    'activatePage(firstPage); redo(); validateState(JSON.parse(JSON.stringify(state)))'
  );
  assert.equal(run('current().elements.length'), 1);
});

test('page activation cannot interrupt a pen stroke and restored documents discard old undo', () => {
  const { node, run } = editingWorkspace();
  run(`globalThis.nextSheet = newPage(); book().pages.push(nextSheet);`);
  node('canvas').listeners.pointerdown({
    button: 0,
    pointerId: 1,
    clientX: 30,
    clientY: 30,
    preventDefault() {}
  });
  const originalPage = run('state.activePage');
  run('activatePage(nextSheet.id); switchPage(nextSheet.id)');
  assert.equal(run('state.activePage'), originalPage);
  node('canvas').listeners.pointerup({
    type: 'pointerup',
    pointerId: 1,
    clientX: 60,
    clientY: 60
  });
  run('activatePage(nextSheet.id); activatePage(book().pages[0].id)');
  assert.equal(run('undoStack.length'), 1);
  run(
    'state = validateState(JSON.parse(JSON.stringify(state))); switchPage(state.activePage)'
  );
  assert.equal(run('undoStack.length'), 0);
  assert.equal(run('redoStack.length'), 0);
  assert.equal(run('pageHistories.size'), 0);
  assert.equal(run('current().elements.length'), 1);
});

function pageStackWorkspace() {
  const frames = [];
  const nodes = [];
  const node = () => {
    const item = {
      children: [],
      dataset: {},
      style: { setProperty() {} },
      className: '',
      listeners: {},
      width: 0,
      height: 0,
      append(...children) {
        for (const child of children) {
          child.remove();
          child.parentElement = this;
          this.children.push(child);
        }
      },
      insertBefore(child, before) {
        child.remove();
        child.parentElement = this;
        const index = before
          ? this.children.indexOf(before)
          : this.children.length;
        this.children.splice(index, 0, child);
      },
      remove() {
        if (!this.parentElement) return;
        const siblings = this.parentElement.children;
        siblings.splice(siblings.indexOf(this), 1);
        this.parentElement = null;
      },
      getContext() {
        return {};
      },
      setAttribute(key, value) {
        this[key] = value;
      },
      addEventListener(name, handler) {
        this.listeners[name] = handler;
      },
      getBoundingClientRect() {
        if (!this.rect && this.className === 'page-surface') {
          const root = this.parentElement;
          const index = root.parentElement.children.indexOf(root);
          const top = index * 1610;
          return { top, bottom: top + 1550, left: 0, width: 1100, height: 1550 };
        }
        return (
          this.rect || {
            top: 0,
            bottom: 800,
            left: 0,
            width: 1100,
            height: 800
          }
        );
      }
    };
    nodes.push(item);
    return item;
  };
  const viewport = node(),
    container = node(),
    editor = node();
  let observer,
    blocked = false;
  const painted = [],
    activated = [];
  const context = vm.createContext({
    document: { createElement: node },
    window: { addEventListener() {} },
    requestAnimationFrame(callback) {
      frames.push(callback);
      return frames.length;
    },
    IntersectionObserver: class {
      constructor(callback) {
        observer = callback;
      }
      observe() {}
      unobserve() {}
    }
  });
  vm.runInContext(
    readFileSync(
      new URL('../dist/page-stack.mjs', import.meta.url),
      'utf8'
    ).replace(
      'export class PageStack',
      'globalThis.PageStack = class PageStack'
    ),
    context
  );
  const stack = new context.PageStack({
    viewport,
    container,
    editor,
    render: (_, page) => painted.push(page.id),
    activate: (id) => {
      activated.push(id);
      stack.setActive(id);
    },
    canActivate: () => !blocked
  });
  return {
    stack,
    viewport,
    container,
    editor,
    nodes,
    painted,
    activated,
    block(value) {
      blocked = value;
    },
    intersect(entries) {
      observer(
        entries.map(([id, isIntersecting]) => ({
          target: stack.sheets.get(id).root,
          isIntersecting
        }))
      );
    },
    frame() {
      const pending = frames.splice(0);
      for (const fn of pending) fn();
    }
  };
}

test('page stack allocates only nearby previews, releases distant bitmaps and keeps writing active until scrolling', () => {
  const w = pageStackWorkspace();
  const pages = Array.from({ length: 100 }, (_, i) => ({
    id: String(i),
    title: 'Лист ' + i
  }));
  w.stack.setPages(pages);
  w.stack.setActive('0');
  w.stack.sheets.get('0').surface.rect = { top: 0, bottom: 650 };
  w.stack.sheets.get('1').surface.rect = { top: 682, bottom: 1332 };
  w.intersect([
    ['0', true],
    ['1', true]
  ]);
  w.frame();
  assert.deepEqual(w.painted, ['1']);
  assert.equal(w.stack.sheets.get('99').preview, null);
  const bitmap = w.stack.sheets.get('1').preview;
  w.stack.setActive('1');
  w.frame();
  assert.equal(w.editor.parentElement, w.stack.sheets.get('1').surface);
  assert.equal(w.stack.activeId, '1');
  assert.equal(bitmap.width, 0);
  assert.deepEqual(w.activated, []);
  w.viewport.listeners.scroll();
  w.frame();
  assert.equal(w.stack.activeId, '0');
  w.intersect([['1', false]]);
  w.frame();
  assert.equal(w.stack.sheets.get('1').preview, null);
  const before = w.painted.length;
  w.block(true);
  w.stack.invalidate();
  w.frame();
  assert.equal(w.painted.length, before);
  w.block(false);
  w.stack.requestUpdate();
  w.frame();
});

test('page stack rebuilds replaced backup pages and removes deleted sheets without losing the editor', () => {
  const w = pageStackWorkspace();
  const first = { id: 'a', title: 'Первый' },
    second = { id: 'b', title: 'Второй' };
  w.stack.setPages([first, second]);
  w.stack.setActive('a');
  w.stack.setPages([{ ...first, title: 'Из копии' }, second]);
  w.stack.setActive('a');
  assert.equal(w.container.children.length, 2);
  assert.equal(w.editor.parentElement, w.stack.sheets.get('a').surface);
  assert.equal(w.stack.sheets.get('a').label.textContent, 'Страница 1');
  w.stack.setPages([second]);
  w.stack.setActive('b');
  assert.equal(w.container.children.length, 1);
  assert.equal(w.stack.sheets.has('a'), false);
  assert.equal(w.editor.parentElement, w.stack.sheets.get('b').surface);
});

test('scrolling far down selects the visible page before new observer entries arrive', () => {
  const w = pageStackWorkspace();
  w.stack.setPages([
    { id: 'first', title: 'Первый' },
    { id: 'last', title: 'Последний' }
  ]);
  w.stack.setActive('first');
  w.stack.sheets.get('first').surface.rect = { top: -2000, bottom: -450 };
  w.stack.sheets.get('last').surface.rect = { top: 40, bottom: 1590 };
  w.intersect([['first', true]]);
  w.frame();
  w.viewport.listeners.scroll();
  w.frame();
  assert.equal(w.stack.activeId, 'last');
  w.intersect([
    ['first', false],
    ['last', true]
  ]);
  w.frame();
  assert.equal(w.stack.activeId, 'last');
});

test('clipboard photos follow the cursor with zoom and scrolling and keep their original paste position during decoding', async () => {
  const workspace = editingWorkspace();
  const { node, run, windowListeners } = workspace;
  node('canvas').getBoundingClientRect = () => ({
    left: 100,
    top: -300,
    width: 550,
    height: 775
  });
  node('viewport').listeners.pointermove({ clientX: 225, clientY: 150 });
  run(`globalThis.finishDecode = null;
    globalThis.createImageBitmap = () => new Promise(resolve => {finishDecode = resolve});`);
  const pending = windowListeners.paste(
    clipboardEvent([{ type: 'image/png', size: 100 }])
  );
  node('viewport').listeners.pointermove({ clientX: 350, clientY: 250 });
  run('finishDecode({width:100,height:80,close(){}})');
  await pending;
  assert.equal(run('current().elements[0].x'), 250);
  assert.equal(run('current().elements[0].y'), 900);
  assert.equal(run('undoStack.length'), 1);
  run('undo()');
  assert.equal(run('current().elements.length'), 0);
  run('redo(); validateState(JSON.parse(JSON.stringify(state)))');
  assert.equal(run('current().elements[0].y'), 900);
});

test('object paste places the whole group at the cursor while duplicate keeps its small offset', () => {
  const { node, run, windowListeners } = editingWorkspace();
  run(`current().elements = [
    {id:uid(),type:'image',src:'data:image/png;base64,aGVsbG8=',x:20,y:30,w:100,h:80},
    {id:uid(),type:'text',text:'Подпись',x:40,y:140,size:20,color:'#000'}
  ]; selection=current().elements.map(e=>e.id);`);
  const copied = clipboardEvent();
  windowListeners.copy(copied);
  node('viewport').listeners.pointermove({ clientX: 400, clientY: 700 });
  windowListeners.paste(copied);
  assert.equal(run('selectionBounds().x'), 400);
  assert.equal(run('selectionBounds().y'), 700);
  assert.equal(run('current().elements[3].x-current().elements[2].x'), 20);
  assert.equal(run('current().elements[3].y-current().elements[2].y'), 110);
  node('viewport').listeners.pointermove({ clientX: 800, clientY: 1100 });
  node('duplicateObject').onclick();
  assert.equal(run('current().elements[4].x'), 424);
  assert.equal(run('current().elements[4].y'), 724);
  run('undo(); undo()');
  assert.equal(run('current().elements.length'), 2);
});

test('pasted images stay inside page edges and multiple images retain their stagger', async () => {
  const workspace = editingWorkspace();
  enableImageDecoding(workspace);
  const { node, run, windowListeners } = workspace;
  node('viewport').listeners.pointermove({ clientX: 1095, clientY: 1545 });
  await windowListeners.paste(
    clipboardEvent([{ type: 'image/png', size: 100, width: 100, height: 80 }])
  );
  assert.equal(run('current().elements[0].x'), 1000);
  assert.equal(run('current().elements[0].y'), 1470);
  node('viewport').listeners.pointermove({ clientX: 300, clientY: 600 });
  await windowListeners.paste(
    clipboardEvent([
      { type: 'image/png', size: 100, width: 100, height: 80 },
      { type: 'image/png', size: 100, width: 100, height: 80 }
    ])
  );
  assert.equal(run('current().elements[1].x'), 300);
  assert.equal(run('current().elements[1].y'), 600);
  assert.equal(run('current().elements[2].x'), 324);
  assert.equal(run('current().elements[2].y'), 624);
  assert.equal(run('undoStack.length'), 2);
});

test('paste targets the sheet under the cursor even when another sheet is active', async () => {
  const workspace = editingWorkspace();
  enableImageDecoding(workspace);
  const { node, run, windowListeners } = workspace;
  run(`globalThis.destination = newPage('Нижний лист'); book().pages.push(destination);
    const surface = {parentElement:{dataset:{pageId:destination.id}},
      getBoundingClientRect(){return {left:100,top:500,width:550,height:775}}};
    document.elementFromPoint = () => ({closest(){return surface}});
    pageStack = {sheets:new Map([[destination.id,{page:destination}]]),invalidate(){}};`);
  node('viewport').listeners.pointermove({ clientX: 200, clientY: 650 });
  await windowListeners.paste(
    clipboardEvent([{ type: 'image/png', size: 100, width: 100, height: 80 }])
  );
  assert.equal(run('state.activePage'), run('destination.id'));
  assert.equal(run('book().pages[0].elements.length'), 0);
  assert.equal(run('current().elements[0].x'), 200);
  assert.equal(run('current().elements[0].y'), 300);
});

test('paste without a sheet cursor uses the visible area and ignores pointer positions from replaced documents', async () => {
  const workspace = editingWorkspace();
  enableImageDecoding(workspace);
  const { node, run, windowListeners } = workspace;
  node('canvas').getBoundingClientRect = () => ({
    left: 0,
    top: -800,
    width: 1100,
    height: 1550
  });
  node('viewport').getBoundingClientRect = () => ({
    left: 0,
    top: 0,
    width: 1100,
    height: 600
  });
  node('viewport').listeners.pointermove({ clientX: 100, clientY: 100 });
  run('state=structuredClone(state)');
  await windowListeners.paste(
    clipboardEvent([{ type: 'image/png', size: 100, width: 100, height: 80 }])
  );
  assert.equal(run('current().elements[0].x'), 550);
  assert.equal(run('current().elements[0].y'), 1100);
});

test('page numbers follow the active sheet and its current order without renaming stored pages', () => {
  const { node, run } = editingWorkspace();
  run(`renderPageStack = () => {};
    current().title = 'Первые идеи';
    book().pages.push(newPage('Моё название'), newPage('Копия'));
    realRenderNav();`);
  assert.equal(node('sheetCrumb').textContent, 'Страница 1');
  run('activatePage(book().pages[2].id); realRenderNav()');
  assert.equal(node('sheetCrumb').textContent, 'Страница 3');
  run('book().pages.splice(0, 1); realRenderNav()');
  assert.equal(node('sheetCrumb').textContent, 'Страница 2');
  assert.equal(run('current().title'), 'Копия');
  run('validateState(JSON.parse(JSON.stringify(state)))');
  assert.doesNotMatch(
    readFileSync(new URL('../dist/index.html', import.meta.url), 'utf8'),
    /id="title"/
  );
});

test('scrolling to page two updates activation even while only page one is in the observer cache', () => {
  const w = pageStackWorkspace();
  w.stack.setPages([{ id: 'first' }, { id: 'second' }]);
  w.stack.setActive('first');
  w.stack.sheets.get('first').surface.rect = { top: -1500, bottom: 38 };
  w.stack.sheets.get('second').surface.rect = { top: 98, bottom: 1648 };
  w.intersect([['first', true]]);
  w.frame();
  w.viewport.listeners.scroll();
  w.frame();
  assert.equal(w.stack.activeId, 'second');
  assert.deepEqual(w.activated, ['second']);
  assert.equal(w.editor.parentElement, w.stack.sheets.get('second').surface);
  w.intersect([['second', true]]);
  w.frame();
  assert.equal(w.stack.activeId, 'second');
  // Scrolling back changes the active page in the other direction as well.
  w.stack.sheets.get('first').surface.rect = { top: -300, bottom: 1250 };
  w.stack.sheets.get('second').surface.rect = { top: 1310, bottom: 2860 };
  w.viewport.listeners.scroll();
  w.frame();
  assert.equal(w.stack.activeId, 'first');
});

test('scroll activation waits for a pen gesture and does not jump back after writing on a smaller visible sheet', () => {
  const w = pageStackWorkspace();
  w.stack.setPages([{ id: 'first' }, { id: 'second' }]);
  w.stack.setActive('first');
  w.stack.sheets.get('first').surface.rect = { top: -1500, bottom: 38 };
  w.stack.sheets.get('second').surface.rect = { top: 98, bottom: 1648 };
  w.block(true);
  w.viewport.listeners.scroll();
  w.frame();
  assert.equal(w.stack.activeId, 'first');
  w.block(false);
  w.stack.requestUpdate();
  w.frame();
  assert.equal(w.stack.activeId, 'second');
  w.stack.setActive('first');
  w.stack.requestUpdate();
  w.frame();
  assert.equal(w.stack.activeId, 'first');
});

test('active-page lookup reads only a small part of a long notebook', () => {
  const w = pageStackWorkspace();
  const pages = Array.from({ length: 1000 }, (_, i) => ({ id: String(i) }));
  w.stack.setPages(pages);
  w.stack.setActive('0');
  w.viewport.rect = { top: 800 * 1610, bottom: 800 * 1610 + 800 };
  let reads = 0;
  for (const sheet of w.stack.sheets.values()) {
    const measure = sheet.surface.getBoundingClientRect.bind(sheet.surface);
    sheet.surface.getBoundingClientRect = () => {
      reads++;
      return measure();
    };
  }
  w.viewport.listeners.scroll();
  w.frame();
  assert.equal(w.stack.activeId, '800');
  assert.ok(reads < 25, `layout reads: ${reads}`);
});

test('application DOM references still exist after changes to the page markup', () => {
  const app = readFileSync(new URL('../dist/app.js', import.meta.url), 'utf8');
  const html = readFileSync(new URL('../dist/index.html', import.meta.url), 'utf8');
  const ids = new Set(
    [...`${html} ${app}`.matchAll(/\bid="([^"]+)"/g)].map((match) => match[1])
  );
  for (const [, id] of app.matchAll(/\$\('([^']+)'\)/g)) {
    assert.ok(ids.has(id), `Missing HTML element: ${id}`);
  }
});

test('clipboard image paste works after choosing paper, thickness or pressure', async () => {
  for (const active of [
    { tagName: 'SELECT' },
    { tagName: 'INPUT', type: 'range' },
    { tagName: 'INPUT', type: 'checkbox' },
    { tagName: 'INPUT', type: 'color' }
  ]) {
    const workspace = editingWorkspace();
    enableImageDecoding(workspace);
    workspace.run(`document.activeElement = ${JSON.stringify(active)}`);
    workspace.node('viewport').listeners.pointermove({
      clientX: 200, clientY: 500
    });
    const event = clipboardEvent([
      { type: 'image/png', size: 100, width: 100, height: 80 }
    ]);
    await workspace.windowListeners.paste(event);
    assert.equal(event.prevented, true, JSON.stringify(active));
    assert.equal(workspace.run('current().elements[0].type'), 'image');
    assert.equal(workspace.run('current().elements[0].x'), 200);
    assert.equal(workspace.run('current().elements[0].y'), 500);
  }
});

test('native copying and object paste still work with the paper selector focused', async () => {
  const { run, node, windowListeners } = editingWorkspace();
  run(`current().elements.push({id:uid(),type:'text',x:20,y:20,size:24,color:'#000',text:'Заметка'});
    selection=[current().elements[0].id]; document.activeElement={tagName:'SELECT'};`);
  const event = clipboardEvent();
  windowListeners.copy(event);
  assert.equal(event.prevented, true);
  node('viewport').listeners.pointermove({ clientX: 300, clientY: 600 });
  await windowListeners.paste(event);
  assert.equal(run('current().elements.length'), 2);
  assert.equal(run('current().elements[1].x'), 300);
  assert.equal(run('current().elements[1].y'), 600);
});

test('legacy notebooks migrate into folders without copying or changing any note data', () => {
  const state = initialState();
  const document = state.books[0], page = document.pages[0];
  page.elements.push({id:uid(),type:'image',src:'data:image/png;base64,aGVsbG8=',x:20,y:30,w:100,h:80});
  const before = JSON.stringify(document.pages);
  migrateLibrary(state);
  assert.equal(state.version,1);
  assert.equal(state.folders.length,1);
  assert.equal(state.folders[0].name,document.name);
  assert.equal(document.folderId,state.folders[0].id);
  assert.equal(document.pages[0],page);
  assert.equal(JSON.stringify(document.pages),before);
  const migrated = JSON.stringify(state);
  migrateLibrary(state);
  assert.equal(JSON.stringify(state),migrated);
  assert.deepEqual(validateState(JSON.parse(migrated)),state);
});

test('nested folders, empty folders and documents survive worker patches and fallback snapshots', () => {
  const state = migrateLibrary(initialState());
  const patcher = new DocumentPatches();
  let stored = applyDocumentPatch(null,patcher.create(state,new Set()));
  const root=state.folders[0];
  const child={id:uid(),name:'Математика',parentId:root.id};
  const nested={id:uid(),name:'Алгебра',parentId:child.id};
  state.folders.push(child,nested,{id:uid(),name:'Пустая папка',parentId:root.id});
  const page=core.newPage();
  page.elements.push({id:uid(),type:'text',text:'Конспект',x:10,y:20,size:24,color:'#000'});
  state.books.push({id:uid(),name:'Урок',folderId:nested.id,pages:[page]});
  state.activePage=page.id;
  stored=applyDocumentPatch(stored,patcher.create(state,new Set([page.id])));
  assert.deepEqual(stored,state);
  assert.deepEqual(folderPath(state,nested.id).map(folder=>folder.name),['Моя тетрадь','Математика','Алгебра']);
  const snapshot=snapshotDocument(state);
  nested.name='Геометрия';
  assert.equal(snapshot.folders[2].name,'Алгебра');
  stored=applyDocumentPatch(stored,patcher.create(state,new Set()));
  assert.equal(stored.folders[2].name,'Геометрия');
  assert.deepEqual(validateState(JSON.parse(JSON.stringify(stored))),state);
});

test('invalid folder trees are rejected rather than hiding or losing documents', () => {
  for (const corrupt of [
    state=>state.folders[0].parentId=state.folders[0].id,
    state=>state.folders[0].parentId='missing',
    state=>state.books[0].folderId='missing',
    state=>state.folders.push({...state.folders[0]}),
    state=>{const child={id:uid(),name:'Child',parentId:state.folders[0].id};state.folders.push(child);state.folders[0].parentId=child.id;}
  ]) {
    const state=migrateLibrary(initialState());corrupt(state);
    assert.throws(()=>validateState(state));
  }
});

function closeWorkspaceDialog(workspace, value='ok', text) {
  if (text !== undefined) {
    const body=workspace.node('dialogBody').children[0];
    const input=body.className==='document-setup' ? body.children[0].children[0] : body;
    input.value=text;
  }
  workspace.node('dialog').returnValue=value;
  workspace.node('dialog').onclose();
  workspace.node('dialog').open=false;
}

test('root notebooks, nested folders and new canvas documents preserve the original document', async () => {
  const workspace=editingWorkspace();
  const {run}=workspace;
  run("current().elements.push({id:uid(),type:'text',text:'Сохранить',x:10,y:20,size:24,color:'#000'})");
  const original=run('JSON.stringify(current())');
  let pending=run('createFolder()');
  closeWorkspaceDialog(workspace,'ok','Учёба');await pending;
  const rootId=run('selectedFolderId');
  pending=run('createFolder(selectedFolderId)');
  closeWorkspaceDialog(workspace,'ok','Математика');await pending;
  const childId=run('selectedFolderId');
  assert.equal(run('state.folders.at(-1).parentId'),rootId);
  pending=run('createDocument()');
  closeWorkspaceDialog(workspace,'ok','Урок 1');await pending;
  assert.equal(run('book().folderId'),childId);
  assert.equal(run('book().name'),'Урок 1');
  assert.equal(run('current().elements.length'),0);
  assert.equal(run('JSON.stringify(state.books[0].pages[0])'),original);
  run('validateState(JSON.parse(JSON.stringify(state)))');
});

test('page deletion requires confirmation, opens a neighbouring page and keeps other documents intact', () => {
  const workspace=editingWorkspace();const {node,run}=workspace;
  run(`book().pages.push(newPage('Вторая'),newPage('Третья'));
    const other=newPage(); other.elements.push({id:uid(),type:'text',text:'Не трогать',x:10,y:20,size:24,color:'#000'});
    state.books.push({id:uid(),name:'Другая',pages:[other]});
    switchPage(state.books[0].pages[1].id);`);
  const before=run('JSON.stringify(state)');
  run('confirmDeletePage()');
  closeWorkspaceDialog(workspace,'cancel');
  assert.equal(run('JSON.stringify(state)'),before);
  const next=run('book().pages[2].id');
  run('confirmDeletePage()');closeWorkspaceDialog(workspace);
  assert.equal(run('book().pages.length'),2);
  assert.equal(run('state.activePage'),next);
  assert.equal(run('state.books[1].pages[0].elements[0].text'),'Не трогать');
  run('confirmDeletePage()');closeWorkspaceDialog(workspace);
  run('confirmDeletePage()');closeWorkspaceDialog(workspace);
  assert.equal(run('book().pages.length'),1);
  assert.equal(run('current().elements.length'),0);
  assert.equal(run('pageHistories.has(state.activePage)'),false);
  run('validateState(JSON.parse(JSON.stringify(state)))');
});

test('deleting folders requires confirmation, removes descendants and preserves unrelated notes', async () => {
  const workspace = editingWorkspace();
  const { run } = workspace;
  run(`migrateLibrary(state);
    globalThis.originalFolder = book().folderId;
    current().elements.push({id:uid(),type:'text',text:'Сохранить',x:10,y:20,size:24,color:'#000'});
    globalThis.originalPages = JSON.stringify(book().pages);
    globalThis.root = {id:uid(),name:'Удалить',parentId:null};
    globalThis.child = {id:uid(),name:'Вложенная',parentId:root.id};
    state.folders.push(root, child);
    globalThis.removedPage = newPage();
    state.books.push({id:uid(),name:'Черновик',folderId:child.id,pages:[removedPage]});
    switchPage(removedPage.id);`);
  const before = run('JSON.stringify(state)');
  run("confirmDeleteLibraryItem('folder', root.id)");
  closeWorkspaceDialog(workspace, 'cancel');
  assert.equal(run('JSON.stringify(state)'), before);
  run("confirmDeleteLibraryItem('folder', root.id)");
  closeWorkspaceDialog(workspace);
  assert.equal(run('state.books.length'), 1);
  assert.equal(run('state.folders.length'), 1);
  assert.equal(run('book().folderId'), run('originalFolder'));
  assert.equal(run('JSON.stringify(book().pages)'), run('originalPages'));
  assert.equal(run('pageHistories.has(removedPage.id)'), false);
  run('validateState(JSON.parse(JSON.stringify(state)))');
});

test('deleting inactive documents keeps the active page; deleting the last document keeps a valid workspace', () => {
  const workspace = editingWorkspace();
  const { run } = workspace;
  run(`migrateLibrary(state);
    globalThis.originalPage = state.activePage;
    globalThis.extra = {id:uid(),name:'Другой',folderId:book().folderId,pages:[newPage()]};
    state.books.push(extra);`);
  run("confirmDeleteLibraryItem('document', extra.id)");
  closeWorkspaceDialog(workspace);
  assert.equal(run('state.activePage'), run('originalPage'));
  run('globalThis.deletedDocument = book().id');
  run("confirmDeleteLibraryItem('document', deletedDocument)");
  closeWorkspaceDialog(workspace);
  assert.equal(run('state.books.length'), 1);
  assert.notEqual(run('book().id'), run('deletedDocument'));
  assert.equal(run('current().elements.length'), 0);
  run("confirmDeleteLibraryItem('folder', book().folderId)");
  closeWorkspaceDialog(workspace);
  assert.equal(run('state.folders.length'), 1);
  assert.equal(run('state.books.length'), 1);
  assert.equal(run('current().elements.length'), 0);
  run('validateState(JSON.parse(JSON.stringify(state)))');
});

test('a deletion confirmation from a replaced workspace cannot delete its new data', () => {
  const workspace = editingWorkspace();
  const { run } = workspace;
  run('migrateLibrary(state)');
  run("confirmDeleteLibraryItem('document', book().id)");
  run('state=migrateLibrary(initialState()); globalThis.replaced=JSON.stringify(state)');
  closeWorkspaceDialog(workspace);
  assert.equal(run('JSON.stringify(state)'), run('replaced'));
});

test('optional covers preserve version:1 notes across JSON, worker metadata updates and fallback snapshots', () => {
  const state = migrateLibrary(initialState());
  const pages = JSON.stringify(state.books[0].pages);
  const patcher = new DocumentPatches();
  let stored = applyDocumentPatch(null, patcher.create(state, new Set()));
  state.folders[0].cover = {color:'#abc4d4'};
  state.books[0].cover = {color:'#6e927e',image:'data:image/png;base64,aGVsbG8='};
  stored = applyDocumentPatch(stored, patcher.create(state, new Set()));
  assert.deepEqual(stored, state);
  assert.deepEqual(validateState(JSON.parse(JSON.stringify(stored))), state);
  assert.equal(JSON.stringify(stored.books[0].pages), pages);
  const snapshot = snapshotDocument(state);
  const unchanged = patcher.create(state, new Set());
  assert.equal(unchanged.folders[0].cover, undefined);
  assert.equal(unchanged.books[0].cover, undefined);
  assert.equal(unchanged.books[0].coverUnchanged, true);
  assert.deepEqual(applyDocumentPatch(stored, unchanged), state);
  // Replacing a cover sends its content once; later pen saves reuse it in the worker.
  state.folders[0].cover = { ...state.folders[0].cover };
  state.books[0].cover = { ...state.books[0].cover };
  const pending = patcher.create(state, new Set());
  state.folders[0].cover.color = '#d5b5a4';
  state.books[0].cover.image = 'data:image/webp;base64,YQ==';
  assert.equal(snapshot.folders[0].cover.color, '#abc4d4');
  assert.equal(snapshot.books[0].cover.image, 'data:image/png;base64,aGVsbG8=');
  assert.equal(pending.folders[0].cover.color, '#abc4d4');
  assert.equal(pending.books[0].cover.image, 'data:image/png;base64,aGVsbG8=');
  delete state.folders[0].cover;
  delete state.books[0].cover;
  stored = applyDocumentPatch(stored, patcher.create(state, new Set()));
  assert.equal(stored.folders[0].cover, undefined);
  assert.equal(stored.books[0].cover, undefined);
  assert.equal(JSON.stringify(stored.books[0].pages), pages);
  assert.deepEqual(validateState(initialState()).version, 1);
});

test('backup cover validation rejects invalid colours, remote images, SVG and oversized image data', () => {
  for (const value of [null, [], 'red', {color:'red'}, {color:'#abc'}, {image:42},
    {image:'https://example.com/cover.png'}, {image:'data:image/svg+xml;base64,YQ=='},
    {image:'data:image/png;base64,' + 'a'.repeat(4_000_000)}]) {
    for (const target of ['folder','document']) {
      const state = migrateLibrary(initialState());
      (target === 'folder' ? state.folders[0] : state.books[0]).cover = value;
      assert.throws(() => validateState(state));
    }
  }
});

test('folder artwork fitting ignores outer white or transparent padding without changing the image', () => {
  for (const alpha of [0, 255]) {
    const width = 10, height = 8;
    const data = new Uint8ClampedArray(width * height * 4).fill(255);
    for (let index = 3; index < data.length; index += 4) data[index] = alpha;
    for (let y = 2; y < 7; y++) for (let x = 1; x < 9; x++) {
      data.set([180, 130, 100, 255], (y * width + x) * 4);
    }
    const original = data.slice();
    assert.deepEqual(coverArtworkBounds({data, width, height}), {x:0.1, y:0.25, width:0.8, height:0.625});
    assert.deepEqual(data, original);
  }
});

test('folder fitting keeps full-bleed artwork, blank images and coloured borders intact', () => {
  for (const colour of [[20,80,50,255], [255,255,255,255], [0,0,0,0], [220,120,160,255]]) {
    const data = new Uint8ClampedArray(8 * 6 * 4);
    for (let i = 0; i < data.length; i += 4) data.set(colour, i);
    assert.deepEqual(coverArtworkBounds({data, width:8, height:6}), {x:0,y:0,width:1,height:1});
  }
});

test('folder tab fitting fills outside gaps with edge colours and preserves the original artwork', () => {
  for (const alpha of [0, 255]) {
    const width=6, height=4;
    const data=new Uint8ClampedArray(width*height*4).fill(255);
    for(let i=3;i<data.length;i+=4)data[i]=alpha;
    data.set([196,135,145,255],(1*width+1)*4);
    data.set([196,135,145,255],(1*width+4)*4);
    data.set([255,255,255,255],(1*width+2)*4);
    data.set([175,190,160,255],(3*width+2)*4);
    data.set([175,190,160,255],(3*width+3)*4);
    const original=data.slice();
    const output=extendCoverArtworkEdges({data,width,height});
    assert.deepEqual(Array.from(output.slice(1*width*4,1*width*4+4)),[196,135,145,255]);
    assert.deepEqual(Array.from(output.slice((1*width+5)*4,(1*width+5)*4+4)),[196,135,145,255]);
    assert.deepEqual(Array.from(output.slice((1*width+2)*4,(1*width+2)*4+4)),[255,255,255,255]);
    assert.deepEqual(data,original);
  }
});

test('folder front crop removes a narrow upper tab but keeps a rectangular photo whole', () => {
  const width=100, height=80;
  const data=new Uint8ClampedArray(width*height*4).fill(255);
  const fill=(left,top,w,h,colour)=>{
    for(let y=top;y<top+h;y++)for(let x=left;x<left+w;x++)data.set(colour,(y*width+x)*4);
  };
  fill(5,5,30,20,[190,100,130,255]);
  fill(5,20,90,10,[190,100,130,255]);
  fill(2,30,96,45,[120,160,190,255]);
  const before=data.slice();
  const cropped=folderFrontBounds({data,width,height});
  assert.equal(cropped.y,0.375);
  assert.equal(cropped.height,0.5625);
  assert.deepEqual(data,before);
  fill(0,0,100,80,[120,160,190,255]);
  assert.deepEqual(folderFrontBounds({data,width,height}),{x:0,y:0,width:1,height:1});
});

test('independent tab colours survive metadata saves and JSON without modifying the folder image or notes', () => {
  const state=migrateLibrary(initialState());
  const image='data:image/png;base64,aGVsbG8=';
  state.folders[0].cover={image,color:'#d4b0c1'};
  const pages=structuredClone(state.books);
  const patcher=new DocumentPatches();
  let stored=applyDocumentPatch(null,patcher.create(state,new Set()));
  state.folders[0].cover={...state.folders[0].cover,tabColor:'#7b5367'};
  stored=applyDocumentPatch(stored,patcher.create(state,new Set()));
  assert.deepEqual(validateState(JSON.parse(JSON.stringify(stored))),state);
  assert.equal(stored.folders[0].cover.image,image);
  assert.equal(stored.folders[0].cover.tabColor,'#7b5367');
  assert.deepEqual(stored.books,pages);
  const snapshot=snapshotDocument(state);
  state.folders[0].cover={...state.folders[0].cover};delete state.folders[0].cover.tabColor;
  stored=applyDocumentPatch(stored,patcher.create(state,new Set()));
  assert.equal(stored.folders[0].cover.tabColor,undefined);
  assert.equal(snapshot.folders[0].cover.tabColor,'#7b5367');
  assert.equal(stored.folders[0].cover.image,image);
  for(const value of ['pink','#fff',null,123,'url(x)']) {
    const invalid=structuredClone(state);invalid.folders[0].cover.tabColor=value;
    assert.throws(()=>validateState(invalid));
  }
});


test('document spine colour survives persistence and JSON while retaining image and pages', () => {
  const state=migrateLibrary(initialState());
  const image='data:image/png;base64,aGVsbG8=';
  state.books[0].cover={image,color:'#d4b0c1'};
  const pages=structuredClone(state.books[0].pages);
  const patcher=new DocumentPatches();
  let stored=applyDocumentPatch(null,patcher.create(state,new Set()));
  state.books[0].cover={...state.books[0].cover,spineColor:'#7b5367'};
  stored=applyDocumentPatch(stored,patcher.create(state,new Set()));
  assert.deepEqual(validateState(JSON.parse(JSON.stringify(stored))),state);
  assert.deepEqual(stored.books[0].pages,pages);
  assert.equal(stored.books[0].cover.image,image);
  const snapshot=snapshotDocument(state);
  state.books[0].cover={...state.books[0].cover};delete state.books[0].cover.spineColor;
  stored=applyDocumentPatch(stored,patcher.create(state,new Set()));
  assert.equal(stored.books[0].cover.spineColor,undefined);
  assert.equal(snapshot.books[0].cover.spineColor,'#7b5367');
  assert.equal(validateState(JSON.parse(JSON.stringify(stored))).books[0].cover.image,image);
  for(const value of ['pink','#fff',null,123,'url(x)']) {
    const invalid=structuredClone(state);invalid.books[0].cover.spineColor=value;
    assert.throws(()=>validateState(invalid));
  }
});

test('page paper colours round-trip through worker patches, snapshots and legacy JSON without changing notes', () => {
  const state=initialState();
  state.books[0].pages[0].elements=[
    {id:uid(),type:'stroke',tool:'pen',color:'#28303b',size:3,points:[{x:20,y:30,p:0.5}]},
    {id:uid(),type:'image',src:'data:image/png;base64,aGVsbG8=',x:20,y:40,w:100,h:80}
  ];
  state.books[0].pages.push(core.newPage('Второй лист'));
  const legacy=JSON.stringify(state);
  assert.deepEqual(validateState(JSON.parse(legacy)),state);
  const originalElements=structuredClone(state.books[0].pages.map(page=>page.elements));
  const patcher=new DocumentPatches();
  let stored=applyDocumentPatch(null,patcher.create(state,new Set()));
  for (const paperColor of ['black','yellow','white']) {
    state.books[0].pages[0].paperColor=paperColor;
    const patch=patcher.create(state,new Set());
    assert.equal(patch.changes.length,0);
    stored=applyDocumentPatch(stored,patch);
    assert.deepEqual(validateState(JSON.parse(JSON.stringify(stored))),state);
    assert.equal(snapshotDocument(state).books[0].pages[0].paperColor,paperColor);
    assert.equal(stored.books[0].pages[1].paperColor,undefined);
    assert.deepEqual(stored.books[0].pages.map(page=>page.elements),originalElements);
  }
  for(const value of ['red','#ffffff',null,12,{}]) {
    const invalid=structuredClone(state);invalid.books[0].pages[0].paperColor=value;
    assert.throws(()=>validateState(invalid));
  }
  assert.equal(validateState(JSON.parse(legacy)).books[0].pages[0].paperColor,undefined);
});


test('new canvas documents use the chosen layout and colour; cancellation and replaced workspaces create nothing', async () => {
  const workspace=editingWorkspace();const {run,node}=workspace;
  run('migrateLibrary(state)');
  const original=run('JSON.stringify(state.books)');
  let pending=run('createDocument()');
  closeWorkspaceDialog(workspace,'cancel');await pending;
  assert.equal(run('JSON.stringify(state.books)'),original);
  for (const paper of ['grid','dots','lines','blank']) for (const colour of ['white','yellow','black']) {
    pending=run('createDocument()');
    const form=node('dialogBody').children[0];
    form.children[1].children[0].value=paper;
    form.children[2].children[0].value=colour;
    closeWorkspaceDialog(workspace,'ok','  Занятие  ');await pending;
    assert.equal(run('book().name'),'Занятие');
    assert.equal(run('current().paper'),paper);
    assert.equal(run('current().paperColor'),colour);
    assert.equal(run('current().elements.length'),0);
    run('validateState(JSON.parse(JSON.stringify(state)))');
  }
  assert.equal(run('JSON.stringify(state.books.slice(0,1))'),original);
  pending=run('createDocument()');
  run('state=migrateLibrary(initialState())');
  const replacement=run('JSON.stringify(state)');
  closeWorkspaceDialog(workspace,'ok','Поздно');await pending;
  assert.equal(run('JSON.stringify(state)'),replacement);
});

test('unreadable or invalid storage never opens a starter notebook or overwrites the stored entry', async () => {
  for(const failure of ['open','read','invalid']) {
    const workspace=editingWorkspace();const {run,node}=workspace;
    run(`state=undefined; globalThis.location={origin:'http://127.0.0.1:8000'};
      globalThis.openRequest={};globalThis.readRequest={};globalThis.readTx={objectStore(){return {get(){return readRequest}}}};
      globalThis.writes=0;globalThis.closed=false;
      globalThis.storedValue={version:999,books:[{name:'Не терять'}]};
      globalThis.fakeDB={close(){closed=true},transaction(mode){if(mode!=='workspace')throw Error('unexpected');return readTx}};
      globalThis.indexedDB={open(){${failure==='open' ? "throw Error('Чтение запрещено')" : 'return openRequest'}}};`);
    const pending=run('loadWorkspace()');
    if(failure!=='open') {
      run('openRequest.result=fakeDB;openRequest.onsuccess()');
      await Promise.resolve();
      if(failure==='read') run("readTx.error=Error('Ошибка чтения');readTx.onabort()");
      else run('readRequest.result=storedValue;readTx.oncomplete()');
    }
    await pending;
    assert.equal(run('state'),undefined);
    assert.equal(node('saveStatus').textContent,'Не удалось загрузить');
    assert.equal(node('storageNotice').hidden,false);
    assert.equal(node('newBook').disabled,true);
    assert.equal(run('storageWritable'),false);
    if(failure==='invalid') assert.equal(run('JSON.stringify(loadedBackup)'),run('JSON.stringify(storedValue)'));
  }
});

test('failed strict writes keep notes in memory, show a persistent error and retry only acknowledges commit', () => {
  const {run,node,advanceTimers}=editingWorkspace();
  run(`globalThis.transactions=[];globalThis.modes=[];
    db={transaction(...args){modes.push(args);const tx={objectStore(){return {put(){}}}};transactions.push(tx);return tx}};
    current().elements.push({id:uid(),type:'text',text:'Сохранить меня',x:10,y:20,size:24,color:'#000'});
    save=realSave;save();`);
  advanceTimers(120);
  assert.equal(run('modes[0][2].durability'),'strict');
  assert.equal(node('saveStatus').textContent,'Сохраняется…');
  run("transactions[0].error={name:'QuotaExceededError'};transactions[0].onabort()");
  assert.equal(node('saveStatus').textContent,'Не сохранено');
  assert.equal(node('storageNotice').hidden,false);
  assert.match(node('storageMessage').textContent,/не хватает места/);
  assert.equal(run('current().elements[0].text'),'Сохранить меня');
  node('retrySave').onclick();
  assert.equal(node('saveStatus').textContent,'Сохраняется…');
  run('transactions[1].oncomplete()');
  assert.equal(node('saveStatus').textContent,'✓ Сохранено');
  assert.equal(node('storageNotice').hidden,true);
});

test('a stalled storage worker falls back to a complete IndexedDB write', () => {
  const {run,node,advanceTimers}=editingWorkspace();
  run(`globalThis.workerTerminated=false;globalThis.transactions=[];globalThis.writes=[];
    globalThis.Worker=class {postMessage(){} terminate(){workerTerminated=true}};
    db={transaction(){const tx={objectStore(){return {put(data){writes.push(structuredClone(data))}}}};transactions.push(tx);return tx}};
    startStorageWorker(false);save=realSave;save();`);
  advanceTimers(120);
  assert.equal(run('writes.length'),0);
  advanceTimers(5000);
  assert.equal(run('workerTerminated'),true);
  assert.equal(run('writes.length'),1);
  assert.equal(node('saveStatus').textContent,'Сохраняется…');
  run('transactions[0].oncomplete()');
  assert.equal(node('saveStatus').textContent,'✓ Сохранено');
});


test('a late acknowledgement cannot hide an error after storage becomes unavailable', () => {
  const {run,node}=editingWorkspace();
  run('saveRevision=3;storageWritable=false;saveFailed();saved(3)');
  assert.equal(node('saveStatus').textContent,'Не сохранено');
  assert.equal(node('storageNotice').hidden,false);
});

test('a valid full backup is not rejected solely by the former 150 MB file size limit', async () => {
  const workspace=editingWorkspace();const {run,node}=workspace;
  run('globalThis.backupText=JSON.stringify(initialState())');
  await run(`document.getElementById('restoreInput').onchange({target:{value:'',files:[{size:151*1024*1024,text:async()=>backupText}]}})`);
  assert.equal(node('dialog').open,true);
  assert.equal(node('dialogTitle').textContent,'Восстановить тетради?');
  closeWorkspaceDialog(workspace,'cancel');
});


test('added pages inherit the active sheet layout and colour without copying notes or changing other pages', () => {
  const {run,node}=editingWorkspace();
  run(`current().elements.push({id:uid(),type:'text',text:'Оставить здесь',x:10,y:20,size:24,color:'#000'});
    globalThis.originalId=current().id;`);
  for(const paper of ['grid','dots','lines','blank']) for(const colour of ['white','yellow','black']) {
    run(`current().paper='${paper}';current().paperColor='${colour}'`);
    const previous=run('JSON.stringify(book().pages)');
    const count=run('book().pages.length');
    node('addPageBottom').onclick();
    assert.equal(run('book().pages.length'),count+1);
    assert.equal(run('current().paper'),paper);
    assert.equal(run('current().paperColor'),colour);
    assert.equal(run('current().elements.length'),0);
    assert.equal(run('JSON.stringify(book().pages.slice(0,-1))'),previous);
  }
  // The active page can be an earlier sheet rather than the last one.
  run("switchPage(originalId);current().paper='lines';delete current().paperColor");
  node('addPageBottom').onclick();
  assert.equal(run('current().paper'),'lines');
  assert.equal(run('current().paperColor'),undefined);
  assert.equal(run('book().pages[0].elements[0].text'),'Оставить здесь');
  run('validateState(JSON.parse(JSON.stringify(state)))');
});

test('aspect-preserving image resize keeps its anchor and fits the page for every handle', () => {
  const r={x:200,y:200,w:160,h:80};
  for(let row=0;row<3;row++)for(let column=0;column<3;column++) {
    if(row===1&&column===1)continue;
    const handle={row,column};
    const anchorX=r.x+(column===0?r.w:column===1?r.w/2:0);
    const anchorY=r.y+(row===0?r.h:row===1?r.h/2:0);
    const point={x:column===0?anchorX-r.w*1.5:column===2?anchorX+r.w*1.5:anchorX,
      y:row===0?anchorY-r.h*1.5:row===2?anchorY+r.h*1.5:anchorY};
    const result=core.aspectResizeBounds(r,handle,point);
    assert.equal(result.w,240);assert.equal(result.h,120);
    assert.equal(result.x+(column===0?result.w:column===1?result.w/2:0),anchorX);
    assert.equal(result.y+(row===0?result.h:row===1?result.h/2:0),anchorY);
    for(const extreme of [{x:-5000,y:-5000},{x:5000,y:5000}, {x:anchorX,y:anchorY}]) {
      const bounded=core.aspectResizeBounds(r,handle,extreme);
      assert.ok(Math.abs(bounded.w/bounded.h-2)<1e-9);
      assert.ok(bounded.x>=-1e-9&&bounded.y>=-1e-9);
      assert.ok(bounded.x+bounded.w<=core.W+1e-9&&bounded.y+bounded.h<=core.H+1e-9);
      assert.ok(bounded.w>=8&&bounded.h>=8);
    }
  }
});

test('Shift scales a photo proportionally, can be released mid-drag, and keeps undo and photo data intact', () => {
  const {run,node}=editingWorkspace();
  run(`current().elements=[{id:uid(),type:'image',src:'data:image/png;base64,aGVsbG8=',x:200,y:200,w:200,h:100}];
    setTool('select');selection=[current().elements[0].id];`);
  const original=run('JSON.stringify(current().elements[0])');
  const event={button:0,pointerId:1,preventDefault(){}};
  node('canvas').listeners.pointerdown({...event,clientX:400,clientY:300,shiftKey:true});
  assert.equal(run('gesture.type'),'resize-selection');
  node('canvas').listeners.pointermove({...event,clientX:500,clientY:310,shiftKey:true});
  assert.equal(run('current().elements[0].w'),300);
  assert.equal(run('current().elements[0].h'),150);
  node('canvas').listeners.pointermove({...event,clientX:500,clientY:310,shiftKey:false});
  assert.ok(Math.abs(run('current().elements[0].h')-110)<1e-9);
  node('canvas').listeners.pointermove({...event,clientX:500,clientY:310,shiftKey:true});
  node('canvas').listeners.pointerup({...event,type:'pointerup',shiftKey:true});
  assert.equal(run('current().elements[0].w/current().elements[0].h'),2);
  assert.equal(run('current().elements[0].src'),'data:image/png;base64,aGVsbG8=');
  assert.equal(run('undoStack.length'),1);
  run('undo()');
  assert.equal(run('JSON.stringify(current().elements[0])'),original);
  run('redo();validateState(JSON.parse(JSON.stringify(state)))');
  assert.equal(run('current().elements[0].w/current().elements[0].h'),2);
});

test('undo and redo keyboard shortcuts work across layouts and focused canvas controls', () => {
  for (const active of [
    {tagName:'BODY'}, {tagName:'SELECT'}, {tagName:'INPUT',type:'range'},
    {tagName:'INPUT',type:'checkbox'}, {tagName:'INPUT',type:'color'}
  ]) for (const keys of [['z','y'],['я','н']]) for (const modifier of ['ctrlKey','metaKey']) {
    const {run,node,windowListeners}=editingWorkspace();
    drawLine(node,[{x:100,y:100},{x:150,y:130}]);
    const original=run('JSON.stringify(current().elements)');
    run(`document.activeElement=${JSON.stringify(active)}`);
    function press(key,code,shiftKey=false) {
      const event={key,code,[modifier]:true,shiftKey,prevented:false,preventDefault(){this.prevented=true}};
      windowListeners.keydown(event);
      assert.equal(event.prevented,true);
    }
    press(keys[0],'KeyZ');
    assert.equal(run('current().elements.length'),0);
    press(keys[0],'KeyZ',true);
    assert.equal(run('JSON.stringify(current().elements)'),original);
    press(keys[0],'KeyZ');
    press(keys[1],'KeyY');
    assert.equal(run('JSON.stringify(current().elements)'),original);
  }
});

test('canvas undo shortcuts leave native text editing, dialogs and active gestures alone', () => {
  for (const guard of [
    `document.activeElement={tagName:'INPUT',type:'text'}`,
    `document.activeElement={tagName:'TEXTAREA'}`,
    `document.activeElement={tagName:'DIV',isContentEditable:true}`,
    `$('dialog').open=true`, `gesture={type:'stroke'}`,
    `viewMode='library'`
  ]) {
    const {run,node,windowListeners}=editingWorkspace();
    drawLine(node,[{x:100,y:100},{x:150,y:130}]);
    run(guard);
    const event={key:'я',code:'KeyZ',ctrlKey:true,prevented:false,preventDefault(){this.prevented=true}};
    windowListeners.keydown(event);
    assert.equal(event.prevented,false,guard);
    assert.equal(run('current().elements.length'),1,guard);
  }
});

test('interface accent loads safely before paint without touching notes or writing storage', () => {
  const source=readFileSync(new URL('../dist/theme.js',import.meta.url),'utf8');
  for(const saved of ['#228855','#FFFFFF','#000000','invalid','red;display:none',null]) {
    const root={dataset:{},style:{setProperty(k,v){this[k]=v}}};
    const context=vm.createContext({window:{},document:{documentElement:root,querySelector:()=>({})},
      localStorage:{getItem:k=>k==='vibenotes-accent'?saved:'dark',setItem(){throw Error('unexpected write')}}});
    vm.runInContext(source,context);
    assert.equal(root.dataset.theme,'dark');
    assert.equal(root.dataset.accent,/^#[0-9a-f]{6}$/i.test(saved||'')?saved.toLowerCase():'#df82b1');
    assert.equal(root.style['--accent'],root.dataset.accent);
    assert.equal(root.style['--accent-ink'],saved==='#FFFFFF'?'#201b22':'#ffffff');
  }
  const root={dataset:{},style:{setProperty(){}}};
  vm.runInNewContext(source,{window:{},document:{documentElement:root,querySelector:()=>({})},
    localStorage:{getItem(){throw Error('blocked')}}});
  assert.equal(root.dataset.theme,'light');
  assert.equal(root.dataset.accent,'#df82b1');
});

test('sidebar folders collapse on repeat activation and stay collapsed after rendering without changing notes', () => {
  const {run,node}=editingWorkspace();
  run("viewMode='library';renderNav=()=>renderLibrary();renderLibrary()");
  const before=run('JSON.stringify(state)');
  const folderId=run('state.folders[0].id');
  const root=()=>node('books').children.find(detail=>detail.dataset.folderId===folderId);
  const activate=()=>root().children[0].onclick({preventDefault(){}});
  assert.equal(root().open,false);
  activate();
  assert.equal(root().open,true);
  assert.equal(run(`expandedFolders.has('${folderId}')`),true);
  activate();
  assert.equal(root().open,false);
  assert.equal(run(`expandedFolders.has('${folderId}')`),false);
  run('renderLibrary()');
  assert.equal(root().open,false);
  activate();
  assert.equal(root().open,true);
  run("viewMode='editor'");
  const activePage=run('state.activePage');
  activate();
  assert.equal(root().open,false);
  assert.equal(run('viewMode'),'editor');
  assert.equal(run('state.activePage'),activePage);
  assert.equal(run('JSON.stringify(state)'),before);
});
