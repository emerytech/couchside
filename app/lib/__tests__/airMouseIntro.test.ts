import test from 'node:test';
import assert from 'node:assert/strict';
import { airMouseIntroState } from '../airMouseIntro.ts';
test('update onboarding waits for hydrated stores before classifying an installation',()=>{
  assert.equal(airMouseIntroState({ready:false,done:false,boxCount:0,tvCount:0}),'wait');
  assert.equal(airMouseIntroState({ready:true,done:false,boxCount:2,tvCount:0}),'offer');
});
test('existing TV-only users qualify; fresh installs retire the update tip before pairing',()=>{
  assert.equal(airMouseIntroState({ready:true,done:false,boxCount:0,tvCount:1}),'offer');
  assert.equal(airMouseIntroState({ready:true,done:false,boxCount:0,tvCount:0}),'fresh');
});
test('opening or dismissing remains final across restarts and later updates',()=>{
  assert.equal(airMouseIntroState({ready:true,done:true,boxCount:2,tvCount:1}),'done');
  assert.equal(airMouseIntroState({ready:true,done:true,boxCount:0,tvCount:0}),'done');
});
