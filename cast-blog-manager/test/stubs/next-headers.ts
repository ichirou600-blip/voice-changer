/**
 * テスト用の next/headers スタブ。
 *
 * Next.js 15 以降 `cookies()` / `headers()` は Promise を返すため、
 * 本物と同じインターフェースに合わせる。
 * Server Component のリクエストコンテキスト外でも DAL を直接テストできる。
 */
const store = new Map<string, string>();

type CookieStore = {
  get: (name: string) => { name: string; value: string } | undefined;
  set: (name: string, value: string) => void;
};

/** テストから同期的に Cookie を差し替えるためのヘルパ */
export function __setCookie(name: string, value: string): void {
  store.set(name, value);
}

export function cookies(): Promise<CookieStore> {
  return Promise.resolve({
    get: (name: string) => (store.has(name) ? { name, value: store.get(name)! } : undefined),
    set: (name: string, value: string) => {
      store.set(name, value);
    },
  });
}

export function headers(): Promise<{ get: (name: string) => string | null }> {
  return Promise.resolve({ get: () => null });
}
