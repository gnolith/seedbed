import { createServer } from 'node:http';

const server = createServer((request, response) => {
  let body = '';
  request.setEncoding('utf8');
  request.on('data', (chunk) => { body += chunk; });
  request.on('end', () => {
    const input = JSON.parse(body).input;
    response.setHeader('content-type', 'application/json');
    response.end(JSON.stringify({
      data: input.map(() => ({ embedding: [1, 0] })),
      usage: { total_tokens: input.length * 3 },
    }));
  });
});

server.listen(0, '0.0.0.0', () => {
  const address = server.address();
  if (!address || typeof address === 'string') throw new Error('deterministic provider did not bind');
  process.stdout.write(`${address.port}\n`);
});

for (const signal of ['SIGINT', 'SIGTERM']) {
  process.on(signal, () => server.close(() => process.exit(0)));
}
