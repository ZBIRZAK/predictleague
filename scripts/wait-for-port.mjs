import net from 'node:net';

const portArg = process.argv[2];
const port = Number(portArg);
const host = process.argv[3] ?? '127.0.0.1';

if (!Number.isInteger(port) || port <= 0 || port > 65535) {
  console.error('Usage: node scripts/wait-for-port.mjs <port> [host]');
  process.exit(1);
}

const deadlineMs = Date.now() + 30_000;

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function waitForPort() {
  while (Date.now() < deadlineMs) {
    const opened = await new Promise((resolve) => {
      const socket = net.createConnection({ host, port });
      socket.once('connect', () => {
        socket.end();
        resolve(true);
      });
      socket.once('error', () => {
        socket.destroy();
        resolve(false);
      });
      socket.setTimeout(800, () => {
        socket.destroy();
        resolve(false);
      });
    });

    if (opened) {
      return;
    }
    await sleep(250);
  }
  throw new Error(`Timed out waiting for ${host}:${port}`);
}

waitForPort()
  .then(() => {
    console.log(`API ready on ${host}:${port}`);
  })
  .catch((error) => {
    console.error(error instanceof Error ? error.message : 'Failed to wait for port.');
    process.exit(1);
  });
