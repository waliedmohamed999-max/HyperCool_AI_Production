// Hosting entry: always start, including when LiteSpeed loads this with require().
import {startServer} from './application.js';
console.log('HyperCool: src/server.js entry loaded');
startServer().catch(error=>{console.error('Server startup failed:',error);process.exitCode=1;});
