import "@testing-library/jest-dom";
import { beforeEach } from "vitest";

// Views that load data on mount (TaskBoard, Calendar) settle their state a
// tick after `render()` returns, which makes React 18 print "An update to X
// inside a test was not wrapped in act(...)" even though the tests await the
// result with `findBy*`/`waitFor`. Testing Library switches the act
// environment on inside its own `act()`/`render()` wrappers and restores the
// previous value afterwards, so turning the global flag off between them
// silences exactly these benign warnings. (Testing Library sets it to `true`
// in a `beforeAll`, hence the per-test reset.)
beforeEach(() => {
  (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = false;
});

class ResizeObserverMock {
  observe() {}
  unobserve() {}
  disconnect() {}
}

(globalThis as any).ResizeObserver = ResizeObserverMock;

// jsdom's localStorage needs a backing file that vitest does not provide;
// a minimal in-memory stub keeps persistence code testable.
class LocalStorageStub {
  private store = new Map<string, string>();
  getItem(key: string): string | null {
    return this.store.has(key) ? this.store.get(key)! : null;
  }
  setItem(key: string, value: string): void {
    this.store.set(key, String(value));
  }
  removeItem(key: string): void {
    this.store.delete(key);
  }
  clear(): void {
    this.store.clear();
  }
  key(index: number): string | null {
    return Array.from(this.store.keys())[index] ?? null;
  }
  get length(): number {
    return this.store.size;
  }
}

if (typeof window !== "undefined" && typeof window.localStorage?.getItem !== "function") {
  Object.defineProperty(window, "localStorage", { value: new LocalStorageStub() });
}
