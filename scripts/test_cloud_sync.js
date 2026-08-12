// Tests for the cloud sync rules: `node scripts/test_cloud_sync.js`.
// These cover the decisions that can lose data — which copy wins, what counts as
// an accidental wipe, and which restore points may be deleted.
const {
  normalizePromptMemoDataset,
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
  sanitizePromptMemoSyncState
} = require("../sync-core.js");

function check(actual, expected, label) {
  if (actual !== expected) {
    throw new Error(`${label}: expected ${JSON.stringify(expected)}, received ${JSON.stringify(actual)}`);
  }
}

function throws(task, label) {
  try {
    task();
  } catch (_error) {
    return;
  }
  throw new Error(`${label}: expected an error`);
}

function prompt(id, extra = {}) {
  return { id, title: `題名${id}`, content: `本文${id}`, tags: [], favorite: false, updatedAt: 1, ...extra };
}

// --- decidePromptMemoSyncAction -------------------------------------------
// The single rule that keeps an old copy from replacing newer work.

const base = {
  remoteExists: true,
  remoteLegacy: false,
  remoteRevision: 5,
  remoteFingerprint: "remote",
  baseRevision: 5,
  baseFingerprint: "base",
  localFingerprint: "base",
  localEmpty: false
};

check(
  decidePromptMemoSyncAction({ ...base, remoteExists: false, localFingerprint: "local" }),
  "push",
  "First PC seeds the cloud"
);
check(
  decidePromptMemoSyncAction({
    ...base, remoteExists: false, localEmpty: true, baseRevision: 0, baseFingerprint: ""
  }),
  "idle",
  "An empty, never-synced PC has nothing to publish"
);
check(
  decidePromptMemoSyncAction({
    ...base, localEmpty: true, localFingerprint: "empty", baseRevision: 0, baseFingerprint: ""
  }),
  "pull",
  "A new PC, or one whose extension data was cleared, adopts the cloud"
);
check(
  decidePromptMemoSyncAction({ ...base, remoteFingerprint: "base" }),
  "idle",
  "Identical content at the same revision transfers nothing"
);
check(
  decidePromptMemoSyncAction({ ...base, remoteFingerprint: "base", remoteRevision: 9 }),
  "adopt",
  "Identical content ahead in revision only re-bases the lineage"
);
check(
  decidePromptMemoSyncAction({ ...base, remoteFingerprint: "base", remoteLegacy: true }),
  "push",
  "A document written before revisions existed is republished with one"
);
check(
  decidePromptMemoSyncAction({ ...base, remoteRevision: 9 }),
  "pull",
  "A newer cloud version reaches an unchanged PC"
);
check(
  decidePromptMemoSyncAction({ ...base, remoteRevision: 9, localFingerprint: "local" }),
  "conflict",
  "A newer cloud version plus local edits is never resolved automatically"
);
check(
  decidePromptMemoSyncAction({ ...base, localFingerprint: "local" }),
  "push",
  "Local edits on top of the known revision are published"
);
check(
  decidePromptMemoSyncAction({ ...base, remoteRevision: 2 }),
  "conflict",
  "A cloud that moved backwards is never silently accepted or overwritten"
);
check(
  decidePromptMemoSyncAction({ ...base, remoteLegacy: true, localFingerprint: "local" }),
  "conflict",
  "An undated cloud document plus local edits asks the user"
);

// --- assessPromptMemoShrink ------------------------------------------------

check(assessPromptMemoShrink({ prompts: [] }, { prompts: [] }), null, "Nothing to protect");
check(
  assessPromptMemoShrink({ prompts: [prompt("a")] }, { prompts: [] })?.reason,
  "empty",
  "Emptying a non-empty cloud copy is always flagged"
);
check(
  assessPromptMemoShrink(
    { prompts: [1, 2, 3, 4, 5, 6].map((id) => prompt(String(id))) },
    { prompts: [prompt("1"), prompt("2")] }
  )?.removed,
  4,
  "Losing more than half of at least five records is flagged"
);
check(
  assessPromptMemoShrink(
    { prompts: [1, 2, 3, 4, 5, 6].map((id) => prompt(String(id))) },
    { prompts: [1, 2, 3, 4].map((id) => prompt(String(id))) }
  ),
  null,
  "An ordinary deletion is not a wipe"
);
check(
  assessPromptMemoShrink({ prompts: [prompt("a"), prompt("b")] }, { prompts: [prompt("a")] }),
  null,
  "A tiny library can shrink freely: half of it is one prompt"
);

// --- normalizePromptMemoDataset / fingerprints -----------------------------

const ordered = normalizePromptMemoDataset({ prompts: [prompt("b"), prompt("a")] });
const reversed = normalizePromptMemoDataset({ prompts: [prompt("a"), prompt("b")] });
check(
  createPromptMemoFingerprint(ordered),
  createPromptMemoFingerprint(reversed),
  "The same prompts added in a different order are the same library"
);
check(ordered.prompts[0].id, "a", "Records are ordered by id");
check(
  normalizePromptMemoDataset({ prompts: [prompt("a"), prompt("a")] }).prompts.length,
  1,
  "A duplicated id is kept once"
);
check(
  normalizePromptMemoDataset({ prompts: [{ title: "", content: "  " }] }).prompts.length,
  0,
  "A record with neither title nor body is dropped"
);

const legacyOnce = normalizePromptMemoDataset({ prompts: [{ title: "旧", content: "本文" }] });
const legacyTwice = normalizePromptMemoDataset({ prompts: [{ title: "旧", content: "本文" }] });
check(
  legacyOnce.prompts[0].id,
  legacyTwice.prompts[0].id,
  "A record saved without an id gets the same id on every load"
);
check(
  createPromptMemoFingerprint(normalizePromptMemoDataset({ prompts: [prompt("a")] }))
    === createPromptMemoFingerprint(normalizePromptMemoDataset({ prompts: [prompt("a", { favorite: true })] })),
  false,
  "A changed field changes the fingerprint"
);
check(
  normalizePromptMemoDataset({ prompts: [prompt("a", { tags: [" 仕事 ", "仕事", ""] })] }).prompts[0].tags.length,
  1,
  "Tags are trimmed and de-duplicated"
);
check(countPromptMemoRecords({ prompts: [prompt("a")] }), 1, "Record count");
check(isPromptMemoDatasetEmpty({ prompts: [] }), true, "Empty dataset");

// --- counts ----------------------------------------------------------------

const counted = readPromptMemoCounts({
  prompts: [
    prompt("a", { favorite: true, tags: ["仕事"] }),
    prompt("b", { tags: ["仕事", "文章"] })
  ]
});
check(counted.prompts, 2, "Counted prompts");
check(counted.favorites, 1, "Counted favorites");
check(counted.tags, 2, "Tags are counted once each");
check(
  formatPromptMemoCounts(counted),
  "プロンプト2件（お気に入り1）・タグ2件",
  "Counts read as a sentence"
);
check(
  readPromptMemoCounts({ counts: { prompts: 9, favorites: 4, tags: 2 }, prompts: [] }).prompts,
  9,
  "A stored counts block is trusted over an absent list"
);

// --- validatePromptMemoBackup ----------------------------------------------

validatePromptMemoBackup({ format: "prompt-memo", prompts: [prompt("a")] });
throws(() => validatePromptMemoBackup(null), "Rejects a non-object");
throws(() => validatePromptMemoBackup({ format: "other", prompts: [] }), "Rejects another app's file");
throws(() => validatePromptMemoBackup({ format: "prompt-memo" }), "Rejects a file without prompts");
throws(
  () => validatePromptMemoBackup({ format: "prompt-memo", prompts: [prompt("a"), prompt("a")] }),
  "Rejects duplicated ids"
);
throws(
  () => validatePromptMemoBackup({ format: "prompt-memo", prompts: [{ id: "a", title: " ", content: "" }] }),
  "Rejects an empty record"
);

// --- history names ---------------------------------------------------------

const stamped = createPromptMemoHistoryName(
  7, "auto", { prompts: 12, favorites: 5, tags: 3 }, new Date("2026-08-12T11:52:12.345Z")
);
check(stamped, "20260812T115212Z-r000007-c12.5.3-auto.json", "History file name");
const parsed = parsePromptMemoHistoryName(stamped);
check(parsed.revision, 7, "Parsed revision");
check(parsed.label, "auto", "Parsed label");
check(parsed.counts.prompts, 12, "Parsed counts");
check(parsed.date.toISOString(), "2026-08-12T11:52:12.000Z", "Parsed timestamp");
check(
  parsePromptMemoHistoryName(
    createPromptMemoHistoryName(3, "auto", null, new Date("2026-08-12T11:52:12Z"))
  ).counts,
  null,
  "A name without counts parses without them"
);
check(parsePromptMemoHistoryName("something-else.json").date, null, "An unknown name is not dated");

// --- history retention -----------------------------------------------------

function entry(iso) {
  return { path: iso, date: new Date(iso) };
}

const recent = Array.from({ length: 30 }, (_, index) =>
  entry(`2026-08-12T${String(23 - index).padStart(2, "0")}:00:00Z`));
check(
  selectExpiredPromptMemoHistory(recent).length,
  0,
  "The 30 most recent restore points are always kept"
);

const sameDayOverflow = [
  ...recent,
  entry("2026-08-11T10:00:00Z"),
  entry("2026-08-11T09:00:00Z"),
  entry("2026-08-10T09:00:00Z")
];
const expired = selectExpiredPromptMemoHistory(sameDayOverflow);
check(expired.length, 1, "Beyond the recent window only one entry per day survives");
check(expired[0].path, "2026-08-11T09:00:00Z", "The later entry of that day is the one kept");

const older = [
  ...recent,
  ...Array.from({ length: 40 }, (_, index) => entry(`2026-0${index < 9 ? 7 : 6}-${
    String(28 - (index % 28)).padStart(2, "0")}T09:00:00Z`))
];
check(
  selectExpiredPromptMemoHistory(older, { recentKeep: 30, dailyKeep: 5 }).length > 0,
  true,
  "Days beyond the daily allowance are released"
);
check(
  selectExpiredPromptMemoHistory([...recent, { path: "broken", date: null }]).length,
  0,
  "A restore point with an unreadable date is never deleted"
);

// --- odds and ends ---------------------------------------------------------

check(formatPromptMemoElapsed(30 * 1000), "1分未満", "Sub-minute gap");
check(formatPromptMemoElapsed(45 * 60 * 1000), "45分", "Minutes");
check(formatPromptMemoElapsed(2 * 60 * 60 * 1000 + 59 * 60 * 1000), "約3時間", "Hours are rounded");
check(formatPromptMemoElapsed(3 * 24 * 60 * 60 * 1000), "約3日", "Days");
check(
  describePromptMemoDevice("Mozilla/5.0 (Windows NT 10.0) Chrome/120.0 Edg/120.0"),
  "Windows / Edge",
  "Device description"
);
check(
  sanitizePromptMemoSyncState({ userId: "a", revision: 4, fingerprint: "f" }, "b").revision,
  0,
  "Another account's lineage says nothing about this one"
);
check(
  sanitizePromptMemoSyncState({ userId: "a", revision: 4, fingerprint: "f" }, "a").revision,
  4,
  "The same account keeps its lineage"
);
check(sanitizePromptMemoSyncState(null).revision, 0, "Missing state starts from zero");
check(
  sanitizePromptMemoSyncState({ revision: -3 }).revision,
  0,
  "A nonsensical revision is discarded"
);

console.log("cloud sync: すべてのテストに合格しました");
