import test from 'node:test';
import assert from 'node:assert/strict';
import type {CatalogEntry,CatalogKind,LinkDraft} from '../src/shared.ts';
import {linkDraftKey} from '../src/shared.ts';

class Element {
  children:Element[]=[];className='';textContent='';value='';hidden=false;disabled=false;open=false;checked=false;isConnected=true;
  onclick:(()=>void)|null=null;oninput:(()=>void)|null=null;ontoggle:(()=>void)|null=null;
  attributes=new Map<string,string>();
  dataset:Record<string,string>={};
  tagName:string;
  constructor(tagName:string){this.tagName=tagName;}
  classList={add:(name:string)=>{this.className+=' '+name;},toggle:(name:string,on:boolean)=>{this.className=this.className.split(' ').filter(value=>value!==name).concat(on?[name]:[]).join(' ');}};
  append(...nodes:Element[]){this.children.push(...nodes);}
  replaceChildren(...nodes:Element[]){this.children=nodes;}
  setAttribute(name:string,value:string){this.attributes.set(name,value);}
  addEventListener(){}
  focus(){}
  querySelectorAll(selector:string):Element[]{const selectors=selector.split(',');return this.children.flatMap(child=>[...(selectors.some(value=>value.startsWith('.')?child.className.split(' ').includes(value.slice(1)):child.tagName===value)?[child]:[]),...child.querySelectorAll(selector)]);}
  querySelector(selector:string){return this.querySelectorAll(selector)[0]??null;}
}
const api:Record<string,(...args:any[])=>any>={};
Object.defineProperty(globalThis,'window',{value:{recall:api},configurable:true});
Object.defineProperty(globalThis,'document',{value:{createElement:(tag:string)=>new Element(tag),createTextNode:(text:string)=>Object.assign(new Element('#text'),{textContent:text})},configurable:true});
const {createRelationEditor,mountCatalogManager}=await import('../src/catalog-ui.ts');
const tick=()=>new Promise<void>(resolve=>setImmediate(resolve));
const root=()=>new Element('main');
const asRoot=(node:Element)=>node as unknown as HTMLElement;
const entry=(id:string,kind:CatalogKind='group'):CatalogEntry=>({id,kind,name:id,target:'https://example.com/'+id,resourceKind:kind==='resource'?'url':null,aliases:[],pinned:false,archived:false,createdAt:'',updatedAt:'',lastUsedAt:null});
const click=(node:Element,label:string)=>{const button=node.querySelectorAll('button').find(row=>row.textContent===label);assert.ok(button,label);button.onclick?.();};
const linkInput=(node:Element)=>{const input=node.querySelectorAll('input').find(row=>row.attributes.get('aria-label')==='新增链接地址');assert.ok(input);return input;};
const copy=<T>(value:T):T=>structuredClone(value);
const signature=linkDraftKey;

test('a delayed relation creation updates the directory without associating a different task or closed editor',async()=>{
  for(const close of [false,true]){
    let resolve!:(value:CatalogEntry)=>void,changes=0;
    api.catalog=async()=>[];api.saveCatalog=()=>new Promise< CatalogEntry>(done=>{resolve=done;});
    const node=root(),editor=createRelationEditor(asRoot(node),{kinds:['group'],onChange:()=>{changes++;},onError:message=>assert.fail(message)});
    await tick();const block=node.querySelector('details')!,input=block.querySelector('input')!;block.open=true;input.value='new-group';input.oninput?.();click(block,'新建分组“new-group”');
    if(close){block.open=false;block.ontoggle?.();}else editor.setValue({groupIds:['task-b-group']});
    resolve(entry('new-group'));await tick();assert.equal(changes,0);assert.deepEqual(editor.getValue().groupIds,close?[]:['task-b-group']);
    block.open=true;input.value='';input.oninput?.();assert.ok(block.querySelectorAll('button').some(button=>button.textContent==='new-group'));
  }
});

test('the workbench resumes the shared link draft, serializes edits and consumes the exact draft',async()=>{
  let current:LinkDraft|null={target:'https://example.com/a',groupIds:['group']};const writes:{next:LinkDraft|null;expected:LinkDraft|null}[]=[],created:LinkDraft[]=[];
  api.catalog=async(kind?:CatalogKind)=>kind==='group'?[entry('group')]:[];api.linkDraft=async()=>copy(current);
  api.saveLinkDraft=async(next:LinkDraft|null,expected:LinkDraft|null)=>{assert.equal(signature(expected),signature(current));writes.push(copy({next,expected}));await tick();current=copy(next);};
  api.createLink=async(value:LinkDraft)=>{assert.equal(signature(value),signature(current));created.push(copy(value));current=null;return entry('saved','resource');};
  const node=root(),manager=mountCatalogManager(asRoot(node),'resource',{onError:message=>assert.fail(message)});await manager.refresh();const input=linkInput(node);assert.equal(input.value,'https://example.com/a');
  input.value='https://example.com/ab';input.oninput?.();input.value='https://example.com/abc';input.oninput?.();await manager.flush();
  assert.equal(writes.length,2);assert.equal(writes[1].expected?.target,'https://example.com/ab');assert.deepEqual(current,{target:'https://example.com/abc',groupIds:['group']});
  click(node,'收藏链接');await tick();await tick();assert.deepEqual(created,[{target:'https://example.com/abc',groupIds:['group']}]);assert.equal(current,null);assert.equal(input.value,'');
});

test('optional link naming and grouping use the shared draft and the saved link can be opened for editing',async()=>{
  let current:LinkDraft|null=null;const group=entry('named-group'),resources:CatalogEntry[]=[],created:LinkDraft[]=[];
  api.catalog=async(kind?:CatalogKind)=>kind==='group'?[group]:kind==='resource'?copy(resources):[group,...copy(resources)];api.linkDraft=async()=>copy(current);
  api.saveLinkDraft=async(next:LinkDraft|null,expected:LinkDraft|null)=>{assert.equal(signature(expected),signature(current));current=copy(next);};
  api.createLink=async(value:LinkDraft)=>{assert.equal(signature(value),signature(current));created.push(copy(value));const saved={...entry('named-link','resource'),name:value.name!,target:value.target,groupIds:value.groupIds};resources.push(saved);current=null;return saved;};
  const node=root(),manager=mountCatalogManager(asRoot(node),'resource',{onError:message=>assert.fail(message)});await manager.refresh();
  const details=node.querySelector('.link-create-details')!,name=details.querySelector('input')!,target=linkInput(node);
  details.open=true;target.value='https://example.com/docs#section';target.oninput?.();name.value='项目文档';name.oninput?.();click(details,group.name);await manager.flush();
  assert.deepEqual(current,{target:target.value,name:'项目文档',groupIds:[group.id]});
  click(node,'收藏链接');await tick();await tick();await tick();await tick();
  assert.deepEqual(created,[{target:'https://example.com/docs#section',name:'项目文档',groupIds:[group.id]}]);assert.equal(current,null);assert.equal(name.value,'');
  manager.editEntry('named-link');const form=node.querySelector('.catalog-form')!;assert.equal(form.hidden,false);assert.equal(form.querySelector('input')!.value,'项目文档');
});

test('a conflicting link edit preserves both windows and blocks flush until explicit resumption',async()=>{
  let current:LinkDraft|null={target:'https://example.com/a',groupIds:[]};const errors:string[]=[];let writes=0;
  api.catalog=async()=>[];api.linkDraft=async()=>copy(current);api.saveLinkDraft=async(next:LinkDraft|null,expected:LinkDraft|null)=>{writes++;if(signature(current)!==signature(expected))throw new Error('草稿已变化');current=copy(next);};
  const node=root(),manager=mountCatalogManager(asRoot(node),'resource',{onError:message=>errors.push(message)});await manager.refresh();const input=linkInput(node);
  current={target:'https://example.com/other-window',groupIds:[]};input.value='https://example.com/local-unsaved';input.oninput?.();
  await assert.rejects(manager.flush(),/草稿/);assert.equal(input.value,'https://example.com/local-unsaved');assert.equal(current.target,'https://example.com/other-window');assert.equal(writes,1);
  click(node,'接续最新草稿');await tick();assert.equal(input.value,'https://example.com/local-unsaved');assert.ok(errors.some(message=>message.includes('复制并清空')));
  input.value='';input.oninput?.();click(node,'接续最新草稿');await tick();await manager.flush();assert.equal(input.value,'https://example.com/other-window');assert.equal(writes,1);
  current=null;await manager.refresh();await manager.flush();assert.equal(input.value,'');assert.equal(current,null);assert.equal(writes,1,'consumed drafts must not be resurrected');
});

test('resuming another window cannot discard unsaved group-only link metadata',async()=>{
  const a=entry('local-group'),b=entry('added-group'),c=entry('remote-group');let current:LinkDraft|null={target:'',groupIds:[a.id]};const errors:string[]=[];
  api.catalog=async()=>[a,b,c];api.linkDraft=async()=>copy(current);api.saveLinkDraft=async(next:LinkDraft|null,expected:LinkDraft|null)=>{if(signature(expected)!==signature(current))throw new Error('草稿冲突');current=copy(next);};
  const node=root(),manager=mountCatalogManager(asRoot(node),'resource',{onError:message=>errors.push(message)});await manager.refresh();const details=node.querySelector('.link-create-details')!;details.open=true;
  current={target:'',groupIds:[c.id]};click(details,b.name);await assert.rejects(manager.flush(),/草稿/);
  click(node,'接续最新草稿');await tick();assert.deepEqual(current,{target:'',groupIds:[c.id]});assert.ok(errors.some(message=>message.includes('记录并移除分组')));
  assert.ok(details.querySelectorAll('span').some(row=>row.textContent.includes(b.name)),'local group metadata must remain visible');
});
