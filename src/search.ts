import { pinyin } from 'pinyin-pro';

export function matchesSearch(values:string[],query:string) {
  const terms=query.normalize('NFKC').trim().toLowerCase().split(/\s+/).filter(Boolean);
  if(!terms.length)return true;
  const text=values.join('\n').normalize('NFKC').toLowerCase();
  let romanized:string|undefined,initials:string|undefined;
  return terms.every(term=>{
    if(text.includes(term))return true;
    if(!/^[a-z0-9]+$/.test(term))return false;
    romanized??=pinyin(text,{toneType:'none',separator:'',nonZh:'consecutive'}).toLowerCase();
    if(romanized.includes(term))return true;
    initials??=pinyin(text,{toneType:'none',pattern:'first',separator:'',nonZh:'consecutive'}).toLowerCase();
    return initials.includes(term);
  });
}
