/**
 * Hero scroll-story engine. The hero section is 320vh tall with a sticky
 * 100vh stage; scrolling drives a progress p ∈ [0,1] that maps to:
 *
 *  - --tx  : the stage shift in vw (acts travel right-to-left past center)
 *  - --f1..--f3 per-act focus values (bell curves peaking at p = 0, .5, 1)
 *
 * Everything downstream is CSS consuming those variables, so the whole
 * animation is a pure function of scroll position — reversible, and safe
 * under fast or jumpy scrolling. Crossing an act's focus threshold toggles
 * .is-focus, which arms its one-shot animations (module snap-on) and the
 * terminal's live counters (ticking output counter, refreshing point
 * values).
 */

const PEAKS = [0, 0.5, 1] as const;

/**
 * Snap-on thresholds for the six cabinet modules: a tight pipeline inside
 * act 1's opening ramp — each module launches about a third of the way
 * through the previous one's flight. Scrolling back past a threshold
 * uninstalls that module again.
 */
const SNAP_AT = [0.05, 0.07, 0.09, 0.11, 0.13, 0.15];

/** The door shuts once every module is home; reopening on scroll-back. */
const DOOR_AT = 0.22;

/** Bell curve around `peak`, eased so peaks feel plateaud and edges soft. */
function focus(p: number, peak: number): number {
  const x = Math.min(1, Math.max(0, 1 - Math.abs(p - peak) / 0.5));
  return x * x * (3 - 2 * x);
}

/**
 * Act 1 holds full focus while its story plays (modules snap in, door
 * closes at ~0.22) and only then hands over: 0.26–0.55 ease-out.
 */
function act1Focus(p: number): number {
  if (p <= 0.26) return 1;
  if (p >= 0.55) return 0;
  const x = (p - 0.26) / 0.29;
  return 1 - x * x * (3 - 2 * x);
}

/**
 * Act 3 reaches full focus a touch early and holds it to the very end of
 * the scroll travel, so the terminal stays readable before release.
 */
function act3Focus(p: number): number {
  if (p >= 0.9) return 1;
  return focus(p, 1);
}

/**
 * Stage pan eases per segment so act 1 stays put while its story plays
 * (modules snap in, door closes), hands over to act 2 through the middle,
 * and settles gently while act 3 holds the frame.
 */
function stageEase(p: number): number {
  const seg = (a: number, b: number): number => {
    const x = Math.min(1, Math.max(0, (p - a) / (b - a)));
    return x * x * (3 - 2 * x);
  };
  if (p <= 0.26) return 0.12 * seg(0, 0.26);
  if (p <= 0.6) return 0.12 + 0.43 * seg(0.26, 0.6);
  if (p <= 0.9) return 0.55 + 0.37 * seg(0.6, 0.9);
  return 0.92 + 0.08 * seg(0.9, 1);
}

export function initHeroStory(): void {
  const stage = document.querySelector<HTMLElement>('#hero-story');
  if (!stage) return;

  const track = stage.querySelector<HTMLElement>('.story-stage');
  const acts = Array.from(stage.querySelectorAll<HTMLElement>('.act'));
  if (!track || acts.length !== PEAKS.length) return;

  const focused: boolean[] = acts.map(() => false);
  const terminals = new Map<
    HTMLElement,
    { count: number; temp: number; speed: number; press: number; timer: number | null; render: () => void }
  >();

  const modules = Array.from(
    stage.querySelectorAll<HTMLElement>('[data-module]'),
  );
  const installed: boolean[] = modules.map(() => false);
  const applySnaps = (p: number): void => {
    modules.forEach((mod, i) => {
      const want = p >= (SNAP_AT[i] ?? 1);
      if (want === installed[i]) return;
      installed[i] = want;
      mod.classList.toggle('installed', want);
    });
  };

  const door = stage.querySelector<HTMLElement>('[data-door]');
  let doorShut = false;
  const applyDoor = (p: number): void => {
    if (!door) return;
    const want = p >= DOOR_AT;
    if (want === doorShut) return;
    doorShut = want;
    door.classList.toggle('shut', want);
  };

  const setFocus = (i: number, f: number): void => {
    const act = acts[i]!;
    act.style.setProperty('--f', f.toFixed(4));
    const want = f > 0.55;
    if (want === focused[i]) return;
    focused[i] = want;
    act.classList.toggle('is-focus', want);
    if (act.classList.contains('act-terminal')) toggleTerminal(act, want);
  };

  // The terminal's live readouts only run while act 3 holds focus.
  const toggleTerminal = (act: HTMLElement, on: boolean): void => {
    let state = terminals.get(act);
    if (!state) {
      state = { count: 1843, temp: 64.2, speed: 12.8, press: 0.62, timer: null, render: () => {} };
      terminals.set(act, state);
      const lives = Array.from(act.querySelectorAll<HTMLElement>('[data-live]'));
      state.render = () => {
        for (const el of lives) {
          if (el.dataset.live === 'count') el.textContent = String(state!.count);
          else if (el.dataset.live === 'temp') el.textContent = `${state!.temp.toFixed(1)}℃`;
          else if (el.dataset.live === 'speed') el.textContent = `${state!.speed.toFixed(1)} m/s`;
          else if (el.dataset.live === 'press') el.textContent = `${state!.press.toFixed(2)} MPa`;
        }
      };
    }
    if (on && state.timer === null) {
      const render = state.render;
      render();
      state.timer = window.setInterval(() => {
        // 产量只增不减；工艺量围绕基线小幅漂移——和真实点流一个脾气。
        if (Math.random() < 0.72) state!.count += 1;
        state!.temp = 64.2 + (Math.random() - 0.5) * 1.6;
        state!.speed = 12.8 + (Math.random() - 0.5) * 0.8;
        state!.press = 0.62 + (Math.random() - 0.5) * 0.04;
        render();
      }, 1400);
    } else if (!on && state.timer !== null) {
      window.clearInterval(state.timer);
      state.timer = null;
    }
  };

  let ticking = false;
  // Stage geometry is measured, not assumed: basePx centers act 1 at p=0 and
  // travelPx is the exact left-to-left distance from the first to the last
  // act, so any breakpoint (act width caps, gaps) stays aligned.
  let basePx = 0;
  let travelPx = 1;
  const measure = (): void => {
    const first = acts[0]!;
    const last = acts[acts.length - 1]!;
    travelPx = Math.max(1, last.offsetLeft - first.offsetLeft);
    basePx = window.innerWidth / 2 - (first.offsetLeft + first.offsetWidth / 2);
  };

  const update = (): void => {
    ticking = false;
    const rect = stage.getBoundingClientRect();
    const travel = rect.height - window.innerHeight;
    const p = travel > 0 ? Math.min(1, Math.max(0, -rect.top / travel)) : 0;
    stage.style.setProperty('--p', p.toFixed(4));
    track.style.setProperty('--tx', (basePx - travelPx * stageEase(p)).toFixed(1));
    setFocus(0, act1Focus(p));
    setFocus(1, focus(p, PEAKS[1] ?? 0.5));
    setFocus(2, act3Focus(p));
    applySnaps(p);
    applyDoor(p);
  };
  const onResize = (): void => {
    measure();
    onScroll();
  };
  const onScroll = (): void => {
    if (!ticking) {
      ticking = true;
      requestAnimationFrame(update);
    }
  };

  measure();
  window.addEventListener('scroll', onScroll, { passive: true });
  window.addEventListener('resize', onResize, { passive: true });
  update();
}
