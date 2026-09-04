/**
 * Landing page entry: shared site behavior plus the hero scroll-story
 * engine (three acts — cabinet, rail bus, terminal — driven by scroll
 * progress; see hero.ts).
 */
import './styles.css';
import { initSite } from './site';
import { initHeroStory } from './hero';

initSite('index');
initHeroStory();
