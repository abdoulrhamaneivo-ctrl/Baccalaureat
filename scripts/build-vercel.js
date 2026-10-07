'use strict';

const fs = require('node:fs');
const path = require('node:path');

const root = path.resolve(__dirname, '..');
const source = path.join(root, 'dist');
const output = path.join(root, 'public');
const socketClient = path.join(root, 'node_modules', 'socket.io', 'client-dist', 'socket.io.min.js');

fs.rmSync(output, { recursive: true, force: true });
fs.cpSync(source, output, { recursive: true });
fs.copyFileSync(socketClient, path.join(output, 'socket.io-client.js'));

const indexPath = path.join(output, 'index.html');
let html = fs.readFileSync(indexPath, 'utf8');
const socketUrl = String(process.env.PETIT_BAC_SOCKET_URL || '').trim().replace(/\/+$/, '');
if (socketUrl && !/^https?:\/\//i.test(socketUrl)) throw new Error('PETIT_BAC_SOCKET_URL doit commencer par https:// ou http://.');
const socketPath = socketUrl ? '/socket.io' : '/api/socket-io';
const bootstrap = `<script>window.PETIT_BAC_SOCKET_URL=${JSON.stringify(socketUrl)};window.PETIT_BAC_SOCKET_PATH=${JSON.stringify(socketPath)};</script><script src="socket.io-client.js"></script>`;
html = html.replace('</head>', `${bootstrap}</head>`);
fs.writeFileSync(indexPath, html);
