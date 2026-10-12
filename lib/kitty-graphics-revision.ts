// Pixel pointers can be reused after a retransmit. A revision distinguishes
// image contents without hashing the framebuffer on every render. Revisions
// are unique across terminals too, so reset cannot reuse a renderer's cache.
let nextRevision = 0;

export class KittyGraphicsRevision {
  value = ++nextRevision;
  private state = 0;

  write(data: string | Uint8Array): void {
    for (let i = 0; i < data.length; i++) {
      const c = typeof data === 'string' ? data.charCodeAt(i) : data[i];
      switch (this.state) {
        case 0:
          this.state = c === 0x1b ? 1 : 0;
          break;
        case 1:
          this.state = c === 0x5f ? 2 : c === 0x1b ? 1 : 0;
          break;
        case 2:
          this.state = c === 0x47 ? 3 : c === 0x1b ? 1 : 0;
          break;
        case 3:
          if (c === 0x1b) this.state = 4;
          break;
        case 4:
          if (c === 0x5c) {
            this.value = ++nextRevision;
            this.state = 0;
          } else {
            this.state = c === 0x1b ? 4 : 3;
          }
          break;
      }
    }
  }
}
