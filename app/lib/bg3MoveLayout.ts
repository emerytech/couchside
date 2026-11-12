import type {PadLayout,Rect} from './padLayout.ts';
/** Retain the regular MOVE zone and A/B positions, replacing NAV with a touchpad. */
export function bg3MoveExtras(l:Extract<PadLayout,{ok:true}>) {
 const {play:p,byId:n}=l,landscape=p.w>p.h,gap=12;
 const top=Math.max(...l.nodes.filter(n=>n.layer===9).map(n=>n.rect.y+n.rect.h))+gap;
 const rightStart=landscape?p.x+p.w*.46:p.x+gap;
 const rightWidth=landscape?p.x+p.w-gap-rightStart:p.w-2*gap;
 const bottom=landscape?Math.min(n.a.hit.y,n.b.hit.y)-gap:Math.min(n.a.hit.y,n.b.hit.y)-72;
 const pad:Rect={x:rightStart,y:top,w:rightWidth,h:Math.max(0,bottom-top)};
 const rowY=pad.y+pad.h+gap;
 const buttonWidth=landscape?Math.min(104,(n.b.hit.x-rightStart-gap)/2):Math.min(140,(rightWidth-gap)/2);
 const left:Rect={x:rightStart,y:rowY,w:buttonWidth,h:48};
 const right:Rect={...left,x:left.x+left.w+gap};
 return {pad,left,right,ok:pad.w>=120&&pad.h>=64&&buttonWidth>=44};
}
