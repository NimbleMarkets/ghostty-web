export {};

declare global {
  /** Whole, tightly packed Kitty pixel buffers, consumed by a t=s transmission. */
  var ghosttyKittySharedMemory: Map<string, Uint8Array> | undefined;
}
