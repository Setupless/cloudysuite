import { Button, Notice, TextField } from "@cloudysuite/ui";
import { type FormEvent, useState } from "react";
import { useAction } from "../account/use-action";
import { bytesToLimitText, parseLimitText } from "./storage-limit-text";

export function StorageLimitForm({
  label,
  limitBytes,
  onChange,
}: {
  label: string;
  limitBytes: number | null;
  // A returned message is shown as the reason it didn't change.
  onChange: (next: number | null) => Promise<string | null | void>;
}) {
  const { pending, error, run } = useAction();
  const [text, setText] = useState(bytesToLimitText(limitBytes));

  const submit = (event: FormEvent) => {
    event.preventDefault();
    return run(async () => {
      const parsed = parseLimitText(text);
      return parsed.ok ? onChange(parsed.bytes) : parsed.message;
    });
  };

  return (
    <form onSubmit={submit} className="flex flex-col gap-3">
      <TextField
        label={label}
        inputMode="decimal"
        autoComplete="off"
        value={text}
        onChange={(event) => setText(event.target.value)}
        hint="If the limit is lower than what's already stored, new uploads stop. Nothing is deleted."
      />
      {error && <Notice tone="danger">{error}</Notice>}
      <div className="flex flex-wrap gap-2">
        <Button type="submit" variant="action" disabled={pending}>
          Save limit
        </Button>
        {limitBytes !== null && (
          <Button
            variant="quiet"
            disabled={pending}
            onClick={() =>
              run(async () => {
                const message = await onChange(null);
                if (!message) setText("");
                return message;
              })
            }
          >
            Remove limit
          </Button>
        )}
      </div>
    </form>
  );
}
