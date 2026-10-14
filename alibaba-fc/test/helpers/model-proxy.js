'use strict';
// The FC HTTP adapter on a loopback port, as the desktop agent loop reaches
// the model proxy, plus a fetch-compatible loopback client on node:http so tests
// may replace globalThis.fetch with their provider fixture at any time.
const http = require('node:http');
const { Readable } = require('node:stream');
const adapter = require('../../src/index.js');

function loopbackFetch(url, { method = 'GET', headers = {}, body, signal } = {}) {
  return new Promise((resolve, reject) => {
    const request = http.request(url, { method, headers: Object.fromEntries(new Headers(headers)), signal }, response => {
      const pairs = Object.entries(response.headers).flatMap(([key, value]) => (Array.isArray(value) ? value : [value]).map(item => [key, item]));
      resolve(new Response(Readable.toWeb(response), { status: response.statusCode, headers: pairs }));
    });
    request.on('error', reject);
    request.end(body);
  });
}

// One server per test process. Each connection closes after its response, and
// the server does not keep the process alive.
let proxy = null;
function proxyUrl() {
  proxy ||= new Promise(resolve => {
    const server = http.createServer((req, res) => { res.shouldKeepAlive = false; return adapter(req, res); });
    server.listen(0, '127.0.0.1', () => { server.unref(); resolve(`http://127.0.0.1:${server.address().port}`); });
  });
  return proxy;
}

module.exports = { loopbackFetch, proxyUrl };
