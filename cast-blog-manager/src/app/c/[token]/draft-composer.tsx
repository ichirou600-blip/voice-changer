"use client";

import { useState, useTransition } from "react";

import { DEFAULT_LENGTH, LENGTH_OPTIONS } from "@/lib/draft/prompt";

import { generateDraftsAction, reportPostedAction } from "./actions";

/**
 * キャストが実際に触る画面。
 *
 * 想定は「スマートフォンで、営業前後の短い時間に」使うこと。
 * そのため次を優先している。
 * - 入力は最小（テーマを選ぶ・単語を入れる の2つだけ。どちらも省略可）
 * - できた文面は**ワンタップでコピー**（長押しでの範囲選択をさせない）
 * - コピーした直後に「投稿しました」を出し、報告まで一続きにする
 */

type Theme = { key: string; label: string };

export function DraftComposer({
  token,
  themes,
  hasProfile,
}: {
  token: string;
  themes: Theme[];
  hasProfile: boolean;
}) {
  const [theme, setTheme] = useState(themes[0]?.key ?? "free");
  const [keywords, setKeywords] = useState("");
  const [length, setLength] = useState<number>(DEFAULT_LENGTH);
  const [drafts, setDrafts] = useState<string[]>([]);
  const [warnings, setWarnings] = useState<string[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [copiedIndex, setCopiedIndex] = useState<number | null>(null);
  const [reported, setReported] = useState<string | null>(null);
  const [pending, startTransition] = useTransition();
  const [reporting, startReporting] = useTransition();

  function generate() {
    setError(null);
    setWarnings([]);
    setCopiedIndex(null);
    const formData = new FormData();
    formData.set("token", token);
    formData.set("theme", theme);
    formData.set("keywords", keywords);
    formData.set("length", String(length));

    startTransition(async () => {
      const result = await generateDraftsAction(formData);
      if (result.ok) {
        setDrafts(result.data.drafts);
        setWarnings(result.data.warnings);
      } else {
        setError(result.error);
      }
    });
  }

  async function copy(text: string, index: number) {
    try {
      await navigator.clipboard.writeText(text);
      setCopiedIndex(index);
    } catch {
      // クリップボードが使えない環境（古い WebView 等）向けの退避策。
      // ここで失敗を黙らせると「コピーしたつもり」で貼り付け先が空になる。
      setError("コピーできませんでした。文面を長押しして選択してください。");
    }
  }

  function report() {
    setError(null);
    const formData = new FormData();
    formData.set("token", token);
    startReporting(async () => {
      const result = await reportPostedAction(formData);
      if (result.ok) {
        setReported(
          result.data.created
            ? `${result.data.businessDate} の更新として記録しました`
            : "すでに記録済みです",
        );
      } else {
        setError(result.error);
      }
    });
  }

  return (
    <div className="space-y-4">
      {!hasProfile ? (
        <p className="rounded-md border border-sky-200 bg-sky-50 px-3 py-2 text-xs leading-relaxed text-sky-800">
          お店に「話し方の設定」を登録してもらうと、より自分らしい文面になります。
        </p>
      ) : null}

      <section className="rounded-lg border border-slate-200 bg-white p-4 shadow-sm">
        <label className="mb-1 block text-sm font-medium text-slate-700" htmlFor="theme">
          なにについて書く？
        </label>
        <select
          id="theme"
          value={theme}
          onChange={(e) => setTheme(e.target.value)}
          className="mb-3 w-full rounded-md border border-slate-300 px-3 py-2 text-sm"
        >
          {themes.map((t) => (
            <option key={t.key} value={t.key}>
              {t.label}
            </option>
          ))}
        </select>

        <label className="mb-1 block text-sm font-medium text-slate-700" htmlFor="keywords">
          キーワード（任意・200文字まで）
        </label>
        <textarea
          id="keywords"
          value={keywords}
          onChange={(e) => setKeywords(e.target.value.slice(0, 200))}
          rows={3}
          placeholder="例: 新しいネイルにした、金曜は出勤、寒くなってきた"
          className="mb-1 w-full rounded-md border border-slate-300 px-3 py-2 text-sm"
        />
        <p className="mb-3 text-right text-[11px] text-slate-400">{keywords.length}/200</p>

        <div className="mb-4">
          <span className="mb-1 block text-sm font-medium text-slate-700">長さ</span>
          <div className="flex gap-2">
            {LENGTH_OPTIONS.map((option) => (
              <button
                key={option}
                type="button"
                onClick={() => setLength(option)}
                className={`flex-1 rounded-md border px-3 py-2 text-sm ${
                  length === option
                    ? "border-slate-900 bg-slate-900 text-white"
                    : "border-slate-300 bg-white text-slate-700"
                }`}
              >
                {option}文字
              </button>
            ))}
          </div>
        </div>

        <button
          type="button"
          onClick={generate}
          disabled={pending}
          className="w-full rounded-md bg-slate-900 px-4 py-3 text-sm font-medium text-white disabled:opacity-50"
        >
          {pending ? "つくっています..." : drafts.length > 0 ? "つくりなおす" : "文面をつくる"}
        </button>
      </section>

      {error ? (
        <p className="rounded-md border border-rose-200 bg-rose-50 px-3 py-2 text-sm text-rose-800">
          {error}
        </p>
      ) : null}

      {warnings.map((w) => (
        <p
          key={w}
          className="rounded-md border border-amber-200 bg-amber-50 px-3 py-2 text-xs text-amber-800"
        >
          {w}
        </p>
      ))}

      {drafts.length > 0 ? (
        <section className="space-y-3">
          <p className="text-xs leading-relaxed text-slate-600">
            気に入ったものをコピーして、ブログに貼り付けてください。そのままでなくて大丈夫です。
            <span className="font-medium text-slate-800">
              内容が合っているか、必ず読んでから投稿してください。
            </span>
          </p>

          {drafts.map((draft, index) => (
            <article
              key={index}
              className="rounded-lg border border-slate-200 bg-white p-4 shadow-sm"
            >
              <p className="whitespace-pre-wrap text-sm leading-relaxed text-slate-800">{draft}</p>
              <div className="mt-3 flex items-center justify-between">
                <span className="text-[11px] text-slate-400">{draft.length}文字</span>
                <button
                  type="button"
                  onClick={() => copy(draft, index)}
                  className={`rounded-md px-4 py-2 text-sm font-medium ${
                    copiedIndex === index
                      ? "bg-emerald-600 text-white"
                      : "border border-slate-300 bg-white text-slate-700"
                  }`}
                >
                  {copiedIndex === index ? "コピーしました" : "コピー"}
                </button>
              </div>
            </article>
          ))}

          <div className="rounded-lg border border-slate-200 bg-white p-4 shadow-sm">
            <p className="mb-2 text-xs text-slate-600">
              ブログに投稿できたら、こちらから報告してください。
            </p>
            {reported ? (
              <p className="rounded-md border border-emerald-200 bg-emerald-50 px-3 py-2 text-sm text-emerald-800">
                {reported}
              </p>
            ) : (
              <button
                type="button"
                onClick={report}
                disabled={reporting}
                className="w-full rounded-md border border-slate-900 px-4 py-3 text-sm font-medium text-slate-900 disabled:opacity-50"
              >
                {reporting ? "記録中..." : "投稿しました"}
              </button>
            )}
          </div>
        </section>
      ) : null}
    </div>
  );
}
