export type MorphlyModel = 'M 2.1' | 'M2.5';
export type MorphlyModelId = MorphlyModel | 'morphly-realtime' | 'lucy-2.5';
export const DEFAULT_MORPHLY_MODEL: 'M 2.1';
export const MORPHLY_MODELS: ReadonlyArray<{ id: MorphlyModel; label: string }>;
export const MORPHLY_EDITING_TYPE: 'subject_replacement';
export const M25_MAX_IMAGE_BYTES: number;
export function normalizeMorphlyModel(value?: unknown): MorphlyModelId | null;
export function validateMorphlyReferenceImage(image: unknown): string | null;
