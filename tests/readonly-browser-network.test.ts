import assert from 'node:assert/strict';
import {test} from 'node:test';
import {createServer, type Server} from 'node:http';
import {mkdtempSync, rmSync} from 'node:fs';
import {join} from 'node:path';
import {tmpdir} from 'node:os';
import {PlaywrightRuntime} from '../src/runtime/browser/playwright-runtime.js';
import {readonlyFixture} from './fixtures/readonly-browser.js';
import {readonlyBrowserAcceptance} from '../src/verifier/readonly-browser-verifier.js';

async function listen(server: Server) {
  await new Promise<void>(done => server.listen(0, '127.0.0.1', done));
  const address = server.address();
  if (!address || typeof address === 'string') throw Error('missing local port');
  return `http://127.0.0.1:${address.port}`;
}
const close = (server: Server) => new Promise<void>((done, reject) => server.close(error => error ? reject(error) : done()));

test('isolated readonly Chromium blocks redirects/resources/automatic navigation before the denied server receives a request', async () => {
  const deniedHits: string[] = [], allowedHits: string[] = [];
  const denied = createServer((request, response) => {
    deniedHits.push(request.url ?? ''); response.end('UNAUTHORIZED');
  });
  const deniedBase = await listen(denied);
  const title = 'Local Readonly Title', marker = 'LOCAL-READONLY-MARKER';
  const document = `<html><head><title>${title}</title></head><body>${marker}</body></html>`;
  const allowed = createServer((request, response) => {
    const path = request.url ?? ''; allowedHits.push(path);
    response.setHeader('Content-Type', 'text/html; charset=utf-8');
    if (path === '/302' || path === '/same-origin-302') {
      response.writeHead(302, {Location: path === '/302' ? `${deniedBase}/redirect` : '/unauthorized'}); response.end();
    } else if (path === '/refresh-header') {
      response.setHeader('Refresh', `0; url=${deniedBase}/refresh`); response.end(document);
    } else if (path === '/download') {
      response.setHeader('Content-Disposition', 'attachment; filename="synthetic.html"'); response.end(document);
    } else if (path === '/resources') {
      response.end(document.replace('</body>', `<script src="${deniedBase}/script"></script><img src="${deniedBase}/image">
        <iframe src="${deniedBase}/frame"></iframe><img src="/unauthorized"></body>`));
    } else if (path === '/automatic') {
      response.end(document.replace('</head>', `<meta http-equiv="refresh" content="0;url=${deniedBase}/meta"></head>`)
        .replace('</body>', `<script>document.body.textContent='SCRIPT-RAN';location.href='${deniedBase}/script-navigation';</script></body>`));
    } else response.end(document);
  });
  const base = await listen(allowed), dir = mkdtempSync(join(tmpdir(), 'readonly-network-'));
  try {
    for (const path of ['/302', '/same-origin-302', '/refresh-header', '/download', '/resources', '/automatic', '/safe']) {
      const url = base + path, hitsBefore = allowedHits.length;
      const runtime = await PlaywrightRuntime.launch({headless: true, readonlyBrowserUrl: url, artifactDir: join(dir, path.slice(1))});
      try {
        const result = await runtime.execute({kind: 'navigate', url});
        if (['/302', '/same-origin-302', '/refresh-header', '/download'].includes(path)) {
          assert.equal(result.ok, false, path);
          await assert.rejects(runtime.observe(), /readonly-browser-network/, 'denied response cannot become usable proof');
        } else {
          assert.equal(result.ok, true, path);
          // Wait for meta refresh / delayed resource loading, not only initial goto completion.
          await runtime.execute({kind: 'wait', ms: 150});
          if (path === '/automatic') {
            await runtime.observe().then(observation => {
              assert.equal(observation.url, url); assert.doesNotMatch(observation.pageText ?? '', /SCRIPT-RAN/);
            }, error => assert.match(String(error), /readonly-browser-network-navigation-denied/));
          } else {
            const observation = await runtime.observe();
            const prepared = readonlyFixture('Read the local page identity.', url, title, marker);
            assert.equal(readonlyBrowserAcceptance(prepared.request.goal, prepared.completionCriteria, observation,
              prepared.verificationContract, prepared.taskContract).verdict, 'pass');
          }
        }
        assert.deepEqual(allowedHits.slice(hitsBefore), [path], 'only the exact frozen document reached the network');
        assert.deepEqual(deniedHits, [], 'third-party server receives zero requests, including redirects');
        const beforeWrongAction = allowedHits.length;
        assert.equal((await runtime.execute({kind: 'navigate', url: `${base}/unauthorized`})).ok, false);
        await assert.rejects(runtime.restore({url: `${base}/unauthorized`}), /readonly-browser-runtime-url-denied/);
        assert.equal((await runtime.execute({kind: 'click', target: {kind: 'text', text: marker}})).ok, false);
        assert.equal(allowedHits.length, beforeWrongAction);
        if (path === '/safe') {
          const restored = await PlaywrightRuntime.launch({headless: true, readonlyBrowserUrl: url, artifactDir: join(dir, 'restored')});
          try {
            await restored.restore({url});
            assert.equal((await restored.observe()).url, url);
            assert.deepEqual(allowedHits.slice(beforeWrongAction), [path]);
            assert.deepEqual(deniedHits, []);
          } finally {await restored.close();}
        }
      } finally {await runtime.close();}
    }
    await assert.rejects(PlaywrightRuntime.launch({readonlyBrowserUrl: base + '/safe', userDataDir: join(dir, 'profile')}), /invalid-binding/);
    assert.throws(() => PlaywrightRuntime.attach({} as never, {readonlyBrowserUrl: base + '/safe'}), /isolated-context/);
    // Opt-in only: ordinary Browser behavior still follows redirects to local synthetic pages.
    const generic = await PlaywrightRuntime.launch({headless: true, artifactDir: join(dir, 'generic')});
    try {
      assert.equal((await generic.execute({kind: 'navigate', url: base + '/302'})).ok, true);
      assert.deepEqual(deniedHits, ['/redirect']);
    } finally {await generic.close();}
  } finally {await close(allowed); await close(denied); rmSync(dir, {recursive: true, force: true});}
});
