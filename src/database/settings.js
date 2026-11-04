const config = require('../config');
const { atomicJsonWrite, safeJsonRead } = require('../utils/files');
function save(patch) { atomicJsonWrite(config.paths.settings, { ...safeJsonRead(config.paths.settings, {}), ...patch }); }
module.exports = { save };
