// A small in-memory cache of finished creatives. Rendering is deterministic, so the same inputs
// always give the same bytes and a cached image is exactly what a new render would produce. The
// cache is bounded both by entry count and by total bytes so it cannot grow the process.
export type ByteCache<V extends { image: Buffer }> = {
  get(key: string): V | undefined;
  set(key: string, value: V): void;
  readonly size: number;
  readonly bytes: number;
  clear(): void;
};

export function createByteCache<V extends { image: Buffer }>(maxEntries = 40, maxBytes = 8 * 1024 * 1024): ByteCache<V> {
  const map = new Map<string, V>();
  let bytes = 0;
  const evict = () => {
    while (map.size > maxEntries || bytes > maxBytes) {
      const oldest = map.keys().next();
      if (oldest.done) break;
      bytes -= map.get(oldest.value)?.image.length ?? 0;
      map.delete(oldest.value);
    }
  };
  return {
    get(key) {
      const v = map.get(key);
      if (v !== undefined) {
        map.delete(key); // refresh recency
        map.set(key, v);
      }
      return v;
    },
    set(key, value) {
      if (value.image.length > maxBytes) return;
      const old = map.get(key);
      if (old) bytes -= old.image.length;
      map.delete(key);
      map.set(key, value);
      bytes += value.image.length;
      evict();
    },
    get size() {
      return map.size;
    },
    get bytes() {
      return bytes;
    },
    clear() {
      map.clear();
      bytes = 0;
    },
  };
}
