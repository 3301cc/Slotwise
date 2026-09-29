export * from "./types";
export { GoogleCalendarProvider } from "./google";
export { MicrosoftGraphProvider } from "./microsoft";

import { GoogleCalendarProvider } from "./google";
import { MicrosoftGraphProvider } from "./microsoft";
import type { CalendarProvider, ProviderKind } from "./types";

const registry: Partial<Record<ProviderKind, CalendarProvider>> = {
  GOOGLE: new GoogleCalendarProvider(),
  MICROSOFT: new MicrosoftGraphProvider(),
  // CRONOFY: add `cronofy.ts` behind the same interface when Exchange/iCloud is needed.
};

export function providerFor(kind: ProviderKind): CalendarProvider {
  const p = registry[kind];
  if (!p) throw new Error(`No calendar provider registered for ${kind}`);
  return p;
}
