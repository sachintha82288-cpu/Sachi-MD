const settings=require('../../services/settings');
module.exports={name:'restart',aliases:['reboot'],category:'owner',emoji:'🔄',description:'Restart the process',ownerOnly:true, mainOnly: true,execute:async({reply})=>{await reply({text:`🔄 Restarting ${settings.name()}...`});setTimeout(()=>process.exit(0),500);}};
