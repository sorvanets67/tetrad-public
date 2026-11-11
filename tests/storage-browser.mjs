// Uses a dedicated temporary profile, including across a real browser restart.
// Never reads, changes, or clears the user's browser profile.
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { mkdtemp, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { initialState, newPage, uid } from '../dist/core.mjs';
import { migrateLibrary } from '../dist/library.mjs';

const baseURL=process.argv[2] || 'http://127.0.0.1:8000/';
assert.equal(new URL(baseURL).origin,'http://127.0.0.1:8000');
const profile=await mkdtemp(join(tmpdir(),'vibenotes-storage-'));
const delay=ms=>new Promise(resolve=>setTimeout(resolve,ms));
let chrome, client, port;

async function connect(url) {
  const socket=new WebSocket(url);
  await once(socket,'open');
  let sequence=0;
  const pending=new Map();
  socket.addEventListener('message',event=>{
    const data=JSON.parse(event.data);
    if(data.id) pending.get(data.id)?.(data);
  });
  const call=(method,params={})=>new Promise((resolve,reject)=>{
    const id=++sequence;
    const timer=setTimeout(()=>{pending.delete(id);reject(Error('CDP timeout: '+method));},10000);
    pending.set(id,data=>{clearTimeout(timer);pending.delete(id);data.error?reject(Error(JSON.stringify(data.error))):resolve(data.result)});
    socket.send(JSON.stringify({id,method,params}));
  });
  const evaluate=async expression=>{
    const data=await call('Runtime.evaluate',{expression,awaitPromise:true,returnByValue:true});
    assert.ok(!data.exceptionDetails,JSON.stringify(data.exceptionDetails));
    return data.result.value;
  };
  const wait=async expression=>{
    for(let i=0;i<150;i++){if(await evaluate(expression))return;await delay(50);}
    throw Error('Condition timed out: '+expression);
  };
  return {socket,call,evaluate,wait};
}
async function launch() {
  chrome=spawn(process.env.CHROME_BIN || 'google-chrome-stable',[
    '--headless','--no-sandbox','--disable-gpu','--disable-background-networking',
    '--no-first-run','--no-default-browser-check','--remote-debugging-port=0',
    '--remote-debugging-address=127.0.0.1',`--user-data-dir=${profile}`,'about:blank'
  ],{stdio:'ignore'});
  let failure;chrome.on('error',error=>{failure=error});
  for(let i=0;i<150;i++){
    if(failure)throw failure;
    try {
      port=(await readFile(join(profile,'DevToolsActivePort'),'utf8')).split('\n')[0];
      const targets=await(await fetch(`http://127.0.0.1:${port}/json/list`)).json();
      client=await connect(targets.find(target=>target.type==='page').webSocketDebuggerUrl);
      await client.call('Page.enable');
      await client.call('Emulation.setFocusEmulationEnabled',{enabled:true});
      await client.call('Page.navigate',{url:baseURL});
      await client.wait('document.getElementById("saveStatus")?.textContent === "✓ Сохранено"');
      return;
    }catch(error){if(i===149)throw error;await delay(100);}
  }
}
async function stop() {
  if(!chrome)return;
  const exited=once(chrome,'exit');
  await client.call('Browser.close');
  await exited;
  client.socket.close();chrome=null;
}
const backup=()=>client.evaluate(`(async()=>{
  let blob;const original=URL.createObjectURL,click=HTMLAnchorElement.prototype.click;
  URL.createObjectURL=value=>{blob=value;return 'blob:test'};HTMLAnchorElement.prototype.click=()=>{};
  try {document.getElementById('backup').click();return JSON.parse(await blob.text());}
  finally{URL.createObjectURL=original;HTMLAnchorElement.prototype.click=click;}
})()`);
const stored=()=>client.evaluate(`(async()=>{
  const db=await new Promise((resolve,reject)=>{const r=indexedDB.open('tetrad-studio',1);r.onsuccess=()=>resolve(r.result);r.onerror=()=>reject(r.error)});
  try{return await new Promise((resolve,reject)=>{
    const tx=(window.__originalTx || IDBDatabase.prototype.transaction).call(db,'workspace','readonly');
    const req=tx.objectStore('workspace').get('state');tx.oncomplete=()=>resolve(req.result);tx.onabort=()=>reject(tx.error);
  });}finally{db.close();}
})()`);
async function reload(script) {
  const result=script?await client.call('Page.addScriptToEvaluateOnNewDocument',{source:script}):null;
  await client.call('Page.reload',{ignoreCache:true});
  await delay(350);
  if(result)await client.call('Page.removeScriptToEvaluateOnNewDocument',{identifier:result.identifier});
}

try {
  await launch();
  const fixture=migrateLibrary(initialState());
  const root=fixture.folders[0];root.name='Конспекты';
  const folder={id:uid(),name:'Математика',parentId:root.id};
  fixture.folders.push(folder,{id:uid(),name:'Пустая папка',parentId:folder.id});
  const photo='data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jRZkAAAAASUVORK5CYII=';
  const first=fixture.books[0];first.name='Урок 1';first.folderId=folder.id;
  first.cover={image:photo,spineColor:'#7b5367'};root.cover={image:photo,tabColor:'#94647b'};
  first.pages[0].paper='grid';first.pages[0].paperColor='yellow';
  first.pages[0].elements=[
    {id:uid(),type:'text',text:'Конспект после перезапуска\nВторая строка',x:40,y:40,size:24,color:'#000000'},
    {id:uid(),type:'stroke',tool:'pen',color:'#8d3e61',size:3,points:[{x:10,y:20,p:0.2},{x:90,y:80,p:0.8}]},
    {id:uid(),type:'image',src:photo,x:50,y:100,w:150,h:150}
  ];
  const second=newPage('Второй лист');second.paperColor='black';first.pages.push(second);
  fixture.books.push({id:uid(),name:'Урок 2',folderId:root.id,pages:[newPage()]});
  await client.evaluate(`(async()=>{
    await document.getElementById('restoreInput').onchange({target:{files:[new File([${JSON.stringify(JSON.stringify(fixture))}],'full.json',{type:'application/json'})],value:''}});
    document.getElementById('dialog').close('ok');
  })()`);
  await client.wait(`document.getElementById('saveStatus').textContent === '✓ Сохранено' && !document.getElementById('dialog').open && !!document.querySelector('[data-document-id="${first.id}"]')`);
  assert.deepEqual(await backup(),fixture);
  assert.deepEqual(await stored(),fixture);
  await reload();
  await client.wait('document.getElementById("saveStatus").textContent === "✓ Сохранено"');
  assert.deepEqual(await backup(),fixture);
  console.log('PASS complete JSON import/export and reload: text, pressure strokes, embedded photo, folders, covers, documents, pages and paper');

  const {targetId}=await client.call('Target.createTarget',{url:baseURL});
  const targets=await(await fetch(`http://127.0.0.1:${port}/json/list`)).json();
  const other=await connect(targets.find(target=>target.id===targetId).webSocketDebuggerUrl);
  await other.wait('document.getElementById("saveStatus")?.textContent === "Не удалось загрузить"');
  assert.match(await other.evaluate('document.getElementById("storageMessage").textContent'),/другой вкладке/);
  assert.equal(await other.evaluate('document.getElementById("newBook").disabled'),true);
  assert.deepEqual(await stored(),fixture);
  await client.call('Target.closeTarget',{targetId});other.socket.close();
  console.log('PASS second tab cannot replace notes with a stale workspace');

  await stop();
  await launch();
  assert.deepEqual(await backup(),fixture);
  assert.deepEqual(await stored(),fixture);
  console.log('PASS full browser process shutdown and restart with the same profile retains the complete notebook');

  await reload(`window.Worker=undefined;window.__denyWrite=true;window.__originalTx=IDBDatabase.prototype.transaction;
    IDBDatabase.prototype.transaction=function(...args){if(args[1]==='readwrite'&&window.__denyWrite)throw new DOMException('Test quota','QuotaExceededError');return __originalTx.apply(this,args)};`);
  await client.wait('document.getElementById("saveStatus").textContent === "Не сохранено"');
  assert.equal(await client.evaluate('document.getElementById("storageNotice").hidden'),false);
  assert.match(await client.evaluate('document.getElementById("storageMessage").textContent'),/не хватает места/);
  assert.deepEqual(await backup(),fixture);
  assert.deepEqual(await stored(),fixture);
  await client.evaluate('window.__denyWrite=false;document.getElementById("retrySave").click()');
  await client.wait('document.getElementById("saveStatus").textContent === "✓ Сохранено"');
  assert.deepEqual(await stored(),fixture);
  console.log('PASS quota failure stays visible, preserves notes and full export; retry acknowledges a real successful transaction');

  await reload(`window.__originalTx=IDBDatabase.prototype.transaction;
    IDBDatabase.prototype.transaction=function(...args){if(args[1]==='readonly')throw new DOMException('Test read failure','UnknownError');return __originalTx.apply(this,args)};`);
  await client.wait('document.getElementById("saveStatus").textContent === "Не удалось загрузить"');
  assert.equal(await client.evaluate('document.getElementById("newBook").disabled'),true);
  assert.equal(await client.evaluate('document.getElementById("libraryView").hidden'),true);
  assert.deepEqual(await stored(),fixture);
  console.log('PASS failed read leaves existing records untouched and never displays an empty starter notebook');

  await reload();
  await client.wait('document.getElementById("saveStatus").textContent === "✓ Сохранено"');
  assert.deepEqual(await backup(),fixture);
  console.log('PASS notes reopen intact after recovering from a read failure');
  const invalid=structuredClone(fixture);invalid.version=999;
  const writeRaw=async value=>client.evaluate(`(async()=>{
    const db=await new Promise((resolve,reject)=>{const r=indexedDB.open('tetrad-studio',1);r.onsuccess=()=>resolve(r.result);r.onerror=()=>reject(r.error)});
    try{await new Promise((resolve,reject)=>{const tx=db.transaction('workspace','readwrite',{durability:'strict'});tx.objectStore('workspace').put(${JSON.stringify(value)},'state');tx.oncomplete=resolve;tx.onabort=()=>reject(tx.error)});}finally{db.close();}
  })()`);
  await writeRaw(invalid);
  await reload();
  await client.wait('document.getElementById("saveStatus").textContent === "Не удалось загрузить"');
  assert.deepEqual(await stored(),invalid);
  assert.deepEqual(await backup(),invalid);
  assert.equal(await client.evaluate('document.getElementById("backup").disabled'),false);
  await writeRaw(fixture);
  await reload();
  await client.wait('document.getElementById("saveStatus").textContent === "✓ Сохранено"');
  assert.deepEqual(await backup(),fixture);
  console.log('PASS invalid stored format is preserved verbatim and remains exportable without a starter overwrite');

} finally {
  client?.socket.close();
  chrome?.kill('SIGTERM');
}
