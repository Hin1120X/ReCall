import type { Item, Suggestion } from './shared.ts';
export const stateNames={ready:'待推进',active:'进行中',paused:'已暂停',waiting:'等待中',done:'已完成'};
export const quadrantNames=['重要且紧急','重要不紧急','紧急不重要','不重要不紧急'];
export function localSuggestions(items:Item[],now=Date.now()):Suggestion[]{
  return items.flatMap((item,index)=>{
    const reminder=item.reminder?Date.parse(item.reminder):NaN,deadline=item.deadline?Date.parse(item.deadline):NaN;
    if(!['ready','active','waiting'].includes(item.state)||item.state==='waiting'&&!(reminder<=now))return [];
    const dates=[reminder<=now?reminder:NaN,deadline<=now+3*86400000?deadline:NaN].filter(Number.isFinite),due=dates.length?Math.min(...dates):null;
    const progress=item.lastProgressAt?Date.parse(item.lastProgressAt):NaN,urgent=item.quadrant===0||item.quadrant===2,important=item.quadrant===0||item.quadrant===1;
    const rank=due!==null?0:urgent?1:Number.isFinite(progress)?2:important?3:4;
    const reason=due!==null?(item.state==='waiting'?'到时间跟进了':deadline===due?(deadline<now?'已过截止时间':'3天内截止'):'到提醒时间了'):urgent?'你标记为紧急':Number.isFinite(progress)?'接着最近一次推进':important?'你标记为重要':'可以从这里继续';
    const latest=item.notes.filter(note=>['checkpoint','progress'].includes(note.kind)&&Number.isFinite(Date.parse(note.createdAt))).sort((a,b)=>Date.parse(b.createdAt)-Date.parse(a.createdAt))[0];
    const context:Suggestion['context']=latest?{text:latest.text,source:latest.kind==='checkpoint'?'checkpoint':'progress',createdAt:latest.createdAt}:item.resumeNote?{text:item.resumeNote,source:'saved',createdAt:null}:null;
    return [{item,reason,context,rank,date:due??(Number.isFinite(progress)?-progress:0),index}];
  }).sort((a,b)=>a.rank-b.rank||(a.rank===0||a.rank===2?a.date-b.date:0)||a.index-b.index).slice(0,3).map(({item,reason,context})=>({item,reason,context}));
}
export function candidates(items:(Item&{aiReason?:string})[],now=Date.now()) {
  const day=86400000;
  const positions=new Map(items.map((item,index)=>[item.id,index]));
  const ranked=items.filter(item=>item.state!=='done').flatMap(item=>{
    const soon=!!item.deadline&&Date.parse(item.deadline)<=now+3*day;
    const review=!!item.reminder&&Date.parse(item.reminder)<=now;
    if(item.state==='waiting'&&!review)return [];
    if(item.reminder&&Date.parse(item.reminder)>now&&!soon)return [];
    const idle=Math.max(0,Math.floor((now-Date.parse(item.lastProgressAt??item.createdAt))/day));
    const neglected=item.quadrant===1&&idle>=7;
    const group=item.state==='waiting'?'followup':soon||item.quadrant===0?'urgent':'advance';
    const rank=soon||item.quadrant===0?0:review?1:neglected?2:item.quadrant===1?3:item.quadrant===2?4:item.quadrant===null?5:6;
    const reason=item.state==='waiting'?'到时间跟进了'+(item.waitingFor?' · '+item.waitingFor:''):soon?(Date.parse(item.deadline!)<now?'已过截止时间':'3 天内截止'):review?'到时间回来看看':neglected?`已有 ${idle} 天未推进`:item.quadrant===0?'重要且紧急':item.inbox?'待整理，先明确下一步':item.state==='paused'?'从上次保存的现场继续':item.quadrant===1?'为重要事项往前推进一步':'可以继续推进';
    return [{...item,reason,group,rank}];
  });
  // AI 输入顺序仅作为同组参考；到期与状态规则每次刷新都重新计算。
  return ranked.sort((a,b)=>a.rank-b.rank||(a.rank===0&&a.deadline&&b.deadline?Date.parse(a.deadline)-Date.parse(b.deadline):0)||positions.get(a.id)!-positions.get(b.id)!);
}
