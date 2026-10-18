import assert from 'node:assert/strict';
import {DatabaseSync} from 'node:sqlite';
import {createHash} from 'node:crypto';
import {existsSync,mkdirSync,mkdtempSync,readFileSync,writeFileSync,readdirSync,statSync,realpathSync} from 'node:fs';
import {join,resolve,relative,isAbsolute,dirname} from 'node:path';
import {fileURLToPath} from 'node:url';
import {spawnSync} from 'node:child_process';

const repo=resolve(fileURLToPath(new URL('../',import.meta.url))),cache=join(repo,'.cache'),self=fileURLToPath(import.meta.url);
const hash=value=>createHash('sha256').update(value).digest('hex');
const quote=name=>'"'+name.replaceAll('"','""')+'"';
function isolated(directory){
  const part=relative(cache,realpathSync(directory));
  assert.ok(!isAbsolute(part)&&/^lifecycle-[^\\/]+[\\/](?:data|backups[\\/]before-v5-[^\\/]+)$/.test(part),'只能检查仓库 .cache/lifecycle-* 中的样例数据或迁移备份');
}
function fileInfo(path){
  if(!existsSync(path))return null;
  const bytes=readFileSync(path);return {size:bytes.length,sha256:hash(bytes)};
}
function inspect(directory,baseline){
  isolated(directory);
  const dbPath=join(directory,'recall.sqlite'),before=Object.fromEntries(['','-wal','-shm'].map(suffix=>[suffix||'main',fileInfo(dbPath+suffix)]));
  const header=readFileSync(dbPath),db=new DatabaseSync(dbPath,{readOnly:true});
  try{
    const integrity=db.prepare('PRAGMA integrity_check').all();assert.deepEqual(integrity,[{__proto__:null,integrity_check:'ok'}]);assert.equal(db.prepare('PRAGMA foreign_key_check').all().length,0);
    const tables=[];
    for(const row of db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%' ORDER BY name").all()){
      const schema=db.prepare(`PRAGMA table_info(${quote(row.name)})`).all(),old=baseline?.tables.find(table=>table.name===row.name),columns=old?.columns??schema.map(column=>column.name);
      const keys=schema.filter(column=>column.pk).sort((a,b)=>a.pk-b.pk).map(column=>quote(column.name));
      let count=0;const digest=createHash('sha256');
      for(const record of db.prepare(`SELECT ${columns.map(quote).join(',')} FROM ${quote(row.name)} ORDER BY ${keys.length?keys.join(','):'rowid'}`).iterate()){count++;if(row.name!=='drafts')digest.update(JSON.stringify(record)+'\n');}
      tables.push({name:row.name,columns,count,sha256:row.name==='drafts'?null:digest.digest('hex')});
    }
    const drafts=db.prepare('SELECT key,body FROM drafts ORDER BY key').all().map(row=>({key:row.key,fields:Object.fromEntries(Object.entries(JSON.parse(row.body)).map(([key,value])=>[key,hash(JSON.stringify(value))]))}));
    const files=[];
    function walk(path,prefix=''){
      for(const entry of readdirSync(path,{withFileTypes:true})){
        const name=prefix?prefix+'/'+entry.name:entry.name;if(entry.isDirectory()){if(['attachments','draft-files'].includes(name))walk(join(path,entry.name),name);}else if(!['recall.sqlite','recall.sqlite-wal','recall.sqlite-shm','startup-check.json','release-state.json'].includes(name))files.push({path:name,...fileInfo(join(path,entry.name))});
      }
    }
    walk(directory);files.sort((a,b)=>a.path.localeCompare(b.path));
    return {runtime:process.execPath,node:process.versions.node,electron:process.versions.electron??null,sqlite:db.prepare('SELECT sqlite_version() AS version').get().version,schema:db.prepare('PRAGMA user_version').get().user_version,mainHeaderSchema:header.length>=64?header.readUInt32BE(60):null,integrity:'ok',foreignKeys:'ok',before,tables,drafts,files};
  }finally{db.close();}
}

if(process.argv[2]==='--inspect'){
  const baseline=process.argv[4]?JSON.parse(readFileSync(process.argv[4],'utf8')):undefined;
  console.log(JSON.stringify(inspect(resolve(process.argv[3]),baseline)));process.exit(0);
}

mkdirSync(cache,{recursive:true});const root=mkdtempSync(join(cache,'lifecycle-')),data=join(root,'data'),baselineFile=join(root,'baseline.json');
const report={startedAt:new Date().toISOString(),isolated:true,root,checks:[],processes:[],passed:false};
const exeFlag=process.argv.indexOf('--exe'),exe=exeFlag>=0?resolve(process.argv[exeFlag+1]??''):join(repo,'node_modules','electron','dist','electron.exe');
const staged=exeFlag>=0;
const packageVersion=JSON.parse(readFileSync(join(repo,'package.json'),'utf8')).version;
const stageRoot=join(repo,'release','Recall-'+packageVersion),actual=realpathSync(exe),fromCache=relative(cache,actual),fromStage=relative(stageRoot,actual);
if(staged)assert.ok(!isAbsolute(fromCache)&&!fromCache.startsWith('..')||!isAbsolute(fromStage)&&!fromStage.startsWith('..'),'--exe 仅接受 .cache 或本版独立发布目录，不检查正式程序');
const appMain=staged?join(dirname(actual),'resources','app','dist','main.cjs'):join(repo,'dist','main.cjs');
assert.ok(readFileSync(appMain,'utf8').includes('--lifecycle-check'),'待验收构建不支持隔离生命周期检查，请先构建新版');
function run(executable,args,name,extraEnv={}){
  const env={...process.env,...extraEnv,TEMP:join(cache,'test-temp'),TMP:join(cache,'test-temp')};mkdirSync(env.TEMP,{recursive:true});
  if(!extraEnv.ELECTRON_RUN_AS_NODE)delete env.ELECTRON_RUN_AS_NODE;
  const child=spawnSync(executable,args,{cwd:repo,env,windowsHide:true,encoding:'utf8',timeout:60000,maxBuffer:8*1024*1024});
  writeFileSync(join(root,name+'.stdout.log'),child.stdout??'');writeFileSync(join(root,name+'.stderr.log'),child.stderr??'');
  report.processes.push({name,runtime:executable,status:child.status,signal:child.signal,error:child.error?String(child.error):null,stdoutBytes:Buffer.byteLength(child.stdout??''),stderrBytes:Buffer.byteLength(child.stderr??'')});
  assert.ifError(child.error);assert.equal(child.status,0,name+' 未正常退出，日志位于 '+root);
  assert.ok(!/Object has been destroyed|SQLITE_CORRUPT|database disk image is malformed|Error occurred in handler|启动失败/.test((child.stderr??'')+(child.stdout??'')),name+' 出现运行错误');
  return child.stdout.trim();
}
function compare(current,schema=7){
  assert.equal(current.schema,schema);
  const baseline=JSON.parse(readFileSync(baselineFile,'utf8'));
  for(const table of baseline.tables){const found=current.tables.find(row=>row.name===table.name);assert.ok(found,'原表缺失：'+table.name);assert.equal(found.count,table.count,table.name+' 数量变化');if(table.name!=='drafts')assert.equal(found.sha256,table.sha256,table.name+' 原字段变化');}
  for(const draft of baseline.drafts){const found=current.drafts.find(row=>row.key===draft.key);assert.ok(found,'有效草稿丢失');for(const [field,digest] of Object.entries(draft.fields))assert.equal(found.fields[field],digest,'草稿原字段变化：'+field);}
  for(const file of baseline.files){const found=current.files.find(row=>row.path===file.path);assert.deepEqual(found,file,'原文件变化：'+file.path);}
}
try{
  run(process.execPath,[join(repo,'tests','fixtures','v5.ts'),data],'fixture-v5');
  const baseline=JSON.parse(run(process.execPath,[self,'--inspect',data],'baseline-node'));
  assert.equal(baseline.schema,5);assert.ok(baseline.before['-wal']?.size>0,'样例必须留下已提交WAL');
  assert.ok(!baseline.tables.some(table=>['catalog_entries','item_catalog','task_usage'].includes(table.name)));assert.ok(!baseline.tables.find(table=>table.name==='items').columns.includes('recurrence'));
  writeFileSync(baselineFile,JSON.stringify(baseline,null,2));report.baseline=baseline;
  const electronBefore=JSON.parse(run(actual,[self,'--inspect',data],'baseline-electron',{ELECTRON_RUN_AS_NODE:'1'}));assert.equal(electronBefore.schema,5);assert.deepEqual(electronBefore.tables,baseline.tables);report.electronBaseline=electronBefore;
  for(const [index,mode] of ['--lifecycle-check','--lifecycle-check','--startup-check'].entries()){
    const label=index<2?'normal-'+(index+1):'startup';
    run(actual,[...(staged?[]:[repo]),mode,'--allow-shortcut-conflict'],label,{RECALL_TEST_DATA:data});
    const node=JSON.parse(run(process.execPath,[self,'--inspect',data,baselineFile],label+'-node'));compare(node);
    const electron=JSON.parse(run(actual,[self,'--inspect',data,baselineFile],label+'-electron',{ELECTRON_RUN_AS_NODE:'1'}));compare(electron);
    assert.equal(node.schema,electron.schema);assert.deepEqual(node.tables,electron.tables);report.checks.push({mode,node,electron});
    writeFileSync(join(root,'report.json'),JSON.stringify(report,null,2));
  }
  const migrationBackups=readdirSync(join(root,'backups')).filter(name=>name.startsWith('before-v5-'));assert.equal(migrationBackups.length,1,'正常重开不应重复迁移备份');
  const migrationBackup=JSON.parse(run(process.execPath,[self,'--inspect',join(root,'backups',migrationBackups[0]),baselineFile],'migration-backup'));compare(migrationBackup,5);report.migrationBackup=migrationBackup;
  const startup=JSON.parse(readFileSync(join(data,'startup-check.json'),'utf8'));assert.equal(realpathSync(startup.dataDirectory),realpathSync(data));assert.ok(startup.hookAvailable);assert.equal(startup.persistedItems,1);
  report.startup=startup;report.passed=true;report.finishedAt=new Date().toISOString();writeFileSync(join(root,'report.json'),JSON.stringify(report,null,2));
  console.log(JSON.stringify({passed:true,root,report:join(root,'report.json'),schema:7,runs:report.checks.length,nodeSqlite:report.checks[0].node.sqlite,electronSqlite:report.checks[0].electron.sqlite,oldFieldsPreserved:true,validDraftPreserved:true,filesVerified:baseline.files.length,scope:'isolated sample only'}));
}catch(error){report.error=String(error);writeFileSync(join(root,'report.json'),JSON.stringify(report,null,2));throw error;}
