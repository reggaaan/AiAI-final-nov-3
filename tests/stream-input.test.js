import test from 'node:test';
import assert from 'node:assert/strict';
import { MAX_IMAGE_BYTES, validateStreamInput } from '../lib/stream-input.js';

test('accepts a text prompt', () => {
  assert.equal(validateStreamInput({ prompt: 'Kumusta?' }), null);
});

test('rejects an empty prompt without an image', () => {
  assert.deepEqual(validateStreamInput({ prompt: '  ' }), {
    status: 400,
    error: 'Prompt or image required',
    code: 'INVALID_INPUT'
  });
});

test('rejects non-string input values', () => {
  assert.equal(validateStreamInput({ prompt: 42 }).code, 'INVALID_INPUT');
});

test('rejects prompts longer than the supported limit', () => {
  assert.equal(validateStreamInput({ prompt: 'a'.repeat(20001) }).code, 'INVALID_INPUT');
});

test('accepts an image whose declared MIME type matches its data URL', () => {
  assert.equal(validateStreamInput({
    prompt: '',
    imageBase64: 'data:image/png;base64,YQ==',
    mimeType: 'image/png'
  }), null);
});

test('rejects unsupported or mismatched image types', () => {
  assert.equal(validateStreamInput({
    imageBase64: 'data:image/svg+xml;base64,YQ==',
    mimeType: 'image/svg+xml'
  }).code, 'INVALID_IMAGE');
  assert.equal(validateStreamInput({
    imageBase64: 'data:image/png;base64,YQ==',
    mimeType: 'image/jpeg'
  }).code, 'INVALID_IMAGE');
});

test('rejects malformed base64 image data', () => {
  assert.equal(validateStreamInput({
    imageBase64: 'data:image/png;base64,YQ',
    mimeType: 'image/png'
  }).code, 'INVALID_IMAGE');
});

test('rejects images larger than the configured limit', () => {
  const encodedImage = Buffer.alloc(MAX_IMAGE_BYTES + 1).toString('base64');
  const error = validateStreamInput({
    imageBase64: `data:image/png;base64,${encodedImage}`,
    mimeType: 'image/png'
  });
  assert.equal(error.status, 413);
  assert.equal(error.code, 'IMAGE_TOO_LARGE');
});
