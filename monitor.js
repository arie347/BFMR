const Monitor = require('./src/monitor');
const logger = require('./src/logger');

const monitor = new Monitor();

// Graceful shutdown
process.on('SIGINT', () => {
    logger.log('\n👋 Shutting down gracefully...');
    monitor.stop();
    process.exit(0);
});

process.on('SIGTERM', () => {
    logger.log('\n👋 Shutting down gracefully...');
    monitor.stop();
    process.exit(0);
});

// Start monitoring
monitor.start().catch(error => {
    logger.log(`Fatal error: ${error.message}`, 'ERROR');
    process.exit(1);
});
