export function StorageMeter({
  usedBytes,
  limitBytes,
  text,
}: {
  usedBytes: number;
  limitBytes: number;
  text: string;
}) {
  const percent = Math.min(100, (usedBytes / limitBytes) * 100);
  return (
    <div className="flex flex-col gap-1.5">
      <div
        role="meter"
        aria-label={text}
        aria-valuemin={0}
        aria-valuemax={limitBytes}
        aria-valuenow={Math.min(usedBytes, limitBytes)}
        className="h-[5px] overflow-hidden rounded bg-field"
      >
        <div
          className={`h-full ${usedBytes >= limitBytes ? "bg-danger" : "bg-accent"}`}
          style={{ width: `${percent}%` }}
        />
      </div>
      <p className="text-xs text-secondary">{text}</p>
    </div>
  );
}
