import type {RecurrenceRule} from './shared.ts';

export function recurrenceRule(value:RecurrenceRule|null|undefined):RecurrenceRule|null {
  if(value==null)return null;
  if(!['daily','weekly','monthly','interval'].includes(value.kind)||!Number.isInteger(value.every)||value.every<1||value.every>365)throw new Error('周期规则无效，请选择1至365的间隔');
  if(value.anchor!==undefined&&(typeof value.anchor!=='string'||!value.anchor.endsWith('Z')||!Number.isFinite(Date.parse(value.anchor))))throw new Error('周期起点无效');
  return {kind:value.kind,every:value.every,...(value.anchor?{anchor:value.anchor}:{})};
}

export function nextOccurrence(rule:RecurrenceRule,reminder:string,completedAt:string):string {
  recurrenceRule(rule);
  const completed=new Date(completedAt),scheduled=new Date(reminder),anchor=new Date(rule.anchor??reminder);
  if([completed,scheduled,anchor].some(value=>!Number.isFinite(value.getTime())))throw new Error('周期时间无效');
  if(rule.kind==='interval'){
    completed.setDate(completed.getDate()+rule.every);
    return completed.toISOString();
  }
  const after=Math.max(completed.getTime(),scheduled.getTime());
  const calendarDay=(date:Date)=>Date.UTC(date.getFullYear(),date.getMonth(),date.getDate())/86400000;
  const distance=rule.kind==='monthly'?(completed.getFullYear()-anchor.getFullYear())*12+completed.getMonth()-anchor.getMonth():calendarDay(completed)-calendarDay(anchor);
  const step=rule.every*(rule.kind==='weekly'?7:1);
  let period=Math.max(1,Math.floor(distance/step));
  for(;;period++){
    const next=new Date(anchor);
    if(rule.kind==='monthly'){
      next.setDate(1);next.setMonth(anchor.getMonth()+period*step);
      const last=new Date(next.getFullYear(),next.getMonth()+1,0).getDate();
      next.setDate(Math.min(anchor.getDate(),last));
    }else next.setDate(anchor.getDate()+period*step);
    if(!Number.isFinite(next.getTime()))throw new Error('周期日期超出支持范围');
    if(next.getTime()>after)return next.toISOString();
  }
}
