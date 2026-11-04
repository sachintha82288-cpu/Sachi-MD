const test=require('node:test');const assert=require('node:assert/strict');const {unwrapMessage,extractText}=require('../src/utils/messages');
test('unwraps ephemeral text',()=>{const m={ephemeralMessage:{message:{conversation:'.menu'}}};assert.equal(extractText(m),'.menu');assert.equal(unwrapMessage(m).conversation,'.menu');});
