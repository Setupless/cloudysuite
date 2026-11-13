// The name and domain of a new address, as form fields named "local" and "domain".
export function AddressField({
  label,
  domains,
  hint,
  required,
}: {
  label: string;
  domains: string[];
  hint?: string;
  required?: boolean;
}) {
  return (
    <fieldset className="flex w-full min-w-0 flex-col gap-1.5 text-left text-sm font-medium">
      <legend className="pb-1.5">{label}</legend>
      <div className="flex flex-wrap items-center gap-1.5">
        <input
          name="local"
          aria-label="Name before the @"
          required={required}
          autoCapitalize="none"
          spellCheck={false}
          className="min-w-0 grow basis-32 rounded border border-line bg-field px-3 py-2.5 text-base font-normal text-text outline-accent focus-visible:outline-2"
        />
        <span className="flex min-w-0 items-center gap-1.5">
          <span aria-hidden className="text-secondary">
            @
          </span>
          <select
            name="domain"
            aria-label="Domain"
            className="min-w-0 rounded border border-line bg-field px-3 py-2.5 text-base font-normal text-text outline-accent focus-visible:outline-2"
          >
            {domains.map((domain) => (
              <option key={domain}>{domain}</option>
            ))}
          </select>
        </span>
      </div>
      {hint && <span className="font-normal text-secondary">{hint}</span>}
    </fieldset>
  );
}
