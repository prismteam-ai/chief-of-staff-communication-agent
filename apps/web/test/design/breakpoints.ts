/**
 * Breakpoint-config objects (Task 8 brief constraint 6, the `smeargle` kit pattern): named
 * viewport sizes a single generic test body is parameterized over, so adding a breakpoint is
 * adding one config entry, not a new test file. Sizes are standard device references (iPhone 12,
 * iPad, a common laptop viewport) rather than pulled from a Figma frame — see
 * `test/design/README.md` for the no-Figma adaptation note.
 */
export interface BreakpointConfig {
  name: 'mobile' | 'tablet' | 'desktop';
  width: number;
  height: number;
}

export const BREAKPOINTS: BreakpointConfig[] = [
  { name: 'mobile', width: 390, height: 844 }, // iPhone 12/13 viewport
  { name: 'tablet', width: 768, height: 1024 }, // iPad portrait
  { name: 'desktop', width: 1440, height: 900 }, // common laptop viewport
];
