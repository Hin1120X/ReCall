import {test} from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync,rmSync,readdirSync,existsSync,writeFileSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {DatabaseSync} from 'node:sqlite';
import {Store,SCHEMA_VERSION} from '../src/store.ts';
import {snapshotData,inspectBackup,databaseInfo} from '../src/data.ts';
import type {SaveInput,Relations} from '../src/shared.ts';
import {createV5Fixture} from './fixtures/v5.ts';

const fresh:SaveInput={id:null,expectedUpdatedAt:null,text:'无敏感样例事项',quadrant:null,reminder:null,deadline:null,folder:null,pending:[]};
const fixture=()=>{const root=mkdtempSync(join(tmpdir(),'recall-catalog-'));return {root,data:join(root,'data'),backups:join(root,'backups')};};

test('多组、多人和常用资料关联按类型保存，普通编辑保留，显式清空与冲突不丢失',()=>{
  const {root,data,backups}=fixture();const store=new Store(data,{backups});
  try{
    const first=store.saveCatalog({id:null,kind:'group',name:'团队管理'}),second=store.saveCatalog({id:null,kind:'group',name:'项目交付'});
    const person=store.saveCatalog({id:null,kind:'person',name:'小李'}),another=store.saveCatalog({id:null,kind:'person',name:'小王'});
    const resource=store.saveCatalog({id:null,kind:'resource',name:'报销系统',target:'https://example.com/expense',aliases:['BX','费用入口'],pinned:true});
    let item=store.save({...fresh,groupIds:[first.id,second.id],personIds:[person.id,another.id],resourceIds:[resource.id],extra:{version:1,fields:{future:{keep:1}}}},[]);
    assert.deepEqual(item.groupIds,[first.id,second.id]);assert.deepEqual(item.personIds,[person.id,another.id]);assert.deepEqual(item.resourceIds,[resource.id]);
    const stale=item.updatedAt;
    item=store.save({...fresh,id:item.id,expectedUpdatedAt:item.updatedAt,text:'继续处理'},[]);
    assert.deepEqual(item.groupIds,[first.id,second.id]);assert.deepEqual(item.extra?.fields.future,{keep:1});
    assert.throws(()=>store.save({...fresh,id:item.id,expectedUpdatedAt:stale,groupIds:[]},[]),/发生变化/);
    for(const invalid of [{groupIds:[first.id,first.id]},{groupIds:[person.id]},{personIds:['missing']},{resourceIds:null}] as unknown as Relations[]){assert.throws(()=>store.save({...fresh,id:item.id,expectedUpdatedAt:item.updatedAt,...invalid},[]),/关联/);}
    assert.deepEqual(store.get(item.id).groupIds,[first.id,second.id]);
    assert.throws(()=>store.save({...fresh,id:item.id,expectedUpdatedAt:item.updatedAt,groupIds:[]},[{name:'missing',source:join(root,'missing')}]),/ENOENT/);
    assert.deepEqual(store.get(item.id).groupIds,[first.id,second.id]);
    item=store.save({...fresh,id:item.id,expectedUpdatedAt:item.updatedAt,groupIds:[]},[]);assert.deepEqual(item.groupIds,[]);assert.deepEqual(item.personIds,[person.id,another.id]);assert.equal(item.lastProgressAt,null);
  }finally{store.close();rmSync(root,{recursive:true,force:true});}
});

test('标签草稿独立保留并跨重开，省略关系不清空，明确移除可清空',()=>{
  const {root,data,backups}=fixture();let store=new Store(data,{backups});
  try{
    const group=store.saveCatalog({id:null,kind:'group',name:'交付负责人'}),person=store.saveCatalog({id:null,kind:'person',name:'小张'});
    store.saveDraft('capture',{text:'',pending:[],groupIds:[group.id],personIds:[person.id]});
    assert.ok(store.drafts().capture,'只选标签的草稿不能被当作空白删除');
    store.saveDraft('capture',{text:'后续正文',pending:[]});store.close();store=new Store(data,{backups});
    assert.deepEqual(store.drafts().capture.groupIds,[group.id]);assert.deepEqual(store.drafts().capture.personIds,[person.id]);
    const saved=store.save({...fresh,text:'后续正文',draftKey:'capture'},[]);assert.deepEqual(saved.groupIds,[group.id]);assert.deepEqual(saved.personIds,[person.id]);
    store.saveDraft('capture',{text:'',pending:[],groupIds:[group.id]});store.saveDraft('capture',{text:'',pending:[],groupIds:[],personIds:[]});assert.equal(store.drafts().capture,undefined);
    store.saveDraft('edit:'+saved.id,{...saved,text:saved.text,pending:[],groupIds:[]});assert.deepEqual(store.drafts()['edit:'+saved.id].groupIds,[]);
    store.saveDraft('edit:'+saved.id,{...saved,pending:[],extra:saved.extra});assert.equal(store.drafts()['edit:'+saved.id],undefined,'完整extra未改变时不能制造编辑草稿');
    store.saveDraft('capture',{text:'',pending:[],groupIds:[],personIds:[],extra:{version:1,fields:{}}});assert.equal(store.drafts().capture,undefined);
    assert.throws(()=>store.saveDraft('capture',{text:'无效',pending:[],groupIds:[person.id]}),/类型不匹配/);
  }finally{store.close();rmSync(root,{recursive:true,force:true});}
});

test('目录稳定编号、改名归档、别名拼音检索与最近使用，不计实际推进或触碰任务编辑版本',()=>{
  const {root,data,backups}=fixture();const store=new Store(data,{backups});
  try{
    let group=store.saveCatalog({id:null,kind:'group',name:'团队管理'});const person=store.saveCatalog({id:null,kind:'person',name:'小李'});
    let resource=store.saveCatalog({id:null,kind:'resource',name:'报销模板',target:'https://example.com/template',aliases:['费用表'],pinned:true});
    const item=store.save({...fresh,text:'每周填写',groupIds:[group.id],personIds:[person.id],resourceIds:[resource.id]},[]);
    assert.equal(store.catalog('resource','baoxiao')[0].id,resource.id);assert.equal(store.catalog('resource','bxmb')[0].id,resource.id);assert.equal(store.catalog('resource','费用表')[0].id,resource.id);
    assert.equal(store.queryTasks({query:'tuanduiguanli xiaoli fyb'})[0].id,item.id);
    const before=store.get(item.id);assert.deepEqual(store.queryTasks({recent:true}),[]);store.touchTask(item.id);assert.deepEqual(store.get(item.id),before);assert.equal(store.queryTasks({recent:true})[0].id,item.id);
    const originalUpdated=resource.updatedAt;store.touchResource(resource.id);resource=store.catalog('resource')[0];assert.ok(resource.lastUsedAt);assert.equal(resource.updatedAt,originalUpdated);
    const stale=group.updatedAt;group=store.saveCatalog({...group,name:'团队协调',archived:true,expectedUpdatedAt:group.updatedAt});
    assert.equal(group.id,item.groupIds![0]);assert.equal(store.catalog('group').length,0);assert.equal(store.queryTasks({groupIds:[group.id],query:'团队协调'})[0].id,item.id);
    assert.throws(()=>store.saveCatalog({...group,name:'旧改名',expectedUpdatedAt:stale}),/发生变化/);
    assert.throws(()=>store.saveCatalog({id:null,kind:'group',name:'团队协调'}),/同名/);
    assert.equal(store.get(item.id).lastProgressAt,null);
    const local=join(root,'local.txt');writeFileSync(local,'无敏感资料');let file=store.saveCatalog({id:null,kind:'resource',name:'本地资料',target:local});rmSync(local);
    file=store.saveCatalog({...file,name:'已移动的资料',archived:true,expectedUpdatedAt:file.updatedAt});assert.equal(file.target,local,'源文件暂时不可用仍应支持改名或归档');
  }finally{store.close();rmSync(root,{recursive:true,force:true});}
});

test('分组与相关人筛选先于数量限制，含等待和未来任务；组合筛选默认未完成',()=>{
  const {root,data,backups}=fixture();const store=new Store(data,{backups});
  try{
    const group=store.saveCatalog({id:null,kind:'group',name:'研发'}),person=store.saveCatalog({id:null,kind:'person',name:'同事'});
    const target=store.save({...fresh,text:'目标事项',state:'waiting',reminder:'2099-01-01T01:00:00.000Z',groupIds:[group.id],personIds:[person.id]},[]);
    for(let index=0;index<55;index++)store.save({...fresh,text:'较新的样例'+index},[]);
    assert.equal(store.queryTasks({groupIds:[group.id],personIds:[person.id],limit:1})[0].id,target.id);
    const done=store.setState(target.id,'done',target.updatedAt);assert.equal(store.queryTasks({groupIds:[group.id]}).length,0);assert.equal(store.queryTasks({groupIds:[group.id],status:'done'})[0].id,done.id);
    assert.equal(store.search('目标事项')[0].id,target.id);
  }finally{store.close();rmSync(root,{recursive:true,force:true});}
});

test('v5迁移只增加结构，目录、关系、草稿和未知表可完整备份并重开',()=>{
  const {root,data,backups}=fixture();const db=createV5Fixture(data),original=db.prepare('SELECT * FROM items').get()!,id=original.id as string;db.close();let store:Store|undefined;
  try{
    store=new Store(data,{backups});assert.equal(store.db.prepare('PRAGMA user_version').get()!.user_version,SCHEMA_VERSION);
    for(const [key,value] of Object.entries(original))assert.deepEqual(store.db.prepare('SELECT * FROM items').get()![key],value);
    assert.equal(store.get(id).notes[0].text,'无敏感历史沟通记录');assert.equal(readdirSync(backups).length,1);
    const group=store.saveCatalog({id:null,kind:'group',name:'迁移后分组'});store.saveDraft('capture',{...store.drafts().capture,groupIds:[group.id]});store.save({...fresh,id,expectedUpdatedAt:store.get(id).updatedAt,groupIds:[group.id]},[]);
    const archive=join(root,'archive');snapshotData(data,archive);const info=inspectBackup(archive,SCHEMA_VERSION);assert.equal(info.counts.catalog_entries,1);assert.equal(info.counts.item_catalog,1);assert.equal(info.counts.future_data,1);assert.equal(info.signature,databaseInfo(data).signature);
    store.close();store=new Store(archive,{backups});assert.deepEqual(store.get(id).groupIds,[group.id]);assert.deepEqual(store.drafts().capture.groupIds,[group.id]);assert.deepEqual(store.get(id).extra?.fields.future,{keep:[1,'样例']});
  }finally{store?.close();rmSync(root,{recursive:true,force:true});}
});

test('正常关闭显式checkpoint；其他读连接占用时保留合法WAL并可再次读取',()=>{
  const {root,data,backups}=fixture();let store=new Store(data,{backups});let reader:DatabaseSync|undefined;
  try{
    store.save(fresh,[]);store.db.prepare('PRAGMA wal_checkpoint(TRUNCATE)').get();
    reader=new DatabaseSync(join(data,'recall.sqlite'),{readOnly:true});reader.exec('BEGIN');reader.prepare('SELECT count(*) FROM items').get();
    store.save({...fresh,text:'读连接后新增'},[]);const checkpoint=store.close();assert.equal(checkpoint?.busy,1);assert.ok(existsSync(join(data,'recall.sqlite-wal')));
    reader.close();reader=undefined;store=new Store(data,{backups});assert.equal(store.items().length,2);assert.equal(store.db.prepare('PRAGMA integrity_check').get()!.integrity_check,'ok');assert.equal(store.close()?.busy,0);
  }finally{reader?.close();store.close();rmSync(root,{recursive:true,force:true});}
});

test('checkpoint报错也关闭连接，原已提交数据保持可读',()=>{
  const {root,data,backups}=fixture();let store=new Store(data,{backups});
  try{
    store.save(fresh,[]);store.db.exec('BEGIN IMMEDIATE');
    assert.throws(()=>store.close());assert.throws(()=>store.db.prepare('SELECT 1'),/not open|closed/i);
    store=new Store(data,{backups});assert.equal(store.items().length,1);assert.equal(store.db.prepare('PRAGMA integrity_check').get()!.integrity_check,'ok');
  }finally{store.close();rmSync(root,{recursive:true,force:true});}
});
