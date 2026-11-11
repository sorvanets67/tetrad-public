// Uses its own temporary Chrome profile. Never connects to the user's browser.
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdtemp, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const baseURL = process.argv[2] || 'http://127.0.0.1:8000/';
assert.ok(['localhost', '127.0.0.1'].includes(new URL(baseURL).hostname));
const profile = await mkdtemp(join(tmpdir(), 'tetrad-smoke-'));
const chrome = spawn(process.env.CHROME_BIN || 'google-chrome-stable', [
  '--headless', '--no-sandbox', '--disable-gpu', '--disable-background-networking',
  '--no-first-run', '--no-default-browser-check', '--window-size=1440,1100',
  '--remote-debugging-address=127.0.0.1', '--remote-debugging-port=0',
  `--user-data-dir=${profile}`, 'about:blank'
], { stdio: 'ignore' });
const delay = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
let socket, launchError;
chrome.on('error', (error) => { launchError = error; });

try {
  let port;
  for (let attempt = 0; attempt < 100; attempt++) {
    if (launchError) throw launchError;
    try {
      port = (await readFile(join(profile, 'DevToolsActivePort'), 'utf8')).split('\n')[0];
      break;
    } catch { await delay(100); }
  }
  assert.ok(port, 'Test Chrome did not start');
  const targets = await (await fetch(`http://127.0.0.1:${port}/json/list`)).json();
  socket = new WebSocket(targets.find((target) => target.type === 'page').webSocketDebuggerUrl);
  await new Promise((resolve) => socket.addEventListener('open', resolve, { once: true }));
  let sequence = 0;
  const pending = new Map();
  socket.addEventListener('message', (event) => {
    const message = JSON.parse(event.data);
    if (message.id) pending.get(message.id)?.(message);
  });
  function call(method, params = {}) {
    return new Promise((resolve, reject) => {
      const id = ++sequence;
      const timer = setTimeout(() => {
        pending.delete(id);
        reject(Error(`Browser timeout: ${method}`));
      }, 15000);
      pending.set(id, (response) => {
        clearTimeout(timer);
        pending.delete(id);
        if (response.error) reject(Error(JSON.stringify(response.error)));
        else resolve(response);
      });
      socket.send(JSON.stringify({ id, method, params }));
    });
  }
  async function evaluate(expression) {
    const response = await call('Runtime.evaluate', {
      expression, awaitPromise: true, returnByValue: true
    });
    assert.ok(!response.result.exceptionDetails, JSON.stringify(response.result.exceptionDetails));
    return response.result.result.value;
  }
  async function waitFor(expression) {
    for (let attempt = 0; attempt < 80; attempt++) {
      if (await evaluate(expression)) return;
      await delay(50);
    }
    throw Error(`Condition did not become true: ${expression}`);
  }
  const click = (id) => evaluate(`document.getElementById(${JSON.stringify(id)}).click()`);
  async function contextMenu(selector) {
    const point = await evaluate(`(() => {
      const row = document.querySelector(${JSON.stringify(selector)});
      for (let parent = row.parentElement; parent; parent = parent.parentElement) {
        if (parent.tagName === 'DETAILS') parent.open = true;
      }
      row.scrollIntoView({block:'nearest'});
      const rect = row.getBoundingClientRect();
      return {x:rect.left + rect.width / 2, y:rect.top + rect.height / 2};
    })()`);
    await call('Input.dispatchMouseEvent', {type:'mouseMoved', buttons:0, ...point});
    await delay(30);
    await call('Input.dispatchMouseEvent', {type:'mousePressed', button:'right', buttons:2, clickCount:1, ...point});
    await call('Input.dispatchMouseEvent', {type:'mouseReleased', button:'right', buttons:0, clickCount:1, ...point});
  }
  const tool = (name) => evaluate(`(() => {
    const button = document.querySelector('[data-tool="${name}"]');
    button.focus();
    button.click();
  })()`);

  await call('Page.enable');
  await call('Page.bringToFront');
  await call('Emulation.setFocusEmulationEnabled', { enabled: true });
  await call('Runtime.enable');
  await call('Network.enable');
  await call('Page.addScriptToEvaluateOnNewDocument', { source: `
    window.__errors = [];
    window.__pointerTrace = [];
    for (const name of ['pointerdown', 'pointermove', 'pointerup', 'pointercancel', 'lostpointercapture', 'gotpointercapture']) {
      window.addEventListener(name, event => __pointerTrace.push({ event: name, target: event.target.id || event.target.className, buttons: event.buttons }), true);
    }
    window.addEventListener('error', event => __errors.push(event.message));
    window.addEventListener('unhandledrejection', event => __errors.push(String(event.reason)));
  ` });
  // Reproduce the fatal line from the old entry if an unversioned URL is used.
  socket.addEventListener('message', (event) => {
    const message = JSON.parse(event.data);
    if (message.method !== 'Fetch.requestPaused') return;
    const { requestId, request } = message.params;
    const url = new URL(request.url);
    const response = url.pathname.endsWith('/app.js') && !url.search
      ? call('Fetch.fulfillRequest', {
          requestId, responseCode: 200,
          responseHeaders: [{ name: 'Content-Type', value: 'text/javascript' }],
          body: Buffer.from("document.getElementById('title').oninput = () => {};").toString('base64')
        })
      : call('Fetch.continueRequest', { requestId });
    response.catch((error) => { console.error(error); });
  });
  await call('Fetch.enable', { patterns: [{ urlPattern: '*/app.js*' }] });
  await call('Page.navigate', { url: baseURL });
  await waitFor('!!document.querySelector("#libraryGrid .library-card") || window.__errors?.length > 0');
  assert.deepEqual(await evaluate('window.__errors'), []);
  assert.equal(await evaluate('typeof document.getElementById("paper").onchange'), 'function');
  await call('Fetch.disable');
  assert.equal(await evaluate('document.querySelectorAll("#books details[open]").length'), 0);
  assert.equal(await evaluate(`(async () => {
    const faces = await document.fonts.load('14px Onest', 'Мои тетради');
    return faces.length > 0 && faces.every(face => face.status === 'loaded') &&
      getComputedStyle(document.body).fontFamily.startsWith('Onest');
  })()`), true);
  console.log('PASS local Onest body font with Cyrillic');
  console.log('PASS startup with an old entry available in cache and collapsed notebooks');

  async function snapshot() {
    return evaluate(`(async () => {
      let blob;
      const original = URL.createObjectURL, click = HTMLAnchorElement.prototype.click;
      URL.createObjectURL = value => { blob = value; return 'blob:testing'; };
      HTMLAnchorElement.prototype.click = () => {};
      try {
        document.getElementById('backup').click();
        return JSON.parse(await blob.text());
      } finally {
        URL.createObjectURL = original;
        HTMLAnchorElement.prototype.click = click;
      }
    })()`);
  }
  async function interfacePalette() {
    return evaluate(`(() => {
      const canvas=document.createElement('canvas');canvas.width=canvas.height=1;
      const ctx=canvas.getContext('2d');
      return [['body','backgroundColor'],['.sidebar','backgroundColor'],['.sidebar','borderRightColor'],['.sidebar-bottom','borderTopColor']].map(([selector,property])=>{
        ctx.fillStyle=getComputedStyle(document.querySelector(selector))[property];ctx.fillRect(0,0,1,1);
        return Array.from(ctx.getImageData(0,0,1,1).data).slice(0,3);
      });
    })()`);
  }
  async function checkFocusContours() {
    const selectors=await evaluate(`(() => {
      window.__focusCheckRestore={active:document.activeElement,scroll:Array.from(document.querySelectorAll('*'),el=>[el,el.scrollLeft,el.scrollTop])};
      const scope=document.querySelector('dialog[open]') || document.querySelector(':popover-open') || document;
      return Array.from(scope.querySelectorAll('button,input,select,textarea,summary,a[href],[tabindex]'))
        .filter(el=>!el.disabled && el.checkVisibility() && el.tabIndex>=0)
        .map((el,i)=>{el.setAttribute('data-focus-check',i);return '[data-focus-check="'+i+'"]'});
    })()`);
    for(const selector of selectors) {
      const point=await evaluate(`(() => {const el=document.querySelector('${selector}');if(!el.closest(':popover-open')) el.scrollIntoView({block:'nearest'});el.focus({preventScroll:true});const r=el.getBoundingClientRect();return {x:r.x+r.width/2,y:r.y+r.height/2}})()`);
      await call('Input.dispatchMouseEvent',{type:'mouseMoved',buttons:0,...point});
      await delay(170);
      const result=await evaluate(`(() => {const el=document.querySelector('${selector}');el.blur();const baseline=getComputedStyle(el).boxShadow;el.focus({preventScroll:true});const s=getComputedStyle(el);return {active:document.activeElement===el,outline:s.outlineStyle,shadow:s.boxShadow,baseline,label:el.id || el.className || el.tagName}})()`);
      assert.equal(result.active,true,result.label);
      assert.equal(result.outline,'none',result.label);
      assert.equal(result.shadow,result.baseline,result.label);
    }
    const shadowBeforeReturn=await evaluate('getComputedStyle(document.activeElement).boxShadow');
    await call('Emulation.setFocusEmulationEnabled',{enabled:false});
    await call('Emulation.setFocusEmulationEnabled',{enabled:true});
    assert.equal(await evaluate('getComputedStyle(document.activeElement).outlineStyle'),'none');
    assert.equal(await evaluate('getComputedStyle(document.activeElement).boxShadow'),shadowBeforeReturn);
    await call('Input.dispatchMouseEvent',{type:'mouseMoved',buttons:0,x:5,y:5});
    await evaluate(`(() => {
      document.querySelectorAll('[data-focus-check]').forEach(el=>el.removeAttribute('data-focus-check'));
      const restore=window.__focusCheckRestore;
      restore.active?.focus({preventScroll:true});
      for(const [el,left,top] of restore.scroll) {el.scrollLeft=left;el.scrollTop=top;}
      delete window.__focusCheckRestore;
    })()`);
    await delay(150);
  }
  await checkFocusContours();
  const beforeTheme = await snapshot();
  assert.equal(await evaluate('document.documentElement.dataset.theme'), 'light');
  await click('settings');
  await checkFocusContours();
  await evaluate(`document.querySelector('input[name="theme"][value="dark"]').click()`);
  assert.equal(await evaluate('document.documentElement.dataset.theme'), 'dark');
  assert.ok((await interfacePalette())[1].every(channel=>channel<80));
  await leftClick({x:5,y:5});
  await waitFor('!document.getElementById("dialog").open && document.documentElement.dataset.theme === "light"');
  const settingsHoverPoint=await evaluate(`(() => {const el=document.getElementById('settings');el.focus();const r=el.getBoundingClientRect();return {x:r.x+r.width/2,y:r.y+r.height/2}})()`);
  await call('Input.dispatchMouseEvent',{type:'mouseMoved',buttons:0,...settingsHoverPoint});
  await delay(170);
  assert.match(await evaluate("getComputedStyle(document.getElementById('settings')).boxShadow"),/inset/);
  assert.equal(await evaluate("getComputedStyle(document.getElementById('settings')).outlineStyle"),'none');
  await call('Input.dispatchMouseEvent',{type:'mouseMoved',buttons:0,x:5,y:5});
  await delay(170);
  assert.equal(await evaluate("getComputedStyle(document.getElementById('settings')).boxShadow"),'none');
  assert.equal(await evaluate('document.activeElement.id'),'settings');
  console.log('PASS settings hover border works after dialog closure and disappears when pointer leaves, even while focused');

  assert.equal(await evaluate('document.documentElement.dataset.theme'), 'light');
  await click('settings');
  await evaluate(`document.querySelector('input[name="theme"][value="dark"]').click()`);
  await click('dialogOk');
  await waitFor('!document.getElementById("dialog").open');
  await waitFor(`localStorage.getItem('vibenotes-theme') === 'dark'`);
  assert.equal(await evaluate("localStorage.getItem('vibenotes-theme')"), 'dark');
  await waitFor('document.getElementById("saveStatus").textContent === "✓ Сохранено"');
  await call('Page.reload', {ignoreCache:true});
  await delay(400);
  await waitFor('!!document.querySelector("#libraryGrid .library-card")');
  assert.equal(await evaluate('document.documentElement.dataset.theme'), 'dark');
  assert.deepEqual(await snapshot(), beforeTheme);
  await click('settings');
  await evaluate(`document.querySelector('input[name="theme"][value="light"]').click()`);
  assert.equal(await evaluate('document.documentElement.dataset.theme'), 'light');
  await call('Input.dispatchKeyEvent', {type:'keyDown',key:'Escape',code:'Escape',windowsVirtualKeyCode:27});
  await call('Input.dispatchKeyEvent', {type:'keyUp',key:'Escape',code:'Escape',windowsVirtualKeyCode:27});
  await waitFor('!document.getElementById("dialog").open && document.documentElement.dataset.theme === "dark"');
  assert.equal(await evaluate('document.documentElement.dataset.theme'), 'dark');
  console.log('PASS theme preview, outside/Escape cancellation, saved choice after reload and unchanged documents');
  async function chooseAccent(color) {
    await evaluate(`(() => { const input=document.getElementById('interfaceAccent');input.value='${color}';input.dispatchEvent(new Event('input',{bubbles:true})); })()`);
  }
  const originalAccent=await evaluate('document.documentElement.dataset.accent');
  const originalPalette=await interfacePalette();
  await click('settings');
  await chooseAccent('#2379bd');
  assert.equal(await evaluate("getComputedStyle(document.querySelector('.add-notebook')).backgroundColor"),'rgb(35, 121, 189)');
  assert.equal(await evaluate("getComputedStyle(document.querySelector('.brand-mark')).backgroundColor"),'rgb(35, 121, 189)');
  const bluePalette=await interfacePalette();
  assert.equal(await evaluate(`document.querySelector('meta[name="theme-color"]').content`),'#191d20');
  assert.ok(bluePalette.every(([r,g,b])=>b>g && g>r),'Blue accents also tint backgrounds and dividers blue');
  assert.notDeepEqual(bluePalette,originalPalette);
  await leftClick({x:5,y:5});
  await waitFor(`document.documentElement.dataset.accent === '${originalAccent}' && !document.getElementById('dialog').open`);
  assert.deepEqual(await interfacePalette(),originalPalette);
  await click('settings');
  await chooseAccent('#2379bd');
  await click('dialogOk');
  await waitFor("localStorage.getItem('vibenotes-accent') === '#2379bd'");
  const beforeAccentReload=await evaluate('performance.timeOrigin');
  await call('Page.reload',{ignoreCache:true});
  await waitFor(`performance.timeOrigin !== ${beforeAccentReload} && !!document.querySelector('#libraryGrid .library-card')`);
  assert.equal(await evaluate('document.documentElement.dataset.accent'),'#2379bd');
  assert.deepEqual(await interfacePalette(),bluePalette);
  assert.deepEqual(await snapshot(),beforeTheme);
  await click('settings');
  await chooseAccent('#ffffff');
  assert.equal(await evaluate("getComputedStyle(document.querySelector('.add-notebook')).color"),'rgb(32, 27, 34)');
  await evaluate(`document.querySelector('input[name="theme"][value="light"]').click()`);
  assert.equal(await evaluate("getComputedStyle(document.querySelector('.add-notebook')).backgroundColor"),'rgb(255, 255, 255)');
  await chooseAccent('#2379bd');
  assert.ok((await interfacePalette()).every(([r,g,b])=>b>g && g>r),'Light backgrounds and dividers follow the blue accent too');
  assert.equal(await evaluate(`document.querySelector('meta[name="theme-color"]').content`),'#f1f5f8');
  await chooseAccent('#000000');
  assert.equal(await evaluate("getComputedStyle(document.querySelector('.add-notebook')).color"),'rgb(255, 255, 255)');
  await call('Input.dispatchKeyEvent',{type:'keyDown',key:'Escape',code:'Escape',windowsVirtualKeyCode:27});
  await call('Input.dispatchKeyEvent',{type:'keyUp',key:'Escape',code:'Escape',windowsVirtualKeyCode:27});
  await waitFor("!document.getElementById('dialog').open && document.documentElement.dataset.accent === '#2379bd'");
  assert.equal(await evaluate('document.documentElement.dataset.theme'),'dark');
  await click('settings');
  await click('resetAccent');
  assert.equal(await evaluate('document.getElementById("interfaceAccent").value'),originalAccent);
  await click('dialogOk');
  await waitFor(`localStorage.getItem('vibenotes-accent') === '${originalAccent}'`);
  assert.deepEqual(await snapshot(),beforeTheme);
  console.log('PASS accent palette preview, cancellation, persistence, light/dark themes, extreme colours and reset without changing notes');
  // Run the remaining writing and library checks in dark mode.
  async function elements() {
    const doc = await snapshot();
    return doc.books.flatMap((book) => book.pages).find((page) => page.id === doc.activePage).elements;
  }
  async function stroke(points, modifiers = 0) {
    const rect = await evaluate(`(() => {
      const r = document.getElementById('canvas').getBoundingClientRect();
      return { left: r.left, top: r.top, width: r.width, height: r.height };
    })()`);
    const physical = points.map(([x, y]) => ({
      x: rect.left + x * rect.width / 1100,
      y: rect.top + y * rect.height / 1550
    }));
    // A real pointer enters the sheet before pressing; CDP must do the same.
    await call('Input.dispatchMouseEvent', {
      type: 'mouseMoved', modifiers, buttons: 0, ...physical[0]
    });
    await delay(25);
    await call('Input.dispatchMouseEvent', {
      type: 'mousePressed', modifiers, button: 'left', buttons: 1, clickCount: 1, ...physical[0]
    });
    for (const point of physical.slice(1)) {
      await call('Input.dispatchMouseEvent', { type: 'mouseMoved', modifiers, button: 'left', buttons: 1, ...point });
      await delay(25);
    }
    await call('Input.dispatchMouseEvent', {
      type: 'mouseReleased', modifiers, button: 'left', buttons: 0, clickCount: 1, ...physical.at(-1)
    });
    await delay(120);
  }
  assert.equal(await evaluate('document.getElementById("editorView").hidden'), true);
  const initialLibrary = await snapshot();
  assert.equal(await evaluate('document.querySelectorAll("#books .selected").length'), 0);
  await evaluate("document.querySelector('#libraryGrid [data-open-folder]').click()");
  assert.equal(await evaluate('document.getElementById("editorView").hidden'), true);
  assert.equal(await evaluate('document.querySelectorAll("#libraryGrid [data-open-document]").length'), 1);
  assert.equal(await evaluate('document.querySelectorAll("#books .folder-row.selected").length'), 1);
  assert.equal(await evaluate('document.querySelectorAll("#books .document-row.selected").length'), 0);
  await evaluate("document.querySelector('#libraryGrid [data-open-document]').click()");
  assert.equal(await evaluate('document.getElementById("editorView").hidden'), false);
  assert.equal(await evaluate('document.querySelectorAll("#books .folder-row.selected").length'), 0);
  assert.equal(await evaluate('document.querySelectorAll("#books .document-row.selected").length'), 1);
  await evaluate("document.querySelector('.folder-row').click()");
  assert.equal(await evaluate('document.querySelector("#books details").open'),false);
  assert.equal(await evaluate('document.getElementById("editorView").hidden'),false);

  await click('libraryHome');
  assert.equal(await evaluate('document.querySelectorAll("#books details[open]").length'), 0);
  assert.equal(await evaluate('document.getElementById("editorView").hidden'), true);
  await evaluate("document.querySelector('.folder-row').click()");
  assert.equal(await evaluate('document.querySelectorAll("#libraryGrid [data-open-document]").length'), 1);
  const sidebarPoint=await evaluate(`(() => {const r=document.querySelector('.folder-row').getBoundingClientRect();return {x:r.x+r.width/2,y:r.y+r.height/2}})()`);
  await leftClick(sidebarPoint);
  assert.equal(await evaluate('document.querySelector("#books details").open'),false);
  assert.equal(await evaluate('document.querySelectorAll("#libraryGrid [data-open-document]").length'),1);
  await evaluate("document.querySelector('.folder-row').focus()");
  await call('Input.dispatchKeyEvent',{type:'keyDown',key:'Enter',code:'Enter',windowsVirtualKeyCode:13,text:'\r'});
  await call('Input.dispatchKeyEvent',{type:'keyUp',key:'Enter',code:'Enter',windowsVirtualKeyCode:13});
  assert.equal(await evaluate('document.querySelector("#books details").open'),true);
  console.log('PASS sidebar folder collapse by repeat click, keyboard reopening and unchanged active document');

  await evaluate("document.querySelector('#libraryGrid [data-open-document]').click()");
  assert.deepEqual((await snapshot()).books, initialLibrary.books);
  console.log('PASS home notebooks, folder cards, sidebar navigation and explicit document opening');
  await checkFocusContours();
  await click('sizeButton');
  await checkFocusContours();
  await click('sizeButton');
  console.log('PASS focus adds no contour to visible controls and preserves independent hover effects');
  assert.deepEqual(await evaluate('Array.from(document.querySelectorAll(".sidebar-bottom button"), button=>button.id)'),['settings','backup']);
  const sidebarActionStyles=await evaluate(`['settings','backup'].map(id=>{
    const button=document.getElementById(id), label=button.querySelector('span'), style=getComputedStyle(label);
    return {fontFamily:style.fontFamily,fontWeight:style.fontWeight,color:style.color,letterSpacing:style.letterSpacing,left:label.getBoundingClientRect().left,height:button.getBoundingClientRect().height,fits:label.scrollWidth<=label.clientWidth};
  })`);
  assert.deepEqual(sidebarActionStyles[0],sidebarActionStyles[1]);
  assert.equal(sidebarActionStyles[0].fits,true);

  await click('settings');
  await waitFor('!!document.getElementById("restore")');
  assert.equal(await evaluate('document.getElementById("restore").disabled'),false);
  await evaluate(`{
    const input=document.getElementById('restoreInput');
    const original=input.click;
    input.click=()=>{window.__restorePickerOpened=true;};
    try {document.getElementById('restore').click();}finally{input.click=original;}
  }`);
  await waitFor('!document.getElementById("dialog").open');
  await delay(50);
  assert.equal(await evaluate('window.__restorePickerOpened'),true);
  console.log('PASS only two sidebar footer buttons; backup restoration opens from settings');
  await evaluate(`(async () => {
    const core = await import('./core.mjs');
    const doc = core.initialState();
    doc.books[0].pages.push(core.newPage('Старая страница'));
    await document.getElementById('restoreInput').onchange({ target: {
      files: [new File([JSON.stringify(doc)], 'version-1.json')], value: ''
    }});
    document.getElementById('dialog').close('ok');
  })()`);
  await waitFor('document.querySelectorAll(".page-sheet").length === 2');
  await delay(500);
  for (const paper of ['grid', 'lines', 'blank', 'dots']) {
    await evaluate(`document.getElementById('paper').value='${paper}';document.getElementById('paper').dispatchEvent(new Event('change'));`);
    assert.equal((await snapshot()).books[0].pages[0].paper, paper);
  }
  assert.equal(await evaluate('document.getElementById("removePage") === null'), true);
  assert.equal(await evaluate(`(() => {
    const controls = ['.tools', '.pen-settings', '#paper', '#paperColor', '#clearPage', '#upload', '#undo'];
    const centres = controls.map(selector => {const r=document.querySelector(selector).getBoundingClientRect();return r.top+r.height/2;});
    const bar=document.querySelector('.toolbar');
    return Math.max(...centres)-Math.min(...centres)<2 && bar.clientWidth<=document.querySelector('main').clientWidth;
  })()`), true);
  assert.equal(await evaluate('document.getElementById("selectionMenuButton") === null'),true);
  assert.equal(await evaluate(`(() => {
    const size=document.getElementById('sizeButton');
    return size.previousElementSibling.dataset.tool==='select' && size.nextElementSibling.dataset.tool==='pen' && document.querySelector('.pen-settings #size')===null;
  })()`),true);
  assert.equal(await evaluate("document.getElementById('sizePopover').matches(':popover-open')"),false);
  await click('sizeButton');
  assert.equal(await evaluate("document.getElementById('sizePopover').matches(':popover-open')"),true);
  await evaluate("document.getElementById('size').value='7';document.getElementById('size').dispatchEvent(new Event('input'))");
  assert.equal(await evaluate("document.getElementById('sizeLabel').textContent"),'7 px');
  await click('sizeButton');
  assert.equal(await evaluate("document.getElementById('sizePopover').matches(':popover-open')"),false);
  const sizePosition = await evaluate("(() => {const r=document.getElementById('sizeButton').getBoundingClientRect();return {x:r.left+r.width/2,y:r.top+r.height/2};})()");
  await leftClick(sizePosition);
  assert.equal(await evaluate("document.getElementById('sizePopover').matches(':popover-open')"),true);
  await leftClick(sizePosition);
  assert.equal(await evaluate("document.getElementById('sizePopover').matches(':popover-open')"),false);
  await click('sizeButton');
  await leftClick({x:5,y:5});
  assert.equal(await evaluate("document.getElementById('sizePopover').matches(':popover-open')"),false);
  await evaluate("document.getElementById('size').value='3';document.getElementById('size').dispatchEvent(new Event('input'))");
  console.log('PASS single-row writing and paper controls with thickness between lasso and pen');
  console.log('PASS all paper styles');
  const beforePaperColour = await snapshot();
  for (const [colour, rgb] of [['white',[255,254,250]],['yellow',[255,242,204]],['black',[24,24,24]]]) {
    await evaluate(`document.getElementById('paperColor').value='${colour}';document.getElementById('paperColor').dispatchEvent(new Event('change'))`);
    assert.equal((await snapshot()).books[0].pages[0].paperColor,colour);
    assert.deepEqual(await evaluate("Array.from(document.getElementById('canvas').getContext('2d').getImageData(5,5,1,1).data).slice(0,3)"),rgb);
    assert.deepEqual((await snapshot()).books[0].pages.map(page=>page.elements),beforePaperColour.books[0].pages.map(page=>page.elements));
  }
  const exportPixel = await evaluate(`(async () => {
    let exported;
    const original=URL.createObjectURL, click=HTMLAnchorElement.prototype.click;
    URL.createObjectURL=blob=>{exported=blob;return 'blob:testing';};
    HTMLAnchorElement.prototype.click=()=>{};
    try {
      await document.getElementById('export').onclick();
      for(let i=0;i<80&&!exported;i++)await new Promise(resolve=>setTimeout(resolve,25));
      const bitmap=await createImageBitmap(exported);
      const canvas=document.createElement('canvas');canvas.width=1100;canvas.height=1550;
      canvas.getContext('2d').drawImage(bitmap,0,0);bitmap.close();
      return Array.from(canvas.getContext('2d').getImageData(5,5,1,1).data).slice(0,3);
    } finally {URL.createObjectURL=original;HTMLAnchorElement.prototype.click=click;}
  })()`);
  assert.deepEqual(exportPixel,[24,24,24]);
  assert.equal((await snapshot()).books[0].pages[1].paperColor,undefined);
  console.log('PASS all sheet colours, independent pages, unchanged notes and black background in PNG');

  await evaluate(`(async () => {
    const canvas = document.createElement('canvas');
    canvas.width = 100; canvas.height = 80;
    const blob = await new Promise(resolve => canvas.toBlob(resolve));
    window.__focusPaste = new DataTransfer();
    __focusPaste.items.add(new File([blob], 'focus-test.png', { type: 'image/png' }));
  })()`);
  const pasteAnchor = await evaluate(`(() => {
    const rect = document.getElementById('canvas').getBoundingClientRect();
    return { x: rect.left + 200 * rect.width / 1100, y: rect.top + 400 * rect.height / 1550 };
  })()`);
  await call('Input.dispatchMouseEvent', { type: 'mouseMoved', buttons: 0, ...pasteAnchor });
  for (const control of ['paper', 'size', 'pressure', 'customColor']) {
    if (control === 'size') await click('sizeButton');
    await evaluate(`document.getElementById('${control}').focus();`);
    assert.equal(await evaluate('document.activeElement.id'), control);
    await evaluate(`window.dispatchEvent(new ClipboardEvent('paste', { clipboardData: __focusPaste }));`);
    await delay(250);
    const inserted = await elements();
    assert.equal(inserted.length, 1, control);
    assert.equal(inserted[0].type, 'image');
    assert.ok(Math.abs(inserted[0].x - 200) < 0.001);
    assert.ok(Math.abs(inserted[0].y - 400) < 0.001);
    await click('undo');
    assert.equal((await elements()).length, 0);
    if (control === 'size') await evaluate("document.getElementById('sizePopover').hidePopover()");
  }
  console.log('PASS paste at the cursor after paper, thickness, pressure and colour controls');
  await tool('pen');
  await stroke([[100,100], [120,115], [140,105], [180,130]]);
  assert.equal((await elements()).length, 1);
  assert.ok((await elements())[0].points.length >= 4, JSON.stringify(await evaluate('window.__pointerTrace')));
  await tool('marker');
  await stroke([[100,180], [130,190], [180,190]]);
  assert.equal((await elements()).length, 2);
  assert.equal((await elements())[1].tool, 'marker');
  await tool('eraser');
  await stroke([[140,100], [140,115]]);
  assert.equal((await elements()).length, 1);
  await click('undo');
  assert.equal((await elements()).length, 2);
  await click('redo');
  assert.equal((await elements()).length, 1);
  console.log('PASS pen, marker, eraser, undo and redo');
  const beforeShortcutUndo=await elements();
  for (const control of ['size','paper']) {
    if (control === 'size') await click('sizeButton');
    await evaluate(`document.getElementById('${control}').focus()`);
    assert.equal(await evaluate('document.activeElement.id'),control);
    await call('Input.dispatchKeyEvent', {type:'keyDown',key:'я',code:'KeyZ',windowsVirtualKeyCode:90,modifiers:2});
    await call('Input.dispatchKeyEvent', {type:'keyUp',key:'я',code:'KeyZ',windowsVirtualKeyCode:90,modifiers:2});
    assert.equal((await elements()).length,2);
    await call('Input.dispatchKeyEvent', {type:'keyDown',key:'Я',code:'KeyZ',windowsVirtualKeyCode:90,modifiers:10});
    await call('Input.dispatchKeyEvent', {type:'keyUp',key:'Я',code:'KeyZ',windowsVirtualKeyCode:90,modifiers:10});
    assert.deepEqual(await elements(),beforeShortcutUndo);
    if (control === 'size') await click('sizeButton');
  }
  console.log('PASS Russian-layout Ctrl+Z and Ctrl+Shift+Z after thickness and paper controls');
  await click('shapeTool');
  await evaluate(`document.querySelector('[data-shape="rectangle"]').click()`);
  await stroke([[300,300], [400,390], [450,400]]);
  assert.equal((await elements()).length, 2);
  const shape = (await elements())[1];
  await stroke([[370,350], [410,380]]);
  assert.ok((await elements())[1].points[0].x > shape.points[0].x + 30);
  await click('rotateRight');
  await tool('select');
  await stroke([[280,250], [550,250], [550,510], [280,510], [280,250]]);
  assert.equal(await evaluate('document.getElementById("copyObject").disabled'), false);
  await evaluate(`
    window.__copied = new DataTransfer();
    window.dispatchEvent(new ClipboardEvent('copy', { clipboardData: __copied }));
    window.dispatchEvent(new ClipboardEvent('paste', { clipboardData: __copied }));
  `);
  assert.equal((await elements()).length, 3);
  console.log('PASS shapes, selection, movement, rotation and object copy/paste');
  await evaluate(`(async () => {
    const canvas = document.createElement('canvas');
    canvas.width = 100; canvas.height = 80;
    const blob = await new Promise(resolve => canvas.toBlob(resolve));
    const data = new DataTransfer();
    data.items.add(new File([blob], 'photo.png', { type: 'image/png' }));
    window.dispatchEvent(new ClipboardEvent('paste', { clipboardData: data }));
  })()`);
  await delay(250);
  assert.equal((await elements()).at(-1).type, 'image');
  const beforePhotoResize=await elements();
  const photoBeforeResize=beforePhotoResize.at(-1);
  await stroke([[photoBeforeResize.x+photoBeforeResize.w,photoBeforeResize.y+photoBeforeResize.h],
    [photoBeforeResize.x+photoBeforeResize.w+50,photoBeforeResize.y+photoBeforeResize.h+5]],8);
  const photoAfterResize=(await elements()).at(-1);
  assert.ok(photoAfterResize.w>photoBeforeResize.w);
  assert.ok(Math.abs(photoAfterResize.w/photoAfterResize.h-photoBeforeResize.w/photoBeforeResize.h)<1e-9);
  assert.equal(photoAfterResize.src,photoBeforeResize.src);
  await click('undo');
  assert.deepEqual(await elements(),beforePhotoResize);
  console.log('PASS Shift photo resizing preserves proportions and image data with undo');

  await tool('text');
  await stroke([[150,500], [150,500]]);
  assert.equal(await evaluate('document.getElementById("dialog").open'), true);
  await evaluate(`document.querySelector('#dialogBody textarea').value='Тест';document.getElementById('dialog').close('ok');`);
  await delay(250);
  assert.equal((await elements()).at(-1).text, 'Тест');
  const count = (await elements()).length;
  await click('clearPage');
  await evaluate(`document.getElementById('dialog').close('ok')`);
  await delay(250);
  assert.equal((await elements()).length, 0);
  await click('undo');
  assert.equal((await elements()).length, count);
  console.log('PASS clipboard image, text, clear and undo');
  await evaluate(`document.querySelectorAll('.page-sheet')[1].scrollIntoView({ block: 'start' })`);
  await delay(200);
  assert.equal(await evaluate('document.getElementById("sheetCrumb").textContent'), 'Страница 2');
  await tool('pen');
  await stroke([[100,100], [130,140], [160,130]]);
  assert.equal((await elements()).length, 1);
  await click('addPageBottom');
  await delay(200);
  assert.equal((await snapshot()).books[0].pages.length, 3);
  await waitFor('document.getElementById("saveStatus").textContent === "✓ Сохранено"');
  const expected = await snapshot();
  assert.equal(expected.version, 1);
  assert.ok(expected.books[0].pages[0].elements.some((element) => element.type === 'image'));
  await call('Page.reload', { ignoreCache: true });
  await waitFor('!!document.querySelector(".page-sheet")');
  await delay(400);
  assert.deepEqual(await snapshot(), expected);
  assert.deepEqual(await evaluate('window.__errors'), []);
  console.log('PASS continuous pages, JSON with embedded photo, reload persistence, no browser errors');
  const originalPages = (await snapshot()).books[0].pages;
  async function createNamed(id, name, paper = 'dots', paperColor = 'white') {
    if (id !== 'newBook') {
      const targetFolder = await evaluate(`(() => {
        const selected = document.querySelector('#books .selected');
        return selected.closest('.library-folder').dataset.folderId;
      })()`);
      await contextMenu(`[data-folder-id="${targetFolder}"] > summary`);
      await waitFor('document.getElementById("dialog").open');
    }
    await click(id);
    await waitFor('!!document.querySelector("#dialogBody input")');
    await evaluate(`{ const input = document.querySelector('#dialogBody input');input.value=${JSON.stringify(name)};input.focus(); }`);
    if (id === 'newDocument') await evaluate(`document.getElementById('documentPaper').value='${paper}';document.getElementById('documentPaperColor').value='${paperColor}'`);
    await call('Input.dispatchKeyEvent', {type:'keyDown', key:'Enter', code:'Enter', windowsVirtualKeyCode:13, text:'\r'});
    await call('Input.dispatchKeyEvent', {type:'keyUp', key:'Enter', code:'Enter', windowsVirtualKeyCode:13});
    await waitFor('!document.getElementById("dialog").open');
    await delay(150);
  }
  await createNamed('newBook', 'Учёба');
  const rootFolder = (await snapshot()).folders.at(-1);
  assert.equal(rootFolder.parentId, null);
  await createNamed('newFolder', 'Математика');
  const childFolder = (await snapshot()).folders.at(-1);
  assert.equal(childFolder.parentId, rootFolder.id);
  await createNamed('newFolder', 'Алгебра');
  const nestedFolder = (await snapshot()).folders.at(-1);
  assert.equal(nestedFolder.parentId, childFolder.id);
  const beforeCancelledDocument = await snapshot();
  await contextMenu(`[data-folder-id="${nestedFolder.id}"] > summary`);
  await click('newDocument');
  await waitFor('!!document.getElementById("documentPaper")');
  await evaluate("document.getElementById('documentPaper').value='blank';document.getElementById('documentPaperColor').value='black'");
  await leftClick({x:5,y:5});
  await waitFor('!document.getElementById("dialog").open');
  await delay(50);
  assert.deepEqual(await snapshot(),beforeCancelledDocument);
  await createNamed('newDocument', 'Урок 1', 'grid', 'yellow');
  await waitFor('document.getElementById("paper").value === "grid"');
  assert.equal(await evaluate('document.getElementById("paperColor").value'), 'yellow');
  assert.equal((await snapshot()).books.at(-1).pages[0].paper,'grid');
  assert.equal((await snapshot()).books.at(-1).pages[0].paperColor,'yellow');
  assert.deepEqual(await evaluate("Array.from(document.getElementById('canvas').getContext('2d').getImageData(5,5,1,1).data).slice(0,3)"),[255,242,204]);
  console.log('PASS document creation with chosen paper and colour via Enter, outside cancellation and unchanged notes');
  assert.equal((await snapshot()).books.at(-1).folderId, nestedFolder.id);
  assert.equal(await evaluate('document.getElementById("bookCrumb").textContent'), 'Учёба / Математика / Алгебра');
  assert.equal(await evaluate('document.getElementById("pageCrumb").textContent'), 'Урок 1');
  await tool('pen');
  await stroke([[100,100], [120,130], [170,120]]);
  assert.equal((await elements()).length, 1);
  await click('addPageBottom');
  await delay(150);
  assert.equal((await snapshot()).books.at(-1).pages.at(-1).paper,'grid');
  assert.equal((await snapshot()).books.at(-1).pages.at(-1).paperColor,'yellow');
  assert.equal(await evaluate('document.getElementById("paper").value'),'grid');
  assert.equal(await evaluate('document.getElementById("paperColor").value'),'yellow');
  assert.deepEqual(await evaluate("Array.from(document.getElementById('canvas').getContext('2d').getImageData(5,5,1,1).data).slice(0,3)"),[255,242,204]);
  console.log('PASS added sheet inherits document paper layout and colour');
  await click('pageMenu');
  await click('deletePage');
  await waitFor('document.getElementById("dialog").open && document.getElementById("dialogTitle").textContent === "Удалить страницу?"');
  await evaluate(`document.getElementById('dialog').close('cancel')`);
  await delay(100);
  assert.equal((await snapshot()).books.at(-1).pages.length, 2);
  await click('pageMenu');
  await click('deletePage');
  await waitFor('document.getElementById("dialog").open && document.getElementById("dialogTitle").textContent === "Удалить страницу?"');
  await evaluate(`document.getElementById('dialog').close('ok')`);
  await delay(150);
  assert.equal((await snapshot()).books.at(-1).pages.length, 1);
  assert.equal((await elements()).length, 1);
  await evaluate(`(() => {
    const details=document.querySelector('[data-folder-id="${rootFolder.id}"]');
    if(details.open) details.querySelector('summary').click();
    details.querySelector('summary').click();
  })()`);
  await createNamed('newDocument', 'Задачи');
  assert.equal((await snapshot()).books.at(-1).folderId, rootFolder.id);
  await createNamed('newFolder', 'Черновики');
  const emptyFolder = (await snapshot()).folders.at(-1);
  assert.equal(emptyFolder.parentId, rootFolder.id);
  assert.equal((await snapshot()).books.some(book => book.folderId === emptyFolder.id), false);
  assert.equal(await evaluate(`document.querySelector('[data-folder-id="${emptyFolder.id}"] .folder-empty').textContent`), 'Папка пуста');
  async function renameFromMenu(selector, actionId, name, cancel = false) {
    await contextMenu(selector);
    await waitFor(`!!document.getElementById(${JSON.stringify(actionId)})`);
    await click(actionId);
    await waitFor('!!document.querySelector("#dialogBody input")');
    await delay(60);
    await evaluate(`{const input = document.querySelector('#dialogBody input');input.value=${JSON.stringify(name)};input.focus();}`);
    if (cancel) await evaluate("document.getElementById('dialog').close('cancel')");
    else {
      await call('Input.dispatchKeyEvent', {type:'keyDown', key:'Enter', code:'Enter', windowsVirtualKeyCode:13, text:'\r'});
      await call('Input.dispatchKeyEvent', {type:'keyUp', key:'Enter', code:'Enter', windowsVirtualKeyCode:13});
    }
    await waitFor('!document.getElementById("dialog").open');
    await delay(100);
  }
  async function leftClick(point) {
    await call('Input.dispatchMouseEvent', {type:'mouseMoved', buttons:0, ...point});
    await call('Input.dispatchMouseEvent', {type:'mousePressed', button:'left', buttons:1, clickCount:1, ...point});
    await call('Input.dispatchMouseEvent', {type:'mouseReleased', button:'left', buttons:0, clickCount:1, ...point});
  }
  const beforeDismiss = await snapshot();
  await contextMenu(`[data-folder-id="${rootFolder.id}"] > summary`);
  await waitFor('document.getElementById("dialog").open');
  const insideDialog = await evaluate(`(() => {
    const rect = document.getElementById('dialogTitle').getBoundingClientRect();
    return {x:rect.left + 10, y:rect.top + 10};
  })()`);
  await leftClick(insideDialog);
  assert.equal(await evaluate('document.getElementById("dialog").open'), true);
  await leftClick({x:5,y:5});
  await waitFor('!document.getElementById("dialog").open');
  assert.deepEqual(await snapshot(), beforeDismiss);
  await contextMenu(`[data-folder-id="${rootFolder.id}"] > summary`);
  await click('renameFolder');
  await waitFor('!!document.querySelector("#dialogBody input")');
  await evaluate("document.querySelector('#dialogBody input').value = 'Не сохранять'");
  await leftClick({x:5,y:5});
  await waitFor('!document.getElementById("dialog").open');
  assert.deepEqual(await snapshot(), beforeDismiss);
  console.log('PASS outside click cancels dialogs without changes; inside click keeps them open');
  const beforeRename = await snapshot();
  await renameFromMenu(`[data-folder-id="${rootFolder.id}"] > summary`, 'renameFolder', 'Не сохранять', true);
  assert.deepEqual(await snapshot(), beforeRename);
  await renameFromMenu(`[data-folder-id="${rootFolder.id}"] > summary`, 'renameFolder', 'Моя учёба');
  await renameFromMenu(`[data-folder-id="${childFolder.id}"] > summary`, 'renameFolder', 'Точные науки');
  const renamedDocument = (await snapshot()).books.at(-1);
  await renameFromMenu(`[data-document-id="${renamedDocument.id}"]`, 'renameDocument', 'Домашняя работа');
  assert.equal((await snapshot()).folders.find(folder => folder.id === rootFolder.id).name, 'Моя учёба');
  assert.equal((await snapshot()).folders.find(folder => folder.id === childFolder.id).name, 'Точные науки');
  assert.equal((await snapshot()).books.at(-1).name, 'Домашняя работа');
  await evaluate(`document.querySelector('[data-document-id="${renamedDocument.id}"]').click()`);
  assert.equal(await evaluate('document.getElementById("bookCrumb").textContent'), 'Моя учёба');
  assert.equal(await evaluate('document.getElementById("pageCrumb").textContent'), 'Домашняя работа');
  assert.deepEqual((await snapshot()).books.map(book => book.pages), beforeRename.books.map(book => book.pages));
  async function openCover(selector, actionId) {
    await contextMenu(selector);
    await click(actionId);
    await waitFor('!!document.getElementById("coverColor")');
  }
  const folderSelector = `[data-folder-id="${rootFolder.id}"] > summary`;
  const documentSelector = `[data-document-id="${renamedDocument.id}"]`;
  async function openTabEditor() {
    await contextMenu(folderSelector);
    await click('changeFolderTab');
    await waitFor('!!document.getElementById("tabColor")');
  }
  // A tab-only override must leave the default front gradient unchanged.
  const beforeTabOnly = await snapshot();
  await openTabEditor();
  const initialFront = await evaluate("getComputedStyle(document.querySelector('#tabPreview .folder-card'),'::after').backgroundImage");
  await evaluate("document.getElementById('tabColor').value='#94647b';document.getElementById('tabColor').dispatchEvent(new Event('input'))");
  assert.equal(await evaluate("getComputedStyle(document.querySelector('#tabPreview .folder-card'),'::after').backgroundImage"), initialFront);
  assert.equal(await evaluate("getComputedStyle(document.querySelector('#tabPreview .folder-card'),'::before').backgroundColor"), 'rgb(148, 100, 123)');
  await leftClick({x:5,y:5});
  await waitFor('!document.getElementById("dialog").open');
  assert.deepEqual(await snapshot(), beforeTabOnly);
  const beforeCover = await snapshot();
  async function waitCoverSaved(expected) {
    for (let attempt = 0; attempt < 80; attempt++) {
      const cover = (await snapshot()).folders.find(folder => folder.id === rootFolder.id).cover;
      if (JSON.stringify(cover) === JSON.stringify(expected)) return;
      await delay(50);
    }
    assert.fail('Folder cover was not applied');
  }
  await openCover(folderSelector, 'changeFolderCover');
  await evaluate("document.getElementById('coverColor').value='#abc4d4';document.getElementById('coverColor').dispatchEvent(new Event('input'))");
  assert.deepEqual(await snapshot(), beforeCover);
  await leftClick({x:5,y:5});
  await waitFor('!document.getElementById("dialog").open');
  assert.deepEqual(await snapshot(), beforeCover);
  await openCover(folderSelector, 'changeFolderCover');
  await evaluate("document.getElementById('coverColor').value='#abc4d4';document.getElementById('coverColor').dispatchEvent(new Event('input'))");
  await click('dialogOk');
  await waitFor('!document.getElementById("dialog").open');
  await delay(100);
  await waitCoverSaved({color:'#abc4d4'});
  await openCover(folderSelector, 'changeFolderCover');
  await click('coverReset');
  await click('dialogOk');
  await waitFor('!document.getElementById("dialog").open');
  await delay(100);
  await waitCoverSaved(undefined);
  await openCover(folderSelector, 'changeFolderCover');
  await evaluate("document.getElementById('coverColor').value='#c2b3d1';document.getElementById('coverColor').dispatchEvent(new Event('input'))");
  await click('dialogOk');
  await waitFor('!document.getElementById("dialog").open');
  await openCover(documentSelector, 'changeDocumentCover');
  await evaluate(`(async () => {
    const canvas = document.createElement('canvas');
    canvas.width=1200;canvas.height=600;
    const ctx=canvas.getContext('2d');
    ctx.fillStyle='#abc4d4';ctx.fillRect(0,0,1200,600);
    ctx.fillStyle='#315e4c';ctx.fillRect(0,0,300,600);
    const blob=await new Promise(resolve=>canvas.toBlob(resolve));
    await document.getElementById('coverFile').onchange({target:{files:[new File([blob],'cover.png',{type:'image/png'})],value:''}});
  })()`);
  assert.equal(await evaluate('document.querySelectorAll("#coverPreview .cover-image").length'), 1);
  assert.equal(await evaluate("getComputedStyle(document.querySelector('#coverPreview .document-card'),'::after').display"), 'none');
  assert.equal(await evaluate('document.getElementById("dialogOk").disabled'), false);
  await click('dialogOk');
  await waitFor('!document.getElementById("dialog").open');
  await delay(100);
  const imageCover = (await snapshot()).books.find(book => book.id === renamedDocument.id).cover;
  assert.match(imageCover.image, /^data:image\/webp;base64,/);
  await openCover(documentSelector, 'changeDocumentCover');
  await click('coverRemoveImage');
  assert.equal(await evaluate("getComputedStyle(document.querySelector('#coverPreview .document-card'),'::after').display"), 'block');
  await evaluate("document.getElementById('dialog').close('cancel')");
  await delay(100);
  assert.deepEqual((await snapshot()).books.find(book => book.id === renamedDocument.id).cover, imageCover);
  assert.deepEqual((await snapshot()).books.map(book => book.pages), beforeCover.books.map(book => book.pages));
  async function openSpineEditor() {
    await contextMenu(documentSelector);
    await click('changeDocumentSpine');
    await waitFor('!!document.getElementById("tabColor")');
  }
  await openSpineEditor();
  await evaluate("document.getElementById('tabColor').value='#7b5367';document.getElementById('tabColor').dispatchEvent(new Event('input'))");
  assert.match(await evaluate("getComputedStyle(document.querySelector('#tabPreview .document-card'),'::before').background"), /123, 83, 103/);
  assert.equal(await evaluate("getComputedStyle(document.querySelector('#tabPreview .document-card'),'::after').display"), 'none');
  await click('dialogOk');
  await waitFor('!document.getElementById("dialog").open');
  await delay(100);
  assert.deepEqual((await snapshot()).books.find(book=>book.id===renamedDocument.id).cover,{...imageCover,spineColor:'#7b5367'});
  await openSpineEditor();
  await click('tabReset');
  assert.equal(await evaluate("document.querySelector('#tabPreview .document-card').classList.contains('custom-spine')"), false);
  await evaluate("document.getElementById('dialog').close('cancel')");
  await delay(100);
  assert.equal((await snapshot()).books.find(book=>book.id===renamedDocument.id).cover.spineColor,'#7b5367');
  await openCover(documentSelector, 'changeDocumentCover');
  await click('coverReset');
  assert.equal(await evaluate("document.querySelector('#coverPreview .document-card').classList.contains('custom-spine')"), true);
  assert.equal(await evaluate('document.querySelectorAll("#coverPreview .cover-image").length'), 0);
  await evaluate("document.getElementById('dialog').close('cancel')");
  await delay(100);
  assert.deepEqual((await snapshot()).books.find(book=>book.id===renamedDocument.id).cover,{...imageCover,spineColor:'#7b5367'});
  assert.deepEqual((await snapshot()).books.map(book=>book.pages), beforeCover.books.map(book=>book.pages));
  console.log('PASS independent document spine colour, preview, reset, cancellation and preserved cover image');
  await openCover(folderSelector, 'changeFolderCover');
  const originalPreviewSize = await evaluate(`(() => {
    const rect = document.querySelector('#coverPreview .folder-card').getBoundingClientRect();
    return {width:rect.width, height:rect.height};
  })()`);
  await evaluate(`(async () => {
    const canvas = document.createElement('canvas');
    canvas.width=724; canvas.height=616;
    const ctx=canvas.getContext('2d');
    ctx.fillStyle='#ffffff';ctx.fillRect(0,0,724,616);
    ctx.fillStyle='#cb9990';
    ctx.beginPath();ctx.roundRect(35,50,245,130,45);ctx.fill();
    ctx.beginPath();ctx.roundRect(35,105,655,470,40);ctx.fill();
    ctx.fillStyle='#dbbcb0';
    ctx.beginPath();ctx.roundRect(15,135,695,460,40);ctx.fill();
    ctx.save();ctx.clip();
    ctx.fillStyle='#a7b097';
    for(let x=40;x<724;x+=170)ctx.fillRect(x,135,70,460);
    ctx.fillStyle='#d8ae68';
    for(let y=190;y<616;y+=180)ctx.fillRect(15,y,695,8);
    ctx.restore();
    const blob=await new Promise(resolve=>canvas.toBlob(resolve));
    await document.getElementById('coverFile').onchange({target:{files:[new File([blob],'whole-folder.png',{type:'image/png'})],value:''}});
  })()`);
  assert.equal(await evaluate('getComputedStyle(document.querySelector("#coverPreview .folder-card"), "::after").display'), 'none');
  await waitFor('document.querySelector("#coverPreview .folder-card .cover-image").dataset.fitted === "true"');
  assert.equal(await evaluate('getComputedStyle(document.querySelector("#coverPreview .folder-card .cover-image")).objectFit'), 'fill');
  assert.deepEqual(await evaluate(`(() => {
    const rect=document.querySelector('#coverPreview .folder-card').getBoundingClientRect();
    return {width:rect.width,height:rect.height};
  })()`), originalPreviewSize);
  await click('dialogOk');
  await waitFor('!document.getElementById("dialog").open');
  await delay(150);
  await click('libraryHome');
  await waitFor(`document.querySelector('[data-open-folder="${rootFolder.id}"] .cover-image').dataset.fitted === 'true'`);
  const folderArt = await evaluate(`(() => {
    const card=document.querySelector('[data-open-folder="${rootFolder.id}"]');
    const image=card.querySelector('.cover-image');
    const bounds=card.getBoundingClientRect(), picture=card.querySelector('.folder-cover-art').getBoundingClientRect();
    const standardCard=document.querySelector('.folder-card:not(.has-cover-image)');
    const standard=standardCard.getBoundingClientRect();
    return {back:getComputedStyle(card,'::before').display, front:getComputedStyle(card,'::after').display,
      fit:getComputedStyle(image).objectFit, width:bounds.width, imageWidth:picture.width,
      height:bounds.height, imageHeight:picture.height, standardWidth:standard.width, standardHeight:standard.height,
      imageTop:picture.top-bounds.top, preparedAspect:image.naturalWidth/image.naturalHeight,
      tabBackground:getComputedStyle(card,'::before').backgroundImage, standardTab:getComputedStyle(standardCard,'::before').backgroundImage};
  })()`);
  assert.equal(folderArt.back, 'block');
  assert.equal(folderArt.tabBackground, folderArt.standardTab);
  assert.equal(folderArt.front, 'none');
  assert.equal(folderArt.fit, 'fill');
  assert.equal(folderArt.width, folderArt.standardWidth);
  assert.equal(folderArt.height, folderArt.standardHeight);
  assert.ok(folderArt.preparedAspect > 1.4, 'The uploaded tab must be excluded from the prepared rectangle');
  assert.equal(folderArt.imageWidth, folderArt.width);
  assert.equal(folderArt.imageHeight, folderArt.height - 29);
  assert.equal(folderArt.imageTop, 29);
  await evaluate(`document.querySelector('[data-document-id="${renamedDocument.id}"]').click()`);
  console.log('PASS folder image changes only the front rectangle; the rose tab and folder dimensions stay standard');
  console.log('PASS custom folder colours, cover preview, cancellation, reset and uploaded document cover without changing notes');
  const beforeTab = await snapshot();
  const priorCover = beforeTab.folders.find(folder=>folder.id===rootFolder.id).cover;
  await openTabEditor();
  assert.equal(await evaluate('document.getElementById("tabEyedropper")'), null);
  await evaluate("document.getElementById('tabColor').value='#7b5367';document.getElementById('tabColor').dispatchEvent(new Event('input'))");
  await waitFor('document.getElementById("tabColor").value === "#7b5367"');
  assert.deepEqual(await snapshot(), beforeTab);
  await click('dialogOk');
  await waitFor('!document.getElementById("dialog").open');
  await waitCoverSaved({...priorCover,tabColor:'#7b5367'});
  await openTabEditor();
  await evaluate("document.getElementById('tabColor').value='#e3b9cb';document.getElementById('tabColor').dispatchEvent(new Event('input'))");
  await evaluate("document.getElementById('dialog').close('cancel')");
  await delay(100);
  assert.deepEqual((await snapshot()).folders.find(folder=>folder.id===rootFolder.id).cover,{...priorCover,tabColor:'#7b5367'});
  await openTabEditor();
  await click('tabReset');
  await click('dialogOk');
  await waitFor('!document.getElementById("dialog").open');
  await waitCoverSaved(priorCover);
  await openTabEditor();
  await evaluate("document.getElementById('tabColor').value='#94647b';document.getElementById('tabColor').dispatchEvent(new Event('input'))");
  await click('dialogOk');
  await waitFor('!document.getElementById("dialog").open');
  await waitCoverSaved({...priorCover,tabColor:'#94647b'});
  await openCover(folderSelector,'changeFolderCover');
  await click('coverReset');
  assert.equal(await evaluate("getComputedStyle(document.querySelector('#coverPreview .folder-card'),'::before').backgroundColor"),'rgb(148, 100, 123)');
  assert.equal(await evaluate("document.querySelectorAll('#coverPreview .cover-image').length"),0);
  await evaluate("document.getElementById('dialog').close('cancel')");
  await delay(100);
  assert.deepEqual((await snapshot()).folders.find(folder=>folder.id===rootFolder.id).cover,{...priorCover,tabColor:'#94647b'});
  assert.deepEqual((await snapshot()).books,beforeTab.books);
  console.log('PASS independent tab colour without a separate eyedropper button, cancellation, reset and preserved folder image');
  await waitFor('document.getElementById("saveStatus").textContent === "✓ Сохранено"');
  const withFolders = await snapshot();
  assert.deepEqual(withFolders.books[0].pages, originalPages);
  await call('Page.reload', { ignoreCache: true });
  await waitFor('!!document.querySelector(".library-folder")');
  await delay(300);
  assert.deepEqual(await snapshot(), withFolders);
  await evaluate(`(async () => {
    const doc = ${JSON.stringify(withFolders)};
    await document.getElementById('restoreInput').onchange({target:{files:[new File([JSON.stringify(doc)],'folders-v1.json')],value:''}});
    document.getElementById('dialog').close('ok');
  })()`);
  await delay(250);
  assert.deepEqual(await snapshot(), withFolders);
  assert.deepEqual(await evaluate('window.__errors'), []);
  await evaluate(`document.querySelector('[data-document-id="${withFolders.books[0].id}"]').click()`);
  await delay(150);
  assert.equal((await snapshot()).activePage, originalPages[0].id);
  assert.deepEqual(await elements(), originalPages[0].elements);
  console.log('PASS legacy migration, nested and empty folders, canvas documents, confirmed page deletion, rename, JSON import and persisted hierarchy');

  async function requestRemoval(selector, actionId) {
    await contextMenu(selector);
    await waitFor(`!!document.getElementById(${JSON.stringify(actionId)})`);
    await click(actionId);
    await waitFor('document.getElementById("dialogTitle").textContent.startsWith("Удалить")');
  }
  const extraDocumentId = withFolders.books.at(-1).id;
  const documentMenu = `[data-document-id="${extraDocumentId}"]`;
  const beforeDeletion = await snapshot();
  await requestRemoval(documentMenu, 'removeDocument');
  await evaluate("document.getElementById('dialog').close('cancel')");
  await delay(100);
  assert.deepEqual(await snapshot(), beforeDeletion);
  await requestRemoval(documentMenu, 'removeDocument');
  await evaluate("document.getElementById('dialog').close('ok')");
  await delay(150);
  assert.equal((await snapshot()).books.some(book => book.id === extraDocumentId), false);
  assert.equal((await snapshot()).activePage, beforeDeletion.activePage);
  await evaluate(`document.querySelector('[data-document-id="${withFolders.books[1].id}"]').click()`);
  await requestRemoval(`[data-folder-id="${rootFolder.id}"] > summary`, 'removeFolder');
  await evaluate("document.getElementById('dialog').close('ok')");
  await delay(150);
  const afterFolderDeletion = await snapshot();
  assert.equal(afterFolderDeletion.books.length, 1);
  assert.deepEqual(afterFolderDeletion.books[0].pages, originalPages);
  assert.equal(afterFolderDeletion.folders.length, 1);
  await waitFor('document.getElementById("saveStatus").textContent === "✓ Сохранено"');
  const beforeReload = await evaluate('performance.timeOrigin');
  await call('Page.reload', {ignoreCache:true});
  await waitFor(`performance.timeOrigin !== ${beforeReload} && !!document.querySelector('.library-folder')`);
  assert.deepEqual(await snapshot(), afterFolderDeletion);
  await requestRemoval('.folder-row', 'removeFolder');
  await evaluate("document.getElementById('dialog').close('ok')");
  await delay(150);
  assert.equal((await snapshot()).books.length, 1);
  assert.equal((await elements()).length, 0);
  await evaluate("document.querySelector('[data-document-id]').click()");
  await tool('pen');
  await stroke([[100,100], [140,130], [180,120]]);
  assert.equal((await elements()).length, 1);
  assert.deepEqual(await evaluate('window.__errors'), []);
  console.log('PASS document and recursive folder deletion, cancellation, active document recovery, persisted deletion and writing after deleting the last notebook');

} finally {
  socket?.close();
  chrome.kill('SIGTERM');
}
