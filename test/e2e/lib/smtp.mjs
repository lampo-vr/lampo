// A stand-in mail relay for the browser suites: a plain SMTP server on 127.0.0.1 that takes every message it is handed
// and keeps it (sender, recipients, the raw text), so a suite can see that the app's relay settings work end to end
// without anything leaving the machine. Loopback only, no TLS (the app allows plain SMTP to loopback), no AUTH asked.
import net from 'node:net';

/** Starts the relay; `messages` fills as mail arrives; `close()` stops it. */
export async function startSmtp() {
  const messages = [];
  const server = net.createServer((socket) => {
    socket.setEncoding('utf8');
    let buffer = '';
    let data = null;
    let msg = { from: null, to: [], text: '' };
    const say = (line) => socket.write(`${line}\r\n`);
    say('220 stand-in relay ready');
    socket.on('data', (chunk) => {
      buffer += chunk;
      let i = buffer.indexOf('\r\n');
      while (i >= 0) {
        const line = buffer.slice(0, i);
        buffer = buffer.slice(i + 2);
        if (data !== null) {
          if (line === '.') {
            msg.text = data.join('\n');
            messages.push(msg);
            msg = { from: null, to: [], text: '' };
            data = null;
            say('250 queued');
          } else data.push(line.startsWith('..') ? line.slice(1) : line);
        } else {
          const cmd = line.slice(0, 4).toUpperCase();
          if (cmd === 'EHLO') socket.write('250-stand-in\r\n250-8BITMIME\r\n250 SIZE 10485760\r\n');
          else if (cmd === 'HELO') say('250 stand-in');
          else if (cmd === 'MAIL') {
            msg.from = /<([^>]*)>/.exec(line)?.[1] ?? null;
            say('250 ok');
          } else if (cmd === 'RCPT') {
            msg.to.push(/<([^>]*)>/.exec(line)?.[1] ?? '');
            say('250 ok');
          } else if (cmd === 'DATA') {
            data = [];
            say('354 go on');
          } else if (cmd === 'RSET') {
            msg = { from: null, to: [], text: '' };
            say('250 ok');
          } else if (cmd === 'QUIT') {
            say('221 bye');
            socket.end();
          } else if (cmd === 'NOOP') say('250 ok');
          else say('502 not here');
        }
        i = buffer.indexOf('\r\n');
      }
    });
    socket.on('error', () => {});
  });
  await new Promise((ok) => server.listen(0, '127.0.0.1', ok));
  const { port } = server.address();
  return { port, url: `smtp://127.0.0.1:${port}`, messages, close: () => new Promise((ok) => server.close(ok)) };
}
