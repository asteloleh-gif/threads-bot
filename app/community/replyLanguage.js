const LANGUAGE_NAMES = {
  en: "English",
  ru: "Russian",
  uk: "Ukrainian",
  zh: "Chinese",
};

const UKRAINIAN_HINTS = new Set([
  "це", "що", "як", "але", "або", "дуже", "тут", "там", "мені", "тобі", "тебе",
  "який", "яка", "яке", "які", "буде", "можна", "треба", "потрібно", "дякую", "привіт",
]);

function tokenize(text) {
  return String(text || "")
    .toLowerCase()
    .match(/[\p{L}\p{N}]+/gu) || [];
}

function detectCurrentCommentLanguage(text) {
  const value = String(text || "").trim();
  if (!value) return null;

  if (/[\u3400-\u4dbf\u4e00-\u9fff]/u.test(value)) return "zh";

  if (/[А-Яа-яЁёІіЇїЄєҐґ]/u.test(value)) {
    if (/[ІіЇїЄєҐґ]/u.test(value)) return "uk";
    const tokens = tokenize(value);
    if (tokens.some(token => UKRAINIAN_HINTS.has(token))) return "uk";
    return "ru";
  }

  if (/[A-Za-z]/u.test(value)) return "en";
  return null;
}

function buildLanguageLock(text) {
  const code = detectCurrentCommentLanguage(text);
  if (!code) return { code: null, name: null, instruction: null };
  const name = LANGUAGE_NAMES[code];
  return {
    code,
    name,
    instruction: `OUTPUT LANGUAGE LOCK: ${name}. Write the entire reply in ${name}. The language of conversation history, persona memory, examples, or the knowledge base must never change this. Do not translate the user's comment; only answer it in ${name}.`,
  };
}

module.exports = {
  LANGUAGE_NAMES,
  detectCurrentCommentLanguage,
  buildLanguageLock,
};
