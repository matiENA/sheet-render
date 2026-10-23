const path = require('path');
const createBotRouter = require('./routes');
const BotEngine = require('./engine');
const tools = require('./tools');

const botStaticDir = path.join(__dirname, 'public');

module.exports = {
    createBotRouter,
    BotEngine,
    tools,
    botStaticDir
};
