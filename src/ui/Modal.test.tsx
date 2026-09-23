import { describe, expect, it, vi } from "vitest";
import { useState } from "react";
import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { Modal } from "./Modal";

function Harness({ onClose = () => undefined }: { onClose?: () => void }) {
  const [open, setOpen] = useState(false);
  return (
    <>
      <button onClick={() => setOpen(true)}>Open</button>
      <Modal
        open={open}
        onClose={() => {
          onClose();
          setOpen(false);
        }}
        title="Edit event"
        description="Change the details"
        footer={<button>Save</button>}
      >
        <input aria-label="Title" />
        <button>Inner</button>
      </Modal>
    </>
  );
}

describe("Modal", () => {
  it("renders nothing when closed", () => {
    render(<Modal open={false} onClose={() => undefined} title="Hidden" />);
    expect(screen.queryByRole("dialog")).toBeNull();
  });

  it("renders an accessible dialog in a portal", () => {
    render(
      <div data-testid="host">
        <Modal open onClose={() => undefined} title="Settings" description="Preferences">
          body
        </Modal>
      </div>
    );
    const dialog = screen.getByRole("dialog", { name: "Settings" });
    expect(dialog).toHaveAttribute("aria-modal", "true");
    expect(dialog).toHaveAccessibleDescription("Preferences");
    expect(screen.getByTestId("host")).not.toContainElement(dialog);
  });

  it("closes on Escape and restores focus to the opener", async () => {
    const onClose = vi.fn();
    render(<Harness onClose={onClose} />);
    const opener = screen.getByRole("button", { name: "Open" });
    opener.focus();
    fireEvent.click(opener);
    const input = await screen.findByLabelText("Title");
    await waitFor(() => expect(input).toHaveFocus());
    fireEvent.keyDown(input, { key: "Escape" });
    expect(onClose).toHaveBeenCalledOnce();
    await waitFor(() => expect(opener).toHaveFocus());
  });

  it("traps Tab inside the dialog", async () => {
    render(<Harness />);
    fireEvent.click(screen.getByRole("button", { name: "Open" }));
    const dialog = await screen.findByRole("dialog");
    const save = screen.getByRole("button", { name: "Save" });
    const close = screen.getByRole("button", { name: "Close" });
    save.focus();
    fireEvent.keyDown(save, { key: "Tab" });
    expect(dialog.contains(document.activeElement)).toBe(true);
    close.focus();
    fireEvent.keyDown(close, { key: "Tab", shiftKey: true });
    expect(document.activeElement).toBe(save);
  });

  it("closes on a backdrop click but not on a click inside", () => {
    const onClose = vi.fn();
    render(
      <Modal open onClose={onClose} title="T">
        <p>content</p>
      </Modal>
    );
    const content = screen.getByText("content");
    fireEvent.mouseDown(content);
    fireEvent.mouseUp(content);
    expect(onClose).not.toHaveBeenCalled();
    const backdrop = document.querySelector(".ui-modal-backdrop") as HTMLElement;
    fireEvent.mouseDown(backdrop);
    fireEvent.mouseUp(backdrop);
    expect(onClose).toHaveBeenCalledOnce();
  });

  it("ignores Escape and backdrop when not dismissible", () => {
    const onClose = vi.fn();
    render(
      <Modal open onClose={onClose} title="Busy" dismissible={false}>
        <button>ok</button>
      </Modal>
    );
    fireEvent.keyDown(screen.getByRole("button", { name: "ok" }), { key: "Escape" });
    const backdrop = document.querySelector(".ui-modal-backdrop") as HTMLElement;
    fireEvent.mouseDown(backdrop);
    fireEvent.mouseUp(backdrop);
    expect(onClose).not.toHaveBeenCalled();
  });

  it("only the top-most modal reacts to Escape", () => {
    const outer = vi.fn();
    const inner = vi.fn();
    render(
      <>
        <Modal open onClose={outer} title="Outer">
          <button>outer</button>
        </Modal>
        <Modal open onClose={inner} title="Inner">
          <button>inner</button>
        </Modal>
      </>
    );
    fireEvent.keyDown(screen.getByRole("button", { name: "outer" }), { key: "Escape" });
    expect(outer).not.toHaveBeenCalled();
    fireEvent.keyDown(screen.getByRole("button", { name: "inner" }), { key: "Escape" });
    expect(inner).toHaveBeenCalledOnce();
  });
});
