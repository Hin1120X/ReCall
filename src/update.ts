import {mkdirSync,readFileSync,writeFileSync,readdirSync,statSync,realpathSync,lstatSync} from 'node:fs';
import {join,resolve,relative,isAbsolute,dirname} from 'node:path';
import {randomUUID,createHash} from 'node:crypto';
import {execFile,spawn} from 'node:child_process';
import {promisify} from 'node:util';

export type ProgramManifest={version:string;files:{path:string;sha256:string}[]};
export type PreparedUpdate={token:string;root:string;manifest:ProgramManifest;workspace:string};
const versionParts=(version:string)=>{if(!/^\d+\.\d+\.\d+$/.test(version))throw new Error('更新版本号无效');return version.split('.').map(Number);};
export function newerVersion(next:string,current:string){const a=versionParts(next),b=versionParts(current);for(let i=0;i<3;i++)if(a[i]!==b[i])return a[i]>b[i];return false;}
export function programPath(root:string,path:string){
  if(typeof path!=='string'||!path||path.includes('\\')||path.split('/').some(part=>!part||part==='.'||part==='..'||part.includes(':')||/[. ]$/.test(part)||/^(con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\.|$)/i.test(part))||isAbsolute(path))throw new Error('更新文件路径无效');
  const result=resolve(root,path),part=relative(resolve(root),result);if(part.startsWith('..')||isAbsolute(part))throw new Error('更新文件越界');
  let current=resolve(root);for(const segment of path.split('/')){current=join(current,segment);try{if(lstatSync(current).isSymbolicLink())throw new Error('程序路径含符号链接或目录联接，停止替换');}catch(error){if((error as NodeJS.ErrnoException).code!=='ENOENT')throw error;}}
  return result;
}
export function verifyProgram(root:string,allowExtra=false):ProgramManifest{
  const file=programPath(root,'files.sha256.json');if(statSync(file).size>5*1024*1024)throw new Error('程序清单过大');
  const manifest:ProgramManifest=JSON.parse(readFileSync(file,'utf8'));versionParts(manifest.version);
  if(!Array.isArray(manifest.files)||!manifest.files.length||manifest.files.length>20000)throw new Error('程序清单无效');
  const names=new Set<string>();let bytes=0;
  for(const entry of manifest.files){
    const path=programPath(root,entry.path),name=entry.path.toLowerCase();
    if(names.has(name)||/^(data|backups|\.git|\.local-data|\.cache)(\/|$)/i.test(entry.path)||! /^[a-f0-9]{64}$/.test(entry.sha256))throw new Error('更新包含重复或业务数据路径');
    names.add(name);const info=statSync(path);if(!info.isFile()||info.isSymbolicLink()||(bytes+=info.size)>2*1024**3)throw new Error('更新文件类型或大小无效');
    if(!realpathSync(path).toLowerCase().startsWith(realpathSync(root).toLowerCase()+'\\'))throw new Error('更新文件越界');
    if(createHash('sha256').update(readFileSync(path)).digest('hex')!==entry.sha256)throw new Error('程序文件校验失败：'+entry.path);
  }
  if(!names.has('recall.exe')||!names.has('resources/app/package.json')||!names.has('resources/app/dist/update-helper.cjs'))throw new Error('更新包缺少程序组件');
  const metadata=JSON.parse(readFileSync(join(root,'resources/app/package.json'),'utf8'));if(metadata.version!==manifest.version)throw new Error('更新包版本不一致');
  function walk(directory:string,prefix=''){for(const entry of readdirSync(directory,{withFileTypes:true})){if(entry.isSymbolicLink())throw new Error('更新包不能含符号链接');const name=prefix+entry.name;if(entry.isDirectory())walk(join(directory,entry.name),name+'/');else if(name!=='files.sha256.json'&&!names.has(name.toLowerCase()))throw new Error('更新包含未校验文件：'+name);}}
  if(!allowExtra)walk(root);return manifest;
}
export async function prepareUpdate(archive:string,runtime:string,currentVersion:string):Promise<PreparedUpdate>{
  if(statSync(archive).size>1024**3)throw new Error('更新包过大');
  const token=randomUUID(),workspace=join(runtime,'updates',token),unpacked=join(workspace,'package');mkdirSync(unpacked,{recursive:true});
  // 解压前逐条验证路径、重复和展开大小，避免ZIP覆盖包目录之外的文件。
  const script=`$ErrorActionPreference='Stop'
Add-Type -AssemblyName System.IO.Compression.FileSystem
$recallZip=[System.IO.Compression.ZipFile]::OpenRead($env:RECALL_UPDATE_ZIP)
try {
  $recallNames=New-Object 'System.Collections.Generic.HashSet[string]' ([System.StringComparer]::OrdinalIgnoreCase)
  [long]$recallSize=0
  if($recallZip.Entries.Count -gt 20000){throw 'Too many entries'}
  foreach($recallEntry in $recallZip.Entries){
    $recallName=$recallEntry.FullName.Replace('\\','/')
    if($recallName.StartsWith('/') -or $recallName.Contains(':') -or ($recallName.Split('/') -contains '..') -or -not $recallNames.Add($recallName)){throw 'Invalid ZIP path'}
    foreach($recallPart in $recallName.TrimEnd('/').Split('/')){if(-not $recallPart -or $recallPart -match '[. ]$' -or $recallPart -match '^(?i:con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\\.|$)'){throw 'Invalid ZIP name'}}
    $recallSize+=$recallEntry.Length
    if($recallSize -gt 2147483648){throw 'ZIP too large'}
  }
} finally {$recallZip.Dispose()}
[System.IO.Compression.ZipFile]::ExtractToDirectory($env:RECALL_UPDATE_ZIP,$env:RECALL_UPDATE_STAGE)`;
  await promisify(execFile)('powershell.exe',['-NoProfile','-NonInteractive','-Command',script],{windowsHide:true,timeout:120000,env:{...process.env,RECALL_UPDATE_ZIP:resolve(archive),RECALL_UPDATE_STAGE:unpacked}});
  const entries=readdirSync(unpacked,{withFileTypes:true});
  const root=entries.length===1&&entries[0].isDirectory()?join(unpacked,entries[0].name):unpacked;
  const manifest=verifyProgram(root);if(!newerVersion(manifest.version,currentVersion))throw new Error('请选择比当前版本更新的完整离线包');
  return {token,workspace,root,manifest};
}
export function verifyUpdate(update:PreparedUpdate){if(JSON.stringify(verifyProgram(update.root))!==JSON.stringify(update.manifest))throw new Error('更新包在预览后发生变化，请重新选择');}
export async function startUpdate(update:PreparedUpdate,program:string,backup:string){
  verifyUpdate(update);program=realpathSync(program);
  const plan=join(update.workspace,'update-plan.json');writeFileSync(plan,JSON.stringify({source:update.root,target:program,parent:process.pid,backup,workspace:update.workspace},null,2));
  const child=spawn(join(update.root,'Recall.exe'),[join(update.root,'resources/app/dist/update-helper.cjs'),plan],{env:{...process.env,ELECTRON_RUN_AS_NODE:'1'},detached:true,stdio:'ignore',windowsHide:true});
  await new Promise<void>((accept,reject)=>{child.once('spawn',accept);child.once('error',reject);});child.unref();
}
