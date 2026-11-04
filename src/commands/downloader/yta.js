const { sendYoutube } = require('./ytv');
module.exports = {
  name: 'yta', aliases: ['ytaudio', 'song'], category: 'download', emoji: '🎧',
  description: 'Download YouTube audio with bitrate selection',
  execute: async ctx => sendYoutube(ctx, ctx.args[0], 'audio', undefined, ctx.args[1]),
};
