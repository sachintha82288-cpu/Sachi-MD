const settings=require('../../services/settings');
module.exports={name:'ping',aliases:['pong'],category:'tools',emoji:'🏓',description:'Check bot latency',execute:async({reply})=>{const t=Date.now();await reply({text:'🏓 Checking...'});await reply({text:`🏓 *Pong!*\n\n⚡ ${Date.now()-t} ms\n🤖 ${settings.name()} is online.`});}};
