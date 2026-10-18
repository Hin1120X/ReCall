import test from 'node:test';
import assert from 'node:assert/strict';
import {mentionAt,removeMention,flagsQuadrant,priorityFlags,captureHasContent,copyRelations,catalogMatches,cycleScope,creationSeed,captureFromSearch} from '../src/launcher-helpers.ts';

test('mentions respect word boundaries and preserve text outside the selected token',()=>{
  for(const text of ['a@example.com','https://example.com/#docs','tomorrow','photo 小王'])assert.equal(mentionAt(text,text.length),null);
  const text='准备材料 #项目交付 后续正文',caret='准备材料 #项目交付'.length;
  const mention=mentionAt(text,caret)!;assert.equal(mention.kind,'group');assert.equal(mention.query,'项目交付');assert.equal(removeMention(text,mention),'准备材料  后续正文');
  assert.equal(mentionAt('TO 小王',5)?.kind,'person');assert.equal(mentionAt('@报销模板',5)?.kind,'resource');
  assert.equal(mentionAt('事项\n@模板',6)?.start,3);
});
test('legacy priority combinations still round trip for the workbench',()=>{
  for(let q=0;q<4;q++){const f=priorityFlags(q);assert.equal(flagsQuadrant(f.urgent,f.important),q);}
});
test('relation drafts are independent copies',()=>{
  const source={groupIds:['a','a'],personIds:['p']},copied=copyRelations(source);copied.groupIds.push('b');assert.deepEqual(source.groupIds,['a','a']);assert.deepEqual(copied.resourceIds,[]);
});
test('search scopes cycle in both directions and only a leading plus enters creation',()=>{
  assert.equal(cycleScope('all'),'tasks');assert.equal(cycleScope('tasks'),'links');assert.equal(cycleScope('links'),'all');assert.equal(cycleScope('all',true),'links');assert.equal(cycleScope('links',true),'tasks');
  assert.equal(creationSeed('+'),'');assert.equal(creationSeed('+  一件事'),'一件事');assert.equal(creationSeed('＋链接'),'链接');for(const value of ['C++资料','https://example.com/?q=a+b','任意分组'])assert.equal(creationSeed(value),null);
});
test('explicit new task retains every existing draft field instead of replacing it with a query',()=>{
  const old={text:'原任务',pending:[{token:'p',name:'sample'}],quadrant:1,reminder:'2027-01-01T01:00:00Z',groupIds:['old-group'],extra:{version:1,fields:{future:{retain:true}}}};
  const restored=captureFromSearch(old,'新的搜索词',{groupIds:['new-group']});assert.equal(restored.resumed,true);assert.deepEqual(restored.value,old);restored.value.pending[0].name='changed';assert.equal(old.pending[0].name,'sample');
  const created=captureFromSearch({text:'',pending:[],extra:{version:1,fields:{}}},'搜索词',{groupIds:['g']});assert.equal(created.resumed,false);assert.equal(created.value.text,'搜索词');assert.deepEqual(created.value.groupIds,['g']);assert.equal(created.value.quadrant,undefined);assert.equal(created.value.reminder,undefined);
});
test('resource browser matches names, aliases, addresses and Chinese pinyin',()=>{
  const entry={id:'r',kind:'resource' as const,name:'报销模板',target:'D:\\Office\\template.docx',resourceKind:'file' as const,aliases:['月报'],pinned:false,archived:false,createdAt:'',updatedAt:'',lastUsedAt:null};
  for(const query of ['报销','baoxiao','bxmb','月报','yuebao','template'])assert.equal(catalogMatches(entry,query),true,query);
  assert.equal(catalogMatches(entry,'unrelated'),false);
});
test('capture prefill protects metadata-only drafts as well as text and attachments',()=>{
  for(const draft of [{text:'记下的内容'},{pending:[{token:'t',name:'sample'}]},{groupIds:['g']},{personIds:['p']},{resourceIds:['r']},{quadrant:2},{reminder:'2027-01-01T09:00'},{deadline:'2027-01-01T09:00'},{folder:'D:\\Sample'},{nextStep:'下一步'},{resumeNote:'上次现场'},{waitingFor:'等待同事'},{state:'paused' as const},{inbox:false},{recurrence:{kind:'weekly' as const,every:1}},{extra:{version:1,fields:{future:true}}}])assert.equal(captureHasContent(draft),true);
  assert.equal(captureHasContent({text:' ',pending:[],quadrant:null,groupIds:[],personIds:[],resourceIds:[],extra:{version:1,fields:{}}}),false);
});
