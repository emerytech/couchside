import {useEffect,useRef,useState} from 'react';
import {Pressable,Text,TextInput,View} from 'react-native';
import * as Clipboard from 'expo-clipboard';
import {api,type ConnSettings} from '@/lib/api';
import {useTheme} from '@/lib/theme';
import {APPEARANCE_PACKS,importAppearance,type AppearancePack} from '@/lib/appearancePacks';
/** Deliberately styled with the phone theme; only the preview uses TV colors. */
export function AppearancePacks({settings}:{settings:ConnSettings}){
 const t=useTheme();const [ready,setReady]=useState(false),[active,setActive]=useState<AppearancePack|null>(null),[draft,setDraft]=useState<AppearancePack|null>(null),[packs,setPacks]=useState<AppearancePack[]>([]),[expanded,setExpanded]=useState(false),[css,setCss]=useState(''),[name,setName]=useState('My appearance'),[message,setMessage]=useState(''),[busy,setBusy]=useState(false);const live=useRef(true),lock=useRef(false);
 useEffect(()=>{live.current=true;api.steamThemes(settings).then(s=>{if(!live.current||!s)return;setReady(s.appearance_ready===true);setActive(s.settings.appearance??null);setDraft(s.settings.appearance??null);setPacks(s.settings.appearance_packs??[]);}).catch(()=>{});return()=>{live.current=false;};},[]);
 if(!ready)return null;
 const button=(label:string,fn:()=>void,selected=false)=><Pressable key={label} disabled={busy} accessibilityRole="button" accessibilityState={{selected,disabled:busy}} onPress={fn} style={{padding:12,borderRadius:12,borderWidth:1,borderColor:selected?t.blue:t.cardBorder,backgroundColor:t.card}}><Text style={{color:t.text}}>{label}</Text></Pressable>;
 async function apply(){if(lock.current)return;lock.current=true;setBusy(true);try{const result=await api.saveSteamTheme(settings,{appearance:draft});if(live.current){setActive(result.settings.appearance??null);setDraft(result.settings.appearance??null);setPacks(result.settings.appearance_packs??[]);setMessage(result.settings.enabled?'Appearance applied to the TV.':'Appearance saved on this PC. Apply a launcher layout to see it.');}}catch(e){if(live.current)setMessage(e instanceof Error?e.message:'Could not save appearance.');}finally{lock.current=false;if(live.current)setBusy(false);}}
 const choices=[...APPEARANCE_PACKS.filter(p=>!packs.some(s=>s.name===p.name)),...packs];
 function pastedText(text:string){
  if(!live.current||lock.current)return;
  if(text.length>32768){setMessage('Theme text must be under 32 KiB.');return;}
  if(!text.trim()){setMessage('Copy the theme CSS first, then choose Paste.');return;}
  setCss(text);setMessage('CSS pasted. Choose Preview imported colors to review it.');
 }
 async function paste(){try{pastedText(await Clipboard.getStringAsync());}catch{if(live.current)setMessage('Could not paste. Use the text field’s Paste menu instead.');}}
 return <View style={{gap:12}}>{button('TV appearance packs',()=>setExpanded(!expanded))}{expanded&&<>
 <Text style={{color:t.textDim}}>Optional colors for your TV launcher. Your phone theme stays the same. Changes remain a preview until Apply.</Text>
 <View style={{flexDirection:'row',flexWrap:'wrap',gap:8}}>{button('Layout default',()=>setDraft(null),draft===null)}{choices.map(p=>button(p.name,()=>setDraft(p),draft?.name===p.name))}</View>
 <View accessibilityLabel="TV appearance preview" style={{backgroundColor:draft?.colors.background??t.card,borderColor:draft?.colors.focus??t.cardBorder,borderWidth:2,borderRadius:12,padding:16,gap:8}}><Text style={{color:draft?.colors.text??t.text,fontWeight:'700'}}>{draft?.name??'Original layout appearance'}</Text><Text style={{color:draft?.colors.muted??t.textDim}}>Your games. Your space.</Text><View style={{backgroundColor:draft?.colors.surface??t.bg,padding:12}}><Text style={{color:draft?.colors.accent??t.blue}}>Selected game · Preview</Text></View></View>
 <Text style={{color:t.text}}>Import PC5 colors</Text><Text style={{color:t.textDim}}>Paste CSS below. Supports hex colors and simple linear gradients; other values are reported and skipped. Up to eight packs are saved on this PC; reusing a name replaces that pack when applied.</Text>
 <TextInput accessibilityLabel="Appearance pack name" value={name} maxLength={60} onChangeText={setName} editable={!busy} style={{color:t.text,backgroundColor:t.card,padding:12}}/>
 <TextInput accessibilityLabel="PC5 theme CSS" multiline value={css} maxLength={32768} onChangeText={setCss} editable={!busy} autoCapitalize="none" autoCorrect={false} autoComplete="off" spellCheck={false} smartInsertDelete={false} style={{color:t.text,backgroundColor:t.card,padding:12,minHeight:90}}/>
 {/* Paste only on request; iOS's system control preserves literal CSS without keyboard substitutions. */}
 {Clipboard.isPasteButtonAvailable?<View pointerEvents={busy?'none':'auto'} style={{opacity:busy?0.5:1}}><Clipboard.ClipboardPasteButton accessibilityLabel="Paste theme CSS" acceptedContentTypes={['plain-text']} backgroundColor={t.card} foregroundColor={t.text} cornerStyle="medium" style={{width:140,height:48}} onPress={data=>{if(data.type==='text')pastedText(data.text);}}/></View>:button('Paste CSS',()=>void paste())}
 {button('Preview imported colors',()=>{try{const r=importAppearance(css,name);setDraft(r.pack);setMessage(`${r.accepted.length} imported; ${r.skipped.length} skipped${r.skipped.length?': '+r.skipped.join(', '):''}. Missing values use Couchside defaults.`);}catch(e){setMessage(e instanceof Error?e.message:'Invalid theme.');}})}
 {!!message&&<Text accessibilityLiveRegion="polite" style={{color:t.text}}>{message}</Text>}
 {button('Cancel appearance changes',()=>{setDraft(active);setMessage('Previous appearance restored in preview.');})}
 {button('Restore layout colors',()=>{setDraft(null);setMessage('Original layout colors selected. Choose Apply appearance to restore them.');})}
 {button(busy?'Saving appearance…':'Apply appearance',()=>void apply())}
 </>}</View>;
}
