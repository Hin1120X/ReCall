import {cp,mkdir,rename,writeFile,readFile,readdir,stat,rm} from 'node:fs/promises';
import {join,resolve,relative,dirname} from 'node:path';
import {execFileSync} from 'node:child_process';
import {createHash} from 'node:crypto';
import {createReadStream} from 'node:fs';
const metadata=JSON.parse(await readFile('package.json','utf8'));
if(!/^\d+\.\d+\.\d+$/.test(metadata.version))throw new Error('发布版本号无效');
const target=resolve(`release/Recall-${metadata.version}`);
try{await stat(target);throw new Error('版本目录已存在，未覆盖；请先保留旧包或改用新版本号');}catch(error){if(error.code!=='ENOENT')throw error;}
try{await stat(join(target,'data'));throw new Error('暂存目录含用户数据，停止打包，未覆盖数据');}catch(error){if(error.code!=='ENOENT')throw error;}
const {default:electronPath}=await import('electron');
if(!(await stat(electronPath)).isFile())throw new Error('Electron 运行文件未就绪，停止打包');
await mkdir(join(target,'resources/app/node_modules'),{recursive:true});
await cp(dirname(electronPath),target,{recursive:true});
await rename(join(target,'electron.exe'),join(target,'Recall.exe'));
const appDirectory=join(target,'resources/app');
await cp('dist',join(appDirectory,'dist'),{recursive:true});
await writeFile(join(appDirectory,'package.json'),JSON.stringify({name:'recall',productName:'Recall',version:metadata.version,main:'dist/main.cjs',dependencies:metadata.dependencies},null,2));
for(const name of ['uiohook-napi','node-gyp-build'])await cp(join('node_modules',name),join(appDirectory,'node_modules',name),{recursive:true});
await writeFile(join(target,'使用说明.txt'),"Recall "+metadata.version+"\n\n首次部署：解压整个目录，双击 Recall.exe，无需 Node.js/npm/Git。\n双击 Shift 或 Ctrl+Alt+Space 呼起。直接输入检索任务、链接、地址或别名；Tab 在全部/待办/链接间切换，Shift+Tab 反向。\n输入 #分组名并确认后在组内检索；分组由你创建。空输入按↓展开一项主建议和两项备选，显示本地依据、现场和下一步。\n输入开头的 +，Tab 选择新增待办/链接，Enter 进入录入；搜索中 Ctrl+Enter 新建待办。\n待办只写正文；链接粘贴网址或完整本地路径后，必须自己填写名称再保存，分组可选。未取名不会创建，也不会自动追加重名序号。无结果时Enter不创建。\nEnter 打开选中任务或链接，Esc收起；草稿保存在本机。关闭窗口只收起，托盘退出才结束程序。\n工作台保留未完成/已完成两个任务视图，等待、暂停和未来提醒仍可找到；属性以标签呈现，点击弹窗修改。\n留断点保存现场、可选下一步和历史，不自动算推进。只有明确追加实际进展才更新推进时间。\n链接、别名、分组与相关人在工作台集中维护；原位资料不搬动。外观跟随Windows明暗；磨砂不支持时使用实底。\n中文字体及许可证保存在 resources/app/dist/fonts 中。\n\n数据目录：%LOCALAPPDATA%\\Recall\\data\\\n备份目录：%LOCALAPPDATA%\\Recall\\backups\\\n程序包不含任务、附件、草稿或OpenCode认证。升级先备份再增量迁移，拒绝写入更高版本数据库。\n升级只替换程序，保留办公室的数据目录；0.4起可在设置与数据选择较新完整离线ZIP升级。\n手动升级前保存草稿并从托盘退出旧版，再解压新版、更新快捷方式，不要同时运行两个版本。\n自动/手动完整备份与恢复均在设置与数据中操作；恢复回到备份时点，不合并之后的记录，恢复前先保全当前完整数据。\n原位引用只保存路径，外部文件需单独备份。不要用旧库覆盖当前库。程序需后台运行才能通知，到期事项在重启后补查。\nOpenCode使用办公室本机自己的路径、认证和所选模型，只在主动分析时发送已保存文字和用户属性。\n快捷检索、建议、记录及保存不依赖模型；本版不接入翻译及缩略语数据源。\n");
const manifest=[];
async function digest(path){const hash=createHash('sha256');for await(const chunk of createReadStream(path))hash.update(chunk);return hash.digest('hex');}
async function walk(directory){for(const entry of await readdir(directory,{withFileTypes:true})){const path=join(directory,entry.name);if(entry.isDirectory())await walk(path);else if(entry.name!=='files.sha256.json')manifest.push({path:relative(target,path).replaceAll('\\','/'),sha256:await digest(path)});}}
await walk(target);await writeFile(join(target,'files.sha256.json'),JSON.stringify({version:metadata.version,files:manifest},null,2));
const archive=resolve(`release/Recall-${metadata.version}-Windows-${process.arch}.zip`);
await rm(archive,{force:true});
execFileSync('powershell.exe',['-NoProfile','-Command',"$ErrorActionPreference='Stop'; Add-Type -AssemblyName System.IO.Compression.FileSystem; [System.IO.Compression.ZipFile]::CreateFromDirectory($env:RECALL_PACKAGE_DIR,$env:RECALL_PACKAGE_ZIP,[System.IO.Compression.CompressionLevel]::Optimal,$true)"],{env:{...process.env,RECALL_PACKAGE_DIR:target,RECALL_PACKAGE_ZIP:archive},windowsHide:true});
await writeFile(archive+'.sha256',(await digest(archive))+'\n');
console.log(JSON.stringify({program:join(target,'Recall.exe'),archive,version:metadata.version,files:manifest.length,dataIncluded:false}));
