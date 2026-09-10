// LiteSpeed loads the entry point with require(); import the ESM app asynchronously.
console.log('HyperCool: app.cjs entry loaded');
import('./src/application.js')
  .then(({ startServer }) => startServer())
  .catch(error => {
    console.error('HyperCool startup failed:', error);
    process.exitCode = 1;
  });
