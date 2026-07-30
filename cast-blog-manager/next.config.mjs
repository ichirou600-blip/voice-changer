import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));

/** @type {import('next').NextConfig} */
const nextConfig = {
  // argon2 / Prisma はネイティブバイナリを含むため、
  // バンドルせず Node の require に委ねる
  serverExternalPackages: ["@node-rs/argon2", "@prisma/client"],
  // 管理ツールのため、サーバー情報を明かさない
  poweredByHeader: false,
  turbopack: {
    // 上位ディレクトリに別の package-lock.json があると、
    // Next.js がそちらをワークスペースの起点と誤認して警告を出す。
    // このディレクトリを明示して固定する。
    root: __dirname,
  },
};

export default nextConfig;
