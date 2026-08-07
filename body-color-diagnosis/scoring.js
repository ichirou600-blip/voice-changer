/*
 * 骨格診断 × パーソナルカラー診断 — 採点ロジック
 *
 * 画面から切り離してあるので、Node からも require("./scoring.js") で検証できる。
 * ブラウザでは classic script として読み込まれ、グローバルの SCORING を app.js が使う。
 */

const SCORING = (function () {
  "use strict";

  const SKELETON_ORDER = ["straight", "wave", "natural"];
  const SEASON_ORDER = ["spring", "summer", "autumn", "winter"];

  function pct(part, whole) {
    return whole > 0 ? Math.round((part / whole) * 100) : 0;
  }

  /**
   * 骨格スコア。設問の weight を足し合わせ、同点は判別力の高いキー設問
   * （weight >= 2）の小計、それでも同点なら固定順で解決する。
   */
  function scoreSkeleton(data, answers) {
    const questions = data.skeleton.questions;
    const totals = { straight: 0, wave: 0, natural: 0 };
    const keyTotals = { straight: 0, wave: 0, natural: 0 };
    let max = 0;

    questions.forEach(function (question, i) {
      const weight = question.weight || 1;
      max += weight;
      const picked = answers[i];
      if (picked == null) return;
      const type = question.options[picked].type;
      totals[type] += weight;
      if (weight >= 2) keyTotals[type] += weight;
    });

    const ranked = SKELETON_ORDER.slice().sort(function (a, b) {
      return (
        totals[b] - totals[a] ||
        keyTotals[b] - keyTotals[a] ||
        SKELETON_ORDER.indexOf(a) - SKELETON_ORDER.indexOf(b)
      );
    });

    return { totals: totals, keyTotals: keyTotals, ranked: ranked, max: max };
  }

  /**
   * パーソナルカラースコア。選択肢ごとの配点ベクトルを合算し、
   * 4シーズンの順位と、ベース／明度／清濁の3軸の偏りを返す。
   */
  function scoreColor(data, answers) {
    const questions = data.color.questions;
    const totals = { spring: 0, summer: 0, autumn: 0, winter: 0 };

    questions.forEach(function (question, i) {
      const picked = answers[i];
      if (picked == null) return;
      const scores = question.options[picked].scores;
      Object.keys(scores).forEach(function (season) {
        totals[season] += scores[season];
      });
    });

    const ranked = SEASON_ORDER.slice().sort(function (a, b) {
      return totals[b] - totals[a] || SEASON_ORDER.indexOf(a) - SEASON_ORDER.indexOf(b);
    });

    const sum = SEASON_ORDER.reduce(function (n, season) {
      return n + totals[season];
    }, 0);

    const axes = data.color.axes.map(function (axis) {
      const left = axis.left.seasons.reduce(function (n, s) {
        return n + totals[s];
      }, 0);
      const right = axis.right.seasons.reduce(function (n, s) {
        return n + totals[s];
      }, 0);
      const span = left + right;
      const leftPct = pct(left, span);
      return {
        id: axis.id,
        label: axis.label,
        leftName: axis.left.name,
        rightName: axis.right.name,
        leftPct: leftPct,
        rightPct: span > 0 ? 100 - leftPct : 0,
      };
    });

    return { totals: totals, ranked: ranked, sum: sum, axes: axes };
  }

  return {
    SKELETON_ORDER: SKELETON_ORDER,
    SEASON_ORDER: SEASON_ORDER,
    scoreSkeleton: scoreSkeleton,
    scoreColor: scoreColor,
  };
})();

if (typeof module !== "undefined" && module.exports) {
  module.exports = SCORING;
}
