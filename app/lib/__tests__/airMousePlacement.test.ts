import test from 'node:test';
import assert from 'node:assert/strict';
import { airMousePlacement } from '../airMousePlacement.ts';
import {padLayout,moveLayout,verticalMoveLayout,stardewLayout,vampireLayout} from '../padLayout.ts';
test('AIR anchor avoids controls and refuses a fully occupied layout',()=>{
 const bounds={x:10,y:5,w:300,h:280},obstacle={x:210,y:180,w:100,h:100};
 const a=airMousePlacement(bounds,[obstacle]);assert.ok(a);
 assert.ok(a.x>=10&&a.y>=5&&a.x+a.w<=310&&a.y+a.h<=285);
 assert.ok(a.x+a.w+4<=obstacle.x||a.y+a.h+4<=obstacle.y);
 assert.equal(airMousePlacement(bounds,[bounds]),null);
});

test('normal and themed PAD/MOVE reserve a reachable non-overlapping AIR launcher',()=>{
 const inset={top:0,right:0,left:0,bottom:20};
 for(const win of [{width:800,height:360},{width:932,height:430}]){
  const layouts=[padLayout(win,inset),moveLayout(win,inset),stardewLayout(win,inset,'standard'),vampireLayout(win,inset)];
  for(const l of layouts){assert.ok(l.ok);if(l.ok)assert.ok(airMousePlacement(l.play,l.nodes.map(n=>n.hit)));}
 }
 const portrait=verticalMoveLayout({width:430,height:932},inset);assert.ok(portrait.ok);
 if(portrait.ok)assert.ok(airMousePlacement(portrait.play,portrait.nodes.map(n=>n.hit)));
});
