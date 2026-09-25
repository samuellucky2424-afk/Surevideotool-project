import { MORPHLY_EDITING_TYPE, M25_MAX_IMAGE_BYTES, type MorphlyModel } from '../../../shared/morphly-models.js';

type Transform = { prompt: string; enhance: boolean; image: File | null };

export function validateMorphlyImage(model: MorphlyModel, image: File | null): string | null {
  if (!image) return model === 'M2.5' ? 'Upload a replacement subject image before starting M2.5.' : 'Upload a garment reference image before starting.';
  if (!image.type.startsWith('image/')) return 'Select an image file.';
  if (model === 'M2.5' && image.size > M25_MAX_IMAGE_BYTES) return 'M2.5 reference images must be 3 MB or smaller. Resize the image and try again.';
  return null;
}

export function buildMorphlyControls(model: MorphlyModel, transform: Transform) {
  if (model === 'M2.5') {
    const error = validateMorphlyImage(model, transform.image);
    if (error) throw new Error(error);
    return { image: transform.image!, editingType: MORPHLY_EDITING_TYPE };
  }
  return { prompt: transform.prompt, enhance: transform.enhance, image: transform.image };
}

export function buildMorphlyConnectOptions(model: MorphlyModel, transform: Transform) {
  return {
    model,
    ...buildMorphlyControls(model, transform),
    ...(model === 'M 2.1' ? { enhancePrompt: transform.enhance } : {}),
    audio: false,
    maxSessionSeconds: 300,
  };
}
