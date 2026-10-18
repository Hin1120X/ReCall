import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync, readFileSync, readdirSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { Store } from '../src/store.ts';
import { doubleShift } from '../src/double-shift.ts';
import { openCodeReply } from '../src/opencode.ts';
import { AnalysisService, parseTodoOrder, todoContext } from '../src/analysis.ts';
import { referenceTarget, checkOpenFile } from '../src/references.ts';
import { DatabaseSync } from 'node:sqlite';
import type { SaveInput } from '../src/shared.ts';

test('OpenCode 返回服务限制时提示选择模型，其他错误保留，成功需要有效回复', () => {
  const event = (message: string) => JSON.stringify({ type: 'error', error: { message } });
  assert.throws(() => openCodeReply(event("Error from provider (Console): OpenCode's free tier can only be used from within OpenCode")), /已响应.*选择.*认证/);
  assert.throws(() => openCodeReply(event('认证过期')), /认证过期/);
  assert.throws(() => openCodeReply(''), /未收到有效/);
  assert.equal(openCodeReply(JSON.stringify({ type: 'text', part: { text: 'Recall 连接可用。' } })), 'Recall 连接可用。');
});

test('分析只由点击请求启动，结果独立持久化，中断可恢复，排序不得遗漏或编造事项', () => {
  const path = mkdtempSync(join(tmpdir(),'recall-analysis-'));
  let store = new Store(path);
  try {
    const item=store.save({id:null,expectedUpdatedAt:null,text:'无敏感样例：整理书桌',quadrant:1,reminder:null,deadline:'2026-12-01T00:00:00.000Z',folder:'D:\\private-folder',pending:[]},[{name:'private-attachment.md',bytes:new Uint8Array([1])}]);
    const service=new AnalysisService(store,()=>({executable:'',model:''}));
    assert.equal(service.list().items.length,1);assert.equal(store.analyses(null).length,0,'浏览列表不得启动分析');
    const context=todoContext([item]);assert.ok(!context.includes('private-folder'));assert.ok(!context.includes('private-attachment'));assert.ok(context.includes(item.deadline!));assert.ok(context.includes('重要不紧急'));
    const ranking=[{id:item.id,reason:'重要但不紧急'}];assert.deepEqual(parseTodoOrder(JSON.stringify(ranking),[item.id]),ranking);
    assert.throws(()=>parseTodoOrder('[]',[item.id]));
    assert.throws(()=>parseTodoOrder(JSON.stringify([{id:'unknown',reason:'猜测'}]),[item.id]));
    assert.throws(()=>parseTodoOrder(JSON.stringify([ranking[0],ranking[0]]),[item.id,'other']));
    assert.throws(()=>todoContext(Array(101).fill(item)),/范围/);
    const done=store.startAnalysis({kind:'approach',itemId:item.id},'sample/model','test');
    store.finishAnalysis(done.id,'先清理桌面，再分类物品','test-version');
    const interrupted=store.startAnalysis({kind:'priority',itemId:null},'sample/model','test');
    service.stop();store.close();store=new Store(path);
    assert.equal(store.analyses(item.id)[0].output,'先清理桌面，再分类物品');
    assert.equal(store.analyses(null)[0].id,interrupted.id);assert.equal(store.analyses(null)[0].state,'failed');
    assert.match(store.analyses(null)[0].error,/中断/);assert.deepEqual(store.get(item.id),item,'分析不得改写用户记录或推进状态');
  } finally {store.close();rmSync(path,{recursive:true,force:true});}
});

test('持久保存，按 ID 修改，附件不依赖原文件，属性不算推进，失败不丢数据', () => {
  const path = mkdtempSync(join(tmpdir(), 'recall-test-'));
  let store = new Store(path);
  try {
    const source = join(path, 'source.md'); writeFileSync(source, '# 测试材料');
    const input: SaveInput = { id: null, expectedUpdatedAt: null, text: '插座方案 100%_中文', quadrant: 1, reminder: null, deadline: null, folder: path, pending: [] };
    const original = store.save(input, [{ name: 'source.md', source }]);
    rmSync(source); store.close(); store = new Store(path);
    const recovered = store.get(original.id);
    assert.equal(recovered.text, input.text);
    assert.equal(readFileSync(store.attachmentPath(original.id, recovered.attachments[0].id).path, 'utf8'), '# 测试材料');
    assert.equal(store.search('100%_').length, 1);
    assert.equal(store.search('source.md').length, 1);
    const updated = store.save({ ...input, id: original.id, expectedUpdatedAt: recovered.updatedAt, text: '插座方案已补充', deadline: '2026-12-01T01:00:00.000Z' }, []);
    assert.equal(store.search('').length, 1); assert.equal(updated.lastProgressAt, null); assert.equal(updated.attachments.length, 1);
    assert.throws(() => store.save({ ...input, id: original.id, expectedUpdatedAt: recovered.updatedAt }, []), /发生变化/);
    const before = readdirSync(join(path, 'attachments'));
    assert.throws(() => store.save({ ...input, text: '失败记录' }, [{ name: 'first.txt', bytes: new Uint8Array([1]) }, { name: 'missing.txt', source: join(path, 'missing') }]));
    assert.equal(store.search('').length, 1); assert.deepEqual(readdirSync(join(path, 'attachments')), before);
    assert.throws(() => store.save({ ...input, text: '' }, []), /加入附件/);
    const attachmentOnly = store.save({ ...input, text: '' }, [{ name: '截图.png', bytes: new Uint8Array([1, 2]) }]);
    assert.equal(attachmentOnly.text, ''); assert.equal(attachmentOnly.attachments.length, 1);
    assert.throws(() => store.save({ ...input, quadrant: 9 }, []), /象限无效/);
    assert.throws(() => store.save({ ...input, reminder: 'tomorrow' }, []), /时间无效/);
  } finally { store.close(); rmSync(path, { recursive: true, force: true }); }
});
test('双击 Shift 只响应两次轻按，排除重复、长按、组合键和插入其他按键', () => {
  let calls = 0;
  const detect = doubleShift(() => calls++, [42, 54]);
  detect('down', 42, false, 0); detect('down', 42, false, 5); detect('up', 42, false, 20);
  detect('down', 54, false, 100); detect('up', 54, false, 120); assert.equal(calls, 1);
  detect('down', 42, false, 1000); detect('up', 42, false, 1600);
  detect('down', 42, false, 1700); detect('up', 42, false, 1720); assert.equal(calls, 1);
  detect('down', 42, false, 1800); detect('down', 30, false, 1810); detect('up', 42, false, 1820);
  detect('down', 42, false, 1900); detect('up', 42, false, 1920); assert.equal(calls, 1);
  detect('down', 42, true, 2000); detect('up', 42, true, 2020);
  detect('down', 42, false, 2100); detect('up', 42, false, 2120); assert.equal(calls, 1);
  detect('cancel', 0, false, 2150);
  detect('down', 42, false, 2200); detect('up', 42, false, 2220); assert.equal(calls, 1);
});

test('兼容旧库；追加记录、实际进展和资料分类独立保存，失败整笔回滚',()=>{
  const path=mkdtempSync(join(tmpdir(),'recall-notes-'));let store:Store|undefined;
  try{
    const old=new DatabaseSync(join(path,'recall.sqlite'));
    old.exec("CREATE TABLE items(id TEXT PRIMARY KEY,text TEXT NOT NULL,quadrant INTEGER,reminder TEXT,deadline TEXT,folder TEXT,createdAt TEXT NOT NULL,updatedAt TEXT NOT NULL,lastProgressAt TEXT);CREATE TABLE attachments(id TEXT PRIMARY KEY,itemId TEXT NOT NULL,name TEXT NOT NULL,path TEXT NOT NULL);");
    old.prepare('INSERT INTO items VALUES(?,?,?,?,?,?,?,?,?)').run('legacy','旧记录',1,null,null,null,'2026-10-01T00:00:00.000Z','2026-10-01T00:00:00.000Z',null);old.close();
    store=new Store(path);const original=store.get('legacy');assert.equal(original.notes.length,0);
    const file=join(path,'source.txt');writeFileSync(file,'资料原文');
    const note=store.addNote('legacy','补充背景','note',[{name:'source.txt',source:file}]);assert.equal(note.lastProgressAt,null);assert.equal(note.text,original.text);assert.equal(note.attachments[0].role,'input');
    store.classifyAttachment('legacy',note.attachments[0].id,'result');assert.equal(store.get('legacy').attachments[0].role,'result');
    const progress=store.addNote('legacy','已完成分类','progress',[]);assert.ok(progress.lastProgressAt);
    const request=store.addNote('legacy','请建议下一步','request',[]);assert.equal(request.lastProgressAt,progress.lastProgressAt);assert.equal(request.quadrant,1);
    store.addReference('legacy',file,'input');store.addReference('legacy','https://example.com/guide','result');
    const saved=store.get('legacy');assert.equal(saved.references[0].target,file);assert.equal(saved.references[1].role,'result');assert.equal(readFileSync(file,'utf8'),'资料原文');
    const context=todoContext([saved]);assert.ok(context.includes('补充背景'));assert.ok(!context.includes(file));assert.ok(!context.includes('example.com'));
    const before=readdirSync(join(path,'attachments'));assert.throws(()=>store!.addNote('legacy','失败追加','progress',[{name:'a.txt',bytes:new Uint8Array([1])},{name:'missing',source:join(path,'absent')}]));assert.deepEqual(store.get('legacy'),saved);assert.deepEqual(readdirSync(join(path,'attachments')),before);
    assert.throws(()=>store!.addNote('legacy','','progress',[]));assert.throws(()=>store!.addReference('legacy','javascript:alert(1)','input'));assert.throws(()=>referenceTarget('https://user:password@example.com'));assert.throws(()=>checkOpenFile('C:\\test.exe'));assert.doesNotThrow(()=>checkOpenFile(file));
    assert.equal(store.search('补充背景').length,1);assert.equal(store.search('example.com').length,1);
    store.close();store=new Store(path);assert.deepEqual(store.get('legacy'),saved);
  }finally{store?.close();rmSync(path,{recursive:true,force:true});}
});
