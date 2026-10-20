import type {CatalogEntry,DraftValue,Item,LinkDraft,Relations,SearchResult,SearchScope,Suggestion} from './shared.ts';
import {el,renderRelationChips,createRelationEditor} from './catalog-ui.ts';
import {linkDraftKey} from './shared.ts';
import {captureFromSearch,captureHasContent,copyRelations,creationSeed,cycleScope,localTime,mentionAt,relationKey,removeMention,type Mention} from './launcher-helpers.ts';
const api=window.recall;
const $=<T extends HTMLElement=HTMLElement>(id:string)=>document.getElementById(id) as T;
const entry=$<HTMLTextAreaElement>('entry');
type Mode='search'|'capture'|'link'|'checkpoint';
let mode:Mode='search',scope:SearchScope='all',query='',expanded=false,selected=0,menuSelected=0,ready=false,saving=false,composing=false,reopenRequested=false;
let capture:DraftValue={text:'',pending:[]},link:LinkDraft|null=null,filters=copyRelations({}),catalog:CatalogEntry[]=[],stored:Record<string,DraftValue>={};
let rows:SearchResult[]=[],suggested:Suggestion[]|null=null,loading=false,request=0,mentionRequest=0,mention:Mention|null=null,mentionRows:(CatalogEntry|null)[]=[],mentionSelected=0;
let checkpointItem:Item|null=null,checkpointDraft:DraftValue|null=null;
let lastPersistedLink:LinkDraft|null=null,linkWrites=Promise.resolve();
let linkDetailsOpen=false;
const writes=new Set<Promise<void>>(),errors=new Map<string,string>(),values=new Map<string,DraftValue|LinkDraft|null>();
const linkName=$<HTMLInputElement>('link-name');
const linkGroups=createRelationEditor($('link-groups'),{kinds:['group'],expanded:true,onChange:value=>{if(mode!=='link'||saving)return;link={...(link??{target:''}),groupIds:value.groupIds};sync();paintChips();},onError:message=>status(message,true)});
function status(message:string,error=false){$('status').textContent=message;$('status').classList.toggle('error',error);}
function retain(key:string,value:DraftValue|LinkDraft|null,force=false){
  const snapshot=structuredClone(value);if(!force&&values.has(key)&&JSON.stringify(values.get(key))===JSON.stringify(snapshot))return;values.set(key,snapshot);
  const operation=key==='link'?linkWrites.then(async()=>{await api.saveLinkDraft(snapshot as LinkDraft|null,lastPersistedLink);lastPersistedLink=structuredClone(snapshot as LinkDraft|null);}):api.saveDraft(key,snapshot as DraftValue);
  const write=operation.then(()=>{errors.delete(key);},error=>{errors.set(key,String(error));status('草稿未写入，输入仍保留：'+String(error),true);});if(key==='link')linkWrites=write;writes.add(write);void write.finally(()=>writes.delete(write));
}
function sync(){if(!ready)return;if(mode==='capture'){capture.text=entry.value;retain('capture',capture);}else if(mode==='link'){link={...(link??{}),target:entry.value,...(linkName.value||link?.name!==undefined?{name:linkName.value}:{})};retain('link',link);}else if(mode==='checkpoint'&&checkpointItem&&checkpointDraft){const text=$<HTMLTextAreaElement>('checkpoint-text').value,nextStep=$<HTMLInputElement>('checkpoint-next').value;if(text===checkpointDraft.text&&nextStep===(checkpointDraft.nextStep??''))return;checkpointDraft={...checkpointDraft,text,pending:checkpointDraft.pending??[],nextStep};stored['checkpoint:'+checkpointItem.id]=checkpointDraft;retain('checkpoint:'+checkpointItem.id,checkpointDraft);}else query=entry.value;}
async function flush(){sync();await Promise.all([...writes]);for(const key of [...errors.keys()])if(values.has(key))retain(key,values.get(key)!,true);await Promise.all([...writes]);if(errors.size)throw new Error([...errors.values()][0]);}
function hasLinkDraft(){return linkDraftKey(link)!==null;}
function menu(){return mode==='search'&&creationSeed(query)!==null;}
function view(){if(mode==='capture')return capture.pending.length?'captureAttachments':'capture';if(mode==='link')return linkDetailsOpen?'linkDetails':'link';if(mode==='checkpoint')return mode;if(menu())return 'menu';return query.trim()||expanded?'results':'search';}
function resize(){void api.view(view()).catch(error=>status(String(error),true));}
function closeMention(){mentionRequest++;mention=null;mentionRows=[];$('mention-panel').hidden=true;resize();}
function draftBadges(){$('resume-capture').hidden=mode!=='search'||!captureHasContent(capture);$('resume-link').hidden=mode!=='search'||!hasLinkDraft();}
function paintChips(){const value=mode==='capture'?capture:mode==='link'?{groupIds:link?.groupIds}:filters;$('relation-chips').hidden=mode==='checkpoint'||mode==='link'&&linkDetailsOpen||!Object.values(copyRelations(value)).some(ids=>ids.length);renderRelationChips($('relation-chips'),value,catalog,(kind,id)=>{if(saving)return;const key=relationKey(kind);if(mode==='capture')capture[key]=(capture[key]??[]).filter(candidate=>candidate!==id);else if(mode==='link')link={...(link??{target:''}),groupIds:(link?.groupIds??[]).filter(candidate=>candidate!==id)};else{filters[key]=filters[key].filter(candidate=>candidate!==id);suggested=null;void search();}paintChips();if(mode==='capture'||mode==='link')sync();});}
function paint(){
  const shown=view();document.body.dataset.mode=shown;$('search-scopes').hidden=mode!=='search'||menu();$('back-search').hidden=mode==='search';$('entry-kind').hidden=mode==='search';$('entry-kind').textContent=mode==='capture'?'新建待办':mode==='link'?'新增链接':'留断点';
  for(const name of ['all','tasks','links'] as const){$('scope-'+name).setAttribute('aria-pressed',String(scope===name));}
  entry.value=mode==='capture'?capture.text:mode==='link'?(link?.target??''):mode==='checkpoint'?'返回搜索可继续查找':query;
  entry.readOnly=mode==='checkpoint';entry.placeholder=mode==='capture'?'记下一件事，Enter 收下…':mode==='link'?'粘贴网址或本地完整路径…':'搜索待办或链接…';entry.setAttribute('aria-label',mode==='capture'?'新建待办内容':mode==='link'?'新增链接地址':mode==='checkpoint'?'返回统一搜索':'统一搜索');
  $('create-menu').hidden=!menu();$('results-panel').hidden=shown!=='results';$('capture-details').hidden=mode!=='capture'||!capture.pending.length;$('checkpoint-panel').hidden=mode!=='checkpoint';$('link-details').hidden=mode!=='link'||!linkDetailsOpen;$('link-options').hidden=mode!=='link';$('link-options').textContent=linkDetailsOpen?'收起名称 / 分组':'名称 / 分组';$('link-options').setAttribute('aria-expanded',String(linkDetailsOpen));
  if(mode==='link'){linkName.value=link?.name??'';if(JSON.stringify(linkGroups.getValue().groupIds)!==JSON.stringify(link?.groupIds??[]))linkGroups.setValue({groupIds:link?.groupIds??[]});}
  if(menu()){for(const [index,id] of ['create-task','create-link'].entries())$(id).classList.toggle('active',index===menuSelected);}
  if(mode==='capture'){const files=$('pending-files');files.replaceChildren();for(const file of capture.pending){const row=el('div',undefined,'pending-file'),remove=el('button','移除');remove.setAttribute('aria-label','移除待保存附件 '+file.name);remove.onclick=()=>void work(async()=>{await api.discard([file.token]);capture.pending=capture.pending.filter(candidate=>candidate.token!==file.token);sync();paint();});row.append(el('span',file.name),remove);files.append(row);}$('legacy-attributes').hidden=!(capture.quadrant!=null||capture.reminder||capture.deadline||capture.recurrence||capture.folder);}
  paintChips();draftBadges();resize();if(mode!=='checkpoint')entry.focus();
}
function searchHint(){status(query.trim()?'↑ ↓ 选择 · Enter 打开 · Ctrl+Enter 新建待办':'↓ 看看接下来做什么 · Tab 切换 · + 新增');}
async function refreshCatalog(){catalog=await api.catalog(undefined,'',true);paintChips();if(mode==='link')await linkGroups.refresh();}
async function search(){
  if(mode!=='search')return;const token=++request;selected=0;
  if(menu()){rows=[];loading=false;paint();status('Tab 切换新增类型 · Enter 确认');return;}
  if(!query.trim()&&!expanded){rows=[];loading=false;paint();searchHint();return;}
  loading=true;paint();status('正在查找…');$('results').replaceChildren();$('results-empty').hidden=true;
  try{
    if(!query.trim()&&scope!=='links'){
      const snapshot=suggested??await api.suggestions({groupIds:filters.groupIds,personIds:filters.personIds});if(token!==request||mode!=='search')return;suggested=snapshot;
      rows=suggested.map(value=>({kind:'task',item:value.item,match:value.reason}));
    }else{const found=await api.lookup({query,scope,groupIds:filters.groupIds,personIds:filters.personIds,limit:40});if(token!==request||mode!=='search')return;rows=found;}
    loading=false;renderResults();searchHint();
  }catch(error){if(token===request){loading=false;rows=[];renderResults();status(String(error),true);}}
}
function nameFor(id:string){return catalog.find(value=>value.id===id)?.name??'关联资料';}
function taskMeta(item:Item){return [item.deadline?'截止 '+localTime(item.deadline).replace('T',' '):'',item.reminder?'提醒 '+localTime(item.reminder).replace('T',' '):'',item.waitingFor?'等待 '+item.waitingFor:''].filter(Boolean).join(' · ');}
function renderResults(){
  selected=Math.max(0,Math.min(selected,rows.length-1));const recall=!query.trim()&&scope!=='links';$('results-heading').textContent=recall?'接下来，从这里继续':scope==='links'?'链接':scope==='tasks'?'待办':'搜索结果';$('results-count').textContent=rows.length?(recall?'本地建议 · 1 件优先，最多 2 件备选':rows.length+' 项'):'';
  const root=$('results');root.replaceChildren();$('results-empty').hidden=rows.length>0;$('results-empty').textContent=recall?'当前没有到期或适合继续的工作。输入关键词查找，或用 + 记下一件事。':'没有找到匹配项。可移除分组或人名筛选，或换个词。';
  for(const [index,row] of rows.entries()){
    const card=el('article',undefined,'search-row'+(index===selected?' active':'')+(recall&&index===0?' primary':''));if(row.kind==='task')card.dataset.itemId=row.item.id;else card.dataset.resourceId=row.entry.id;
    const open=el('button',undefined,'result-open');open.type='button';const title=el('span',undefined,'result-title');title.append(el('span',row.kind==='task'?row.item.text.split('\n')[0]||'附件事项':row.entry.name),el('span',row.kind==='task'?'待办':'链接','result-kind'));
    if(recall)open.append(el('span',index===0?'建议先处理 · '+row.match:'也可以 · '+row.match,'reason-line'));open.append(title);
    if(row.kind==='task'){
      const item=row.item,context=recall?suggested?.find(value=>value.item.id===item.id)?.context:null;if(context){const line=el('span',undefined,'context-line');line.append(el('span',context.source==='progress'?'最近实际进展':'上次停在','context-label'),document.createTextNode(context.text));open.append(line);}
      if(item.nextStep){const line=el('span',undefined,'next-line');line.append(el('span','下一步','context-label'),document.createTextNode(item.nextStep));open.append(line);}
    const meta=taskMeta(item);if(meta||!recall)open.append(el('small',[meta,!recall?row.match:''].filter(Boolean).join(' · '),'result-meta'));
      open.onclick=()=>void openRow(row);
      card.append(open);if(recall){
        const actions=el('div',undefined,'row-actions'),materials=[...(item.resourceIds??[]).map(id=>({name:nameFor(id),open:()=>api.openResource(id)})),...item.attachments.map(file=>({name:file.name,open:()=>api.openAttachment(item.id,file.id)})),...item.references.map(ref=>({name:ref.name,open:()=>api.openReference(item.id,ref.id)})),...(item.folder?[{name:'主文件夹',open:()=>api.openFolder(item.id)}]:[])];
        for(const material of materials.slice(0,3)){const resource=el('button','↗ '+material.name);resource.onclick=()=>void material.open().catch(error=>status(String(error),true));actions.append(resource);}
        if(materials.length>3){const all=el('button','全部资料 · '+materials.length);all.onclick=()=>void api.openManager(item.id).catch(error=>status(String(error),true));actions.append(all);}
        const checkpoint=el('button','留个断点','checkpoint');checkpoint.onclick=()=>void beginCheckpoint(item).catch(error=>status(String(error),true));actions.append(checkpoint);card.append(actions);
      }
    }else{open.append(el('small',row.entry.target,'result-meta'));if(row.match)open.append(el('small',row.match,'result-meta'));open.onclick=()=>void openRow(row);const actions=el('div',undefined,'row-actions'),edit=el('button','编辑名称 / 分组','link-edit');edit.onclick=()=>{if(composing||saving)return;void work(async()=>{await flush();await api.openLibrary(row.entry.id);});};actions.append(edit);card.append(open,actions);}
    root.append(card);
  }
}
async function openRow(row:SearchResult){if(loading||saving||composing)return;await work(async()=>{if(row.kind==='task')await api.openManager(row.item.id);else{await api.openResource(row.entry.id);await api.hide();}});}
async function chooseScope(next:SearchScope){if(saving||composing||mode!=='search')return;sync();closeMention();scope=next;await search();}
function returnSearch(){if(saving)return;sync();closeMention();mode='search';entry.readOnly=false;paint();void search();}
async function beginCapture(seed:string){
  if(!ready||saving||composing)return;sync();closeMention();await work(async()=>{await flush();stored=await api.drafts();const fresh=stored.capture??{text:'',pending:[]};values.set('capture',structuredClone(fresh));const result=captureFromSearch(fresh,seed,filters);capture=result.value;mode='capture';paint();sync();status(result.resumed?'已恢复原待办草稿，未覆盖内容或安排；Enter 保存 · Esc 保留':'Enter 收下 · Shift+Enter 换行 · # 分组 · @ 资料 · to 人');});
}
async function beginLink(seed:string){
  if(!ready||saving||composing)return;sync();closeMention();await work(async()=>{await flush();link=await api.linkDraft();lastPersistedLink=structuredClone(link);values.set('link',structuredClone(link));const resumed=hasLinkDraft();if(!resumed)link={target:seed,groupIds:[...filters.groupIds]};linkDetailsOpen=true;linkGroups.setValue({groupIds:link?.groupIds??[]});await linkGroups.refresh();mode='link';paint();sync();status(resumed?'已恢复原链接草稿，名称和分组均保留':'填写名称后 Enter 保存 · 分组可选');});
}
async function beginCheckpoint(item:Item){
  if(!ready||saving||composing)return;sync();closeMention();await work(async()=>{await flush();const token=++request,[current,drafts]=await Promise.all([api.item(item.id),api.drafts()]);if(token!==request||mode!=='search')return;stored=drafts;const saved=stored['checkpoint:'+item.id];checkpointItem=current;checkpointDraft={...(saved??{text:'',pending:[]}),itemId:item.id,expectedUpdatedAt:saved?.expectedUpdatedAt??current.updatedAt};values.set('checkpoint:'+item.id,structuredClone(checkpointDraft));mode='checkpoint';paint();$('checkpoint-target').textContent=current.text.split('\n')[0]||'附件事项';$<HTMLTextAreaElement>('checkpoint-text').value=checkpointDraft.text;$<HTMLInputElement>('checkpoint-next').value=checkpointDraft.nextStep??'';$('checkpoint-text').focus();status('留一句话，下次接着做 · Ctrl+Enter 保存 · Esc 保留');});}
async function work(action:()=>Promise<void>){if(saving)return;saving=true;entry.disabled=true;const fields: (HTMLInputElement|HTMLTextAreaElement|HTMLButtonElement)[]=[$<HTMLTextAreaElement>('checkpoint-text'),$<HTMLInputElement>('checkpoint-next'),...$('link-details').querySelectorAll<HTMLInputElement|HTMLButtonElement>('input,button')];for(const field of fields)field.disabled=true;try{await action();}catch(error){status('未完成，输入仍保留：'+String(error),true);}finally{saving=false;entry.disabled=!ready;for(const field of fields)field.disabled=false;if(reopenRequested){reopenRequested=false;void api.show();}else if(mode==='capture'||mode==='link')entry.focus();else if(mode==='checkpoint')$('checkpoint-text').focus();}}
async function save(){
  if(saving||composing||!ready)return;sync();if(mode==='search')return;
  if(mode==='checkpoint'&&!checkpointDraft?.text.trim()){status('请写下上次停在哪里。',true);$('checkpoint-text').focus();return;}
  if(mode==='link'&&!link?.target.trim()){status('请粘贴网址或本地完整位置。',true);entry.focus();return;}
  if(mode==='link'&&!link?.name?.trim()){linkDetailsOpen=true;paint();status('请先为链接填写名称，尚未创建。',true);linkName.focus();return;}
  if(mode==='capture'&&!capture.text.trim()&&!capture.pending.length){status('先记下一件事，或放入附件。',true);entry.focus();return;}
  await work(async()=>{
    await flush();
    if(mode==='capture'){const {pending,...fields}=capture;await api.save({...fields,id:null,expectedUpdatedAt:null,text:capture.text,quadrant:capture.quadrant??null,reminder:capture.reminder??null,deadline:capture.deadline??null,folder:capture.folder??null,pending:pending.map(file=>file.token),draftKey:'capture'});capture={text:'',pending:[]};delete stored.capture;errors.delete('capture');values.delete('capture');}
    else if(mode==='link'){await api.createLink(link!);link=null;lastPersistedLink=null;linkGroups.setValue({});errors.delete('link');values.delete('link');}
    else if(checkpointItem&&checkpointDraft){const key='checkpoint:'+checkpointItem.id;await api.checkpoint({id:checkpointItem.id,expectedUpdatedAt:checkpointDraft.expectedUpdatedAt??checkpointItem.updatedAt,text:checkpointDraft.text,...(checkpointDraft.nextStep?.trim()?{nextStep:checkpointDraft.nextStep}:{}),draftKey:key});delete stored[key];errors.delete(key);values.delete(key);checkpointItem=null;checkpointDraft=null;suggested=null;}
    mode='search';query='';expanded=false;rows=[];paint();status('已保存');await api.hide();
  });
}
function renderMentions(){
  const root=$('mention-results');root.replaceChildren();for(const [index,row] of mentionRows.entries()){const button=el('button',row?.name??('新建'+(mention!.kind==='group'?'分组':'相关人')+'“'+mention!.query+'”'));button.classList.toggle('active',index===mentionSelected);button.setAttribute('role','option');button.setAttribute('aria-selected',String(index===mentionSelected));button.onmousedown=event=>event.preventDefault();button.onclick=()=>void chooseMention(index);root.append(button);}if(!mentionRows.length)root.append(el('p','没有匹配项，原文字会保留。','helper'));$('mention-panel').hidden=false;void api.view('results');
}
async function updateMention(){
  if(composing||saving||(mode!=='search'&&mode!=='capture'))return;if(menu()){closeMention();return;}const found=mentionAt(entry.value,entry.selectionStart);if(!found){closeMention();return;}const token=++mentionRequest;
  try{const matches=await api.catalog(found.kind,found.query);if(token!==mentionRequest||composing)return;mention=found;const value=mode==='capture'?capture:filters,existing=value[relationKey(found.kind)]??[];mentionRows=matches.filter(row=>!row.archived&&!existing.includes(row.id)).slice(0,7);if(mode==='capture'&&found.kind!=='resource'&&found.query&&!matches.some(row=>row.name.toLocaleLowerCase()===found.query.toLocaleLowerCase()))mentionRows.push(null);mentionSelected=0;renderMentions();}catch(error){status(String(error),true);}
}
async function chooseMention(index:number){
  if(!mention||saving||!mentionRows.length)return;const token=mention,row=mentionRows[index],targetMode=mode;
  await work(async()=>{const chosen=row??await api.saveCatalog({id:null,kind:token.kind,name:token.query});if(targetMode==='search'&&chosen.kind==='resource'){closeMention();await api.openResource(chosen.id);await api.hide();return;}if(!catalog.some(value=>value.id===chosen.id))catalog.push(chosen);const key=relationKey(chosen.kind),target=targetMode==='capture'?capture:filters;target[key]=[...new Set([...(target[key]??[]),chosen.id])];const text=removeMention(entry.value,token);entry.value=text;if(targetMode==='capture')capture.text=text;else{query=text;expanded=true;suggested=null;}closeMention();paintChips();sync();entry.setSelectionRange(token.start,token.start);if(targetMode==='search')await search();status('已选择“'+chosen.name+'”');});entry.focus();
}
function activateMenu(){const seed=creationSeed(query)??'';if(menuSelected===0)beginCapture(seed);else beginLink(seed);}
entry.oninput=()=>{if(composing){sync();return;}sync();if(mode==='search'){if(query.trim())expanded=true;void search();}void updateMention();};
entry.addEventListener('compositionstart',()=>{composing=true;closeMention();});entry.addEventListener('compositionend',()=>{composing=false;sync();if(mode==='search'){if(query.trim())expanded=true;void search();}void updateMention();if(reopenRequested){reopenRequested=false;void api.show();}});
entry.addEventListener('click',()=>void updateMention());
entry.onkeydown=event=>{
  if(event.isComposing||composing||event.keyCode===229||saving)return;
  if(mention&&!$('mention-panel').hidden){if(event.key==='Escape'){event.preventDefault();event.stopPropagation();closeMention();return;}if(['ArrowDown','ArrowUp'].includes(event.key)){event.preventDefault();mentionSelected=Math.max(0,Math.min(mentionRows.length-1,mentionSelected+(event.key==='ArrowDown'?1:-1)));renderMentions();return;}if((event.key==='Tab'||event.key==='Enter')&&!event.ctrlKey&&!event.altKey&&!event.metaKey){event.preventDefault();event.stopPropagation();void chooseMention(mentionSelected);return;}}
  if(mode==='search'&&event.ctrlKey&&event.key==='Enter'){event.preventDefault();event.stopPropagation();beginCapture(creationSeed(query)??query);return;}
  if(mode==='link'&&event.ctrlKey&&event.key==='Enter'){event.preventDefault();event.stopPropagation();if(!linkDetailsOpen)toggleLinkDetails();else void save();return;}
  if(mode==='search'&&menu()){if(event.key==='Tab'||['ArrowDown','ArrowUp'].includes(event.key)){event.preventDefault();menuSelected=menuSelected?0:1;paint();return;}if(event.key==='Enter'){event.preventDefault();activateMenu();return;}}
  if(mode==='search'&&event.key==='Tab'&&!event.ctrlKey&&!event.altKey&&!event.metaKey){event.preventDefault();void chooseScope(cycleScope(scope,event.shiftKey));return;}
  if(mode==='search'&&['ArrowDown','ArrowUp'].includes(event.key)){event.preventDefault();if(!expanded&&!query.trim()){if(event.key==='ArrowDown'){expanded=true;void search();}return;}if(loading)return;selected=Math.max(0,Math.min(rows.length-1,selected+(event.key==='ArrowDown'?1:-1)));renderResults();$('results').querySelector('.search-row.active')?.scrollIntoView({block:'nearest'});return;}
  if(event.key==='Enter'&&!event.shiftKey){event.preventDefault();event.stopPropagation();if(mode==='search'){const row=rows[selected];if(row&&!loading)void openRow(row);}else if(mode==='capture'||mode==='link')void save();}
};
document.addEventListener('keydown',event=>{if(event.isComposing||composing||event.keyCode===229||saving)return;if(event.key==='Escape'){event.preventDefault();if(mention){closeMention();return;}sync();void api.hide().catch(error=>status(String(error),true));}if(event.key==='Enter'&&event.ctrlKey&&(mode==='checkpoint'||mode==='link'&&linkDetailsOpen)){event.preventDefault();void save();}});
document.addEventListener('compositionstart',()=>{composing=true;});document.addEventListener('compositionend',()=>{composing=false;});
for(const name of ['all','tasks','links'] as const)$('scope-'+name).onclick=()=>void chooseScope(name);
$('create-task').onclick=()=>{menuSelected=0;activateMenu();};$('create-link').onclick=()=>{menuSelected=1;activateMenu();};
$('back-search').onclick=returnSearch;$('manager').onclick=()=>{sync();void api.openManager(mode==='checkpoint'?checkpointItem?.id:null).catch(error=>status(String(error),true));};
$('resume-capture').onclick=()=>beginCapture('');$('resume-link').onclick=()=>beginLink('');$('checkpoint-save').onclick=()=>void save();$('checkpoint-text').oninput=sync;$('checkpoint-next').oninput=sync;
function toggleLinkDetails(){if(mode!=='link'||saving||composing)return;sync();linkDetailsOpen=!linkDetailsOpen;paint();status(linkDetailsOpen?'Enter 或 Ctrl+Enter 保存 · Esc 保留草稿':'Enter 直接保存 · 名称 / 分组可选 · Ctrl+Enter 展开');if(linkDetailsOpen)linkName.focus();}
$('link-options').onclick=toggleLinkDetails;$('link-save').onclick=()=>void save();linkName.oninput=()=>{sync();if(linkName.value.trim()&&$('status').textContent?.includes('请先为链接填写名称'))status('Enter 或 Ctrl+Enter 保存 · 分组可选');};
linkName.onkeydown=event=>{if(event.isComposing||composing||event.keyCode===229||saving)return;if(event.key==='Enter'){event.preventDefault();event.stopPropagation();void save();}};
async function stage(workFiles:()=>ReturnType<typeof api.chooseFiles>){if(mode!=='capture'||saving)return;sync();await work(async()=>{capture.pending.push(...await workFiles());retain('capture',capture);paint();status(capture.pending.length+' 个附件待保存 · Enter 收下');});entry.focus();}
$('choose-files').onclick=()=>void stage(()=>api.chooseFiles());
entry.addEventListener('paste',event=>{if(mode!=='capture'||saving||!Array.from(event.clipboardData?.items??[]).some(item=>item.type.startsWith('image/')))return;event.preventDefault();void stage(async()=>{const file=await api.pasteImage();return file?[file]:[];});});
document.addEventListener('dragover',event=>event.preventDefault());document.addEventListener('drop',event=>{event.preventDefault();if(mode!=='capture'||saving)return;const paths=Array.from(event.dataTransfer?.files??[]).map(file=>window.recallFiles.path(file));if(paths.length)void stage(()=>api.importFiles(paths));});
function opened(){if(!ready||saving||composing){reopenRequested=true;return;}sync();closeMention();mode='search';scope='all';query='';filters=copyRelations({});expanded=false;selected=0;menuSelected=0;rows=[];suggested=null;request++;paint();searchHint();void refreshCatalog().catch(error=>status(String(error),true));}
api.onOpen(opened);
api.onPrefill(value=>{void boot.then(()=>{sync();if(captureHasContent(capture)){status('已有待办草稿，原内容和安排保留；可继续草稿后再新建。',true);return;}capture={...capture,...copyRelations(value)};mode='capture';paint();sync();status('已带入所选关联 · 输入内容后 Enter 收下');}).catch(error=>status(String(error),true));});
api.onFlush(async()=>{if(!ready||saving||composing)throw new Error('快捷窗口仍在处理输入，请稍后重试');await flush();});
window.addEventListener('focus',()=>{if(ready)void refreshCatalog().catch(error=>status(String(error),true));});
const boot=Promise.all([api.drafts(),api.linkDraft(),api.catalog(undefined,'',true)]).then(([drafts,savedLink,entries])=>{stored=drafts;capture=drafts.capture??{text:'',pending:[]};link=savedLink;lastPersistedLink=structuredClone(savedLink);values.set('capture',structuredClone(capture));values.set('link',structuredClone(link));catalog=entries;ready=true;entry.disabled=false;opened();reopenRequested=false;}).catch(error=>status('草稿读取失败，未覆盖原数据：'+String(error),true));
entry.disabled=true;
