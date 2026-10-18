import { app, BrowserWindow, ipcMain, dialog, clipboard, globalShortcut, Menu, Tray, shell, screen, Notification, powerMonitor, nativeTheme } from 'electron';
import {release} from 'node:os';
import {activateWindow} from './window-activation.ts';
import {randomUUID} from 'node:crypto';
import { mkdirSync, statSync, accessSync, constants, writeFileSync, existsSync,rmSync,readFileSync,renameSync } from 'node:fs';
import { join, basename, resolve, dirname } from 'node:path';
import { pathToFileURL } from 'node:url';
import { Store, SCHEMA_VERSION, type Material } from './store.ts';
import { doubleShift } from './double-shift.ts';
import type { SaveInput, AnalysisRequest, NoteKind, Role, TaskState, DraftValue, Extra, Reminder, CatalogInput, CatalogKind, TaskFilter, Relations, AppSettings, LookupInput, SuggestionFilter, CheckpointInput, CreateLinkInput, LinkDraft } from './shared.ts';
import { prepareDataDirectory,inspectBackup,databaseInfo } from './data.ts';
import {Protection,prepareRestore,installRestore,recoverRestore} from './protection.ts';
import {Reminders} from './reminders.ts';
import { referenceTarget, checkOpenFile } from './references.ts';
import { getOpenCodeSettings, openCodeInfo, saveOpenCodeSettings, checkOpenCode, type OpenCodeSettings } from './opencode.ts';
import { AnalysisService } from './analysis.ts';
import {prepareUpdate,verifyUpdate,startUpdate,type PreparedUpdate} from './update.ts';

const smoke = process.argv.includes('--smoke-test');
const startupCheck = process.argv.includes('--startup-check');
const lifecycleCheck=process.argv.includes('--lifecycle-check');
const qaSession=process.argv.includes('--qa-session');
app.setName('Recall');
if(process.platform==='win32')app.setAppUserModelId(smoke?'Recall.Sample':'Recall.Desktop');
const testDirectory=startupCheck||lifecycleCheck||qaSession?process.env.RECALL_TEST_DATA:undefined;
if((lifecycleCheck||qaSession)&&!testDirectory)throw new Error('桌面检查必须指定隔离样例目录');
const dataDirectory = smoke ? join(app.getAppPath(), '.cache', `smoke-${Date.now()}`)
  : (testDirectory??(app.isPackaged ? join(process.env.LOCALAPPDATA??app.getPath('appData'),'Recall','data') : join(app.getAppPath(), '.local-data')));
const backupsDirectory=testDirectory?join(dirname(dataDirectory),'backups'):smoke||!app.isPackaged?join(app.getAppPath(),'.cache','backups'):join(dirname(dataDirectory),'backups');
// 实例锁独立于业务数据路径，避免导入旧数据前 Chromium 创建非空目标目录。
const runtimeDirectory=smoke?join(dirname(dataDirectory),'runtime-'+basename(dataDirectory)):testDirectory?join(dirname(testDirectory),'runtime'):join(app.isPackaged?(process.env.LOCALAPPDATA??app.getPath('appData')):app.getAppPath(),app.isPackaged?'Recall/runtime':'.cache/runtime');
mkdirSync(runtimeDirectory,{recursive:true});app.setPath('userData',runtimeDirectory);
if(startupCheck&&!testDirectory){
  console.log(JSON.stringify({mode:'read-only',dataDirectory,...databaseInfo(dataDirectory)}));app.exit(0);
}else if (!smoke && !app.requestSingleInstanceLock()) app.quit();
else void app.whenReady().then(async () => {
  recoverRestore(dataDirectory);
  if(app.isPackaged&&!testDirectory){
    let legacy=join(dirname(process.execPath),'data');
    if(!existsSync(join(dataDirectory,'recall.sqlite'))&&!existsSync(join(legacy,'recall.sqlite'))){
      const choice=await dialog.showMessageBox({type:'question',title:'开始使用 Recall',message:'在这台电脑上第一次使用，还是接续旧版记录？',detail:'已有记录请选择旧版 data 文件夹。接续前先退出旧版；新版会先备份，原文件保留。',buttons:['首次使用，建立新记录','接续旧版记录','取消'],defaultId:1,cancelId:2,noLink:true});
      if(choice.response===2){app.quit();return;}
      if(choice.response===1){const selected=await dialog.showOpenDialog({title:'选择旧版 data 文件夹',properties:['openDirectory']});if(selected.canceled){app.quit();return;}legacy=selected.filePaths[0];if(!existsSync(join(legacy,'recall.sqlite')))throw new Error('所选目录没有 Recall 数据库，未创建空库，请选择旧版 data 文件夹');}
    }
    prepareDataDirectory(dataDirectory,legacy,backupsDirectory);
  }
  if(existsSync(join(dataDirectory,'recall.sqlite')))databaseInfo(dataDirectory);
  const store = new Store(dataDirectory,{backups:backupsDirectory,version:app.getVersion()});
  const protection=new Protection(dataDirectory,backupsDirectory,join(runtimeDirectory,'protection-state.json'));
  const settingsFile=join(dataDirectory,'app-settings.json');
  const validResourceShortcut=(key:unknown):key is string=>{
    if(typeof key!=='string'||! /^(?:(?:Control|Ctrl|Alt|Shift)\+){1,3}[A-Za-z0-9]$/i.test(key)||! /(?:Control|Ctrl|Alt)\+/i.test(key))return false;
    const modifiers=key.split('+').slice(0,-1).map(value=>value.toLowerCase().replace('ctrl','control'));return new Set(modifiers).size===modifiers.length;
  };
  let appPreferences:AppSettings={openAtLogin:false,resourceShortcut:'Control+Alt+L'},shortcutError='';
  if(existsSync(settingsFile)){try{const saved=JSON.parse(readFileSync(settingsFile,'utf8'));if(typeof saved.openAtLogin==='boolean'&&validResourceShortcut(saved.resourceShortcut))appPreferences={openAtLogin:saved.openAtLogin,resourceShortcut:saved.resourceShortcut};else throw new Error('格式无效');}catch{shortcutError='偏好设置不可读，已使用默认入口；任务数据仍保留';}}
  const reminders=new Reminders(store);
  let maintenance=false,preparingMaintenance=false;
  let background:ReturnType<typeof setInterval>|undefined;
  let openCodeSettings = getOpenCodeSettings(dataDirectory);
  const analysis = new AnalysisService(store, () => openCodeSettings);
  const folders = new Set<string>(Object.values(store.drafts()).flatMap(draft=>draft.folder?[draft.folder]:[]));
  let quitting = false;
  let tray: Tray | undefined;
  let stopHook = () => {};
  const window = new BrowserWindow({
    width: 640, height: 88, minWidth: 360, minHeight: 72, show: false,
    frame: false, thickFrame:false, resizable: false, maximizable: false,
    title: 'Recall', backgroundColor: '#ffffff', autoHideMenuBar: true,
    webPreferences: { preload: join(__dirname, 'preload.cjs'), contextIsolation: true, nodeIntegration: false, sandbox: true }
  });
  const page = pathToFileURL(join(__dirname, 'index.html')).href;
  const managerPage = pathToFileURL(join(__dirname,'manager.html')).href;
  let manager: BrowserWindow | null = null;
  let launcherReady=false,pendingShow=false;
  const openLibrary=async()=>{await openManager();manager!.webContents.send('recall:library');};
  const applyTheme=()=>{
    if(window.isDestroyed())return;
    const color=nativeTheme.shouldUseDarkColors?'#202124':'#f8f9fb';
    const supported=process.platform==='win32'&&Number(release().split('.')[2])>=22621&&!nativeTheme.prefersReducedTransparency&&!nativeTheme.shouldUseHighContrastColors;
    try{window.setBackgroundMaterial(supported?'acrylic':'none');window.setBackgroundColor(supported?'#00000000':color);}catch{window.setBackgroundColor(color);}
    if(manager&&!manager.isDestroyed())manager.setBackgroundColor(color);
  };
  nativeTheme.on('updated',applyTheme);applyTheme();
  let managerReady: Promise<void> | null = null;
  const openManager = async (id: string | null = null) => {
    if (id !== null) {store.get(id);store.touchTask(id);}
    if (!manager) {
      const area=screen.getDisplayNearestPoint(screen.getCursorScreenPoint()).workArea;
      manager = new BrowserWindow({ width:Math.min(1060,area.width),height:Math.min(800,area.height),minWidth:560,minHeight:480,show:false,title:'Recall · 工作台',backgroundColor:'#ffffff',autoHideMenuBar:true,webPreferences:{ preload:join(__dirname,'preload.cjs'),contextIsolation:true,nodeIntegration:false,sandbox:true } });
      manager.webContents.setWindowOpenHandler(() => ({ action:'deny' }));
      manager.webContents.on('will-navigate', event => event.preventDefault());
      manager.on('close', event => { if (!quitting) { event.preventDefault(); manager?.hide(); } });
      managerReady = manager.loadFile(join(__dirname,'manager.html'));
      applyTheme();
    }
    await managerReady;
    window.hide();activateWindow(manager);
    if (id !== null) manager.webContents.send('recall:edit',id);else manager.webContents.send('recall:home');
  };
  window.webContents.setWindowOpenHandler(() => ({ action: 'deny' }));
  window.webContents.on('will-navigate', event => event.preventDefault());
  window.on('close', event => { if (!quitting) { event.preventDefault(); window.hide(); } });
  const resize = (view: string, recenter = false) => {
    if(window.isDestroyed()||quitting)return;
    const sizes: Record<string,[number,number]> = { search:[640,88],results:[680,560],capture:[560,128],link:[640,128],checkpoint:[680,360],menu:[640,190],captureAttachments:[640,240],new:[560,128],todo:[680,560],resources:[680,560],preview:[680,560],options:[640,360],note:[640,320] };
    if (!Object.hasOwn(sizes,view)) throw new Error('窗口状态无效');
    const bounds = window.getBounds();
    const area = recenter ? screen.getDisplayNearestPoint(screen.getCursorScreenPoint()).workArea : screen.getDisplayMatching(bounds).workArea;
    const width = Math.min(sizes[view][0],area.width),height = Math.min(sizes[view][1],area.height);
    const x = recenter ? Math.round(area.x+(area.width-width)/2) : Math.max(area.x,Math.min(bounds.x,area.x+area.width-width));
    const y = recenter ? Math.round(area.y+area.height*.2) : Math.max(area.y,Math.min(bounds.y,area.y+area.height-height));
    // Windows 无边框窗口分别 setSize/setPosition 会累积边框偏移，统一设置绝对边界。
    window.setBounds({x,y,width,height});
  };
  const show = () => {
    if(quitting||window.isDestroyed())return;
    if(!launcherReady){pendingShow=true;return;}
    manager?.hide();
    resize('search',true);
    activateWindow(window);window.webContents.send('recall:open');
  };
  app.on('second-instance', show);
  const handle = (channel: string, fn: (...args: any[]) => unknown) => ipcMain.handle(channel, (event, ...args) => {
    if(maintenance||quitting)throw new Error('数据维护或退出进行中，请稍后再试，输入仍保留');
    const owner = [window,manager].find(owner=>owner&&!owner.isDestroyed()&&event.sender===owner.webContents)??null;
    if (!owner || owner.isDestroyed() || event.senderFrame !== owner.webContents.mainFrame || event.senderFrame.url !== (owner === window ? page : managerPage)) throw new Error('请求来源无效');
    if(maintenance||quitting)throw new Error('数据维护或退出进行中，请稍后再试，输入仍保留');
    return fn(...args,event);
  });
  const available = (path: string) => {
    try { if (!statSync(path).isDirectory()) return false; accessSync(path, constants.R_OK); return true; } catch { return false; }
  };
  const addPending = (material: Material) => {
    return store.stage(material);
  };
  const materialsFor = (tokens:string[]) => {
    if(!Array.isArray(tokens)||tokens.length>100||new Set(tokens).size!==tokens.length||tokens.some(token=>typeof token!=='string'))throw new Error('附件列表无效');
    return store.materialsFor(tokens);
  };
  handle('recall:note',(id:string,text:string,kind:NoteKind,tokens:string[],draftKey:string|undefined,extra:Extra|undefined)=>store.addNote(id,text,kind,materialsFor(tokens),draftKey,tokens,extra));
  handle('recall:items',()=>store.items().map(item=>({...item,folderAvailable:item.folder?available(item.folder):true})));
  handle('recall:state',(id:string,state:TaskState,version:string)=>store.setState(id,state,version));
  handle('recall:drafts',()=>store.drafts());
  handle('recall:draft-save',(key:string,value:DraftValue)=>{
    const previous=store.drafts()[key];
    if(value?.folder&&!folders.has(value.folder)&&value.folder!==previous?.folder&&(!value.itemId||store.get(value.itemId).folder!==value.folder))throw new Error('请通过选择器关联文件夹');
    return store.saveDraft(key,value);
  });
  handle('recall:data-info',()=>({directory:dataDirectory,backups:backupsDirectory,version:app.getVersion(),schema:SCHEMA_VERSION}));
  handle('recall:catalog',(kind?:CatalogKind,query?:string,includeArchived?:boolean)=>store.catalog(kind,query,includeArchived));
  handle('recall:catalog-save',(input:CatalogInput)=>store.saveCatalog(input));
  handle('recall:query-tasks',(filter:TaskFilter)=>store.queryTasks(filter));
  handle('recall:lookup',(filter:LookupInput)=>store.lookup(filter));
  handle('recall:suggestions',(filter?:SuggestionFilter)=>store.suggestions(filter));
  handle('recall:checkpoint',(input:CheckpointInput)=>store.checkpoint(input));
  handle('recall:link-create',(input:CreateLinkInput)=>store.createLink(input));
  handle('recall:link-draft',()=>store.linkDraft());
  handle('recall:link-draft-save',(value:LinkDraft|null,expected:LinkDraft|null)=>{
    if(expected===undefined)throw new Error('链接草稿版本缺失，请重新打开后接续');
    return store.saveLinkDraft(value,expected);
  });
  handle('recall:touch-task',(id:string)=>store.touchTask(id));
  handle('recall:library',()=>openLibrary());
  handle('recall:prefill',async(relations:Relations)=>{
    if(!relations||typeof relations!=='object')throw new Error('归属无效');
    for(const [field,kind] of [['groupIds','group'],['personIds','person'],['resourceIds','resource']] as const){const ids=relations[field];if(ids!==undefined&&(!Array.isArray(ids)||ids.length>100||new Set(ids).size!==ids.length||ids.some(id=>typeof id!=='string'||!store.catalog(kind,'',true).some(entry=>entry.id===id))))throw new Error('关联不存在');}
    await flushWindows();const capture=store.drafts().capture;
    if(capture&&(capture.text.trim()||capture.pending.length||capture.quadrant!=null||capture.reminder||capture.deadline||capture.folder||capture.recurrence||Object.keys(capture.extra?.fields??{}).length||[capture.groupIds,capture.personIds,capture.resourceIds].some(ids=>ids?.length)))throw new Error('快捷窗口已有未保存草稿，请先继续或处理该草稿；原内容和归属均保留');
    show();window.webContents.send('recall:prefill',relations);
  });
  handle('recall:resource-choose',async(kind:string,event:Electron.IpcMainInvokeEvent)=>{
    if(!['file','folder'].includes(kind))throw new Error('资料类型无效');
    const result=await dialog.showOpenDialog(BrowserWindow.fromWebContents(event.sender)!,{title:'收藏原位置，不复制资料',properties:[kind==='folder'?'openDirectory':'openFile']});
    if(result.canceled)return null;const ref=referenceTarget(result.filePaths[0]);return store.saveCatalog({id:null,kind:'resource',name:ref.name,target:ref.target});
  });
  handle('recall:resource-open',async(id:string)=>{
    const entry=store.catalog('resource','',true).find(entry=>entry.id===id);if(!entry)throw new Error('常用资料不存在');
    const ref=referenceTarget(entry.target);
    if(ref.kind==='url')await shell.openExternal(ref.target);else{if(ref.kind==='file')checkOpenFile(ref.target);const error=await shell.openPath(ref.target);if(error)throw new Error('资料无法打开：'+error);}
    store.touchResource(id);
  });
  const flushWindows=()=>Promise.all([window,manager].filter((owner):owner is BrowserWindow=>!!owner&&!owner.isDestroyed()).map(owner=>new Promise<void>((accept,reject)=>{
    const id=randomUUID();
    const done=(event:Electron.IpcMainEvent,reply:string,error:string)=>{if(reply!==id||event.sender!==owner.webContents||event.senderFrame!==owner.webContents.mainFrame)return;clearTimeout(timeout);ipcMain.removeListener('recall:flushed',done);if(error)reject(new Error(error));else accept();};
    const timeout=setTimeout(()=>{ipcMain.removeListener('recall:flushed',done);reject(new Error('等待草稿保存超时，未开始维护，请稍后重试'));},8000);
    ipcMain.on('recall:flushed',done);owner.webContents.send('recall:flush',id);
  })));
  const maintain=async<T>(work:()=>T)=>{
    if(preparingMaintenance||maintenance)throw new Error('已有备份或恢复正在进行');
    preparingMaintenance=true;
    try{await flushWindows();maintenance=true;return await work();}finally{maintenance=false;preparingMaintenance=false;}
  };
  handle('recall:app-settings',()=>({...appPreferences,openAtLogin:process.platform==='win32'&&app.isPackaged&&!testDirectory&&!smoke?app.getLoginItemSettings({path:process.execPath,args:['--background']}).openAtLogin:appPreferences.openAtLogin,shortcutError}));
  handle('recall:app-settings-save',(settings:AppSettings)=>{
    if(!settings||typeof settings.openAtLogin!=='boolean')throw new Error('启动设置无效');
    const previous=appPreferences,changeLogin=process.platform==='win32'&&app.isPackaged&&!testDirectory&&!smoke;
    const previousLogin=changeLogin?app.getLoginItemSettings({path:process.execPath,args:['--background']}).openAtLogin:previous.openAtLogin;let loginTouched=false;
    const next={openAtLogin:settings.openAtLogin,resourceShortcut:previous.resourceShortcut};
    try{
      if(changeLogin){app.setLoginItemSettings({openAtLogin:next.openAtLogin,path:process.execPath,args:['--background']});loginTouched=true;}
      writeFileSync(settingsFile+'.tmp',JSON.stringify(next));renameSync(settingsFile+'.tmp',settingsFile);appPreferences=next;shortcutError='';return next;
    }catch(error){if(loginTouched)app.setLoginItemSettings({openAtLogin:previousLogin,path:process.execPath,args:['--background']});throw error;}
  });
  let selectedUpdate:PreparedUpdate|null=null;
  handle('recall:update-choose',async(event:Electron.IpcMainInvokeEvent)=>{
    if(!app.isPackaged||testDirectory||smoke)throw new Error('开发与样例模式不替换正式程序');
    const result=await dialog.showOpenDialog(BrowserWindow.fromWebContents(event.sender)!,{title:'选择 Recall 完整离线升级ZIP',filters:[{name:'Recall 完整升级包',extensions:['zip']}],properties:['openFile']});
    if(result.canceled)return null;selectedUpdate=null;selectedUpdate=await prepareUpdate(result.filePaths[0],runtimeDirectory,app.getVersion());return {token:selectedUpdate.token,version:selectedUpdate.manifest.version,files:selectedUpdate.manifest.files.length};
  });
  handle('recall:update-apply',async(token:string)=>{
    if(!selectedUpdate||selectedUpdate.token!==token)throw new Error('请重新选择升级包');
    verifyUpdate(selectedUpdate);const update=selectedUpdate;
    await maintain(async()=>{if(checkingConnection)throw new Error('连接检查正在进行，请完成后升级');const backup=protection.backup().lastPath;await startUpdate(update,dirname(process.execPath),backup);});
    quitting=true;clean();app.exit(0);return true;
  });
  handle('recall:protection-info',()=>protection.info());
  handle('recall:backup-directory',async(event:Electron.IpcMainInvokeEvent)=>{
    const result=await dialog.showOpenDialog(BrowserWindow.fromWebContents(event.sender)!,{title:'选择日常备份位置',properties:['openDirectory','createDirectory']});
    return result.canceled?protection.info():protection.choose(result.filePaths[0]);
  });
  handle('recall:backup-now',()=>maintain(()=>protection.backup()));
  const restoreChoices=new Map<string,{source:string;fingerprint:string}>();
  handle('recall:restore-choose',async(event:Electron.IpcMainInvokeEvent)=>{
    const result=await dialog.showOpenDialog(BrowserWindow.fromWebContents(event.sender)!,{title:'选择一份完整 Recall 备份文件夹',properties:['openDirectory']});
    if(result.canceled)return null;
    const info=inspectBackup(result.filePaths[0],SCHEMA_VERSION),token=randomUUID();restoreChoices.clear();restoreChoices.set(token,{source:result.filePaths[0],fingerprint:JSON.stringify(info.files)});
    return {token,createdAt:info.createdAt,appVersion:info.legacy?'旧格式 · 当前完整性已校验':info.appVersion,schema:info.schema,counts:info.counts};
  });
  handle('recall:restore',async(token:string,event:Electron.IpcMainInvokeEvent)=>{
    const selected=restoreChoices.get(token);if(!selected)throw new Error('请重新选择备份');
    const source=selected.source,info=inspectBackup(source,SCHEMA_VERSION);
    if(JSON.stringify(info.files)!==selected.fingerprint)throw new Error('备份在预览后发生变化，请重新选择');
    if(checkingConnection)throw new Error('连接检查正在进行，请完成后恢复');
    const choice=await dialog.showMessageBox(BrowserWindow.fromWebContents(event.sender)!,{type:'warning',title:'恢复 Recall 数据',message:'恢复到 '+new Date(info.createdAt).toLocaleString()+' 的备份？',detail:`备份含 ${info.counts.items??0} 个事项、${info.counts.notes??0} 条记录。备份之后的新增内容不会合并；当前完整数据会另行保留。确认后重新启动 Recall。`,buttons:['取消','保全当前数据并恢复'],defaultId:0,cancelId:0,noLink:true});
    if(choice.response!==1)return false;
    return maintain(()=>{
      if(checkingConnection)throw new Error('连接检查正在进行，请完成后恢复');
      if(JSON.stringify(inspectBackup(source,SCHEMA_VERSION).files)!==selected.fingerprint)throw new Error('备份在确认期间发生变化，请重新选择');
      const stage=prepareRestore(source,dataDirectory,SCHEMA_VERSION,directory=>{const copy=new Store(directory,{backups:backupsDirectory,version:app.getVersion()});try{copy.items();copy.drafts();}finally{copy.close();}});
      try{writeFileSync(join(stage,'backup-settings.json'),JSON.stringify({directory:protection.info().directory}));protection.backup('before-restore');}catch(error){if(dirname(stage)===dirname(dataDirectory)&&/^restore-stage-[a-f0-9-]{36}$/.test(basename(stage)))rmSync(stage,{recursive:true,force:true});throw error;}
      maintenance=true;quitting=true;clean();
      try{installRestore(dataDirectory,stage);}catch(error){dialog.showErrorBox('恢复中断，原数据已保全',String(error));}
      if(!smoke){app.relaunch();app.exit(0);}return true;
    });
  });
  handle('recall:reminders',()=>({items:reminders.list(),error:reminders.error}));
  handle('recall:reminder-handle',(id:string,minutes:number|null)=>reminders.handle(id,minutes));
  handle('recall:reference-add',(id:string,target:string,role:Role)=>store.addReference(id,target,role));
  handle('recall:attachment-role',(itemId:string,id:string,role:Role)=>store.classifyAttachment(itemId,id,role));
  handle('recall:reference-choose',async(id:string,kind:string,role:Role,event:Electron.IpcMainInvokeEvent)=>{
    store.get(id);if(!['file','folder'].includes(kind)||!['input','result'].includes(role))throw new Error('资料选择无效');
    const result=await dialog.showOpenDialog(BrowserWindow.fromWebContents(event.sender)!,{title:'引用原位置（不复制资料）',properties:[kind==='folder'?'openDirectory':'openFile']});
    return result.canceled?null:store.addReference(id,result.filePaths[0],role);
  });
  handle('recall:reference-open',async(itemId:string,id:string)=>{
    const ref=store.get(itemId).references.find(ref=>ref.id===id);if(!ref)throw new Error('资料入口不存在');
    const target=referenceTarget(ref.target);
    if(target.kind==='url')await shell.openExternal(target.target);
    else{if(target.kind==='file')checkOpenFile(target.target);const error=await shell.openPath(target.target);if(error)throw new Error('资料无法打开：'+error);}
  });
  handle('recall:import-files',(paths:string[])=>{
    if(!Array.isArray(paths)||!paths.length||paths.length>100)throw new Error('一次最多添加100个附件');
    const materials=paths.map(path=>{const ref=referenceTarget(path);if(ref.kind!=='file')throw new Error('附件只接受本地文件，文件夹请添加引用');return {name:ref.name,source:ref.target};});
    return store.stageMany(materials);
  });
  handle('recall:search', (query: string) => store.search(query).map(item => ({ ...item, folderAvailable: item.folder ? available(item.folder) : true })));
  handle('recall:item', (id: string) => { const item = store.get(id); return { ...item,folderAvailable:item.folder ? available(item.folder) : true }; });
  handle('recall:manager', (id: string | null) => { if (id !== null && typeof id !== 'string') throw new Error('事项编号无效'); return openManager(id); });
  handle('recall:todos', () => { const list = analysis.list(); return { ...list, items: list.items.map(item => ({ ...item, folderAvailable: item.folder ? available(item.folder) : true })) }; });
  handle('recall:analyses', (id: string | null) => { if (id !== null) store.get(id); return store.analyses(id); });
  handle('recall:analyze', (request: AnalysisRequest) => {
    try { return { ok:true,analysis:analysis.start(request) }; }
    catch (error) { return { ok:false,message:error instanceof Error ? error.message : String(error) }; }
  });
  handle('recall:view', (view: string) => resize(view));
  handle('recall:save', (input: SaveInput) => {
    if (!input || !Array.isArray(input.pending) || input.pending.length > 100 || new Set(input.pending).size !== input.pending.length) throw new Error('附件列表无效');
    const materials = materialsFor(input.pending);
    if (input.folder && !folders.has(input.folder) && (!input.id || store.get(input.id).folder !== input.folder)) throw new Error('请通过选择器关联文件夹');
    const item = store.save(input, materials);
    return item;
  });
  handle('recall:files', async (event: Electron.IpcMainInvokeEvent) => {
    const result = await dialog.showOpenDialog(BrowserWindow.fromWebContents(event.sender)!, { title: '添加附件', properties: ['openFile', 'multiSelections'] });
    if (result.canceled) return [];
    if (result.filePaths.length > 100) throw new Error('一次最多添加 100 个附件');
    return store.stageMany(result.filePaths.map(path => ({ name: basename(path), source: path })));
  });
  handle('recall:folder', async (event: Electron.IpcMainInvokeEvent) => {
    const result = await dialog.showOpenDialog(BrowserWindow.fromWebContents(event.sender)!, { title: '关联现有资料文件夹', properties: ['openDirectory'] });
    if (result.canceled) return null;
    const path = result.filePaths[0];
    if (!available(path)) throw new Error('文件夹不存在或无法读取');
    folders.add(path); return path;
  });
  handle('recall:paste-image', async () => {
    const items = await clipboard.read();
    const image = items.find(item => item.types.includes('image/png')); if (!image) return null;
    const blob = await image.getType('image/png');
    if (!(blob instanceof Blob)) throw new Error('截图格式无效');
    if (blob.size > 20 * 1024 * 1024) throw new Error('截图超过 20 MB，请通过文件添加');
    const bytes = new Uint8Array(await blob.arrayBuffer());
    return addPending({ name: `截图-${new Date().toISOString().replace(/[:.]/g, '-')}.png`, bytes });
  });
  handle('recall:discard', (tokens: string[]) => {
    if (!Array.isArray(tokens) || tokens.length > 100 || tokens.some(token => typeof token !== 'string')) throw new Error('附件列表无效');
    store.discard(tokens);
  });
  handle('recall:open-attachment', async (itemId: string, attachmentId: string) => {
    const { path } = store.attachmentPath(itemId, attachmentId);
    checkOpenFile(path);
    if (!resolve(path).startsWith(resolve(join(dataDirectory, 'attachments')) + '\\')) throw new Error('附件路径无效');
    const error = await shell.openPath(path); if (error) throw new Error('附件无法打开：' + error);
  });
  handle('recall:open-folder', async (itemId: string) => {
    const folder = store.get(itemId).folder;
    if (!folder || !available(folder)) throw new Error('关联文件夹不存在或无法读取，请重新关联');
    const error = await shell.openPath(folder); if (error) throw new Error('文件夹无法打开：' + error);
  });
  handle('recall:hide', (event: Electron.IpcMainInvokeEvent) => BrowserWindow.fromWebContents(event.sender)?.hide());
  handle('recall:quit',()=>app.quit());
  handle('recall:show',show);
  const permittedExecutables = new Set([openCodeSettings.executable]);
  let checkingConnection = false;
  handle('recall:opencode-settings', () => openCodeSettings);
  handle('recall:opencode-info', () => openCodeInfo(openCodeSettings));
  handle('recall:opencode-choose', async (event: Electron.IpcMainInvokeEvent) => {
    const result = await dialog.showOpenDialog(BrowserWindow.fromWebContents(event.sender)!, { title:'选择 OpenCode v2 CLI',filters:[{ name:'OpenCode 可执行文件',extensions:['exe'] }],properties:['openFile'] });
    if (result.canceled) return null;
    const path = result.filePaths[0]; permittedExecutables.add(path); return path;
  });
  handle('recall:opencode-save', async (settings: OpenCodeSettings) => {
    if (!settings || !permittedExecutables.has(settings.executable)) throw new Error('请通过选择器选择 OpenCode 可执行文件');
    await saveOpenCodeSettings(dataDirectory,settings); openCodeSettings = settings;
  });
  handle('recall:opencode-check', async () => {
    if (checkingConnection) return { ok: false, message: '连接检查正在进行' };
    checkingConnection = true;
    try { return { ok: true, ...await checkOpenCode(dataDirectory,openCodeSettings) }; }
    catch (error) { return { ok: false, message: error instanceof Error ? error.message : String(error) }; }
    finally { checkingConnection = false; }
  });
  const fallback = globalShortcut.register('Control+Alt+Space', show);
  let hookAvailable = false;
  try {
    const { uIOhook, UiohookKey } = await import('uiohook-napi');
    const detect = doubleShift(show, [UiohookKey.Shift, UiohookKey.ShiftRight]);
    uIOhook.on('keydown', event => detect('down', event.keycode, event.ctrlKey || event.altKey || event.metaKey));
    uIOhook.on('keyup', event => detect('up', event.keycode, event.ctrlKey || event.altKey || event.metaKey));
    uIOhook.on('mousedown', () => detect('cancel', 0));
    powerMonitor.on('resume',()=>detect('cancel',0));
    powerMonitor.on('unlock-screen',()=>detect('cancel',0));
    uIOhook.start(); hookAvailable = true;
    stopHook = () => uIOhook.stop();
  } catch (error) { console.error('Double Shift unavailable:', error); }
  tray = new Tray(await app.getFileIcon(process.execPath));
  tray.setToolTip('Recall · 双击 Shift 呼起');
  tray.setContextMenu(Menu.buildFromTemplate([
    { label: '呼起 Recall', click: show },
    { label: '工作台 / 设置', click: () => void openManager() },
    {label:'常用链接',click:()=>void openLibrary().catch(console.error)},
    { type: 'separator' }, { label: '退出 Recall', click: () => app.quit() }
  ]));
  tray.on('double-click', show);
  const notices=new Set<Notification>();
  const notify=(rows:Reminder[],failed:(message:string)=>void)=>{
    if(!Notification.isSupported())throw new Error('系统通知不可用，请在工作台查看未处理提醒');
    const notice=new Notification({title:rows.length===1?(rows[0].kind==='deadline'?'Recall · 截止提醒':'Recall · 到时间回访了'):`Recall · ${rows.length} 条到期提醒`,body:rows.length===1?(rows[0].text.split('\n')[0]||'附件事项'):'点击打开工作台，逐项查看、延后或处理。',timeoutType:'default'});
    notices.add(notice);notice.on('click',()=>{if(!quitting)void openManager(rows.length===1?rows[0].itemId:null).catch(error=>{reminders.error=String(error);});});
    notice.on('failed',(_event,error)=>{failed('系统通知发送失败：'+error+'；未处理提醒仍保留在工作台');notices.delete(notice);});
    notice.on('close',()=>notices.delete(notice));notice.show();return notice;
  };
  if(process.platform==='win32'&&app.isPackaged&&!startupCheck&&!smoke&&!testDirectory){
    try{const menu=join(app.getPath('appData'),'Microsoft','Windows','Start Menu','Programs');mkdirSync(menu,{recursive:true});if(!shell.writeShortcutLink(join(menu,'Recall.lnk'),'create',{target:process.execPath,cwd:dirname(process.execPath),appUserModelId:'Recall.Desktop',toastActivatorClsid:app.toastActivatorCLSID,description:'Recall 本地任务工作台'}))throw new Error('无法建立通知快捷方式');}
    catch(error){reminders.error='系统提醒注册失败：'+String(error)+'；可在工作台查看提醒';}
  }
  const checkBackground=()=>{
    if(maintenance||preparingMaintenance||quitting)return;
    try{reminders.tick(notify);}catch(error){reminders.error=String(error);}
    try{if(protection.due())void maintain(()=>protection.backup('daily')).catch(error=>console.error('自动备份失败，原数据保留',String(error)));}catch(error){console.error('自动备份检查失败',String(error));}
  };
  powerMonitor.on('resume',checkBackground);
  const clean=()=>{clearInterval(background);nativeTheme.removeListener('updated',applyTheme);globalShortcut.unregisterAll();stopHook();tray?.destroy();for(const notice of notices)notice.close();analysis.stop();store.close();};
  let quitPending=false;
  app.on('before-quit',event=>{
    if(quitting)return;event.preventDefault();
    if(quitPending)return;quitPending=true;
    void flushWindows().then(()=>{quitting=true;clean();app.exit(0);}).catch(error=>{quitPending=false;dialog.showErrorBox('尚未退出，输入仍保留',String(error));});
  });
  if(!startupCheck)await window.loadFile(join(__dirname, 'index.html'));
  launcherReady=true;if(pendingShow){pendingShow=false;show();}
  if(!smoke&&!startupCheck){background=setInterval(checkBackground,30000);setTimeout(checkBackground,5000);}
  if (smoke) {
    try {
      const runSmoke = require(join(app.getAppPath(), 'tests', 'desktop.cjs'));
      await runSmoke({ window, store, show, openManager, getManager:() => manager,openLibrary, hookAvailable, fallback, dataDirectory, protection, reminders, notify });
      stopHook(); analysis.stop(); store.close(); app.exit(0);
    } catch (error) { console.error(error); stopHook(); analysis.stop(); store.close(); app.exit(1); }
  } else if (startupCheck) {
    if (!hookAvailable || (!fallback&&!process.argv.includes('--allow-shortcut-conflict'))) throw new Error('启动检查：全局快捷入口不可用');
    writeFileSync(join(dataDirectory, 'startup-check.json'), JSON.stringify({ checkedAt: new Date().toISOString(), appPath: app.getAppPath(), dataDirectory, hookAvailable, fallback, node: process.versions.node, electron: process.versions.electron, persistedItems: store.search('').length }, null, 2));
    quitting=true;clean();app.exit(0);
  } else {
    if(!process.argv.includes('--background'))show();
    if(lifecycleCheck)setTimeout(()=>app.quit(),1000);
    if (!hookAvailable) dialog.showMessageBox(window, { type: 'warning', message: '双击 Shift 暂时不可用', detail: fallback ? '可用 Ctrl+Alt+Space 或系统托盘呼起，记录与保存不受影响。' : '可从系统托盘呼起，记录与保存不受影响。' });
  }
}).catch(error => { console.error(error); dialog.showErrorBox('Recall 启动失败', String(error)); app.exit(1); });
