"use client";

/**
 * ルートレイアウトで発生したエラーの受け皿。
 * layout.tsx ごと差し替わるため、html/body を自前で描画する必要がある。
 */
export default function GlobalError({ error }: { error: Error & { digest?: string } }) {
  return (
    <html lang="ja">
      <body style={{ fontFamily: "sans-serif", padding: "3rem", textAlign: "center" }}>
        <h1 style={{ fontSize: "1.5rem", fontWeight: 700 }}>エラーが発生しました</h1>
        <p style={{ marginTop: "1rem", color: "#475569" }}>
          時間をおいて再度お試しください。
        </p>
        {error.digest ? (
          <p style={{ marginTop: "1rem", fontSize: "0.75rem", color: "#64748b" }}>
            エラー番号: {error.digest}
          </p>
        ) : null}
      </body>
    </html>
  );
}
