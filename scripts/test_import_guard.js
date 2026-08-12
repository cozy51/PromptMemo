// Tests for the import confirmation: `node scripts/test_import_guard.js`.
//
// The popup is loaded as the browser loads it, against a fake DOM built from
// popup.html, and files are handed to it exactly as the file input would.  What
// is checked is what the user sees before deciding: the two columns of counts,
// the dates, the warning, and whether the button is available at all.
const fs = require("fs");
const path = require("path");
const vm = require("vm");
const { createDocument, settle } = require("./fake_popup.js");

const root = path.join(__dirname, "..");
const html = fs.readFileSync(path.join(root, "popup.html"), "utf8");
const sources = ["sync-core.js", "popup.js"]
  .map((name) => ({ name, code: fs.readFileSync(path.join(root, name), "utf8") }));

function check(actual, expected, label) {
  if (actual !== expected) {
    throw new Error(`${label}: expected ${JSON.stringify(expected)}, received ${JSON.stringify(actual)}`);
  }
}

// Relative to the real clock: an import is judged against when the library was
// last saved, and saving happens at the moment the test runs.
const NOW = Date.now();
const HOUR = 60 * 60 * 1000;

function formatted(at) {
  return new Intl.DateTimeFormat("ja-JP", {
    year: "numeric", month: "numeric", day: "numeric", hour: "2-digit", minute: "2-digit"
  }).format(new Date(at));
}

function prompt(id, extra = {}) {
  return {
    id, title: `題名${id}`, description: "", content: `本文${id}`,
    tags: ["仕事"], favorite: false, updatedAt: NOW, ...extra
  };
}

function library(count, { at = NOW, favorites = 0, tags = ["仕事"] } = {}) {
  return Array.from({ length: count }, (_, index) => prompt(`p${index}`, {
    updatedAt: at,
    favorite: index < favorites,
    tags
  }));
}

function backup(prompts, exportedAt) {
  return JSON.stringify({
    format: "prompt-memo",
    kind: "full-backup",
    version: 1,
    ...(exportedAt ? { exportedAt: new Date(exportedAt).toISOString() } : {}),
    prompts
  });
}

function openPopup({ prompts = [], updatedAt = NOW, settings = null } = {}) {
  const store = {
    promptMemoItems: prompts,
    promptMemoDataUpdatedAt: new Date(updatedAt).toISOString(),
    ...(settings ? { promptMemoConfirmationSettings: settings } : {})
  };
  const doc = createDocument(html);
  const toasts = [];

  const context = {
    JSON, Math, Number, String, Boolean, Array, Object, Date, RegExp, Set, Map,
    Promise, Intl, Error, console,
    crypto: { randomUUID: () => `id-${Math.random().toString(36).slice(2)}` },
    navigator: { userAgent: "Mozilla/5.0 (Windows NT 10.0) Chrome/120.0 Edg/120.0" },
    document: doc,
    setTimeout,
    clearTimeout,
    chrome: {
      runtime: { getManifest: () => ({ version: "1.2.0" }) },
      storage: {
        local: {
          async get(keys) {
            const list = Array.isArray(keys) ? keys : [keys];
            return Object.fromEntries(list
              .filter((key) => key in store)
              .map((key) => [key, JSON.parse(JSON.stringify(store[key]))]));
          },
          async set(items) { Object.assign(store, JSON.parse(JSON.stringify(items))); }
        },
        onChanged: { addListener() {} }
      }
    }
  };
  context.window = context;
  context.globalThis = context;
  vm.createContext(context);
  sources.forEach(({ name, code }) => vm.runInContext(code, context, { filename: name }));
  // The toast is the only feedback for an import that needs no dialog.
  const toast = doc.querySelector("#toast");
  Object.defineProperty(toast, "textContent", {
    set(value) { toasts.push(value); },
    get() { return toasts[toasts.length - 1] || ""; }
  });

  return {
    store,
    toasts,
    el: (id) => doc.querySelector(`#${id}`),
    text: (id) => doc.querySelector(`#${id}`).textContent,
    async load(name, text) {
      const input = doc.querySelector("#importFile");
      input.files = [{ name, text: async () => text }];
      input.dispatch("change");
      await settle();
    }
  };
}

(async function main() {
  // 1. An older file: the warning names the gap and the button is held back
  //    until the user says they understand what it costs.
  const stale = openPopup({ prompts: library(23), updatedAt: NOW });
  await stale.load("backup-ext_PromptMemo_2026-08-12_0130.json", backup(library(24, { at: NOW - 2 * HOUR }), NOW - 2 * HOUR));
  check(stale.el("importDialog").open, true, "An older file is questioned before it is applied");
  check(stale.text("importFileName"), "backup-ext_PromptMemo_2026-08-12_0130.json", "The file is named");
  check(
    stale.text("importWarning"),
    "このファイルは、現在のデータより約2時間古い内容です。インポートすると、その間の変更は失われます。",
    "The warning says how old the file is and what it costs"
  );
  check(stale.el("importWarning").dataset.level, "danger", "…and reads as the strong warning");
  check(stale.el("importAcknowledgeRow").classList.contains("hidden"), false, "It has to be acknowledged");
  check(stale.el("importSkipRow").classList.contains("hidden"), true, "…and cannot be switched off for next time");
  check(stale.el("confirmImportButton").disabled, true, "The button is unavailable until then");
  check(stale.el("confirmImportButton").textContent, "古い内容で上書きする", "…and says what it will do");

  // The comparison the user judges by.
  check(stale.text("importCurrentPromptCount"), "23件", "The current count is shown");
  check(stale.text("importFilePromptCount"), "24件（+1）", "…beside the file's, with the difference");
  check(stale.text("importCurrentUpdatedAt"), formatted(NOW), "The current data is dated");
  check(stale.text("importFileUpdatedAt"), formatted(NOW - 2 * HOUR), "…and so is the file");

  stale.el("importForm").dispatch("submit");
  await settle();
  check(stale.store.promptMemoItems.length, 23, "Submitting without acknowledging changes nothing");
  check(stale.toasts.at(-1), "古い内容で上書きすることを確認してください", "…and says what is missing");

  stale.el("importAcknowledge").checked = true;
  stale.el("importAcknowledge").dispatch("change");
  check(stale.el("confirmImportButton").disabled, false, "Acknowledging releases the button");
  stale.el("importForm").dispatch("submit");
  await settle();
  check(stale.store.promptMemoItems.length, 24, "…and the acknowledged import is applied");
  check(stale.el("importDialog").open, false, "The dialog closes once it is done");

  // 2. A newer file is an ordinary import: it still shows the comparison, with
  //    no warning and no acknowledgement.
  const fresh = openPopup({ prompts: library(23), updatedAt: NOW });
  await fresh.load("newer.json", backup(library(24, { at: NOW + HOUR, favorites: 3 }), NOW + HOUR));
  check(fresh.el("importDialog").open, true, "A replacement is always confirmed");
  check(fresh.el("importWarning").classList.contains("hidden"), true, "…without a warning when it is safe");
  check(fresh.el("importAcknowledgeRow").classList.contains("hidden"), true, "…and without an acknowledgement");
  check(fresh.el("importSkipRow").classList.contains("hidden"), false, "…but it can be skipped next time");
  check(fresh.el("confirmImportButton").disabled, false, "The button is available straight away");
  check(fresh.text("importCurrentFavoriteCount"), "0件", "Favourites are compared too");
  check(fresh.text("importFileFavoriteCount"), "3件（+3）", "…with the difference");
  check(fresh.text("importFileTagCount"), "1件（増減なし）", "An unchanged count says so rather than showing +0");

  fresh.el("importSkipConfirmation").checked = true;
  fresh.el("importForm").dispatch("submit");
  await settle();
  check(fresh.store.promptMemoItems.length, 24, "The import is applied");
  check(fresh.store.promptMemoConfirmationSettings.fullRestore, false, "…and the skip is remembered");

  // The remembered skip only covers the safe case.
  await fresh.load("newer2.json", backup(library(25, { at: NOW + 2 * HOUR }), NOW + 2 * HOUR));
  check(fresh.el("importDialog").open, false, "A plainly newer file now applies without asking");
  check(fresh.store.promptMemoItems.length, 25, "…and is applied");
  await fresh.load("older.json", backup(library(25, { at: NOW - 5 * HOUR }), NOW - 5 * HOUR));
  check(fresh.el("importDialog").open, true, "An older file asks even so");
  check(fresh.el("importSkipRow").classList.contains("hidden"), true, "…and offers no way to silence that");
  fresh.el("cancelImportButton").dispatch("click");
  await settle();
  check(fresh.store.promptMemoItems.length, 25, "Cancelling leaves the library alone");

  // 3. A newer file that drops most of the library: a milder warning, no
  //    acknowledgement, because the dates say it really is the newer copy.
  const shrinking = openPopup({ prompts: library(23), updatedAt: NOW });
  await shrinking.load("small.json", backup(library(3, { at: NOW + HOUR }), NOW + HOUR));
  check(
    shrinking.text("importWarning"),
    "このファイルは現在より20件少ない内容です。",
    "A much smaller file is flagged with the number it drops"
  );
  check(shrinking.el("importWarning").dataset.level, "caution", "…as a caution, not a danger");
  check(shrinking.el("confirmImportButton").disabled, false, "…and can be applied directly");
  check(shrinking.text("importFilePromptCount"), "3件（-20）", "The drop is visible in the counts");

  // 4. A file with no dates at all: say so instead of guessing.
  const undated = openPopup({ prompts: library(5), updatedAt: NOW });
  await undated.load("hand-written.json", JSON.stringify({
    format: "prompt-memo",
    prompts: [1, 2, 3, 4, 5].map((index) => ({ id: `x${index}`, title: "手書き", content: "本文" }))
  }));
  check(
    undated.text("importWarning"),
    "日時を読み取れないため、どちらが新しいかは判断できません。件数を確認してください。",
    "An undated file asks the user to judge by the counts"
  );
  check(undated.text("importFileUpdatedAt"), "不明", "…and its date reads as unknown");
  check(undated.el("importSkipRow").classList.contains("hidden"), true, "…and cannot be waved through next time");

  // Both facts at once: undated *and* much smaller.
  const undatedSmall = openPopup({ prompts: library(20), updatedAt: NOW });
  await undatedSmall.load("hand-written.json", JSON.stringify({
    format: "prompt-memo",
    prompts: [{ id: "x", title: "手書き", content: "本文" }]
  }));
  check(
    undatedSmall.text("importWarning"),
    "このファイルは現在より19件少ない内容です。"
      + "日時を読み取れないため、どちらが新しいかは判断できません。件数を確認してください。",
    "Size and date are reported together, neither hiding the other"
  );

  // 5. An empty library has nothing to lose, so the first import just happens.
  const empty = openPopup({ prompts: [] });
  await empty.load("first.json", backup(library(4, { at: NOW })));
  check(empty.el("importDialog").open, false, "Importing into an empty library needs no confirmation");
  check(empty.store.promptMemoItems.length, 4, "…and is applied");
  check(empty.toasts.at(-1), "全4件をインポートしました", "…and says what happened");

  // 6. A single prompt is added, never a replacement.
  const single = openPopup({ prompts: library(3) });
  await single.load("one.json", JSON.stringify({
    format: "prompt-memo",
    kind: "single-prompt",
    prompt: { id: "solo", title: "1件", content: "本文" }
  }));
  check(single.el("importDialog").open, false, "A single prompt is not a replacement");
  check(single.store.promptMemoItems.length, 4, "…it is added to the library");

  console.log("import guard: すべてのテストに合格しました");
})();
