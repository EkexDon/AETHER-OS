/**
 * bytes — small byte-transport helpers shared between the terminal UI and
 * its tests. Keeping them in a dependency-free module makes the critical
 * base64 round-trip trivially unit-testable.
 */

/** Decode a base64 string into raw bytes (atob yields a binary string). */
export function base64ToBytes(base64: string): Uint8Array {
  const binary = atob(base64);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
  return bytes;
}

/** Encode raw bytes as base64 (inverse of {@link base64ToBytes}). */
export function bytesToBase64(bytes: Uint8Array): string {
  let binary = "";
  for (let i = 0; i < bytes.length; i++) binary += String.fromCharCode(bytes[i]);
  return btoa(binary);
}
