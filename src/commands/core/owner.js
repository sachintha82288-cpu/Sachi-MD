const settings=require('../../services/settings');
module.exports={name:'owner',aliases:['creator','me'],category:'tools',emoji:'👑',description:'Show the bot owner',execute:async({reply,config})=>reply({text:`👑 *${settings.name()} Owner*\n\n📱 ${config.owner?config.owner.split('@')[0]:'Not connected yet'}\n🤖 ${settings.name()}\n⚡ Fast • Smart • Clean`})};
