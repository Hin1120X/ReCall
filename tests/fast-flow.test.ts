import {test} from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync,rmSync,readdirSync,readFileSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {DatabaseSync} from 'node:sqlite';
import {Store,SCHEMA_VERSION} from '../src/store.ts';
import {inspectBackup,databaseInfo,snapshotData} from '../src/data.ts';
import {localSuggestions} from '../src/workbench.ts';
import type {Item,SaveInput} from '../src/shared.ts';

const fresh:SaveInput={id:null,expectedUpdatedAt:null,text:'无敏感样例事项',quadrant:1,reminder:'2099-01-01T01:00:00.000Z',deadline:null,folder:null,pending:[]};
const fixture=()=>{const root=mkdtempSync(join(tmpdir(),'recall-fast-flow-'));return {root,data:join(root,'data'),backups:join(root,'backups')};};

test('资料属于多个工作分组，省略保留、明确清空、类型与保存冲突及失败事务均受保护',()=>{
  const {root,data,backups}=fixture(),store=new Store(data,{backups});
  try{
    const a=store.saveCatalog({id:null,kind:'group',name:'甲工作线'}),b=store.saveCatalog({id:null,kind:'group',name:'乙工作线'}),person=store.saveCatalog({id:null,kind:'person',name:'小李'});
    let link=store.saveCatalog({id:null,kind:'resource',name:'共享入口',target:'https://example.com/common',groupIds:[a.id,b.id]});
    assert.deepEqual(link.groupIds,[a.id,b.id]);const oldVersion=link.updatedAt;
    link=store.saveCatalog({id:link.id,kind:'resource',name:'改名入口',expectedUpdatedAt:link.updatedAt});assert.deepEqual(link.groupIds,[a.id,b.id]);
    assert.throws(()=>store.saveCatalog({...link,groupIds:[],expectedUpdatedAt:oldVersion}),/发生变化/);
    assert.throws(()=>store.saveCatalog({...link,groupIds:[person.id],expectedUpdatedAt:link.updatedAt}),/类型不匹配/);
    assert.throws(()=>store.saveCatalog({...link,groupIds:[a.id,a.id],expectedUpdatedAt:link.updatedAt}),/重复/);
    store.db.exec("CREATE TEMP TRIGGER fail_group_link BEFORE INSERT ON resource_groups BEGIN SELECT RAISE(FAIL,'样例关系写入失败'); END");
    assert.throws(()=>store.saveCatalog({...link,name:'不能半保存',expectedUpdatedAt:link.updatedAt}),/样例关系/);assert.equal(store.catalog('resource')[0].name,'改名入口');assert.deepEqual(store.catalog('resource')[0].groupIds,[a.id,b.id]);store.db.exec('DROP TRIGGER fail_group_link');
    link=store.saveCatalog({...link,groupIds:[],expectedUpdatedAt:link.updatedAt});assert.deepEqual(link.groupIds,[]);
  }finally{store.close();rmSync(root,{recursive:true,force:true});}
});

test('统一检索不因组名扩散任务，明确组过滤与资源别名地址仍可命中',()=>{
  const {root,data,backups}=fixture(),store=new Store(data,{backups});
  try{
    const group=store.saveCatalog({id:null,kind:'group',name:'不会自动扩展的组'}),person=store.saveCatalog({id:null,kind:'person',name:'小王'});
    const link=store.saveCatalog({id:null,kind:'resource',name:'报表入口',target:'https://example.com/weekly-report',aliases:['周五表'],groupIds:[group.id]});
    const related=store.save({...fresh,text:'填写统计结果',groupIds:[group.id],personIds:[person.id],resourceIds:[link.id]},[]);
    assert.equal(store.lookup({query:group.name}).length,0);assert.equal(store.lookup({query:'周五表'}).length,2);assert.equal(store.lookup({query:'weekly-report',scope:'links'})[0].kind,'link');
    assert.equal(store.lookup({query:'报表',scope:'tasks'})[0].kind,'task');assert.equal(store.lookup({query:'bb rk',scope:'links'})[0].kind,'link');
    assert.equal(store.lookup({groupIds:[group.id],scope:'links'})[0].kind,'link');assert.equal(store.lookup({personIds:[person.id],scope:'links'}).length,0);
    assert.equal(store.lookup({groupIds:[group.id],personIds:[person.id],scope:'tasks'})[0].kind,'task');
    for(let index=0;index<55;index++)store.save({...fresh,text:'较新的无关事项 '+index},[]);
    const filtered=store.lookup({query:'填写统计',groupIds:[group.id],limit:1});assert.equal(filtered.length,1);assert.equal(filtered[0].kind==='task'&&filtered[0].item.id,related.id);
    store.setState(related.id,'done',related.updatedAt);assert.equal(store.lookup({query:'填写统计',scope:'tasks'})[0].kind,'task','查找也能找回已完成历史');
    assert.throws(()=>store.lookup({scope:'invalid' as 'all'}),/检索条件/);
  }finally{store.close();rmSync(root,{recursive:true,force:true});}
});

test('资料草稿独立于任务草稿并跨重开，保存自动命名且事务失败不消费',()=>{
  const {root,data,backups}=fixture();let store=new Store(data,{backups});
  try{
    const group=store.saveCatalog({id:null,kind:'group',name:'报表工作线'});store.saveDraft('capture',{text:'独立任务草稿',pending:[]});
    store.saveLinkDraft({target:'尚未输入完的地址',groupIds:[group.id]});store.close();store=new Store(data,{backups});
    assert.equal(store.linkDraft()?.target,'尚未输入完的地址');assert.throws(()=>store.createLink({target:'尚未输入完的地址'}));assert.equal(store.drafts().capture.text,'独立任务草稿');assert.ok(store.linkDraft());
    const target='https://example.com/report';store.saveLinkDraft({target});assert.deepEqual(store.linkDraft()?.groupIds,[group.id]);
    store.db.exec("CREATE TEMP TRIGGER fail_link BEFORE INSERT ON catalog_entries WHEN NEW.kind='resource' BEGIN SELECT RAISE(FAIL,'样例链接写入失败'); END");assert.throws(()=>store.createLink({target}),/样例链接/);assert.ok(store.linkDraft());store.db.exec('DROP TRIGGER fail_link');
    const saved=store.createLink({target});assert.equal(saved.name,'example.com/report');assert.deepEqual(saved.groupIds,[group.id]);assert.equal(store.linkDraft(),null);assert.equal(store.drafts().capture.text,'独立任务草稿');assert.equal(store.items().length,0);
    assert.equal(store.createLink({target}).name,'example.com/report (2)');
    store.saveLinkDraft({target});store.db.exec("CREATE TEMP TRIGGER change_link_draft AFTER INSERT ON catalog_entries WHEN NEW.kind='resource' BEGIN UPDATE link_drafts SET body='{\"target\":\"https://example.com/changed\",\"groupIds\":[]}' WHERE key='link'; END");
    assert.throws(()=>store.createLink({target}),/草稿已变化/);assert.equal(store.linkDraft()?.target,target);assert.equal(store.catalog('resource').length,2,'草稿发生变化时资料插入也应回滚');store.db.exec('DROP TRIGGER change_link_draft');store.saveLinkDraft(null);
    store.saveLinkDraft({target:'https://example.com/new'});assert.throws(()=>store.createLink({target:'https://example.com/other'}),/草稿已变化/);assert.equal(store.linkDraft()?.target,'https://example.com/new');store.saveLinkDraft(null);assert.equal(store.linkDraft(),null);
  }finally{store.close();rmSync(root,{recursive:true,force:true});}
});

test('双入口链接草稿使用原子CAS，过期写入和清除均不能覆盖另一入口，串行接续可保存',()=>{
  const {root,data,backups}=fixture(),store=new Store(data,{backups});
  try{
    const a=store.saveCatalog({id:null,kind:'group',name:'甲组'}),b=store.saveCatalog({id:null,kind:'group',name:'乙组'});
    store.saveLinkDraft({target:'https://example.com/original',groupIds:[a.id,b.id]},null);
    const firstSnapshot=store.linkDraft()!,secondSnapshot=structuredClone(firstSnapshot),firstInput={target:'https://example.com/from-first',groupIds:[a.id,b.id]},secondInput={target:'https://example.com/from-second',groupIds:[b.id]};
    store.saveLinkDraft(firstInput,{...firstSnapshot,groupIds:[b.id,a.id]});assert.deepEqual(store.linkDraft(),firstInput,'组序不同仍是同一预期草稿');
    assert.throws(()=>store.saveLinkDraft(secondInput,secondSnapshot),/另一入口变化/);assert.deepEqual(store.linkDraft(),firstInput);assert.equal(secondInput.target,'https://example.com/from-second','失败不能修改调用方尚未提交的内容');
    assert.throws(()=>store.saveLinkDraft(null,secondSnapshot),/另一入口变化/);assert.deepEqual(store.linkDraft(),firstInput);
    assert.throws(()=>store.saveLinkDraft({target:'',groupIds:[]},secondSnapshot),/另一入口变化/);assert.deepEqual(store.linkDraft(),firstInput,'空输入触发删除也必须先核对预期值');
    assert.throws(()=>store.saveLinkDraft(secondInput,null),/另一入口变化/);assert.deepEqual(store.linkDraft(),firstInput,'新入口不能假定草稿不存在');
    store.saveLinkDraft(secondInput,store.linkDraft());assert.deepEqual(store.linkDraft(),secondInput);store.saveLinkDraft(null,store.linkDraft());assert.equal(store.linkDraft(),null);
    assert.throws(()=>store.saveLinkDraft(firstInput,secondSnapshot),/另一入口变化/);assert.equal(store.linkDraft(),null,'已被另一入口提交消费的旧草稿不能重新复活');
    store.saveLinkDraft({target:'https://example.com/new'},null);assert.equal(store.linkDraft()?.target,'https://example.com/new');
  }finally{store.close();rmSync(root,{recursive:true,force:true});}
});

test('链接草稿的空值CAS与实际删除一致，空地址有分组仍保留，省略分组只继承而不放宽预期',()=>{
  const {root,data,backups}=fixture(),store=new Store(data,{backups});
  try{
    const empty={target:'',groupIds:[]};store.saveLinkDraft(empty,null);assert.equal(store.linkDraft(),null);
    const first={target:'https://example.com/first',groupIds:[]};store.saveLinkDraft(first,empty);assert.deepEqual(store.linkDraft(),first);
    store.saveLinkDraft({target:'   ',groupIds:[]},first);assert.equal(store.linkDraft(),null);store.saveLinkDraft({target:'https://example.com/after-spaces'},{target:'   '});assert.equal(store.linkDraft()?.target,'https://example.com/after-spaces');store.saveLinkDraft(null,store.linkDraft());
    const group=store.saveCatalog({id:null,kind:'group',name:'只有分组的草稿'}),grouped={target:'',groupIds:[group.id]};store.saveLinkDraft(grouped,null);assert.deepEqual(store.linkDraft(),grouped);
    assert.throws(()=>store.saveLinkDraft({target:'不能覆盖有分组的草稿'},empty),/另一入口变化/);assert.deepEqual(store.linkDraft(),grouped);
    store.saveLinkDraft({target:'https://example.com/grouped'},grouped);assert.deepEqual(store.linkDraft(),{target:'https://example.com/grouped',groupIds:[group.id]},'省略分组必须继承既有关系');
    assert.throws(()=>store.saveLinkDraft(null,{target:'https://example.com/grouped'}),/另一入口变化/,'预期未带真实分组时不能误删');
    store.saveLinkDraft({target:'https://example.com/continued'},store.linkDraft());assert.deepEqual(store.linkDraft()?.groupIds,[group.id]);
  }finally{store.close();rmSync(root,{recursive:true,force:true});}
});

test('自定义链接名称和多分组随草稿重开保留，保存时冲突和失败不会消费，名称可检索',()=>{
  const {root,data,backups}=fixture();let store=new Store(data,{backups});
  try{
    const a=store.saveCatalog({id:null,kind:'group',name:'链接甲组'}),b=store.saveCatalog({id:null,kind:'group',name:'链接乙组'}),target='https://example.com/report#part';
    store.saveLinkDraft({target:'',name:'每周报表',groupIds:[a.id,b.id]},null);
    store.saveLinkDraft({target},store.linkDraft());store.close();store=new Store(data,{backups});
    const snapshot=store.linkDraft()!;assert.equal(snapshot.name,'每周报表');assert.deepEqual(snapshot.groupIds,[a.id,b.id]);
    store.saveLinkDraft({...snapshot,name:'项目报表'},snapshot);
    assert.throws(()=>store.saveLinkDraft(null,snapshot),/另一入口变化/);
    assert.throws(()=>store.createLink({...snapshot}),/草稿已变化/);assert.equal(store.catalog('resource').length,0);
    store.db.exec("CREATE TEMP TRIGGER fail_named_link BEFORE INSERT ON resource_groups BEGIN SELECT RAISE(FAIL,'样例归组失败'); END");
    assert.throws(()=>store.createLink(store.linkDraft()!),/样例归组失败/);assert.equal(store.linkDraft()?.name,'项目报表');assert.equal(store.catalog('resource').length,0);store.db.exec('DROP TRIGGER fail_named_link');
    const saved=store.createLink(store.linkDraft()!);assert.equal(saved.name,'项目报表');assert.equal(saved.target,target);assert.deepEqual(saved.groupIds,[a.id,b.id]);assert.equal(store.linkDraft(),null);
    assert.equal(store.lookup({query:'项目报表',scope:'links'})[0].kind,'link');assert.equal(store.lookup({groupIds:[b.id],scope:'links'}).length,1);
    assert.equal(store.createLink({target,name:'项目报表'}).name,'项目报表 (2)');
    assert.equal(store.createLink({target,name:'  '}).name,'example.com/report');
  }finally{store.close();rmSync(root,{recursive:true,force:true});}
});

test('只有链接名称的草稿不会被当空值删除，名称清空及边界校验与CAS一致',()=>{
  const {root,data,backups}=fixture(),store=new Store(data,{backups});
  try{
    const named={target:'',name:'先记下名称',groupIds:[]};store.saveLinkDraft(named,null);assert.deepEqual(store.linkDraft(),named);
    assert.throws(()=>store.saveLinkDraft(null,{target:'',groupIds:[]}),/另一入口变化/);assert.deepEqual(store.linkDraft(),named);
    assert.throws(()=>store.saveLinkDraft({target:'',name:'x'.repeat(201)},named),/名称/);assert.deepEqual(store.linkDraft(),named);
    assert.throws(()=>store.createLink({target:'https://example.com',name:123 as unknown as string}),/名称/);
    store.saveLinkDraft({target:'',name:'',groupIds:[]},named);assert.equal(store.linkDraft(),null);
    store.saveLinkDraft({target:'',name:'   '},null);assert.equal(store.linkDraft(),null);
  }finally{store.close();rmSync(root,{recursive:true,force:true});}
});

test('断点现场、独立历史和清草稿同一事务，冲突失败保留；不冒充实际进展',()=>{
  const {root,data,backups}=fixture(),store=new Store(data,{backups});
  try{
    let item=store.save({...fresh,recurrence:{kind:'weekly',every:1},extra:{version:1,fields:{unknown:{keep:true}}}},[]);item=store.addNote(item.id,'已完成第一步','progress',[]);
    const before=store.get(item.id),key='checkpoint:'+item.id;store.saveDraft(key,{text:'停在第二步',pending:[],nextStep:'下一步核对',itemId:item.id,expectedUpdatedAt:item.updatedAt,extra:{version:1,fields:{unknownNote:'保留'}}});
    store.db.exec("CREATE TEMP TRIGGER fail_checkpoint BEFORE INSERT ON notes WHEN NEW.kind='checkpoint' BEGIN SELECT RAISE(FAIL,'样例断点写入失败'); END");
    assert.throws(()=>store.checkpoint({id:item.id,expectedUpdatedAt:item.updatedAt,text:'停在第二步',nextStep:'下一步核对',draftKey:key}),/样例断点/);assert.deepEqual(store.get(item.id),before);assert.ok(store.drafts()[key]);store.db.exec('DROP TRIGGER fail_checkpoint');
    assert.throws(()=>store.checkpoint({id:item.id,expectedUpdatedAt:'stale',text:'停在第二步',draftKey:key}),/发生变化/);assert.ok(store.drafts()[key]);
    item=store.checkpoint({id:item.id,expectedUpdatedAt:item.updatedAt,text:' 停在第二步 ',nextStep:'下一步核对'});
    assert.equal(item.resumeNote,'停在第二步');assert.equal(item.nextStep,'下一步核对');assert.equal(item.lastProgressAt,before.lastProgressAt);assert.equal(item.reminder,before.reminder);assert.deepEqual(item.recurrence,before.recurrence);assert.deepEqual(item.extra,before.extra);assert.equal(item.state,before.state);
    const history=item.notes.at(-1)!;assert.equal(history.kind,'checkpoint');assert.equal(history.text,'停在第二步');assert.equal(history.extra?.fields.unknownNote,'保留');assert.equal(history.extra?.fields.nextStep,'下一步核对');assert.equal(store.drafts()[key],undefined);
    const suggestions=store.suggestions();assert.equal(suggestions[0].context?.source,'checkpoint');assert.equal(suggestions[0].context?.createdAt,history.createdAt);
    const staged=store.stage({name:'未提交资料.txt',bytes:Buffer.from('断点未提交样例')});store.saveDraft(key,{text:'带附件的草稿',pending:[staged],extra:{version:1,fields:{futureAttachment:true}}});
    assert.throws(()=>store.checkpoint({id:item.id,expectedUpdatedAt:item.updatedAt,text:'不能清除待存资料'}),/包含附件/);assert.equal(store.drafts()[key].pending[0].token,staged.token);assert.equal(store.drafts()[key].extra?.fields.futureAttachment,true);assert.equal(readFileSync((store.materialsFor([staged.token])[0] as {source:string}).source,'utf8'),'断点未提交样例');assert.deepEqual(store.get(item.id),item);
  }finally{store.close();rmSync(root,{recursive:true,force:true});}
});

test('本地建议最多三件，日期/紧急/近期推进/重要/其他分层稳定，未来提醒不排除可推进任务',()=>{
  const {root,data,backups}=fixture(),store=new Store(data,{backups});
  try{
    const base=store.save({...fresh,quadrant:null},[]),now=Date.parse('2026-10-19T02:00:00.000Z'),day=86400000;
    const make=(id:string,values:Partial<Item>={}):Item=>({...base,id,...values});
    const urgent=make('urgent',{quadrant:2}),important=make('important',{quadrant:1}),progress=make('progress',{lastProgressAt:new Date(now-day).toISOString()}),recent=make('recent',{lastProgressAt:new Date(now-1000).toISOString()});
    assert.deepEqual(localSuggestions([important,progress,urgent,recent],now).map(row=>row.item.id),['urgent','recent','progress']);
    const due=make('due',{reminder:new Date(now-1000).toISOString()}),earlier=make('earlier',{state:'waiting',reminder:new Date(now-day).toISOString()}),deadline=make('deadline',{deadline:new Date(now+2*day).toISOString()});
    assert.deepEqual(localSuggestions([urgent,deadline,due,earlier],now).map(row=>row.item.id),['earlier','due','deadline']);
    assert.deepEqual(localSuggestions([make('paused',{state:'paused'}),make('done',{state:'done'}),make('waiting',{state:'waiting'}),urgent],now).map(row=>row.item.id),['urgent']);
    assert.deepEqual(localSuggestions([make('first'),make('second'),make('third'),make('fourth')],now).map(row=>row.item.id),['first','second','third']);
    const old=make('old',{resumeNote:'旧版保存现场',notes:[]});assert.deepEqual(localSuggestions([old],now)[0].context,{text:'旧版保存现场',source:'saved',createdAt:null});
    const progressTime=new Date(now-1000).toISOString(),checkpointTime=new Date(now-day).toISOString(),withHistory=make('history',{resumeNote:'旧断点',notes:[{id:'a',kind:'checkpoint',text:'旧断点',createdAt:checkpointTime},{id:'b',kind:'progress',text:'随后完成了一步',createdAt:progressTime}]});
    assert.deepEqual(localSuggestions([withHistory],now)[0].context,{text:'随后完成了一步',source:'progress',createdAt:progressTime});
    const group=store.saveCatalog({id:null,kind:'group',name:'筛选工作线'}),person=store.saveCatalog({id:null,kind:'person',name:'小张'}),filtered=store.save({...fresh,groupIds:[group.id],personIds:[person.id]},[]);
    assert.deepEqual(store.suggestions({groupIds:[group.id],personIds:[person.id]}).map(row=>row.item.id),[filtered.id]);
  }finally{store.close();rmSync(root,{recursive:true,force:true});}
});

test('schema6接续只新增结构，原周期、关系、历史、未知扩展与文件保留，schema7资料草稿可完整备份',()=>{
  const {root,data,backups}=fixture();let store=new Store(data,{backups});
  try{
    const group=store.saveCatalog({id:null,kind:'group',name:'旧工作线'}),link=store.saveCatalog({id:null,kind:'resource',name:'旧资料',target:'https://example.com/old'});
    let item=store.save({...fresh,groupIds:[group.id],resourceIds:[link.id],recurrence:{kind:'monthly',every:1},extra:{version:1,fields:{future:[1,'保留']}}},[{name:'old.txt',bytes:Buffer.from('旧附件样例')}]);item=store.addNote(item.id,'旧日志','custom',[]);store.saveDraft('capture',{text:'旧草稿',pending:[],extra:{version:1,fields:{futureDraft:true}}});store.close();
    const db=new DatabaseSync(join(data,'recall.sqlite'));db.exec('DROP TABLE resource_groups; DROP TABLE link_drafts; PRAGMA user_version=6');const original=db.prepare('SELECT * FROM items').get();db.close();
    store=new Store(data,{backups});assert.equal(SCHEMA_VERSION,7);assert.deepEqual(store.db.prepare('SELECT * FROM items').get(),original);assert.deepEqual(store.get(item.id).groupIds,[group.id]);assert.deepEqual(store.get(item.id).resourceIds,[link.id]);assert.deepEqual(store.get(item.id).recurrence,item.recurrence);assert.equal(store.get(item.id).notes[0].kind,'custom');assert.deepEqual(store.catalog('resource')[0].groupIds,[],'不能猜测旧资料分组');
    const archives=readdirSync(backups);assert.equal(archives.length,1);const oldBackup=inspectBackup(join(backups,archives[0]));assert.equal(oldBackup.schema,6);
    store.saveLinkDraft({target:'https://example.com/draft',groupIds:[group.id]});let resource=store.catalog('resource')[0];resource=store.saveCatalog({...resource,groupIds:[group.id],expectedUpdatedAt:resource.updatedAt});
    const snapshot=join(root,'snapshot');snapshotData(data,snapshot);const manifest=inspectBackup(snapshot,7);assert.equal(manifest.counts.resource_groups,1);assert.equal(manifest.counts.link_drafts,1);assert.equal(manifest.signature,databaseInfo(data).signature);assert.equal(readFileSync(store.attachmentPath(item.id,item.attachments[0].id).path,'utf8'),'旧附件样例');
    assert.deepEqual(inspectBackup(join(backups,archives[0])),oldBackup,'后续编辑与新备份不能修改升级前原件');
  }finally{store.close();rmSync(root,{recursive:true,force:true});}
});

test('建议和关键字查找不先截取1000条而漏掉旧的重要事项',()=>{
  const {root,data,backups}=fixture(),store=new Store(data,{backups});
  try{
    store.db.exec('BEGIN IMMEDIATE');const insert=store.db.prepare('INSERT INTO items(id,text,quadrant,reminder,deadline,createdAt,updatedAt) VALUES(?,?,?,?,?,?,?)');
    insert.run('older-important','唯一的旧关键任务',1,null,'2000-01-01T00:00:00.000Z','2000-01-01T00:00:00.000Z','2000-01-01T00:00:00.000Z');
    for(let index=0;index<1005;index++)insert.run('recent-'+index,'较新的普通样例 '+index,null,null,null,'2026-10-19T00:00:00.000Z','2026-10-19T00:00:00.000Z');store.db.exec('COMMIT');
    assert.equal(store.suggestions()[0].item.id,'older-important');const result=store.lookup({query:'唯一的旧关键',scope:'tasks',limit:1});assert.equal(result.length,1);assert.equal(result[0].kind==='task'&&result[0].item.id,'older-important');
  }finally{store.close();rmSync(root,{recursive:true,force:true});}
});
