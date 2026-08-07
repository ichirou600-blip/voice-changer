/*
 * 骨格診断 × パーソナルカラー診断 — アプリ本体
 * data.js の DATA と scoring.js の SCORING を参照する。
 */
(function () {
  "use strict";

  var STORAGE_KEY = "bcd.answers.v1";
  var THEME_KEY = "bcd.theme.v1";
  var SKELETON_ORDER = SCORING.SKELETON_ORDER;
  var SEASON_ORDER = SCORING.SEASON_ORDER;

  var sq = DATA.skeleton.questions;
  var cq = DATA.color.questions;
  var TOTAL = sq.length + cq.length;

  var state = {
    skeleton: new Array(sq.length).fill(null),
    color: new Array(cq.length).fill(null),
    index: 0,
  };

  var advanceTimer = null;

  /* ---------------------------------------------------------------- *
   * ユーティリティ
   * ---------------------------------------------------------------- */

  function $(id) {
    return document.getElementById(id);
  }

  function esc(value) {
    return String(value).replace(/[&<>"']/g, function (ch) {
      return { "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[ch];
    });
  }

  function showToast(message) {
    var el = $("toast");
    el.textContent = message;
    el.hidden = false;
    window.clearTimeout(showToast.timer);
    showToast.timer = window.setTimeout(function () {
      el.hidden = true;
    }, 2200);
  }

  function scoreSkeleton(answers) {
    return SCORING.scoreSkeleton(DATA, answers);
  }

  function scoreColor(answers) {
    return SCORING.scoreColor(DATA, answers);
  }

  /* ---------------------------------------------------------------- *
   * 保存と復元
   * ---------------------------------------------------------------- */

  function save() {
    try {
      window.localStorage.setItem(
        STORAGE_KEY,
        JSON.stringify({ skeleton: state.skeleton, color: state.color, index: state.index })
      );
    } catch (err) {
      /* プライベートモードなどで保存できない場合は黙って続行する */
    }
  }

  function loadSaved() {
    try {
      var raw = window.localStorage.getItem(STORAGE_KEY);
      if (!raw) return null;
      var parsed = JSON.parse(raw);
      if (!Array.isArray(parsed.skeleton) || !Array.isArray(parsed.color)) return null;
      if (parsed.skeleton.length !== sq.length || parsed.color.length !== cq.length) return null;
      return parsed;
    } catch (err) {
      return null;
    }
  }

  function clearSaved() {
    try {
      window.localStorage.removeItem(STORAGE_KEY);
    } catch (err) {
      /* noop */
    }
  }

  function encodeAnswers() {
    return (
      "#s=" + state.skeleton.map(digit).join("") + "&c=" + state.color.map(digit).join("")
    );
    function digit(value) {
      return value == null ? "-" : String(value);
    }
  }

  function decodeAnswers(hash) {
    var match = /^#s=([0-9-]+)&c=([0-9-]+)$/.exec(hash || "");
    if (!match) return null;
    var skeleton = parse(match[1], sq);
    var color = parse(match[2], cq);
    if (!skeleton || !color) return null;
    return { skeleton: skeleton, color: color };

    function parse(text, questions) {
      if (text.length !== questions.length) return null;
      var out = [];
      for (var i = 0; i < text.length; i += 1) {
        if (text[i] === "-") return null;
        var value = Number(text[i]);
        if (!(value >= 0 && value < questions[i].options.length)) return null;
        out.push(value);
      }
      return out;
    }
  }

  /* ---------------------------------------------------------------- *
   * 画面遷移
   * ---------------------------------------------------------------- */

  function showView(name) {
    ["intro", "quiz", "result"].forEach(function (key) {
      $("view-" + key).hidden = key !== name;
    });
    window.scrollTo({ top: 0, behavior: "auto" });
  }

  function questionAt(index) {
    return index < sq.length
      ? { question: sq[index], group: "skeleton", localIndex: index }
      : { question: cq[index - sq.length], group: "color", localIndex: index - sq.length };
  }

  function answerAt(index) {
    var slot = questionAt(index);
    return state[slot.group][slot.localIndex];
  }

  function firstUnanswered() {
    for (var i = 0; i < TOTAL; i += 1) {
      if (answerAt(i) == null) return i;
    }
    return TOTAL - 1;
  }

  function isComplete() {
    return (
      state.skeleton.every(function (v) {
        return v != null;
      }) &&
      state.color.every(function (v) {
        return v != null;
      })
    );
  }

  /* ---------------------------------------------------------------- *
   * 設問の描画
   * ---------------------------------------------------------------- */

  function renderQuiz() {
    var slot = questionAt(state.index);
    var question = slot.question;
    var picked = state[slot.group][slot.localIndex];

    $("quiz-section-name").textContent = slot.group === "skeleton" ? "骨格診断" : "パーソナルカラー診断";
    $("quiz-counter").textContent = state.index + 1 + " / " + TOTAL;

    var rail = $("quiz-rail");
    rail.setAttribute("aria-valuenow", String(countAnswered()));
    rail.innerHTML = "";
    for (var i = 0; i < TOTAL; i += 1) {
      var tick = document.createElement("i");
      if (answerAt(i) != null) tick.className = "done";
      else if (i === state.index) tick.className = "here";
      rail.appendChild(tick);
    }

    $("question-text").textContent = question.q;
    var hint = $("question-hint");
    hint.textContent = question.hint || "";
    hint.hidden = !question.hint;

    var box = $("options");
    box.innerHTML = "";
    question.options.forEach(function (option, optionIndex) {
      var button = document.createElement("button");
      button.type = "button";
      button.className = "option";
      button.setAttribute("role", "radio");
      button.setAttribute("aria-checked", String(picked === optionIndex));
      button.tabIndex = picked === optionIndex || (picked == null && optionIndex === 0) ? 0 : -1;
      button.innerHTML =
        '<span class="key" aria-hidden="true">' +
        (optionIndex + 1) +
        "</span><span>" +
        esc(option.label) +
        "</span>";
      button.addEventListener("click", function () {
        choose(optionIndex);
      });
      box.appendChild(button);
    });

    $("prev-btn").disabled = state.index === 0;
    $("quiz-tip").textContent = "数字キー（1〜" + question.options.length + "）でも選べます";

    var body = $("quiz-body");
    body.classList.remove("fade-in");
    void body.offsetWidth; // アニメーションを再生させるためのリフロー
    body.classList.add("fade-in");
  }

  function countAnswered() {
    var count = 0;
    for (var i = 0; i < TOTAL; i += 1) {
      if (answerAt(i) != null) count += 1;
    }
    return count;
  }

  function choose(optionIndex) {
    var slot = questionAt(state.index);
    state[slot.group][slot.localIndex] = optionIndex;
    save();

    Array.prototype.forEach.call($("options").children, function (child, i) {
      child.setAttribute("aria-checked", String(i === optionIndex));
      child.tabIndex = i === optionIndex ? 0 : -1;
    });

    window.clearTimeout(advanceTimer);
    advanceTimer = window.setTimeout(function () {
      if (state.index < TOTAL - 1) {
        state.index += 1;
        save();
        renderQuiz();
      } else if (isComplete()) {
        finish();
      } else {
        state.index = firstUnanswered();
        save();
        renderQuiz();
      }
    }, 230);
  }

  function goBack() {
    window.clearTimeout(advanceTimer);
    if (state.index === 0) return;
    state.index -= 1;
    save();
    renderQuiz();
  }

  function moveFocus(delta) {
    var options = Array.prototype.slice.call($("options").children);
    if (!options.length) return;
    var current = options.indexOf(document.activeElement);
    var next = (current + delta + options.length) % options.length;
    if (current === -1) next = 0;
    options[next].focus();
  }

  /* ---------------------------------------------------------------- *
   * 結果の描画
   * ---------------------------------------------------------------- */

  function bars(rows) {
    var top = Math.max.apply(
      null,
      rows.map(function (row) {
        return row.value;
      })
    );
    return (
      '<div class="bars">' +
      rows
        .map(function (row) {
          var width = top > 0 ? Math.round((row.value / top) * 100) : 0;
          return (
            '<div class="bar-row' +
            (row.value === top && top > 0 ? " top" : "") +
            '"><span class="label">' +
            esc(row.label) +
            '</span><span class="bar-track"><span class="bar-fill" style="width:' +
            width +
            '%"></span></span><span class="value">' +
            row.value +
            "</span></div>"
          );
        })
        .join("") +
      "</div>"
    );
  }

  function swatches(colors, small) {
    return (
      '<div class="swatches' +
      (small ? " small" : "") +
      '">' +
      colors
        .map(function (color) {
          return (
            '<div class="swatch"><span class="chipcolor" style="background:' +
            esc(color.hex) +
            '"></span><span class="cname">' +
            esc(color.name) +
            '</span><span class="chex">' +
            esc(color.hex) +
            "</span></div>"
          );
        })
        .join("") +
      "</div>"
    );
  }

  function list(items, cross) {
    return (
      "<ul>" +
      items
        .map(function (item) {
          return '<li class="tick' + (cross ? " cross" : "") + '"><span>' + esc(item) + "</span></li>";
        })
        .join("") +
      "</ul>"
    );
  }

  function detail(rows) {
    return (
      '<dl class="detail">' +
      rows
        .map(function (row) {
          return (
            '<div class="detail-row"><dt>' +
            esc(row[0]) +
            "</dt><dd>" +
            esc(row[1]) +
            "</dd></div>"
          );
        })
        .join("") +
      "</dl>"
    );
  }

  function renderResult() {
    var skeleton = scoreSkeleton(state.skeleton);
    var color = scoreColor(state.color);
    var frame = DATA.skeleton.types[skeleton.ranked[0]];
    var season = DATA.color.seasons[color.ranked[0]];
    var second = DATA.color.seasons[color.ranked[1]];
    var combo = DATA.combos[skeleton.ranked[0] + "-" + color.ranked[0]];

    var html = "";

    /* ベストカラーのドレープ */
    html +=
      '<div class="result-banner" aria-hidden="true">' +
      season.palette
        .map(function (c, i) {
          return '<span style="background:' + esc(c.hex) + ";animation-delay:" + i * 45 + 'ms"></span>';
        })
        .join("") +
      "</div>";

    /* 総合 */
    html +=
      '<div class="verdict"><span class="kicker">あなたのタイプ</span>' +
      '<span class="name">' +
      esc(frame.name) +
      '<span style="color:var(--accent)"> × </span>' +
      esc(season.name) +
      "</span>" +
      '<span class="reading">' +
      esc(frame.reading) +
      " / " +
      esc(season.reading) +
      "</span></div>";

    /* 掛け合わせ */
    html +=
      '<div class="combo"><span class="combo-catch">' +
      esc(combo.catch) +
      "</span><p>" +
      esc(combo.text) +
      "</p></div>";

    /* --- 骨格 --- */
    var skeletonRows = SKELETON_ORDER.map(function (key) {
      return { label: DATA.skeleton.types[key].name, value: skeleton.totals[key] };
    });
    var skeletonGap = skeleton.totals[skeleton.ranked[0]] - skeleton.totals[skeleton.ranked[1]];

    html += '<section class="result-section">';
    html += '<p class="eyebrow">骨格診断</p>';
    html +=
      '<div class="stack-tight"><h2 class="type-name">' +
      esc(frame.name) +
      '<span class="en">' +
      esc(frame.reading) +
      '</span></h2><p class="type-tagline">' +
      esc(frame.tagline) +
      "</p></div>";
    html += "<p>" + esc(frame.summary) + "</p>";
    html +=
      '<div class="chips">' +
      frame.keywords
        .map(function (word) {
          return '<span class="chip">' + esc(word) + "</span>";
        })
        .join("") +
      "</div>";
    html += bars(skeletonRows);
    if (skeletonGap <= 2) {
      html +=
        '<p class="mix-note">1位と2位の差がわずかです。' +
        esc(DATA.skeleton.types[skeleton.ranked[1]].name) +
        "の要素も持つミックスタイプの可能性があります。両方のアドバイスを試して、しっくりくる方を採用してください。</p>";
    }
    html += '<div class="card stack">';
    html += '<div><p class="subhead">得意な素材</p>' + list(frame.material.good) + "</div>";
    html += '<div><p class="subhead">苦手な素材</p>' + list(frame.material.bad, true) + "</div>";
    html +=
      '<div><p class="subhead">似合うアイテム</p>' +
      detail([
        ["トップス", frame.items.tops.join("／")],
        ["ボトムス", frame.items.bottoms.join("／")],
        ["アウター", frame.items.outer.join("／")],
        ["小物", frame.accessory.join("／")],
      ]) +
      "</div>";
    html += '<div><p class="subhead">避けたいもの</p>' + list(frame.avoid, true) + "</div>";
    html += '<div><p class="subhead">着こなしの指針</p>' + list(frame.tips) + "</div>";
    html += "</div></section>";

    /* --- パーソナルカラー --- */
    var seasonRows = SEASON_ORDER.map(function (key) {
      return { label: DATA.color.seasons[key].name, value: color.totals[key] };
    });
    var seasonGap = color.totals[color.ranked[0]] - color.totals[color.ranked[1]];

    html += '<section class="result-section">';
    html += '<p class="eyebrow">パーソナルカラー診断</p>';
    html +=
      '<div class="stack-tight"><h2 class="type-name">' +
      esc(season.name) +
      '<span class="en">' +
      esc(season.reading) +
      '</span></h2><p class="type-tagline">' +
      esc(season.tagline) +
      "</p></div>";
    html += "<p>" + esc(season.summary) + "</p>";
    html +=
      '<div class="chips">' +
      season.keywords
        .map(function (word) {
          return '<span class="chip">' + esc(word) + "</span>";
        })
        .join("") +
      "</div>";
    html += bars(seasonRows);
    html +=
      '<p class="mix-note">セカンドシーズンは<strong>' +
      esc(second.name) +
      "</strong>。1位の色でしっくりこないときは、こちらの色を試すと合うことがあります。" +
      (seasonGap <= 2 ? "今回は1位との差が小さいので、実質どちらも得意な可能性が高いタイプです。" : "") +
      "</p>";

    html += '<div class="card stack">';
    html += '<div><p class="subhead">3つの軸</p>';
    html += color.axes
      .map(function (axis) {
        return (
          '<div class="axis"><div class="axis-head"><span class="axis-name">' +
          esc(axis.label) +
          "</span><span>" +
          axis.leftPct +
          "％ / " +
          axis.rightPct +
          '％</span></div><div class="axis-track"><span class="axis-mark" style="left:' +
          axis.rightPct +
          '%"></span></div><div class="axis-ends"><span>' +
          esc(axis.leftName) +
          "</span><span>" +
          esc(axis.rightName) +
          "</span></div></div>"
        );
      })
      .join("");
    html += "</div>";
    html += '<div><p class="subhead">ベストカラー</p>' + swatches(season.palette) + "</div>";
    html +=
      '<div><p class="subhead">苦手な色</p>' +
      swatches(season.avoid, true) +
      '<p class="note" style="margin-top:.6rem">' +
      esc(season.avoidReason) +
      "</p></div>";
    html +=
      '<div><p class="subhead">メイク</p>' +
      detail([
        ["ベース", season.makeup.base],
        ["チーク", season.makeup.cheek],
        ["リップ", season.makeup.lip],
        ["アイ", season.makeup.eye],
      ]) +
      "</div>";
    html +=
      '<div><p class="subhead">その他</p>' +
      detail([
        ["ヘア", season.hair],
        ["金属", season.metal],
        ["白の選び方", season.white],
      ]) +
      "</div>";
    html += '<div><p class="subhead">色選びの指針</p>' + list(season.styling) + "</div>";
    html += "</div></section>";

    $("result-body").innerHTML = html;
  }

  function resultText() {
    var skeleton = scoreSkeleton(state.skeleton);
    var color = scoreColor(state.color);
    var frame = DATA.skeleton.types[skeleton.ranked[0]];
    var season = DATA.color.seasons[color.ranked[0]];
    var second = DATA.color.seasons[color.ranked[1]];
    var combo = DATA.combos[skeleton.ranked[0] + "-" + color.ranked[0]];

    var lines = [];
    lines.push("【骨格診断 × パーソナルカラー診断】");
    lines.push("骨格タイプ：" + frame.name + "（" + frame.reading + "）");
    lines.push("パーソナルカラー：" + season.name + "（" + season.reading + "）");
    lines.push("セカンドシーズン：" + second.name);
    lines.push("");
    lines.push("■ " + combo.catch);
    lines.push(combo.text);
    lines.push("");
    lines.push("■ 骨格スコア");
    lines.push(
      SKELETON_ORDER.map(function (key) {
        return DATA.skeleton.types[key].name + " " + skeleton.totals[key];
      }).join(" / ")
    );
    lines.push("■ カラースコア");
    lines.push(
      SEASON_ORDER.map(function (key) {
        return DATA.color.seasons[key].name + " " + color.totals[key];
      }).join(" / ")
    );
    lines.push(
      color.axes
        .map(function (axis) {
          return axis.label + "：" + (axis.leftPct >= axis.rightPct ? axis.leftName : axis.rightName);
        })
        .join(" / ")
    );
    lines.push("");
    lines.push("■ ベストカラー");
    lines.push(
      season.palette
        .map(function (c) {
          return c.name + " " + c.hex;
        })
        .join(" / ")
    );
    lines.push("");
    lines.push(window.location.href);
    return lines.join("\n");
  }

  function finish() {
    if (window.history && window.history.replaceState) {
      window.history.replaceState(null, "", encodeAnswers());
    } else {
      window.location.hash = encodeAnswers();
    }
    renderResult();
    showView("result");
  }

  /* ---------------------------------------------------------------- *
   * テーマ
   * ---------------------------------------------------------------- */

  function currentTheme() {
    var stamped = document.documentElement.getAttribute("data-theme");
    if (stamped) return stamped;
    return window.matchMedia && window.matchMedia("(prefers-color-scheme: dark)").matches
      ? "dark"
      : "light";
  }

  function applyTheme(theme) {
    document.documentElement.setAttribute("data-theme", theme);
    $("theme-toggle").textContent = theme === "dark" ? "ライト表示" : "ダーク表示";
    try {
      window.localStorage.setItem(THEME_KEY, theme);
    } catch (err) {
      /* noop */
    }
  }

  /* ---------------------------------------------------------------- *
   * 起動
   * ---------------------------------------------------------------- */

  function init() {
    /* イントロのドレープ：4シーズンから2色ずつ */
    $("intro-drape").innerHTML = SEASON_ORDER.map(function (key) {
      var palette = DATA.color.seasons[key].palette;
      return [palette[0], palette[1]]
        .map(function (c) {
          return '<span style="background:' + c.hex + '"></span>';
        })
        .join("");
    }).join("");

    var savedTheme = null;
    try {
      savedTheme = window.localStorage.getItem(THEME_KEY);
    } catch (err) {
      /* noop */
    }
    $("theme-toggle").textContent = (savedTheme || currentTheme()) === "dark" ? "ライト表示" : "ダーク表示";
    if (savedTheme === "dark" || savedTheme === "light") applyTheme(savedTheme);

    $("theme-toggle").addEventListener("click", function () {
      applyTheme(currentTheme() === "dark" ? "light" : "dark");
    });

    $("start-btn").addEventListener("click", function () {
      state.skeleton = new Array(sq.length).fill(null);
      state.color = new Array(cq.length).fill(null);
      state.index = 0;
      save();
      renderQuiz();
      showView("quiz");
    });

    var saved = loadSaved();
    var resume = $("resume-btn");
    if (saved && (saved.index > 0 || saved.skeleton.some(function (v) { return v != null; }))) {
      resume.hidden = false;
      resume.addEventListener("click", function () {
        state.skeleton = saved.skeleton;
        state.color = saved.color;
        state.index = Math.min(Math.max(saved.index || 0, 0), TOTAL - 1);
        if (isComplete()) {
          finish();
        } else {
          renderQuiz();
          showView("quiz");
        }
      });
    }

    $("prev-btn").addEventListener("click", goBack);
    $("retry-btn").addEventListener("click", function () {
      clearSaved();
      state.skeleton = new Array(sq.length).fill(null);
      state.color = new Array(cq.length).fill(null);
      state.index = 0;
      if (window.history && window.history.replaceState) {
        window.history.replaceState(null, "", window.location.pathname + window.location.search);
      }
      renderQuiz();
      showView("quiz");
    });

    $("print-btn").addEventListener("click", function () {
      window.print();
    });

    $("copy-btn").addEventListener("click", function () {
      var text = resultText();
      if (navigator.clipboard && navigator.clipboard.writeText) {
        navigator.clipboard.writeText(text).then(
          function () {
            showToast("結果をコピーしました");
          },
          function () {
            showToast("コピーできませんでした");
          }
        );
      } else {
        showToast("この環境ではコピーできません");
      }
    });

    document.addEventListener("keydown", function (event) {
      if ($("view-quiz").hidden) return;
      if (event.metaKey || event.ctrlKey || event.altKey) return;

      var slot = questionAt(state.index);
      var count = slot.question.options.length;

      if (event.key >= "1" && event.key <= String(count)) {
        event.preventDefault();
        choose(Number(event.key) - 1);
      } else if (event.key === "ArrowDown" || event.key === "ArrowRight") {
        event.preventDefault();
        moveFocus(1);
      } else if (event.key === "ArrowUp" || event.key === "ArrowLeft") {
        event.preventDefault();
        moveFocus(-1);
      } else if (event.key === "Backspace") {
        event.preventDefault();
        goBack();
      }
    });

    /* 共有リンクから開かれた場合は、そのまま結果を表示する */
    applyHash();

    /* 別の共有リンクに貼り替えられたときや、戻る/進む操作にも追従する */
    window.addEventListener("hashchange", function () {
      if (applyHash()) return;
      if (!window.location.hash && !$("view-result").hidden) showView("intro");
    });
  }

  /** URL のハッシュが有効な回答なら、その結果を表示して true を返す。 */
  function applyHash() {
    var shared = decodeAnswers(window.location.hash);
    if (!shared) return false;
    state.skeleton = shared.skeleton;
    state.color = shared.color;
    state.index = TOTAL - 1;
    renderResult();
    showView("result");
    return true;
  }

  if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", init);
  } else {
    init();
  }
})();
