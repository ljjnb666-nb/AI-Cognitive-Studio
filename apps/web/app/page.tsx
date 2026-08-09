export default function HomePage() {
  return (
    <main className="mx-auto flex min-h-screen max-w-3xl items-center px-6 py-16">
      <section className="w-full border border-[var(--border)] p-8 sm:p-12">
        <p className="mb-8 text-sm font-medium text-[var(--muted)]">Phase 0 Foundation</p>
        <h1 className="m-0 text-4xl font-semibold tracking-normal text-[var(--foreground)]">
          AI Cognitive Studio
        </h1>
        <div className="mt-10 flex items-center gap-3 text-base text-[var(--foreground)]" aria-live="polite">
          <span className="h-2.5 w-2.5 rounded-full bg-[var(--success)]" aria-hidden="true" />
          <span>System status: Ready</span>
        </div>
      </section>
    </main>
  );
}
