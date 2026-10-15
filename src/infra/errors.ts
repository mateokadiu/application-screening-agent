/**
 * Thrown by model adapters when the run as a whole can't continue: bad key,
 * unknown model, malformed request, or a quota that won't reset for hours.
 * Retrying or escalating each remaining application wouldn't help.
 */
export class FatalLlmError extends Error {}
