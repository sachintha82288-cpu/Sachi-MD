const test=require('node:test');
const assert=require('node:assert/strict');
const status=require('../src/services/status/manager');

test('normalizes international status numbers',()=>{
  assert.equal(status.normalizeNumber('+94 77 123 4567'),'94771234567');
  assert.equal(status.normalizeNumber('0094771234567'),'94771234567');
});

test('status settings can be toggled',()=>{
  const fs=require('fs');
  const file=require('path').join(require('../src/config').paths.data,'status-settings.json');
  const backup=fs.existsSync(file)?fs.readFileSync(file,'utf8'):null;
  try{
    status.setAutoSeen(true); assert.equal(status.getSettings().autoSeen,true);
    status.setAutoReact(true,'🔥'); assert.equal(status.getSettings().autoReact,true); assert.equal(status.getSettings().reaction,'🔥');
    status.setAutoReact(false); status.setAutoSeen(false);
  } finally {
    if(backup===null){ try{ fs.rmSync(file,{force:true}); }catch{} }
    else fs.writeFileSync(file,backup);
  }
});
