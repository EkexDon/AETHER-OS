import { beforeEach, describe, expect, it } from "vitest";
import { isDirty, useIdeStore } from "./ideStore";
import { languageForPath } from "./language";

const reset = () =>
  useIdeStore.setState({ rootPath: null, tabs: [], activePath: null });

describe("languageForPath", () => {
  it("maps common source extensions to Monaco language ids", () => {
    expect(languageForPath("/p/src/main.rs")).toBe("rust");
    expect(languageForPath("/p/src/App.tsx")).toBe("typescript");
    expect(languageForPath("/p/src/util.js")).toBe("javascript");
    expect(languageForPath("/p/package.json")).toBe("json");
    expect(languageForPath("/p/styles.css")).toBe("css");
    expect(languageForPath("/p/README.md")).toBe("markdown");
  });

  it("is case insensitive", () => {
    expect(languageForPath("/p/Main.RS")).toBe("rust");
    expect(languageForPath("/p/INDEX.HTML")).toBe("html");
  });

  it("recognises files identified by name rather than extension", () => {
    expect(languageForPath("/p/Dockerfile")).toBe("dockerfile");
    expect(languageForPath("/p/Dockerfile.prod")).toBe("dockerfile");
    expect(languageForPath("/p/.zshrc")).toBe("shell");
  });

  it("does not treat a leading dot as an extension separator", () => {
    expect(languageForPath("/p/.gitignore")).toBe("plaintext");
  });

  it("falls back to plaintext for unknown or extensionless files", () => {
    expect(languageForPath("/p/LICENSE")).toBe("plaintext");
    expect(languageForPath("/p/data.wat")).toBe("plaintext");
  });
});

describe("useIdeStore", () => {
  beforeEach(reset);

  it("opens a file as a new active tab", () => {
    useIdeStore.getState().openFile("/p/src/main.rs", "fn main() {}");
    const { tabs, activePath } = useIdeStore.getState();

    expect(tabs).toHaveLength(1);
    expect(tabs[0].name).toBe("main.rs");
    expect(tabs[0].language).toBe("rust");
    expect(activePath).toBe("/p/src/main.rs");
  });

  it("focuses an already-open tab instead of reopening it", () => {
    const store = useIdeStore.getState();
    store.openFile("/p/a.ts", "a");
    store.openFile("/p/b.ts", "b");
    useIdeStore.getState().openFile("/p/a.ts", "STALE FROM DISK");

    const { tabs, activePath } = useIdeStore.getState();
    expect(tabs).toHaveLength(2);
    expect(activePath).toBe("/p/a.ts");
    // Reopening must not clobber the live buffer with a fresh disk read.
    expect(tabs[0].content).toBe("a");
  });

  it("tracks dirty state by comparing the buffer against disk", () => {
    useIdeStore.getState().openFile("/p/a.ts", "original");
    expect(isDirty(useIdeStore.getState().tabs[0])).toBe(false);

    useIdeStore.getState().updateContent("/p/a.ts", "edited");
    expect(isDirty(useIdeStore.getState().tabs[0])).toBe(true);

    useIdeStore.getState().markSaved("/p/a.ts");
    expect(isDirty(useIdeStore.getState().tabs[0])).toBe(false);
  });

  it("reverts to clean when an edit is undone back to the saved content", () => {
    useIdeStore.getState().openFile("/p/a.ts", "original");
    useIdeStore.getState().updateContent("/p/a.ts", "edited");
    useIdeStore.getState().updateContent("/p/a.ts", "original");

    expect(isDirty(useIdeStore.getState().tabs[0])).toBe(false);
  });

  it("only updates the targeted tab", () => {
    const store = useIdeStore.getState();
    store.openFile("/p/a.ts", "a");
    store.openFile("/p/b.ts", "b");

    useIdeStore.getState().updateContent("/p/a.ts", "changed");

    const tabs = useIdeStore.getState().tabs;
    expect(tabs[0].content).toBe("changed");
    expect(tabs[1].content).toBe("b");
  });

  it("activates the following tab when the active one is closed", () => {
    const store = useIdeStore.getState();
    store.openFile("/p/a.ts", "a");
    store.openFile("/p/b.ts", "b");
    store.openFile("/p/c.ts", "c");

    useIdeStore.getState().setActive("/p/b.ts");
    useIdeStore.getState().closeFile("/p/b.ts");

    expect(useIdeStore.getState().activePath).toBe("/p/c.ts");
    expect(useIdeStore.getState().tabs.map((t) => t.name)).toEqual(["a.ts", "c.ts"]);
  });

  it("falls back to the previous tab when closing the last one", () => {
    const store = useIdeStore.getState();
    store.openFile("/p/a.ts", "a");
    store.openFile("/p/b.ts", "b");

    useIdeStore.getState().closeFile("/p/b.ts");
    expect(useIdeStore.getState().activePath).toBe("/p/a.ts");
  });

  it("clears the active path when the last tab is closed", () => {
    useIdeStore.getState().openFile("/p/a.ts", "a");
    useIdeStore.getState().closeFile("/p/a.ts");

    expect(useIdeStore.getState().tabs).toHaveLength(0);
    expect(useIdeStore.getState().activePath).toBeNull();
  });

  it("keeps the active tab when a different tab is closed", () => {
    const store = useIdeStore.getState();
    store.openFile("/p/a.ts", "a");
    store.openFile("/p/b.ts", "b");

    useIdeStore.getState().setActive("/p/b.ts");
    useIdeStore.getState().closeFile("/p/a.ts");

    expect(useIdeStore.getState().activePath).toBe("/p/b.ts");
  });

  it("ignores closing a path that is not open", () => {
    useIdeStore.getState().openFile("/p/a.ts", "a");
    useIdeStore.getState().closeFile("/p/nope.ts");

    expect(useIdeStore.getState().tabs).toHaveLength(1);
    expect(useIdeStore.getState().activePath).toBe("/p/a.ts");
  });
});
