import { Button, Modal, Notice, TextField } from "@cloudysuite/ui";
import { type FormEvent, useEffect, useRef, useState } from "react";

export function NameDialog({
  title,
  hint,
  submitLabel,
  onSubmit,
  onClose,
}: {
  title: string;
  hint: string;
  submitLabel: string;
  // Resolves once done, and throws with the words to show if it can't be.
  onSubmit: (name: string) => Promise<void>;
  onClose: () => void;
}) {
  const [name, setName] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [pending, setPending] = useState(false);
  const field = useRef<HTMLInputElement>(null);
  // The box is turned off while saving, which takes the person's place away.
  useEffect(() => {
    if (pending || !error) return;
    field.current?.focus();
    field.current?.select();
  }, [pending, error]);

  async function submit(event: FormEvent) {
    event.preventDefault();
    setPending(true);
    setError(null);
    try {
      await onSubmit(name);
      onClose();
    } catch (failure) {
      setError((failure as Error).message);
      setPending(false);
    }
  }

  return (
    <Modal title={title} onClose={onClose} busy={pending}>
      <form onSubmit={submit} className="flex flex-col gap-3">
        <TextField
          ref={field}
          label="Name"
          value={name}
          hint={hint}
          autoFocus
          disabled={pending}
          onChange={(event) => setName(event.target.value)}
        />
        {error && <Notice tone="danger">{error}</Notice>}
        <div className="flex justify-end gap-2">
          <Button variant="toolbar" disabled={pending} onClick={onClose}>
            Cancel
          </Button>
          <Button type="submit" variant="toolbarAction" pending={pending}>
            {submitLabel}
          </Button>
        </div>
      </form>
    </Modal>
  );
}
