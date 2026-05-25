import Link from "next/link";

type Props = {
  /** App name displayed as the header's main visual anchor. */
  title?: string;
  /** Small-caps line below the title. e.g. "Teacher" or "Admin". */
  eyebrow?: string;
  /** Italic subtitle below the eyebrow. e.g. course name. */
  subtitle?: string;
  /** Optional right-side slot (nav links, sign-out button, etc). */
  right?: React.ReactNode;
  /** When provided, makes the title a link back to this path. */
  logoHref?: string;
  /** Replaces the default light-blue hairline rule below the header with a
   * different color class. e.g. "h-0.5 border-0 bg-dark-blue" for admin. */
  ruleClassName?: string;
};

export function BrandHeader({
  title,
  eyebrow,
  subtitle,
  right,
  logoHref,
  ruleClassName,
}: Props) {
  const heading = title ? (
    <span className="font-display text-xl font-semibold italic">
      <span className="text-maroon">EHS</span>{" "}
      <span className="text-ink">{title}</span>
    </span>
  ) : null;

  return (
    <header className="bg-white">
      <div className="mx-auto flex w-full max-w-5xl items-center justify-between gap-6 px-6 pt-5 pb-4">
        <div className="flex items-baseline gap-4 min-w-0">
          {logoHref && heading ? (
            <Link href={logoHref} className="shrink-0">
              {heading}
            </Link>
          ) : (
            heading
          )}
          {(eyebrow || subtitle) && (
            <div className="hidden min-w-0 sm:block">
              {eyebrow && (
                <div className="ehs-eyebrow truncate whitespace-nowrap">
                  {eyebrow}
                </div>
              )}
              {subtitle && (
                <div className="mt-0.5 truncate text-xs italic text-cool-gray">
                  {subtitle}
                </div>
              )}
            </div>
          )}
        </div>
        {right && <div className="min-w-0 self-center">{right}</div>}
      </div>
      <hr className={ruleClassName ?? "ehs-rule"} />
    </header>
  );
}
