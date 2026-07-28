import { describe, expect, it } from "vitest";

import {
  castCreateSchema,
  castTargetSchema,
  castUpdateSchema,
  loginSchema,
  postCreateSchema,
  postVoidSchema,
  setupSchema,
  storeSettingsSchema,
} from "./validations";

/**
 * 「HTML フォームが実際に送信する形」でスキーマを検証する。
 *
 * 経緯: 単体テストが DAL を直接呼んでいたため、
 * 「未入力の日付欄が空文字で送られてスキーマに弾かれる」というバグを
 * ブラウザでの E2E テストまで検出できなかった。
 * フォームは **未入力の項目も空文字として送る** ので、
 * ここではその前提で検証する。
 */

/** 実際のフォーム送信を模した入力（未入力欄は空文字） */
function form(values: Record<string, string>) {
  return values;
}

describe("更新記録フォーム（postCreateSchema）", () => {
  it("日付・タイトル・URL が未入力（空文字）でも通る", () => {
    const result = postCreateSchema.safeParse(
      form({ castId: "c1", businessDate: "", title: "", url: "" }),
    );
    expect(result.success).toBe(true);
    if (result.success) {
      // 空文字は undefined に正規化され、DAL 側で「本日」として扱われる
      expect(result.data.businessDate).toBeUndefined();
    }
  });

  it("日付を入力した場合はそのまま通る", () => {
    const result = postCreateSchema.safeParse(
      form({ castId: "c1", businessDate: "2026-07-28", title: "出勤しました", url: "" }),
    );
    expect(result.success).toBe(true);
    if (result.success) expect(result.data.businessDate).toBe("2026-07-28");
  });

  it("不正な日付は拒否する", () => {
    expect(
      postCreateSchema.safeParse(form({ castId: "c1", businessDate: "2026/07/28" })).success,
    ).toBe(false);
    expect(
      postCreateSchema.safeParse(form({ castId: "c1", businessDate: "2026-02-30" })).success,
    ).toBe(false);
  });

  it("キャスト未選択は拒否する", () => {
    expect(postCreateSchema.safeParse(form({ castId: "", businessDate: "" })).success).toBe(false);
  });

  it("不正な URL は拒否する", () => {
    expect(
      postCreateSchema.safeParse(form({ castId: "c1", businessDate: "", url: "not-a-url" })).success,
    ).toBe(false);
  });
});

describe("週次目標フォーム（castTargetSchema）", () => {
  it("適用開始日が空文字でも通る", () => {
    const result = castTargetSchema.safeParse(form({ castId: "c1", postsPerWeek: "3", effectiveFrom: "" }));
    expect(result.success).toBe(true);
    if (result.success) expect(result.data.effectiveFrom).toBeUndefined();
  });

  it("数値は文字列で送られても変換される", () => {
    const result = castTargetSchema.safeParse(form({ castId: "c1", postsPerWeek: "5" }));
    expect(result.success).toBe(true);
    if (result.success) expect(result.data.postsPerWeek).toBe(5);
  });
});

describe("キャスト登録フォーム（castCreateSchema）", () => {
  it("フォームからの文字列入力を受け付ける", () => {
    const result = castCreateSchema.safeParse(
      form({ storeId: "s1", name: "あやか", postsPerWeek: "3" }),
    );
    expect(result.success).toBe(true);
    if (result.success) expect(result.data.postsPerWeek).toBe(3);
  });

  it("源氏名が空なら拒否", () => {
    expect(castCreateSchema.safeParse(form({ storeId: "s1", name: "", postsPerWeek: "3" })).success).toBe(
      false,
    );
  });
});

describe("キャスト更新フォーム（castUpdateSchema）", () => {
  it("在籍状況の3値を受け付ける", () => {
    for (const status of ["ACTIVE", "INACTIVE", "RETIRED"]) {
      expect(castUpdateSchema.safeParse(form({ castId: "c1", name: "あやか", status })).success).toBe(
        true,
      );
    }
  });

  it("未知の状態は拒否", () => {
    expect(
      castUpdateSchema.safeParse(form({ castId: "c1", name: "あやか", status: "UNKNOWN" })).success,
    ).toBe(false);
  });
});

describe("店舗設定フォーム（storeSettingsSchema）", () => {
  it("数値が文字列で送られても変換される", () => {
    const result = storeSettingsSchema.safeParse(
      form({
        storeId: "s1",
        name: "テスト店",
        businessDayStart: "6",
        reminderHour: "17",
        daysStaleThreshold: "2",
      }),
    );
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.businessDayStart).toBe(6);
      expect(result.data.daysStaleThreshold).toBe(2);
    }
  });

  it("範囲外の時刻は拒否", () => {
    const base = { storeId: "s1", name: "店", reminderHour: "17", daysStaleThreshold: "2" };
    expect(storeSettingsSchema.safeParse(form({ ...base, businessDayStart: "24" })).success).toBe(false);
    expect(storeSettingsSchema.safeParse(form({ ...base, businessDayStart: "-1" })).success).toBe(false);
  });
});

describe("その他のフォーム", () => {
  it("ログインはメール形式を検証し小文字化する", () => {
    const result = loginSchema.safeParse(form({ email: " Admin@Example.COM ", password: "pw" }));
    expect(result.success).toBe(true);
    if (result.success) expect(result.data.email).toBe("admin@example.com");
  });

  it("初期セットアップは12文字未満のパスワードを拒否", () => {
    const base = { storeName: "店", name: "山田", email: "a@example.com" };
    expect(setupSchema.safeParse(form({ ...base, password: "short" })).success).toBe(false);
    expect(setupSchema.safeParse(form({ ...base, password: "long-enough-password" })).success).toBe(
      true,
    );
  });

  it("無効化は理由を必須にする", () => {
    expect(postVoidSchema.safeParse(form({ postId: "p1", reason: "" })).success).toBe(false);
    expect(postVoidSchema.safeParse(form({ postId: "p1", reason: "重複" })).success).toBe(true);
  });
});
