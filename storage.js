// The web app's own copy of the library lives in this browser's localStorage.
// It keeps the small async get/set/remove/onChanged shape the rest of the code
// was written against, so the cloud sync engine and the app only ever talk to
// `promptMemoStorage`, never to localStorage directly.
const PROMPT_MEMO_VERSION = "2.0.0";

(function setupStorage() {
  const listeners = new Set();

  function read(key) {
    const raw = localStorage.getItem(key);
    if (raw === null) return undefined;
    try {
      return JSON.parse(raw);
    } catch {
      // A value that is not JSON was not written by this app; treat it as absent
      // rather than letting one bad entry stop the whole page from opening.
      return undefined;
    }
  }

  function notify(changes) {
    if (!Object.keys(changes).length) return;
    listeners.forEach((listener) => {
      try {
        listener(changes, "local");
      } catch (error) {
        console.error("Prompt Memo storage listener failed:", error);
      }
    });
  }

  function toList(keys) {
    return Array.isArray(keys) ? keys : [keys];
  }

  window.promptMemoStorage = {
    async get(keys) {
      const result = {};
      for (const key of toList(keys)) {
        const value = read(key);
        if (value !== undefined) result[key] = value;
      }
      return result;
    },

    async set(items) {
      const changes = {};
      for (const [key, value] of Object.entries(items)) {
        const oldValue = read(key);
        // Written before anyone is told, so a listener that reads back sees it.
        localStorage.setItem(key, JSON.stringify(value));
        changes[key] = { oldValue, newValue: JSON.parse(JSON.stringify(value)) };
      }
      notify(changes);
    },

    async remove(keys) {
      const changes = {};
      for (const key of toList(keys)) {
        const oldValue = read(key);
        localStorage.removeItem(key);
        if (oldValue !== undefined) changes[key] = { oldValue, newValue: undefined };
      }
      notify(changes);
    },

    onChanged: {
      addListener(listener) { listeners.add(listener); }
    }
  };

  // Another tab of the app saved something: pass it on exactly like a change
  // made here, so every open tab shows the same library.
  window.addEventListener("storage", (event) => {
    if (event.storageArea !== localStorage || !event.key) return;
    const parse = (raw) => {
      if (raw === null) return undefined;
      try { return JSON.parse(raw); } catch { return undefined; }
    };
    notify({ [event.key]: { oldValue: parse(event.oldValue), newValue: parse(event.newValue) } });
  });
})();
