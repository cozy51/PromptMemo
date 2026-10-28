// Tests for short phrases and the usage history: `node scripts/test_short_and_history.js`.
//
// The popup is loaded against a fake DOM built from popup.html, as in
// test_import_guard.js.  What is checked is what the user sees: which cards each
// tab shows and in what order, and what is stored when they save or use one.
const fs = require("fs");
const path = require("path");
const vm = require("vm");
const { createDocument, settle } = require("./fake_popup.js");

const root = path.join(__dirname, "..");
const html = fs.readFileSync(path.join(root, "popup.html"), "utf8");
const sources = ["sync-core.js", "popup.js"]
  .map((name) => ({ name, code: fs.readFileSync(path.join(root, name), "utf8") }));

function check(actual, expected, label) {
  const a = JSON.stringify(actual);
  const e = JSON.stringify(expected);
  if (a !== e) throw new Error(`${label}: expected ${e}, received ${a}`);
}

function prompt(id, extra = {}) {
  return {
    id, title: `題名${id}`, description: "", content: `本文${id}`,
    tags: [], favorite: false, updatedAt: 1, ...extra
  };
}

function openPopup({ prompts = [], usage = null } = {}) {
  const store = {
    promptMemoItems: prompts,
    ...(usage ? { promptMemoUsage: usage } : {})
  };
  const doc = createDocument(html);
  const clipboard = [];
  let nextId = 0;

  const context = {
    JSON, Math, Number, String, Boolean, Array, Object, Date, RegExp, Set, Map,
    Promise, Intl, Error, console,
    crypto: { randomUUID: () => `new-${nextId += 1}` },
    navigator: {
      userAgent: "Mozilla/5.0 (Windows NT 10.0) Chrome/120.0 Edg/120.0",
      clipboard: { writeText: async (text) => { clipboard.push(text); } }
    },
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

  const el = (id) => doc.querySelector(`#${id}`);
  const cards = () => el("promptList").children;
  return {
    store,
    clipboard,
    el,
    // The heading of each card, in the order shown.
    titles: () => cards().map((card) => card.children[0].children[0].children[0].textContent),
    lines: () => cards().map((card) => card.children[0].children[1].textContent),
    async show(filter) {
      el("filterBar").dispatch("click", { target: { closest: () => ({ dataset: { filter } }) } });
      await settle();
    },
    async copy(index) {
      cards()[index].children[1].children[1].dispatch("click");
      await settle();
    },
    async saveShort(text, { favorite = false } = {}) {
      el("addShortButton").dispatch("click");
      el("shortInput").value = text;
      el("shortFavoriteInput").checked = favorite;
      el("shortForm").dispatch("submit");
      await settle();
    }
  };
}

(async function main() {
  // 1. The history is what opens first, newest use on top.
  const popup = openPopup({
    prompts: [prompt("a"), prompt("b", { favorite: true }), prompt("c")],
    usage: { a: 100, c: 300 }
  });
  await settle();
  check(popup.titles(), ["題名c", "題名a"], "The history opens first, most recently used on top");
  check(popup.el("emptyState").classList.contains("hidden"), true, "…and is not empty");

  // 2. Using a prompt moves it to the top of the history.
  await popup.show("favorite");
  check(popup.titles(), ["題名b"], "The favourites tab still works");
  await popup.copy(0);
  check(popup.clipboard, ["本文b"], "Copy puts the prompt on the clipboard");
  await popup.show("history");
  check(popup.titles(), ["題名b", "題名c", "題名a"], "The prompt just used is now at the top");
  check(typeof popup.store.promptMemoUsage.b, "number", "The use is remembered");
  check(popup.store.promptMemoItems.find((item) => item.id === "b").updatedAt, 1,
    "Using a prompt does not edit it, so it never reaches the cloud as a change");

  // 3. A short phrase is registered from the text alone.
  await popup.saveShort("200字程度で\n要約してください。", { favorite: true });
  const saved = popup.store.promptMemoItems.find((item) => item.kind === "short");
  check(saved.content, "200字程度で 要約してください。", "Line breaks fold into one line");
  check(saved.title, saved.content, "The phrase is its own title");
  check(saved.favorite, true, "…and can be a favourite");
  check(popup.el("shortDialog").open, false, "The dialog closes after saving");

  await popup.show("short");
  check(popup.titles(), ["200字程度で 要約してください。"], "The short tab lists only short phrases");
  check(popup.lines(), ["短文"], "…marked as such");
  await popup.copy(0);
  check(popup.clipboard.at(-1), "200字程度で 要約してください。", "A short phrase copies its text");
  await popup.show("history");
  check(popup.titles()[0], "200字程度で 要約してください。", "…and joins the history");

  // 4. The same phrase twice is refused.
  await popup.saveShort("200字程度で 要約してください。");
  check(popup.el("shortDialog").open, true, "A duplicate keeps the dialog open");
  check(popup.el("shortInput").validationMessage, "同じ短文がすでに登録されています。", "…and says why");
  check(popup.store.promptMemoItems.filter((item) => item.kind === "short").length, 1, "…and adds nothing");

  // 5. The kind survives the normalization the cloud and imports go through,
  //    and ordinary prompts are written exactly as before.
  const vmContext = { };
  vm.createContext(vmContext);
  vm.runInContext(sources[0].code, vmContext);
  const normalized = vm.runInContext(
    `normalizePromptMemoDataset({ prompts: ${JSON.stringify(popup.store.promptMemoItems)} })`, vmContext
  ).prompts;
  check(normalized.find((item) => item.id === saved.id).kind, "short", "A short phrase stays short through sync");
  check("kind" in normalized.find((item) => item.id === "a"), false, "An ordinary prompt gains no new field");

  // 6. An empty history explains itself instead of saying nothing was found.
  const fresh = openPopup({ prompts: [prompt("a")] });
  await settle();
  check(fresh.titles(), [], "Nothing used yet, nothing in the history");
  check(fresh.el("emptyTitle").textContent, "まだ使用履歴がありません", "…and the page says so");

  console.log("short phrase and history tests passed");
})().catch((error) => {
  console.error(error);
  process.exit(1);
});
