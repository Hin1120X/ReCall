const assert=require('node:assert/strict');
module.exports=async({window,store,first,waiting,group,openManager,getManager,openLibrary,setActive,evaluate,input,event,wait,until,reveal,check,snap})=>{
  const click=async id=>{await wait(`document.getElementById(${JSON.stringify(id)})&&!document.getElementById(${JSON.stringify(id)}).disabled`,'操作仍在保存：'+id);await evaluate(`document.getElementById(${JSON.stringify(id)}).click()`);};
  const target=async id=>{await openManager(id);setActive(getManager());await wait(`!document.getElementById('detail-view').hidden&&document.getElementById('detail-view').dataset.itemId===${JSON.stringify(id)}&&!document.getElementById('save').disabled`,'任务未就绪');};
  await target(first.id);await click('add-property');await wait("document.getElementById('property-dialog').open",'属性弹窗未打开');
  await evaluate("document.getElementById('property-urgent').checked=true");await openManager(waiting.id);
  await wait("document.getElementById('status').textContent.includes('属性')",'属性编辑时未拦截换任务');assert.equal(await evaluate("document.getElementById('detail-view').dataset.itemId"),first.id);
  await evaluate("document.dispatchEvent(new KeyboardEvent('keydown',{key:'s',ctrlKey:true,bubbles:true}))");await until(()=>store.get(first.id).quadrant===2,'弹窗CtrlS未保存属性');await wait("!document.getElementById('property-dialog').open",'属性保存未关闭');assert.equal(store.get(waiting.id).quadrant,null);assert.equal(store.get(first.id).lastProgressAt,null);
  const original=store.get(first.id);await click('add-property');await wait("document.getElementById('property-dialog').open",'取消属性测试未打开');await evaluate("document.getElementById('property-important').checked=true");await click('property-cancel');assert.deepEqual(store.get(first.id),original);
  check('属性弹窗绑定原任务，CtrlS保存该属性，取消不写入');

  let release;const originalSave=store.saveCatalog;const groupName='异步隔离验收分组';
  try{
    store.saveCatalog=function(value){if(value.name===groupName)return new Promise(resolve=>{release=()=>resolve(originalSave.call(this,value));});return originalSave.call(this,value);};
    await evaluate("document.getElementById('relations-panel').open=true;document.querySelector('#relations-editor .relation-control').open=true");
    await evaluate(`{const field=document.querySelector('#relations-editor input[aria-label="查找分组"]');field.value=${JSON.stringify(groupName)};field.dispatchEvent(new Event('input',{bubbles:true}));}`);
    await wait("Array.from(document.querySelectorAll('#relations-editor .relation-options button')).some(button=>button.textContent.startsWith('新建分组'))",'新建分组候选未显示');
    await evaluate("Array.from(document.querySelectorAll('#relations-editor .relation-options button')).find(button=>button.textContent.startsWith('新建分组')).click()");await until(()=>typeof release==='function','未发起异步目录保存');
    await target(waiting.id);release();await until(()=>store.catalog('group').some(value=>value.name===groupName),'异步目录未完成');
    await wait("!document.querySelector('#relations-editor > .relation-chips').textContent.includes('异步隔离验收分组')",'异步标签串到另一任务');assert.ok(!(store.drafts()['edit:'+waiting.id]?.groupIds??[]).includes(store.catalog('group').find(value=>value.name===groupName).id));
  }finally{store.saveCatalog=originalSave;}
  check('异步新建关系返回后不串入另一任务');

  await reveal();await event('ArrowDown');await wait("document.querySelector('#results [data-item-id="+JSON.stringify(first.id)+"] .checkpoint')!==null",'主任务建议缺失');
  await evaluate(`document.querySelector('#results [data-item-id="${first.id}"] .checkpoint').click()`);await wait("document.body.dataset.mode==='checkpoint'",'快捷断点未打开');await input('快捷窗口原断点 A','checkpoint-text');await until(()=>store.drafts()['checkpoint:'+first.id]?.text==='快捷窗口原断点 A','快捷草稿未写入');
  await target(first.id);await click('leave-checkpoint');await wait("document.getElementById('checkpoint-panel').open",'工作台断点未打开');await input('工作台接续未保存 B','checkpoint-text');await until(()=>store.drafts()['checkpoint:'+first.id]?.text==='工作台接续未保存 B','工作台草稿未写入');
  await reveal();assert.equal(store.drafts()['checkpoint:'+first.id].text,'工作台接续未保存 B');await event('ArrowDown');await wait("document.querySelector('#results .checkpoint')!==null",'建议未展开');await evaluate(`document.querySelector('#results [data-item-id="${first.id}"] .checkpoint').click()`);await wait("document.getElementById('checkpoint-text').value==='工作台接续未保存 B'",'快捷窗覆盖了工作台最新草稿');
  await click('checkpoint-save');await until(()=>!store.drafts()['checkpoint:'+first.id],'断点未消费');await target(first.id);await click('leave-checkpoint');await wait("document.getElementById('checkpoint-panel').open&&document.getElementById('checkpoint-text').value==='"+"'",'已消费断点复活');assert.equal(store.drafts()['checkpoint:'+first.id],undefined);
  check('跨窗口断点接续保留最新输入，已消费草稿不复活');

  const pending=store.stage({name:'isolated-checkpoint.txt',bytes:new TextEncoder().encode('isolated sample')});const before=store.get(first.id);store.saveDraft('checkpoint:'+first.id,{text:'含待存资料的旧断点',pending:[pending],itemId:first.id,expectedUpdatedAt:before.updatedAt,extra:{version:1,fields:{futureCheckpoint:'keep'}}});
  await target(first.id);await click('leave-checkpoint');await wait("document.getElementById('checkpoint-text').value==='含待存资料的旧断点'",'旧断点未接续');await input('修改文字仍保留资料','checkpoint-text');await until(()=>store.drafts()['checkpoint:'+first.id]?.text==='修改文字仍保留资料','断点文字未保留');await click('checkpoint-save');await wait("document.getElementById('status').textContent.includes('附件')&&!document.getElementById('checkpoint-save').disabled",'含附件断点未保护');assert.deepEqual(store.drafts()['checkpoint:'+first.id].pending,[pending]);assert.equal(store.drafts()['checkpoint:'+first.id].extra.fields.futureCheckpoint,'keep');assert.deepEqual(store.get(first.id),before);
  check('旧断点附件、扩展字段及失败输入保留');

  store.saveLinkDraft({target:'https://example.invalid/shared-a',groupIds:[group.id]});await openLibrary();setActive(getManager());await wait("document.getElementById('links-view').hidden===false",'工作台链接未打开');
  await wait("document.querySelector('#links-manager .catalog-create input')?.value==='https://example.invalid/shared-a'",'工作台未接续快捷链接草稿');
  await evaluate("{const field=document.querySelector('#links-manager .catalog-create input');field.value='https://example.invalid/shared-b';field.dispatchEvent(new Event('input',{bubbles:true}));}");await until(()=>store.linkDraft()?.target==='https://example.invalid/shared-b','工作台链接草稿未保存');
  await reveal();await input('+');await wait("document.body.dataset.mode==='menu'",'链接新建菜单未打开');await event('Tab');await event('Enter');await wait("document.body.dataset.mode==='link'&&document.getElementById('entry').value==='https://example.invalid/shared-b'",'快捷入口未接续最新链接');await event('Enter');await until(()=>store.linkDraft()===null,'链接保存未原子清草稿');
  await openLibrary();setActive(getManager());await wait("document.querySelector('#links-manager .catalog-create input')?.value==='"+"'",'工作台复活已消费链接草稿');assert.equal(store.linkDraft(),null);check('链接双入口接续、串行保存和原子消费');
  await reveal();await input('+');await event('Tab');await event('Enter');await wait("document.body.dataset.mode==='link'",'命名链接入口未打开');
  const targetURL='https://example.invalid/project#section',beforeLinks=store.catalog('resource').length;
  await input(targetURL);await event('Enter',{ctrlKey:true});await wait("document.body.dataset.mode==='linkDetails'&&document.activeElement.id==='link-name'",'名称分组未展开并聚焦');
  await input('可检索的项目入口','link-name');await wait(`Array.from(document.querySelectorAll('#link-groups .relation-options button')).some(button=>button.textContent===${JSON.stringify(group.name)})`,'链接分组候选缺失');
  await evaluate(`Array.from(document.querySelectorAll('#link-groups .relation-options button')).find(button=>button.textContent===${JSON.stringify(group.name)}).click()`);
  await until(()=>store.linkDraft()?.name==='可检索的项目入口'&&store.linkDraft()?.groupIds?.includes(group.id),'链接名称分组未存入草稿');
  await evaluate("document.getElementById('link-name').dispatchEvent(new KeyboardEvent('keydown',{key:'Enter',isComposing:true,bubbles:true}))");assert.equal(store.catalog('resource').length,beforeLinks,'输入法确认不能保存链接');
  await snap('08-link-name-group');await event('Escape');await reveal();await input('+');await event('Tab');await event('Enter');await wait("document.body.dataset.mode==='linkDetails'&&document.getElementById('link-name').value==='可检索的项目入口'",'链接名称草稿未恢复');
  await event('Enter',{ctrlKey:true});await until(()=>store.catalog('resource').length===beforeLinks+1,'命名链接未保存');let named=store.catalog('resource').find(entry=>entry.name==='可检索的项目入口');assert.ok(named);assert.equal(named.target,targetURL);assert.deepEqual(named.groupIds,[group.id]);assert.equal(store.linkDraft(),null);
  await reveal();await input('可检索的项目入口');await wait("document.querySelector('#results .link-edit')!==null",'链接搜索缺少直接编辑');await evaluate("document.querySelector('#results .link-edit').click()");setActive(getManager());
  await wait("!document.getElementById('links-view').hidden&&!document.querySelector('#links-manager .catalog-form').hidden&&document.querySelector('#links-manager input[aria-label=链接名称]').value==='可检索的项目入口'",'未直接打开对应链接编辑');
  const second=store.saveCatalog({id:null,kind:'group',name:'新归属工作组'});
  await evaluate("{const field=document.querySelector('#links-manager input[aria-label=链接名称]');field.value='已修改的项目入口';field.dispatchEvent(new Event('input',{bubbles:true}));}");
  await wait(`Array.from(document.querySelectorAll('#links-manager .catalog-form .relation-options button')).some(button=>button.textContent===${JSON.stringify(second.name)})`,'编辑分组未刷新');
  await evaluate(`Array.from(document.querySelectorAll('#links-manager .catalog-form .relation-options button')).find(button=>button.textContent===${JSON.stringify(second.name)}).click()`);
  await evaluate("Array.from(document.querySelectorAll('#links-manager .catalog-form button')).find(button=>button.textContent==='保存').click()");await until(()=>store.catalog('resource').find(entry=>entry.id===named.id)?.name==='已修改的项目入口','修改链接名称未保存');
  named=store.catalog('resource').find(entry=>entry.id===named.id);assert.equal(named.target,targetURL);assert.deepEqual(named.groupIds,[group.id,second.id]);check('可选链接命名归组、IME保护、草稿恢复和搜索直达编辑');
};
