const STORAGE_KEY = "promptMemoItems";
const CONFIRMATION_SETTINGS_KEY = "promptMemoConfirmationSettings";
const COLLAPSED_TAGS_KEY = "promptMemoCollapsedTags";
const TITLE_COLLATOR = new Intl.Collator("ja", {
  sensitivity: "base",
  numeric: true
});

const els = {
  addButton: document.querySelector("#addButton"),
  confirmationSettingsButton: document.querySelector("#confirmationSettingsButton"),
  versionBadge: document.querySelector("#versionBadge"),
  emptyAddButton: document.querySelector("#emptyAddButton"),
  searchInput: document.querySelector("#searchInput"),
  filterBar: document.querySelector("#filterBar"),
  promptList: document.querySelector("#promptList"),
  emptyState: document.querySelector("#emptyState"),
  emptyTitle: document.querySelector("#emptyTitle"),
  emptyText: document.querySelector("#emptyText"),
  exportAllButton: document.querySelector("#exportAllButton"),
  importButton: document.querySelector("#importButton"),
  importFile: document.querySelector("#importFile"),
  dialog: document.querySelector("#editorDialog"),
  form: document.querySelector("#editorForm"),
  dialogTitle: document.querySelector("#dialogTitle"),
  promptId: document.querySelector("#promptId"),
  titleInput: document.querySelector("#titleInput"),
  descriptionInput: document.querySelector("#descriptionInput"),
  contentInput: document.querySelector("#contentInput"),
  tagsInput: document.querySelector("#tagsInput"),
  favoriteInput: document.querySelector("#favoriteInput"),
  deleteButton: document.querySelector("#deleteButton"),
  closeDialog: document.querySelector("#closeDialog"),
  cancelButton: document.querySelector("#cancelButton"),
  confirmDialog: document.querySelector("#confirmDialog"),
  confirmForm: document.querySelector("#confirmForm"),
  confirmTitle: document.querySelector("#confirmTitle"),
  confirmMessage: document.querySelector("#confirmMessage"),
  skipConfirmationInput: document.querySelector("#skipConfirmationInput"),
  skipConfirmationLabel: document.querySelector("#skipConfirmationLabel"),
  confirmProceedButton: document.querySelector("#confirmProceedButton"),
  closeConfirmDialog: document.querySelector("#closeConfirmDialog"),
  cancelConfirmButton: document.querySelector("#cancelConfirmButton"),
  confirmationSettingsDialog: document.querySelector("#confirmationSettingsDialog"),
  confirmationSettingsForm: document.querySelector("#confirmationSettingsForm"),
  closeConfirmationSettings: document.querySelector("#closeConfirmationSettings"),
  showDeleteConfirmation: document.querySelector("#showDeleteConfirmation"),
  showRestoreConfirmation: document.querySelector("#showRestoreConfirmation"),
  toast: document.querySelector("#toast")
};

let prompts = [];
let currentFilter = "favorite";
let toastTimer;
let confirmationSettings = {
  delete: true,
  fullRestore: true
};
let collapsedTags = new Set();
let pendingConfirmation = null;

init();

async function init() {
  const result = await chrome.storage.local.get([
    STORAGE_KEY,
    CONFIRMATION_SETTINGS_KEY,
    COLLAPSED_TAGS_KEY
  ]);
  prompts = Array.isArray(result[STORAGE_KEY]) ? result[STORAGE_KEY] : [];
  collapsedTags = new Set(
    Array.isArray(result[COLLAPSED_TAGS_KEY]) ? result[COLLAPSED_TAGS_KEY] : []
  );
  confirmationSettings = {
    ...confirmationSettings,
    ...(result[CONFIRMATION_SETTINGS_KEY] || {})
  };
  renderVersion();
  render();
  els.searchInput.focus();
}

function renderVersion() {
  const version = chrome.runtime.getManifest().version;
  els.versionBadge.textContent = `v${version}`;
}

function render() {
  const query = els.searchInput.value.trim().toLocaleLowerCase("ja");
  const visible = prompts
    .filter((prompt) => {
      const searchable = [prompt.title, prompt.description, prompt.content, ...(prompt.tags || [])].join(" ").toLocaleLowerCase("ja");
      return !query || searchable.includes(query);
    })
    .filter((prompt) => {
      if (currentFilter === "favorite") return prompt.favorite;
      if (currentFilter === "other") return !prompt.favorite;
      return true;
    })
    .sort((a, b) =>
      TITLE_COLLATOR.compare(a.title, b.title) ||
      b.updatedAt - a.updatedAt
    );

  const listItems = currentFilter === "tags"
    ? createTagGroups(visible)
    : visible.map(createCard);
  els.promptList.replaceChildren(...listItems);
  const isEmpty = visible.length === 0;
  els.promptList.classList.toggle("hidden", isEmpty);
  els.emptyState.classList.toggle("hidden", !isEmpty);
  els.emptyAddButton.classList.toggle("hidden", prompts.length > 0);

  if (prompts.length && isEmpty) {
    els.emptyTitle.textContent = "見つかりませんでした";
    els.emptyText.textContent = "検索語や絞り込みを変えてみてください。";
  } else {
    els.emptyTitle.textContent = "プロンプトがありません";
    els.emptyText.textContent = "よく使う指示を保存して、いつでも呼び出せます。";
  }
}

function createTagGroups(items) {
  const groups = new Map();

  for (const prompt of items) {
    const tags = Array.isArray(prompt.tags)
      ? prompt.tags.map((tag) => tag.trim()).filter(Boolean)
      : [];
    const groupTags = tags.length ? tags : ["タグなし"];

    for (const tag of groupTags) {
      const key = tag.toLocaleLowerCase("ja");
      if (!groups.has(key)) groups.set(key, { label: tag, prompts: [] });
      groups.get(key).prompts.push(prompt);
    }
  }

  return [...groups.values()]
    .sort((a, b) => {
      if (a.label === "タグなし") return 1;
      if (b.label === "タグなし") return -1;
      return a.label.localeCompare(b.label, "ja");
    })
    .map(({ label, prompts: taggedPrompts }) => {
      const group = document.createElement("section");
      group.className = "tag-group";

      const heading = document.createElement("h2");
      heading.className = "tag-group-title";

      const toggle = document.createElement("button");
      toggle.className = "tag-group-toggle";
      toggle.type = "button";
      toggle.dataset.tagKey = label.toLocaleLowerCase("ja");
      toggle.setAttribute("aria-expanded", String(!collapsedTags.has(toggle.dataset.tagKey)));

      const arrow = document.createElement("span");
      arrow.className = "tag-group-arrow";
      arrow.setAttribute("aria-hidden", "true");
      arrow.textContent = "▼";

      const name = document.createElement("span");
      name.className = "tag-group-name";
      name.textContent = label;

      const count = document.createElement("span");
      count.className = "tag-group-count";
      count.textContent = `${taggedPrompts.length}件`;
      toggle.append(arrow, name, count);
      heading.append(toggle);

      const cards = document.createElement("div");
      cards.className = "tag-group-cards";
      cards.classList.toggle("hidden", collapsedTags.has(toggle.dataset.tagKey));
      cards.append(...taggedPrompts.map(createCard));

      group.append(heading, cards);
      return group;
    });
}

function createCard(prompt) {
  const card = document.createElement("article");
  card.className = "prompt-card";

  const info = document.createElement("div");
  info.className = "card-info";

  const head = document.createElement("div");
  head.className = "card-head";

  const title = document.createElement("h2");
  title.className = "card-title";
  title.textContent = prompt.title;

  const favorite = document.createElement("button");
  favorite.className = `favorite-button${prompt.favorite ? " active" : ""}`;
  favorite.textContent = prompt.favorite ? "★" : "☆";
  favorite.title = "お気に入り";
  favorite.addEventListener("click", () => toggleFavorite(prompt.id));

  const edit = document.createElement("button");
  edit.className = "edit-button";
  edit.textContent = "編集";
  edit.addEventListener("click", () => openEditor(prompt));

  head.append(title, favorite, edit);

  const content = document.createElement("p");
  content.className = "card-content";
  content.textContent = prompt.description || prompt.content;

  info.append(head, content);

  if (prompt.tags?.length) {
    const tags = document.createElement("div");
    tags.className = "tags";
    for (const value of prompt.tags) {
      const tag = document.createElement("span");
      tag.className = "tag";
      tag.textContent = value;
      tags.append(tag);
    }
    info.append(tags);
  }

  const actions = document.createElement("div");
  actions.className = "card-actions";
  actions.append(
    actionButton("貼り付け", "button primary insert", () => insertIntoPage(prompt.content)),
    actionButton("コピー", "button copy-action", () => copyPrompt(prompt.content))
  );
  card.append(info, actions);
  return card;
}

function actionButton(label, className, handler) {
  const button = document.createElement("button");
  button.className = className;
  button.textContent = label;
  button.addEventListener("click", handler);
  return button;
}

function openEditor(prompt = null) {
  els.form.reset();
  els.titleInput.setCustomValidity("");
  els.promptId.value = prompt?.id || "";
  els.titleInput.value = prompt?.title || "";
  els.descriptionInput.value = prompt?.description || "";
  els.contentInput.value = prompt?.content || "";
  els.tagsInput.value = prompt?.tags?.join(", ") || "";
  els.favoriteInput.checked = Boolean(prompt?.favorite);
  els.dialogTitle.textContent = prompt ? "プロンプトを編集" : "新しいプロンプト";
  els.deleteButton.classList.toggle("hidden", !prompt);
  els.dialog.showModal();
  els.titleInput.focus();
}

function closeEditor() {
  els.dialog.close();
}

async function savePrompts() {
  await chrome.storage.local.set({ [STORAGE_KEY]: prompts });
  render();
}

async function backupToFile() {
  const now = new Date();
  const pad = (value) => String(value).padStart(2, "0");
  const timestamp = [
    now.getFullYear(),
    pad(now.getMonth() + 1),
    pad(now.getDate())
  ].join("-") + `_${pad(now.getHours())}${pad(now.getMinutes())}`;
  const filename = `backup-ext_PromptMemo_${timestamp}.json`;
  const backup = {
    format: "prompt-memo",
    kind: "full-backup",
    version: 1,
    exportedAt: new Date().toISOString(),
    prompts
  };
  const blob = new Blob([JSON.stringify(backup, null, 2)], { type: "application/json" });
  const url = URL.createObjectURL(blob);

  try {
    await chrome.downloads.download({
      url,
      filename,
      conflictAction: "uniquify",
      saveAs: false
    });
    return filename;
  } finally {
    setTimeout(() => URL.revokeObjectURL(url), 10000);
  }
}

async function toggleFavorite(id) {
  const prompt = prompts.find((item) => item.id === id);
  if (!prompt) return;
  prompt.favorite = !prompt.favorite;
  prompt.updatedAt = Date.now();
  await savePrompts();
}

async function copyPrompt(content) {
  await navigator.clipboard.writeText(content);
  showToast("クリップボードにコピーしました");
}

async function insertIntoPage(content) {
  try {
    const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
    if (!tab?.id) throw new Error("active tab not found");

    const results = await chrome.scripting.executeScript({
      target: { tabId: tab.id },
      func: insertText,
      args: [content]
    });

    if (!results?.[0]?.result) {
      await navigator.clipboard.writeText(content);
      showToast("入力欄が未選択のためコピーしました");
      return;
    }
    window.close();
  } catch {
    await navigator.clipboard.writeText(content);
    showToast("このページには挿入できないためコピーしました");
  }
}

function insertText(text) {
  const element = document.activeElement;
  if (!element) return false;

  if (element instanceof HTMLTextAreaElement || (element instanceof HTMLInputElement && /^(text|search|url|email|tel|password)$/i.test(element.type))) {
    const start = element.selectionStart ?? element.value.length;
    const end = element.selectionEnd ?? start;
    element.setRangeText(text, start, end, "end");
    element.dispatchEvent(new InputEvent("input", { bubbles: true, inputType: "insertText", data: text }));
    element.dispatchEvent(new Event("change", { bubbles: true }));
    element.focus();
    return true;
  }

  const editable = element.closest?.('[contenteditable="true"], [contenteditable="plaintext-only"]');
  if (editable) {
    const selection = window.getSelection();
    if (!selection?.rangeCount || !editable.contains(selection.anchorNode)) {
      const range = document.createRange();
      range.selectNodeContents(editable);
      range.collapse(false);
      selection.removeAllRanges();
      selection.addRange(range);
    }
    const range = selection.getRangeAt(0);
    range.deleteContents();
    const node = document.createTextNode(text);
    range.insertNode(node);
    range.setStartAfter(node);
    range.collapse(true);
    selection.removeAllRanges();
    selection.addRange(range);
    editable.dispatchEvent(new InputEvent("input", { bubbles: true, inputType: "insertText", data: text }));
    editable.focus();
    return true;
  }

  return false;
}

function showToast(message) {
  clearTimeout(toastTimer);
  els.toast.textContent = message;
  els.toast.classList.add("show");
  toastTimer = setTimeout(() => els.toast.classList.remove("show"), 2200);
}

function normalizeTitle(title) {
  return title.trim().normalize("NFKC").toLocaleLowerCase("ja");
}

async function saveConfirmationSettings() {
  await chrome.storage.local.set({ [CONFIRMATION_SETTINGS_KEY]: confirmationSettings });
}

function askForConfirmation(type, options) {
  if (!confirmationSettings[type]) return Promise.resolve(true);

  els.confirmTitle.textContent = options.title;
  els.confirmMessage.textContent = options.message;
  els.skipConfirmationLabel.textContent = options.skipLabel;
  els.skipConfirmationInput.checked = false;
  els.confirmProceedButton.textContent = options.confirmLabel;
  els.confirmProceedButton.className = options.danger ? "button danger solid" : "button primary";
  els.confirmDialog.showModal();

  return new Promise((resolve) => {
    pendingConfirmation = { resolve, type };
  });
}

function finishConfirmation(result) {
  if (!pendingConfirmation) return;
  const { resolve } = pendingConfirmation;
  pendingConfirmation = null;
  els.confirmDialog.close();
  resolve(result);
}

function openConfirmationSettings() {
  els.showDeleteConfirmation.checked = confirmationSettings.delete;
  els.showRestoreConfirmation.checked = confirmationSettings.fullRestore;
  els.confirmationSettingsDialog.showModal();
}

els.addButton.addEventListener("click", () => openEditor());
els.confirmationSettingsButton.addEventListener("click", openConfirmationSettings);
els.emptyAddButton.addEventListener("click", () => openEditor());
els.closeDialog.addEventListener("click", closeEditor);
els.cancelButton.addEventListener("click", closeEditor);
els.searchInput.addEventListener("input", render);
els.titleInput.addEventListener("input", () => els.titleInput.setCustomValidity(""));
els.closeConfirmDialog.addEventListener("click", () => finishConfirmation(false));
els.cancelConfirmButton.addEventListener("click", () => finishConfirmation(false));
els.confirmDialog.addEventListener("cancel", (event) => {
  event.preventDefault();
  finishConfirmation(false);
});

els.confirmForm.addEventListener("submit", async (event) => {
  event.preventDefault();
  if (!pendingConfirmation) return;
  if (els.skipConfirmationInput.checked) {
    confirmationSettings[pendingConfirmation.type] = false;
    await saveConfirmationSettings();
  }
  finishConfirmation(true);
});

els.closeConfirmationSettings.addEventListener("click", () => els.confirmationSettingsDialog.close());
els.confirmationSettingsForm.addEventListener("submit", async (event) => {
  event.preventDefault();
  confirmationSettings.delete = els.showDeleteConfirmation.checked;
  confirmationSettings.fullRestore = els.showRestoreConfirmation.checked;
  await saveConfirmationSettings();
  els.confirmationSettingsDialog.close();
  showToast("確認設定を保存しました");
});
els.exportAllButton.addEventListener("click", async () => {
  const filename = await backupToFile();
  showToast(`全${prompts.length}件を ${filename} にエクスポートしました`);
});
els.importButton.addEventListener("click", () => els.importFile.click());

els.importFile.addEventListener("change", async () => {
  const file = els.importFile.files?.[0];
  if (!file) return;

  try {
    const parsed = JSON.parse(await file.text());
    const isSingle = parsed?.kind === "single-prompt" && parsed.prompt;
    const imported = isSingle
      ? [parsed.prompt]
      : (Array.isArray(parsed) ? parsed : parsed.prompts);
    if (!Array.isArray(imported)) throw new Error("invalid format");

    const valid = imported.filter((item) =>
      item && typeof item.title === "string" && typeof item.content === "string"
    ).map((item) => ({
      id: typeof item.id === "string" ? item.id : crypto.randomUUID(),
      title: item.title,
      description: typeof item.description === "string" ? item.description : "",
      content: item.content,
      tags: Array.isArray(item.tags) ? item.tags.filter((tag) => typeof tag === "string") : [],
      favorite: Boolean(item.favorite),
      updatedAt: Number(item.updatedAt) || Date.now()
    }));

    if (!valid.length && imported.length) throw new Error("no valid prompts");

    if (isSingle) {
      const restored = { ...valid[0], id: crypto.randomUUID(), updatedAt: Date.now() };
      prompts.push(restored);
    } else {
      if (prompts.length) {
        const approved = await askForConfirmation("fullRestore", {
          title: "全件データをインポート",
          message: `現在の${prompts.length}件を、インポートする${valid.length}件で置き換えます。よろしいですか？`,
          skipLabel: "今後は全件インポート時の確認を省略する",
          confirmLabel: "全件をインポート",
          danger: false
        });
        if (!approved) return;
      }
      prompts = valid;
    }
    await savePrompts();
    showToast(isSingle ? "個別プロンプトを1件インポートしました" : `全${valid.length}件をインポートしました`);
  } catch {
    showToast("このJSONファイルは読み込めません");
  } finally {
    els.importFile.value = "";
  }
});

els.filterBar.addEventListener("click", (event) => {
  const button = event.target.closest("[data-filter]");
  if (!button) return;
  currentFilter = button.dataset.filter;
  els.filterBar.querySelectorAll(".filter").forEach((item) => item.classList.toggle("active", item === button));
  render();
});

els.promptList.addEventListener("click", async (event) => {
  const toggle = event.target.closest(".tag-group-toggle");
  if (!toggle) return;

  const key = toggle.dataset.tagKey;
  if (collapsedTags.has(key)) {
    collapsedTags.delete(key);
  } else {
    collapsedTags.add(key);
  }
  await chrome.storage.local.set({ [COLLAPSED_TAGS_KEY]: [...collapsedTags] });
  render();
});

els.form.addEventListener("submit", async (event) => {
  event.preventDefault();
  const now = Date.now();
  const id = els.promptId.value;
  const title = els.titleInput.value.trim();

  if (!id && prompts.some((prompt) => normalizeTitle(prompt.title) === normalizeTitle(title))) {
    els.titleInput.setCustomValidity("同じタイトルのプロンプトがすでに追加されています。");
    els.titleInput.reportValidity();
    els.titleInput.focus();
    return;
  }

  const data = {
    id: id || crypto.randomUUID(),
    title,
    description: els.descriptionInput.value.trim(),
    content: els.contentInput.value.trim(),
    tags: [...new Set(els.tagsInput.value.split(/[,、]/).map((tag) => tag.trim()).filter(Boolean))],
    favorite: els.favoriteInput.checked,
    updatedAt: now
  };

  if (id) {
    prompts = prompts.map((prompt) => prompt.id === id ? data : prompt);
  } else {
    prompts.push(data);
  }
  await savePrompts();
  closeEditor();
  showToast("保存しました");
});

els.deleteButton.addEventListener("click", async () => {
  const id = els.promptId.value;
  if (!id) return;
  const prompt = prompts.find((item) => item.id === id);
  const approved = await askForConfirmation("delete", {
    title: "プロンプトを削除",
    message: `「${prompt?.title || "このプロンプト"}」を削除します。この操作は元に戻せません。`,
    skipLabel: "今後は削除時の確認を省略する",
    confirmLabel: "削除する",
    danger: true
  });
  if (!approved) return;
  prompts = prompts.filter((prompt) => prompt.id !== id);
  await savePrompts();
  closeEditor();
  showToast("削除しました");
});
