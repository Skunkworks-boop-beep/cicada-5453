#!/usr/bin/env node
/**
 * Remote connect launcher: SSH tunnel to a more powerful machine and open the app.
 * Usage:
 *   REMOTE_USER=user REMOTE_HOST=192.168.1.10 REMOTE_PASSWORD=secret node scripts/remote-connect.mjs
 *   node scripts/remote-connect.mjs   # prompts for user, host, password
 *
 * Optional: REMOTE_APP_PATH=/path/on/remote to run "npm run dev" and uvicorn on the remote.
 * Optional: REMOTE_START=1 to run the start command on the remote (default 0).
 */

import { Client } from 'ssh2';
import net from 'net';
import { createInterface } from 'readline';
import { exec } from 'child_process';
import { platform } from 'os';

const LOCAL_FRONTEND = parseInt(process.env.REMOTE_LOCAL_FRONTEND_PORT || '5173', 10);
const LOCAL_BACKEND = parseInt(process.env.REMOTE_LOCAL_BACKEND_PORT || '8000', 10);
const REMOTE_FRONTEND = 5173;
const REMOTE_BACKEND = 8000;

function question(rl, prompt) {
  return new Promise((resolve) => {
    rl.question(prompt, (answer) => resolve(answer?.trim() ?? ''));
  });
}

function openBrowser(url) {
  const cmd = platform() === 'win32' ? `start ${url}` : platform() === 'darwin' ? `open "${url}"` : `xdg-open "${url}"`;
  exec(cmd, (err) => {
    if (err) console.warn('Could not open browser:', err.message);
  });
}

function createForwardServer(conn, remoteHost, remotePort, localPort, label) {
  const server = net.createServer((localSocket) => {
    conn.forwardOut('127.0.0.1', 0, remoteHost, remotePort, (err, stream) => {
      if (err) {
        localSocket.destroy();
        return;
      }
      stream.pipe(localSocket).pipe(stream);
      stream.on('close', () => localSocket.destroy());
      localSocket.on('close', () => stream.close());
    });
  });
  server.listen(localPort, '127.0.0.1', () => {
    console.log(`  [${label}] localhost:${localPort} -> ${remoteHost}:${remotePort}`);
  });
  return server;
}

async function main() {
  let user = process.env.REMOTE_USER;
  let host = process.env.REMOTE_HOST;
  let password = process.env.REMOTE_PASSWORD;
  const appPath = process.env.REMOTE_APP_PATH || 'cicada-5453';
  const shouldStart = process.env.REMOTE_START === '1' || process.env.REMOTE_START === 'true';

  if (!user || !host) {
    const rl = createInterface({ input: process.stdin, output: process.stdout });
    if (!user) user = await question(rl, 'Remote username: ');
    if (!host) host = await question(rl, 'Remote host (IP or hostname): ');
    if (!password) password = await question(rl, 'Password (leave empty for SSH key): ');
    rl.close();
  }

  if (!user || !host) {
    console.error('Set REMOTE_USER and REMOTE_HOST (or enter when prompted).');
    process.exit(1);
  }

  const conn = new Client();

  // Build connect config: use password if provided, otherwise SSH agent (same as terminal)
  const connectConfig = {
    host,
    port: parseInt(process.env.REMOTE_PORT || '22', 10),
    username: user,
    readyTimeout: 20000,
  };
  if (password) {
    connectConfig.password = password;
  } else {
    // Use SSH agent (SSH_AUTH_SOCK) — same keys as terminal ssh
    const agentSocket = process.env.SSH_AUTH_SOCK;
    if (agentSocket) {
      connectConfig.agent = agentSocket;
    } else if (process.platform === 'win32') {
      connectConfig.agent = 'pageant';
    } else {
      console.warn('No password and no SSH_AUTH_SOCK. Start ssh-agent and add your key, or set REMOTE_PASSWORD.');
    }
  }

  conn.on('ready', () => {
    console.log('SSH connected. Port forwarding active.');
    createForwardServer(conn, '127.0.0.1', REMOTE_FRONTEND, LOCAL_FRONTEND, 'frontend');
    createForwardServer(conn, '127.0.0.1', REMOTE_BACKEND, LOCAL_BACKEND, 'backend');

    if (shouldStart && appPath) {
      const cmd = `cd ${appPath} && (npm run dev &) && (cd python && source venv/bin/activate && uvicorn cicada_nn.api:app --host 0.0.0.0 --port ${REMOTE_BACKEND} &)`;
      conn.exec(cmd, (err, stream) => {
        if (err) {
          console.warn('Remote start failed:', err.message);
          return;
        }
        stream.on('close', () => {}).stderr.on('data', (d) => process.stderr.write(d));
      });
    }

    setTimeout(() => {
      openBrowser('http://localhost:5173');
      console.log('\nBrowser opened. Use the app at http://localhost:5173');
      console.log('Press Ctrl+C to stop the tunnel.\n');
    }, 1000);
  })
    .on('error', (err) => {
      console.error('SSH error:', err.message);
      process.exit(1);
    })
    .connect(connectConfig);
}

main();
