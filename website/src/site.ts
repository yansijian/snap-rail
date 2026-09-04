/**
 * Shared behavior for both website pages: nav highlighting, reveal-on-scroll
 * and the media slot mechanism. Slots are declared in HTML as
 * `<... data-video="hero-dashboard">` / `<... data-image="device-manager">`;
 * the recorded file is expected at `public/assets/<name>.mp4|png`. While the
 * file is absent the CSS fallback inside the slot stays visible, so the site
 * renders complete before the demo assets are recorded (see
 * public/assets/README.md).
 */

/** Mark the current page's nav link and open external links in a new tab. */
function initNav(page: 'index' | 'plugins'): void {
  for (const link of document.querySelectorAll<HTMLAnchorElement>('a[data-nav]')) {
    if (link.dataset.nav === page) {
      link.classList.add('active');
      link.setAttribute('aria-current', 'page');
    }
  }
}

/** Fade sections in as they enter the viewport (disabled for reduced motion). */
function initReveal(): void {
  const targets = document.querySelectorAll('.reveal');
  if (window.matchMedia('(prefers-reduced-motion: reduce)').matches) {
    targets.forEach((el) => el.classList.add('revealed'));
    return;
  }
  const observer = new IntersectionObserver(
    (entries) => {
      for (const entry of entries) {
        if (entry.isIntersecting) {
          entry.target.classList.add('revealed');
          observer.unobserve(entry.target);
        }
      }
    },
    { rootMargin: '-40px 0px' },
  );
  targets.forEach((el) => observer.observe(el));
}

/**
 * Mount a muted looping <video> into every [data-video] slot. On canplay the
 * slot gains .is-ready (CSS swaps the fallback for the video); on error it
 * gains .is-missing so the fallback stays permanently.
 */
function initVideoSlots(): void {
  for (const slot of document.querySelectorAll<HTMLElement>('[data-video]')) {
    const name = slot.dataset.video;
    if (!name) continue;
    const video = document.createElement('video');
    video.muted = true;
    video.loop = true;
    video.autoplay = true;
    video.playsInline = true;
    video.setAttribute('aria-label', `${name} 演示录屏`);
    video.className = 'absolute inset-0 h-full w-full object-cover';
    video.src = `./assets/${name}.mp4`;
    video.addEventListener('canplay', () => slot.classList.add('is-ready'), { once: true });
    video.addEventListener('error', () => slot.classList.add('is-missing'), { once: true });
    slot.appendChild(video);
  }
}

/** Mount an <img> into every [data-image] slot with the same fallback deal. */
function initImageSlots(): void {
  for (const slot of document.querySelectorAll<HTMLElement>('[data-image]')) {
    const name = slot.dataset.image;
    if (!name) continue;
    const img = document.createElement('img');
    img.alt = slot.dataset.alt ?? `${name} 界面截图`;
    img.className = 'h-full w-full object-cover object-left-top';
    img.src = `./assets/${name}.png`;
    img.addEventListener('load', () => slot.classList.add('is-ready'), { once: true });
    img.addEventListener('error', () => slot.classList.add('is-missing'), { once: true });
    slot.appendChild(img);
  }
}

/** Wire everything a page needs; called from each page entry module. */
export function initSite(page: 'index' | 'plugins'): void {
  initNav(page);
  initReveal();
  initVideoSlots();
  initImageSlots();
}
