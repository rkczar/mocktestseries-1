import Image from "next/image";
import type { LoginPageConfig } from "@/lib/login-page";

/**
 * The left half of the split login layout. Admin-controlled via Admin →
 * Website → Login Page. Renders nothing but the configured background when
 * `leftCanvas.mode` is "blank" (the default on a fresh install) — no
 * marketing copy, stats, or stock imagery is ever forced in.
 */
export function LeftCanvas({ config }: { config: LoginPageConfig }) {
  const { leftCanvas } = config;
  const showContent = leftCanvas.mode === "content";
  const align = leftCanvas.contentAlignment === "center" ? "items-center text-center" : "items-start text-left";
  const mobileVisibility = config.mobileBehavior === "stack" ? "flex" : "hidden sm:flex";

  return (
    <div
      className={`relative min-h-[220px] flex-1 overflow-hidden sm:min-h-0 ${mobileVisibility}`}
      style={{ background: leftCanvas.backgroundColor || config.background.canvas }}
    >
      {leftCanvas.ambient ? (
        <div
          className="pointer-events-none absolute inset-0"
          style={{
            background:
              "radial-gradient(60% 50% at 30% 20%, rgba(99,102,241,0.18), transparent 60%), radial-gradient(50% 40% at 80% 80%, rgba(99,102,241,0.10), transparent 60%)",
          }}
        />
      ) : null}

      {showContent ? (
        <div className={`relative z-10 flex w-full max-w-lg flex-col justify-center gap-4 p-12 ${align}`}>
          {leftCanvas.content.logoUrl ? (
            <Image src={leftCanvas.content.logoUrl} alt="" width={48} height={48} className="h-12 w-12 object-contain" unoptimized />
          ) : null}
          {leftCanvas.content.heading ? (
            <h2 className="text-3xl font-semibold text-white">{leftCanvas.content.heading}</h2>
          ) : null}
          {leftCanvas.content.subheading ? <p className="text-base text-white/70">{leftCanvas.content.subheading}</p> : null}
          {leftCanvas.content.text ? <p className="text-sm text-white/50">{leftCanvas.content.text}</p> : null}
          {leftCanvas.content.imageUrl ? (
            <Image
              src={leftCanvas.content.imageUrl}
              alt=""
              width={480}
              height={320}
              className="mt-4 max-h-80 w-full rounded-2xl object-cover"
              unoptimized
            />
          ) : null}
          {leftCanvas.content.cards?.length ? (
            <div className="mt-4 grid grid-cols-1 gap-3 sm:grid-cols-2">
              {leftCanvas.content.cards.map((card, i) => (
                <div key={i} className="rounded-xl border border-white/10 bg-white/5 p-4">
                  <p className="text-sm font-medium text-white">{card.title}</p>
                  <p className="mt-1 text-xs text-white/50">{card.text}</p>
                </div>
              ))}
            </div>
          ) : null}
        </div>
      ) : null}
    </div>
  );
}
