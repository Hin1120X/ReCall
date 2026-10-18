import type { Note, Item } from './shared.ts';
export function renderNotes(container:HTMLElement,notes:Note[],item?:Item) {
  container.replaceChildren();
  for(const note of notes){const row=document.createElement('article');row.className='analysis-record';const meta=document.createElement('small');meta.textContent=(({note:'备注 / 背景 / 想法',progress:'实际进展',request:'分析诉求',checkpoint:'工作断点'} as Record<string,string>)[note.kind]??'其他记录 · '+note.kind)+' · '+new Date(note.createdAt).toLocaleString();const text=document.createElement('pre');text.textContent=note.text;row.append(meta,text);if(item)for(const file of item.attachments.filter(file=>file.noteId===note.id)){const button=document.createElement('button');button.textContent='附件 · '+file.name;const feedback=document.createElement('small');feedback.setAttribute('role','status');button.onclick=()=>void window.recall.openAttachment(item.id,file.id).catch(error=>{feedback.textContent=String(error);});row.append(button,feedback);}container.append(row);}
  if(!notes.length){const p=document.createElement('p');p.className='muted';p.textContent='还没有追加记录。';container.append(p);}
}
export function renderReferences(container:HTMLElement,item:Item){
  container.replaceChildren();
  for(const ref of item.references){const row=document.createElement('div');row.className='reference-row';const button=document.createElement('button');button.textContent=(ref.role==='input'?'输入资料':'中间结果')+' · '+ref.name;button.title=ref.target;button.onclick=()=>void window.recall.openReference(item.id,ref.id).catch(error=>{status.textContent=String(error);});const path=document.createElement('small');path.textContent=(ref.kind==='url'?'网页链接':'原位置引用')+' · '+ref.target;const status=document.createElement('small');status.setAttribute('role','status');row.append(button,path,status);container.append(row);}
}
