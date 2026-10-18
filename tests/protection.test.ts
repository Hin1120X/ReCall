import {test} from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync,mkdirSync,readFileSync,writeFileSync,rmSync,existsSync,renameSync,readdirSync} from 'node:fs';
import {join} from 'node:path';
import {tmpdir} from 'node:os';
import {DatabaseSync} from 'node:sqlite';
import {Store,SCHEMA_VERSION} from '../src/store.ts';
import {snapshotData,inspectBackup,databaseInfo} from '../src/data.ts';
import {Protection,prepareRestore,installRestore,recoverRestore} from '../src/protection.ts';
import {Reminders} from '../src/reminders.ts';
import type {SaveInput,Reminder} from '../src/shared.ts';
const fresh:SaveInput={id:null,expectedUpdatedAt:null,text:'无敏感样例事项',quadrant:null,reminder:null,deadline:null,folder:null,pending:[]};

test('事项扩展、未知记录类型、草稿扩展和记录附件在普通编辑与重开后保留',()=>{
  const root=mkdtempSync(join(tmpdir(),'recall-extension-'));let store=new Store(root);
  try{
    let item=store.save({...fresh,extra:{version:1,fields:{future:{a:[1,'测试']},owner:'样例'}}},[]);
    const id=item.id,created=item.createdAt;
    item=store.save({...fresh,id,expectedUpdatedAt:item.updatedAt,text:'修改正文'},[]);
    assert.deepEqual(item.extra,{version:1,fields:{future:{a:[1,'测试']},owner:'样例'}});
    item=store.save({...fresh,id,expectedUpdatedAt:item.updatedAt,extra:{version:1,fields:{owner:'新值'}}},[]);
    assert.deepEqual(item.extra?.fields.future,{a:[1,'测试']});assert.equal(item.extra?.fields.owner,'新值');
    assert.throws(()=>store.save({...fresh,extra:{version:99,fields:{}}},[]),/扩展属性/);
    assert.throws(()=>store.save({...fresh,extra:{version:1,fields:{number:NaN}}},[]),/JSON/);
    item=store.addNote(id,'一次沟通结果','communication',[{name:'meeting.txt',bytes:Buffer.from('无敏感输入')}],undefined,[],{version:1,fields:{result:'等待反馈'}});
    assert.equal(item.notes[0].kind,'communication');assert.equal(item.lastProgressAt,null);assert.equal(item.attachments[0].noteId,item.notes[0].id);
    store.saveDraft('capture',{text:'草稿',pending:[],extra:{version:1,fields:{later:'保留'}}});store.saveDraft('capture',{text:'续写',pending:[]});
    store.close();store=new Store(root);item=store.get(id);
    assert.equal(item.createdAt,created);assert.equal(item.notes[0].extra?.fields.result,'等待反馈');assert.equal(store.drafts().capture.extra?.fields.later,'保留');
    const captured=store.save({...fresh,draftKey:'capture'},[]);assert.equal(captured.extra?.fields.later,'保留');
  }finally{store.close();rmSync(root,{recursive:true,force:true});}
});

test('旧格式 v4 备份可校验并在临时目录升级，旧数据和旧备份保持不变',()=>{
  const root=mkdtempSync(join(tmpdir(),'recall-v4-restore-')),data=join(root,'data'),backup=join(root,'old-backup');let store=new Store(data);
  try{
    const item=store.save({...fresh,state:'paused',resumeNote:'旧现场',nextStep:'旧下一步'},[{name:'a.txt',bytes:Buffer.from('历史文件')}]);store.addNote(item.id,'历史进展','progress',[]);store.close();
    const db=new DatabaseSync(join(data,'recall.sqlite'));db.exec('ALTER TABLE items DROP COLUMN extra; ALTER TABLE notes DROP COLUMN extra; ALTER TABLE attachments DROP COLUMN noteId; DROP TABLE reminders; PRAGMA user_version=4');db.close();
    snapshotData(data,backup);rmSync(join(backup,'backup-manifest.json'));const info=inspectBackup(backup,SCHEMA_VERSION);assert.equal(info.legacy,true);assert.equal(info.schema,4);
    const before=databaseInfo(data).signature;
    const stage=prepareRestore(backup,data,SCHEMA_VERSION,path=>{const staged=new Store(path,{backups:join(root,'migrations')});assert.equal(staged.get(item.id).nextStep,'旧下一步');staged.close();});
    assert.equal(databaseInfo(data).signature,before);assert.equal(databaseInfo(backup).schema,4);assert.equal(existsSync(join(backup,'backup-manifest.json')),false);
    installRestore(data,stage);store=new Store(data);assert.equal(store.get(item.id).notes[0].text,'历史进展');assert.equal(store.get(item.id).attachments[0].noteId,null);assert.equal(databaseInfo(data).schema,SCHEMA_VERSION);
  }finally{store.close();rmSync(root,{recursive:true,force:true});}
});

test('备份覆盖新表、草稿、扩展、设置及文件，发现篡改和缺失附件拒绝恢复',()=>{
  const root=mkdtempSync(join(tmpdir(),'recall-snapshot-')),data=join(root,'data'),backup=join(root,'backup');const store=new Store(data);
  try{
    const item=store.save({...fresh,extra:{version:1,fields:{next:'保留'}}},[{name:'input.txt',bytes:Buffer.from('附件原文')}]);
    const pending=store.stage({name:'draft.txt',bytes:Buffer.from('草稿附件')});store.saveDraft('capture',{text:'未提交',pending:[pending]});
    store.db.exec("CREATE TABLE future_records(id TEXT PRIMARY KEY,body TEXT); INSERT INTO future_records VALUES('future','完整保留')");
    writeFileSync(join(data,'opencode-settings.json'),JSON.stringify({executable:'sample.exe',model:'sample/model'}));
    snapshotData(data,backup);const info=inspectBackup(backup,SCHEMA_VERSION);
    assert.equal(info.counts.future_records,1);assert.equal(info.counts.drafts,1);assert.equal(info.signature,databaseInfo(data).signature);
    assert.ok(info.files.some(file=>file.path==='opencode-settings.json'));
    const file=join(backup,'attachments',item.attachments[0].id+'.txt');writeFileSync(file,'变更');assert.throws(()=>inspectBackup(backup),/变化/);
    rmSync(store.attachmentPath(item.id,item.attachments[0].id).path);assert.throws(()=>snapshotData(data,join(root,'missing')),/附件缺失/);assert.equal(existsSync(join(root,'missing')),false);
  }finally{store.close();rmSync(root,{recursive:true,force:true});}
});

test('日常备份按本地日期与数据变化执行，手动备份、重启状态和失败反馈有效',()=>{
  const root=mkdtempSync(join(tmpdir(),'recall-daily-')),data=join(root,'data'),store=new Store(data),state=join(root,'runtime','backup.json');
  try{
    const empty=new Protection(data,join(root,'backups'),state);assert.equal(empty.due(),false);store.saveDraft('capture',{text:'',pending:[]});assert.equal(empty.due(),false);store.saveDraft('capture',{text:'有内容的未提交草稿',pending:[]});assert.equal(empty.due(),true);
    store.save(fresh,[]);const service=new Protection(data,join(root,'backups'),state);assert.equal(service.due(),true);
    const info=service.backup('daily');assert.ok(info.lastSuccess);assert.equal(service.due(),false);
    assert.equal(new Protection(data,join(root,'backups'),state).info().lastPath,info.lastPath);
    const tomorrow=new Date(Date.now()+86400000);assert.equal(service.due(tomorrow),false);store.addNote(store.items()[0].id,'新增','note',[]);assert.equal(service.due(tomorrow),true);
    assert.throws(()=>service.choose(data),/之外/);
    const destination=join(root,'external');mkdirSync(destination);service.choose(destination);assert.ok(service.backup().lastPath.startsWith(destination));
    rmSync(destination,{recursive:true});writeFileSync(destination,'无法创建目录');assert.throws(()=>service.backup());assert.ok(service.info().error);assert.equal(store.items().length,1);
  }finally{store.close();rmSync(root,{recursive:true,force:true});}
});

test('没有任务但已有独立常用资料时仍每日备份，改名与新目录实体也触发次日备份',()=>{
  const root=mkdtempSync(join(tmpdir(),'recall-library-backup-')),data=join(root,'data'),store=new Store(data),service=new Protection(data,join(root,'backups'),join(root,'runtime','backup.json'));
  try{
    assert.equal(service.due(),false);let resource=store.saveCatalog({id:null,kind:'resource',name:'常用报表入口',target:'https://example.com/report'});
    assert.equal(store.items().length,0);assert.equal(service.due(),true);const first=service.backup('daily');assert.ok(first.lastSuccess);const backup=inspectBackup(first.lastPath,SCHEMA_VERSION);assert.equal(backup.counts.items,0);assert.equal(backup.counts.catalog_entries,1);
    assert.equal(service.due(),false);const tomorrow=new Date(Date.now()+86400000);assert.equal(service.due(tomorrow),false);
    resource=store.saveCatalog({...resource,name:'报表入口新名称',expectedUpdatedAt:resource.updatedAt});assert.equal(service.due(tomorrow),true);assert.equal(store.items().length,0);
    store.saveCatalog({id:null,kind:'group',name:'工作身份'});store.saveCatalog({id:null,kind:'person',name:'样例同事'});const second=service.backup();assert.equal(inspectBackup(second.lastPath,SCHEMA_VERSION).counts.catalog_entries,3);
  }finally{store.close();rmSync(root,{recursive:true,force:true});}
});

test('恢复先迁移校验，完整保全恢复前数据；错误备份不会切换目录',()=>{
  const root=mkdtempSync(join(tmpdir(),'recall-restore-')),data=join(root,'data'),backup=join(root,'backup');let store=new Store(data);
  try{
    const first=store.save(fresh,[{name:'a.txt',bytes:Buffer.from('原文件')}]);snapshotData(data,backup);store.addNote(first.id,'备份后新增进展','progress',[]);
    const before=databaseInfo(data).signature;
    assert.throws(()=>prepareRestore(backup,data,SCHEMA_VERSION,()=>{throw new Error('样例迁移失败');}),/样例迁移失败/);assert.equal(databaseInfo(data).signature,before);
    const stage=prepareRestore(backup,data,SCHEMA_VERSION,path=>{const copy=new Store(path);copy.items();copy.close();});store.close();
    const previous=installRestore(data,stage);store=new Store(data);assert.equal(store.get(first.id).notes.length,0);
    const old=new Store(previous);assert.equal(old.get(first.id).notes[0].text,'备份后新增进展');old.close();assert.equal(readFileSync(store.attachmentPath(first.id,first.attachments[0].id).path,'utf8'),'原文件');
    const manifest=JSON.parse(readFileSync(join(backup,'backup-manifest.json'),'utf8'));manifest.format=999;writeFileSync(join(backup,'backup-manifest.json'),JSON.stringify(manifest));assert.throws(()=>prepareRestore(backup,data,SCHEMA_VERSION,()=>{}),/版本/);
  }finally{store.close();rmSync(root,{recursive:true,force:true});}
});

test('恢复目录切换中断后启动回到原数据，目录记录不能越界',()=>{
  const root=mkdtempSync(join(tmpdir(),'recall-recovery-')),data=join(root,'data');let store=new Store(data);store.save(fresh,[]);store.close();
  try{
    const id='12345678-1234-1234-1234-123456789abc',previous='data-before-restore-'+id,stage='restore-stage-'+id;
    writeFileSync(join(root,'restore-journal.json'),JSON.stringify({previous,stage}));renameSync(data,join(root,previous));mkdirSync(join(root,stage));
    recoverRestore(data);store=new Store(data);assert.equal(store.items().length,1);store.close();assert.equal(existsSync(join(root,'restore-journal.json')),false);
    writeFileSync(join(root,'restore-journal.json'),JSON.stringify({previous:'../outside',stage}));assert.throws(()=>recoverRestore(data),/无效/);
  }finally{rmSync(root,{recursive:true,force:true});}
});

test('到期提醒持久化去重、补查、延后、完成取消与时间变更，均不修改截止或推进时间',()=>{
  const root=mkdtempSync(join(tmpdir(),'recall-reminders-'));let store=new Store(root);const now=Date.parse('2026-10-16T04:00:00.000Z'),due=new Date(now-1000).toISOString();
  try{
    let item=store.save({...fresh,reminder:due,deadline:due},[]);let service=new Reminders(store);const batches:Reminder[][]=[];
    service.tick(rows=>batches.push(rows),now);assert.equal(batches.length,1);assert.equal(batches[0].length,2);service.tick(rows=>batches.push(rows),now);assert.equal(batches.length,1);
    store.close();store=new Store(root);service=new Reminders(store);service.tick(rows=>batches.push(rows),now+1000);assert.equal(batches.length,1);
    const deadline=service.list(now).find(row=>row.kind==='deadline')!;service.handle(deadline.id,10,now);assert.equal(service.list(now).length,1);assert.equal(store.get(item.id).deadline,due);assert.equal(store.get(item.id).lastProgressAt,null);
    service.tick(rows=>batches.push(rows),now+600001);assert.equal(batches.length,2);service.handle(deadline.id,null,now+600001);assert.equal(service.list(now+600001).length,1);
    item=store.get(item.id);item=store.save({...item,expectedUpdatedAt:item.updatedAt,reminder:null,pending:[]},[]);assert.equal(service.list(now+600001).length,0);
    item=store.save({...item,expectedUpdatedAt:item.updatedAt,reminder:new Date(now+1000).toISOString(),pending:[]},[]);service.tick((_rows,failed)=>failed('通知受限'),now+2000);assert.equal(service.error,'通知受限');assert.equal(service.list(now+2000).length,1);
    store.setState(item.id,'done',item.updatedAt);assert.equal(service.list(now+2000).length,0);assert.equal(store.get(item.id).lastProgressAt,null);
    const completed=store.save({...fresh,text:'已处理提醒样例',deadline:due},[]);service.tick(rows=>batches.push(rows),now+3000);const handled=service.list(now+3000).find(row=>row.itemId===completed.id)!;service.handle(handled.id,null,now+3000);const count=batches.length;
    const done=store.setState(completed.id,'done',completed.updatedAt);service.list(now+3000);store.setState(completed.id,'ready',done.updatedAt);service.tick(rows=>batches.push(rows),now+4000);assert.equal(batches.length,count,'重新打开事项不重复发送已处理提醒');
  }finally{store.close();rmSync(root,{recursive:true,force:true});}
});
