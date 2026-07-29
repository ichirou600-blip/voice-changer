/** @type {import('next').NextConfig} */
const nextConfig = {
  // argon2 / Prisma はネイティブバイナリを含むため、
  // バンドルせず Node の require に委ねる
  serverExternalPackages: ["@node-rs/argon2", "@prisma/client"],
  // 管理ツールのため、サーバー情報を明かさない
  poweredByHeader: false,
};

export default nextConfig;
