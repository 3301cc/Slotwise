import { useId, useMemo, useState } from 'react';
import { zoneCaption } from './slotLabel.js';
import type { BookerTimezone } from './useBookerTimezone.js';

/**
 * Durchsuchbare Zonenauswahl. Native <datalist>, damit keine Bibliothek
 * geladen wird und die Auswahl mit Tastatur und Screenreader funktioniert.
 */
export function TimezoneSelect({ tz, at }: { tz: BookerTimezone; at: Date }) {
  const id = useId();
  const [query, setQuery] = useState(tz.timezone);
  const options = useMemo(() => {
    const q = query.trim().toLowerCase();
    return (q ? tz.options.filter((o) => o.toLowerCase().includes(q)) : tz.options).slice(0, 50);
  }, [query, tz.options]);

  return (
    <div className="flex flex-col gap-1">
      <label htmlFor={id} className="text-xs font-medium text-slate-500">
        Zeitzone {tz.detected ? '(automatisch erkannt)' : ''}
      </label>
      <input
        id={id}
        list={`${id}-list`}
        value={query}
        onChange={(e) => setQuery(e.target.value)}
        onBlur={() => {
          if (tz.options.includes(query)) tz.setTimezone(query);
          else setQuery(tz.timezone);
        }}
        className="h-9 rounded-lg border border-slate-200 bg-white px-3 text-sm text-slate-900 shadow-sm focus:border-emerald-400"
        autoComplete="off"
        spellCheck={false}
      />
      <datalist id={`${id}-list`}>
        {options.map((o) => (
          <option key={o} value={o} />
        ))}
      </datalist>
      <p className="text-[11px] text-slate-400">{zoneCaption(tz.timezone, at)}</p>
    </div>
  );
}
