import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { existsSync, readdirSync, readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';
export type OpenCodeSettings = { executable: string; model: string };
const execute = promisify(execFile);
export function discoverOpenCode() {
  const root = join(process.env.APPDATA ?? '', 'ai.opencode.desktop', 'cli');
  if (existsSync(root)) for (const version of readdirSync(root).sort((a,b) => b.localeCompare(a, undefined, { numeric: true }))) {
    const path = join(root, version, 'opencode-cli.exe'); if (existsSync(path)) return path;
  }
  const bundled = join(process.env.LOCALAPPDATA ?? '', 'Programs', '@opencodedesktop', 'resources', 'opencode-cli.exe');
  return existsSync(bundled) ? bundled : '';
}
export function getOpenCodeSettings(directory: string): OpenCodeSettings {
  const file = join(directory, 'opencode-settings.json');
  if (existsSync(file)) {
    const data = JSON.parse(readFileSync(file, 'utf8'));
    if (typeof data.executable === 'string' && typeof data.model === 'string') return data;
  }
  return { executable: discoverOpenCode(), model: '' };
}
async function versionOf(executable: string) {
  if (!executable || !executable.toLowerCase().endsWith('.exe') || !existsSync(executable)) throw new Error('未找到 OpenCode v2 可执行文件，请选择桌面版配套的 opencode-cli.exe');
  const request = execute(executable, ['--version'], { windowsHide: true, timeout: 15000 });
  request.child.stdin?.end();
  const { stdout } = await request;
  if (!/v2\./.test(stdout)) throw new Error('PATH 中的旧版 1.x 与现有桌面数据库不兼容，请选择 OpenCode v2 CLI');
  return stdout.trim();
}
export async function openCodeInfo(settings: OpenCodeSettings) {
  const version = await versionOf(settings.executable);
  // v2.0.22 的 models --standalone 返回空列表；读取既有服务的模型目录。
  const request = execute(settings.executable, ['models'], { windowsHide: true, timeout: 30000, maxBuffer: 1024 * 1024 });
  request.child.stdin?.end();
  const { stdout } = await request;
  const models=stdout.split(/\r?\n/).map(s=>s.trim()).filter(s=>/^[\w.-]+\/[\w.#-]+$/.test(s));
  if(!models.length)throw new Error('OpenCode 尚未返回模型列表，请点击“读取可用模型”重试；已保存的模型保持不变');
  return { version,models };
}
export async function saveOpenCodeSettings(directory: string, settings: OpenCodeSettings) {
  if (typeof settings?.model !== 'string' || (settings.model !== '' && !/^[\w.-]+\/[\w.#-]+$/.test(settings.model))) throw new Error('模型格式应为 provider/model，留空沿用 OpenCode 默认模型');
  await versionOf(settings.executable);
  writeFileSync(join(directory, 'opencode-settings.json'), JSON.stringify(settings, null, 2));
}
export function openCodeReply(stdout: string) {
  const events = stdout.trim().split(/\r?\n/).filter(Boolean).map(line => JSON.parse(line));
  const error = events.find(event => event.type === 'error');
  const reply = events.filter(event => event.type === 'text').map(event => event.part?.text ?? '').join('');
  if (error) {
    const message = error.error?.message ?? 'OpenCode 返回错误';
    if (message.includes("free tier can only be used from within OpenCode")) throw new Error('OpenCode 已响应，但它的免费模型服务不接受 Recall 的调用。请在模型列表选择你已配置认证的模型，再检查连接。');
    throw new Error(message);
  }
  if (!reply.trim()) throw new Error('未收到有效回复');
  return reply;
}
export async function runOpenCode(directory: string, settings: OpenCodeSettings, prompt: string, system: string, title: string, signal?: AbortSignal) {
  const version = await versionOf(settings.executable);
  mkdirSync(directory, { recursive: true });
  writeFileSync(join(directory, 'opencode.json'), JSON.stringify({ snapshots: false, permissions: [{ action:'*',resource:'*',effect:'deny' }], agents: { recall: { description:'Recall',mode:'primary',system,permissions:[{ action:'*',resource:'*',effect:'deny' }] } } }));
  const args = ['run','--standalone','--format','json','--agent','recall','--title',title];
  if (settings.model) args.push('--model',settings.model);
  args.push('请根据标准输入完成请求，不使用任何工具。');
  // 正文走 stdin，避免 Windows 命令行长度限制；结束输入，避免等待到超时。
  const request = execute(settings.executable,args,{ cwd:directory,windowsHide:true,timeout:60000,maxBuffer:1024*1024,signal });
  request.child.stdin?.end(prompt);
  let stdout: string;
  try { ({ stdout } = await request); }
  catch (error) {
    const failure = error as { killed?: boolean; stdout?: string };
    if (failure.killed) throw new Error('OpenCode 请求超过 60 秒，请重试或检查所选模型');
    if (!failure.stdout?.trim()) throw new Error('OpenCode 执行失败，请检查路径、认证及模型');
    stdout = failure.stdout;
  }
  const reply = openCodeReply(stdout);
  return { version, reply };
}
export async function checkOpenCode(directory: string, settings: OpenCodeSettings) {
  const { version, reply } = await runOpenCode(join(directory,'connection-check'),settings,'仅回复 Recall 连接可用。不要使用任何工具。','只回复固定连接检查结果，不调用任何工具。','Recall connection check');
  if (!reply.includes('Recall')) throw new Error('未收到有效连接检查结果');
  const verified = { ...settings, version, verifiedAt:new Date().toISOString(), reply };
  writeFileSync(join(directory,'opencode-connection.json'),JSON.stringify(verified,null,2));
  return verified;
}
