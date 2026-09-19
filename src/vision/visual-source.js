export const STACKCHAN_CAMERA_SOURCE = 'stackchan_camera'
export const EMBODIED_TRANSIENT_VISUAL_CLASS = 'embodied_transient'
export const STACKCHAN_CAMERA_PROMPT = '花花通过实体身体的摄像头主动看了看现实环境。请直接告诉主人你看到了什么。'

export function isEmbodiedTransientAttachment(value) {
  return value?.visualClass === EMBODIED_TRANSIENT_VISUAL_CLASS
    || value?.source === STACKCHAN_CAMERA_SOURCE
}

export function allowsLongTermVisualMemory(value) {
  return !isEmbodiedTransientAttachment(value)
}

export function embodiedTransientExperienceMetadata(candidateImportance = 0) {
  const candidate = Number(candidateImportance)
  return {
    sourceType: 'embodied_visual_observation',
    visualClass: EMBODIED_TRANSIENT_VISUAL_CLASS,
    importanceScore: Math.min(0.6, Math.max(0.3, Number.isFinite(candidate) ? candidate : 0)),
    attachmentId: null,
    rawImageAsMemorySource: false,
  }
}

export function isStackchanCameraMessage(message) {
  return isEmbodiedTransientAttachment(message?.attachment)
    || message?.source === STACKCHAN_CAMERA_SOURCE
    || String(message?.text ?? '').trim() === STACKCHAN_CAMERA_PROMPT
}
