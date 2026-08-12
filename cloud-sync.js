// Supabase is the authoritative copy of the prompt library; chrome.storage.local
// is the offline copy of it.  Every upload is guarded by the revision the local
// copy is based on, so a PC that has been closed, offline, or restored from an
// old file can never quietly replace newer work made on another PC.  Whenever
// the two sides genuinely disagree the user decides, and the losing side is
// archived to the cloud history first so nothing is lost either way.
(function setupCloudSync() {
  const DATA_KEY = "promptMemoItems";
  const CONFIG_KEY = "promptMemoCloudConfig";
  const SESSION_KEY = "promptMemoCloudSession";
  const SYNC_STATE_KEY = "promptMemoSyncState";
  const DEVICE_ID_KEY = "promptMemoDeviceId";

  const DEFAULT_BUCKET = "todo-backups";
  const LATEST_FILE = "PromptMemo-latest.json";
  // Named after the app so one bucket can hold several apps' histories.
  const HISTORY_FOLDER = "PromptMemo-history";
  const HISTORY_RECENT_KEEP = 30;
  const HISTORY_DAILY_KEEP = 30;
  const HISTORY_LIST_LIMIT = 200;
  const PUSH_DEBOUNCE_MS = 900;
  const POLL_INTERVAL_MS = 60 * 1000;
  const MAX_DOCUMENT_BYTES = 10 * 1024 * 1024;

  const els = {
    status: document.querySelector("#cloudSyncStatus"),
    detail: document.querySelector("#cloudSyncDetail"),
    settingsButton: document.querySelector("#cloudSyncSettings"),
    signInButton: document.querySelector("#cloudSyncSignIn"),
    signOutButton: document.querySelector("#cloudSyncSignOut"),
    syncNowButton: document.querySelector("#cloudSyncNow"),
    historyButton: document.querySelector("#cloudSyncHistory"),
    resolveButton: document.querySelector("#cloudSyncResolve"),

    settingsDialog: document.querySelector("#cloudSettingsDialog"),
    settingsForm: document.querySelector("#cloudSettingsForm"),
    closeSettings: document.querySelector("#closeCloudSettings"),
    urlInput: document.querySelector("#cloudUrlInput"),
    keyInput: document.querySelector("#cloudKeyInput"),
    bucketInput: document.querySelector("#cloudBucketInput"),

    signInDialog: document.querySelector("#cloudSignInDialog"),
    signInForm: document.querySelector("#cloudSignInForm"),
    closeSignIn: document.querySelector("#closeCloudSignIn"),
    emailInput: document.querySelector("#cloudEmailInput"),
    passwordInput: document.querySelector("#cloudPasswordInput"),
    signInMessage: document.querySelector("#cloudSignInMessage"),
    signInSubmit: document.querySelector("#cloudSignInSubmit"),

    historyDialog: document.querySelector("#cloudHistoryDialog"),
    historyList: document.querySelector("#cloudHistoryList"),
    historyEmpty: document.querySelector("#cloudHistoryEmpty"),
    closeHistory: document.querySelector("#closeCloudHistory"),

    conflictDialog: document.querySelector("#cloudConflictDialog"),
    conflictReason: document.querySelector("#cloudConflictReason"),
    conflictRemoteSummary: document.querySelector("#cloudConflictRemoteSummary"),
    conflictLocalSummary: document.querySelector("#cloudConflictLocalSummary"),
    useRemoteButton: document.querySelector("#cloudConflictUseRemote"),
    useLocalButton: document.querySelector("#cloudConflictUseLocal"),
    conflictLaterButton: document.querySelector("#cloudConflictLater")
  };

  let config = { url: "", anonKey: "", bucket: DEFAULT_BUCKET };
  let client = null;
  let user = null;
  let deviceId = "";
  let syncState = createPromptMemoSyncState();
  let pushTimer = null;
  let pollTimer = null;
  let queue = Promise.resolve();
  let paused = false;
  let pausedMessage = "";
  let pendingConflict = null;
  let lastError = "";

  function setStatus(message, state = "idle") {
    if (!els.status) return;
    els.status.textContent = message;
    els.status.dataset.state = state;
  }

  function setDetail(message) {
    if (!els.detail) return;
    els.detail.textContent = message || "";
    els.detail.hidden = !message;
  }

  function formatTime(value) {
    const date = new Date(value);
    if (!value || Number.isNaN(date.getTime())) return "";
    const sameDay = date.toDateString() === new Date().toDateString();
    return new Intl.DateTimeFormat("ja-JP", sameDay
      ? { hour: "2-digit", minute: "2-digit" }
      : { month: "numeric", day: "numeric", hour: "2-digit", minute: "2-digit" }
    ).format(date);
  }

  // Restore points are told apart by their time, so it carries seconds: several
  // can land in the same minute during a burst of edits.
  function formatHistoryTime(date) {
    return new Intl.DateTimeFormat("ja-JP", {
      year: "numeric", month: "numeric", day: "numeric",
      hour: "2-digit", minute: "2-digit", second: "2-digit"
    }).format(date);
  }

  function describeDataset(dataset) {
    return formatPromptMemoCounts(readPromptMemoCounts(dataset));
  }

  function isConfigured() {
    return Boolean(config.url && config.anonKey);
  }

  function updateControls() {
    const configured = isConfigured();
    const signedIn = Boolean(user);
    if (els.signInButton) els.signInButton.hidden = !configured || signedIn;
    if (els.signOutButton) els.signOutButton.hidden = !signedIn;
    if (els.syncNowButton) els.syncNowButton.hidden = !signedIn;
    if (els.historyButton) els.historyButton.hidden = !signedIn;
    if (els.resolveButton) els.resolveButton.hidden = !pendingConflict;
  }

  function reportIdle() {
    if (paused) {
      setStatus(pausedMessage || "同期を保留中", "error");
      return;
    }
    if (lastError) {
      setStatus(lastError, "error");
      setDetail(syncState.lastSyncedAt ? `最終同期 ${formatTime(syncState.lastSyncedAt)}` : "ローカルに保存済み");
      return;
    }
    setStatus("クラウドと同期済み", "saved");
    setDetail(syncState.lastSyncedAt ? `最終同期 ${formatTime(syncState.lastSyncedAt)}` : "");
  }

  // Every cloud operation runs one at a time: two overlapping syncs could each
  // read the same revision and then both write it.
  function run(task) {
    const next = queue.then(task).catch((error) => {
      console.warn("Prompt Memo cloud sync failed:", error);
      lastError = /^(同期|クラウド|ログイン)/.test(error?.message || "")
        ? error.message
        : "クラウドに接続できません（ローカルに保存済み）";
      reportIdle();
    });
    queue = next;
    return next;
  }

  async function loadConfig() {
    const result = await chrome.storage.local.get([CONFIG_KEY, SYNC_STATE_KEY, DEVICE_ID_KEY]);
    const stored = result[CONFIG_KEY] || {};
    config = {
      url: String(stored.url || "").trim().replace(/\/+$/, ""),
      anonKey: String(stored.anonKey || "").trim(),
      bucket: String(stored.bucket || "").trim() || DEFAULT_BUCKET
    };
    syncState = sanitizePromptMemoSyncState(result[SYNC_STATE_KEY]);
    deviceId = String(result[DEVICE_ID_KEY] || "");
    if (!deviceId) {
      deviceId = crypto.randomUUID();
      await chrome.storage.local.set({ [DEVICE_ID_KEY]: deviceId });
    }
  }

  async function saveSyncState(state) {
    syncState = { ...createPromptMemoSyncState(), ...state };
    await chrome.storage.local.set({ [SYNC_STATE_KEY]: syncState });
    return syncState;
  }

  function currentState() {
    return sanitizePromptMemoSyncState(syncState, user?.id || "");
  }

  async function loadLocalDataset() {
    const result = await chrome.storage.local.get(DATA_KEY);
    return normalizePromptMemoDataset({ prompts: result[DATA_KEY] });
  }

  async function saveLocalDataset(dataset) {
    // Written straight to storage: the popup redraws from the storage change
    // event, and `notifyLocalChange` is deliberately not called, because a copy
    // that came *from* the cloud must not be pushed back to it.
    await chrome.storage.local.set({ [DATA_KEY]: dataset.prompts });
  }

  function objectPath(...parts) {
    return [user.id, ...parts].join("/");
  }

  function readDocument(text) {
    if (text.length > MAX_DOCUMENT_BYTES) {
      throw new Error("クラウドのデータが大きすぎます");
    }
    const parsed = validatePromptMemoBackup(JSON.parse(text));
    const sync = parsed.sync && typeof parsed.sync === "object" ? parsed.sync : null;
    const revision = Number.isFinite(sync?.revision) && sync.revision > 0
      ? Math.floor(sync.revision)
      : 0;
    const dataset = normalizePromptMemoDataset(parsed);
    return {
      raw: text,
      dataset,
      revision,
      legacy: !sync || revision === 0,
      updatedAt: String(sync?.updatedAt || parsed.exportedAt || ""),
      deviceName: String(sync?.deviceName || ""),
      fingerprint: createPromptMemoFingerprint(dataset)
    };
  }

  async function readLatest() {
    const text = await client.download(config.bucket, objectPath(LATEST_FILE));
    if (!text) return null;
    try {
      return readDocument(text);
    } catch (error) {
      throw new Error(`クラウドのデータを読み取れませんでした：${error.message}`);
    }
  }

  function createDocument(dataset, revision, previousRevision) {
    const now = new Date();
    const counts = readPromptMemoCounts(dataset);
    return {
      format: PROMPT_MEMO_BACKUP_FORMAT,
      kind: PROMPT_MEMO_BACKUP_KIND,
      version: 1,
      schemaVersion: PROMPT_MEMO_SCHEMA_VERSION,
      extensionVersion: chrome.runtime.getManifest().version,
      exportedAt: now.toISOString(),
      sync: {
        revision,
        previousRevision: previousRevision ?? null,
        updatedAt: now.toISOString(),
        deviceId,
        deviceName: describePromptMemoDevice(navigator.userAgent)
      },
      counts,
      prompts: dataset.prompts
    };
  }

  // Keep the copy that is about to be replaced.  Every overwrite is archived:
  // a restore point is only useful if it sits just before the mistake, and
  // pruneHistory keeps the count bounded.
  async function archiveText(text, revision, label, required = false) {
    try {
      let counts = null;
      try {
        counts = readPromptMemoCounts(JSON.parse(text));
      } catch (_error) {
        // An unreadable archive still deserves to be kept, just without counts.
      }
      await client.upload(
        config.bucket,
        objectPath(HISTORY_FOLDER, createPromptMemoHistoryName(revision, label, counts)),
        text
      );
      await pruneHistory();
    } catch (error) {
      // Losing a routine history copy must not block the sync itself, but an
      // archive taken to protect data that is about to be replaced must.
      console.warn("Prompt Memo cloud history write failed:", error);
      if (required) throw error;
    }
  }

  async function listHistory() {
    const entries = await client.list(config.bucket, objectPath(HISTORY_FOLDER), {
      limit: HISTORY_LIST_LIMIT
    });
    return entries
      .filter((entry) => entry?.name?.endsWith(".json"))
      .map((entry) => ({
        name: entry.name,
        path: objectPath(HISTORY_FOLDER, entry.name),
        ...parsePromptMemoHistoryName(entry.name)
      }))
      // Sort here rather than trusting the listing order, so an entry whose name
      // cannot be parsed still lands somewhere sensible.  Names carry whole
      // seconds, so a burst of edits produces ties: the revision breaks them,
      // and the name itself settles the rest, which keeps the newest restore
      // point at the top however the listing arrived.
      .sort((a, b) =>
        (b.date?.getTime() || 0) - (a.date?.getTime() || 0)
        || (b.revision || 0) - (a.revision || 0)
        || b.name.localeCompare(a.name));
  }

  async function pruneHistory() {
    const entries = await listHistory().catch(() => []);
    const expired = selectExpiredPromptMemoHistory(entries, {
      recentKeep: HISTORY_RECENT_KEEP,
      dailyKeep: HISTORY_DAILY_KEEP
    });
    if (expired.length === 0) return;
    await client.remove(config.bucket, expired.map((entry) => entry.path));
  }

  async function applyRemote(remote) {
    await saveLocalDataset(remote.dataset);
    // Re-read so the recorded fingerprint describes what is actually stored,
    // including any normalisation the load path applies.
    const stored = await loadLocalDataset();
    const fingerprint = createPromptMemoFingerprint(stored);
    await saveSyncState({
      userId: user.id,
      revision: remote.revision,
      fingerprint,
      remoteUpdatedAt: remote.updatedAt,
      lastSyncedAt: new Date().toISOString()
    });
    return { stored, fingerprint };
  }

  async function pushLocal(local, fingerprint, remote, { force = false, label = "auto" } = {}) {
    const risk = force ? null : assessPromptMemoShrink(remote?.dataset || null, local);
    if (risk) {
      pendingConflict = { kind: "shrink", risk, remote, local, fingerprint };
      openConflictDialog();
      return;
    }
    const baseRevision = Math.max(remote?.revision || 0, currentState().revision);
    const payload = createDocument(local, baseRevision + 1, remote?.revision ?? null);
    if (remote) {
      await archiveText(remote.raw, remote.revision, label, force);
    }
    await client.upload(config.bucket, objectPath(LATEST_FILE), JSON.stringify(payload, null, 2));
    await saveSyncState({
      userId: user.id,
      revision: payload.sync.revision,
      fingerprint,
      remoteUpdatedAt: payload.sync.updatedAt,
      lastSyncedAt: payload.sync.updatedAt
    });
  }

  async function synchronize() {
    if (!client || !user || paused || pendingConflict) return;
    setStatus("クラウドと同期中…", "saving");
    const remote = await readLatest();
    const local = await loadLocalDataset();
    const state = currentState();
    const localFingerprint = createPromptMemoFingerprint(local);
    const action = decidePromptMemoSyncAction({
      remoteExists: Boolean(remote),
      remoteLegacy: remote?.legacy,
      remoteRevision: remote?.revision,
      remoteFingerprint: remote?.fingerprint,
      baseRevision: state.revision,
      baseFingerprint: state.fingerprint,
      localFingerprint,
      localEmpty: isPromptMemoDatasetEmpty(local)
    });

    lastError = "";
    if (action === "conflict") {
      pendingConflict = { kind: "diverged", remote, local, fingerprint: localFingerprint };
      openConflictDialog();
      return;
    }
    if (action === "pull") {
      const applied = await applyRemote(remote);
      if (applied.fingerprint !== remote.fingerprint) {
        // Storing the cloud copy changed it — an older schema, a duplicate id.
        // Publish the cleaned version straight away, otherwise the two sides
        // would disagree forever and every poll would pull again.
        await pushLocal(applied.stored, applied.fingerprint, remote, { label: "normalized" });
      }
    } else if (action === "push") {
      await pushLocal(local, localFingerprint, remote);
    } else if (action === "adopt") {
      await saveSyncState({
        userId: user.id,
        revision: remote.revision,
        fingerprint: localFingerprint,
        remoteUpdatedAt: remote.updatedAt,
        lastSyncedAt: new Date().toISOString()
      });
    } else if (action === "idle" && !remote && isPromptMemoDatasetEmpty(local)) {
      setStatus("クラウドにデータがありません", "idle");
      setDetail("このPCで追加すると保存されます");
      return;
    }
    if (pendingConflict) return;
    reportIdle();
  }

  function openConflictDialog() {
    const { kind, remote, local, risk } = pendingConflict;
    if (els.conflictReason) {
      els.conflictReason.textContent = kind === "shrink"
        ? `このPCの内容はクラウドより${risk.removed}件少なくなっています。`
          + "誤操作やブラウザーデータの削除でないか確認してください。"
        : "他のPCの変更と、このPCの未同期の変更が食い違っています。"
          + "どちらを残すか選んでください。選ばなかった方はクラウド履歴に退避します。";
    }
    if (els.conflictRemoteSummary) {
      els.conflictRemoteSummary.textContent = remote
        ? `${describeDataset(remote.dataset)}／更新 ${formatTime(remote.updatedAt) || "不明"}`
          + `${remote.deviceName ? `（${remote.deviceName}）` : ""}`
        : "クラウドにデータがありません";
    }
    if (els.conflictLocalSummary) {
      els.conflictLocalSummary.textContent = describeDataset(local);
    }
    if (els.useLocalButton) {
      els.useLocalButton.textContent = kind === "shrink"
        ? "確認した：このPCの内容で更新"
        : "このPCの内容を残す";
    }
    paused = true;
    pausedMessage = kind === "shrink"
      ? "同期を保留中（件数が大きく減っています）"
      : "同期を保留中（内容が食い違っています）";
    setStatus(pausedMessage, "error");
    setDetail("「同期の確認」から残す方を選んでください");
    updateControls();
    if (els.conflictDialog && !els.conflictDialog.open) els.conflictDialog.showModal();
  }

  async function resolveWithRemote() {
    const conflict = pendingConflict;
    if (!conflict?.remote) return;
    // Archive this PC's version before dropping it, so an accidental choice here
    // is still recoverable from the cloud history.
    if (!isPromptMemoDatasetEmpty(conflict.local)) {
      const localPayload = createDocument(conflict.local, currentState().revision, null);
      await archiveText(
        JSON.stringify(localPayload, null, 2),
        localPayload.sync.revision,
        "local-conflict",
        true
      );
    }
    await applyRemote(conflict.remote);
    pendingConflict = null;
    paused = false;
    pausedMessage = "";
    updateControls();
    reportIdle();
  }

  async function resolveWithLocal() {
    const conflict = pendingConflict;
    if (!conflict) return;
    pendingConflict = null;
    paused = false;
    pausedMessage = "";
    updateControls();
    await pushLocal(conflict.local, conflict.fingerprint, conflict.remote, {
      force: true,
      label: "remote-replaced"
    });
    reportIdle();
  }

  const HISTORY_LABELS = {
    auto: "上書き前の内容",
    normalized: "整理前の内容",
    "local-conflict": "このPCの未同期分",
    "remote-replaced": "上書き前のクラウド"
  };

  // Entries written before the counts were part of the name have to be read to
  // be counted.  That is done after the list is on screen, a few at a time, so
  // opening the dialog stays instant and a slow file never blocks the rest.
  const COUNT_FETCH_CONCURRENCY = 4;
  let historyRequestId = 0;

  async function fillMissingCounts(entries, requestId) {
    const pending = entries.filter((entry) => !entry.counts);
    await Promise.all(Array.from(
      { length: Math.min(COUNT_FETCH_CONCURRENCY, pending.length) },
      async () => {
        while (pending.length > 0 && requestId === historyRequestId) {
          const entry = pending.shift();
          try {
            const text = await client.download(config.bucket, entry.path);
            entry.counts = text ? readPromptMemoCounts(JSON.parse(text)) : null;
          } catch (_error) {
            entry.counts = null;
          }
          if (requestId !== historyRequestId) return;
          entry.countsElement.textContent = entry.counts
            ? formatPromptMemoCounts(entry.counts)
            : "件数を読み取れませんでした";
        }
      }
    ));
  }

  async function openHistoryDialog() {
    if (!els.historyDialog) return;
    const requestId = (historyRequestId += 1);
    els.historyList.replaceChildren();
    els.historyEmpty.textContent = "読み込み中…";
    els.historyEmpty.hidden = false;
    els.historyDialog.showModal();

    let entries = [];
    try {
      entries = await listHistory();
    } catch (_error) {
      els.historyEmpty.textContent = "履歴を読み込めませんでした";
      return;
    }
    if (requestId !== historyRequestId) return;
    if (entries.length === 0) {
      els.historyEmpty.textContent = "まだ履歴はありません（クラウドが上書きされたときに増えます）";
      return;
    }
    els.historyEmpty.hidden = true;

    // The current cloud version anchors the list: it is the row every restore
    // point below is being compared against.
    const state = currentState();
    els.historyList.append(createHistoryRow({
      heading: "現在のクラウド",
      counts: formatPromptMemoCounts(readPromptMemoCounts(await loadLocalDataset())),
      note: state.remoteUpdatedAt ? `更新 ${formatTime(state.remoteUpdatedAt)}` : "同期の記録がありません",
      current: true
    }));

    entries.forEach((entry) => {
      const row = createHistoryRow({
        heading: entry.date ? formatHistoryTime(entry.date) : entry.name,
        counts: entry.counts ? formatPromptMemoCounts(entry.counts) : "件数を確認中…",
        note: HISTORY_LABELS[entry.label] || entry.label,
        onRestore: (button) => restoreFromHistory(entry, button)
      });
      entry.countsElement = row.querySelector(".cloud-history-counts");
      els.historyList.append(row);
    });

    await fillMissingCounts(entries, requestId);
  }

  function createHistoryRow({ heading, counts, note, current = false, onRestore = null }) {
    const item = document.createElement("li");
    item.className = `cloud-history-item${current ? " cloud-history-current" : ""}`;

    const info = document.createElement("div");
    const title = document.createElement("strong");
    title.textContent = heading;
    const countsText = document.createElement("span");
    countsText.className = "cloud-history-counts";
    countsText.textContent = counts;
    const noteText = document.createElement("span");
    noteText.textContent = note;
    info.append(title, countsText, noteText);
    item.append(info);

    if (onRestore) {
      const button = document.createElement("button");
      button.type = "button";
      button.className = "button secondary compact";
      button.textContent = "この時点に戻す";
      button.addEventListener("click", () => onRestore(button));
      item.append(button);
    }
    return item;
  }

  async function restoreFromHistory(entry, button) {
    const when = entry.date ? formatHistoryTime(entry.date) : entry.name;
    const state = currentState();
    const behindBy = entry.date && state.remoteUpdatedAt
      ? Date.parse(state.remoteUpdatedAt) - entry.date.getTime()
      : 0;
    const approved = await window.promptMemoUI.confirm({
      title: "この時点に戻す",
      message: `${when} の内容に戻します。`
        + (entry.counts ? `\n${formatPromptMemoCounts(entry.counts)}` : "")
        + (behindBy > 0
          ? `\n現在のクラウドより${formatPromptMemoElapsed(behindBy)}古い内容です。`
            + "その間の変更は、戻したあとは表示されなくなります。"
          : "")
        + "\n現在のクラウドの内容は履歴へ退避してから置き換えます。続けますか？",
      confirmLabel: "この時点に戻す"
    });
    if (!approved) return;

    button.disabled = true;
    await run(async () => {
      const text = await client.download(config.bucket, entry.path);
      if (!text) throw new Error("クラウドの履歴を読み取れませんでした");
      const snapshot = readDocument(text);
      const remote = await readLatest();
      if (remote) {
        await archiveText(remote.raw, remote.revision, "remote-replaced", true);
      }
      // Restoring is a deliberate rollback, so it is published as a *new*
      // revision rather than by rewinding the counter — other PCs then pull it
      // forward instead of seeing the cloud jump backwards.
      const revision = Math.max(remote?.revision || 0, currentState().revision) + 1;
      const payload = createDocument(snapshot.dataset, revision, remote?.revision ?? null);
      await client.upload(config.bucket, objectPath(LATEST_FILE), JSON.stringify(payload, null, 2));
      await applyRemote({ ...snapshot, revision, updatedAt: payload.sync.updatedAt });
      reportIdle();
      window.promptMemoUI.toast(`${when} の内容に戻しました`);
    });
    button.disabled = false;
    els.historyDialog.close();
  }

  function notifyLocalChange() {
    if (!user) return;
    clearTimeout(pushTimer);
    if (paused) {
      setStatus(pausedMessage || "同期を保留中", "error");
      return;
    }
    setStatus("変更を同期待ち…", "saving");
    pushTimer = setTimeout(() => run(synchronize), PUSH_DEBOUNCE_MS);
  }

  function syncNow() {
    clearTimeout(pushTimer);
    lastError = "";
    run(synchronize);
  }

  function startPolling() {
    clearInterval(pollTimer);
    pollTimer = setInterval(() => {
      if (document.visibilityState === "visible") run(synchronize);
    }, POLL_INTERVAL_MS);
  }

  function stopSync() {
    clearTimeout(pushTimer);
    clearInterval(pollTimer);
  }

  function showSignedOut() {
    stopSync();
    paused = false;
    pendingConflict = null;
    updateControls();
    if (!isConfigured()) {
      setStatus("クラウド同期は未設定（ローカル保存のみ）", "idle");
      setDetail("「クラウド設定」でSupabaseの接続先を登録します");
      return;
    }
    setStatus("ログインするとクラウドと同期します", "idle");
    setDetail("ログアウト中の変更はこのPCだけに保存されます");
  }

  function createClient() {
    if (!isConfigured()) return null;
    return createPromptMemoSupabaseClient({
      url: config.url,
      anonKey: config.anonKey,
      loadSession: async () => (await chrome.storage.local.get(SESSION_KEY))[SESSION_KEY] || null,
      saveSession: async (session) => {
        if (session) {
          await chrome.storage.local.set({ [SESSION_KEY]: session });
        } else {
          await chrome.storage.local.remove(SESSION_KEY);
        }
      }
    });
  }

  async function startSignedInSession() {
    user = client.getUser();
    updateControls();
    if (!user) {
      showSignedOut();
      return;
    }
    lastError = "";
    setStatus(`${user.email || "ユーザー"} で同期中…`, "saving");
    setDetail("");
    startPolling();
    await run(synchronize);
  }

  function setSignInMessage(message, state = "info") {
    els.signInMessage.textContent = message;
    els.signInMessage.dataset.state = state;
  }

  async function signIn(event) {
    event.preventDefault();
    const email = els.emailInput.value.trim();
    const password = els.passwordInput.value;
    if (!email || !password) return;
    els.signInSubmit.disabled = true;
    setSignInMessage("ログインしています…");
    try {
      await client.signIn(email, password);
      els.passwordInput.value = "";
      setSignInMessage("");
      els.signInDialog.close();
      await startSignedInSession();
      window.promptMemoUI.toast("クラウド同期にログインしました");
    } catch (error) {
      console.warn("Prompt Memo sign-in failed:", error);
      setSignInMessage(error?.status === 400
        ? "メールアドレスかパスワードが違います"
        : "ログインできませんでした（接続先の設定も確認してください）", "error");
    } finally {
      els.signInSubmit.disabled = false;
    }
  }

  async function signOut() {
    stopSync();
    await client.signOut();
    user = null;
    // The sync bookkeeping describes one account's document, so it goes with the
    // session: the next account starts from a clean comparison.
    await saveSyncState(createPromptMemoSyncState());
    showSignedOut();
    window.promptMemoUI.toast("クラウド同期からログアウトしました");
  }

  function openSettings() {
    els.urlInput.value = config.url;
    els.keyInput.value = config.anonKey;
    els.bucketInput.value = config.bucket;
    els.settingsDialog.showModal();
  }

  async function saveSettings(event) {
    event.preventDefault();
    const next = {
      url: els.urlInput.value.trim().replace(/\/+$/, ""),
      anonKey: els.keyInput.value.trim(),
      bucket: els.bucketInput.value.trim() || DEFAULT_BUCKET
    };
    // A different project, account, or bucket means a different document, so the
    // revision this PC believes it is based on no longer describes anything.
    const changedDocument = next.url !== config.url
      || next.anonKey !== config.anonKey
      || next.bucket !== config.bucket;
    // The session, though, belongs to the project alone: renaming the bucket
    // must not make the user sign in again.
    const changedProject = next.url !== config.url || next.anonKey !== config.anonKey;
    config = next;
    await chrome.storage.local.set({ [CONFIG_KEY]: config });
    els.settingsDialog.close();

    if (changedDocument) {
      stopSync();
      await saveSyncState(createPromptMemoSyncState());
    }
    if (changedProject) {
      user = null;
      await chrome.storage.local.remove(SESSION_KEY);
    }
    client = createClient();
    window.promptMemoUI.toast("クラウド設定を保存しました");
    if (!client) {
      showSignedOut();
      return;
    }
    await client.init();
    if (client.getUser()) {
      await startSignedInSession();
    } else {
      showSignedOut();
    }
  }

  els.settingsButton?.addEventListener("click", openSettings);
  els.closeSettings?.addEventListener("click", () => els.settingsDialog.close());
  els.settingsForm?.addEventListener("submit", saveSettings);

  els.signInButton?.addEventListener("click", () => {
    setSignInMessage("");
    els.passwordInput.value = "";
    els.signInDialog.showModal();
    els.emailInput.focus();
  });
  els.closeSignIn?.addEventListener("click", () => els.signInDialog.close());
  els.signInForm?.addEventListener("submit", signIn);

  els.signOutButton?.addEventListener("click", () => signOut());
  els.syncNowButton?.addEventListener("click", syncNow);
  els.historyButton?.addEventListener("click", () => openHistoryDialog());
  els.closeHistory?.addEventListener("click", () => els.historyDialog.close());
  // Abandon any counts still being fetched once the list is off screen.
  els.historyDialog?.addEventListener("close", () => { historyRequestId += 1; });

  els.useRemoteButton?.addEventListener("click", () => {
    els.conflictDialog.close();
    run(resolveWithRemote);
  });
  els.useLocalButton?.addEventListener("click", () => {
    els.conflictDialog.close();
    run(resolveWithLocal);
  });
  els.resolveButton?.addEventListener("click", () => {
    if (pendingConflict) openConflictDialog();
  });
  els.conflictLaterButton?.addEventListener("click", () => {
    els.conflictDialog.close();
    setStatus(pausedMessage, "error");
    setDetail("「同期の確認」を押すと選び直せます");
  });
  // The dialog must not be dismissable by accident: an unresolved conflict keeps
  // sync paused, which is the safe state.
  els.conflictDialog?.addEventListener("cancel", (event) => event.preventDefault());

  window.promptMemoCloudSync = {
    notifyLocalChange,
    syncNow,
    isPaused: () => paused
  };

  (async function init() {
    setStatus("クラウド同期を確認中…", "saving");
    await loadConfig();
    client = createClient();
    if (!client) {
      showSignedOut();
      return;
    }
    await client.init();
    if (client.getUser()) {
      await startSignedInSession();
    } else {
      showSignedOut();
    }
  })();
})();
