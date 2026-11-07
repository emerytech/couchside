import test from 'node:test';
import assert from 'node:assert/strict';
import { AirMouseIntegrator, AIR_MOUSE_REMOTE_GAIN, airMouseGripSample } from '../airMouse.ts';
import { pointerMoveFrame } from '../tvdirect/webosproto.ts';
import { WebosSession, type WebosDeps } from '../tvdirect/webos.ts';
const sample = (timestamp: number, x = 0, y = 0) => ({timestamp, x, y, z: 0});
test('calibration removes stationary bias; release/reset and long gaps cannot jump', () => {
 const m = new AirMouseIntegrator();
 assert.equal(m.calibrate(Array.from({length: 30}, (_, i) => sample(i*.02,.04,.03))), true);
 m.step(sample(1,.04,.03)); assert.deepEqual(m.step(sample(1.02,.04,.03)), {dx:0,dy:0});
 assert.equal(m.step(sample(5,10,10)), null);
 m.reset(); assert.equal(m.step(sample(6,1,1)), null);
 assert.equal(m.calibrate(Array.from({length:20},(_,i)=>sample(i,2,0))), false);
});
test('fractional motion accumulates, samples stay bounded, invalid input does not move', () => {
 const m = new AirMouseIntegrator(); let total=0;
 for(let i=0;i<100;i++) {const d=m.step(sample(i*.02,0,.025)); if(d)total+=d.dx;}
 assert.ok(total < -5, 'slow deliberate motion retains fractional progress');
 const d=m.step(sample(2,1e9,1e9))!;assert.ok(Math.abs(d.dx)<=60 && Math.abs(d.dy)<=60);
 assert.equal(m.step(sample(NaN,1,1)),null);
 for(const pair of [[NaN,0],[0,Infinity],[121,0]]) assert.throws(()=>pointerMoveFrame(...pair as [number,number]));
});
function fixture() {
 const session = new WebosSession('fixture.local', {} as WebosDeps);
 const sent: string[]=[];let closed=0,opens=0;
 let release: (()=>void)|undefined;
 const gate=new Promise<void>(r=>{release=r;});
 const ptr={send:(s:string)=>sent.push(s),close:()=>{closed++;}};
 const internals=session as unknown as {request:()=>Promise<unknown>;open:()=>Promise<unknown>};
 internals.request=async()=>({payload:{socketPath:'wss://fixture.local:3001/pointer'}});
 internals.open=async()=>{opens++;await gate;return ptr;};
 return {session,sent,release:()=>release!(),closed:()=>closed,opens:()=>opens};
}
test('release while pointer handshake is pending closes it and sends no late motion', async () => {
 const f=fixture();let active=true;const pending=f.session.movePointer(20,10,()=>active);
 await Promise.resolve();active=false;f.session.stopPointer();f.release();await pending;
 assert.deepEqual(f.sent,[]);assert.equal(f.closed(),1);
});
test('one pointer connection handles repeated moves; cancelled click is never delivered', async () => {
 const f=fixture();f.release();
 for(let i=0;i<20;i++)assert.equal((await f.session.movePointer(1,2,()=>true)).ok,true);
 assert.equal(f.opens(),1);assert.equal(f.sent.length,20);
 await f.session.clickPointer(()=>false);assert.equal(f.sent.length,20);
 f.session.close();assert.equal(f.closed(),1);
});

test('stationary phone clears smoothing tail, stays paused through jitter, then resumes', () => {
 const m = new AirMouseIntegrator();m.step(sample(0,0,2));m.step(sample(.02,0,2));
 for(let i=2;i<20;i++) {const d=m.step(sample(i*.02));if(i>=9)assert.deepEqual(d,{dx:0,dy:0});}
 assert.deepEqual(m.step(sample(.4,.015,.015)),{dx:0,dy:0});
 const moved=m.step(sample(.42,0,.5));assert.ok(moved && moved.dx<0);
});

test('remote Z yaw and pitch use the same calibration frame', () => {
 const raw = {x:.4,y:.1,z:-.5,timestamp:0};
 const remote = new AirMouseIntegrator();
 remote.step(airMouseGripSample(raw,'remote'));
 const delta = remote.step(airMouseGripSample({...raw,timestamp:.02},'remote'))!;
 assert.ok(delta.dx > 0); assert.ok(delta.dy < 0);

 const bias = Array.from({length:30},(_,i)=>airMouseGripSample({x:.02,y:0,z:.03,timestamp:i*.02},'remote'));
 assert.equal(remote.calibrate(bias),true);
 remote.step({...bias[0],timestamp:1});
 assert.deepEqual(remote.step({...bias[0],timestamp:1.02}),{dx:0,dy:0});
 assert.equal(raw.y,.1);
});

test('remote wrist sweep covers four times the distance without changing stillness or frame bounds', () => {
 const distance = (gain: number) => {
  const m = new AirMouseIntegrator(); let total = 0;
  for(let i=0;i<=50;i++) { const d=m.step({x:0,y:-.35,z:0,timestamp:i*.02},gain); if(d) { total+=d.dx; assert.ok(Math.abs(d.dx)<=60); } }
  for(let i=51;i<80;i++) m.step({x:0,y:0,z:0,timestamp:i*.02},gain);
  assert.deepEqual(m.step({x:0,y:0,z:0,timestamp:1.6},gain),{dx:0,dy:0});
  return total;
 };
 const normal = distance(1), remote = distance(AIR_MOUSE_REMOTE_GAIN);
 assert.ok(remote > 1400 && remote < 1600);
 assert.ok(Math.abs(remote/normal-4)<.05);
});

test('precision filter suppresses hand tremor yet responds promptly to a deliberate sweep', () => {
 const m = new AirMouseIntegrator(); let travel=0;
 for(let i=0;i<100;i++) { const d=m.step(sample(i*.02,0,.06*Math.sin(2*Math.PI*8*i*.02)),4); if(d)travel+=Math.abs(d.dx); }
 assert.ok(travel < 45, `tremor path ${travel}px should remain small`);
 const sweep=[];
 for(let i=100;i<106;i++) sweep.push(m.step(sample(i*.02,0,-.6),4)!.dx);
 assert.ok(sweep[2]>35, 'intentional sweep responds within 60ms');
 m.reset();assert.equal(m.step(sample(3,0,-.6),4),null);
 for(let i=151;i<170;i++) m.step(sample(i*.02),4);
 assert.deepEqual(m.step(sample(3.4),4),{dx:0,dy:0});
});

test('figure-eight trajectory is rotationally consistent through diagonals and reversals', () => {
 const a=new AirMouseIntegrator(),b=new AirMouseIntegrator(); const angle=.61,c=Math.cos(angle),s=Math.sin(angle);
 let ax=0,ay=0,bx=0,by=0;
 for(let i=0;i<500;i++) {
  const t=i*.02,x=.19*Math.sin(t*3),y=.32*Math.cos(t*1.5);
  const p=a.step(sample(t,x,y),4),q=b.step(sample(t,c*x-s*y,s*x+c*y),4);
  if(p&&q){ax+=p.dx;ay+=p.dy;bx+=q.dx;by+=q.dy;
   assert.ok(Math.hypot(bx-(c*ax+s*ay),by-(-s*ax+c*ay))<3,'rotation must not distort the integrated curve');}
 }
});
