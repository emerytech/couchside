import test from 'node:test';
import assert from 'node:assert/strict';
import {remoteCircleDiameter,remoteJoystickDirection} from '../remoteNavigation.ts';
test('remote pad grows into reclaimed space while respecting width and maximum diameter',()=>{
 assert.equal(remoteCircleDiameter(400,300),296);assert.equal(remoteCircleDiameter(600,500),320);
 assert.equal(remoteCircleDiameter(280,400),196);assert.equal(remoteCircleDiameter(400,180),176);
 assert.equal(remoteCircleDiameter(NaN,0),240);
});
test('TV joystick chooses cardinal repeat direction; resting or invalid movement sends nothing',()=>{
 assert.equal(remoteJoystickDirection(2,.5),'right');assert.equal(remoteJoystickDirection(-2,1),'left');
 assert.equal(remoteJoystickDirection(.4,-3),'up');assert.equal(remoteJoystickDirection(-.2,4),'down');
 assert.equal(remoteJoystickDirection(0,0),null);assert.equal(remoteJoystickDirection(NaN,1),null);
});
