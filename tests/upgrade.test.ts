import {test} from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync,mkdirSync,writeFileSync,readFileSync,rmSync,readdirSync,renameSync,existsSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {DatabaseSync} from 'node:sqlite';
import {Store,SCHEMA_VERSION} from '../src/store.ts';
import {snapshotData,prepareDataDirectory,dataSignature} from '../src/data.ts';
import {candidates} from '../src/workbench.ts';
import {todoContext,AnalysisService} from '../src/analysis.ts';
import type {SaveInput} from '../src/shared.ts';
const fresh:SaveInput={id:null,expectedUpdatedAt:null,text:'无敏感样例',quadrant:null,reminder:null,deadline:null,folder:null,pending:[]};
function legacy(path:string,version:number) {
  mkdirSync(join(path,'attachments'),{recursive:true});writeFileSync(join(path,'attachments','sample.md'),'# 原始附件内容');writeFileSync(join(path,'opencode-settings.json'),'原有设置');
  const db=new DatabaseSync(join(path,'recall.sqlite'));
  db.exec(`CREATE TABLE items(id TEXT PRIMARY KEY,text TEXT NOT NULL,quadrant INTEGER,reminder TEXT,deadline TEXT,folder TEXT,createdAt TEXT NOT NULL,updatedAt TEXT NOT NULL,lastProgressAt TEXT);
    CREATE TABLE attachments(id TEXT PRIMARY KEY,itemId TEXT NOT NULL,name TEXT NOT NULL,path TEXT NOT NULL${version>=3?",role TEXT NOT NULL DEFAULT 'input'":''});
    INSERT INTO items VALUES('legacy','旧事项正文',1,'2026-11-01T00:00:00.000Z',NULL,'D:/原位资料','2026-10-01T00:00:00.000Z','2026-10-02T00:00:00.000Z','2026-10-02T00:00:00.000Z'); PRAGMA user_version=${version};`);
  db.prepare('INSERT INTO attachments(id,itemId,name,path) VALUES(?,?,?,?)').run('attachment','legacy','sample.md',join(path,'attachments','sample.md'));
  if(version>=2)db.exec("CREATE TABLE analyses(id TEXT PRIMARY KEY,itemId TEXT,kind TEXT,state TEXT,output TEXT,error TEXT,model TEXT,version TEXT,fingerprint TEXT,createdAt TEXT,finishedAt TEXT); INSERT INTO analyses VALUES('analysis','legacy','approach','succeeded','已有建议','','sample/model','v2','old','2026-10-02T00:00:00.000Z','2026-10-02T00:00:00.000Z');");
  if(version>=3)db.exec("CREATE TABLE notes(id TEXT PRIMARY KEY,itemId TEXT,kind TEXT,text TEXT,createdAt TEXT); INSERT INTO notes VALUES('note','legacy','progress','已有实际进展','2026-10-02T00:00:00.000Z'); CREATE TABLE refs(id TEXT PRIMARY KEY,itemId TEXT,name TEXT,target TEXT,kind TEXT,role TEXT,createdAt TEXT); INSERT INTO refs VALUES('ref','legacy','本地引用','D:/原位资料/input.docx','file','input','2026-10-02T00:00:00.000Z');");
  if(version>=4){db.exec("ALTER TABLE items ADD COLUMN state TEXT NOT NULL DEFAULT 'ready'; ALTER TABLE items ADD COLUMN inbox INTEGER NOT NULL DEFAULT 0; ALTER TABLE items ADD COLUMN nextStep TEXT NOT NULL DEFAULT ''; ALTER TABLE items ADD COLUMN resumeNote TEXT NOT NULL DEFAULT ''; ALTER TABLE items ADD COLUMN waitingFor TEXT NOT NULL DEFAULT ''; ALTER TABLE items ADD COLUMN completedAt TEXT; UPDATE items SET state='paused',nextStep='接着核对第四项',resumeNote='停在第三项'; UPDATE attachments SET path='attachments/sample.md'; CREATE TABLE drafts(key TEXT PRIMARY KEY,body TEXT NOT NULL,updatedAt TEXT NOT NULL); CREATE TABLE pending_files(token TEXT PRIMARY KEY,name TEXT NOT NULL,path TEXT NOT NULL);");db.prepare('INSERT INTO drafts VALUES(?,?,?)').run('edit:legacy',JSON.stringify({text:'旧版未提交草稿',pending:[],itemId:'legacy',expectedUpdatedAt:'2026-10-02T00:00:00.000Z'}),'2026-10-02T00:00:00.000Z');}
  const original=db.prepare('SELECT * FROM items').get()!;db.close();return original;
}
test('各历史结构升级、备份与重启保留正文、进展、资料和时间，移动目录后附件仍可打开',()=>{
  const root=mkdtempSync(join(tmpdir(),'recall-upgrades-'));
  try{for(const version of [0,1,2,3,4]) {
    const path=join(root,'v'+version),backup=join(root,'backups-v'+version),original=legacy(path,version);
    let store=new Store(path,{backups:backup,version:'0.2.0'});const item=store.get('legacy');
    for(const [key,value] of Object.entries(original))assert.deepEqual(item[key as keyof typeof item],key==='inbox'?!!value:value,key);
    assert.equal(item.state,version>=4?'paused':'ready');assert.equal(item.inbox,false);assert.equal(item.nextStep,version>=4?'接着核对第四项':'');
    if(version>=4)assert.equal(store.drafts()['edit:legacy'].text,'旧版未提交草稿');
    assert.equal(readFileSync(store.attachmentPath(item.id,'attachment').path,'utf8'),'# 原始附件内容');
    if(version>=2)assert.equal(store.analyses(item.id)[0].output,'已有建议');
    if(version>=3){assert.equal(item.notes[0].text,'已有实际进展');assert.equal(item.references[0].target,'D:/原位资料/input.docx');}
    assert.equal(store.db.prepare('PRAGMA user_version').get()!.user_version,SCHEMA_VERSION);store.close();
    const archives=readdirSync(backup);assert.equal(archives.length,1);const archive=join(backup,archives[0]);
    const old=new DatabaseSync(join(archive,'recall.sqlite'),{readOnly:true});assert.deepEqual({...old.prepare('SELECT * FROM items').get()}, {...original});assert.equal(old.prepare('PRAGMA user_version').get()!.user_version,version);old.close();
    assert.equal(readFileSync(join(archive,'attachments','sample.md'),'utf8'),'# 原始附件内容');assert.equal(readFileSync(join(archive,'opencode-settings.json'),'utf8'),'原有设置');
    store=new Store(path,{backups:backup,version:'0.2.0'});store.close();assert.equal(readdirSync(backup).length,1,'同版本重启不重复迁移');
    const moved=path+'-moved';renameSync(path,moved);store=new Store(moved,{backups:backup,version:'0.2.0'});assert.equal(readFileSync(store.attachmentPath('legacy','attachment').path,'utf8'),'# 原始附件内容');store.addNote('legacy','升级后继续记录','note',[]);store.close();
  }}finally{rmSync(root,{recursive:true,force:true});}
});
test('拒绝未知新版本；迁移缺失附件或备份失败时保留原库且不提高版本',()=>{
  const root=mkdtempSync(join(tmpdir(),'recall-upgrade-fail-'));
  try{
    const future=join(root,'future');mkdirSync(future);let db=new DatabaseSync(join(future,'recall.sqlite'));db.exec('CREATE TABLE future(x); INSERT INTO future VALUES(7); PRAGMA user_version=99');db.close();const bytes=readFileSync(join(future,'recall.sqlite'));assert.throws(()=>new Store(future),/更新/);assert.deepEqual(readFileSync(join(future,'recall.sqlite')),bytes);assert.equal(existsSync(join(future,'attachments')),false);
    const lost=join(root,'lost');mkdirSync(lost);writeFileSync(join(lost,'release-state.json'),'{"version":"0.2.0"}');assert.throws(()=>new Store(lost),/数据库缺失/);assert.equal(existsSync(join(lost,'recall.sqlite')),false);
    const missing=join(root,'missing'),original=legacy(missing,3);rmSync(join(missing,'attachments','sample.md'));assert.throws(()=>new Store(missing,{backups:join(root,'backups')}),/附件缺失/);
    db=new DatabaseSync(join(missing,'recall.sqlite'));assert.deepEqual({...db.prepare('SELECT * FROM items').get()},{...original});assert.equal(db.prepare('PRAGMA user_version').get()!.user_version,3);assert.equal(db.prepare('PRAGMA table_info(items)').all().length,9);db.close();
    const blocked=join(root,'blocked');legacy(blocked,2);writeFileSync(join(root,'backup-file'),'blocked');assert.throws(()=>new Store(blocked,{backups:join(root,'backup-file')}));db=new DatabaseSync(join(blocked,'recall.sqlite'));assert.equal(db.prepare('PRAGMA user_version').get()!.user_version,2);db.close();
  }finally{rmSync(root,{recursive:true,force:true});}
});
test('正式目录接续旧便携库一次；旧数据后来变化或目标非空时拒绝覆盖',()=>{
  const root=mkdtempSync(join(tmpdir(),'recall-adopt-'));
  try{
    const old=join(root,'old'),target=join(root,'fixed'),backup=join(root,'backups');legacy(old,3);const before=dataSignature(old);
    prepareDataDirectory(target,old,backup);assert.equal(dataSignature(target),before);assert.equal(dataSignature(old),before);prepareDataDirectory(target,old,backup);assert.equal(readdirSync(backup).length,1);
    const db=new DatabaseSync(join(old,'recall.sqlite'));db.prepare('UPDATE items SET text=?').run('旧版后来新增的修改');db.close();assert.throws(()=>prepareDataDirectory(target,old,backup),/又有变化/);assert.equal(dataSignature(target),before);
    const another=join(root,'another');legacy(another,3);assert.throws(()=>prepareDataDirectory(another,old,backup),/均有数据库/);
  }finally{rmSync(root,{recursive:true,force:true});}
});
test('草稿文字、进展类型和附件独立于源文件持久化，提交原子清理，失败不消耗草稿',()=>{
  const root=mkdtempSync(join(tmpdir(),'recall-drafts-'));
  let store=new Store(root);
  try{
    assert.throws(()=>store.stageMany([{name:'first.txt',bytes:new Uint8Array([1])},{name:'lost.txt',source:join(root,'missing')}]),/ENOENT/);assert.equal(store.db.prepare('SELECT count(*) AS n FROM pending_files').get()!.n,0);assert.deepEqual(readdirSync(join(root,'draft-files')),[],'批量导入失败不留下半组附件');
    const source=join(root,'input.txt');writeFileSync(source,'草稿附件原文');const pending=store.stage({name:'input.txt',source});store.saveDraft('capture',{text:'未提交草稿',pending:[pending],quadrant:null});rmSync(source);store.close();store=new Store(root);
    assert.equal(store.todos().length,0);assert.equal(store.drafts().capture.text,'未提交草稿');assert.equal(readFileSync((store.materialsFor([pending.token])[0] as {source:string}).source,'utf8'),'草稿附件原文');
    const item=store.save({...fresh,text:'未提交草稿',pending:[pending.token],draftKey:'capture'},store.materialsFor([pending.token]));assert.equal(store.drafts().capture,undefined);assert.equal(store.db.prepare('SELECT count(*) AS n FROM pending_files').get()!.n,0);assert.equal(readFileSync(store.attachmentPath(item.id,item.attachments[0].id).path,'utf8'),'草稿附件原文');
    const staged=store.stage({name:'result.txt',bytes:new Uint8Array([2,3])});store.saveDraft('note:'+item.id,{text:'已推进',kind:'progress',itemId:item.id,pending:[staged]});store.close();store=new Store(root);assert.equal(store.drafts()['note:'+item.id].kind,'progress');
    const before=store.get(item.id);assert.throws(()=>store.addNote(item.id,'失败','progress',[{name:'lost',source:join(root,'missing')}],'note:'+item.id,[staged.token]));assert.deepEqual(store.get(item.id),before);assert.ok(store.drafts()['note:'+item.id]);
    store.addNote(item.id,'已推进','progress',store.materialsFor([staged.token]),'note:'+item.id,[staged.token]);assert.equal(store.drafts()['note:'+item.id],undefined);assert.ok(store.get(item.id).lastProgressAt);
    const orphan=store.stage({name:'interrupted.txt',bytes:new Uint8Array([9])});store.close();store=new Store(root);assert.ok(store.drafts().capture.pending.some(file=>file.token===orphan.token),'导入后中断的附件可恢复');
    const snapshot=root+'-snapshot';snapshotData(root,snapshot);assert.equal(dataSignature(root),dataSignature(snapshot));rmSync(snapshot,{recursive:true,force:true});
  }finally{store.close();rmSync(root,{recursive:true,force:true});}
});
test('状态与现场不计推进；完成排除排序、恢复保留资料、冲突不得覆盖',()=>{
  const root=mkdtempSync(join(tmpdir(),'recall-states-'));const store=new Store(root);
  try{
    let item=store.save(fresh,[]);const stale=item.updatedAt;
    item=store.save({...fresh,id:item.id,expectedUpdatedAt:item.updatedAt,state:'paused',nextStep:'核对第一项',resumeNote:'停在第二步',waitingFor:'同事反馈',inbox:false},[]);assert.equal(item.lastProgressAt,null);assert.equal(item.inbox,false);assert.match(todoContext([item]),/核对第一项/);assert.match(todoContext([item]),/停在第二步/);
    assert.throws(()=>store.setState(item.id,'active',stale),/发生变化/);item=store.setState(item.id,'done',item.updatedAt);assert.equal(store.todos().length,0);assert.ok(item.completedAt);assert.equal(item.lastProgressAt,null);
    const service=new AnalysisService(store,()=>({executable:'',model:''}));assert.throws(()=>service.start({kind:'approach',itemId:item.id}),/已完成/);service.stop();item=store.setState(item.id,'ready',item.updatedAt);assert.equal(item.completedAt,null);assert.equal(item.resumeNote,'停在第二步');assert.equal(store.todos().length,1);
  }finally{store.close();rmSync(root,{recursive:true,force:true});}
});
test('候选每次按到期与状态计算，重要未推进再次出现，同组保留输入顺序',()=>{
  const root=mkdtempSync(join(tmpdir(),'recall-candidates-'));const store=new Store(root);
  try{
    const now=Date.parse('2026-10-12T00:00:00.000Z');const first=store.save({...fresh,text:'普通第一项'},[]),second=store.save({...fresh,text:'普通第二项'},[]);
    const important={...first,id:'important',quadrant:1,createdAt:'2026-10-01T00:00:00.000Z'},urgent={...second,id:'urgent',deadline:'2026-10-13T00:00:00.000Z'};
    const waiting={...first,id:'waiting',state:'waiting' as const,reminder:'2026-10-12T01:00:00.000Z'},done={...first,id:'done',state:'done' as const};
    assert.deepEqual(candidates([first,second,important,urgent,waiting,done],now).map(item=>item.id),['urgent','important',first.id,second.id]);assert.match(candidates([important],now)[0].reason,/11 天/);assert.equal(candidates([waiting],now+3600000).length,1);assert.equal(candidates([{...first,reminder:'2026-11-01T00:00:00.000Z'}],now).length,0);
  }finally{store.close();rmSync(root,{recursive:true,force:true});}
});
