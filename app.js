/* FocusFrame – privacy-first, static PWA. No servers, analytics or third-party code. */
'use strict';

const $ = id => document.getElementById(id);
const STORAGE_KEY = 'focusframe-settings-v1';
const DB_NAME = 'focusframe-local-v1';
const MAX_FRAMES = 150;
const MAX_GYM_MS = 10 * 60 * 1000; // Long videos are intentionally capped to protect phone storage.
const CLIP_SECONDS = 30;
const settingsDefaults = { mic: false, keepAwake: true, autoDim: true, autoDelete: 0 };
let settings;
try { settings = {...settingsDefaults, ...JSON.parse(localStorage.getItem(STORAGE_KEY) || '{}')}; }
catch { settings = {...settingsDefaults}; }

let dbPromise;
let active = null;
let busy = false;
let ticker = null;
let captureTicker = null;
let autoDimTimer = null;
let wakeLock = null;
let dimmed = false;
let cameraFacing = 'user';
let selectedMode = 'timelapse';
let toastTimeout;
let dialogUrl = null;
let dialogSession = null;
let thumbnailUrls = [];
let lastDraftPersist = 0;
const preview = $('livePreview');
const captureCanvas = document.createElement('canvas');

function showToast(message, timeout = 4400) {
  const element = $('toast'); element.textContent = message;
  element.classList.add('show'); clearTimeout(toastTimeout);
  toastTimeout = setTimeout(() => element.classList.remove('show'), timeout);
}
function formatTime(ms) {
  const secs = Math.floor(Math.max(0, ms) / 1000);
  return [Math.floor(secs / 3600), Math.floor(secs % 3600 / 60), secs % 60].map(n => String(n).padStart(2, '0')).join(':');
}
function formatMinutes(ms) {
  const minutes = Math.round(ms / 60000);
  return minutes >= 60 ? `${Math.floor(minutes / 60)}h ${minutes % 60}m` : `${minutes}m`;
}
function escapeHTML(s) {
  return String(s).replace(/[&<>"']/g, ch => ({'&':'&amp;', '<':'&lt;', '>':'&gt;', '"':'&quot;', "'":'&#39;'}[ch]));
}
function saveSettings() { try { localStorage.setItem(STORAGE_KEY, JSON.stringify(settings)); } catch {} }
function dateKey(date) {
  return `${date.getFullYear()}-${String(date.getMonth()+1).padStart(2,'0')}-${String(date.getDate()).padStart(2,'0')}`;
}
function dayDate(key) { const [y,m,d] = key.split('-').map(Number); return new Date(y,m-1,d); }
function minusDays(d, amount) { return new Date(d.getFullYear(), d.getMonth(), d.getDate() - amount); }
function sleep(ms) { return new Promise(resolve => setTimeout(resolve,ms)); }

function openDB() {
  if (!('indexedDB' in window)) return Promise.reject(new Error('Dein Browser bietet keinen lokalen Videospeicher.'));
  if (!dbPromise) dbPromise = new Promise((resolve,reject) => {
    const req = indexedDB.open(DB_NAME, 1);
    req.onupgradeneeded = () => {
      const db = req.result;
      if (!db.objectStoreNames.contains('sessions')) db.createObjectStore('sessions',{keyPath:'id'});
      if (!db.objectStoreNames.contains('frames')) db.createObjectStore('frames',{keyPath:['sid','n']}).createIndex('sid','sid');
      if (!db.objectStoreNames.contains('chunks')) db.createObjectStore('chunks',{keyPath:['sid','n']}).createIndex('sid','sid');
    };
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error || new Error('Speicher konnte nicht geöffnet werden.'));
  }).catch(error => { dbPromise = null; throw error; });
  return dbPromise;
}
async function dbPut(name, data) {
  const db = await openDB();
  return new Promise((resolve,reject) => {
    const tx = db.transaction(name, 'readwrite'); tx.objectStore(name).put(data);
    tx.oncomplete = () => resolve(); tx.onerror = () => reject(tx.error || new Error('Speichern fehlgeschlagen.'));
    tx.onabort = () => reject(tx.error || new Error('Speicher voll oder blockiert.'));
  });
}
async function dbGet(name, key) {
  const db = await openDB();
  return new Promise((resolve,reject) => {
    const req = db.transaction(name, 'readonly').objectStore(name).get(key);
    req.onsuccess = () => resolve(req.result); req.onerror = () => reject(req.error);
  });
}
async function dbAll(name, sid) {
  const db = await openDB();
  return new Promise((resolve,reject) => {
    const store = db.transaction(name, 'readonly').objectStore(name);
    const req = sid === undefined ? store.getAll() : store.index('sid').getAll(IDBKeyRange.only(sid));
    req.onsuccess = () => resolve(req.result); req.onerror = () => reject(req.error);
  });
}
async function dbDelete(name, key) {
  const db = await openDB();
  return new Promise((resolve,reject) => {
    const tx = db.transaction(name,'readwrite'); tx.objectStore(name).delete(key);
    tx.oncomplete = () => resolve(); tx.onerror = () => reject(tx.error);
  });
}
async function deleteSessionItems(name,sid,onlyOdd=false) {
  const items = await dbAll(name,sid);
  if (!items.length) return 0;
  const db = await openDB();
  return new Promise((resolve,reject) => {
    const tx = db.transaction(name,'readwrite'); const store = tx.objectStore(name);
    for (let i=0;i<items.length;i++) {
      if (!onlyOdd || (i%2 === 1 && i !== items.length-1)) store.delete([sid,items[i].n]);
    }
    tx.oncomplete = () => resolve(onlyOdd ? items.filter((_,i)=>i%2 === 0 || i===items.length-1).length : 0);
    tx.onerror = () => reject(tx.error);
  });
}
async function fullyDeleteSession(id) {
  await Promise.all([deleteSessionItems('frames',id), deleteSessionItems('chunks',id)]);
  await dbDelete('sessions',id);
}

function setMode(mode) {
  if (active || busy) return;
  selectedMode = mode;
  document.querySelectorAll('.mode-btn').forEach(b => b.classList.toggle('active', b.dataset.mode === mode));
  $('stageMode').textContent = {timelapse:'ZEITRAFFER',video:'ECHTZEIT',timer:'NUR TIMER'}[mode];
  $('modeExplanation').textContent = {
    timelapse:'Zeitraffer: nur einzelne komprimierte Bilder, intelligent ausgedünnt. Beim Beenden wird daraus ein Video von etwa 30 Sekunden mit eingeblendeter vergangener Aufnahmezeit (ohne Ton).',
    video:'Gym-Video: echte Bewegung für deine Technik-Analyse. Höherer Speicherbedarf; pro Clip maximal 10 Minuten. Ton nur, wenn in Optionen aktiviert.',
    timer:'Nur Timer: komplett ohne Kamera, ohne Video und mit besonders geringem Akkuverbrauch.'
  }[mode];
  $('cameraIdle').querySelector('h3').textContent = mode === 'timer' ? 'Deine Zeit zählt.' : 'Dein Moment zählt.';
  $('startLabel').textContent = mode === 'timer' ? 'Fokus-Timer starten' : 'Fokus starten';
}
function updateUI() {
  const recording = !!active;
  $('recordState').innerHTML = recording ? '<span class="state-dot"></span> Läuft' : '<span class="state-dot"></span> Bereit';
  $('recordState').classList.toggle('is-recording',recording);
  $('previewBadge').hidden = !recording || active.mode === 'timer';
  $('startStop').classList.toggle('is-stop',recording);
  $('startIcon').textContent = recording ? '■' : '●';
  $('startLabel').textContent = recording ? 'Beenden & speichern' : selectedMode === 'timer' ? 'Fokus-Timer starten' : 'Fokus starten';
  $('startStop').disabled = busy;
  $('dimButton').disabled = !recording;
  $('keepAwakeButton').disabled = !recording;
  $('keepAwakeButton').textContent = `☀ Wachhalten: ${recording && active.keepAwake ? 'an' : 'aus'}`;
  $('stageTitle').textContent = recording ? 'DEINE FOKUSZEIT' : 'BEREIT ZUM START';
  $('cameraStage').classList.toggle('has-video',recording && active.mode !== 'timer');
  preview.classList.toggle('front',cameraFacing === 'user');
  $('flipCamera').disabled = recording;
  for (const id of ['sessionTitle','sessionCategory','goalMinutes','pomodoroEnabled']) $(id).disabled = recording;
  document.querySelectorAll('.mode-btn').forEach(b=>b.disabled=recording);
}
function currentDuration(a=active) {
  if (!a) return 0;
  return Math.max(0, Date.now()-a.startedAt-a.pausedMs-(a.pausedAt ? Date.now()-a.pausedAt : 0));
}
async function acquireWakeLock() {
  if (!active || !active.keepAwake || document.visibilityState !== 'visible' || !navigator.wakeLock || wakeLock) return;
  try { wakeLock = await navigator.wakeLock.request('screen'); }
  catch { /* Not guaranteed on all iOS versions and low-power states. */ }
}
async function releaseWakeLock() {
  if (wakeLock) { const ref=wakeLock; wakeLock=null; try { await ref.release(); } catch {} }
}
function chooseMime() {
  if (!window.MediaRecorder) return null;
  const formats=['video/mp4;codecs=avc1.42E01E','video/mp4','video/webm;codecs=vp8','video/webm;codecs=vp9','video/webm'];
  return formats.find(type=>MediaRecorder.isTypeSupported(type)) || '';
}
async function createCameraStream(useMic=false) {
  if (!navigator.mediaDevices?.getUserMedia) throw new Error('Kamera nicht verfügbar. Öffne die Seite über HTTPS in Safari.');
  const constraints={
    audio:useMic ? {echoCancellation:true,noiseSuppression:true} : false,
    video:{facingMode:{ideal:cameraFacing},width:{ideal:1280},height:{ideal:720},frameRate:{ideal:24,max:30}}
  };
  try { return await navigator.mediaDevices.getUserMedia(constraints); }
  catch(error) {
    if (useMic && (error.name==='NotFoundError'||error.name==='OverconstrainedError')) {
      return navigator.mediaDevices.getUserMedia({...constraints,audio:false});
    }
    if (error.name==='NotAllowedError') throw new Error('Bitte Kamera-Zugriff in Safari erlauben.');
    if (error.name==='NotFoundError') throw new Error('Keine Kamera gefunden.');
    throw error;
  }
}
function stopCamera(stream) {
  if (stream) stream.getTracks().forEach(track=>track.stop());
  preview.pause(); preview.srcObject=null;
}
function makeId() {
  return (crypto.randomUUID?.() || `${Date.now()}-${Math.random().toString(36).slice(2)}`);
}
async function startSession() {
  if (busy || active) return;
  busy=true; updateUI();
  let stream;
  try {
    await openDB();
    const mode=selectedMode;
    if (mode==='video' && !window.MediaRecorder) throw new Error('Echtzeitvideos werden von diesem Browser nicht unterstützt.');
    if (mode==='video' && chooseMime()===null) throw new Error('Kein kompatibles Aufnahmeformat gefunden.');
    if (mode==='timelapse' && !captureCanvas.toBlob) throw new Error('Bilderfassung wird von diesem Browser nicht unterstützt.');
    if (mode!=='timer') {
      stream=await createCameraStream(mode==='video' && settings.mic);
      preview.srcObject=stream;
      $('cameraStage').classList.add('has-video');
      preview.muted=true;
      await preview.play();
      if (!preview.videoWidth) await new Promise(resolve => {preview.addEventListener('loadedmetadata',resolve,{once:true});setTimeout(resolve,1200);});
    }
    const newSession = {
      id:makeId(),mode,title:$('sessionTitle').value.trim() || 'Fokus-Session',category:$('sessionCategory').value,
      startedAt:Date.now(),pausedMs:0,pausedAt:null,keepAwake:!!settings.keepAwake,
      durationMs:0,goalMs:Math.max(0,Math.min(480,Number($('goalMinutes').value)||0))*60000,
      pomodoro:$('pomodoroEnabled').checked,prevPhase:'focus',goalNotified:false,stream,
      nextSampleAt:Date.now(),sampleEveryMs:3000,framesStored:0,seq:0,writing:false,writes:[],
      recorder:null,mime:'',chunkNumber:0,writeError:null,thumbnail:null,ended:false
    };
    await dbPut('sessions',{
      id:newSession.id,title:newSession.title,category:newSession.category,mode:newSession.mode,
      startedAt:newSession.startedAt,durationMs:0,status:'draft'
    });
    if (mode==='video') {
      const mime=chooseMime(); newSession.mime=mime;
      const options={videoBitsPerSecond:850000}; if (mime) options.mimeType=mime;
      try { newSession.recorder=new MediaRecorder(stream,options); }
      catch { newSession.recorder=new MediaRecorder(stream); }
      newSession.mime=newSession.recorder.mimeType || mime || 'video/mp4';
      newSession.recorder.ondataavailable = e => {
        if (!e.data || !e.data.size) return;
        const n=newSession.chunkNumber++;
        const job=dbPut('chunks',{sid:newSession.id,n,blob:e.data}).catch(error=>{newSession.writeError=error;});
        newSession.writes.push(job);
      };
      newSession.recorder.onerror = event => { newSession.writeError=event.error||new Error('Videoaufnahme fehlgeschlagen.'); };
      newSession.recorder.start(10000); // Periodically flush camera footage to IndexedDB.
    }
    active=newSession;
    busy=false;
    await acquireWakeLock();
    updateUI();
    ticker=setInterval(tick,1000);
    if (mode==='timelapse') { captureTicker=setInterval(maybeCapture,850); maybeCapture(); }
    if (settings.autoDim) autoDimTimer=setTimeout(() => { if (active===newSession && !busy) setDim(true); },15000);
    tick();
    showToast(mode==='timer' ? 'Timer gestartet.' : 'Aufnahme läuft. Lass die App geöffnet.');
  } catch(error) {
    if (stream) stopCamera(stream);
    $('cameraStage').classList.remove('has-video');
    active=null; busy=false; updateUI();
    showToast(error.message || 'Die Aufnahme konnte nicht starten.',6500);
  }
}
function paintVideo(video,canvas,mirror=false) {
  const ctx=canvas.getContext('2d',{alpha:false});
  ctx.fillStyle='#101010';ctx.fillRect(0,0,canvas.width,canvas.height);
  const vw=video.videoWidth || 1280, vh=video.videoHeight || 720;
  const ratio=Math.max(canvas.width/vw,canvas.height/vh);
  const w=vw*ratio,h=vh*ratio,x=(canvas.width-w)/2,y=(canvas.height-h)/2;
  if(mirror){ctx.save();ctx.translate(canvas.width,0);ctx.scale(-1,1);ctx.drawImage(video,x,y,w,h);ctx.restore();}
  else ctx.drawImage(video,x,y,w,h);
}
function canvasBlob(canvas,type='image/jpeg',quality=.55) {
  return new Promise((resolve,reject) => canvas.toBlob(blob => blob ? resolve(blob) : reject(new Error('Bildkonvertierung fehlgeschlagen.')),type,quality));
}
async function maybeCapture() {
  const a=active;
  if (!a || a.mode!=='timelapse' || a.writing || a.pausedAt || busy || document.hidden || Date.now()<a.nextSampleAt) return;
  if (preview.readyState<2 || preview.videoWidth===0) return;
  a.writing=true;
  a.nextSampleAt=Date.now()+a.sampleEveryMs;
  try {
    const vw=preview.videoWidth,vh=preview.videoHeight;
    const factor=Math.min(1,800/Math.max(vw,vh));
    captureCanvas.width=Math.max(2,Math.round(vw*factor));captureCanvas.height=Math.max(2,Math.round(vh*factor));
    paintVideo(preview,captureCanvas,cameraFacing==='user');
    const elapsedMs=currentDuration(a); // Zeit des aufgenommenen Bildes, Pausen abgezogen.
    const blob=await canvasBlob(captureCanvas,'image/jpeg',.48);
    if (blob.size) {
      const n=a.seq++;
      await dbPut('frames',{sid:a.id,n,blob,elapsedMs});
      a.framesStored++;
      a.thumbnail=blob;
      if (a.framesStored>MAX_FRAMES) {
        a.framesStored=await deleteSessionItems('frames',a.id,true);
        a.sampleEveryMs*=2;
      }
    }
  } catch(error) {
    showToast('Einzelbild nicht gespeichert: '+(error.message || 'Speicherfehler'));
  } finally { a.writing=false; }
}
function signalPhase() {
  try {navigator.vibrate?.([200,100,200]);}catch{}
}
function tick() {
  const a=active; if (!a) return;
  const elapsed=currentDuration(a);
  $('timerDisplay').textContent=formatTime(elapsed);
  $('dimTime').textContent=formatTime(elapsed);
  let phaseLabel='FOKUS LÄUFT';
  if (a.pomodoro) {
    const pos=elapsed%(30*60000);
    const inBreak=pos>=25*60000;
    const remain=(inBreak ? 30*60000 : 25*60000)-pos;
    phaseLabel=`${inBreak?'PAUSE':'FOKUS'} · ${Math.ceil(remain/60000)} MIN REST`;
    const phase=inBreak?'break':'focus';
    if (phase!==a.prevPhase) {a.prevPhase=phase;signalPhase();showToast(inBreak?'25 Minuten geschafft! 5 Minuten Pause.':'Pause vorbei. Weiter geht’s!');}
  }
  $('dimFocus').textContent=phaseLabel;
  if (a.goalMs && elapsed>=a.goalMs && !a.goalNotified) {a.goalNotified=true;signalPhase();showToast('Dein Zeitziel ist erreicht!');}
  if (a.mode==='video' && elapsed>=MAX_GYM_MS && !busy) {
    showToast('10-Minuten-Limit erreicht. Video wird gespeichert.'); stopSession(); return;
  }
  if (!busy && Date.now()-lastDraftPersist>12000) {
    lastDraftPersist=Date.now();
    // Update a lightweight checkpoint so interrupted sessions can be recovered.
    dbGet('sessions',a.id).then(s=> {if (active===a && !a.ended && s?.status==='draft') {s.durationMs=elapsed;return dbPut('sessions',s);} }).catch(()=>{});
  }
}
async function stopSession() {
  if (!active || busy) return;
  busy=true;
  const a=active; a.durationMs=currentDuration(a);a.ended=true;
  clearInterval(ticker); clearInterval(captureTicker);clearTimeout(autoDimTimer);ticker=captureTicker=autoDimTimer=null;
  if (dimmed) setDim(false);
  $('startLabel').textContent='Speichere Session …';updateUI();
  try {
    if (a.mode==='timelapse') {
      let spins=0;
      while(a.writing && spins++<60) await sleep(100);
    }
    if (a.recorder && a.recorder.state!=='inactive') {
      await new Promise(resolve => {
        const done=()=>resolve();
        a.recorder.addEventListener('stop',done,{once:true});
        try {a.recorder.stop();} catch {resolve();}
        setTimeout(resolve,3500);
      });
    }
    stopCamera(a.stream);
    await Promise.all(a.writes);
    if (a.writeError) throw a.writeError;
    await completeDraft(a.id,a);
    showToast('Session gespeichert – du findest sie unter Sessions.',5100);
  } catch(error) {
    // Deliberately retain IndexedDB draft, raw video chunks and sampled frames.
    showToast('Export fehlgeschlagen. Deine Rohdaten bleiben unter Sessions zur Rettung erhalten: '+(error.message||''),7500);
  } finally {
    await releaseWakeLock();active=null;busy=false;
    $('timerDisplay').textContent='00:00:00';$('stageTitle').textContent='BEREIT ZUM START';
    updateUI(); await renderLibrary(); await renderStats();updateStorage();
  }
}
async function waitForImage(blob) {
  if ('createImageBitmap' in window) {
    try { const bitmap=await createImageBitmap(blob); return {image:bitmap,close:()=>bitmap.close()}; } catch {}
  }
  const url=URL.createObjectURL(blob);
  try {
    const image=new Image(); image.src=url;
    await new Promise((resolve,reject) => {image.onload=resolve;image.onerror=reject;});
    return {image,close:()=>URL.revokeObjectURL(url)};
  } catch (e) { URL.revokeObjectURL(url);throw e; }
}
function paintImageCover(ctx,image,w,h) {
  ctx.fillStyle='#000';ctx.fillRect(0,0,w,h);
  const srcW=image.width,srcH=image.height;
  const scale=Math.max(w/srcW,h/srcH), width=srcW*scale,height=srcH*scale;
  ctx.drawImage(image,(w-width)/2,(h-height)/2,width,height);
}
// Die Uhr wird direkt in die Videobilder gezeichnet und ist daher auch im Export sichtbar.
function paintElapsedOverlay(ctx, elapsedMs, width, height) {
  const size=Math.max(18,Math.min(38,Math.round(width*0.043)));
  const pad=Math.max(12,Math.round(size*0.55));
  const x=pad,y=pad;
  const label=formatTime(elapsedMs);
  ctx.save();
  ctx.font=`600 ${size}px ui-monospace, SFMono-Regular, Menlo, Consolas, monospace`;
  const labelWidth=ctx.measureText(label).width;
  const h=size+pad*1.4;
  const dot=Math.max(5,Math.round(size*.12));
  const w=labelWidth+pad*2.5+dot*2;
  const r=Math.min(14,h/4);
  ctx.fillStyle='rgba(0,0,0,0.76)';
  ctx.beginPath();
  ctx.moveTo(x+r,y);ctx.lineTo(x+w-r,y);ctx.quadraticCurveTo(x+w,y,x+w,y+r);
  ctx.lineTo(x+w,y+h-r);ctx.quadraticCurveTo(x+w,y+h,x+w-r,y+h);
  ctx.lineTo(x+r,y+h);ctx.quadraticCurveTo(x,y+h,x,y+h-r);
  ctx.lineTo(x,y+r);ctx.quadraticCurveTo(x,y,x+r,y);ctx.closePath();ctx.fill();
  ctx.fillStyle='#e8c663';
  ctx.beginPath();ctx.arc(x+pad+dot,y+h/2,dot,0,Math.PI*2);ctx.fill();
  ctx.fillStyle='#ffffff';
  ctx.textBaseline='middle';
  ctx.fillText(label,x+pad*1.5+dot*2,y+h/2+1);
  ctx.restore();
}
async function buildTimelapse(frames, actualDurationMs=0) {
  if (!frames.length) throw new Error('Es wurden keine Kamerabilder erfasst.');
  if (!window.MediaRecorder || !HTMLCanvasElement.prototype.captureStream || chooseMime()===null) return buildContactSheet(frames);
  const first=await waitForImage(frames[0].blob);
  const width=first.image.width,height=first.image.height;
  const canvas=document.createElement('canvas');canvas.width=width;canvas.height=height;
  const ctx=canvas.getContext('2d',{alpha:false});
  paintImageCover(ctx,first.image,width,height);
  paintElapsedOverlay(ctx,0,width,height);
  first.close();
  const stream=canvas.captureStream(12);
  let recorder, mime=chooseMime();
  try {recorder=new MediaRecorder(stream,mime?{mimeType:mime,videoBitsPerSecond:650000}:{videoBitsPerSecond:650000});}
  catch {stream.getTracks().forEach(track=>track.stop());return buildContactSheet(frames);}
  mime=recorder.mimeType || mime || 'video/mp4';
  const chunks=[];
  recorder.ondataavailable=event=>{if (event.data?.size) chunks.push(event.data);};
  const finished=new Promise((resolve,reject)=>{
    recorder.addEventListener('stop',resolve,{once:true});
    recorder.addEventListener('error',event=>reject(event.error||new Error('Video-Encoding fehlgeschlagen.')),{once:true});
  });
  const durationMs=Math.max(0,actualDurationMs||0);
  // Die gespeicherten echten Aufnahmezeitpunkte bleiben nach der Ausdünnung erhalten.
  // Ältere, noch nicht exportierte Sessions ohne Zeitstempel bleiben kompatibel.
  const times=frames.map((frame,i)=> Number.isFinite(frame.elapsedMs)
    ? Math.max(0,Math.min(durationMs,frame.elapsedMs))
    : durationMs*i/Math.max(1,frames.length-1));
  let currentFrame=0;
  let loadedFrame=-1;
  let loadedImage=null;
  async function renderAt(elapsedMs) {
    while(currentFrame+1<frames.length && times[currentFrame+1]<=elapsedMs) currentFrame++;
    if(currentFrame!==loadedFrame) {
      const next=await waitForImage(frames[currentFrame].blob);
      loadedImage?.close();loadedImage=next;loadedFrame=currentFrame;
    }
    paintImageCover(ctx,loadedImage.image,width,height);
    paintElapsedOverlay(ctx,elapsedMs,width,height);
  }
  try {
    recorder.start();
    const fps=10, intervalMs=1000/fps, clipMs=CLIP_SECONDS*1000;
    const started=performance.now();
    let nextTick=0;
    // Echtzeit-Taktung: Lade-/Decodierzeit verlängert den Clip nicht künstlich.
    while (performance.now()-started<clipMs) {
      const playMs=Math.min(clipMs,Math.max(0,performance.now()-started));
      const elapsedMs=durationMs*Math.min(1,playMs/Math.max(1,clipMs-intervalMs));
      await renderAt(elapsedMs);
      nextTick++;
      const remaining=Math.min(started+nextTick*intervalMs,started+clipMs)-performance.now();
      if(remaining>0) await sleep(remaining);
      else await sleep(0); // Browser-Encoder darf auch bei langsamen Geräten arbeiten.
    }
    if(recorder.state!=='inactive') recorder.stop();
    // Einige Browser liefern nach stop() kein Ereignis: Export begrenzen, statt zu hängen.
    await Promise.race([
      finished,
      sleep(9000).then(()=>{throw new Error('Video-Encoder antwortet nicht.');})
    ]);
    const blob=new Blob(chunks,{type:mime});
    if(!blob.size) throw new Error('Encoder hat kein Video geliefert.');
    return {blob,mediaType:'video',mime};
  } catch(error) {
    if(recorder.state!=='inactive') try{recorder.stop();}catch{}
    // Best-effort: bei nicht unterstütztem Canvas-Encoding Bildübersicht bewahren.
    return buildContactSheet(frames);
  } finally {
    loadedImage?.close();
    stream.getTracks().forEach(track=>track.stop());
  }
}
async function buildContactSheet(frames) {
  const picks=frames.filter((_,i)=>i%Math.max(1,Math.ceil(frames.length/24))===0).slice(0,24);
  const canvas=document.createElement('canvas');canvas.width=1200;canvas.height=675;
  const ctx=canvas.getContext('2d',{alpha:false});ctx.fillStyle='#0b0b0b';ctx.fillRect(0,0,1200,675);
  const cellW=200,cellH=168.75;
  for(let i=0;i<picks.length;i++) {
    const {image,close}=await waitForImage(picks[i].blob);
    ctx.save();ctx.beginPath();ctx.rect(i%6*cellW,Math.floor(i/6)*cellH,cellW,cellH);ctx.clip();
    ctx.translate(i%6*cellW,Math.floor(i/6)*cellH);paintImageCover(ctx,image,cellW,cellH);ctx.restore();close();
  }
  return {blob:await canvasBlob(canvas,'image/jpeg',.84),mediaType:'image',mime:'image/jpeg'};
}
async function completeDraft(id, runtime=null) {
  const saved=await dbGet('sessions',id);
  if (!saved || saved.status!=='draft') throw new Error('Session nicht gefunden.');
  const mode=saved.mode;
  let result={blob:null,mediaType:'timer',mime:''};
  let thumbnail=runtime?.thumbnail || null;
  if (mode==='timelapse') {
    const frames=await dbAll('frames',id);
    if (!frames.length) throw new Error('Keine Zeitraffer-Bilder vorhanden.');
    thumbnail=thumbnail||frames[Math.floor(frames.length/2)].blob;
    showToast('Erstelle 30-Sekunden-Zeitraffer mit Timer … Bitte App offen lassen.',35000);
    result=await buildTimelapse(frames,runtime?.durationMs ?? saved.durationMs);
  } else if (mode==='video') {
    const chunks=await dbAll('chunks',id);
    const mime=runtime?.mime || chunks[0]?.blob?.type || 'video/mp4';
    const blob=new Blob(chunks.map(c=>c.blob),{type:mime});
    if(!blob.size) throw new Error('Keine Video-Daten vorhanden.');
    result={blob,mediaType:'video',mime};
  }
  const completed={...saved,durationMs:runtime?.durationMs ?? saved.durationMs,
    status:'complete',mediaType:result.mediaType,mime:result.mime,
    blob:result.blob,thumbnail:thumbnail||null,completedAt:Date.now()};
  await dbPut('sessions',completed);
  await Promise.all([deleteSessionItems('frames',id),deleteSessionItems('chunks',id)]);
  if (result.mediaType==='image') showToast('Video-Encoding nicht möglich: Bildübersicht als Ersatz gespeichert.',7000);
}

function setDim(value) {
  dimmed=!!value;
  $('dimScreen').classList.toggle('show',dimmed);
  $('dimScreen').setAttribute('aria-hidden',String(!dimmed));
  if (dimmed) tick();
}
async function switchCamera() {
  if(active || busy) return;
  cameraFacing=cameraFacing==='user'?'environment':'user';
  preview.classList.toggle('front',cameraFacing==='user');
  showToast(cameraFacing==='user'?'Frontkamera beim nächsten Start.':'Rückkamera beim nächsten Start.');
}
async function toggleWake() {
  if(!active) return;
  active.keepAwake=!active.keepAwake;
  if(active.keepAwake) await acquireWakeLock();else await releaseWakeLock();
  updateUI();
}
async function switchTab(id) {
  if (active || busy) {showToast('Beende erst die Aufnahme, bevor du die Ansicht wechselst.');return;}
  document.querySelectorAll('.view').forEach(v=>v.classList.toggle('active',v.id===`view-${id}`));
  document.querySelectorAll('.nav-btn').forEach(b=>b.classList.toggle('selected',b.dataset.tab===id));
  if(id==='library') await renderLibrary();
  if(id==='stats') await renderStats();
  if(id==='settings') await updateStorage();
  window.scrollTo({top:0,behavior:'smooth'});
}
function dateLabel(timestamp) {
  return new Date(timestamp).toLocaleDateString('de-DE',{day:'2-digit',month:'short',year:'numeric'});
}
async function renderLibrary() {
  const container=$('libraryList');
  thumbnailUrls.forEach(url=>URL.revokeObjectURL(url));thumbnailUrls=[];
  let sessions;
  try {sessions=(await dbAll('sessions')).sort((a,b)=>b.startedAt-a.startedAt);}catch {container.innerHTML='<div class="empty-state">Lokaler Speicher konnte nicht gelesen werden.</div>';return;}
  container.replaceChildren();
  if(!sessions.length){container.innerHTML='<div class="empty-state">Noch keine Sessions gespeichert. Starte deine erste Aufnahme!</div>';return;}
  for(const session of sessions) {
    const card=document.createElement('article');card.className='session-card';
    const thumb=session.thumbnail?URL.createObjectURL(session.thumbnail):'icon-192.png';
    if(session.thumbnail) thumbnailUrls.push(thumb);
    const duration=formatTime(session.durationMs || 0);
    const type=session.status==='draft'?'UNTERBROCHEN':({video:'VIDEO',image:'BILDÜBERSICHT',timer:'TIMER'}[session.mediaType]||'SESSION');
    card.innerHTML=`<div class="session-body"><img class="session-thumb" alt="Vorschaubild" src="${thumb}"><div class="session-meta"><span class="session-type">${type}</span><h3>${escapeHTML(session.title)}</h3><p>${escapeHTML(session.category)} · ${dateLabel(session.startedAt)}</p><p>◷ ${duration} · ${session.mode==='timelapse'?'Zeitraffer':session.mode==='video'?'Gym-Video':'Fokuszeit'}</p></div></div><div class="session-actions"></div>`;
    const actions=card.querySelector('.session-actions');
    const addButton=(text,handler,cls='')=>{const b=document.createElement('button');b.textContent=text;b.type='button';if(cls)b.className=cls;b.addEventListener('click',handler);actions.append(b);};
    if(session.status==='draft') addButton('↻ Aufnahme retten',()=>recoverSession(session.id));
    else if(session.mediaType==='timer') addButton('✓ Erfasst',()=>showToast('Diese Session enthält nur die Zeit, kein Video.'));
    else addButton('▶ Ansehen',()=>openMedia(session));
    if(session.status==='complete' && session.blob) addButton('↓ Export',()=>shareSession(session));
    addButton('✕ Löschen',()=>removeSession(session.id),'delete-btn');
    container.append(card);
  }
}
async function recoverSession(id) {
  if (busy || active) return;
  if(!confirm('Unterbrochene Session aus den gespeicherten Rohdaten fertigstellen?')) return;
  busy=true;
  try {await completeDraft(id);showToast('Gerettete Session gespeichert.');}
  catch(error){showToast('Rettung nicht möglich: '+error.message,6500);}
  finally{busy=false;await renderLibrary();await renderStats();updateStorage();}
}
async function removeSession(id) {
  if(!confirm('Session und alle dazugehörigen Daten wirklich endgültig löschen?')) return;
  try {await fullyDeleteSession(id);showToast('Session gelöscht.');await renderLibrary();await renderStats();updateStorage();}
  catch(error){showToast('Löschen fehlgeschlagen: '+error.message);}
}
function openMedia(session) {
  if(dialogUrl) URL.revokeObjectURL(dialogUrl);
  dialogSession=session;dialogUrl=URL.createObjectURL(session.blob);
  $('dialogTitle').textContent=session.title;
  $('dialogInfo').textContent=`${dateLabel(session.startedAt)} · ${formatTime(session.durationMs)} · ${session.mediaType==='image'?'Bildübersicht':session.mode==='timelapse'?'30-Sekunden-Zeitraffer mit Timer':'Originalvideo'}`;
  const isVideo=session.mediaType==='video';
  $('savedVideo').hidden=!isVideo;$('savedImage').hidden=isVideo;
  if(isVideo) {$('savedVideo').src=dialogUrl;$('savedImage').removeAttribute('src');}
  else {$('savedVideo').removeAttribute('src');$('savedImage').src=dialogUrl;}
  $('videoDialog').showModal();
}
function closeDialog() {
  $('savedVideo').pause();$('savedVideo').removeAttribute('src');$('savedVideo').load();$('savedImage').removeAttribute('src');
  if(dialogUrl){URL.revokeObjectURL(dialogUrl);dialogUrl=null;}
  dialogSession=null;$('videoDialog').close();
}
async function shareSession(session) {
  if(!session.blob) return;
  const subtype=session.mediaType==='image'?'jpg':(session.mime||session.blob.type).includes('webm')?'webm':'mp4';
  const cleanName=session.title.replace(/[^a-zA-Z0-9äöüÄÖÜß_-]+/g,'-').slice(0,38)||'Session';
  const filename=`FocusFrame-${cleanName}-${dateKey(new Date(session.startedAt))}.${subtype}`;
  const file=new File([session.blob],filename,{type:session.mime||session.blob.type||(subtype==='jpg'?'image/jpeg':'video/mp4')});
  if(navigator.canShare?.({files:[file]})) {
    try {await navigator.share({files:[file],title:session.title});return;}
    catch(error) {if(error.name==='AbortError')return;}
  }
  const url=URL.createObjectURL(session.blob);
  const anchor=document.createElement('a');anchor.href=url;anchor.download=filename;
  document.body.append(anchor);anchor.click();anchor.remove();
  setTimeout(()=>URL.revokeObjectURL(url),60000);
  showToast('Datei wird über deinen Browser bereitgestellt.');
}
function sessionStats(sessions) {
  const complete=sessions.filter(s=>s.status==='complete');
  const total=complete.reduce((sum,s)=>sum+(s.durationMs||0),0);
  const dates=new Set(complete.map(s=>dateKey(new Date(s.startedAt))));
  let streak=0;let cursor=new Date();
  if(!dates.has(dateKey(cursor)))cursor=minusDays(cursor,1);
  while(dates.has(dateKey(cursor))){streak++;cursor=minusDays(cursor,1);}
  return {complete,total,streak};
}
async function renderStats() {
  let sessions=[];try {sessions=await dbAll('sessions');}catch{return;}
  const {complete,total,streak}=sessionStats(sessions);
  $('statHours').textContent=formatMinutes(total);$('statSessions').textContent=String(complete.length);
  $('statStreak').textContent=streak+' Tage';$('statAverage').textContent=formatMinutes(complete.length?total/complete.length:0);
  const totals={};
  for(const session of complete) {const key=dateKey(new Date(session.startedAt));totals[key]=(totals[key]||0)+(session.durationMs||0)/60000;}
  const week=Array.from({length:7},(_,i)=>minusDays(new Date(),6-i));
  const max=Math.max(1,...week.map(d=>totals[dateKey(d)]||0));
  const weekBars=$('weekBars');weekBars.replaceChildren();
  for(const d of week){
    const mins=totals[dateKey(d)]||0;
    const el=document.createElement('div');el.className='bar-col';
    el.innerHTML=`<small>${Math.round(mins)}m</small><div class="bar-track"><div class="bar-fill" style="height:${mins?Math.max(5,mins/max*100):0}%"></div></div><span>${d.toLocaleDateString('de-DE',{weekday:'short'})}</span>`;
    weekBars.append(el);
  }
  const today=new Date();$('calendarMonth').textContent=today.toLocaleDateString('de-DE',{month:'long',year:'numeric'});
  const heatmap=$('monthHeatmap');heatmap.replaceChildren();
  const first=new Date(today.getFullYear(),today.getMonth(),1),days=new Date(today.getFullYear(),today.getMonth()+1,0).getDate();
  const offset=(first.getDay()+6)%7;
  for(let i=0;i<offset;i++){const el=document.createElement('div');el.className='heat-cell blank';heatmap.append(el);}
  for(let d=1;d<=days;d++){
    const day=new Date(today.getFullYear(),today.getMonth(),d),mins=totals[dateKey(day)]||0;
    const level=mins>=120?4:mins>=60?3:mins>=25?2:mins>0?1:0;
    const el=document.createElement('div');el.className='heat-cell '+(level?'l'+level:'');
    el.title=`${day.toLocaleDateString('de-DE')}: ${Math.round(mins)} Minuten`;
    heatmap.append(el);
  }
}
async function updateStorage(){
  try{
    const est=await navigator.storage?.estimate?.();
    $('storageUsed').textContent=est?.usage!=null?`${(est.usage/1048576).toFixed(1)} MB`:'Nicht verfügbar';
  }catch{$('storageUsed').textContent='Nicht verfügbar';}
}
async function autoClean(){
  if(!settings.autoDelete)return;
  const expiry=Date.now()-Number(settings.autoDelete)*86400000;
  const sessions=await dbAll('sessions');
  for(const session of sessions) if(session.status==='complete' && (session.completedAt||session.startedAt)<expiry) await fullyDeleteSession(session.id);
}
function onVisibilityChange(){
  const a=active;if(!a)return;
  if(document.hidden){
    if(!a.pausedAt)a.pausedAt=Date.now();
    releaseWakeLock();
  }else{
    if(a.pausedAt){a.pausedMs+=Date.now()-a.pausedAt;a.pausedAt=null;}
    if(a.stream && a.stream.getVideoTracks().some(t=>t.readyState==='ended')){
      showToast('iOS hat die Kamera unterbrochen. Aufnahme wird abgeschlossen.');stopSession();return;
    }
    acquireWakeLock();showToast('App wieder aktiv. Aufnahme im Vordergrund fortgesetzt.');tick();
  }
}
function connectUI(){
  document.querySelectorAll('.mode-btn').forEach(b=>b.addEventListener('click',()=>setMode(b.dataset.mode)));
  document.querySelectorAll('.nav-btn').forEach(b=>b.addEventListener('click',()=>switchTab(b.dataset.tab)));
  $('startStop').addEventListener('click',()=>active?stopSession():startSession());
  $('dimButton').addEventListener('click',()=>{if(active)setDim(true);});
  $('dimRestore').addEventListener('click',()=>setDim(false));
  $('dimStop').addEventListener('click',()=>stopSession());
  $('flipCamera').addEventListener('click',switchCamera);
  $('keepAwakeButton').addEventListener('click',toggleWake);
  $('closeDialog').addEventListener('click',closeDialog);
  $('videoDialog').addEventListener('click',e=>{if(e.target===$('videoDialog'))closeDialog();});
  $('videoDialog').addEventListener('cancel',e=>{e.preventDefault();closeDialog();});
  $('shareVideo').addEventListener('click',()=>{if(dialogSession)shareSession(dialogSession);});
  $('autoDimSetting').checked=!!settings.autoDim;
  $('useMicrophone').checked=!!settings.mic;
  $('keepAwakeSetting').checked=!!settings.keepAwake;
  $('autoDelete').value=String(settings.autoDelete);
  $('autoDimSetting').addEventListener('change',e=>{settings.autoDim=e.target.checked;saveSettings();});
  $('useMicrophone').addEventListener('change',e=>{settings.mic=e.target.checked;saveSettings();});
  $('keepAwakeSetting').addEventListener('change',e=>{settings.keepAwake=e.target.checked;saveSettings();});
  $('autoDelete').addEventListener('change',async e=>{settings.autoDelete=Number(e.target.value);saveSettings();await autoClean();await renderLibrary();await renderStats();await updateStorage();});
  document.addEventListener('visibilitychange',onVisibilityChange);
  window.addEventListener('pagehide',()=>{if(active){releaseWakeLock();}});
  setMode('timelapse');updateUI();
}
async function initialize() {
  connectUI();
  try {await openDB();await autoClean();await renderLibrary();await renderStats();await updateStorage();}
  catch(error){showToast('Lokaler Speicher nicht verfügbar: '+error.message,7000);}
  if('serviceWorker' in navigator && location.protocol==='https:'){
    navigator.serviceWorker.register('./sw.js').catch(()=>{});
  }
}
initialize();
