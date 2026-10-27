import { test } from 'node:test';
import assert from 'node:assert/strict';
import { swipeDestination, blockTabSwipe, resetTabSwipe, isTabSwipeBlocked } from '../tabSwipe.ts';
const tabs = ['index','play','actions','pad','launch','setup'];
test('follows visible order in both directions without wrapping', () => {
  assert.equal(swipeDestination(tabs,'play',-120,5), 'actions');
  assert.equal(swipeDestination(tabs,'play',120,5), 'index');
  assert.equal(swipeDestination(tabs,'index',120,5), null);
  assert.equal(swipeDestination(tabs,'setup',-120,5), null);
  assert.equal(swipeDestination(['index','actions','setup'],'index',-120,0), 'actions');
});
test('protects vertical scroll, small movement, multitouch, and remote gestures', () => {
  for (const [x,y,n] of [[20,0,1],[100,60,1],[120,0,2]]) assert.equal(swipeDestination(tabs,'play',x,y,n),null);
  assert.equal(swipeDestination(tabs,'pad',120,0),null);
  assert.equal(swipeDestination(['remote','setup'],'remote',-120,0),null);
  resetTabSwipe(); assert.equal(isTabSwipeBlocked(),false);
  blockTabSwipe(); assert.equal(isTabSwipeBlocked(),true);
  resetTabSwipe(); assert.equal(isTabSwipeBlocked(),false);
});
