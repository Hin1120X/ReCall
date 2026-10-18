import { DatabaseSync } from 'node:sqlite';
import { createHash, randomUUID } from 'node:crypto';
import { existsSync, mkdirSync, readdirSync, readFileSync, cpSync, renameSync, rmSync, writeFileSync, openSync,readSync,closeSync, statSync } from 'node:fs';
import { join, resolve, relative, isAbsolute, basename } from 'node:path';

function check(db:DatabaseSync) {
  if(db.prepare('PRAGMA integrity_check').get()?.integrity_check!=='ok'||db.prepare('PRAGMA foreign_key_check').all().length)throw new Error('数据库完整性检查失败，原数据未覆盖');
}
const quote=(name:string)=>'"'+name.replaceAll('"','""')+'"';
export function databaseInfo(directory:string) {
  const db=new DatabaseSync(join(directory,'recall.sqlite'),{readOnly:true});
  try {
    check(db);const counts:Record<string,number>={},hash=createHash('sha256');
    for(const {name} of db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%' ORDER BY name").all() as {name:string}[]){
      const columns=db.prepare(`PRAGMA table_info(${quote(name)})`).all() as {name:string;pk:number}[];
      const keys=columns.filter(col=>col.pk).sort((a,b)=>a.pk-b.pk).map(col=>quote(col.name));
      counts[name]=0;hash.update(name+'\n');
      for(const row of db.prepare(`SELECT * FROM ${quote(name)} ORDER BY ${keys.length?keys.join(','):'rowid'}`).iterate()){hash.update(JSON.stringify(row)+'\n');counts[name]++;}
    }
    return {schema:Number(db.prepare('PRAGMA user_version').get()!.user_version),counts,signature:hash.digest('hex')};
  }finally{db.close();}
}
export type BackupManifest={format:number;createdAt:string;appVersion:string;schema:number;counts:Record<string,number>;signature:string;files:{path:string;size:number;sha256:string}[];legacy?:boolean};
function files(directory:string,prefix=''):BackupManifest['files'] {
  return readdirSync(join(directory,prefix),{withFileTypes:true}).flatMap(entry=>{
    if(entry.isSymbolicLink())throw new Error('数据目录含符号链接，已停止备份或恢复');
    const path=prefix?prefix+'/'+entry.name:entry.name;
    if(!prefix&&['backup-manifest.json','recall.sqlite-wal','recall.sqlite-shm'].includes(entry.name))return [];
    if(entry.isDirectory())return files(directory,path);
    if(!entry.isFile())throw new Error('备份中含不支持的文件类型');
    const target=join(directory,path);return [{path,size:statSync(target).size,sha256:fileDigest(target)}];
  }).sort((a,b)=>a.path<b.path?-1:a.path>b.path?1:0);
}
export function inspectBackup(directory:string,maxSchema=Number.MAX_SAFE_INTEGER):BackupManifest {
  const file=join(directory,'backup-manifest.json');
  if(!existsSync(join(directory,'recall.sqlite')))throw new Error('请选择完整 Recall 备份文件夹');
  const info=databaseInfo(directory);
  if(info.counts.items===undefined||info.counts.attachments===undefined)throw new Error('不是有效的 Recall 备份');
  if(existsSync(file)&&statSync(file).size>20*1024*1024)throw new Error('备份清单过大');
  const manifest:BackupManifest=existsSync(file)?JSON.parse(readFileSync(file,'utf8')):{format:1,legacy:true,createdAt:statSync(join(directory,'recall.sqlite')).mtime.toISOString(),appVersion:'旧格式',...info,files:files(directory)};
  if(manifest.format!==1||!Number.isInteger(manifest.schema)||manifest.schema>maxSchema||!Array.isArray(manifest.files)||manifest.files.length>100000||!Number.isFinite(Date.parse(manifest.createdAt)))throw new Error('备份版本不支持或格式无效，请使用对应新版程序');
  if(JSON.stringify(files(directory))!==JSON.stringify(manifest.files))throw new Error('备份文件缺失、增加或内容变化，未恢复');
  if(info.schema!==manifest.schema||info.signature!==manifest.signature||JSON.stringify(info.counts)!==JSON.stringify(manifest.counts))throw new Error('备份数据库校验失败');
  const db=new DatabaseSync(join(directory,'recall.sqlite'),{readOnly:true});
  try{for(const [table,folder] of [['attachments','attachments'],['pending_files','draft-files']]){
    if(!db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name=?").get(table))continue;
    for(const row of db.prepare(`SELECT path FROM ${quote(table)}`).all() as {path:string}[]){
      const path=info.schema<4&&table==='attachments'?join(directory,folder,basename(row.path)):resolve(directory,row.path);
      if(!path.startsWith(resolve(directory,folder)+'\\')||!existsSync(path)||!statSync(path).isFile())throw new Error('备份附件缺失或资料路径无效');
    }
  }}finally{db.close();}
  return manifest;
}
export function dataSignature(directory:string) {
  const db=new DatabaseSync(join(directory,'recall.sqlite'),{readOnly:true});
  try {
    const hash=createHash('sha256');
    for(const table of ['items','attachments','notes','refs','analyses'])if(db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name=?").get(table)){hash.update(table);for(const row of db.prepare(`SELECT * FROM ${table} ORDER BY rowid`).iterate())hash.update(JSON.stringify(row)+'\n');}
    return hash.digest('hex');
  }finally{db.close();}
}
export function snapshotData(directory:string,target:string) {
  const destination=relative(directory,target);
  if(!isAbsolute(destination)&&destination!=='..'&&!destination.startsWith('..\\'))throw new Error('备份目标必须在数据目录之外');
  if(existsSync(target))throw new Error('备份目录已存在，未覆盖');
  mkdirSync(target,{recursive:true});
  try {
    const source=new DatabaseSync(join(directory,'recall.sqlite'),{readOnly:true});
    try{check(source);source.prepare('VACUUM INTO ?').run(join(target,'recall.sqlite'));}finally{source.close();}
    for(const entry of readdirSync(directory,{withFileTypes:true})) {
      if(['recall.sqlite','recall.sqlite-wal','recall.sqlite-shm','chromium','backups','analysis-run','backup-manifest.json','startup-check.json'].includes(entry.name))continue;
      if(entry.isSymbolicLink())throw new Error('数据目录含符号链接，请先核对');
      cpSync(join(directory,entry.name),join(target,entry.name),{recursive:true,errorOnExist:true,force:false});
    }
    const copy=new DatabaseSync(join(target,'recall.sqlite'),{readOnly:true});try{check(copy);}finally{copy.close();}
    if(databaseInfo(directory).signature!==databaseInfo(target).signature)throw new Error('备份记录校验不一致');
    function verify(source:string,destination:string) {
      for(const entry of readdirSync(source,{withFileTypes:true})) {
        if(entry.isSymbolicLink())throw new Error('数据目录含符号链接，请先核对后再升级');
        const a=join(source,entry.name),b=join(destination,entry.name);
        if(entry.isDirectory())verify(a,b);
        else if(fileDigest(a)!==fileDigest(b))throw new Error('附件或草稿备份校验失败');
      }
    }
    for(const name of ['attachments','draft-files'])if(existsSync(join(directory,name)))verify(join(directory,name),join(target,name));
    const info=databaseInfo(target);
    const release=join(target,'release-state.json');
    const manifest:BackupManifest={format:1,createdAt:new Date().toISOString(),appVersion:existsSync(release)?JSON.parse(readFileSync(release,'utf8')).version:'legacy',...info,files:files(target)};
    writeFileSync(join(target,'backup-manifest.json'),JSON.stringify(manifest,null,2));
    inspectBackup(target);
  }catch(error){rmSync(target,{recursive:true,force:true});throw error;}
}
function fileDigest(path:string){const fd=openSync(path,'r'),hash=createHash('sha256'),buffer=Buffer.alloc(1024*1024);try{let length;while((length=readSync(fd,buffer,0,buffer.length,null)))hash.update(buffer.subarray(0,length));return hash.digest('hex');}finally{closeSync(fd);}}
export function prepareDataDirectory(target:string,legacy:string,backups:string) {
  const originFile=join(target,'legacy-origin.json');
  if(existsSync(originFile)) {
    const origin=JSON.parse(readFileSync(originFile,'utf8')) as {directory:string;signature:string};
    if(existsSync(join(origin.directory,'recall.sqlite'))&&dataSignature(origin.directory)!==origin.signature)throw new Error('旧便携数据又有变化。已保留两份数据，请先接续这些记录，不能自动覆盖。');
  }
  if(!existsSync(join(legacy,'recall.sqlite'))||resolve(target)===resolve(legacy))return;
  if(existsSync(join(target,'recall.sqlite'))) {
    if(!existsSync(originFile))throw new Error('固定数据目录和旧便携目录均有数据库，请先选择需要接续的数据；两份均未覆盖');
    return;
  }
  mkdirSync(backups,{recursive:true});
  const archive=join(backups,'legacy-'+Date.now()+'-'+randomUUID().slice(0,8));
  snapshotData(legacy,archive);
  const signature=dataSignature(archive);
  const staged=target+'-import-'+randomUUID();
  try {
    snapshotData(archive,staged);
    if(dataSignature(legacy)!==signature)throw new Error('旧版仍在写入数据，请退出旧版后再接续；原数据与备份均保留');
    writeFileSync(join(staged,'legacy-origin.json'),JSON.stringify({directory:resolve(legacy),signature},null,2));
    rmSync(join(staged,'backup-manifest.json'),{force:true});
    if(existsSync(target)) {
      if(readdirSync(target).length)throw new Error('目标数据目录非空，未覆盖，请先核对');
      rmSync(target);
    }
    renameSync(staged,target);
  }catch(error){rmSync(staged,{recursive:true,force:true});throw error;}
}
