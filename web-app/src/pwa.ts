// Installable app + "new version" banner.
//
// - Registers the service worker (production only) so the app shell, engine and
//   puzzles work offline.
// - Shows an "Install app" chip when the browser offers an install prompt.
// - Polls /version.json (written at build time) and, when the deployed build id differs
//   from the one this page was built with, offers a one-tap reload.

interface InstallPromptEvent extends Event {
  prompt: () => Promise<void>;
  userChoice: Promise<{ outcome: "accepted" | "dismissed" }>;
}

const POLL_MS = 5 * 60_000;

export function setupPwa(): void {
  const banner = document.getElementById("update-banner") as HTMLElement;
  const reloadBtn = document.getElementById("update-reload") as HTMLButtonElement;
  const installBtn = document.getElementById("install") as HTMLButtonElement;

  reloadBtn.addEventListener("click", () => window.location.reload());

  if (import.meta.env.PROD && "serviceWorker" in navigator) {
    window.addEventListener("load", () => {
      navigator.serviceWorker.register("./sw.js").catch(() => {
        /* offline support is a bonus; the app works without it */
      });
    });
  }

  let deferred: InstallPromptEvent | null = null;
  window.addEventListener("beforeinstallprompt", (e) => {
    e.preventDefault();
    deferred = e as InstallPromptEvent;
    installBtn.hidden = false;
  });
  installBtn.addEventListener("click", async () => {
    if (!deferred) return;
    installBtn.hidden = true;
    await deferred.prompt();
    deferred = null;
  });
  window.addEventListener("appinstalled", () => (installBtn.hidden = true));

  if (!import.meta.env.PROD) return;
  const check = async () => {
    try {
      const resp = await fetch(`./version.json?t=${Date.now()}`, { cache: "no-store" });
      if (!resp.ok) return;
      const { build } = (await resp.json()) as { build?: string };
      if (build && build !== __BUILD_ID__) banner.hidden = false;
    } catch {
      /* offline */
    }
  };
  window.setInterval(check, POLL_MS);
  document.addEventListener("visibilitychange", () => {
    if (document.visibilityState === "visible") void check();
  });
}
