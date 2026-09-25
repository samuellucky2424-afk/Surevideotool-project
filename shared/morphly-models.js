export const DEFAULT_MORPHLY_MODEL = 'M 2.1';
export const MORPHLY_MODELS = [
  { id: 'M 2.1', label: 'M2.1' },
  { id: 'M2.5', label: 'M2.5' },
];
export const MORPHLY_EDITING_TYPE = 'subject_replacement';
// Base64 adds ~33%; leave room below the hosted API's 4.5 MB request limit.
export const M25_MAX_IMAGE_BYTES = 3 * 1024 * 1024;

export function normalizeMorphlyModel(value = DEFAULT_MORPHLY_MODEL) {
  if (typeof value !== 'string') return null;
  switch (value.replace(/\s/g, '').toLowerCase()) {
    case 'm2.1': return 'M 2.1';
    case 'm2.5': return 'M2.5';
    // Preserve the provider's existing public aliases for older clients.
    case 'morphly-realtime': return 'morphly-realtime';
    case 'lucy-2.5': return 'lucy-2.5';
    default: return null;
  }
}

export function validateMorphlyReferenceImage(image) {
  if (typeof image !== 'string' || !image) return 'M2.5 requires a replacement subject image.';
  if (image.length > Math.ceil(M25_MAX_IMAGE_BYTES / 3) * 4 + 128) {
    return 'M2.5 reference images must be 3 MB or smaller. Resize the image and try again.';
  }
  if (/^data:image\/[a-zA-Z0-9.+-]+;base64,[A-Za-z0-9+/]+={0,2}$/.test(image)) return null;
  if (/^ssupload:\?id=\S+$/.test(image)) return null;
  try {
    const url = new URL(image);
    if (['https:', 'http:'].includes(url.protocol) && !url.username && !url.password) return null;
  } catch { /* Return an actionable validation error below. */ }
  return 'M2.5 requires an image URL or a base64 image.';
}
