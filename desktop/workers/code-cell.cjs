'use strict';
// Runs only inside the deny-by-default OS sandbox. Node vm is NOT the security boundary.
const readline = require('node:readline');
const send = value => process.stdout.write(JSON.stringify(value) + '\n');
// Exit only after the terminal protocol record has reached the parent pipe.
const finish = (value, code) => process.stdout.write(JSON.stringify(value) + '\n', () => process.exit(code));
const pending = new Map(); let started = false, sequence = 0;
const tools = new Proxy(Object.create(null), { get: (_, name) => args => new Promise((resolve, reject) => {
  const id = ++sequence; pending.set(id, { resolve, reject }); send({ type: 'call', id, name, args: args || {} });
}) });
const rl = readline.createInterface({ input: process.stdin });
rl.on('line', line => {
  try {
    const message = JSON.parse(line);
    if (!started) {
      started = true;
      const AsyncFunction = Object.getPrototypeOf(async function () {}).constructor;
      Promise.resolve(new AsyncFunction('tools', 'text', message.code)(tools, value => send({ type: 'text', value })))
        .then(value => finish({ type: 'result', value }, 0), error => finish({ type: 'error', error: String(error.message) }, 1));
    } else {
      const call = pending.get(message.id); if (!call) throw new Error('Unknown reply'); pending.delete(message.id);
      message.result?.ok === false ? call.reject(Object.assign(new Error(message.result.error?.message || 'Tool failed'), { code: message.result.error?.code })) : call.resolve(message.result?.value);
    }
  } catch (error) { finish({ type: 'error', error: error.message }, 1); }
});
