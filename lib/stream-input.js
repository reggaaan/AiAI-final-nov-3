export const MAX_IMAGE_BYTES = 2 * 1024 * 1024;
const MAX_PROMPT_LENGTH = 20000;
const IMAGE_DATA_URL_PATTERN = /^data:(image\/(?:png|jpeg|webp|gif|heic|heif));base64,([A-Za-z0-9+/]+={0,2})$/i;

export function validateStreamInput({ prompt, imageBase64, mimeType }, maxImageBytes = MAX_IMAGE_BYTES) {
  if ((prompt !== undefined && typeof prompt !== 'string') ||
      (imageBase64 !== undefined && typeof imageBase64 !== 'string') ||
      (mimeType !== undefined && typeof mimeType !== 'string')) {
    return {
      status: 400,
      error: 'Invalid prompt or image data.',
      code: 'INVALID_INPUT'
    };
  }

  if (!prompt?.trim() && !imageBase64) {
    return {
      status: 400,
      error: 'Prompt or image required',
      code: 'INVALID_INPUT'
    };
  }

  if (prompt && prompt.length > MAX_PROMPT_LENGTH) {
    return {
      status: 400,
      error: 'Prompt is too long.',
      code: 'INVALID_INPUT'
    };
  }

  if (imageBase64) {
    const imageMatch = IMAGE_DATA_URL_PATTERN.exec(imageBase64);
    if (!imageMatch || imageMatch[1].toLowerCase() !== mimeType?.toLowerCase()) {
      return {
        status: 400,
        error: 'Please upload a supported image file.',
        code: 'INVALID_IMAGE'
      };
    }

    const encodedImage = imageMatch[2];
    if (encodedImage.length % 4 !== 0) {
      return {
        status: 400,
        error: 'Please upload a valid image file.',
        code: 'INVALID_IMAGE'
      };
    }

    const paddingLength = encodedImage.endsWith('==') ? 2 : encodedImage.endsWith('=') ? 1 : 0;
    const imageSize = Math.floor(encodedImage.length * 3 / 4) - paddingLength;
    if (imageSize > maxImageBytes) {
      return {
        status: 413,
        error: 'Image must be 2 MB or smaller.',
        code: 'IMAGE_TOO_LARGE'
      };
    }
  }

  return null;
}
