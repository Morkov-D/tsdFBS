'use strict';
const T={endpoint:'',session:null,employee:null,catalog:{lks:[],warehouses:[],products:[],savedAt:''},draft:null,queue:[],sending:false,cameraStream:null,cameraTimer:null,cameraBusy:false,scanBusy:false,byId:new Map(),byBarcode:new Map(),scanCodes:new Set()};
const $=id=>document.getElementById(id);
function stage(label,percent){const box=$('workProgress');box.classList.remove('hidden');$('workProgressLabel').textContent=label;$('workProgressValue').textContent=percent==null?'Синхронизация…':percent+'%';$('workProgressFill').style.width=percent==null?'35%':percent+'%';$('workProgressFill').classList.toggle('moving',percent==null);}
function stageEnd(){const box=$('workProgress');if(box)box.classList.add('hidden');}
function buildIndexes(){T.byId=new Map();T.byBarcode=new Map();(T.catalog.products||[]).forEach(p=>{T.byId.set(p.uuid,p);(p.barcodes||[]).forEach(code=>{const key=p.lkId+'|'+String(code);const arr=T.byBarcode.get(key)||[];arr.push(p);T.byBarcode.set(key,arr);});});T.scanCodes=new Set(T.draft?.scans?.map(x=>x.dm)||[]);}
function focusScanner(){if(!$('assemblyView').classList.contains('hidden')){const input=$('scanInput');if(document.activeElement!==input){input.focus({preventScroll:true});}}}

const escapeHtml=v=>String(v??'').replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
function view(id){['setupView','loginView','homeView','assemblyView'].forEach(x=>$(x).classList.toggle('hidden',x!==id));}
function message(text,type='good'){const area=$('alerts');area.innerHTML=`<div class="notice ${type}">${escapeHtml(text)}</div>`;clearTimeout(window.alertTimer);window.alertTimer=setTimeout(()=>area.innerHTML='',8000);}
function busy(button,cb){if(button.disabled)return;button.disabled=true;const original=button.dataset.label||button.textContent;button.dataset.label=original;button.textContent='⏳ Выполняется…';Promise.resolve().then(cb).catch(e=>{console.error(e);message(e.message||String(e),'bad');}).finally(()=>{button.disabled=false;button.textContent=original;});}
function activeOnline(){return navigator.onLine;}
function showConnection(){$('connection').classList.toggle('offline',!activeOnline());$('connection').textContent=activeOnline()?'● В сети':'● Офлайн';$('connection').title=activeOnline()?'Сеть доступна':'Нет сети: очередь сохранится';}
const lkLabel=lk=>`${lk.name} · ${lk.marketplace} · ${lk.externalId}`;
function selectedLK(){const value=$('lkLookup').value;return T.catalog.lks.find(x=>lkLabel(x)===value);}
function isGTINValid(gtin){if(!/^\d{14}$/.test(gtin))return false;let sum=0;for(let i=0;i<13;i++)sum+=Number(gtin[i])*(i%2===0?3:1);return (10-sum%10)%10===Number(gtin[13]);}
function parseDM(value){const code=String(value||'').replace(/^\]d2/,'');const m=code.match(/^01(\d{14})21([^\x1d]{1,20})(?:\x1d|$)/);if(!m)throw Error('Не распознан DataMatrix: нужны AI 01 + GTIN и AI 21 + серия. Проверьте настройки сканера (разделитель GS).');if(!isGTINValid(m[1]))throw Error('Ошибка контрольной цифры GTIN в ЧЗ');return {raw:code,gtin:m[1],serial:m[2]};}
async function start(){await DB.open();T.endpoint=localStorage.getItem('stockflow_endpoint')||'';T.catalog=await DB.get('catalog','snapshot')||T.catalog;T.draft=await DB.get('draft','current')||null;T.queue=await DB.all('queue');buildIndexes();$('employeeId').value=localStorage.getItem('stockflow_employee')||'';showConnection();if(T.endpoint)view('loginView');else view('setupView');}
$('setupForm').onsubmit=e=>{e.preventDefault();const url=$('endpoint').value.trim();let u;try{u=new URL(url);}catch(e){return message('Некорректный URL','bad');}if(u.protocol!=='https:'||u.hostname!=='script.google.com'||!/^\/macros\/s\/[^/]+\/exec$/.test(u.pathname))return message('Нужна опубликованная HTTPS-ссылка Apps Script, оканчивающаяся на /exec','bad');T.endpoint=u.origin+u.pathname;localStorage.setItem('stockflow_endpoint',T.endpoint);view('loginView');message('Адрес сервера сохранён');};
$('changeEndpoint').onclick=()=>{$('endpoint').value=T.endpoint;view('setupView');};
$('loginForm').onsubmit=e=>{e.preventDefault();busy($('loginForm').querySelector('button'),async()=>{
  const id=$('employeeId').value.trim();if(!id)throw Error('Введите ID сотрудника');
  try{const response=await API.jsonp(T.endpoint,{op:'login',employeeId:id});T.session=response.token;T.employee=response.employee;localStorage.setItem('stockflow_employee',id);await DB.put('meta','lastEmployee',T.employee);
    try{await syncCatalog();}catch(err){message('Вход выполнен, но обновить справочники не удалось: '+err.message,'bad');}
  }catch(err){const cached=await DB.get('meta','lastEmployee');if((!activeOnline() || /Нет связи|Превышено время ожидания/i.test(err.message)) && cached && cached.id===id && T.catalog.products.length){T.employee=cached;T.session=null;message('Офлайн-вход по ранее подтверждённому ID. На сервер данные уйдут только после повторного онлайн-входа.','');}else throw err;}
  afterLogin();
});};
function afterLogin(){$('userName').textContent=`${T.employee.name} · ${T.employee.id}`;buildIndexes();if(T.draft){view('assemblyView');renderAssembly();}else{view('homeView');renderHome();}if(activeOnline()&&T.session)sendQueue();}
$('logout').onclick=()=>{T.employee=null;T.session=null;view('loginView');};
function renderHome(){$('lkData').innerHTML=T.catalog.lks.map(lk=>`<option value="${escapeHtml(lkLabel(lk))}"></option>`).join('');
  $('warehouse').innerHTML=T.catalog.warehouses.map(w=>`<option value="${escapeHtml(w.uuid)}">${escapeHtml(w.name)}</option>`).join('');
  const saved=localStorage.getItem('stockflow_last_lk'),wh=localStorage.getItem('stockflow_last_warehouse');
  if(saved){const lk=T.catalog.lks.find(l=>l.uuid===saved);if(lk)$('lkLookup').value=lkLabel(lk);}
  if(wh&&T.catalog.warehouses.some(w=>w.uuid===wh))$('warehouse').value=wh;
  $('beginAssembly').textContent=T.draft?'Вернуться к сборке':'Начать сборку';
  $('cacheStats').textContent=`ЛК: ${T.catalog.lks.length} · Товаров: ${T.catalog.products.length} · Складов: ${T.catalog.warehouses.length}`;
  $('cachedAt').textContent=T.catalog.savedAt?new Date(T.catalog.savedAt).toLocaleString('ru-RU'):'Не загружено';renderQueue();}
$('beginAssembly').onclick=()=>busy($('beginAssembly'),async()=>{
  if(T.draft){view('assemblyView');renderAssembly();return;}
  const lk=selectedLK();if(!lk)throw Error('Выберите ЛК из подсказок');const warehouseId=$('warehouse').value;if(!warehouseId)throw Error('Не выбран склад');
  
  T.draft={lkId:lk.uuid,warehouseId,stage:'barcode',pendingProductId:null,scans:[],createdAt:new Date().toISOString()};T.scanCodes=new Set();await DB.put('draft','current',T.draft);
  localStorage.setItem('stockflow_last_lk',lk.uuid);localStorage.setItem('stockflow_last_warehouse',warehouseId);view('assemblyView');renderAssembly();
});
function renderAssembly(){if(!T.draft)return;const lk=T.catalog.lks.find(x=>x.uuid===T.draft.lkId);$('assemblyTitle').textContent=lk?lk.name:'ЛК';const codes=T.draft.scans;const stage=T.draft.stage;
  $('assemblyCount').textContent=codes.length+' шт.';$('scanStageCount').textContent=stage==='barcode'?'01 / 02':'02 / 02';
  $('scanTitle').textContent=stage==='barcode'?'Штрихкод товара':'DataMatrix ЧЗ';
  const product=T.byId.get(T.draft.pendingProductId);
  $('scanHelp').textContent=stage==='barcode'?'Сканируйте ШК товара, затем подтвердите Enter.':`Товар: ${product?.article||'Не найден'}. Отсканируйте код ЧЗ.`;
  $('scanInput').value='';$('scanInput').placeholder=stage==='barcode'?'ШК товара…':'GS1 DataMatrix…';$('scanCard').dataset.stage=stage;
  $('scanStepOne').classList.toggle('done',stage==='dm');$('scanStepTwo').classList.toggle('active',stage==='dm');
  const ag={};codes.forEach(s=>{ag[s.productId]=(ag[s.productId]||0)+1;});const entries=Object.entries(ag);$('scanSummary').textContent=entries.length+' артикулов';
  $('scanHistory').innerHTML=entries.length?entries.slice(-24).reverse().map(([id,n])=>{const p=T.byId.get(id);return `<div class="item"><div><b>${escapeHtml(p?.article||'Неизвестный товар')}</b><small>${escapeHtml(p?.gtin||'')}</small></div><span>${n} шт.</span></div>`;}).join('')+(entries.length>24?`<p class="muted">Показаны 24 из ${entries.length} артикулов</p>`:''):'<p class="muted">Здесь появятся отсканированные товары</p>';
  requestAnimationFrame(focusScanner);
}
$('scanForm').onsubmit=e=>{e.preventDefault();acceptScan($('scanInput').value);};
$('scanInput').addEventListener('keydown',e=>{if(e.key==='Tab'&&$('scanInput').value){e.preventDefault();acceptScan($('scanInput').value);}});
$('assemblyView').addEventListener('click',e=>{if(e.target.closest('button,a,video'))return;focusScanner();});
async function acceptScan(value){if(T.scanBusy)return;T.scanBusy=true;try{
  if(!T.draft)throw Error('Нет активной сборки');const val=String(value||'').trim();if(!val)throw Error('Пустой скан');
  if(T.draft.stage==='barcode'){
    const candidates=T.byBarcode.get(T.draft.lkId+'|'+val)||[];
    if(!candidates.length)throw Error('Штрихкод не найден в выбранном ЛК: '+val);
    if(candidates.length>1)throw Error('Штрихкод неоднозначен. Проверьте справочник.');
    T.draft.pendingProductId=candidates[0].uuid;T.draft.stage='dm';
  }else{
    const p=T.byId.get(T.draft.pendingProductId);if(!p)throw Error('Сначала сканируйте ШК товара');
    const dm=parseDM(val);if(dm.gtin!==p.gtin)throw Error('GTIN ЧЗ '+dm.gtin+' не совпадает с товаром ('+p.gtin+')');
    if(T.scanCodes.has(dm.raw))throw Error('Этот ЧЗ уже отсканирован в текущей сборке');
    T.draft.scans.push({productId:p.uuid,barcode:p.barcodes[0],dm:dm.raw,gtin:dm.gtin});T.scanCodes.add(dm.raw);T.draft.pendingProductId=null;T.draft.stage='barcode';
    message('Добавлено: '+p.article+' — 1 шт.');
  }
  await DB.put('draft','current',T.draft);renderAssembly();
}catch(err){message(err.message,'bad');$('scanInput').focus();$('scanInput').select();if(navigator.vibrate)navigator.vibrate([50,40,70]);}finally{T.scanBusy=false;}}
$('backHome').onclick=()=>{stopCamera();view('homeView');renderHome();if(T.draft)message('Незакрытая сборка сохранена локально. Нажмите «Вернуться к сборке», чтобы продолжить.','');};
$('finishAssembly').onclick=()=>busy($('finishAssembly'),async()=>{
  if(!T.draft)throw Error('Нет активной сборки');if(T.draft.stage==='dm')throw Error('Сначала отсканируйте ЧЗ последнего товара');
  if(!T.draft.scans.length)throw Error('Нет отсканированных товаров');
  if(!confirm('Закрыть сборку на '+T.draft.scans.length+' шт.? Она попадёт в очередь отправки.'))return;
  const id=crypto.randomUUID(),byProduct=new Map();T.draft.scans.forEach(s=>{if(!byProduct.has(s.productId))byProduct.set(s.productId,[]);byProduct.get(s.productId).push(s.dm);});
  const job={jobId:id,employeeId:T.employee.id,lkId:T.draft.lkId,warehouseId:T.draft.warehouseId,items:[...byProduct].map(([productId,codes])=>({productId,qty:codes.length,codes})),qty:T.draft.scans.length,createdAt:new Date().toISOString(),status:'QUEUED',message:''};
  // Сначала сохраняем задание в IndexedDB; только потом удаляем черновик.
  await DB.commitAssembly(job);T.draft=null;T.queue=await DB.all('queue');stopCamera();view('homeView');renderHome();message('Сборка '+job.qty+' шт. сохранена на устройстве. Передаём на сервер без блокировки интерфейса.');if(activeOnline()&&T.session)sendQueue();
});
$('syncCatalog').onclick=()=>busy($('syncCatalog'),async()=>{const changed=await syncCatalog(true);renderHome();message(changed?'Справочники обновлены':'Нет изменений');});
async function syncCatalog(force=false){
 if(!T.session)throw Error('Для синхронизации войдите онлайн');
 stage('Проверяем изменения справочников…',null);
 try{
  const meta=await API.jsonp(T.endpoint,{op:'meta',token:T.session});
  if(!force&&T.catalog.products.length&&T.catalog.version===meta.version){stageEnd();return false;}
  const products=[],lks=[],warehouses=[];let page=0,version='';
  while(true){
   const part=await API.jsonp(T.endpoint,{op:'catalog',token:T.session,page,limit:300});
   if(page===0){lks.push(...part.lks);warehouses.push(...part.warehouses);version=part.version;}
   if(part.version!==version)throw Error('Справочник изменился во время загрузки. Обновите ещё раз.');
   products.push(...part.products);
   stage('Загружено товаров: '+products.length+' / '+part.total,part.total?Math.round(products.length/part.total*100):100);
   if(part.nextPage===null)break;
   page=part.nextPage;if(page>10000)throw Error('Слишком много страниц справочника');
  }
  const snapshot={lks,warehouses,products,version,savedAt:new Date().toISOString()};
  await DB.replaceCatalog(snapshot);T.catalog=snapshot;buildIndexes();return true;
 }finally{stageEnd();}
}
function renderQueue(){
 const pending=T.queue.filter(x=>x.status!=='SUCCESS');$('queueCount').textContent=pending.length;
 $('queueList').innerHTML=pending.length?pending.slice().reverse().map(j=>{
  const lk=T.catalog.lks.find(x=>x.uuid===j.lkId);
  const labels={QUEUED:'На устройстве',SENDING:'Отправляется',UNCERTAIN:'Ожидает ответа',ERROR:'Ошибка сервера'};
  return `<div class="item job"><div><b>${escapeHtml(lk?.name||'ЛК')} · ${j.qty} шт.</b><small>${new Date(j.createdAt).toLocaleString('ru-RU')} · ${escapeHtml(j.jobId.slice(0,8))}</small><small>${escapeHtml(j.message||'Сохранено локально')}</small></div><span class="job-status ${j.status==='ERROR'?'error':j.status==='UNCERTAIN'?'unknown':''}">${escapeHtml(labels[j.status]||j.status)}</span></div>`;
 }).join(''):'<p class="muted">Очередь пуста. Все подтверждённые сборки удалены из локальной очереди.</p>';
 $('sendQueue').disabled=T.sending||pending.every(j=>j.status==='ERROR');
}
$('sendQueue').onclick=()=>sendQueue();
async function sendQueue(){
 if(T.sending)return;
 if(!T.session){message('Для отправки очереди выполните онлайн-вход','bad');return;}
 if(!activeOnline()){message('Нет соединения. Очередь сохранена на устройстве.','');return;}
 T.sending=true;$('sendQueue').disabled=true;
 try{
  T.queue=await DB.all('queue');const items=T.queue.filter(j=>j.status!=='ERROR');let num=0;
  for(const job of items){
   num++;job.status='SENDING';job.message='Проверяем подтверждение на сервере';await DB.put('queue',job.jobId,job);T.queue=await DB.all('queue');renderQueue();
   stage('Передача сборки '+num+' из '+items.length+' · '+job.qty+' шт.',Math.round((num-1)/items.length*100));
   let result;
   try{result=await API.sendAssembly(T.endpoint,{action:'assembly',token:T.session,jobId:job.jobId,lkId:job.lkId,warehouseId:job.warehouseId,items:job.items});}
   catch(e){job.status='UNCERTAIN';job.message=e.message;await DB.put('queue',job.jobId,job);message('Ответ сервера не получен: '+e.message,'bad');break;}
   if(result.status==='SUCCESS'){
    await DB.del('queue',job.jobId);stage('Подтверждена сборка '+num+' из '+items.length,Math.round(num/items.length*100));
    message('Подтверждено сервером: '+job.qty+' шт. · '+job.jobId.slice(0,8));
   }else{
    job.status=result.status==='ERROR'?'ERROR':'UNCERTAIN';job.message=result.message||'Нет ответа сервера';await DB.put('queue',job.jobId,job);
    message(job.status==='ERROR'?'Ошибка сборки: '+job.message+'. Проверьте журнал операций перед исправлением!':'Сервер пока не подтвердил сборку; она остаётся в очереди.',job.status==='ERROR'?'bad':'');
    break;
   }
  }
 }finally{stageEnd();T.queue=await DB.all('queue');if(!$('homeView').classList.contains('hidden'))renderQueue();T.sending=false;$('sendQueue').disabled=false;if(!$('homeView').classList.contains('hidden'))renderQueue();}
}

// Camera scanning is optional. Hardware TSD scanners work as keyboard input + Enter.
$('cameraBtn').onclick=async()=>{try{if(!('BarcodeDetector'in window))throw Error('Браузер не поддерживает BarcodeDetector. Используйте сканер ТСД или ручной ввод.');
  const formats=await BarcodeDetector.getSupportedFormats();const needed=T.draft?.stage==='dm'?'data_matrix':'code_128';
  if(!formats.includes(needed)&&!formats.includes('data_matrix'))throw Error('Камера браузера не поддерживает требуемые форматы штрихкодов');
  T.cameraStream=await navigator.mediaDevices.getUserMedia({video:{facingMode:'environment'},audio:false});
  $('cameraVideo').srcObject=T.cameraStream;$('cameraBox').classList.remove('hidden');const detector=new BarcodeDetector({formats:formats.filter(x=>['data_matrix','ean_13','ean_8','code_128','upc_a','itf'].includes(x))});
  T.cameraTimer=setInterval(async()=>{if(T.cameraBusy||!T.cameraStream)return;T.cameraBusy=true;try{const found=await detector.detect($('cameraVideo'));if(found.length){const v=found[0].rawValue;stopCamera();await acceptScan(v);}}catch(e){}finally{T.cameraBusy=false;}},650);
}catch(err){message(err.message,'bad');stopCamera();}};
$('cameraStop').onclick=stopCamera;
function stopCamera(){clearInterval(T.cameraTimer);T.cameraTimer=null;T.cameraStream?.getTracks().forEach(t=>t.stop());T.cameraStream=null;$('cameraBox').classList.add('hidden');}
window.addEventListener('online',()=>{showConnection();if(T.session)sendQueue();});window.addEventListener('offline',showConnection);window.addEventListener('focus',()=>{if(T.session&&activeOnline()&&!T.sending)sendQueue();});document.addEventListener('visibilitychange',()=>{if(!document.hidden&&T.session&&activeOnline())sendQueue();});
if('serviceWorker'in navigator)navigator.serviceWorker.register('./sw.js').catch(e=>console.warn('SW:',e));
start().then(()=>window.stockflowBootReady?.()).catch(e=>{window.stockflowBootError?.(e.message);message('Ошибка инициализации IndexedDB: '+e.message,'bad');});
