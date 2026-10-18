import {test} from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {Store} from '../src/store.ts';
import {nextOccurrence,recurrenceRule} from '../src/recurrence.ts';
import type {SaveInput} from '../src/shared.ts';

const local=(year:number,month:number,day:number,hour=9,minute=0)=>new Date(year,month-1,day,hour,minute).toISOString();
const fresh:SaveInput={id:null,expectedUpdatedAt:null,text:'无敏感周期样例',quadrant:1,reminder:local(2026,1,31),deadline:null,folder:null,pending:[]};

test('固定日历周期保留本地时间、每周间隔，漏期只安排一个未来日期',()=>{
  assert.equal(nextOccurrence({kind:'daily',every:1,anchor:local(2026,1,1)},local(2026,1,1),local(2026,1,5,10)),local(2026,1,6));
  assert.equal(nextOccurrence({kind:'weekly',every:2,anchor:local(2026,1,5)},local(2026,1,5),local(2026,2,2,10)),local(2026,2,16));
  assert.equal(nextOccurrence({kind:'interval',every:3},local(2026,1,1),local(2026,1,20,15,40)),local(2026,1,23,15,40));
  assert.throws(()=>recurrenceRule({kind:'daily',every:0}),/周期/);assert.throws(()=>recurrenceRule({kind:'weekly',every:366}),/周期/);assert.throws(()=>recurrenceRule({kind:'monthly',every:1,anchor:'bad'}),/起点/);
});

test('月末保持原始日，二月截断后回到31号；闰年与跨年正确',()=>{
  const rule={kind:'monthly' as const,every:1,anchor:local(2026,1,31)};
  assert.equal(nextOccurrence(rule,local(2026,1,31),local(2026,2,1)),local(2026,2,28));
  assert.equal(nextOccurrence(rule,local(2026,2,28),local(2026,2,28,10)),local(2026,3,31));
  assert.equal(nextOccurrence({kind:'monthly',every:1,anchor:local(2028,1,31)},local(2028,1,31),local(2028,2,1)),local(2028,2,29));
  assert.equal(nextOccurrence({kind:'monthly',every:2,anchor:local(2026,11,30)},local(2026,11,30),local(2026,12,1)),local(2027,1,30));
});

test('完成生成独立下一期，保留每期历史、组人资料与未知字段，撤销再完成不重复',()=>{
  const root=mkdtempSync(join(tmpdir(),'recall-recurrence-')),data=join(root,'data');let store=new Store(data,{backups:join(root,'backups')});
  const originalNow=Date.now;let clock=Date.parse(local(2026,1,1));Date.now=()=>clock;
  try{
    const group=store.saveCatalog({id:null,kind:'group',name:'报表负责人'}),person=store.saveCatalog({id:null,kind:'person',name:'小王'}),resource=store.saveCatalog({id:null,kind:'resource',name:'报表模板',target:'https://example.com/template'});
    let item=store.save({...fresh,deadline:local(2026,2,2),recurrence:{kind:'monthly',every:1},groupIds:[group.id],personIds:[person.id],resourceIds:[resource.id],extra:{version:1,fields:{future:{keep:'yes'}}}},[{name:'本期结果.txt',bytes:Buffer.from('本期输出')}]);
    store.addReference(item.id,'https://example.com/report','input');store.addNote(item.id,'本期完成记录','progress',[]);item=store.get(item.id);
    clock=Date.parse(local(2026,2,1,10));const done=store.setState(item.id,'done',item.updatedAt);
    let next=store.todos()[0];assert.equal(store.items().length,2);assert.notEqual(next.id,item.id);assert.equal(next.reminder,local(2026,2,28));assert.equal(next.seriesId,item.id);assert.equal(next.recurrence?.anchor,local(2026,1,31));
    assert.deepEqual(next.groupIds,[group.id]);assert.deepEqual(next.personIds,[person.id]);assert.deepEqual(next.resourceIds,[resource.id]);assert.deepEqual(next.extra?.fields.future,{keep:'yes'});assert.equal(next.text,item.text);assert.equal(next.quadrant,1);
    assert.equal(next.notes.length,0);assert.equal(next.attachments.length,0);assert.equal(next.references.length,1);assert.equal(next.deadline,null);assert.equal(next.lastProgressAt,null);assert.equal(next.nextStep,'');
    assert.equal(store.get(item.id).notes.length,1);assert.equal(store.get(item.id).attachments.length,1);
    store.close();store=new Store(data,{backups:join(root,'backups')});assert.equal(store.items().length,2);
    let reopened=store.setState(item.id,'ready',done.updatedAt);assert.equal(store.items().length,2);store.setState(item.id,'done',reopened.updatedAt);assert.equal(store.items().length,2,'重新完成旧期不得再生成一份下一期');
    next=store.get(next.id);clock=Date.parse(local(2026,2,28,10));store.setState(next.id,'done',next.updatedAt);assert.equal(store.items().length,3);assert.equal(store.todos()[0].reminder,local(2026,3,31));assert.equal(store.todos()[0].seriesId,item.id);
  }finally{Date.now=originalNow;store.close();rmSync(root,{recursive:true,force:true});}
});

test('周期变更与清除可保留草稿，缺少提醒拒绝保存，单次事务失败不生成下一期',()=>{
  const root=mkdtempSync(join(tmpdir(),'recall-recurrence-draft-')),store=new Store(join(root,'data'),{backups:join(root,'backups')});
  try{
    let item=store.save({...fresh,recurrence:{kind:'daily',every:1}},[]);
    store.saveDraft('capture',{text:'',pending:[],recurrence:{kind:'weekly',every:1}});assert.ok(store.drafts().capture);store.saveDraft('capture',{text:'新正文',pending:[]});assert.equal(store.drafts().capture.recurrence?.kind,'weekly');
    store.saveDraft('edit:'+item.id,{...item,pending:[],recurrence:null});assert.equal(store.drafts()['edit:'+item.id].recurrence,null);
    assert.throws(()=>store.save({...fresh,reminder:null,recurrence:{kind:'daily',every:1}},[]),/提醒/);
    assert.throws(()=>store.save({...item,expectedUpdatedAt:item.updatedAt,pending:[],state:'done'},[{name:'失败附件',source:join(root,'missing')}]),/ENOENT/);assert.equal(store.items().length,1);assert.equal(store.get(item.id).state,'ready');
    item=store.save({...item,expectedUpdatedAt:item.updatedAt,pending:[],recurrence:null},[]);const done=store.setState(item.id,'done',item.updatedAt);assert.equal(store.items().length,1);assert.equal(done.recurrence,null);
  }finally{store.close();rmSync(root,{recursive:true,force:true});}
});
