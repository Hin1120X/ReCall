import type { CatalogEntry, CatalogKind, DraftValue, Relations } from './shared.ts';
import {matchesSearch} from './search.ts';

export type Mention = {kind:CatalogKind;query:string;start:number;end:number};
export function mentionAt(text:string,caret:number):Mention|null {
  const match=/(^|\s)(@|#|to )([^\n@#]*)$/i.exec(text.slice(0,caret));
  if(!match)return null;
  return {kind:match[2]==='@'?'resource':match[2]==='#'?'group':'person',query:match[3].trim(),start:match.index+match[1].length,end:caret};
}
export function removeMention(text:string,mention:Mention){return text.slice(0,mention.start)+text.slice(mention.end);}
export function priorityFlags(quadrant:number|null){return {urgent:quadrant===0||quadrant===2,important:quadrant===0||quadrant===1};}
export function flagsQuadrant(urgent:boolean,important:boolean){return urgent?(important?0:2):(important?1:3);}
export function captureHasContent(value:Partial<DraftValue>){return !!(value.text?.trim()||value.pending?.length||value.quadrant!=null||value.reminder||value.deadline||value.folder||value.recurrence||value.state!==undefined||value.inbox!==undefined||value.nextStep?.trim()||value.resumeNote?.trim()||value.waitingFor?.trim()||value.groupIds?.length||value.personIds?.length||value.resourceIds?.length||Object.keys(value.extra?.fields??{}).length);}
export function cycleScope(scope:'all'|'tasks'|'links',reverse=false){const scopes=['all','tasks','links'] as const;return scopes[(scopes.indexOf(scope)+(reverse?2:1))%scopes.length];}
export function creationSeed(value:string){const text=value.trimStart();return text[0]==='+'||text[0]==='＋'?text.slice(1).trimStart():null;}
export function captureFromSearch(saved:DraftValue,query:string,relations:Relations={}){const resumed=captureHasContent(saved);return {resumed,value:resumed?structuredClone(saved):{...structuredClone(saved),text:query,...copyRelations(relations)}};}
export const relationKey=(kind:CatalogKind)=>kind==='resource'?'resourceIds':kind==='group'?'groupIds':'personIds';
export function copyRelations(value:Relations):Required<Relations>{return {groupIds:[...new Set(value.groupIds??[])],personIds:[...new Set(value.personIds??[])],resourceIds:[...new Set(value.resourceIds??[])]};}
export function catalogMatches(entry:CatalogEntry,query:string){return matchesSearch([entry.name,...entry.aliases,entry.target],query);}
export function resourceOrder(entries:CatalogEntry[]){return [...entries].sort((a,b)=>Number(b.pinned)-Number(a.pinned)||(b.lastUsedAt??'').localeCompare(a.lastUsedAt??'')||a.name.localeCompare(b.name,'zh-CN'));}
export function localTime(value:string|null|undefined){return value?new Date(Date.parse(value)-new Date(value).getTimezoneOffset()*60000).toISOString().slice(0,16):'';}
