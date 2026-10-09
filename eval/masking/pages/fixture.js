/*
 * 評価用ページの架空データを、ページ読み込み時に埋め込む(AM-T05)。
 *
 * - 認証情報の形(接頭辞 + 英数字)・長いランダム列・カード番号は、ソースに完全な形を書かない。
 *   接頭辞は断片を連結して作り、本体は固定シードの擬似乱数で作る(push 時のシークレット検出対策。決定 #5)
 * - カード番号はチェックディジット(Luhn)を満たす乱数。先頭は主要な発行者の範囲を避けて 9 にする
 * - 同じページ・同じ要素の順番なら毎回同じ値になる(撮り直しても画像が変わらない)
 *
 * 使い方: <span data-mask="credential/prefixed_token" data-gen="token" data-prefix="0" data-len="36"></span>
 */
(() => {
  /** 32bit の擬似乱数(mulberry32) */
  function mulberry32(seed) {
    let a = seed >>> 0;
    return () => {
      a = (a + 0x6d2b79f5) >>> 0;
      let t = a;
      t = Math.imul(t ^ (t >>> 15), t | 1);
      t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
      return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
    };
  }

  /** 文字列から 32bit のシード(FNV-1a) */
  function hashSeed(str) {
    let h = 0x811c9dc5;
    for (let i = 0; i < str.length; i++) {
      h ^= str.charCodeAt(i);
      h = Math.imul(h, 0x01000193);
    }
    return h >>> 0;
  }

  const UPPER = "ABCDEFGHIJKLMNOPQRSTUVWXYZ";
  const LOWER = "abcdefghijklmnopqrstuvwxyz";
  const DIGITS = "0123456789";

  /**
   * 接頭辞の一覧(断片の配列。連結して使う)。サービス名は書かない。
   * 各要素: [断片..., 本体の文字種]。文字種は "alnum" | "upper" | "dashed_digits"(数字-数字-英数字)
   */
  const PREFIXES = [
    [["sk", "_li", "ve_"], "alnum"],
    [["gh", "p_"], "alnum"],
    [["gh", "o_"], "alnum"],
    [["xo", "xb-"], "dashed_digits"],
    [["AK", "IA"], "upper"],
    [["gl", "pat-"], "alnum"],
    [["np", "m_"], "alnum"],
    [["AI", "za"], "alnum"],
    [["sk", "-pr", "oj-"], "alnum"],
    [["hf", "_"], "alnum"],
    [["rk", "_li", "ve_"], "alnum"],
    [["SG", "."], "alnum"],
  ];

  function pick(rand, chars) {
    return chars[Math.floor(rand() * chars.length)];
  }

  /** 英字と数字を必ず両方含む列 */
  function mixed(rand, len, chars) {
    for (;;) {
      let s = "";
      for (let i = 0; i < len; i++) s += pick(rand, chars);
      if (/[A-Za-z]/.test(s) && /[0-9]/.test(s)) return s;
    }
  }

  function genToken(rand, el) {
    const [parts, body] = PREFIXES[Number(el.dataset.prefix ?? 0) % PREFIXES.length];
    const prefix = parts.join("");
    const len = Number(el.dataset.len ?? 32);
    if (body === "upper") return prefix + mixed(rand, len, UPPER + DIGITS);
    if (body === "dashed_digits") {
      let digits1 = "";
      let digits2 = "";
      for (let i = 0; i < 12; i++) digits1 += pick(rand, DIGITS);
      for (let i = 0; i < 13; i++) digits2 += pick(rand, DIGITS);
      return `${prefix}${digits1}-${digits2}-${mixed(rand, len, UPPER + LOWER + DIGITS)}`;
    }
    return prefix + mixed(rand, len, UPPER + LOWER + DIGITS);
  }

  function genRandom(rand, el) {
    const len = Number(el.dataset.len ?? 32);
    const charset = el.dataset.charset === "hex" ? "0123456789abcdef" : UPPER + LOWER + DIGITS + "-_";
    return mixed(rand, len, charset);
  }

  /** 手がかり語の後の値(パスワードらしい短めの列) */
  function genSecret(rand, el) {
    const len = Number(el.dataset.len ?? 12);
    return mixed(rand, len, UPPER + LOWER + DIGITS + "#%&*+!");
  }

  /** Luhn のチェックディジット */
  function luhnDigit(body) {
    let sum = 0;
    for (let i = 0; i < body.length; i++) {
      let d = Number(body[body.length - 1 - i]);
      if (i % 2 === 0) {
        d *= 2;
        if (d > 9) d -= 9;
      }
      sum += d;
    }
    return String((10 - (sum % 10)) % 10);
  }

  /** data-group="4-4-4-4"(桁の区切り方)、data-sep=" " | "-" | ""(区切り文字) */
  function genCard(rand, el) {
    const groups = (el.dataset.group ?? "4-4-4-4").split("-").map(Number);
    const total = groups.reduce((a, b) => a + b, 0);
    let body = "9";
    while (body.length < total - 1) body += pick(rand, DIGITS);
    const digits = body + luhnDigit(body);
    const sep = el.dataset.sep ?? " ";
    const out = [];
    let pos = 0;
    for (const g of groups) {
      out.push(digits.slice(pos, pos + g));
      pos += g;
    }
    return out.join(sep);
  }

  const GENERATORS = { token: genToken, random: genRandom, secret: genSecret, card: genCard };

  const page = location.pathname.split("/").pop() || "page";
  document.querySelectorAll("[data-gen]").forEach((el, i) => {
    const gen = GENERATORS[el.dataset.gen];
    if (!gen) throw new Error(`unknown data-gen at #${i}`);
    const rand = mulberry32(hashSeed(`${page}:${i}`));
    el.textContent = (el.dataset.before ?? "") + gen(rand, el) + (el.dataset.after ?? "");
  });
  document.documentElement.dataset.fixtureReady = "1";
})();
