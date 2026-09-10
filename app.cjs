// LiteSpeed loads the entry point with require(); import the ESM app asynchronously.
import('./src/server.js')
  .then(({ startServer }) => startServer())
  .catch(error => {
    console.error('HyperCool startup failed:', error);
    process.exitCode = 1;
  });
