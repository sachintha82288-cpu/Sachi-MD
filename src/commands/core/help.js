const menu=require('../../menu/menu');
module.exports={name:'help',aliases:['commands','h'],category:'tools',emoji:'❓',description:'Show command help',execute:async({reply,args,commands})=>reply({text:menu.help(commands,args[0]?.toLowerCase())})};
