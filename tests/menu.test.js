const test=require('node:test');const assert=require('node:assert/strict');const menu=require('../src/menu/menu');
test('has clean categories',()=>{assert.deepEqual(menu.categories.map(x=>x.id),['download','status','media','tools','group','ai','settings','owner']);});
