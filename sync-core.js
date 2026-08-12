// Pure helpers shared by the popup and the cloud sync engine.  Nothing here
// touches the network, chrome.storage, or the DOM, so the rules that decide
// which copy of the data wins can be tested on their own
// (`node scripts/test_cloud_sync.js`).

const PROMPT_MEMO_BACKUP_FORMAT = "prompt-memo";
const PROMPT_MEMO_BACKUP_KIND = "full-backup";
// The schema the cloud document is written with; version 1 is the plain export
// file that earlier releases produced and that is still readable.
const PROMPT_MEMO_SCHEMA_VERSION = 2;
const PROMPT_MEMO_MAX_PROMPTS = 5000;
// Fingerprints are order sensitive, so the collection order is fixed here.
const PROMPT_MEMO_DATASET_COLLECTIONS = ["prompts"];

function createPromptMemoItemFingerprint(item) {
  const source = JSON.stringify(item);
  let hash = 2166136261;
  for (let index = 0; index < source.length; index += 1) {
    hash ^= source.charCodeAt(index);
    hash = Math.imul(hash, 16777619);
  }
  return (hash >>> 0).toString(36);
}

function normalizePromptMemoTags(values) {
  if (!Array.isArray(values)) return [];
  return [...new Set(
    values.map((tag) => String(tag ?? "").trim()).filter(Boolean)
  )];
}

function normalizePromptMemoRecord(prompt) {
  const normalized = {
    id: String(prompt?.id ?? "").trim(),
    title: String(prompt?.title ?? "").trim(),
    description: String(prompt?.description ?? "").trim(),
    content: String(prompt?.content ?? ""),
    tags: normalizePromptMemoTags(prompt?.tags),
    favorite: Boolean(prompt?.favorite),
    updatedAt: Number.isFinite(Number(prompt?.updatedAt)) ? Number(prompt.updatedAt) : 0
  };
  // A record saved by a very old build may have no id.  Deriving one from the
  // content keeps it stable across devices: a random id would make the same
  // prompt look like a different record on every load and never stop syncing.
  if (!normalized.id) {
    normalized.id = `legacy-${createPromptMemoItemFingerprint({
      title: normalized.title,
      content: normalized.content
    })}`;
  }
  return normalized;
}

// Normalize any payload — local storage, a cloud document, an imported file —
// the same way, so two copies of the same library compare equal.  The order is
// fixed by id because the popup sorts for display anyway: without this, two PCs
// that added the same prompts in a different order would look like a conflict.
function normalizePromptMemoDataset(source) {
  const list = Array.isArray(source)
    ? source
    : (Array.isArray(source?.prompts) ? source.prompts : []);
  const seen = new Set();
  const prompts = list
    .map(normalizePromptMemoRecord)
    // The content itself is kept verbatim — whitespace inside a prompt can be
    // deliberate — but a record that is blank either way is not a prompt.
    .filter((prompt) => prompt.title || prompt.content.trim())
    .filter((prompt) => {
      if (seen.has(prompt.id)) return false;
      seen.add(prompt.id);
      return true;
    })
    .sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
  return { prompts };
}

function countPromptMemoRecords(dataset) {
  return PROMPT_MEMO_DATASET_COLLECTIONS.reduce(
    (total, name) => total + (Array.isArray(dataset?.[name]) ? dataset[name].length : 0),
    0
  );
}

function isPromptMemoDatasetEmpty(dataset) {
  return countPromptMemoRecords(dataset) === 0;
}

// A 32-bit hash alone would make an undetected collision — a change that never
// reaches the cloud — a real if unlikely risk, so combine two independent
// hashes with the serialized length.
function createPromptMemoFingerprint(dataset) {
  const source = JSON.stringify(
    PROMPT_MEMO_DATASET_COLLECTIONS.map((name) => dataset?.[name] ?? [])
  );
  let low = 2166136261;
  let high = 40389;
  for (let index = 0; index < source.length; index += 1) {
    const code = source.charCodeAt(index);
    low = Math.imul(low ^ code, 16777619);
    high = Math.imul(high ^ (code + index), 2246822519);
  }
  return `${source.length.toString(36)}.${(low >>> 0).toString(36)}.${(high >>> 0).toString(36)}`;
}

// The record counts of a document, however it was written: documents written by
// the cloud sync carry a `counts` block, exported files only the prompts.
function readPromptMemoCounts(source) {
  const counts = source?.counts;
  const prompts = Array.isArray(source?.prompts)
    ? source.prompts
    : (Array.isArray(source) ? source : []);
  const tags = new Set();
  prompts.forEach((prompt) => {
    normalizePromptMemoTags(prompt?.tags).forEach((tag) => tags.add(tag));
  });
  return {
    prompts: Number.isFinite(counts?.prompts) ? counts.prompts : prompts.length,
    favorites: Number.isFinite(counts?.favorites)
      ? counts.favorites
      : prompts.filter((prompt) => prompt?.favorite).length,
    tags: Number.isFinite(counts?.tags) ? counts.tags : tags.size
  };
}

function formatPromptMemoCounts(counts) {
  if (!counts) return "";
  return `プロンプト${counts.prompts}件（お気に入り${counts.favorites}）・タグ${counts.tags}件`;
}

function validatePromptMemoBackup(data) {
  if (!data || typeof data !== "object" || Array.isArray(data)) {
    throw new Error("バックアップファイルではありません");
  }
  if (data.format !== PROMPT_MEMO_BACKUP_FORMAT) {
    throw new Error("対応していないバックアップ形式です");
  }
  if (!Array.isArray(data.prompts)) {
    throw new Error("プロンプトのデータがありません");
  }
  if (data.prompts.length > PROMPT_MEMO_MAX_PROMPTS) {
    throw new Error("バックアップの件数が多すぎます");
  }

  const ids = new Set();
  data.prompts.forEach((prompt) => {
    if (!prompt || typeof prompt !== "object" || Array.isArray(prompt)) {
      throw new Error("プロンプトのデータが不正です");
    }
    if (!String(prompt.title || "").trim() && !String(prompt.content || "").trim()) {
      throw new Error("タイトルも本文もないプロンプトが含まれています");
    }
    if (prompt.tags !== undefined && !Array.isArray(prompt.tags)) {
      throw new Error("プロンプトのタグ情報が不正です");
    }
    const id = String(prompt.id || "");
    if (id && ids.has(id)) {
      throw new Error("プロンプトIDが重複しています");
    }
    if (id) ids.add(id);
  });
  return data;
}

// Decide what to do with a cloud document without touching either copy, so the
// rule that prevents older data from winning stays small enough to test.
function decidePromptMemoSyncAction(input) {
  const {
    remoteExists,
    remoteLegacy = false,
    remoteRevision = 0,
    remoteFingerprint = "",
    baseRevision = 0,
    baseFingerprint = "",
    localFingerprint = "",
    localEmpty = false
  } = input;

  // A browser that has never synced and holds nothing has no opinion to defend;
  // one that *has* synced and is now empty was emptied by an action, so that
  // deletion is a real edit and has to pass the accidental-wipe guard instead of
  // being silently undone.
  const hasLineage = baseRevision > 0 || baseFingerprint !== "";
  const unsynced = localEmpty && !hasLineage;

  if (!remoteExists) return unsynced ? "idle" : "push";

  // Edits this browser made that the cloud has never seen.
  const localDirty = !unsynced && localFingerprint !== baseFingerprint;

  // Identical content needs no transfer; only the revision lineage is adjusted.
  if (remoteFingerprint === localFingerprint) {
    // Except when upgrading from a pre-revision document: give it a revision now
    // so the first later edit is an ordinary push rather than a conflict.
    if (remoteLegacy) return "push";
    return remoteRevision === baseRevision ? "idle" : "adopt";
  }

  // Documents written before revisions existed carry no ordering information,
  // so guessing which side is newer is exactly the mistake to avoid.
  if (remoteLegacy) return localDirty ? "conflict" : "pull";

  if (remoteRevision > baseRevision) return localDirty ? "conflict" : "pull";
  // The cloud moved backwards relative to this browser: never silently accept
  // it, and never silently overwrite it either.
  if (remoteRevision < baseRevision) return "conflict";
  return localDirty ? "push" : "pull";
}

// Guard against the accidental wipe: a cleared browser profile, a mis-clicked
// bulk delete, or an import of a much older file must not quietly shrink the
// authoritative copy.
function assessPromptMemoShrink(remoteDataset, localDataset) {
  const remoteCount = countPromptMemoRecords(remoteDataset);
  const localCount = countPromptMemoRecords(localDataset);
  if (remoteCount === 0) return null;
  if (localCount === 0) {
    return { reason: "empty", remoteCount, localCount, removed: remoteCount };
  }
  const removed = remoteCount - localCount;
  if (remoteCount >= 5 && removed >= Math.ceil(remoteCount / 2)) {
    return { reason: "shrink", remoteCount, localCount, removed };
  }
  return null;
}

// The timestamp leads the name so a plain descending sort is chronological,
// whatever revision each entry carries.  The record counts ride along so the
// history list can show them without downloading every file.
function createPromptMemoHistoryName(revision, label, counts, date = new Date()) {
  const stamp = date.toISOString().replace(/[-:]/g, "").replace(/\.\d+Z$/, "Z");
  const tally = counts
    ? `-c${counts.prompts}.${counts.favorites}.${counts.tags}`
    : "";
  return `${stamp}-r${String(revision).padStart(6, "0")}${tally}-${label}.json`;
}

function parsePromptMemoHistoryName(name) {
  const match = /^(\d{8})T(\d{6})Z-r(\d+)(?:-c([\d.]+))?-(.+)\.json$/.exec(name);
  if (!match) return { revision: null, date: null, label: name, counts: null };

  const [, day, time, revision, tally, label] = match;
  const iso = `${day.slice(0, 4)}-${day.slice(4, 6)}-${day.slice(6, 8)}`
    + `T${time.slice(0, 2)}:${time.slice(2, 4)}:${time.slice(4, 6)}Z`;

  const parts = tally ? tally.split(".").map(Number) : [];
  const counts = parts.length === 3 && parts.every(Number.isFinite)
    ? { prompts: parts[0], favorites: parts[1], tags: parts[2] }
    : null;
  return { revision: Number(revision), date: new Date(iso), label, counts };
}

// Cloud history retention.  Recent restore points are what undo a mis-click and
// older ones are what undo a mistake noticed days later, so keep every recent
// entry and thin everything older down to one per day.  `entries` must be newest
// first; the returned entries are the ones safe to delete.
function selectExpiredPromptMemoHistory(entries, { recentKeep = 30, dailyKeep = 30 } = {}) {
  if (!Array.isArray(entries) || entries.length <= recentKeep) return [];
  const keptDays = new Set();
  return entries.slice(recentKeep).filter((entry) => {
    const day = entry?.date instanceof Date && !Number.isNaN(entry.date.getTime())
      ? entry.date.toISOString().slice(0, 10)
      : null;
    // An entry whose timestamp cannot be read is kept: deleting a restore point
    // we do not understand is the one outcome worth avoiding here.
    if (!day) return false;
    if (keptDays.has(day)) return true;
    keptDays.add(day);
    return keptDays.size > dailyKeep;
  });
}

function formatPromptMemoElapsed(milliseconds) {
  const minutes = Math.floor(Math.max(0, milliseconds) / 60000);
  if (minutes < 1) return "1分未満";
  if (minutes < 60) return `${minutes}分`;
  // Rounded, because these read as "about": floor would call 2時間59分 "2時間",
  // understating what a restore would discard.
  const hours = Math.round(minutes / 60);
  if (hours < 24) return `約${hours}時間`;
  return `約${Math.round(minutes / 1440)}日`;
}

function describePromptMemoDevice(userAgent = "") {
  const agent = String(userAgent || "");
  const platform = /Windows/.test(agent) ? "Windows"
    : /Macintosh|Mac OS/.test(agent) ? "Mac"
    : /iPhone|iPad|iPod/.test(agent) ? "iOS"
    : /Android/.test(agent) ? "Android"
    : /Linux/.test(agent) ? "Linux"
    : "不明な端末";
  const browser = /Edg\//.test(agent) ? "Edge"
    : /OPR\//.test(agent) ? "Opera"
    : /Chrome\//.test(agent) ? "Chrome"
    : /Firefox\//.test(agent) ? "Firefox"
    : /Safari\//.test(agent) ? "Safari"
    : "ブラウザー";
  return `${platform} / ${browser}`;
}

function createPromptMemoSyncState() {
  return {
    userId: "",
    revision: 0,
    fingerprint: "",
    remoteUpdatedAt: "",
    lastSyncedAt: ""
  };
}

function sanitizePromptMemoSyncState(stored, userId = "") {
  if (!stored || typeof stored !== "object" || Array.isArray(stored)) {
    return createPromptMemoSyncState();
  }
  const state = {
    userId: String(stored.userId || ""),
    revision: Number.isFinite(stored.revision) && stored.revision > 0
      ? Math.floor(stored.revision)
      : 0,
    fingerprint: String(stored.fingerprint || ""),
    remoteUpdatedAt: String(stored.remoteUpdatedAt || ""),
    lastSyncedAt: String(stored.lastSyncedAt || "")
  };
  // Revisions belong to one account's document; another account's history says
  // nothing about how fresh this browser's copy is.
  if (userId && state.userId && state.userId !== userId) return createPromptMemoSyncState();
  return state;
}

// Node's test runner loads this file with `vm`; the browser loads it as a
// classic script, where these names are already global.
if (typeof module === "object" && module.exports) {
  module.exports = {
    PROMPT_MEMO_BACKUP_FORMAT,
    PROMPT_MEMO_BACKUP_KIND,
    PROMPT_MEMO_SCHEMA_VERSION,
    PROMPT_MEMO_MAX_PROMPTS,
    normalizePromptMemoDataset,
    normalizePromptMemoRecord,
    normalizePromptMemoTags,
    countPromptMemoRecords,
    isPromptMemoDatasetEmpty,
    createPromptMemoFingerprint,
    readPromptMemoCounts,
    formatPromptMemoCounts,
    validatePromptMemoBackup,
    decidePromptMemoSyncAction,
    assessPromptMemoShrink,
    createPromptMemoHistoryName,
    parsePromptMemoHistoryName,
    selectExpiredPromptMemoHistory,
    formatPromptMemoElapsed,
    describePromptMemoDevice,
    createPromptMemoSyncState,
    sanitizePromptMemoSyncState
  };
}
