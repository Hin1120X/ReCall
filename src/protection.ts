import {existsSync,readFileSync,writeFileSync,renameSync,rmSync,mkdirSync,realpathSync} from 'node:fs';
import {join,dirname,basename,resolve,relative,isAbsolute} from 'node:path';
import {randomUUID} from 'node:crypto';
import {databaseInfo,inspectBackup,snapshotData} from './data.ts';
import type {ProtectionInfo} from './shared.ts';

export class Protection {
  private state:{lastSuccess:string;lastPath:string;signature:string;error:string}={lastSuccess:'',lastPath:'',signature:'',error:''};
  readonly data:string;readonly defaultDirectory:string;readonly stateFile:string;
  constructor(data:string,defaultDirectory:string,stateFile:string){
    this.data=data;this.defaultDirectory=defaultDirectory;this.stateFile=stateFile;
    if(existsSync(stateFile)){try{this.state={...this.state,...JSON.parse(readFileSync(stateFile,'utf8'))};}catch{this.state.error='备份状态不可读，请重新执行备份';}}
  }
  info():ProtectionInfo {
    const settings=join(this.data,'backup-settings.json');
    const directory=existsSync(settings)?JSON.parse(readFileSync(settings,'utf8')).directory:this.defaultDirectory;
    return {directory,lastSuccess:this.state.lastSuccess,lastPath:this.state.lastPath,error:this.state.error};
  }
  choose(directory:string){
    const selected=realpathSync(directory),data=realpathSync(this.data),part=relative(data,selected);
    if(part===''||(!isAbsolute(part)&&part!=='..'&&!part.startsWith('..\\')))throw new Error('备份目录必须在 Recall 数据目录之外');
    writeFileSync(join(this.data,'backup-settings.json'),JSON.stringify({directory:selected}));return this.info();
  }
  due(now=new Date()){
    if(this.state.lastSuccess&&new Date(this.state.lastSuccess).toDateString()===now.toDateString())return false;
    const info=databaseInfo(this.data);
    if(!Object.entries(info.counts).some(([table,count])=>count>0&&!['reminders','task_usage'].includes(table)))return false;
    return info.signature!==this.state.signature;
  }
  backup(kind:'manual'|'daily'|'before-restore'='manual'){
    try{
      const directory=this.info().directory;mkdirSync(directory,{recursive:true});
      const root=realpathSync(directory),part=relative(realpathSync(this.data),root);
      if(part===''||(!isAbsolute(part)&&part!=='..'&&!part.startsWith('..\\')))throw new Error('备份目录必须在数据目录之外');
      const target=join(root,kind+'-'+Date.now()+'-'+randomUUID().slice(0,8));
      snapshotData(this.data,target);
      const manifest=inspectBackup(target);
      this.state={lastSuccess:manifest.createdAt,lastPath:target,signature:manifest.signature,error:''};
      this.save();return this.info();
    }catch(error){this.state.error=String(error);try{this.save();}catch{}throw error;}
  }
  private save(){mkdirSync(dirname(this.stateFile),{recursive:true});const temporary=this.stateFile+'.tmp';writeFileSync(temporary,JSON.stringify(this.state));renameSync(temporary,this.stateFile);}
}

const journal=(data:string)=>join(dirname(data),'restore-journal.json');
export function recoverRestore(data:string){
  const marker=journal(data);if(!existsSync(marker))return;
  const info=JSON.parse(readFileSync(marker,'utf8')) as {stage:string;previous:string};
  if(!/^restore-stage-[a-f0-9-]{36}$/.test(info.stage)||!/^data-before-restore-[a-f0-9-]{36}$/.test(info.previous))throw new Error('恢复记录格式无效，请保全数据后核对');
  const previous=join(dirname(data),info.previous),stage=join(dirname(data),info.stage);
  if(!existsSync(data)&&existsSync(previous))renameSync(previous,data);
  if(!existsSync(join(data,'recall.sqlite'))||(existsSync(previous)&&existsSync(stage)))throw new Error('恢复未完成，两份数据均保留，请先核对');
  databaseInfo(data);rmSync(marker);
}
export function prepareRestore(source:string,data:string,maxSchema:number,migrate:(directory:string)=>void){
  inspectBackup(source,maxSchema);
  const stage=join(dirname(data),'restore-stage-'+randomUUID());
  try{snapshotData(source,stage);migrate(stage);databaseInfo(stage);rmSync(join(stage,'backup-manifest.json'));return stage;}
  catch(error){if(existsSync(stage))rmSync(stage,{recursive:true,force:true});throw error;}
}
// 调用者关闭数据库并阻止后续写入后，才允许切换目录。
export function installRestore(data:string,stage:string){
  if(dirname(resolve(stage))!==dirname(resolve(data))||!/^restore-stage-[a-f0-9-]{36}$/.test(basename(stage)))throw new Error('恢复临时目录无效');
  const previous=join(dirname(data),'data-before-restore-'+randomUUID()),marker=journal(data);
  if(existsSync(marker))throw new Error('存在未完成的恢复，请重新启动后核对');
  writeFileSync(marker,JSON.stringify({stage:basename(stage),previous:basename(previous)}));
  try{renameSync(data,previous);renameSync(stage,data);}
  catch(error){if(!existsSync(data)&&existsSync(previous))renameSync(previous,data);if(existsSync(data))rmSync(marker);throw error;}
  rmSync(marker);return previous;
}
