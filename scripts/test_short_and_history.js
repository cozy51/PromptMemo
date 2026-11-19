// Tests for short phrases and the usage history: `node scripts/test_short_and_history.js`.
//
// The popup is loaded against a fake DOM built from index.html, as in
// test_import_guard.js.  What is checked is what the user sees: which cards each
// tab shows and in what order, and what is stored when they save or use one.
const fs = require("fs");
const path = require("path");
const vm = require("vm");
const { createDocument, installStorage, settle } = require("./fake_popup.js");

const root = path.join(__dirname, "..");
const html = fs.readFileSync(path.join(root, "index.html"), "utf8");
const sources = ["sync-core.js", "app.js"]
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

function openPopup({ prompts = [], usage = null, saved = {} } = {}) {
  const store = {
    promptMemoItems: prompts,
    ...(usage ? { promptMemoUsage: usage } : {}),
    ...saved
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
    clearTimeout
  };
  context.window = context;
  context.globalThis = context;
  vm.createContext(context);
  installStorage(context, store);
  sources.forEach(({ name, code }) => vm.runInContext(code, context, { filename: name }));

  const el = (id) => doc.querySelector(`#${id}`);
  const cards = () => el("promptList").children;
  return {
    store,
    clipboard,
    el,
    // The heading of each card, in the order shown.
    titles: () => cards().map((card) => card.children[0].children[0].children[0].textContent),
    // The line under the heading, as the page shows it (its parts are spans).
    lines: () => cards().map((card) => card.children[0].children[1].children
      .map((span) => span.textContent).join(" ・ ")),
    // The prompt text shown in the wide layout, if the card has one.
    texts: () => cards().map((card) => card.children[0].querySelector(".card-prompt")?.textContent ?? null),
    async show(filter) {
      el("filterBar").dispatch("click", { target: { closest: () => ({ dataset: { filter } }) } });
      await settle();
    },
    async copy(index) {
      cards()[index].children[1].children[0].dispatch("click");
      await settle();
    },
    // The heading of each tag group in the tag view.
    groups: () => cards().map((group) => group.children[0].children[0].children[1].textContent),
    chips: () => el("tagFilterBar").children.map((chip) => chip.textContent),
    async pickTag(tag) {
      el("tagFilterBar").dispatch("click", { target: { closest: () => ({ dataset: { tag } }) } });
      await settle();
    },
    async saveShort(text, { favorite = false, tags = "", memo = "" } = {}) {
      el("addShortButton").dispatch("click");
      el("shortInput").value = text;
      el("shortMemoInput").value = memo;
      el("shortTagsInput").value = tags;
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
  // A web page cannot type into another tab, so copying is the only action.
  check(popup.el("promptList").children[0].children[1].children.map((button) => button.textContent), ["コピー"],
    "Each card offers copy alone");
  check(popup.el("emptyState").classList.contains("hidden"), true, "…and is not empty");

  // 2. Using a prompt moves it to the top of the history.
  await popup.show("favorite");
  check(popup.titles(), ["題名b"], "The favourites tab still works");
  check(popup.texts(), ["本文b"], "A prompt card carries its text for the wide layout");
  check(popup.lines(), ["本文b"], "…and, with no description, falls back to it on the line below the title");
  await popup.copy(0);
  check(popup.clipboard, ["本文b"], "Copy puts the prompt on the clipboard");
  await popup.show("history");
  check(popup.titles(), ["題名b", "題名c", "題名a"], "The prompt just used is now at the top");
  check(typeof popup.store.promptMemoUsage.b, "number", "The use is remembered");
  check(popup.store.promptMemoItems.find((item) => item.id === "b").updatedAt, 1,
    "Using a prompt does not edit it, so it never reaches the cloud as a change");

  // 3. A short phrase is registered from the text alone.
  await popup.saveShort("200字程度で\n要約してください。", { favorite: true, tags: "要約、 文章, 要約", memo: "議事録に使う" });
  const saved = popup.store.promptMemoItems.find((item) => item.kind === "short");
  check(saved.content, "200字程度で 要約してください。", "Line breaks fold into one line");
  check(saved.title, saved.content, "The phrase is its own title");
  check(saved.favorite, true, "…and can be a favourite");
  check(saved.description, "議事録に使う", "…and keeps its memo as the description");
  check(saved.tags, ["要約", "文章"], "…and carries tags, split on either comma, without duplicates");
  check(popup.el("shortDialog").open, false, "The dialog closes after saving");

  await popup.show("short");
  check(popup.titles(), ["200字程度で 要約してください。"], "The short tab lists only short phrases");
  check(popup.lines(), ["短文 ・ 議事録に使う"], "…marked as such, with its memo");
  check(popup.texts(), [null], "…with no second copy of the text");
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

  // 6. A description keeps its place on the line; the text is shown apart from it.
  const described = openPopup({
    prompts: [prompt("d", { description: "用途の説明", content: "1行目\n2行目" })],
    usage: { d: Date.now() }
  });
  await settle();
  check(described.lines()[0].endsWith(" ・ 用途の説明"), true, "The history shows when it was used, then the description");
  check(described.texts(), ["1行目\n2行目"], "The text keeps its line breaks");

  // 7. The tag view can show one tag at a time, and remembers the pick.
  const tagged = openPopup({
    prompts: [
      prompt("g1", { tags: ["GEM"] }),
      prompt("g2", { tags: ["GEM", "GPTs"] }),
      prompt("p1", { tags: ["GPTs"] }),
      prompt("n1")
    ]
  });
  await settle();
  check(tagged.el("tagFilterBar").classList.contains("hidden"), false, "The tag chips are shown without opening the tag view");
  await tagged.show("tags");
  check(tagged.el("tagFilterBar").classList.contains("hidden"), false, "…and in the tag view too");
  check(tagged.chips(), ["すべて", "GEM", "GPTs", "タグなし"], "One chip per tag, untagged last");
  check(tagged.groups(), ["GEM", "GPTs", "タグなし"], "Every tag is shown to begin with");
  await tagged.pickTag("gpts");
  check(tagged.groups(), ["GPTs"], "Picking a tag shows that tag alone");
  check(tagged.store.promptMemoSelectedTag, ["gpts"], "…and the pick is remembered");
  const reopened = openPopup({ prompts: tagged.store.promptMemoItems, saved: { promptMemoSelectedTag: "gpts" } });
  await reopened.show("tags");
  check(reopened.groups(), ["GPTs"], "The next visit opens on the same tag, even as saved by an older build");
  await tagged.show("other");
  check(tagged.titles(), ["題名g2", "題名p1"], "In another tab the picked tag narrows the list");
  await tagged.pickTag("gem");
  check(tagged.titles(), ["題名g2"], "Picking a second tag keeps only the prompts carrying both");
  check(tagged.store.promptMemoSelectedTag, ["gpts", "gem"], "…and both picks are remembered");
  await tagged.pickTag("gpts");
  check(tagged.titles(), ["題名g1", "題名g2"], "Picking a tag again drops it");
  await tagged.pickTag("タグなし");
  check(tagged.titles(), ["題名n1"], "「タグなし」 shows the prompts with no tag, replacing the other picks");
  await tagged.pickTag("gem");
  check(tagged.titles(), ["題名g1", "題名g2"], "…and a tag replaces 「タグなし」");
  await tagged.pickTag("");
  check(tagged.titles(), ["題名g1", "題名g2", "題名n1", "題名p1"], "「すべて」 shows the whole tab again");
  await tagged.show("tags");
  check(tagged.groups(), ["GEM", "GPTs", "タグなし"], "「すべて」 brings every tag back");

  const noTags = openPopup({ prompts: [prompt("a")] });
  await settle();
  check(noTags.el("tagFilterBar").classList.contains("hidden"), true, "A library with no tags keeps the row out of the way");

  // 7a. The chips count what the open tab holds, and grey out what it does not.
  const counted = openPopup({
    prompts: [
      prompt("f1", { tags: ["GEM"], favorite: true }),
      prompt("o1", { tags: ["GEM"] }),
      prompt("o2", { tags: ["GPTs"] }),
      prompt("s1", { tags: ["GEM"], kind: "short" })
    ]
  });
  const chipState = () => counted.el("tagFilterBar").children.slice(1)
    .map((chip) => `${chip.textContent}${chip.children[0].textContent}${chip.disabled ? "×" : ""}`);
  await counted.show("other");
  check(chipState(), ["GEM1", "GPTs1"], "The other tab counts its own prompts");
  await counted.show("short");
  check(chipState(), ["GEM1", "GPTs0×"], "The short tab counts short phrases alone, greying out the rest");
  await counted.show("favorite");
  check(chipState(), ["GEM1", "GPTs0×"], "…and so does every other tab");

  // 7b. Short phrases have their own tab and stay out of "other".
  const mixed = openPopup({ prompts: [prompt("p"), prompt("s", { kind: "short" })] });
  await mixed.show("other");
  check(mixed.titles(), ["題名p"], "The other tab leaves short phrases to their own tab");
  await mixed.show("short");
  check(mixed.titles(), ["本文s"], "…where they are listed");

  // 8. An empty history explains itself instead of saying nothing was found.
  const fresh = openPopup({ prompts: [prompt("a")] });
  await settle();
  check(fresh.titles(), [], "Nothing used yet, nothing in the history");
  check(fresh.el("emptyTitle").textContent, "まだ使用履歴がありません", "…and the page says so");

  console.log("short phrase and history tests passed");
})().catch((error) => {
  console.error(error);
  process.exit(1);
});
