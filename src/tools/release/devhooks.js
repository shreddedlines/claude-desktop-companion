'use strict';
/**
 * devhooks.js — PRODUCTION BUILD STUB.
 *
 * The development/test controls (alternative data, sessions and log folders, simulated tray input, disabled locking or
 * usage monitoring, timing overrides, mocked process discovery, crash injection) are not part of the distributed application.
 * This file replaces the development version in the release package. It never reads command-line arguments or environment
 * variables, so nothing a user, a script or an attacker passes to the application can switch those controls on.
 */
const NONE = Object.freeze({ dev: false, passthrough: Object.freeze([]) });
module.exports = {
  DEV_HOOKS: false,
  DEV_CONTROLS: Object.freeze([]),
  options() { return NONE; },
  forwardToMerge() { return []; },
  forwardToWatcher() { return []; },
  mockProcessSource() { return null; },
  installCrashInjector() { /* not available in production */ },
};
