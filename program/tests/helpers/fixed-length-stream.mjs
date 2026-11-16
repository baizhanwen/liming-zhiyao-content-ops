// Node-only adapter for route unit tests. Native workerd/R2 is verified
// separately; this does not claim Node's stream has R2 length metadata.
export function installFixedLengthStream(t) {
  const previous = globalThis.FixedLengthStream;
  if (previous) return;
  globalThis.FixedLengthStream = class extends TransformStream {
    constructor(length) {
      let bytes = 0;
      super({
        transform(chunk, controller) {
          bytes += chunk.byteLength;
          if (bytes > length) throw new Error("Fixed length stream overflow");
          controller.enqueue(chunk);
        },
        flush() { if (bytes !== length) throw new Error("Fixed length stream underflow"); },
      });
    }
  };
  t.after(() => { delete globalThis.FixedLengthStream; });
}
