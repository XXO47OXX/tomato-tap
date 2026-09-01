import assert from 'node:assert/strict';
import { Readable } from 'node:stream';
import test from 'node:test';

import { readRequestBody, RequestBodyError } from '../src/gateway/request-reader.mjs';

function request(chunks, headers = {}) {
  const stream = Readable.from(chunks);
  stream.headers = headers;
  return stream;
}

test('request reader returns a bounded request body', async () => {
  const body = await readRequestBody(request([Buffer.from('hello'), Buffer.from(' world')]), {
    maxBytes: 11,
  });
  assert.equal(body.toString(), 'hello world');
});

test('request reader rejects declared and streamed oversized bodies', async () => {
  await assert.rejects(
    readRequestBody(request([], { 'content-length': '12' }), { maxBytes: 10 }),
    (error) => error instanceof RequestBodyError
      && error.status === 413
      && error.code === 'EREQUESTTOOLARGE',
  );
  await assert.rejects(
    readRequestBody(request([Buffer.alloc(6), Buffer.alloc(6)]), { maxBytes: 10 }),
    (error) => error instanceof RequestBodyError && error.status === 413,
  );
});

test('request reader rejects malformed Content-Length', async () => {
  await assert.rejects(
    async () => readRequestBody(request([], { 'content-length': 'not-a-number' }), { maxBytes: 10 }),
    (error) => error instanceof RequestBodyError && error.status === 400,
  );
});
