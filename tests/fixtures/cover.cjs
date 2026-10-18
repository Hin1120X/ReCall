const {app,BrowserWindow}=require('electron');
const {writeFileSync,mkdirSync}=require('node:fs');
const {join}=require('node:path');
const directory=process.argv[2];mkdirSync(directory,{recursive:true});app.setPath('userData',join(directory,'runtime'));
app.whenReady().then(async()=>{const window=new BrowserWindow({width:960,height:700,title:'Recall 隔离验收遮挡窗口',backgroundColor:'#e7eaf0',webPreferences:{sandbox:true,contextIsolation:true,nodeIntegration:false}});await window.loadURL('data:text/html;charset=utf-8,'+encodeURIComponent('<title>Recall 隔离验收遮挡窗口</title><h1>隔离测试窗口</h1><p>本窗口不包含用户资料。</p>'));window.show();window.focus();writeFileSync(join(directory,'ready.json'),JSON.stringify({pid:process.pid,focused:window.isFocused()}));process.on('message',message=>{if(message==='quit')app.quit();});});
