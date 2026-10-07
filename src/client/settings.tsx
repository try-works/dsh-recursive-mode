/**
 * Recursive settings page (Phase D R8, §11.8): a settings.section list entry
 * surfacing the host-owned enforcement config. The client is read-mostly; all
 * writes ride the host config path (never run files).
 */
import { createElement } from 'react'

export interface RecursiveSettingsProps {
  close: () => void
}

export function RecursiveSettings({ close }: RecursiveSettingsProps) {
  return createElement('div', { className: 'rec-settings' },
    createElement('h2', {}, 'Recursive'),
    createElement('p', {}, 'Enforcement policy, scratch format, and provider defaults are configured on the host. This panel reports that; the client is read-only (§11.9).'),
    createElement('button', { onClick: close }, 'Close'),
  )
}
