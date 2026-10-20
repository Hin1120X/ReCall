import { DatabaseSync } from 'node:sqlite';
import { randomUUID } from 'node:crypto';
import { mkdirSync, copyFileSync, writeFileSync, rmSync, existsSync, readFileSync, readdirSync } from 'node:fs';
import { join, basename, extname, resolve, relative } from 'node:path';
import type { Item, SaveInput, Analysis, AnalysisRequest, NoteKind, Role, TaskState, DraftValue, Pending, Extra, CatalogEntry, CatalogInput, CatalogKind, Relations, TaskFilter, LookupInput, SearchResult, SuggestionFilter, LinkDraft, CheckpointInput, CreateLinkInput } from './shared.ts';
import { referenceTarget } from './references.ts';
import { snapshotData } from './data.ts';
import {matchesSearch} from './search.ts';
import {recurrenceRule,nextOccurrence} from './recurrence.ts';
import {localSuggestions} from './workbench.ts';
import {linkDraftKey} from './shared.ts';

export type Material = { name: string; source: string } | { name: string; bytes: Uint8Array };
export const SCHEMA_VERSION=7;
function extraValue(value:Extra|undefined,previous:Extra={version:1,fields:{}}):string {
  if(value===undefined)return JSON.stringify(previous);
  if(!value||value.version!==1||!value.fields||typeof value.fields!=='object'||Array.isArray(value.fields))throw new Error('扩展属性格式无效');
  const encoded=JSON.stringify({version:previous.version,fields:{...previous.fields,...value.fields}},(_key,field)=>{if(typeof field==='number'&&!Number.isFinite(field)||['undefined','function','symbol','bigint'].includes(typeof field))throw new Error('扩展属性只接受有效 JSON 值');return field;});
  if(encoded.length>100000)throw new Error('扩展属性过长');
  return encoded;
}
const states:TaskState[]=['ready','active','paused','waiting','done'];
const relationKinds={groupIds:'group',personIds:'person',resourceIds:'resource'} as const;
const relationKeys=Object.keys(relationKinds) as (keyof Relations)[];
const catalogKinds:CatalogKind[]=['resource','group','person'];
export class Store {
  private closed=false;
  readonly db: DatabaseSync;
  readonly directory: string;
  readonly backups:string;
  constructor(directory: string,options:{backups?:string;version?:string}={}) {
    this.directory = directory;
    this.backups=options.backups??directory+'-backups';
    const file=join(directory,'recall.sqlite');
    if(!existsSync(file)&&existsSync(directory)&&readdirSync(directory).some(name=>name!=='chromium'))throw new Error('数据目录已有文件但数据库缺失，已停止启动，不能自动创建空库覆盖使用');
    let version=0;
    if(existsSync(file)) {
      const probe=new DatabaseSync(file,{readOnly:true});
      try{version=Number(probe.prepare('PRAGMA user_version').get()!.user_version);}finally{probe.close();}
      if(version>SCHEMA_VERSION)throw new Error(`数据库版本 ${version} 比本程序支持的 ${SCHEMA_VERSION} 更新。请使用新版程序，数据未修改。`);
      const releaseFile=join(directory,'release-state.json');
      const release=existsSync(releaseFile)?JSON.parse(readFileSync(releaseFile,'utf8')):{version:''};
      if(version<SCHEMA_VERSION||(options.version&&release.version!==options.version)) {
        mkdirSync(this.backups,{recursive:true});
        snapshotData(directory,join(this.backups,`before-v${version}-${Date.now()}-${randomUUID().slice(0,8)}`));
      }
    }
    mkdirSync(directory,{recursive:true});
    this.db = new DatabaseSync(file,{timeout:5000});
    try {
    this.db.exec('PRAGMA journal_mode=WAL; PRAGMA synchronous=FULL; PRAGMA foreign_keys=ON;');
    if(version<SCHEMA_VERSION){
    this.db.exec('BEGIN IMMEDIATE');
    try{
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS items (
        id TEXT PRIMARY KEY, text TEXT NOT NULL, quadrant INTEGER,
        reminder TEXT, deadline TEXT, folder TEXT, createdAt TEXT NOT NULL,
        updatedAt TEXT NOT NULL, lastProgressAt TEXT
      );
      CREATE TABLE IF NOT EXISTS attachments (
        id TEXT PRIMARY KEY, itemId TEXT NOT NULL REFERENCES items(id), name TEXT NOT NULL, path TEXT NOT NULL
      );
      CREATE TABLE IF NOT EXISTS analyses (
        id TEXT PRIMARY KEY, itemId TEXT REFERENCES items(id), kind TEXT NOT NULL,
        state TEXT NOT NULL, output TEXT NOT NULL, error TEXT NOT NULL,
        model TEXT NOT NULL, version TEXT NOT NULL, fingerprint TEXT NOT NULL,
        createdAt TEXT NOT NULL, finishedAt TEXT
      );
      CREATE TABLE IF NOT EXISTS notes(id TEXT PRIMARY KEY,itemId TEXT NOT NULL REFERENCES items(id),kind TEXT NOT NULL,text TEXT NOT NULL,createdAt TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS refs(id TEXT PRIMARY KEY,itemId TEXT NOT NULL REFERENCES items(id),name TEXT NOT NULL,target TEXT NOT NULL,kind TEXT NOT NULL,role TEXT NOT NULL,createdAt TEXT NOT NULL);
      `);
    if (!(this.db.prepare('PRAGMA table_info(attachments)').all() as {name:string}[]).some(col=>col.name==='role')) this.db.exec("ALTER TABLE attachments ADD COLUMN role TEXT NOT NULL DEFAULT 'input'");
    const columns=new Set((this.db.prepare('PRAGMA table_info(items)').all() as {name:string}[]).map(col=>col.name));
    for(const [name,definition] of Object.entries({state:"TEXT NOT NULL DEFAULT 'ready'",inbox:'INTEGER NOT NULL DEFAULT 1',nextStep:"TEXT NOT NULL DEFAULT ''",resumeNote:"TEXT NOT NULL DEFAULT ''",waitingFor:"TEXT NOT NULL DEFAULT ''",completedAt:'TEXT'}))if(!columns.has(name))this.db.exec(`ALTER TABLE items ADD COLUMN ${name} ${definition}`);
    if(!columns.has('inbox'))this.db.exec('UPDATE items SET inbox=0 WHERE quadrant IS NOT NULL');
    if(!columns.has('extra'))this.db.exec(`ALTER TABLE items ADD COLUMN extra TEXT NOT NULL DEFAULT '{"version":1,"fields":{}}'`);
    if(!(this.db.prepare('PRAGMA table_info(notes)').all() as {name:string}[]).some(col=>col.name==='extra'))this.db.exec(`ALTER TABLE notes ADD COLUMN extra TEXT NOT NULL DEFAULT '{"version":1,"fields":{}}'`);
    if(!(this.db.prepare('PRAGMA table_info(attachments)').all() as {name:string}[]).some(col=>col.name==='noteId'))this.db.exec('ALTER TABLE attachments ADD COLUMN noteId TEXT REFERENCES notes(id)');
    this.db.exec(`CREATE TABLE IF NOT EXISTS reminders(id TEXT PRIMARY KEY,itemId TEXT NOT NULL REFERENCES items(id),kind TEXT NOT NULL,dueAt TEXT NOT NULL,scheduledAt TEXT NOT NULL,state TEXT NOT NULL,sentAt TEXT,UNIQUE(itemId,kind,dueAt));`);
    this.db.exec(`CREATE TABLE IF NOT EXISTS drafts(key TEXT PRIMARY KEY,body TEXT NOT NULL,updatedAt TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS pending_files(token TEXT PRIMARY KEY,name TEXT NOT NULL,path TEXT NOT NULL);`);
    for(const [name,definition] of Object.entries({recurrence:'TEXT',seriesId:'TEXT',previousOccurrenceId:'TEXT REFERENCES items(id)'}))if(!columns.has(name))this.db.exec(`ALTER TABLE items ADD COLUMN ${name} ${definition}`);
    this.db.exec(`CREATE UNIQUE INDEX IF NOT EXISTS items_previous_occurrence ON items(previousOccurrenceId) WHERE previousOccurrenceId IS NOT NULL;
      CREATE TABLE IF NOT EXISTS catalog_entries(id TEXT PRIMARY KEY,kind TEXT NOT NULL,name TEXT NOT NULL,target TEXT NOT NULL,resourceKind TEXT,aliases TEXT NOT NULL,pinned INTEGER NOT NULL DEFAULT 0,archived INTEGER NOT NULL DEFAULT 0,createdAt TEXT NOT NULL,updatedAt TEXT NOT NULL,lastUsedAt TEXT);
      CREATE INDEX IF NOT EXISTS catalog_kind ON catalog_entries(kind,archived);
      CREATE TABLE IF NOT EXISTS item_catalog(itemId TEXT NOT NULL REFERENCES items(id),catalogId TEXT NOT NULL REFERENCES catalog_entries(id),PRIMARY KEY(itemId,catalogId));
      CREATE INDEX IF NOT EXISTS catalog_tasks ON item_catalog(catalogId,itemId);
      CREATE TABLE IF NOT EXISTS task_usage(itemId TEXT PRIMARY KEY REFERENCES items(id),lastOpenedAt TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS resource_groups(resourceId TEXT NOT NULL REFERENCES catalog_entries(id),groupId TEXT NOT NULL REFERENCES catalog_entries(id),PRIMARY KEY(resourceId,groupId));
      CREATE INDEX IF NOT EXISTS grouped_resources ON resource_groups(groupId,resourceId);
      CREATE TABLE IF NOT EXISTS link_drafts(key TEXT PRIMARY KEY CHECK(key='link'),body TEXT NOT NULL,updatedAt TEXT NOT NULL);`);
    for(const row of this.db.prepare('SELECT id,path FROM attachments').all() as {id:string;path:string}[]) {
      const path=version<4?join('attachments',basename(row.path)):row.path,target=resolve(directory,path);
      if(!target.startsWith(resolve(directory,'attachments')+'\\')||!existsSync(target))throw new Error('已有附件缺失或路径无效，升级已停止，原库与备份均保留');
      if(path!==row.path)this.db.prepare('UPDATE attachments SET path=? WHERE id=?').run(path,row.id);
    }
    if(this.db.prepare('PRAGMA integrity_check').get()?.integrity_check!=='ok'||this.db.prepare('PRAGMA foreign_key_check').all().length)throw new Error('升级完整性检查失败');
    this.db.exec(`PRAGMA user_version=${SCHEMA_VERSION}; COMMIT`);
    }catch(error){this.db.exec('ROLLBACK');throw error;}
    }
    mkdirSync(join(directory,'attachments'),{recursive:true});mkdirSync(join(directory,'draft-files'),{recursive:true});
    this.db.prepare("UPDATE analyses SET state='failed',error='上次分析因应用退出而中断，请重新分析',finishedAt=? WHERE state='running'").run(new Date().toISOString());
    const drafts=this.drafts(),claimed=new Set(Object.values(drafts).flatMap(value=>value.pending.map(file=>file.token)));
    const orphaned=(this.db.prepare('SELECT token,name FROM pending_files').all() as Pending[]).filter(file=>!claimed.has(file.token));
    if(orphaned.length)this.saveDraft('capture',{...(drafts.capture??{text:''}),pending:[...(drafts.capture?.pending??[]),...orphaned]});
    if(options.version)writeFileSync(join(directory,'release-state.json'),JSON.stringify({version:options.version,schema:SCHEMA_VERSION},null,2));
    }catch(error){this.db.close();throw error;}
  }
  get(id: string): Item {
    if(typeof id!=='string'||!id||id.length>100)throw new Error('事项编号无效');
    const item = this.db.prepare('SELECT * FROM items WHERE id=?').get(id) as Omit<Item, 'attachments'> | undefined;
    if (!item) throw new Error('事项不存在，请重新查找');
    const relations=this.db.prepare('SELECT c.id,c.kind FROM item_catalog r JOIN catalog_entries c ON c.id=r.catalogId WHERE r.itemId=? ORDER BY r.rowid').all(id) as {id:string;kind:CatalogKind}[];
    return { ...item, ...Object.fromEntries(relationKeys.map(key=>[key,relations.filter(row=>row.kind===relationKinds[key]).map(row=>row.id)])),recurrence:item.recurrence?JSON.parse(item.recurrence as unknown as string):null,extra:JSON.parse(item.extra as unknown as string), inbox:!!item.inbox, attachments: this.db.prepare('SELECT id,name,role,noteId FROM attachments WHERE itemId=? ORDER BY rowid').all(id) as Item['attachments'],notes:(this.db.prepare('SELECT id,kind,text,createdAt,extra FROM notes WHERE itemId=? ORDER BY createdAt,rowid').all(id) as unknown as (Omit<Item['notes'][number],'extra'>&{extra:string})[]).map(note=>({...note,extra:JSON.parse(note.extra)})),references:this.db.prepare('SELECT id,name,target,kind,role,createdAt FROM refs WHERE itemId=? ORDER BY rowid').all(id) as Item['references'] };
  }
  search(query: string): Item[] {
    return this.queryTasks({query,status:'all',limit:50});
  }
  catalog(kind?:CatalogKind,query='',includeArchived=false):CatalogEntry[] {
    if(kind!==undefined&&!catalogKinds.includes(kind)||typeof query!=='string'||query.length>10000||typeof includeArchived!=='boolean')throw new Error('常用资料检索条件无效');
    return (this.db.prepare('SELECT * FROM catalog_entries WHERE (? IS NULL OR kind=?) AND (? OR archived=0) ORDER BY pinned DESC,lastUsedAt DESC,updatedAt DESC,rowid DESC').all(kind??null,kind??null,Number(includeArchived)) as unknown as (Omit<CatalogEntry,'aliases'|'pinned'|'archived'>&{aliases:string;pinned:number;archived:number})[])
      .map(row=>({...row,aliases:JSON.parse(row.aliases) as string[],pinned:!!row.pinned,archived:!!row.archived,...(row.kind==='resource'?{groupIds:(this.db.prepare('SELECT groupId FROM resource_groups WHERE resourceId=? ORDER BY rowid').all(row.id) as {groupId:string}[]).map(group=>group.groupId)}:{})}))
      .filter(row=>matchesSearch([row.name,row.target,...row.aliases],query));
  }
  saveCatalog(input:CatalogInput):CatalogEntry {
    return this.storeCatalog(input);
  }
  private storeCatalog(input:CatalogInput,consumeLinkDraft?:{body:string;updatedAt:string}|null):CatalogEntry {
    if(!input||!catalogKinds.includes(input.kind)||typeof input.name!=='string'||!input.name.trim()||input.name.length>200||input.id!==null&&(typeof input.id!=='string'||!input.id||input.id.length>100))throw new Error('资料、分组或相关人信息无效');
    const existing=input.id?this.catalog(undefined,'',true).find(row=>row.id===input.id):null;
    if(input.id&&!existing)throw new Error('资料、分组或相关人不存在');
    if(existing&&(existing.kind!==input.kind||input.expectedUpdatedAt!==existing.updatedAt))throw new Error('条目已发生变化，请重新打开后保存');
    for(const flag of [input.pinned,input.archived])if(flag!==undefined&&typeof flag!=='boolean')throw new Error('条目状态无效');
    let name=input.name.trim();
    if(consumeLinkDraft===undefined&&this.catalog(input.kind,'',true).some(row=>row.id!==input.id&&row.name.toLowerCase()===name.toLowerCase()))throw new Error('已存在同名条目，请选择已有条目（也可查看归档）');
    const aliases=input.aliases!==undefined?input.aliases:existing?.aliases??[];
    if(!Array.isArray(aliases)||aliases.length>20||aliases.some(alias=>typeof alias!=='string'||!alias.trim()||alias.length>100))throw new Error('别名无效，一项最多20个别名');
    const cleanedAliases=[...new Set(aliases.map(alias=>alias.trim()))];
    const groupIds=this.checkedRelations({groupIds:input.groupIds},{groupIds:existing?.groupIds}).groupIds;
    if(input.kind!=='resource'&&groupIds.length)throw new Error('只有资料可以关联工作分组');
    let target=existing?.target??'',resourceKind=existing?.resourceKind??null;
    if(input.kind==='resource'){
      if(!existing||input.target!==undefined&&input.target!==existing.target){const ref=referenceTarget(input.target as string);target=ref.target;resourceKind=ref.kind;}
    }else if(input.target!==undefined&&input.target!=='')throw new Error('分组或相关人不接受资料地址');
    const now=new Date(Math.max(Date.now(),existing?Date.parse(existing.updatedAt)+1:0)).toISOString(),id=existing?.id??randomUUID();
    this.db.exec('BEGIN IMMEDIATE');
    try{
      if(consumeLinkDraft!==undefined){
        const current=this.db.prepare("SELECT body,updatedAt FROM link_drafts WHERE key='link'").get() as {body:string;updatedAt:string}|undefined;
        if(consumeLinkDraft===null?!!current:current?.body!==consumeLinkDraft.body||current?.updatedAt!==consumeLinkDraft.updatedAt)throw new Error('资料草稿已变化，请重新打开后保存');
        if((this.db.prepare("SELECT name FROM catalog_entries WHERE kind='resource'").all() as {name:string}[]).some(entry=>entry.name.toLowerCase()===name.toLowerCase()))throw new Error('已存在同名链接，请换个名称，或编辑已有链接');
      }
      if(existing){const changed=this.db.prepare('UPDATE catalog_entries SET name=?,target=?,resourceKind=?,aliases=?,pinned=?,archived=?,updatedAt=? WHERE id=? AND updatedAt=?').run(name,target,resourceKind,JSON.stringify(cleanedAliases),Number(input.pinned??existing.pinned),Number(input.archived??existing.archived),now,id,existing.updatedAt);if(changed.changes!==1)throw new Error('条目已发生变化，请重新打开后保存');}
      else this.db.prepare('INSERT INTO catalog_entries(id,kind,name,target,resourceKind,aliases,pinned,archived,createdAt,updatedAt,lastUsedAt) VALUES(?,?,?,?,?,?,?,?,?,?,NULL)').run(id,input.kind,name,target,resourceKind,JSON.stringify(cleanedAliases),Number(input.pinned??false),Number(input.archived??false),now,now);
      if(input.kind==='resource'){
        this.db.prepare('DELETE FROM resource_groups WHERE resourceId=?').run(id);
        for(const groupId of groupIds)this.db.prepare('INSERT INTO resource_groups(resourceId,groupId) VALUES(?,?)').run(id,groupId);
      }
      if(consumeLinkDraft){const consumed=this.db.prepare("DELETE FROM link_drafts WHERE key='link' AND body=? AND updatedAt=?").run(consumeLinkDraft.body,consumeLinkDraft.updatedAt);if(consumed.changes!==1)throw new Error('资料草稿已变化，请重新打开后保存');}
      this.db.exec('COMMIT');
    }catch(error){this.db.exec('ROLLBACK');throw error;}
    return this.catalog(undefined,'',true).find(row=>row.id===id)!;
  }
  linkDraft():LinkDraft|null {
    const row=this.db.prepare("SELECT body FROM link_drafts WHERE key='link'").get() as {body:string}|undefined;
    return row?JSON.parse(row.body):null;
  }
  saveLinkDraft(value:LinkDraft|null,expected?:LinkDraft|null){
    const normalized=(draft:LinkDraft|null)=>{
      if(draft===null)return null;
      if(!draft||typeof draft!=='object'||Array.isArray(draft)||typeof draft.target!=='string'||draft.target.length>32767||draft.groupIds!==undefined&&(!Array.isArray(draft.groupIds)||draft.groupIds.length>100||draft.groupIds.some(id=>typeof id!=='string'||!id||id.length>100)))throw new Error('资料草稿无效');
      if(draft.name!==undefined&&(typeof draft.name!=='string'||draft.name.length>200))throw new Error('链接名称最多200个字符');
      return linkDraftKey(draft);
    };
    normalized(value);const expectedBody=expected===undefined?undefined:normalized(expected);
    this.db.exec('BEGIN IMMEDIATE');
    try{
      const previous=this.linkDraft();
      if(expectedBody!==undefined&&normalized(previous)!==expectedBody)throw new Error('资料草稿已在另一入口变化，请重新读取后接续；原内容仍保留');
      if(value===null)this.db.prepare("DELETE FROM link_drafts WHERE key='link'").run();
      else{
        const groupIds=this.checkedRelations(value,previous??{}).groupIds;
        if(!linkDraftKey({...previous,...value,groupIds}))this.db.prepare("DELETE FROM link_drafts WHERE key='link'").run();
        else{
          const body=JSON.stringify({...previous,...value,groupIds});if(body.length>100000)throw new Error('资料草稿过长');
          this.db.prepare("INSERT INTO link_drafts(key,body,updatedAt) VALUES('link',?,?) ON CONFLICT(key) DO UPDATE SET body=excluded.body,updatedAt=excluded.updatedAt").run(body,new Date().toISOString());
        }
      }
      this.db.exec('COMMIT');
    }catch(error){this.db.exec('ROLLBACK');throw error;}
  }
  createLink(input:CreateLinkInput):CatalogEntry {
    if(!input||typeof input.target!=='string')throw new Error('请输入资料地址');
    if(input.name!==undefined&&(typeof input.name!=='string'||input.name.length>200))throw new Error('链接名称最多200个字符');
    const saved=this.db.prepare("SELECT body,updatedAt FROM link_drafts WHERE key='link'").get() as {body:string;updatedAt:string}|undefined,draft:LinkDraft|null=saved?JSON.parse(saved.body):null,groups=this.checkedRelations(input,draft??{}).groupIds;
    const name=input.name??draft?.name??'';
    if(!name.trim())throw new Error('请先为链接填写名称');
    const ref=referenceTarget(input.target);
    if(draft&&linkDraftKey({...draft,target:draft.target.trim()})!==linkDraftKey({target:input.target.trim(),name,groupIds:groups}))throw new Error('资料草稿已变化，请重新打开后保存');
    return this.storeCatalog({id:null,kind:'resource',name:name.trim(),target:ref.target,groupIds:groups},saved??null);
  }
  private checkedRelations(value:Relations,previous:Relations={}):Required<Relations> {
    return Object.fromEntries(relationKeys.map(key=>{
      const ids=value[key]!==undefined?value[key]:previous[key]??[];
      if(!Array.isArray(ids)||ids.length>100||new Set(ids).size!==ids.length||ids.some(id=>typeof id!=='string'||!id||id.length>100))throw new Error('关联标签无效、重复或超过100项');
      for(const id of ids)if(!this.db.prepare('SELECT id FROM catalog_entries WHERE id=? AND kind=?').get(id,relationKinds[key]))throw new Error('关联的分组、相关人或资料不存在，或类型不匹配');
      return [key,ids];
    })) as Required<Relations>;
  }
  private writeRelations(id:string,relations:Required<Relations>){
    this.db.prepare('DELETE FROM item_catalog WHERE itemId=?').run(id);
    for(const key of relationKeys)for(const catalogId of relations[key])this.db.prepare('INSERT INTO item_catalog(itemId,catalogId) VALUES(?,?)').run(id,catalogId);
  }
  queryTasks(filter:TaskFilter={}):Item[] {
    return this.queryTaskItems(filter);
  }
  private queryTaskItems(filter:TaskFilter={},includeGroupNames=true):Item[] {
    if(!filter||typeof filter!=='object'||Array.isArray(filter))throw new Error('事项检索条件无效');
    const {query='',status='open',limit=200,recent=false}=filter;
    if(typeof query!=='string'||query.length>10000||!['open','done','all'].includes(status)||!Number.isInteger(limit)||limit<1||limit>1000||typeof recent!=='boolean')throw new Error('事项检索条件无效');
    const relations=this.checkedRelations(filter),where:string[]=[],args:string[]=[];
    if(status!=='all'){where.push(status==='done'?"i.state='done'":"i.state<>'done'");}
    if(recent)where.push('u.itemId IS NOT NULL');
    for(const key of relationKeys)for(const id of relations[key]){where.push('EXISTS(SELECT 1 FROM item_catalog r WHERE r.itemId=i.id AND r.catalogId=?)');args.push(id);}
    const order=recent?'u.lastOpenedAt DESC,i.updatedAt DESC,i.rowid DESC':'i.updatedAt DESC,i.rowid DESC';
    const entries=this.catalog(undefined,'',true),catalog=new Map(entries.map(row=>[row.id,row]));
    const results:Item[]=[];
    for(const row of this.db.prepare(`SELECT i.id FROM items i LEFT JOIN task_usage u ON u.itemId=i.id ${where.length?'WHERE '+where.join(' AND '):''} ORDER BY ${order}`).iterate(...args)){
      const item=this.get(row.id as string);
      const linked=relationKeys.filter(key=>includeGroupNames||key!=='groupIds').flatMap(key=>(item[key]??[]).flatMap(id=>{const entry=catalog.get(id);return entry?[entry.name,entry.target,...entry.aliases]:[];}));
      if(matchesSearch([item.text,item.nextStep,item.resumeNote,item.waitingFor,...item.notes.map(note=>note.text),...item.attachments.map(file=>file.name),...item.references.flatMap(ref=>[ref.name,ref.target]),...linked],query))results.push(item);
      if(results.length===limit)break;
    }
    return results;
  }
  lookup(input:LookupInput={}):SearchResult[]{
    if(!input||typeof input!=='object'||Array.isArray(input))throw new Error('检索条件无效');
    const {query='',scope='all',limit=50}=input;
    if(typeof query!=='string'||query.length>10000||!['all','tasks','links'].includes(scope)||!Number.isInteger(limit)||limit<1||limit>1000)throw new Error('检索条件无效');
    const relations=this.checkedRelations({groupIds:input.groupIds,personIds:input.personIds});
    const tasks:SearchResult[]=scope==='links'?[]:this.queryTaskItems({query,status:'all',limit,...relations},false).map(item=>({kind:'task',item,match:matchesSearch([item.text,item.nextStep,item.resumeNote,item.waitingFor],query)?'事项':matchesSearch(item.notes.map(note=>note.text),query)?'记录':'关联资料'}));
    const links:SearchResult[]=scope==='tasks'||relations.personIds.length?[]:this.catalog('resource',query).filter(entry=>relations.groupIds.every(id=>entry.groupIds?.includes(id))).map(entry=>({kind:'link',entry,match:'链接'}));
    return [...tasks,...links].slice(0,limit);
  }
  suggestions(filter:SuggestionFilter={}){
    if(!filter||typeof filter!=='object'||Array.isArray(filter))throw new Error('推荐筛选条件无效');
    const relations=this.checkedRelations({groupIds:filter.groupIds,personIds:filter.personIds});
    return localSuggestions(this.items().filter(item=>relations.groupIds.every(id=>item.groupIds?.includes(id))&&relations.personIds.every(id=>item.personIds?.includes(id))));
  }
  touchTask(id:string){
    this.get(id);
    const previous=this.db.prepare('SELECT lastOpenedAt FROM task_usage WHERE itemId=?').get(id) as {lastOpenedAt:string}|undefined;
    const now=new Date(Math.max(Date.now(),previous?Date.parse(previous.lastOpenedAt)+1:0)).toISOString();
    this.db.prepare('INSERT INTO task_usage(itemId,lastOpenedAt) VALUES(?,?) ON CONFLICT(itemId) DO UPDATE SET lastOpenedAt=excluded.lastOpenedAt').run(id,now);
  }
  touchResource(id:string){
    const entry=this.catalog('resource','',true).find(row=>row.id===id);if(!entry)throw new Error('常用资料不存在');
    const now=new Date(Math.max(Date.now(),entry.lastUsedAt?Date.parse(entry.lastUsedAt)+1:0)).toISOString();
    this.db.prepare('UPDATE catalog_entries SET lastUsedAt=? WHERE id=?').run(now,id);
  }
  todos(): Item[] {
    return (this.db.prepare("SELECT id FROM items WHERE state<>'done' ORDER BY createdAt DESC, rowid DESC").all() as { id: string }[]).map(row => this.get(row.id));
  }
  items():Item[]{return (this.db.prepare('SELECT id FROM items ORDER BY createdAt DESC,rowid DESC').all() as {id:string}[]).map(row=>this.get(row.id));}
  startAnalysis(request: AnalysisRequest, model: string, fingerprint: string): Analysis {
    const row: Analysis = { ...request, id:randomUUID(), state:'running', output:'', error:'', model, version:'', fingerprint, createdAt:new Date().toISOString(), finishedAt:null };
    this.db.prepare('INSERT INTO analyses(id,itemId,kind,state,output,error,model,version,fingerprint,createdAt,finishedAt) VALUES(?,?,?,?,?,?,?,?,?,?,?)').run(row.id,row.itemId,row.kind,row.state,row.output,row.error,row.model,row.version,row.fingerprint,row.createdAt,row.finishedAt);
    return row;
  }
  finishAnalysis(id: string, output: string, version: string, error = '') {
    this.db.prepare('UPDATE analyses SET state=?,output=?,version=?,error=?,finishedAt=? WHERE id=?').run(error ? 'failed' : 'succeeded',output,version,error,new Date().toISOString(),id);
  }
  analyses(itemId: string | null): Analysis[] {
    return this.db.prepare('SELECT * FROM analyses WHERE itemId IS ? ORDER BY createdAt DESC,rowid DESC LIMIT 20').all(itemId) as Analysis[];
  }
  save(input: SaveInput, materials: Material[]): Item {
    if (!input || typeof input.text !== 'string' || input.text.length > 100000) throw new Error('记录内容无效或过长');
    if (input.id !== null && typeof input.id !== 'string') throw new Error('事项编号无效');
    if (input.expectedUpdatedAt !== null && typeof input.expectedUpdatedAt !== 'string') throw new Error('事项版本无效');
    if (input.quadrant !== null && (!Number.isInteger(input.quadrant) || input.quadrant < 0 || input.quadrant > 3)) throw new Error('象限无效');
    for (const date of [input.reminder, input.deadline]) {
      if (date !== null && (typeof date !== 'string' || !/Z$/.test(date) || !Number.isFinite(Date.parse(date)))) throw new Error('时间无效');
    }
    if (input.folder !== null && (typeof input.folder !== 'string' || input.folder.length > 32767)) throw new Error('文件夹无效');
    const existing = input.id ? this.get(input.id) : null;
    if (existing && existing.updatedAt !== input.expectedUpdatedAt) throw new Error('事项已发生变化，请返回查找后重新打开');
    const text = input.text.trim();
    if (!text && !materials.length && !existing?.attachments.length) throw new Error('请写下一件事，或加入附件');
    if (materials.length > 100) throw new Error('一次最多添加 100 个附件');
    const id = existing?.id ?? randomUUID();
    const now = new Date(Math.max(Date.now(), existing ? Date.parse(existing.updatedAt) + 1 : 0)).toISOString();
    const state=input.state??existing?.state??'ready',inbox=input.inbox??(input.quadrant!==null?false:existing?.inbox??true);
    const nextStep=input.nextStep??existing?.nextStep??'',resumeNote=input.resumeNote??existing?.resumeNote??'',waitingFor=input.waitingFor??existing?.waitingFor??'';
    if(!states.includes(state)||typeof inbox!=='boolean'||[nextStep,resumeNote,waitingFor].some(value=>typeof value!=='string'||value.length>100000))throw new Error('事项状态或现场内容无效');
    const completedAt=state==='done'?(existing?.completedAt??now):null;
    const draft=input.draftKey?this.drafts()[input.draftKey]:undefined;
    const extra=extraValue(input.extra??draft?.extra,existing?.extra);
    const relations=this.checkedRelations(input,existing??draft);
    const recurrence=recurrenceRule(input.recurrence!==undefined?input.recurrence:existing?existing.recurrence:draft?.recurrence);
    if(recurrence){
      if(!input.reminder)throw new Error('周期事项需要具体的下次提醒时间');
      recurrence.anchor=existing?.recurrence?.kind===recurrence.kind&&existing.recurrence.every===recurrence.every&&existing.reminder===input.reminder?existing.recurrence.anchor??input.reminder:input.reminder;
    }
    const seriesId=existing?.seriesId??(recurrence?id:null);
    this.checkDraftKey(input.draftKey,input.id?'edit:'+input.id:'capture');
    const written: string[] = [];
    this.db.exec('BEGIN IMMEDIATE');
    try {
      if (existing) this.db.prepare('UPDATE items SET text=?,quadrant=?,reminder=?,deadline=?,folder=?,updatedAt=?,state=?,inbox=?,nextStep=?,resumeNote=?,waitingFor=?,completedAt=? WHERE id=?').run(text, input.quadrant, input.reminder, input.deadline, input.folder, now,state,Number(inbox),nextStep,resumeNote,waitingFor,completedAt,id);
      else this.db.prepare('INSERT INTO items(id,text,quadrant,reminder,deadline,folder,createdAt,updatedAt,lastProgressAt,state,inbox,nextStep,resumeNote,waitingFor,completedAt) VALUES(?,?,?,?,?,?,?,?,NULL,?,?,?,?,?,?)').run(id, text, input.quadrant, input.reminder, input.deadline, input.folder, now, now,state,Number(inbox),nextStep,resumeNote,waitingFor,completedAt);
      this.db.prepare('UPDATE items SET extra=? WHERE id=?').run(extra,id);
      this.db.prepare('UPDATE items SET recurrence=?,seriesId=? WHERE id=?').run(recurrence?JSON.stringify(recurrence):null,seriesId,id);
      this.writeRelations(id,relations);
      this.writeMaterials(id,materials,written);
      if(state==='done'&&existing?.state!=='done'&&recurrence)this.createNextOccurrence(this.get(id),completedAt!);
      this.consumeDraft(input.draftKey,input.pending);
      this.db.exec('COMMIT');
    } catch (error) {
      this.db.exec('ROLLBACK');
      for (const path of written) rmSync(path, { force: true });
      throw error;
    }
    this.removeStaged(input.pending);
    return this.get(id);
  }
  private createNextOccurrence(item:Item,completedAt:string){
    if(this.db.prepare('SELECT id FROM items WHERE previousOccurrenceId=?').get(item.id))return;
    const id=randomUUID(),reminder=nextOccurrence(item.recurrence!,item.reminder!,completedAt);
    this.db.prepare(`INSERT INTO items(id,text,quadrant,reminder,deadline,folder,createdAt,updatedAt,lastProgressAt,state,inbox,nextStep,resumeNote,waitingFor,completedAt,extra,recurrence,seriesId,previousOccurrenceId)
      VALUES(?,?,?,?,NULL,?,?,?,NULL,'ready',?,'','','',NULL,?,?,?,?)`).run(id,item.text,item.quadrant,reminder,item.folder,completedAt,completedAt,Number(item.inbox),JSON.stringify(item.extra??{version:1,fields:{}}),JSON.stringify(item.recurrence),item.seriesId??item.id,item.id);
    this.writeRelations(id,this.checkedRelations(item));
    for(const ref of item.references)this.db.prepare('INSERT INTO refs(id,itemId,name,target,kind,role,createdAt) VALUES(?,?,?,?,?,?,?)').run(randomUUID(),id,ref.name,ref.target,ref.kind,ref.role,completedAt);
  }
  private writeMaterials(id:string,materials:Material[],written:string[],noteId:string|null=null) {
      for (const material of materials) {
        const attachmentId = randomUUID();
        const name = basename(material.name) || '附件';
        const path = join(this.directory, 'attachments', attachmentId + extname(name));
        written.push(path);
        if ('source' in material) copyFileSync(material.source, path);
        else writeFileSync(path, material.bytes);
        this.db.prepare('INSERT INTO attachments(id,itemId,name,path,role,noteId) VALUES(?,?,?,?,?,?)').run(attachmentId,id,name,relative(this.directory,path),'input',noteId);
      }
  }
  addNote(id:string,text:string,kind:NoteKind,materials:Material[],draftKey?:string,tokens:string[]=[],extra?:Extra) {
    const item=this.get(id);
    if(typeof text!=='string'||text.length>100000||typeof kind!=='string'||! /^[a-z][a-z0-9_-]{0,63}$/.test(kind)||materials.length>100)throw new Error('追加记录无效');
    const encodedExtra=extraValue(extra??(draftKey?this.drafts()[draftKey]?.extra:undefined));
    text=text.trim();if(!text&&(!materials.length||kind==='progress'))throw new Error('请输入记录内容');
    if(draftKey)this.checkDraftKey(draftKey,draftKey.startsWith('comment:')?'comment:'+id:'note:'+id);
    const now=new Date(Math.max(Date.now(),Date.parse(item.updatedAt)+1)).toISOString(),written:string[]=[];
    this.db.exec('BEGIN IMMEDIATE');
    try{
      const noteId=randomUUID();
      this.db.prepare('INSERT INTO notes(id,itemId,kind,text,createdAt,extra) VALUES(?,?,?,?,?,?)').run(noteId,id,kind,text||'补充资料',now,encodedExtra);
      this.writeMaterials(id,materials,written,noteId);
      this.db.prepare('UPDATE items SET updatedAt=?,lastProgressAt=? WHERE id=?').run(now,kind==='progress'?now:item.lastProgressAt,id);
      this.consumeDraft(draftKey,tokens);
      this.db.exec('COMMIT');
    }catch(error){this.db.exec('ROLLBACK');for(const path of written)rmSync(path,{force:true});throw error;}
    this.removeStaged(tokens);
    return this.get(id);
  }
  checkpoint(input:CheckpointInput):Item {
    if(!input||typeof input.id!=='string'||typeof input.expectedUpdatedAt!=='string'||typeof input.text!=='string'||!input.text.trim()||input.text.length>100000||input.nextStep!==undefined&&(typeof input.nextStep!=='string'||input.nextStep.length>100000))throw new Error('请输入有效的工作断点');
    const item=this.get(input.id),key='checkpoint:'+item.id;
    this.checkDraftKey(input.draftKey,key);
    if(input.expectedUpdatedAt!==item.updatedAt)throw new Error('事项已发生变化，请重新打开后保存断点，草稿仍保留');
    const draft=this.drafts()[key];if(draft?.pending.length)throw new Error('断点草稿包含附件，请先保全或移除后保存');
    const text=input.text.trim(),nextStep=input.nextStep??item.nextStep,now=new Date(Math.max(Date.now(),Date.parse(item.updatedAt)+1)).toISOString();
    const extra=extraValue({version:1,fields:{nextStep}},draft?.extra);
    this.db.exec('BEGIN IMMEDIATE');
    try{
      const changed=this.db.prepare('UPDATE items SET resumeNote=?,nextStep=?,updatedAt=? WHERE id=? AND updatedAt=?').run(text,nextStep,now,item.id,input.expectedUpdatedAt);
      if(changed.changes!==1)throw new Error('事项已发生变化，请重新打开后保存断点，草稿仍保留');
      this.db.prepare('INSERT INTO notes(id,itemId,kind,text,createdAt,extra) VALUES(?,?,?,?,?,?)').run(randomUUID(),item.id,'checkpoint',text,now,extra);
      this.consumeDraft(key,[]);this.db.exec('COMMIT');
    }catch(error){this.db.exec('ROLLBACK');throw error;}
    return this.get(item.id);
  }
  addReference(id:string,target:string,role:Role) {
    this.get(id);if(!['input','result'].includes(role))throw new Error('资料用途无效');
    const ref=referenceTarget(target);
    this.db.prepare('INSERT INTO refs(id,itemId,name,target,kind,role,createdAt) VALUES(?,?,?,?,?,?,?)').run(randomUUID(),id,ref.name,ref.target,ref.kind,role,new Date().toISOString());
    return this.get(id);
  }
  classifyAttachment(itemId:string,id:string,role:Role) {
    this.attachmentPath(itemId,id);if(!['input','result'].includes(role))throw new Error('附件用途无效');
    this.db.prepare('UPDATE attachments SET role=? WHERE id=? AND itemId=?').run(role,id,itemId);
  }
  attachmentPath(itemId: string, attachmentId: string): { name: string; path: string } {
    const row = this.db.prepare('SELECT name,path FROM attachments WHERE id=? AND itemId=?').get(attachmentId, itemId) as { name: string; path: string } | undefined;
    if (!row) throw new Error('附件不存在');
    const path=resolve(this.directory,row.path);
    if(!path.startsWith(resolve(this.directory,'attachments')+'\\'))throw new Error('附件路径无效');
    return {...row,path};
  }
  setState(id:string,state:TaskState,expectedUpdatedAt:string) {
    const item=this.get(id);
    if(!states.includes(state))throw new Error('事项状态无效');
    return this.save({...item,id,expectedUpdatedAt,state,pending:[]},[]);
  }
  private checkDraftKey(key:string|undefined,expected:string){if(key!==undefined&&key!==expected)throw new Error('草稿目标不一致');}
  private consumeDraft(key:string|undefined,tokens:string[]) {
    if(key)this.db.prepare('DELETE FROM drafts WHERE key=?').run(key);
    for(const token of tokens)this.db.prepare('DELETE FROM pending_files WHERE token=?').run(token);
  }
  private removeStaged(tokens:string[]) {
    for(const token of tokens)if(/^[a-f0-9-]{36}$/.test(token)) {
      // shortcut: 删除失败保留残留副本，不回滚成功记录；需要自动清理时再补安全扫描。
      try{rmSync(join(this.directory,'draft-files',token),{force:true});}catch{}
    }
  }
  drafts():Record<string,DraftValue> {
    return Object.fromEntries((this.db.prepare('SELECT key,body FROM drafts').all() as {key:string;body:string}[]).map(row=>[row.key,JSON.parse(row.body)]));
  }
  saveDraft(key:string,value:DraftValue) {
    if(typeof key!=='string'||! /^(capture|(?:edit|note|comment|checkpoint):[^:]{1,100})$/.test(key)||!value||typeof value.text!=='string'||value.text.length>100000||JSON.stringify(value).length>500000)throw new Error('草稿无效或过长');
    const previous=this.drafts()[key];
    value={...previous,...Object.fromEntries(Object.entries(value).filter(([_key,field])=>field!==undefined))} as DraftValue;
    if(JSON.stringify(value).length>500000)throw new Error('草稿无效或过长');
    if(!Array.isArray(value.pending)||value.pending.length>100||new Set(value.pending.map(file=>file.token)).size!==value.pending.length)throw new Error('草稿附件无效');
    if(value.quadrant!==undefined&&value.quadrant!==null&&(!Number.isInteger(value.quadrant)||value.quadrant<0||value.quadrant>3))throw new Error('草稿象限无效');
    for(const date of [value.reminder,value.deadline])if(date!==undefined&&date!==null&&(typeof date!=='string'||!/Z$/.test(date)||!Number.isFinite(Date.parse(date))))throw new Error('草稿时间无效');
    for(const text of [value.nextStep,value.resumeNote,value.waitingFor])if(text!==undefined&&(typeof text!=='string'||text.length>100000))throw new Error('草稿现场无效');
    if(value.folder!==undefined&&value.folder!==null&&(typeof value.folder!=='string'||value.folder.length>32767))throw new Error('草稿文件夹无效');
    if(value.state!==undefined&&!states.includes(value.state)||value.inbox!==undefined&&typeof value.inbox!=='boolean'||value.kind!==undefined&&(typeof value.kind!=='string'||!/^[a-z][a-z0-9_-]{0,63}$/.test(value.kind)))throw new Error('草稿状态无效');
    this.checkedRelations(value);
    if(value.recurrence!==undefined)value.recurrence=recurrenceRule(value.recurrence);
    if(value.extra!==undefined)value={...value,extra:JSON.parse(extraValue(value.extra,previous?.extra))};
    else if(previous?.extra)value={...value,extra:previous.extra};
    this.materialsFor(value.pending.map(file=>file.token));
    if(key==='capture'&&!value.text.trim()&&!value.pending.length&&!Object.keys(value.extra?.fields??{}).length&&value.quadrant==null&&!value.reminder&&!value.deadline&&!value.folder&&!value.recurrence&&!relationKeys.some(field=>value[field]?.length)){this.db.prepare('DELETE FROM drafts WHERE key=?').run(key);return;}
    if(key!=='capture'){
      const item=this.get(key.slice(key.indexOf(':')+1));
      if(key.startsWith('checkpoint:')&&!value.text.trim()&&!value.pending.length&&!Object.keys(value.extra?.fields??{}).length&&(value.nextStep===undefined||value.nextStep===item.nextStep)){this.db.prepare('DELETE FROM drafts WHERE key=?').run(key);return;}
      if(key.startsWith('edit:')&&!value.pending.length&&['text','quadrant','reminder','deadline','folder','state','inbox','nextStep','resumeNote','waitingFor'].every(field=>value[field as keyof DraftValue]===item[field as keyof Item])&&relationKeys.every(field=>JSON.stringify(value[field]??item[field]??[])===JSON.stringify(item[field]??[]))&&JSON.stringify(value.recurrence!==undefined?value.recurrence:item.recurrence??null)===JSON.stringify(item.recurrence??null)&&extraValue(value.extra,item.extra)===JSON.stringify(item.extra??{version:1,fields:{}})){this.db.prepare('DELETE FROM drafts WHERE key=?').run(key);return;}
    }
    this.db.prepare('INSERT INTO drafts(key,body,updatedAt) VALUES(?,?,?) ON CONFLICT(key) DO UPDATE SET body=excluded.body,updatedAt=excluded.updatedAt').run(key,JSON.stringify(value),new Date().toISOString());
  }
  stage(material:Material):Pending {
    if(Number(this.db.prepare('SELECT count(*) AS n FROM pending_files').get()!.n)>=100)throw new Error('待保存附件达到100个，请先保存或移除');
    const token=randomUUID(),name=basename(material.name)||'附件',path=join('draft-files',token),target=join(this.directory,path);
    try {
      if('source' in material)copyFileSync(material.source,target);else writeFileSync(target,material.bytes);
      this.db.prepare('INSERT INTO pending_files(token,name,path) VALUES(?,?,?)').run(token,name,path);
    }catch(error){rmSync(target,{force:true});throw error;}
    return {token,name};
  }
  stageMany(materials:Material[]):Pending[] {
    if(!materials.length||materials.length+Number(this.db.prepare('SELECT count(*) AS n FROM pending_files').get()!.n)>100)throw new Error('待保存附件超过100个，请先保存或移除');
    const staged:Pending[]=[];this.db.exec('BEGIN IMMEDIATE');
    try{for(const material of materials)staged.push(this.stage(material));this.db.exec('COMMIT');return staged;}
    catch(error){this.db.exec('ROLLBACK');this.removeStaged(staged.map(file=>file.token));throw error;}
  }
  materialsFor(tokens:string[]):Material[] {
    if(!Array.isArray(tokens)||tokens.length>100||new Set(tokens).size!==tokens.length||tokens.some(token=>typeof token!=='string'))throw new Error('附件列表无效');
    return tokens.map(token=>{
      const row=this.db.prepare('SELECT name,path FROM pending_files WHERE token=?').get(token) as {name:string;path:string}|undefined;
      if(!row)throw new Error('待保存附件已失效，请重新添加');
      const source=resolve(this.directory,row.path);if(!source.startsWith(resolve(this.directory,'draft-files')+'\\'))throw new Error('草稿附件路径无效');
      return {name:row.name,source};
    });
  }
  discard(tokens:string[]) {
    this.materialsFor(tokens);
    for(const token of tokens)this.db.prepare('DELETE FROM pending_files WHERE token=?').run(token);
    this.removeStaged(tokens);
    for(const [key,value] of Object.entries(this.drafts()))if(value.pending.some(file=>tokens.includes(file.token)))this.saveDraft(key,{...value,pending:value.pending.filter(file=>!tokens.includes(file.token))});
  }
  close() {
    if(!this.closed){
      try{return this.db.prepare('PRAGMA wal_checkpoint(TRUNCATE)').get() as {busy:number;log:number;checkpointed:number};}
      finally{this.db.close();this.closed=true;}
    }
  }
}
