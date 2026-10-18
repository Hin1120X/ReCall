import { isAbsolute, basename, normalize, extname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { statSync } from 'node:fs';
export function referenceTarget(value:string) {
  if(typeof value!=='string'||!value.trim()||value.length>32767)throw new Error('资料地址无效');
  let target=value.trim().replace(/^"(.*)"$/,'$1');
  if(/^https?:\/\//i.test(target)){
    const url=new URL(target);if(url.username||url.password)throw new Error('请使用不含登录凭据的链接');
    return {target:url.href,name:url.hostname+url.pathname,kind:'url' as const};
  }
  if(/^file:/i.test(target))target=fileURLToPath(target);
  if(!isAbsolute(target)||! /^[a-z]:[\\/]/i.test(target))throw new Error('请粘贴本地完整路径或 http/https 链接');
  target=normalize(target);
  let stats;try{stats=statSync(target);}catch{throw new Error('本地资料不存在或无法访问');}
  if(!stats.isFile()&&!stats.isDirectory())throw new Error('资料不是普通文件或文件夹');
  return {target,name:basename(target)||target,kind:stats.isDirectory()?'folder' as const:'file' as const};
}
export function checkOpenFile(path:string){
  if(/\.(exe|com|cmd|bat|ps1|vbs|js|jse|wsf|lnk|url|hta|reg|msi|scr)$/i.test(extname(path)))throw new Error('此类程序或脚本不能通过资料入口启动，请在文件管理器中确认后操作');
}
