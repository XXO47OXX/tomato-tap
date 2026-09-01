import assert from 'node:assert/strict';
import test from 'node:test';

import {
  deliverResponseToClient,
  rejectByPath,
} from '../src/gateway/http-response.mjs';

function responseRecorder() {
  return {
    status: null,
    headers: null,
    body: null,
    writeHead(status, headers) {
      this.status = status;
      this.headers = headers;
    },
    end(body = Buffer.alloc(0)) {
      this.body = Buffer.isBuffer(body) ? body : Buffer.from(String(body));
    },
  };
}

test('deliverResponseToClient replaces buffered transport headers', () => {
  const res = responseRecorder();
  deliverResponseToClient(res, {
    status: 201,
    headers: {
      'content-type': 'application/json',
      'content-length': '999',
      'transfer-encoding': 'chunked',
      'set-cookie': ['upstream-session=secret'],
      connection: 'keep-alive',
    },
    body: Buffer.from('{"ok":true}'),
  });

  assert.equal(res.status, 201);
  assert.equal(res.headers['content-type'], 'application/json');
  assert.equal(res.headers['content-length'], '11');
  assert.equal(res.headers['transfer-encoding'], undefined);
  assert.equal(res.headers['set-cookie'], undefined);
  assert.equal(res.headers.connection, undefined);
  assert.equal(res.body.toString(), '{"ok":true}');
});

test('rejectByPath follows the configured protocol format', () => {
  const anthropic = responseRecorder();
  rejectByPath(anthropic, '/direct/v1/messages', 503, 'busy', { format: 'anthropic' });
  assert.equal(anthropic.status, 503);
  assert.deepEqual(JSON.parse(anthropic.body), {
    type: 'error',
    error: { type: 'mimo_tap_blocked', message: 'busy' },
  });

  const openai = responseRecorder();
  rejectByPath(openai, '/direct/v1/chat/completions', 503, 'busy', { format: 'openai' });
  assert.equal(openai.status, 503);
  assert.deepEqual(JSON.parse(openai.body), {
    error: { code: '503', type: 'mimo_tap_blocked', message: 'busy' },
  });

  const method = responseRecorder();
  rejectByPath(method, '/oa/v1/chat/completions', 405, 'POST required', { format: 'openai' }, {
    allow: 'POST',
  });
  assert.equal(method.headers.allow, 'POST');
});
