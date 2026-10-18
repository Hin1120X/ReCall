import test,{mock,type TestContext} from 'node:test';
import fs from 'node:fs';
import {syncBuiltinESMExports} from 'node:module';
import assert from 'node:assert/strict';
import {mkdtempSync,mkdirSync,writeFileSync,readFileSync,rmSync,existsSync,symlinkSync} from 'node:fs';
import {join,dirname} from 'node:path';
import {tmpdir} from 'node:os';
import {createHash} from 'node:crypto';
import {verifyProgram,programPath,newerVersion} from '../src/update.ts';
import {installProgram} from '../src/update-helper.ts';
function fixture(root:string,version:string,extra:Record<string,string>={}){
  mkdirSync(root,{recursive:true});const files:Record<string,string>={'Recall.exe':'sample-executable-'+version,'resources/app/package.json':JSON.stringify({version}),'resources/app/dist/update-helper.cjs':'sample-helper',...extra};
  for(const [name,body]of Object.entries(files)){mkdirSync(dirname(join(root,name)),{recursive:true});writeFileSync(join(root,name),body);}
  writeFileSync(join(root,'files.sha256.json'),JSON.stringify({version,files:Object.entries(files).map(([path,body])=>({path,sha256:createHash('sha256').update(body).digest('hex')}))}));
}
function fileLink(target:string,path:string,context:TestContext){
  try{symlinkSync(target,path,'file');}
  catch(error){
    if(process.platform!=='win32'||(error as NodeJS.ErrnoException).code!=='EPERM')throw error;
    const lstat=fs.lstatSync,stats=lstat(dirname(path));
    mock.method(fs,'lstatSync',(...args:Parameters<typeof fs.lstatSync>)=>String(args[0])===path?Object.assign(Object.create(stats),{isSymbolicLink:()=>true}):lstat(...args));syncBuiltinESMExports();
    context.diagnostic('Windows 未授予创建文件符号链接权限；本例使用 lstat 链接元数据验证同一安装拒绝路径。');
  }
}
test('离线升级清单拒绝越界、篡改、非更新版本，保留数据且可保全旧程序',async()=>{
  const root=mkdtempSync(join(tmpdir(),'recall-update-')),target=join(root,'program'),workspace=join(root,'work'),source=join(workspace,'package');
  try{
    fixture(target,'0.4.0');fixture(source,'0.5.0',{'resources/app/dist/new.js':'new'});mkdirSync(join(target,'data'));writeFileSync(join(target,'data/keep.txt'),'业务数据');
    assert.equal(newerVersion('0.5.0','0.4.0'),true);assert.equal(newerVersion('0.4.0','0.4.0'),false);assert.throws(()=>programPath(root,'../data'));assert.throws(()=>programPath(root,'D:/data'));assert.throws(()=>programPath(root,'a\\b'));
    verifyProgram(source);await installProgram(source,target,workspace);assert.equal(verifyProgram(target,true).version,'0.5.0');assert.equal(readFileSync(join(target,'data/keep.txt'),'utf8'),'业务数据');assert.equal(JSON.parse(readFileSync(join(workspace,'previous-program/resources/app/package.json'),'utf8')).version,'0.4.0');
    writeFileSync(join(source,'Recall.exe'),'tampered');await assert.rejects(()=>installProgram(source,target,workspace),/校验失败/);assert.equal(verifyProgram(target,true).version,'0.5.0');
  }finally{rmSync(root,{recursive:true,force:true});}
});
test('程序替换失败恢复旧文件，未列入发布清单的用户文件不删除',async()=>{
  const root=mkdtempSync(join(tmpdir(),'recall-update-failure-')),target=join(root,'program'),workspace=join(root,'work'),source=join(workspace,'package');
  try{
    fixture(target,'0.4.0');fixture(source,'0.5.0',{'new-program.js':'new-file'});writeFileSync(join(target,'keep.txt'),'keep');
    const copy=fs.copyFileSync;let failed=false;
    mock.method(fs,'copyFileSync',(...args:Parameters<typeof fs.copyFileSync>)=>{const [,to]=args;if(to===join(target,'new-program.js')&&!failed){failed=true;throw Object.assign(new Error('模拟磁盘写入失败'),{code:'ENOSPC'});}return copy(...args);});syncBuiltinESMExports();
    await assert.rejects(()=>installProgram(source,target,workspace),/模拟磁盘/);assert.equal(verifyProgram(target,true).version,'0.4.0');assert.equal(readFileSync(join(target,'keep.txt'),'utf8'),'keep');assert.equal(JSON.parse(readFileSync(join(workspace,'result.json'),'utf8')).status,'rolled-back');
  }finally{mock.restoreAll();syncBuiltinESMExports();rmSync(root,{recursive:true,force:true});}
});
test('新增程序路径与用户已有文件冲突时，在替换任何程序之前拒绝',async()=>{
  const root=mkdtempSync(join(tmpdir(),'recall-update-conflict-')),target=join(root,'program'),workspace=join(root,'work'),source=join(workspace,'package');
  try{fixture(target,'0.4.0');fixture(source,'0.5.0',{'my-file.txt':'program'});writeFileSync(join(target,'my-file.txt'),'user');await assert.rejects(()=>installProgram(source,target,workspace),/同名用户/);assert.equal(readFileSync(join(target,'my-file.txt'),'utf8'),'user');assert.equal(verifyProgram(target,true).version,'0.4.0');}finally{rmSync(root,{recursive:true,force:true});}
});
test('目标新增路径中的目录联接不能把更新写入业务目录',()=>{
  const root=mkdtempSync(join(tmpdir(),'recall-update-junction-')),target=join(root,'program'),data=join(root,'data');
  try{mkdirSync(target);mkdirSync(data);writeFileSync(join(data,'keep.txt'),'keep');symlinkSync(data,join(target,'linked'),'junction');assert.throws(()=>programPath(target,'linked/keep.txt'),/联接|符号链接/);assert.equal(readFileSync(join(data,'keep.txt'),'utf8'),'keep');}finally{rmSync(root,{recursive:true,force:true});}
});

test('断开的目录联接也不能作为新增程序目录',async()=>{
  const root=mkdtempSync(join(tmpdir(),'recall-update-broken-junction-')),target=join(root,'program'),workspace=join(root,'work'),source=join(workspace,'package'),outside=join(root,'missing-directory');
  try{
    fixture(target,'0.4.0');fixture(source,'0.5.0',{'linked/new.js':'new'});symlinkSync(outside,join(target,'linked'),'junction');assert.equal(existsSync(join(target,'linked')),false);
    await assert.rejects(()=>installProgram(source,target,workspace),/联接|符号链接/);assert.equal(existsSync(outside),false);assert.equal(verifyProgram(target,true).version,'0.4.0');
  }finally{rmSync(root,{recursive:true,force:true});}
});

test('断开的目标文件链接在替换前被拒绝，不创建目录外文件',async context=>{
  const root=mkdtempSync(join(tmpdir(),'recall-update-dangling-')),target=join(root,'program'),workspace=join(root,'work'),source=join(workspace,'package'),outside=join(root,'outside-new.js');
  try{
    fixture(target,'0.4.0');fixture(source,'0.5.0',{'new-program.js':'new-file'});fileLink(outside,join(target,'new-program.js'),context);
    assert.equal(existsSync(join(target,'new-program.js')),false);
    assert.throws(()=>programPath(target,'new-program.js'),/联接|符号链接/);
    await assert.rejects(()=>installProgram(source,target,workspace),/联接|符号链接/);
    assert.equal(existsSync(outside),false);assert.equal(verifyProgram(target,true).version,'0.4.0');
  }finally{mock.restoreAll();syncBuiltinESMExports();rmSync(root,{recursive:true,force:true});}
});

test('目标发布清单不能是指向目录外文件的链接',async context=>{
  const root=mkdtempSync(join(tmpdir(),'recall-update-manifest-link-')),target=join(root,'program'),workspace=join(root,'work'),source=join(workspace,'package'),outside=join(root,'outside-manifest.json');
  try{
    fixture(target,'0.4.0');fixture(source,'0.5.0');const old=readFileSync(join(target,'files.sha256.json'),'utf8');writeFileSync(outside,old);rmSync(join(target,'files.sha256.json'));fileLink(outside,join(target,'files.sha256.json'),context);
    assert.throws(()=>verifyProgram(target,true),/联接|符号链接/);
    await assert.rejects(()=>installProgram(source,target,workspace),/联接|符号链接/);
    assert.equal(readFileSync(outside,'utf8'),old);assert.equal(readFileSync(join(target,'Recall.exe'),'utf8'),'sample-executable-0.4.0');
  }finally{mock.restoreAll();syncBuiltinESMExports();rmSync(root,{recursive:true,force:true});}
});
