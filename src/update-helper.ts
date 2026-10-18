import {copyFileSync,mkdirSync,readFileSync,writeFileSync,existsSync,rmSync,realpathSync,statSync} from 'node:fs';
import {join,dirname,resolve} from 'node:path';
import {spawn} from 'node:child_process';
import {createHash} from 'node:crypto';
import {programPath,verifyProgram,newerVersion} from './update.ts';

export async function installProgram(source:string,target:string,workspace:string){
  source=realpathSync(source);target=realpathSync(target);workspace=realpathSync(workspace);
  if(source===target||!source.startsWith(workspace+'\\')||resolve(target).startsWith(workspace+'\\'))throw new Error('更新目录无效');
  const next=verifyProgram(source),previous=verifyProgram(target,true);
  if(!newerVersion(next.version,previous.version))throw new Error('更新版本必须比现有程序更新');
  const oldNames=new Set(previous.files.map(file=>file.path.toLowerCase()));
  for(const entry of next.files){const destination=programPath(target,entry.path);if(!oldNames.has(entry.path.toLowerCase())&&existsSync(destination))throw new Error('程序目录存在同名用户文件或目录，未覆盖：'+entry.path);let parent=dirname(destination);while(parent!==target){if(existsSync(parent)&&!statSync(parent).isDirectory())throw new Error('程序目录存在同名用户文件，未覆盖：'+entry.path);parent=dirname(parent);}}
  const previousProgram=join(workspace,'previous-program');mkdirSync(previousProgram,{recursive:true});
  const copy=(from:string,to:string,name:string)=>{const destination=programPath(to,name);mkdirSync(dirname(destination),{recursive:true});copyFileSync(programPath(from,name),destination);};
  for(const entry of previous.files)copy(target,previousProgram,entry.path);copy(target,previousProgram,'files.sha256.json');
  const wait=()=>new Promise(accept=>setTimeout(accept,300));
  const retryCopy=async(from:string,to:string,name:string)=>{for(let attempt=0;attempt<60;attempt++){try{copy(from,to,name);return;}catch(error){if(attempt===59||!['EPERM','EACCES','EBUSY'].includes((error as NodeJS.ErrnoException).code??''))throw error;await wait();}}};
  try{
    for(const entry of [...next.files,{path:'files.sha256.json',sha256:''}]){
      if(entry.sha256&&existsSync(programPath(target,entry.path))&&createHash('sha256').update(readFileSync(programPath(target,entry.path))).digest('hex')===entry.sha256)continue;
      await retryCopy(source,target,entry.path);
    }
    const nextNames=new Set(next.files.map(file=>file.path.toLowerCase()));for(const entry of previous.files)if(!nextNames.has(entry.path.toLowerCase()))rmSync(programPath(target,entry.path),{force:true});
    // 程序目录可保留旧便携data；只核对发布清单中的程序文件。
    verifyProgram(target,true);
    writeFileSync(join(workspace,'result.json'),JSON.stringify({status:'installed',version:next.version,previousProgram}));
  }catch(error){
    const failures:string[]=[];
    for(const entry of next.files)if(!oldNames.has(entry.path.toLowerCase())){try{const path=programPath(target,entry.path);if(existsSync(path)&&statSync(path).isFile())rmSync(path,{force:true});}catch(problem){failures.push(String(problem));}}
    for(const entry of previous.files){try{const current=programPath(target,entry.path);if(existsSync(current)&&createHash('sha256').update(readFileSync(current)).digest('hex')===entry.sha256)continue;await retryCopy(previousProgram,target,entry.path);}catch(problem){failures.push(String(problem));}}
    try{await retryCopy(previousProgram,target,'files.sha256.json');verifyProgram(target,true);}catch(problem){failures.push(String(problem));}
    writeFileSync(join(workspace,'result.json'),JSON.stringify({status:failures.length?'rollback-failed':'rolled-back',error:String(error),failures,previousProgram}));throw error;
  }
  return next;
}
if(process.argv[2]&&!process.env.RECALL_UPDATE_UNIT_TEST){
  const plan=JSON.parse(readFileSync(process.argv[2],'utf8'));
  void(async()=>{
    if(!Number.isInteger(plan.parent)||plan.parent<=0)throw new Error('更新进程无效');
    for(let i=0;i<150;i++){let alive=true;try{process.kill(plan.parent,0);}catch{alive=false;}if(!alive)break;if(i===149)throw new Error('等待 Recall 退出超时，程序未替换');await new Promise(accept=>setTimeout(accept,200));}
    await installProgram(plan.source,plan.target,plan.workspace);
    const child=spawn(join(plan.target,'Recall.exe'),[],{detached:true,stdio:'ignore',windowsHide:true,env:{...process.env,ELECTRON_RUN_AS_NODE:''}});
    await new Promise<void>((accept,reject)=>{child.once('spawn',accept);child.once('error',reject);});child.unref();
  })().catch(error=>{writeFileSync(join(plan.workspace,'update-error.txt'),String(error));});
}
