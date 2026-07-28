/**
 * テスト用の next/headers スタブ。
 * Server Component のリクエストコンテキスト外でも DAL を直接テストできるようにする。
 */
const store = new Map<string, string>();

export function cookies() {
  return {
    get: (name: string) => (store.has(name) ? { name, value: store.get(name)! } : undefined),
    set: (name: string, value: string) => {
      store.set(name, value);
    },
  };
}

export function headers() {
  return {
    get: (_name: string) => null,
  };
}
