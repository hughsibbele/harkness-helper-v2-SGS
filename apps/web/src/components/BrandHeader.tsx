// Shared page header used across landing + dashboard + admin surfaces.
//
// Phase A: text wordmark only (no logo asset yet — drop a webp into
// /public/brand and switch back to an <img> when ready).

import Link from "next/link";

type Props = {
  eyebrow?: string;
  title?: string;
  subtitle?: string;
  right?: React.ReactNode;
  logoHref?: string;
  ruleClassName?: string;
};

export function BrandHeader({
  eyebrow,
  title,
  subtitle,
  right,
  logoHref,
  ruleClassName,
}: Props) {
  const wordmark = (
    <span className="select-none text-base font-semibold tracking-tight text-maroon">
      Harkness Helper
      <span className="ml-1 text-xs italic text-cool-gray">EHS</span>
    </span>
  );

  return (
    <header className="bg-white">
      <div className="mx-auto flex w-full max-w-5xl items-end justify-between gap-6 px-6 pt-6 pb-4">
        <div className="flex min-w-0 items-end gap-5">
          {logoHref ? (
            <Link href={logoHref} aria-label="Home" className="shrink-0">
              {wordmark}
            </Link>
          ) : (
            wordmark
          )}
          {(eyebrow || title || subtitle) && (
            <div className="hidden min-w-0 pb-1 sm:block">
              {eyebrow && (
                <div className="ehs-eyebrow truncate whitespace-nowrap">
                  {eyebrow}
                </div>
              )}
              {title && (
                <div className="mt-0.5 truncate text-base text-ink">
                  {title}
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
