/** Bounded, numeric-only QA trace. No identifiers, addresses or credentials. */
export function createAirMouseQaTrace(limit=1800,sensitivity=4) {
 const samples:{at:number;t:number;x:number;y:number;z:number}[]=[];
 const sends:{at:number;dx:number;dy:number}[]=[];
 return {
  sample(at:number,s:{timestamp:number;x:number;y:number;z:number}){if(samples.length<limit)samples.push({at,t:s.timestamp,x:s.x,y:s.y,z:s.z});},
  send(at:number,dx:number,dy:number){if(sends.length<limit)sends.push({at,dx,dy});},
  snapshot(){
   const gap=(rows:{at:number}[])=>rows.reduce((max,row,i)=>i?Math.max(max,row.at-rows[i-1].at):max,0);
   return {version:1,sensitivity,samples,sends,summary:{samples:samples.length,sends:sends.length,
    dx:sends.reduce((n,s)=>n+s.dx,0),dy:sends.reduce((n,s)=>n+s.dy,0),maxSampleGapMs:gap(samples),maxSendGapMs:gap(sends)}};
  },
 };
}
