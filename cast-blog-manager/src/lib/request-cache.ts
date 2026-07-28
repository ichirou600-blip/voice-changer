import * as React from "react";

/**
 * リクエストスコープのメモ化。
 *
 * React の `cache()` は React Server Components の実行コンテキストでのみ提供される。
 * 単体テストなど素の Node 実行では存在しないため、
 * 利用できない場合はメモ化なしの関数をそのまま返す（挙動は同じ、DB アクセス回数だけ増える）。
 */
export function requestCache<TArgs extends unknown[], TResult>(
  fn: (...args: TArgs) => TResult,
): (...args: TArgs) => TResult {
  const reactCache = (React as unknown as { cache?: typeof requestCache }).cache;
  return typeof reactCache === "function" ? reactCache(fn) : fn;
}
