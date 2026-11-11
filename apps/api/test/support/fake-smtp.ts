import { createServer, Server, Socket } from 'node:net';

export interface Received {
  from: string;
  to: string[];
  data: string;
}

/** A minimal SMTP server for tests (no relay, no auth): enough for nodemailer to deliver one message. */
export async function startFakeSmtp(): Promise<{ port: number; received: Received[]; close(): Promise<void> }> {
  const received: Received[] = [];
  const sockets = new Set<Socket>();
  const server: Server = createServer((socket) => {
    sockets.add(socket);
    socket.on('close', () => sockets.delete(socket));
    let inData = false;
    let current: Received = { from: '', to: [], data: '' };
    let buffer = '';
    socket.write('220 fake ESMTP\r\n');
    socket.on('data', (chunk) => {
      buffer += chunk.toString('utf8');
      for (;;) {
        if (inData) {
          const end = buffer.indexOf('\r\n.\r\n');
          if (end === -1) return;
          current.data = buffer.slice(0, end);
          buffer = buffer.slice(end + 5);
          inData = false;
          received.push(current);
          current = { from: '', to: [], data: '' };
          socket.write('250 OK queued as fake-id\r\n');
          continue;
        }
        const nl = buffer.indexOf('\r\n');
        if (nl === -1) return;
        const line = buffer.slice(0, nl);
        buffer = buffer.slice(nl + 2);
        const cmd = line.toUpperCase();
        if (cmd.startsWith('EHLO') || cmd.startsWith('HELO')) socket.write('250 fake\r\n');
        else if (cmd.startsWith('MAIL FROM')) { current.from = line.slice(10); socket.write('250 OK\r\n'); }
        else if (cmd.startsWith('RCPT TO')) { current.to.push(line.slice(8)); socket.write('250 OK\r\n'); }
        else if (cmd === 'DATA') { inData = true; socket.write('354 go\r\n'); }
        else if (cmd === 'QUIT') { socket.write('221 bye\r\n'); socket.end(); }
        else socket.write('250 OK\r\n');
      }
    });
    socket.on('error', () => undefined);
  });
  await new Promise<void>((res) => server.listen(0, '127.0.0.1', res));
  const port = (server.address() as { port: number }).port;
  return { port, received, close: () => new Promise((res) => { server.close(() => res()); sockets.forEach((s) => s.destroy()); }) };
}
