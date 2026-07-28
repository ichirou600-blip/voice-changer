/** @type {import('next').NextConfig} */
const nextConfig = {
  experimental: {
    // argon2 / Prisma はネイティブバイナリを含むため、
    // webpack でバンドルせず Node の require に委ねる
    serverComponentsExternalPackages: ["@node-rs/argon2", "@prisma/client"],
  },
  // 管理ツールのため、外部からのインデックスを避ける
  poweredByHeader: false,
};

export default nextConfig;
