// Load .env before anything reads process.env.
require('./src/utils/envLoader').loadEnv();
require('./src/app');
