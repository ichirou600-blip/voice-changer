import type { Metadata } from "next";

import "./globals.css";

export const metadata: Metadata = {
  title: "キャストブログ更新管理",
  description: "ナイトラウンジ向けのキャストブログ更新管理ツール",
  robots: { index: false, follow: false },
};

export default function RootLayout({ children }: Readonly<{ children: React.ReactNode }>) {
  return (
    <html lang="ja">
      <body>{children}</body>
    </html>
  );
}
