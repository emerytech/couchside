/** Appearance v1 is data, never CSS. Kept in parity with the agent and companion. */
export type AppearancePack = {version:1;name:string;colors:Record<'background'|'surface'|'text'|'muted'|'accent'|'focus',string>;backgrounds:Partial<Record<'home'|'library'|'settings',{angle:number;stops:string[]}>>};
export function parseAppearancePack(raw:unknown):AppearancePack {
 const v=raw as AppearancePack;
 const keys=(o:unknown,w:string[])=>!!o&&typeof o==='object'&&!Array.isArray(o)&&Object.keys(o).length===w.length&&w.every(k=>Object.hasOwn(o,k));
 const hex=(x:unknown)=>typeof x==='string'&&/^#[0-9a-fA-F]{6}$/.test(x);
 if(!keys(v,['version','name','colors','backgrounds'])||v.version!==1||typeof v.name!=='string'||!v.name.trim()||v.name.length>60||/[\x00-\x1f\x7f]/.test(v.name))throw Error('Invalid appearance pack.');
 if(!keys(v.colors,['background','surface','text','muted','accent','focus'])||!Object.values(v.colors).every(hex))throw Error('Use six-digit hex colors.');
 if(!v.backgrounds||typeof v.backgrounds!=='object'||Array.isArray(v.backgrounds)||Object.keys(v.backgrounds).some(k=>!['home','library','settings'].includes(k)))throw Error('Invalid backgrounds.');
 for(const g of Object.values(v.backgrounds)){if(!keys(g,['angle','stops'])||!Number.isInteger(g.angle)||g.angle<0||g.angle>360||!Array.isArray(g.stops)||g.stops.length<2||g.stops.length>4||!g.stops.every(hex))throw Error('Invalid gradient.');}
 return JSON.parse(JSON.stringify({...v,name:v.name.trim()}));
}
const make=(name:string,bg:string,surface:string,text:string,muted:string,accent:string):AppearancePack=>({version:1,name,colors:{background:bg,surface,text,muted,accent,focus:accent},backgrounds:{}});
export const APPEARANCE_PACKS=[make('Ocean','#081a29','#15354a','#edf8ff','#a9cada','#66cfff'),make('Forest','#0c211c','#1b3930','#effbf4','#b2ccbc','#8ed9ac'),make('Ember','#24130f','#43291f','#fff4eb','#d8b8a6','#ffb078'),make('Violet','#191329','#302443','#f8f1ff','#c4b4dc','#c4a0ff')];
/** Conservative PC5 compatibility subset. Unsupported declarations are reported, never executed. */
export function importAppearance(css:string,name:string){
 if(css.length>32768)throw Error('Theme text must be under 32 KiB.');
 const text=css.replace(/\/\*[\s\S]*?\*\//g,'');
 if(/[@\\]/.test(text)||/\/\*|\*\//.test(text))throw Error('Directives, escapes and unfinished comments are unsupported.');
 const pack=make(name,'#0c1321','#19263a','#f0f4fa','#aabbd0','#26d4be');
 const colors:Record<string,keyof AppearancePack['colors']>={'--c-bg':'background','--c-card':'surface','--c-text':'text','--c-text-2':'muted','--c-accent':'accent','--c-ring-a':'focus'};
 const gradients:Record<string,'home'|'library'|'settings'>={'--g-art-default':'home','--g-library':'library','--g-settings':'settings'};
 const accepted:string[]=[],skipped:string[]=[];
 for(const m of text.matchAll(/([\w-]+)\s*:\s*([^;{}]*)(?:;|(?=\})|$)/g)){
  const [,key,raw]=m;const value=raw.trim();
  if(Object.hasOwn(colors,key)&&/^#[0-9a-fA-F]{6}$/.test(value)){pack.colors[colors[key]]=value;accepted.push(key);continue;}
  const g=value.match(/^linear-gradient\(\s*(\d{1,3})deg\s*,\s*(#[0-9a-fA-F]{6}(?:\s*,\s*#[0-9a-fA-F]{6}){1,3})\s*\)$/);
  if(Object.hasOwn(gradients,key)&&g&&Number(g[1])<=360){pack.backgrounds[gradients[key]]={angle:Number(g[1]),stops:g[2].split(',').map(s=>s.trim())};accepted.push(key);continue;}
  skipped.push(key);
 }
 if(!accepted.length)throw Error('No compatible values found. Use six-digit hex colors or linear gradients with an angle and 2–4 hex colors.');
 return {pack:parseAppearancePack(pack),accepted,skipped};
}
