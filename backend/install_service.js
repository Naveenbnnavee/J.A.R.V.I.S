const { Service } = require('node-windows');
const path = require('path');

// Create a new service object
const svc = new Service({
  name: 'JarvisOS_Backend',
  description: 'The Jarvis Node.js Backend Brain.',
  script: path.join(__dirname, 'server.js'),
  nodeOptions: [
    '--harmony',
    '--max_old_space_size=4096'
  ]
});

// Listen for the "install" event, which indicates the
// process is available as a service.
svc.on('install', function() {
  console.log('[node-windows] Jarvis OS Backend Service installed successfully.');
  svc.start();
  console.log('[node-windows] Service started.');
});

// Listen for the "alreadyinstalled" event
svc.on('alreadyinstalled', function() {
  console.log('[node-windows] Service is already installed.');
});

// Listen for the "start" event
svc.on('start', function() {
  console.log('[node-windows] Service is running.');
});

svc.install();
