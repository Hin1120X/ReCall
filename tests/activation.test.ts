import {test} from 'node:test';
import assert from 'node:assert/strict';
import {doubleShift} from '../src/double-shift.ts';
import {activateWindow} from '../src/window-activation.ts';

test('组合键中释放 Shift 后正常双击不需要第三次；取消释放残留状态',()=>{
  let count=0;const detect=doubleShift(()=>count++,[42,54]);
  detect('down',42,false,0);detect('down',29,true,10);detect('up',42,true,20);detect('up',29,false,30);
  detect('down',42,false,1000);detect('up',42,false,1020);detect('down',42,false,1100);detect('up',42,false,1120);assert.equal(count,1);
  detect('down',54,false,1200);detect('cancel',0,false,1250);
  detect('down',54,false,5000);detect('up',54,false,5020);detect('down',54,false,5100);detect('up',54,false,5120);assert.equal(count,2);
});

test('显式激活先恢复和聚焦，必要的临时置顶会释放',async()=>{
  const calls:string[]=[];let top=false;
  const listeners=new Map<string,()=>void>();
  const window={isDestroyed:()=>false,isMinimized:()=>true,restore:()=>calls.push('restore'),show:()=>calls.push('show'),moveTop:()=>calls.push('top'),focus:()=>calls.push('focus'),webContents:{focus:()=>calls.push('content')},isFocused:()=>false,isAlwaysOnTop:()=>top,setAlwaysOnTop:(value:boolean)=>{top=value;calls.push(String(value));},once:(event:string,callback:()=>void)=>listeners.set(event,callback),removeListener:(event:string)=>listeners.delete(event)};
  activateWindow(window as never);assert.deepEqual(calls.slice(0,5),['restore','show','top','focus','content']);assert.equal(top,true);
  listeners.get('hide')!();assert.equal(top,false);assert.equal(listeners.size,0);
  await new Promise(resolve=>setTimeout(resolve,230));assert.equal(top,false);
});
