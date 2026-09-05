export function isLatestPetRenderSequence(currentSequence: number | undefined, requestedSequence: number): boolean {
  return currentSequence === requestedSequence;
}
