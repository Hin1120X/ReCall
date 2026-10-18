import type { Analysis, Item } from './shared.ts';
export function renderAnalyses(container: HTMLElement, records: Analysis[], items: Item[] = []) {
  container.replaceChildren();
  if (!records.length) { const p=document.createElement('p');p.className='muted';p.textContent='还没有分析记录。';container.append(p); }
  const names=new Map(items.map(item=>[item.id,item.text||'附件事项']));
  for(const row of records){
    const article=document.createElement('article');article.className='analysis-record';
    const meta=document.createElement('small');
    meta.textContent=[row.kind==='approach'?'怎么开展':'优先级建议',{running:'正在分析',succeeded:'已保存',failed:'失败'}[row.state],new Date(row.createdAt).toLocaleString(),row.model||'OpenCode 默认模型'].join(' · ');
    const content=document.createElement('pre');content.textContent=row.state==='running'?'收起窗口后仍继续分析。':row.error||row.output;
    if(row.state==='succeeded'&&row.kind==='priority'&&!row.itemId){
      try{content.textContent=JSON.parse(row.output.trim().replace(/^\x60\x60\x60(?:json)?\s*/i,'').replace(/\s*\x60\x60\x60$/,'')).map((entry:{id:string;reason:string},index:number)=>(index+1)+'. '+(names.get(entry.id)??'历史事项')+'\n'+entry.reason).join('\n\n');}catch{}
    }
    article.append(meta,content);container.append(article);
  }
}
