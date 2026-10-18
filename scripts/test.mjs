import {mkdirSync,readdirSync} from 'node:fs';
import {resolve,join} from 'node:path';
import {spawnSync} from 'node:child_process';
const temporary=resolve('.cache','test-temp');mkdirSync(temporary,{recursive:true});
const tests=readdirSync('tests').filter(file=>file.endsWith('.test.ts')).map(file=>join('tests',file));
const result=spawnSync(process.execPath,['--test',...tests],{stdio:'inherit',env:{...process.env,TEMP:temporary,TMP:temporary},windowsHide:true});
if(result.error)throw result.error;process.exitCode=result.status??1;
