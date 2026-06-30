const os = require('node:os');
const net = require('node:net');

const originalNetworkInterfaces = os.networkInterfaces.bind(os);
const originalListen = net.Server.prototype.listen;

net.Server.prototype.listen = function listenWithLocalhostFallback(...args) {
  if (process.env.WDIO_FORCE_LOCALHOST_BIND !== '0') {
    if (args[0] && typeof args[0] === 'object' && (!args[0].host || args[0].host === '0.0.0.0')) {
      args[0] = { ...args[0], host: '127.0.0.1' };
    } else if (typeof args[0] === 'number' && (!args[1] || args[1] === '0.0.0.0')) {
      args.splice(1, 0, '127.0.0.1');
    }
  }

  return originalListen.apply(this, args);
};

os.networkInterfaces = function networkInterfacesWithLocalhostFallback() {
  try {
    return originalNetworkInterfaces();
  } catch (error) {
    if (process.env.WDIO_NETWORK_FALLBACK_LOG !== '0') {
      process.stderr.write(
        `[wdio-network-fallback] os.networkInterfaces() failed: ${error?.message || error}. Falling back to localhost only.\n`
      );
    }

    return {
      lo: [
        {
          address: '127.0.0.1',
          netmask: '255.0.0.0',
          family: 'IPv4',
          mac: '00:00:00:00:00:00',
          internal: true,
          cidr: '127.0.0.1/8'
        },
        {
          address: '::1',
          netmask: 'ffff:ffff:ffff:ffff:ffff:ffff:ffff:ffff',
          family: 'IPv6',
          mac: '00:00:00:00:00:00',
          internal: true,
          cidr: '::1/128',
          scopeid: 0
        }
      ]
    };
  }
};
