import test from 'node:test';
import assert from 'node:assert/strict';
import {syntheticGyroSample} from '../airMouseSynthetic.ts';
import {AirMouseIntegrator,airMouseGripSample,AIR_MOUSE_REMOTE_GAIN} from '../airMouse.ts';
test('synthetic source has bounded repeated movement and still start/end; same gyro integrator',()=>{
 const e=new AirMouseIntegrator();let count=0;let total=0;
 for(let i=0;i<=1500;i++){
  const t=i*.02,s=syntheticGyroSample(t);assert.equal(s.timestamp,t);
  assert.ok(Math.abs(s.x)<=.085&&Math.abs(s.z)<=.13);
  if(t<2||t>=27)assert.equal(Math.hypot(s.x,s.z),0);
  const d=e.step(airMouseGripSample(s,'remote'),AIR_MOUSE_REMOTE_GAIN);
  if(d&&Math.abs(d.dx)+Math.abs(d.dy)){count++;total+=Math.hypot(d.dx,d.dy);assert.ok(Math.hypot(d.dx,d.dy)<=60);}
 }
 assert.ok(count>1000);assert.ok(total>4000);
 assert.deepEqual(syntheticGyroSample(3),syntheticGyroSample(3));
});
