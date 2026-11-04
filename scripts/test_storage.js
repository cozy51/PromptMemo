// The localStorage layer the web app saves through: values round-trip as JSON,
// every change is announced to listeners (the app redraws from them), and a
// save made in another tab is announced the same way.
const vm = require("vm");
const { installStorage } = require("./fake_popup.js");

function check(actual, expected, label) {
  const a = JSON.stringify(actual);
  const e = JSON.stringify(expected);
  if (a !== e) throw new Error(`${label}: expected ${e}, received ${a}`);
}

(async function main() {
  const store = { broken: "x" };
  const windowListeners = {};
  const context = {
    JSON, Object, Array, Set, Promise, console,
    addEventListener: (type, handler) => { windowListeners[type] = handler; }
  };
  context.window = context;
  vm.createContext(context);
  installStorage(context, store);
  // A value that is not JSON (written by something else) reads as absent.
  context.localStorage.getItem = ((getItem) => (key) => key === "broken" ? "{not json" : getItem(key))(
    context.localStorage.getItem
  );
  const storage = context.promptMemoStorage;
  const changes = [];
  storage.onChanged.addListener((change, area) => changes.push({ change, area }));

  check(typeof context.PROMPT_MEMO_VERSION, "undefined", "The version is a script constant, not a window property");
  check(vm.runInContext("PROMPT_MEMO_VERSION", context), require("../package.json").version,
    "The version shown in the app matches package.json");

  await storage.set({ items: [{ id: "a" }], at: "2026-11-04" });
  check(store.items, [{ id: "a" }], "Values are saved");
  check(await storage.get(["items", "at", "missing", "broken"]), { items: [{ id: "a" }], at: "2026-11-04" },
    "Only keys that hold readable values come back");
  check(await storage.get("at"), { at: "2026-11-04" }, "A single key can be asked for");
  check(changes.at(-1).change.items, { newValue: [{ id: "a" }] }, "A save is announced with its new value");
  check(changes.at(-1).area, "local", "…as a local change");

  await storage.remove("at");
  check("at" in store, false, "Removing deletes the value");
  check(changes.at(-1).change.at, { oldValue: "2026-11-04" }, "…and is announced");
  const before = changes.length;
  await storage.remove("never-there");
  check(changes.length, before, "Removing nothing announces nothing");

  // Another tab saved: the browser fires `storage` on this window.
  windowListeners.storage({
    storageArea: context.localStorage,
    key: "items",
    oldValue: JSON.stringify([{ id: "a" }]),
    newValue: JSON.stringify([{ id: "a" }, { id: "b" }])
  });
  check(changes.at(-1).change.items.newValue.length, 2, "A save in another tab reaches this one");

  console.log("storage: すべてのテストに合格しました");
})().catch((error) => {
  console.error(error);
  process.exit(1);
});
