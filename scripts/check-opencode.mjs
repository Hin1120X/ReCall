import { mkdir } from 'node:fs/promises';
import { resolve } from 'node:path';
import { getOpenCodeSettings, checkOpenCode } from '../src/opencode.ts';
const directory = resolve('.local-data'); await mkdir(directory,{recursive:true});
const settings = getOpenCodeSettings(directory);
// 命令行测试可指定已有模型；应用设置仍可留空沿用 OpenCode 默认值。
if (process.argv[2]) settings.model = process.argv[2];
console.log(JSON.stringify(await checkOpenCode(directory,settings),null,2));
