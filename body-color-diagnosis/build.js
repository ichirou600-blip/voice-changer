/*
 * CSS と JS を index.html に埋め込み、単一ファイル版を書き出す。
 *   node body-color-diagnosis/build.js
 *
 * 出力:
 *   dist/index.html  … そのまま配布・公開できる完全な HTML
 *   dist/embed.html  … <head>/<body> を持たない断片。既存ページへの埋め込み用
 *
 * 外部依存なし。
 */

const fs = require("fs");
const path = require("path");

const ROOT = __dirname;
const OUT = path.join(ROOT, "dist");

function read(name) {
  return fs.readFileSync(path.join(ROOT, name), "utf8");
}

// インライン化した JS が </script> でタグを閉じてしまわないようにする
function safeScript(code) {
  return code.replace(/<\/script/gi, "<\\/script");
}

const css = read("styles.css");
const scripts = ["data.js", "scoring.js", "app.js"];
const source = read("index.html");

let full = source.replace(
  /[ \t]*<link rel="stylesheet" href="styles\.css" \/>\n/,
  "<style>\n" + css + "</style>\n"
);

scripts.forEach(function (name) {
  const tag = new RegExp('[ \\t]*<script src="' + name.replace(".", "\\.") + '"></script>\\n');
  if (!tag.test(full)) {
    throw new Error(name + " の script タグが index.html に見つかりません");
  }
  full = full.replace(tag, "<script>\n" + safeScript(read(name)) + "</script>\n");
});

if (/<link rel="stylesheet"|<script src=/.test(full)) {
  throw new Error("インライン化されていない外部参照が残っています");
}

const bodyMatch = /<body>([\s\S]*)<\/body>/.exec(full);
const titleMatch = /<title>([\s\S]*?)<\/title>/.exec(full);
if (!bodyMatch || !titleMatch) {
  throw new Error("body または title を取り出せませんでした");
}

const embed =
  "<title>" +
  titleMatch[1] +
  "</title>\n<style>\n" +
  css +
  "</style>\n" +
  bodyMatch[1].trim() +
  "\n";

fs.mkdirSync(OUT, { recursive: true });
fs.writeFileSync(path.join(OUT, "index.html"), full, "utf8");
fs.writeFileSync(path.join(OUT, "embed.html"), embed, "utf8");

function kb(text) {
  return (Buffer.byteLength(text, "utf8") / 1024).toFixed(1) + " KB";
}

console.log("dist/index.html  " + kb(full));
console.log("dist/embed.html  " + kb(embed));
