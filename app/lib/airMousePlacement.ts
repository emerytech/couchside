/** Place the collapsed AIR fan only in unused controller space. Expanded
 * commands may cover drawings, but the closed launcher never steals a control. */
type Rect = {x:number;y:number;w:number;h:number};
export function airMousePlacement(bounds:Rect, controls:Rect[]):Rect|null {
  const w=60,h=52;
  for(let y=bounds.y+bounds.h-h;y>=bounds.y;y-=8) {
    for(let x=bounds.x+bounds.w-w;x>=bounds.x;x-=8) {
      const r={x,y,w,h};
      if(controls.every(c=>r.x+r.w+4<=c.x||c.x+c.w+4<=r.x||r.y+r.h+4<=c.y||c.y+c.h+4<=r.y))return r;
    }
  }
  return null;
}
