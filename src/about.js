const root = document.documentElement;
const langToggle = document.getElementById("lang-toggle");
const kanaToggle = document.getElementById("kana-toggle");

const LANG_KEY = "kyoquake-about-lang";
const KANA_KEY = "kyoquake-about-kana";

function currentLang() {
  return root.classList.contains("lang-ja") ? "ja" : "en";
}

function applyLang(lang, persist = true) {
  const isJa = lang === "ja";
  root.classList.toggle("lang-en", !isJa);
  root.classList.toggle("lang-ja", isJa);
  root.lang = isJa ? "ja" : "en";

  if (langToggle) {
    langToggle.setAttribute(
      "aria-label",
      isJa ? "Switch to English" : "日本語に切り替える",
    );
  }

  document.title = isJa ? "KyoQuake — 概要" : "KyoQuake — About";

  if (persist) {
    try {
      localStorage.setItem(LANG_KEY, isJa ? "ja" : "en");
    } catch (err) {
      // Ignore storage failures.
    }
  }
}

function applyKana(enabled, persist = true) {
  root.classList.toggle("kana-on", enabled);

  if (kanaToggle) {
    kanaToggle.setAttribute("aria-pressed", enabled ? "true" : "false");
  }

  if (persist) {
    try {
      localStorage.setItem(KANA_KEY, enabled ? "1" : "0");
    } catch (err) {
      // Ignore storage failures.
    }
  }
}

// Sync the controls with the language/kana classes set by the inline head script.
applyLang(currentLang(), false);
applyKana(root.classList.contains("kana-on"), false);

langToggle?.addEventListener("click", () => {
  applyLang(currentLang() === "ja" ? "en" : "ja");
});

kanaToggle?.addEventListener("click", () => {
  applyKana(!root.classList.contains("kana-on"));
});
