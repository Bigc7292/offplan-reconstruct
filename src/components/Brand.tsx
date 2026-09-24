import Link from "next/link";

export function Brand({ small }: { small?: boolean }) {
  return (
    <Link href="/" className="flex items-baseline gap-2 select-none">
      <span className={`font-[family-name:var(--font-display)] ${small ? "text-xl" : "text-3xl"} text-champagne-300 tracking-wide`}>OffPlan</span>
      <span className={`${small ? "text-[10px]" : "text-xs"} uppercase tracking-[0.3em] text-stone-400`}>Reconstruct</span>
    </Link>
  );
}

export function Footer() {
  return (
    <footer className="text-[11px] text-stone-500 text-center py-4">
      Reconstructed from sales materials — not a survey. Dimensions, finishes and layouts are as shown in marketing collateral and may change.
    </footer>
  );
}
