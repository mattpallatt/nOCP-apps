// A second adapter, this one for plain Node — proof that app.ts really is
// host-agnostic, not just in theory. Bundled by build.sh the same way
// lambda.ts is (app.ts imports dist/widget.txt via esbuild's text loader,
// so this can't just be run directly through a bare TS runner). Run with:
//   ./build.sh && NOCP_FRAME_TOKEN=dev node dist/serve-local.mjs
//
// Node's global fetch() implementation (undici) provides real Request/
// Response objects, so there's no translation layer to write at all here —
// http.createServer's IncomingMessage/ServerResponse are the only things
// to bridge.
import {createServer} from 'node:http';
import {createApp} from './app';
import {inMemoryWebhookStore} from './webhookStore';

const handleRequest = createApp(
  {
    frameToken: process.env.NOCP_FRAME_TOKEN ?? '',
    title: process.env.NOCP_TITLE ?? 'nOCP',
  },
  inMemoryWebhookStore,
);

const port = Number(process.env.PORT ?? 8787);

const server = createServer((req, res) => {
  void (async () => {
    const url = `http://${req.headers.host ?? `localhost:${port}`}${req.url}`;
    const hasBody = req.method !== 'GET' && req.method !== 'HEAD';
    const request = new Request(url, {
      method: req.method,
      headers: req.headers as Record<string, string>,
      // @ts-expect-error -- Node's Request accepts a Node Readable here even though the DOM lib types don't say so; duplex is required alongside it.
      body: hasBody ? req : undefined,
      duplex: hasBody ? 'half' : undefined,
    });

    const response = await handleRequest(request);
    res.writeHead(response.status, Object.fromEntries(response.headers));
    res.end(Buffer.from(await response.arrayBuffer()));
  })();
});

server.listen(port, () => {
  console.log(`nOCP starter app listening on http://localhost:${port}`);
  console.log(`Try: curl http://localhost:${port}/healthz`);
});
