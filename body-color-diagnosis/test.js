/*
 * 診断データと採点ロジックの検証。
 *   node body-color-diagnosis/test.js
 * 外部依存なし。失敗したら終了コード 1 を返す。
 */

const DATA = require("./data.js");
const SCORING = require("./scoring.js");

const SKELETON_TYPES = SCORING.SKELETON_ORDER;
const SEASONS = SCORING.SEASON_ORDER;
const HEX = /^#[0-9A-F]{6}$/;

let failures = 0;
let checks = 0;

function ok(condition, message) {
  checks += 1;
  if (!condition) {
    failures += 1;
    console.error("  NG  " + message);
  }
}

function section(name, fn) {
  console.log("\n" + name);
  const before = failures;
  fn();
  console.log(before === failures ? "  ok  すべて通過" : "  " + (failures - before) + " 件失敗");
}

/* ------------------------------------------------------------------ */

section("骨格タイプの定義", function () {
  SKELETON_TYPES.forEach(function (key) {
    const type = DATA.skeleton.types[key];
    ok(!!type, key + " が定義されている");
    if (!type) return;
    ok(!!type.name && !!type.reading && !!type.tagline, key + ": 名称一式がある");
    ok(type.summary.length > 40, key + ": 説明文が十分な長さ");
    ok(type.keywords.length >= 3, key + ": キーワードが3つ以上");
    ok(type.material.good.length >= 2 && type.material.bad.length >= 2, key + ": 得意/苦手素材がある");
    ok(
      type.items.tops.length >= 2 && type.items.bottoms.length >= 2 && type.items.outer.length >= 2,
      key + ": アイテム提案がそろっている"
    );
    ok(type.avoid.length >= 3, key + ": 避けたいものが3つ以上");
    ok(type.accessory.length >= 2, key + ": 小物提案がある");
    ok(type.tips.length >= 3, key + ": 着こなしの指針が3つ以上");
  });
});

section("骨格の設問", function () {
  const seenIds = new Set();
  DATA.skeleton.questions.forEach(function (question, i) {
    const at = "骨格Q" + (i + 1);
    ok(!seenIds.has(question.id), at + ": id が重複していない");
    seenIds.add(question.id);
    ok(question.q.trim().length > 0, at + ": 質問文がある");
    ok(question.options.length === 3, at + ": 選択肢が3つ");

    const types = question.options.map(function (option) {
      return option.type;
    });
    SKELETON_TYPES.forEach(function (key) {
      ok(types.indexOf(key) !== -1, at + ": " + key + " の選択肢がある");
    });
    question.options.forEach(function (option, j) {
      ok(option.label.trim().length > 0, at + "-" + (j + 1) + ": ラベルがある");
    });
  });

  const keyCount = DATA.skeleton.questions.filter(function (q) {
    return (q.weight || 1) >= 2;
  }).length;
  ok(keyCount >= 4, "判別力の高いキー設問が4問以上ある（実際: " + keyCount + "）");
});

section("パーソナルカラーの定義", function () {
  SEASONS.forEach(function (key) {
    const season = DATA.color.seasons[key];
    ok(!!season, key + " が定義されている");
    if (!season) return;
    ok(!!season.name && !!season.reading && !!season.tagline, key + ": 名称一式がある");
    ok(season.summary.length > 40, key + ": 説明文が十分な長さ");
    ok(season.palette.length >= 6, key + ": ベストカラーが6色以上");
    ok(season.avoid.length >= 3, key + ": 苦手な色が3色以上");
    ok(!!season.avoidReason, key + ": 苦手な理由が書かれている");

    season.palette.concat(season.avoid).forEach(function (color) {
      ok(HEX.test(color.hex), key + ": " + color.name + " の hex が正しい形式（" + color.hex + "）");
      ok(!!color.name, key + ": 色名がある");
    });

    ["base", "cheek", "lip", "eye"].forEach(function (part) {
      ok(!!season.makeup[part], key + ": メイク（" + part + "）の提案がある");
    });
    ok(!!season.hair && !!season.metal && !!season.white, key + ": ヘア/金属/白の提案がある");
    ok(season.styling.length >= 3, key + ": 色選びの指針が3つ以上");
  });
});

section("パーソナルカラーの設問", function () {
  const seenIds = new Set();
  DATA.color.questions.forEach(function (question, i) {
    const at = "カラーQ" + (i + 1);
    ok(!seenIds.has(question.id), at + ": id が重複していない");
    seenIds.add(question.id);
    ok(question.q.trim().length > 0, at + ": 質問文がある");
    ok(question.options.length >= 3, at + ": 選択肢が3つ以上");

    question.options.forEach(function (option, j) {
      const where = at + "-" + (j + 1);
      ok(option.label.trim().length > 0, where + ": ラベルがある");
      const keys = Object.keys(option.scores);
      ok(keys.length > 0, where + ": 配点がある");
      keys.forEach(function (season) {
        ok(SEASONS.indexOf(season) !== -1, where + ": 未知のシーズン名がない（" + season + "）");
        ok(option.scores[season] > 0, where + ": 配点が正の数");
      });
    });
  });

  // どのシーズンも、選択肢全体を通して十分に得点しうること
  SEASONS.forEach(function (season) {
    const reachable = DATA.color.questions.reduce(function (n, question) {
      const best = Math.max.apply(
        null,
        question.options.map(function (option) {
          return option.scores[season] || 0;
        })
      );
      return n + best;
    }, 0);
    ok(reachable >= 15, season + ": 最大到達スコアが十分（" + reachable + "）");
  });
});

section("3つの軸", function () {
  ok(DATA.color.axes.length === 3, "軸が3つある");
  DATA.color.axes.forEach(function (axis) {
    const all = axis.left.seasons.concat(axis.right.seasons).sort();
    ok(all.length === 4, axis.label + ": 4シーズンを分割している");
    ok(
      JSON.stringify(all) === JSON.stringify(SEASONS.slice().sort()),
      axis.label + ": 左右の合計が4シーズンと一致する"
    );
    ok(!!axis.left.name && !!axis.right.name, axis.label + ": 両端の名称がある");
  });
});

section("掛け合わせアドバイス", function () {
  SKELETON_TYPES.forEach(function (type) {
    SEASONS.forEach(function (season) {
      const key = type + "-" + season;
      const combo = DATA.combos[key];
      ok(!!combo, key + " が定義されている");
      if (!combo) return;
      ok(!!combo.catch, key + ": キャッチがある");
      ok(combo.text.length > 60, key + ": 本文が十分な長さ");
    });
  });
  ok(Object.keys(DATA.combos).length === 12, "組み合わせがちょうど12通り");
});

section("採点：骨格", function () {
  // 各タイプに全振りしたら、そのタイプが1位になること
  SKELETON_TYPES.forEach(function (target) {
    const answers = DATA.skeleton.questions.map(function (question) {
      return question.options.findIndex(function (option) {
        return option.type === target;
      });
    });
    const result = SCORING.scoreSkeleton(DATA, answers);
    ok(result.ranked[0] === target, target + " に全振りすると " + target + " が1位になる");
    ok(result.totals[target] === result.max, target + ": 満点になる（" + result.totals[target] + "）");
  });

  // 未回答が混ざっても落ちないこと
  const partial = new Array(DATA.skeleton.questions.length).fill(null);
  partial[0] = 0;
  const partialResult = SCORING.scoreSkeleton(DATA, partial);
  ok(partialResult.ranked.length === 3, "未回答が混ざっても順位が返る");
  ok(partialResult.totals.straight > 0, "回答済みの分だけ加点される");
});

section("採点：パーソナルカラー", function () {
  // 各シーズンにとって最良の選択肢を選び続けたら、そのシーズンが1位になること
  SEASONS.forEach(function (target) {
    const answers = DATA.color.questions.map(function (question) {
      let bestIndex = 0;
      let bestScore = -1;
      question.options.forEach(function (option, i) {
        const value = option.scores[target] || 0;
        if (value > bestScore) {
          bestScore = value;
          bestIndex = i;
        }
      });
      return bestIndex;
    });
    const result = SCORING.scoreColor(DATA, answers);
    ok(result.ranked[0] === target, target + " 寄りに答えると " + target + " が1位になる");

    result.axes.forEach(function (axis) {
      ok(
        axis.leftPct + axis.rightPct === 100,
        target + " / " + axis.label + ": 軸の割合が合計100%（" + axis.leftPct + "+" + axis.rightPct + "）"
      );
    });
  });

  // 全員に均等配点の選択肢だけを選んでも壊れないこと
  const empty = new Array(DATA.color.questions.length).fill(null);
  const emptyResult = SCORING.scoreColor(DATA, empty);
  ok(emptyResult.sum === 0, "未回答なら合計0");
  emptyResult.axes.forEach(function (axis) {
    ok(axis.leftPct === 0 && axis.rightPct === 0, axis.label + ": 未回答でも 0 で安全に返る");
  });
});

section("軸とシーズンの整合", function () {
  // イエベに全振りした結果が、ベース軸で必ずイエベ側に寄ること
  ["spring", "autumn"].forEach(function (warm) {
    const answers = DATA.color.questions.map(function (question) {
      let bestIndex = 0;
      let bestScore = -1;
      question.options.forEach(function (option, i) {
        const value = option.scores[warm] || 0;
        if (value > bestScore) {
          bestScore = value;
          bestIndex = i;
        }
      });
      return bestIndex;
    });
    const base = SCORING.scoreColor(DATA, answers).axes[0];
    ok(base.leftPct > 50, warm + ": ベース軸がイエローベース側に寄る（" + base.leftPct + "%）");
  });

  ["summer", "winter"].forEach(function (cool) {
    const answers = DATA.color.questions.map(function (question) {
      let bestIndex = 0;
      let bestScore = -1;
      question.options.forEach(function (option, i) {
        const value = option.scores[cool] || 0;
        if (value > bestScore) {
          bestScore = value;
          bestIndex = i;
        }
      });
      return bestIndex;
    });
    const base = SCORING.scoreColor(DATA, answers).axes[0];
    ok(base.rightPct > 50, cool + ": ベース軸がブルーベース側に寄る（" + base.rightPct + "%）");
  });
});

/* ------------------------------------------------------------------ */

console.log(
  "\n" +
    (failures === 0
      ? "すべて通過： " + checks + " 件のチェック"
      : failures + " 件失敗 / " + checks + " 件中")
);
process.exit(failures === 0 ? 0 : 1);
