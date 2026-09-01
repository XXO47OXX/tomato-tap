export class RequestBodyError extends Error {
  constructor(message, { code = 'EBADREQUEST', status = 400 } = {}) {
    super(message);
    this.name = 'RequestBodyError';
    this.code = code;
    this.status = status;
  }
}

export function readRequestBody(request, { maxBytes } = {}) {
  if (!Number.isSafeInteger(maxBytes) || maxBytes < 1) {
    throw new Error('request-reader: maxBytes must be a positive safe integer');
  }
  const declaredLength = contentLength(request.headers?.['content-length']);
  if (declaredLength > maxBytes) {
    request.resume?.();
    return Promise.reject(tooLarge(maxBytes));
  }

  return new Promise((resolve, reject) => {
    const chunks = [];
    let size = 0;
    let settled = false;

    const cleanup = () => {
      request.removeListener('data', onData);
      request.removeListener('end', onEnd);
      request.removeListener('error', onError);
      request.removeListener('aborted', onAborted);
    };
    const finish = (fn, value) => {
      if (settled) return;
      settled = true;
      cleanup();
      fn(value);
    };
    const onData = (chunk) => {
      size += chunk.length;
      if (size > maxBytes) {
        finish(reject, tooLarge(maxBytes));
        request.resume?.();
        return;
      }
      chunks.push(chunk);
    };
    const onEnd = () => finish(resolve, Buffer.concat(chunks, size));
    const onError = (error) => finish(reject, new RequestBodyError(
      `tomato-tap: client request error: ${error.message}`,
      { code: error.code || 'EBADREQUEST', status: 400 },
    ));
    const onAborted = () => finish(reject, new RequestBodyError(
      'tomato-tap: client request aborted',
      { code: 'ECANCELED', status: 400 },
    ));

    request.on('data', onData);
    request.once('end', onEnd);
    request.once('error', onError);
    request.once('aborted', onAborted);
  });
}

function contentLength(value) {
  if (value === undefined || value === null || value === '') return 0;
  const text = Array.isArray(value) ? value[0] : value;
  if (!/^\d+$/.test(String(text))) {
    throw new RequestBodyError('tomato-tap: invalid Content-Length header');
  }
  const length = Number(text);
  if (!Number.isSafeInteger(length)) {
    throw new RequestBodyError('tomato-tap: Content-Length is too large', {
      code: 'EREQUESTTOOLARGE',
      status: 413,
    });
  }
  return length;
}

function tooLarge(maxBytes) {
  return new RequestBodyError(
    `tomato-tap: request body exceeds configured limit (${maxBytes} bytes)`,
    { code: 'EREQUESTTOOLARGE', status: 413 },
  );
}
